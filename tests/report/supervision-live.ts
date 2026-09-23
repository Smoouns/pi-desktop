import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest, sha256, writeOnce } from "../../evals/core/io.js";
import { createJournalScope } from "../../evals/core/request-journal.js";
import { fixtureHashes, seedHash } from "../../evals/sdk-supervision-live/fixture.js";
import { MODEL, PRODUCT_LIMITS, PROMPTS, PROFILES, RUNS, SETTINGS, SYSTEM, TASKS, TTL, VERSION, policyForSchema, referenceBudget, type SchemaVersion } from "../../evals/sdk-supervision-live/policy.js";
import type { Catalog } from "../../evals/report/catalog.js";
import { projectAggregate } from "../../evals/report/project.js";
import { recoverLegacySupervision } from "../../evals/report/legacy-context.js";
import { createReport, inspectBatch, inventory, markdown, verifyPackage, writePackage } from "../../evals/report/report.js";

// Frozen identities from accepted original CLI bundles, not new SDK executions.
// V2/V3 have the same factory text; their budget contracts remain different.
const PROFILE_HASHES = {
  legacy: ["47dbe60c6267fd22aa99757b189bb77f796750b7540c28e6b5c0b11a0a3ebe24", "7ed787017c872b0008e0125b896033020b715ff8c1c8b858b19271483e1a2911", "eb3205e54ba411b498f33c5b789aaf4eb7838bc2b2d289f216e9691adb49f4b0"],
  current: ["5ce290746672f1bd012d0aecbdd7b34416b06d923d827f9422881a87e54d69fc", "55376b73144bb6adb4e607f15423d39dc0eab1320159bdd4ed6275c649e8108d", "799a5beec9529b4d7584d8bce213a3e470e9f3d529ad7f6660d44b6a796292cb"],
};

function syntheticManifest(version: SchemaVersion) {
  const h = sha256("synthetic-report-only"), policy = policyForSchema(version);
  const sources = { "tests/report/synthetic-supervision-live.ts": h };
  const files = Object.fromEntries(TASKS.map(t => [t, fixtureHashes(t)]));
  const prompts = Object.fromEntries(Object.entries(PROMPTS).map(([k, v]) => [k, sha256(v)]));
  const { thinkingLevel: _, ...model } = MODEL;
  return { schemaVersion: version, kind: "sdk-supervision-live-manifest", mode: "dry-run", simulation: "readback", batchId: `s4-dry-report-v${version}`,
    createdAt: "2026-09-23T00:00:00.000Z", expiresAt: new Date(Date.parse("2026-09-23T00:00:00.000Z") + TTL).toISOString(),
    model: { ...model, reasoning: false, outputField: "max_tokens", compatSha256: h }, endpointSha256: h, configSha256: h,
    code: { commit: "a".repeat(40), dirty: true, files: sources, sha256: digest(sources) }, fixture: { files, sha256: digest(files) },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, sdk: "0.63.1", lockSha256: h },
    prepared: Object.fromEntries(RUNS.map(run => [run.runId, {
      extensionSha256: PROFILE_HASHES[version === 1 ? "legacy" : "current"][PROFILES.indexOf(run.profile)],
      toolsSha256: h, systemSha256: h, promptSha256: prompts[run.task], seedSha256: seedHash(run.task),
      wire: run.task === "pressure-recover" ? { beforeBytes: 40000, afterTrimBytes: 30000, beforeSha256: h, afterTrimSha256: h, trimmed: 1 }
        : { beforeBytes: 1024, afterTrimBytes: 1024, beforeSha256: h, afterTrimSha256: h, trimmed: 0 },
    }])), calibration: { summaryBytes: [1024], ordinaryBytes: [1024], compactions: 1, historyIntact: true },
    runs: RUNS, limits: policy.limits, policy, productLimits: PRODUCT_LIMITS, settings: SETTINGS, version: VERSION, prompts,
    systemSha256: sha256(SYSTEM), referenceBudget: referenceBudget(policy.limits) };
}

