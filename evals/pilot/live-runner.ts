import assert from "node:assert/strict";
import { fork, spawnSync, type ForkOptions } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, digest, readBounded, sha256, treeManifest } from "../core/io.js";
import { createLiveManifest, liveAuthorizationToken, readLiveManifest, validateLiveAuthorization, writeLiveManifest, type LiveManifest, type PreparedFingerprint } from "./live-manifest.js";
import { createPilotJournal, recoverPilotJournal } from "./journal.js";
import { recoverLiveResults, sealLiveResults, writeLiveTaskRecord, type LiveTaskRecord } from "./live-records.js";
import { resolvePilotPrivateConfig } from "./private-config.js";
import { PILOT_LIMITS, PILOT_MODEL, PILOT_PROBE_CONTENT, PILOT_PROBE_PATH, PILOT_TASK_IDS, type PilotTaskId } from "./policy.js";
import { createRehearsalProvider } from "./rehearsal-provider.js";
import { sourceSnapshot } from "./runner.js";
import { createPilotTransport } from "./transport.js";
import type { BrokerWorkerResult, BrokerWorkerStart } from "./broker-worker.js";
import { unevaluatedPilotAnswer } from "./answer-diagnostics.js";

const root = process.cwd();
const liveRoot = path.join(root, "artifacts/harness/live-pilots");
const mapDigest = (files: Record<string, string>) => sha256(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
const infraHash = sha256(JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false }, null, 2) + "\n");
type PrivateConfig = ReturnType<typeof resolvePilotPrivateConfig>;
type Transport = ReturnType<typeof createPilotTransport>;

function cleanWorkerEnvironment(agentDir: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)) environment[key] = value;
	return { ...environment, PI_EVAL_WORKER: "1", PI_CODING_AGENT_DIR: agentDir };
}

/** Child has no credential/endpoint and starts under the offline network + subprocess guard. */
async function worker(taskId: PilotTaskId, config: PrivateConfig, prepareOnly: boolean, expected: PreparedFingerprint | null,
	transport?: Transport, signal?: AbortSignal): Promise<BrokerWorkerResult> {
	const directory = await mkdtemp(path.join(process.env.PI_PILOT_WORK_ROOT!, "broker-task-"));
	const projectRoot = path.join(directory, "project"), agentDir = path.join(directory, "agent");
	await cp(path.join(root, "fixtures/harness-novel"), projectRoot, { recursive: true, errorOnExist: true });
	const model = { ...config.runtimeModel, baseUrl: "https://pilot.invalid/v1" };
	return new Promise((resolve, reject) => {
		const child = fork(process.env.PI_PILOT_BUNDLE!, ["broker-worker"], {
			cwd: root, env: cleanWorkerEnvironment(agentDir), windowsHide: true, silent: true,
			execArgv: ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href],
		} as ForkOptions & { windowsHide: boolean });
		// Never forward child output: SDK exceptions can contain model text.
		child.stdout?.resume(); child.stderr?.resume();
		let finished = false, pending = false, lastInvocation = 0, result: BrokerWorkerResult | undefined;
		const finish = (error?: Error) => {
			if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
			if (error) { transport?.stop("MANUAL_STOP"); child.kill(); reject(error); }
			else if (result) resolve(result); else reject(new Error("PILOT_WORKER_FAILED"));
		};
		const onAbort = () => finish(new Error("PILOT_BATCH_ABORTED"));
		const timer = setTimeout(() => finish(new Error("PILOT_WORKER_TIMEOUT")), prepareOnly ? 45_000 : PILOT_LIMITS.taskTimeoutMs);
		if (signal?.aborted) { onAbort(); return; }
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", () => finish(new Error("PILOT_WORKER_FAILED")));
		child.on("close", (code) => finish(code === 0 && result && !pending ? undefined : new Error("PILOT_WORKER_FAILED")));
		child.on("message", (raw: any) => {
			if (finished) return;
			if (raw?.type === "result") {
				if (result || pending || !raw.value || raw.value.summary?.taskId !== taskId) { finish(new Error("PILOT_IPC_INVALID")); return; }
				result = raw.value; return;
			}
			if (raw?.type !== "request" || prepareOnly || !transport || pending || result || !Number.isSafeInteger(raw.invocation)
				|| raw.invocation !== lastInvocation + 1 || typeof raw.body !== "string" || Buffer.byteLength(raw.body) > PILOT_LIMITS.maxInputBytes) {
				finish(new Error("PILOT_IPC_INVALID")); return;
			}
			pending = true; lastInvocation = raw.invocation;
			void transport.invoke(taskId, async () => {
				const response = await transport.fetch(config.endpoint, { method: "POST", body: raw.body, redirect: "error" });
				const body = await response.text();
				if (finished) throw new Error("PILOT_IPC_CLOSED");
				return { type: "response", invocation: raw.invocation, status: response.status, body };
			}).then((response) => {
				// Settle the invocation BEFORE making the response visible to the child.
				pending = false;
				if (!finished) child.send(response, (error) => { if (error) finish(new Error("PILOT_IPC_FAILED")); });
			}, () => { pending = false; finish(new Error("PILOT_TRANSPORT_FAILED")); });
		});
		const start: BrokerWorkerStart = { type: "start", taskId, projectRoot, agentDir, model, prepareOnly, expected };
		child.send(start, (error) => { if (error) finish(new Error("PILOT_IPC_FAILED")); });
	});
}

