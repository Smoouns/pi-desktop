import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertInside, digest, readBounded, sha256 } from "../core/io.js";
import { MODEL, SYSTEM } from "./policy.js";
import { exact, hash, count } from "./records.js";
import { LIFE_CONTENT, LIFE_LIMITS, LIFE_PARTIAL, LIFE_PROFILES, LIFE_PROMPTS, lifeExpected, lifePlan, isWriteTask, type LifeRun } from "./lifecycle-policy.js";
import { emptyOperationMetrics, type LifeStageResult } from "./lifecycle-session.js";

export const lifePolicy = () => ({ driver: "synthetic-sdk-lifecycle-v2", limits: LIFE_LIMITS, model: MODEL.id, contextWindow: MODEL.contextWindow,
	trigger: "synthetic-usage-or-overflow-not-provider-actual", autoCompaction: true, autoRetry: false,
	systemSha256: sha256(SYSTEM), promptSha256: digest(LIFE_PROMPTS), providerUsage: null, costUsd: null });
export interface LifeManifest {
	schemaVersion: 2; kind: "sdk-lifecycle-offline"; batchId: string; createdAt: string;
	code: { commit: string; dirty: boolean; files: Record<string, string>; sha256: string };
	runtime: { node: string; platform: string; arch: string; sdk: "0.63.1" };
	fixture: Record<string, string>; policy: ReturnType<typeof lifePolicy>;
	extensions: Record<string, string>; runs: LifeRun[];
}
export const LIFE_CHECKS = ["source", "inventory", "settings", "boundary", "zeroNetwork", "requestContract", "taskContract"] as const;
export interface LifeResult {
	status: "pass" | "fail" | "unknown" | "blocked";
	reason: "PASS" | "MISSING_DURABLE_OPERATION" | "CONTRACT_FAILED" | "WORKER_UNKNOWN" | "BATCH_STOPPED";
	checks: Record<typeof LIFE_CHECKS[number], boolean>; stages: LifeStageResult[] | null;
}
function fileMap(value: any) {
	assert.ok(value && typeof value === "object" && !Array.isArray(value)); assert.ok(Object.keys(value).length > 0 && Object.keys(value).length < 4096);
	for (const [name, h] of Object.entries(value)) { assert.ok(name.length < 512 && !/[\\:\x00-\x1f]/.test(name) && !name.split("/").some(p => !p || p === "." || p === "..")); hash(h); }
}
export function validateLifeManifest(value: unknown): LifeManifest {
	const m = exact(value, ["schemaVersion", "kind", "batchId", "createdAt", "code", "runtime", "fixture", "policy", "extensions", "runs"]);
	assert.equal(m.schemaVersion, 2); assert.equal(m.kind, "sdk-lifecycle-offline"); assert.match(m.batchId, /^s3-lifecycle-[A-Za-z0-9_-]+$/); assert.equal(new Date(m.createdAt).toISOString(), m.createdAt);
	exact(m.code, ["commit", "dirty", "files", "sha256"]); assert.match(m.code.commit, /^[0-9a-f]{40}$/); assert.equal(typeof m.code.dirty, "boolean"); fileMap(m.code.files); assert.equal(digest(m.code.files), m.code.sha256);
	exact(m.runtime, ["node", "platform", "arch", "sdk"]); for (const v of Object.values(m.runtime)) assert.match(v as string, /^[A-Za-z0-9_.-]{1,64}$/); assert.equal(m.runtime.sdk, "0.63.1");
	fileMap(m.fixture); assert.deepEqual(m.policy, lifePolicy()); exact(m.extensions, LIFE_PROFILES); Object.values(m.extensions).forEach(hash); assert.deepEqual(m.runs, lifePlan()); return m;
}
const flags = ["inventory", "settings", "boundary", "zeroNetwork", "reopened", "durableIntentBeforeWrite", "unknownAtCompaction", "fromHook"];
export function validateLifeStage(value: unknown): LifeStageResult {
	const s = exact(value, ["stage", ...flags, "receipts", "tools", "writes", "writeEffects", "lostAcks", "pendingBefore", "pendingAfter", "starts", "ends", "inheritedCompactions", "nativeCompactions", "agentEnds", "writeResults", "operationMetrics", "finalFileSha256", "extensionSha256", "toolSchemaSha256", "promptSha256"]);
	assert.ok(["single", "seed", "resume"].includes(s.stage)); flags.forEach(k => assert.equal(typeof s[k], "boolean")); assert.equal(s.reopened, s.stage === "resume");
	count(s.tools, LIFE_LIMITS.tools); count(s.writes, s.tools); count(s.writeEffects, s.writes); count(s.lostAcks, s.writes);
	for (const key of ["pendingBefore", "pendingAfter"]) assert.ok(["none", "issued", "unknown", "completed"].includes(s[key]));
	for (const key of ["inheritedCompactions", "nativeCompactions", "agentEnds"]) count(s[key], 8);
	for (const key of ["extensionSha256", "toolSchemaSha256", "promptSha256"]) hash(s[key]); if (s.finalFileSha256 !== null) hash(s.finalFileSha256);
	exact(s.operationMetrics, Object.keys(emptyOperationMetrics())); Object.values(s.operationMetrics).forEach(n => count(n, 32));
	assert.ok(Array.isArray(s.receipts) && s.receipts.length <= LIFE_LIMITS.requests + 2);
	for (const r of s.receipts) {
		exact(r, ["kind", "payloadBytes", "outputReserve", "payloadSha256", "disposition", "outcome"]); hash(r.payloadSha256); count(r.payloadBytes, 1048576); count(r.outputReserve, 4096);
		assert.ok(["agent", "summary"].includes(r.kind)); assert.ok(["dispatched", "product-blocked", "outer-blocked", "aborted"].includes(r.disposition)); assert.ok(["complete", "error", "aborted", "overflow"].includes(r.outcome));
		if (r.disposition === "dispatched") assert.ok(r.payloadBytes + r.outputReserve + 512 <= LIFE_LIMITS.outerBytes);
	}
	assert.ok(s.receipts.filter((r: any) => r.disposition === "dispatched").length <= LIFE_LIMITS.requests);
	assert.ok(Array.isArray(s.starts) && s.starts.length <= 4); s.starts.forEach((r: any) => assert.ok(["threshold", "overflow"].includes(r)));
	assert.ok(Array.isArray(s.ends) && s.ends.length <= 5);
	for (const e of s.ends) { exact(e, ["reason", "success", "aborted", "willRetry", "error"]); assert.ok(["threshold", "overflow"].includes(e.reason)); for (const k of ["success", "aborted", "willRetry", "error"]) assert.equal(typeof e[k], "boolean"); }
	assert.ok(Array.isArray(s.writeResults) && s.writeResults.length <= LIFE_LIMITS.tools); s.writeResults.forEach((r: any) => assert.ok(["reconciled", "unknown", "persistence", "error", "success"].includes(r)));
	return s;
}
function nativeContract(task: LifeRun["task"], stage: LifeStageResult) {
	const expected = ["auto-threshold", "write-after-compact"].includes(task) ? 2 : 1;
	const reason = task === "auto-overflow" ? "overflow" : "threshold";
	return stage.inheritedCompactions === 0 && stage.nativeCompactions === expected && !stage.fromHook
		&& stage.starts.length === expected && stage.starts.every(r => r === reason)
		&& stage.ends.length === expected && stage.ends.every(e => e.reason === reason && e.success && !e.aborted && !e.error && e.willRetry === (task === "auto-overflow"))
		&& stage.receipts.filter(r => r.kind === "summary" && r.outcome === "complete").length >= expected;
}
const seedHash = (task: LifeRun["task"]) => task === "write-missing" ? null : sha256(task === "write-partial" ? LIFE_PARTIAL : LIFE_CONTENT);
function writeSeedContract(task: LifeRun["task"], seed: LifeStageResult) {
	return nativeContract(task, seed) && seed.stage === "seed" && seed.writes === 1 && seed.lostAcks === 1 && seed.writeEffects === (task === "write-missing" ? 0 : 1)
		&& seed.writeResults.length === 1 && seed.writeResults[0] === "error" && seed.finalFileSha256 === seedHash(task)
		&& seed.receipts.filter(r => r.kind === "agent").length === (task === "write-after-compact" ? 5 : 4);
}
export function judgeLifecycle(run: LifeRun, stages: LifeStageResult[], source = true): LifeResult {
	stages.forEach(validateLifeStage);
	const [first, last = first] = stages, write = isWriteTask(run.task);
	const complete = write ? stages.length === 2 && first.stage === "seed" && last.stage === "resume" : stages.length === 1 && first.stage === "single";
	const checks = { source, inventory: stages.every(s => s.inventory), settings: stages.every(s => s.settings), boundary: stages.every(s => s.boundary), zeroNetwork: stages.every(s => s.zeroNetwork), requestContract: false, taskContract: false };
	const receipts = stages.flatMap(s => s.receipts), expectedCompactions = ["auto-threshold", "write-after-compact"].includes(run.task) ? 2 : 1;
	checks.requestContract = receipts.every(r => r.disposition === "dispatched" && (r.outcome === "complete" || run.task === "auto-overflow" && r.kind === "agent" && r.outcome === "overflow"))
		&& receipts.filter(r => r.outcome === "overflow").length === (run.task === "auto-overflow" ? 1 : 0);
	if (!write) checks.taskContract = nativeContract(run.task, first) && first.writes === 0 && first.finalFileSha256 === null && first.agentEnds === (run.task === "auto-threshold" ? 5 : 3)
		&& first.receipts.filter(r => r.kind === "agent").length === (run.task === "auto-threshold" ? 6 : 4);
	else {
		const full = ["write-acklost", "write-after-compact"].includes(run.task);
		checks.taskContract = writeSeedContract(run.task, first) && complete && first.durableIntentBeforeWrite && first.unknownAtCompaction && first.pendingAfter === "unknown"
			&& first.operationMetrics.intents === 1 && first.operationMetrics.results === 1 && first.operationMetrics.persistenceBlocks === 0
			&& last.reopened && last.inheritedCompactions === expectedCompactions && last.nativeCompactions === 0 && last.starts.length === 0 && last.ends.length === 0
			&& last.pendingBefore === "unknown" && last.pendingAfter === (full ? "completed" : "unknown") && last.writes === 0 && last.writeEffects === 0 && last.lostAcks === 0
			&& last.finalFileSha256 === seedHash(run.task) && last.writeResults.length === 2 && last.writeResults.every(r => r === (full ? "reconciled" : "unknown"))
			&& last.operationMetrics.replayBlocks === 2 && last.operationMetrics.persistenceBlocks === 0 && last.receipts.filter(r => r.kind === "agent").length === 6;
	}
	const safe = complete && [checks.source, checks.inventory, checks.settings, checks.boundary, checks.zeroNetwork].every(Boolean);
	const pass = safe && checks.requestContract && checks.taskContract;
	return { status: pass ? "pass" : safe ? "fail" : "unknown", reason: pass ? "PASS" : !safe ? "WORKER_UNKNOWN" : write && run.profile !== "sdk-b3-checkpoint-ops-v2" ? "MISSING_DURABLE_OPERATION" : "CONTRACT_FAILED", checks, stages };
}
export function expectedLifecycleResult(run: LifeRun, result: LifeResult) {
	if (result.status === "pass") return lifeExpected(run) === "pass";
	if (lifeExpected(run) !== "fail" || result.status !== "fail" || result.reason !== "MISSING_DURABLE_OPERATION" || !result.stages || !["source", "inventory", "settings", "boundary", "zeroNetwork", "requestContract"].every(k => result.checks[k as keyof LifeResult["checks"]])) return false;
	const [seed, resume] = result.stages;
	return result.stages.length === 2 && writeSeedContract(run.task, seed) && seed.pendingBefore === "none" && seed.pendingAfter === "none" && !seed.durableIntentBeforeWrite && !seed.unknownAtCompaction
		&& resume.stage === "resume" && resume.reopened && resume.inheritedCompactions === seed.nativeCompactions && resume.nativeCompactions === 0 && resume.starts.length === 0 && resume.ends.length === 0 && !resume.fromHook
		&& resume.writes === 1 && resume.lostAcks === 0 && resume.writeResults.length === 1 && resume.writeResults[0] === "success" && resume.writeEffects === (["write-acklost", "write-after-compact"].includes(run.task) ? 0 : 1)
		&& resume.finalFileSha256 === sha256(LIFE_CONTENT) && resume.pendingBefore === "none" && resume.pendingAfter === "none" && resume.receipts.filter(r => r.kind === "agent").length === 2;
}
export function validateLifeResult(value: unknown, run: LifeRun, manifest: LifeManifest): LifeResult {
	const r = exact(value, ["status", "reason", "checks", "stages"]); exact(r.checks, LIFE_CHECKS);
	Object.values(r.checks).forEach(v => assert.equal(typeof v, "boolean"));
	if (r.stages === null) { assert.ok(["unknown", "blocked"].includes(r.status)); assert.equal(r.reason, r.status === "blocked" ? "BATCH_STOPPED" : "WORKER_UNKNOWN"); assert.ok(Object.values(r.checks).every(v => v === false)); return r; }
	assert.ok(Array.isArray(r.stages) && r.stages.length >= 1 && r.stages.length <= 2);
	for (const s of r.stages) {
		validateLifeStage(s); assert.equal(s.extensionSha256, manifest.extensions[run.profile]); assert.equal(s.promptSha256, digest(LIFE_PROMPTS));
		if (run.profile !== "sdk-b3-checkpoint-ops-v2") assert.deepEqual(s.operationMetrics, emptyOperationMetrics());
	}
	assert.deepEqual(r, judgeLifecycle(run, r.stages, r.checks.source)); return r;
}
export async function rebuildLifecycle(directory: string) {
	assert.ok((await readdir(directory)).every(n => ["manifest.json", "index.json", "aggregate.json", "raw"].includes(n)), "S3_LIFECYCLE_EXTRA_ARTIFACT");
	const text = await readBounded(path.join(directory, "manifest.json")), manifest = validateLifeManifest(JSON.parse(text)), manifestSha256 = sha256(text);
	await assertInside(directory, path.join(directory, "raw"));
	const index = exact(JSON.parse(await readBounded(path.join(directory, "index.json"))), ["schemaVersion", "manifestSha256", "entries"]);
	assert.equal(index.schemaVersion, 2); assert.equal(index.manifestSha256, manifestSha256); assert.ok(Array.isArray(index.entries)); assert.equal(index.entries.length, manifest.runs.length);
	assert.deepEqual((await readdir(path.join(directory, "raw"))).sort(), manifest.runs.map(r => r.runId + ".json").sort());
	const rows = []; let stopped = false;
	for (const [i, run] of manifest.runs.entries()) {
		const entry = exact(index.entries[i], ["runId", "file", "sha256"]); assert.equal(entry.runId, run.runId); assert.equal(entry.file, `raw/${run.runId}.json`); hash(entry.sha256);
		const rawText = await readBounded(path.join(directory, entry.file), 128000); assert.equal(sha256(rawText), entry.sha256);
		const raw = exact(JSON.parse(rawText), ["schemaVersion", "manifestSha256", "run", "result"]); assert.equal(raw.schemaVersion, 2); assert.equal(raw.manifestSha256, manifestSha256); assert.deepEqual(raw.run, run);
		const result = validateLifeResult(raw.result, run, manifest); if (stopped) assert.equal(result.status, "blocked"); if (!expectedLifecycleResult(run, result)) stopped = true;
		const stages = result.stages, receipts = stages?.flatMap(s => s.receipts) ?? null;
		rows.push({ ...run, status: result.status, reason: result.reason,
			syntheticAgentRequests: receipts?.filter(r => r.kind === "agent" && r.disposition === "dispatched").length ?? null,
			syntheticSummaryRequests: receipts?.filter(r => r.kind === "summary" && r.disposition === "dispatched").length ?? null,
			nativeAutoCompactions: stages?.reduce((n, s) => n + s.nativeCompactions, 0) ?? null, processReopens: stages?.filter(s => s.reopened).length ?? null,
			writeDispatches: stages?.reduce((n, s) => n + s.writes, 0) ?? null, writeEffects: stages?.reduce((n, s) => n + s.writeEffects, 0) ?? null,
			providerUsage: null, costUsd: null });
	}
	return { schemaVersion: 2, kind: "sdk-lifecycle-offline-aggregate", batchId: manifest.batchId, manifestSha256, realHttpDispatches: 0, rows };
}
