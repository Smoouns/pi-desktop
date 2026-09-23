import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { PILOT_LIMITS, PILOT_MODEL, PILOT_TASK_IDS, type PilotTaskId } from "./policy.js";

export const LIVE_AUTHORIZATION_ACKNOWLEDGEMENT = "I authorize at most 8 live HTTP calls for this manifest and acknowledge that provider cost is unknown.";
export const LIVE_MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;
export class LiveManifestError extends Error { constructor(public readonly code: string) { super(code); this.name = "LiveManifestError"; } }
const fail = (code: string): never => { throw new LiveManifestError(code); };
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown, code: string): Record<string, unknown> => isRecord(value) ? value : fail(code);
const hex = (value: unknown, code: string): string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : fail(code);
const exact = (value: Record<string, unknown>, keys: string[], code: string): void => {
	const left = Object.keys(value).sort(), right = [...keys].sort(); if (left.length !== right.length || left.some((key, index) => key !== right[index])) fail(code);
};
const hashes = (value: unknown, code: string): Record<string, string> => {
	const source = record(value, code); if (Object.keys(source).length < 1 || Object.keys(source).length > 4096) fail(code);
	const result: Record<string, string> = {}; for (const [key, hash] of Object.entries(source)) {
		if (!key || key.length > 512 || key.includes("\0") || path.isAbsolute(key) || key.split(/[\\/]/).includes("..")) fail(code);
		result[key.replaceAll("\\", "/")] = hex(hash, code);
	} return result;
};
const digestMap = (value: Record<string, string>): string => sha256(JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

export type PreparedFingerprint = { toolsSha256: string; systemSha256: string; promptSha256: string; roleSha256: string; extensionSha256: string };
export type LiveManifest = {
	schemaVersion: 1; kind: "pilot-live-manifest"; status: "prepared"; executionMode: "live" | "dry-run"; batchId: string; createdAt: string; expiresAt: string;
	model: typeof PILOT_MODEL & { reasoning: boolean; compatibilitySha256: string; outputField: "max_tokens" | "max_completion_tokens" };
	endpointSha256: string; configSha256: string; taskIds: [...typeof PILOT_TASK_IDS]; limits: typeof PILOT_LIMITS;
	code: { commit: string; dirty: boolean; files: Record<string, string>; sha256: string };
	fixture: { files: Record<string, string>; sha256: string };
	prepared: Record<PilotTaskId, PreparedFingerprint>;
	runtime: { node: string; platform: string; arch: string; piSdk: string; lockSha256: string };
	estimator: { kind: string; version: string; units: "estimated_tokens"; maxInputBytes: number };
	settings: { retry: false; compaction: false; sessionTitle: false; skills: false; discovery: false };
};
export type CreateLiveManifestInput = Omit<LiveManifest, "schemaVersion" | "kind" | "status" | "expiresAt" | "model" | "taskIds" | "limits" | "settings"> & {
	outputField: "max_tokens" | "max_completion_tokens"; reasoning: boolean; compatibilitySha256: string; expiresAt?: string;
};

export function createLiveManifest(input: CreateLiveManifestInput): LiveManifest {
	const created = Date.parse(input.createdAt); if (!Number.isFinite(created)) fail("LIVE_CREATED_AT");
	const expiresAt = input.expiresAt ?? new Date(created + LIVE_MANIFEST_TTL_MS).toISOString();
	return validateLiveManifest({ schemaVersion: 1, kind: "pilot-live-manifest", status: "prepared", executionMode: input.executionMode, batchId: input.batchId,
		createdAt: input.createdAt, expiresAt, model: { ...PILOT_MODEL, reasoning: input.reasoning, compatibilitySha256: input.compatibilitySha256, outputField: input.outputField }, endpointSha256: input.endpointSha256, configSha256: input.configSha256,
		taskIds: [...PILOT_TASK_IDS], limits: { ...PILOT_LIMITS }, code: input.code, fixture: input.fixture, prepared: input.prepared, runtime: input.runtime,
		estimator: input.estimator, settings: { retry: false, compaction: false, sessionTitle: false, skills: false, discovery: false } });
}

export function validateLiveManifest(value: unknown): LiveManifest {
	const root = record(value, "LIVE_MANIFEST_SCHEMA");
	exact(root, ["schemaVersion", "kind", "status", "executionMode", "batchId", "createdAt", "expiresAt", "model", "endpointSha256", "configSha256", "taskIds", "limits", "code", "fixture", "prepared", "runtime", "estimator", "settings"], "LIVE_MANIFEST_FIELDS");
	if (root.schemaVersion !== 1 || root.kind !== "pilot-live-manifest" || root.status !== "prepared" || (root.executionMode !== "live" && root.executionMode !== "dry-run")) fail("LIVE_MANIFEST_IDENTITY");
	if (typeof root.batchId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(root.batchId)) fail("LIVE_BATCH_ID");
	const created = Date.parse(String(root.createdAt)), expires = Date.parse(String(root.expiresAt));
	if (!Number.isFinite(created) || !Number.isFinite(expires) || expires - created !== LIVE_MANIFEST_TTL_MS) fail("LIVE_EXPIRY");
	const model = record(root.model, "LIVE_MODEL"); exact(model, ["provider", "id", "api", "contextWindow", "maxTokens", "thinkingLevel", "reasoning", "compatibilitySha256", "outputField"], "LIVE_MODEL_FIELDS");
	for (const [key, expected] of Object.entries(PILOT_MODEL)) if (model[key] !== expected) fail("LIVE_MODEL"); hex(model.compatibilitySha256, "LIVE_COMPAT_SHA"); if (typeof model.reasoning !== "boolean") fail("LIVE_MODEL");
	if (model.outputField !== "max_tokens" && model.outputField !== "max_completion_tokens") fail("LIVE_OUTPUT_FIELD");
	if (!Array.isArray(root.taskIds) || JSON.stringify(root.taskIds) !== JSON.stringify(PILOT_TASK_IDS)) fail("LIVE_TASKS");
	const limits = record(root.limits, "LIVE_LIMITS"); exact(limits, Object.keys(PILOT_LIMITS), "LIVE_LIMIT_FIELDS");
	for (const [key, expected] of Object.entries(PILOT_LIMITS)) if (limits[key] !== expected) fail("LIVE_LIMITS");
	const parseTree = (item: unknown, code: string, withSourceState: boolean) => { const source = record(item, code); exact(source, withSourceState ? ["commit", "dirty", "files", "sha256"] : ["files", "sha256"], code);
		const files = hashes(source.files, code); if (digestMap(files) !== hex(source.sha256, code)) fail(code + "_DIGEST");
		return withSourceState ? { commit: String(source.commit), dirty: source.dirty === true, files, sha256: source.sha256 as string } : { files, sha256: source.sha256 as string }; };
	const code = parseTree(root.code, "LIVE_CODE", true) as LiveManifest["code"]; if (!code.commit || code.commit.length > 64 || typeof record(root.code, "LIVE_CODE").dirty !== "boolean") fail("LIVE_CODE");
	const fixture = parseTree(root.fixture, "LIVE_FIXTURE", false) as LiveManifest["fixture"];
	const preparedRoot = record(root.prepared, "LIVE_PREPARED"); exact(preparedRoot, [...PILOT_TASK_IDS], "LIVE_PREPARED_FIELDS"); const prepared = {} as Record<PilotTaskId, PreparedFingerprint>;
	for (const id of PILOT_TASK_IDS) { const item = record(preparedRoot[id], "LIVE_PREPARED"); exact(item, ["toolsSha256", "systemSha256", "promptSha256", "roleSha256", "extensionSha256"], "LIVE_PREPARED_ITEM");
		prepared[id] = { toolsSha256: hex(item.toolsSha256, "LIVE_PREPARED_SHA"), systemSha256: hex(item.systemSha256, "LIVE_PREPARED_SHA"), promptSha256: hex(item.promptSha256, "LIVE_PREPARED_SHA"), roleSha256: hex(item.roleSha256, "LIVE_PREPARED_SHA"), extensionSha256: hex(item.extensionSha256, "LIVE_PREPARED_SHA") }; }
	const runtimeRoot = record(root.runtime, "LIVE_RUNTIME"); exact(runtimeRoot, ["node", "platform", "arch", "piSdk", "lockSha256"], "LIVE_RUNTIME_FIELDS");
	const runtime = runtimeRoot as unknown as LiveManifest["runtime"]; if (![runtime.node, runtime.platform, runtime.arch, runtime.piSdk].every((item) => typeof item === "string" && item.length > 0 && item.length < 128)) fail("LIVE_RUNTIME"); hex(runtime.lockSha256, "LIVE_RUNTIME");
	const estimatorRoot = record(root.estimator, "LIVE_ESTIMATOR"); exact(estimatorRoot, ["kind", "version", "units", "maxInputBytes"], "LIVE_ESTIMATOR_FIELDS"); const estimator = estimatorRoot as unknown as LiveManifest["estimator"];
	if (typeof estimator.kind !== "string" || typeof estimator.version !== "string" || estimator.units !== "estimated_tokens" || estimator.maxInputBytes !== PILOT_LIMITS.maxInputBytes) fail("LIVE_ESTIMATOR");
	const settingsRoot = record(root.settings, "LIVE_SETTINGS"); exact(settingsRoot, ["retry", "compaction", "sessionTitle", "skills", "discovery"], "LIVE_SETTINGS_FIELDS"); if (Object.values(settingsRoot).some((item) => item !== false)) fail("LIVE_SETTINGS");
	return { ...(root as unknown as LiveManifest), model: model as unknown as LiveManifest["model"], endpointSha256: hex(root.endpointSha256, "LIVE_ENDPOINT_SHA"), configSha256: hex(root.configSha256, "LIVE_CONFIG_SHA"), code, fixture, prepared, runtime: { ...runtime }, estimator: { ...estimator }, settings: { retry: false, compaction: false, sessionTitle: false, skills: false, discovery: false } };
}

export function liveManifestDigest(manifest: LiveManifest): string { return sha256(stable(validateLiveManifest(manifest))); }
export async function writeLiveManifest(filename: string, manifest: LiveManifest): Promise<string> {
	const text = stable(validateLiveManifest(manifest)); await mkdir(path.dirname(filename), { recursive: true });
	const handle = await open(filename, "wx", 0o600);
	try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
	return sha256(text);
}
export async function readLiveManifest(filename: string, maxBytes = 1024 * 1024): Promise<{ manifest: LiveManifest; sha256: string }> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) fail("LIVE_MANIFEST_READ_LIMIT");
	const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) fail("LIVE_MANIFEST_FILE");
	const text = await readFile(filename, "utf8"); if (Buffer.byteLength(text) > maxBytes) fail("LIVE_MANIFEST_FILE");
	try { return { manifest: validateLiveManifest(JSON.parse(text)), sha256: sha256(text) }; } catch (error) { if (error instanceof LiveManifestError) throw error; return fail("LIVE_MANIFEST_JSON"); }
}

export function liveAuthorizationToken(manifestSha256: string): string { return `${hex(manifestSha256, "LIVE_AUTH_SHA")}\n${LIVE_AUTHORIZATION_ACKNOWLEDGEMENT}`; }
export function validateLiveAuthorization(expectedSha256: string, approval: unknown, now: Date, manifest: LiveManifest): true {
	const expected = hex(expectedSha256, "LIVE_AUTH_SHA"); if (typeof approval !== "string" || approval !== liveAuthorizationToken(expected)) fail("LIVE_AUTHORIZATION_REQUIRED");
	const valid = validateLiveManifest(manifest); if (valid.executionMode !== "live") fail("LIVE_DRY_RUN_NOT_AUTHORIZABLE"); if (liveManifestDigest(valid) !== expected) fail("LIVE_MANIFEST_DRIFT");
	const time = now.getTime(); if (!Number.isFinite(time) || time < Date.parse(valid.createdAt) || time >= Date.parse(valid.expiresAt)) fail("LIVE_AUTHORIZATION_EXPIRED");
	return true;
}
