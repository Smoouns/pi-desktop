import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { freezeRequestPolicy } from "../../../evals/core/request-policy.js";
import { prepare } from "./prepared-cli.js";
import { activatePrepared, authorizePrepared, PREPARED_PARENT, safeJson } from "./prepared-manifest.js";
import { loadConfig } from "./model-projection.js";
import { Journal, recover } from "./journal.js";
import { PreparedBroker } from "./prepared-broker.js";
import { analyzeBatch, runPreparedBatch } from "./prepared-run.js";
import { executionProfile, enumeratedStateProfile, outputReservationFor, upstreamBudget } from "./protocol-profile.js";
import { batchExitCode } from "./report-status.js";
import { syntheticReply } from "./broker.js";
import { RESPONSE_CONTRACT_V2 } from "./response-contract-v2.js";

const parent = path.resolve(PREPARED_PARENT); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "upstream-tests-"));
const configFile = path.join(output, "public-models.json");
await writeFile(configFile, JSON.stringify({ providers: { "gemini-proxy": { baseUrl: "https://example.invalid/e8-public/v1", api: "openai-completions", apiKey: "E8_TEST_CREDENTIAL", models: [{ id: "gemini-3.8-flash-high", contextWindow: 262144, maxTokens: 16384, input: ["text"] }] } } }));
const projection = loadConfig(configFile), profile = executionProfile("joint-upstream"), design = safeJson(profile.planFile);
const cases: any[] = [];
async function test(id: string, fn: () => any) {
	try { cases.push({ id, pass: true, ...await fn() }); console.log("PASS " + id); }
	catch (error) { cases.push({ id, pass: false, error: (error as Error).stack }); console.error("FAIL " + id, error); }
}
await test("E8G-user-accepted-budget-only-plan-diff", () => {
	const previous = safeJson(executionProfile("joint-enum-v2").planFile);
	assert.deepEqual(design.upstreamBudget, upstreamBudget);
	assert.equal(profile.liveAllowed, true); assert.equal(executionProfile("joint-enum-v2").liveAllowed, false);
	assert.deepEqual(design.policy.limits, { ...previous.policy.limits, maxOutputTokens: 81920, maxTotalOutputTokens: 81920 * 24 });
	assert.equal(profile.noCacheReservationReferenceUsd, (65536 * 0.75 + 81920 * 3.75) * 24 / 1_000_000);
});
await test("E8G-legacy-output-reservations-unchanged", () => {
	for (const name of ["joint", "tool-none", "joint-tool-none", "joint-enum-v2", undefined]) assert.equal(outputReservationFor(name, 2048), 2048);
	assert.equal(outputReservationFor(profile.name, 2048), 81920); assert.equal(enumeratedStateProfile(profile.name), true);
	for (const invalid of [NaN, 0, -1, 1.5, 81921]) assert.throws(() => outputReservationFor(profile.name, invalid));
});
let prepared: Awaited<ReturnType<typeof prepare>>;
await test("E8G-full-native-prepare-14-reservations-no-network", async () => {
	prepared = await prepare(configFile, profile.name);
	assert.equal(prepared.liveAllowed, true); assert.equal(prepared.approvalGranted, false); assert.equal(prepared.credentialResolved, false);
	const dir = path.dirname(prepared.file), report = safeJson(path.join(dir, "probe-report.json"));
	assert.equal(batchExitCode(report), 0); assert.equal(report.responseContractId, RESPONSE_CONTRACT_V2);
	assert.equal(report.reservations, 14); assert.equal(report.usageCoverage.paired, 14); assert.equal(report.seedPreserved, true);
	assert.equal(report.summaryContentReview, "pending_review"); assert.equal(report.clientOutputCapEnforced, false);
	for (const { data } of recover(path.join(dir, "probe/broker.jsonl")).rows.filter(row => row.event === "reserved")) {
		assert.equal(data.outputReservation, 81920); assert.equal(data.clientOutputLimit, data.body[data.outputField]);
		if (data.kind === "summary") assert.ok([Math.floor(0.8 * 2048), Math.floor(0.5 * 2048)].includes(data.clientOutputLimit));
		else assert.equal(data.clientOutputLimit, 2048);
		assert.equal(data.outputBudgetSource, "user-accepted-gateway-policy");
	}
	return { prepared: prepared.file, nativeRequests: 14, realModelCalls: 0 };
});
if (prepared!) {
	const dir = path.dirname(prepared.file), manifest = safeJson(prepared.file);
	for (const fault of ["reasoning-9016", "over-reservation", "unknown-usage", "tool-denied"]) await test("E8G-full-sdk-" + fault, async () => {
		const target = path.join(output, fault); await mkdir(target); let sends = 0; const counts = new Map<string, number>();
		const frame = (choices: any[], usage?: any) => `data: ${JSON.stringify({ id: "e8g-synthetic", object: "chat.completion.chunk", created: 1, model: projection.workerModel.id, choices, ...(usage ? { usage } : {}) })}\n\n`;
		const broker = new PreparedBroker(target, freezeRequestPolicy(manifest.policy), projection.workerModel, "live", {
			executionProfile: profile.name, assertFresh: () => undefined, toolSchemaHashes: manifest.toolSchemaHashes,
			fetch: async body => {
				sends++; const ticket = [...broker.tickets.values()].find(t => t.body === body && !t.finished)!;
				const key = ticket.worker.scenario + "/" + ticket.phase, n = (counts.get(key) ?? 0) + 1; counts.set(key, n);
				const scenario = ticket.worker.scenario === "c-control" ? "c-treatment" : ticket.worker.scenario;
				const delta: any = sends === 1 && fault === "tool-denied"
					? { role: "assistant", tool_calls: [{ index: 0, id: "blocked", type: "function", function: { name: "list_dir", arguments: "{}" } }] }
					: syntheticReply(scenario, ticket.phase, n);
				const usage = sends === 1 ? fault === "unknown-usage" ? undefined : { prompt_tokens: 128, completion_tokens: 93, completion_tokens_details: { reasoning_tokens: fault === "over-reservation" ? 81828 : 9016 } }
					: { prompt_tokens: 128, completion_tokens: 32 };
				return new Response(frame([{ index: 0, delta, finish_reason: null }]) + frame([{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }])
					+ (usage ? frame([], usage) : "") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
			},
		});
		let results; try { results = await runPreparedBatch(dir, broker); } finally { broker.close(); }
		const report = analyzeBatch(results, broker);
		await writeFile(path.join(target, "report.json"), JSON.stringify({ ...report, syntheticOnly: true, realModelCalls: 0 }, null, 2));
		if (fault === "reasoning-9016") {
			assert.equal(sends, 14); assert.equal(batchExitCode(report), 0); assert.equal(report.pairs[0].sdkOutput, 9109);
			assert.equal(report.pairs[0].outputMatched, true); assert.equal(report.referenceCostUsd, null);
		} else {
			assert.equal(sends, 1); assert.equal(batchExitCode(report), 1); assert.ok(results.slice(1).every(row => row.status === "not_run"));
			assert.equal(report.stopReason, fault === "over-reservation" ? "usage_exceeded_reservation" : fault === "unknown-usage" ? "usage_unknown" : "tool_permission");
		}
		return { simulatedCalls: sends, networkRequests: 0, realModelCalls: 0 };
	});
	await test("E8G-task-request-limit-still-eight", () => {
		const journal = new Journal(path.join(output, "request-limit.jsonl"), freezeRequestPolicy(manifest.policy));
		try {
			for (let i = 0; i < 8; i++) journal.reserve("E8-U", 2048, 81920, {});
			assert.throws(() => journal.reserve("E8-U", 2048, 81920, {}), /request_limit/);
		} finally { journal.close(); }
	});
	await test("E8G-new-synthetic-approval-is-single-use", () => {
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, false), /COST_ACK/);
		authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true), /EEXIST/);
		activatePrepared(prepared.file, configFile, prepared.manifestSha256);
		assert.throws(() => activatePrepared(prepared.file, configFile, prepared.manifestSha256), /EEXIST/);
	});
}
assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")].attempts, 0);
await writeFile(path.join(output, "summary.json"), JSON.stringify({ cases, failures: cases.filter(c => !c.pass).length, networkRequests: 0, realModelCalls: 0, hostCredentialResolved: false }, null, 2));
console.log("E8 upstream evidence: " + output); assert.equal(cases.filter(c => !c.pass).length, 0);
