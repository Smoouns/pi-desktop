import assert from "node:assert/strict";
import { fork, spawnSync, type ForkOptions } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, digest, readBounded, sha256, treeManifest } from "../core/io.js";
import { createBoundedTransport } from "../core/request-transport.js";
import { resolvePilotPrivateConfig } from "../pilot/private-config.js";
import { checkBaselineGitObjects, sdkSources } from "../sdk-ablation/runner.js";
import { validateSdkProvenance } from "../sdk-ablation/extensions.js";
import { validateSdkPrepared } from "../sdk-ablation/records.js";
import type { SdkPrepared } from "../sdk-ablation/session.js";
import { SDK_CONTENT, SDK_TARGET } from "../sdk-ablation/policy.js";
import { authorize, durableJson, exact, hashes, promptHashes, readManifest, validateLiveManifest, type SdkLiveManifest, type Simulation } from "./manifest.js";
import { LIVE_ACK, LIVE_LIMITS, LIVE_MODEL, LIVE_POLICY, LIVE_RUNS, LIVE_SETTINGS, LIVE_SYSTEM, LIVE_TTL, LIVE_VERSION, type LiveRun } from "./policy.js";
import { journalScope, recoverResults, sealResults, validateRecord, validateSummary, type SdkLiveRecord } from "./records.js";
import type { SdkLiveWorkerResult, SdkLiveWorkerStart } from "./worker.js";
import { syntheticFetch } from "./synthetic.js";

const root = process.cwd(); export const liveRoot = path.join(root, "artifacts/harness/sdk-live");
type Config = ReturnType<typeof resolvePilotPrivateConfig>;
type Gate = ReturnType<typeof createBoundedTransport<string>>;
const infraHash = sha256(JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false }) + "\n");
function workerEnv(agentDir: string) {
	const env: NodeJS.ProcessEnv = {}; for (const [key,value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)) env[key] = value;
	return { ...env, PI_EVAL_WORKER:"1", PI_CODING_AGENT_DIR:agentDir };
}
async function worker(run: LiveRun, config: Config, prepareOnly: boolean, expected: SdkPrepared | null, gate?: Gate, signal?: AbortSignal): Promise<SdkLiveWorkerResult> {
	const directory = await mkdtemp(path.join(process.env.PI_SDK_LIVE_WORK_ROOT!, "task-")), projectRoot = path.join(directory,"project"), agentDir = path.join(directory,"agent");
	await cp(path.join(root,"fixtures/harness-novel"), projectRoot, { recursive:true, errorOnExist:true });
	return new Promise((resolve,reject) => {
		const child = fork(process.env.PI_SDK_LIVE_BUNDLE!, ["worker"], { cwd:root, env:workerEnv(agentDir), silent:true, windowsHide:true,
			execArgv:["--import", pathToFileURL(path.join(root,"scripts/eval-network-guard.mjs")).href] } as ForkOptions & {windowsHide:boolean});
		child.stdout?.resume(); child.stderr?.resume();
		let finished=false, pending=false, next=0, result: SdkLiveWorkerResult | undefined;
		const finish = (error?: Error) => { if (finished) return; finished=true; clearTimeout(timer); signal?.removeEventListener("abort",stop);
			if (error) { gate?.stop("MANUAL_STOP"); child.kill(); reject(error); } else if (result) resolve(result); else reject(new Error("S2_WORKER_UNKNOWN")); };
		const stop = () => finish(new Error("S2_STOPPED"));
		const timer = setTimeout(stop, prepareOnly ? 45000 : LIVE_LIMITS.taskTimeoutMs);
		if (signal?.aborted) { stop(); return; } signal?.addEventListener("abort",stop,{once:true});
		child.on("error",stop); child.on("close",code=>finish(code===0 && result && !pending ? undefined : new Error("S2_WORKER_UNKNOWN")));
		child.on("message",(raw:any) => {
			if (finished) return;
			try {
				if (raw?.type === "result") {
					assert.ok(!result && !pending); exact(raw,["type","value"]); assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 128000);
					exact(raw.value,["prepared","summary","before","after"]); validateSdkPrepared(raw.value.prepared); hashes(raw.value.before); hashes(raw.value.after);
					if (prepareOnly) assert.equal(raw.value.summary,null); else validateSummary(raw.value.summary,run);
					result=raw.value; return;
				}
				exact(raw,["type","invocation","body"]); assert.ok(raw.type === "request" && !prepareOnly && gate && !pending && !result && raw.invocation === next+1
					&& typeof raw.body === "string" && Buffer.byteLength(raw.body) <= LIVE_LIMITS.maxInputBytes);
				pending=true; next++;
				void gate!.invoke(run.runId,async()=> {
					const response=await gate!.fetch(config.endpoint,{method:"POST",body:raw.body,redirect:"error"}); const body=await response.text();
					if (finished) throw new Error("S2_CLOSED"); return {type:"response",invocation:raw.invocation,status:response.status,body};
				}).then(response=> { pending=false; if (!finished) child.send(response,error=>{if(error)stop();}); },()=>{pending=false;stop();});
			} catch { stop(); }
		});
		const start: SdkLiveWorkerStart = {type:"start",run,projectRoot,agentDir,model:{...config.runtimeModel,baseUrl:"https://pilot.invalid/v1"},prepareOnly,expected};
		child.send(start,error=>{if(error)stop();});
	});
}
async function snapshot() {
	const sources=await sdkSources();
	for(const file of ["scripts/run-sdk-live.mjs","scripts/pilot-broker-network.mjs"]) sources[file]=sha256(await readFile(path.join(root,file)));
	for(const file of ["node_modules/openai/package.json","node_modules/openai/client.mjs"]) sources[file]=sha256(await readFile(path.join(root,file)));
	return {sources,fixture:await treeManifest(path.join(root,"fixtures/harness-novel"))};
}
async function runtime() { const pkg=JSON.parse(await readBounded(path.join(root,"node_modules/@mariozechner/pi-coding-agent/package.json")));
	assert.equal(pkg.version,"0.63.1"); return {node:process.version,platform:process.platform,arch:process.arch,piSdk:"0.63.1" as const,lockSha256:sha256(await readFile("package-lock.json"))}; }
