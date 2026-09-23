import assert from "node:assert/strict";
import { aggregateBatch } from "../../evals/core/aggregate.js";
import { digest, sha256 } from "../../evals/core/io.js";
import { EvalValidationError } from "../../evals/core/schema.js";
import type { EvalManifest, RawRun, ResultIndex, TaskDefinition } from "../../evals/core/types.js";

const hash = "a".repeat(64);
const categories = ["CTX", "VER", "TOOL", "ISO"] as const;
const tasks: TaskDefinition[] = categories.map((category, index) => ({
	id: `${category}-${String(index + 1).padStart(3, "0")}`, version: 1, category, fixture: "fixtures/harness-novel",
	allowedActions: ["read"], faults: [`fault-${category.toLowerCase()}`], requiredChecks: [`${category.toLowerCase()}-contract`], unsupportedConditions: ["none"], rubric: null,
}));

function fixture(): { manifest: EvalManifest; index: ResultIndex; raws: Map<string, string> } {
	const runs = [1, 2, 3].flatMap((repetition) => tasks.map((task) => ({ runId: `${task.id}-r${repetition}`, taskId: task.id, repetition })));
	const codeFiles = { "eval.ts": hash }, fixtureFiles = { "README.md": hash };
	const manifest: EvalManifest = {
		schemaVersion: 1, kind: "offline-contract", batchId: "batch-test", createdAt: "2026-09-22T00:00:00.000Z",
		code: { commit: "d".repeat(40), dirty: false, files: codeFiles, sha256: digest(codeFiles) },
		environment: { node: "v24", npm: "11", platform: "win32", arch: "x64", piSdk: "0.63.1", lockSha256: hash },
		fixture: { files: fixtureFiles, sha256: digest(fixtureFiles) }, taskSet: { tasks, sha256: digest(tasks) },
		variants: [
			{ id: "b0-raw", availability: "not_implemented", features: { typed: false }, reason: "adapter absent" },
			{ id: "current", availability: "runnable", features: { typed: true }, reason: "synthetic contract" },
			{ id: "runnable-unselected", availability: "runnable", features: { typed: true }, reason: "not in this batch" },
		], selectedVariant: "current", budget: { modelCalls: 0, repetitions: 3, maxRuns: 12, taskTimeoutMs: 1000 }, runs,
	};
	const manifestSha256 = digest(manifest);
	const raws = new Map<string, string>();
	const index: ResultIndex = { schemaVersion: 1, batchId: manifest.batchId, manifestSha256, entries: [] };
	for (const run of runs) {
		const task = tasks.find((candidate) => candidate.id === run.taskId)!;
		const unavailable = task.category !== "CTX";
		const raw: RawRun = {
			schemaVersion: 1, batchId: manifest.batchId, manifestSha256, ...run, category: task.category, variant: manifest.selectedVariant!,
			status: "pass", reasonCode: "CONTRACT_PASS", checks: [{ id: task.requiredChecks[0]!, passed: true }],
			trace: [{ event: "contract.checked", data: { category: task.category, safe: true } }],
			metrics: { modelCalls: 0, duplicateSideEffects: 0, staleEvidenceUsed: 0, blockedDuplicateDispatches: task.category === "TOOL" ? 1 : 0, recoveries: task.category === "TOOL" ? 1 : 0 },
			usage: unavailable
				? { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, source: "unavailable" }
				: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 3, totalTokens: 22, source: "synthetic" },
		};
		const file = `raw/${run.runId}.json`, text = JSON.stringify(raw, null, 2) + "\n";
		raws.set(file, text); index.entries.push({ runId: run.runId, file, sha256: sha256(text) });
	}
	return { manifest, index, raws };
}

