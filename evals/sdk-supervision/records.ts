import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createRunSupervisor } from "../../src/harness/run-supervisor.js";
import { digest, readBounded, sha256, treeManifest } from "../core/io.js";
import { exact, count, hash } from "../sdk-context/records.js";
import { FEATURES, LIMITS, MODEL, PROFILES, PROMPTS, SETTINGS, SUPERVISOR_LIMITS, VALID, INVALID, emptyMetrics, expectedStatus, plan, type Run } from "./policy.js";
import { seedMessages, type Evidence } from "./session.js";
import provenance from "./provenance.json";

export const policy = () => ({ driver: "sdk-supervision-offline-v1", profiles: FEATURES, limits: LIMITS, supervisorLimits: SUPERVISOR_LIMITS, settings: SETTINGS,
  model: MODEL, factoryProvenance: provenance, promptSha256: digest(PROMPTS), verifier: "public-marker-only-not-novel-verifier",
  seed: "synthetic-public-history-not-model-generated", compaction: "input-policy-trim-then-native-manual-sdk-compaction", realHttpDispatches: 0, providerUsage: null, costUsd: null });
export interface Manifest { schemaVersion: 1; kind: "sdk-supervision-offline"; batchId: string; createdAt: string;
  code: { commit: string; dirty: boolean; files: Record<string, string>; sha256: string }; fixture: Record<string, string>;
  runtime: { node: string; platform: string; arch: string; sdk: string }; policy: ReturnType<typeof policy>; extensions: Record<string, string>; runs: Run[]; }
export interface RecordRow { schemaVersion: 1; manifestSha256: string; run: Run; status: "pass" | "fail" | "unknown" | "blocked";
  reason: "PASS" | "MISSING_SUPERVISOR" | "MISSING_MAINTENANCE" | "CONTRACT_FAILED" | "WORKER_UNKNOWN" | "BATCH_STOPPED"; sourceStable: boolean; evidence: Evidence | null; }
