import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { freezeRequestPolicy } from "../../../evals/core/request-policy.js";
import { prepare } from "./prepared-cli.js";
import { activatePrepared, authorizePrepared, inspectPrepared, PREPARED_PARENT, safeJson } from "./prepared-manifest.js";
import { loadConfig, resolveCredential } from "./model-projection.js";
import { digest, recover } from "./journal.js";
import { PreparedBroker } from "./prepared-broker.js";
import { analyzeToolNone, runPreparedBatch } from "./prepared-run.js";
import { executionProfile } from "./protocol-profile.js";
import { batchExitCode } from "./report-status.js";
import scopeExtension from "./scope-extension.js";
import { prompts } from "./fixtures.js";

const parent = path.resolve(PREPARED_PARENT); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "tool-none-tests-"));
const config = { providers: { "gemini-proxy": { baseUrl: "https://example.invalid/e8-public/v1", api: "openai-completions", apiKey: "E8_TEST_CREDENTIAL", models: [{ id: "gemini-3.8-flash-high", contextWindow: 262144, maxTokens: 16384, input: ["text"] }] } } };
const configFile = path.join(output, "public-models.json"); await writeFile(configFile, JSON.stringify(config));
const projection = loadConfig(configFile), profile = executionProfile("tool-none"), design = safeJson(profile.planFile);
const cases: any[] = [];
async function test(id: string, fn: () => any) {
	try { cases.push({ id, pass: true, ...await fn() }); console.log("PASS " + id); }
	catch (error) { cases.push({ id, pass: false, error: (error as Error).stack }); console.error("FAIL " + id, error); }
}
await test("E8N-plan-single-request-no-tools", () => {
	assert.equal(design.authorization.granted, false); assert.equal(design.executable, false);
	assert.equal(design.request.prompt, prompts.u1); assert.equal(design.request.toolChoice, "none");
	assert.deepEqual(design.safety.activeTools, []); assert.equal(design.safety.successfulToolExecutionsAllowed, 0);
	assert.deepEqual(profile.stages, [{ id: "tool-none", task: "E8-TOOL-NONE" }]);
	const policy = freezeRequestPolicy(design.policy);
	assert.equal(policy.limits.maxHttpRequests, 1); assert.equal(policy.limits.maxTaskHttpRequests, 1);
	assert.equal(policy.limits.maxInputBytes, 8192); assert.equal(policy.limits.maxOutputTokens, 2048);
	assert.equal(profile.noCacheReservationReferenceUsd, (8192 * 0.75 + 2048 * 3.75) / 1_000_000);
	assert.throws(() => executionProfile("unregistered"));
});
await test("E8N-scope-hook-aborts-on-failure", async () => {
	const handlers = new Map<string, any>(), key = Symbol.for("pi.e8.explicitToolNone");
	scopeExtension({ on(name: string, handler: any) { handlers.set(name, handler); } } as any);
	let aborts = 0; const ctx = { abort() { aborts++; } }, event = { payload: { tools: [] } };
	assert.equal(await handlers.get("before_provider_request")(event, ctx), undefined);
	try {
		(globalThis as any)[key] = () => { throw Error("synthetic-policy-fault"); };
		await assert.rejects(async () => handlers.get("before_provider_request")(event, ctx), /synthetic-policy-fault/);
		assert.equal(aborts, 1);
	} finally { delete (globalThis as any)[key]; }
});
let prepared: Awaited<ReturnType<typeof prepare>>;
await test("E8N-full-extension-single-request-prepare", async () => {
	prepared = await prepare(configFile, "tool-none");
	assert.equal(prepared.executionProfile, "tool-none"); assert.equal(prepared.maxHttpRequests, 1);
	assert.equal(prepared.networkRequests, 0); assert.equal(prepared.approvalGranted, false);
	const manifest = safeJson(prepared.file); assert.equal(manifest.kind, profile.manifestKind); assert.equal(manifest.probe.requestsCaptured, 1);
	assert.equal(existsSync(path.join(path.dirname(prepared.file), "authorization-consumed.json")), false);
	return { manifest: prepared.file, sha256: prepared.manifestSha256, networkRequests: 0, realModelCalls: 0 };
});
if (prepared!) {
	const dir = path.dirname(prepared.file), original = await readFile(prepared.file, "utf8"), manifest = JSON.parse(original);
	await test("E8N-only-tool-choice-added-before-production-audit", async () => {
		const report = safeJson(path.join(dir, "probe-report.json")); assert.equal(batchExitCode(report), 0);
		assert.equal(report.ucrAcceptance, "not_run"); assert.equal(report.rootCauseEstablished, false);
		assert.deepEqual(report.businessOutcome, { toolNone: "text_without_tool_call" });
		assert.equal(report.protocolObservation.payloadAdjustments.length, 1);
		const request = recover(path.join(dir, "probe/broker.jsonl")).rows.find(row => row.event === "reserved")!.data;
		const { tool_choice, ...unchanged } = request.body;
		assert.equal(tool_choice, "none"); assert.deepEqual(unchanged.tools, []);
		const adjustment = report.protocolObservation.payloadAdjustments[0];
		assert.equal(adjustment.afterSha256, request.bodySha256); assert.equal(adjustment.beforeSha256, digest(JSON.stringify(unchanged)));
		const result = safeJson(path.join(dir, "probe/worker-tool-none/worker-result.json"));
		assert.equal(result.extensionSha256, digest(readFileSync(path.join(dir, "assets/novel-tools.ts"))));
		assert.deepEqual(result.activeTools, []); assert.deepEqual(result.finalizationErrors, []); assert.equal(result.fetchAttempts.length, 1);
		assert.equal(report.usageCoverage.paired, 1); assert.equal(report.pairs[0].outputMatched, true);
		assert.equal(result.snapshots[0].task.taskId, "E8-TOOL-NONE");
		return { fullProductionExtension: true, payloadChangedKeys: ["tool_choice"], requestsCaptured: 1, nativeUsagePaired: true };
	});
	await test("E8N-approval-cost-expiry-and-config-gates", async () => {
		assert.throws(() => authorizePrepared(prepared.file, configFile, "0".repeat(64), true), /HASH_MISMATCH/);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, false), /COST_ACK/);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true, manifest.expiresAt), /EXPIRED_OR_CLOCK/);
		const changed = structuredClone(config); changed.providers["gemini-proxy"].apiKey = "E8_OTHER_REFERENCE";
		await writeFile(configFile, JSON.stringify(changed));
		try { assert.throws(() => inspectPrepared(prepared.file, configFile), /SELECTED_CONFIG_DRIFT/); }
		finally { await writeFile(configFile, JSON.stringify(config)); }
		assert.equal(existsSync(path.join(dir, "authorization-consumed.json")), false);
	});
	await test("E8N-no-copy-profile-swap-policy-or-asset-drift", async () => {
		const copied = await mkdtemp(path.join(parent, "tool-none-")); await writeFile(path.join(copied, "manifest.json"), original);
		assert.throws(() => inspectPrepared(path.join(copied, "manifest.json"), configFile), /COPY_NOT_AUTHORIZED/);
		for (const field of ["kind", "executionProfile", "policy", "assets"]) {
			const changed = structuredClone(manifest);
			if (field === "kind") changed.kind = executionProfile("joint").manifestKind;
			else if (field === "executionProfile") changed.executionProfile = "joint";
			else if (field === "policy") changed.policy.limits.maxHttpRequests = 2;
			else changed.assets["assets/worker.mjs"] = "0".repeat(64);
			await writeFile(prepared.file, JSON.stringify(changed));
			try { assert.throws(() => inspectPrepared(prepared.file, configFile), /LOCATION|MISMATCH|DRIFT/); }
			finally { await writeFile(prepared.file, original); }
		}
	});
	await test("E8N-synthetic-single-use-before-credential-resolution", () => {
		let reads = 0; const environment = new Proxy({}, { get() { reads++; return "E8_SYNTHETIC_NOT_A_CREDENTIAL"; } });
		authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true); assert.equal(reads, 0);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true), /EEXIST/);
		const activated = activatePrepared(prepared.file, configFile, prepared.manifestSha256);
		resolveCredential(activated.projection, environment); assert.equal(reads, 1);
		assert.throws(() => activatePrepared(prepared.file, configFile, prepared.manifestSha256), /EEXIST/);
		return { syntheticApprovalOnly: true, hostCredentialResolved: false, networkRequests: 0 };
	});
	const frame = (choices: any[], usage?: any) => `data: ${JSON.stringify({ id: "e8-tool-none-synthetic", object: "chat.completion.chunk", created: 1, model: projection.workerModel.id, choices, ...(usage ? { usage } : {}) })}\n\n`;
	const usage = { prompt_tokens: 128, completion_tokens: 32 };
	for (const fault of ["text", "tool-call", "legacy-tool-call", "http-400", "missing-usage", "empty", "truncated"] as const) {
		await test("E8N-full-sdk-" + fault, async () => {
			const target = path.join(output, "response-" + fault); await mkdir(target); let sends = 0;
			const broker = new PreparedBroker(target, freezeRequestPolicy(manifest.policy), projection.workerModel, "live", {
				executionProfile: "tool-none", assertFresh: () => undefined, toolSchemaHashes: manifest.toolSchemaHashes,
				fetch: async body => {
					sends++; const request = JSON.parse(body); assert.equal(request.tool_choice, "none"); assert.deepEqual(request.tools, []);
					if (fault === "http-400") return new Response("synthetic protocol rejection", { status: 400 });
					const delta = fault === "tool-call" ? { tool_calls: [{ index: 0, id: "synthetic_call", type: "function", function: { name: "list_dir", arguments: "{}" } }] }
						: fault === "legacy-tool-call" ? { function_call: { name: "list_dir", arguments: "{}" }, content: "This is not a pure text-only response." }
						: { content: fault === "empty" ? "" : "只读边界已确认。Synthetic reply, not a model result." };
					return new Response(frame([{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }])
						+ frame([{ index: 0, delta: {}, finish_reason: fault === "tool-call" ? "tool_calls" : fault === "truncated" ? "length" : "stop" }])
						+ (fault === "missing-usage" ? "" : frame([], usage)) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
				},
			});
			let results; try { results = await runPreparedBatch(dir, broker); } finally { broker.close(); }
			const report = analyzeToolNone(results, broker);
			await writeFile(path.join(target, "report.json"), JSON.stringify({ ...report, syntheticFaultInjection: true, realModelCalls: 0, networkRequests: 0, providerAvailabilityVerified: false }, null, 2) + "\n");
			assert.equal(sends, 1); assert.equal(results.length, 1); assert.equal(report.reservations, 1);
			assert.equal(report.protocolObservation.successfulToolExecutions, 0); assert.equal(report.rootCauseEstablished, false);
			assert.deepEqual(report.protocolObservation.httpStatuses, [fault === "http-400" ? 400 : 200]);
			assert.equal(batchExitCode(report), fault === "text" ? 0 : 1);
			assert.ok(Array.isArray(results[0].result.messages)); assert.ok(results[0].result.ledgerRecords.length > 0);
			assert.equal(report.referenceCostUsd, null);
			if (fault.endsWith("tool-call")) {
				assert.equal(report.stopReason, "tool_permission"); assert.equal(report.businessOutcome.toolNone, "tool_call_observed");
				assert.equal(report.protocolObservation.rawToolCallDeltas, 1);
			}
			return { simulatedUpstreamCalls: sends, realModelCalls: 0, networkRequests: 0, classification: report.businessOutcome.toolNone, exitCode: batchExitCode(report) };
		});
	}
}

