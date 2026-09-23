import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createComponentAdapter } from "../adapters/components.js";
import type { RunScope } from "../../src/harness/types.js";
import type { EvalTask, TaskResult } from "../core/types.js";

const checkIds = ["checkpoint-built", "changed-source-detected", "stale-write-blocked", "refreshed-checkpoint-selected", "fresh-write-allowed"] as const;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const metrics = (staleEvidenceUsed = 0, recoveries = 0): TaskResult["metrics"] => ({ modelCalls: 0, duplicateSideEffects: 0, staleEvidenceUsed, blockedDuplicateDispatches: 0, recoveries });

export const task: EvalTask = {
	definition: {
		id: "VER-001-source-invalidation-recovery", version: 2, requiredCapabilities: ["versionedCheckpoint"], category: "VER", fixture: "fixtures/harness-novel",
		allowedActions: ["read and modify canon/world.md in isolated fixture copy", "build and select production checkpoints", "revalidate source hashes"],
		faults: ["checkpoint source changes after capture", "old checkpoint remains in history"],
		requiredChecks: [...checkIds],
		unsupportedConditions: ["semantic truth verification", "external filesystem changes outside isolated project", "provider-generated evidence"],
		rubric: null,
	},
	async run(project, adapter = createComponentAdapter()): Promise<TaskResult> {
		const checks = checkIds.map((id) => ({ id, passed: false }));
		const set = (id: typeof checkIds[number], passed: boolean): void => { checks.find((item) => item.id === id)!.passed = passed; };
		const relative = "canon/world.md"; const file = join(project, "canon", "world.md");
		let staleEvidenceUsed = 0;
		try {
			const original = await readFile(file, "utf8"); const before = sha(original);
			const scope: RunScope = { projectId: "fixture-project", sessionId: "session-ver", role: "planning", runId: "run-1", generation: 1 };
			const versions = adapter.sourceVersioning!(); const invalidation = adapter.checkpointInvalidation!(); const store = adapter.checkpointStore!({ digest: sha });
			const base = { scope, objective: "validate public synthetic source", hardConstraints: ["use current source only"], evidence: [{ path: relative, sha256: before, authority: "canonical", temporal: "current" }], observationIds: [], artifacts: [], unresolvedIssues: [], allowedNextActions: ["revalidate"], pendingOperations: [], budget: { readUsed: 0, outputUsed: 0, requestEstimate: null }, cause: "manual" as const };
			const oldCheckpoint = store.build(base); set("checkpoint-built", store.parse(oldCheckpoint).id === oldCheckpoint.id);
			const changedText = `${original}\n<!-- phase5 public synthetic mutation -->\n`; await writeFile(file, changedText, "utf8"); const after = sha(changedText);
			const stale = await versions.revalidate(oldCheckpoint.evidence, async () => ({ sha256: sha(await readFile(file, "utf8")), authority: "canonical", temporal: "current", eligible: true }));
			set("changed-source-detected", !stale.valid && stale.checks[0]?.status === "changed");
			const blocked = invalidation.evaluate({ scopeMatches: true, sources: stale.checks, pendingOperations: [] });
			if (blocked.allowedToWrite) staleEvidenceUsed = 1;
			set("stale-write-blocked", blocked.status === "needs_revalidation" && !blocked.allowedToWrite);
			const freshCheckpoint = store.build({ ...base, scope: { ...scope, runId: "run-2", generation: 2 }, evidence: [{ ...base.evidence[0]!, sha256: after }], cause: "refresh", parentId: oldCheckpoint.id });
			const entries = [oldCheckpoint, freshCheckpoint].map((data) => ({ type: "custom", customType: "pi-desktop-task-checkpoint", data }));
			set("refreshed-checkpoint-selected", store.latest(entries, { ...scope, runId: "resume", generation: 3 })?.id === freshCheckpoint.id);
			const fresh = await versions.revalidate(freshCheckpoint.evidence, async () => ({ sha256: sha(await readFile(file, "utf8")), authority: "canonical", temporal: "current", eligible: true }));
			const ready = invalidation.evaluate({ scopeMatches: true, sources: fresh.checks, pendingOperations: [] });
			set("fresh-write-allowed", fresh.valid && ready.status === "ready" && ready.allowedToWrite);
			const passed = checks.every((item) => item.passed);
			return { status: passed ? "pass" : "fail", reasonCode: passed ? "VER_RECOVERY_PASS" : "VER_CHECK_FAILED", checks, trace: [
				{ event: "source_changed", data: { path: relative, beforeHash: before, afterHash: after, staleStatus: stale.checks[0]?.status ?? "missing" } },
				{ event: "checkpoint_refreshed", data: { parentLinked: freshCheckpoint.parentId === oldCheckpoint.id, generation: freshCheckpoint.scope.generation, ready: ready.allowedToWrite } },
			], metrics: metrics(staleEvidenceUsed, ready.allowedToWrite ? 1 : 0) };
		} catch {
			return { status: "fail", reasonCode: "VER_RUNTIME_FAILURE", checks, trace: [{ event: "version_task_failed", data: { path: relative } }], metrics: metrics(staleEvidenceUsed) };
		}
	},
};
