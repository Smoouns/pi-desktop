import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInside, digest, sha256, treeManifest } from "../../evals/core/io.js";
import { createBoundedTransport } from "../../evals/core/request-transport.js";
import { freezeRequestPolicy } from "../../evals/core/request-policy.js";
import { createPilotTransport } from "../../evals/pilot/transport.js";
import { recoverPilotJournal } from "../../evals/pilot/journal.js";
import { authorize, durableJson, readManifest, validateLiveManifest, type SdkLiveManifest, type Simulation } from "../../evals/sdk-live/manifest.js";
import { LIVE_ACK, LIVE_LIMITS, LIVE_MODEL, LIVE_POLICY, LIVE_RUNS } from "../../evals/sdk-live/policy.js";
import { journalScope, recoverResults, validateRecord } from "../../evals/sdk-live/records.js";
import { liveRoot, runSdkDry, runSdkLive } from "../../evals/sdk-live/runner.js";

const endpoint="https://pilot.invalid/v1/chat/completions";
const body=()=>JSON.stringify({model:LIVE_MODEL.id,max_tokens:2048,messages:[]});
const response=()=>new Response('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n');
const options={endpoint,modelId:LIVE_MODEL.id,outputField:"max_tokens" as const,estimateInput:()=>1,fetchImpl:async()=>response()};
const consume=(gate:ReturnType<typeof createBoundedTransport>,id=LIVE_RUNS[0].runId)=>gate.invoke(id,async()=>(await gate.fetch(endpoint,{method:"POST",body:body()})).text());
async function clean(parent:string,folder:string){await assertInside(parent,folder);await rm(folder,{recursive:true,force:true,maxRetries:3});}
async function coreTests(parent:string) {
	let count=0;
	const test=async(name:string,run:()=>void|Promise<void>)=>{try{await run();count++;}catch(error){console.error(`S2 core failed: ${name}`);throw error;}};
	await test("24 scoped reservations and no refund",async()=>{const gate=createBoundedTransport(options,LIVE_POLICY);for(const run of LIVE_RUNS)for(let i=0;i<6;i++)await consume(gate,run.runId);
		assert.equal(gate.snapshot().requestsReserved,24);await assert.rejects(()=>consume(gate));assert.equal(gate.snapshot().stopCode,"BATCH_REQUEST_LIMIT");assert.throws(()=>gate.reset());});
	await test("per profile task cap",async()=>{const gate=createBoundedTransport(options,LIVE_POLICY);for(let i=0;i<6;i++)await consume(gate);await assert.rejects(()=>consume(gate));assert.equal(gate.snapshot().stopCode,"TASK_REQUEST_LIMIT");});
	await test("legacy cap remains four per task",async()=>{const gate=createPilotTransport(options);for(let i=0;i<4;i++)await gate.invoke("P5P-READ-001",async()=>(await gate.fetch(endpoint,{method:"POST",body:body()})).text());
		await assert.rejects(()=>gate.invoke("P5P-READ-001",async()=>(await gate.fetch(endpoint,{method:"POST",body:body()})).text()));assert.equal(gate.snapshot().requestsReserved,4);});
	await test("cross namespace denied",async()=>{await assert.rejects(()=>consume(createBoundedTransport(options,LIVE_POLICY),"P5P-READ-001"));});
	await test("mutable policy cannot widen a gate",async()=>{const policy=structuredClone(LIVE_POLICY),gate=createBoundedTransport(options,policy);(policy.taskIds as string[]).push("injected");await assert.rejects(()=>consume(gate,"injected"));});
	await test("invalid policy",()=>{for(const value of [0,-1,NaN,Infinity,1.5])assert.throws(()=>freezeRequestPolicy({...LIVE_POLICY,limits:{...LIVE_LIMITS,maxHttpRequests:value}}));});
	for(const phase of ["reserve","settle"] as const)await test(`${phase} failure stops delivery`,async()=>{let fetches=0,delivered=false;
		const gate=createBoundedTransport({...options,fetchImpl:async()=>{fetches++;return response();},...(phase==="reserve"?{beforeDispatch:async()=>{throw new Error("private-canary");}}:{onRequestFinished:async()=>{throw new Error("private-canary");}})},LIVE_POLICY);
		await assert.rejects(async()=>{await consume(gate);delivered=true;});assert.equal(delivered,false);assert.equal(fetches,phase==="reserve"?0:1);assert.equal(gate.snapshot().requestsReserved,1);assert.ok(!JSON.stringify(gate.snapshot()).includes("private-canary"));});
	await test("cancel in flight",async()=>{let began!:()=>void;const begun=new Promise<void>(resolve=>{began=resolve;});const gate=createBoundedTransport({...options,fetchImpl:async()=>{began();return new Promise<Response>(()=>{});}},LIVE_POLICY);
		const pending=consume(gate);await begun;gate.stop("MANUAL_STOP");await assert.rejects(()=>pending);assert.equal(gate.snapshot().requests[0].status,"unknown");await assert.rejects(()=>consume(gate));});
	for(const scope of ["request","task","batch"] as const)await test(`${scope} deadline`,async()=>{let now=0;const policy={...LIVE_POLICY,limits:{...LIVE_LIMITS,requestTimeoutMs:Number(LIVE_LIMITS.requestTimeoutMs)}};if(scope==="request")policy.limits.requestTimeoutMs=1;
		const gate=createBoundedTransport({...options,now:()=>now,fetchImpl:scope==="request"?async()=>new Promise<Response>(()=>{}):options.fetchImpl},policy);
		if(scope==="task") {await consume(gate);now=LIVE_LIMITS.taskTimeoutMs;}if(scope==="batch")now=LIVE_LIMITS.batchTimeoutMs;
		await assert.rejects(()=>consume(gate));assert.equal(gate.snapshot().stopCode,`${scope.toUpperCase()}_TIMEOUT`);});
	for(const what of ["input","output","model","endpoint"] as const)await test(`${what} preflight`,async()=>{let calls=0;const gate=createBoundedTransport({...options,fetchImpl:async()=>{calls++;return response();},estimateInput:()=>what==="input"?32769:1},LIVE_POLICY);
		await assert.rejects(()=>gate.invoke(LIVE_RUNS[0].runId,()=>gate.fetch(what==="endpoint"?"https://forbidden.invalid":endpoint,{method:"POST",body:JSON.stringify({model:what==="model"?"wrong":LIVE_MODEL.id,max_tokens:what==="output"?2049:2048})})));assert.equal(calls,0);});
	await test("durable reserve then settle then SDK",async()=>{const directory=await mkdtemp(path.join(parent,"journal-")),sha="a".repeat(64),journal=await journalScope.create(directory,sha,"dry-run");let order:string[]=[];
		const gate=createBoundedTransport({...options,beforeDispatch:async request=>{await journal.reserve(request);order.push("reserve");},fetchImpl:async()=>{const disk=await journalScope.recover(directory,sha);assert.equal(disk.pending,1);order.push("fetch");return response();},
			onRequestFinished:async request=>{await journal.settle({ordinal:request.ordinal,taskId:request.taskId,invocationId:request.invocationId,dispatchAttempted:true,status:"complete",reasonCode:null,usage:request.usage});order.push("settle");}},LIVE_POLICY);
		await consume(gate);order.push("sdk");assert.deepEqual(order,["reserve","fetch","settle","sdk"]);await journal.finalize("complete");assert.ok((await journalScope.recover(directory,sha)).canPass);
		await assert.rejects(()=>journalScope.create(directory,sha,"dry-run"));await assert.rejects(()=>recoverPilotJournal(directory,sha));});
	await test("crash reserve remains unknown",async()=>{const directory=await mkdtemp(path.join(parent,"journal-")),sha="b".repeat(64),journal=await journalScope.create(directory,sha,"dry-run");
		await journal.reserve({ordinal:1,taskId:LIVE_RUNS[0].runId,invocationId:1,inputEstimate:2,inputBytes:2,outputReserved:2048,requestSha256:"c".repeat(64)});
		const before=await treeManifest(directory),recovered=await journalScope.recover(directory,sha);assert.equal(recovered.unknown,1);assert.equal(recovered.dispatchAttempted,1);assert.equal(recovered.canPass,false);assert.deepEqual(await treeManifest(directory),before);});
	await test("journal strict chain and quota",async()=>{const directory=await mkdtemp(path.join(parent,"journal-")),sha="b".repeat(64),journal=await journalScope.create(directory,sha,"dry-run");
		const reserve=(ordinal:number)=>({ordinal,taskId:LIVE_RUNS[0].runId,invocationId:ordinal,inputEstimate:2,inputBytes:2,outputReserved:2048,requestSha256:"c".repeat(64)});
		for(let i=1;i<=6;i++)await journal.reserve(reserve(i));await assert.rejects(()=>journal.reserve(reserve(7)));await writeFile(path.join(directory,"event-000001.json"),"{}");await assert.rejects(()=>journalScope.recover(directory,sha));});
	return count;
}

