import assert from "node:assert/strict";
import { runTaskTransportCases } from "./task-transport.js";
let cases = 0, failures = 0;
await runTaskTransportCases(async (id, body) => { cases++; try { await body(() => undefined); console.log(`PASS ${id}`); } catch (error) { failures++; console.error(`FAIL ${id}`, error); } });
console.log(`Task transport: ${cases} cases; failures=${failures}; modelCalls=0`);
assert.equal(failures, 0);
