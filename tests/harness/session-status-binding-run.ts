import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { runSessionStatusBindingCases } from "./session-status-binding.js";
let cases = 0, failures = 0;
const results: Array<{ id: string; pass: boolean; error?: string }> = [];
await runSessionStatusBindingCases(async (id, body) => {
	cases++;
	try { await body(() => undefined); results.push({ id, pass: true }); console.log(`PASS ${id}`); }
	catch (error) { failures++; results.push({ id, pass: false, error: String(error) }); console.error(`FAIL ${id}`, error); }
});
await mkdir("artifacts/harness/session-status-binding", { recursive: true });
const output = await mkdtemp("artifacts/harness/session-status-binding/check-");
await writeFile(`${output}/summary.json`, JSON.stringify({
	checkedAt: new Date().toISOString(), head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	mainSha256: createHash("sha256").update(await readFile("src/main.ts")).digest("hex"),
	cases, failures, modelCalls: 0, rpcRequests: 0, results,
}, null, 2));
console.log(`Evidence: ${output}/summary.json`);
console.log(`Session status binding: ${cases} cases; failures=${failures}; modelCalls=0; rpcRequests=0`);
assert.equal(failures, 0);
