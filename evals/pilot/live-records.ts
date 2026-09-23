import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { recoverPilotJournal, type PilotJournalRecovery } from "./journal.js";
import { readLiveManifest } from "./live-manifest.js";
import { PILOT_LIMITS, PILOT_PROBE_CONTENT, PILOT_PROBE_PATH, PILOT_TASK_IDS, type PilotTaskId } from "./policy.js";
import { pilotAnswerAccepted, validatePilotAnswerDiagnostic, type PilotAnswerDiagnostic } from "./answer-diagnostics.js";

export const LIVE_BROKER_REASON_CODES = [
	"LIVE_TASK_PASS", "SDK_SESSION_FAILED", "MECHANICAL_CHECK_FAILED", "REQUEST_UNKNOWN", "BATCH_ABORTED", "BROKER_STOPPED",
	"SOURCE_DRIFT", "FIXTURE_DRIFT", "FILE_POLICY_FAILED", "JOURNAL_INCOMPLETE", "USER_ABORTED", "AUTHORIZATION_FAILED",
	"TRANSPORT_FAILED", "BUDGET_EXCEEDED", "PROVIDER_USAGE_MISSING", "PROVIDER_ERROR",
] as const;
export type LiveBrokerReasonCode = typeof LIVE_BROKER_REASON_CODES[number];
export class LiveRecordsError extends Error { constructor(public readonly code: string) { super(code); this.name = "LiveRecordsError"; } }
const fail = (code: string): never => { throw new LiveRecordsError(code); };
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown, code: string): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail(code);
const exact = (value: Record<string, unknown>, keys: readonly string[], code: string): void => { const left = Object.keys(value).sort(), right = [...keys].sort(); if (left.length !== right.length || left.some((key, index) => key !== right[index])) fail(code); };
const bool = (value: unknown, code: string): boolean => typeof value === "boolean" ? value : fail(code);
const nullableCount = (value: unknown, code: string): number | null => value === null ? null : Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fail(code);
const taskId = (value: unknown): PilotTaskId => PILOT_TASK_IDS.includes(value as PilotTaskId) ? value as PilotTaskId : fail("LIVE_RESULT_TASK");
const reason = (value: unknown): LiveBrokerReasonCode => LIVE_BROKER_REASON_CODES.includes(value as LiveBrokerReasonCode) ? value as LiveBrokerReasonCode : fail("LIVE_RESULT_REASON");
const safePath = (value: unknown): string => typeof value === "string" && value.length > 0 && value.length <= 512 && !path.isAbsolute(value) && !/[\\\0-\x1f]/.test(value) && !value.split("/").some((part) => !part || part === "." || part === "..") ? value : fail("LIVE_RESULT_PATH");

const SDK_CHECK_IDS = ["settings", "extension", "allowlist", "role", "files", "toolResults", "normalStop", "finalAnswer"] as const;
const TASK_CHECK_IDS = ["sdk", "source", "fixture", "files", "prepared"] as const;
export type LiveSdkUsage = { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; totalTokens: number | null };
type LiveTaskData = {
	manifestSha256: string; taskId: PilotTaskId; status: "pass" | "fail" | "unknown" | "blocked";
	checks: { sdk: boolean; source: boolean; fixture: boolean; files: boolean; prepared: boolean };
	sdkChecks: { settings: boolean; extension: boolean; allowlist: boolean; role: boolean; files: boolean; toolResults: boolean; normalStop: boolean; finalAnswer: boolean };
	sdkUsage: LiveSdkUsage; fileChanges: Array<{ path: string; beforeSha256: string | null; afterSha256: string | null }>; reasonCode: LiveBrokerReasonCode;
};
// V1 remains readable without fabricated diagnostics; new broker records use V2.
export type LiveTaskRecord = LiveTaskData & ({ schemaVersion: 1 } | { schemaVersion: 2; answerDiagnostic: PilotAnswerDiagnostic });
export type LiveResultIndex = { schemaVersion: 1; kind: "pilot-live-result-index"; manifestSha256: string; entries: Array<{ taskId: PilotTaskId; file: string; sha256: string }> };
export type LiveAggregate = {
	schemaVersion: 1; kind: "pilot-live-aggregate"; mode: "live" | "dry-run"; status: "pass" | "incomplete" | "failed";
	tasks: Array<{ taskId: PilotTaskId; status: "pass" | "fail" | "unknown" | "blocked"; reasonCode: LiveBrokerReasonCode; answerDiagnostic?: PilotAnswerDiagnostic }>;
	realHttpDispatches: number; simulatedHttpDispatches: number; possibleUnknownDispatches: number;
	providerUsage: { source: "provider" | "synthetic"; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; cachedTokens: number | null; reasoningTokens: number | null; costUsd: null };
	sdkUsage: LiveSdkUsage & { costUsd: null }; manifestSha256: string; indexed: boolean;
};

