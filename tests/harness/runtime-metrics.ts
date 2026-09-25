import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRuntimeMetrics } from "../../src/harness/runtime-metrics.js";
import { withLoadedExtension } from "./contracts.js";
import { sha256, withProject, type RunCase } from "./testkit.js";

export async function runRuntimeMetricCases(runCase: RunCase): Promise<void> {
	await runCase("METRICS-01 separates estimates, audit callbacks and unknown HTTP", record => {
		const meter = createRuntimeMetrics();
		meter.plan("context-preflight", { allowed: true, ledger: { inputEstimate: 12, rawInputBytes: 30, total: 40, limit: 100, prompt: "SECRET" } });
		meter.plan("provider-audit", { allowed: false, ledger: { inputEstimate: 70, rawInputBytes: 200, total: 110, limit: 100 }, payload: "SECRET" });
		const value = meter.snapshot();
		assert.deepEqual(value.contextPreflight.latest, { allowed: true, estimatedInputTokens: 12, serializedInputBytes: 30, totalWithReserves: 40, limit: 100 });
		assert.equal(value.providerPayloadAudit.checks, 1); assert.equal(value.providerPayloadAudit.blocked, 1);
		assert.equal(value.transport.httpDispatches, null); assert.equal(value.transport.retries, null); assert.equal(value.transport.summaryRequests, null);
		assert.equal(value.transport.taskTotalComplete, false); assert.equal(value.sdkUsage.totals.input, null);
		assert.doesNotMatch(JSON.stringify(value), /SECRET/);
		meter.plan("context-preflight", new Proxy({}, { get() { throw Error("SECRET"); } }));
		assert.equal(meter.snapshot().contextPreflight.latest, null);
		record("metrics.layers", { estimate: 12, auditCallbacks: 1, httpKnown: false });
	});
	await runCase("METRICS-02 missing and all-zero usage never becomes free tokens", record => {
		const meter = createRuntimeMetrics();
		const message = { role: "assistant", stopReason: "stop", usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15, cost: { total: 777 } }, content: "PRIVATE" };
		meter.usage(message); meter.usage(message); // A repeated event for the same message is not another bill.
		assert.equal(meter.snapshot().sdkUsage.responses, 1);
		assert.equal(meter.snapshot().sdkUsage.totals.input, 10);
		meter.usage({ role: "assistant", stopReason: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
		const value = meter.snapshot().sdkUsage;
		assert.equal(value.responses, 2); assert.equal(value.failedOrAbortedResponses, 1); assert.equal(value.unknownResponses, 1);
		assert.equal(value.totals.input, null); assert.equal(value.knownSubtotals.input, 10); assert.equal(value.costUsd, null);
		assert.equal(value.cacheBreakdownVerified, false);
		assert.doesNotMatch(JSON.stringify(meter.snapshot()), /PRIVATE|777/);
		const partial = createRuntimeMetrics();
		partial.usage({ role: "assistant", usage: { input: 10, output: -3, cacheRead: NaN, cacheWrite: Infinity, totalTokens: 1.5 } });
		assert.equal(partial.snapshot().sdkUsage.totals.input, 10); assert.equal(partial.snapshot().sdkUsage.totals.cacheRead, null);
		partial.usage({ role: "assistant", usage: new Proxy({}, { get() { throw Error("PRIVATE"); } }) });
		assert.equal(partial.snapshot().sdkUsage.totals.input, null);
		record("metrics.unknown", { partialRetained: true, zeroIsUnknown: true, noCostGuess: true });
	});
	await runCase("METRICS-03 counts file reads separately from references with bounded identity tracking", record => {
		const meter = createRuntimeMetrics({ maxTrackedFiles: 2 });
		const frame = meter.beginContext();
		meter.read("document", sha256("a"), 100); meter.read("observationValidation", sha256("a"), 100);
		meter.reference("observationSources", 3); meter.reference("checkpointSources", 2);
		meter.read("checkpointValidation", sha256("b"), null);
		meter.endContext(frame);
		meter.read("fingerprint", sha256("b"), 50); meter.read("memory", sha256("c"), 40);
		const value = meter.snapshot();
		assert.deepEqual(value.reads.total, { calls: 5, bytes: 290, failures: 1 });
		assert.deepEqual(value.reads.lastContext?.reads.total, { calls: 3, bytes: 200, failures: 1 });
		assert.equal(value.reads.repeatedPathReadsAtLeast, 1); assert.equal(value.reads.distinctPathsTracked, 2); assert.equal(value.reads.fileTrackingTruncated, true);
		assert.equal(value.reads.logicalReferences.observationSources, 3);
		value.reads.lastContext!.reads.total.bytes = 999;
		assert.equal(meter.snapshot().reads.lastContext?.reads.total.bytes, 200);
		const next = meter.beginContext(); meter.endContext(frame);
		meter.read("document", sha256("a"), 7); meter.endContext(next);
		assert.equal(meter.snapshot().reads.lastContext?.reads.repeatedPathReadsAtLeast, 0);
		assert.equal(meter.snapshot().reads.lastContext?.reads.total.bytes, 7);
		record("metrics.reads", { fileCalls: 5, logicalSourceRefs: 5, contextBytes: 200, capped: true });
	});
	await runCase("METRICS-04 standalone factory and overflow are explicit", record => {
		const rebuilt = Function(`return (${createRuntimeMetrics.toString()})`)() as typeof createRuntimeMetrics;
		const meter = rebuilt(); meter.read("document", sha256("x"), Number.MAX_SAFE_INTEGER);
		meter.read("document", sha256("x"), 1);
		assert.equal(meter.snapshot().overflow, true);
		assert.equal(meter.snapshot().reads.total.bytes, Number.MAX_SAFE_INTEGER);
		const first = meter.beginContext(), second = meter.beginContext(); meter.endContext(first); meter.endContext(second);
		assert.equal(meter.snapshot().reads.overlappingContexts, true);
		record("metrics.boundaries", { standalone: true, overflowReported: true, overlapReported: true });
	});
	await runCase("METRICS-05 production reads and observation pages retain revalidation and isolation", record => withProject(async root => {
		const sourcePath = "canon/world.md", raw = await readFile(path.join(root, sourcePath));
		for (const minified of [false, true]) await withLoadedExtension(root, minified, async extension => {
			const ctx = (sessionId: string) => ({ cwd: root, sessionManager: { getSessionId: () => sessionId, getBranch: () => [] } });
			const a = ctx("metrics-a"), b = ctx("metrics-b");
			const execute = (name: string, id: string, params: any, context = a) => extension.tools.get(name)!.definition.execute(id, params, undefined, undefined, context as never) as Promise<any>;
			const budget = async (id: string, context = a) => JSON.parse((await execute("get_context_budget", id, {}, context)).content[0].text);
			const first = await execute("read_story_document", "read-1", { path: sourcePath });
			await execute("read_story_document", "read-2", { path: sourcePath });
			const page = await execute("read_observation", "page", { id: first.details.observation.id, start: 0, limit: 10 });
			assert.equal(page.details.hasMore, true);
			const initial = await budget("metrics");
			assert.equal(initial.metrics.reads.byKind.document.calls, 2);
			assert.equal(initial.metrics.reads.byKind.document.bytes, raw.length * 2);
			assert.equal(initial.metrics.reads.byKind.observationValidation.calls, 1);
			assert.equal(initial.metrics.reads.logicalReferences.observationPages, 1);
			assert.equal(initial.metrics.reads.logicalReferences.observationPageBytes, 10);
			assert.equal(initial.run.readUsed, raw.length * 3 + 10, "Existing resource charging unchanged");
			await writeFile(path.join(root, sourcePath), Buffer.concat([raw, Buffer.from("changed")]));
			try { await assert.rejects(execute("read_observation", "stale", { id: first.details.observation.id }), /STALE_OBSERVATION/); }
			finally { await writeFile(path.join(root, sourcePath), raw); }
			const foreign = await budget("b", b);
			assert.equal(foreign.metrics.reads.total.calls, 0); assert.equal(foreign.previousRun, null);
			const restored = await budget("a-back");
			assert.equal(restored.metrics.reads.total.calls, 0);
			assert.equal(restored.previousRun.scope.sessionId, "metrics-a");
			assert.equal(restored.previousRun.metrics.reads.byKind.observationValidation.calls, 2);
			assert.doesNotMatch(JSON.stringify(restored.metrics), /canon\/world|SECRET/);
		});
		record("metrics.adapter", { minified: true, unchangedBudget: true, modifiedSourceRejected: true, sessionIsolated: true });
	}));
}
