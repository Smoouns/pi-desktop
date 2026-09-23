import assert from "node:assert/strict";
import { SCENARIOS, type Scenario } from "./policy.js";
import { runTransportProbe } from "./runner.js";
import { recover } from "./records.js";
import { contextTransportWorker } from "./worker.js";
import { runTransportTests } from "../../tests/sdk-context-transport/tests.js";
try {
	const [mode, arg] = process.argv.slice(2);
	if (mode === "worker") await contextTransportWorker();
	else if (mode === "test") console.log(`S3 transport: ${await runTransportTests()} checks passed`);
	else if (mode === "recover") console.log(JSON.stringify(await recover(arg), null, 2));
	else if (mode === "run") { assert.ok(SCENARIOS.includes((arg ?? "manual") as Scenario)); console.log(JSON.stringify(await runTransportProbe((arg ?? "manual") as Scenario), null, 2)); }
	else throw new Error("S3T_OFFLINE_ONLY");
} catch { console.error("S3T_REJECTED"); process.exitCode = 1; }
