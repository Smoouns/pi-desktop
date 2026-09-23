import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRehearsalManifest, pilotRecordDigest, PilotRecordError, rebuildPilotBatch, sealPilotBatch, validatePilotResultIndex, validatePilotRunRecord, writePilotManifest, type PilotRunRecord } from "../../evals/pilot/records.js";
import { PILOT_PROBE_CONTENT, PILOT_PROBE_PATH, PILOT_TASK_IDS, type PilotTaskId } from "../../evals/pilot/policy.js";

const hash = "a".repeat(64);
const errorCode = (code: string) => (error: unknown): boolean => error instanceof PilotRecordError && error.code === code;
const files = { "fixture.md": hash };
const manifest = () => createRehearsalManifest({ batchId: "pilot-test", createdAt: "2026-09-22T00:00:00.000Z", outputField: "max_tokens",
	code: { commit: "b".repeat(40), files, sha256: pilotRecordDigest.digestMap(files) }, fixture: { files, sha256: pilotRecordDigest.digestMap(files) }, policySha256: hash,
	promptSha256: { [PILOT_TASK_IDS[0]]: hash, [PILOT_TASK_IDS[1]]: hash }, toolsSha256: { [PILOT_TASK_IDS[0]]: hash, [PILOT_TASK_IDS[1]]: hash } });
const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedTokens: null, reasoningTokens: null };
function run(taskId: PilotTaskId, manifestSha256: string, ordinalBase: number): PilotRunRecord {
	const settings = JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false }, null, 2) + "\n";
	return { schemaVersion: 1, batchId: "pilot-test", manifestSha256, taskId, status: "pass", reasonCode: "REHEARSAL_PASS",
		checks: ["sdk", "transport", "source", "fixture", "usage-consistency"].map((id) => ({ id, passed: true })), realHttpDispatches: 0, simulatedHttpDispatches: 3,
		requests: [0, 1, 2].map((offset) => ({ schemaVersion: 1, ordinal: ordinalBase + offset, taskId, invocationId: ordinalBase + offset, status: "complete", reasonCode: null,
			inputEstimate: 100, inputBytes: 500, outputReserved: 2048, requestSha256: hash, usageSource: "synthetic", usage })),
		usage: { source: "synthetic", providerActual: false, inputTokens: 30, outputTokens: 6, totalTokens: 36 }, fileChanges: [
			{ path: ".pi/settings.json", beforeSha256: null, afterSha256: pilotRecordDigest.sha256(settings) },
			...(taskId === "P5P-WRITE-001" ? [{ path: PILOT_PROBE_PATH, beforeSha256: null, afterSha256: pilotRecordDigest.sha256(PILOT_PROBE_CONTENT) }] : []),
		], safeSdkChecks: ["settings", "extension", "allowlist", "role", "files", "toolResults", "normalStop", "finalAnswer"].map((id) => ({ id, passed: true })) };
}

async function cleanup(directory: string): Promise<void> {
	const parent = await realpath(os.tmpdir()), target = await realpath(directory), relative = path.relative(parent, target);
	assert.ok(/^pilot-records-[^\\/]+$/.test(relative), "UNSAFE_TEST_CLEANUP");
	await rm(target, { recursive: true, force: true });
}

