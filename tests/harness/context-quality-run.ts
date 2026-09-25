import assert from "node:assert/strict";
import { runContextMaintenanceCases } from "./context-maintenance.js";
let cases = 0, failures = 0;
await runContextMaintenanceCases(async (id, body) => { cases++; try { await body(() => undefined); console.log(`PASS ${id}`); } catch (error) { failures++; console.error(`FAIL ${id}`, error); } });
console.log(`Context quality: ${cases} cases; failures=${failures}; modelCalls=0; semanticQuality=not-measured`);
assert.equal(failures, 0);
