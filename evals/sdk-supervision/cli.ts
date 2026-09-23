import assert from "node:assert/strict";
import path from "node:path";
import { assertInside, writeOnce } from "../core/io.js";
import { PROFILES, TASKS, SCENARIOS, type Profile, type Task, type Scenario } from "./policy.js";
import { runSession } from "./session.js";
import { runBatch } from "./runner.js";
import { rebuild } from "./records.js";
import { runTests } from "../../tests/sdk-supervision/tests.js";

try {
  const mode = process.argv[2];
  if (mode === "worker") {
    assert.equal(process.env.PI_EVAL_WORKER, "1"); assert.equal(process.argv.length, 7); await assertInside(process.env.PI_S4_WORK_ROOT!, process.argv[3]);
    const profile = process.argv[4] as Profile, task = process.argv[5] as Task, scenario = process.argv[6] as Scenario;
    assert.ok(PROFILES.includes(profile) && TASKS.includes(task) && SCENARIOS.includes(scenario));
    await writeOnce(path.join(process.argv[3], "result.json"), await runSession(process.argv[3], profile, task, scenario));
  } else if (mode === "run") {
    const { directory, aggregate } = await runBatch(); console.log(JSON.stringify({ directory, status: aggregate.status, counts: aggregate.counts }, null, 2));
    if (aggregate.status !== "expected-contrast") process.exitCode = 1;
  }
  else if (mode === "rebuild") console.log(JSON.stringify(await rebuild(process.argv[3]), null, 2));
  else if (mode === "test") console.log(JSON.stringify(await runTests(), null, 2));
  else throw new Error("S4_OFFLINE_ONLY");
} catch (error) { console.error(error); process.exitCode = 1; }