async function fileConfig(filename:string,credential:boolean) {
	try { return resolvePilotPrivateConfig(JSON.parse(await readBounded(filename)),process.env,credential); } catch { throw new Error("S2_CONFIG_REJECTED"); }
}
export const syntheticConfig = () => resolvePilotPrivateConfig({providers:{[LIVE_MODEL.provider]:{api:LIVE_MODEL.api,baseUrl:"https://pilot.invalid/v1",apiKey:"synthetic-not-a-key",
	models:[{id:LIVE_MODEL.id,contextWindow:LIVE_MODEL.contextWindow,maxTokens:16384,compat:{maxTokensField:"max_tokens"}}]}}},{},false);
async function prepare(config:Config, simulation:Simulation) {
	await validateSdkProvenance(); checkBaselineGitObjects();
	const {sources,fixture}=await snapshot(), prepared: Record<string,SdkPrepared>={};
	for(const run of LIVE_RUNS) prepared[run.runId]=(await worker(run,config,true,null)).prepared;
	assert.deepEqual(await snapshot(),{sources,fixture},"S2_SOURCE_DRIFT");
	await mkdir(liveRoot,{recursive:true}); const mode=simulation === "none" ? "live" : "dry-run";
	const directory=await mkdtemp(path.join(liveRoot,mode === "live" ? "s2-live-" : "s2-dry-"));
	const git=(args:string[])=>{const r=spawnSync("git",args,{cwd:root,encoding:"utf8",windowsHide:true});assert.equal(r.status,0);return r.stdout.trim();};
	const createdAt=new Date().toISOString();
	const manifest=validateLiveManifest({schemaVersion:1,kind:"sdk-ablation-live-manifest",mode,simulation,batchId:path.basename(directory),createdAt,expiresAt:new Date(Date.parse(createdAt)+LIVE_TTL).toISOString(),
		model:config.publicModel,endpointSha256:config.endpointSha256,configSha256:config.configSha256,
		code:{commit:git(["rev-parse","HEAD"]),dirty:!!git(["status","--porcelain"]),files:sources,sha256:digest(sources)},fixture:{files:fixture,sha256:digest(fixture)},runtime:await runtime(),
		prepared,runs:LIVE_RUNS,limits:LIVE_LIMITS,version:LIVE_VERSION,settings:LIVE_SETTINGS,prompts:promptHashes(),systemSha256:sha256(LIVE_SYSTEM),estimator:"serialized-utf8-bytes-upper-bound-v1"});
	const manifestSha256=await durableJson(path.join(directory,"manifest.json"),manifest); return {directory,manifest,manifestSha256};
}
export async function prepareSdkLive(filename:string) { return prepare(await fileConfig(filename,false),"none"); }
export async function checkAuthorization(directory:string,approvalSha:string,acceptsUnknownCost:boolean) {
	await assertInside(liveRoot,directory); const batch=await readManifest(directory); assert.equal(path.basename(directory),batch.manifest.batchId);
	authorize(batch.manifest,batch.manifestSha256,acceptsUnknownCost ? `${approvalSha}\n${LIVE_ACK}` : null);
	assert.deepEqual((await readdir(directory)).sort(),["manifest.json"],"S2_ALREADY_CLAIMED");
	const head=spawnSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8",windowsHide:true});assert.equal(head.status,0);assert.equal(head.stdout.trim(),batch.manifest.code.commit,"S2_HEAD_DRIFT");
	assert.deepEqual(await snapshot(),{sources:batch.manifest.code.files,fixture:batch.manifest.fixture.files},"S2_SOURCE_DRIFT");
	assert.deepEqual(await runtime(),batch.manifest.runtime,"S2_RUNTIME_DRIFT"); return batch;
}
function boundary(run:LiveRun,before:Record<string,string>,after:Record<string,string>) {
	return Object.entries(before).every(([name,hash])=>after[name]===hash) && Object.keys(after).every(name=>name in before
		|| name === ".pi/settings.json" && after[name]===infraHash || run.taskId === "P5A-TOOL-001" && name===SDK_TARGET && after[name]===sha256(SDK_CONTENT));
}
async function execute(directory:string, manifest:SdkLiveManifest, manifestSha256:string, config:Config, fetchImpl:typeof fetch) {
	assert.equal(manifest.configSha256,config.configSha256); assert.equal(manifest.endpointSha256,config.endpointSha256); assert.deepEqual(manifest.model,config.publicModel);
	const expected={sources:manifest.code.files,fixture:manifest.fixture.files}; assert.deepEqual(await snapshot(),expected); assert.deepEqual(await runtime(),manifest.runtime);
	const journal=await journalScope.create(path.join(directory,"journal"),manifestSha256,manifest.mode); await mkdir(path.join(directory,"raw"));
	const gate=createBoundedTransport({endpoint:config.endpoint,modelId:LIVE_MODEL.id,outputField:config.publicModel.outputField,fetchImpl,estimateInput:body=>body.byteLength,
		beforeDispatch:async request=>{assert.deepEqual(await snapshot(),expected);assert.ok(Date.now()<Date.parse(manifest.expiresAt));await journal.reserve(request);},
		onRequestFinished:async request=>{await journal.settle({ordinal:request.ordinal,taskId:request.taskId,invocationId:request.invocationId,dispatchAttempted:request.dispatchAttempted,status:"complete",reasonCode:null,usage:request.usage});}
	},LIVE_POLICY);
	const abort=new AbortController(),stop=()=>{gate.stop("MANUAL_STOP");abort.abort();}; const timer=setTimeout(stop,LIVE_LIMITS.batchTimeoutMs);
	process.once("SIGINT",stop);process.once("SIGTERM",stop); let stopped=false;
	try {
		for(const run of manifest.runs) {
			let record:SdkLiveRecord={schemaVersion:1,manifestSha256,run,status:"blocked",reasonCode:"BATCH_STOPPED",checks:{source:false,fixture:false,prepared:false,boundary:false},summary:null};
			if(!stopped) {
				try {
					assert.deepEqual(await snapshot(),expected);
					const result=await worker(run,config,false,manifest.prepared[run.runId],gate,abort.signal);
					// Preserve actual observed metrics even when a later source audit fails.
					record={...record,status:"unknown",reasonCode:"SOURCE_DRIFT",summary:result.summary};
					const current=await snapshot(),checks={source:digest(current.sources)===digest(expected.sources),fixture:digest(current.fixture)===digest(expected.fixture)&&digest(result.before)===digest(expected.fixture),
						prepared:digest(result.prepared)===digest(manifest.prepared[run.runId]),boundary:boundary(run,result.before,result.after)};
					const safe=Object.values(checks).every(Boolean)&&gate.snapshot().state === "active"&&result.summary!.status!=="unknown"&&result.summary!.sdkUsage!==null;
					record={...record,checks,status:safe?result.summary!.status:"unknown",reasonCode:safe?result.summary!.reasonCode:result.summary!.status==="unknown"?result.summary!.reasonCode:"SOURCE_DRIFT"};
					stopped=!safe;
				} catch { stopped=true; record={...record,status:"unknown",reasonCode:record.summary?"SOURCE_DRIFT":"WORKER_UNKNOWN"}; }
				if(stopped) gate.stop("MANUAL_STOP");
			}
			validateRecord(record,manifest,manifestSha256,run); await durableJson(path.join(directory,`raw/${run.runId}.json`),record);
		}
		const disk=await journalScope.recover(path.join(directory,"journal"),manifestSha256);
		for(const reservation of disk.reservations.filter(r=>!r.settlement)) {
			const request=gate.snapshot().requests.find(r=>r.ordinal===reservation.ordinal);
			await journal.settle({ordinal:reservation.ordinal,taskId:reservation.taskId,invocationId:reservation.invocationId,dispatchAttempted:request?.dispatchAttempted??true,status:"unknown",reasonCode:request?.reasonCode??"MANUAL_STOP",usage:null});
		}
		await journal.finalize(stopped?"aborted":"complete"); await sealResults(directory);
		const aggregate=await recoverResults(directory); await durableJson(path.join(directory,"aggregate.json"),aggregate); return aggregate;
	} finally {clearTimeout(timer);process.off("SIGINT",stop);process.off("SIGTERM",stop);gate.stop("MANUAL_STOP");}
}
export async function runSdkLive(directory:string,filename:string,approvalSha:string,acceptsUnknownCost:boolean) {
	const {manifest,manifestSha256}=await checkAuthorization(directory,approvalSha,acceptsUnknownCost);
	const configSha=sha256(await readBounded(filename)), config=await fileConfig(filename,true);
	const network=await import(pathToFileURL(path.join(root,"scripts/pilot-broker-network.mjs")).href);
	try { return await execute(directory,manifest,manifestSha256,config,network.createPinnedFetch(config.endpoint,config.credential)); }
	finally {assert.equal(sha256(await readBounded(filename)),configSha,"S2_PRIVATE_CONFIG_CHANGED");}
}
export async function runSdkDry(simulation:Exclude<Simulation,"none">="readback") {
	assert.ok((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active); const config=syntheticConfig(),batch=await prepare(config,simulation);
	const aggregate=await execute(batch.directory,batch.manifest,batch.manifestSha256,config,syntheticFetch(simulation));
	return {directory:batch.directory,aggregate};
}
