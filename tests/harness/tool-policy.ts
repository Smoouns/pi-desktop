import assert from "node:assert/strict";
import { createToolRuntime, type ToolResult } from "../../src/harness/tool-policy.js";
import type { RunCase } from "./testkit.js";

const fail = (kind: "transient" | "invalid_input" | "stale_source" | "permission" | "validation", code = kind): ToolResult<never> => ({
	ok: false, error: { kind, code, message: code },
});

export async function runToolPolicyCases(runCase: RunCase): Promise<void> {
	await runCase("TOOL-POLICY-01 bounded read retry and backoff", async (record) => {
		const delays: number[] = [];
		const runtime = createToolRuntime({ sleep: async (ms) => { delays.push(ms); }, backoffMs: (retry) => retry * 10 });
		const result = await runtime.execute({ params: {}, operation: async (_params, { attempt }) => attempt < 3 ? fail("transient") : { ok: true, value: "ok" } });
		assert.deepEqual(result.result, { ok: true, value: "ok" });
		assert.deepEqual(result.actions, ["retry", "retry"]);
		assert.deepEqual(delays, [10, 20]);
		record("tool.policy.retry", { attempts: result.attempts, retries: delays.length });
	});

	await runCase("TOOL-POLICY-02 invalid input requires changed repair", async (record) => {
		const runtime = createToolRuntime();
		const calls: string[] = [];
		const result = await runtime.execute({ params: { path: "bad" }, operation: async (params) => { calls.push(params.path); return fail("invalid_input"); }, repair: async (params) => params });
		assert.deepEqual(calls, ["bad"]);
		assert.deepEqual(result.actions, ["block"]);
		record("tool.policy.invalid_input", { attempts: result.attempts, exactReplay: false });
	});

	await runCase("TOOL-POLICY-03 stale source refreshes before retry", async (record) => {
		const runtime = createToolRuntime();
		const seen: number[] = [];
		const result = await runtime.execute({ params: { version: 1 }, operation: async (params) => { seen.push(params.version); return params.version === 1 ? fail("stale_source") : { ok: true, value: params.version }; }, refreshSources: async () => ({ version: 2 }) });
		assert.deepEqual(seen, [1, 2]);
		assert.deepEqual(result.actions, ["refresh_sources"]);
		record("tool.policy.refresh", { attempts: result.attempts });
	});

	await runCase("TOOL-POLICY-04 validation repair is bounded", async (record) => {
		const runtime = createToolRuntime({ maxRepairs: 1 });
		const result = await runtime.execute({ params: { revision: 0 }, operation: async () => fail("validation"), repair: async (params) => ({ revision: params.revision + 1 }) });
		assert.equal(result.attempts, 2);
		assert.deepEqual(result.actions, ["repair", "block"]);
		record("tool.policy.validation", { attempts: result.attempts });
	});

	await runCase("TOOL-POLICY-05 permission blocks without replay", async (record) => {
		const runtime = createToolRuntime();
		const result = await runtime.execute({ params: {}, operation: async () => fail("permission") });
		assert.equal(result.attempts, 1);
		assert.deepEqual(result.actions, ["block"]);
		record("tool.policy.permission", { attempts: 1 });
	});

	await runCase("TOOL-POLICY-06 abort fences late success", async (record) => {
		const controller = new AbortController();
		let finish!: (result: ToolResult<string>) => void;
		const late = new Promise<ToolResult<string>>((resolve) => { finish = resolve; });
		const runtime = createToolRuntime();
		const pending = runtime.execute({ params: {}, signal: controller.signal, operation: async () => late });
		controller.abort();
		const result = await pending;
		finish({ ok: true, value: "late" });
		await Promise.resolve();
		assert.equal(result.result.ok, false);
		if (!result.result.ok) assert.equal(result.result.error.kind, "cancelled");
		record("tool.policy.cancelled", { attempts: result.attempts, lateAccepted: false });
	});

	await runCase("TOOL-POLICY-07 side effects never blind retry", async (record) => {
		const runtime = createToolRuntime();
		let calls = 0;
		const result = await runtime.execute({ params: {}, sideEffect: true, operation: async () => { calls += 1; return fail("transient"); } });
		assert.equal(calls, 1);
		assert.deepEqual(result.actions, ["stop"]);
		record("tool.policy.write_no_replay", { attempts: calls });
	});

	await runCase("TOOL-POLICY-08 dispatched write timeout is unknown outcome", async (record) => {
		let releaseSleep!: () => void;
		const runtime = createToolRuntime({ now: () => 0, sleep: async () => new Promise<void>((resolve) => { releaseSleep = resolve; }) });
		const pending = runtime.execute({ params: {}, sideEffect: true, deadlineMs: 1, operation: async () => new Promise<ToolResult<string>>(() => undefined) });
		await Promise.resolve();
		releaseSleep();
		const result = await pending;
		assert.equal(result.result.ok, false);
		if (!result.result.ok) assert.equal(result.result.error.kind, "unknown_outcome");
		assert.deepEqual(result.actions, ["reconcile"]);
		record("tool.policy.unknown_outcome", { attempts: result.attempts });
	});

	await runCase("TOOL-POLICY-09 factory source is standalone", async (record) => {
		const rebuilt = Function(`return (${createToolRuntime.toString()})`)() as typeof createToolRuntime;
		const result = await rebuilt().execute({ params: {}, operation: async () => ({ ok: true, value: 1 }) });
		assert.deepEqual(result.result, { ok: true, value: 1 });
		record("tool.policy.embeddable", { standalone: true });
	});

	await runCase("TOOL-POLICY-10 cancelled write remains unknown", async (record) => {
		const controller = new AbortController();
		let finish!: (result: ToolResult<string>) => void;
		const operation = new Promise<ToolResult<string>>((resolve) => { finish = resolve; });
		const runtime = createToolRuntime();
		const pending = runtime.execute({ params: {}, sideEffect: true, signal: controller.signal, operation: async () => operation });
		controller.abort();
		const result = await pending;
		finish({ ok: true, value: "late" });
		assert.equal(result.result.ok, false);
		if (!result.result.ok) assert.equal(result.result.error.kind, "unknown_outcome");
		assert.deepEqual(result.actions, ["reconcile"]);
		record("tool.policy.cancelled_write", { lateAccepted: false });
	});

	await runCase("TOOL-POLICY-11 stale refresh is bounded and must change params", async (record) => {
		const runtime = createToolRuntime({ maxRefreshes: 1 });
		let refreshCalls = 0;
		const same = await runtime.execute({ params: { sha: "old" }, operation: async () => fail("stale_source"), refreshSources: async (params) => { refreshCalls += 1; return params; } });
		assert.equal(same.attempts, 1);
		assert.equal(refreshCalls, 1);
		assert.deepEqual(same.actions, ["refresh_sources", "block"]);

		const bounded = await runtime.execute({ params: { sha: "a" }, operation: async () => fail("stale_source"), refreshSources: async () => ({ sha: "b" }) });
		assert.equal(bounded.attempts, 2);
		assert.deepEqual(bounded.actions, ["refresh_sources", "refresh_sources", "block"]);
		record("tool.policy.refresh_bounded", { sameParamsBlocked: true, attempts: bounded.attempts });
	});

	await runCase("TOOL-POLICY-12 callback failures are structured", async (record) => {
		const runtime = createToolRuntime({ sleep: async () => { throw new Error("timer unavailable"); } });
		const backoff = await runtime.execute({ params: {}, operation: async () => fail("transient") });
		const refresh = await runtime.execute({ params: {}, operation: async () => fail("stale_source"), refreshSources: async () => { throw new Error("refresh unavailable"); } });
		const repair = await runtime.execute({ params: {}, operation: async () => fail("validation"), repair: async () => { throw new Error("repair unavailable"); } });
		const reconcile = await runtime.execute({
			params: {}, sideEffect: true,
			operation: async () => ({ ok: false, error: { kind: "unknown_outcome", code: "DROPPED", message: "dropped" } }),
			reconcile: async () => { throw new Error("reconcile unavailable"); },
		});
		for (const [result, code] of [[backoff, "BACKOFF_FAILED"], [refresh, "REFRESH_FAILED"], [repair, "REPAIR_FAILED"], [reconcile, "RECONCILE_FAILED"]] as const) {
			assert.equal(result.result.ok, false);
			if (!result.result.ok) {
				assert.equal(result.result.error.kind, "fatal");
				assert.equal(result.result.error.code, code);
			}
		}
		record("tool.policy.callback_failures", { structured: 4 });
	});

	await runCase("TOOL-POLICY-13 invalid budgets fall back to finite defaults", async (record) => {
		const runtime = createToolRuntime({ maxTransientRetries: Number.NaN, maxRepairs: Number.POSITIVE_INFINITY, maxRefreshes: -1, sleep: async () => undefined });
		const transient = await runtime.execute({ params: {}, maxTransientRetries: -5, operation: async (_params, { attempt }) => attempt === 3 ? { ok: true, value: true } : fail("transient") });
		assert.equal(transient.attempts, 3);
		assert.equal(transient.result.ok, true);
		const validation = await runtime.execute({ params: { n: 0 }, maxRepairs: Number.NaN, operation: async () => fail("validation"), repair: async (params) => ({ n: params.n + 1 }) });
		assert.equal(validation.attempts, 2);
		assert.deepEqual(validation.actions, ["repair", "block"]);
		record("tool.policy.budgets", { finiteFallback: true });
	});

	await runCase("TOOL-POLICY-14 pre-cancel does not dispatch and expired deadline does not retry", async (record) => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const runtime = createToolRuntime();
		const cancelled = await runtime.execute({ params: {}, signal: controller.signal, operation: async () => { calls += 1; return { ok: true, value: true }; } });
		assert.equal(calls, 0);
		assert.deepEqual(cancelled.actions, ["stop"]);

		let clock = 0;
		const deadlineRuntime = createToolRuntime({ now: () => clock, sleep: async (ms) => { clock += ms; } });
		const expired = await deadlineRuntime.execute({ params: {}, deadlineMs: 5, operation: async () => new Promise<ToolResult<string>>(() => undefined) });
		assert.equal(expired.attempts, 1);
		assert.deepEqual(expired.actions, ["stop"]);
		assert.equal(expired.result.ok, false);
		if (!expired.result.ok) assert.equal(expired.result.error.code, "DEADLINE_EXCEEDED");
		record("tool.policy.deadline", { preCancelledDispatches: calls, retriesAfterExpiry: 0 });
	});

	await runCase("TOOL-POLICY-15 invalid deadlines and terminal failures stop before replay", async (record) => {
		const runtime = createToolRuntime();
		let calls = 0;
		for (const deadlineMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const result = await runtime.execute({ params: {}, deadlineMs, sideEffect: true, operation: async () => { calls += 1; return { ok: true, value: true }; } });
			assert.equal(result.attempts, 0);
			assert.deepEqual(result.actions, ["block"]);
			assert.equal(result.result.ok, false);
			if (!result.result.ok) {
				assert.equal(result.result.error.kind, "invalid_input");
				assert.equal(result.result.error.code, "INVALID_DEADLINE");
			}
		}
		assert.equal(calls, 0);
		const precondition = await runtime.execute({ params: {}, operation: async () => ({ ok: false, error: { kind: "precondition", code: "MISSING", message: "missing" } }) });
		assert.equal(precondition.attempts, 1);
		assert.deepEqual(precondition.actions, ["block"]);
		const fatal = await runtime.execute({ params: {}, operation: async () => ({ ok: false, error: { kind: "fatal", code: "BROKEN", message: "broken" } }) });
		assert.equal(fatal.attempts, 1);
		assert.deepEqual(fatal.actions, ["stop"]);
		record("tool.policy.terminal", { invalidDeadlines: 3, dispatched: calls, preconditionBlocked: true, fatalStopped: true });
	});
}
