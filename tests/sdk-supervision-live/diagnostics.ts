import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256, treeManifest } from "../../evals/core/io.js";
import { createContextBroker } from "../../evals/sdk-context-transport/broker.js";
import { freezeRequestPolicy } from "../../evals/core/request-policy.js";
import { observeRunTransport, validateTransportDiagnostic } from "../../evals/sdk-supervision-live/diagnostics.js";
import { LEGACY_LIMITS, LEGACY_POLICY, LIMITS, MODEL, POLICY, RUNS, referenceBudget } from "../../evals/sdk-supervision-live/policy.js";
import { recover, seal } from "../../evals/sdk-supervision-live/records.js";
import { legacyProfileHashes, type Manifest } from "../../evals/sdk-supervision-live/manifest.js";

type Test = (name: string, fn: () => void | Promise<void>) => Promise<void>;
export async function diagnosticUnitTests(test: Test, temporary: string) {
  const endpoint = "https://pilot.invalid/v1/chat/completions", body = JSON.stringify({ model: MODEL.id, max_tokens: 2048, messages: [] });
  for (const mode of ["task-limit", "timeout", "network", "before-dispatch"] as const) await test(`diagnostic ${mode}`, async () => {
    const directory = await mkdtemp(path.join(temporary, "diagnostic-")); let actualCalls = 0;
    const policy = mode === "timeout" ? freezeRequestPolicy({ namespace: "s4-diagnostics-unit-v1", taskIds: POLICY.taskIds, limits: { ...LIMITS, requestTimeoutMs: 20 } }) : POLICY;
    const broker = await createContextBroker({ directory, manifestSha256: "a".repeat(64), policy,
      route: { endpoint, modelId: MODEL.id, outputField: "max_tokens", mode: "dry-run" },
      beforeReserve: async () => { if (mode === "before-dispatch") throw new Error("private-canary-not-retained"); },
      fetchImpl: async () => { actualCalls++; if (mode === "timeout") return new Promise<Response>(() => undefined);
        if (mode === "network") throw new Error("private-canary-not-retained");
        return new Response('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n'); } });
    const observed = observeRunTransport(broker, RUNS[0]);
    const offer = (id: number) => ({ id, kind: "ordinary" as const, taskId: RUNS[0].runId, stage: "single" as const, body });
    if (mode === "task-limit") for (let i = 1; i <= LIMITS.maxTaskHttpRequests; i++) await observed.broker.submit(offer(i));
    await assert.rejects(() => observed.broker.submit(offer(mode === "task-limit" ? LIMITS.maxTaskHttpRequests + 1 : 1)));
    const firstStop = broker.snapshot().transport.stopCode; broker.stop();
    const d = await observed.finish(), last = d.offers.at(-1)!;
    assert.equal(d.stopCode, firstStop); assert.equal(last.stopCode, firstStop); assert.equal(last.returned, false);
    assert.equal(d.stopCode, ({ "task-limit": "TASK_REQUEST_LIMIT", timeout: "REQUEST_TIMEOUT", network: "NETWORK_FAILURE", "before-dispatch": "JOURNAL_FAILURE" } as const)[mode]);
    assert.equal(actualCalls, mode === "task-limit" ? LIMITS.maxTaskHttpRequests : mode === "before-dispatch" ? 0 : 1);
    assert.equal(last.dispatchAttempted, mode === "timeout" || mode === "network");
    assert.equal(last.reservationOrdinal, mode === "task-limit" ? null : 1);
    assert.ok(!JSON.stringify(d).includes("private-canary") && !JSON.stringify(d).includes("https:"));
    for (const mutate of [(v: any) => v.stopCode = "private-canary", (v: any) => v.rawError = "private-canary", (v: any) => v.offers[0].id = 0,
      (v: any) => v.offers.at(-1).returned = true, (v: any) => v.offers.at(-1).stopCode = null]) {
      const copy = structuredClone(d); mutate(copy); assert.throws(() => validateTransportDiagnostic(copy));
    }
    await broker.close(true);
  });
}

/** Synthetic compatibility fixture, never a migration of historical evidence. */
export function asLegacyManifest(source: Manifest, version: 1 | 2): Manifest {
  const manifest = structuredClone(source); manifest.schemaVersion = version;
  manifest.limits = structuredClone(LEGACY_LIMITS); manifest.policy = structuredClone(LEGACY_POLICY);
  manifest.referenceBudget = referenceBudget(LEGACY_LIMITS);
  for (const run of RUNS) manifest.prepared[run.runId].extensionSha256 = legacyProfileHashes(version)[run.profile];
  return manifest;
}

export async function legacyCopy(source: string, temporary: string, version: 1 | 2 = 1) {
  const directory = await mkdtemp(path.join(temporary, "legacy-")); await cp(source, directory, { recursive: true });
  const read = async (name: string) => JSON.parse(await readFile(path.join(directory, name), "utf8"));
  const write = async (name: string, value: unknown) => {
    const text = JSON.stringify(value, null, 2) + "\n"; await writeFile(path.join(directory, name), text); return sha256(text);
  };
  const manifest = asLegacyManifest(await read("manifest.json"), version);
  const manifestSha256 = await write("manifest.json", manifest);
  const files = Object.keys(await treeManifest(directory));
  const claim = await read("journal/claim.json"); claim.manifestSha256 = manifestSha256; claim.kind = `${LEGACY_POLICY.namespace}-journal-claim`;
  let previous = await write("journal/claim.json", claim);
  for (const file of files.filter(file => /^journal\/event-/.test(file)).sort()) {
    const event = await read(file); event.manifestSha256 = manifestSha256; event.prevSha256 = previous; previous = await write(file, event);
  }
  const journal = await read("journal/index.json"); journal.manifestSha256 = manifestSha256; journal.lastSha256 = previous;
  journal.kind = `${LEGACY_POLICY.namespace}-journal-index`; await write("journal/index.json", journal);
  for (const file of files.filter(file => file.startsWith("raw/"))) {
    const record = await read(file); record.schemaVersion = version; record.manifestSha256 = manifestSha256; if (version === 1) delete record.transport;
    for (const stage of record.stages) stage.prepared.extensionSha256 = manifest.prepared[record.run.runId].extensionSha256;
    await write(file, record);
  }
  await rm(path.join(directory, "aggregate.json")); await rm(path.join(directory, "index.json")); await seal(directory);
  const aggregate = await recover(directory); await write("aggregate.json", aggregate);
  return { directory, aggregate };
}
