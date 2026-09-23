import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { aggregateBatch } from "./aggregate.js";
import { validateManifest, validateRawRun } from "./schema.js";
import { assertInside, canonical, digest, readBounded, sha256, treeManifest, writeOnce } from "./io.js";
import type { EvalAggregate, EvalManifest, RawRun, ResultIndex, TaskResult } from "./types.js";
import type { TaskDefinition } from "./types.js";
import { tasks } from "../tasks.js";
import { variants } from "../variants.js";
import { comparisonVariants, createComponentAdapter, runWithAdapter } from "../adapters/components.js";
import { createHistoricalAdapter, validateHistoricalSnapshots } from "../adapters/historical.js";

const root = process.cwd();
const fixtureRoot = path.join(root, "fixtures/harness-novel");
const output = path.join(root, "artifacts/harness/evals");
const sourceDirectories = ["src/harness", "src/extensions", "evals", "tests/evals"];
const sourceFiles = ["scripts/run-offline-evals.mjs", "scripts/eval-network-guard.mjs", "package.json", "package-lock.json", "tsconfig.harness.json"];

export async function sourceManifest(): Promise<Record<string, string>> {
	const entries: Record<string, string> = {};
	for (const dir of sourceDirectories) for (const [name, hash] of Object.entries(await treeManifest(path.join(root, dir)))) entries[`${dir}/${name}`] = hash;
	for (const name of sourceFiles) entries[name] = sha256(await readFile(path.join(root, name)));
	return entries;
}

const failure = (reasonCode: string, status: TaskResult["status"] = "invalid"): TaskResult => ({
	status, reasonCode, checks: [], trace: [],
	metrics: { modelCalls: 0, duplicateSideEffects: 0, staleEvidenceUsed: 0, blockedDuplicateDispatches: 0, recoveries: 0 },
});

export function safeRawRun(result: unknown, identity: Pick<RawRun, "batchId" | "manifestSha256" | "runId" | "taskId" | "category" | "variant" | "repetition">, task: TaskDefinition): RawRun {
	const envelope = { ...identity, schemaVersion: 1 as const,
		usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, source: "unavailable" as const } };
	try { return validateRawRun({ ...(result as TaskResult), ...envelope }, task); }
	catch {
		// Do not spread rejected fields: debug payloads and raw errors stay out of artifacts.
		return validateRawRun({ ...failure("RAW_VALIDATION_FAILED"), ...envelope }, task);
	}
}

export function resolveAdapter(variant: string) {
	return variant === "historical-b1" || variant === "historical-b2" || variant === "historical-b3"
		? createHistoricalAdapter(variant) : createComponentAdapter(variant);
}

export async function executeTask(taskId: string, project: string, resultFile: string, variant = "current-full-contract"): Promise<void> {
	const task = tasks.find((candidate) => candidate.definition.id === taskId);
	assert.ok(task && process.env.PI_EVAL_WORKER === "1", "INVALID_WORKER_REQUEST");
	await assertInside(output, project);
	assert.equal(path.dirname(resultFile), path.dirname(project), "INVALID_WORKER_RESULT_PATH");
	const guard = (globalThis as Record<symbol, unknown>)[Symbol.for("pi.eval.networkGuard")] as { active: boolean; attempts: number } | undefined;
	assert.ok(guard?.active, "OFFLINE_GUARD_REQUIRED");
	let result: TaskResult;
	try { result = await runWithAdapter(task, project, resolveAdapter(variant)); }
	catch { result = failure("TASK_EXCEPTION", "fail"); }
	if (guard.attempts !== 0) result = failure("OFFLINE_GUARD_VIOLATION");
	await writeOnce(resultFile, result);
}

export const matrixVariants = ["historical-b1", "historical-b2", "historical-b3", ...comparisonVariants, "current-full-contract"];

