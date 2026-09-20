import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTraceRecorder } from "../../src/harness/trace.js";
import type { TraceEvent } from "../../src/harness/types.js";
import { runContractCases } from "./contracts.js";
import { runMemoryCases } from "./memory.js";
import { runRpcCases } from "./rpc.js";
import { runTraceCases } from "./trace.js";
import { runVerifierCases } from "./verifier.js";
import { fixtureRoot, sha256, treeManifest, type RunCase } from "./testkit.js";

type CaseResult = { id: string; status: "pass" | "fail" | "partial"; trace: TraceEvent[]; unsupported: Array<{ subcase: string; reason: string }>; error?: string };
const original = await treeManifest(fixtureRoot);
const repetitions: CaseResult[][] = [];
const output = path.resolve("artifacts/harness");
await mkdir(output, { recursive: true });

for (let repetition = 1; repetition <= 3; repetition++) {
	const results: CaseResult[] = [];
	const runCase: RunCase = async (id, body, scope = {}) => {
		assert.ok(!results.some((result) => result.id === id), `Duplicate case ID: ${id}`);
		const trace = createTraceRecorder({
			caseId: id,
			scope: { projectId: "synthetic-a", sessionId: "session-a", runId: "baseline-run", generation: 1, role: null, ...scope },
			now: () => 0,
		});
		let failure: unknown;
		const unsupported: CaseResult["unsupported"] = [];
		try {
			assert.deepEqual(await treeManifest(fixtureRoot), original, "Fixture changed before case");
			trace.record("case.started");
			await body((event, summary) => {
				trace.record(event, summary);
				if (event === "case.unsupported") {
					assert.equal(process.platform, "win32", "Required Linux case cannot be unsupported");
					assert.equal(typeof summary?.subcase, "string");
					assert.equal(typeof summary?.reason, "string");
					unsupported.push({ subcase: String(summary?.subcase), reason: String(summary?.reason) });
				}
			});
		} catch (error) { failure = error; }
		try { assert.deepEqual(await treeManifest(fixtureRoot), original, "Fixture changed after case"); }
		catch (error) { failure = error; }
		trace.record("case.completed", { passed: !failure && unsupported.length === 0, unsupportedSubcases: unsupported.length });
		const result: CaseResult = { id, status: failure ? "fail" : unsupported.length ? "partial" : "pass", trace: trace.snapshot(), unsupported };
		if (failure) {
			result.error = (failure instanceof Error ? failure.message : String(failure)).replaceAll(process.cwd(), "<repo>").replaceAll(os.tmpdir(), "<tmp>").slice(0, 2000);
			console.error(`FAIL ${id}: ${result.error}`);
		} else console.log(`${result.status === "partial" ? "PARTIAL" : "PASS"} ${id}${unsupported.length ? `: ${JSON.stringify(unsupported)}` : ""}`);
		results.push(result);
	};
	await runTraceCases(runCase);
	await runContractCases(runCase);
	await runMemoryCases(runCase);
	await runRpcCases(runCase);
	await runVerifierCases(runCase);
	repetitions.push(results);
	await writeFile(path.join(output, `run-${repetition}.json`), JSON.stringify(results, null, 2) + "\n");
}

let deterministic = true;
try {
	assert.deepEqual(repetitions[1], repetitions[0]);
	assert.deepEqual(repetitions[2], repetitions[0]);
} catch { deterministic = false; }
const packageVersion = async (name: string): Promise<string> => JSON.parse(await readFile(path.join("node_modules", name, "package.json"), "utf8")).version;
const implementationFiles: Record<string, string> = {};
for (const name of [
	"src/extensions/novel-tools-extension.ts", "src/novel/context.ts", "src/novel/context-attachment.ts",
	"src/components/chat-view.ts", "src/novel/memory-engine.ts", "src/rpc/bridge.ts",
	"scripts/verify-novel-chapter.ts", "scripts/run-public-tests.mjs", "scripts/run-harness-baseline.mjs",
	"scripts/novel-domain-smoke.ts", "scripts/novel-tools-extension-smoke.ts", "scripts/novel-verifier-smoke.ts",
	"scripts/novel-memory-smoke.ts", "scripts/world-change-smoke.ts", "package.json", "tsconfig.harness.json",
]) implementationFiles[name] = sha256(await readFile(name));
for (const directory of ["src/harness", "tests/harness", "tests/support"]) {
	for (const [name, hash] of Object.entries(await treeManifest(directory))) implementationFiles[`${directory}/${name}`] = hash;
}
const summary = {
	schemaVersion: 1, baselineCommit: "3b5f8b06131d46ee0b4b97dd646ba3d6f6bcd887",
	implementationHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
	node: process.version, npm: process.env.npm_config_user_agent?.split(" ")[0] ?? "unavailable",
	platform: process.platform, arch: process.arch, osRelease: os.release(),
	piSdk: await packageVersion("@mariozechner/pi-coding-agent"), esbuild: await packageVersion("esbuild"),
	lockSha256: sha256(await readFile("package-lock.json")), fixtureSha256: sha256(JSON.stringify(original)),
	implementationFiles, implementationSha256: sha256(JSON.stringify(implementationFiles)),
	fixture: original, repetitions: 3, deterministic,
	cases: repetitions[0].map(({ id, status, unsupported }) => ({ id, status, unsupported })),
	actualModelInputTokens: null, modelCalls: 0,
};
await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
const failed = repetitions.some((results) => results.some((result) => result.status === "fail"));
console.log(`Harness: ${summary.cases.length} cases x 3; deterministic=${deterministic}; failures=${failed}`);
if (failed || !deterministic) process.exitCode = 1;
