import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, digest, readBounded, sha256, treeManifest, writeOnce } from "../core/io.js";
import { validateSdkProvenance } from "./extensions.js";
import { runSdkSession, type SdkPrepared, type SdkResult } from "./session.js";
import { SDK_CHECKS, SDK_CONTENT, SDK_LIMITS, SDK_PROFILES, SDK_TASKS, sdkRunPlan, type SdkProfile, type SdkScenario, type SdkTask } from "./policy.js";
import { rebuildSdkBatch, sdkPolicy, sdkPreparedKey, validateSdkManifest, validateSdkPrepared, validateSdkResult, type SdkManifest, type SdkIndex } from "./records.js";
import provenance from "./baseline/provenance.json";

const root = process.cwd(), fixtureRoot = path.join(root, "fixtures/harness-novel");
export async function sdkSources() {
	const inputs = JSON.parse(await readBounded(process.env.PI_ABLATION_BUILD_INPUTS!)) as Record<string, string>;
	for (const [name, expected] of Object.entries(inputs)) {
		assert.ok(/^(evals|tests)\//.test(name) && !name.includes(".."), "SDK_SOURCE_PATH");
		assert.equal(sha256(await readFile(path.join(root, name))), expected, "SDK_SOURCE_DRIFT");
	}
	for (const name of ["package.json", "package-lock.json", "scripts/run-sdk-ablation.mjs", "scripts/eval-network-guard.mjs"]) inputs[name] = sha256(await readFile(path.join(root, name)));
	for (const name of ["@mariozechner/pi-coding-agent", "@mariozechner/pi-agent-core", "@mariozechner/pi-ai"]) {
		const folder = `node_modules/${name}`;
		inputs[`${folder}/package.json`] = sha256(await readFile(path.join(root, folder, "package.json")));
		inputs[`${folder}/dist-tree`] = digest(await treeManifest(path.join(root, folder, "dist")));
	}
	return inputs;
}

export async function runSdkWorker(profile: SdkProfile, taskId: SdkTask, options: { scenario?: SdkScenario; prepare?: boolean; expected?: SdkPrepared } = {}): Promise<SdkResult & { metrics: NonNullable<SdkResult["metrics"]> }> {
	const parent = process.env.PI_ABLATION_WORK_ROOT!;
	const directory = await mkdtemp(path.join(parent, "task-"));
	try {
		await cp(fixtureRoot, path.join(directory, "project"), { recursive: true, errorOnExist: true });
		if (options.expected) await writeOnce(path.join(directory, "expected.json"), options.expected);
		const args = ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href, process.env.PI_ABLATION_BUNDLE!,
			options.prepare ? "prepare-worker" : "task-worker", profile, taskId, directory, options.scenario ?? "normal"];
		const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, PI_EVAL_WORKER: "1", PI_CODING_AGENT_DIR: path.join(directory, "agent") },
			encoding: "utf8", timeout: SDK_LIMITS.taskTimeoutMs, maxBuffer: 64000, windowsHide: true });
		assert.equal(result.status, 0, "SDK_WORKER_FAILED");
		const output = JSON.parse(await readBounded(path.join(directory, "result.json"), 128000));
		if (options.prepare) validateSdkPrepared(output.prepared);
		else validateSdkResult(output);
		assert.ok(output.metrics, "SDK_WORKER_FAILED");
		return output;
	} finally { await assertInside(parent, directory); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
}
export async function sdkWorker(profile: SdkProfile, taskId: SdkTask, directory: string, scenario: SdkScenario, prepareOnly: boolean) {
	assert.equal(process.env.PI_EVAL_WORKER, "1", "SDK_WORKER_REQUIRED"); await assertInside(process.env.PI_ABLATION_WORK_ROOT!, directory);
	let expected: SdkPrepared | undefined;
	try { expected = validateSdkPrepared(JSON.parse(await readFile(path.join(directory, "expected.json"), "utf8"))); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const result = await runSdkSession({ profile, taskId, scenario, prepareOnly, expected, projectRoot: path.join(directory, "project"), agentDir: path.join(directory, "agent") });
	await writeOnce(path.join(directory, "result.json"), result);
}

export function checkBaselineGitObjects(): number {
	for (const source of provenance.sources) {
		const raw = spawnSync("git", ["show", `${source.commit}:${source.repoPath}`], { cwd: root, windowsHide: true, maxBuffer: 2_000_000 });
		assert.equal(raw.status, 0, "SDK_BASELINE_GIT_MISSING"); assert.equal(sha256(raw.stdout), source.rawSha256, "SDK_BASELINE_GIT_SHA");
		const blob = spawnSync("git", ["rev-parse", `${source.commit}:${source.repoPath}`], { cwd: root, windowsHide: true, encoding: "utf8" });
		assert.equal(blob.status, 0); assert.equal(blob.stdout.trim(), source.blob, "SDK_BASELINE_GIT_BLOB");
	}
	return provenance.sources.length;
}

export function emptySdkResult(reasonCode: "SDK_WORKER_FAILED" | "SDK_SOURCE_DRIFT" | "SDK_BATCH_STOPPED"): SdkResult {
	return { status: reasonCode === "SDK_BATCH_STOPPED" ? "blocked" : "unknown", reasonCode,
		checks: Object.fromEntries(SDK_CHECKS.map(key => [key, false])) as SdkResult["checks"], prepared: null,
		metrics: null, syntheticUsage: null, finalFileSha256: null, answerCode: "ANSWER_NOT_EVALUATED" };
}
export function expectedSdkOutcome(profile: SdkProfile, taskId: SdkTask, result: SdkResult): boolean {
	if (profile !== "sdk-b0-safety-fixed" || taskId !== "P5A-TOOL-001") return result.status === "pass" && result.reasonCode === "SDK_PASS";
	// Only the declared duplicate dispatch is permitted in this synthetic negative
	// control. A path/file/settings/role failure must still stop the batch.
	return result.status === "fail" && result.reasonCode === "SDK_CONTRACT_FAILED"
		&& Object.entries(result.checks).every(([key, passed]) => passed === (key !== "singleWrite"))
		&& result.metrics?.writeDispatches === 2 && result.metrics.duplicateWriteDispatches === 1
		&& result.metrics.syntheticInvocations === 4 && result.finalFileSha256 === sha256(SDK_CONTENT);
}
export async function runSdkBatch() {
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")]; assert.ok(guard?.active, "SDK_NETWORK_GUARD_REQUIRED");
	await validateSdkProvenance(); checkBaselineGitObjects();
	const sources = await sdkSources(), fixture = await treeManifest(fixtureRoot);
	const prepared: Record<string, SdkPrepared> = {};
	for (const profile of SDK_PROFILES) for (const task of SDK_TASKS) {
		const result = await runSdkWorker(profile, task, { prepare: true });
		assert.equal(result.metrics.syntheticInvocations, 0, "SDK_PREPARE_INVOKED");
		prepared[sdkPreparedKey(profile, task)] = validateSdkPrepared(result.prepared);
	}
	assert.equal(digest(await sdkSources()), digest(sources), "SDK_SOURCE_DRIFT");
	assert.equal(digest(await treeManifest(fixtureRoot)), digest(fixture), "SDK_FIXTURE_DRIFT");
	const parent = path.join(root, "artifacts/harness/sdk-ablations"); await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(path.join(parent, "sdk-s1-")); await mkdir(path.join(directory, "raw"));
	const git = (args: string[]) => { const result = spawnSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }); assert.equal(result.status, 0); return result.stdout.trim(); };
	const sdkVersion = JSON.parse(await readFile(path.join(root, "node_modules/@mariozechner/pi-coding-agent/package.json"), "utf8")).version;
	assert.equal(sdkVersion, "0.63.1", "SDK_VERSION_DRIFT");
	const manifest: SdkManifest = { schemaVersion: 1, kind: "sdk-ablation-rehearsal", batchId: path.basename(directory), createdAt: new Date().toISOString(),
		code: { commit: git(["rev-parse", "HEAD"]), dirty: !!git(["status", "--porcelain"]), files: sources, sha256: digest(sources) },
		environment: { node: process.version, platform: process.platform, arch: process.arch, piSdk: sdkVersion, lockSha256: sha256(await readFile(path.join(root, "package-lock.json"))) },
		fixture: { files: fixture, sha256: digest(fixture) }, policy: sdkPolicy(), prepared, runs: sdkRunPlan() };
	validateSdkManifest(manifest); await writeOnce(path.join(directory, "manifest.json"), manifest);
	const manifestSha256 = digest(manifest), manifestBytes = sha256(await readFile(path.join(directory, "manifest.json")));
	const index: SdkIndex = { schemaVersion: 1, batchId: manifest.batchId, manifestSha256, entries: [] };
	let stopped = false;
	for (const run of manifest.runs) {
		let result = emptySdkResult("SDK_BATCH_STOPPED");
		if (!stopped) {
			try {
				assert.equal(digest(await sdkSources()), manifest.code.sha256); assert.equal(digest(await treeManifest(fixtureRoot)), manifest.fixture.sha256);
				result = await runSdkWorker(run.profile, run.taskId, { expected: prepared[sdkPreparedKey(run.profile, run.taskId)] });
				assert.equal(digest(await sdkSources()), manifest.code.sha256); assert.equal(digest(await treeManifest(fixtureRoot)), manifest.fixture.sha256);
				// Only the deliberately frozen, temp-only negative replay is expected to fail.
				stopped = !expectedSdkOutcome(run.profile, run.taskId, result);
			} catch {
				// Do not erase observed writes if a later source/fixture audit fails.
				result = result.metrics ? { ...result, status: "unknown", reasonCode: "SDK_SOURCE_DRIFT", checks: { ...result.checks, limits: false } } : emptySdkResult("SDK_WORKER_FAILED");
				stopped = true;
			}
		}
		validateSdkResult(result);
		const file = `raw/${run.runId}.json`;
		await writeOnce(path.join(directory, file), { schemaVersion: 1, batchId: manifest.batchId, manifestSha256, run, result });
		index.entries.push({ runId: run.runId, file, sha256: sha256(await readFile(path.join(directory, file))) });
		console.log(`${result.status.toUpperCase()} ${run.runId} ${result.reasonCode}`);
	}
	assert.equal(sha256(await readFile(path.join(directory, "manifest.json"))), manifestBytes, "SDK_MANIFEST_DRIFT");
	await writeOnce(path.join(directory, "result-index.json"), index);
	const aggregate = await rebuildSdkBatch(directory); await writeOnce(path.join(directory, "aggregate.json"), aggregate);
	assert.equal(guard.attempts, 0, "SDK_UNEXPECTED_NETWORK");
	assert.equal(stopped, false, "SDK_BATCH_UNEXPECTED_RESULT");
	return { directory, aggregate };
}
