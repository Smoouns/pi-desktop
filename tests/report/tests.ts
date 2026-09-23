import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInside, digest, sha256, writeOnce } from "../../evals/core/io.js";
import { catalog, FAMILIES, validateCatalog, type Catalog } from "../../evals/report/catalog.js";
import { emptyStatuses, projectAggregate, sumKnown } from "../../evals/report/project.js";
import { recoverLegacyContext } from "../../evals/report/legacy-context.js";
import { createReport, inspectBatch, inventory, markdown, verifyPackage, writePackage } from "../../evals/report/report.js";
import { rebuild, policy } from "../../evals/sdk-recovery-races/records.js";
import { plan } from "../../evals/sdk-recovery-races/policy.js";
import { runSupervisionTests } from "./supervision.js";
import { runSupervisionLiveTests } from "./supervision-live.js";

// These are synthetic report fixtures, not new SDK/killed-process evidence.
async function unknownFixture(root: string): Promise<Catalog> {
  const relative = "artifacts/harness/sdk-recovery-races/s3-races-report-fixture", directory = path.join(root, relative);
  await mkdir(path.join(directory, "raw"), { recursive: true });
  const sources = { "tests/report/synthetic.ts": sha256("synthetic-report-only") };
  const manifest = { schemaVersion: 1, kind: "sdk-recovery-races-offline", batchId: "s3-races-report-fixture", createdAt: "2026-09-23T00:00:00.000Z",
    code: { commit: "a".repeat(40), dirty: true, files: sources, sha256: digest(sources) }, fixture: sources,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, sdk: "0.63.1" },
    policy: policy(), extensionSha256: sha256("synthetic-extension"), runs: plan() };
  await writeOnce(path.join(directory, "manifest.json"), manifest);
  const manifestSha256 = sha256(await readFile(path.join(directory, "manifest.json")));
  const entries = [];
  for (const [i, run] of manifest.runs.entries()) {
    const file = "raw/" + run.runId + ".json";
    await writeOnce(path.join(directory, file), { schemaVersion: 1, manifestSha256, run, status: i === 0 ? "unknown" : "blocked",
      reason: i === 0 ? "WORKER_UNKNOWN" : "BATCH_STOPPED", evidence: null });
    entries.push({ runId: run.runId, file, sha256: sha256(await readFile(path.join(directory, file))) });
  }
  await writeOnce(path.join(directory, "index.json"), { schemaVersion: 1, manifestSha256, entries });
  await writeOnce(path.join(directory, "aggregate.json"), await rebuild(directory));
  return { schemaVersion: 1, kind: "phase5-evidence-selection", entries: [{ id: "synthetic-unknown", family: "sdk-recovery", directory: relative,
    manifestSha256, treeSha256: digest(await inventory(directory)) }] };
}

