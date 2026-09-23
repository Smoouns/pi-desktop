import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, canonical, digest, readBounded, sha256, treeManifest } from "../../evals/core/io.js";
import { matrixVariants, rebuildBatch, report, resolveAdapter, runBatch, safeRawRun, sameAggregate } from "../../evals/core/runner.js";
import { tasks } from "../../evals/tasks.js";
import { runWithAdapter } from "../../evals/adapters/components.js";
import { validateHistoricalSnapshots } from "../../evals/adapters/historical.js";

export async function runRunnerTests(): Promise<number> {
	let count = 0;
	const check = (body: () => void) => { body(); count++; };
	check(() => assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 })));
	check(() => assert.throws(() => canonical({ missing: undefined }), /NON_JSON_VALUE/));
	check(() => assert.throws(() => resolveAdapter("b0-raw"), /ADAPTER_UNAVAILABLE/));
	let unavailableDispatches = 0;
	const unavailableTask = { ...tasks[0]!, run: async () => { unavailableDispatches++; throw new Error("UNAVAILABLE_TASK_DISPATCHED"); } };
	for (const variant of ["historical-b1", "c1-tool-contract"]) {
		const result = await runWithAdapter(unavailableTask, "unused-synthetic-path", resolveAdapter(variant));
		check(() => { assert.equal(result.status, "unsupported"); assert.equal(result.checks.length, 0); assert.equal(unavailableDispatches, 0); });
	}
	check(() => {
		const task = tasks[0]!.definition;
		const raw = safeRawRun({ debug: "synthetic-canary-not-for-persistence", status: "pass" }, {
			batchId: "safe-test", manifestSha256: "a".repeat(64), runId: `${task.id}-r1`, taskId: task.id, category: task.category, variant: "current-full-contract", repetition: 1,
		}, task);
		assert.equal(raw.status, "invalid");
		assert.equal(raw.reasonCode, "RAW_VALIDATION_FAILED");
		assert.ok(!JSON.stringify(raw).includes("synthetic-canary"));
		assert.ok(!("debug" in raw));
	});
	const guard = pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href;
	const child = spawnSync(process.execPath, ["--import", guard, process.env.PI_EVAL_BUNDLE!, "guard-probe"], {
		env: { ...process.env, PI_EVAL_WORKER: "1" }, encoding: "utf8", timeout: 20_000,
	});
	check(() => { assert.equal(child.status, 0, "Guard probe failed"); assert.match(child.stdout, /OFFLINE_GUARD_PROBE_PASS/); });
	const timedOut = spawnSync(process.execPath, ["--import", guard, process.env.PI_EVAL_BUNDLE!, "timeout-probe"], {
		env: { ...process.env, PI_EVAL_WORKER: "1" }, timeout: 200, stdio: "pipe",
	});
	check(() => assert.ok(timedOut.error && "code" in timedOut.error && timedOut.error.code === "ETIMEDOUT"));
	const before = await treeManifest(path.resolve("fixtures/harness-novel"));
	const { directory, aggregate } = await runBatch(matrixVariants);
	check(() => assert.equal(aggregate.runCount, tasks.length * 3 * matrixVariants.length));
	check(() => assert.ok(aggregate.deterministic));
	check(() => assert.ok(aggregate.groups.every((group) => group.statuses.pass + group.statuses.unsupported === group.count)));
	check(() => assert.ok(aggregate.groups.every((group) => group.usage.missingRuns === group.count && group.usage.actualProviderRuns === 0)));
	check(() => {
		const text = report(aggregate);
		assert.match(text, /## Historical module contracts/);
		assert.match(text, /## Current-source component contracts/);
		assert.match(text, /VER-002-long-horizon/);
		assert.match(text, /native compaction, Supervisor and context maintenance are not exercised/);
	});
	check(() => {
		for (const group of aggregate.groups) {
			const supported = tasks.filter((task) => task.definition.category === group.category && (task.definition.requiredCapabilities ?? []).every((capability) => resolveAdapter(group.variant).capabilities.includes(capability))).length;
			assert.equal(group.statuses.pass, supported * 3);
			assert.equal(group.statuses.unsupported, group.count - supported * 3);
		}
	});
	assert.deepEqual(await treeManifest(path.resolve("fixtures/harness-novel")), before); count++;
	const manifestFile = path.join(directory, "manifest.json");
	const manifestBytes = await readFile(manifestFile);
	const replay = await rebuildBatch(directory);
	check(() => assert.ok(sameAggregate(aggregate, replay)));
	assert.equal(sha256(await readFile(manifestFile)), sha256(manifestBytes)); count++;
	await assert.rejects(() => rebuildBatch(path.resolve("fixtures/harness-novel"))); count++;
	const parent = path.resolve("artifacts/harness/evals");
	const corruptedSnapshot = await mkdtemp(path.join(parent, "snapshot-integrity-"));
	try {
		const snapshots = path.join(corruptedSnapshot, "evals/adapters/snapshots");
		await mkdir(snapshots, { recursive: true });
		await writeFile(path.join(snapshots, "types.ts"), "synthetic corrupted snapshot", "utf8");
		await assert.rejects(() => validateHistoricalSnapshots(corruptedSnapshot), /HISTORICAL_SNAPSHOT_MISMATCH/); count++;
	} finally {
		await assertInside(parent, corruptedSnapshot);
		assert.ok(path.basename(corruptedSnapshot).startsWith("snapshot-integrity-"));
		await rm(corruptedSnapshot, { recursive: true, force: true, maxRetries: 3 });
	}
	const tampered = await mkdtemp(path.join(parent, "integrity-test-"));
	try {
		await cp(directory, tampered, { recursive: true });
		const index = JSON.parse(await readBounded(path.join(tampered, "result-index.json")));
		const rawPath = path.join(tampered, index.entries[0].file);
		await writeFile(rawPath, "{\"incomplete\":", "utf8");
		await assert.rejects(() => rebuildBatch(tampered)); count++;
		await rm(rawPath);
		await assert.rejects(() => rebuildBatch(tampered)); count++;
		const beforeAudit = await treeManifest(tampered);
		const rejected = spawnSync(process.execPath, ["--import", guard, process.env.PI_EVAL_BUNDLE!, "rebuild", tampered], {
			env: process.env, encoding: "utf8", timeout: 20_000,
		});
		check(() => { assert.equal(rejected.status, 1); assert.match(rejected.stderr, /Offline evaluation rejected: RAW_FILE_SET_MISMATCH/); });
		assert.deepEqual(await treeManifest(tampered), beforeAudit); count++;
	} finally {
		await assertInside(parent, tampered);
		assert.ok(path.basename(tampered).startsWith("integrity-test-"));
		await rm(tampered, { recursive: true, force: true, maxRetries: 3 });
	}
	return count;
}