const SETTINGS = JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false }, null, 2) + "\n";
const expectedChanges = (id: PilotTaskId) => [
	{ path: ".pi/settings.json", beforeSha256: null, afterSha256: sha256(SETTINGS) },
	...(id === "P5P-WRITE-001" ? [{ path: PILOT_PROBE_PATH, beforeSha256: null, afterSha256: sha256(PILOT_PROBE_CONTENT) }] : []),
];

export function validateLiveTaskRecord(value: unknown): LiveTaskRecord {
	const root = object(value, "LIVE_RESULT_SCHEMA"); exact(root, ["schemaVersion", "manifestSha256", "taskId", "status", "checks", "sdkChecks", "sdkUsage", "fileChanges", "reasonCode", ...(root.schemaVersion === 2 ? ["answerDiagnostic"] : [])], "LIVE_RESULT_FIELDS");
	if ((root.schemaVersion !== 1 && root.schemaVersion !== 2) || !isHash(root.manifestSha256) || !["pass", "fail", "unknown", "blocked"].includes(root.status as string)) fail("LIVE_RESULT_SCHEMA");
	const id = taskId(root.taskId), checksRaw = object(root.checks, "LIVE_RESULT_CHECKS"); exact(checksRaw, TASK_CHECK_IDS, "LIVE_RESULT_CHECK_FIELDS");
	const checks = Object.fromEntries(TASK_CHECK_IDS.map((key) => [key, bool(checksRaw[key], "LIVE_RESULT_CHECK")])) as LiveTaskRecord["checks"];
	const sdkRaw = object(root.sdkChecks, "LIVE_RESULT_SDK_CHECKS"); exact(sdkRaw, SDK_CHECK_IDS, "LIVE_RESULT_SDK_FIELDS");
	const sdkChecks = Object.fromEntries(SDK_CHECK_IDS.map((key) => [key, bool(sdkRaw[key], "LIVE_RESULT_SDK_CHECK")])) as LiveTaskRecord["sdkChecks"];
	const usageRaw = object(root.sdkUsage, "LIVE_RESULT_SDK_USAGE"); exact(usageRaw, ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"], "LIVE_RESULT_SDK_USAGE_FIELDS");
	const sdkUsage: LiveSdkUsage = { inputTokens: nullableCount(usageRaw.inputTokens, "LIVE_RESULT_SDK_USAGE"), outputTokens: nullableCount(usageRaw.outputTokens, "LIVE_RESULT_SDK_USAGE"), cacheReadTokens: nullableCount(usageRaw.cacheReadTokens, "LIVE_RESULT_SDK_USAGE"), cacheWriteTokens: nullableCount(usageRaw.cacheWriteTokens, "LIVE_RESULT_SDK_USAGE"), totalTokens: nullableCount(usageRaw.totalTokens, "LIVE_RESULT_SDK_USAGE") };
	if (!Array.isArray(root.fileChanges) || root.fileChanges.length > 8) fail("LIVE_RESULT_FILES");
	const fileChanges = (root.fileChanges as unknown[]).map((value) => { const change = object(value, "LIVE_RESULT_FILE"); exact(change, ["path", "beforeSha256", "afterSha256"], "LIVE_RESULT_FILE_FIELDS"); if ((change.afterSha256 !== null && !isHash(change.afterSha256)) || (change.beforeSha256 !== null && !isHash(change.beforeSha256)) || (change.beforeSha256 === null && change.afterSha256 === null)) fail("LIVE_RESULT_FILE_HASH"); return { path: safePath(change.path), beforeSha256: change.beforeSha256 as string | null, afterSha256: change.afterSha256 as string | null }; });
	if (new Set(fileChanges.map((item) => item.path)).size !== fileChanges.length) fail("LIVE_RESULT_FILE_DUPLICATE");
	const code = reason(root.reasonCode), status = root.status as LiveTaskRecord["status"];
	if ((status === "pass") !== (code === "LIVE_TASK_PASS")) fail("LIVE_RESULT_STATUS_REASON");
	const data: LiveTaskData = { manifestSha256: root.manifestSha256 as string, taskId: id, status, checks, sdkChecks, sdkUsage, fileChanges, reasonCode: code };
	if (root.schemaVersion === 1) return { schemaVersion: 1, ...data };
	let answerDiagnostic: PilotAnswerDiagnostic;
	try { answerDiagnostic = validatePilotAnswerDiagnostic(root.answerDiagnostic, id); }
	catch { return fail("LIVE_RESULT_ANSWER_DIAGNOSTIC"); }
	if (sdkChecks.finalAnswer !== pilotAnswerAccepted(answerDiagnostic)
		|| status === "blocked" && answerDiagnostic.codes[0] !== "ANSWER_NOT_EVALUATED") fail("LIVE_RESULT_ANSWER_CONFLICT");
	return { schemaVersion: 2, ...data, answerDiagnostic };
}

function mechanicallyPass(record: LiveTaskRecord, journal: PilotJournalRecovery): boolean {
	if (record.status !== "pass" || record.reasonCode !== "LIVE_TASK_PASS" || Object.values(record.checks).some((value) => !value) || Object.values(record.sdkChecks).some((value) => !value)) return false;
	if ([record.sdkUsage.inputTokens, record.sdkUsage.outputTokens, record.sdkUsage.totalTokens].some((value) => value === null)) return false;
	const actual = [...record.fileChanges].sort((a, b) => a.path.localeCompare(b.path)), expected = expectedChanges(record.taskId).sort((a, b) => a.path.localeCompare(b.path));
	return JSON.stringify(actual) === JSON.stringify(expected) && journal.canPass && journal.requestsByTask[record.taskId] > 0;
}

async function writeExclusive(filename: string, content: string): Promise<void> { const handle = await open(filename, "wx", 0o600); try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); } }
async function bounded(filename: string, max = 256 * 1024): Promise<string> { const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size > max) fail("LIVE_RESULT_FILE_UNSAFE"); return readFile(filename, "utf8"); }
async function assertDirectory(directory: string): Promise<void> { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) fail("LIVE_RESULT_DIRECTORY_UNSAFE"); }
async function manifestAt(directory: string) { await assertDirectory(directory); return readLiveManifest(path.join(directory, "manifest.json")); }