// Unit-only synthetic sidecar: target admission boundaries without an SDK call.
const unitBroker = async (name: string) => {
	const dir = path.join(output, name), work = path.join(dir, "worker"), sessionFile = path.join(work, "agent/sessions/public.jsonl");
	await mkdir(path.join(work, "agent/sessions/.pi-desktop-transport"), { recursive: true }); let sends = 0;
	const broker = new PreparedBroker(dir, freezeRequestPolicy(design.policy), projection.workerModel, "live", { executionProfile: "tool-none", assertFresh: () => undefined,
		fetch: async () => { sends++; return new Response('data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }); } });
	broker.register("worker-tool-none", work, "E8-TOOL-NONE", "tool-none"); const worker = broker.workers.get("worker-tool-none")!;
	const handle = (kind: string, data: any) => (broker as any).handle(worker, kind, data) as Promise<any>;
	await handle("ready", { sessionFile });
	const record = { owner: "synthetic-unit-only", pending: [{ id: 1, kind: "ordinary", supported: true, attempts: [1] }] };
	const productionJournal = path.join(path.dirname(sessionFile), ".pi-desktop-transport/unit.json");
	await writeFile(productionJournal, JSON.stringify({ key: digest(JSON.stringify([path.basename(sessionFile), record.owner])), record: { ...record, sha256: digest(JSON.stringify(record)) } }));
	const payload = { model: projection.workerModel.id, stream: true, messages: [{ role: "user", content: "Public unit; no real request." }], tools: [], tool_choice: "none", stream_options: { include_usage: true }, [projection.publicProjection.outputField]: 2048 };
	const data = { productionJournal, productionCallId: 1, attempt: 1, kind: "ordinary", phase: "tool-none", body: JSON.stringify(payload) };
	return { broker, handle, data, payload, sends: () => sends };
};
await test("E8N-broker-rejects-policy-omission-and-extra-authority", async () => {
	for (const fault of ["missing-none", "auto", "tool-schema", "summary", "wrong-phase", "retry", "large-input", "large-output"]) {
		const t = await unitBroker("admission-" + fault);
		try {
			const data = { ...t.data }, payload: any = { ...t.payload };
			if (fault === "missing-none") delete payload.tool_choice;
			if (fault === "auto") payload.tool_choice = "auto";
			if (fault === "tool-schema") payload.tools = [{ type: "function", function: { name: "list_dir" } }];
			if (fault === "summary") data.kind = "summary";
			if (fault === "wrong-phase") data.phase = "u1";
			if (fault === "retry") data.attempt = 2;
			if (fault === "large-input") payload.messages[0] = { role: "user", content: "x".repeat(8193) };
			if (fault === "large-output") payload[projection.publicProjection.outputField] = 2049;
			data.body = JSON.stringify(payload); await assert.rejects(t.handle("reserve", data));
			assert.equal(t.sends(), 0); assert.equal(t.broker.journal.rows.filter(row => row.event === "reserved").length, 0);
		} finally { t.broker.close(); }
	}
	return { invalidCases: 8, realModelCalls: 0, networkRequests: 0 };
});
await test("E8N-single-request-allowance-no-second-send", async () => {
	const t = await unitBroker("allowance");
	try {
		const permit = await t.handle("reserve", t.data); await t.handle("open", permit); await t.handle("pull", permit);
		await assert.rejects(t.handle("open", permit)); await assert.rejects(t.handle("reserve", t.data));
		assert.equal(t.broker.journal.stopReason, "request_limit"); assert.equal(t.sends(), 1);
		assert.equal(t.broker.journal.rows.filter(row => row.event === "reserved").length, 1);
	} finally { t.broker.close(); }
	return { simulatedUpstreamCalls: 1, realModelCalls: 0, networkRequests: 0, remainingAllowance: 0 };
});
assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")].attempts, 0);
await writeFile(path.join(output, "summary.json"), JSON.stringify({ cases, failures: cases.filter(c => !c.pass).length, realModelCalls: 0, networkRequests: 0, hostCredentialResolved: false }, null, 2) + "\n");
console.log("E8 tool-none evidence: " + output); assert.equal(cases.filter(c => !c.pass).length, 0);
