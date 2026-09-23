import { digest } from "./io.ts";
import type { Capability, EvalManifest, RawRun, ResultIndex, RunStatus, Scalar, TaskDefinition, Usage, VariantDefinition } from "./types.ts";

export class EvalValidationError extends Error {
	constructor(public readonly code: string) {
		super(code);
		this.name = "EvalValidationError";
	}
}

const fail = (code: string): never => { throw new EvalValidationError(code); };
const record = (value: unknown, code: string): Record<string, unknown> => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
	return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: readonly string[], code: string): void => {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
};
const string = (value: unknown, code: string, max = 256, pattern?: RegExp): string => {
	if (typeof value !== "string" || value.length < 1 || value.length > max || (pattern && !pattern.test(value))) fail(code);
	return value as string;
};
const integer = (value: unknown, code: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(code);
	return value as number;
};
const bool = (value: unknown, code: string): boolean => {
	if (typeof value !== "boolean") fail(code);
	return value as boolean;
};
const array = (value: unknown, code: string, max = 4096): unknown[] => {
	if (!Array.isArray(value) || value.length > max) fail(code);
	return value as unknown[];
};
const hex = (value: unknown, code: string): string => string(value, code, 64, /^[a-f0-9]{64}$/);
const identifier = (value: unknown, code: string): string => string(value, code, 128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const stringList = (value: unknown, code: string, max = 128): string[] => array(value, code, max).map((item) => string(item, code, 256));
const unique = (items: readonly string[], code: string): void => { if (new Set(items).size !== items.length) fail(code); };
const scalar = (value: unknown, code: string): Scalar => {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string" && value.length <= 4096) return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return fail(code);
};

const validateStringMap = (value: unknown, code: string, max = 4096): Record<string, string> => {
	const object = record(value, code);
	if (Object.keys(object).length < 1 || Object.keys(object).length > max) fail(code);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(object)) {
		const filename = string(key, code, 512);
		if (/[\\:\x00-\x1f]/.test(filename) || filename.startsWith("/") || filename.split("/").some((part) => part === "" || part === "." || part === "..")) fail(code);
		result[filename] = hex(entry, code);
	}
	return result;
};

const validateTask = (value: unknown): TaskDefinition => {
	const task = record(value, "TASK_SCHEMA");
	if (task.version !== 1 && task.version !== 2) fail("TASK_SCHEMA");
	exact(task, task.version === 1
		? ["id", "version", "category", "fixture", "allowedActions", "faults", "requiredChecks", "unsupportedConditions", "rubric"]
		: ["id", "version", "requiredCapabilities", "category", "fixture", "allowedActions", "faults", "requiredChecks", "unsupportedConditions", "rubric"], "TASK_FIELDS");
	if (task.fixture !== "fixtures/harness-novel" || task.rubric !== null) fail("TASK_SCHEMA");
	if (!["CTX", "VER", "TOOL", "ISO"].includes(task.category as string)) fail("TASK_CATEGORY");
	const allowedActions = stringList(task.allowedActions, "TASK_ACTIONS");
	const faults = stringList(task.faults, "TASK_FAULTS");
	const requiredChecks = stringList(task.requiredChecks, "TASK_CHECKS");
	const unsupportedConditions = stringList(task.unsupportedConditions, "TASK_UNSUPPORTED");
	unique(allowedActions, "TASK_ACTION_DUPLICATE"); unique(faults, "TASK_FAULT_DUPLICATE"); unique(requiredChecks, "TASK_CHECK_DUPLICATE"); unique(unsupportedConditions, "TASK_UNSUPPORTED_DUPLICATE");
	if (requiredChecks.length === 0) fail("TASK_CHECKS_EMPTY");
	let requiredCapabilities: Capability[] | undefined;
	if (task.version === 2) {
		const allowedCapabilities: Capability[] = ["toolReliability", "observations", "contextBudget", "versionedCheckpoint"];
		requiredCapabilities = stringList(task.requiredCapabilities, "TASK_CAPABILITIES", allowedCapabilities.length) as Capability[];
		if (requiredCapabilities.length === 0 || requiredCapabilities.some((capability) => !allowedCapabilities.includes(capability))) fail("TASK_CAPABILITIES");
		unique(requiredCapabilities, "TASK_CAPABILITY_DUPLICATE");
	}
	return { id: identifier(task.id, "TASK_ID"), version: task.version as 1 | 2, ...(requiredCapabilities ? { requiredCapabilities } : {}), category: task.category as TaskDefinition["category"], fixture: "fixtures/harness-novel", allowedActions, faults, requiredChecks, unsupportedConditions, rubric: null };
};