export async function writeLiveTaskRecord(directory: string, value: LiveTaskRecord): Promise<void> {
	const record = validateLiveTaskRecord(value), manifest = await manifestAt(directory); if (record.manifestSha256 !== manifest.sha256) fail("LIVE_RESULT_MANIFEST_BINDING");
	const runs = path.join(directory, "runs"); await mkdir(runs, { recursive: true }); await assertDirectory(runs); await writeExclusive(path.join(runs, `${record.taskId}.json`), stable(record));
}

function validateIndex(value: unknown, manifestSha256: string): LiveResultIndex {
	const root = object(value, "LIVE_RESULT_INDEX"); exact(root, ["schemaVersion", "kind", "manifestSha256", "entries"], "LIVE_RESULT_INDEX_FIELDS");
	if (root.schemaVersion !== 1 || root.kind !== "pilot-live-result-index" || root.manifestSha256 !== manifestSha256 || !Array.isArray(root.entries) || root.entries.length !== 2) fail("LIVE_RESULT_INDEX");
	const entries = (root.entries as unknown[]).map((value) => { const item = object(value, "LIVE_RESULT_INDEX_ENTRY"); exact(item, ["taskId", "file", "sha256"], "LIVE_RESULT_INDEX_ENTRY_FIELDS"); const id = taskId(item.taskId); if (item.file !== `runs/${id}.json` || !isHash(item.sha256)) fail("LIVE_RESULT_INDEX_ENTRY"); return { taskId: id, file: item.file as string, sha256: item.sha256 as string }; });
	if (new Set(entries.map((entry) => entry.taskId)).size !== 2) fail("LIVE_RESULT_INDEX_DUPLICATE"); return { schemaVersion: 1, kind: "pilot-live-result-index", manifestSha256, entries };
}