const flags = (v: any, keys: string[]) => keys.forEach(k => assert.equal(typeof v[k], "boolean"));
const fileMap = (v: any) => {
  assert.ok(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).length < 4096);
  for (const [name, h] of Object.entries(v)) { assert.ok(name.length < 512 && !/[\\:\x00-\x1f]/.test(name) && !name.split("/").some(p => !p || p === "." || p === "..")); hash(h); }
};
export function validateManifest(value: unknown): Manifest {
  const m = exact(value, ["schemaVersion", "kind", "batchId", "createdAt", "code", "fixture", "runtime", "policy", "extensions", "runs"]);
  assert.equal(m.schemaVersion, 1); assert.equal(m.kind, "sdk-supervision-offline"); assert.match(m.batchId, /^s4-offline-[A-Za-z0-9_-]+$/); assert.equal(new Date(m.createdAt).toISOString(), m.createdAt);
  exact(m.code, ["commit", "dirty", "files", "sha256"]); assert.match(m.code.commit, /^[a-f0-9]{40}$/); assert.equal(typeof m.code.dirty, "boolean"); fileMap(m.code.files); assert.equal(digest(m.code.files), m.code.sha256);
  fileMap(m.fixture); exact(m.runtime, ["node", "platform", "arch", "sdk"]); Object.values(m.runtime).forEach(v => assert.match(v as string, /^[A-Za-z0-9_.-]{1,64}$/)); assert.equal(m.runtime.sdk, "0.63.1");
  assert.deepEqual(m.policy, policy()); exact(m.extensions, [...PROFILES]); Object.values(m.extensions).forEach(hash); assert.deepEqual(m.runs, plan()); return m;
}
export function validateEvidence(value: unknown): Evidence {
  const e = exact(value, ["inventory", "settings", "boundary", "zeroNetwork", "historyIntact", "persisted", "metrics", "budgetBlocks", "intents", "operationResults", "tools", "writes", "verifications", "receipts",
    "compactions", "compactionStarts", "compactionErrors", "fromHook", "automaticCompactions", "currentInputCopies", "restoredInput", "finalReady", "finalFileSha256", "supervisor", "extensionSha256", "toolSchemaSha256", "promptSha256", "seedSha256"]);
  flags(e, ["inventory", "settings", "boundary", "zeroNetwork", "historyIntact", "persisted", "fromHook", "restoredInput", "finalReady"]);
  for (const k of ["budgetBlocks", "intents", "operationResults", "tools", "writes", "verifications", "compactions", "compactionStarts", "compactionErrors", "automaticCompactions", "currentInputCopies"]) count(e[k], 32);
  exact(e.metrics, Object.keys(emptyMetrics())); flags(e.metrics, ["contextUnmodified"]);
  for (const k of Object.keys(emptyMetrics()).filter(k => k !== "contextUnmodified")) count(e.metrics[k], k.startsWith("projected") ? 1024 * 1024 : 256);
  for (const k of ["extensionSha256", "toolSchemaSha256", "promptSha256", "seedSha256"]) hash(e[k]);
  if (e.finalFileSha256 !== null) hash(e.finalFileSha256);
  if (e.supervisor !== null) createRunSupervisor({ digest: sha256 }).parse(e.supervisor);
  assert.ok(Array.isArray(e.receipts) && e.receipts.length <= LIMITS.requests + 1);
  for (const row of e.receipts) {
    exact(row, ["kind", "payloadBytes", "outputReserve", "payloadSha256", "disposition", "outcome", "currentInputCopies"]);
    assert.ok(["agent", "summary"].includes(row.kind)); count(row.payloadBytes, 1024 * 1024); count(row.outputReserve, 65536); hash(row.payloadSha256); count(row.currentInputCopies, 32);
    assert.ok(["dispatched", "product-blocked", "outer-blocked", "aborted"].includes(row.disposition)); assert.ok(["complete", "error", "aborted"].includes(row.outcome));
    if (row.disposition !== "dispatched") assert.notEqual(row.outcome, "complete");
  }
  return e;
}
export function contract(run: Run, e: Evidence): boolean {
  const sup = FEATURES[run.profile].supervisor, maintenance = FEATURES[run.profile].maintenance, state = e.supervisor, m = e.metrics;
  const historyTask = ["trim-fit", "compact-fallback"].includes(run.task), compact = run.task === "compact-fallback" && maintenance;
  if (![e.inventory, e.settings, e.boundary, e.zeroNetwork, e.historyIntact, e.persisted, m.contextUnmodified].every(Boolean) || e.fromHook || e.automaticCompactions || e.restoredInput || e.compactionErrors) return false;
  if (e.promptSha256 !== digest(PROMPTS[run.task]) || e.seedSha256 !== digest(seedMessages(run.task)) || e.currentInputCopies !== 1 || e.tools > LIMITS.tools || e.receipts.length > LIMITS.requests) return false;
  if (sup !== (state !== null) || m.supervisorStarts !== (sup ? 1 : 0) || m.maintenanceInputs !== (maintenance ? 1 : 0) || m.handledInputs || m.compactErrors || m.toolBlocks) return false;
  if (!sup && [m.snapshots, m.verificationEvents, m.terminalFences].some(Boolean)) return false;
  if (!maintenance && [m.preflightTrimmed, m.contextTrimmed, m.compactAttempts, m.projectedBefore, m.projectedAfter].some(Boolean)) return false;
  if (sup && (!m.snapshots || state!.userAccepted || state!.verificationAttempts !== e.verifications || state!.toolCalls !== e.tools)) return false;
  const blocked = historyTask && !maintenance;
  if (e.budgetBlocks !== (blocked ? 1 : 0) || e.compactions !== (compact ? 1 : 0) || e.compactionStarts !== (compact ? 1 : 0) || m.compactAttempts !== (compact ? 1 : 0)) return false;
  const agents = e.receipts.filter(r => r.kind === "agent"), summaries = e.receipts.filter(r => r.kind === "summary");
  const terminalAbort = sup && run.task === "unchanged-verification";
  // SDK event delivery is queued: one already-scheduled continuation can enter
  // the API with an aborted signal. It must never dispatch/produce a reply.
  if (summaries.length !== (compact ? 1 : 0) || agents.length !== (historyTask ? 1 : run.task === "unverified-stop" ? 3 : run.task === "verified-stop" ? 4 : sup ? 6 : 9)) return false;
  if (!e.receipts.every(r => r.payloadBytes + r.outputReserve + LIMITS.safety <= LIMITS.outerBytes
    && r.disposition === (blocked && r.kind === "agent" ? "product-blocked" : terminalAbort && r === agents.at(-1) ? "aborted" : "dispatched")
    && r.outcome === (blocked && r.kind === "agent" || terminalAbort && r === agents.at(-1) ? "aborted" : "complete"))) return false;
  if (!agents.every(r => r.currentInputCopies === (historyTask ? 1 : 0) && (blocked || r.payloadBytes + LIMITS.reserve + LIMITS.safety <= LIMITS.contextBytes)) || !summaries.every(r => r.currentInputCopies === 0)) return false;
  if (historyTask) {
    if (e.tools || e.writes || e.verifications || e.intents || e.operationResults || e.finalFileSha256 !== null || e.finalReady !== maintenance) return false;
    if (maintenance && (m.projectedBefore <= LIMITS.contextBytes || m.projectedAfter > LIMITS.contextBytes)) return false;
    if (run.task === "trim-fit" && maintenance && (m.preflightTrimmed !== 1 || m.contextTrimmed !== 1) || run.task === "compact-fallback" && (m.preflightTrimmed || m.contextTrimmed)) return false;
    return !sup || state!.state === (maintenance ? "COMPLETED_CANDIDATE" : "CANCELLED") && state!.reasonCode === (maintenance ? "STOP_VERIFIED" : "ABORTED");
  }
  const loops = run.task === "unchanged-verification", verifications = loops ? sup ? 3 : 6 : run.task === "verified-stop" ? 1 : 0;
  if (e.writes !== 1 || e.intents !== 1 || e.operationResults !== 1 || e.tools !== 2 + verifications || e.verifications !== verifications || e.finalFileSha256 !== sha256(loops ? INVALID : VALID) || e.finalReady !== !(loops && sup)) return false;
  if (!sup) return true;
  if (m.verificationEvents !== verifications) return false;
  const expected = loops ? ["NO_PROGRESS", "UNCHANGED_VERIFICATION"] : run.task === "unverified-stop" ? ["BLOCKED_PREREQUISITE", "COMPLETION_NOT_VERIFIED"] : ["COMPLETED_CANDIDATE", "STOP_VERIFIED"];
  return state!.state === expected[0] && state!.reasonCode === expected[1] && m.terminalFences === (loops ? 2 : 0);
}
export function judge(run: Run, e: Evidence): Pick<RecordRow, "status" | "reason"> {
  if (!contract(run, e)) return { status: "fail", reason: "CONTRACT_FAILED" };
  if (expectedStatus(run.profile, run.task) === "pass") return { status: "pass", reason: "PASS" };
  return { status: "fail", reason: ["trim-fit", "compact-fallback"].includes(run.task) ? "MISSING_MAINTENANCE" : "MISSING_SUPERVISOR" };
}
export function expected(run: Run, row: Pick<RecordRow, "status" | "reason">) {
  const status = expectedStatus(run.profile, run.task);
  const reason = status === "pass" ? "PASS" : ["trim-fit", "compact-fallback"].includes(run.task) ? "MISSING_MAINTENANCE" : "MISSING_SUPERVISOR";
  return row.status === status && row.reason === reason;
}
export function validateRecord(value: unknown, run: Run, manifest: Manifest, manifestSha256: string): RecordRow {
  const r = exact(value, ["schemaVersion", "manifestSha256", "run", "status", "reason", "sourceStable", "evidence"]);
  assert.equal(r.schemaVersion, 1); assert.equal(r.manifestSha256, manifestSha256); assert.deepEqual(r.run, run); assert.equal(typeof r.sourceStable, "boolean"); assert.ok(["pass", "fail", "unknown", "blocked"].includes(r.status));
  if (r.evidence !== null) { validateEvidence(r.evidence); assert.equal(r.evidence.extensionSha256, manifest.extensions[run.profile]); }
  if (["pass", "fail"].includes(r.status)) { assert.equal(r.sourceStable, true); assert.ok(r.evidence); assert.deepEqual({ status: r.status, reason: r.reason }, judge(run, r.evidence)); }
  else { assert.equal(r.reason, r.status === "unknown" ? "WORKER_UNKNOWN" : "BATCH_STOPPED"); assert.equal(r.evidence, null); assert.equal(r.sourceStable, false); }
  return r;
}
export async function rebuild(directory: string) {
  const manifestText = await readBounded(path.join(directory, "manifest.json")), m = validateManifest(JSON.parse(manifestText)), manifestSha256 = sha256(manifestText), files = await treeManifest(directory);
  assert.deepEqual((await readdir(directory)).sort(), ["aggregate.json", "index.json", "manifest.json", "raw"].filter(n => n !== "aggregate.json" || n in files).sort());
  const index = exact(JSON.parse(await readBounded(path.join(directory, "index.json"))), ["schemaVersion", "manifestSha256", "entries"]);
  assert.equal(index.schemaVersion, 1); assert.equal(index.manifestSha256, manifestSha256); assert.equal(index.entries.length, m.runs.length);
  const rows: Array<{ run: Run; status: RecordRow["status"]; reason: RecordRow["reason"]; businessOutcome: string; userAccepted: false; tools: number | null; verifications: number | null; nativeCompactions: number | null; trimmed: number | null }> = [];
  let stopped = false, schemaHash: string | null = null;
  for (let i = 0; i < m.runs.length; i++) {
    const run = m.runs[i], item = exact(index.entries[i], ["runId", "file", "sha256"]);
    assert.equal(item.runId, run.runId); assert.equal(item.file, `raw/${run.runId}.json`); assert.equal(item.sha256, files[item.file]);
    const row = validateRecord(JSON.parse(await readBounded(path.join(directory, item.file))), run, m, manifestSha256);
    if (stopped) assert.equal(row.status, "blocked"); else assert.notEqual(row.status, "blocked"); if (!expected(run, row)) stopped = true;
    const e = row.evidence;
    if (e) { schemaHash ??= e.toolSchemaSha256; assert.equal(e.toolSchemaSha256, schemaHash, "S4_TOOL_SCHEMA_DRIFT"); }
    rows.push({ run, status: row.status, reason: row.reason, businessOutcome: !e || !contract(run, e) ? "unobserved" : e.supervisor?.state === "NO_PROGRESS" ? "no-progress-stopped"
      : e.supervisor?.state === "BLOCKED_PREREQUISITE" ? "verification-required" : e.budgetBlocks ? "budget-blocked" : run.task === "unchanged-verification" || run.task === "unverified-stop" ? "unverified-final-answer" : run.task === "verified-stop" ? "verified-public-candidate" : "read-only-answer",
      userAccepted: false, tools: e?.tools ?? null, verifications: e?.verifications ?? null, nativeCompactions: e?.compactions ?? null, trimmed: e?.metrics.contextTrimmed ?? null });
  }
  assert.deepEqual(Object.keys(files).sort(), ["manifest.json", "index.json", ...("aggregate.json" in files ? ["aggregate.json"] : []), ...index.entries.map((e: any) => e.file)].sort());
  return { schemaVersion: 1, kind: "sdk-supervision-aggregate", manifestSha256, status: stopped ? "incomplete" : "expected-contrast", realHttpDispatches: 0, providerUsage: null, costUsd: null,
    counts: Object.fromEntries(["pass", "fail", "unknown", "blocked"].map(s => [s, rows.filter(r => r.status === s).length])), rows };
}
