import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { runToolOutputAccountingCases } from "./tool-output-accounting.js";
const parent = path.resolve("artifacts/harness"); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "tool-output-accounting-"));
const cases: any[] = [];
await runToolOutputAccountingCases(async (id, body) => {
	try { await body(() => undefined); cases.push({ id, pass: true }); console.log("PASS " + id); }
	catch (error) { cases.push({ id, pass: false, error: (error as Error).stack }); console.error("FAIL " + id, error); }
});
await writeFile(path.join(output, "summary.json"), JSON.stringify({ cases, failures: cases.filter(c => !c.pass).length, realModelCalls: 0 }, null, 2));
console.log("Tool output accounting evidence: " + output); assert.equal(cases.filter(c => !c.pass).length, 0);
