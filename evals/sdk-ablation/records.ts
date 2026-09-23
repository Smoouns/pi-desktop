import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertInside, digest, readBounded, sha256 } from "../core/io.js";
import { SDK_CHECKS, SDK_CONTENT, SDK_FEATURES, SDK_LIMITS, SDK_PROFILES, SDK_PROMPTS, SDK_REASONS, SDK_SYSTEM, SDK_TASKS, sdkRunPlan } from "./policy.js";
import { emptySdkMetrics } from "./extensions.js";
import type { SdkPrepared, SdkResult } from "./session.js";

export interface SdkManifest {
	schemaVersion: 1; kind: "sdk-ablation-rehearsal"; batchId: string; createdAt: string;
	code: { commit: string; dirty: boolean; files: Record<string, string>; sha256: string };
	environment: { node: string; platform: string; arch: string; piSdk: "0.63.1"; lockSha256: string };
	fixture: { files: Record<string, string>; sha256: string };
	policy: ReturnType<typeof sdkPolicy>;
	prepared: Record<string, SdkPrepared>;
	runs: ReturnType<typeof sdkRunPlan>;
}
export interface SdkRecord { schemaVersion: 1; batchId: string; manifestSha256: string; run: SdkManifest["runs"][number]; result: SdkResult; }
export interface SdkIndex { schemaVersion: 1; batchId: string; manifestSha256: string; entries: Array<{ runId: string; file: string; sha256: string }>; }
export const sdkPreparedKey = (profile: string, task: string) => `${profile}:${task}`;
export const sdkPolicy = () => ({ profiles: SDK_FEATURES, limits: SDK_LIMITS, systemSha256: sha256(SDK_SYSTEM),
	prompts: Object.fromEntries(SDK_TASKS.map(task => [task, sha256(SDK_PROMPTS[task])])),
	model: "synthetic-sdk-s1", driver: "scripted-blind-write-replay-v1", note: "Synthetic negative replay probe, not model behavior; identical write bytes can still produce duplicate filesystem write dispatches." });