function v2Fixture(selectedVariants = ["current", "comparison"]): { manifest: EvalManifest; index: ResultIndex; raws: Map<string, string> } {
	const base = fixture();
	const v2Tasks: TaskDefinition[] = base.manifest.taskSet.tasks.map((task) => ({
		...task, version: 2, requiredCapabilities: task.category === "CTX" ? ["observations", "contextBudget"] : ["toolReliability"],
	}));
	const runs = selectedVariants.flatMap((variant) => [1, 2, 3].flatMap((repetition) => v2Tasks.map((task) => ({
		runId: `${variant}-${task.id}-r${repetition}`, taskId: task.id, repetition, variant,
	}))));
	const manifest: EvalManifest = {
		...base.manifest, schemaVersion: 2, taskSet: { tasks: v2Tasks, sha256: digest(v2Tasks) },
		variants: [
			{ id: "current", availability: "runnable", features: { observations: true, contextBudget: true, toolReliability: true }, reason: "current contract" },
			{ id: "comparison", availability: "runnable", features: { observations: false, contextBudget: false, toolReliability: true }, reason: "comparison contract" },
			{ id: "runnable-unselected", availability: "runnable", features: { observations: true }, reason: "not in this batch" },
			{ id: "future", availability: "not_implemented", features: { observations: null }, reason: "adapter absent" },
		],
		selectedVariant: undefined, selectedVariants, budget: { ...base.manifest.budget, maxRuns: runs.length }, runs,
	};
	delete (manifest as unknown as Record<string, unknown>).selectedVariant;
	const manifestSha256 = digest(manifest);
	const raws = new Map<string, string>();
	const index: ResultIndex = { schemaVersion: 1, batchId: manifest.batchId, manifestSha256, entries: [] };
	for (const run of runs) {
		const task = v2Tasks.find((candidate) => candidate.id === run.taskId)!;
		const unsupported = run.variant === "comparison" && task.category === "CTX";
		const raw: RawRun = {
			schemaVersion: 1, batchId: manifest.batchId, manifestSha256, ...run, category: task.category,
			status: unsupported ? "unsupported" : "pass", reasonCode: unsupported ? "CAPABILITY_UNSUPPORTED" : "CONTRACT_PASS",
			checks: unsupported ? [] : [{ id: task.requiredChecks[0]!, passed: true }],
			trace: [{ event: "contract.checked", data: { category: task.category, variant: run.variant } }],
			metrics: { modelCalls: 0, duplicateSideEffects: 0, staleEvidenceUsed: 0, blockedDuplicateDispatches: 0, recoveries: 0 },
			usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, source: "unavailable" },
		};
		const file = `raw/${run.runId}.json`, text = JSON.stringify(raw, null, 2) + "\n";
		raws.set(file, text); index.entries.push({ runId: run.runId, file, sha256: sha256(text) });
	}
	return { manifest, index, raws };
}

const errorCode = (code: string) => (error: unknown): boolean => error instanceof EvalValidationError && error.code === code && error.message === code;
const parsedRaw = (raws: Map<string, string>, file: string): RawRun => JSON.parse(raws.get(file)!);
const replaceRaw = (data: ReturnType<typeof fixture>, file: string, raw: unknown): void => {
	const text = JSON.stringify(raw, null, 2) + "\n"; data.raws.set(file, text);
	const entry = data.index.entries.find((candidate) => candidate.file === file)!; entry.sha256 = sha256(text);
};

