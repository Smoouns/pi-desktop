import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { freezeRequestPolicy } from "../../../evals/core/request-policy.js";
import { prepare } from "./prepared-cli.js";
import { activatePrepared, authorizePrepared, inspectPrepared, PREPARED_PARENT, safeJson } from "./prepared-manifest.js";
import { loadConfig } from "./model-projection.js";
import { digest, recover } from "./journal.js";
import { PreparedBroker } from "./prepared-broker.js";
import { analyzeBatch, runPreparedBatch } from "./prepared-run.js";
import { executionProfile, jointExplicitNone } from "./protocol-profile.js";
import { installNoToolsPayloadPolicy } from "./no-tools-provider.js";
import { jointToolPolicyEvidence } from "./joint-tool-policy.js";
import { batchExitCode } from "./report-status.js";
import { syntheticReply } from "./broker.js";
import { allowedTools, SOURCE, source } from "./fixtures.js";

const parent = path.resolve(PREPARED_PARENT); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "joint-tool-none-tests-"));
const config = { providers: { "gemini-proxy": { baseUrl: "https://example.invalid/e8-public/v1", api: "openai-completions", apiKey: "E8_TEST_CREDENTIAL", models: [{ id: "gemini-3.8-flash-high", contextWindow: 262144, maxTokens: 16384, input: ["text"] }] } } };
const configFile = path.join(output, "public-models.json"); await writeFile(configFile, JSON.stringify(config));
const projection = loadConfig(configFile), profile = executionProfile("joint-tool-none"), design = safeJson(profile.planFile);
const cases: any[] = [];
async function test(id: string, fn: () => any) {
	try { cases.push({ id, pass: true, ...await fn() }); console.log("PASS " + id); }
	catch (error) { cases.push({ id, pass: false, error: (error as Error).stack }); console.error("FAIL " + id, error); }
}
await test("E8J-versioned-plan-retains-original-budget-and-stages", () => {
	const original = safeJson(executionProfile("joint").planFile);
	assert.equal(digest(readFileSync(design.baseline.design)), design.baseline.designSha256);
	assert.equal(design.authorization.granted, false); assert.equal(design.executable, false);
	assert.deepEqual(design.policy.limits, original.policy.limits); assert.deepEqual(design.policy.taskIds, original.policy.taskIds);
	assert.notEqual(design.policy.namespace, original.policy.namespace);
	assert.deepEqual(profile.stages, executionProfile("joint").stages);
	assert.equal(profile.noCacheReservationReferenceUsd, (65536 * 0.75 + 2048 * 3.75) * 24 / 1_000_000);
	for (const p of ["joint", "tool-none", "joint-tool-none", undefined]) for (const stage of ["u", "c-control", "c-treatment", "r", "unknown"]) {
		assert.equal(jointExplicitNone(p, stage), p === "joint-tool-none" && ["u", "c-control", "c-treatment"].includes(stage));
	}
});
await test("E8J-provider-decoration-preserves-stream-and-audit-order", async () => {
	for (const method of ["stream", "streamSimple"] as const) for (const summary of [false, true]) {
		const records: any[] = [], events: string[] = [], sentinel = { nativeStream: true };
		let captured: any;
		const delegate = function (this: any, model: any, context: any, options: any) { assert.equal(this, provider); captured = { model, context, options }; return sentinel; };
		const provider = { api: "openai-completions", sourceId: "unchanged", stream: delegate, streamSimple: delegate };
		const model = { api: provider.api }, context = { messages: [], ...(summary ? {} : { tools: [] }) };
		const signal = new AbortController().signal, options = { signal, maxTokens: 2048, onPayload(payload: any) { events.push("production-audit"); assert.equal(payload.tool_choice, "none"); return payload; } };
		installNoToolsPayloadPolicy(provider, () => summary ? "summary" : "u1", row => { records.push(row); events.push("evidence"); });
		assert.equal(provider.sourceId, "unchanged"); assert.equal(provider[method](model, context, options), sentinel);
		assert.equal(captured.context, context); assert.equal(captured.options.signal, signal); assert.equal(captured.options.maxTokens, 2048);
		const payload = { messages: [], ...(summary ? {} : { tools: [] }) }, changed = await captured.options.onPayload(payload, model);
		assert.deepEqual(payload, { messages: [], ...(summary ? {} : { tools: [] }) });
		assert.deepEqual(changed, { ...payload, tool_choice: "none" }); assert.deepEqual(events, ["production-audit", "evidence"]);
		assert.equal(records.length, 1); assert.equal(records[0].beforeSha256, digest(JSON.stringify(payload))); assert.equal(records[0].afterSha256, digest(JSON.stringify(changed)));
	}
});
await test("E8J-provider-rejects-extra-tools-or-payload-drift", async () => {
	for (const fault of ["context-tools", "option-choice", "payload-tools", "payload-choice", "audit-choice-removal", "audit-other-key", "audit-throw"]) {
		let captured: any, recorded = 0;
		const delegate = (_m: any, _c: any, options: any) => { captured = options; return {}; };
		const provider = { api: "openai-completions", stream: delegate, streamSimple: delegate };
		installNoToolsPayloadPolicy(provider, () => "summary", () => recorded++);
		const model = { api: provider.api }, context = { tools: fault === "context-tools" ? [{}] : [] };
		const options = { ...(fault === "option-choice" ? { toolChoice: "auto" } : {}), onPayload(payload: any) {
			if (fault === "audit-choice-removal") delete payload.tool_choice;
			if (fault === "audit-other-key") payload.extra = "not authorized";
			if (fault === "audit-throw") throw Error("synthetic audit failure");
			return payload;
		} };
		if (fault === "context-tools" || fault === "option-choice") assert.throws(() => provider.streamSimple(model, context, options));
		else {
			provider.streamSimple(model, context, options);
			await assert.rejects(captured.onPayload({ tools: fault === "payload-tools" ? [{}] : [], ...(fault === "payload-choice" ? { tool_choice: "auto" } : {}) }, model));
		}
		assert.equal(recorded, 0);
	}
	assert.throws(() => installNoToolsPayloadPolicy({ api: "google-generative-ai" }, () => "u1", () => undefined));
	return { faultCases: 8, networkRequests: 0 };
});
let prepared: Awaited<ReturnType<typeof prepare>>;
await test("E8J-full-extension-14-request-no-network-prepare", async () => {
	prepared = await prepare(configFile, "joint-tool-none");
	assert.equal(prepared.executionProfile, "joint-tool-none"); assert.equal(prepared.maxHttpRequests, 24);
	assert.equal(prepared.networkRequests, 0); assert.equal(prepared.approvalGranted, false);
	const manifest = safeJson(prepared.file); assert.equal(manifest.kind, profile.manifestKind); assert.equal(manifest.probe.requestsCaptured, 14);
	assert.equal(existsSync(path.join(path.dirname(prepared.file), "authorization-consumed.json")), false);
	return { manifest: prepared.file, sha256: prepared.manifestSha256, realModelCalls: 0, networkRequests: 0 };
});
if (prepared!) {
	const dir = path.dirname(prepared.file), original = await readFile(prepared.file, "utf8"), manifest = JSON.parse(original);
	const report = safeJson(path.join(dir, "probe-report.json")), rows = recover(path.join(dir, "probe/broker.jsonl")).rows;
	const results = report.stages.map((stage: any) => ({ ...stage, result: safeJson(path.join(dir, stage.resultFile)) }));
	await test("E8J-six-only-field-adjustments-including-two-native-summaries", async () => {
		assert.equal(batchExitCode(report), 0); assert.equal(report.toolPolicyEvidence.passed, true);
		assert.equal(report.toolPolicyEvidence.noToolsOrdinaryRequests, 4); assert.equal(report.toolPolicyEvidence.noToolsSummaryRequests, 2);
		assert.equal(report.toolPolicyEvidence.readRequests, 8); assert.equal(report.toolPolicyEvidence.readToolsUnchanged, true);
		assert.equal(report.pairs.length, 14); assert.ok(report.pairs.every((p: any) => p.matched && p.outputMatched));
		assert.equal(report.summaryRequestIds.length, 2); assert.equal(report.independentSeed, true); assert.equal(report.seedPreserved, true);
		assert.equal(report.summaryContentReview, "pending_review"); assert.ok(Object.values(report.readEvidence).every(Boolean));
		for (const stage of results) {
			assert.equal(stage.result.extensionSha256, digest(readFileSync(path.join(dir, "assets/novel-tools.ts"))));
			assert.deepEqual(stage.result.finalizationErrors, []); assert.equal(stage.result.network.denied, 0);
			assert.deepEqual(stage.result.activeTools, stage.id === "r" ? allowedTools : []);
			if (stage.id !== "r") assert.equal(await readFile(path.join(dir, "probe/worker-" + stage.id + "/project", SOURCE), "utf8"), source("v1"));
		}
		return { nativeRequestsCaptured: 14, ordinaryNone: 4, summaryNone: 2, rUnchanged: 8, fullProductionExtension: true };
	});
	await test("E8J-evidence-gaps-cannot-report-pass", () => {
		for (const fault of ["choice", "before-hash", "boundary", "raw-tool", "r-choice", "r-adjustment", "partial"]) {
			const r = structuredClone(results), journal = structuredClone(rows);
			const request = journal.find(row => row.event === "reserved")!.data;
			if (fault === "choice") delete request.body.tool_choice;
			if (fault === "before-hash") r[0].result.protocolAdjustments[0].beforeSha256 = "0".repeat(64);
			if (fault === "boundary") r[0].result.protocolAdjustments[0].boundary = "after-reservation";
			if (fault === "raw-tool") journal.find(row => row.event === "terminal")!.data.toolCallDeltas = 1;
			if (fault === "r-choice") journal.find(row => row.event === "reserved" && row.data.worker === "worker-r")!.data.body.tool_choice = "none";
			if (fault === "r-adjustment") r[3].result.protocolAdjustments.push({});
			if (fault === "partial") r[2].status = "not_run";
			const proof = jointToolPolicyEvidence(r, journal); assert.equal(proof.passed, false);
			assert.equal(batchExitCode({ ...report, toolPolicyEvidence: proof }), 1);
		}
		assert.equal(batchExitCode({ ...report, toolPolicyEvidence: undefined }), 1);
		return { invalidEvidenceCases: 8 };
	});
	await test("E8J-new-manifest-isolated-approval-cost-expiry-and-profile", async () => {
		assert.throws(() => authorizePrepared(prepared.file, configFile, "0".repeat(64), true), /HASH_MISMATCH/);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, false), /COST_ACK/);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true, manifest.expiresAt), /EXPIRED_OR_CLOCK/);
		const copied = await mkdtemp(path.join(parent, profile.prefix)); await writeFile(path.join(copied, "manifest.json"), original);
		assert.throws(() => inspectPrepared(path.join(copied, "manifest.json"), configFile), /COPY_NOT_AUTHORIZED/);
		for (const fault of ["profile", "kind", "policy", "asset"]) {
			const changed = structuredClone(manifest);
			if (fault === "profile") changed.executionProfile = "joint";
			if (fault === "kind") changed.kind = executionProfile("joint").manifestKind;
			if (fault === "policy") changed.policy.limits.maxHttpRequests++;
			if (fault === "asset") changed.assets["assets/worker.mjs"] = "0".repeat(64);
			await writeFile(prepared.file, JSON.stringify(changed));
			try { assert.throws(() => inspectPrepared(prepared.file, configFile), /LOCATION|MISMATCH|DRIFT/); }
			finally { await writeFile(prepared.file, original); }
		}
		assert.equal(existsSync(path.join(dir, "authorization-consumed.json")), false);
	});
	await test("E8J-synthetic-approval-single-use-no-credential", () => {
		authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true);
		assert.throws(() => authorizePrepared(prepared.file, configFile, prepared.manifestSha256, true), /EEXIST/);
		activatePrepared(prepared.file, configFile, prepared.manifestSha256);
		assert.throws(() => activatePrepared(prepared.file, configFile, prepared.manifestSha256), /EEXIST/);
		return { syntheticApprovalOnly: true, hostCredentialResolved: false, realModelCalls: 0 };
	});
	const faults = [
		{ id: "u-tool", stage: "u", phase: "u1", style: "tool", sends: 1 },
		{ id: "u-legacy", stage: "u", phase: "u1", style: "legacy", sends: 1 },
		{ id: "control-tool", stage: "c-control", phase: "answer", style: "tool", sends: 3 },
		{ id: "summary-tool", stage: "c-treatment", phase: "summary", style: "tool", sends: 4 },
		{ id: "summary-legacy", stage: "c-treatment", phase: "summary", style: "legacy", sends: 4 },
		{ id: "summary-http-400", stage: "c-treatment", phase: "summary", style: "http", sends: 4 },
		{ id: "treatment-answer-tool", stage: "c-treatment", phase: "answer", style: "tool", sends: 6 },
	];
	for (const fault of faults) await test("E8J-full-sdk-stop-" + fault.id, async () => {
		const target = path.join(output, fault.id); await mkdir(target); let sends = 0; const counts = new Map<string, number>();
		const frame = (choices: any[], usage?: any) => `data: ${JSON.stringify({ id: "synthetic-e8j", object: "chat.completion.chunk", created: 1, model: projection.workerModel.id, choices, ...(usage ? { usage } : {}) })}\n\n`;
		const broker = new PreparedBroker(target, freezeRequestPolicy(manifest.policy), projection.workerModel, "live", {
			executionProfile: "joint-tool-none", assertFresh: () => undefined, toolSchemaHashes: manifest.toolSchemaHashes,
			fetch: async body => {
				sends++; const ticket = [...broker.tickets.values()].find(t => t.body === body && !t.finished)!; assert.ok(ticket);
				const key = ticket.worker.scenario + "/" + ticket.phase, n = (counts.get(key) ?? 0) + 1; counts.set(key, n);
				const injected = ticket.worker.scenario === fault.stage && ticket.phase === fault.phase;
				if (injected && fault.style === "http") return new Response("synthetic field rejection", { status: 400 });
				const delta: any = !injected ? syntheticReply(ticket.worker.scenario, ticket.phase, n)
					: fault.style === "legacy" ? { role: "assistant", content: "Not a pure text response.", function_call: { name: "list_dir", arguments: "{}" } }
					: { role: "assistant", tool_calls: [{ index: 0, id: "forbidden", type: "function", function: { name: "list_dir", arguments: "{}" } }] };
				return new Response(frame([{ index: 0, delta, finish_reason: null }]) + frame([{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }])
					+ frame([], { prompt_tokens: 128, completion_tokens: 32 }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
			},
		});
		let run; try { run = await runPreparedBatch(dir, broker); } finally { broker.close(); }
		const result = analyzeBatch(run, broker);
		await writeFile(path.join(target, "report.json"), JSON.stringify({ ...result, syntheticFaultInjection: true, realModelCalls: 0, networkRequests: 0, providerAvailabilityVerified: false }, null, 2) + "\n");
		assert.equal(sends, fault.sends); assert.equal(batchExitCode(result), 1); assert.equal(result.toolPolicyEvidence?.passed, false);
		assert.equal(result.stopReason, fault.style === "http" ? "http_or_content_type_error" : "tool_permission");
		assert.equal(run.find(s => s.id === "r")!.status, "not_run"); assert.equal(result.businessOutcome.r, "not_run");
		assert.ok(run.filter(s => s.result).every(s => s.result.tools.length === 0 && Array.isArray(s.result.messages) && s.result.ledgerRecords.length > 0));
		return { simulatedUpstreamCalls: sends, realModelCalls: 0, networkRequests: 0, rNotRun: true };
	});

	await test("E8J-broker-rejects-missing-none-and-r-policy-contamination", async () => {
		for (const fault of ["missing-ordinary-none", "missing-summary-none", "summary-tools", "r-none", "r-missing-tools", "extra-tools"]) {
			const target = path.join(output, "admission-" + fault), work = path.join(target, "worker"), sessionFile = path.join(work, "agent/sessions/public.jsonl");
			await mkdir(path.join(work, "agent/sessions/.pi-desktop-transport"), { recursive: true }); let sends = 0;
			const broker = new PreparedBroker(target, freezeRequestPolicy(manifest.policy), projection.workerModel, "live", { executionProfile: "joint-tool-none", assertFresh: () => undefined,
				fetch: async () => { sends++; throw Error("must not send"); } });
			try {
				const summary = fault.includes("summary"), r = fault.startsWith("r-"), scenario = summary ? "c-treatment" : r ? "r" : "u", id = "worker-" + scenario;
				broker.register(id, work, summary ? "E8-C" : r ? "E8-R" : "E8-U", scenario);
				assert.throws(() => broker.register("wrong", work, "E8-U", "unknown"), /STAGE_INVALID/);
				const worker = broker.workers.get(id)!, handle = (kind: string, data: any) => (broker as any).handle(worker, kind, data);
				await handle("ready", { sessionFile });
				const kind = summary ? "summary" : "ordinary", record = { owner: "synthetic-unit-only", pending: [{ id: 1, kind, supported: true, attempts: [1] }] };
				const productionJournal = path.join(path.dirname(sessionFile), ".pi-desktop-transport/unit.json");
				await writeFile(productionJournal, JSON.stringify({ key: digest(JSON.stringify([path.basename(sessionFile), record.owner])), record: { ...record, sha256: digest(JSON.stringify(record)) } }));
				const from = rows.find(row => row.event === "reserved" && row.data.worker === id && row.data.kind === kind)!.data;
				const payload = structuredClone(from.body);
				if (fault.startsWith("missing-")) delete payload.tool_choice;
				if (fault === "summary-tools" || fault === "r-missing-tools") payload.tools = [];
				if (fault === "r-none") payload.tool_choice = "none";
				if (fault === "extra-tools") payload.tools = [{ type: "function", function: { name: "list_dir" } }];
				await assert.rejects(handle("reserve", { productionJournal, productionCallId: 1, attempt: 1, kind, phase: from.phase, body: JSON.stringify(payload) }));
				assert.equal(sends, 0); assert.equal(broker.journal.rows.filter(row => row.event === "reserved").length, 0);
			} finally { broker.close(); }
		}
		return { faultCases: 6, syntheticSidecarUnitOnly: true, realModelCalls: 0 };
	});
}
assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")].attempts, 0);
await writeFile(path.join(output, "summary.json"), JSON.stringify({ cases, failures: cases.filter(c => !c.pass).length, realModelCalls: 0, networkRequests: 0, hostCredentialResolved: false }, null, 2) + "\n");
console.log("E8 joint tool-none evidence: " + output); assert.equal(cases.filter(c => !c.pass).length, 0);
