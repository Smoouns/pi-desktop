import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest, sha256, writeOnce } from "../../evals/core/io.js";
import { type Catalog } from "../../evals/report/catalog.js";
import { projectAggregate } from "../../evals/report/project.js";
import { createReport, inspectBatch, inventory, markdown, verifyPackage, writePackage } from "../../evals/report/report.js";
import { rebuild, policy } from "../../evals/sdk-supervision/records.js";
import { FEATURES, PROFILES, expectedStatus, plan } from "../../evals/sdk-supervision/policy.js";

/** Public report records only. Never create a session or run the synthetic API. */
export async function runSupervisionTests(root: string, builder: Record<string, string>) {
  let checks = 0;
  const check = (fn: () => void) => { fn(); checks++; };
  const rows = plan().map(run => {
    const status = expectedStatus(run.profile, run.task), features = FEATURES[run.profile];
    const businessOutcome = run.task === "verified-stop" ? "verified-public-candidate"
      : run.task === "unchanged-verification" ? features.supervisor ? "no-progress-stopped" : "unverified-final-answer"
      : run.task === "unverified-stop" ? features.supervisor ? "verification-required" : "unverified-final-answer"
      : features.maintenance ? "read-only-answer" : "budget-blocked";
    return { run, status, reason: status === "pass" ? "PASS" : ["trim-fit", "compact-fallback"].includes(run.task) ? "MISSING_MAINTENANCE" : "MISSING_SUPERVISOR", businessOutcome, userAccepted: false };
  });
  const aggregate = { realHttpDispatches: 0, providerUsage: { synthetic: 999 }, rows };
  const projected = projectAggregate("sdk-supervision", aggregate, {});
  check(() => assert.equal(projected.samples, 45)); check(() => assert.equal(projected.groups.length, 15));
  check(() => assert.equal(projected.statuses.pass, 27)); check(() => assert.equal(projected.statuses.fail, 18));
  check(() => assert.equal(projected.providerActualUsage, null)); check(() => assert.equal(projected.actualCostUsd, null));
  check(() => assert.equal(projected.evidenceKind, "synthetic-sdk")); check(() => assert.equal(projected.realHttpDispatches, 0));
  const sum = (outcome: string) => projected.groups.reduce((n, g) => n + (g.businessOutcomes[outcome] ?? 0), 0);
  for (const [key, n] of Object.entries({ "verified-public-candidate": 9, "read-only-answer": 6, "no-progress-stopped": 6,
    "verification-required": 6, "budget-blocked": 12, "unverified-final-answer": 6 })) check(() => assert.equal(sum(key), n));
  check(() => assert.ok(projected.groups.every(g => Object.keys(g.operationOutcomes).length === 0)));
  for (const change of [(r: any) => r.userAccepted = true, (r: any) => delete r.userAccepted, (r: any) => r.businessOutcome = "approved", (r: any) => delete r.businessOutcome]) {
    const altered = structuredClone(aggregate); change(altered.rows[0]); check(() => assert.throws(() => projectAggregate("sdk-supervision", altered, {})));
  }

  const relative = "artifacts/harness/sdk-supervision/s4-offline-report-fixture", directory = path.join(root, relative);
  await mkdir(path.join(directory, "raw"), { recursive: true });
  const sources = { "tests/report/synthetic-s4.ts": sha256("synthetic-report-only") };
  const manifest = { schemaVersion: 1, kind: "sdk-supervision-offline", batchId: "s4-offline-report-fixture", createdAt: "2026-09-23T00:00:00.000Z",
    code: { commit: "a".repeat(40), dirty: true, files: sources, sha256: digest(sources) }, fixture: sources,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, sdk: "0.63.1" }, policy: policy(),
    extensions: Object.fromEntries(PROFILES.map(p => [p, sha256(p + "-report-fixture")])), runs: plan() };
  await writeOnce(path.join(directory, "manifest.json"), manifest);
  const manifestSha256 = sha256(await readFile(path.join(directory, "manifest.json"))), entries = [];
  for (const [i, run] of manifest.runs.entries()) {
    const file = "raw/" + run.runId + ".json";
    await writeOnce(path.join(directory, file), { schemaVersion: 1, manifestSha256, run, status: i === 0 ? "unknown" : "blocked",
      reason: i === 0 ? "WORKER_UNKNOWN" : "BATCH_STOPPED", sourceStable: false, evidence: null });
    entries.push({ runId: run.runId, file, sha256: sha256(await readFile(path.join(directory, file))) });
  }
  await writeOnce(path.join(directory, "index.json"), { schemaVersion: 1, manifestSha256, entries });
  await writeOnce(path.join(directory, "aggregate.json"), await rebuild(directory));
  const selection: Catalog = { schemaVersion: 1, kind: "phase5-evidence-selection", entries: [{ id: "synthetic-supervision", family: "sdk-supervision", directory: relative,
    manifestSha256, treeSha256: digest(await inventory(directory)) }] };
  const before = await inventory(directory), result = await createReport(root, selection, builder), batch = result.batches[0];
  check(() => assert.equal(result.verifiedBatches, 1)); assert.equal(batch.integrity, "verified");
  check(() => assert.equal(batch.summary.statuses.pass, 0)); check(() => assert.equal(batch.summary.statuses.unknown, 1));
  check(() => assert.equal(batch.summary.statuses.blocked, 44));
  check(() => assert.equal(batch.summary.groups.reduce((n, g) => n + (g.businessOutcomes.unobserved ?? 0), 0), 45));
  check(() => assert.ok(markdown(result).includes("机械合同 pass=0")));
  check(() => assert.ok(markdown(result).includes("未观测 45")));
  const rendered = markdown({ ...result, batches: [{ ...batch, summary: projected }] });
  check(() => assert.ok(rendered.includes("机械合同 pass=27")));
  check(() => assert.ok(rendered.includes("公开候选已验证 9，只读答复 6，无进展停止 6，等待验证 6，预算阻断 12，未验证最终答案 6，未观测 0")));
  check(() => assert.ok(rendered.includes("没有任何一项代表人工验收或 Canon 晋升")));
  check(() => assert.ok(!rendered.includes("独立对照尚未执行")));
  check(() => assert.ok(rendered.includes("独立业务结局")));
  const packaged = await writePackage(root, selection, builder), verified = await verifyPackage(root, packaged.directory, builder);
  check(() => assert.equal(verified.verifiedBatches, 1));
  const after = await inventory(directory); check(() => assert.deepEqual(after, before));
  const saved = path.join(directory, "aggregate.json"), text = await readFile(saved, "utf8"), fake = JSON.parse(text);
  fake.rows[0].businessOutcome = "verified-public-candidate";
  await writeFile(saved, JSON.stringify(fake));
  const invalid = await inspectBatch(root, { ...selection.entries[0], treeSha256: digest(await inventory(directory)) });
  check(() => assert.equal(invalid.problem, "REPORT_AGGREGATE_MISMATCH"));
  await writeFile(saved, text);
  const final = await inventory(directory); check(() => assert.deepEqual(final, before));
  return checks;
}
