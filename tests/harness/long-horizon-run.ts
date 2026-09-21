import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createTraceRecorder } from "../../src/harness/trace.js";
import { runLongHorizonCases } from "./phase4-extension.js";
import { fixtureRoot, treeManifest, sha256, type RunCase } from "./testkit.js";

// A deterministic hook/real-file workload, not a model-quality benchmark.
const original = await treeManifest(fixtureRoot);
const runs: Array<Array<{ id: string; trace: ReturnType<ReturnType<typeof createTraceRecorder>["snapshot"]>; status: string; error?: string }>> = [];
for (let repeat = 0; repeat < 3; repeat++) {
	const cases: typeof runs[number] = [];
	const runCase: RunCase = async (id, body) => {
		const recorder = createTraceRecorder({ caseId: id, scope: { projectId: "synthetic-a", sessionId: "long-horizon", runId: "deterministic", generation: 1, role: "write" }, now: () => 0 });
		try {
			await body((event, summary) => recorder.record(event, summary));
			assert.deepEqual(await treeManifest(fixtureRoot), original, "Repository fixture must remain unchanged");
			cases.push({ id, status: "pass", trace: recorder.snapshot() });
		} catch (error) {
			cases.push({ id, status: "fail", trace: recorder.snapshot(), error: error instanceof Error ? error.message : String(error) });
		}
	};
	await runLongHorizonCases(runCase);
	runs.push(cases);
}
let deterministic = true;
try { assert.deepEqual(runs[0], runs[1]); assert.deepEqual(runs[0], runs[2]); } catch { deterministic = false; }
await mkdir("artifacts/harness", { recursive: true });
const implementationFiles: Record<string, string> = {};
for (const name of ["src/harness/run-supervisor.ts", "src/extensions/supervisor-runtime.ts", "src/extensions/novel-tools-extension.ts", "scripts/verify-novel-chapter.ts", "tests/harness/phase4-extension.ts", "tests/harness/long-horizon-run.ts"]) implementationFiles[name] = sha256(await readFile(name));
await writeFile("artifacts/harness/long-horizon.json", JSON.stringify({ schemaVersion: 1, phase: "phase4", kind: "deterministic-real-loader-fault-eval", implementationHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()), implementationFiles, fixtureSha256: sha256(JSON.stringify(original)), modelCalls: 0, actualModelInputTokens: null, repetitions: 3, deterministic, runs }, null, 2) + "\n");
assert.ok(runs[0].length > 0, "Long-horizon suite cannot be empty");
assert.ok(deterministic, "Long-horizon traces must repeat deterministically");
assert.ok(runs.every((cases) => cases.every((item) => item.status === "pass")), JSON.stringify(runs.flat().filter((item) => item.status !== "pass")));
console.log(`Long-horizon: ${runs[0].length} cases x 3; deterministic=${deterministic}; modelCalls=0`);
