import assert from "node:assert/strict";
import { digest, readBounded, sha256 } from "../core/io.js";
import { count, durableJson, exact, hash, hashes } from "../sdk-live/manifest.js";
import { validateSdkPrepared } from "../sdk-ablation/records.js";
import type { SdkPrepared } from "../sdk-ablation/session.js";
import type { PublicPilotModel } from "../pilot/model.js";
import { ACK, LIMITS, MODEL, POLICY, PRODUCT_LIMITS, PROMPTS, RUNS, SETTINGS, SIMULATIONS, SYSTEM, TTL, VERSION, referenceBudget, stagesFor, type Simulation } from "./policy.js";
import { profileSource } from "./profile.js";

export { count, durableJson, exact, hash, hashes };
export interface Manifest {
	schemaVersion: 1; kind: "sdk-context-live-manifest"; mode: "live" | "dry-run"; simulation: Simulation; batchId: string; createdAt: string; expiresAt: string;
	model: PublicPilotModel; endpointSha256: string; configSha256: string;
	code: { commit: string; dirty: boolean; files: Record<string, string>; sha256: string }; fixture: { files: Record<string, string>; sha256: string };
	runtime: { node: string; platform: string; arch: string; sdk: "0.63.1"; lockSha256: string };
	prepared: Record<string, Record<string, SdkPrepared>>; runs: typeof RUNS; limits: typeof LIMITS; policy: typeof POLICY; productLimits: typeof PRODUCT_LIMITS;
	settings: typeof SETTINGS; version: typeof VERSION; prompts: Record<string, string>; systemSha256: string; referenceBudget: ReturnType<typeof referenceBudget>;
}
export const promptHashes = () => Object.fromEntries(Object.entries(PROMPTS).map(([key, text]) => [key, sha256(text)]));
export function validateManifest(value: unknown): Manifest {
	const m = exact(value, ["schemaVersion", "kind", "mode", "simulation", "batchId", "createdAt", "expiresAt", "model", "endpointSha256", "configSha256", "code", "fixture", "runtime", "prepared", "runs", "limits", "policy", "productLimits", "settings", "version", "prompts", "systemSha256", "referenceBudget"]);
	assert.equal(m.schemaVersion, 1); assert.equal(m.kind, "sdk-context-live-manifest"); assert.ok(["live", "dry-run"].includes(m.mode));
	assert.ok(SIMULATIONS.includes(m.simulation)); assert.equal(m.mode === "live", m.simulation === "none");
	assert.match(m.batchId, m.mode === "live" ? /^s3-live-[A-Za-z0-9_-]{1,64}$/ : /^s3-dry-[A-Za-z0-9_-]{1,64}$/);
	assert.equal(new Date(m.createdAt).toISOString(), m.createdAt); assert.equal(new Date(m.expiresAt).toISOString(), m.expiresAt); assert.equal(Date.parse(m.expiresAt) - Date.parse(m.createdAt), TTL);
	exact(m.model, ["provider", "id", "api", "contextWindow", "maxTokens", "outputField", "reasoning", "compatSha256"]);
	for (const key of ["provider", "id", "api", "contextWindow", "maxTokens"] as const) assert.equal(m.model[key], MODEL[key]);
	assert.equal(typeof m.model.reasoning, "boolean"); hash(m.model.compatSha256); assert.ok(["max_tokens", "max_completion_tokens"].includes(m.model.outputField));
	hash(m.endpointSha256); hash(m.configSha256); exact(m.code, ["commit", "dirty", "files", "sha256"]); assert.match(m.code.commit, /^[a-f0-9]{40}$/); assert.equal(typeof m.code.dirty, "boolean");
	for (const tree of [m.code, exact(m.fixture, ["files", "sha256"])]) { hashes(tree.files); hash(tree.sha256); assert.equal(tree.sha256, digest(tree.files)); }
	exact(m.runtime, ["node", "platform", "arch", "sdk", "lockSha256"]); assert.equal(m.runtime.sdk, "0.63.1"); hash(m.runtime.lockSha256);
	for (const key of ["node", "platform", "arch"]) assert.match(m.runtime[key], /^[A-Za-z0-9_.-]{1,64}$/);
	assert.deepEqual(m.runs, RUNS); assert.deepEqual(m.limits, LIMITS); assert.deepEqual(m.policy, POLICY); assert.deepEqual(m.productLimits, PRODUCT_LIMITS);
	assert.deepEqual(m.settings, SETTINGS); assert.deepEqual(m.version, VERSION); assert.deepEqual(m.prompts, promptHashes()); assert.equal(m.systemSha256, sha256(SYSTEM)); assert.deepEqual(m.referenceBudget, referenceBudget());
	exact(m.prepared, RUNS.map(run => run.runId));
	for (const run of RUNS) {
		exact(m.prepared[run.runId], stagesFor(run));
		for (const stage of stagesFor(run)) {
			const item = validateSdkPrepared(m.prepared[run.runId][stage]);
			assert.equal(item.extensionSha256, sha256(profileSource(run.profile))); assert.equal(item.promptSha256, m.prompts[stage]);
			// Tools can differ across profiles by design, never silently within one.
			const peer = RUNS.find(r => r.profile === run.profile)!;
			assert.equal(item.toolsSha256, m.prepared[peer.runId][stagesFor(peer)[0]].toolsSha256);
			assert.equal(item.systemSha256, m.prepared[RUNS[0].runId].single.systemSha256);
		}
	}
	return m as Manifest;
}
export async function readManifest(directory: string) {
	const text = await readBounded(directory + "/manifest.json"); return { manifest: validateManifest(JSON.parse(text)), manifestSha256: sha256(text) };
}
export function authorize(manifest: Manifest, sha: string, approval: unknown, now = Date.now()) {
	validateManifest(manifest); hash(sha); assert.equal(approval, `${sha}\n${ACK}`, "S3L_APPROVAL_REQUIRED");
	assert.equal(manifest.mode, "live", "S3L_DRY_NOT_AUTHORIZABLE"); assert.equal(sha256(JSON.stringify(manifest, null, 2) + "\n"), sha, "S3L_MANIFEST_DRIFT");
	assert.ok(Number.isFinite(now) && now >= Date.parse(manifest.createdAt) && now < Date.parse(manifest.expiresAt), "S3L_APPROVAL_EXPIRED");
}
