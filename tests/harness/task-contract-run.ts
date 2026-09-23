import assert from "node:assert/strict";
import { runTaskContractExtensionCases } from "./task-contract-extension.js";
import { runTaskContractCases } from "./task-contract.js";
import { fixtureRoot, treeManifest, type RunCase } from "./testkit.js";

const original = await treeManifest(fixtureRoot);
let cases = 0, failures = 0;
const runCase: RunCase = async (id, body) => {
	try { await body(() => undefined); console.log(`PASS ${id}`); }
	catch (error) { failures++; console.error(`FAIL ${id}`, error); }
	assert.deepEqual(await treeManifest(fixtureRoot), original);
	cases++;
};
await runTaskContractCases(runCase);
await runTaskContractExtensionCases(runCase);
console.log(`Task contract: ${cases} cases; failures=${failures}; modelCalls=0`);
assert.equal(failures, 0);
