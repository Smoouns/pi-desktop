import assert from "node:assert/strict";
import { createUsageCalibration } from "../../src/harness/usage-calibration.js";
import { createContextBudget } from "../../src/harness/context-budget.js";
import { sha256, type RunCase } from "./testkit.js";

const owner = { projectId: "p", sessionId: "s", role: "write", taskId: "t" };
const model = { api: "openai-completions", provider: "public-synthetic", id: "offline", baseUrl: "https://loopback.invalid", contextWindow: 65536, maxTokens: 1024 };
const budget = createContextBudget();
const estimate = (payload: unknown) => budget.checkPayload(payload, Number.MAX_SAFE_INTEGER, 0, 0).ledger.inputEstimate;
const factory = () => createUsageCalibration({ digest: sha256, estimate });
const payload = { model: "offline", messages: [{ role: "system", content: "system" }, { role: "user", content: "PUBLIC-TEST" }], tools: [], stream: true };
const request = (body: any = payload, overrides: any = {}) => ({ owner, model, kind: "ordinary" as const, projection: { version: 1 }, body: JSON.stringify(body), endpoint: model.baseUrl + "/chat/completions", ...overrides });
const response = (usage: any = { input: 80, cacheRead: 20, cacheWrite: 0, output: 999, totalTokens: 1099 }, overrides: any = {}) => ({ status: "complete", usage, scopeCurrent: true, dispatchAttempts: 1, bodiesComplete: 1, redirected: false, ...overrides });
const last = (c: ReturnType<typeof factory>) => c.snapshot(owner).samples.at(-1)!;