const validateVariant = (value: unknown): VariantDefinition => {
	const variant = record(value, "VARIANT_SCHEMA");
	exact(variant, ["id", "availability", "features", "reason"], "VARIANT_FIELDS");
	if (variant.availability !== "runnable" && variant.availability !== "not_implemented") fail("VARIANT_AVAILABILITY");
	const featuresObject = record(variant.features, "VARIANT_FEATURES");
	if (Object.keys(featuresObject).length > 128) fail("VARIANT_FEATURES");
	const features: Record<string, boolean | null> = {};
	for (const [key, feature] of Object.entries(featuresObject)) {
		if (feature !== null && typeof feature !== "boolean") fail("VARIANT_FEATURES");
		features[string(key, "VARIANT_FEATURE", 128)] = feature as boolean | null;
	}
	return { id: identifier(variant.id, "VARIANT_ID"), availability: variant.availability as VariantDefinition["availability"], features, reason: string(variant.reason, "VARIANT_REASON", 1024) };
};

export function validateManifest(value: unknown): EvalManifest {
	const manifest = record(value, "MANIFEST_SCHEMA");
	if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) fail("MANIFEST_SCHEMA");
	exact(manifest, manifest.schemaVersion === 1
		? ["schemaVersion", "kind", "batchId", "createdAt", "code", "environment", "fixture", "taskSet", "variants", "selectedVariant", "budget", "runs"]
		: ["schemaVersion", "kind", "batchId", "createdAt", "code", "environment", "fixture", "taskSet", "variants", "selectedVariants", "budget", "runs"], "MANIFEST_FIELDS");
	if (manifest.kind !== "offline-contract") fail("MANIFEST_SCHEMA");
	const code = record(manifest.code, "MANIFEST_CODE"); exact(code, ["commit", "dirty", "files", "sha256"], "MANIFEST_CODE_FIELDS");
	const environment = record(manifest.environment, "MANIFEST_ENV"); exact(environment, ["node", "npm", "platform", "arch", "piSdk", "lockSha256"], "MANIFEST_ENV_FIELDS");
	const fixture = record(manifest.fixture, "MANIFEST_FIXTURE"); exact(fixture, ["files", "sha256"], "MANIFEST_FIXTURE_FIELDS");
	const taskSet = record(manifest.taskSet, "MANIFEST_TASK_SET"); exact(taskSet, ["tasks", "sha256"], "MANIFEST_TASK_SET_FIELDS");
	const tasks = array(taskSet.tasks, "MANIFEST_TASKS", 128).map(validateTask);
	const taskIds = tasks.map((task) => task.id); unique(taskIds, "TASK_ID_DUPLICATE");
	if (new Set(tasks.map((task) => task.category)).size !== 4) fail("TASK_CATEGORIES_INCOMPLETE");
	const variants = array(manifest.variants, "MANIFEST_VARIANTS", 32).map(validateVariant);
	const variantIds = variants.map((variant) => variant.id); unique(variantIds, "VARIANT_ID_DUPLICATE");
	const selectedVariants = manifest.schemaVersion === 1
		? [identifier(manifest.selectedVariant, "SELECTED_VARIANT")]
		: stringList(manifest.selectedVariants, "SELECTED_VARIANTS", 32).map((value) => identifier(value, "SELECTED_VARIANT"));
	if (selectedVariants.length === 0) fail("SELECTED_VARIANTS_EMPTY");
	unique(selectedVariants, "SELECTED_VARIANT_DUPLICATE");
	if (selectedVariants.some((selected) => !variants.some((variant) => variant.id === selected && variant.availability === "runnable"))) fail("SELECTED_VARIANT_UNAVAILABLE");
	const budget = record(manifest.budget, "MANIFEST_BUDGET"); exact(budget, ["modelCalls", "repetitions", "maxRuns", "taskTimeoutMs"], "MANIFEST_BUDGET_FIELDS");
	if (budget.modelCalls !== 0 || budget.repetitions !== 3) fail("BUDGET_POLICY");
	const maxRuns = integer(budget.maxRuns, "BUDGET_MAX_RUNS", 1, 4096);
	const taskTimeoutMs = integer(budget.taskTimeoutMs, "BUDGET_TIMEOUT", 1, 3_600_000);
	const runs = array(manifest.runs, "MANIFEST_RUNS", 4096).map((entry) => {
		const run = record(entry, "RUN_PLAN_SCHEMA"); exact(run, manifest.schemaVersion === 1 ? ["runId", "taskId", "repetition"] : ["runId", "taskId", "repetition", "variant"], "RUN_PLAN_FIELDS");
		const taskId = identifier(run.taskId, "RUN_TASK_ID");
		if (!taskIds.includes(taskId)) fail("RUN_TASK_UNKNOWN");
		const variant = manifest.schemaVersion === 2 ? identifier(run.variant, "RUN_VARIANT") : undefined;
		if (variant !== undefined && !selectedVariants.includes(variant)) fail("RUN_VARIANT_UNSELECTED");
		return { runId: identifier(run.runId, "RUN_ID"), taskId, repetition: integer(run.repetition, "RUN_REPETITION", 1, 3), ...(variant ? { variant } : {}) };
	});
	if (runs.length > maxRuns) fail("BUDGET_RUNS_EXCEEDED");
	unique(runs.map((run) => run.runId), "RUN_ID_DUPLICATE");
	unique(runs.map((run) => `${run.variant ?? selectedVariants[0]}:${run.taskId}:${run.repetition}`), "RUN_PLAN_DUPLICATE");
	for (const selected of selectedVariants) for (const task of tasks) for (let repetition = 1; repetition <= 3; repetition++) {
		if (!runs.some((run) => (run.variant ?? selectedVariants[0]) === selected && run.taskId === task.id && run.repetition === repetition)) fail("RUN_PLAN_INCOMPLETE");
	}
	if (runs.length !== selectedVariants.length * tasks.length * 3) fail("RUN_PLAN_EXTRA");
	const createdAt = string(manifest.createdAt, "CREATED_AT", 64);
	let normalizedCreatedAt: string | null = null; try { normalizedCreatedAt = new Date(createdAt).toISOString(); } catch { fail("CREATED_AT"); }
	if (normalizedCreatedAt !== createdAt) fail("CREATED_AT");
	const codeFiles = validateStringMap(code.files, "CODE_FILES"), codeSha = hex(code.sha256, "CODE_SHA"); if (digest(codeFiles) !== codeSha) fail("CODE_PROVENANCE_HASH");
	const fixtureFiles = validateStringMap(fixture.files, "FIXTURE_FILES"), fixtureSha = hex(fixture.sha256, "FIXTURE_SHA"); if (digest(fixtureFiles) !== fixtureSha) fail("FIXTURE_PROVENANCE_HASH");
	const taskSetSha = hex(taskSet.sha256, "TASK_SET_SHA"); if (digest(tasks) !== taskSetSha) fail("TASK_SET_PROVENANCE_HASH");
	return {
		schemaVersion: manifest.schemaVersion as 1 | 2, kind: "offline-contract", batchId: identifier(manifest.batchId, "BATCH_ID"), createdAt,
		code: { commit: string(code.commit, "CODE_COMMIT", 64, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), dirty: bool(code.dirty, "CODE_DIRTY"), files: codeFiles, sha256: codeSha },
		environment: { node: string(environment.node, "ENV_NODE", 64), npm: string(environment.npm, "ENV_NPM", 64), platform: string(environment.platform, "ENV_PLATFORM", 64), arch: string(environment.arch, "ENV_ARCH", 64), piSdk: string(environment.piSdk, "ENV_PI_SDK", 64), lockSha256: hex(environment.lockSha256, "ENV_LOCK_SHA") },
		fixture: { files: fixtureFiles, sha256: fixtureSha }, taskSet: { tasks, sha256: taskSetSha }, variants,
		...(manifest.schemaVersion === 1 ? { selectedVariant: selectedVariants[0] } : { selectedVariants }),
		budget: { modelCalls: 0, repetitions: 3, maxRuns, taskTimeoutMs }, runs,
	};
}

