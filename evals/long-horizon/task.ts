import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationIntent } from "../../src/harness/operation-ledger.js";
import type { RunScope } from "../../src/harness/types.js";
import { createComponentAdapter, type ComponentAdapter } from "../adapters/components.js";
import type { EvalTask, TaskResult } from "../core/types.js";

const checkIds = [
	"source-read-and-observed",
	"request-budget-conserved",
	"checkpoint-serialized",
	"synthetic-compaction-boundary",
	"checkpoint-restored-from-file",
	"changed-source-detected",
	"stale-evidence-write-blocked",
	"source-reread-and-refreshed",
	"lost-ack-write-applied",
	"lost-ack-reconciled-without-duplicate",
	"cross-project-rejected",
	"cross-session-rejected",
] as const;

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const metrics = (duplicateSideEffects = 0, staleEvidenceUsed = 0, blockedDuplicateDispatches = 0, recoveries = 0): TaskResult["metrics"] => ({
	modelCalls: 0,
	duplicateSideEffects,
	staleEvidenceUsed,
	blockedDuplicateDispatches,
	recoveries,
});
const isStaleSource = (action: () => unknown): boolean => {
	try { action(); return false; }
	catch (error) { return !!error && typeof error === "object" && "kind" in error && (error as { kind: unknown }).kind === "stale_source"; }
};

/**
 * One deterministic, sustained-project VER scenario combining CTX/VER/TOOL/ISO
 * contracts. The boundary below is synthetic serialization only: it neither calls
 * an LLM summarizer nor claims to exercise Pi's native compaction lifecycle.
 */
