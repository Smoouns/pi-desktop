import assert from "node:assert/strict";
import { fork, spawnSync, type ForkOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, digest, readBounded, sha256, treeManifest } from "../core/io.js";
import { resolvePilotPrivateConfig } from "../pilot/private-config.js";
import { validateProvenance } from "./profile.js";
import { fixture, fixtureHashes } from "./fixture.js";
import { createContextBroker } from "../sdk-context-transport/broker.js";
import { ACK, FEATURES, LIMITS, MODEL, POLICY, PRODUCT_LIMITS, RUNS, SETTINGS, TASKS, SYSTEM, TTL, VERSION, SCHEMA_VERSION, referenceBudget, type Run, type Simulation } from "./policy.js";
import { authorize, durableJson, exact, promptHashes, readManifest, validateManifest, type Manifest } from "./manifest.js";
import { boundary, recover, seal, stageSafe, taskPassed, validateRecord, validateWorker, type RecordRow } from "./records.js";
import { syntheticFetch } from "./synthetic.js";
import { observeRunTransport } from "./diagnostics.js";
import type { Start, WorkerResult } from "./session.js";
import type { Prepared } from "./session.js";


const root = process.cwd(); export const evidenceRoot = path.join(root, "artifacts/harness/sdk-supervision-live");
type Config = ReturnType<typeof resolvePilotPrivateConfig>;
type Broker = Awaited<ReturnType<typeof createContextBroker>>;
function workerEnv(work: string) {
	const env: NodeJS.ProcessEnv = {}; for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)) env[key] = value;
	return { ...env, PI_EVAL_WORKER: "1", PI_CODING_AGENT_DIR: path.join(work, "agent") };
}
const git = (args: string[]) => { const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0); return r.stdout.trim(); };
async function snapshot() {
	const sources = JSON.parse(await readBounded(process.env.PI_ABLATION_BUILD_INPUTS!)) as Record<string, string>;
	for (const [name, expected] of Object.entries(sources)) { assert.ok(/^(evals|tests|src)\//.test(name) && !name.includes("..")); assert.equal(sha256(await readFile(name)), expected, "S4L_SOURCE_DRIFT"); }
	for (const name of ["package.json", "package-lock.json", "scripts/run-sdk-supervision-live.mjs", "scripts/eval-network-guard.mjs", "scripts/pilot-broker-network.mjs", "node_modules/openai/package.json", "node_modules/openai/client.mjs"]) sources[name] = sha256(await readFile(name));
	for (const name of ["@mariozechner/pi-coding-agent", "@mariozechner/pi-agent-core", "@mariozechner/pi-ai"]) { const folder = `node_modules/${name}`; sources[`${folder}/package.json`] = sha256(await readFile(`${folder}/package.json`)); sources[`${folder}/dist-tree`] = digest(await treeManifest(`${folder}/dist`)); }
	return { sources, fixture: Object.fromEntries(TASKS.map(t => [t, fixtureHashes(t)])) };
}
async function runtime() {
	assert.equal(JSON.parse(await readBounded("node_modules/@mariozechner/pi-coding-agent/package.json")).version, "0.63.1");
	return { node: process.version, platform: process.platform, arch: process.arch, sdk: "0.63.1" as const, lockSha256: sha256(await readFile("package-lock.json")) };
}
async function fixtureWork(run: Run) {
  const work = await mkdtemp(path.join(process.env.PI_S4L_WORK_ROOT!, "task-")), project = path.join(work, "project");
  for (const [name, content] of Object.entries(fixture(run.task))) {
    const file = path.join(project, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content, { flag: "wx" });
  }
  return work;
}
async function worker(start: Start, broker?: Broker, signal?: AbortSignal, childReady?: (child: ReturnType<typeof fork> | null) => void): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		const child = fork(process.env.PI_S4L_BUNDLE!, ["worker"], { cwd: root, env: workerEnv(start.work), silent: true, windowsHide: true,
			execArgv: ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href] } as ForkOptions & { windowsHide: boolean });
		child.stdout?.resume(); child.stderr?.resume(); childReady?.(child);
		let finished = false, compacting = false, next = 0, result: WorkerResult | undefined; const pending = new Set<number>();
		const finish = (error?: Error) => {
			if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", stop); childReady?.(null);
			if (error) { broker?.stop(); child.kill(); reject(error); } else resolve(result!);
		};
		const stop = () => finish(new Error("S4L_WORKER_UNKNOWN"));
		const timer = setTimeout(stop, start.prepareOnly ? 45000 : LIMITS.taskTimeoutMs);
		if (signal?.aborted) { stop(); return; } signal?.addEventListener("abort", stop, { once: true });
		child.on("error", stop); child.on("close", code => finish(code === 0 && result && pending.size === 0 && !compacting ? undefined : new Error("S4L_WORKER_UNKNOWN")));
		child.on("message", (raw: any) => {
			if (finished) return;
			try {
				assert.ok(Buffer.byteLength(JSON.stringify(raw)) < 262144);
				if (raw?.type === "result") { exact(raw, ["type", "value"]); assert.ok(!result && !pending.size && !compacting); result = validateWorker(raw.value, start.prepareOnly); return; }
				assert.ok(!start.prepareOnly && !result && broker);
				if (raw?.type === "phase") { exact(raw, ["type", "compacting"]); assert.ok(FEATURES(start.run.profile).maintenance && start.run.task === "pressure-recover"); assert.equal(pending.size, 0); assert.equal(typeof raw.compacting, "boolean"); assert.notEqual(compacting, raw.compacting); compacting = raw.compacting; return; }
				if (raw?.type === "cancel") { exact(raw, ["type", "id"]); assert.ok(pending.has(raw.id)); broker.stop("REQUEST_ABORTED"); return; }
				exact(raw, ["type", "id", "kind", "body"]); assert.equal(raw.type, "request"); assert.equal(raw.id, ++next); assert.equal(raw.kind, compacting ? "summary" : "ordinary");
				assert.ok(pending.size === 0 || compacting && pending.size === 1); pending.add(raw.id);
				void broker.submit({ id: broker.snapshot().offered + 1, kind: raw.kind, body: raw.body, taskId: start.run.runId, stage: "single" }).then(response => {
					pending.delete(raw.id); if (!finished && child.connected) child.send({ type: "response", id: raw.id, ...response }, error => { if (error) stop(); });
				}, () => { pending.delete(raw.id); if (!finished && child.connected) child.send({ type: "stop", id: raw.id }, error => { if (error) stop(); }); });
			} catch { stop(); }
		});
		child.send(start, error => { if (error) stop(); });
	});
}
const startFor = (run: Run, work: string, config: Config, prepareOnly: boolean, expected: Prepared | null, simulation: Simulation): Start => ({
  type: "start", run, work, model: { ...config.runtimeModel, baseUrl: "https://pilot.invalid/v1" }, prepareOnly, expected, simulation
});
export const syntheticConfig = () => resolvePilotPrivateConfig({ providers: { [MODEL.provider]: { api: MODEL.api, baseUrl: "https://pilot.invalid/v1", apiKey: "synthetic-not-a-key",
	models: [{ id: MODEL.id, contextWindow: MODEL.contextWindow, maxTokens: 16384, compat: { maxTokensField: "max_tokens" } }] } } }, {}, false);
