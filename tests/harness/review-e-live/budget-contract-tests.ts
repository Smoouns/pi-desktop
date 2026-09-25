import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { freezeRequestPolicy } from "../../../evals/core/request-policy.js";
import { prepare } from "./prepared-cli.js";
import { activatePrepared, authorizePrepared, inspectPrepared, PREPARED_PARENT, safeJson } from "./prepared-manifest.js";
import { projectConfig } from "./model-projection.js";
import { executionProfile, jointExplicitNone } from "./protocol-profile.js";
import { QUESTION, critical, oracle, score, seed } from "./fixtures.js";
import { QUESTION_V2, RESPONSE_CONTRACT_V2, responseChoices, responseContractSchema, responseFields, scoreResponseV2 } from "./response-contract-v2.js";
import { outputAccounting } from "./output-accounting.js";
import { digest, recover } from "./journal.js";
import { PreparedBroker } from "./prepared-broker.js";
import { batchExitCode } from "./report-status.js";

const parent = path.resolve(PREPARED_PARENT); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "budget-contract-tests-"));
const config: any = { providers: { "gemini-proxy": { baseUrl: "https://example.invalid/e8-public/v1", api: "openai-completions", apiKey: "E8_TEST_CREDENTIAL", models: [{ id: "gemini-3.8-flash-high", contextWindow: 262144, maxTokens: 16384, input: ["text"] }] } } };
const configFile = path.join(output, "public-models.json"); await writeFile(configFile, JSON.stringify(config));
const cases: any[] = [];
async function test(id: string, fn: () => any) {
	try { cases.push({ id, pass: true, ...await fn() }); console.log("PASS " + id); }
	catch (error) { cases.push({ id, pass: false, error: (error as Error).stack }); console.error("FAIL " + id, error); }
}

