import assert from "node:assert/strict";
import { runTaskProgressCases } from "./task-progress.js";
import { runTaskProgressExtensionCases } from "./task-progress-extension.js";
let cases = 0, failures = 0;
for (const run of [runTaskProgressCases, runTaskProgressExtensionCases]) await run(async (id, body) => { cases++; try { await body(() => undefined); console.log(`PASS ${id}`); } catch (error) { failures++; console.error(`FAIL ${id}`, error); } });
console.log(`Task progress: ${cases} cases; failures=${failures}; modelCalls=0`); assert.equal(failures, 0);
