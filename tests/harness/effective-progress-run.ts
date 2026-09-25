import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runEffectiveProgressCases, runEffectiveProgressExtensionCases } from "./effective-progress.js";
import { fixtureRoot, sha256, treeManifest, type RunCase } from "./testkit.js";
const original = await treeManifest(fixtureRoot);
const parent = path.resolve("artifacts/harness/review-e6"); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "focused-"));
const sourceHashes = Object.fromEntries(await Promise.all(["src/harness/run-supervisor.ts", "src/harness/verification-progress.ts", "src/extensions/novel-tools-extension.ts", "src/extensions/supervisor-runtime.ts"].map(async name => [name, sha256(await readFile(name))])));
const results: { id: string; passed: boolean; error?: string }[] = [];
const runCase: RunCase = async (id, body) => {
	try { await body(() => undefined); results.push({ id, passed: true }); console.log(`PASS ${id}`); }
	catch (error) { const message = error instanceof Error ? error.message : String(error); results.push({ id, passed: false, error: message }); console.error(`FAIL ${id}: ${message}`); }
};
await runEffectiveProgressCases(runCase); await runEffectiveProgressExtensionCases(runCase);
assert.deepEqual(await treeManifest(fixtureRoot), original);
await writeFile(path.join(output, "summary.json"), JSON.stringify({ sourceHashes, results, modelCalls: 0, fixtureUnchanged: true }, null, 2) + "\n");
console.log(`${results.length} cases, failures=${results.filter(item => !item.passed).length}; ${output}`);
assert.ok(results.every(item => item.passed));
