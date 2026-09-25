import assert from "node:assert/strict";
import { runUsageCalibrationCases } from "./usage-calibration.js";
let cases = 0, failures = 0;
await runUsageCalibrationCases(async (id, body) => { cases++; try { await body(() => undefined); console.log(`PASS ${id}`); } catch (error) { failures++; console.error(`FAIL ${id}`, error); } });
console.log(`Usage calibration: ${cases} cases; failures=${failures}; modelCalls=0; realCalibration=not-measured`);
assert.equal(failures, 0);
