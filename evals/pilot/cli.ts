import assert from "node:assert/strict";
import path from "node:path";
import { assertInside } from "../core/io.js";
import { runModelProjectionTests } from "../../tests/pilot/model.js";
import { runPilotTransportTests } from "../../tests/pilot/transport.js";
import { runPilotUsageTests } from "../../tests/pilot/usage.js";
import { runPilotRecordTests } from "../../tests/pilot/records.js";
import { runSdkSessionTests } from "../../tests/pilot/sdk-session.js";
import { rebuildPilotBatch } from "./records.js";
import { runPilotRehearsal, runRehearsalWorker, testPilotWorkerGuard, testPilotSdkWorker } from "./runner.js";
import { isPilotTaskId } from "./policy.js";
import { runLiveManifestTests } from "../../tests/pilot/live-manifest.js";
import { runPilotJournalTests } from "../../tests/pilot/journal.js";
import { runBrokerWorker } from "./broker-worker.js";
import { prepareLivePilot, runBrokerDryRun, runLivePilot, testBrokerFailures } from "./live-runner.js";
import { recoverLiveResults } from "./live-records.js";
import { runPrivateConfigTests } from "../../tests/pilot/private-config.js";
import { runLiveRecordsTests } from "../../tests/pilot/live-records.js";
import { liveAuthorizationToken, readLiveManifest, validateLiveAuthorization } from "./live-manifest.js";
import { runAnswerDiagnosticTests } from "../../tests/pilot/answer-diagnostics.js";

try {
	const mode = process.argv[2];
	if (mode === "test") {
		const answers = runAnswerDiagnosticTests();
		const model = await runModelProjectionTests();
		const transport = await runPilotTransportTests();
		const usage = await runPilotUsageTests();
		const manifest = await runLiveManifestTests();
		const journal = await runPilotJournalTests();
		const privateConfig = runPrivateConfigTests();
		const liveRecords = await runLiveRecordsTests();
		const records = await runPilotRecordTests();
		const guard = testPilotWorkerGuard();
		const sdk = await testPilotSdkWorker();
		console.log(`Pilot offline tests: answers=${answers}, model=${model}, transport=${transport}, usage=${usage}, records=${records}, guard=${guard}, sdk=${sdk}, manifest=${manifest}, journal=${journal}, config=${privateConfig}, liveRecords=${liveRecords}. Zero real model requests.`);
		const result = await runPilotRehearsal();
		console.log(`Pilot SDK rehearsal: ${JSON.stringify(result.aggregate)}; directory=${result.directory}`);
		assert.equal(result.aggregate.pass, 2, "PILOT_REHEARSAL_FAILED");
		const broker = await runBrokerDryRun();
		console.log(`Pilot broker dry-run: ${JSON.stringify(broker)}`);
		assert.equal(broker.aggregate.status, "pass", "PILOT_BROKER_DRY_RUN_FAILED");
		console.log(`Pilot broker fault tests: ${await testBrokerFailures()}. Zero real model requests.`);
	} else if (mode === "broker-dry-run") {
		const broker = await runBrokerDryRun(); console.log(JSON.stringify(broker));
		assert.equal(broker.aggregate.status, "pass", "PILOT_BROKER_DRY_RUN_FAILED");
	} else if (mode === "prepare-live") {
		const result = await prepareLivePilot(process.argv[3]);
		console.log(JSON.stringify({ directory: result.directory, manifestSha256: result.manifestSha256, expiresAt: result.manifest.expiresAt,
			model: result.manifest.model, limits: result.manifest.limits, credentialResolved: false, realHttpDispatches: 0, costUsd: null }, null, 2));
	} else if (mode === "live") {
		const result = await runLivePilot(path.resolve(process.argv[3]), process.argv[4], process.argv[6], process.argv[7] === "--accept-unknown-cost");
		console.log(JSON.stringify(result, null, 2));
		if (result.status !== "pass") process.exitCode = 1;
	} else if (mode === "authorize-live") {
		await assertInside(path.resolve("artifacts/harness/live-pilots"), path.resolve(process.argv[3]));
		const { manifest, sha256 } = await readLiveManifest(path.join(process.argv[3], "manifest.json"));
		validateLiveAuthorization(sha256, process.argv[7] === "--accept-unknown-cost" ? liveAuthorizationToken(process.argv[6]) : null, new Date(), manifest);
	} else if (mode === "recover-live") {
		await assertInside(path.resolve("artifacts/harness/live-pilots"), path.resolve(process.argv[3]));
		console.log(JSON.stringify(await recoverLiveResults(process.argv[3]), null, 2));
	} else if (mode === "rehearse") {
		const result = await runPilotRehearsal();
		console.log(`Pilot SDK rehearsal: ${JSON.stringify(result.aggregate)}; directory=${result.directory}`);
		assert.equal(result.aggregate.pass, 2, "PILOT_REHEARSAL_FAILED");
	} else if (mode === "rebuild") {
		await assertInside(path.resolve("artifacts/harness/pilot-rehearsals"), path.resolve(process.argv[3]));
		console.log(JSON.stringify(await rebuildPilotBatch(process.argv[3]), null, 2));
	} else if (mode === "broker-worker") {
		await runBrokerWorker();
	} else if (mode === "prepare-worker" || mode === "rehearsal-worker") {
		const taskId = process.argv[3];
		assert.ok(isPilotTaskId(taskId), "PILOT_TASK_INVALID");
		await runRehearsalWorker(taskId, process.argv[4], mode === "prepare-worker");
	} else if (mode === "guard-probe") {
		assert.equal(process.env.PI_EVAL_WORKER, "1", "PILOT_WORKER_REQUIRED");
		// Windows/Node can reconstruct OS identity paths even with an explicit env.
		// Pi isolation uses the explicit agentDir, not absence of USERPROFILE.
		assert.ok(!Object.keys(process.env).some((key) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)), "PILOT_PRIVATE_ENV");
		await assert.rejects(async () => fetch("https://pilot.invalid"), /OFFLINE_NETWORK_DENIED/);
		const http = await import("node:http"), child = await import("node:child_process");
		assert.throws(() => http.get("http://127.0.0.1:1"), /OFFLINE_NETWORK_DENIED/);
		assert.throws(() => child.spawn("arbitrary-command"), /OFFLINE_SUBPROCESS_DENIED/);
		console.log("PILOT_GUARD_PASS");
	} else if (mode === "sdk-test-worker") {
		assert.equal(process.env.PI_EVAL_WORKER, "1", "PILOT_WORKER_REQUIRED");
		console.log(`PILOT_SDK_TEST_PASS ${await runSdkSessionTests()}`);
	} else throw new Error("LIVE_NOT_AUTHORIZED");
} catch (error) {
	const candidate = error instanceof Error ? error.message.split("\n")[0].trim() : "";
	const reason = /^[A-Z][A-Z0-9_]{2,79}$/.test(candidate) ? candidate : "PILOT_REJECTED";
	console.error(`Pilot rejected: ${reason}`);
	process.exitCode = 1;
}
