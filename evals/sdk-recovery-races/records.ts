import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { digest, readBounded, sha256, treeManifest } from "../core/io.js";
import { exact, count, hash } from "../sdk-context/records.js";
import { CONTENT, PARTIAL, PROFILE, LIMITS, PROMPTS, SETTINGS, plan, type Evidence, type Run, type Seed, type Resume } from "./policy.js";

export const policy = () => ({ profile: PROFILE, driver: "sdk-process-kill-barriers-v1", limits: LIMITS, settings: SETTINGS, promptSha256: digest(PROMPTS),
  effects: "public-temporary-fixture-only", compaction: "not-tested", realHttpDispatches: 0, providerUsage: null, costUsd: null });
export interface Manifest { schemaVersion: 1; kind: "sdk-recovery-races-offline"; batchId: string; createdAt: string;
  code: { commit: string; dirty: boolean; files: Record<string, string>; sha256: string }; fixture: Record<string, string>;
  runtime: { node: string; platform: string; arch: string; sdk: string }; policy: ReturnType<typeof policy>; extensionSha256: string; runs: Run[]; }
export interface RecordRow { schemaVersion: 1; manifestSha256: string; run: Run; status: "pass" | "fail" | "unknown" | "blocked"; reason: "PASS" | "CONTRACT_FAILED" | "WORKER_UNKNOWN" | "BATCH_STOPPED"; evidence: Evidence | null; }
const flags = (v: any, keys: string[]) => keys.forEach(k => assert.equal(typeof v[k], "boolean"));
const nullableHash = (v: unknown) => { if (v !== null) hash(v); };
const fileMap = (v: any) => {
  assert.ok(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).length < 4096);
  for (const [name, h] of Object.entries(v)) { assert.ok(name.length < 512 && !/[\\:\x00-\x1f]/.test(name) && !name.split("/").some(p => !p || p === "." || p === "..")); hash(h); }
};
export function validateManifest(value: unknown): Manifest {
  const m = exact(value, ["schemaVersion", "kind", "batchId", "createdAt", "code", "fixture", "runtime", "policy", "extensionSha256", "runs"]);
  assert.equal(m.schemaVersion, 1); assert.equal(m.kind, "sdk-recovery-races-offline"); assert.match(m.batchId, /^s3-races-[A-Za-z0-9_-]+$/); assert.equal(new Date(m.createdAt).toISOString(), m.createdAt);
  exact(m.code, ["commit", "dirty", "files", "sha256"]); assert.match(m.code.commit, /^[a-f0-9]{40}$/); assert.equal(typeof m.code.dirty, "boolean"); fileMap(m.code.files); assert.equal(digest(m.code.files), m.code.sha256);
  fileMap(m.fixture); exact(m.runtime, ["node", "platform", "arch", "sdk"]); Object.values(m.runtime).forEach(v => assert.match(v as string, /^[A-Za-z0-9_.-]{1,64}$/)); assert.equal(m.runtime.sdk, "0.63.1");
  assert.deepEqual(m.policy, policy()); hash(m.extensionSha256); assert.deepEqual(m.runs, plan()); return m;
}
export function validateSeed(value: unknown): Seed {
  const s = exact(value, ["durableIntent", "issued", "dispatched", "inventory", "settings", "zeroNetwork", "targetSha256", "sessionSha256", "checkpointSha256", "providerCalls", "tools", "writes"]);
  flags(s, ["durableIntent", "issued", "dispatched", "inventory", "settings", "zeroNetwork"]);
  nullableHash(s.targetSha256); hash(s.sessionSha256); hash(s.checkpointSha256); for (const k of ["providerCalls", "tools", "writes"]) count(s[k], 16); return s;
}
export function validateResume(value: unknown): Resume {
  const s = exact(value, ["reopened", "inventory", "settings", "boundary", "zeroNetwork", "pendingBefore", "pendingAfter", "targetSha256", "writeDispatches", "replayResults", "refreshes", "providerCalls", "tools", "operationMetrics"]);
  flags(s, ["reopened", "inventory", "settings", "boundary", "zeroNetwork"]);
  for (const k of ["pendingBefore", "pendingAfter"]) assert.ok(["none", "issued", "unknown", "completed"].includes(s[k]));
  nullableHash(s.targetSha256); for (const k of ["writeDispatches", "refreshes", "providerCalls", "tools"]) count(s[k], 16);
  assert.ok(Array.isArray(s.replayResults) && s.replayResults.length <= 4); s.replayResults.forEach((v: unknown) => assert.ok(["success", "reconciled", "unknown", "other-error"].includes(v as string)));
  exact(s.operationMetrics, ["intents", "results", "replayBlocks", "persistenceBlocks", "staleResults"]); Object.values(s.operationMetrics).forEach(n => count(n, 16)); return s;
}
export function validateEvidence(value: unknown): Evidence {
  const e = exact(value, ["seed", "killed", "exited", "gracefulCleanup", "seedDiskVerified", "exitCode", "exitSignal", "resumes", "executorReady", "executorReleasedAfterRecovery", "executorEffects", "boundary", "sourceStable"]);
  flags(e, ["killed", "exited", "gracefulCleanup", "seedDiskVerified", "executorReady", "executorReleasedAfterRecovery", "boundary", "sourceStable"]);
  if (e.seed !== null) validateSeed(e.seed); if (e.exitCode !== null) count(e.exitCode, 0xffffffff); assert.ok([null, "SIGKILL", "SIGTERM"].includes(e.exitSignal));
  assert.ok(Array.isArray(e.resumes) && e.resumes.length <= 2); e.resumes.forEach(validateResume); count(e.executorEffects, 2); return e;
}
export const initialHash = (scenario: Run["scenario"]) => scenario === "after-effect" ? sha256(CONTENT) : scenario === "partial-effect" ? sha256(PARTIAL) : null;
export function passes(run: Run, e: Evidence) {
  const s = e.seed, late = run.scenario === "late-effect";
  if (!s || !s.durableIntent || !s.issued || !s.dispatched || !s.inventory || !s.settings || !s.zeroNetwork || s.writes !== 1 || s.tools !== 2 || s.providerCalls !== 3 || s.targetSha256 !== initialHash(run.scenario)) return false;
  if (!e.killed || !e.exited || e.gracefulCleanup || !e.seedDiskVerified || !(e.exitSignal === "SIGKILL" || e.exitCode !== null && e.exitCode !== 0) || !e.boundary || !e.sourceStable) return false;
  if (e.executorReady !== late || e.executorReleasedAfterRecovery !== late || e.executorEffects !== (late ? 1 : 0) || e.resumes.length !== (late ? 2 : 1)) return false;
  return e.resumes.every((r, i) => {
    const full = run.scenario === "after-effect" || late && i === 1;
    return r.reopened && r.inventory && r.settings && r.boundary && r.zeroNetwork && r.pendingBefore === "issued"
      && r.pendingAfter === (full ? "completed" : "issued") && r.targetSha256 === (full ? sha256(CONTENT) : initialHash(run.scenario))
      && r.writeDispatches === 0 && r.replayResults.length === 2 && r.replayResults.every(v => v === (full ? "reconciled" : "unknown"))
      && r.refreshes === 1 && r.providerCalls === 6 && r.tools === 1 && r.operationMetrics.intents === 0 && r.operationMetrics.results === 0
      && r.operationMetrics.replayBlocks === 2 && r.operationMetrics.persistenceBlocks === 0 && r.operationMetrics.staleResults === 0;
  });
}
export function validateRecord(value: unknown, run: Run, manifestSha256: string): RecordRow {
  const r = exact(value, ["schemaVersion", "manifestSha256", "run", "status", "reason", "evidence"]);
  assert.equal(r.schemaVersion, 1); assert.equal(r.manifestSha256, manifestSha256); assert.deepEqual(r.run, run);
  assert.ok(["pass", "fail", "unknown", "blocked"].includes(r.status));
  if (r.evidence !== null) validateEvidence(r.evidence);
  if (r.status === "pass" || r.status === "fail") { assert.ok(r.evidence?.sourceStable); assert.equal(r.status === "pass", passes(run, r.evidence)); assert.equal(r.reason, r.status === "pass" ? "PASS" : "CONTRACT_FAILED"); }
  else { assert.equal(r.reason, r.status === "blocked" ? "BATCH_STOPPED" : "WORKER_UNKNOWN"); if (r.status === "blocked") assert.equal(r.evidence, null); }
  return r;
}
export async function rebuild(directory: string) {
  const manifestText = await readBounded(path.join(directory, "manifest.json")), m = validateManifest(JSON.parse(manifestText)), manifestSha256 = sha256(manifestText);
  const files = await treeManifest(directory);
  assert.deepEqual((await readdir(directory)).sort(), ["aggregate.json", "index.json", "manifest.json", "raw"].filter(n => n !== "aggregate.json" || n in files).sort());
  const index = exact(JSON.parse(await readBounded(path.join(directory, "index.json"))), ["schemaVersion", "manifestSha256", "entries"]);
  assert.equal(index.schemaVersion, 1); assert.equal(index.manifestSha256, manifestSha256); assert.equal(index.entries.length, m.runs.length);
  const rows = []; let stopped = false;
  for (let i = 0; i < m.runs.length; i++) {
    const run = m.runs[i], item = exact(index.entries[i], ["runId", "file", "sha256"]);
    assert.equal(item.runId, run.runId); assert.equal(item.file, `raw/${run.runId}.json`); assert.equal(item.sha256, files[item.file]);
    const record = validateRecord(JSON.parse(await readBounded(path.join(directory, item.file))), run, manifestSha256);
    if (stopped) assert.equal(record.status, "blocked"); else assert.notEqual(record.status, "blocked"); if (record.status !== "pass") stopped = true;
    const e = record.evidence, last = e?.resumes.at(-1);
    rows.push({ run, status: record.status, reason: record.reason, killed: e?.killed ?? false, reopened: e?.resumes.length ?? 0, resumeWriteDispatches: e ? e.resumes.reduce((n, s) => n + s.writeDispatches, 0) : null,
      operationOutcome: record.status !== "pass" ? "unobserved" : last?.pendingAfter === "completed" ? "satisfied-by-readback" : "unknown-replay-blocked",
      backgroundEffects: e?.executorEffects ?? null });
  }
  assert.deepEqual(Object.keys(files).sort(), ["manifest.json", "index.json", ...("aggregate.json" in files ? ["aggregate.json"] : []), ...index.entries.map((e: any) => e.file)].sort());
  return { schemaVersion: 1, kind: "sdk-recovery-races-aggregate", manifestSha256, status: rows.every(r => r.status === "pass") ? "pass" : "incomplete",
    realHttpDispatches: 0, providerUsage: null, costUsd: null, rows };
}
