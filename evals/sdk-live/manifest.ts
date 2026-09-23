import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { digest, readBounded, sha256 } from "../core/io.js";
import { validateSdkPrepared } from "../sdk-ablation/records.js";
import type { SdkPrepared } from "../sdk-ablation/session.js";
import type { PublicPilotModel } from "../pilot/model.js";
import { LIVE_ACK, LIVE_LIMITS, LIVE_MODEL, LIVE_PROMPTS, LIVE_RUNS, LIVE_SETTINGS, LIVE_SYSTEM, LIVE_TTL, LIVE_VERSION } from "./policy.js";

export const SIMULATIONS = ["none", "readback", "replay", "answer-format", "network", "missing-usage", "forbidden-path", "forbidden-tool", "request-limit"] as const;
export type Simulation = typeof SIMULATIONS[number];
export interface SdkLiveManifest {
	schemaVersion: 1; kind: "sdk-ablation-live-manifest"; mode: "live" | "dry-run"; simulation: Simulation;
	batchId: string; createdAt: string; expiresAt: string;
	model: PublicPilotModel; endpointSha256: string; configSha256: string;
	code: { commit: string; dirty: boolean; files: Record<string,string>; sha256: string };
	fixture: { files: Record<string,string>; sha256: string };
	runtime: { node: string; platform: string; arch: string; piSdk: "0.63.1"; lockSha256: string };
	prepared: Record<string,SdkPrepared>; runs: typeof LIVE_RUNS; limits: typeof LIVE_LIMITS;
	version: typeof LIVE_VERSION; settings: typeof LIVE_SETTINGS; prompts: Record<string,string>; systemSha256: string;
	estimator: "serialized-utf8-bytes-upper-bound-v1";
}
export const exact = (value: unknown, keys: readonly string[]): Record<string,any> => {
	assert.ok(value && typeof value === "object" && !Array.isArray(value), "S2_OBJECT");
	assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "S2_FIELDS"); return value as Record<string,any>;
};
export const hash = (value: unknown) => assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "S2_HASH");
export const count = (value: unknown, max = 1000000000) => assert.ok(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max, "S2_COUNT");
export function hashes(value: unknown): asserts value is Record<string,string> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value)); const entries = Object.entries(value);
	assert.ok(entries.length > 0 && entries.length <= 4096);
	for (const [name, entry] of entries) { assert.ok(name.length <= 512 && !/[\\:\x00-\x1f]/.test(name) && !name.split("/").some(part => !part || part === "." || part === "..")); hash(entry); }
}
export const promptHashes = () => Object.fromEntries(Object.entries(LIVE_PROMPTS).map(([task, text]) => [task, sha256(text)]));
export function validateLiveManifest(value: unknown): SdkLiveManifest {
	const m = exact(value, ["schemaVersion","kind","mode","simulation","batchId","createdAt","expiresAt","model","endpointSha256","configSha256","code","fixture","runtime","prepared","runs","limits","version","settings","prompts","systemSha256","estimator"]);
	assert.equal(m.schemaVersion, 1); assert.equal(m.kind, "sdk-ablation-live-manifest"); assert.ok(["live","dry-run"].includes(m.mode));
	assert.ok(SIMULATIONS.includes(m.simulation)); assert.equal(m.simulation === "none", m.mode === "live");
	assert.match(m.batchId, m.mode === "live" ? /^s2-live-[A-Za-z0-9_-]{1,64}$/ : /^s2-dry-[A-Za-z0-9_-]{1,64}$/);
	assert.equal(new Date(m.createdAt).toISOString(), m.createdAt); assert.equal(new Date(m.expiresAt).toISOString(), m.expiresAt);
	assert.equal(Date.parse(m.expiresAt) - Date.parse(m.createdAt), LIVE_TTL);
	exact(m.model, ["provider","id","api","contextWindow","maxTokens","outputField","reasoning","compatSha256"]);
	for (const key of ["provider","id","api","contextWindow","maxTokens"] as const) assert.equal(m.model[key], LIVE_MODEL[key]);
	assert.equal(typeof m.model.reasoning, "boolean"); hash(m.model.compatSha256); assert.ok(["max_tokens","max_completion_tokens"].includes(m.model.outputField));
	hash(m.endpointSha256); hash(m.configSha256);
	exact(m.code, ["commit","dirty","files","sha256"]); assert.match(m.code.commit, /^[a-f0-9]{40}$/); assert.equal(typeof m.code.dirty, "boolean");
	for (const tree of [m.code, exact(m.fixture, ["files","sha256"])]) { hashes(tree.files); hash(tree.sha256); assert.equal(digest(tree.files), tree.sha256); }
	exact(m.runtime, ["node","platform","arch","piSdk","lockSha256"]); assert.equal(m.runtime.piSdk, "0.63.1"); hash(m.runtime.lockSha256);
	for (const key of ["node","platform","arch"]) assert.match(m.runtime[key], /^[A-Za-z0-9_.-]{1,64}$/);
	assert.deepEqual(m.runs, LIVE_RUNS); assert.deepEqual(m.limits, LIVE_LIMITS); assert.deepEqual(m.settings, LIVE_SETTINGS); assert.deepEqual(m.version, LIVE_VERSION);
	assert.deepEqual(m.prompts, promptHashes()); assert.equal(m.systemSha256, sha256(LIVE_SYSTEM)); assert.equal(m.estimator, "serialized-utf8-bytes-upper-bound-v1");
	exact(m.prepared, LIVE_RUNS.map(run => run.runId));
	for (const run of LIVE_RUNS) {
		const prepared = validateSdkPrepared(m.prepared[run.runId]); assert.equal(prepared.promptSha256, m.prompts[run.taskId]);
		const peer = LIVE_RUNS.find(item => item.taskId === run.taskId)!;
		assert.equal(prepared.systemSha256, m.prepared[peer.runId].systemSha256, "S2_UNFAIR_SYSTEM"); assert.equal(prepared.toolsSha256, m.prepared[peer.runId].toolsSha256, "S2_UNFAIR_TOOLS");
		const same = LIVE_RUNS.find(item => item.profile === run.profile)!; assert.equal(prepared.extensionSha256, m.prepared[same.runId].extensionSha256);
	}
	return m as SdkLiveManifest;
}
export async function durableJson(filename: string, value: unknown) {
	const text = JSON.stringify(value, null, 2) + "\n", handle = await open(filename, "wx", 0o600);
	try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
	return sha256(text);
}
export async function readManifest(directory: string) {
	const text = await readBounded(directory + "/manifest.json");
	return { manifest: validateLiveManifest(JSON.parse(text)), manifestSha256: sha256(text) };
}
export function authorize(manifest: SdkLiveManifest, manifestSha256: string, approval: unknown, now = Date.now()) {
	validateLiveManifest(manifest); hash(manifestSha256);
	assert.equal(approval, `${manifestSha256}\n${LIVE_ACK}`, "S2_APPROVAL_REQUIRED");
	assert.equal(manifest.mode, "live", "S2_DRY_RUN_NOT_AUTHORIZABLE");
	assert.equal(sha256(JSON.stringify(manifest, null, 2) + "\n"), manifestSha256, "S2_MANIFEST_DRIFT");
	assert.ok(Number.isFinite(now) && now >= Date.parse(manifest.createdAt) && now < Date.parse(manifest.expiresAt), "S2_APPROVAL_EXPIRED");
}
