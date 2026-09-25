import assert from "node:assert/strict";
import { runRequestSourceCacheCases } from "./request-source-cache.js";
import { fixtureRoot, treeManifest, type RunCase } from "./testkit.js";

const before = await treeManifest(fixtureRoot);
let cases = 0, failures = 0;
const runCase: RunCase = async (id, body) => {
	try { await body(() => undefined); assert.deepEqual(await treeManifest(fixtureRoot), before); console.log(`PASS ${id}`); }
	catch (error) { failures++; console.error(`FAIL ${id}`, error); }
	cases++;
};
await runRequestSourceCacheCases(runCase);
console.log(`Request source cache: ${cases} cases; failures=${failures}; modelCalls=0`);
assert.equal(failures, 0);
