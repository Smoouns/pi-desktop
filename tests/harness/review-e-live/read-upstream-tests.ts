import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { freezeRequestPolicy } from "../../../evals/core/request-policy.js";
import { prepare } from "./prepared-cli.js";
import { activatePrepared, authorizePrepared, PREPARED_PARENT, safeJson } from "./prepared-manifest.js";
import { loadConfig } from "./model-projection.js";
import { Journal, recover } from "./journal.js";
import { PreparedBroker } from "./prepared-broker.js";
import { allowedTools } from "./fixtures.js";
import { executionProfile, outputReservationFor, upstreamBudget } from "./protocol-profile.js";
import { batchExitCode } from "./report-status.js";

const parent = path.resolve(PREPARED_PARENT); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "read-upstream-tests-"));
const configFile = path.join(output, "public-models.json");
await writeFile(configFile, JSON.stringify({ providers: { "gemini-proxy": { baseUrl: "https://example.invalid/e8-public/v1", api: "openai-completions", apiKey: "E8_TEST_CREDENTIAL", models: [{ id: "gemini-3.8-flash-high", contextWindow: 262144, maxTokens: 16384, input: ["text"] }] } } }));
const projection = loadConfig(configFile), profile = executionProfile("read-upstream"), design = safeJson(profile.planFile);
const cases: any[] = [];
async function test(id: string, fn: () => any) {
	try { cases.push({ id, pass: true, ...await fn() }); console.log("PASS " + id); }
	catch (error) { cases.push({ id, pass: false, error: (error as Error).stack }); console.error("FAIL " + id, error); }
}
await test("E8R-only-read-with-existing-upstream-budget", () => {
	assert.deepEqual(profile.stages, [{ id: "r", task: "E8-R" }]);
	assert.deepEqual(design.policy.taskIds, ["E8-R"]); assert.deepEqual(design.upstreamBudget, upstreamBudget);
	assert.equal(design.productionOutputBytesLimit, 65536);
	assert.equal(design.policy.limits.maxHttpRequests, 12); assert.equal(design.policy.limits.maxTaskHttpRequests, 12);
	assert.equal(design.policy.limits.maxTotalOutputTokens, 12 * 81920);
	assert.equal(outputReservationFor(profile.name, 2048), 81920);
	assert.equal(profile.noCacheReservationReferenceUsd, (65536 * 0.75 + 81920 * 3.75) * 12 / 1_000_000);
	assert.equal(safeJson(executionProfile("joint-upstream").planFile).policy.limits.maxTaskHttpRequests, 8);
});
await test("E8R-broker-refuses-other-stages", async () => {
	const dir = path.join(output, "stage-scope"); await mkdir(dir);
	const broker = new PreparedBroker(dir, freezeRequestPolicy(design.policy), projection.workerModel, "probe", { executionProfile: profile.name, assertFresh: () => undefined });
	try {
		for (const [scenario, task] of [["u", "E8-U"], ["c-treatment", "E8-C"], ["r", "E8-C"]]) assert.throws(() => broker.register(scenario, dir, task, scenario), /E8_JOINT_STAGE_INVALID/);
		broker.register("worker-r", dir, "E8-R", "r"); assert.equal(broker.workers.size, 1);
	} finally { broker.close(); }
});
await test("E8R-twelve-requests-remain-a-hard-cap", () => {
	const journal = new Journal(path.join(output, "request-limit.jsonl"), freezeRequestPolicy(design.policy));
	try {
		for (let i = 0; i < 12; i++) journal.reserve("E8-R", 2048, 81920, {});
		assert.throws(() => journal.reserve("E8-R", 2048, 81920, {}), /request_limit/);
	} finally { journal.close(); }
});
let prepared: Awaited<ReturnType<typeof prepare>>;
await test("E8R-full-native-read-only-prepare", async () => {
	prepared = await prepare(configFile, profile.name);
	assert.equal(prepared.approvalGranted, false); assert.equal(prepared.credentialResolved, false);
	const dir = path.dirname(prepared.file), report = safeJson(path.join(dir, "probe-report.json"));
	assert.equal(batchExitCode(report), 0); assert.equal(report.reservations, 8);
	assert.deepEqual(report.businessOutcome, { u: "not_run", c: "not_run", r: "read_freshness_observed" });
	assert.equal(report.compaction, null); assert.equal(report.summaryContentReview, "not_run");
	assert.equal(report.clientOutputCapEnforced, false); assert.equal(report.readBudgets.length, 3);
	const rows = recover(path.join(dir, "probe/broker.jsonl")).rows;
	for (const { data } of rows.filter(row => row.event === "reserved")) {
		assert.equal(data.worker, "worker-r"); assert.equal(data.kind, "ordinary");
		assert.equal(data.outputReservation, 81920); assert.equal(data.clientOutputLimit, 2048);
		assert.equal(data.outputBudgetSource, "user-accepted-gateway-policy");
		assert.deepEqual(data.body.tools.map((t: any) => t.function.name).sort(), [...allowedTools].sort());
		assert.equal(data.body.tool_choice, undefined);
	}
	return { prepared: prepared.file, nativeRequests: 8, realModelCalls: 0 };
});
if (prepared!) {
	await test("E8R-partial-or-missing-evidence-cannot-pass", () => {
		const report = safeJson(path.join(path.dirname(prepared.file), "probe-report.json"));
		assert.equal(batchExitCode(report), 0);
		for (const key of Object.keys(report.readEvidence)) assert.equal(batchExitCode({ ...report, readEvidence: { ...report.readEvidence, [key]: false } }), 1);
		for (const patch of [{ pairs: [] }, { pairs: report.pairs.map((p: any) => ({ ...p, outputMatched: false })) }, { stopReason: "worker_failed" }, { businessOutcome: { ...report.businessOutcome, c: "passed" } }, { stages: [] }, { summaryRequestIds: ["unexpected"] }]) assert.equal(batchExitCode({ ...report, ...patch }), 1);
	});
	await test("E8R-new-synthetic-approval-is-exact-and-single-use", () => {
		assert.throws(() => authorizePrepared(prepared.file, configFile, "0".repeat(64), true), /HASH_MISMATCH/);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, false), /COST_ACK/);
		authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true), /EEXIST/);
		activatePrepared(prepared.file, configFile, prepared.manifestSha256);
		assert.throws(() => activatePrepared(prepared.file, configFile, prepared.manifestSha256), /EEXIST/);
	});
}
assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")].attempts, 0);
await writeFile(path.join(output, "summary.json"), JSON.stringify({ cases, failures: cases.filter(c => !c.pass).length, networkRequests: 0, realModelCalls: 0, hostCredentialResolved: false }, null, 2));
console.log("E8 read retest evidence: " + output); assert.equal(cases.filter(c => !c.pass).length, 0);
