import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInside, digest, sha256, treeManifest, writeOnce } from "../../evals/core/io.js";
import { PROFILES, SETTINGS } from "../../evals/sdk-supervision/policy.js";
import { runBatch, runScenario, snapshot } from "../../evals/sdk-supervision/runner.js";
import { expected, policy, rebuild, validateManifest, validateRecord } from "../../evals/sdk-supervision/records.js";

export async function runTests() {
  let checks = 0;
  const check = (fn: () => void) => { fn(); checks++; };
  const buildInputs = JSON.parse(await readFile(process.env.PI_S4_BUILD_INPUTS!, "utf8"));
  check(() => assert.ok(buildInputs["evals/adapters/snapshots/context-maintenance.ts"]));
  check(() => assert.equal(buildInputs["src/extensions/context-maintenance.ts"], undefined));
  const root = path.resolve("artifacts/harness/sdk-supervision"); await mkdir(root, { recursive: true });
  const faults = await mkdtemp(path.join(root, "s4-fault-tests-"));
  const initial = await snapshot();
  await writeOnce(path.join(faults, "manifest.json"), { schemaVersion: 1, kind: "s4-offline-fault-tests", code: initial.sources, codeSha256: digest(initial.sources), policy: policy(), fixture: initial.fixture });
  const faultResults = [];
  for (const scenario of ["summary-error", "summary-cancel", "summary-too-large", "maintenance-disabled", "supervisor-persistence"] as const) {
    const task = scenario === "supervisor-persistence" ? "verified-stop" : "compact-fallback";
    const e = await runScenario("sdk-b3-s4-supervisor-maintenance", task, scenario);
    await writeOnce(path.join(faults, scenario + ".json"), { scenario, task, settings: { ...SETTINGS, compaction: { ...SETTINGS.compaction, enabled: scenario !== "maintenance-disabled" } }, evidence: e });
    check(() => assert.ok(e.inventory && e.settings && e.boundary && e.zeroNetwork && e.historyIntact));
    check(() => assert.equal(e.tools + e.writes + e.verifications, 0));
    check(() => assert.equal(e.finalReady, false)); check(() => assert.equal(e.finalFileSha256, null));
    check(() => assert.equal(e.automaticCompactions, 0)); check(() => assert.equal(e.fromHook, false));
    if (scenario === "supervisor-persistence") {
      check(() => assert.equal(e.supervisor?.state, "FAILED")); check(() => assert.equal(e.supervisor?.reasonCode, "SUPERVISOR_PERSISTENCE"));
      check(() => assert.equal(e.persisted, false)); check(() => assert.equal(e.metrics.snapshots, 0));
      check(() => assert.ok(e.receipts.every(r => r.disposition === "aborted" && r.outcome === "aborted")));
      check(() => assert.equal(e.metrics.compactAttempts, 0));
    } else if (scenario === "maintenance-disabled") {
      check(() => assert.equal(e.metrics.compactAttempts, 0)); check(() => assert.equal(e.compactions, 0));
      check(() => assert.equal(e.budgetBlocks, 1)); check(() => assert.equal(e.currentInputCopies, 1));
      check(() => assert.equal(e.receipts.length, 1)); check(() => assert.equal(e.receipts[0].disposition, "product-blocked"));
    } else {
      const failed = scenario !== "summary-too-large";
      check(() => assert.equal(e.compactionStarts, 1)); check(() => assert.equal(e.metrics.compactAttempts, 1));
      check(() => assert.equal(e.compactions, failed ? 0 : 1)); check(() => assert.equal(e.metrics.compactErrors, failed ? 1 : 0));
      check(() => assert.equal(e.compactionErrors, failed ? 1 : 0)); check(() => assert.equal(e.metrics.handledInputs, 1));
      check(() => assert.equal(e.restoredInput, true)); check(() => assert.equal(e.currentInputCopies, 0));
      check(() => assert.equal(e.receipts.length, 1));
      check(() => assert.ok(e.receipts.every(r => r.kind === "summary" && r.currentInputCopies === 0 && r.disposition === "dispatched" && r.outcome === (scenario === "summary-error" ? "error" : scenario === "summary-cancel" ? "aborted" : "complete"))));
      check(() => assert.equal(e.supervisor, null));
    }
    faultResults.push({ scenario, status: "pass" });
  }
  check(() => assert.ok(faultResults.length === 5)); const finalSnapshot = await snapshot(); check(() => assert.deepEqual(finalSnapshot, initial));
  await writeOnce(path.join(faults, "summary.json"), { schemaVersion: 1, kind: "s4-offline-fault-tests", realHttpDispatches: 0, results: faultResults, files: await treeManifest(faults) });
  const batch = await runBatch();
  check(() => assert.equal(batch.aggregate.status, "expected-contrast"));
  check(() => assert.deepEqual(batch.aggregate.counts, { pass: 27, fail: 18, unknown: 0, blocked: 0 }));
  for (const row of batch.aggregate.rows) check(() => assert.ok(expected(row.run, row)));
  const files = await treeManifest(batch.directory), rebuilt = await rebuild(batch.directory);
  check(() => assert.deepEqual(rebuilt, batch.aggregate)); const filesAfter = await treeManifest(batch.directory); check(() => assert.deepEqual(files, filesAfter));
  const manifestText = await readFile(path.join(batch.directory, "manifest.json"), "utf8"), manifest = validateManifest(JSON.parse(manifestText)), manifestSha256 = sha256(manifestText);
  check(() => assert.notEqual(manifest.extensions[PROFILES[0]], manifest.extensions[PROFILES[1]]));
  check(() => assert.notEqual(manifest.extensions[PROFILES[1]], manifest.extensions[PROFILES[2]]));
  for (const mutate of [(v: any) => v.extra = true, (v: any) => v.runs.reverse(), (v: any) => v.policy.limits.contextBytes++, (v: any) => v.policy.factoryProvenance.commit = "0".repeat(40), (v: any) => v.code.sha256 = "0".repeat(64)]) {
    const m = structuredClone(manifest); mutate(m); check(() => assert.throws(() => validateManifest(m)));
  }
  for (const task of ["verified-stop", "unchanged-verification", "unverified-stop", "trim-fit", "compact-fallback"]) {
    const run = manifest.runs.find(r => r.profile === PROFILES[2] && r.task === task)!;
    const original = JSON.parse(await readFile(path.join(batch.directory, "raw", run.runId + ".json"), "utf8"));
    const mutations = [(r: any) => r.extra = "unexpected", (r: any) => r.evidence.zeroNetwork = false, (r: any) => r.evidence.historyIntact = false,
      (r: any) => r.evidence.currentInputCopies = 2, (r: any) => r.evidence.extensionSha256 = "0".repeat(64), (r: any) => r.evidence.receipts[0].extra = "unexpected",
      (r: any) => r.evidence.supervisor.userAccepted = true, (r: any) => r.evidence.seedSha256 = sha256("wrong")];
    if (task === "compact-fallback") mutations.push(r => r.evidence.compactions = 0, r => r.evidence.fromHook = true);
    if (task === "trim-fit") mutations.push(r => r.evidence.metrics.contextTrimmed = 0);
    if (task === "unchanged-verification") mutations.push(r => r.evidence.receipts.at(-1).disposition = "dispatched");
    for (const mutate of mutations) { const row = structuredClone(original); mutate(row); check(() => assert.throws(() => validateRecord(row, run, manifest, manifestSha256))); }
    // Unknown is not silently promoted by a passing evidence-shaped object.
    const unknown = { ...original, status: "unknown", reason: "WORKER_UNKNOWN", sourceStable: false, evidence: null };
    check(() => assert.equal(validateRecord(unknown, run, manifest, manifestSha256).status, "unknown"));
  }
  const temp = await mkdtemp(path.join(process.env.PI_S4_WORK_ROOT!, "tamper-"));
  try {
    await cp(batch.directory, temp, { recursive: true }); const filename = path.join(temp, "index.json"), text = await readFile(filename, "utf8");
    for (const mutate of [(v: any) => v.entries.pop(), (v: any) => v.entries.reverse(), (v: any) => v.entries[0].file = "../outside", (v: any) => v.entries[0].sha256 = "0".repeat(64), (v: any) => v.entries[1] = v.entries[0]]) {
      const index = JSON.parse(text); mutate(index); await writeFile(filename, JSON.stringify(index)); await assert.rejects(rebuild(temp)); checks++;
    }
    await writeFile(filename, text); await writeFile(path.join(temp, "raw/extra.json"), "{}"); await assert.rejects(rebuild(temp)); checks++;
  } finally { await assertInside(process.env.PI_S4_WORK_ROOT!, temp); await rm(temp, { recursive: true, force: true, maxRetries: 3 }); }
  return { checks, directory: batch.directory, faults, counts: batch.aggregate.counts };
}