export async function runAggregateTests(): Promise<number> {
	let count = 0;
	const test = (name: string, action: () => void): void => { action(); count++; void name; };

	test("aggregates planned denominator, unavailable and synthetic cache usage", () => {
		const data = fixture(), aggregate = aggregateBatch(data.manifest, data.index, data.raws);
		assert.equal(aggregate.runCount, 12); assert.equal(aggregate.deterministic, true); assert.deepEqual(aggregate.notRunVariants, ["b0-raw", "runnable-unselected"]);
		assert.equal(Object.hasOwn(aggregate, "taskGroups"), false);
		assert.equal(aggregate.groups.length, 4); assert.ok(aggregate.groups.every((group) => group.success.denominator === 3 && group.success.numerator === 3));
		assert.equal(aggregate.groups.find((group) => group.category === "CTX")?.usage.syntheticRuns, 3);
		assert.equal(aggregate.groups.find((group) => group.category === "CTX")?.usage.missingRuns, 0);
		assert.equal(aggregate.groups.find((group) => group.category === "VER")?.usage.missingRuns, 3);
		assert.equal(aggregate.groups.find((group) => group.category === "TOOL")?.metrics.blockedDuplicateDispatches, 3);
		assert.equal(aggregate.groups[0]?.usage.actualProviderRuns, 0);
	});

	test("canonical manifest hash ignores object key insertion order", () => {
		const data = fixture();
		const reordered = { ...data.manifest, code: { sha256: data.manifest.code.sha256, files: data.manifest.code.files, dirty: false, commit: data.manifest.code.commit } };
		assert.equal(digest(reordered), digest(data.manifest));
	});

	test("rejects manifest drift", () => { const data = fixture(); data.manifest.code.commit = "c".repeat(40); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("MANIFEST_HASH_MISMATCH")); });
	test("rejects forged provenance hash", () => { const data = fixture(); data.manifest.code.sha256 = hash; data.index.manifestSha256 = digest(data.manifest); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("CODE_PROVENANCE_HASH")); });
	test("rejects missing index entry", () => { const data = fixture(); data.index.entries.pop(); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("INDEX_RUN_SET_MISMATCH")); });
	test("rejects missing raw file", () => { const data = fixture(); data.raws.delete(data.index.entries[0]!.file); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("RAW_FILE_SET_MISMATCH")); });
	test("rejects extra raw file", () => { const data = fixture(); data.raws.set("raw/extra.json", "{}"); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("RAW_FILE_SET_MISMATCH")); });
	test("rejects raw byte hash mismatch", () => { const data = fixture(); const file = data.index.entries[0]!.file; data.raws.set(file, data.raws.get(file)! + " "); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("RAW_HASH_MISMATCH")); });
	test("rejects raw records over one MiB before parsing", () => { const data = fixture(), entry = data.index.entries[0]!, text = `{"padding":"${"x".repeat(1024 * 1024)}"}`; data.raws.set(entry.file, text); entry.sha256 = sha256(text); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("RAW_FILE_TOO_LARGE")); });
	test("rejects duplicate index run IDs", () => { const data = fixture(); data.index.entries[1]!.runId = data.index.entries[0]!.runId; assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("INDEX_RUN_DUPLICATE")); });
	test("rejects escaping and nested raw paths", () => { const data = fixture(); data.index.entries[0]!.file = "raw/../secret.json"; assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("INDEX_PATH_UNSAFE")); });
	test("rejects unknown strict fields", () => { const data = fixture(); const file = data.index.entries[0]!.file, raw = { ...parsedRaw(data.raws, file), payload: "sensitive" }; replaceRaw(data, file, raw); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("RAW_FIELDS")); });
	test("rejects false or absent required checks on pass", () => { const data = fixture(); const file = data.index.entries[0]!.file, raw = parsedRaw(data.raws, file); raw.checks[0]!.passed = false; replaceRaw(data, file, raw); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("PASS_CHECKS_INCOMPLETE")); });
	test("rejects pass with unsafe side effects", () => { const data = fixture(); const file = data.index.entries[0]!.file, raw = parsedRaw(data.raws, file); raw.metrics.duplicateSideEffects = 1; replaceRaw(data, file, raw); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("PASS_SAFETY_METRICS")); });
	test("rejects duplicate checks", () => { const data = fixture(); const file = data.index.entries[0]!.file, raw = parsedRaw(data.raws, file); raw.checks.push(raw.checks[0]!); replaceRaw(data, file, raw); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("RAW_CHECK_DUPLICATE")); });
	test("unknown status remains in denominator and does not become pass", () => { const data = fixture(); const file = data.index.entries[0]!.file, raw = parsedRaw(data.raws, file); raw.status = "unknown"; raw.reasonCode = "OUTCOME_UNKNOWN"; raw.checks = []; replaceRaw(data, file, raw); const aggregate = aggregateBatch(data.manifest, data.index, data.raws), group = aggregate.groups.find((candidate) => candidate.category === "CTX")!; assert.equal(group.statuses.unknown, 1); assert.equal(group.success.denominator, 3); assert.equal(group.success.numerator, 2); });
	test("unsupported status remains explicit", () => { const data = fixture(); const file = data.index.entries[0]!.file, raw = parsedRaw(data.raws, file); raw.status = "unsupported"; raw.reasonCode = "CONDITION_UNSUPPORTED"; raw.checks = []; replaceRaw(data, file, raw); const group = aggregateBatch(data.manifest, data.index, data.raws).groups.find((candidate) => candidate.category === "CTX")!; assert.equal(group.statuses.unsupported, 1); assert.equal(group.success.numerator, 2); });
	test("unavailable usage must be all null", () => { const data = fixture(); const file = data.index.entries.find((entry) => entry.runId.startsWith("VER"))!.file, raw = parsedRaw(data.raws, file); raw.usage.inputTokens = 0; replaceRaw(data, file, raw); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("USAGE_UNAVAILABLE_NON_NULL")); });
	test("synthetic cache tokens remain separately represented", () => { const data = fixture(); const file = data.index.entries[0]!.file, raw = parsedRaw(data.raws, file); assert.equal(raw.usage.inputTokens, 10); assert.equal(raw.usage.cacheReadTokens, 7); assert.equal(raw.usage.cacheWriteTokens, 3); assert.equal(raw.usage.totalTokens, 22); assert.equal(aggregateBatch(data.manifest, data.index, data.raws).groups.find((group) => group.category === "CTX")?.usage.syntheticRuns, 3); });
	test("partial batch is rejected rather than aggregated", () => { const data = fixture(); const removed = data.index.entries.pop()!; data.raws.delete(removed.file); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("INDEX_RUN_SET_MISMATCH")); });
	test("different repetition output marks deterministic false", () => { const data = fixture(); const file = data.index.entries.find((entry) => entry.runId === "CTX-001-r2")!.file, raw = parsedRaw(data.raws, file); raw.trace[0]!.data.safe = false; replaceRaw(data, file, raw); assert.equal(aggregateBatch(data.manifest, data.index, data.raws).deterministic, false); });
	test("identical reconstruction is deterministic", () => { const data = fixture(); assert.deepEqual(aggregateBatch(data.manifest, data.index, data.raws), aggregateBatch(structuredClone(data.manifest), structuredClone(data.index), new Map(data.raws))); });
	test("rejects model calls above offline budget", () => { const data = fixture(); const file = data.index.entries[0]!.file, raw = parsedRaw(data.raws, file); raw.metrics.modelCalls = 1; replaceRaw(data, file, raw); assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("MODEL_CALLS")); });

	test("v2 aggregates the exact variant task repetition matrix", () => {
		const data = v2Fixture(), aggregate = aggregateBatch(data.manifest, data.index, data.raws);
		assert.equal(aggregate.runCount, 24); assert.equal(aggregate.groups.length, 8); assert.equal(aggregate.deterministic, true);
		assert.equal(aggregate.taskGroups?.length, 8); assert.ok(aggregate.taskGroups?.every((group) => group.count === 3));
		assert.deepEqual(aggregate.taskGroups?.map((group) => `${group.variant}:${group.taskId}`), [
			"comparison:CTX-001", "comparison:ISO-004", "comparison:TOOL-003", "comparison:VER-002",
			"current:CTX-001", "current:ISO-004", "current:TOOL-003", "current:VER-002",
		]);
		assert.deepEqual(aggregate.notRunVariants, ["future", "runnable-unselected"]);
		assert.ok(aggregate.groups.every((group) => group.success.denominator === 3));
	});
	test("v2 unsupported runs remain in the selected variant denominator", () => {
		const aggregate = aggregateBatch(...Object.values(v2Fixture()) as [EvalManifest, ResultIndex, Map<string, string>]);
		const group = aggregate.groups.find((candidate) => candidate.variant === "comparison" && candidate.category === "CTX")!;
		assert.equal(group.count, 3); assert.equal(group.statuses.unsupported, 3); assert.deepEqual(group.success, { numerator: 0, denominator: 3 });
	});
	test("v2 rejects a missing matrix cell", () => {
		const data = v2Fixture(); data.manifest.runs.pop(); data.manifest.budget.maxRuns--;
		assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("RUN_PLAN_INCOMPLETE"));
	});
	test("v2 rejects a duplicate matrix cell even when run IDs differ", () => {
		const data = v2Fixture(), first = data.manifest.runs[0]!, second = data.manifest.runs[1]!;
		data.manifest.runs[1] = { ...first, runId: second.runId };
		assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("RUN_PLAN_DUPLICATE"));
	});
	test("v2 rejects raw output assigned to a different selected variant", () => {
		const data = v2Fixture(), file = data.index.entries[0]!.file, raw = parsedRaw(data.raws, file); raw.variant = "comparison"; replaceRaw(data, file, raw);
		assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("RAW_DEFINITION_MISMATCH"));
	});
	test("v2 tasks require a declared nonempty capability set", () => {
		const data = v2Fixture(); delete (data.manifest.taskSet.tasks[0] as unknown as Record<string, unknown>).requiredCapabilities;
		data.manifest.taskSet.sha256 = digest(data.manifest.taskSet.tasks); data.index.manifestSha256 = digest(data.manifest);
		assert.throws(() => aggregateBatch(data.manifest, data.index, data.raws), errorCode("TASK_FIELDS"));
	});
	test("v2 rejects duplicate and unknown capabilities", () => {
		const duplicate = v2Fixture(); duplicate.manifest.taskSet.tasks[0]!.requiredCapabilities = ["observations", "observations"];
		duplicate.manifest.taskSet.sha256 = digest(duplicate.manifest.taskSet.tasks); duplicate.index.manifestSha256 = digest(duplicate.manifest);
		assert.throws(() => aggregateBatch(duplicate.manifest, duplicate.index, duplicate.raws), errorCode("TASK_CAPABILITY_DUPLICATE"));
		const unknown = v2Fixture(); (unknown.manifest.taskSet.tasks[0]!.requiredCapabilities as string[]) = ["unknown"];
		unknown.manifest.taskSet.sha256 = digest(unknown.manifest.taskSet.tasks); unknown.index.manifestSha256 = digest(unknown.manifest);
		assert.throws(() => aggregateBatch(unknown.manifest, unknown.index, unknown.raws), errorCode("TASK_CAPABILITIES"));
	});
	test("v2 determinism is scoped to variant and task", () => {
		const data = v2Fixture(), file = data.index.entries.find((entry) => entry.runId === "comparison-VER-002-r1")!.file;
		const raw = parsedRaw(data.raws, file); raw.trace[0]!.data.variantSpecific = true; replaceRaw(data, file, raw);
		assert.equal(aggregateBatch(data.manifest, data.index, data.raws).deterministic, false);
		const clean = v2Fixture();
		assert.equal(aggregateBatch(clean.manifest, clean.index, clean.raws).deterministic, true);
	});
	test("v2 single selected variant reconstructs without v1 selectedVariant", () => {
		const data = v2Fixture(["current"]), rebuilt = aggregateBatch(structuredClone(data.manifest), structuredClone(data.index), new Map(data.raws));
		assert.equal(rebuilt.runCount, 12); assert.equal(rebuilt.groups.length, 4); assert.deepEqual(rebuilt.notRunVariants, ["comparison", "future", "runnable-unselected"]);
	});

	return count;
}