/** Report-only unknown/blocked records. No API, SDK session or task worker. */
async function sealedFixture(root: string, version: SchemaVersion): Promise<Catalog["entries"][number]> {
  const manifest = syntheticManifest(version), relative = "artifacts/harness/sdk-supervision-live/" + manifest.batchId, directory = path.join(root, relative);
  await mkdir(path.join(directory, "raw"), { recursive: true }); await writeOnce(path.join(directory, "manifest.json"), manifest);
  const manifestSha256 = sha256(await readFile(path.join(directory, "manifest.json")));
  const journal = await createJournalScope(policyForSchema(version)).create(path.join(directory, "journal"), manifestSha256, "dry-run");
  await journal.finalize("aborted");
  for (const [i, run] of RUNS.entries()) await writeOnce(path.join(directory, "raw", run.runId + ".json"), {
    schemaVersion: version, manifestSha256, run, status: i === 0 ? "unknown" : "blocked", reasonCode: i === 0 ? "WORKER_UNKNOWN" : "BATCH_STOPPED",
    sourceStable: false, stages: [], ...(version >= 2 ? { transport: i === 0 ? { stopCode: "MANUAL_STOP", offers: [] } : null } : {}),
  });
  const files = await inventory(directory); delete files["manifest.json"];
  await writeOnce(path.join(directory, "index.json"), { schemaVersion: 1, manifestSha256, files });
  await writeOnce(path.join(directory, "aggregate.json"), await recoverLegacySupervision(directory));
  return { id: "synthetic-s4-live-v" + version, family: "sdk-supervision-live", directory: relative, manifestSha256, treeSha256: digest(await inventory(directory)) };
}

function projectionFixture(version: SchemaVersion = 3) {
  const requests = version === 3 ? [4, 5, 8, 2, 2, 2, 3, 0, 0] : [6, 6, 0, 0, 0, 0, 0, 0, 0];
  const rows = RUNS.map((run, i) => {
    const n = requests[i], status = version === 3 ? i < 7 ? "pass" : "fail" : i === 0 ? "pass" : i === 1 ? "unknown" : "blocked";
    const outcome = version !== 3 ? i === 0 ? "verified_candidate" : "unknown" : i < 3 ? "verified_candidate" : i < 6 ? "blocked_prerequisite" : i === 6 ? "read_only_answer" : "budget_blocked";
    const summaries = version === 3 && i === 6 ? 1 : 0;
    const provider = { input: n ? n * 10 : null, output: n ? n : null, reasoning: n ? n * 2 : null, cached: null, total: n ? n * 13 : null };
    const sdk = { input: provider.input, output: n ? n * 3 : null, total: provider.total, cacheRead: n ? 0 : null, cacheWrite: n ? 0 : null };
    if (version === 1 && i === 1) sdk.output = null; // Legacy missing SDK evidence stays missing.
    return { run, status, reasonCode: status === "pass" ? "PASS" : status === "fail" ? "TASK_FAILED" : status === "unknown" ? "SAFETY_STOP" : "BATCH_STOPPED",
      businessOutcome: outcome, userAccepted: false, requests: n, ordinary: n - summaries, summaries,
      providerActualUsage: provider, sdkUsage: sdk, nativeCompactions: status === "blocked" ? null : summaries,
      noProgressBranch: status === "blocked" ? "unobserved" : "not_triggered",
      ...(version >= 2 ? { transportDiagnostics: status === "blocked" ? null : { stopCode: null, sdkEntries: n || 1, offered: n, dispatched: n } } : {}),
    };
  });
  return { manifest: syntheticManifest(version), aggregate: { schemaVersion: version, mode: "live", sealed: true,
    status: version === 3 ? "completed-with-failures" : "incomplete", realHttpDispatches: requests.reduce((n, x) => n + x, 0), simulatedHttpDispatches: 0,
    unknownRequests: 0, pendingRequests: 0, sharedReserved: requests.reduce((n, x) => n + x, 0), rows } };
}

