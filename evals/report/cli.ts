import assert from "node:assert/strict";
import path from "node:path";
import { readBounded } from "../core/io.js";
import { catalog } from "./catalog.js";
import { verifyPackage, writePackage } from "./report.js";

async function main() {
  const mode = process.argv[2], root = process.cwd();
  assert.ok(["run", "verify", "test"].includes(mode)); assert.equal(process.argv.length, mode === "verify" ? 4 : 3);
  const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")];
  assert.ok(guard?.active && process.env.PI_EVAL_WORKER === "1");
  const builder = JSON.parse(await readBounded(process.env.PI_REPORT_INPUTS!));
  if (mode === "test") {
    const { runTests } = await import("../../tests/report/tests.js");
    console.log(JSON.stringify(await runTests(builder), null, 2));
  } else if (mode === "run") {
    const result = await writePackage(root, catalog, builder);
    console.log(JSON.stringify({ directory: path.relative(root, result.directory).replaceAll("\\", "/"), verifiedBatches: result.report.verifiedBatches,
      selectedBatches: result.report.selectedBatches, newModelRequests: 0,
      rejected: result.report.batches.filter(b => b.integrity !== "verified").map(b => ({ id: b.selection.id, problem: b.problem })) }, null, 2));
    if (result.report.verifiedBatches !== result.report.selectedBatches) process.exitCode = 1;
  } else {
    const result = await verifyPackage(root, path.resolve(process.argv[3]), builder);
    console.log(JSON.stringify(result, null, 2));
    if (result.verifiedBatches !== result.selectedBatches) process.exitCode = 1;
  }
  assert.equal(guard.attempts, 0, "REPORT_EXTERNAL_ATTEMPT");
}
main().catch(() => { console.error("REPORT_FAILED: refused invalid evidence, package, arguments or builder drift; no model request was started."); process.exitCode = 1; });
