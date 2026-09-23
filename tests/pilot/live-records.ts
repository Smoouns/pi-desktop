import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPilotJournal } from "../../evals/pilot/journal.js";
import { createLiveManifest, liveManifestDigest, writeLiveManifest, type PreparedFingerprint } from "../../evals/pilot/live-manifest.js";
import { LiveRecordsError, recoverLiveResults, sealLiveResults, validateLiveTaskRecord, writeLiveTaskRecord, type LiveTaskRecord } from "../../evals/pilot/live-records.js";
import { PILOT_PROBE_CONTENT, PILOT_PROBE_PATH, PILOT_TASK_IDS, type PilotTaskId } from "../../evals/pilot/policy.js";
import { diagnosePilotAnswer, unevaluatedPilotAnswer } from "../../evals/pilot/answer-diagnostics.js";

const h = (letter: string): string => letter.repeat(64);
const digestMap = (value: Record<string, string>): string => createHash("sha256").update(JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const settings = JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false }, null, 2) + "\n";
const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedTokens: null, reasoningTokens: null };
const recordsError = (code: string) => (error: unknown): boolean => error instanceof LiveRecordsError && error.code === code;

async function setup(mode: "live" | "dry-run" = "dry-run") {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-live-records-")); const files = { "evals/pilot/policy.ts": h("b") }, fixture = { "README.md": h("c") };
	const prepared = Object.fromEntries(PILOT_TASK_IDS.map((id, index) => [id, { toolsSha256: h(String(index + 1)), systemSha256: h("d"), promptSha256: h("e"), roleSha256: h("f"), extensionSha256: h("0") }])) as Record<PilotTaskId, PreparedFingerprint>;
	const manifest = createLiveManifest({ executionMode: mode, batchId: "live-record-test", createdAt: "2026-09-22T00:00:00.000Z", outputField: "max_tokens", reasoning: false, compatibilitySha256: h("7"), endpointSha256: h("a"), configSha256: h("6"),
		code: { commit: "abc123", dirty: false, files, sha256: digestMap(files) }, fixture: { files: fixture, sha256: digestMap(fixture) }, prepared,
		runtime: { node: "v24", platform: "win32", arch: "x64", piSdk: "0.63.1", lockSha256: h("9") }, estimator: { kind: "pilot-estimator", version: "1", units: "estimated_tokens", maxInputBytes: 262144 } });
	const manifestSha256 = liveManifestDigest(manifest); await writeLiveManifest(path.join(directory, "manifest.json"), manifest);
	const journal = await createPilotJournal(path.join(directory, "journal"), manifestSha256, mode);
	for (let index = 0; index < PILOT_TASK_IDS.length; index++) { const ordinal = index + 1, taskId = PILOT_TASK_IDS[index]!; await journal.reserve({ ordinal, taskId, invocationId: ordinal, inputEstimate: 100, inputBytes: 500, outputReserved: 2048, requestSha256: h("8") }); await journal.settle({ ordinal, taskId, invocationId: ordinal, dispatchAttempted: true, status: "complete", reasonCode: null, usage }); }
	await journal.finalize("complete"); return { directory, manifestSha256 };
}
function record(taskId: PilotTaskId, manifestSha256: string): LiveTaskRecord {
	return { schemaVersion: 1, manifestSha256, taskId, status: "pass", reasonCode: "LIVE_TASK_PASS", checks: { sdk: true, source: true, fixture: true, files: true, prepared: true },
		sdkChecks: { settings: true, extension: true, allowlist: true, role: true, files: true, toolResults: true, normalStop: true, finalAnswer: true },
		sdkUsage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: 12 }, fileChanges: [
			{ path: ".pi/settings.json", beforeSha256: null, afterSha256: sha(settings) },
			...(taskId === "P5P-WRITE-001" ? [{ path: PILOT_PROBE_PATH, beforeSha256: null, afterSha256: sha(PILOT_PROBE_CONTENT) }] : []),
		] };
}
function diagnosticRecord(taskId: PilotTaskId, manifestSha256: string): LiveTaskRecord & { schemaVersion: 2 } {
	return { ...record(taskId, manifestSha256), schemaVersion: 2,
		answerDiagnostic: diagnosePilotAnswer(taskId, taskId === PILOT_TASK_IDS[0] ? '{"canPredictStorm":false,"signers":["记录员","设备技师"]}' : "ready") };
}
async function cleanup(directory: string): Promise<void> { const parent = await realpath(os.tmpdir()), target = await realpath(directory), relative = path.relative(parent, target); assert.ok(/^pilot-live-records-[^\\/]+$/.test(relative), "UNSAFE_LIVE_RECORD_TEST_CLEANUP"); await rm(target, { recursive: true, force: true }); }

