import { createOperationLedger } from "../../src/harness/operation-ledger.js";
import { createToolRuntime } from "../../src/harness/tool-policy.js";
import { createObservationStore } from "../../src/harness/observation-store.js";
import { createContextBudget } from "../../src/harness/context-budget.js";
import { createCheckpointStore } from "../../src/harness/checkpoint-store.js";
import { createSourceVersioning } from "../../src/harness/source-version.js";
import { createCheckpointInvalidation } from "../../src/harness/invalidation.js";
import type { Capability, EvalTask, TaskResult } from "../core/types.js";

/** Current-source component adapters, NOT historical B0/B1/B2/B3 implementations. */
export const componentProfiles: Readonly<Record<string, readonly Capability[]>> = Object.freeze({
	"c1-tool-contract": Object.freeze(["toolReliability"] as Capability[]),
	"c2-observation-budget": Object.freeze(["toolReliability", "observations", "contextBudget"] as Capability[]),
	"c3-versioned-checkpoint": Object.freeze(["toolReliability", "observations", "contextBudget", "versionedCheckpoint"] as Capability[]),
	"current-full-contract": Object.freeze(["toolReliability", "observations", "contextBudget", "versionedCheckpoint"] as Capability[]),
});
export const comparisonVariants = ["c1-tool-contract", "c2-observation-budget", "c3-versioned-checkpoint"] as const;

export interface ComponentAdapter {
	id: string;
	capabilities: readonly Capability[];
	operationLedger?: typeof createOperationLedger;
	toolRuntime?: typeof createToolRuntime;
	observationStore?: typeof createObservationStore;
	contextBudget?: typeof createContextBudget | typeof import("./snapshots/context-budget.js").createContextBudget;
	checkpointStore?: typeof createCheckpointStore;
	sourceVersioning?: typeof createSourceVersioning;
	checkpointInvalidation?: typeof createCheckpointInvalidation;
}

export function createComponentAdapter(id = "current-full-contract"): ComponentAdapter {
	const capabilities = componentProfiles[id];
	if (!capabilities) throw new Error("ADAPTER_UNAVAILABLE");
	return Object.freeze({
		id, capabilities,
		...(capabilities.includes("toolReliability") ? { operationLedger: createOperationLedger, toolRuntime: createToolRuntime } : {}),
		...(capabilities.includes("observations") ? { observationStore: createObservationStore } : {}),
		...(capabilities.includes("contextBudget") ? { contextBudget: createContextBudget } : {}),
		...(capabilities.includes("versionedCheckpoint") ? { checkpointStore: createCheckpointStore, sourceVersioning: createSourceVersioning, checkpointInvalidation: createCheckpointInvalidation } : {}),
	});
}

export async function runWithAdapter(task: EvalTask, project: string, adapter: ComponentAdapter): Promise<TaskResult> {
	const missing = (task.definition.requiredCapabilities ?? []).filter((capability) => !adapter.capabilities.includes(capability));
	if (missing.length) return {
		status: "unsupported", reasonCode: "ADAPTER_CAPABILITY_UNAVAILABLE", checks: [],
		trace: [{ event: "capability.unavailable", data: { missing: missing.join(",") } }],
		metrics: { modelCalls: 0, duplicateSideEffects: 0, staleEvidenceUsed: 0, blockedDuplicateDispatches: 0, recoveries: 0 },
	};
	return task.run(project, adapter);
}