async function snapshot() {
	const sources = await sourceSnapshot();
	sources["scripts/pilot-broker-network.mjs"] = sha256(await readFile(path.join(root, "scripts/pilot-broker-network.mjs")));
	const fixture = await treeManifest(path.join(root, "fixtures/harness-novel"));
	return { sources, fixture };
}
async function runtime() {
	const installed = JSON.parse(await readBounded(path.join(root, "node_modules/@mariozechner/pi-coding-agent/package.json")));
	assert.equal(installed.version, "0.63.1", "PILOT_SDK_VERSION_MISMATCH");
	return { node: process.version, platform: process.platform, arch: process.arch, piSdk: installed.version as string };
}
async function configFromFile(filename: string, credential: boolean): Promise<PrivateConfig> {
	// Parse only; never invoke Pi's shell-command credential resolver or print config errors.
	try { return resolvePilotPrivateConfig(JSON.parse(await readBounded(filename)), process.env, credential); }
	catch { throw new Error("PILOT_PRIVATE_CONFIG_REJECTED"); }
}
const syntheticConfig = () => resolvePilotPrivateConfig({ providers: { [PILOT_MODEL.provider]: { api: PILOT_MODEL.api,
	baseUrl: "https://pilot.invalid/v1", apiKey: "synthetic-not-a-key", models: [{ id: PILOT_MODEL.id, contextWindow: PILOT_MODEL.contextWindow,
		maxTokens: 16384, compat: { maxTokensField: "max_tokens" } }] } } }, {}, false);

async function prepare(config: PrivateConfig, mode: "live" | "dry-run") {
	const { sources, fixture } = await snapshot();
	const prepared = {} as Record<PilotTaskId, PreparedFingerprint>;
	for (const taskId of PILOT_TASK_IDS) {
		const result = await worker(taskId, config, true, null);
		assert.equal(result.summary.status, "pass", "PILOT_PREPARE_FAILED"); prepared[taskId] = result.prepared;
	}
	assert.deepEqual(await snapshot(), { sources, fixture }, "PILOT_SOURCE_DRIFT");
	const git = (args: string[]) => { const result = spawnSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }); assert.equal(result.status, 0, "PILOT_GIT_FAILED"); return result.stdout.trim(); };
	await mkdir(liveRoot, { recursive: true });
	const directory = await mkdtemp(path.join(liveRoot, mode === "live" ? "live-" : "dry-run-"));
	const manifest = createLiveManifest({ executionMode: mode, batchId: path.basename(directory), createdAt: new Date().toISOString(),
		outputField: config.publicModel.outputField, reasoning: config.publicModel.reasoning, compatibilitySha256: config.publicModel.compatSha256,
		endpointSha256: config.endpointSha256, configSha256: config.configSha256,
		code: { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]).length > 0, files: sources, sha256: mapDigest(sources) },
		fixture: { files: fixture, sha256: mapDigest(fixture) }, prepared,
		runtime: { ...await runtime(), lockSha256: sources["package-lock.json"]! },
		estimator: { kind: "serialized-utf8-bytes-upper-bound", version: "1", units: "estimated_tokens", maxInputBytes: PILOT_LIMITS.maxInputBytes },
	});
	const manifestSha256 = await writeLiveManifest(path.join(directory, "manifest.json"), manifest);
	return { directory, manifest, manifestSha256 };
}

