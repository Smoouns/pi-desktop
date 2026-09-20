import assert from "node:assert/strict";
import { createTraceRecorder } from "../../src/harness/trace.js";
import type { RunScope, TraceSummaryValue } from "../../src/harness/types.js";
import type { RunCase } from "./testkit.js";

const baseScope: RunScope = {
	projectId: "project-a",
	sessionId: "session-a",
	runId: "run-a",
	generation: 7,
	role: null,
};

export async function runTraceCases(runCase: RunCase): Promise<void> {
	await runCase("TRACE-01 deterministic scalar records and isolated snapshots", (record) => {
		let time = 40;
		const scope = { ...baseScope };
		const recorder = createTraceRecorder({ caseId: "TRACE-01", scope, now: () => ++time });
		const first = recorder.record("read.completed", { zCount: 2, accepted: true, detail: null, code: "OK" });
		scope.projectId = "mutated-after-construction";
		const second = recorder.record("read.completed", { zCount: 3 });

		assert.deepEqual(Object.keys(first.summary), ["accepted", "code", "detail", "zCount"]);
		assert.deepEqual([first.sequence, second.sequence], [1, 2]);
		assert.deepEqual([first.timestampMs, second.timestampMs], [41, 42]);
		assert.equal(second.scope.projectId, "project-a", "recorder must snapshot its initial scope");

		const snapshot = recorder.snapshot();
		snapshot[0].scope.projectId = "mutated-snapshot";
		snapshot[0].summary.code = "CHANGED";
		snapshot.push(second);
		const unchanged = recorder.snapshot();
		assert.equal(unchanged.length, 2);
		assert.equal(unchanged[0].scope.projectId, "project-a");
		assert.equal(unchanged[0].summary.code, "OK");

		const invalidValues: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, {}, [], undefined];
		for (const value of invalidValues) {
			assert.throws(
				() => recorder.record("invalid", { value } as unknown as Record<string, TraceSummaryValue>),
				/Trace summary field value must be (?:finite|a scalar)/,
			);
		}
		assert.equal(recorder.snapshot().length, 2, "rejected records must not consume a sequence");
		record("trace.verified", { records: 2, invalidRejected: invalidValues.length });
	});
}
