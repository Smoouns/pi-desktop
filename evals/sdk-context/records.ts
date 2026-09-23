import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertInside, digest, readBounded, sha256 } from "../core/io.js";
import { CHECKS, CONTENT, FEATURES, LARGE_TEXT, LIMITS, MODEL, PROFILES, PROMPTS, REASONS, SYSTEM, emptyMetrics, runPlan, type Run } from "./policy.js";
import type { StageResult } from "./session.js";

export const policy = () => ({ features: FEATURES, limits: LIMITS, model: MODEL.id, driver: "synthetic-sdk-context-v1", estimator: "complete-synthetic-json-utf8-bytes",
	systemSha256: sha256(SYSTEM), promptSha256: digest(PROMPTS), generatedFixtureSha256: sha256(LARGE_TEXT), providerUsage: null, costUsd: null });
export interface Manifest { schemaVersion: 1; kind: "sdk-context-offline"; batchId: string; createdAt: string;
	code: { commit: string; dirty: boolean; files: Record<string,string>; sha256: string };
	runtime: { node: string; platform: string; arch: string; sdk: "0.63.1" }; fixture: Record<string,string>;
	policy: ReturnType<typeof policy>; extensions: Record<string,string>; runs: ReturnType<typeof runPlan>; }
export interface Result { status: "pass" | "fail" | "unknown" | "blocked"; reason: typeof REASONS[number]; checks: Record<typeof CHECKS[number],boolean>; stages: StageResult[] | null; }
export const exact = (value: any, names: readonly string[]) => { assert.ok(value && typeof value === "object" && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...names].sort()); return value; };
export const hash = (value: unknown) => assert.ok(typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
export const count = (value: unknown, max = 1000000) => assert.ok(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max);
function fileMap(value: any) { assert.ok(value && typeof value === "object" && !Array.isArray(value)); assert.ok(Object.keys(value).length > 0 && Object.keys(value).length < 4096); for (const [name,h] of Object.entries(value)) { assert.ok(name.length < 512 && !/[\\:\x00-\x1f]/.test(name) && !name.split("/").some(p=>!p || p==="." || p==="..")); hash(h); } }
export function validateManifest(value: unknown): Manifest {
	const m = exact(value, ["schemaVersion","kind","batchId","createdAt","code","runtime","fixture","policy","extensions","runs"]);
	assert.equal(m.schemaVersion,1); assert.equal(m.kind,"sdk-context-offline"); assert.match(m.batchId,/^s3-offline-[A-Za-z0-9_-]+$/); assert.equal(new Date(m.createdAt).toISOString(),m.createdAt);
	exact(m.code,["commit","dirty","files","sha256"]); assert.match(m.code.commit,/^[0-9a-f]{40}$/); assert.equal(typeof m.code.dirty,"boolean"); fileMap(m.code.files); assert.equal(digest(m.code.files),m.code.sha256);
	exact(m.runtime,["node","platform","arch","sdk"]); for (const v of Object.values(m.runtime)) assert.match(v as string,/^[A-Za-z0-9_.-]{1,64}$/); assert.equal(m.runtime.sdk,"0.63.1");
	fileMap(m.fixture); assert.deepEqual(m.policy,policy()); exact(m.extensions,PROFILES); Object.values(m.extensions).forEach(hash); assert.deepEqual(m.runs,runPlan()); return m;
}
const stageBooleans = ["inventory","settings","boundary","zeroNetwork","markerSeen","fromHook","compactionFailed","reopened","checkpointRestored","oldObservationDenied","blockedBeforeRefresh","prematureRefreshBlocked","refreshSucceeded"];
export function validateStage(value: unknown): StageResult {
	const s = exact(value,["stage",...stageBooleans,"metrics","receipts","tools","writes","nativeCompactions","finalFileSha256","extensionSha256","toolSchemaSha256","promptSha256"]);
	assert.ok(["single","seed","resume"].includes(s.stage)); stageBooleans.forEach(k=>assert.equal(typeof s[k],"boolean"));
	exact(s.metrics,Object.keys(emptyMetrics())); Object.values(s.metrics).forEach(v=>count(v,256)); count(s.tools,LIMITS.tools); count(s.writes,s.tools); count(s.nativeCompactions,1);
	for (const k of ["extensionSha256","toolSchemaSha256","promptSha256"]) hash(s[k]); if (s.finalFileSha256!==null) hash(s.finalFileSha256);
	assert.ok(Array.isArray(s.receipts)&&s.receipts.length<=LIMITS.syntheticRequests+2);
	for(const row of s.receipts) { exact(row,["kind","payloadBytes","outputReserve","payloadSha256","disposition"]); assert.ok(["agent","summary"].includes(row.kind)); count(row.payloadBytes,1024*1024); count(row.outputReserve,4096); hash(row.payloadSha256); assert.ok(["dispatched","product-blocked","outer-blocked","aborted"].includes(row.disposition)); if(row.disposition==="dispatched")assert.ok(row.payloadBytes+row.outputReserve+LIMITS.safetyMargin<=LIMITS.outerBytes); }
	assert.ok(s.receipts.filter((r: any)=>r.disposition==="dispatched").length<=LIMITS.syntheticRequests);
	if(s.stage!=="resume")assert.ok(!s.reopened); else assert.ok(s.reopened);
	return s;
}
export function judge(run: Run, stages: StageResult[], source = true): Result {
	stages.forEach(validateStage);
	const receipts = stages.flatMap(s=>s.receipts), last=stages.at(-1)!;
	const complete = run.task==="compact-resume" ? stages.length===2&&stages[0].stage==="seed"&&last.stage==="resume" : stages.length===1&&last.stage==="single";
	const checks={ source, inventory:stages.every(s=>s.inventory), settings:stages.every(s=>s.settings), boundary:stages.every(s=>s.boundary), zeroNetwork:stages.every(s=>s.zeroNetwork), requestContract:false, taskContract:false };
	if(run.task==="request-budget") { checks.requestContract=receipts.length===1&&receipts[0].disposition==="product-blocked"&&last.metrics.budgetBlocks===1; checks.taskContract=last.tools===0&&last.writes===0; }
	else if(run.task==="large-result") { checks.requestContract=receipts.every(r=>r.disposition==="dispatched"&&r.payloadBytes+LIMITS.outputReserve+LIMITS.safetyMargin<=LIMITS.contextBytes); checks.taskContract=last.markerSeen&&last.writes===0&&receipts.length>=2; }
	else { checks.requestContract=receipts.every(r=>r.disposition==="dispatched"); checks.taskContract=complete&&stages[0].nativeCompactions===1&&!stages[0].fromHook&&!stages[0].compactionFailed&&stages[0].receipts.some(r=>r.kind==="summary")&&last.reopened&&last.checkpointRestored&&last.oldObservationDenied&&last.blockedBeforeRefresh&&last.prematureRefreshBlocked&&last.refreshSucceeded&&last.writes===1&&last.finalFileSha256===sha256(CONTENT); }
	const safe=complete&&checks.source&&checks.inventory&&checks.settings&&checks.boundary&&checks.zeroNetwork;
	const success=safe&&Object.values(checks).every(Boolean);
	const reason=success?"PASS":!safe?"WORKER_UNKNOWN":!checks.requestContract&&run.profile==="sdk-b1-reliability"?"MISSING_PRODUCT_BUDGET":run.task==="compact-resume"&&run.profile!=="sdk-b3-checkpoint"?"MISSING_STALE_WRITE_GATE":"CONTRACT_FAILED";
	return {status:success?"pass":safe?"fail":"unknown",reason,checks,stages};
}
export function validateResult(value: unknown, run: Run, m: Manifest): Result {
	const r=exact(value,["status","reason","checks","stages"]); assert.ok(["pass","fail","unknown","blocked"].includes(r.status));assert.ok(REASONS.includes(r.reason));exact(r.checks,CHECKS);Object.values(r.checks).forEach(v=>assert.equal(typeof v,"boolean"));
	if(r.stages===null){assert.ok(r.status==="unknown"||r.status==="blocked");assert.equal(r.reason,r.status==="blocked"?"BATCH_STOPPED":"WORKER_UNKNOWN");assert.ok(Object.values(r.checks).every(v=>v===false));return r;}
	assert.ok(Array.isArray(r.stages)&&r.stages.length>=1&&r.stages.length<=2);
	for(const s of r.stages){validateStage(s);assert.equal(s.extensionSha256,m.extensions[run.profile]);assert.equal(s.promptSha256,digest(run.task==="large-result"?PROMPTS.large:run.task==="request-budget"?PROMPTS.budget:PROMPTS));
		if(run.profile==="sdk-b1-reliability")assert.deepEqual(s.metrics,emptyMetrics());
		if(run.profile!=="sdk-b3-checkpoint")for(const key of ["checkpoints","beforeCompact","afterCompact","staleWriteBlocks","persistenceBlocks","refreshes"])assert.equal(s.metrics[key],0);}
	assert.deepEqual(r,judge(run,r.stages,r.checks.source));return r;
}
/** Strict declared negative controls; arbitrary task failures must stop the matrix. */
export function expectedResult(run: Run, result: Result): boolean {
	if(result.status==="pass")return run.task==="compact-resume"?run.profile==="sdk-b3-checkpoint":run.profile!=="sdk-b1-reliability";
	if(result.status!=="fail"||!result.stages||!["source","inventory","settings","boundary","zeroNetwork"].every(k=>result.checks[k as keyof Result["checks"]]))return false;
	if(run.task!=="compact-resume")return run.profile==="sdk-b1-reliability"&&result.reason==="MISSING_PRODUCT_BUDGET"&&!result.checks.requestContract&&result.checks.taskContract;
	const [seed,resume]=result.stages;
	return run.profile!=="sdk-b3-checkpoint"&&result.reason==="MISSING_STALE_WRITE_GATE"&&result.checks.requestContract&&result.stages.length===2&&seed.nativeCompactions===1&&!seed.fromHook&&!seed.compactionFailed&&seed.receipts.some(r=>r.kind==="summary")&&resume.reopened&&!resume.blockedBeforeRefresh&&resume.writes===1&&resume.finalFileSha256===sha256(CONTENT)&&(run.profile==="sdk-b1-reliability"||resume.oldObservationDenied);
}
export async function rebuild(directory:string) {
	assert.ok((await readdir(directory)).every(name=>["manifest.json","index.json","aggregate.json","raw"].includes(name)),"S3_EXTRA_ARTIFACT");
	const manifestText=await readBounded(path.join(directory,"manifest.json")),manifest=validateManifest(JSON.parse(manifestText)),manifestSha256=sha256(manifestText);
	await assertInside(directory,path.join(directory,"raw"));
	const index=exact(JSON.parse(await readBounded(path.join(directory,"index.json"))),["schemaVersion","manifestSha256","entries"]);assert.equal(index.schemaVersion,1);assert.equal(index.manifestSha256,manifestSha256);
	assert.ok(Array.isArray(index.entries)&&index.entries.length===manifest.runs.length);
	assert.deepEqual((await readdir(path.join(directory,"raw"))).sort(),manifest.runs.map(r=>r.runId+".json").sort());
	const rows=[];let stopped=false;
	for(const [n,run] of manifest.runs.entries()) {const entry=exact(index.entries[n],["runId","file","sha256"]);assert.equal(entry.runId,run.runId);assert.equal(entry.file,`raw/${run.runId}.json`);hash(entry.sha256);
		const text=await readBounded(path.join(directory,entry.file),128000);assert.equal(sha256(text),entry.sha256);const raw=exact(JSON.parse(text),["schemaVersion","manifestSha256","run","result"]);assert.equal(raw.schemaVersion,1);assert.equal(raw.manifestSha256,manifestSha256);assert.deepEqual(raw.run,run);
		const result=validateResult(raw.result,run,manifest);if(stopped)assert.equal(result.status,"blocked");if(!expectedResult(run,result))stopped=true;
		const receipts=result.stages?.flatMap(s=>s.receipts)??null;
		rows.push({...run,status:result.status,reason:result.reason,syntheticAgentRequests:receipts?receipts.filter(r=>r.kind==="agent"&&r.disposition==="dispatched").length:null,syntheticSummaryRequests:receipts?receipts.filter(r=>r.kind==="summary"&&r.disposition==="dispatched").length:null,productBudgetBlocks:receipts?receipts.filter(r=>r.disposition==="product-blocked").length:null,nativeCompactions:result.stages?.[0].nativeCompactions??null,providerUsage:null,costUsd:null});
	}
	return {schemaVersion:1,kind:"sdk-context-offline-aggregate",batchId:manifest.batchId,manifestSha256,realHttpDispatches:0,rows};
}