async function fileConfig(filename: string, credential: boolean) {
	try { return resolvePilotPrivateConfig(JSON.parse(await readBounded(filename)), process.env, credential); } catch { throw new Error("S4L_CONFIG_REJECTED"); }
}
let dryCache: { key: string; prepared: Manifest["prepared"]; calibration: Manifest["calibration"] } | null = null;
async function prepare(config: Config, simulation: Simulation) {
  await validateProvenance(); const expected = await snapshot(), key = digest({ expected, config: config.configSha256, runtime: await runtime() });
  const prepared: Manifest["prepared"] = {}; let calibration: Manifest["calibration"] | null = null;
  if (simulation !== "none" && dryCache?.key === key) { Object.assign(prepared, structuredClone(dryCache.prepared)); calibration = structuredClone(dryCache.calibration); }
  else {
    for (const run of RUNS) {
      const result = await worker(startFor(run, await fixtureWork(run), config, true, null, "none"));
      assert.deepEqual(result.before, expected.fixture[run.task]); assert.ok(boundary(run, result.before, result.after)); prepared[run.runId] = result.prepared;
      if (result.calibration) { assert.equal(calibration, null); calibration = result.calibration; }
    }
    assert.ok(calibration); if (simulation !== "none") dryCache = { key, prepared: structuredClone(prepared), calibration: structuredClone(calibration) };
  }
	assert.deepEqual(await snapshot(), expected, "S4L_SOURCE_DRIFT"); await mkdir(evidenceRoot, { recursive: true });
	const mode = simulation === "none" ? "live" : "dry-run", directory = await mkdtemp(path.join(evidenceRoot, mode === "live" ? "s4-live-" : "s4-dry-")), createdAt = new Date().toISOString();
	const manifest = validateManifest({ schemaVersion: SCHEMA_VERSION, kind: "sdk-supervision-live-manifest", mode, simulation, batchId: path.basename(directory), createdAt, expiresAt: new Date(Date.parse(createdAt) + TTL).toISOString(),
		model: config.publicModel, endpointSha256: config.endpointSha256, configSha256: config.configSha256, code: { commit: git(["rev-parse", "HEAD"]), dirty: !!git(["status", "--porcelain"]), files: expected.sources, sha256: digest(expected.sources) },
		fixture: { files: expected.fixture, sha256: digest(expected.fixture) }, runtime: await runtime(), prepared, calibration, runs: RUNS, limits: LIMITS, policy: POLICY, productLimits: PRODUCT_LIMITS, settings: SETTINGS, version: VERSION,
		prompts: promptHashes(), systemSha256: sha256(SYSTEM), referenceBudget: referenceBudget() });
	return { directory, manifest, manifestSha256: await durableJson(path.join(directory, "manifest.json"), manifest) };
}
export async function prepareLive(filename: string) { return prepare(await fileConfig(filename, false), "none"); }
export async function checkAuthorization(directory: string, approvalSha: string, acceptsUnknownCost: boolean) {
	await assertInside(evidenceRoot, directory); const batch = await readManifest(directory); assert.equal(path.basename(directory), batch.manifest.batchId);
	authorize(batch.manifest, batch.manifestSha256, acceptsUnknownCost ? `${approvalSha}\n${ACK}` : null);
	assert.deepEqual((await readdir(directory)).sort(), ["manifest.json"], "S4L_ALREADY_CLAIMED");
	assert.equal(git(["rev-parse", "HEAD"]), batch.manifest.code.commit, "S4L_HEAD_DRIFT"); await validateProvenance();
	assert.deepEqual(await snapshot(), { sources: batch.manifest.code.files, fixture: batch.manifest.fixture.files }, "S4L_SOURCE_DRIFT");
	assert.deepEqual(await runtime(), batch.manifest.runtime, "S4L_RUNTIME_DRIFT"); return batch;
}
async function execute(batch: Awaited<ReturnType<typeof prepare>>, config: Config, liveFetch?: typeof fetch) {
	const { directory, manifest, manifestSha256 } = batch, expected = { sources: manifest.code.files, fixture: manifest.fixture.files };
	assert.equal(manifest.configSha256, config.configSha256); assert.equal(manifest.endpointSha256, config.endpointSha256); assert.deepEqual(manifest.model, config.publicModel);
	assert.deepEqual(await snapshot(), expected); assert.deepEqual(await runtime(), manifest.runtime);
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")], attempts = guard?.attempts;
	if (manifest.mode === "dry-run") assert.ok(guard?.active && !liveFetch); else assert.ok(liveFetch && manifest.simulation === "none");
	let currentChild: ReturnType<typeof fork> | null = null, currentRun = RUNS[0];
	const mock = manifest.mode === "dry-run" ? syntheticFetch(manifest.simulation as Exclude<Simulation, "none">, () => ({ run: currentRun, kind: broker.snapshot().kinds.at(-1)!.kind }), () => currentChild?.send({ type: "cancel-fixture" })) : undefined;
	const broker = await createContextBroker({ directory, manifestSha256, policy: POLICY, route: { endpoint: config.endpoint, modelId: MODEL.id, outputField: config.publicModel.outputField, mode: manifest.mode }, fetchImpl: liveFetch ?? mock!,
		beforeReserve: async () => { assert.deepEqual(await snapshot(), expected); assert.ok(Date.now() < Date.parse(manifest.expiresAt), "S4L_APPROVAL_EXPIRED"); } });
	await mkdir(path.join(directory, "raw")); const abort = new AbortController(), stop = () => { broker.stop(); abort.abort(); }; let stopped = false;
	const timer = setTimeout(() => { broker.stop("BATCH_TIMEOUT"); abort.abort(); }, LIMITS.batchTimeoutMs); process.once("SIGINT", stop); process.once("SIGTERM", stop);
	try {
		for (const run of RUNS) {
			let record: RecordRow = { schemaVersion: SCHEMA_VERSION, manifestSha256, run, status: "blocked", reasonCode: "BATCH_STOPPED", sourceStable: false, stages: [], transport: null };
			if (!stopped) {
				currentRun = run;
				const observed = observeRunTransport(broker, run);
				// One wall-clock deadline covers maintenance, tools and HTTP.
				const taskTimer = setTimeout(() => { broker.stop("TASK_TIMEOUT"); abort.abort(); }, LIMITS.taskTimeoutMs);
				try {
					const work = await fixtureWork(run);
					assert.deepEqual(await snapshot(), expected);
                    const result = await worker(startFor(run, work, config, false, manifest.prepared[run.runId], manifest.simulation), observed.broker, abort.signal, child => { currentChild = child; });
                    record.stages.push(result);
                    if (!stageSafe(result.result!) || broker.snapshot().transport.state !== "active") stopped = true;
					record.sourceStable = digest(await snapshot()) === digest(expected) && (manifest.mode !== "dry-run" || attempts === guard.attempts);
					if (!record.sourceStable) stopped = true;
					record.status = stopped ? "unknown" : taskPassed(run, record.stages) ? "pass" : "fail";
					record.reasonCode = stopped ? record.sourceStable ? "SAFETY_STOP" : "SOURCE_DRIFT" : record.status === "pass" ? "PASS" : "TASK_FAILED";
				} catch { stopped = true; record.status = "unknown"; record.reasonCode = record.stages.length ? "SOURCE_DRIFT" : "WORKER_UNKNOWN"; }
				finally { clearTimeout(taskTimer); }
				if (stopped) broker.stop();
				record.transport = await observed.finish();
			}
			validateRecord(record, manifest, manifestSha256, run); await durableJson(path.join(directory, `raw/${run.runId}.json`), record);
		}
		await broker.close(stopped); await seal(directory); const aggregate = await recover(directory); await durableJson(path.join(directory, "aggregate.json"), aggregate); return aggregate;
	} finally { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); broker.stop(); }
}
export async function runLive(directory: string, filename: string, approvalSha: string, acceptsUnknownCost: boolean) {
	const batch = await checkAuthorization(directory, approvalSha, acceptsUnknownCost), configSha = sha256(await readBounded(filename)), config = await fileConfig(filename, true);
	const network = await import(pathToFileURL(path.join(root, "scripts/pilot-broker-network.mjs")).href);
	try { return await execute({ ...batch, directory }, config, network.createPinnedFetch(config.endpoint, config.credential)); }
	finally { assert.equal(sha256(await readBounded(filename)), configSha, "S4L_PRIVATE_CONFIG_CHANGED"); }
}
export async function runDry(simulation: Exclude<Simulation, "none"> = "readback") {
	const config = syntheticConfig(), batch = await prepare(config, simulation); return { directory: batch.directory, aggregate: await execute(batch, config) };
}