export const task: EvalTask = {
	definition: {
		id: "VER-002-long-horizon",
		version: 2,
		requiredCapabilities: ["toolReliability", "observations", "contextBudget", "versionedCheckpoint"],
		category: "VER",
		fixture: "fixtures/harness-novel",
		allowedActions: [
			"read and modify canon/world.md in one isolated public fixture copy",
			"serialize and restore a production checkpoint under .novel/evals",
			"write a synthetic result under drafts/eval through the production operation ledger",
			"exercise production observation, source-version, invalidation, checkpoint, and ledger factories",
		],
		faults: [
			"source changes after a serialized checkpoint",
			"write succeeds but acknowledgement is lost",
			"checkpoint or observation is requested from another project or session",
		],
		requiredChecks: [...checkIds],
		unsupportedConditions: [
			"LLM-generated compaction or summary quality",
			"Pi native compaction lifecycle",
			"model-generated prose or whole-chapter semantic acceptance",
			"external side effects outside the isolated fixture copy",
		],
		rubric: null,
	},
	async run(project, adapter: ComponentAdapter = createComponentAdapter()): Promise<TaskResult> {
		const checks = checkIds.map((id) => ({ id, passed: false }));
		const set = (id: typeof checkIds[number], passed: boolean): void => { checks.find((item) => item.id === id)!.passed = passed; };
		const trace: TaskResult["trace"] = [];
		const relativeSource = "canon/world.md";
		const sourceFile = join(project, "canon", "world.md");
		const checkpointFile = join(project, ".novel", "evals", "long-horizon-checkpoint.json");
		const outputRelative = "drafts/eval/long-horizon.md";
		const outputFile = join(project, "drafts", "eval", "long-horizon.md");
		let staleEvidenceUsed = 0;
		let writes = 0;
		let sourceRecovery = false;
		let operationRecovery = false;
		try {
			const scope: RunScope = { projectId: "fixture-project", sessionId: "session-long", role: "planning", runId: "run-1", generation: 1 };
			if (!adapter.sourceVersioning || !adapter.checkpointInvalidation || !adapter.checkpointStore || !adapter.observationStore || !adapter.operationLedger || !adapter.contextBudget) {
				throw new Error("ADAPTER_FACTORY_UNAVAILABLE");
			}
			const versions = adapter.sourceVersioning();
			const invalidation = adapter.checkpointInvalidation();
			const observations = adapter.observationStore({ digest: sha });
			const ledger = adapter.operationLedger();
			const budget = adapter.contextBudget({ defaultContextWindow: 2048, defaultOutputReserve: 128, defaultSafetyMargin: 64 });

			const original = await readFile(sourceFile, "utf8");
			const originalHash = sha(original);
			const originalObservation = observations.put({
				scope, toolName: "read", toolCallId: "read-world-1", text: original,
				sources: [{ path: relativeSource, sha256: originalHash, authority: "canonical", temporal: "current" }],
			});
			set("source-read-and-observed", observations.read({ id: originalObservation.id, scope }).payload === original);
			trace.push({ event: "source_observed", data: { path: relativeSource, hash: originalHash, observationId: originalObservation.id } });
			const request = budget.planRequest({
				systemPrompt: "public synthetic sustained verification",
				tools: [{ name: "read" }, { name: "write" }],
				messages: [originalObservation.preview, "checkpoint summary", "verify current source"],
				messageKinds: ["observation_preview", "checkpoint", "new_evidence"],
			});
			const componentInput = request.ledger.system + request.ledger.tools + request.ledger.history + request.ledger.checkpoint
				+ request.ledger.observationPreview + request.ledger.newEvidence + request.ledger.serializationOverhead;
			const inputEstimate = "inputEstimate" in request.ledger ? request.ledger.inputEstimate : componentInput;
			set("request-budget-conserved", request.allowed && componentInput === inputEstimate
				&& request.ledger.total === inputEstimate + request.ledger.outputReserve + request.ledger.safetyMargin);
			trace.push({ event: "request_budget_checked", data: { allowed: request.allowed, estimatedUnits: inputEstimate, totalUnits: request.ledger.total, units: request.ledger.estimator.units } });

			const base = {
				scope,
				objective: "public synthetic long-horizon recovery chain",
				hardConstraints: ["use current source only", "do not duplicate writes"],
				evidence: [{ path: relativeSource, sha256: originalHash, authority: "canonical", temporal: "current" }],
				observationIds: [originalObservation.id], artifacts: [], unresolvedIssues: [],
				allowedNextActions: ["revalidate", "write after validation"], pendingOperations: [],
				budget: { readUsed: 1, outputUsed: 0, requestEstimate: null }, cause: "before_compact" as const,
			};
			await mkdir(join(project, ".novel", "evals"), { recursive: true });
			const serializedCheckpoint = await (async () => {
				const store = adapter.checkpointStore!({ digest: sha });
				const built = store.build(base);
				await writeFile(checkpointFile, `${JSON.stringify(built, null, 2)}\n`, "utf8");
				return { id: built.id, constraints: JSON.stringify(built.hardConstraints), evidence: JSON.stringify(built.evidence) };
			})();
			const serializedValue = JSON.parse(await readFile(checkpointFile, "utf8")) as Record<string, unknown>;
			set("checkpoint-serialized", serializedValue.id === serializedCheckpoint.id);

			// This is deliberately just an offline serialization boundary. It does not
			// invoke model summarization or the native Pi compaction lifecycle.
			set("synthetic-compaction-boundary", Object.hasOwn(serializedValue, "hardConstraints") && Object.hasOwn(serializedValue, "evidence"));
			trace.push({ event: "synthetic_serialization_boundary", data: { checkpointId: serializedCheckpoint.id, llmCompaction: false, nativePiLifecycle: false } });

			const changed = `${original}\n<!-- phase5 public synthetic long-horizon mutation -->\n`;
			await writeFile(sourceFile, changed, "utf8");
			const changedHash = sha(changed);
			// A fresh store restores only bytes read back from disk; no prior checkpoint
			// object or process-local checkpoint history is reused across this boundary.
			const restoredStore = adapter.checkpointStore({ digest: sha });
			const restored = restoredStore.parse(JSON.parse(await readFile(checkpointFile, "utf8")));
			set("checkpoint-restored-from-file", restored.id === serializedCheckpoint.id && restored.evidence[0]?.sha256 === originalHash
				&& JSON.stringify(restored.hardConstraints) === serializedCheckpoint.constraints && JSON.stringify(restored.evidence) === serializedCheckpoint.evidence);
			const stale = await versions.revalidate(restored.evidence, async () => ({ sha256: sha(await readFile(sourceFile, "utf8")), authority: "canonical", temporal: "current", eligible: true }));
			set("changed-source-detected", !stale.valid && stale.checks[0]?.status === "changed");
			const staleDecision = invalidation.evaluate({ scopeMatches: true, sources: stale.checks, pendingOperations: [] });
			if (staleDecision.allowedToWrite) staleEvidenceUsed += 1;
			set("stale-evidence-write-blocked", staleDecision.status === "needs_revalidation" && !staleDecision.allowedToWrite);
			trace.push({ event: "stale_write_gate", data: { path: relativeSource, status: staleDecision.status, allowedToWrite: staleDecision.allowedToWrite } });

			const refreshedText = await readFile(sourceFile, "utf8");
			const refreshedObservation = observations.put({
				scope: { ...scope, runId: "run-2", generation: 2 }, toolName: "read", toolCallId: "read-world-2", text: refreshedText,
				sources: [{ path: relativeSource, sha256: changedHash, authority: "canonical", temporal: "current" }],
			});
			const refreshed = restoredStore.build({
				...base, scope: { ...scope, runId: "run-2", generation: 2 },
				evidence: [{ ...base.evidence[0]!, sha256: changedHash }], observationIds: [refreshedObservation.id],
				cause: "refresh", parentId: restored.id, budget: { ...base.budget, readUsed: 2 },
			});
			await writeFile(checkpointFile, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");
			const freshValidation = await versions.revalidate(refreshed.evidence, async () => ({ sha256: sha(await readFile(sourceFile, "utf8")), authority: "canonical", temporal: "current", eligible: true }));
			const freshDecision = invalidation.evaluate({ scopeMatches: true, sources: freshValidation.checks, pendingOperations: [] });
			sourceRecovery = refreshed.parentId === restored.id && freshValidation.valid && freshDecision.allowedToWrite;
			set("source-reread-and-refreshed", sourceRecovery);

			await mkdir(join(project, "drafts", "eval"), { recursive: true });
			const outputBody = "public synthetic long-horizon result\n";
			const outputHash = sha(outputBody);
			const intent: OperationIntent = {
				scope: { ...scope, runId: "run-2", generation: 2 }, toolCallId: "long-write-1", toolName: "write",
				target: outputRelative, preHash: null, expectedPostHash: outputHash, argsDigest: sha("public-long-write"),
			};
			const first = ledger.prepare(intent, null);
			if (freshDecision.allowedToWrite && first.action === "dispatch") {
				ledger.markDispatched(first.operationId);
				writes += 1;
				await writeFile(outputFile, outputBody, "utf8");
				// Fault injection: the write happened, but no completion acknowledgement is recorded.
			}
			set("lost-ack-write-applied", writes === 1 && sha(await readFile(outputFile, "utf8")) === outputHash);
			const replay = ledger.prepare(intent, sha(await readFile(outputFile, "utf8")));
			if (replay.action === "dispatch") { writes += 1; await writeFile(outputFile, outputBody, "utf8"); }
			operationRecovery = replay.action === "satisfied" && replay.state === "completed" && writes === 1;
			set("lost-ack-reconciled-without-duplicate", operationRecovery);
			trace.push({ event: "lost_ack_reconciled", data: { path: outputRelative, replayAction: replay.action, writes } });

			set("cross-project-rejected", isStaleSource(() => observations.read({ id: refreshedObservation.id, scope: { ...scope, projectId: "other-project" } }))
				&& restoredStore.latest([{ type: "custom", customType: "pi-desktop-task-checkpoint", data: refreshed }], { ...scope, projectId: "other-project" }) === null);
			set("cross-session-rejected", isStaleSource(() => observations.read({ id: refreshedObservation.id, scope: { ...scope, sessionId: "other-session" } }))
				&& restoredStore.latest([{ type: "custom", customType: "pi-desktop-task-checkpoint", data: refreshed }], { ...scope, sessionId: "other-session" }) === null);
			trace.push({ event: "authority_boundaries_checked", data: { projectRejected: checks[10]!.passed, sessionRejected: checks[11]!.passed } });

			const passed = checks.every((check) => check.passed);
			return {
				status: passed ? "pass" : "fail", reasonCode: passed ? "VER_LONG_HORIZON_PASS" : "VER_LONG_HORIZON_CHECK_FAILED",
				checks, trace, metrics: metrics(Math.max(0, writes - 1), staleEvidenceUsed, operationRecovery ? 1 : 0, Number(sourceRecovery) + Number(operationRecovery)),
			};
		} catch (error) {
			return {
				status: "fail", reasonCode: "VER_LONG_HORIZON_RUNTIME_FAILURE", checks,
				trace: [...trace, { event: "long_horizon_failed", data: { stage: "runtime", reason: "production-contract-failed" } }],
				metrics: metrics(Math.max(0, writes - 1), staleEvidenceUsed),
			};
		}
	},
};