for (const reasoning of [false, true]) for (const level of ["off", "low", "high"] as const) {
	await test(`E8B-native-agent-${reasoning ? "reasoning" : "nonreasoning"}-${level}`, async () => {
		const example = structuredClone(config); example.providers["gemini-proxy"].models[0].reasoning = reasoning;
		const model = projectConfig(example).workerModel;
		let payload: any, count = 0;
		const agent = new Agent({ initialState: { model, thinkingLevel: level, tools: [], systemPrompt: "Public offline parameter probe." },
			getApiKey: () => "E8_SYNTHETIC_NOT_A_CREDENTIAL", onPayload: value => { count++; payload = structuredClone(value); throw Error("E8_CAPTURE_BEFORE_NETWORK"); } });
		await agent.prompt("Parameter capture only.");
		assert.equal(count, 1); assert.equal(payload.max_completion_tokens, 2048); assert.equal(payload.max_tokens, undefined);
		assert.equal(payload.reasoning_effort, reasoning && level !== "off" ? level : undefined);
		assert.equal(payload.enable_thinking, undefined); assert.equal(payload.thinking, undefined);
		const reply: any = agent.state.messages.at(-1); assert.equal(reply.stopReason, "error");
		return { modelReasoning: reasoning, level, outputField: "max_completion_tokens", value: 2048, reasoningEffortSent: payload.reasoning_effort ?? null,
			capturedBeforeNetwork: true, establishesProxySupport: false };
	});
}
await test("E8B-compat-output-alternative-and-reasoning-support", async () => {
	const samples: any[] = [];
	for (const field of ["max_tokens", "max_completion_tokens"] as const) for (const supports of [false, true]) {
		const example = structuredClone(config);
		Object.assign(example.providers["gemini-proxy"].models[0], { reasoning: true, compat: { maxTokensField: field, supportsReasoningEffort: supports } });
		const projected = projectConfig(example); let payload: any;
		const result = await streamSimple(projected.workerModel, { messages: [{ role: "user", content: "Public parameter probe.", timestamp: 1 }] },
			{ apiKey: "E8_SYNTHETIC_NOT_A_CREDENTIAL", maxTokens: 2048, reasoning: "low", onPayload(value) { payload = structuredClone(value); throw Error("E8_CAPTURE_BEFORE_NETWORK"); } }).result();
		assert.equal(result.stopReason, "error"); assert.equal(payload[field], 2048);
		assert.equal(payload[field === "max_tokens" ? "max_completion_tokens" : "max_tokens"], undefined);
		assert.equal(payload.reasoning_effort, supports ? "low" : undefined);
		samples.push({ field, supportsReasoningEffort: supports, reasoningEffortSent: payload.reasoning_effort ?? null });
	}
	return { samples, networkRequests: 0, establishesProxySupport: false };
});
await test("E8B-high-model-name-does-not-enable-sdk-reasoning", () => {
	const projection = projectConfig(config); assert.equal(projection.workerModel.reasoning, false);
	assert.equal(projection.workerModel.maxTokens, 2048); assert.equal(projection.publicProjection.configuredMaxTokens, 16384);
	assert.equal(projection.publicProjection.thinkingLevel, "off");
});
await test("E8B-output-cap-still-counts-reasoning", () => {
	const usage = outputAccounting({ prompt_tokens: 3846, completion_tokens: 93, completion_tokens_details: { reasoning_tokens: 9016 } });
	assert.equal(usage.sdkNormalizedOutput, 9109); assert.ok(usage.sdkNormalizedOutput! > 2048);
	assert.equal(usage.referenceCostUsd, null); assert.equal(usage.providerBillingVerified, false);
});
await test("E8V2-explicit-vocabulary-covers-exact-answer-contract", () => {
	assert.equal(responseFields.length, 10); assert.deepEqual(responseContractSchema.required, Object.keys(oracle));
	assert.equal(responseContractSchema.additionalProperties, false); assert.ok(QUESTION_V2.includes(RESPONSE_CONTRACT_V2));
	for (const [key, choices] of Object.entries(responseChoices)) {
		assert.ok(Object.keys(choices).length >= 3); assert.ok(Object.hasOwn(choices, (oracle as any)[key]));
		for (const [value, meaning] of Object.entries(choices)) assert.ok(QUESTION_V2.includes(`${value}（${meaning}）`));
	}
	assert.ok(QUESTION_V2.includes("先重读失效来源，再按需刷新检查点"));
	assert.ok(!QUESTION_V2.includes(JSON.stringify(oracle))); assert.ok(!QUESTION_V2.includes("正确答案"));
	assert.equal(scoreResponseV2(JSON.stringify(oracle)).passed, true);
	assert.equal(scoreResponseV2(JSON.stringify(Object.fromEntries(Object.entries(oracle).reverse()), null, 2)).passed, true);
	assert.deepEqual(scoreResponseV2(JSON.stringify(oracle)).matches.filter(m => m.critical).map(m => m.key), critical);
});
await test("E8V2-no-posthoc-synonym-regrading-or-lost-refresh", () => {
	// Legacy answer and legacy scorer keep their original six-of-ten outcome.
	const oldAnswer = { ...oracle, goal: "organize_next_planning", card: "needs_human_confirmation", next: "reread_stale_source", unresolved: "remain_unknown" };
	assert.equal(score(JSON.stringify(oldAnswer)).matches.filter(m => m.passed).length, 6);
	assert.equal(scoreResponseV2(JSON.stringify(oldAnswer)).schemaValid, false);
	const missingRefresh = scoreResponseV2(JSON.stringify({ ...oracle, next: "reread_only" }));
	assert.equal(missingRefresh.schemaValid, true); assert.equal(missingRefresh.passed, false);
	assert.equal(missingRefresh.matches.find(m => m.key === "next")?.passed, false);
	for (const field of critical) {
		const mutated: any = { ...oracle }; mutated[field] = field === "writerPlanningWrite" ? true
			: Object.keys((responseChoices as any)[field]).find(value => value !== (oracle as any)[field]);
		const value = scoreResponseV2(JSON.stringify(mutated)); assert.equal(value.schemaValid, true); assert.equal(value.criticalPassed, false);
	}
});
await test("E8V2-rejects-format-type-duplicate-and-extra-fields", () => {
	const base = JSON.stringify(oracle);
	const failures = ["", "null", "[]", "false", '"text"', "```json\n" + base + "\n```", base + " after", "x".repeat(8193),
		JSON.stringify({ ...oracle, extra: "approval" }), JSON.stringify({ ...oracle, goal: undefined }), JSON.stringify({ ...oracle, writerPlanningWrite: "false" }),
		JSON.stringify({ ...oracle, card: ["pending_human_confirmation"] }), JSON.stringify({ ...oracle, goal: "PLAN_ONLY" }),
		'{"goal":"draft_body",' + base.slice(1), '{"go\\u0061l":"draft_body",' + base.slice(1),
		'{"goal":{"message":"value with escaped \\\"goal\\\": and comma, nesting"},' + base.slice(1)];
	for (const text of failures) assert.equal(scoreResponseV2(text).passed, false, text.slice(0, 80));
	assert.equal(scoreResponseV2('{"goal":"draft_body",' + base.slice(1)).reason, "duplicate_key");
	assert.equal(scoreResponseV2('{"go\\u0061l":"draft_body",' + base.slice(1)).reason, "duplicate_key");
	assert.equal(scoreResponseV2(base.replace('"plan_only"', '"plan\\u005fonly"')).passed, true);
	return { rejectedVariants: failures.length };
});
await test("E8V2-versioned-plan-keeps-ceilings-and-disables-live", () => {
	const profile = executionProfile("joint-enum-v2"), design = safeJson(profile.planFile);
	assert.equal(profile.liveAllowed, false); assert.equal(design.liveAllowed, false);
	assert.deepEqual(design.policy.limits, safeJson(executionProfile("joint-tool-none").planFile).policy.limits);
	assert.ok(jointExplicitNone(profile.name, "u") && jointExplicitNone(profile.name, "c-treatment")); assert.equal(jointExplicitNone(profile.name, "r"), false);
	const dir = path.join(output, "forbidden-live");
	assert.throws(() => new PreparedBroker(dir, freezeRequestPolicy(design.policy), projectConfig(config).workerModel, "live", { executionProfile: profile.name, assertFresh() {} }), /OFFLINE_ONLY/);
	assert.equal(existsSync(path.join(dir, "broker.jsonl")), false);
});

