import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compact } from "@mariozechner/pi-coding-agent";
import { createContextMaintenance } from "../../src/extensions/context-maintenance.js";
import { assertInside, digest, sha256, treeManifest } from "../../evals/core/io.js";
import { freezeRequestPolicy } from "../../evals/core/request-policy.js";
import { createJournalScope } from "../../evals/core/request-journal.js";
import { createContextBroker } from "../../evals/sdk-context-transport/broker.js";
import { createBoundedTransport } from "../../evals/core/request-transport.js";
import { ACK, LEGACY_ACK, LEGACY_LIMITS, LEGACY_POLICY, LIMITS, MODEL, POLICY, PRODUCT_LIMITS, RUNS, SCHEMA_VERSION, SIMULATIONS, TARGET, referenceBudget, type Simulation } from "../../evals/sdk-supervision-live/policy.js";
import { seedMessages } from "../../evals/sdk-supervision-live/fixture.js";
import { installBridge } from "../../evals/sdk-supervision-live/bridge.js";
import { authorize, durableJson, readManifest, validateManifest } from "../../evals/sdk-supervision-live/manifest.js";
import { journalScope, recover, seal, validateRecord } from "../../evals/sdk-supervision-live/records.js";
import { evidenceRoot, runDry, runLive, syntheticConfig } from "../../evals/sdk-supervision-live/runner.js";
import { formatDiagnostics } from "../../evals/sdk-supervision-live/diagnostics.js";
import { asLegacyManifest, diagnosticUnitTests, legacyCopy } from "./diagnostics.js";
import { createTransportTestClock, expectTimeoutAtPhase, phaseSignal } from "../support/transport-clock.js";