const object = (value: unknown): Record<string, any> => { assert.ok(value && typeof value === "object" && !Array.isArray(value), "SDK_OBJECT"); return value as Record<string, any>; };
const exact = (value: unknown, keys: string[]) => { const record = object(value); assert.deepEqual(Object.keys(record).sort(), [...keys].sort(), "SDK_FIELDS"); return record; };
const hash = (value: unknown) => assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "SDK_HASH");
const integer = (value: unknown, max = 1000000) => assert.ok(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max, "SDK_COUNT");
const boolean = (value: unknown) => assert.equal(typeof value, "boolean", "SDK_BOOLEAN");
const token = (value: unknown, max = 128) => assert.ok(typeof value === "string" && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value), "SDK_IDENTIFIER");
const map = (value: unknown) => {
	const entries = object(value); assert.ok(Object.keys(entries).length > 0 && Object.keys(entries).length <= 4096, "SDK_FILE_MAP");
	for (const [name, entry] of Object.entries(entries)) {
		assert.ok(name.length <= 512 && !/[\\:\x00-\x1f]/.test(name) && !name.split("/").some(part => !part || part === "." || part === ".."), "SDK_FILE_PATH"); hash(entry);
	}
};
export function validateSdkPrepared(value: unknown): SdkPrepared {
	const data = exact(value, ["extensionSha256", "toolsSha256", "systemSha256", "promptSha256"]); Object.values(data).forEach(hash); return data as SdkPrepared;
}
export function validateSdkManifest(value: unknown): SdkManifest {
	const m = exact(value, ["schemaVersion", "kind", "batchId", "createdAt", "code", "environment", "fixture", "policy", "prepared", "runs"]);
	assert.equal(m.schemaVersion, 1); assert.equal(m.kind, "sdk-ablation-rehearsal"); token(m.batchId);
	assert.equal(new Date(m.createdAt).toISOString(), m.createdAt);
	exact(m.code, ["commit", "dirty", "files", "sha256"]); assert.match(m.code.commit, /^[a-f0-9]{40}$/); boolean(m.code.dirty); map(m.code.files); hash(m.code.sha256); assert.equal(digest(m.code.files), m.code.sha256, "SDK_SOURCE_HASH");
	exact(m.environment, ["node", "platform", "arch", "piSdk", "lockSha256"]); [m.environment.node, m.environment.platform, m.environment.arch].forEach(item => token(item)); assert.equal(m.environment.piSdk, "0.63.1"); hash(m.environment.lockSha256);
	exact(m.fixture, ["files", "sha256"]); map(m.fixture.files); hash(m.fixture.sha256); assert.equal(digest(m.fixture.files), m.fixture.sha256);
	assert.equal(digest(m.policy), digest(sdkPolicy()), "SDK_POLICY_DRIFT");
	assert.deepEqual(m.runs, sdkRunPlan(), "SDK_PLAN_DRIFT");
	exact(m.prepared, SDK_PROFILES.flatMap(profile => SDK_TASKS.map(task => sdkPreparedKey(profile, task))));
	for (const profile of SDK_PROFILES) for (const task of SDK_TASKS) {
		const prepared = validateSdkPrepared(m.prepared[sdkPreparedKey(profile, task)]); assert.equal(prepared.promptSha256, sha256(SDK_PROMPTS[task]));
		const peer = m.prepared[sdkPreparedKey(SDK_PROFILES[0], task)];
		assert.equal(prepared.systemSha256, peer.systemSha256, "SDK_UNFAIR_SYSTEM"); assert.equal(prepared.toolsSha256, peer.toolsSha256, "SDK_UNFAIR_TOOLS");
		assert.equal(prepared.extensionSha256, m.prepared[sdkPreparedKey(profile, SDK_TASKS[0])].extensionSha256, "SDK_PROFILE_DRIFT");
	}
	return m as SdkManifest;
}
export function validateSdkResult(value: unknown): SdkResult {
	const r = exact(value, ["status", "reasonCode", "checks", "prepared", "metrics", "syntheticUsage", "finalFileSha256", "answerCode"]);
	assert.ok(["pass", "fail", "unknown", "cancelled", "blocked"].includes(r.status), "SDK_STATUS"); assert.ok(SDK_REASONS.includes(r.reasonCode), "SDK_REASON");
	exact(r.checks, [...SDK_CHECKS]); Object.values(r.checks).forEach(boolean);
	if (r.prepared !== null) validateSdkPrepared(r.prepared);
	if (r.metrics === null) {
		assert.ok(["unknown", "blocked"].includes(r.status), "SDK_METRICS_MISSING"); assert.equal(r.syntheticUsage, null);
	} else {
		exact(r.metrics, [...Object.keys(emptySdkMetrics()), "syntheticInvocations", "tools", "writeDispatches", "duplicateWriteDispatches", "readAttempts", "realHttpDispatches"]);
		Object.values(r.metrics).forEach(item => integer(item));
		assert.equal(r.metrics.realHttpDispatches, 0, "SDK_REAL_REQUEST_FORBIDDEN"); integer(r.metrics.syntheticInvocations, SDK_LIMITS.taskInvocations); integer(r.metrics.tools, SDK_LIMITS.taskTools);
		assert.equal(r.metrics.duplicateWriteDispatches, Math.max(0, r.metrics.writeDispatches - 1), "SDK_WRITE_COUNT");
	}
	if (r.syntheticUsage !== null) { exact(r.syntheticUsage, ["input", "output", "total"]); Object.values(r.syntheticUsage).forEach(item => integer(item)); assert.equal(r.syntheticUsage.total, r.syntheticUsage.input + r.syntheticUsage.output); }
	if (r.finalFileSha256 !== null) hash(r.finalFileSha256);
	assert.ok(["ANSWER_OK", "ANSWER_INVALID", "ANSWER_NOT_EVALUATED"].includes(r.answerCode), "SDK_ANSWER_CODE");
	if (r.status === "pass") {
		assert.ok(Object.values(r.checks).every(Boolean) && r.prepared !== null && r.syntheticUsage !== null && r.metrics !== null && r.metrics.duplicateWriteDispatches === 0, "SDK_FALSE_PASS");
		assert.equal(r.reasonCode, "SDK_PASS"); assert.equal(r.answerCode, "ANSWER_OK");
		assert.equal(r.syntheticUsage.input, r.metrics.syntheticInvocations); assert.equal(r.syntheticUsage.output, r.metrics.syntheticInvocations);
	} else assert.notEqual(r.reasonCode, "SDK_PASS", "SDK_FALSE_PASS");
	return r as SdkResult;
}
export function sdkAggregate(manifestValue: unknown, indexValue: unknown, files: ReadonlyMap<string, string>) {
	const manifest = validateSdkManifest(manifestValue), manifestSha256 = digest(manifestValue);
	const index = exact(indexValue, ["schemaVersion", "batchId", "manifestSha256", "entries"]);
	assert.equal(index.schemaVersion, 1); assert.equal(index.batchId, manifest.batchId); assert.equal(index.manifestSha256, manifestSha256, "SDK_MANIFEST_DRIFT");
	assert.ok(Array.isArray(index.entries) && index.entries.length === manifest.runs.length && files.size === manifest.runs.length, "SDK_INCOMPLETE_RECORDS");
	const results: Array<{ run: SdkManifest["runs"][number]; result: SdkResult }> = [];
	for (const [ordinal, plan] of manifest.runs.entries()) {
		const entry = exact(index.entries[ordinal], ["runId", "file", "sha256"]);
		assert.equal(entry.runId, plan.runId); assert.equal(entry.file, `raw/${plan.runId}.json`); hash(entry.sha256);
		const text = files.get(entry.file); assert.ok(text && Buffer.byteLength(text) <= 128000, "SDK_RAW_MISSING"); assert.equal(sha256(text), entry.sha256, "SDK_RAW_DRIFT");
		const record = exact(JSON.parse(text), ["schemaVersion", "batchId", "manifestSha256", "run", "result"]);
		assert.equal(record.schemaVersion, 1); assert.equal(record.batchId, manifest.batchId); assert.equal(record.manifestSha256, manifestSha256); assert.deepEqual(record.run, plan);
		const result = validateSdkResult(record.result);
		if (result.prepared) assert.equal(digest(result.prepared), digest(manifest.prepared[sdkPreparedKey(plan.profile, plan.taskId)]), "SDK_PREPARED_DRIFT");
		if (result.status === "pass") {
			assert.ok(result.metrics); assert.equal(result.metrics.writeDispatches, plan.taskId === "P5A-READ-001" ? 0 : 1);
			assert.equal(result.finalFileSha256, plan.taskId === "P5A-READ-001" ? null : sha256(SDK_CONTENT));
			if (plan.profile === "sdk-b1-reliability") { assert.equal(result.metrics.agentStarts, 1); assert.equal(result.metrics.runStops, 1); }
		}
		if (result.metrics && plan.profile === "sdk-b0-safety-fixed") for (const key of Object.keys(emptySdkMetrics())) assert.equal((result.metrics as any)[key], 0, "SDK_B0_CAPABILITY_LEAK");
		results.push({ run: plan, result });
	}
	const groups = SDK_PROFILES.flatMap(profile => SDK_TASKS.map(taskId => {
		const runs = results.filter(item => item.run.profile === profile && item.run.taskId === taskId);
		const statuses = { pass: 0, fail: 0, unknown: 0, cancelled: 0, blocked: 0 }; for (const r of runs) statuses[r.result.status]++;
		const missingMetrics = runs.filter(item => item.result.metrics === null).length;
		return { profile, taskId, count: runs.length, statuses, deterministic: new Set(runs.map(item => digest(item.result))).size === 1, ...(missingMetrics ? { missingMetrics } : {}),
			syntheticInvocations: missingMetrics ? null : runs.reduce((sum, item) => sum + item.result.metrics!.syntheticInvocations, 0),
			writeDispatches: missingMetrics ? null : runs.reduce((sum, item) => sum + item.result.metrics!.writeDispatches, 0),
			duplicateWriteDispatches: missingMetrics ? null : runs.reduce((sum, item) => sum + item.result.metrics!.duplicateWriteDispatches, 0) };
	}));
	return { schemaVersion: 1, kind: "sdk-ablation-rehearsal-aggregate", batchId: manifest.batchId, manifestSha256, runCount: results.length, groups, realHttpDispatches: 0,
		inference: "Scripted SDK lifecycle evidence only; not provider behavior, token savings, full historical Desktop or complete B1 RPC recovery." };
}
export async function rebuildSdkBatch(directory: string) {
	directory = path.resolve(directory); await assertInside(path.resolve("artifacts/harness/sdk-ablations"), directory);
	const raw = path.join(directory, "raw"); await assertInside(directory, raw);
	const files = new Map<string, string>();
	const names = await readdir(raw); assert.ok(names.length <= 12, "SDK_RAW_EXTRA");
	for (const name of names) { assert.match(name, /^[A-Za-z0-9_-]+\.json$/); files.set(`raw/${name}`, await readBounded(path.join(raw, name), 128000)); }
	return sdkAggregate(JSON.parse(await readBounded(path.join(directory, "manifest.json"))), JSON.parse(await readBounded(path.join(directory, "result-index.json"))), files);
}
