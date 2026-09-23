import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { task } from "../../evals/long-horizon/task.js";
import { createComponentAdapter, runWithAdapter } from "../../evals/adapters/components.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export async function runLongHorizonTests(): Promise<number> {
	let count = 0;
	const parent = await mkdtemp(path.join(os.tmpdir(), "pi-phase5-long-horizon-tests-"));
	try {
		const project = path.join(parent, "public-fixture-current");
		await cp(path.resolve("fixtures/harness-novel"), project, { recursive: true, errorOnExist: true });
		const result = await runWithAdapter(task, project, createComponentAdapter("current-full-contract"));
		assert.equal(result.status, "pass"); count++;
		assert.equal(result.reasonCode, "VER_LONG_HORIZON_PASS"); count++;
		assert.ok(result.checks.every((check) => check.passed)); count++;
		assert.equal(result.metrics.modelCalls, 0); count++;
		assert.equal(result.metrics.duplicateSideEffects, 0); count++;
		assert.equal(result.metrics.staleEvidenceUsed, 0); count++;
		assert.equal(await readFile(path.join(project, "drafts", "eval", "long-horizon.md"), "utf8"), "public synthetic long-horizon result\n"); count++;
		const boundary = result.trace.find((entry) => entry.event === "synthetic_serialization_boundary");
		assert.deepEqual({ llmCompaction: boundary?.data.llmCompaction, nativePiLifecycle: boundary?.data.nativePiLifecycle }, { llmCompaction: false, nativePiLifecycle: false }); count++;
		assert.equal(result.trace.find((entry) => entry.event === "request_budget_checked")?.data.units, "estimated_tokens"); count++;

		const c3Project = path.join(parent, "public-fixture-c3");
		await cp(path.resolve("fixtures/harness-novel"), c3Project, { recursive: true, errorOnExist: true });
		const c3 = await runWithAdapter(task, c3Project, createComponentAdapter("c3-versioned-checkpoint"));
		assert.equal(c3.status, "pass"); count++;

		const mutatedProject = path.join(parent, "public-fixture-mutated-adapter");
		await cp(path.resolve("fixtures/harness-novel"), mutatedProject, { recursive: true, errorOnExist: true });
		const current = createComponentAdapter("current-full-contract");
		const mutated = { ...current, checkpointStore: undefined };
		const mutatedResult = await task.run(mutatedProject, mutated);
		assert.equal(mutatedResult.status, "fail"); count++;
		assert.equal(mutatedResult.reasonCode, "VER_LONG_HORIZON_RUNTIME_FAILURE"); count++;

		const checkpointPath = path.join(project, ".novel", "evals", "long-horizon-checkpoint.json");
		const validDiskCheckpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Record<string, unknown>;
		const corruptDiskCheckpoint = { ...validDiskCheckpoint, id: `cp_${"0".repeat(64)}` };
		await writeFile(checkpointPath, `${JSON.stringify(corruptDiskCheckpoint, null, 2)}\n`, "utf8");
		const factory = createComponentAdapter("current-full-contract").checkpointStore;
		assert.ok(factory); count++;
		const store = factory({ digest: sha });
		const corruptFromDisk = JSON.parse(await readFile(checkpointPath, "utf8"));
		assert.throws(
			() => store.parse(corruptFromDisk),
			(error: unknown) => !!error && typeof error === "object" && "kind" in error && (error as { kind: unknown }).kind === "checkpoint_integrity",
		); count++;
		assert.throws(() => store.latest([
			{ type: "custom", customType: "pi-desktop-task-checkpoint", data: validDiskCheckpoint },
			{ type: "custom", customType: "pi-desktop-task-checkpoint", data: corruptFromDisk },
		], { projectId: "fixture-project", sessionId: "session-long", role: "planning", runId: "resume", generation: 3 }), /Checkpoint integrity check failed/); count++;
		return count;
	} finally {
		const resolvedParent = path.resolve(parent);
		assert.equal(path.dirname(resolvedParent), path.resolve(os.tmpdir()));
		assert.ok(path.basename(resolvedParent).startsWith("pi-phase5-long-horizon-tests-"));
		await rm(resolvedParent, { recursive: true, force: true, maxRetries: 3 });
	}
}
