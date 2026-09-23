import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PILOT_LIMITS, PILOT_MODEL, PILOT_PROBE_CONTENT, PILOT_PROBE_PATH, PILOT_TASK_IDS, type PilotTaskId } from "./policy.js";
import type { ProviderUsage } from "./usage.js";

export class PilotRecordError extends Error {
	constructor(public readonly code: string) { super(code); this.name = "PilotRecordError"; }
}
const fail = (code: string): never => { throw new PilotRecordError(code); };
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const hex = (value: unknown, code: string): string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : fail(code);
const text = (value: unknown, code: string, max = 256): string => typeof value === "string" && value.length > 0 && value.length <= max ? value : fail(code);
const identifier = (value: unknown, code: string): string => { const result = text(value, code, 128); return /^[A-Z0-9][A-Z0-9._:-]*$/i.test(result) ? result : fail(code); };
const integer = (value: unknown, code: string): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fail(code);
const record = (value: unknown, code: string): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail(code);
const exact = (value: Record<string, unknown>, keys: readonly string[], code: string): void => {
	const actual = Object.keys(value).sort(), expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
};
const safePath = (value: unknown, code: string): string => {
	const result = text(value, code, 512);
	if (result.startsWith("/") || /^[A-Za-z]:/.test(result) || /[\\\0-\x1f]/.test(result) || result.split("/").some((part) => !part || part === "." || part === "..")) fail(code);
	return result;
};
const hashMap = (value: unknown, code: string): Record<string, string> => {
	const source = record(value, code), result: Record<string, string> = {};
	if (Object.keys(source).length < 1 || Object.keys(source).length > 4096) fail(code);
	for (const [key, hash] of Object.entries(source)) result[safePath(key, code)] = hex(hash, code);
	return result;
};
const digestMap = (map: Record<string, string>): string => sha256(JSON.stringify(Object.entries(map).sort(([a], [b]) => a.localeCompare(b))));
const PILOT_SETTINGS_CONTENT = JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false }, null, 2) + "\n";
const expectedPassChanges = (taskId: PilotTaskId): Array<{ path: string; beforeSha256: null; afterSha256: string }> => [
	{ path: ".pi/settings.json", beforeSha256: null, afterSha256: sha256(PILOT_SETTINGS_CONTENT) },
	...(taskId === "P5P-WRITE-001" ? [{ path: PILOT_PROBE_PATH, beforeSha256: null, afterSha256: sha256(PILOT_PROBE_CONTENT) }] : []),
];

export type PilotManifest = {
	schemaVersion: 1; kind: "pilot-rehearsal"; batchId: string; createdAt: string;
	model: typeof PILOT_MODEL & { outputField: "max_tokens" | "max_completion_tokens" };
	code: { commit: string; files: Record<string, string>; sha256: string };
	fixture: { files: Record<string, string>; sha256: string };
	policySha256: string; promptSha256: Record<PilotTaskId, string>; toolsSha256: Record<PilotTaskId, string>;
	taskIds: [...typeof PILOT_TASK_IDS]; authorization: "offline-only";
	limits: typeof PILOT_LIMITS; settings: { retry: false; compaction: false; sessionTitle: false };
};

export type RehearsalManifestInput = Pick<PilotManifest, "batchId" | "createdAt" | "code" | "fixture" | "policySha256" | "promptSha256" | "toolsSha256"> & {
	outputField: "max_tokens" | "max_completion_tokens";
};

export function createRehearsalManifest(input: RehearsalManifestInput): PilotManifest {
	return validatePilotManifest({ schemaVersion: 1, kind: "pilot-rehearsal", batchId: input.batchId, createdAt: input.createdAt,
		model: { ...PILOT_MODEL, outputField: input.outputField }, code: input.code, fixture: input.fixture,
		policySha256: input.policySha256, promptSha256: input.promptSha256, toolsSha256: input.toolsSha256,
		taskIds: [...PILOT_TASK_IDS], authorization: "offline-only", limits: { ...PILOT_LIMITS },
		settings: { retry: false, compaction: false, sessionTitle: false } });
}

