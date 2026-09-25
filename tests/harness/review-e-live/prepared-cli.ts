import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { freezeRequestPolicy } from "../../../evals/core/request-policy.js";
import { digest, recover } from "./journal.js";
import { loadConfig, probeCompatibility, resolveCredential } from "./model-projection.js";
import { activatePrepared, authorizePrepared, inspectPrepared, PREPARED_PARENT, safeJson, sourceManifest, verifyFiles, writeNew } from "./prepared-manifest.js";
import { buildAssets, runPreparedBatch, analyzeBatch, analyzeToolNone } from "./prepared-run.js";
import { PreparedBroker } from "./prepared-broker.js";
import { batchExitCode } from "./report-status.js";
import { executionProfile, upstreamBudget, upstreamBudgetProfile, type ExecutionProfile } from "./protocol-profile.js";
import { prompts } from "./fixtures.js";

export async function prepare(config: string, name: ExecutionProfile = "joint") {
	const profile = executionProfile(name);
	const parent = path.resolve(PREPARED_PARENT); await mkdir(parent, { recursive: true });
	const dir = await mkdtemp(path.join(parent, profile.prefix));
	try {
		const projection = loadConfig(config), fingerprint = sourceManifest();
		const compatibility = await probeCompatibility(projection);
		const design = safeJson(profile.planFile);
		if (name === "tool-none") assert.equal(design.request.prompt, prompts.u1, "E8_DIAGNOSTIC_PROMPT_DRIFT");
		const policy = freezeRequestPolicy(design.policy);
		await buildAssets(dir, projection.workerModel, name);
		const output = path.join(dir, "probe"); await mkdir(output);
		const broker = new PreparedBroker(output, policy, projection.workerModel, "probe", { executionProfile: name, assertFresh: () => {
			assert.equal(loadConfig(config).configSha256, projection.configSha256, "E8_CONFIG_DRIFT_DURING_PREPARE");
		} });
		let report;
		try { const results = await runPreparedBatch(dir, broker); report = name === "tool-none" ? analyzeToolNone(results, broker) : analyzeBatch(results, broker); }
		finally { broker.close(); }
		writeNew(path.join(dir, "probe-report.json"), JSON.stringify({ ...report, compatibility, realModelCalls: 0, networkRequests: 0, credentialResolved: false }, null, 2) + "\n");
		assert.equal(report.mechanicalStatus, "completed", "E8_PROBE_FAILED");
		assert.equal(report.reservations, profile.probeRequests); assert.ok(report.pairs.every(pair => pair.matched));
		assert.equal(batchExitCode(report), 0);
		assert.equal(report.maxConcurrentUpstream, 1); assert.equal(report.remoteDispatchAttempts, 0);
		if (name !== "tool-none") {
			if (name !== "read-upstream") {
				assert.equal(report.independentSeed, true); assert.ok(report.controlScore?.passed && report.systemRecoveryScore?.passed);
				assert.equal(report.seedPreserved, true);
			}
			assert.equal(report.readBudgets.length, 3); assert.ok(report.readBudgets[0].value.metrics.reads.lastContext.reads.sourceCache.hits > 0);
			assert.equal(report.readFinalAnswer?.includes("v2"), true);
			assert.equal("r" in report.businessOutcome && report.businessOutcome.r, "read_freshness_observed");
		}
		verifyFiles(process.cwd(), fingerprint.source, "E8_SOURCE_DRIFT_DURING_PREPARE"); verifyFiles(process.cwd(), fingerprint.dependencies, "E8_DEPENDENCY_DRIFT_DURING_PREPARE");
		const assets: Record<string, string> = {};
		for (const file of (await readdir(path.join(dir, "assets"))).sort()) assets["assets/" + file] = digest(readFileSync(path.join(dir, "assets", file)));
		assets["probe-report.json"] = digest(readFileSync(path.join(dir, "probe-report.json")));
		assets["probe/broker.jsonl"] = digest(readFileSync(path.join(dir, "probe/broker.jsonl")));
		for (const stage of report.stages) assets[stage.resultFile] = digest(readFileSync(path.join(dir, stage.resultFile)));
		const createdAt = Date.now();
		const manifest = { kind: profile.manifestKind, executionProfile: name, liveAllowed: profile.liveAllowed, version: 1, batchDirectory: path.relative(process.cwd(), dir).replaceAll("\\", "/"),
			createdAt, expiresAt: createdAt + 24 * 3600_000, approval: { granted: false, required: true, singleUse: true, unknownCostAcknowledgementRequired: true },
			model: projection.publicProjection, configSha256: projection.configSha256, ...fingerprint, assets, policy,
			toolSchemaHashes: report.toolSchemaHashes, probe: { requestsCaptured: profile.probeRequests, networkRequests: 0, credentialResolved: false, remoteAvailabilityVerified: false, endpointMappingEquivalent: true },
			...(upstreamBudgetProfile(name) ? { upstreamBudget, clientOutputCapEnforced: false, budgetAcceptance: "User requested use of the existing upstream budget; global configuration unchanged" } : {}),
			referencePriceUsdPerMillion: { input: 0.75, output: 3.75, cachedInput: 0.075 }, noCacheReservationReferenceUsd: profile.noCacheReservationReferenceUsd, referenceIsMoneyCap: false, actualCostUsd: null,
			stopping: "Any transport, permission, unknown usage/outcome or frozen-input drift stops the batch. No replay or refund.", scope: "public synthetic fixtures only; no titles, retries, model judges or automatic compaction" };
		const file = path.join(dir, "manifest.json"); writeNew(file, JSON.stringify(manifest, null, 2) + "\n");
		const value = inspectPrepared(file, config);
		return { file, manifestSha256: value.sha256, expiresAt: new Date(manifest.expiresAt).toISOString(), model: manifest.model.id, provider: manifest.model.provider,
			executionProfile: name, liveAllowed: profile.liveAllowed, maxHttpRequests: policy.limits.maxHttpRequests, maxTaskHttpRequests: policy.limits.maxTaskHttpRequests,
			maxInputBytes: policy.limits.maxInputBytes, maxOutputTokens: policy.limits.maxOutputTokens, noCacheReservationReferenceUsd: profile.noCacheReservationReferenceUsd,
			credentialResolved: false, networkRequests: 0, realModelCalls: 0, approvalGranted: false };
	} catch { writeNew(path.join(dir, "prepare-failed.json"), JSON.stringify({ code: "E8_PREPARE_FAILED", realModelCalls: 0, credentialResolved: false }) + "\n"); throw Error("E8_PREPARE_FAILED:" + dir); }
}

