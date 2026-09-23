import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, digest, sha256, writeOnce } from "../core/io.js";
import { validateContextProvenance } from "./extension.js";
import { snapshot, setupWork } from "./runner.js";
import { lifecycleExtensionSource } from "./lifecycle-extension.js";
import { LIFE_LIMITS, LIFE_PROFILES, isWriteTask, lifePlan, type LifeProfile, type LifeScenario, type LifeTask } from "./lifecycle-policy.js";
import { LIFE_CHECKS, expectedLifecycleResult, judgeLifecycle, lifePolicy, rebuildLifecycle, validateLifeManifest, validateLifeStage, validateLifeResult, type LifeManifest, type LifeResult } from "./lifecycle-records.js";
import type { LifeStage, LifeStageResult } from "./lifecycle-session.js";

async function worker(work: string, profile: LifeProfile, task: LifeTask, stage: LifeStage, scenario: LifeScenario) {
	await assertInside(process.env.PI_CONTEXT_WORK_ROOT!, work);
	const result = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href, process.env.PI_CONTEXT_BUNDLE!, "lifecycle-worker", work, profile, task, stage, scenario],
		{ cwd: process.cwd(), env: { ...process.env, PI_EVAL_WORKER: "1", PI_CODING_AGENT_DIR: path.join(work, "agent") }, encoding: "utf8", timeout: LIFE_LIMITS.timeoutMs, maxBuffer: 32000, windowsHide: true });
	if (result.status !== 0) { console.error(`S3 lifecycle ${profile}/${task}/${stage}: ${result.stderr.slice(0, 2000)}`); throw new Error("S3_LIFECYCLE_WORKER_UNKNOWN"); }
	return validateLifeStage(JSON.parse(await readFile(path.join(work, `lifecycle-${stage}.json`), "utf8")));
}
export async function runLifecycleScenario(profile: LifeProfile, task: LifeTask, scenario: LifeScenario = "normal") {
	const work = await setupWork(), stages: LifeStageResult[] = [];
	try {
		stages.push(await worker(work, profile, task, isWriteTask(task) ? "seed" : "single", scenario));
		if (isWriteTask(task) && (stages[0].ends.at(-1)?.success || scenario === "result-persistence")) stages.push(await worker(work, profile, task, "resume", scenario));
		return stages;
	} catch { throw Object.assign(new Error("S3_LIFECYCLE_STAGE_FAILED"), { stages }); }
	finally { await assertInside(process.env.PI_CONTEXT_WORK_ROOT!, work); await rm(work, { recursive: true, force: true, maxRetries: 3 }); }
}
const empty = (status: "unknown" | "blocked"): LifeResult => ({ status, reason: status === "blocked" ? "BATCH_STOPPED" : "WORKER_UNKNOWN", checks: Object.fromEntries(LIFE_CHECKS.map(k => [k, false])) as LifeResult["checks"], stages: null });
export async function runLifecycleBatch() {
	assert.ok((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active); await validateContextProvenance();
	const initial = await snapshot(); assert.equal(JSON.parse(await readFile("node_modules/@mariozechner/pi-coding-agent/package.json", "utf8")).version, "0.63.1");
	const parent = path.resolve("artifacts/harness/sdk-context"); await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(path.join(parent, "s3-lifecycle-")); await mkdir(path.join(directory, "raw"));
	const git = (args: string[]) => { const r = spawnSync("git", args, { encoding: "utf8", windowsHide: true }); assert.equal(r.status, 0); return r.stdout.trim(); };
	const manifest: LifeManifest = validateLifeManifest({ schemaVersion: 2, kind: "sdk-lifecycle-offline", batchId: path.basename(directory), createdAt: new Date().toISOString(),
		code: { commit: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])), files: initial.sources, sha256: digest(initial.sources) },
		runtime: { node: process.version, platform: process.platform, arch: process.arch, sdk: "0.63.1" }, fixture: initial.fixture, policy: lifePolicy(),
		extensions: Object.fromEntries(LIFE_PROFILES.map(p => [p, sha256(lifecycleExtensionSource(p))])), runs: lifePlan() });
	await writeOnce(path.join(directory, "manifest.json"), manifest); const manifestSha256 = sha256(await readFile(path.join(directory, "manifest.json")));
	const entries = []; let stopped = false;
	for (const run of manifest.runs) {
		let result = empty("blocked"), stages: LifeStageResult[] | null = null;
		if (!stopped) try {
			assert.deepEqual(await snapshot(), initial); stages = await runLifecycleScenario(run.profile, run.task); assert.deepEqual(await snapshot(), initial);
			result = judgeLifecycle(run, stages); stopped = !expectedLifecycleResult(run, result);
		} catch (error) { stopped = true; stages ??= (error as any)?.stages ?? null; result = stages?.length ? judgeLifecycle(run, stages, false) : empty("unknown"); }
		validateLifeResult(result, run, manifest); const file = `raw/${run.runId}.json`;
		await writeOnce(path.join(directory, file), { schemaVersion: 2, manifestSha256, run, result }); entries.push({ runId: run.runId, file, sha256: sha256(await readFile(path.join(directory, file))) });
		console.log(`${run.runId}: ${result.status} (${result.reason})`);
	}
	await writeOnce(path.join(directory, "index.json"), { schemaVersion: 2, manifestSha256, entries });
	const aggregate = await rebuildLifecycle(directory); await writeOnce(path.join(directory, "aggregate.json"), aggregate); return { directory, aggregate };
}
