import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, digest, readBounded, sha256, treeManifest, writeOnce } from "../core/io.js";
import { projectPilotModel } from "./model.js";
import { PILOT_LIMITS, PILOT_MODEL, PILOT_PROMPTS, PILOT_SYSTEM, PILOT_TASK_IDS, type PilotTaskId } from "./policy.js";
import { createRehearsalProvider } from "./rehearsal-provider.js";
import { createRehearsalManifest, pilotRecordDigest, rebuildPilotBatch, sealPilotBatch, writePilotManifest, type PilotRunRecord } from "./records.js";
import { runPilotSdkTask, type PilotSdkSessionSummary } from "./sdk-session.js";
import { createPilotTransport, type PilotTransportSnapshot } from "./transport.js";

const root = process.cwd();
type Prepared = { taskId: PilotTaskId; toolNames: string[]; toolsSha256: string; systemSha256: string };
type WorkerResult = { prepared: Prepared; summary: PilotSdkSessionSummary; transport: PilotTransportSnapshot; before: Record<string, string>; after: Record<string, string> };

export async function sourceSnapshot(): Promise<Record<string, string>> {
	const inputs = JSON.parse(await readBounded(process.env.PI_PILOT_BUILD_INPUTS!)) as Record<string, string>;
	for (const [name, expected] of Object.entries(inputs)) {
		assert.ok(/^(evals|tests|src)\//.test(name) && !name.includes(".."), "PILOT_SOURCE_PATH");
		assert.equal(sha256(await readFile(path.join(root, name))), expected, "PILOT_SOURCE_DRIFT");
	}
	for (const name of ["package.json", "package-lock.json", "scripts/run-pilot-evals.mjs", "scripts/eval-network-guard.mjs"]) inputs[name] = sha256(await readFile(path.join(root, name)));
	// Installed runtime bytes, not just the lockfile's intended versions.
	for (const name of ["@mariozechner/pi-coding-agent", "@mariozechner/pi-agent-core", "@mariozechner/pi-ai", "openai"]) {
		const folder = `node_modules/${name}`;
		inputs[`${folder}/package.json`] = sha256(await readFile(path.join(root, folder, "package.json")));
		const files = await treeManifest(path.join(root, folder, name === "openai" ? "core" : "dist"));
		inputs[`${folder}/runtime-tree`] = digest(files);
	}
	inputs["node_modules/openai/client.mjs"] = sha256(await readFile(path.join(root, "node_modules/openai/client.mjs")));
	return inputs;
}

export function testPilotWorkerGuard(): number {
	const result = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href,
		process.env.PI_PILOT_BUNDLE!, "guard-probe"], { cwd: root, env: { ...process.env, PI_EVAL_WORKER: "1" }, encoding: "utf8", timeout: 10_000, windowsHide: true });
	if (result.status !== 0) throw new Error(result.stderr?.match(/^Pilot rejected: ([A-Z0-9_]+)\s*$/m)?.[1] ?? "PILOT_GUARD_TEST_FAILED");
	assert.equal(result.stdout.trim(), "PILOT_GUARD_PASS", "PILOT_GUARD_TEST_FAILED");
	return 4;
}

export async function testPilotSdkWorker(): Promise<number> {
	const directory = await mkdtemp(path.join(process.env.PI_PILOT_WORK_ROOT!, "sdk-test-"));
	const result = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href,
		process.env.PI_PILOT_BUNDLE!, "sdk-test-worker"], { cwd: root, env: { ...process.env, PI_EVAL_WORKER: "1", PI_CODING_AGENT_DIR: path.join(directory, "agent") },
		encoding: "utf8", timeout: 45_000, maxBuffer: 64_000, windowsHide: true });
	if (result.status !== 0) throw new Error(result.stderr?.match(/^Pilot rejected: ([A-Z0-9_]+)\s*$/m)?.[1] ?? "PILOT_SDK_TEST_FAILED");
	const match = result.stdout.trim().match(/^PILOT_SDK_TEST_PASS (\d+)$/);
	assert.ok(match, "PILOT_SDK_TEST_FAILED");
	return Number(match[1]);
}

