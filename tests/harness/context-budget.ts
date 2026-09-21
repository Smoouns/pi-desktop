import assert from "node:assert/strict";
import { createContextBudget } from "../../src/harness/context-budget.js";
import type { RunCase } from "./testkit.js";

const scope = { projectId: "p", sessionId: "s", runId: "r", generation: 1, role: "write" };

export async function runContextBudgetCases(runCase: RunCase): Promise<void> {
	await runCase("CONTEXT-BUDGET-01 multilingual token estimation covers CJK, emoji, history, and every tool", (record) => {
		const budget = createContextBudget({ defaultOutputReserve: 32, defaultSafetyMargin: 16 });
		const messages = [{ role: "user", content: "白潮🌊" }, { role: "assistant", content: "保留全部历史" }];
		const tools = [{ name: "read", schema: { description: "读取章节" } }, { name: "write", schema: { description: "写入✍️" } }];
		const before = JSON.stringify({ messages, tools });
		const planned = budget.planRequest({ systemPrompt: "系统约束", tools, messages, messageKinds: ["new_evidence", "history"], contextWindow: 4_096 });
		assert.equal(planned.allowed, true);
		assert.equal(planned.ledger.estimator.kind, "estimated_tokens");
		assert.equal(planned.ledger.estimator.exactProviderTokens, false);
		assert.ok(planned.ledger.system > 0);
		assert.ok(planned.ledger.tools > 0);
		assert.ok(planned.ledger.newEvidence > 0);
		assert.equal(planned.ledger.rawInputBytes, new TextEncoder().encode(JSON.stringify({ systemPrompt: "系统约束", tools, messages })).byteLength);
		assert.ok(planned.ledger.inputEstimate < planned.ledger.rawInputBytes, "token estimate must no longer treat every UTF-8 byte as one token");
		assert.ok(planned.ledger.history > 0);
		assert.equal(
			planned.ledger.system + planned.ledger.tools + planned.ledger.history + planned.ledger.checkpoint
			+ planned.ledger.observationPreview + planned.ledger.newEvidence + planned.ledger.serializationOverhead,
			planned.ledger.total - planned.ledger.outputReserve - planned.ledger.safetyMargin,
			"ledger categories and serialization overhead must conserve the complete request estimate",
		);
		assert.equal(planned.messages, messages);
		assert.equal(JSON.stringify({ messages, tools }), before);
		record("context.budget.multilingual", { conservative: true, rawBytesSeparated: true, tools: tools.length });
	});

	await runCase("CONTEXT-BUDGET-02 request boundary blocks without truncating content", (record) => {
		const budget = createContextBudget({ defaultOutputReserve: 0, defaultSafetyMargin: 0 });
		const messages = [{ role: "user", content: "不要截断这段用户正文" }];
		const wide = budget.planRequest({ systemPrompt: "S", tools: [], messages, contextWindow: 1_024 });
		assert.equal(wide.allowed, true);
		const exact = budget.planRequest({ systemPrompt: "S", tools: [], messages, contextWindow: wide.ledger.total });
		assert.equal(exact.allowed, true);
		const blocked = budget.planRequest({ systemPrompt: "S", tools: [], messages, contextWindow: wide.ledger.total - 1 });
		assert.equal(blocked.allowed, false);
		assert.equal(blocked.reason, "model_input_budget_exceeded");
		assert.deepEqual(messages, [{ role: "user", content: "不要截断这段用户正文" }]);
		record("context.budget.boundary", { exactAllowed: true, overflowBlocked: true, truncated: false });
	});

	await runCase("CONTEXT-BUDGET-03 ledger categories are positional and checkpoint remains zero-capable", (record) => {
		const budget = createContextBudget({ defaultOutputReserve: 10, defaultSafetyMargin: 20 });
		const messages = [
			{ role: "user", content: "history" },
			{ role: "custom", content: "checkpoint" },
			{ role: "tool", content: "preview" },
			{ role: "tool", content: "evidence" },
		];
		const categorized = budget.planRequest({ systemPrompt: "", tools: [], messages, messageKinds: ["history", "checkpoint", "observation_preview", "new_evidence"], contextWindow: 2_048 });
		assert.ok(categorized.ledger.history > 0);
		assert.ok(categorized.ledger.checkpoint > 0);
		assert.ok(categorized.ledger.observationPreview > 0);
		assert.ok(categorized.ledger.newEvidence > 0);
		const phaseTwo = budget.planRequest({ systemPrompt: "", tools: [], messages: [messages[0]], contextWindow: 2_048 });
		assert.equal(phaseTwo.ledger.checkpoint, 0);
		assert.equal(phaseTwo.ledger.observationPreview, 0);
		assert.equal(phaseTwo.ledger.newEvidence, 0);
		record("context.budget.ledger", { checkpointReserved: true, checkpointImplemented: false });
	});

	await runCase("CONTEXT-BUDGET-04 actual payload guard serializes once and rejects unmetered media", (record) => {
		const budget = createContextBudget({ defaultOutputReserve: 7, defaultSafetyMargin: 11 });
		const payload = { model: "x", messages: [{ role: "user", content: "中文🌊" }], tools: [{ name: "a" }, { name: "b" }] };
		const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
		const measured = budget.checkPayload(payload, 10_000, 7, 11);
		const estimate = measured.ledger.inputEstimate;
		const allowed = budget.checkPayload(payload, estimate + 18, 7, 11);
		assert.equal(allowed.allowed, true);
		assert.equal(allowed.ledger.payload, estimate);
		assert.equal(allowed.ledger.rawInputBytes, bytes);
		assert.equal(allowed.ledger.total, estimate + 18);
		assert.equal(budget.checkPayload(payload, estimate + 17, 7, 11).allowed, false);
		const image = budget.checkPayload({ messages: [{ role: "user", content: [{ type: "image_url", image_url: "https://example.invalid/a.png" }] }] }, 10_000);
		assert.equal(image.allowed, false);
		assert.equal(image.reason, "unsupported_media");
		assert.ok(image.unsupportedMedia.length > 0);
		for (const inline of [
			{ inlineData: { mimeType: "image/png", data: "base64" } },
			{ inline_data: { mime_type: "image/jpeg", data: "base64" } },
		]) {
			const inlineResult = budget.checkPayload({ messages: [{ role: "user", content: [inline] }] }, 10_000);
			assert.equal(inlineResult.allowed, false);
			assert.equal(inlineResult.reason, "unsupported_media");
		}
		record("context.budget.payload", { exactSerialization: true, unmeteredMediaBlocked: true });
	});

	await runCase("CONTEXT-BUDGET-05 read and output budgets aggregate for the whole run", (record) => {
		const budget = createContextBudget({ defaultReadBudget: 10, defaultOutputBudget: 6 });
		assert.equal(budget.beginRun(scope).allowed, true);
		assert.equal(budget.chargeRead(scope, 4).allowed, true);
		assert.equal(budget.chargeRead(scope, 6).allowed, true);
		const readBlocked = budget.chargeRead(scope, 1);
		assert.equal(readBlocked.allowed, false);
		assert.equal(readBlocked.readUsed, 10);
		assert.equal(budget.chargeOutput(scope, 4).allowed, true);
		assert.equal(budget.beginRun(scope, { readLimit: 999, outputLimit: 999 }).readLimit, 10, "beginRun must not reset a live run");
		assert.equal(budget.chargeOutput(scope, 3).allowed, false);
		assert.equal(budget.getRunBudget(scope).outputUsed, 4);
		record("context.budget.run", { readUsed: 10, outputUsed: 4, perToolReset: false });
	});

	await runCase("CONTEXT-BUDGET-06 invalid numbers and unknown runs fail closed", (record) => {
		const budget = createContextBudget();
		for (const contextWindow of [Number.NaN, Number.POSITIVE_INFINITY, -1, 64.5]) {
			const result = budget.planRequest({ systemPrompt: "", tools: [], messages: [], contextWindow });
			assert.equal(result.allowed, false);
			assert.equal(result.reason, "invalid_budget");
		}
		assert.equal(budget.chargeRead(scope, 1).allowed, false);
		assert.equal(budget.beginRun(scope, { readLimit: Number.NaN }).allowed, false);
		assert.equal(budget.beginRun({ ...scope, runId: "valid" }, { readLimit: 1, outputLimit: 1 }).allowed, true);
		assert.equal(budget.chargeRead({ ...scope, runId: "valid" }, Number.POSITIVE_INFINITY).allowed, false);
		record("context.budget.fail_closed", { invalidInputs: 7 });
	});

	await runCase("CONTEXT-BUDGET-07 selection budget remains an independent soft signal", (record) => {
		const budget = createContextBudget({ selectionBudget: 5, defaultOutputReserve: 0, defaultSafetyMargin: 0 });
		assert.deepEqual(budget.checkSelection(6), { valid: true, exceeded: true, estimatedUnits: 6, softLimit: 5 });
		const request = budget.planRequest({ systemPrompt: "", tools: [], messages: [], contextWindow: 100 });
		assert.equal(request.allowed, true, "soft selection state must not become a request hard cap");
		record("context.budget.selection", { independent: true, softOnly: true });
	});

	await runCase("CONTEXT-BUDGET-08 factory source is standalone", (record) => {
		const rebuilt = Function(`return (${createContextBudget.toString()})`)() as typeof createContextBudget;
		const budget = rebuilt({ defaultReadBudget: 2, defaultOutputBudget: 2, defaultOutputReserve: 0, defaultSafetyMargin: 0 });
		assert.equal(budget.beginRun("embedded").allowed, true);
		assert.equal(budget.chargeRead("embedded", 2).allowed, true);
		assert.equal(budget.planRequest({ systemPrompt: "嵌入", tools: [], messages: [], contextWindow: 100 }).allowed, true);
		record("context.budget.embeddable", { standalone: true });
	});

	await runCase("CONTEXT-BUDGET-09 run capacity is bounded without evicting active ledgers", (record) => {
		const budget = createContextBudget({ maxRuns: 1, defaultReadBudget: 5 });
		const first = { ...scope, runId: "first" };
		const second = { ...scope, runId: "second" };
		assert.equal(budget.beginRun(first).allowed, true);
		assert.equal(budget.chargeRead(first, 3).allowed, true);
		const full = budget.beginRun(second);
		assert.equal(full.allowed, false);
		assert.equal(full.reason, "run_capacity_exceeded");
		assert.equal(budget.getRunBudget(first).readUsed, 3, "capacity pressure must not evict or reset an active run");
		assert.deepEqual(budget.endRun(first), { ended: true, reason: null });
		assert.deepEqual(budget.endRun(first), { ended: false, reason: "run_not_started" });
		assert.equal(budget.beginRun(second).allowed, true);
		record("context.budget.capacity", { maxRuns: 1, automaticEviction: false, explicitRelease: true });
	});

	await runCase("CONTEXT-BUDGET-10 reserves and integer arithmetic fail closed at their boundaries", (record) => {
		const budget = createContextBudget({ defaultOutputReserve: 0, defaultSafetyMargin: 0 });
		const request = { systemPrompt: "S", tools: [], messages: [{ role: "user", content: "正文".repeat(100) }], contextWindow: 1_024 };
		const base = budget.planRequest(request);
		assert.equal(base.allowed, true);
		const reserved = budget.planRequest({ ...request, contextWindow: base.ledger.total, outputReserve: 1 });
		assert.equal(reserved.allowed, false);
		assert.equal(reserved.reason, "model_input_budget_exceeded");
		assert.equal(reserved.ledger.total, base.ledger.total + 1);
		assert.equal(budget.checkPayload({}, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1).reason, "invalid_budget");
		assert.equal(budget.planRequest({ ...request, contextWindow: Number.MAX_SAFE_INTEGER, outputReserve: Number.MAX_SAFE_INTEGER }).reason, "invalid_budget");

		const huge = createContextBudget({ defaultReadBudget: Number.MAX_SAFE_INTEGER });
		const hugeScope = { ...scope, runId: "huge" };
		assert.equal(huge.beginRun(hugeScope).allowed, true);
		assert.equal(huge.chargeRead(hugeScope, Number.MAX_SAFE_INTEGER - 1).allowed, true);
		assert.equal(huge.chargeRead(hugeScope, 2).allowed, false);
		assert.equal(huge.getRunBudget(hugeScope).readUsed, Number.MAX_SAFE_INTEGER - 1);
		record("context.budget.arithmetic", { reserveEnforced: true, overflowBlocked: true, stateUnchanged: true });
	});

	await runCase("CONTEXT-BUDGET-11 estimator is conservative for multilingual text without byte-token inflation", (record) => {
		const budget = createContextBudget({ defaultOutputReserve: 0, defaultSafetyMargin: 0 });
		const ascii = budget.checkPayload({ text: "a".repeat(3_000) }, 10_000);
		const cjk = budget.checkPayload({ text: "汉".repeat(1_000) }, 10_000);
		const emoji = budget.checkPayload({ text: "🌊".repeat(1_000) }, 10_000);
		assert.ok(ascii.ledger.inputEstimate >= 1_000);
		assert.ok(cjk.ledger.inputEstimate >= 2_000);
		assert.ok(emoji.ledger.inputEstimate >= 2_600);
		for (const result of [ascii, cjk, emoji]) {
			assert.ok(result.ledger.inputEstimate < result.ledger.rawInputBytes);
			assert.equal(result.ledger.total, result.ledger.inputEstimate);
		}
		record("context.budget.units", { providerExact: false, bytesTrackedSeparately: true });
	});
}
