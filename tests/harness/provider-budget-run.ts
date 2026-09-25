import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runLoopbackHttpCases } from "./loopback-http.js";
import { runProviderBudgetCases } from "./provider-budget.js";
import { fixtureRoot, sha256, treeManifest, type RunCase } from "./testkit.js";

const original = await treeManifest(fixtureRoot);
const parent = path.resolve("artifacts/harness/review-e7"); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "focused-"));
const sourceHashes = Object.fromEntries(await Promise.all([
	"tests/support/loopback-http.ts", "tests/harness/loopback-http.ts", "tests/harness/provider-budget.ts", "tests/harness/provider-budget-run.ts",
	"src/extensions/novel-tools-extension.ts", "node_modules/@mariozechner/pi-ai/dist/providers/google.js", "node_modules/@google/genai/dist/node/index.mjs",
].map(async name => [name, sha256(await readFile(name))])));
const results: { repetition: number; id: string; passed: boolean; error?: string }[] = [];
// Fixed repetitions, not retry-until-green. Every assertion failure is retained.
for (let repetition = 1; repetition <= 3; repetition++) {
	const runCase: RunCase = async (id, body) => {
		try { await body(() => undefined); results.push({ repetition, id, passed: true }); console.log(`PASS ${repetition} ${id}`); }
		catch (error) { const message = error instanceof Error ? error.message : String(error); results.push({ repetition, id, passed: false, error: message }); console.error(`FAIL ${repetition} ${id}: ${message}`); }
	};
	await runLoopbackHttpCases(runCase); await runProviderBudgetCases(runCase);
}
assert.deepEqual(await treeManifest(fixtureRoot), original);
await writeFile(path.join(output, "summary.json"), JSON.stringify({ node: process.version, undici: process.versions.undici, sourceHashes, results, modelCalls: 0, fixtureUnchanged: true }, null, 2) + "\n");
console.log(`${results.length} checks, failures=${results.filter(item => !item.passed).length}; ${output}`);
assert.ok(results.every(item => item.passed));
