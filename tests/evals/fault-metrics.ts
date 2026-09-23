import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createComponentAdapter, type ComponentAdapter } from "../../evals/adapters/components.js";
import { task as toolTask } from "../../evals/tool-recovery/task.js";
import { task as versioningTask } from "../../evals/versioning/task.js";
import { assertInside } from "../../evals/core/io.js";

const fixture = path.resolve("fixtures/harness-novel");
const testRoot = path.resolve("artifacts/harness");

async function cleanup(parent: string): Promise<void> {
	await assertInside(testRoot, parent);
	assert.ok(path.basename(parent).startsWith(".fault-metrics-"), "UNSAFE_METRIC_TEST_CLEANUP");
	await rm(parent, { recursive: true, force: true, maxRetries: 3 });
}

async function isolated(name: string): Promise<{ parent: string; project: string }> {
	const parent = await mkdtemp(path.join(path.resolve("artifacts/harness"), `.fault-metrics-${name}-`));
	const project = path.join(parent, "project");
	await cp(fixture, project, { recursive: true, errorOnExist: true });
	return { parent, project };
}

export async function runFaultMetricTests(): Promise<number> {
	let count = 0;
	const tool = await isolated("tool");
	try {
		const current = createComponentAdapter();
		const adapter: ComponentAdapter = { ...current, operationLedger: (() => {
			const ledger = current.operationLedger!();
			let preparations = 0;
			return { ...ledger, prepare(...args: Parameters<typeof ledger.prepare>) {
				const result = ledger.prepare(...args); preparations++;
				// Force the lost-ack replay to dispatch, producing a real duplicate write.
				if (preparations === 2) return { ...result, action: "dispatch" as const };
				// Fail only after the duplicate was written.
				if (preparations === 3) throw new Error("injected-after-duplicate");
				return result;
			} };
		}) as typeof current.operationLedger };
		const result = await toolTask.run(tool.project, adapter);
		assert.equal(result.reasonCode, "TOOL_RUNTIME_FAILURE");
		assert.equal(result.metrics.duplicateSideEffects, 1);
		assert.equal(await readFile(path.join(tool.project, "drafts/eval/lost-ack.md"), "utf8"), "public synthetic write\n");
		count++;
	} finally { await cleanup(tool.parent); }

	const versioning = await isolated("versioning");
	try {
		const current = createComponentAdapter();
		const adapter: ComponentAdapter = { ...current, checkpointInvalidation: (() => {
			const invalidation = current.checkpointInvalidation!();
			let evaluations = 0;
			return { evaluate(...args: Parameters<typeof invalidation.evaluate>) {
				evaluations++;
				if (evaluations === 1) return { ...invalidation.evaluate(...args), status: "ready" as const, allowedToWrite: true };
				throw new Error("injected-after-stale-gate");
			} };
		}) as typeof current.checkpointInvalidation };
		const result = await versioningTask.run(versioning.project, adapter);
		assert.equal(result.reasonCode, "VER_RUNTIME_FAILURE");
		assert.equal(result.metrics.staleEvidenceUsed, 1);
		assert.match(await readFile(path.join(versioning.project, "canon/world.md"), "utf8"), /phase5 public synthetic mutation/);
		count++;
	} finally { await cleanup(versioning.parent); }

	const positive = await isolated("positive");
	try {
		const toolResult = await toolTask.run(positive.project, createComponentAdapter());
		assert.equal(toolResult.status, "pass"); assert.equal(toolResult.metrics.duplicateSideEffects, 0);
		const verResult = await versioningTask.run(positive.project, createComponentAdapter());
		assert.equal(verResult.status, "pass"); assert.equal(verResult.metrics.staleEvidenceUsed, 0);
		count++;
	} finally { await cleanup(positive.parent); }
	return count;
}