export async function runTests() {
  let count = 0; const temporary = await mkdtemp(path.join(process.env.PI_S4L_WORK_ROOT!, "tests-"));
  const test = async (name: string, fn: () => void | Promise<void>) => { try { await fn(); count++; } catch (error) { console.error(`S4 live tooling failed: ${name}`); throw error; } };
  const endpoint = "https://pilot.invalid/v1/chat/completions", body = JSON.stringify({ model: MODEL.id, max_tokens: 2048, messages: [] });
  const response = () => new Response('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n');
  try {
    await diagnosticUnitTests(test, temporary);
    await test("only the versioned request reservations grow", () => {
      assert.equal(SCHEMA_VERSION, 3); assert.equal(POLICY.namespace, "sdk-supervision-live-v2");
      assert.equal(LEGACY_POLICY.namespace, "sdk-supervision-live-v1");
      assert.equal(LEGACY_LIMITS.maxTaskHttpRequests, 6); assert.equal(LEGACY_LIMITS.maxHttpRequests, 54);
      assert.equal(LIMITS.maxTaskHttpRequests, 8); assert.equal(LIMITS.maxHttpRequests, 72);
      assert.deepEqual(LIMITS, { ...LEGACY_LIMITS, maxTaskHttpRequests: 8, maxHttpRequests: 72, maxTotalInputTokens: 4718592, maxTotalOutputTokens: 147456 });
      assert.equal(referenceBudget().noCacheReservationEstimate, 4.091904);
      assert.equal(referenceBudget(LEGACY_LIMITS).noCacheReservationEstimate, 3.068928);
      assert.equal(referenceBudget().actualCostUsd, null);
    });
    console.log("S4 live tooling: shared limits and SDK serialization branches");
    await test("separate reasoning included in output cap", async () => {
      const gate = createBoundedTransport({ endpoint, modelId: MODEL.id, outputField: "max_tokens", outputMode: "bounded", estimateInput: () => 1,
        fetchImpl: async () => new Response('data: {"usage":{"prompt_tokens":1,"completion_tokens":2040,"completion_tokens_details":{"reasoning_tokens":20},"total_tokens":2061}}\n\ndata: [DONE]\n\n') }, POLICY);
      await assert.rejects(() => gate.invoke(RUNS[0].runId, async () => (await gate.fetch(endpoint, { method: "POST", body })).text())); assert.equal(gate.snapshot().stopCode, "PROVIDER_USAGE_LIMIT");
    });
    for (const policy of [LEGACY_POLICY, POLICY]) for (const cap of ["task", "batch"] as const) await test(`${policy.namespace} ${cap} mixed ordinary-summary quota`, async () => {
      let dispatched = 0;
      const directory = await mkdtemp(path.join(temporary, "broker-")), broker = await createContextBroker({ directory, manifestSha256: "a".repeat(64), policy,
        route: { endpoint, modelId: MODEL.id, outputField: "max_tokens", mode: "dry-run" }, fetchImpl: async () => { dispatched++; return response(); } });
      const max = cap === "task" ? policy.limits.maxTaskHttpRequests : policy.limits.maxHttpRequests;
      for (let i = 1; i <= max; i++) await broker.submit({ id: i, kind: i % 2 ? "ordinary" : "summary", taskId: RUNS[cap === "task" ? 0 : Math.floor((i - 1) / policy.limits.maxTaskHttpRequests)].runId, stage: "single", body });
      await assert.rejects(() => broker.submit({ id: max + 1, kind: "ordinary", taskId: RUNS[0].runId, stage: "single", body }));
      assert.equal(broker.snapshot().transport.stopCode, cap === "task" ? "TASK_REQUEST_LIMIT" : "BATCH_REQUEST_LIMIT");
      const disk = await broker.close(); assert.equal(disk.reserved, max); assert.equal(disk.outputReserved, max * 2048); assert.equal(dispatched, max);
      await assert.rejects(() => broker.submit({ id: max + 1, kind: "summary", taskId: RUNS[0].runId, stage: "single", body }));
    });
    await test("timeout, no refund, no second dispatch", async () => {
      const policy = freezeRequestPolicy({ namespace: "s4-live-timeout-unit-v1", taskIds: POLICY.taskIds, limits: { ...LIMITS, requestTimeoutMs: 20 } });
      const clock = createTransportTestClock(), dispatched = phaseSignal(); let calls = 0;
      const directory = await mkdtemp(path.join(temporary, "timeout-")), broker = await createContextBroker({ directory, manifestSha256: "a".repeat(64), policy,
        route: { endpoint, modelId: MODEL.id, outputField: "max_tokens", mode: "dry-run" }, testClock: clock.timing,
        fetchImpl: async () => { calls++; dispatched.reached(); return new Promise<Response>(() => undefined); } });
      const offer = (id: number) => ({ id, kind: "summary" as const, taskId: RUNS[0].runId, stage: "single" as const, body });
      const pending = broker.submit(offer(1));
      await expectTimeoutAtPhase(pending, dispatched.promise.then(async () => {
        const disk = await createJournalScope(policy).recover(path.join(directory, "journal"), "a".repeat(64));
        assert.equal(disk.reserved, 1); assert.equal(disk.pending, 1);
        const binding = JSON.parse(await readFile(path.join(directory, "requests/request-000001.json"), "utf8"));
        assert.equal(binding.offerId, 1); assert.equal(binding.kind, "summary");
        assert.equal(broker.snapshot().transport.requests[0].dispatchAttempted, true);
      }), clock, "REQUEST_TIMEOUT", 20);
      assert.deepEqual(clock.snapshot().delays, [20, 20]);
      await assert.rejects(() => broker.submit(offer(2)), /S3T_OFFER_REJECTED/);
      assert.equal(calls, 1); assert.equal(broker.snapshot().offered, 1);
      const disk = await broker.close(); assert.equal(disk.reserved, 1); assert.equal(disk.unknown, 1); assert.equal(disk.outputReserved, 2048);
      assert.equal(broker.snapshot().transport.stopCode, "REQUEST_TIMEOUT");
      assert.equal(broker.snapshot().transport.requestsReserved, 1); assert.equal(broker.snapshot().transport.outputReserved, 2048);
    });
    await test("journal deadline prevents dispatch and remains distinct from network timeout", async () => {
      const policy = freezeRequestPolicy({ namespace: "s4-live-timeout-unit-v1", taskIds: POLICY.taskIds, limits: { ...LIMITS, requestTimeoutMs: 20 } });
      const clock = createTransportTestClock(), reserving = phaseSignal(), release = phaseSignal(); let calls = 0;
      const directory = await mkdtemp(path.join(temporary, "journal-timeout-"));
      const heldReservation = release.promise.then(() => { throw new Error("test reservation cancelled"); });
      const broker = await createContextBroker({ directory, manifestSha256: "a".repeat(64), policy,
        route: { endpoint, modelId: MODEL.id, outputField: "max_tokens", mode: "dry-run" }, testClock: clock.timing,
        beforeReserve: () => { reserving.reached(); return heldReservation; }, fetchImpl: async () => { calls++; return response(); } });
      try {
        const pending = broker.submit({ id: 1, kind: "summary", taskId: RUNS[0].runId, stage: "single", body });
        await expectTimeoutAtPhase(pending, reserving.promise, clock, "JOURNAL_FAILURE", 20);
        assert.deepEqual(clock.snapshot().delays, [20]); assert.equal(calls, 0);
        const snapshot = broker.snapshot().transport;
        assert.equal(snapshot.stopCode, "JOURNAL_FAILURE"); assert.equal(snapshot.requestsReserved, 1); assert.equal(snapshot.outputReserved, 2048);
        assert.equal(snapshot.requests[0].dispatchAttempted, false); assert.equal(snapshot.requests[0].status, "unknown");
        await assert.rejects(() => broker.submit({ id: 2, kind: "summary", taskId: RUNS[0].runId, stage: "single", body }));
        assert.equal(calls, 0); assert.equal(broker.snapshot().transport.requestsReserved, 1);
      } finally { release.reached(); await assert.rejects(heldReservation, /test reservation cancelled/); }
      const disk = await broker.close(); assert.equal(disk.reserved, 0);
      assert.deepEqual(await readdir(path.join(directory, "requests")), []);
    });
    await test("test clock cannot change live deadlines or create a live journal", async () => {
      const directory = path.join(temporary, "live-clock-forbidden"), clock = createTransportTestClock(); let calls = 0;
      await assert.rejects(() => createContextBroker({ directory, manifestSha256: "a".repeat(64), policy: POLICY,
        route: { endpoint, modelId: MODEL.id, outputField: "max_tokens", mode: "live" }, testClock: clock.timing,
        fetchImpl: async () => { calls++; return response(); } }), /S3T_TEST_CLOCK_DRY_ONLY/);
      await assert.rejects(() => readdir(directory), { code: "ENOENT" }); assert.equal(calls, 0);
      assert.deepEqual(clock.snapshot().delays, []);
    });
    await test("native split summary uses two bounded SDK payloads", async () => {
      const model = { ...syntheticConfig().runtimeModel, baseUrl: "https://pilot.invalid/v1" }, bridge = installBridge(model, { allowSummary: true, prepareOnly: true, terminal: () => false, onReply: () => undefined });
      let emit: (e: any) => void = () => undefined;
      bridge.attach({ agent: { streamFn: () => undefined }, subscribe: (fn: any) => { emit = fn; }, abortCompaction: () => undefined } as any);
      try {
        emit({ type: "compaction_start", reason: "manual" });
        await compact({ firstKeptEntryId: "public", messagesToSummarize: [{ role: "user", content: "Public history", timestamp: 0 }],
          turnPrefixMessages: [{ role: "user", content: "Public split prefix", timestamp: 0 }], isSplitTurn: true, tokensBefore: 10, previousSummary: undefined,
          fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 2048, keepRecentTokens: 128 } } as any, model, "synthetic-placeholder");
        emit({ type: "compaction_end" }); assert.equal(bridge.payloads.length, 2); assert.ok(bridge.payloads.every(p => p.kind === "summary" && p.bytes <= 65536));
        assert.equal(bridge.snapshot().receipts.length, 2); assert.equal(bridge.snapshot().stopped, false);
      } finally { bridge.dispose(); }
    });
    await test("recent and pending tools protected without mutating history", () => {
      const seed = seedMessages("pressure-recover"), before = structuredClone(seed), m = createContextMaintenance();
      const trim = m.trimOldToolResults(seed, { maxInlineBytes: 1500 }); assert.equal(trim.trimmed.length, 1); assert.deepEqual(seed, before);
      assert.deepEqual(trim.messages.slice(-16), seed.slice(-16));
      assert.equal(m.trimOldToolResults(seed, { maxInlineBytes: 1500, pendingToolNames: ["read"] }).trimmed.length, 0);
    });
    console.log("S4 live tooling: complete 3 x 3 actual SDK dry-run");
    const good = await runDry(), a = good.aggregate;
    await test("nine fixed cells with honest control budget failures", () => { assert.equal(a.status, "completed-with-failures"); assert.deepEqual(a.rows.map(r => r.status), [...Array(7).fill("pass"), "fail", "fail"]);
      assert.deepEqual(a.rows.map(r => r.businessOutcome), [...Array(3).fill("verified_candidate"), ...Array(3).fill("blocked_prerequisite"), "read_only_answer", "budget_blocked", "budget_blocked"]);
      assert.equal(a.summaries, 1); assert.equal(a.sharedReserved, 21); assert.equal(a.realHttpDispatches, 0); assert.ok(a.rows.every(r => r.userAccepted === false && r.noProgressBranch === "not_triggered")); });
    const { manifest, manifestSha256 } = await readManifest(good.directory);
    await test("v3 exact counters and readable diagnoses", () => { assert.equal(manifest.schemaVersion, 3); assert.equal(a.schemaVersion, 3);
      assert.ok(a.rows.every(r => r.transportDiagnostics?.stopCode === null)); assert.equal(a.rows[0].transportDiagnostics?.dispatched, 4);
      assert.match(formatDiagnostics(a), /SDK 入口/); assert.match(formatDiagnostics(a), /预留前拒绝/); });
    await test("v1 readonly compatibility keeps old aggregate shape", async () => {
      const legacy = await legacyCopy(good.directory, temporary), before = await treeManifest(legacy.directory);
      const expected = { ...a, schemaVersion: 1, manifestSha256: legacy.aggregate.manifestSha256, rows: a.rows.map(({ transportDiagnostics: _d, ...row }) => row) };
      assert.deepEqual(legacy.aggregate, expected); assert.deepEqual(await recover(legacy.directory), expected); assert.deepEqual(await treeManifest(legacy.directory), before);
      assert.match(formatDiagnostics(legacy.aggregate), /历史未记录细分原因/); assert.ok(!formatDiagnostics(legacy.aggregate).includes("TASK_REQUEST_LIMIT"));
    });
    await test("v2 readonly compatibility preserves diagnostics and old budget", async () => {
      const legacy = await legacyCopy(good.directory, temporary, 2), before = await treeManifest(legacy.directory);
      const expected = { ...a, schemaVersion: 2, manifestSha256: legacy.aggregate.manifestSha256 };
      assert.deepEqual(legacy.aggregate, expected); assert.deepEqual(await recover(legacy.directory), expected);
      assert.deepEqual((await readManifest(legacy.directory)).manifest.limits, LEGACY_LIMITS);
      assert.deepEqual(await treeManifest(legacy.directory), before);
    });
    const raw = async (directory: string, i: number) => JSON.parse(await readFile(path.join(directory, `raw/${RUNS[i].runId}.json`), "utf8"));
    await test("identical seeds and pressure serialized before and after trimming", () => {
      const p = manifest.prepared[RUNS[6].runId]; assert.ok(p.wire.beforeBytes > p.wire.afterTrimBytes); assert.ok(p.wire.afterTrimBytes + 6144 > PRODUCT_LIMITS.contextBytes);
      assert.equal(p.wire.trimmed, 1); assert.ok(manifest.calibration.summaryBytes.every(n => n <= 65536)); assert.ok(manifest.calibration.ordinaryBytes[0] + 6144 <= 32768);
    });
    await test("native compact preserves stored history and current input once", async () => { const s = (await raw(good.directory, 6)).stages[0].result;
      assert.equal(s.historyIntact, true); assert.equal(s.currentInputCopies, 1); assert.equal(s.fromHook, false); assert.equal(s.automaticCompactions, 0); assert.equal(s.compactions, 1); assert.equal(s.metrics.compactAttempts, 1); });
    await test("read-only deterministic recover", async () => { const before = await treeManifest(good.directory); assert.deepEqual(await recover(good.directory), a); assert.deepEqual(await treeManifest(good.directory), before); });
    await test("unknown cache remains unknown cost", () => { for (const row of a.rows) { assert.equal(row.parsedUsage.cached, null); assert.equal(row.costUsd, null); assert.equal(row.providerActualUsage, null); } });
    await test("authorization checked before private config", async () => {
      await assert.rejects(() => runLive(good.directory, "nonexistent-private-config", manifestSha256, true), /S4L_DRY_NOT_AUTHORIZABLE/);
      await assert.rejects(() => runLive(good.directory, "nonexistent-private-config", manifestSha256, false), /S4L_APPROVAL_REQUIRED/);
    });
    const live = structuredClone(manifest); live.mode = "live"; live.simulation = "none"; live.batchId = "s4-live-synthetic-test";
    const sha = sha256(JSON.stringify(live, null, 2) + "\n"), token = `${sha}\n${ACK}`, now = Date.parse(live.createdAt) + 1;
    await test("fresh exact approval", () => authorize(live, sha, token, now));
    for (const version of [1, 2] as const) {
      await test(`v${version} remains read only even with matching fresh approval`, () => { const old = asLegacyManifest(live, version);
        const hash = sha256(JSON.stringify(old, null, 2) + "\n"); assert.throws(() => authorize(old, hash, `${hash}\n${ACK}`, now), /S4L_LEGACY_READ_ONLY/); });
      await test(`v${version} cannot inherit a changed generated factory hash`, () => { const old = asLegacyManifest(live, version);
        old.prepared[RUNS[0].runId].extensionSha256 = "0".repeat(64); assert.throws(() => validateManifest(old)); });
      await test(`v${version} cannot be granted the v3 budget`, () => { const old = asLegacyManifest(live, version);
        old.limits = LIMITS; old.policy = POLICY; old.referenceBudget = referenceBudget(); assert.throws(() => validateManifest(old)); });
    }
    for (const approval of [null, "", manifestSha256, `${manifestSha256}\n${ACK}`, `${sha}\n${LEGACY_ACK}`, `${sha}\nI authorize at most 32 live HTTP requests`]) await test("no old partial or different approval", () => assert.throws(() => authorize(live, sha, approval, now)));
    for (const at of [NaN, Date.parse(live.createdAt) - 1, Date.parse(live.expiresAt), Date.parse(live.expiresAt) + 1]) await test("expiry", () => assert.throws(() => authorize(live, sha, token, at)));
    const mutations: Array<(m: any) => void> = [m => m.limits.maxHttpRequests++, m => m.policy.namespace = "sdk-context-live-v1", m => m.model.id = "other", m => m.model.maxTokens++,
      m => m.schemaVersion = 4, m => m.limits = LEGACY_LIMITS, m => m.policy = LEGACY_POLICY, m => m.referenceBudget = referenceBudget(LEGACY_LIMITS),
      m => m.settings.retry.enabled = true, m => m.runs.reverse(), m => m.runs.pop(), m => m.runs[0] = m.runs[1], m => m.prompts[RUNS[0].task] = "a".repeat(64),
      m => m.prepared[RUNS[0].runId].toolsSha256 = "a".repeat(64), m => m.prepared[RUNS[6].runId].wire.trimmed = 0,
      m => m.code.files["../secret"] = "a".repeat(64), m => m.fixture.files[RUNS[0].task][TARGET] = "a".repeat(64), m => m.calibration.summaryBytes = [], m => m.rawReply = "private-canary"];
    for (const mutate of mutations) await test("strict manifest", () => { const copy = structuredClone(manifest); mutate(copy); assert.throws(() => validateManifest(copy)); });
    const first = await raw(good.directory, 0);
    for (const mutate of [(r: any) => r.stages = [], (r: any) => r.stages[0].result.verifications = 0, (r: any) => r.stages[0].result.bridge.stopped = true,
      (r: any) => r.stages[0].after.extra = "a".repeat(64), (r: any) => r.stages[0].result.rawReply = "private-canary", (r: any) => r.reasonCode = "TASK_FAILED",
      (r: any) => r.stages[0].result.receipt.artifactSha256 = "a".repeat(64), (r: any) => r.stages[0].result.currentInputCopies = 2,
      (r: any) => r.stages[0].result.currentInputCopies = 0, (r: any) => delete r.transport, (r: any) => r.transport.stopCode = "TASK_REQUEST_LIMIT",
      (r: any) => r.transport.offers[0].payloadBytes++, (r: any) => r.transport.offers[0].kind = "summary", (r: any) => r.transport.offers.pop(),
      (r: any) => r.transport.offers[0].rawBody = "private-canary"]) await test("cannot forge pass", () => {
        const copy = structuredClone(first); mutate(copy); assert.throws(() => validateRecord(copy, manifest, manifestSha256, RUNS[0]));
      });
    for (const fault of ["raw-missing", "raw-drift", "extra", "binding-drift", "journal-gap", "index-drift", "aggregate-drift"]) await test(fault, async () => {
      const folder = await mkdtemp(path.join(temporary, "tamper-")); await cp(good.directory, folder, { recursive: true });
      if (fault === "raw-missing") await rm(path.join(folder, `raw/${RUNS[0].runId}.json`));
      if (fault === "raw-drift") await writeFile(path.join(folder, `raw/${RUNS[0].runId}.json`), JSON.stringify({ ...first, status: "fail" }));
      if (fault === "extra") await writeFile(path.join(folder, "extra.json"), "{}");
      if (fault === "binding-drift") await writeFile(path.join(folder, "requests/request-000001.json"), "{}");
      if (fault === "journal-gap") await rm(path.join(folder, "journal/event-000001.json"));
      if (fault === "index-drift") await writeFile(path.join(folder, "index.json"), "{}");
      if (fault === "aggregate-drift") await writeFile(path.join(folder, "aggregate.json"), JSON.stringify({ ...a, actualCostUsd: 0 }));
      await assert.rejects(() => recover(folder));
    });
    for (const fault of ["request-hash", "wrong-ordinal", "dispatched-count"]) await test(`diagnostic cross-check ${fault} after reseal`, async () => {
      const folder = await mkdtemp(path.join(temporary, "diagnostic-tamper-")); await cp(good.directory, folder, { recursive: true });
      const copy = structuredClone(first);
      if (fault === "request-hash") copy.transport.offers[0].requestSha256 = "0".repeat(64);
      if (fault === "wrong-ordinal") for (const offer of copy.transport.offers) offer.reservationOrdinal += 10;
      if (fault === "dispatched-count") copy.transport.offers[0].dispatchAttempted = false;
      await writeFile(path.join(folder, `raw/${RUNS[0].runId}.json`), JSON.stringify(copy));
      await rm(path.join(folder, "aggregate.json")); await rm(path.join(folder, "index.json")); await seal(folder);
      await assert.rejects(() => recover(folder));
    });
    await test("unsealed journal is unknown and read-only", async () => {
      const folder = await mkdtemp(path.join(temporary, "crash-")); await durableJson(path.join(folder, "manifest.json"), manifest);
      const journal = await journalScope.create(path.join(folder, "journal"), manifestSha256, "dry-run");
      await journal.reserve({ ordinal: 1, taskId: RUNS[0].runId, invocationId: 1, inputEstimate: 1, inputBytes: 1, outputReserved: 2048, requestSha256: "c".repeat(64) });
      const before = await treeManifest(folder), recovered = await recover(folder); assert.equal(recovered.status, "incomplete"); assert.equal(recovered.unknownRequests, 1); assert.ok(recovered.rows.every(r => r.status === "unknown")); assert.deepEqual(await treeManifest(folder), before);
    });
    for (const fault of ["source", "claimed"] as const) await test(`${fault} blocks before auth`, async () => {
      const folder = await mkdtemp(path.join(evidenceRoot, "s4-live-test-"));
      try { const m = structuredClone(live); m.batchId = path.basename(folder); if (fault === "source") { m.code.files[Object.keys(m.code.files)[0]] = "0".repeat(64); m.code.sha256 = digest(m.code.files); }
        const h = await durableJson(path.join(folder, "manifest.json"), m); if (fault === "claimed") await durableJson(path.join(folder, "claim.json"), {});
        await assert.rejects(() => runLive(folder, "nonexistent-private-config", h, true), fault === "source" ? /S4L_SOURCE_DRIFT/ : /S4L_ALREADY_CLAIMED/);
      } finally { await assertInside(evidenceRoot, folder); await rm(folder, { recursive: true, force: true }); }
    });
    for (const simulation of SIMULATIONS.filter(s => s !== "none" && s !== "readback")) {
      console.log(`S4 live tooling fault: ${simulation}`); const batch = await runDry(simulation as Exclude<Simulation, "none">), a = batch.aggregate;
      await test(`${simulation} no real calls`, () => assert.equal(a.realHttpDispatches, 0));
      await test(`${simulation} outcome`, async () => {
        if (["wrong-content", "no-write", "unverified"].includes(simulation)) { assert.equal(a.status, "completed-with-failures"); assert.deepEqual(a.rows.slice(0, 3).map(r => r.status), ["fail", "fail", "fail"]);
          for (let i = 0; i < 3; i++) { const s = (await raw(batch.directory, i)).stages[0].result; assert.equal(s.safe, true); assert.equal(s.verificationCurrent, false); if (i) assert.equal(s.supervisor.state, "BLOCKED_PREREQUISITE"); }
        } else if (simulation === "unchanged-loop") { assert.equal(a.status, "completed-with-failures"); for (const i of [3, 4]) { assert.equal(a.rows[i].businessOutcome, "no_progress_stopped"); assert.equal(a.rows[i].noProgressBranch, "triggered"); assert.equal(a.rows[i].requests, 3); }
          assert.equal(a.rows[5].businessOutcome, "blocked_prerequisite"); assert.equal(a.rows[5].requests, 4);
        } else if (["summary-too-large", "maintenance-disabled"].includes(simulation)) { assert.equal(a.status, "completed-with-failures"); assert.deepEqual(a.rows.slice(6).map(r => r.status), ["fail", "fail", "fail"]);
          const s = (await raw(batch.directory, 6)).stages[0].result; assert.equal(s.writes, 0); assert.equal(s.currentInputCopies, simulation === "summary-too-large" ? 0 : 1); if (simulation === "summary-too-large") { assert.equal(s.restoredInput, true); assert.equal(s.metrics.handledInputs, 1); }
        } else if (simulation === "reasoning-cache") { assert.equal(a.status, "completed-with-failures"); for (const r of a.rows.filter(r => r.requests)) { assert.equal(r.parsedUsage.cached, r.requests * 25); assert.equal(r.sdkUsage.total, r.requests * 130); assert.equal(r.parsedUsage.total, r.requests * 110); assert.equal(r.costUsd, null); } }
        else { assert.equal(a.status, "incomplete"); const stop = simulation.startsWith("summary-") ? 6 : simulation === "supervisor-persistence" ? 1 : 0;
          assert.equal(a.rows[stop].status, "unknown"); assert.ok(a.rows.slice(stop + 1).every(r => r.status === "blocked"));
          if (simulation.startsWith("summary-")) { const s = (await raw(batch.directory, 6)).stages[0].result; assert.equal(s.currentInputCopies, 0); assert.equal(s.restoredInput, true); assert.equal(s.compactions, 0); }
        }
      });
      await test(`${simulation} readback`, async () => { const before = await treeManifest(batch.directory); assert.deepEqual(await recover(batch.directory), a); assert.deepEqual(await treeManifest(batch.directory), before); });
      if (["request-limit", "summary-error", "summary-cancel", "missing-usage"].includes(simulation)) await test(`${simulation} explicit transport cause`, () => {
        const row = a.rows.find(r => r.status === "unknown")!, d = row.transportDiagnostics!;
        assert.equal(d.stopCode, ({ "request-limit": "TASK_REQUEST_LIMIT", "summary-error": "NETWORK_FAILURE", "summary-cancel": "REQUEST_ABORTED", "missing-usage": "USAGE_INVALID" } as Record<string, string>)[simulation]);
        if (simulation === "request-limit") { assert.equal(d.offered, 9); assert.equal(d.dispatched, 8); assert.equal(d.rejectedBeforeReservation, 1); assert.equal(d.failedAfterDispatch, 0);
          assert.equal(row.sdkUsage.input, 800); assert.equal(row.sdkUsage.output, 80); assert.match(formatDiagnostics(a), /TASK_REQUEST_LIMIT/); }
        else assert.equal(d.failedAfterDispatch, 1);
      });
      if (simulation === "request-limit") for (const version of [1, 2] as const) await test(`v${version} rejects eight-request journal even after rehash`, async () => {
        await assert.rejects(() => legacyCopy(batch.directory, temporary, version), /JOURNAL_BATCH_BUDGET/);
      });
      if (simulation === "missing-usage") for (const version of [1, 2] as const) await test(`v${version} failure keeps unknown SDK usage`, async () => {
        const legacy = await legacyCopy(batch.directory, temporary, version), before = await treeManifest(legacy.directory);
        assert.equal(legacy.aggregate.rows[0].sdkUsage.input, null); assert.equal(legacy.aggregate.rows[0].status, "unknown");
        assert.deepEqual(await recover(legacy.directory), legacy.aggregate); assert.deepEqual(await treeManifest(legacy.directory), before);
        if (version === 1) assert.ok(!formatDiagnostics(legacy.aggregate).includes("USAGE_INVALID"));
        else assert.equal(legacy.aggregate.rows[0].transportDiagnostics?.stopCode, "USAGE_INVALID");
      });
      await test(`${simulation} no sensitive retained data`, async () => { for (const file of Object.keys(await treeManifest(batch.directory))) assert.ok(!/https?:\/\/|private-canary|broker-placeholder-not-a-key/.test(await readFile(path.join(batch.directory, file), "utf8"))); });
      console.log(`S4 live retained ${simulation}: ${path.basename(batch.directory)}`);
    }
    console.log(`S4 live retained readback: ${path.basename(good.directory)}`); return count;
  } finally { await assertInside(process.env.PI_S4L_WORK_ROOT!, temporary); await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
}
