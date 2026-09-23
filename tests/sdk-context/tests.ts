import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, sha256, treeManifest } from "../../evals/core/io.js";
import { auditInventory, extensionSource, validateContextProvenance } from "../../evals/sdk-context/extension.js";
import { loadSdkExtension } from "../../evals/sdk-ablation/session.js";
import { runBatch, runScenario, setupWork } from "../../evals/sdk-context/runner.js";
import { expectedResult, judge, rebuild, validateManifest, validateResult, validateStage } from "../../evals/sdk-context/records.js";
import { CONTROL_KEY, CONTENT, LIMITS, PROFILES, SOURCE, TASKS, expectedStatus, type Run } from "../../evals/sdk-context/policy.js";

export async function unitWorker() {
	assert.equal(process.env.PI_EVAL_WORKER,"1");let count=0;const work=await setupWork();
	try {
		const project=path.join(work,"project"),source=path.join(project,SOURCE),original=await readFile(source,"utf8");
		for(const profile of PROFILES){
			const text=extensionSource(profile),file=path.join(work,profile+".ts");await writeFile(file,text);const loaded=await loadSdkExtension(file,project);auditInventory(profile,loaded,text);count++;
			const ext=loaded.extensions[0];
			for(const name of ["turn_end","session_fork","unknown_hook"]){ext.handlers.set(name,[()=>{}]);assert.throws(()=>auditInventory(profile,loaded,text));ext.handlers.delete(name);count++;}
			ext.tools.set("supervisor_approve",{});assert.throws(()=>auditInventory(profile,loaded,text));ext.tools.delete("supervisor_approve");count++;
			assert.throws(()=>auditInventory(profile,loaded,text+"\n// injected"));count++;
			if(profile==="sdk-b1-reliability")continue;
			const binding=(sessionId="s3-unit",role="write")=>({getSessionId:()=>sessionId,getBranch:()=>[{type:"custom",customType:"pi-desktop-novel-role",data:{role}}]});
			let aborted=0;const ctx={cwd:project,sessionManager:binding(),abort:()=>{aborted++;}};
			const event={toolName:"read_story_document",toolCallId:"unit-read",input:{path:SOURCE},isError:false,content:[{type:"text",text:original}],details:{}};
			const transformed=await ext.handlers.get("tool_result")[0](event,ctx),id=transformed.details.observation.id;
			const read=ext.tools.get("read_observation").definition;
			const page=await read.execute("page",{id,start:0,limit:64},undefined,undefined,ctx);assert.equal(page.content[0].text,original.slice(0,64));count++;
			for(const args of [{id,start:-1},{id,start:0.5},{id,limit:0},{id,limit:4001},{id,limit:1.1},{id:"obs_unknown"}]){await assert.rejects(read.execute("invalid",args,undefined,undefined,ctx));count++;}
			for(const other of [{...ctx,sessionManager:binding("other")},{...ctx,sessionManager:binding("s3-unit","plan")},{...ctx,cwd:work}]){await assert.rejects(read.execute("scope",{id,start:0,limit:10},undefined,undefined,other));count++;}
			await writeFile(source,original+"\nchanged");await assert.rejects(read.execute("stale",{id,limit:10},undefined,undefined,ctx));await writeFile(source,original);count++;
			const hook=ext.handlers.get("before_provider_request")[0];
			for(const payload of [{system:"x".repeat(LIMITS.contextBytes)},{tools:[{description:"x".repeat(LIMITS.contextBytes)}]},{messages:[{role:"user",content:"汉".repeat(LIMITS.contextBytes/3+1)}]},{messages:[{type:"image",data:"synthetic"}]},{extra:"x".repeat(LIMITS.contextBytes)}]){const before=aborted;await hook({payload},ctx);assert.equal(aborted,before+1);count++;}
			const before=aborted;await hook({payload:{system:"short",tools:[],messages:[]}},ctx);assert.equal(aborted,before);count++;
			// A fresh extension has no access to observations retained only in its predecessor.
			const reloaded=await loadSdkExtension(file,project);await assert.rejects(reloaded.extensions[0].tools.get("read_observation").definition.execute("expired",{id,limit:10},undefined,undefined,ctx));count++;
			delete (globalThis as any)[Symbol.for(CONTROL_KEY)];
		}
		const guard=(globalThis as any)[Symbol.for("pi.eval.networkGuard")],before=guard.attempts;
		await assert.rejects(async()=>fetch("https://sdk-s3.invalid"));assert.throws(()=>spawnSync(process.execPath,["--version"]));assert.equal(guard.attempts,before+2);count++;
		return count;
	} finally {await assertInside(process.env.PI_CONTEXT_WORK_ROOT!,work);await rm(work,{recursive:true,force:true,maxRetries:3});}
}
export async function runTests() {
	let count=0;
	await validateContextProvenance();count++;
	const unit=spawnSync(process.execPath,["--import",pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href,process.env.PI_CONTEXT_BUNDLE!,"unit-worker"],{cwd:process.cwd(),env:{...process.env,PI_EVAL_WORKER:"1"},encoding:"utf8",timeout:30000,windowsHide:true});
	assert.equal(unit.status,0,unit.stderr);const match=unit.stdout.trim().match(/^S3_UNIT_PASS (\d+)$/);assert.ok(match);count+=Number(match[1]);
	for(const profile of PROFILES)for(const task of TASKS){const stages=await runScenario(profile,task),run:Run={runId:`${profile}-${task}-r1`,profile,task,repetition:1};const result=judge(run,stages);assert.equal(result.status,expectedStatus(profile,task));assert.ok(expectedResult(run,result));count++;
		if(task==="compact-resume"){assert.equal(stages[0].nativeCompactions,1);assert.equal(stages[0].fromHook,false);assert.ok(stages[0].receipts.some(r=>r.kind==="summary"));assert.ok(stages[1].reopened);count++;
			if(profile==="sdk-b3-checkpoint"){assert.ok(stages[1].blockedBeforeRefresh&&stages[1].prematureRefreshBlocked&&stages[1].refreshSucceeded);assert.equal(stages[1].writes,1);count++;}
		}
		const partial=judge(run,[stages[0]],false);assert.equal(partial.status,"unknown");assert.deepEqual(partial.stages?.[0].receipts,stages[0].receipts);count++;
	}
	for(const scenario of ["unchanged","missing-source","corrupt-checkpoint"] as const){const stages=await runScenario("sdk-b3-checkpoint","compact-resume",scenario),last=stages.at(-1)!;assert.equal(last.inventory,true);assert.equal(last.boundary,true);assert.equal(last.zeroNetwork,true);assert.equal(last.writes,scenario==="unchanged"?1:0);assert.equal(last.blockedBeforeRefresh,scenario!=="unchanged");count++;}
	for(const scenario of ["summary-error","summary-cancel","summary-limit"] as const){const stages=await runScenario("sdk-b3-checkpoint","compact-resume",scenario);assert.equal(stages.length,1);assert.ok(stages[0].compactionFailed);assert.equal(stages[0].nativeCompactions,0);assert.equal(stages[0].metrics.beforeCompact,1);assert.equal(stages[0].metrics.afterCompact,0);assert.ok(stages[0].receipts.some(r=>r.kind==="summary"));count++;}
	const batch=await runBatch();assert.equal(batch.aggregate.realHttpDispatches,0);assert.equal(batch.aggregate.rows.filter(r=>r.status==="pass").length,15);assert.equal(batch.aggregate.rows.filter(r=>r.status==="fail").length,12);count++;
	const before=await treeManifest(batch.directory);assert.deepEqual(await rebuild(batch.directory),batch.aggregate);assert.deepEqual(await treeManifest(batch.directory),before);count++;
	const manifest=JSON.parse(await readFile(path.join(batch.directory,"manifest.json"),"utf8"));validateManifest(manifest);const copy=structuredClone(manifest);copy.policy.limits.contextBytes++;assert.throws(()=>validateManifest(copy));count++;
	const passRun=manifest.runs.find((r:Run)=>r.profile==="sdk-b3-checkpoint"&&r.task==="compact-resume"),raw=JSON.parse(await readFile(path.join(batch.directory,"raw",passRun.runId+".json"),"utf8"));
	for(const mutate of [(r:any)=>r.extra="PRIVATE_CANARY",(r:any)=>r.stages[0].receipts[0].extra="secret",(r:any)=>r.stages[0].zeroNetwork=false,(r:any)=>r.stages[0].nativeCompactions=0,(r:any)=>r.stages[1].writes=0,(r:any)=>r.stages[1].checkpointRestored=false,(r:any)=>r.stages[1].oldObservationDenied=false,(r:any)=>r.stages[1].finalFileSha256=sha256("wrong"),(r:any)=>r.stages[1].receipts[0].disposition="product-blocked",(r:any)=>r.stages=null]){const changed=structuredClone(raw.result);mutate(changed);assert.throws(()=>validateResult(changed,passRun,manifest));count++;}
	const temp=await mkdtemp(path.join(process.env.PI_CONTEXT_WORK_ROOT!,"tamper-"));
	try {await cp(batch.directory,temp,{recursive:true});const indexPath=path.join(temp,"index.json"),indexText=await readFile(indexPath,"utf8");
		for(const mutate of [(i:any)=>i.entries.pop(),(i:any)=>i.entries.reverse(),(i:any)=>i.entries[0].sha256="0".repeat(64),(i:any)=>i.entries[0].file="../outside",(i:any)=>i.entries[1]=i.entries[0]]){const index=JSON.parse(indexText);mutate(index);await writeFile(indexPath,JSON.stringify(index));await assert.rejects(rebuild(temp));count++;}await writeFile(indexPath,indexText);
		await writeFile(path.join(temp,"raw/extra.json"),"{}");await assert.rejects(rebuild(temp));count++;
	}finally{await assertInside(process.env.PI_CONTEXT_WORK_ROOT!,temp);await rm(temp,{recursive:true,force:true,maxRetries:3});}
	console.log(`S3 frozen matrix: ${batch.directory} (15 pass, 12 declared capability negatives).`);
	return count;
}