export async function runTests(builder: Record<string, string>) {
  let checks = 0;
  const check = (fn: () => void) => { fn(); checks++; };
  const reject = async (fn: () => Promise<unknown>) => { await assert.rejects(fn); checks++; };
  const root = await mkdtemp(path.join(process.env.PI_REPORT_WORK!, "fixture-"));
  try {
    check(() => assert.equal(validateCatalog(catalog).entries.length, 15));
    check(() => assert.deepEqual(catalog.entries.filter(e => e.family === "sdk-supervision-live").map(e => e.id), ["s4-live-first-incomplete", "s4-live-8x72"]));
    for (const mutate of [
      (c: Catalog) => { c.entries.push({ ...c.entries[0] }); },
      (c: Catalog) => { c.entries[0].directory = "../private"; },
      (c: Catalog) => { c.entries[0].directory = "C:/private"; },
      (c: Catalog) => { c.entries[0].directory += "/../escape"; },
      (c: Catalog) => { c.entries[0].family = "pilot"; },
      (c: Catalog) => { c.entries[0].manifestSha256 = "unknown"; },
      (c: Catalog) => { c.entries[0].id = "<script>"; },
      (c: Catalog) => { (c.entries[0] as any).credential = "not-allowed"; },
    ]) {
      const c = structuredClone(catalog); mutate(c); check(() => assert.throws(() => validateCatalog(c)));
    }
    check(() => assert.equal(sumKnown([0, null]), null));
    check(() => assert.equal(sumKnown([]), null));
    check(() => assert.equal(sumKnown([undefined, 2]), null));
    check(() => assert.equal(sumKnown([0, 2]), 2));
    check(() => assert.throws(() => sumKnown([-1])));
    const basic = { mode: "live", realHttpDispatches: 2, possibleUnknownDispatches: 0, rows: [
      { runId: "r1", profile: "B1", taskId: "READ", status: "fail", reasonCode: "ANSWER_MARKDOWN_FENCE",
        providerUsage: { promptTokens: 10, completionTokens: 2, reasoningTokens: 3, cachedTokens: null, totalTokens: 15 },
        sdkUsage: { outputTokens: 5, cacheReadTokens: 0 } },
    ] };
    const s2 = projectAggregate("sdk-live", basic, {});
    check(() => assert.equal(s2.statuses.fail, 1));
    check(() => assert.equal(s2.providerActualUsage!.cached, null));
    check(() => assert.equal(s2.actualCostUsd, null));
    check(() => assert.equal(s2.providerActualUsage!.completion, 2));
    check(() => assert.equal(s2.sdkNormalizedOutput, 5));
    const cached = structuredClone(basic) as any; cached.rows[0].providerUsage.cachedTokens = 0;
    check(() => assert.equal(projectAggregate("sdk-live", cached, {}).providerActualUsage!.cached, 0));
    cached.rows[0].providerUsage.cachedTokens = 4;
    check(() => assert.equal(projectAggregate("sdk-live", cached, {}).providerActualUsage!.cached, 4));
    check(() => assert.equal(projectAggregate("sdk-live", { ...basic, mode: "dry-run" }, {}).providerActualUsage, null));
    check(() => assert.throws(() => projectAggregate("sdk-live", { ...basic, rows: [...basic.rows, ...basic.rows] }, {})));
    const module = projectAggregate("module", { taskGroups: [{ variant: "c1", taskId: "CTX", count: 1, runIds: ["r1"], statuses: { ...emptyStatuses(), unsupported: 1 } }] }, {});
    check(() => assert.equal(module.statuses.unsupported, 1));
    check(() => assert.equal(module.statuses.pass, 0));
    check(() => assert.throws(() => projectAggregate("module", { taskGroups: [{ variant: "c1", taskId: "CTX", count: 2, runIds: ["r1"], statuses: { pass: 1 } }] }, {})));
    const s1 = projectAggregate("sdk-read-write", { realHttpDispatches: 0, groups: [{ profile: "B0", taskId: "WRITE", count: 1, statuses: { fail: 1 } }] },
      { runs: [{ runId: "r1", profile: "B0", taskId: "WRITE" }] });
    check(() => assert.equal(s1.groups[0].runIds[0], "r1"));
    const pilot = projectAggregate("pilot", { mode: "live", realHttpDispatches: 1, possibleUnknownDispatches: 1,
      tasks: [{ taskId: "READ", status: "unknown", reasonCode: "REQUEST_UNKNOWN" }], providerUsage: {}, sdkUsage: {} }, {});
    check(() => assert.equal(pilot.statuses.unknown, 1));
    check(() => assert.equal(pilot.providerActualUsage!.total, null));
    check(() => assert.equal(pilot.unknownHttpRequests, 1));
    for (const family of ["sdk-context", "sdk-lifecycle"] as const) {
      const p = projectAggregate(family, { realHttpDispatches: 0, rows: [{ runId: "r1", profile: "B1", task: "compact", status: "fail", reason: "MISSING_GATE" }] }, {});
      check(() => assert.equal(p.statuses.fail, 1));
    }
    const transport = projectAggregate("sdk-transport", { realHttpDispatches: 0, contractPassed: true, scenario: "cancel", requestOutcome: "unknown", stopCode: "CANCELLED" }, {});
    check(() => assert.equal(transport.statuses.pass, 1));
    check(() => assert.equal(transport.groups[0].operationOutcomes.unknown, 1));
    const liveContext = projectAggregate("sdk-context-live", { mode: "live", realHttpDispatches: 2, unknownRequests: 0, rows: [
      { run: { runId: "r1", profile: "B3", task: "compact" }, status: "pass", reasonCode: "PASS", providerActualUsage: { input: 4, output: 1, reasoning: 2, cached: null, total: 7 }, sdkUsage: { output: 3 } }] }, {});
    check(() => assert.equal(liveContext.providerActualUsage!.reasoning, 2));
    check(() => assert.equal(liveContext.sdkNormalizedOutput, 3));
    const race = projectAggregate("sdk-recovery", { realHttpDispatches: 0, rows: [
      { run: { runId: "r1", scenario: "partial-effect" }, status: "pass", reason: "PASS", operationOutcome: "unknown-replay-blocked" },
      { run: { runId: "r2", scenario: "after-effect" }, status: "pass", reason: "PASS", operationOutcome: "satisfied-by-readback" }] }, {});
    check(() => assert.equal(race.statuses.pass, 2));
    check(() => assert.equal(race.groups[0].operationOutcomes["unknown-replay-blocked"], 1));

    const selection = await unknownFixture(root), entry = selection.entries[0], directory = path.join(root, entry.directory);
    await reject(() => recoverLegacyContext(path.join(root, "missing-legacy-batch")));
    const before = await inventory(directory), result = await createReport(root, selection, builder);
    check(() => assert.equal(result.verifiedBatches, 1));
    check(() => assert.equal(result.phase5Complete, false));
    const first = result.batches[0]; assert.equal(first.integrity, "verified");
    check(() => assert.equal(first.summary.statuses.unknown, 1));
    check(() => assert.equal(first.summary.statuses.blocked, 11));
    check(() => assert.equal(first.summary.statuses.pass, 0));
    check(() => assert.ok(markdown(result).includes("Phase 5 未完成")));
    check(() => assert.ok(markdown(result).includes("unknown")));
    const repeated = await createReport(root, selection, builder);
    check(() => assert.deepEqual(repeated, result));
    assert.deepEqual(await inventory(directory), before); checks++;

    const missing = { ...entry, id: "missing", directory: entry.directory + "-missing", manifestSha256: "b".repeat(64) };
    const incomplete = await createReport(root, { ...selection, entries: [entry, missing] }, builder);
    check(() => assert.equal(incomplete.batches.length, 2));
    check(() => assert.equal(incomplete.verifiedBatches, 1));
    check(() => assert.equal(incomplete.batches[1].integrity, "unavailable"));
    const wrongSha = await inspectBatch(root, { ...entry, manifestSha256: "b".repeat(64) });
    check(() => assert.equal(wrongSha.problem, "REPORT_MANIFEST_MISMATCH"));
    const rawPath = path.join(directory, "raw/before-effect-r1.json"), rawText = await readFile(rawPath, "utf8");
    await writeFile(rawPath, rawText.replace('"unknown"', '"pass"'));
    const changed = await inspectBatch(root, entry);
    check(() => assert.equal(changed.problem, "REPORT_TREE_MISMATCH"));
    const resealed = await inspectBatch(root, { ...entry, treeSha256: digest(await inventory(directory)) });
    check(() => assert.equal(resealed.integrity, "invalid"));
    await writeFile(rawPath, rawText);
    const aggregatePath = path.join(directory, "aggregate.json"), aggregateText = await readFile(aggregatePath, "utf8");
    await writeFile(aggregatePath, "{}");
    const falseAggregate = await inspectBatch(root, { ...entry, treeSha256: digest(await inventory(directory)) });
    check(() => assert.equal(falseAggregate.problem, "REPORT_AGGREGATE_MISMATCH"));
    await writeFile(aggregatePath, aggregateText);
    await rm(aggregatePath); // Test-owned synthetic aggregate only.
    const noAggregate = await inspectBatch(root, { ...entry, treeSha256: digest(await inventory(directory)) });
    check(() => assert.equal(noAggregate.integrity, "verified"));
    check(() => assert.ok(noAggregate.integrity === "verified" && !noAggregate.savedAggregateCompared));
    await writeFile(aggregatePath, aggregateText);
    const unexpected = path.join(directory, "credential.json");
    await writeFile(unexpected, '{"authorization":"PRIVATE_SENTINEL"}');
    const safe = await createReport(root, selection, builder);
    check(() => assert.equal(safe.batches[0].integrity, "invalid"));
    check(() => assert.ok(!JSON.stringify(safe).includes("PRIVATE_SENTINEL")));
    await rm(unexpected);
    const linkPath = directory + "-junction";
    await symlink(directory, linkPath, process.platform === "win32" ? "junction" : "dir");
    const linked = await inspectBatch(root, { ...entry, directory: entry.directory + "-junction" });
    check(() => assert.equal(linked.integrity, "invalid"));
    await rm(linkPath);

    const packaged = await writePackage(root, selection, builder);
    const verified = await verifyPackage(root, packaged.directory, builder);
    check(() => assert.equal(verified.verifiedBatches, 1));
    const another = await writePackage(root, selection, builder);
    check(() => assert.notEqual(packaged.directory, another.directory));
    check(() => assert.deepEqual(another.report, packaged.report));
    await reject(() => verifyPackage(root, packaged.directory, { ...builder, "tests/drift.ts": "a".repeat(64) }));
    const reportPath = path.join(packaged.directory, "report.md"), reportText = await readFile(reportPath, "utf8");
    await writeFile(reportPath, reportText + "false success");
    await reject(() => verifyPackage(root, packaged.directory, builder));
    const packageManifestPath = path.join(packaged.directory, "manifest.json"), packageManifestText = await readFile(packageManifestPath, "utf8");
    const payload = await inventory(packaged.directory); delete payload["manifest.json"];
    await writeFile(packageManifestPath, JSON.stringify({ schemaVersion: 1, kind: "phase5-report-package", files: payload, filesSha256: digest(payload) }));
    await reject(() => verifyPackage(root, packaged.directory, builder));
    await writeFile(packageManifestPath, packageManifestText);
    await writeFile(reportPath, reportText);
    await writeFile(rawPath, "{}");
    await reject(() => verifyPackage(root, packaged.directory, builder));
    await writeFile(rawPath, rawText);
    const final = await verifyPackage(root, packaged.directory, builder);
    check(() => assert.equal(final.newModelRequests, 0));
    assert.deepEqual(await inventory(directory), before); checks++;
    check(() => assert.ok(!/Bearer\s|https?:\/\/|"apiKey"\s*:|PRIVATE_SENTINEL/.test(JSON.stringify(packaged.report))));
    checks += await runSupervisionTests(root, builder);
    checks += await runSupervisionLiveTests(root, builder);
    return { checks, familyProjections: FAMILIES.length, fixture: "synthetic report records only; no new SDK or killed-process run", realModelRequests: 0 };
  } finally {
    await assertInside(process.env.PI_REPORT_WORK!, root);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