export function validateIndex(value: unknown): ResultIndex {
	const index = record(value, "INDEX_SCHEMA"); exact(index, ["schemaVersion", "batchId", "manifestSha256", "entries"], "INDEX_FIELDS");
	if (index.schemaVersion !== 1) fail("INDEX_SCHEMA");
	const entries = array(index.entries, "INDEX_ENTRIES", 4096).map((value) => {
		const entry = record(value, "INDEX_ENTRY_SCHEMA"); exact(entry, ["runId", "file", "sha256"], "INDEX_ENTRY_FIELDS");
		const file = string(entry.file, "INDEX_FILE", 512);
		if (!/^raw\/[A-Za-z0-9_-]+\.json$/.test(file)) fail("INDEX_PATH_UNSAFE");
		return { runId: identifier(entry.runId, "INDEX_RUN_ID"), file, sha256: hex(entry.sha256, "INDEX_RAW_SHA") };
	});
	unique(entries.map((entry) => entry.runId), "INDEX_RUN_DUPLICATE"); unique(entries.map((entry) => entry.file), "INDEX_FILE_DUPLICATE");
	return { schemaVersion: 1, batchId: identifier(index.batchId, "INDEX_BATCH_ID"), manifestSha256: hex(index.manifestSha256, "INDEX_MANIFEST_SHA"), entries };
}

