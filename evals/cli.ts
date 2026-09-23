import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeTask, matrixVariants, rebuildBatch, report, runBatch } from "./core/runner.js";
import { assertInside, readBounded, writeOnce } from "./core/io.js";
import { runAggregateTests } from "../tests/evals/aggregate.js";
import { runRunnerTests } from "../tests/evals/runner.js";
import { runHistoricalTests } from "../tests/evals/historical.js";
import { runLongHorizonTests } from "../tests/evals/long-horizon.js";
import { runFaultMetricTests } from "../tests/evals/fault-metrics.js";

const mode = process.argv[2];
try {
	if (mode === "task") {
		assert.equal(process.argv.length, 7, "INVALID_WORKER_ARGS");
		await executeTask(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
	} else if (mode === "run" || mode === "matrix") {
		const { directory, aggregate } = await runBatch(mode === "matrix" ? matrixVariants : undefined);
		await writeFile(path.join(directory, "report.md"), report(aggregate), { flag: "wx" });
		console.log(`Offline batch: ${path.relative(process.cwd(), directory)}; runs=${aggregate.runCount}; deterministic=${aggregate.deterministic}`);
		// Unsupported is an explicitly reported missing capability, never a PASS.
		if (!aggregate.deterministic || aggregate.groups.some((group) => group.statuses.pass + group.statuses.unsupported !== group.count)) process.exitCode = 1;
	} else if (mode === "rebuild") {
		const aggregate = await rebuildBatch(process.argv[3]);
		// Rebuilding is read-only: print to stdout instead of replacing evidence.
		console.log(JSON.stringify(aggregate, null, 2));
	} else if (mode === "test") {
		const schemaCount = await runAggregateTests();
		const historicalCount = await runHistoricalTests();
		const longHorizonCount = await runLongHorizonTests();
		const faultMetricCount = await runFaultMetricTests();
		const runnerCount = await runRunnerTests();
		console.log(`Eval self-tests: ${schemaCount} schema/aggregate + ${historicalCount} historical + ${longHorizonCount} long-horizon + ${faultMetricCount} fault-metrics + ${runnerCount} runner/integrity checks passed; zero real model calls.`);
	} else if (mode === "guard-probe") {
		assert.equal(process.env.PI_EVAL_WORKER, "1");
		assert.ok(!Object.keys(process.env).some((key) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)), "CREDENTIAL_ENV_LEAK");
		const http = await import("node:http");
		const child = await import("node:child_process");
		assert.throws(() => http.get("http://127.0.0.1:1"), /OFFLINE_NETWORK_DENIED/);
		assert.throws(() => child.spawn("arbitrary-command"), /OFFLINE_SUBPROCESS_DENIED/);
		await assert.rejects(async () => fetch("https://invalid.invalid"), /OFFLINE_NETWORK_DENIED/);
		console.log("OFFLINE_GUARD_PROBE_PASS");
	} else if (mode === "timeout-probe") {
		assert.equal(process.env.PI_EVAL_WORKER, "1");
		await new Promise((resolve) => setTimeout(resolve, 30_000));
	} else throw new Error("INVALID_EVAL_MODE");
} catch (error) {
	// Never persist raw exception messages/stack/payloads, even for malformed input.
	const reason = error instanceof Error && /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message) ? error.message : "EVAL_REJECTED";
	console.error(`Offline evaluation rejected: ${reason}`);
	if (mode === "rebuild") {
		try {
			const directory = path.resolve(process.argv[3]);
			const output = path.resolve("artifacts/harness/evals");
			await assertInside(output, directory);
			await readBounded(path.join(directory, "manifest.json"));
			const rejectionRoot = path.join(output, "rejections");
			await mkdir(rejectionRoot, { recursive: true });
			await assertInside(output, rejectionRoot);
			const auditDirectory = await mkdtemp(path.join(rejectionRoot, "rejected-"));
			await writeOnce(path.join(auditDirectory, "reason.json"), { schemaVersion: 1, batchId: path.basename(directory), reasonCode: reason });
		} catch { /* Invalid locations are never written to. */ }
	}
	process.exitCode = 1;
}