export async function runPilotRecordTests(): Promise<number> {
	let count = 0; const test = async (_name: string, action: () => Promise<void> | void): Promise<void> => { await action(); count++; };
	await test("writes manifest before runs and rebuilds without provider claims", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-records-"));
		try { const manifestSha = await writePilotManifest(directory, manifest()); const runs = [run(PILOT_TASK_IDS[0], manifestSha, 1), run(PILOT_TASK_IDS[1], manifestSha, 4)]; await sealPilotBatch(directory, runs); const before = await readFile(path.join(directory, "result-index.json"), "utf8"); const aggregate = await rebuildPilotBatch(directory); const after = await readFile(path.join(directory, "result-index.json"), "utf8"); assert.deepEqual(aggregate, { schemaVersion: 1, kind: "pilot-rehearsal-aggregate", batchId: "pilot-test", planned: 2, pass: 2, fail: 0, blocked: 0, unknown: 0, realHttpDispatches: 0, simulatedHttpDispatches: 6, providerActualRuns: 0, syntheticUsageRuns: 2, unavailableUsageRuns: 0 }); assert.equal(after, before); }
		finally { await cleanup(directory); }
	});
	await test("rejects unknown fields and a passing run without usage", () => {
		const value = run(PILOT_TASK_IDS[0], hash, 1) as unknown as Record<string, unknown>; value.extra = true; assert.throws(() => validatePilotRunRecord(value), errorCode("PILOT_RUN_FIELDS"));
		const missing = run(PILOT_TASK_IDS[0], hash, 1); missing.usage = { source: "unavailable", providerActual: false, inputTokens: null, outputTokens: null, totalTokens: null }; assert.throws(() => validatePilotRunRecord(missing), errorCode("PILOT_PASS_INVALID"));
	});
	await test("rejects missing required checks and duplicate request identities", () => {
		const missing = run(PILOT_TASK_IDS[0], hash, 1); missing.checks = missing.checks.filter((check) => check.id !== "transport"); assert.throws(() => validatePilotRunRecord(missing), errorCode("PILOT_PASS_CHECKS"));
		const duplicate = run(PILOT_TASK_IDS[0], hash, 1); duplicate.requests[1]!.ordinal = duplicate.requests[0]!.ordinal; duplicate.requests[1]!.invocationId = duplicate.requests[0]!.invocationId; assert.throws(() => validatePilotRunRecord(duplicate), errorCode("PILOT_RUN_SIMULATED_MISMATCH"));
	});
	await test("rejects per-request budget excess and partial index", () => {
		const over = run(PILOT_TASK_IDS[0], hash, 1); over.requests[0]!.inputEstimate = 32_769; assert.throws(() => validatePilotRunRecord(over), errorCode("PILOT_REQUEST_BUDGET"));
		assert.throws(() => validatePilotResultIndex({ schemaVersion: 1, batchId: "pilot-test", manifestSha256: hash, entries: [{ taskId: PILOT_TASK_IDS[0], file: `runs/${PILOT_TASK_IDS[0]}.json`, sha256: hash }] }), errorCode("PILOT_INDEX_SCHEMA"));
	});
	await test("does not trust a claimed usage consistency check", () => {
		const missing = run(PILOT_TASK_IDS[0], hash, 1);
		missing.checks = missing.checks.filter((check) => check.id !== "usage-consistency");
		assert.throws(() => validatePilotRunRecord(missing), errorCode("PILOT_PASS_CHECKS"));
		const mismatch = run(PILOT_TASK_IDS[0], hash, 1);
		mismatch.usage.totalTokens = 999;
		assert.throws(() => validatePilotRunRecord(mismatch), errorCode("PILOT_USAGE_MISMATCH"));
	});
	await test("manifest is write-once", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-records-"));
		try { await writePilotManifest(directory, manifest()); await assert.rejects(() => writePilotManifest(directory, manifest()), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST"); }
		finally { await cleanup(directory); }
	});
	await test("rejects a tampered stored aggregate", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-records-"));
		try { const manifestSha = await writePilotManifest(directory, manifest()); await sealPilotBatch(directory, [run(PILOT_TASK_IDS[0], manifestSha, 1), run(PILOT_TASK_IDS[1], manifestSha, 4)]); await writeFile(path.join(directory, "aggregate.json"), JSON.stringify({ kind: "tampered" }) + "\n", "utf8"); await assert.rejects(() => rebuildPilotBatch(directory), errorCode("PILOT_AGGREGATE_MISMATCH")); }
		finally { await cleanup(directory); }
	});
	await test("rejects tampered indexed run", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-records-"));
		try { const manifestSha = await writePilotManifest(directory, manifest()); await sealPilotBatch(directory, [run(PILOT_TASK_IDS[0], manifestSha, 1), run(PILOT_TASK_IDS[1], manifestSha, 4)]); await writeFile(path.join(directory, "runs", `${PILOT_TASK_IDS[0]}.json`), "{}\n", "utf8"); await assert.rejects(() => rebuildPilotBatch(directory), errorCode("PILOT_RUN_HASH")); }
		finally { await cleanup(directory); }
	});
	return count;
}
