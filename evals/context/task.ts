import { access } from "node:fs/promises";
import { join } from "node:path";
import { createComponentAdapter } from "../adapters/components.js";
import type { EvalTask, TaskResult } from "../core/types.js";

const checkIds = ["fixture-present", "ledger-conserves", "overflow-blocked", "invalid-blocked", "media-blocked"] as const;
const metrics = (): TaskResult["metrics"] => ({ modelCalls: 0, duplicateSideEffects: 0, staleEvidenceUsed: 0, blockedDuplicateDispatches: 0, recoveries: 0 });

export const task: EvalTask = {
	definition: {
		id: "CTX-001-budget-fail-closed", version: 2, requiredCapabilities: ["contextBudget"], category: "CTX", fixture: "fixtures/harness-novel",
		allowedActions: ["read public fixture metadata", "evaluate synthetic text payloads in memory"],
		faults: ["request exceeds context window", "invalid message-kind cardinality", "unsupported inline media"],
		requiredChecks: [...checkIds],
		unsupportedConditions: ["provider-tokenizer parity", "audio/video payload accounting", "real provider usage or cache accounting"],
		rubric: null,
	},
	async run(project, adapter = createComponentAdapter()): Promise<TaskResult> {
		const checks = checkIds.map((id) => ({ id, passed: false }));
		const set = (id: typeof checkIds[number], passed: boolean): void => { checks.find((item) => item.id === id)!.passed = passed; };
		try {
			await access(join(project, "README.md")); set("fixture-present", true);
			const budget = adapter.contextBudget!({ defaultContextWindow: 512, defaultOutputReserve: 32, defaultSafetyMargin: 16 });
			const normal = budget.planRequest({
				systemPrompt: "public synthetic system", tools: [{ name: "read" }],
				messages: ["history", "checkpoint", "preview", "evidence"],
				messageKinds: ["history", "checkpoint", "observation_preview", "new_evidence"],
			});
			const l = normal.ledger;
			const inputUnits = l.system + l.tools + l.history + l.checkpoint + l.observationPreview + l.newEvidence + l.serializationOverhead;
			set("ledger-conserves", normal.allowed && l.total === inputUnits + l.outputReserve + l.safetyMargin
				&& (!("inputEstimate" in l) || l.inputEstimate === inputUnits) && l.available === Math.max(0, l.limit - l.total));
			const overflow = budget.planRequest({ systemPrompt: "s", tools: [], messages: ["中".repeat(800)], contextWindow: 64, outputReserve: 8, safetyMargin: 8 });
			set("overflow-blocked", !overflow.allowed && overflow.reason === "model_input_budget_exceeded" && overflow.ledger.total > overflow.ledger.limit);
			const invalid = budget.planRequest({ systemPrompt: "s", tools: [], messages: ["one"], messageKinds: [] });
			set("invalid-blocked", !invalid.allowed && invalid.reason === "invalid_payload");
			const media = budget.checkPayload({ type: "image_url", image_url: "data:image/png;base64,public-synthetic" }, 512, 8, 8);
			set("media-blocked", !media.allowed && media.reason === "unsupported_media" && media.unsupportedMedia.length === 1);
			const passed = checks.every((item) => item.passed);
			return { status: passed ? "pass" : "fail", reasonCode: passed ? "CTX_CONTRACT_PASS" : "CTX_CHECK_FAILED", checks, trace: [
				{ event: "context_budget_evaluated", data: { allowed: normal.allowed, inputUnits, units: l.estimator.units, total: l.total, limit: l.limit } },
				{ event: "context_faults_evaluated", data: { overflow: !overflow.allowed, invalid: !invalid.allowed, media: !media.allowed } },
			], metrics: metrics() };
		} catch {
			return { status: "fail", reasonCode: "CTX_RUNTIME_FAILURE", checks, trace: [{ event: "context_task_failed", data: { stage: "offline-contract" } }], metrics: metrics() };
		}
	},
};