async function taskFiles(directory: string): Promise<Map<PilotTaskId, { record: LiveTaskRecord; text: string }>> {
	const result = new Map<PilotTaskId, { record: LiveTaskRecord; text: string }>(), runs = path.join(directory, "runs");
	try { await assertDirectory(runs); const names = (await readdir(runs)).sort(); if (names.some((name) => !PILOT_TASK_IDS.some((id) => name === `${id}.json`))) fail("LIVE_RESULT_RUN_FILES");
		for (const name of names) { const text = await bounded(path.join(runs, name)); const record = validateLiveTaskRecord(JSON.parse(text)); if (name !== `${record.taskId}.json` || result.has(record.taskId)) fail("LIVE_RESULT_RUN_FILES"); result.set(record.taskId, { record, text }); }
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	return result;
}

export async function sealLiveResults(directory: string): Promise<LiveResultIndex> {
	const manifest = await manifestAt(directory), tasks = await taskFiles(directory); let journal: PilotJournalRecovery;
	try { journal = await recoverPilotJournal(path.join(directory, "journal"), manifest.sha256); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fail("LIVE_RESULTS_INCOMPLETE"); throw error; }
	if (tasks.size !== 2 || !journal.finalized || journal.mode !== manifest.manifest.executionMode) fail("LIVE_RESULTS_INCOMPLETE");
	const entries = PILOT_TASK_IDS.map((id) => { const item = tasks.get(id)!; if (item.record.manifestSha256 !== manifest.sha256) fail("LIVE_RESULT_MANIFEST_BINDING"); return { taskId: id, file: `runs/${id}.json`, sha256: sha256(item.text) }; });
	const index: LiveResultIndex = { schemaVersion: 1, kind: "pilot-live-result-index", manifestSha256: manifest.sha256, entries }; await writeExclusive(path.join(directory, "result-index.json"), stable(index)); return index;
}

const sumNullable = (values: Array<number | null>): number | null => values.length > 0 && values.every((value) => value !== null) ? values.reduce<number>((sum, value) => sum + (value as number), 0) : null;
export async function recoverLiveResults(directory: string): Promise<LiveAggregate> {
	const manifest = await manifestAt(directory), records = await taskFiles(directory); let journal: PilotJournalRecovery | null = null;
	try { journal = await recoverPilotJournal(path.join(directory, "journal"), manifest.sha256); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	if (journal && journal.mode !== manifest.manifest.executionMode) fail("LIVE_RESULT_MODE_MISMATCH");
	let indexed = false;
	try { const index = validateIndex(JSON.parse(await bounded(path.join(directory, "result-index.json"))), manifest.sha256);
		for (const entry of index.entries) { const item = records.get(entry.taskId); if (!item || sha256(item.text) !== entry.sha256) fail("LIVE_RESULT_HASH"); } indexed = true;
	} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const tasks = PILOT_TASK_IDS.map((id) => { const record = records.get(id)?.record; if (!journal || !record || record.manifestSha256 !== manifest.sha256) return { taskId: id, status: "unknown" as const, reasonCode: "JOURNAL_INCOMPLETE" as const };
		const diagnostic = record.schemaVersion === 2 ? { answerDiagnostic: record.answerDiagnostic } : {};
		return mechanicallyPass(record, journal) ? { taskId: id, status: "pass" as const, reasonCode: "LIVE_TASK_PASS" as const, ...diagnostic } : { taskId: id, status: record.status === "pass" ? "fail" as const : record.status, reasonCode: record.status === "pass" ? "MECHANICAL_CHECK_FAILED" as const : record.reasonCode, ...diagnostic }; });
	const completeUsage = journal?.reservations.map((item) => item.settlement?.usage ?? null) ?? [], usageValues = <K extends keyof NonNullable<(typeof completeUsage)[number]>>(key: K) => completeUsage.map((usage) => usage?.[key] ?? null);
	const sdk = [...records.values()].map((item) => item.record.sdkUsage);
	const anyFailed = tasks.some((item) => item.status === "fail" || item.status === "blocked"), incomplete = !indexed || records.size !== 2 || !journal?.canPass || tasks.some((item) => item.status === "unknown");
	const status: LiveAggregate["status"] = !incomplete && !anyFailed && tasks.every((item) => item.status === "pass") ? "pass" : incomplete ? "incomplete" : "failed";
	const attempted = journal?.dispatchAttempted ?? 0;
	return { schemaVersion: 1, kind: "pilot-live-aggregate", mode: manifest.manifest.executionMode, status, tasks,
		realHttpDispatches: journal?.mode === "live" ? attempted : 0, simulatedHttpDispatches: journal?.mode === "dry-run" ? attempted : 0, possibleUnknownDispatches: journal?.unknown ?? PILOT_LIMITS.maxHttpRequests,
		providerUsage: { source: manifest.manifest.executionMode === "live" ? "provider" : "synthetic", promptTokens: sumNullable(usageValues("promptTokens")), completionTokens: sumNullable(usageValues("completionTokens")), totalTokens: sumNullable(usageValues("totalTokens")), cachedTokens: sumNullable(usageValues("cachedTokens")), reasoningTokens: sumNullable(usageValues("reasoningTokens")), costUsd: null },
		sdkUsage: { inputTokens: records.size === 2 ? sumNullable(sdk.map((item) => item.inputTokens)) : null, outputTokens: records.size === 2 ? sumNullable(sdk.map((item) => item.outputTokens)) : null, cacheReadTokens: records.size === 2 ? sumNullable(sdk.map((item) => item.cacheReadTokens)) : null, cacheWriteTokens: records.size === 2 ? sumNullable(sdk.map((item) => item.cacheWriteTokens)) : null, totalTokens: records.size === 2 ? sumNullable(sdk.map((item) => item.totalTokens)) : null, costUsd: null }, manifestSha256: manifest.sha256, indexed };
}