export async function prepareLivePilot(filename: string) { return prepare(await configFromFile(filename, false), "live"); }

const emptyUsage = () => ({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null });
const sdkCheckIds = ["settings", "extension", "role", "allowlist", "files", "toolResults", "normalStop", "finalAnswer"] as const;
function fileChanges(before: Record<string, string>, after: Record<string, string>) {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter((name) => before[name] !== after[name])
		.map((name) => ({ path: name, beforeSha256: before[name] ?? null, afterSha256: after[name] ?? null }));
}
function allowedFiles(taskId: PilotTaskId, changes: ReturnType<typeof fileChanges>) {
	return changes.every((change) => change.beforeSha256 === null && (
		(change.path === ".pi/settings.json" && change.afterSha256 === infraHash)
		|| (taskId === PILOT_TASK_IDS[1] && change.path === PILOT_PROBE_PATH && change.afterSha256 === sha256(PILOT_PROBE_CONTENT))))
		&& (taskId !== PILOT_TASK_IDS[1] || changes.some((change) => change.path === PILOT_PROBE_PATH));
}

async function execute(directory: string, manifest: LiveManifest, manifestSha256: string, config: PrivateConfig, fetchImpl: typeof fetch) {
	assert.equal(manifest.configSha256, config.configSha256, "PILOT_CONFIG_DRIFT");
	assert.equal(manifest.endpointSha256, config.endpointSha256, "PILOT_ENDPOINT_DRIFT");
	const expected = { sources: manifest.code.files, fixture: manifest.fixture.files };
	assert.deepEqual(await snapshot(), expected, "PILOT_SOURCE_DRIFT");
	assert.deepEqual({ ...await runtime(), lockSha256: expected.sources["package-lock.json"] }, manifest.runtime, "PILOT_RUNTIME_DRIFT");
	// Exclusive and permanent: a crashed/interrupted batch is never resumed or refunded.
	const journal = await createPilotJournal(path.join(directory, "journal"), manifestSha256, manifest.executionMode);
	const gate = createPilotTransport({ endpoint: config.endpoint, modelId: PILOT_MODEL.id, outputField: config.publicModel.outputField, fetchImpl,
		estimateInput: (body) => body.byteLength,
		beforeDispatch: async (request) => {
			assert.deepEqual(await snapshot(), expected, "PILOT_SOURCE_DRIFT");
			assert.ok(Date.now() < Date.parse(manifest.expiresAt), "LIVE_AUTHORIZATION_EXPIRED");
			await journal.reserve(request);
		},
		onRequestFinished: async (request) => { await journal.settle({ ordinal: request.ordinal, taskId: request.taskId, invocationId: request.invocationId,
			dispatchAttempted: request.dispatchAttempted, status: "complete", reasonCode: null, usage: request.usage }); },
	});
	const abort = new AbortController();
	const stop = () => { gate.stop("MANUAL_STOP"); abort.abort(); };
	process.once("SIGINT", stop); process.once("SIGTERM", stop);
	const batchTimer = setTimeout(stop, PILOT_LIMITS.batchTimeoutMs);
	let failed = false;
	try {
		for (const taskId of PILOT_TASK_IDS) {
			let record: LiveTaskRecord = { schemaVersion: 2, manifestSha256, taskId, status: "blocked", reasonCode: "BATCH_ABORTED", answerDiagnostic: unevaluatedPilotAnswer(taskId),
				checks: { sdk: false, source: false, fixture: false, files: false, prepared: false },
				sdkChecks: Object.fromEntries(sdkCheckIds.map((id) => [id, false])) as LiveTaskRecord["sdkChecks"], sdkUsage: emptyUsage(), fileChanges: [] };
			if (!failed) {
				try {
					assert.deepEqual(await snapshot(), expected, "PILOT_SOURCE_DRIFT");
					const result = await worker(taskId, config, false, manifest.prepared[taskId], gate, abort.signal);
					const current = await snapshot();
					const changes = fileChanges(result.before, result.after);
					const checks = { sdk: result.summary.status === "pass", source: digest(current.sources) === digest(expected.sources),
						fixture: digest(current.fixture) === digest(expected.fixture) && digest(result.before) === digest(expected.fixture),
						files: allowedFiles(taskId, changes), prepared: digest(result.prepared) === digest(manifest.prepared[taskId]) };
					failed = Object.values(checks).some((value) => !value) || gate.snapshot().state !== "active";
					record = { ...record, status: failed ? "fail" : "pass", reasonCode: failed ? "MECHANICAL_CHECK_FAILED" : "LIVE_TASK_PASS", checks,
						sdkChecks: Object.fromEntries(sdkCheckIds.map((id) => [id, result.summary.checks[id] === true])) as LiveTaskRecord["sdkChecks"],
						sdkUsage: result.summary.usage, fileChanges: changes, answerDiagnostic: result.summary.answerDiagnostic };
				} catch { failed = true; gate.stop("MANUAL_STOP"); record = { ...record, status: "unknown", reasonCode: "REQUEST_UNKNOWN" }; }
			}
			await writeLiveTaskRecord(directory, record);
		}
		// Persist known failure snapshots when possible; power loss still leaves a conservative pending reserve.
		const disk = await recoverPilotJournal(path.join(directory, "journal"), manifestSha256);
		for (const reservation of disk.reservations.filter((item) => !item.settlement)) {
			const request = gate.snapshot().requests.find((item) => item.ordinal === reservation.ordinal);
			await journal.settle({ ordinal: reservation.ordinal, taskId: reservation.taskId, invocationId: reservation.invocationId,
				dispatchAttempted: request?.dispatchAttempted ?? true, status: "unknown", reasonCode: request?.reasonCode ?? "MANUAL_STOP", usage: null });
		}
		await journal.finalize(failed ? "aborted" : "complete");
		await sealLiveResults(directory);
		return await recoverLiveResults(directory);
	} finally { clearTimeout(batchTimer); process.off("SIGINT", stop); process.off("SIGTERM", stop); gate.stop("MANUAL_STOP"); }
}

