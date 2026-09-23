import assert from "node:assert/strict";
import { digest, readBounded, sha256 } from "../core/io.js";
import { count, durableJson, exact, hash, hashes } from "../sdk-live/manifest.js";
import { validateSdkPrepared } from "../sdk-ablation/records.js";
import { fixtureHashes, seedHash } from "./fixture.js";
import type { Prepared, Calibration } from "./session.js";

import type { PublicPilotModel } from "../pilot/model.js";
import { ACK, LIMITS, MODEL, POLICY, PRODUCT_LIMITS, PROMPTS, RUNS, SETTINGS, SIMULATIONS, SYSTEM, TTL, VERSION, referenceBudget, TASKS, policyForSchema, SCHEMA_VERSION, type SchemaVersion, type Simulation, type Profile } from "./policy.js";
import type { RequestLimits } from "../core/request-policy.js";
import { profileSource } from "./profile.js";

export { count, durableJson, exact, hash, hashes };
// V1's generated extension text was hashed after bundling. Additional imports
// can rename bundled identifiers without changing the factory source. Freeze
// the accepted v1 fingerprints for readback; never re-authorize these records.
export const LEGACY_PROFILE_HASHES: Record<Profile, string> = {
  "sdk-b3-s4live-control-v1": "47dbe60c6267fd22aa99757b189bb77f796750b7540c28e6b5c0b11a0a3ebe24",
  "sdk-b3-s4live-supervisor-v1": "7ed787017c872b0008e0125b896033020b715ff8c1c8b858b19271483e1a2911",
  "sdk-b3-s4live-supervisor-maintenance-v1": "eb3205e54ba411b498f33c5b789aaf4eb7838bc2b2d289f216e9691adb49f4b0",
};
export const V2_PROFILE_HASHES: Record<Profile, string> = {
  "sdk-b3-s4live-control-v1": "5ce290746672f1bd012d0aecbdd7b34416b06d923d827f9422881a87e54d69fc",
  "sdk-b3-s4live-supervisor-v1": "55376b73144bb6adb4e607f15423d39dc0eab1320159bdd4ed6275c649e8108d",
  "sdk-b3-s4live-supervisor-maintenance-v1": "799a5beec9529b4d7584d8bce213a3e470e9f3d529ad7f6660d44b6a796292cb",
};
export const legacyProfileHashes = (version: 1 | 2) => version === 1 ? LEGACY_PROFILE_HASHES : V2_PROFILE_HASHES;
export interface Manifest {
	schemaVersion: SchemaVersion; kind: "sdk-supervision-live-manifest"; mode: "live" | "dry-run"; simulation: Simulation; batchId: string; createdAt: string; expiresAt: string;
	model: PublicPilotModel; endpointSha256: string; configSha256: string;
	code: { commit: string; dirty: boolean; files: Record<string, string>; sha256: string }; fixture: { files: Record<string, Record<string, string>>; sha256: string };
	runtime: { node: string; platform: string; arch: string; sdk: "0.63.1"; lockSha256: string };
	prepared: Record<string, Prepared>; calibration: Calibration; runs: typeof RUNS; limits: Readonly<RequestLimits>; policy: typeof POLICY; productLimits: typeof PRODUCT_LIMITS;
	settings: typeof SETTINGS; version: typeof VERSION; prompts: Record<string, string>; systemSha256: string; referenceBudget: ReturnType<typeof referenceBudget>;
}
export const promptHashes = () => Object.fromEntries(Object.entries(PROMPTS).map(([key, text]) => [key, sha256(text)]));
export function validateManifest(value: unknown): Manifest {
	const m = exact(value, ["schemaVersion", "kind", "mode", "simulation", "batchId", "createdAt", "expiresAt", "model", "endpointSha256", "configSha256", "code", "fixture", "runtime", "prepared", "calibration", "runs", "limits", "policy", "productLimits", "settings", "version", "prompts", "systemSha256", "referenceBudget"]);
	const policy = policyForSchema(m.schemaVersion);
	assert.equal(m.kind, "sdk-supervision-live-manifest"); assert.ok(["live", "dry-run"].includes(m.mode));
	assert.ok(SIMULATIONS.includes(m.simulation)); assert.equal(m.mode === "live", m.simulation === "none");
	assert.match(m.batchId, m.mode === "live" ? /^s4-live-[A-Za-z0-9_-]{1,64}$/ : /^s4-dry-[A-Za-z0-9_-]{1,64}$/);
	assert.equal(new Date(m.createdAt).toISOString(), m.createdAt); assert.equal(new Date(m.expiresAt).toISOString(), m.expiresAt); assert.equal(Date.parse(m.expiresAt) - Date.parse(m.createdAt), TTL);
	exact(m.model, ["provider", "id", "api", "contextWindow", "maxTokens", "outputField", "reasoning", "compatSha256"]);
	for (const key of ["provider", "id", "api", "contextWindow", "maxTokens"] as const) assert.equal(m.model[key], MODEL[key]);
	assert.equal(typeof m.model.reasoning, "boolean"); hash(m.model.compatSha256); assert.ok(["max_tokens", "max_completion_tokens"].includes(m.model.outputField));
	hash(m.endpointSha256); hash(m.configSha256); exact(m.code, ["commit", "dirty", "files", "sha256"]); assert.match(m.code.commit, /^[a-f0-9]{40}$/); assert.equal(typeof m.code.dirty, "boolean");
	hashes(m.code.files); hash(m.code.sha256); assert.equal(m.code.sha256, digest(m.code.files)); exact(m.fixture, ["files", "sha256"]);
  assert.deepEqual(m.fixture.files, Object.fromEntries(TASKS.map(t => [t, fixtureHashes(t)]))); assert.equal(m.fixture.sha256, digest(m.fixture.files));
	exact(m.runtime, ["node", "platform", "arch", "sdk", "lockSha256"]); assert.equal(m.runtime.sdk, "0.63.1"); hash(m.runtime.lockSha256);
	for (const key of ["node", "platform", "arch"]) assert.match(m.runtime[key], /^[A-Za-z0-9_.-]{1,64}$/);
	assert.deepEqual(m.runs, RUNS); assert.deepEqual(m.limits, policy.limits); assert.deepEqual(m.policy, policy); assert.deepEqual(m.productLimits, PRODUCT_LIMITS);
	assert.deepEqual(m.settings, SETTINGS); assert.deepEqual(m.version, VERSION); assert.deepEqual(m.prompts, promptHashes()); assert.equal(m.systemSha256, sha256(SYSTEM)); assert.deepEqual(m.referenceBudget, referenceBudget(policy.limits));
	exact(m.prepared, RUNS.map(run => run.runId));
  for (const run of RUNS) {
    const item = validatePrepared(m.prepared[run.runId]);
    assert.equal(item.extensionSha256, m.schemaVersion === SCHEMA_VERSION ? sha256(profileSource(run.profile)) : legacyProfileHashes(m.schemaVersion)[run.profile]); assert.equal(item.promptSha256, m.prompts[run.task]); assert.equal(item.seedSha256, seedHash(run.task));
    const peer = RUNS.find(r => r.task === run.task)!;
    for (const key of ["systemSha256", "toolsSha256"] as const) assert.equal(item[key], m.prepared[RUNS[0].runId][key]);
    assert.deepEqual(item.wire, m.prepared[peer.runId].wire, "S4L_UNFAIR_INPUT");
    if (run.task === "pressure-recover") { assert.ok(item.wire.trimmed > 0); assert.ok(item.wire.afterTrimBytes + PRODUCT_LIMITS.outputReserve + PRODUCT_LIMITS.safetyMargin > PRODUCT_LIMITS.contextBytes); }
  }
  const c = validateCalibration(m.calibration); assert.equal(c.compactions, 1); assert.equal(c.historyIntact, true);
  assert.ok(c.summaryBytes.length >= 1 && c.summaryBytes.length <= 2); assert.equal(c.ordinaryBytes.length, 1);
  assert.ok(c.ordinaryBytes[0] + PRODUCT_LIMITS.outputReserve + PRODUCT_LIMITS.safetyMargin <= PRODUCT_LIMITS.contextBytes);

	return m as Manifest;
}
export async function readManifest(directory: string) {
	const text = await readBounded(directory + "/manifest.json"); return { manifest: validateManifest(JSON.parse(text)), manifestSha256: sha256(text) };
}
export function authorize(manifest: Manifest, sha: string, approval: unknown, now = Date.now()) {
	validateManifest(manifest); hash(sha); assert.equal(approval, `${sha}\n${ACK}`, "S4L_APPROVAL_REQUIRED");
	assert.equal(manifest.mode, "live", "S4L_DRY_NOT_AUTHORIZABLE"); assert.equal(sha256(JSON.stringify(manifest, null, 2) + "\n"), sha, "S4L_MANIFEST_DRIFT");
	assert.equal(manifest.schemaVersion, SCHEMA_VERSION, "S4L_LEGACY_READ_ONLY");
	assert.ok(Number.isFinite(now) && now >= Date.parse(manifest.createdAt) && now < Date.parse(manifest.expiresAt), "S4L_APPROVAL_EXPIRED");
}


export function validatePrepared(value: unknown): Prepared {
  const r = exact(value, ["extensionSha256", "toolsSha256", "systemSha256", "promptSha256", "seedSha256", "wire"]);
  validateSdkPrepared(Object.fromEntries(["extensionSha256", "toolsSha256", "systemSha256", "promptSha256"].map(k => [k, r[k]]))); hash(r.seedSha256);
  const w = exact(r.wire, ["beforeBytes", "afterTrimBytes", "beforeSha256", "afterTrimSha256", "trimmed"]);
  count(w.beforeBytes, LIMITS.maxInputBytes); count(w.afterTrimBytes, w.beforeBytes); count(w.trimmed, 16); hash(w.beforeSha256); hash(w.afterTrimSha256);
  return r as Prepared;
}
export function validateCalibration(value: unknown): Calibration {
  const c = exact(value, ["summaryBytes", "ordinaryBytes", "compactions", "historyIntact"]); count(c.compactions, 1); assert.equal(typeof c.historyIntact, "boolean");
  for (const k of ["summaryBytes", "ordinaryBytes"]) { assert.ok(Array.isArray(c[k]) && c[k].length <= 2); for (const n of c[k]) count(n, LIMITS.maxInputBytes); }
  return c as Calibration;
}