export async function runUsageCalibrationCases(runCase: RunCase): Promise<void> {
	await runCase("CAL-01 pairs input-only SDK usage with final serialized estimate", record => {
		const c = factory(); c.finish(c.start(request()), response());
		assert.equal(last(c).sdkInputTokens, 100); assert.equal(last(c).estimatedInputTokens, estimate(payload));
		assert.equal(last(c).rawRequestBytes, Buffer.byteLength(JSON.stringify(payload))); assert.equal(last(c).eligible, true);
		assert.equal(last(c).baselineErrorTokens, estimate(payload) - 100); assert.equal(c.snapshot(owner).anchorCount, 1);
		assert.equal(c.snapshot(owner).appliedToBudget, false); assert.equal(c.snapshot(owner).costUsd, null);
		record("calibration.pair", { syntheticUsage: true, includesCache: true, excludesOutput: true, budgetUnchanged: true });
	});
	await runCase("CAL-02 compatible append computes a diagnostic delta, not a multiplier", () => {
		const c = factory(); c.finish(c.start(request()), response());
		const next = { ...payload, messages: [...payload.messages, { role: "assistant", content: "ok" }, { role: "user", content: "MORE" }] };
		c.finish(c.start(request(next)), response());
		assert.equal(last(c).anchorCompatibility, "compatible_append");
		assert.equal(last(c).anchoredInputEstimate, 100 + estimate(next) - estimate(payload));
		assert.equal(last(c).anchoredErrorTokens, estimate(next) - estimate(payload));
	});
	await runCase("CAL-03 model endpoint prompt schema projection and kind invalidate old anchors", () => {
		const changes = [
			request(payload, { model: { ...model, id: "other" } }), request(payload, { model: { ...model, provider: "other" } }),
			request(payload, { endpoint: model.baseUrl + "/alternate/chat/completions" }), request(payload, { model: { ...model, contextWindow: 32768 } }),
			request({ ...payload, messages: [{ role: "system", content: "changed" }, ...payload.messages.slice(1)] }),
			request({ ...payload, tools: [{ type: "function", function: { name: "new_tool", parameters: { type: "object" } } }] }),
			request(payload, { projection: { version: 2 } }), request(payload, { kind: "summary" }),
		];
		for (const changed of changes) {
			const c = factory(); c.finish(c.start(request()), response()); c.finish(c.start(changed), response());
			assert.equal(last(c).anchoredInputEstimate, null); assert.notEqual(last(c).anchorCompatibility, "compatible_append");
		}
	});
	await runCase("CAL-04 truncated rewritten reordered history is never append-compatible", () => {
		for (const messages of [payload.messages.slice(0, 1), [...payload.messages].reverse(), [...payload.messages.slice(0, 1), { role: "user", content: "CHANGED" }]]) {
			const c = factory(); c.finish(c.start(request()), response()); c.finish(c.start(request({ ...payload, messages })), response());
			assert.equal(last(c).anchorCompatibility, "history_not_append_only"); assert.equal(last(c).anchoredInputEstimate, null);
		}
	});
	await runCase("CAL-05 missing zero negative fractional and unsafe usage stay unknown", () => {
		for (const usage of [undefined, {}, { input: 80 }, { input: 0, cacheRead: 0, cacheWrite: 0 },
			{ input: -1, cacheRead: 20, cacheWrite: 0 }, { input: 1.5, cacheRead: 2, cacheWrite: 0 }, { input: Number.MAX_SAFE_INTEGER, cacheRead: 20, cacheWrite: 0 }]) {
			const c = factory(); c.finish(c.start(request()), response());
			c.finish(c.start(request()), { ...response(), usage });
			assert.equal(last(c).eligible, false); assert.equal(last(c).sdkInputTokens, null); assert.equal(last(c).baselineErrorTokens, null); assert.equal(c.snapshot(owner).anchorCount, 0);
			c.finish(c.start(request()), response()); assert.equal(last(c).anchoredInputEstimate, null);
		}
	});
	await runCase("CAL-06 retries aborted failed and incomplete responses cannot calibrate", () => {
		for (const overrides of [{ dispatchAttempts: 2 }, { dispatchAttempts: 0 }, { bodiesComplete: 0 }, { redirected: true }, { status: "error" }, { status: "aborted" }]) {
			const c = factory(); c.finish(c.start(request()), response(undefined, overrides));
			assert.equal(last(c).eligible, false); assert.equal(last(c).baselineErrorTokens, null); assert.equal(c.snapshot(owner).anchorCount, 0);
		}
	});
	await runCase("CAL-07 compaction resets and late completion cannot revive an anchor", () => {
		const c = factory(); c.finish(c.start(request()), response()); const pending = c.start(request());
		c.invalidate("compaction_started"); c.finish(pending, response()); assert.equal(c.snapshot(owner).anchorCount, 0);
		c.finish(c.start(request()), response()); assert.equal(last(c).anchoredInputEstimate, null); assert.equal(last(c).anchorCompatibility, "compaction_started");
		c.reset(); assert.deepEqual(c.snapshot(owner).samples, []); assert.equal(c.snapshot(owner).anchorCount, 0);
	});
	await runCase("CAL-08 scope and response ordering cannot borrow another request's usage", () => {
		const c = factory(), first = c.start(request()), second = c.start(request());
		c.finish(first, response()); assert.equal(c.snapshot(owner).samples.length, 0);
		c.finish(second, response()); assert.equal(c.snapshot(owner).samples.length, 1);
		for (const foreign of [{ ...owner, sessionId: "other" }, { ...owner, projectId: "other" }, { ...owner, role: "plan" }, { ...owner, taskId: "other" }]) {
			assert.equal(c.snapshot(foreign).samples.length, 0);
			c.finish(c.start(request(payload, { owner: foreign })), response()); assert.equal(c.snapshot(foreign).samples[0].anchoredInputEstimate, null);
		}
		c.finish(c.start(request()), response(undefined, { scopeCurrent: false })); assert.equal(c.snapshot(owner).anchorCount, 0);
	});
	await runCase("CAL-09 bounded hash-only records survive embedding but not cold restart", () => {
		const c = (Function(`return (${createUsageCalibration.toString()})`)() as typeof createUsageCalibration)({ digest: sha256, estimate });
		for (let i = 0; i < 45; i++) c.finish(c.start(request()), response());
		const view = c.snapshot(owner); assert.equal(view.samples.length, 32);
		assert.doesNotMatch(JSON.stringify(view), /PUBLIC-TEST|loopback\.invalid|Bearer|system"/);
		view.samples[0].estimatedInputTokens = 999999; assert.notEqual(c.snapshot(owner).samples[0].estimatedInputTokens, 999999);
		assert.equal(factory().snapshot(owner).anchorCount, 0);
		for (let i = 0; i < 16; i++) assert.ok(c.start(request())); assert.equal(c.start(request()), null);
		c.reset(); assert.ok(c.start(request()));
	});
	await runCase("CAL-10 Google system tools and normalized cache use the same boundaries", () => {
		const c = factory(), google = { ...model, api: "google-generative-ai" };
		const body = { contents: [{ role: "user", parts: [{ text: "PUBLIC-GOOGLE" }] }], systemInstruction: { parts: [{ text: "system" }] }, tools: [] };
		const options = { model: google, endpoint: model.baseUrl + "/models/offline:streamGenerateContent" };
		c.finish(c.start(request(body, options)), response()); assert.equal(last(c).sdkInputTokens, 100);
		c.finish(c.start(request({ ...body, systemInstruction: { parts: [{ text: "changed" }] } }, options)), response());
		assert.equal(last(c).anchoredInputEstimate, null); assert.equal(last(c).anchorCompatibility, "model_or_static_context_changed");
	});
	await runCase("CAL-11 unsupported history drops diagnostic anchors without touching budget", () => {
		const c = factory(); c.finish(c.start(request()), response());
		const before = budget.checkPayload(payload, 1000, 200, 100);
		assert.equal(c.start(request({ ...payload, messages: Array(2049).fill(payload.messages[1]) })), null);
		assert.equal(c.snapshot(owner).anchorCount, 0); assert.equal(c.snapshot(owner).lastInvalidation, "unsupported_history");
		assert.deepEqual(budget.checkPayload(payload, 1000, 200, 100), before);
	});
}