export async function runLivePilot(directory: string, filename: string, approvalSha: string, acceptsUnknownCost: boolean) {
	await assertInside(liveRoot, directory);
	const { manifest, sha256: manifestSha256 } = await readLiveManifest(path.join(directory, "manifest.json"));
	validateLiveAuthorization(manifestSha256, acceptsUnknownCost ? liveAuthorizationToken(approvalSha) : null, new Date(), manifest);
	const config = await configFromFile(filename, true);
	const originalConfigSha = sha256(await readBounded(filename));
	const module = await import(pathToFileURL(path.join(root, "scripts/pilot-broker-network.mjs")).href);
	try { return await execute(directory, manifest, manifestSha256, config, module.createPinnedFetch(config.endpoint, config.credential)); }
	finally { assert.equal(sha256(await readBounded(filename)), originalConfigSha, "PILOT_PRIVATE_CONFIG_CHANGED"); }
}

/** Same parent/IPC/worker/journal path, with explicit synthetic fetch and no credential access. */
export async function runBrokerDryRun() {
	assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active, true, "PILOT_NETWORK_GUARD_REQUIRED");
	const config = syntheticConfig(), batch = await prepare(config, "dry-run");
	const providers = PILOT_TASK_IDS.map((taskId) => createRehearsalProvider(taskId)); let current = 0;
	const fetchImpl: typeof fetch = (input, init) => { if (providers[current]!.calls() >= 3) current++; assert.ok(providers[current], "PILOT_SYNTHETIC_EXTRA_REQUEST"); return providers[current]!.fetch(input, init); };
	const aggregate = await execute(batch.directory, batch.manifest, batch.manifestSha256, config, fetchImpl);
	return { directory: batch.directory, aggregate };
}