export async function runSupervisionLiveTests(root: string, builder: Record<string, string>) {
  let checks = 0;
  const check = (fn: () => void) => { fn(); checks++; };
  const reject = async (fn: () => Promise<unknown>) => { await assert.rejects(fn); checks++; };
  const { aggregate, manifest } = projectionFixture(), current = projectAggregate("sdk-supervision-live", aggregate, manifest);
  check(() => assert.equal(current.statuses.pass, 7)); check(() => assert.equal(current.statuses.fail, 2));
  check(() => assert.equal(current.groups.length, 9)); check(() => assert.equal(current.realHttpDispatches, 26));
  check(() => assert.equal(current.providerActualUsage!.prompt, 260)); check(() => assert.equal(current.providerActualUsage!.completion, 26));
  check(() => assert.equal(current.providerActualUsage!.reasoning, 52)); check(() => assert.equal(current.providerActualUsage!.total, 338));
  check(() => assert.equal(current.providerActualUsage!.cached, null)); check(() => assert.equal(current.sdkNormalizedOutput, 78));
  check(() => assert.equal(current.actualCostUsd, null)); check(() => assert.equal(current.supervisionLive!.batchHttpLimit, 72));
  check(() => assert.equal(current.supervisionLive!.taskHttpLimit, 8)); check(() => assert.equal(current.supervisionLive!.budgetNamespace, "sdk-supervision-live-v2"));
  check(() => assert.deepEqual(current.supervisionLive!.usageCoverage, { basis: "tasks-with-http-reservations", plannedTasks: 9, tasksWithReservations: 7, tasksWithoutReservations: 2, unrunTasks: 0 }));
  check(() => assert.deepEqual(current.supervisionLive!.noProgressBranches, { triggered: 0, not_triggered: 9, unobserved: 0 }));
  check(() => assert.equal(current.supervisionLive!.rows[6].nativeCompactions, 1));
  check(() => assert.equal(current.supervisionLive!.rows[7].brokerOffers, 0));
  check(() => assert.equal(current.supervisionLive!.rows[7].sdkEntries, 1));
  check(() => assert.equal(current.supervisionLive!.rows[7].httpDispatches, 0));
  check(() => assert.equal(current.groups[3].businessOutcomes.blocked_prerequisite, 1));
  check(() => assert.equal(current.groups[7].businessOutcomes.budget_blocked, 1));
  check(() => assert.equal(aggregate.rows[7].providerActualUsage.input, null));
  for (const cache of [0, 3]) {
    const a: any = structuredClone(aggregate); for (const row of a.rows) if (row.requests) row.providerActualUsage.cached = cache;
    check(() => assert.equal(projectAggregate("sdk-supervision-live", a, manifest).providerActualUsage!.cached, cache * 7));
    check(() => assert.equal(projectAggregate("sdk-supervision-live", a, manifest).actualCostUsd, null));
  }
  const missing: any = structuredClone(aggregate); missing.rows[1].providerActualUsage.total = null; missing.rows[1].sdkUsage.output = null;
  const unknown = projectAggregate("sdk-supervision-live", missing, manifest);
  check(() => assert.equal(unknown.providerActualUsage!.total, null)); check(() => assert.equal(unknown.sdkNormalizedOutput, null));
  check(() => assert.equal(unknown.providerActualUsage!.prompt, 260));
  check(() => assert.equal(projectAggregate("sdk-supervision-live", { ...aggregate, mode: "dry-run", realHttpDispatches: 0 }, manifest).providerActualUsage, null));
  const old = projectionFixture(1), legacy = projectAggregate("sdk-supervision-live", old.aggregate, old.manifest);
  check(() => assert.equal(legacy.statuses.unknown, 1)); check(() => assert.equal(legacy.statuses.blocked, 7));
  check(() => assert.equal(legacy.providerActualUsage!.total, 156)); check(() => assert.equal(legacy.sdkNormalizedOutput, null));
  check(() => assert.equal(legacy.supervisionLive!.taskHttpLimit, 6)); check(() => assert.equal(legacy.supervisionLive!.batchHttpLimit, 54));
  check(() => assert.equal(legacy.supervisionLive!.noProgressBranches.unobserved, 7));
  check(() => assert.equal(legacy.supervisionLive!.usageCoverage.unrunTasks, 7));
  check(() => assert.equal(legacy.supervisionLive!.rows[1].diagnostics, "legacy-not-recorded"));
  check(() => assert.equal(legacy.supervisionLive!.rows[1].stopCode, null));
  for (const mutate of [
    (a: any) => a.rows[0].userAccepted = true, (a: any) => delete a.rows[0].userAccepted,
    (a: any) => a.rows[0].businessOutcome = "accepted_canon", (a: any) => a.rows[0].noProgressBranch = "probably_triggered",
    (a: any) => a.rows[0].requests = -1, (a: any) => a.sharedReserved++, (a: any) => a.sealed = false,
    (a: any) => a.schemaVersion = 1, (a: any) => a.rows.push(a.rows[0]),
  ]) {
    const a = structuredClone(aggregate); mutate(a); check(() => assert.throws(() => projectAggregate("sdk-supervision-live", a, manifest)));
  }
  const triggered = structuredClone(aggregate); triggered.rows[3].noProgressBranch = "triggered"; triggered.rows[3].businessOutcome = "no_progress_stopped";
  check(() => assert.equal(projectAggregate("sdk-supervision-live", triggered, manifest).supervisionLive!.noProgressBranches.triggered, 1));
  await reject(() => recoverLegacySupervision(path.join(root, "missing-s4-batch")));

  const selection: Catalog = { schemaVersion: 1, kind: "phase5-evidence-selection", entries: [] };
  for (const version of [1, 2, 3] as const) selection.entries.push(await sealedFixture(root, version));
  const before = await Promise.all(selection.entries.map(e => inventory(path.join(root, e.directory))));
  const report = await createReport(root, selection, builder);
  check(() => assert.equal(report.verifiedBatches, 3)); check(() => assert.equal(report.newModelRequests, 0));
  for (const [i, batch] of report.batches.entries()) {
    assert.equal(batch.integrity, "verified");
    check(() => assert.equal(batch.summary.statuses.unknown, 1)); check(() => assert.equal(batch.summary.statuses.blocked, 8));
    check(() => assert.equal(batch.summary.supervisionLive!.schemaVersion, i + 1));
    check(() => assert.equal(batch.summary.supervisionLive!.batchHttpLimit, i === 2 ? 72 : 54));
    check(() => assert.equal(batch.summary.supervisionLive!.noProgressBranches.unobserved, 9));
    check(() => assert.equal(batch.summary.providerActualUsage, null));
  }
  const first = report.batches[0]; assert.equal(first.integrity, "verified");
  const rendered = markdown({ ...report, batches: [{ ...first, summary: current }] });
  for (const expected of ["每项 / 全批请求上限 8 / 72", "候选已验证 3，前提缺失时停止 3，只读答复 1，预算阻断 2", "没有任何一项代表人工验收或 Canon 晋升", "用量覆盖：7 / 9", "未触发 9", "零请求任务原始用量保留 null", "无传输停止不等于业务完成"])
    check(() => assert.ok(rendered.includes(expected), expected));
  const oldMarkdown = markdown({ ...report, batches: [{ ...first, summary: legacy }] });
  check(() => assert.ok(oldMarkdown.includes("历史未记录细分诊断")));
  check(() => assert.ok(oldMarkdown.includes("每项 / 全批请求上限 6 / 54")));
  check(() => assert.ok(oldMarkdown.includes("其中 7 项未运行")));
  const repeated = await createReport(root, selection, builder); check(() => assert.deepEqual(repeated, report));
  const packaged = await writePackage(root, selection, builder), verified = await verifyPackage(root, packaged.directory, builder);
  check(() => assert.equal(verified.verifiedBatches, 3));
  check(() => assert.equal(verified.newModelRequests, 0));

  const entry = selection.entries[2], directory = path.join(root, entry.directory), aggregatePath = path.join(directory, "aggregate.json");
  const saved = await readFile(aggregatePath, "utf8"), fake = JSON.parse(saved); fake.rows[0].businessOutcome = "verified_candidate";
  await writeFile(aggregatePath, JSON.stringify(fake));
  const badAggregate = await inspectBatch(root, { ...entry, treeSha256: digest(await inventory(directory)) });
  check(() => assert.equal(badAggregate.integrity, "invalid")); await writeFile(aggregatePath, saved);

  const rawPath = path.join(directory, "raw", RUNS[0].runId + ".json"), rawText = await readFile(rawPath, "utf8");
  const raw = JSON.parse(rawText); raw.status = "pass"; raw.reasonCode = "PASS";
  await writeFile(rawPath, JSON.stringify(raw));
  const indexPath = path.join(directory, "index.json"), indexText = await readFile(indexPath, "utf8"), index = JSON.parse(indexText);
  index.files["raw/" + RUNS[0].runId + ".json"] = sha256(await readFile(rawPath)); await writeFile(indexPath, JSON.stringify(index));
  const badRaw = await inspectBatch(root, { ...entry, treeSha256: digest(await inventory(directory)) });
  check(() => assert.equal(badRaw.integrity, "invalid")); await writeFile(rawPath, rawText); await writeFile(indexPath, indexText);

  const manifestPath = path.join(directory, "manifest.json"), manifestText = await readFile(manifestPath, "utf8"), changed = JSON.parse(manifestText);
  changed.prepared[RUNS[0].runId].extensionSha256 = "f".repeat(64); await writeFile(manifestPath, JSON.stringify(changed));
  const badProfile = await inspectBatch(root, { ...entry, manifestSha256: sha256(await readFile(manifestPath)), treeSha256: digest(await inventory(directory)) });
  check(() => assert.equal(badProfile.integrity, "invalid")); await writeFile(manifestPath, manifestText);

  const unsealedDirectory = directory + "-prepared"; await mkdir(unsealedDirectory); await writeFile(path.join(unsealedDirectory, "manifest.json"), manifestText);
  const unsealed = await inspectBatch(root, { ...entry, directory: entry.directory + "-prepared", treeSha256: digest(await inventory(unsealedDirectory)) });
  check(() => assert.equal(unsealed.integrity, "invalid"));
  for (const [i, e] of selection.entries.entries()) check(() => assert.equal(e.treeSha256, digest(before[i])));
  const after = await Promise.all(selection.entries.map(e => inventory(path.join(root, e.directory))));
  check(() => assert.deepEqual(after, before));
  return checks;
}