export async function runLiveRecordsTests(): Promise<number> {
	let count = 0; const test = async (_name: string, action: () => Promise<void>): Promise<void> => { await action(); count++; };
	await test("missing index remains incomplete then sealed results pass", async () => { const data = await setup(); try {
		for (const id of PILOT_TASK_IDS) await writeLiveTaskRecord(data.directory, record(id, data.manifestSha256)); const incomplete = await recoverLiveResults(data.directory); assert.equal(incomplete.status, "incomplete"); assert.equal(incomplete.indexed, false);
		await sealLiveResults(data.directory); const aggregate = await recoverLiveResults(data.directory); assert.equal(aggregate.status, "pass"); assert.equal(aggregate.realHttpDispatches, 0); assert.equal(aggregate.simulatedHttpDispatches, 2); assert.equal(aggregate.providerUsage.source, "synthetic"); assert.equal(aggregate.providerUsage.costUsd, null); }
		finally { await cleanup(data.directory); } });
	await test("live mode counts actual client dispatches without cost invention", async () => { const data = await setup("live"); try { for (const id of PILOT_TASK_IDS) await writeLiveTaskRecord(data.directory, record(id, data.manifestSha256)); await sealLiveResults(data.directory); const aggregate = await recoverLiveResults(data.directory); assert.equal(aggregate.realHttpDispatches, 2); assert.equal(aggregate.simulatedHttpDispatches, 0); assert.equal(aggregate.providerUsage.source, "provider"); assert.equal(aggregate.providerUsage.cachedTokens, null); }
		finally { await cleanup(data.directory); } });
	await test("mechanically rederived file policy prevents pass", async () => { const data = await setup(); try { const bad = record(PILOT_TASK_IDS[0], data.manifestSha256); bad.fileChanges.push({ path: "canon/world.md", beforeSha256: h("1"), afterSha256: h("2") }); await writeLiveTaskRecord(data.directory, bad); await writeLiveTaskRecord(data.directory, record(PILOT_TASK_IDS[1], data.manifestSha256)); await sealLiveResults(data.directory); const aggregate = await recoverLiveResults(data.directory); assert.equal(aggregate.status, "failed"); assert.equal(aggregate.tasks[0]?.reasonCode, "MECHANICAL_CHECK_FAILED"); }
		finally { await cleanup(data.directory); } });
	await test("indexed task tampering is rejected", async () => { const data = await setup(); try { for (const id of PILOT_TASK_IDS) await writeLiveTaskRecord(data.directory, record(id, data.manifestSha256)); await sealLiveResults(data.directory); const filename = path.join(data.directory, "runs", `${PILOT_TASK_IDS[0]}.json`); await writeFile(filename, (await readFile(filename, "utf8")).replace("LIVE_TASK_PASS", "SOURCE_DRIFT"), "utf8"); await assert.rejects(() => recoverLiveResults(data.directory)); }
		finally { await cleanup(data.directory); } });
	await test("strict schema and fixed reason codes reject unknown data", async () => { const data = await setup(); try { const value = record(PILOT_TASK_IDS[0], data.manifestSha256) as unknown as Record<string, unknown>; value.rawText = "secret"; assert.throws(() => validateLiveTaskRecord(value), recordsError("LIVE_RESULT_FIELDS")); const bad = record(PILOT_TASK_IDS[0], data.manifestSha256) as unknown as Record<string, unknown>; bad.reasonCode = "ARBITRARY_ERROR"; assert.throws(() => validateLiveTaskRecord(bad), recordsError("LIVE_RESULT_REASON")); }
		finally { await cleanup(data.directory); } });
	await test("missing journal is incomplete with null usage and conservative unknown dispatches", async () => { const data = await setup(); try { await rm(path.join(data.directory, "journal"), { recursive: true, force: true }); const aggregate = await recoverLiveResults(data.directory); assert.equal(aggregate.status, "incomplete"); assert.equal(aggregate.possibleUnknownDispatches, 8); assert.equal(aggregate.providerUsage.totalTokens, null); assert.equal(aggregate.sdkUsage.totalTokens, null); assert.ok(aggregate.tasks.every((task) => task.status === "unknown")); }
		finally { await cleanup(data.directory); } });
	await test("failure record may preserve deletion evidence but cannot pass", async () => { const data = await setup(); try { const deleted = record(PILOT_TASK_IDS[0], data.manifestSha256); deleted.status = "fail"; deleted.reasonCode = "FILE_POLICY_FAILED"; deleted.fileChanges = [{ path: "canon/world.md", beforeSha256: h("1"), afterSha256: null }]; assert.equal(validateLiveTaskRecord(deleted).fileChanges[0]?.afterSha256, null); }
		finally { await cleanup(data.directory); } });
	await test("fixture drift remains a sealed failed task", async () => { const data = await setup(); try { const drifted = record(PILOT_TASK_IDS[0], data.manifestSha256); drifted.status = "fail"; drifted.reasonCode = "FIXTURE_DRIFT"; drifted.checks.fixture = false; await writeLiveTaskRecord(data.directory, drifted); await writeLiveTaskRecord(data.directory, record(PILOT_TASK_IDS[1], data.manifestSha256)); await sealLiveResults(data.directory); const aggregate = await recoverLiveResults(data.directory); assert.equal(aggregate.status, "failed"); assert.equal(aggregate.tasks[0]?.reasonCode, "FIXTURE_DRIFT"); }
		finally { await cleanup(data.directory); } });
	await test("legacy records retain no invented diagnosis", async () => { const data = await setup(); try {
		for (const id of PILOT_TASK_IDS) await writeLiveTaskRecord(data.directory, record(id, data.manifestSha256)); await sealLiveResults(data.directory);
		const aggregate = await recoverLiveResults(data.directory); assert.ok(aggregate.tasks.every((item) => !Object.hasOwn(item, "answerDiagnostic")));
		assert.deepEqual(validateLiveTaskRecord(record(PILOT_TASK_IDS[0], data.manifestSha256)), record(PILOT_TASK_IDS[0], data.manifestSha256));
	} finally { await cleanup(data.directory); } });
	await test("v2 diagnostics round trip through files and recovery", async () => { const data = await setup(); try {
		for (const id of PILOT_TASK_IDS) await writeLiveTaskRecord(data.directory, diagnosticRecord(id, data.manifestSha256)); await sealLiveResults(data.directory);
		const aggregate = await recoverLiveResults(data.directory); assert.equal(aggregate.status, "pass");
		for (const item of aggregate.tasks) assert.deepEqual(item.answerDiagnostic?.codes, ["ANSWER_OK"]);
	} finally { await cleanup(data.directory); } });
	await test("failed diagnosis survives recovery without model text", async () => { const data = await setup(); try {
		const bad = diagnosticRecord(PILOT_TASK_IDS[0], data.manifestSha256); bad.status = "fail"; bad.reasonCode = "MECHANICAL_CHECK_FAILED";
		bad.checks.sdk = false; bad.sdkChecks.finalAnswer = false; bad.answerDiagnostic = diagnosePilotAnswer(bad.taskId, "private-final-answer-canary");
		await writeLiveTaskRecord(data.directory, bad); await writeLiveTaskRecord(data.directory, diagnosticRecord(PILOT_TASK_IDS[1], data.manifestSha256)); await sealLiveResults(data.directory);
		const aggregate = await recoverLiveResults(data.directory); assert.equal(aggregate.status, "failed"); assert.deepEqual(aggregate.tasks[0]?.answerDiagnostic?.codes, ["ANSWER_JSON_INVALID"]);
		assert.doesNotMatch(await readFile(path.join(data.directory, "runs", `${bad.taskId}.json`), "utf8"), /private-final-answer-canary/);
	} finally { await cleanup(data.directory); } });
	await test("v2 required fields and enum prevent arbitrary output", async () => {
		const good = diagnosticRecord(PILOT_TASK_IDS[0], h("a"));
		const { answerDiagnostic, ...missing } = good;
		assert.throws(() => validateLiveTaskRecord(missing), recordsError("LIVE_RESULT_FIELDS"));
		assert.throws(() => validateLiveTaskRecord({ ...good, schemaVersion: 1 }), recordsError("LIVE_RESULT_FIELDS"));
		for (const bad of [{ ...answerDiagnostic, rawText: "secret" }, { ...answerDiagnostic, codes: ["secret"] }, { ...answerDiagnostic, taskId: PILOT_TASK_IDS[1] }])
			assert.throws(() => validateLiveTaskRecord({ ...good, answerDiagnostic: bad }), recordsError("LIVE_RESULT_ANSWER_DIAGNOSTIC"));
	});
	await test("diagnosis cannot conflict with boolean final answer", async () => {
		const good = diagnosticRecord(PILOT_TASK_IDS[0], h("a"));
		assert.throws(() => validateLiveTaskRecord({ ...good, answerDiagnostic: diagnosePilotAnswer(good.taskId, "bad") }), recordsError("LIVE_RESULT_ANSWER_CONFLICT"));
		assert.throws(() => validateLiveTaskRecord({ ...good, sdkChecks: { ...good.sdkChecks, finalAnswer: false } }), recordsError("LIVE_RESULT_ANSWER_CONFLICT"));
	});
	await test("blocked or unknown runs are explicitly unevaluated", async () => {
		const good = diagnosticRecord(PILOT_TASK_IDS[1], h("a"));
		const blocked = { ...good, status: "blocked", reasonCode: "BATCH_ABORTED", sdkChecks: { ...good.sdkChecks, finalAnswer: false }, answerDiagnostic: unevaluatedPilotAnswer(good.taskId) };
		assert.equal(validateLiveTaskRecord(blocked).status, "blocked");
		assert.throws(() => validateLiveTaskRecord({ ...blocked, answerDiagnostic: diagnosePilotAnswer(good.taskId, "bad") }), recordsError("LIVE_RESULT_ANSWER_CONFLICT"));
	});
	await test("changing an otherwise valid diagnostic breaks index hash", async () => { const data = await setup(); try {
		const bad = diagnosticRecord(PILOT_TASK_IDS[0], data.manifestSha256); bad.status = "fail"; bad.reasonCode = "MECHANICAL_CHECK_FAILED";
		bad.checks.sdk = false; bad.sdkChecks.finalAnswer = false; bad.answerDiagnostic = diagnosePilotAnswer(bad.taskId, "bad");
		await writeLiveTaskRecord(data.directory, bad); await writeLiveTaskRecord(data.directory, diagnosticRecord(PILOT_TASK_IDS[1], data.manifestSha256)); await sealLiveResults(data.directory);
		const filename = path.join(data.directory, "runs", `${bad.taskId}.json`);
		await writeFile(filename, (await readFile(filename, "utf8")).replace("ANSWER_JSON_INVALID", "ANSWER_SIGNERS_ORDER"));
		await assert.rejects(() => recoverLiveResults(data.directory), recordsError("LIVE_RESULT_HASH"));
	} finally { await cleanup(data.directory); } });
	return count;
}
