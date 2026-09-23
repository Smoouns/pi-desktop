import { checkAuthorization, prepareLive, runDry, runLive } from "./runner.js";
import { recover } from "./records.js";
import { formatDiagnostics } from "./diagnostics.js";
import { supervisionLiveWorker } from "./session.js";
import { SIMULATIONS, type Simulation } from "./policy.js";
import { runTests } from "../../tests/sdk-supervision-live/tests.js";
try {
	const mode = process.argv[2];
	if (mode === "worker") await supervisionLiveWorker();
	else if (mode === "test") console.log(`SDK S4 live tooling tests passed: ${await runTests()}. Zero real model requests.`);
	else if (mode === "dry-run") { const simulation = process.argv[3] ?? "readback"; if (!SIMULATIONS.includes(simulation as Simulation) || simulation === "none") throw new Error("S4L_SIMULATION_INVALID"); console.log(JSON.stringify(await runDry(simulation as Exclude<Simulation, "none">), null, 2)); }
	else if (mode === "prepare") { const result = await prepareLive(process.argv[3]); console.log(JSON.stringify({ directory: result.directory, manifestSha256: result.manifestSha256, model: result.manifest.model, limits: result.manifest.limits, referenceBudget: result.manifest.referenceBudget, expiresAt: result.manifest.expiresAt }, null, 2)); }
	else if (mode === "recover") console.log(JSON.stringify(await recover(process.argv[3]), null, 2));
	else if (mode === "diagnose") console.log(formatDiagnostics(await recover(process.argv[3])));
	else if (mode === "authorize") await checkAuthorization(process.argv[3], process.argv[6], process.argv[7] === "--accept-unknown-cost");
	else if (mode === "live") console.log(JSON.stringify(await runLive(process.argv[3], process.argv[4], process.argv[6], process.argv[7] === "--accept-unknown-cost"), null, 2));
	else throw new Error("S4L_MODE_REJECTED");
} catch (error) { if (process.argv[2] === "test" || process.argv[2] === "dry-run") console.error(error); console.error("SDK_S4_LIVE_REJECTED"); process.exitCode = 1; }
