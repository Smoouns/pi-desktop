import { createComponentAdapter } from "../adapters/components.js";
import type { EvalTask, TaskResult } from "../core/types.js";
import type { ToolResult } from "../../src/harness/tool-policy.js";

const requiredChecks = ["read-retry-bounded", "read-recovers", "permission-never-retried", "write-timeout-unknown", "write-not-replayed"];
export const task: EvalTask = {
	definition: {
		id: "TOOL-002-typed-recovery", version: 2, category: "TOOL", fixture: "fixtures/harness-novel", requiredCapabilities: ["toolReliability"],
		allowedActions: ["execute synthetic read callbacks", "simulate one dispatched write with unknown result using an injected clock"],
		faults: ["two transient read failures", "permission failure", "write timeout after dispatch"], requiredChecks,
		unsupportedConditions: ["real provider requests", "full session RPC integration", "OS process failure"], rubric: null,
	},
	async run(_project, adapter = createComponentAdapter()): Promise<TaskResult> {
		const delays: number[] = [];
		const retry = adapter.toolRuntime!({ sleep: async (ms) => { delays.push(ms); }, backoffMs: (n) => n * 10 });
		const read = await retry.execute({ params: {}, operation: async (_params, { attempt }): Promise<ToolResult<string>> => attempt < 3
			? { ok: false, error: { kind: "transient", code: "SYNTHETIC_TRANSIENT", message: "synthetic" } }
			: { ok: true, value: "public-result" } });
		const denied = await retry.execute({ params: {}, operation: async (): Promise<ToolResult<string>> => ({ ok: false, error: { kind: "permission", code: "SYNTHETIC_PERMISSION", message: "synthetic" } }) });
		let release: (() => void) | undefined;
		const timeoutRuntime = adapter.toolRuntime!({ now: () => 0, sleep: async () => new Promise<void>((resolve) => { release = resolve; }) });
		let writes = 0;
		const pending = timeoutRuntime.execute({ params: {}, sideEffect: true, deadlineMs: 1, operation: async (): Promise<ToolResult<string>> => { writes++; return new Promise(() => undefined); } });
		await Promise.resolve();
		if (!release) throw new Error("DEADLINE_NOT_REGISTERED");
		release();
		const timed = await pending;
		const values = [read.attempts === 3 && delays.join(",") === "10,20", read.result.ok, denied.attempts === 1 && denied.actions.join(",") === "block",
			!timed.result.ok && timed.result.error.kind === "unknown_outcome" && timed.actions.join(",") === "reconcile", writes === 1];
		return { status: values.every(Boolean) ? "pass" : "fail", reasonCode: values.every(Boolean) ? "TYPED_RECOVERY_PASS" : "TYPED_RECOVERY_FAILED",
			checks: requiredChecks.map((id, index) => ({ id, passed: values[index]! })),
			trace: [{ event: "typed.read.recovery", data: { attempts: read.attempts, retryCount: delays.length } },
				{ event: "typed.write.timeout", data: { dispatches: writes, unknown: !timed.result.ok && timed.result.error.kind === "unknown_outcome" } }],
			metrics: { modelCalls: 0, duplicateSideEffects: Math.max(0, writes - 1), staleEvidenceUsed: 0, blockedDuplicateDispatches: 0, recoveries: read.result.ok ? 1 : 0 },
		};
	},
};