export async function runBatch(selectedVariants: string[] = ["current-full-contract"]): Promise<{ directory: string; aggregate: EvalAggregate }> {
	assert.ok(selectedVariants.length > 0 && new Set(selectedVariants).size === selectedVariants.length, "INVALID_VARIANT_SELECTION");
	for (const id of selectedVariants) resolveAdapter(id);
	// The source manifest detects drift, but cannot establish historical provenance.
	// Validate the vendored bytes against the separately frozen commit/blob metadata.
	if (selectedVariants.some((id) => id.startsWith("historical-"))) await validateHistoricalSnapshots(root);
	await mkdir(output, { recursive: true });
	await assertInside(path.join(root, "artifacts/harness"), output);
	const directory = await mkdtemp(path.join(output, "offline-"));
	const batchId = path.basename(directory);
	await mkdir(path.join(directory, "raw"));
	const files = await sourceManifest();
	const compiledInputs = JSON.parse(await readBounded(process.env.PI_EVAL_BUILD_INPUTS!)) as Record<string, string>;
	assert.ok(Object.keys(compiledInputs).length > 0, "MISSING_COMPILED_INPUTS");
	for (const [name, hash] of Object.entries(compiledInputs)) assert.equal(files[name], hash, "COMPILED_SOURCE_DRIFT");
	const fixtureFiles = await treeManifest(fixtureRoot);
	const definitions = tasks.map((task) => task.definition);
	const runs = [1, 2, 3].flatMap((repetition) => selectedVariants.flatMap((variant) => definitions.map((task) => ({ runId: `${variant}-${task.id}-r${repetition}`, taskId: task.id, repetition, variant }))));
	const manifest: EvalManifest = {
		schemaVersion: 2, kind: "offline-contract", batchId, createdAt: new Date().toISOString(),
		code: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()), files, sha256: digest(files) },
		environment: { node: process.version, npm: process.env.npm_config_user_agent?.split(" ")[0] ?? "unknown", platform: process.platform, arch: process.arch,
			piSdk: JSON.parse(await readFile(path.join(root, "node_modules/@mariozechner/pi-coding-agent/package.json"), "utf8")).version,
			lockSha256: sha256(await readFile(path.join(root, "package-lock.json"))) },
		fixture: { files: fixtureFiles, sha256: digest(fixtureFiles) },
		taskSet: { tasks: definitions, sha256: digest(definitions) }, variants,
		selectedVariants, budget: { modelCalls: 0, repetitions: 3, maxRuns: runs.length, taskTimeoutMs: 20_000 }, runs,
	};
	const manifestHash = digest(manifest);
	validateManifest(manifest);
	await writeOnce(path.join(directory, "manifest.json"), manifest);
	const manifestBytesHash = sha256(await readFile(path.join(directory, "manifest.json")));
	const index: ResultIndex = { schemaVersion: 1, batchId, manifestSha256: manifestHash, entries: [] };
	for (const planned of runs) {
		const task = tasks.find((candidate) => candidate.definition.id === planned.taskId)!;
		const work = await mkdtemp(path.join(directory, ".work-"));
		let result: TaskResult;
		let fixtureUnchanged = true;
		let sourceUnchanged = true;
		try {
			assert.equal(digest(await treeManifest(fixtureRoot)), manifest.fixture.sha256, "FIXTURE_DRIFT");
			assert.equal(digest(await sourceManifest()), manifest.code.sha256, "SOURCE_DRIFT");
			const project = path.join(work, "project");
			await cp(fixtureRoot, project, { recursive: true, errorOnExist: true });
			assert.equal(digest(await treeManifest(project)), manifest.fixture.sha256, "COPY_DRIFT");
			const resultFile = path.join(work, "result.json");
			const child = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href, process.env.PI_EVAL_BUNDLE!, "task", planned.taskId, project, resultFile, planned.variant], {
				cwd: root, env: { ...process.env, PI_EVAL_WORKER: "1" }, timeout: manifest.budget.taskTimeoutMs, stdio: "pipe", maxBuffer: 64 * 1024,
			});
			if (child.error || child.signal || child.status !== 0) result = failure(child.error && "code" in child.error && child.error.code === "ETIMEDOUT" ? "TASK_TIMEOUT" : "WORKER_FAILED");
			else result = JSON.parse(await readBounded(resultFile)) as TaskResult;
		} catch { result = failure("RUNNER_INTEGRITY_FAILURE"); }
		finally {
			fixtureUnchanged = digest(await treeManifest(fixtureRoot)) === manifest.fixture.sha256;
			sourceUnchanged = digest(await sourceManifest()) === manifest.code.sha256;
			await assertInside(directory, work);
			assert.ok(path.basename(work).startsWith(".work-"), "UNSAFE_EVAL_CLEANUP");
			await rm(work, { recursive: true, force: true, maxRetries: 3 });
		}
		if (!fixtureUnchanged || !sourceUnchanged) result = failure(!fixtureUnchanged ? "FIXTURE_DRIFT" : "SOURCE_DRIFT");
		const raw = safeRawRun(result!, { batchId, manifestSha256: manifestHash, ...planned, category: task.definition.category }, task.definition);
		const filename = `raw/${planned.runId}.json`;
		await writeOnce(path.join(directory, filename), raw);
		index.entries.push({ runId: planned.runId, file: filename, sha256: sha256(await readFile(path.join(directory, filename))) });
		console.log(`${raw.status.toUpperCase()} ${raw.runId} ${raw.reasonCode}`);
		if (!fixtureUnchanged || !sourceUnchanged || raw.status === "invalid" || raw.metrics.modelCalls !== 0 || raw.metrics.duplicateSideEffects > 0 || raw.metrics.staleEvidenceUsed > 0) {
			await writeOnce(path.join(directory, "stopped.json"), { schemaVersion: 1, batchId, reasonCode: "BATCH_STOPPED", runId: planned.runId });
			throw new Error("BATCH_STOPPED");
		}
	}
	assert.equal(digest(JSON.parse(await readBounded(path.join(directory, "manifest.json")))), manifestHash, "MANIFEST_DRIFT");
	assert.equal(sha256(await readFile(path.join(directory, "manifest.json"))), manifestBytesHash, "MANIFEST_BYTES_DRIFT");
	await writeOnce(path.join(directory, "result-index.json"), index);
	const aggregate = await rebuildBatch(directory);
	await writeOnce(path.join(directory, "aggregate.json"), aggregate);
	return { directory, aggregate };
}