/** Faults run only with synthetic configuration and the offline network guard. */
export async function testBrokerFailures(): Promise<number> {
	assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active, true, "PILOT_NETWORK_GUARD_REQUIRED");
	let count = 0;
	for (const fault of ["network", "missing-usage", "answer-format"] as const) {
		const config = syntheticConfig(), batch = await prepare(config, "dry-run");
		let calls = 0;
		const scripted = createRehearsalProvider(PILOT_TASK_IDS[0]);
		const fetchImpl: typeof fetch = async (input, init) => {
			calls++;
			if (fault === "network") throw new Error("synthetic-private-error-must-not-be-exported");
			const response = await scripted.fetch(input, init);
			let body = await response.text();
			if (fault === "missing-usage") body = body.split("\n\n").filter((chunk) => !chunk.includes('"usage"')).join("\n\n");
			else if (calls === 3) {
				// Synthetic SSE only: exercise diagnosis through provider parser,
				// worker IPC, V2 record, sealed index and offline recovery.
				const answer = '{"canPredictStorm":false,"signers":["记录员","设备技师"]}';
				assert.ok(body.includes(JSON.stringify(answer)), "PILOT_SYNTHETIC_ANSWER_MISSING");
				body = body.replace(JSON.stringify(answer), JSON.stringify(`\x60\x60\x60json\n${answer}\n\x60\x60\x60`));
			}
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const aggregate = await execute(batch.directory, batch.manifest, batch.manifestSha256, config, fetchImpl);
		const expectedCalls = fault === "answer-format" ? 3 : 1;
		assert.equal(calls, expectedCalls, "PILOT_FAULT_RETRIED");
		assert.notEqual(aggregate.status, "pass", "PILOT_FAULT_FALSE_PASS");
		assert.equal(aggregate.tasks[1]!.status, "blocked", "PILOT_FAULT_DID_NOT_STOP_BATCH");
		assert.equal(aggregate.providerUsage.promptTokens, fault === "answer-format" ? 300 : null, "PILOT_UNKNOWN_USAGE_ZEROED"); count++;
		if (fault === "answer-format") {
			assert.equal(aggregate.tasks[0]!.status, "fail");
			assert.deepEqual(aggregate.tasks[0]!.answerDiagnostic?.codes, ["ANSWER_MARKDOWN_FENCE"]);
			assert.deepEqual(aggregate.tasks[1]!.answerDiagnostic?.codes, ["ANSWER_NOT_EVALUATED"]); count++;
		}
		const diskBefore = await treeManifest(batch.directory);
		assert.deepEqual(await recoverLiveResults(batch.directory), aggregate, "PILOT_RECOVERY_DRIFT");
		assert.deepEqual(await treeManifest(batch.directory), diskBefore, "PILOT_RECOVERY_WROTE_FILES"); count++;
		await assert.rejects(() => execute(batch.directory, batch.manifest, batch.manifestSha256, config, fetchImpl), /JOURNAL_ALREADY_CLAIMED/);
		assert.equal(calls, expectedCalls, "PILOT_BATCH_REPLAYED"); count++;
		await assert.rejects(() => runLivePilot(batch.directory, "nonexistent-private-config", batch.manifestSha256, true), /LIVE_DRY_RUN_NOT_AUTHORIZABLE/); count++;
		await assert.rejects(() => runLivePilot(batch.directory, "nonexistent-private-config", batch.manifestSha256, false), /LIVE_AUTHORIZATION_REQUIRED/); count++;
	}
	return count;
}
