import assert from "node:assert/strict";
import { SDK_PROFILES, SDK_SCENARIOS, SDK_TASKS, type SdkProfile, type SdkTask, type SdkScenario } from "./policy.js";
import { rebuildSdkBatch } from "./records.js";
import { runSdkBatch, sdkWorker } from "./runner.js";
import { runSdkTests, runSdkUnitTests } from "../../tests/sdk-ablation/tests.js";

try {
	const mode = process.argv[2];
	if (mode === "run") console.log(JSON.stringify(await runSdkBatch()));
	else if (mode === "rebuild") console.log(JSON.stringify(await rebuildSdkBatch(process.argv[3]), null, 2));
	else if (mode === "test") console.log(`SDK ablation tests passed: ${await runSdkTests()}. Zero real model requests.`);
	else if (mode === "unit-worker") console.log(`SDK_UNIT_PASS ${await runSdkUnitTests()}`);
	else if (mode === "task-worker" || mode === "prepare-worker") {
		const [profile, task, directory, scenario] = process.argv.slice(3);
		assert.ok(SDK_PROFILES.includes(profile as SdkProfile) && SDK_TASKS.includes(task as SdkTask) && SDK_SCENARIOS.includes(scenario as SdkScenario), "SDK_WORKER_ARGUMENTS");
		await sdkWorker(profile as SdkProfile, task as SdkTask, directory, scenario as SdkScenario, mode === "prepare-worker");
	} else throw new Error("SDK_MODE_INVALID");
} catch (error) {
	// No filesystem/SDK exception text or raw model output is exported.
	const known = ["SDK_UNIT_FAILED", "SDK_WORKER_FAILED", "SDK_BASELINE_DRIFT", "SDK_B1_FACTORY_DRIFT", "SDK_BASELINE_GIT_MISSING", "SDK_BASELINE_GIT_SHA", "SDK_BASELINE_GIT_BLOB", "SDK_CAPABILITY_LEAK", "SDK_EXTENSION_LOAD_FAILED", "SDK_PREPARED_DRIFT", "SDK_BATCH_UNEXPECTED_RESULT", "SDK_UNFAIR_SYSTEM", "SDK_UNFAIR_TOOLS"];
	const code = error instanceof Error ? error.message.split("\n")[0] : "";
	console.error(known.includes(code) ? code : "SDK_ABLATION_REJECTED"); process.exitCode = 1;
}
