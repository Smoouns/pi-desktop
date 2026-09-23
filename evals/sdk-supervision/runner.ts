import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, digest, readBounded, sha256, treeManifest, writeOnce } from "../core/io.js";
import { extensionSource, validateProvenance } from "./extension.js";
import { LIMITS, PROFILES, plan, type Profile, type Task, type Scenario } from "./policy.js";
import { expected, judge, policy, rebuild, validateEvidence, validateManifest, validateRecord, type RecordRow } from "./records.js";

export async function snapshot() {
  const sources = JSON.parse(await readBounded(process.env.PI_S4_BUILD_INPUTS!)) as Record<string, string>;
  for (const [file, expected] of Object.entries(sources)) assert.equal(sha256(await readFile(file)), expected, "S4_SOURCE_CHANGED");
  for (const file of ["package.json", "package-lock.json", "scripts/run-sdk-supervision.mjs", "scripts/eval-network-guard.mjs"]) sources[file] = sha256(await readFile(file));
  for (const name of ["@mariozechner/pi-coding-agent", "@mariozechner/pi-agent-core", "@mariozechner/pi-ai"]) {
    const dir = `node_modules/${name}`; sources[dir + "/package.json"] = sha256(await readFile(dir + "/package.json")); sources[dir + "/dist-tree"] = digest(await treeManifest(dir + "/dist"));
  }
  return { sources, fixture: await treeManifest("fixtures/harness-novel") };
}
export async function runScenario(profile: Profile, task: Task, scenario: Scenario = "normal") {
  const work = await mkdtemp(path.join(process.env.PI_S4_WORK_ROOT!, "task-"));
  try {
    await cp("fixtures/harness-novel", path.join(work, "project"), { recursive: true, errorOnExist: true });
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href, process.env.PI_S4_BUNDLE!, "worker", work, profile, task, scenario],
      { cwd: process.cwd(), env: { ...process.env, PI_EVAL_WORKER: "1", PI_CODING_AGENT_DIR: path.join(work, "agent") }, encoding: "utf8", timeout: LIMITS.timeoutMs, maxBuffer: 32000, windowsHide: true });
    if (child.status !== 0) { console.error(`S4 worker ${profile}/${task}/${scenario}: ${child.stderr.slice(0, 3000)}`); throw new Error("S4_WORKER_UNKNOWN"); }
    return validateEvidence(JSON.parse(await readBounded(path.join(work, "result.json"))));
  } finally { await assertInside(process.env.PI_S4_WORK_ROOT!, work); await rm(work, { recursive: true, force: true, maxRetries: 3 }); }
}
export async function runBatch() {
  assert.ok((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active); await validateProvenance(); const initial = await snapshot();
  assert.equal(JSON.parse(await readBounded("node_modules/@mariozechner/pi-coding-agent/package.json")).version, "0.63.1");
  const root = path.resolve("artifacts/harness/sdk-supervision"); await mkdir(root, { recursive: true }); const directory = await mkdtemp(path.join(root, "s4-offline-")); await mkdir(path.join(directory, "raw"));
  const git = (args: string[]) => { const r = spawnSync("git", args, { encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0); return r.stdout.trim(); };
  const manifest = validateManifest({ schemaVersion: 1, kind: "sdk-supervision-offline", batchId: path.basename(directory), createdAt: new Date().toISOString(),
    code: { commit: git(["rev-parse", "HEAD"]), dirty: !!git(["status", "--porcelain"]), files: initial.sources, sha256: digest(initial.sources) }, fixture: initial.fixture,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, sdk: "0.63.1" }, policy: policy(), extensions: Object.fromEntries(PROFILES.map(p => [p, sha256(extensionSource(p))])), runs: plan() });
  await writeOnce(path.join(directory, "manifest.json"), manifest); const manifestSha256 = sha256(await readFile(path.join(directory, "manifest.json"))), entries = []; let stopped = false;
  for (const run of manifest.runs) {
    let row: RecordRow = { schemaVersion: 1, manifestSha256, run, status: "blocked", reason: "BATCH_STOPPED", sourceStable: false, evidence: null };
    if (!stopped) try {
      assert.deepEqual(await snapshot(), initial); const evidence = await runScenario(run.profile, run.task); assert.deepEqual(await snapshot(), initial);
      row = { ...row, ...judge(run, evidence), sourceStable: true, evidence }; stopped = !expected(run, row);
    } catch { row = { ...row, status: "unknown", reason: "WORKER_UNKNOWN" }; stopped = true; }
    validateRecord(row, run, manifest, manifestSha256); const file = `raw/${run.runId}.json`; await writeOnce(path.join(directory, file), row);
    entries.push({ runId: run.runId, file, sha256: sha256(await readFile(path.join(directory, file))) }); console.log(`${run.runId}: ${row.status} (${row.reason})`);
  }
  await writeOnce(path.join(directory, "index.json"), { schemaVersion: 1, manifestSha256, entries }); const aggregate = await rebuild(directory); await writeOnce(path.join(directory, "aggregate.json"), aggregate);
  return { directory, aggregate };
}
