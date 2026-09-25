import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { freezeRequestPolicy } from "../../../evals/core/request-policy.js";
import { prepare } from "./prepared-cli.js";
import { activatePrepared, authorizePrepared, inspectPrepared, PREPARED_PARENT, safeJson } from "./prepared-manifest.js";
import { loadConfig, probeCompatibility, projectConfig, resolveCredential } from "./model-projection.js";
import { digest } from "./journal.js";
import { PreparedBroker } from "./prepared-broker.js";
import { analyzeBatch, runPreparedBatch } from "./prepared-run.js";
import { transportTests } from "./prepared-transport-tests.js";
import { finalizeWorkerEvidence } from "./worker-finalization.js";
import { batchExitCode } from "./report-status.js";

const parent = path.resolve(PREPARED_PARENT); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "gate-tests-"));
const config = { providers: { "gemini-proxy": { baseUrl: "https://example.invalid/e8-public/v1", api: "openai-completions", apiKey: "E8_TEST_CREDENTIAL", models: [{ id: "gemini-3.8-flash-high", contextWindow: 262144, maxTokens: 16384, input: ["text"] }] } } };
const configFile = path.join(output, "public-models.json"); await writeFile(configFile, JSON.stringify(config));
const cases: any[] = [];
async function test(id: string, fn: () => Promise<any> | any) {
	try { cases.push({ id, pass: true, ...await fn() }); console.log("PASS " + id); }
	catch (error) { cases.push({ id, pass: false, error: (error as Error).stack }); console.error("FAIL " + id, error); }
}
let prepared: Awaited<ReturnType<typeof prepare>>;
await test("E8P-private-projection-no-credential-resolution", () => {
	const p = loadConfig(configFile); assert.equal(p.publicProjection.configuredMaxTokens, 16384); assert.equal(p.workerModel.maxTokens, 2048);
	const publicText = JSON.stringify(p.publicProjection); assert.ok(!publicText.includes("example.invalid") && !publicText.includes("E8_TEST_CREDENTIAL"));
	for (const value of ["!echo secret", "literal-secret", "NODE_OPTIONS", "PATH"]) {
		const invalid = structuredClone(config); invalid.providers["gemini-proxy"].apiKey = value; assert.throws(() => projectConfig(invalid), /CONFIG_REJECTED/);
	}
	const invalid = structuredClone(config); invalid.providers["gemini-proxy"].baseUrl = "http://example.invalid/v1"; assert.throws(() => projectConfig(invalid), /CONFIG_REJECTED/);
	return { credentialResolved: false };
});
await test("E8P-sdk-endpoint-mapping-zero-network", async () => {
	const result = await probeCompatibility(loadConfig(configFile)); assert.equal(result.samples.length, 2);
	assert.deepEqual(result.toolPolicyProbes.map(p => [p.id, p.toolsFieldPresent, p.toolChoice]), [
		["empty-tools", true, null], ["omitted-tools", false, null], ["omitted-with-tool-history", true, null], ["explicit-none", true, "none"],
	]);
	assert.equal(result.toolPolicyAppliedToWorker, false); assert.equal(result.explicitNoneRemoteSupportVerified, false);
	assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")].attempts, 0); return result;
});
await test("E8P-teardown-faults-preserve-primary-and-partial-evidence", async () => {
	for (const primary of [undefined, "E8_PRIMARY_FAILURE"]) {
		const result: any = { ...(primary ? { failure: primary } : {}) }, calls: string[] = [];
		let ledger = ["before"], captures = 0;
		await finalizeWorkerEvidence(result, {
			settle() { calls.push("settle"); throw Error("do-not-export-raw-error"); },
			evidence: {
				messages() { if (++captures > 1) throw Error("capture failure"); return ["retained-before-shutdown"]; },
				ledgerRecords: () => [...ledger], notices: () => ["retained-notice"], sessionFile: () => "synthetic.jsonl",
			},
			shutdown() { calls.push("shutdown"); ledger.push("shutdown-entry"); throw Error("shutdown failure"); },
			dispose() { calls.push("dispose"); throw Error("dispose failure"); },
			flush() { calls.push("flush"); throw Error("flush failure"); },
		});
		assert.equal(result.failure, primary ?? "E8_WORKER_FINALIZATION_FAILED:settle-before");
		assert.deepEqual(result.messages, ["retained-before-shutdown"]); assert.deepEqual(result.ledgerRecords, ["before", "shutdown-entry"]);
		assert.equal(result.sessionFile, "synthetic.jsonl"); assert.deepEqual(result.notices, ["retained-notice"]);
		assert.deepEqual(calls, ["settle", "shutdown", "settle", "dispose", "flush"]);
		assert.deepEqual(result.finalizationErrors.map((e: any) => e.stage), ["settle-before", "shutdown", "settle-after", "after-shutdown:messages", "dispose", "settings-flush"]);
		assert.ok(!JSON.stringify(result).includes("do-not-export-raw-error"));
	}
	return { primaryFailurePreserved: true, laterCleanupAttempted: true, networkRequests: 0 };
});
await test("E8P-complete-production-zero-network-probe", async () => {
	prepared = await prepare(configFile);
	assert.equal(prepared.networkRequests, 0); assert.equal(prepared.approvalGranted, false);
	const manifest = safeJson(prepared.file); assert.equal(manifest.probe.requestsCaptured, 14); assert.equal(manifest.policy.limits.maxHttpRequests, 24);
	assert.equal(existsSync(path.join(path.dirname(prepared.file), "authorization-consumed.json")), false);
	return { manifest: prepared.file, sha256: prepared.manifestSha256, requestsCaptured: 14, networkRequests: 0 };
});
if (prepared!) {
	const original = await readFile(prepared.file, "utf8"), manifest = JSON.parse(original), dir = path.dirname(prepared.file);
	const claim = path.join(dir, "authorization-consumed.json");
	await test("E8P-stopped-partial-and-failed-reports-exit-nonzero", async () => {
		const report = safeJson(path.join(dir, "probe-report.json"));
		assert.equal(report.summaryContentReview, "pending_review"); assert.equal(batchExitCode(report), 0);
		const base = { mechanicalStatus: report.mechanicalStatus, stopReason: report.stopReason, stages: report.stages.map((s: any) => ({ id: s.id, status: s.status })), businessOutcome: report.businessOutcome };
		const variants = [
			{ ...base, mechanicalStatus: "stopped", stopReason: "tool_permission" },
			{ ...base, stages: base.stages.slice(1) },
			{ ...base, stages: base.stages.map((s: any) => s.id === "r" ? { ...s, status: "not_run" } : s) },
			{ ...base, stages: base.stages.map((s: any) => s.id === "r" ? { ...s, id: "u" } : s) },
			...(["u", "c", "r"] as const).map(id => ({ ...base, businessOutcome: { ...base.businessOutcome, [id]: "failed" } })),
			{},
		];
		const probe = path.join(output, "report-exit.mjs");
		await build({ stdin: { contents: 'import { batchExitCode } from "./tests/harness/review-e-live/report-status.ts"; process.exitCode = batchExitCode(JSON.parse(process.argv[2]));', resolveDir: process.cwd() },
			outfile: probe, bundle: true, platform: "node", format: "esm", logLevel: "warning" });
		for (const [value, expected] of [[base, 0], ...variants.map(value => [value, 1])] as const) {
			assert.equal(batchExitCode(value), expected);
			const child = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href, probe, JSON.stringify(value)],
				{ env: {}, windowsHide: true, encoding: "utf8", timeout: 5000 });
			assert.equal(child.error, undefined); assert.equal(child.status, expected); assert.equal(child.stderr, "");
		}
		return { childExitCases: variants.length + 1, summaryQualityNotAutoAccepted: true, networkRequests: 0 };
	});
	await test("E8P-missing-approval-cost-and-expiry-rejected", () => {
		assert.throws(() => authorizePrepared(prepared.file, configFile, "0".repeat(64), true), /HASH_MISMATCH/);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, false), /COST_ACK/);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true, manifest.createdAt - 1), /EXPIRED_OR_CLOCK/);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true, manifest.expiresAt), /EXPIRED_OR_CLOCK/);
		assert.equal(existsSync(claim), false);
	});
	await test("E8P-selected-config-and-reference-drift", async () => {
		for (const field of ["baseUrl", "apiKey"] as const) {
			const changed = structuredClone(config); changed.providers["gemini-proxy"][field] = field === "baseUrl" ? "https://example.invalid/changed/v1" : "E8_OTHER_REFERENCE";
			await writeFile(configFile, JSON.stringify(changed));
			try { assert.throws(() => inspectPrepared(prepared.file, configFile), /SELECTED_CONFIG_DRIFT/); }
			finally { await writeFile(configFile, JSON.stringify(config)); }
		}
		assert.equal(existsSync(claim), false);
	});
	await test("E8P-source-dependency-asset-and-policy-drift", async () => {
		for (const target of ["source", "dependencies", "assets", "policy"]) {
			const changed = structuredClone(manifest);
			if (target === "policy") changed.policy.limits.maxHttpRequests++;
			else changed[target][Object.keys(changed[target])[0]] = "0".repeat(64);
			await writeFile(prepared.file, JSON.stringify(changed));
			try { assert.throws(() => inspectPrepared(prepared.file, configFile), /DRIFT/); }
			finally { await writeFile(prepared.file, original); }
		}
		assert.equal(existsSync(claim), false);
	});
	await test("E8P-manifest-copy-is-not-a-new-allowance", async () => {
		const copied = await mkdtemp(path.join(parent, "prepared-")); await writeFile(path.join(copied, "manifest.json"), original);
		assert.throws(() => inspectPrepared(path.join(copied, "manifest.json"), configFile, prepared.manifestSha256), /COPY_NOT_AUTHORIZED/);
	});
	await test("E8P-single-use-before-credential-and-no-resume", () => {
		let reads = 0; const environment = new Proxy({}, { get: () => { reads++; return "synthetic-not-a-real-key"; } });
		const checked = authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true);
		assert.equal(reads, 0); assert.equal(existsSync(claim), true);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true), /EEXIST/);
		const activated = activatePrepared(prepared.file, configFile, prepared.manifestSha256);
		assert.equal(resolveCredential(activated.projection, environment), "synthetic-not-a-real-key"); assert.equal(reads, 1);
		assert.throws(() => activatePrepared(prepared.file, configFile, prepared.manifestSha256), /EEXIST/);
		assert.equal(checked.sha256, digest(readFileSync(prepared.file)));
		return { syntheticApprovalOnly: true, remoteRequests: 0, credentialReadAfterConsumption: true };
	});
	await test("E8P-fatal-upstream-stops-following-stages", async () => {
		const target = path.join(output, "simulated-401"); await mkdir(target);
		let sends = 0;
		const broker = new PreparedBroker(target, freezeRequestPolicy(manifest.policy), loadConfig(configFile).workerModel, "live", {
			assertFresh: () => undefined, toolSchemaHashes: manifest.toolSchemaHashes,
			fetch: async () => { sends++; return new Response("not persisted", { status: 401 }); },
		});
		let results; try { results = await runPreparedBatch(dir, broker); } finally { broker.close(); }
		assert.equal(sends, 1); assert.equal(results[0].status, "stopped"); assert.ok(results.slice(1).every(row => row.status === "not_run"));
		assert.ok(results[0].result.sessionFile); assert.ok(Array.isArray(results[0].result.messages));
		assert.ok(results[0].result.ledgerRecords.length > 0); assert.deepEqual(results[0].result.finalizationErrors, []);
		const report = analyzeBatch(results, broker); assert.equal(batchExitCode(report), 1); assert.equal(report.referenceCostUsd, null);
		return { simulatedUpstreamCalls: sends, actualNetworkRequests: 0, noPaidApproval: true };
	});
	await test("E8P-inactive-tool-retains-failure-evidence", async () => {
		const target = path.join(output, "simulated-inactive-tool"); await mkdir(target);
		const model = loadConfig(configFile).workerModel;
		let sends = 0;
		const broker = new PreparedBroker(target, freezeRequestPolicy(manifest.policy), model, "live", {
			assertFresh: () => undefined, toolSchemaHashes: manifest.toolSchemaHashes,
			fetch: async body => {
				sends++; assert.deepEqual(JSON.parse(body).tools, []);
				const frame = (choices: any[], usage?: any) => `data: ${JSON.stringify({ id: "e8-synthetic-undeclared", object: "chat.completion.chunk", created: 1, model: model.id, choices, ...(usage ? { usage } : {}) })}\n\n`;
				return new Response(frame([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "synthetic_list_dir", type: "function", function: { name: "list_dir", arguments: "{}" } }] }, finish_reason: null }])
					+ frame([{ index: 0, delta: {}, finish_reason: "tool_calls" }])
					+ frame([], { prompt_tokens: 798, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 708 } }) + "data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } });
			},
		});
		let results; try { results = await runPreparedBatch(dir, broker); } finally { broker.close(); }
		const report = analyzeBatch(results, broker);
		await writeFile(path.join(target, "report.json"), JSON.stringify({ ...report, syntheticFaultInjection: true,
			realModelCalls: 0, networkRequests: 0, credentialResolvedFromHost: false, providerAvailabilityVerified: false }, null, 2) + "\n");
		assert.equal(sends, 1); assert.equal(report.stopReason, "tool_permission");
		assert.ok(results.slice(1).every(row => row.status === "not_run"));
		const result = results[0].result;
		assert.ok(result.failure); assert.ok(result.sessionFile);
		assert.ok(result.messages.some((m: any) => m.role === "assistant" && m.usage.input === 798 && m.usage.output === 714));
		assert.ok(result.messages.some((m: any) => m.role === "toolResult" && m.toolName === "list_dir" && m.isError));
		assert.ok(result.ledgerRecords.length > 0); assert.ok(result.notices.length > 0);
		assert.deepEqual(result.finalizationErrors, []);
		const durable = (await readFile(result.sessionFile, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
		assert.deepEqual(result.ledgerRecords, durable.filter(row => row.customType === "pi-desktop-transport-ledger/v1").map(row => row.data));
		assert.equal(report.usageCoverage.paired, 1); assert.equal(report.pairs[0].sdkInput, 798);
		assert.equal(report.pairs[0].sdkOutput, 714); assert.equal(report.pairs[0].outputMatched, true);
		assert.deepEqual(report.businessOutcome, { u: "not_completed", c: "not_run", r: "not_run" });
		assert.equal(report.summaryContentReview, "not_run"); assert.equal(report.controlScore, null); assert.equal(report.systemRecoveryScore, null);
		assert.equal(report.readEvidence, null); assert.equal(report.independentSeed, null); assert.equal(batchExitCode(report), 1);
		assert.equal(report.referenceCostUsd, null);
		return { simulatedUpstreamCalls: sends, actualNetworkRequests: 0, noPaidApproval: true, retainedInputPairs: report.usageCoverage.paired };
	});
	await transportTests(output, loadConfig(configFile).workerModel, manifest.policy, test);
}
assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")].attempts, 0);
await writeFile(path.join(output, "summary.json"), JSON.stringify({ cases, failures: cases.filter(row => !row.pass).length, realModelCalls: 0, credentialResolvedFromHost: false, networkRequests: 0 }, null, 2) + "\n");
console.log("E8 preparation evidence: " + output);
assert.equal(cases.filter(row => !row.pass).length, 0);
