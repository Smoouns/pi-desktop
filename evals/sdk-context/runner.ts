import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, digest, readBounded, sha256, treeManifest, writeOnce } from "../core/io.js";
import { validateContextProvenance, extensionSource } from "./extension.js";
import { CONTENT, CHECKS, LARGE, LARGE_TEXT, LIMITS, PROFILES, SOURCE, expectedStatus, runPlan, type Profile, type Scenario, type Task } from "./policy.js";
import { expectedResult, judge, policy, rebuild, validateManifest, validateResult, validateStage, type Manifest, type Result } from "./records.js";
import type { Stage, StageResult } from "./session.js";

export async function snapshot() {
	const sources=JSON.parse(await readBounded(process.env.PI_CONTEXT_BUILD_INPUTS!)) as Record<string,string>;
	for(const [file,expected] of Object.entries(sources)){assert.ok(/^(evals|tests)\//.test(file));assert.equal(sha256(await readFile(file)),expected);}
	for(const file of ["package.json","package-lock.json","scripts/run-sdk-context.mjs","scripts/eval-network-guard.mjs"])sources[file]=sha256(await readFile(file));
	for(const name of ["@mariozechner/pi-coding-agent","@mariozechner/pi-agent-core","@mariozechner/pi-ai"]){const dir=`node_modules/${name}`;sources[dir+"/package.json"]=sha256(await readFile(dir+"/package.json"));sources[dir+"/dist-tree"]=digest(await treeManifest(dir+"/dist"));}
	return {sources,fixture:await treeManifest("fixtures/harness-novel")};
}
export async function setupWork() {
	const work=await mkdtemp(path.join(process.env.PI_CONTEXT_WORK_ROOT!,"task-"));await cp("fixtures/harness-novel",path.join(work,"project"),{recursive:true,errorOnExist:true});
	await mkdir(path.join(work,"project/notes"),{recursive:true});await writeFile(path.join(work,"project",LARGE),LARGE_TEXT,{flag:"wx"});return work;
}
export async function stageWorker(work:string,profile:Profile,task:Task,stage:Stage,scenario:Scenario="normal") {
	await assertInside(process.env.PI_CONTEXT_WORK_ROOT!,work);
	const result=spawnSync(process.execPath,["--import",pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href,process.env.PI_CONTEXT_BUNDLE!,"worker",work,profile,task,stage,scenario],
		{cwd:process.cwd(),env:{...process.env,PI_EVAL_WORKER:"1",PI_CODING_AGENT_DIR:path.join(work,"agent")},encoding:"utf8",timeout:LIMITS.timeoutMs,maxBuffer:32000,windowsHide:true});
	if(result.status!==0){console.error(`S3 worker ${profile}/${task}/${stage}: ${result.stderr.slice(0,2000)}`);throw new Error("S3_WORKER_UNKNOWN");}
	return validateStage(JSON.parse(await readBounded(path.join(work,stage+".json"),128000)));
}
export async function mutateResume(work:string,scenario:Scenario) {
	const source=path.join(work,"project",SOURCE);await assertInside(work,source);
	if(scenario==="missing-source")await rm(source);
	else if(scenario==="corrupt-checkpoint") {
		const state=JSON.parse(await readBounded(path.join(work,"resume-state.json"))),file=path.resolve(work,"agent",state.sessionFile);await assertInside(work,file);
		const entries=(await readFile(file,"utf8")).trimEnd().split("\n").map(line=>JSON.parse(line));
		const latest=[...entries].reverse().find(e=>e.type==="custom"&&e.customType==="pi-desktop-task-checkpoint");assert.ok(latest);latest.data.id="cp_tampered";
		await writeFile(file,entries.map(e=>JSON.stringify(e)).join("\n")+"\n");
	} else if(scenario==="normal")await writeFile(source,(await readFile(source,"utf8"))+"\nS3 synthetic source revision.\n");
}
export async function runScenario(profile:Profile,task:Task,scenario:Scenario="normal") {
	const work=await setupWork();const stages:StageResult[]=[];
	try {
		if(task!=="compact-resume")stages.push(await stageWorker(work,profile,task,"single",scenario));
		else {stages.push(await stageWorker(work,profile,task,"seed",scenario));if(!stages[0].compactionFailed){await mutateResume(work,scenario);stages.push(await stageWorker(work,profile,task,"resume",scenario));}}
		return stages;
	} catch { throw Object.assign(new Error("S3_STAGE_FAILED"),{stages}); }
	finally {await assertInside(process.env.PI_CONTEXT_WORK_ROOT!,work);await rm(work,{recursive:true,force:true,maxRetries:3});}
}
export const emptyResult=(status:"unknown"|"blocked"):Result=>({status,reason:status==="blocked"?"BATCH_STOPPED":"WORKER_UNKNOWN",checks:Object.fromEntries(CHECKS.map(k=>[k,false])) as Result["checks"],stages:null});
export async function runBatch() {
	assert.ok((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active);await validateContextProvenance();const initial=await snapshot();
	const pkg=JSON.parse(await readBounded("node_modules/@mariozechner/pi-coding-agent/package.json"));assert.equal(pkg.version,"0.63.1");
	const root=path.resolve("artifacts/harness/sdk-context");await mkdir(root,{recursive:true});const directory=await mkdtemp(path.join(root,"s3-offline-"));await mkdir(path.join(directory,"raw"));
	const git=(args:string[])=>{const r=spawnSync("git",args,{encoding:"utf8",windowsHide:true});assert.equal(r.status,0);return r.stdout.trim();};
	const manifest:Manifest=validateManifest({schemaVersion:1,kind:"sdk-context-offline",batchId:path.basename(directory),createdAt:new Date().toISOString(),code:{commit:git(["rev-parse","HEAD"]),dirty:!!git(["status","--porcelain"]),files:initial.sources,sha256:digest(initial.sources)},runtime:{node:process.version,platform:process.platform,arch:process.arch,sdk:"0.63.1"},fixture:initial.fixture,policy:policy(),extensions:Object.fromEntries(PROFILES.map(p=>[p,sha256(extensionSource(p))])),runs:runPlan()});
	await writeOnce(path.join(directory,"manifest.json"),manifest);const manifestSha256=sha256(await readFile(path.join(directory,"manifest.json")));const entries=[];let stopped=false;
	for(const run of manifest.runs){let result=emptyResult("blocked");if(!stopped){let stages:StageResult[]|null=null;try{assert.deepEqual(await snapshot(),initial);stages=await runScenario(run.profile,run.task);assert.deepEqual(await snapshot(),initial);result=judge(run,stages);
		// Only predeclared missing-capability negative outcomes may continue.
		stopped=!expectedResult(run,result);
	}catch(error){stopped=true;stages??=(error as any)?.stages??null;result=stages?.length?judge(run,stages,false):emptyResult("unknown");}}
		validateResult(result,run,manifest);const file=`raw/${run.runId}.json`;await writeOnce(path.join(directory,file),{schemaVersion:1,manifestSha256,run,result});entries.push({runId:run.runId,file,sha256:sha256(await readFile(path.join(directory,file)))});
		console.log(`${run.runId}: ${result.status} (${result.reason})`);
	}
	await writeOnce(path.join(directory,"index.json"),{schemaVersion:1,manifestSha256,entries});const aggregate=await rebuild(directory);await writeOnce(path.join(directory,"aggregate.json"),aggregate);
	return {directory,aggregate};
}
