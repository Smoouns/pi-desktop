import assert from "node:assert/strict";
import { fork, spawnSync, type ChildProcess, type ForkOptions } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, digest, readBounded, sha256, treeManifest, writeOnce } from "../core/io.js";
import { validateContextProvenance } from "../sdk-context/extension.js";
import { lifecycleExtensionSource } from "../sdk-context/lifecycle-extension.js";
import { CONTENT, LIMITS, PROFILE, TARGET, plan, emptyEvidence, type Run } from "./policy.js";
import { readSessionPath, projectBoundary } from "./session.js";
import { exact } from "../sdk-context/records.js";
import { initialHash, passes, policy, rebuild, validateManifest, validateRecord, validateResume, validateSeed, type Manifest, type RecordRow } from "./records.js";

const guardUrl = () => pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href;
export async function snapshot() {
  const sources = JSON.parse(await readBounded(process.env.PI_RACE_BUILD_INPUTS!));
  for (const [file, expected] of Object.entries(sources)) { assert.ok(/^(evals|tests)\//.test(file)); assert.equal(sha256(await readFile(file)), expected); }
  for (const file of ["package.json", "package-lock.json", "scripts/run-sdk-recovery-races.mjs", "scripts/eval-network-guard.mjs"]) sources[file] = sha256(await readFile(file));
  for (const name of ["@mariozechner/pi-coding-agent", "@mariozechner/pi-agent-core", "@mariozechner/pi-ai"]) { const dir = `node_modules/${name}`; sources[`${dir}/package.json`] = sha256(await readFile(`${dir}/package.json`)); sources[`${dir}/dist-tree`] = digest(await treeManifest(`${dir}/dist`)); }
  return { sources, fixture: await treeManifest("fixtures/harness-novel") };
}
function launch(work: string, args: string[], children: Set<ChildProcess>) {
  const child = fork(process.env.PI_RACE_BUNDLE!, args, { cwd: process.cwd(), env: { ...process.env, PI_EVAL_WORKER: "1", PI_CODING_AGENT_DIR: path.join(work, "agent") },
    silent: true, windowsHide: true, execArgv: ["--import", guardUrl()] } as ForkOptions & { windowsHide: boolean });
  children.add(child); child.stdout?.resume(); child.stderr?.resume();
  const messages: any[] = [], wake = new Set<() => void>(); let exited = false, failed = false;
  const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, LIMITS.childMs);
  const signal = () => { for (const fn of wake) fn(); wake.clear(); };
  child.on("error", () => { failed = true; signal(); });
  child.on("message", value => { if (JSON.stringify(value).length > 16384 || messages.length >= 4) { failed = true; child.kill("SIGKILL"); } else messages.push(value); signal(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, sig) => { clearTimeout(timer); exited = true; children.delete(child); signal(); resolve({ code, signal: sig }); }));
  const wait = async (type: string) => {
    for (;;) { if (failed) throw new Error("RACE_CHILD_FAILED"); const index = messages.findIndex(m => m?.type === type); if (index >= 0) return messages.splice(index, 1)[0]; assert.ok(!exited, "RACE_EARLY_EXIT"); await new Promise<void>(resolve => wake.add(resolve)); }
  };
  return { child, wait, closed };
}
export async function runCase(run: Run) {
  const work = await mkdtemp(path.join(process.env.PI_RACE_WORK_ROOT!, "case-")), children = new Set<ChildProcess>(), evidence = emptyEvidence();
  await cp("fixtures/harness-novel", path.join(work, "project"), { recursive: true, errorOnExist: true });
  const before = await treeManifest(path.join(work, "project"));
  const timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, LIMITS.caseMs);
  try {
    const executor = run.scenario === "late-effect" ? launch(work, ["executor", work], children) : null;
    if (executor) { exact(await executor.wait("executor-ready"), ["type"]); evidence.executorReady = true; }
    const seed = launch(work, ["worker", work, run.scenario, "seed"], children);
    const barrier = exact(await seed.wait("barrier"), ["type", "value"]); evidence.seed = validateSeed(barrier.value);
    const sessionBytes = await readFile(await readSessionPath(work));
    const entries = sessionBytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    const checkpoint = [...entries].reverse().find(e => e.type === "custom" && e.customType === "pi-desktop-task-checkpoint")?.data;
    const op = checkpoint?.pendingOperations.at(-1);
    assert.equal(sha256(sessionBytes), evidence.seed.sessionSha256); assert.equal(digest(checkpoint), evidence.seed.checkpointSha256);
    assert.ok(op?.operationId === "seed-write" && op.state === "issued" && op.dispatched && op.expectedPostHash === sha256(CONTENT));
    assert.equal((await treeManifest(path.join(work, "project")))[TARGET] ?? null, initialHash(run.scenario)); evidence.seedDiskVerified = true;
    evidence.killed = seed.child.kill("SIGKILL");
    const exit = await seed.closed; evidence.exited = true; evidence.exitCode = exit.code; evidence.exitSignal = exit.signal;
    evidence.gracefulCleanup = await stat(path.join(work, "seed-graceful-cleanup.json")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    const resume = async () => {
      const child = launch(work, ["worker", work, run.scenario, "resume"], children);
      const response = exact(await child.wait("result"), ["type", "value"]); evidence.resumes.push(validateResume(response.value));
      const exit = await child.closed; assert.equal(exit.code, 0); assert.equal(exit.signal, null);
    };
    await resume();
    if (executor) {
      assert.equal(evidence.resumes[0].pendingAfter, "issued"); assert.equal(evidence.resumes[0].targetSha256, null); assert.equal(evidence.resumes[0].writeDispatches, 0);
      evidence.executorReleasedAfterRecovery = true;
      executor.child.send({ type: "commit" }); const result = exact(await executor.wait("executor-done"), ["type", "effects", "sha256"]);
      assert.equal(result.effects, 1); assert.equal(result.sha256, sha256(CONTENT)); evidence.executorEffects = result.effects;
      const exit = await executor.closed; assert.equal(exit.code, 0); assert.equal(exit.signal, null);
      assert.equal((await treeManifest(path.join(work, "project")))[TARGET], sha256(CONTENT)); await resume();
    }
    evidence.boundary = projectBoundary(before, await treeManifest(path.join(work, "project")));
    return evidence;
  } catch { throw Object.assign(new Error("RACE_WORKER_UNKNOWN"), { evidence }); }
  finally {
    clearTimeout(timer);
    await Promise.all([...children].map(child => new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill("SIGKILL"); })));
    await assertInside(process.env.PI_RACE_WORK_ROOT!, work); await rm(work, { recursive: true, force: true, maxRetries: 3 });
  }
}
export async function runBatch() {
  assert.ok((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active); await validateContextProvenance(); const initial = await snapshot();
  assert.equal(JSON.parse(await readBounded("node_modules/@mariozechner/pi-coding-agent/package.json")).version, "0.63.1");
  const parent = path.resolve("artifacts/harness/sdk-recovery-races"); await mkdir(parent, { recursive: true }); const directory = await mkdtemp(path.join(parent, "s3-races-")); await mkdir(path.join(directory, "raw"));
  const git = (args: string[]) => { const r = spawnSync("git", args, { encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0); return r.stdout.trim(); };
  const manifest: Manifest = validateManifest({ schemaVersion: 1, kind: "sdk-recovery-races-offline", batchId: path.basename(directory), createdAt: new Date().toISOString(),
    code: { commit: git(["rev-parse", "HEAD"]), dirty: !!git(["status", "--porcelain"]), files: initial.sources, sha256: digest(initial.sources) }, fixture: initial.fixture,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, sdk: "0.63.1" }, policy: policy(), extensionSha256: sha256(lifecycleExtensionSource(PROFILE)), runs: plan() });
  await writeOnce(path.join(directory, "manifest.json"), manifest); const manifestSha256 = sha256(await readFile(path.join(directory, "manifest.json"))), entries = []; let stopped = false;
  for (const run of manifest.runs) {
    const row: RecordRow = { schemaVersion: 1, manifestSha256, run, status: "blocked", reason: "BATCH_STOPPED", evidence: null };
    if (!stopped) {
      try { assert.deepEqual(await snapshot(), initial); row.evidence = await runCase(run); assert.deepEqual(await snapshot(), initial); row.evidence.sourceStable = true;
        row.status = passes(run, row.evidence) ? "pass" : "fail"; row.reason = row.status === "pass" ? "PASS" : "CONTRACT_FAILED";
      } catch (error) { row.evidence ??= (error as any).evidence ?? null; row.status = "unknown"; row.reason = "WORKER_UNKNOWN"; }
      stopped = row.status !== "pass";
    }
    validateRecord(row, run, manifestSha256); const file = `raw/${run.runId}.json`; await writeOnce(path.join(directory, file), row); entries.push({ runId: run.runId, file, sha256: sha256(await readFile(path.join(directory, file))) });
    console.log(`${run.runId}: ${row.status}`);
  }
  await writeOnce(path.join(directory, "index.json"), { schemaVersion: 1, manifestSha256, entries }); const aggregate = await rebuild(directory); await writeOnce(path.join(directory, "aggregate.json"), aggregate);
  return { directory, aggregate };
}