export type PilotRequestRecord = {
	schemaVersion: 1; ordinal: number; taskId: PilotTaskId; invocationId: number;
	status: "dispatched" | "complete" | "unknown"; reasonCode: string | null;
	inputEstimate: number; inputBytes: number; outputReserved: 2048; requestSha256: string;
	usageSource: "synthetic" | "unavailable"; usage: ProviderUsage | null;
};

export type PilotRunRecord = {
	schemaVersion: 1; batchId: string; manifestSha256: string; taskId: PilotTaskId;
	status: "pass" | "fail" | "blocked" | "unknown"; reasonCode: string;
	checks: Array<{ id: string; passed: boolean }>;
	realHttpDispatches: 0; simulatedHttpDispatches: number; requests: PilotRequestRecord[];
	usage: { source: "synthetic" | "unavailable"; providerActual: false; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
	fileChanges: Array<{ path: string; beforeSha256: string | null; afterSha256: string | null }>;
	safeSdkChecks: Array<{ id: string; passed: boolean }>;
};

export type PilotResultIndex = { schemaVersion: 1; batchId: string; manifestSha256: string; entries: Array<{ taskId: PilotTaskId; file: string; sha256: string }> };
export type PilotAggregate = { schemaVersion: 1; kind: "pilot-rehearsal-aggregate"; batchId: string; planned: 2; pass: number; fail: number; blocked: number; unknown: number; realHttpDispatches: 0; simulatedHttpDispatches: number; providerActualRuns: 0; syntheticUsageRuns: number; unavailableUsageRuns: number };

export function validatePilotManifest(value: unknown): PilotManifest {
	const root = record(value, "PILOT_MANIFEST_SCHEMA");
	exact(root, ["schemaVersion", "kind", "batchId", "createdAt", "model", "code", "fixture", "policySha256", "promptSha256", "toolsSha256", "taskIds", "authorization", "limits", "settings"], "PILOT_MANIFEST_FIELDS");
	if (root.schemaVersion !== 1 || root.kind !== "pilot-rehearsal" || root.authorization !== "offline-only") fail("PILOT_MANIFEST_SCHEMA");
	const model = record(root.model, "PILOT_MODEL_SCHEMA"); exact(model, ["provider", "id", "api", "contextWindow", "maxTokens", "thinkingLevel", "outputField"], "PILOT_MODEL_FIELDS");
	if (model.provider !== PILOT_MODEL.provider || model.id !== PILOT_MODEL.id || model.api !== PILOT_MODEL.api || model.contextWindow !== PILOT_MODEL.contextWindow || model.maxTokens !== 2048 || model.thinkingLevel !== "off" || (model.outputField !== "max_tokens" && model.outputField !== "max_completion_tokens")) fail("PILOT_MODEL_SCHEMA");
	const validateFiles = (value: unknown, code: string) => { const item = record(value, code); exact(item, ["commit", "files", "sha256"], code + "_FIELDS"); const files = hashMap(item.files, code); if (hex(item.sha256, code) !== digestMap(files)) fail(code + "_DIGEST"); return { commit: text(item.commit, code, 64), files, sha256: item.sha256 as string }; };
	const code = validateFiles(root.code, "PILOT_CODE");
	const fixtureRaw = record(root.fixture, "PILOT_FIXTURE"); exact(fixtureRaw, ["files", "sha256"], "PILOT_FIXTURE_FIELDS"); const fixtureFiles = hashMap(fixtureRaw.files, "PILOT_FIXTURE"); if (hex(fixtureRaw.sha256, "PILOT_FIXTURE") !== digestMap(fixtureFiles)) fail("PILOT_FIXTURE_DIGEST");
	if (!Array.isArray(root.taskIds) || root.taskIds.length !== 2 || root.taskIds[0] !== PILOT_TASK_IDS[0] || root.taskIds[1] !== PILOT_TASK_IDS[1]) fail("PILOT_TASK_IDS");
	const prompts = record(root.promptSha256, "PILOT_PROMPTS"); exact(prompts, [...PILOT_TASK_IDS], "PILOT_PROMPTS_FIELDS");
	const tools = record(root.toolsSha256, "PILOT_TOOLS"); exact(tools, [...PILOT_TASK_IDS], "PILOT_TOOLS_FIELDS");
	const limits = record(root.limits, "PILOT_LIMITS"); exact(limits, Object.keys(PILOT_LIMITS), "PILOT_LIMIT_FIELDS"); for (const [key, expected] of Object.entries(PILOT_LIMITS)) if (limits[key] !== expected) fail("PILOT_LIMITS");
	const settings = record(root.settings, "PILOT_SETTINGS"); exact(settings, ["retry", "compaction", "sessionTitle"], "PILOT_SETTINGS_FIELDS"); if (settings.retry !== false || settings.compaction !== false || settings.sessionTitle !== false) fail("PILOT_SETTINGS");
	return { schemaVersion: 1, kind: "pilot-rehearsal", batchId: text(root.batchId, "PILOT_BATCH_ID", 128), createdAt: text(root.createdAt, "PILOT_CREATED_AT", 64), model: model as PilotManifest["model"], code, fixture: { files: fixtureFiles, sha256: fixtureRaw.sha256 as string }, policySha256: hex(root.policySha256, "PILOT_POLICY_SHA"), promptSha256: { [PILOT_TASK_IDS[0]]: hex(prompts[PILOT_TASK_IDS[0]], "PILOT_PROMPT_SHA"), [PILOT_TASK_IDS[1]]: hex(prompts[PILOT_TASK_IDS[1]], "PILOT_PROMPT_SHA") }, toolsSha256: { [PILOT_TASK_IDS[0]]: hex(tools[PILOT_TASK_IDS[0]], "PILOT_TOOLS_SHA"), [PILOT_TASK_IDS[1]]: hex(tools[PILOT_TASK_IDS[1]], "PILOT_TOOLS_SHA") }, taskIds: [...PILOT_TASK_IDS], authorization: "offline-only", limits: { ...PILOT_LIMITS }, settings: { retry: false, compaction: false, sessionTitle: false } };
}

const validateProviderUsage = (value: unknown): ProviderUsage => {
	const usage = record(value, "PILOT_PROVIDER_USAGE"); exact(usage, ["promptTokens", "completionTokens", "totalTokens", "cachedTokens", "reasoningTokens"], "PILOT_PROVIDER_USAGE_FIELDS");
	const nullable = (item: unknown) => item === null ? null : integer(item, "PILOT_PROVIDER_USAGE");
	return { promptTokens: nullable(usage.promptTokens), completionTokens: nullable(usage.completionTokens), totalTokens: nullable(usage.totalTokens), cachedTokens: nullable(usage.cachedTokens), reasoningTokens: nullable(usage.reasoningTokens) };
};
export function validatePilotRequestRecord(value: unknown): PilotRequestRecord {
	const root = record(value, "PILOT_REQUEST_SCHEMA"); exact(root, ["schemaVersion", "ordinal", "taskId", "invocationId", "status", "reasonCode", "inputEstimate", "inputBytes", "outputReserved", "requestSha256", "usageSource", "usage"], "PILOT_REQUEST_FIELDS");
	if (root.schemaVersion !== 1 || !PILOT_TASK_IDS.includes(root.taskId as PilotTaskId) || !["dispatched", "complete", "unknown"].includes(root.status as string) || root.outputReserved !== 2048 || (root.usageSource !== "synthetic" && root.usageSource !== "unavailable")) fail("PILOT_REQUEST_SCHEMA");
	const usage = root.usage === null ? null : validateProviderUsage(root.usage); if ((root.usageSource === "unavailable") !== (usage === null)) fail("PILOT_REQUEST_USAGE");
	const status = root.status as PilotRequestRecord["status"], reasonCode = root.reasonCode === null ? null : identifier(root.reasonCode, "PILOT_REQUEST_REASON");
	if ((status === "complete") !== (reasonCode === null)) fail("PILOT_REQUEST_REASON_STATE");
	return { schemaVersion: 1, ordinal: integer(root.ordinal, "PILOT_REQUEST_ORDINAL"), taskId: root.taskId as PilotTaskId, invocationId: integer(root.invocationId, "PILOT_INVOCATION_ID"), status, reasonCode, inputEstimate: integer(root.inputEstimate, "PILOT_INPUT_ESTIMATE"), inputBytes: integer(root.inputBytes, "PILOT_INPUT_BYTES"), outputReserved: 2048, requestSha256: hex(root.requestSha256, "PILOT_REQUEST_SHA"), usageSource: root.usageSource as PilotRequestRecord["usageSource"], usage };
}

export function validatePilotRunRecord(value: unknown): PilotRunRecord {
	const root = record(value, "PILOT_RUN_SCHEMA"); exact(root, ["schemaVersion", "batchId", "manifestSha256", "taskId", "status", "reasonCode", "checks", "realHttpDispatches", "simulatedHttpDispatches", "requests", "usage", "fileChanges", "safeSdkChecks"], "PILOT_RUN_FIELDS");
	if (root.schemaVersion !== 1 || !PILOT_TASK_IDS.includes(root.taskId as PilotTaskId) || !["pass", "fail", "blocked", "unknown"].includes(root.status as string) || root.realHttpDispatches !== 0 || integer(root.simulatedHttpDispatches, "PILOT_RUN_SIMULATED") > 4) fail("PILOT_RUN_SCHEMA");
	if (!Array.isArray(root.requests) || root.requests.length > 8) fail("PILOT_RUN_REQUESTS"); const requestItems = root.requests as unknown[]; const requests = requestItems.map(validatePilotRequestRecord); if (requests.some((item) => item.taskId !== root.taskId)) fail("PILOT_RUN_REQUEST_TASK");
	if (!Array.isArray(root.checks) || root.checks.length > 64) fail("PILOT_RUN_CHECKS"); const checkItems = root.checks as unknown[]; const checks = checkItems.map((item) => { const check = record(item, "PILOT_RUN_CHECK"); exact(check, ["id", "passed"], "PILOT_RUN_CHECK_FIELDS"); if (typeof check.passed !== "boolean") fail("PILOT_RUN_CHECK"); return { id: identifier(check.id, "PILOT_RUN_CHECK_ID"), passed: check.passed as boolean }; });
	if (new Set(checks.map((check) => check.id)).size !== checks.length) fail("PILOT_RUN_CHECK_DUPLICATE");
	const usage = record(root.usage, "PILOT_RUN_USAGE"); exact(usage, ["source", "providerActual", "inputTokens", "outputTokens", "totalTokens"], "PILOT_RUN_USAGE_FIELDS"); if ((usage.source !== "synthetic" && usage.source !== "unavailable") || usage.providerActual !== false) fail("PILOT_RUN_USAGE"); const nullable = (item: unknown) => item === null ? null : integer(item, "PILOT_RUN_USAGE"); const normalizedUsage = { source: usage.source as "synthetic" | "unavailable", providerActual: false as const, inputTokens: nullable(usage.inputTokens), outputTokens: nullable(usage.outputTokens), totalTokens: nullable(usage.totalTokens) }; if (normalizedUsage.source === "unavailable" && Object.values(normalizedUsage).some((item) => typeof item === "number")) fail("PILOT_RUN_USAGE_UNAVAILABLE");
	if (!Array.isArray(root.fileChanges) || root.fileChanges.length > 128) fail("PILOT_FILE_CHANGES"); const changeItems = root.fileChanges as unknown[]; const fileChanges = changeItems.map((item) => { const change = record(item, "PILOT_FILE_CHANGE"); exact(change, ["path", "beforeSha256", "afterSha256"], "PILOT_FILE_CHANGE_FIELDS"); return { path: safePath(change.path, "PILOT_FILE_PATH"), beforeSha256: change.beforeSha256 === null ? null : hex(change.beforeSha256, "PILOT_FILE_SHA"), afterSha256: change.afterSha256 === null ? null : hex(change.afterSha256, "PILOT_FILE_SHA") }; });
	if (!Array.isArray(root.safeSdkChecks) || root.safeSdkChecks.length > 64) fail("PILOT_SDK_CHECKS"); const sdkItems = root.safeSdkChecks as unknown[]; const safeSdkChecks = sdkItems.map((item) => { const check = record(item, "PILOT_SDK_CHECK"); exact(check, ["id", "passed"], "PILOT_SDK_CHECK_FIELDS"); if (typeof check.passed !== "boolean") fail("PILOT_SDK_CHECK"); return { id: identifier(check.id, "PILOT_SDK_CHECK_ID"), passed: check.passed as boolean }; });
	if (new Set(safeSdkChecks.map((check) => check.id)).size !== safeSdkChecks.length) fail("PILOT_SDK_CHECK_DUPLICATE");
	const simulatedHttpDispatches = integer(root.simulatedHttpDispatches, "PILOT_RUN_SIMULATED"); if (requests.length !== simulatedHttpDispatches || new Set(requests.map((request) => request.ordinal)).size !== requests.length || new Set(requests.map((request) => request.invocationId)).size !== requests.length) fail("PILOT_RUN_SIMULATED_MISMATCH");
	if (requests.some((request) => request.inputEstimate > PILOT_LIMITS.maxInputTokens || request.inputBytes > PILOT_LIMITS.maxInputBytes)) fail("PILOT_REQUEST_BUDGET");
	if (root.status === "pass") {
		if (requests.length !== 3) fail("PILOT_PASS_REQUEST_COUNT");
		for (const required of ["sdk", "transport", "source", "fixture", "usage-consistency"]) if (!checks.some((check) => check.id === required && check.passed)) fail("PILOT_PASS_CHECKS");
		for (const required of ["settings", "extension", "allowlist", "role", "files", "toolResults", "normalStop", "finalAnswer"]) if (!safeSdkChecks.some((check) => check.id === required && check.passed)) fail("PILOT_PASS_SDK_CHECKS");
		if (checks.some((check) => !check.passed) || safeSdkChecks.some((check) => !check.passed) || normalizedUsage.source === "unavailable" || requests.some((request) => request.status !== "complete" || request.usageSource !== "synthetic" || request.usage?.promptTokens === null || request.usage?.completionTokens === null || request.usage?.totalTokens === null)) fail("PILOT_PASS_INVALID");
		// This scripted fixture has zero cache/reasoning usage; independently check
		// the arithmetic instead of trusting the runner's success boolean.
		if (normalizedUsage.inputTokens !== requests.reduce((sum, request) => sum + (request.usage?.promptTokens ?? 0), 0)
			|| normalizedUsage.outputTokens !== requests.reduce((sum, request) => sum + (request.usage?.completionTokens ?? 0), 0)
			|| normalizedUsage.totalTokens !== requests.reduce((sum, request) => sum + (request.usage?.totalTokens ?? 0), 0)) fail("PILOT_USAGE_MISMATCH");
		const expected = expectedPassChanges(root.taskId as PilotTaskId).sort((a, b) => a.path.localeCompare(b.path));
		const actual = [...fileChanges].sort((a, b) => a.path.localeCompare(b.path));
		if (JSON.stringify(actual) !== JSON.stringify(expected)) fail("PILOT_PASS_FILE_CHANGES");
	}
	return { schemaVersion: 1, batchId: identifier(root.batchId, "PILOT_BATCH_ID"), manifestSha256: hex(root.manifestSha256, "PILOT_MANIFEST_SHA"), taskId: root.taskId as PilotTaskId, status: root.status as PilotRunRecord["status"], reasonCode: identifier(root.reasonCode, "PILOT_RUN_REASON"), checks, realHttpDispatches: 0, simulatedHttpDispatches, requests, usage: normalizedUsage, fileChanges, safeSdkChecks };
}

export function validatePilotResultIndex(value: unknown): PilotResultIndex {
	const root = record(value, "PILOT_INDEX_SCHEMA"); exact(root, ["schemaVersion", "batchId", "manifestSha256", "entries"], "PILOT_INDEX_FIELDS"); if (root.schemaVersion !== 1 || !Array.isArray(root.entries) || root.entries.length !== 2) fail("PILOT_INDEX_SCHEMA");
	const entries = (root.entries as unknown[]).map((item) => { const entry = record(item, "PILOT_INDEX_ENTRY"); exact(entry, ["taskId", "file", "sha256"], "PILOT_INDEX_ENTRY_FIELDS"); if (!PILOT_TASK_IDS.includes(entry.taskId as PilotTaskId)) fail("PILOT_INDEX_TASK"); return { taskId: entry.taskId as PilotTaskId, file: safePath(entry.file, "PILOT_INDEX_FILE"), sha256: hex(entry.sha256, "PILOT_INDEX_SHA") }; });
	if (new Set(entries.map((item) => item.taskId)).size !== 2 || new Set(entries.map((item) => item.file)).size !== 2) fail("PILOT_INDEX_DUPLICATE");
	return { schemaVersion: 1, batchId: text(root.batchId, "PILOT_BATCH_ID", 128), manifestSha256: hex(root.manifestSha256, "PILOT_MANIFEST_SHA"), entries };
}

export async function writePilotManifest(directory: string, manifestValue: PilotManifest): Promise<string> {
	const manifest = validatePilotManifest(manifestValue), manifestText = stable(manifest); await mkdir(directory, { recursive: true });
	await writeFile(path.join(directory, "manifest.json"), manifestText, { encoding: "utf8", flag: "wx" }); return sha256(manifestText);
}
export async function sealPilotBatch(directory: string, runValues: PilotRunRecord[]): Promise<PilotResultIndex> {
	const manifestText = await readFile(path.join(directory, "manifest.json"), "utf8"), manifest = validatePilotManifest(JSON.parse(manifestText)), manifestSha256 = sha256(manifestText);
	if (runValues.length !== 2) fail("PILOT_RUN_COUNT"); const runs = runValues.map(validatePilotRunRecord);
	if (new Set(runs.map((run) => run.taskId)).size !== 2 || runs.some((run) => run.batchId !== manifest.batchId || run.manifestSha256 !== manifestSha256)) fail("PILOT_RUN_BINDING");
	await mkdir(path.join(directory, "runs"), { recursive: true });
	const entries: PilotResultIndex["entries"] = [];
	for (const run of runs) { const file = `runs/${run.taskId}.json`, content = stable(run); await writeFile(path.join(directory, file), content, { encoding: "utf8", flag: "wx" }); entries.push({ taskId: run.taskId, file, sha256: sha256(content) }); }
	const index: PilotResultIndex = { schemaVersion: 1, batchId: manifest.batchId, manifestSha256, entries: entries.sort((a, b) => a.taskId.localeCompare(b.taskId)) };
	await writeFile(path.join(directory, "result-index.json"), stable(index), { encoding: "utf8", flag: "wx" }); return index;
}

export async function rebuildPilotBatch(directory: string): Promise<PilotAggregate> {
	const top = (await readdir(directory)).sort(); if (top.join(",") !== "manifest.json,result-index.json,runs" && top.join(",") !== "aggregate.json,manifest.json,result-index.json,runs") fail("PILOT_BATCH_EXTRA_FILES");
	if ((await lstat(path.join(directory, "manifest.json"))).isSymbolicLink() || (await lstat(path.join(directory, "result-index.json"))).isSymbolicLink() || (await lstat(path.join(directory, "runs"))).isSymbolicLink()) fail("PILOT_BATCH_SYMLINK");
	const manifestText = await readFile(path.join(directory, "manifest.json"), "utf8"), manifest = validatePilotManifest(JSON.parse(manifestText));
	const index = validatePilotResultIndex(JSON.parse(await readFile(path.join(directory, "result-index.json"), "utf8"))), manifestSha256 = sha256(manifestText);
	if (index.batchId !== manifest.batchId || index.manifestSha256 !== manifestSha256) fail("PILOT_INDEX_BINDING");
	const runs: PilotRunRecord[] = [];
	const runFiles = (await readdir(path.join(directory, "runs"))).sort(); if (runFiles.length !== 2) fail("PILOT_RUN_EXTRA_FILES");
	for (const entry of index.entries) { if (entry.file !== `runs/${entry.taskId}.json`) fail("PILOT_RUN_PATH"); const absolute = path.resolve(directory, entry.file), base = path.resolve(directory) + path.sep; if (!absolute.startsWith(base) || (await lstat(absolute)).isSymbolicLink() || (await stat(absolute)).size > 1024 * 1024) fail("PILOT_RUN_PATH"); const content = await readFile(absolute, "utf8"); if (sha256(content) !== entry.sha256) fail("PILOT_RUN_HASH"); const run = validatePilotRunRecord(JSON.parse(content)); if (run.taskId !== entry.taskId || run.batchId !== manifest.batchId || run.manifestSha256 !== manifestSha256) fail("PILOT_RUN_BINDING"); runs.push(run); }
	if (runs.reduce((sum, run) => sum + run.simulatedHttpDispatches, 0) > PILOT_LIMITS.maxHttpRequests || runs.flatMap((run) => run.requests).reduce((sum, request) => sum + request.inputEstimate, 0) > PILOT_LIMITS.maxTotalInputTokens || runs.flatMap((run) => run.requests).reduce((sum, request) => sum + request.outputReserved, 0) > PILOT_LIMITS.maxTotalOutputTokens) fail("PILOT_BATCH_BUDGET");
	const ordinals = runs.flatMap((run) => run.requests.map((request) => request.ordinal)); if (new Set(ordinals).size !== ordinals.length) fail("PILOT_BATCH_REQUEST_DUPLICATE");
	const count = (status: PilotRunRecord["status"]) => runs.filter((run) => run.status === status).length;
	const aggregate: PilotAggregate = { schemaVersion: 1, kind: "pilot-rehearsal-aggregate", batchId: manifest.batchId, planned: 2, pass: count("pass"), fail: count("fail"), blocked: count("blocked"), unknown: count("unknown"), realHttpDispatches: 0, simulatedHttpDispatches: runs.reduce((sum, run) => sum + run.simulatedHttpDispatches, 0), providerActualRuns: 0, syntheticUsageRuns: runs.filter((run) => run.usage.source === "synthetic").length, unavailableUsageRuns: runs.filter((run) => run.usage.source === "unavailable").length };
	if (top.includes("aggregate.json")) { const aggregatePath = path.join(directory, "aggregate.json"); if ((await lstat(aggregatePath)).isSymbolicLink() || (await stat(aggregatePath)).size > 64 * 1024) fail("PILOT_AGGREGATE_PATH"); const stored = JSON.parse(await readFile(aggregatePath, "utf8")); if (stable(stored) !== stable(aggregate)) fail("PILOT_AGGREGATE_MISMATCH"); }
	return aggregate;
}

export const pilotRecordDigest = { sha256, digestMap };
