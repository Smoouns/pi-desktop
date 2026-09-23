import assert from "node:assert/strict";
import { assertInside } from "../core/io.js";
import { CASES, type RaceCase } from "./policy.js";
import { sessionWorker, executorWorker } from "./session.js";
import { runBatch } from "./runner.js";
import { rebuild } from "./records.js";
import { runTests } from "../../tests/sdk-recovery-races/tests.js";

try {
  const mode = process.argv[2];
  if (mode === "worker" || mode === "executor") {
    assert.equal(process.env.PI_EVAL_WORKER, "1"); await assertInside(process.env.PI_RACE_WORK_ROOT!, process.argv[3]);
    process.once("disconnect", () => process.exit(1));
    if (mode === "worker") { assert.ok(CASES.includes(process.argv[4] as RaceCase)); assert.ok(["seed", "resume"].includes(process.argv[5])); await sessionWorker(process.argv[3], process.argv[4] as RaceCase, process.argv[5] as "seed" | "resume"); }
    else await executorWorker(process.argv[3]);
    process.removeAllListeners("disconnect"); process.disconnect?.();
  } else if (mode === "run") console.log(JSON.stringify(await runBatch(), null, 2));
  else if (mode === "rebuild") console.log(JSON.stringify(await rebuild(process.argv[3]), null, 2));
  else if (mode === "test") console.log(JSON.stringify(await runTests(), null, 2));
  else throw new Error("RACE_OFFLINE_ONLY");
} catch (error) { console.error(error); process.exitCode = 1; if (process.connected) process.disconnect?.(); }
