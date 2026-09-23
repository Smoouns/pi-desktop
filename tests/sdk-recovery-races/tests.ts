import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInside, sha256, treeManifest } from "../../evals/core/io.js";
import { installDurableOperations } from "../../evals/sdk-context/lifecycle-extension.js";
import { runBatch } from "../../evals/sdk-recovery-races/runner.js";
import { passes, rebuild, validateRecord, validateResume, validateManifest } from "../../evals/sdk-recovery-races/records.js";

/** Adapter callback guards only, separate from the real killed-process matrix. */
async function lateCallbackTests() {
  let checks = 0;
  for (const where of ["before-fingerprint", "during-fingerprint"] as const) for (const change of ["abort", "generation", "session", "role", "project"] as const) {
    const handlers = new Map<string, any[]>(), operations: any[] = [];
    const key = "pi.race.test-control", metricsKey = "pi.race.test-metrics";
    const original = { scope: { generation: 1, session: "a", role: "write", project: "a" }, controller: new AbortController() };
    let active = original, phase = "intent", release: () => void = () => {}, started: () => void = () => {};
    const barrier = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const control = { current: () => active, runtime: { writeGate: async () => null, operation: (_ctx: any, _run: any, op: any) => operations.push(op) } };
    (globalThis as any)[Symbol.for(key)] = control;
    const api = { on: (name: string, fn: any) => handlers.set(name, [...handlers.get(name) ?? [], fn]), appendEntry: () => {} };
    installDurableOperations(api, { createHash, path, lstat: () => {}, readFile: async () => { if (phase === "result" && where === "during-fingerprint") { started(); await blocked; } return Buffer.from("result"); },
      controlKey: key, metricsKey, faultKey: "pi.race.no-fault", createSafety: () => ({ check: async () => {}, checkedPath: async () => "public-target" }) }, () => {});
    const event = { toolName: "write", toolCallId: "old-tool", input: { path: "drafts/x.md", content: "result" }, isError: false }, ctx = { cwd: "public", abort() { throw new Error("Unexpected abort"); } };
    try {
      for (const fn of handlers.get("tool_call")!) await fn(event, ctx);
      assert.equal(operations.length, 2); checks++;
      const switchRun = () => {
        if (change === "abort") original.controller.abort();
        else active = { scope: { ...original.scope, ...(change === "generation" ? { generation: 2 } : { [change]: "b" }) }, controller: new AbortController() };
      };
      phase = "result";
      if (where === "before-fingerprint") switchRun();
      const pending = handlers.get("tool_result")![0](event, ctx);
      if (where === "during-fingerprint") { await barrier; switchRun(); release(); }
      await pending;
      assert.equal(operations.length, 2); checks++;
      const metrics = (globalThis as any)[Symbol.for(metricsKey)]; assert.equal(metrics.staleResults, 1); assert.equal(metrics.results, 0); checks += 2;
      await handlers.get("tool_result")![0](event, ctx); assert.equal(operations.length, 2); assert.equal(metrics.staleResults, 1); checks += 2;
    } finally { release(); delete (globalThis as any)[Symbol.for(key)]; delete (globalThis as any)[Symbol.for(metricsKey)]; }
  }
  return checks;
}

export async function runTests() {
  let checks = await lateCallbackTests();
  const batch = await runBatch();
  assert.equal(batch.aggregate.status, "pass"); checks++;
  assert.equal(batch.aggregate.rows.length, 12); checks++;
  for (const row of batch.aggregate.rows) {
    assert.equal(row.status, "pass"); assert.equal(row.resumeWriteDispatches, 0); checks += 2;
    assert.equal(row.operationOutcome, ["before-effect", "partial-effect"].includes(row.run.scenario) ? "unknown-replay-blocked" : "satisfied-by-readback"); checks++;
  }
  const before = await treeManifest(batch.directory); assert.deepEqual(await rebuild(batch.directory), batch.aggregate); checks++;
  assert.deepEqual(await treeManifest(batch.directory), before); checks++;
  const sample = JSON.parse(await readFile(path.join(batch.directory, "raw/after-effect-r1.json"), "utf8"));
  for (const change of [
    (e: any) => { e.killed = false; }, (e: any) => { e.gracefulCleanup = true; }, (e: any) => { e.seedDiskVerified = false; },
    (e: any) => { e.resumes[0].writeDispatches = 1; }, (e: any) => { e.resumes[0].replayResults = ["success", "success"]; },
    (e: any) => { e.resumes[0].pendingAfter = "issued"; }, (e: any) => { e.sourceStable = false; }, (e: any) => { e.seed.durableIntent = false; }
  ]) {
    const bad = structuredClone(sample); change(bad.evidence); assert.equal(passes(bad.run, bad.evidence), false); checks++;
    assert.throws(() => validateRecord(bad, bad.run, bad.manifestSha256)); checks++;
  }
  const late = JSON.parse(await readFile(path.join(batch.directory, "raw/late-effect-r1.json"), "utf8"));
  late.evidence.executorReleasedAfterRecovery = false; assert.equal(passes(late.run, late.evidence), false); checks++;
  const partial = JSON.parse(await readFile(path.join(batch.directory, "raw/partial-effect-r1.json"), "utf8"));
  partial.evidence.resumes[0].pendingAfter = "completed"; assert.throws(() => validateRecord(partial, partial.run, partial.manifestSha256)); checks++;
  const unknown = { ...sample, status: "unknown", reason: "WORKER_UNKNOWN", evidence: { ...sample.evidence, sourceStable: false, resumes: [] } };
  validateRecord(unknown, unknown.run, unknown.manifestSha256); checks++;
  assert.throws(() => validateRecord({ ...unknown, status: "pass", reason: "PASS" }, unknown.run, unknown.manifestSha256)); checks++;
  assert.throws(() => validateResume({ ...sample.evidence.resumes[0], rawResponse: "not-allowed" })); checks++;
  const manifest = JSON.parse(await readFile(path.join(batch.directory, "manifest.json"), "utf8"));
  assert.throws(() => validateManifest({ ...manifest, policy: { ...manifest.policy, realHttpDispatches: 1 } })); checks++;
  const tmp = await mkdtemp(path.join(process.env.PI_RACE_WORK_ROOT!, "tamper-"));
  try {
    await cp(batch.directory, path.join(tmp, "batch"), { recursive: true });
    const file = path.join(tmp, "batch/raw/after-effect-r1.json"); await writeFile(file, JSON.stringify({ ...sample, status: "fail" }));
    await assert.rejects(() => rebuild(path.join(tmp, "batch"))); checks++;
    await writeFile(file, await readFile(path.join(batch.directory, "raw/after-effect-r1.json")));
    await writeFile(path.join(tmp, "batch/extra.json"), "{}"); await assert.rejects(() => rebuild(path.join(tmp, "batch"))); checks++;
  } finally { await assertInside(process.env.PI_RACE_WORK_ROOT!, tmp); await rm(tmp, { recursive: true, force: true, maxRetries: 3 }); }
  for (const file of Object.keys(before)) {
    const text = await readFile(path.join(batch.directory, file), "utf8");
    assert.ok(!/Bearer\s|sk-[A-Za-z0-9]{16,}|https?:\/\/|"(?:apiKey|messages|content|headers|authorization)"\s*:/.test(text));
  }
  checks++;
  return { checks, directory: batch.directory, manifestSha256: sha256(await readFile(path.join(batch.directory, "manifest.json"))), processCases: 12, adapterCallbackCases: 10, realModelRequests: 0 };
}