const validateUsage = (value: unknown): Usage => {
	const usage = record(value, "USAGE_SCHEMA"); exact(usage, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "source"], "USAGE_FIELDS");
	if (usage.source !== "unavailable" && usage.source !== "synthetic") fail("USAGE_SOURCE");
	const count = (entry: unknown): number | null => entry === null ? null : integer(entry, "USAGE_COUNT", 0);
	const result: Usage = { inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens), cacheReadTokens: count(usage.cacheReadTokens), cacheWriteTokens: count(usage.cacheWriteTokens), totalTokens: count(usage.totalTokens), source: usage.source as Usage["source"] };
	if (result.source === "unavailable" && Object.entries(result).some(([key, entry]) => key !== "source" && entry !== null)) fail("USAGE_UNAVAILABLE_NON_NULL");
	return result;
};

export function validateRawRun(value: unknown, task: TaskDefinition): RawRun {
	const raw = record(value, "RAW_SCHEMA");
	exact(raw, ["schemaVersion", "batchId", "manifestSha256", "runId", "taskId", "category", "variant", "repetition", "usage", "status", "reasonCode", "checks", "trace", "metrics"], "RAW_FIELDS");
	if (raw.schemaVersion !== 1 || !["pass", "fail", "blocked_user", "blocked_prerequisite", "no_progress", "cancelled", "invalid", "unsupported", "unknown"].includes(raw.status as string)) fail("RAW_SCHEMA");
	const checks = array(raw.checks, "RAW_CHECKS", 128).map((value) => { const check = record(value, "RAW_CHECK_SCHEMA"); exact(check, ["id", "passed"], "RAW_CHECK_FIELDS"); return { id: identifier(check.id, "RAW_CHECK_ID"), passed: bool(check.passed, "RAW_CHECK_PASSED") }; });
	unique(checks.map((check) => check.id), "RAW_CHECK_DUPLICATE");
	const trace = array(raw.trace, "RAW_TRACE", 256).map((value) => {
		const item = record(value, "RAW_TRACE_SCHEMA"); exact(item, ["event", "data"], "RAW_TRACE_FIELDS");
		const dataObject = record(item.data, "RAW_TRACE_DATA"); if (Object.keys(dataObject).length > 64) fail("RAW_TRACE_DATA");
		const data: Record<string, Scalar> = {}; for (const [key, entry] of Object.entries(dataObject)) data[string(key, "RAW_TRACE_KEY", 128)] = scalar(entry, "RAW_TRACE_SCALAR");
		return { event: identifier(item.event, "RAW_TRACE_EVENT"), data };
	});
	const metrics = record(raw.metrics, "RAW_METRICS"); exact(metrics, ["modelCalls", "duplicateSideEffects", "staleEvidenceUsed", "blockedDuplicateDispatches", "recoveries"], "RAW_METRIC_FIELDS");
	const normalizedMetrics = { modelCalls: integer(metrics.modelCalls, "MODEL_CALLS", 0, 0), duplicateSideEffects: integer(metrics.duplicateSideEffects, "DUPLICATE_SIDE_EFFECTS", 0, 1_000_000), staleEvidenceUsed: integer(metrics.staleEvidenceUsed, "STALE_EVIDENCE", 0, 1_000_000), blockedDuplicateDispatches: integer(metrics.blockedDuplicateDispatches, "BLOCKED_DUPLICATES", 0, 1_000_000), recoveries: integer(metrics.recoveries, "RECOVERIES", 0, 1_000_000) };
	const status = raw.status as RunStatus;
	const checkIds = checks.map((check) => check.id);
	if (status === "pass" && (task.requiredChecks.some((id) => !checkIds.includes(id)) || checks.some((check) => !check.passed))) fail("PASS_CHECKS_INCOMPLETE");
	if (status === "pass" && checkIds.some((id) => !task.requiredChecks.includes(id))) fail("PASS_CHECKS_EXTRA");
	if (status === "pass" && (normalizedMetrics.duplicateSideEffects !== 0 || normalizedMetrics.staleEvidenceUsed !== 0)) fail("PASS_SAFETY_METRICS");
	return { schemaVersion: 1, batchId: identifier(raw.batchId, "RAW_BATCH_ID"), manifestSha256: hex(raw.manifestSha256, "RAW_MANIFEST_SHA"), runId: identifier(raw.runId, "RAW_RUN_ID"), taskId: identifier(raw.taskId, "RAW_TASK_ID"), category: raw.category as RawRun["category"], variant: identifier(raw.variant, "RAW_VARIANT"), repetition: integer(raw.repetition, "RAW_REPETITION", 1, 3), usage: validateUsage(raw.usage), status, reasonCode: identifier(raw.reasonCode, "RAW_REASON"), checks, trace, metrics: normalizedMetrics };
}