export async function runSdkLiveTests() {
	const parent=process.env.PI_SDK_LIVE_WORK_ROOT!,temporary=await mkdtemp(path.join(parent,"tests-"));let count=0;
	try {
		console.log("SDK S2: transport and durable journal");count+=await coreTests(temporary);
		console.log("SDK S2: complete broker readback");const result=await runSdkDry();assert.equal(result.aggregate.status,"pass");assert.equal(result.aggregate.simulatedHttpDispatches,10);count++;
		const before=await treeManifest(result.directory);assert.deepEqual(await recoverResults(result.directory),result.aggregate);assert.deepEqual(await treeManifest(result.directory),before);count++;
		const {manifest,manifestSha256}=await readManifest(result.directory);
		for(const row of result.aggregate.rows){assert.equal(row.providerUsage.cachedTokens,null);assert.equal(row.providerUsage.costUsd,null);assert.equal(row.sdkUsage!.totalTokens,row.providerUsage.totalTokens);count++;}
		console.log("SDK S2: authorization and schema guards");
		await assert.rejects(()=>runSdkLive(result.directory,"nonexistent-private-config",manifestSha256,true),/S2_DRY_RUN_NOT_AUTHORIZABLE/);count++;
		await assert.rejects(()=>runSdkLive(result.directory,"nonexistent-private-config",manifestSha256,false),/S2_APPROVAL_REQUIRED/);count++;
		const live=structuredClone(manifest);live.mode="live";live.simulation="none";live.batchId="s2-live-synthetic-test";
		const liveSha=sha256(JSON.stringify(live,null,2)+"\n"),token=`${liveSha}\n${LIVE_ACK}`,now=Date.parse(live.createdAt)+1;
		authorize(live,liveSha,token,now);count++;
		for(const approval of [null,"",manifestSha256,`${manifestSha256}\n${LIVE_ACK}`,`${liveSha}\nI authorize at most 8 live HTTP calls for this manifest and acknowledge that provider cost is unknown.`]){assert.throws(()=>authorize(live,liveSha,approval,now));count++;}
		for(const time of [NaN,Date.parse(live.createdAt)-1,Date.parse(live.expiresAt),Date.parse(live.expiresAt)+1]){assert.throws(()=>authorize(live,liveSha,token,time));count++;}
		const mutations:Array<(m:any)=>void>=[m=>m.limits.maxHttpRequests=25,m=>m.model.maxTokens=4096,m=>m.model.id="other",m=>m.version.driver="scripted-v1",m=>m.settings.retry=true,m=>m.runs.reverse(),m=>m.mode="live",
			m=>m.rawAnswer="private-canary",m=>m.prompts["P5A-READ-001"]="0".repeat(64),m=>m.prepared[LIVE_RUNS[1].runId].toolsSha256="0".repeat(64),m=>m.code.files["../secret"]="0".repeat(64),m=>m.code.sha256="0".repeat(64),m=>m.expiresAt=m.createdAt];
		for(const mutate of mutations){const copy=structuredClone(manifest);mutate(copy);assert.throws(()=>validateLiveManifest(copy));count++;}
		const first=JSON.parse(await readFile(path.join(result.directory,`raw/${LIVE_RUNS[0].runId}.json`),"utf8"));
		for(const mutate of [(r:any)=>r.summary=null,(r:any)=>r.summary.checks.read=false,(r:any)=>r.summary.metrics.writeDispatches=1,(r:any)=>r.summary.metrics.runStops=1,(r:any)=>r.summary.sdkUsage=null,
			(r:any)=>r.summary.answerCodes=["PRIVATE_MESSAGE"],(r:any)=>r.summary.rawAnswer="private-canary",(r:any)=>r.run=LIVE_RUNS[1],(r:any)=>r.summary.prepared.systemSha256="0".repeat(64)]){
			const copy=structuredClone(first);mutate(copy);assert.throws(()=>validateRecord(copy,manifest,manifestSha256,LIVE_RUNS[0]));count++;}
		for(const fault of ["raw-missing","raw-extra","raw-drift","index-duplicate","journal-gap"]){const folder=await mkdtemp(path.join(temporary,"tamper-"));await cp(result.directory,folder,{recursive:true});
			if(fault==="raw-missing")await rm(path.join(folder,`raw/${LIVE_RUNS[0].runId}.json`));
			if(fault==="raw-extra")await writeFile(path.join(folder,"raw/extra.json"),"{}");
			if(fault==="raw-drift")await writeFile(path.join(folder,`raw/${LIVE_RUNS[0].runId}.json`),JSON.stringify({...first,reasonCode:"TASK_FAILED"}));
			if(fault==="index-duplicate"){const file=path.join(folder,"result-index.json"),index=JSON.parse(await readFile(file,"utf8"));index.entries[1]=index.entries[0];await writeFile(file,JSON.stringify(index));}
			if(fault==="journal-gap")await rm(path.join(folder,"journal/event-000001.json"));
			await assert.rejects(()=>recoverResults(folder));count++;}
		const driftDir=await mkdtemp(path.join(liveRoot,"s2-live-test-"));
		try {const drift:SdkLiveManifest={...live,batchId:path.basename(driftDir)};drift.code=structuredClone(live.code);drift.code.files[Object.keys(drift.code.files)[0]]="0".repeat(64);drift.code.sha256=digest(drift.code.files);
			const hash=await durableJson(path.join(driftDir,"manifest.json"),drift);await assert.rejects(()=>runSdkLive(driftDir,"nonexistent-private-config",hash,true),/S2_SOURCE_DRIFT/);count++;
		}finally{await clean(liveRoot,driftDir);}
		for(const simulation of ["replay","answer-format","network","missing-usage","forbidden-path","forbidden-tool","request-limit"] as Exclude<Simulation,"none"|"readback">[]){
			console.log(`SDK S2 fault: ${simulation}`);const batch=await runSdkDry(simulation),aggregate=batch.aggregate;
			assert.equal(aggregate.realHttpDispatches,0);count++;
			if(simulation==="replay"){assert.equal(aggregate.status,"completed-with-failures");assert.deepEqual(aggregate.rows.map(row=>row.status),["pass","pass","pass","fail"]);assert.equal(aggregate.rows[2].metrics!.writeDispatches,1);assert.equal(aggregate.rows[3].metrics!.writeDispatches,2);assert.equal(aggregate.simulatedHttpDispatches,12);count++;}
			else if(simulation==="answer-format"){assert.equal(aggregate.status,"completed-with-failures");assert.deepEqual(aggregate.rows[0].answerCodes,["ANSWER_MARKDOWN_FENCE"]);assert.deepEqual(aggregate.rows.map(row=>row.status),["fail","pass","pass","pass"]);assert.equal(aggregate.simulatedHttpDispatches,10);count++;}
			else {assert.equal(aggregate.status,"incomplete");assert.deepEqual(aggregate.rows.map(row=>row.status),["unknown","blocked","blocked","blocked"]);assert.equal(aggregate.simulatedHttpDispatches,simulation==="request-limit"?6:1);count++;
				if(simulation==="network"||simulation==="missing-usage"){assert.equal(aggregate.rows[0].providerUsage.totalTokens,null);assert.equal(aggregate.rows[0].metrics,null);assert.equal(aggregate.possibleUnknownDispatches,1);count++;}}
			const frozen=await treeManifest(batch.directory);assert.deepEqual(await recoverResults(batch.directory),aggregate);assert.deepEqual(await treeManifest(batch.directory),frozen);count++;
			console.log(`SDK S2 retained ${simulation}: ${path.basename(batch.directory)}`);
			for(const name of Object.keys(frozen)){const text=await readFile(path.join(batch.directory,name),"utf8");assert.ok(!/https?:\/\/|private-canary|PRIVATE_MESSAGE|broker-placeholder-not-a-key/.test(text));}count++;
		}
		console.log(`SDK S2 retained readback: ${path.basename(result.directory)}`);return count;
	}finally{await clean(parent,temporary);}
}
