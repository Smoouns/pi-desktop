import { digest, sha256 } from "./io.ts";
import { EvalValidationError, validateIndex, validateManifest, validateRawRun } from "./schema.ts";
import type { AggregateGroup, EvalAggregate, RawRun, RunStatus } from "./types.ts";

const fail = (code: string): never => { throw new EvalValidationError(code); };
const statuses: RunStatus[] = ["pass", "fail", "blocked_user", "blocked_prerequisite", "no_progress", "cancelled", "invalid", "unsupported", "unknown"];
const deterministicPayload = (run: RawRun): unknown => ({ status: run.status, reasonCode: run.reasonCode, checks: run.checks, trace: run.trace, metrics: run.metrics, usage: run.usage });
const aggregateItems = (items: RawRun[]): AggregateGroup => {
	items.sort((left, right) => left.runId.localeCompare(right.runId));
	const statusCounts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<RunStatus, number>;
	for (const item of items) statusCounts[item.status]++;
	return {
		variant: items[0]!.variant, category: items[0]!.category, runIds: items.map((item) => item.runId), count: items.length,
		statuses: statusCounts, success: { numerator: statusCounts.pass, denominator: items.length },
		usage: { missingRuns: items.filter((item) => item.usage.source === "unavailable").length, syntheticRuns: items.filter((item) => item.usage.source === "synthetic").length, actualProviderRuns: 0 as const },
		metrics: { modelCalls: 0, duplicateSideEffects: items.reduce((sum, item) => sum + item.metrics.duplicateSideEffects, 0), staleEvidenceUsed: items.reduce((sum, item) => sum + item.metrics.staleEvidenceUsed, 0), blockedDuplicateDispatches: items.reduce((sum, item) => sum + item.metrics.blockedDuplicateDispatches, 0), recoveries: items.reduce((sum, item) => sum + item.metrics.recoveries, 0) },
	};
};

export function aggregateBatch(manifestValue: unknown, indexValue: unknown, rawFiles: ReadonlyMap<string, string>): EvalAggregate {
	const manifest = validateManifest(manifestValue);
	const index = validateIndex(indexValue);
	const manifestSha256 = digest(manifestValue);
	if (index.batchId !== manifest.batchId) fail("INDEX_BATCH_MISMATCH");
	if (index.manifestSha256 !== manifestSha256) fail("MANIFEST_HASH_MISMATCH");
	if (index.entries.length !== manifest.runs.length) fail("INDEX_RUN_SET_MISMATCH");
	if (rawFiles.size !== index.entries.length) fail("RAW_FILE_SET_MISMATCH");
	const planned = new Map(manifest.runs.map((run) => [run.runId, run]));
	const tasks = new Map(manifest.taskSet.tasks.map((task) => [task.id, task]));
	const runs: RawRun[] = [];
	for (const entry of index.entries) {
		const plan = planned.get(entry.runId) ?? fail("INDEX_RUN_UNPLANNED");
		const text = rawFiles.get(entry.file) ?? fail("RAW_FILE_MISSING");
		if (new TextEncoder().encode(text).byteLength > 1024 * 1024) fail("RAW_FILE_TOO_LARGE");
		if (sha256(text) !== entry.sha256) fail("RAW_HASH_MISMATCH");
		let decoded: unknown; try { decoded = JSON.parse(text); } catch { fail("RAW_JSON_INVALID"); }
		const task = tasks.get(plan.taskId) ?? fail("RUN_TASK_UNKNOWN");
		const run = validateRawRun(decoded, task);
		if (run.batchId !== manifest.batchId || run.manifestSha256 !== manifestSha256) fail("RAW_MANIFEST_MISMATCH");
		if (run.runId !== plan.runId || run.taskId !== plan.taskId || run.repetition !== plan.repetition) fail("RAW_PLAN_MISMATCH");
		const plannedVariant = manifest.schemaVersion === 1 ? manifest.selectedVariant! : plan.variant!;
		if (run.category !== task.category || run.variant !== plannedVariant) fail("RAW_DEFINITION_MISMATCH");
		runs.push(run);
	}
	for (const key of rawFiles.keys()) if (!index.entries.some((entry) => entry.file === key)) fail("RAW_FILE_EXTRA");

	let deterministic = true;
	for (const variant of manifest.schemaVersion === 1 ? [manifest.selectedVariant!] : manifest.selectedVariants!) {
		for (const task of manifest.taskSet.tasks) {
			const samples = runs.filter((run) => run.variant === variant && run.taskId === task.id).map(deterministicPayload);
			if (new Set(samples.map((sample) => digest(sample))).size !== 1) deterministic = false;
		}
	}

	const grouped = new Map<string, RawRun[]>();
	for (const run of runs) { const key = `${run.variant}\0${run.category}`; grouped.set(key, [...(grouped.get(key) ?? []), run]); }
	const groups: AggregateGroup[] = [...grouped.values()].map(aggregateItems).sort((left, right) => left.variant.localeCompare(right.variant) || left.category.localeCompare(right.category));
	let taskGroups: Array<AggregateGroup & { taskId: string }> | undefined;
	if (manifest.schemaVersion === 2) {
		const taskGrouped = new Map<string, RawRun[]>();
		for (const run of runs) { const key = `${run.variant}\0${run.taskId}`; taskGrouped.set(key, [...(taskGrouped.get(key) ?? []), run]); }
		taskGroups = [...taskGrouped.values()].map((items) => ({ ...aggregateItems(items), taskId: items[0]!.taskId }))
			.sort((left, right) => left.variant.localeCompare(right.variant) || left.taskId.localeCompare(right.taskId));
	}
	const selected = new Set(manifest.schemaVersion === 1 ? [manifest.selectedVariant!] : manifest.selectedVariants!);
	return { schemaVersion: 1, batchId: manifest.batchId, manifestSha256, codeCommit: manifest.code.commit, deterministic, runCount: runs.length, groups, ...(taskGroups ? { taskGroups } : {}), notRunVariants: manifest.variants.filter((variant) => !selected.has(variant.id)).map((variant) => variant.id).sort(), inference: "contract-only; insufficient for model quality, token savings or ablation claims" };
}