/** Invoked only by the offline parent under the network/subprocess guard. */
export async function runRehearsalWorker(taskId: PilotTaskId, directory: string, prepareOnly: boolean): Promise<void> {
	assert.equal(process.env.PI_EVAL_WORKER, "1", "PILOT_WORKER_REQUIRED");
	assert.ok(PILOT_TASK_IDS.includes(taskId), "PILOT_TASK_INVALID");
	await assertInside(process.env.PI_PILOT_WORK_ROOT!, directory);
	const projectRoot = path.join(directory, "project"), agentDir = path.join(directory, "agent");
	assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir, "PILOT_AGENT_DIR_MISMATCH");
	const { runtimeModel } = projectPilotModel({ providers: { [PILOT_MODEL.provider]: { api: PILOT_MODEL.api, baseUrl: "https://pilot.invalid/v1", models: [{
		id: PILOT_MODEL.id, contextWindow: PILOT_MODEL.contextWindow, maxTokens: 16_384, compat: { maxTokensField: "max_tokens" },
	}] } } });
	const scripted = createRehearsalProvider(taskId);
	const transport = createPilotTransport({ endpoint: "https://pilot.invalid/v1/chat/completions", modelId: PILOT_MODEL.id, outputField: "max_tokens",
		fetchImpl: scripted.fetch, estimateInput: (body) => body.byteLength });
	const originalFetch = globalThis.fetch;
	// The fallback remains the offline guard; no real network implementation is ever captured.
	globalThis.fetch = transport.fetch;
	let prepared: Prepared | undefined;
	const before = await treeManifest(projectRoot);
	try {
		const expected = prepareOnly ? null : JSON.parse(await readBounded(path.join(directory, "expected.json")));
		const summary = await runPilotSdkTask({ taskId, projectRoot, agentDir, model: runtimeModel, credential: "synthetic-not-a-key", transport,
			prepareOnly, onPrepared: (value) => {
				prepared = value;
				if (expected && digest(value) !== digest(expected)) throw new Error("PILOT_PREPARED_DRIFT");
			} });
		assert.ok(prepared, "PILOT_PREPARE_FAILED");
		const after = await treeManifest(projectRoot);
		await writeOnce(path.join(directory, "worker.json"), { prepared, summary, transport: transport.snapshot(), before, after } satisfies WorkerResult);
	} finally { globalThis.fetch = originalFetch; }
}

async function worker(taskId: PilotTaskId, prepareOnly: boolean, expected?: Prepared): Promise<WorkerResult> {
	const directory = await mkdtemp(path.join(process.env.PI_PILOT_WORK_ROOT!, prepareOnly ? "prepare-" : "task-"));
	await cp(path.join(root, "fixtures/harness-novel"), path.join(directory, "project"), { recursive: true, errorOnExist: true });
	if (expected) await writeOnce(path.join(directory, "expected.json"), expected);
	const env = { ...process.env, PI_EVAL_WORKER: "1", PI_CODING_AGENT_DIR: path.join(directory, "agent") };
	const result = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href,
		process.env.PI_PILOT_BUNDLE!, prepareOnly ? "prepare-worker" : "rehearsal-worker", taskId, directory],
		{ cwd: root, env, encoding: "utf8", timeout: 45_000, maxBuffer: 256_000, windowsHide: true });
	if (result.error || result.status !== 0) {
		// Child errors may contain transport text. Export only our bounded code.
		const reason = result.stderr?.match(/^Pilot rejected: ([A-Z0-9_]+)\s*$/m)?.[1];
		throw new Error(reason ?? "PILOT_WORKER_FAILED");
	}
	return JSON.parse(await readBounded(path.join(directory, "worker.json"))) as WorkerResult;
}