let prepared: Awaited<ReturnType<typeof prepare>>;
await test("E8V2-full-sdk-independent-contract-prepare", async () => {
	prepared = await prepare(configFile, "joint-enum-v2"); assert.equal(prepared.liveAllowed, false);
	assert.equal(prepared.networkRequests, 0); assert.equal(prepared.credentialResolved, false); assert.equal(prepared.approvalGranted, false);
	const dir = path.dirname(prepared.file), report = safeJson(path.join(dir, "probe-report.json")), inputs = safeJson(path.join(dir, "assets/inputs.json"));
	assert.equal(batchExitCode(report), 0); assert.equal(report.responseContractId, RESPONSE_CONTRACT_V2);
	assert.equal(report.controlScore.schemaValid, true); assert.equal(report.systemRecoveryScore.schemaValid, true);
	assert.equal(report.reservations, 14); assert.equal(report.usageCoverage.paired, 14); assert.ok(report.pairs.every((p: any) => p.outputMatched));
	assert.equal(report.independentSeed, true); assert.equal(report.seedPreserved, true); assert.equal(report.summaryContentReview, "pending_review");
	assert.equal(report.toolPolicyEvidence.passed, true); assert.equal(report.toolPolicyEvidence.profile, "joint-enum-v2");
	assert.equal(inputs.question, QUESTION_V2); assert.deepEqual(inputs.seed, seed()); assert.equal(inputs.responseContractId, RESPONSE_CONTRACT_V2);
	const rows = recover(path.join(dir, "probe/broker.jsonl")).rows.filter(r => r.event === "reserved");
	const c = rows.filter(r => r.data.worker.startsWith("worker-c-")); assert.equal(c.length, 4);
	for (const row of c) {
		const body = JSON.stringify(row.data.body); assert.equal(body.includes(RESPONSE_CONTRACT_V2), row.data.kind !== "summary");
		if (row.data.kind !== "summary") assert.ok(row.data.body.messages.some((m: any) => JSON.stringify(m.content).includes(RESPONSE_CONTRACT_V2)));
	}
	// Production appends TaskContract/checkpoint projections after the question.
	// Identify the actual question, not the last provider user-role message.
	const messageText = (m: any) => typeof m.content === "string" ? m.content
		: m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
	const cInputs = c.filter(r => r.data.kind === "ordinary").map(r => r.data.body.messages
		.filter((m: any) => m.role === "user").map(messageText).filter((text: string) => text === QUESTION_V2));
	assert.deepEqual(cInputs, [[QUESTION_V2], [QUESTION_V2]]); // Exactly once in each independent arm.
	return { prepared: prepared.file, nativeCapturedRequests: 14, realModelCalls: 0, networkRequests: 0, liveAllowed: false };
});
if (prepared!) {
	await test("E8V2-cannot-consume-approval-or-activate-before-live-ready", async () => {
		const dir = path.dirname(prepared.file), original = await readFile(prepared.file, "utf8"), manifest = JSON.parse(original);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true), /OFFLINE_ONLY/);
		assert.throws(() => activatePrepared(prepared.file, configFile, prepared.manifestSha256), /OFFLINE_ONLY/);
		assert.equal(existsSync(path.join(dir, "authorization-consumed.json")), false);
		assert.equal(existsSync(path.join(dir, "execution-started.json")), false);
		manifest.liveAllowed = true; await writeFile(prepared.file, JSON.stringify(manifest));
		try { assert.throws(() => inspectPrepared(prepared.file, configFile), /LIVE_POLICY_MISMATCH/); }
		finally { await writeFile(prepared.file, original); }
		assert.equal(digest(readFileSync(prepared.file)), prepared.manifestSha256);
	});
}
await test("E8V2-legacy-question-and-three-consumed-results-unchanged", () => {
	const previousFile = path.join(parent, "joint-tool-none-XbVP5l/manifest.json");
	if (existsSync(previousFile)) assert.equal(digest(readFileSync("tests/harness/review-e-live/fixtures.ts")), safeJson(previousFile).source["tests/harness/review-e-live/fixtures.ts"]);
	assert.equal(QUESTION.includes(RESPONSE_CONTRACT_V2), false);
	for (const [batch, audit] of [["prepared-q4sDJ2", "readback-q4sDJ2"], ["tool-none-Z93R4B", "readback-tool-none-Z93R4B"], ["joint-tool-none-XbVP5l", "readback-joint-tool-none-XbVP5l"]]) {
		// Installed desktop checkout evidence, not a prerequisite for public CI.
		const reportFile = path.join(parent, audit, "summary.json"); if (!existsSync(reportFile)) continue;
		for (const [file, sha] of Object.entries(safeJson(reportFile).evidenceSha256)) assert.equal(digest(readFileSync(path.join(parent, batch, file))), sha);
	}
});
assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")].attempts, 0);
await writeFile(path.join(output, "summary.json"), JSON.stringify({ cases, failures: cases.filter(c => !c.pass).length, realModelCalls: 0, networkRequests: 0, hostCredentialResolved: false }, null, 2) + "\n");
console.log("E8 budget and contract evidence: " + output); assert.equal(cases.filter(c => !c.pass).length, 0);
