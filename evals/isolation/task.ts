import { access } from "node:fs/promises";
import { join } from "node:path";
import { createComponentAdapter } from "../adapters/components.js";
import type { RunScope } from "../../src/harness/types.js";
import type { EvalTask, TaskResult } from "../core/types.js";

const checkIds = ["fixture-present", "same-authority-positive-control", "project-isolated", "session-isolated", "role-isolated", "generation-budget-isolated"] as const;
const metrics = (): TaskResult["metrics"] => ({ modelCalls: 0, duplicateSideEffects: 0, staleEvidenceUsed: 0, blockedDuplicateDispatches: 0, recoveries: 0 });
const stale = (operation: () => unknown): boolean => { try { operation(); return false; } catch (error) { return !!error && typeof error === "object" && "kind" in error && (error as { kind: unknown }).kind === "stale_source"; } };

export const task: EvalTask = {
	definition: {
		id: "ISO-001-authority-boundaries", version: 2, requiredCapabilities: ["observations", "contextBudget"], category: "ISO", fixture: "fixtures/harness-novel",
		allowedActions: ["read public fixture metadata", "store synthetic observation", "allocate in-memory run budgets"],
		faults: ["cross-project observation read", "cross-session observation read", "cross-role observation read", "generation budget reuse"],
		requiredChecks: [...checkIds],
		unsupportedConditions: ["OS account isolation", "multi-process persistence", "remote tenant isolation"],
		rubric: null,
	},
	async run(project, adapter = createComponentAdapter()): Promise<TaskResult> {
		const checks = checkIds.map((id) => ({ id, passed: false }));
		const set = (id: typeof checkIds[number], passed: boolean): void => { checks.find((item) => item.id === id)!.passed = passed; };
		try {
			await access(join(project, "README.md")); set("fixture-present", true);
			const scope: RunScope = { projectId: "project-a", sessionId: "session-a", role: "planning", runId: "run-1", generation: 1 };
			const store = adapter.observationStore!(); const record = store.put({ scope, toolName: "read", toolCallId: "call-1", text: "public synthetic observation", sources: [] });
			set("same-authority-positive-control", store.read({ id: record.id, scope: { ...scope, runId: "run-2", generation: 2 } }).payload === "public synthetic observation");
			set("project-isolated", stale(() => store.read({ id: record.id, scope: { ...scope, projectId: "project-b" } })));
			set("session-isolated", stale(() => store.read({ id: record.id, scope: { ...scope, sessionId: "session-b" } })));
			set("role-isolated", stale(() => store.read({ id: record.id, scope: { ...scope, role: "drafting" } })));
			const budget = adapter.contextBudget!({ defaultReadBudget: 10, defaultOutputBudget: 10 });
			const generationOne = { ...scope, generation: 1 }; const generationTwo = { ...scope, generation: 2 };
			budget.beginRun(generationOne); budget.chargeRead(generationOne, 7); budget.beginRun(generationTwo);
			const first = budget.getRunBudget(generationOne); const second = budget.getRunBudget(generationTwo);
			set("generation-budget-isolated", first.readUsed === 7 && second.readUsed === 0 && second.availableRead === 10);
			const passed = checks.every((item) => item.passed);
			return { status: passed ? "pass" : "fail", reasonCode: passed ? "ISO_BOUNDARIES_PASS" : "ISO_CHECK_FAILED", checks, trace: [
				{ event: "observation_boundaries_checked", data: { positiveControl: checks[1]!.passed, projectBlocked: checks[2]!.passed, sessionBlocked: checks[3]!.passed, roleBlocked: checks[4]!.passed } },
				{ event: "generation_budgets_checked", data: { generationOneRead: first.readUsed, generationTwoRead: second.readUsed } },
			], metrics: metrics() };
		} catch {
			return { status: "fail", reasonCode: "ISO_RUNTIME_FAILURE", checks, trace: [{ event: "isolation_task_failed", data: { stage: "authority-boundaries" } }], metrics: metrics() };
		}
	},
};