export async function runPilotRehearsal() {
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")];
	assert.equal(guard?.active, true, "PILOT_NETWORK_GUARD_REQUIRED");
	const sources = await sourceSnapshot(), fixture = await treeManifest(path.join(root, "fixtures/harness-novel"));
	const prepared = {} as Record<PilotTaskId, Prepared>;
	for (const taskId of PILOT_TASK_IDS) {
		const result = await worker(taskId, true);
		assert.equal(result.transport.requestsReserved, 0, "PILOT_PREPARE_DISPATCH");
		prepared[taskId] = result.prepared;
	}
	const parent = path.join(root, "artifacts/harness/pilot-rehearsals");
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(path.join(parent, "rehearsal-"));
	const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, env: process.env, encoding: "utf8", windowsHide: true });
	assert.equal(commit.status, 0, "PILOT_COMMIT_UNAVAILABLE");
	const manifest = createRehearsalManifest({ batchId: path.basename(directory), createdAt: new Date().toISOString(),
		code: { commit: commit.stdout.trim(), files: sources, sha256: pilotRecordDigest.digestMap(sources) },
		fixture: { files: fixture, sha256: pilotRecordDigest.digestMap(fixture) }, outputField: "max_tokens",
		policySha256: digest({ limits: PILOT_LIMITS, system: PILOT_SYSTEM, model: PILOT_MODEL, prepared,
			estimator: "serialized-utf8-bytes-upper-bound-v1", syntheticProvider: "scripted-openai-sse-v1" }),
		promptSha256: Object.fromEntries(PILOT_TASK_IDS.map((id) => [id, sha256(PILOT_PROMPTS[id])])) as Record<PilotTaskId, string>,
		toolsSha256: Object.fromEntries(PILOT_TASK_IDS.map((id) => [id, prepared[id].toolsSha256])) as Record<PilotTaskId, string> });
	const manifestSha256 = await writePilotManifest(directory, manifest);
	const runs: PilotRunRecord[] = [];
	let stopped = false;
	for (const taskId of PILOT_TASK_IDS) {
		const emptyRun = (status: "unknown" | "blocked", reasonCode: string): PilotRunRecord => ({ schemaVersion: 1, batchId: manifest.batchId, manifestSha256, taskId, status, reasonCode,
			checks: [], realHttpDispatches: 0, simulatedHttpDispatches: 0, requests: [], usage: { source: "unavailable", providerActual: false, inputTokens: null, outputTokens: null, totalTokens: null }, fileChanges: [], safeSdkChecks: [] });
		if (stopped) { runs.push(emptyRun("blocked", "BATCH_STOPPED")); continue; }
		try {
		assert.deepEqual(await sourceSnapshot(), sources, "PILOT_SOURCE_DRIFT");
		const result = await worker(taskId, false, prepared[taskId]);
		const sourceStable = digest(await sourceSnapshot()) === digest(sources);
		const fixtureStable = digest(await treeManifest(path.join(root, "fixtures/harness-novel"))) === digest(fixture) && digest(result.before) === digest(fixture);
		const checks = [
			{ id: "sdk", passed: result.summary.status === "pass" && digest(result.prepared) === digest(prepared[taskId]) },
			{ id: "transport", passed: result.transport.state === "active" && result.transport.requestsReserved === 3 && result.transport.completedResponses === 3 },
			{ id: "source", passed: sourceStable }, { id: "fixture", passed: fixtureStable },
			{ id: "usage-consistency", passed: result.summary.usage.inputTokens === result.transport.requests.reduce((sum, item) => sum + (item.usage?.promptTokens ?? 0), 0)
				&& result.summary.usage.outputTokens === result.transport.requests.reduce((sum, item) => sum + (item.usage?.completionTokens ?? 0), 0)
				&& result.summary.usage.totalTokens === result.transport.requests.reduce((sum, item) => sum + (item.usage?.totalTokens ?? 0), 0) },
		];
		const requests: PilotRunRecord["requests"] = result.transport.requests.map(({ dispatchAttempted: _attempted, ...request }) => ({
			...request, schemaVersion: 1, outputReserved: 2048,
			ordinal: runs.reduce((sum, run) => sum + run.requests.length, 0) + request.ordinal,
			invocationId: runs.reduce((sum, run) => sum + run.requests.length, 0) + request.invocationId,
			usageSource: request.usage ? "synthetic" : "unavailable",
		}));
		const fileChanges = [...new Set([...Object.keys(result.before), ...Object.keys(result.after)])].filter((name) => result.before[name] !== result.after[name])
			.map((name) => ({ path: name, beforeSha256: result.before[name] ?? null, afterSha256: result.after[name] ?? null }));
		runs.push({ schemaVersion: 1, batchId: manifest.batchId, manifestSha256, taskId,
			status: checks.every((check) => check.passed) ? "pass" : "fail", reasonCode: checks.every((check) => check.passed) ? "REHEARSAL_PASS" : "REHEARSAL_CHECK_FAILED",
			checks, realHttpDispatches: 0, simulatedHttpDispatches: requests.length, requests,
			usage: { source: "synthetic", providerActual: false, inputTokens: result.summary.usage.inputTokens, outputTokens: result.summary.usage.outputTokens, totalTokens: result.summary.usage.totalTokens },
			fileChanges, safeSdkChecks: Object.entries(result.summary.checks).map(([id, passed]) => ({ id, passed })) });
		stopped = checks.some((check) => !check.passed);
		} catch (error) {
			const candidate = error instanceof Error ? error.message.split("\n")[0].trim() : "";
			const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(candidate) ? candidate : "REHEARSAL_ABORTED";
			runs.push(emptyRun("unknown", code)); stopped = true;
		}
	}
	await sealPilotBatch(directory, runs);
	const aggregate = await rebuildPilotBatch(directory);
	await writeOnce(path.join(directory, "aggregate.json"), aggregate);
	assert.equal(guard.attempts, 0, "PILOT_UNEXPECTED_NETWORK_ATTEMPT");
	return { directory, aggregate };
}
