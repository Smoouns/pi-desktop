import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationIntent } from "../../src/harness/operation-ledger.js";
import { createComponentAdapter } from "../adapters/components.js";
import type { EvalTask, TaskResult } from "../core/types.js";

const checkIds = ["lost-ack-write-applied", "lost-ack-reconciled", "lost-ack-not-duplicated", "cancel-after-dispatch-unknown", "cancelled-write-reconciled"] as const;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const baseMetrics = (duplicateSideEffects = 0, blockedDuplicateDispatches = 0, recoveries = 0): TaskResult["metrics"] => ({ modelCalls: 0, duplicateSideEffects, staleEvidenceUsed: 0, blockedDuplicateDispatches, recoveries });

export const task: EvalTask = {
	definition: {
		id: "TOOL-001-write-unknown-outcome", version: 2, requiredCapabilities: ["toolReliability"], category: "TOOL", fixture: "fixtures/harness-novel",
		allowedActions: ["create synthetic files under drafts/eval in isolated fixture copy", "hash post-state", "reconcile through production operation ledger"],
		faults: ["write succeeds but acknowledgement is lost", "cancellation occurs after dispatch"],
		requiredChecks: [...checkIds],
		unsupportedConditions: ["non-filesystem external side effects", "filesystem durability after host power loss", "concurrent writer process"],
		rubric: null,
	},
	async run(project, adapter = createComponentAdapter()): Promise<TaskResult> {
		const checks = checkIds.map((id) => ({ id, passed: false }));
		const set = (id: typeof checkIds[number], passed: boolean): void => { checks.find((item) => item.id === id)!.passed = passed; };
		let firstWrites = 0; let secondWrites = 0;
		try {
			const dir = join(project, "drafts", "eval"); await mkdir(dir, { recursive: true });
			const scope = { projectId: "fixture-project", sessionId: "session-tool", role: "drafting", runId: "run-1", generation: 1 };
			let dispatches = 0; const ledger = adapter.operationLedger!();
			const firstPath = join(dir, "lost-ack.md"); const firstBody = "public synthetic write\n"; const firstHash = sha(firstBody);
			const first: OperationIntent = { scope, toolCallId: "call-lost-ack", toolName: "write", target: "drafts/eval/lost-ack.md", preHash: null, expectedPostHash: firstHash, argsDigest: sha("lost-ack-args") };
			if (ledger.prepare(first, null).action === "dispatch") { ledger.markDispatched(first.toolCallId); dispatches += 1; firstWrites += 1; await writeFile(firstPath, firstBody, "utf8"); }
			set("lost-ack-write-applied", sha(await readFile(firstPath, "utf8")) === firstHash);
			const replay = ledger.prepare({ ...first, scope: { ...scope, runId: "run-2", generation: 2 }, toolCallId: "call-lost-ack-retry", preHash: firstHash }, firstHash);
			if (replay.action === "dispatch") { ledger.markDispatched(replay.operationId); dispatches += 1; firstWrites += 1; await writeFile(firstPath, firstBody, "utf8"); }
			set("lost-ack-reconciled", replay.action === "satisfied" && replay.state === "completed");
			set("lost-ack-not-duplicated", firstWrites === 1 && (await readFile(firstPath, "utf8")) === firstBody);
			const secondPath = join(dir, "cancelled.md"); const secondBody = "public synthetic cancelled write\n"; const secondHash = sha(secondBody);
			const second: OperationIntent = { scope: { ...scope, runId: "run-3", generation: 3 }, toolCallId: "call-cancel", toolName: "write", target: "drafts/eval/cancelled.md", preHash: null, expectedPostHash: secondHash, argsDigest: sha("cancel-args") };
			if (ledger.prepare(second, null).action === "dispatch") { ledger.markDispatched(second.toolCallId); dispatches += 1; secondWrites += 1; await writeFile(secondPath, secondBody, "utf8"); }
			const cancelled = ledger.cancel(second.toolCallId); set("cancel-after-dispatch-unknown", cancelled.state === "unknown" && cancelled.action === "blocked");
			const cancelReplay = ledger.prepare({ ...second, scope: { ...scope, runId: "run-4", generation: 4 }, toolCallId: "call-cancel-retry", preHash: secondHash }, secondHash);
			if (cancelReplay.action === "dispatch") { ledger.markDispatched(cancelReplay.operationId); dispatches += 1; secondWrites += 1; await writeFile(secondPath, secondBody, "utf8"); }
			set("cancelled-write-reconciled", cancelReplay.action === "satisfied" && secondWrites === 1 && (await readFile(secondPath, "utf8")) === secondBody);
			const passed = checks.every((item) => item.passed); const duplicate = Math.max(0, firstWrites - 1) + Math.max(0, secondWrites - 1);
			const blockedDuplicates = [replay, cancelReplay].filter((item) => item.action !== "dispatch").length;
			return { status: passed ? "pass" : "fail", reasonCode: passed ? "TOOL_RECONCILIATION_PASS" : "TOOL_CHECK_FAILED", checks, trace: [
				{ event: "lost_ack_reconciled", data: { path: "drafts/eval/lost-ack.md", hash: firstHash, dispatches: firstWrites, replayAction: replay.action } },
				{ event: "cancelled_dispatch_reconciled", data: { path: "drafts/eval/cancelled.md", hash: secondHash, dispatches: secondWrites, cancelState: cancelled.state, replayAction: cancelReplay.action } },
			], metrics: baseMetrics(duplicate, blockedDuplicates, [replay, cancelReplay].filter((item) => item.action === "satisfied").length) };
		} catch {
			const duplicate = Math.max(0, firstWrites - 1) + Math.max(0, secondWrites - 1);
			return { status: "fail", reasonCode: "TOOL_RUNTIME_FAILURE", checks, trace: [{ event: "tool_task_failed", data: { stage: "filesystem-reconciliation" } }], metrics: baseMetrics(duplicate) };
		}
	},
};