/** Read-only reconstruction. Never replaces original manifest/index/raw/aggregate. */
export async function rebuildBatch(directory: string): Promise<EvalAggregate> {
	directory = path.resolve(directory);
	await assertInside(output, directory);
	const manifest = JSON.parse(await readBounded(path.join(directory, "manifest.json")));
	const index = JSON.parse(await readBounded(path.join(directory, "result-index.json")));
	const rawDirectory = path.join(directory, "raw");
	await assertInside(directory, rawDirectory);
	const rawFiles = new Map<string, string>();
	const names = await readdir(rawDirectory);
	assert.ok(names.length <= 4096, "TOO_MANY_RAW_FILES");
	for (const name of names) {
		assert.match(name, /^[A-Za-z0-9_-]+\.json$/, "INVALID_RAW_PATH");
		rawFiles.set(`raw/${name}`, await readBounded(path.join(rawDirectory, name)));
	}
	return aggregateBatch(manifest, index, rawFiles);
}

export function report(aggregate: EvalAggregate): string {
	const table = (historical: boolean): string[] => {
		const groups = aggregate.groups.filter((group) => group.variant.startsWith("historical-") === historical);
		if (!groups.length) return [];
		return [
			historical ? "## Historical module contracts (not full historical Desktop)" : "## Current-source component contracts", "",
			"| Variant | Category | Pass / planned | Fail | Unsupported | Other non-pass | Unknown usage |", "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
			...groups.map((group) => `| ${group.variant} | ${group.category} | ${group.success.numerator} / ${group.success.denominator} | ${group.statuses.fail} | ${group.statuses.unsupported} | ${group.count - group.statuses.pass - group.statuses.fail - group.statuses.unsupported} | ${group.usage.missingRuns} |`), "",
			...(aggregate.taskGroups ? [
				"| Variant | Task | Pass / planned | Fail | Unsupported | Other non-pass |", "| --- | --- | ---: | ---: | ---: | ---: |",
				...aggregate.taskGroups.filter((group) => group.variant.startsWith("historical-") === historical)
					.map((group) => `| ${group.variant} | ${group.taskId} | ${group.success.numerator} / ${group.success.denominator} | ${group.statuses.fail} | ${group.statuses.unsupported} | ${group.count - group.statuses.pass - group.statuses.fail - group.statuses.unsupported} |`), "",
			] : []),
		];
	};
	return [
		`# Offline contract evaluation: ${aggregate.batchId}`, "",
		`Code: ${aggregate.codeCommit}; manifest SHA-256: ${aggregate.manifestSha256}`,
		`Runs: ${aggregate.runCount}; deterministic: ${aggregate.deterministic}; real model calls: 0.`, "",
		...table(true), ...table(false),
		`Not run: ${aggregate.notRunVariants.join(", ")}.`,
		"Contract-only synthetic fault injection. Insufficient evidence for model quality, token savings or ablation claims.",
		"Historical modules and current component profiles are separate evidence tracks, not full Desktop baselines. Unsupported means absent capability, NOT failure or success. No cross-track ranking or budget-unit savings claim.",
		"Historical budget units are UTF-8 bytes; current units are estimated tokens. C3 and current-full execute the same factories here; native compaction, Supervisor and context maintenance are not exercised. The long-horizon task is a synthetic checkpoint serialization/recovery chain, not LLM compaction.",
		"Provider usage is unavailable, not zero. Exact run IDs/statuses/metrics are in aggregate.json; raw records are hash-bound by result-index.json.", "",
	].join("\n");
}

export const sameAggregate = (left: EvalAggregate, right: EvalAggregate): boolean => canonical(left) === canonical(right);
