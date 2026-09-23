import assert from "node:assert/strict";
import { fork, spawnSync, type ForkOptions } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest, readBounded, sha256, treeManifest } from "../core/io.js";
import { durableJson, exact } from "../sdk-live/manifest.js";
import { createContextBroker } from "./broker.js";
import { MODEL, LIMITS, VERSION, policyFor, settingsFor, type Scenario } from "./policy.js";
import { promptDigest, recover, seal, validateManifest, validateWorker, type Result } from "./records.js";
import { createSyntheticFetch } from "./synthetic.js";
import type { WorkerResult, WorkerStart } from "./worker.js";

export const evidenceRoot = path.resolve("artifacts/harness/sdk-context-transport");
export async function sourceSnapshot() {
	const sources = JSON.parse(await readBounded(process.env.PI_S3T_INPUTS!)) as Record<string, string>;
	for (const [name, value] of Object.entries(sources)) {
		assert.ok(/^(evals|tests)\//.test(name) && !name.includes("..")); assert.equal(sha256(await readFile(name)), value, "S3T_SOURCE_DRIFT");
	}
	for (const file of ["package.json", "package-lock.json", "scripts/run-sdk-context-transport.mjs", "scripts/eval-network-guard.mjs"]) sources[file] = sha256(await readFile(file));
	for (const name of ["@mariozechner/pi-coding-agent", "@mariozechner/pi-ai", "@mariozechner/pi-agent-core"]) {
		const directory = `node_modules/${name}`; sources[`${directory}/package.json`] = sha256(await readFile(`${directory}/package.json`)); sources[`${directory}/dist-tree`] = digest(await treeManifest(`${directory}/dist`));
	}
	sources["node_modules/openai/package.json"] = sha256(await readFile("node_modules/openai/package.json"));
	// Bind the real SDK HTTP client, including its retry code, not just package metadata.
	sources["node_modules/openai/client.mjs"] = sha256(await readFile("node_modules/openai/client.mjs"));
	return sources;
}

/** Only local SSE injection is reachable in this stage. No models.json input,
 * private-config resolver, authorization token, credential, or live fetch. */
export async function runTransportProbe(scenario: Scenario) {
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")]; assert.ok(guard?.active);
	const attempts = guard.attempts, sources = await sourceSnapshot();
	assert.equal(JSON.parse(await readBounded("node_modules/@mariozechner/pi-coding-agent/package.json")).version, "0.63.1");
	await mkdir(evidenceRoot, { recursive: true });
	const directory = await mkdtemp(path.join(evidenceRoot, "s3-transport-")), work = await mkdtemp(path.join(process.env.PI_S3T_WORK_ROOT!, "task-"));
	const git = (args: string[]) => { const r = spawnSync("git", args, { encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0); return r.stdout.trim(); };
	const manifest = validateManifest({ schemaVersion: 1, kind: "sdk-context-transport-offline", batchId: path.basename(directory), createdAt: new Date().toISOString(), scenario,
		code: { commit: git(["rev-parse", "HEAD"]), dirty: !!git(["status", "--porcelain"]), files: sources, sha256: digest(sources) },
		runtime: { node: process.version, platform: process.platform, arch: process.arch, sdk: "0.63.1" }, policy: policyFor(scenario), settings: settingsFor(scenario), version: VERSION, promptsSha256: promptDigest(), modelSha256: digest(MODEL) });
	const manifestSha256 = await durableJson(path.join(directory, "manifest.json"), manifest);
	let child: ReturnType<typeof fork> | undefined;
	const mock = createSyntheticFetch(scenario, () => broker.snapshot().kinds.at(-1)!.kind, kind => child?.send({ type: "cancel-fixture", kind }));
	const broker = await createContextBroker({ directory, manifestSha256, policy: manifest.policy, fetchImpl: mock.fetchImpl });
	let worker: WorkerResult | null = null, failed = false;
	const stop = () => { failed = true; broker.stop(); child?.kill(); };
	process.once("SIGINT", stop); process.once("SIGTERM", stop);
	try {
		await new Promise<void>((resolve, reject) => {
			const env: NodeJS.ProcessEnv = {};
			for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)) env[key] = value;
			Object.assign(env, { PI_EVAL_WORKER: "1", PI_CODING_AGENT_DIR: path.join(work, "agent") });
			child = fork(process.env.PI_S3T_BUNDLE!, ["worker"], { cwd: process.cwd(), env, silent: true, windowsHide: true,
				execArgv: ["--import", pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href] } as ForkOptions & { windowsHide: boolean });
			child.stdout?.resume(); child.stderr?.resume();
			let phase = false, pending = 0, done = false;
			const timer = setTimeout(stop, LIMITS.taskTimeoutMs);
			const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(); };
			child.on("error", () => { stop(); finish(new Error("S3T_WORKER_UNKNOWN")); });
			child.on("close", code => finish(code === 0 && worker && !pending && !phase && !failed ? undefined : new Error("S3T_WORKER_UNKNOWN")));
			child.on("message", (raw: any) => {
				if (done) return;
				try {
					assert.ok(Buffer.byteLength(JSON.stringify(raw)) < 65536);
					if (raw?.type === "phase") { exact(raw, ["type", "compacting"]); assert.ok(!pending && !worker); assert.equal(typeof raw.compacting, "boolean"); assert.notEqual(phase, raw.compacting); phase = raw.compacting; return; }
					if (raw?.type === "cancel") { exact(raw, ["type", "id"]); assert.ok(Number.isInteger(raw.id) && raw.id > 0 && raw.id <= broker.snapshot().offered && !worker); broker.stop("REQUEST_ABORTED"); return; }
					if (raw?.type === "result") { exact(raw, ["type", "value"]); assert.ok(!worker && !pending && !phase); worker = validateWorker(raw.value); return; }
					exact(raw, ["type", "id", "kind", "body"]); assert.equal(raw.type, "request"); assert.ok(!worker && raw.kind === (phase ? "summary" : "ordinary"));
					pending++;
					void broker.submit({ id: raw.id, kind: raw.kind, body: raw.body }).then(response => {
						pending--; if (child?.connected) child.send({ type: "response", id: raw.id, ...response }, error => { if (error) stop(); });
					}, () => { pending--; if (child?.connected) child.send({ type: "stop", id: raw.id }, error => { if (error) stop(); }); });
				} catch { stop(); }
			});
			child.send({ type: "start", scenario, work } satisfies WorkerStart, error => { if (error) stop(); });
		});
	} catch { failed = true; }
	finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
	let sourceStable = false;
	try { sourceStable = digest(await sourceSnapshot()) === digest(sources); } catch { sourceStable = false; }
	await broker.close(failed || !sourceStable);
	const snapshot = broker.snapshot();
	const result: Result = { schemaVersion: 1, manifestSha256, worker, sourceStable, zeroNetwork: attempts === guard.attempts,
		broker: { offered: snapshot.offered, maxConcurrentOffers: snapshot.maxConcurrentOffers, stopCode: snapshot.transport.stopCode }, simulation: mock.snapshot() };
	await durableJson(path.join(directory, "result.json"), result); await seal(directory);
	const aggregate = await recover(directory); await durableJson(path.join(directory, "aggregate.json"), aggregate);
	return { directory, aggregate };
}