async function execute(file: string, config: string, approved: string) {
	const activated = activatePrepared(file, config, approved); // consumes execution before resolving any key
	const key = resolveCredential(activated.projection, process.env);
	const network = await import(pathToFileURL(path.resolve("scripts/pilot-broker-network.mjs")).href);
	const pinnedFetch = network.createPinnedFetch(activated.projection.endpoint, key);
	const output = path.join(activated.dir, "live"); await mkdir(output);
	const policy = freezeRequestPolicy(activated.manifest.policy);
	const broker = new PreparedBroker(output, policy, activated.projection.workerModel, "live", {
		assertFresh: () => { inspectPrepared(file, config, approved); }, toolSchemaHashes: activated.manifest.toolSchemaHashes, authorizationSha256: approved, executionProfile: activated.profile.name,
		fetch: (body, signal) => pinnedFetch(activated.projection.endpoint, { method: "POST", body, signal, redirect: "error" }),
	});
	const timer = setTimeout(() => broker.stop("batch_timeout"), policy.limits.batchTimeoutMs);
	let report;
	try { const results = await runPreparedBatch(activated.dir, broker); report = activated.profile.name === "tool-none" ? analyzeToolNone(results, broker) : analyzeBatch(results, broker); }
	finally { clearTimeout(timer); broker.close(); }
	writeNew(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
	return { report: path.join(output, "report.json"), mechanicalStatus: report.mechanicalStatus, businessOutcome: report.businessOutcome,
		summaryContentReview: report.summaryContentReview, remoteDispatchAttempts: report.remoteDispatchAttempts, actualCostUsd: null, exitCode: batchExitCode(report) };
}

// This module is also imported by the deterministic gate tests.
if (process.env.PI_E8_CLI === "1") {
	const [mode, ...args] = process.argv.slice(2);
	try {
		if (mode === "prepare") { assert.equal(args.length, 1); console.log(JSON.stringify(await prepare(args[0]))); }
		else if (mode === "prepare-tool-none") { assert.equal(args.length, 1); console.log(JSON.stringify(await prepare(args[0], "tool-none"))); }
		else if (mode === "prepare-joint-tool-none") { assert.equal(args.length, 1); console.log(JSON.stringify(await prepare(args[0], "joint-tool-none"))); }
		else if (mode === "prepare-upstream") { assert.equal(args.length, 1); console.log(JSON.stringify(await prepare(args[0], "joint-upstream"))); }
		else if (mode === "prepare-read-upstream") { assert.equal(args.length, 1); console.log(JSON.stringify(await prepare(args[0], "read-upstream"))); }
		else if (mode === "verify") { assert.equal(args.length, 2); const value = inspectPrepared(args[0], args[1]); console.log(JSON.stringify({ valid: true, manifestSha256: value.sha256, approvalConsumed: existsSync(path.join(value.dir, "authorization-consumed.json")), credentialResolved: false, networkRequests: 0 })); }
		else if (mode === "authorize") { assert.equal(args.length, 4); const value = authorizePrepared(args[0], args[1], args[2], args[3] === "--accept-unknown-cost"); console.log(JSON.stringify({ authorized: true, manifestSha256: value.sha256 })); }
		else if (mode === "execute") { assert.equal(args.length, 3); const result = await execute(args[0], args[1], args[2]); console.log(JSON.stringify(result)); process.exitCode = result.exitCode; }
		else if (mode === "recover") { assert.equal(args.length, 1); const recovered = recover(args[0]); console.log(JSON.stringify({ ...recovered, rows: undefined, newHttpRequests: 0 })); }
		else throw Error("E8_MODE_INVALID");
	} catch (error) { console.error(mode.startsWith("prepare") ? (error as Error).message : "E8_" + String(mode).toUpperCase() + "_REJECTED"); process.exitCode = 1; }
}
