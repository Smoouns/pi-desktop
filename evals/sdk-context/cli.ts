import assert from "node:assert/strict";
import path from "node:path";
import { writeOnce } from "../core/io.js";
import { PROFILES, SCENARIOS, TASKS, type Profile, type Scenario, type Task } from "./policy.js";
import { rebuild } from "./records.js";
import { runBatch, runScenario } from "./runner.js";
import { runStage, type Stage } from "./session.js";
import { runTests, unitWorker } from "../../tests/sdk-context/tests.js";
import { LIFE_PROFILES, LIFE_SCENARIOS, LIFE_TASKS, type LifeProfile, type LifeScenario, type LifeTask } from "./lifecycle-policy.js";
import { runLifecycleStage, type LifeStage } from "./lifecycle-session.js";
import { runLifecycleBatch, runLifecycleScenario } from "./lifecycle-runner.js";
import { rebuildLifecycle } from "./lifecycle-records.js";
import { runLifecycleTests, lifecycleUnitWorker } from "../../tests/sdk-context/lifecycle-tests.js";
try {
	const mode=process.argv[2];
	if(mode==="lifecycle-worker") { const [work,profile,task,stage,scenario]=process.argv.slice(3); assert.ok(LIFE_PROFILES.includes(profile as LifeProfile)&&LIFE_TASKS.includes(task as LifeTask)&&["single","seed","resume"].includes(stage)&&LIFE_SCENARIOS.includes(scenario as LifeScenario)); await writeOnce(path.join(work,`lifecycle-${stage}.json`), await runLifecycleStage(work,profile as LifeProfile,task as LifeTask,stage as LifeStage,scenario as LifeScenario)); }
	else if(mode==="lifecycle-probe") console.log(JSON.stringify(await runLifecycleScenario(process.argv[3] as LifeProfile,process.argv[4] as LifeTask,(process.argv[5]??"normal") as LifeScenario),null,2));
	else if(mode==="lifecycle-run") console.log(JSON.stringify(await runLifecycleBatch(),null,2));
	else if(mode==="lifecycle-rebuild") console.log(JSON.stringify(await rebuildLifecycle(process.argv[3]),null,2));
	else if(mode==="lifecycle-test") console.log(`SDK S3 lifecycle tests passed: ${await runLifecycleTests()}. Zero real model requests.`);
	else if(mode==="lifecycle-unit-worker") console.log(`S3_LIFECYCLE_UNIT_PASS ${await lifecycleUnitWorker()}`);
	else if(mode==="worker") {const [work,profile,task,stage,scenario]=process.argv.slice(3);assert.ok(PROFILES.includes(profile as Profile)&&TASKS.includes(task as Task)&&["single","seed","resume"].includes(stage)&&SCENARIOS.includes(scenario as Scenario));await writeOnce(path.join(work,stage+".json"),await runStage(work,profile as Profile,task as Task,stage as Stage,scenario as Scenario));}
	else if(mode==="probe")console.log(JSON.stringify(await runScenario(process.argv[3] as Profile,process.argv[4] as Task,(process.argv[5]??"normal") as Scenario),null,2));
	else if(mode==="run")console.log(JSON.stringify(await runBatch(),null,2));
	else if(mode==="rebuild")console.log(JSON.stringify(await rebuild(process.argv[3]),null,2));
	else if(mode==="test")console.log(`SDK S3 tests passed: ${await runTests()}. Zero real model requests.`);
	else if(mode==="unit-worker")console.log(`S3_UNIT_PASS ${await unitWorker()}`);
	else throw new Error("S3_OFFLINE_ONLY");
}catch(error){console.error(error);process.exitCode=1;}
