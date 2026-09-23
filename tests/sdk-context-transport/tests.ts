import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInside, treeManifest } from "../../evals/core/io.js";
import { createBoundedTransport } from "../../evals/core/request-transport.js";
import { createJournalScope } from "../../evals/core/request-journal.js";
import { createContextBroker } from "../../evals/sdk-context-transport/broker.js";
import { ENDPOINT, MODEL, SCENARIOS, TASK_ID, expectedStop, policyFor } from "../../evals/sdk-context-transport/policy.js";
import { recover, validateManifest, validateResult } from "../../evals/sdk-context-transport/records.js";
import { runTransportProbe } from "../../evals/sdk-context-transport/runner.js";
import { syntheticSse } from "../../evals/sdk-context-transport/synthetic.js";

const body = (max = 1638) => JSON.stringify({ model: MODEL.id, max_tokens: max, messages: [{ role: "user", content: "public" }] });
const options = { endpoint: ENDPOINT, modelId: MODEL.id, outputField: "max_tokens" as const, estimateInput: (bytes: Uint8Array) => bytes.byteLength, fetchImpl: async () => syntheticSse() };
const consume = (gate: ReturnType<typeof createBoundedTransport<typeof TASK_ID>>, max = 1638) => gate.invoke(TASK_ID, () => gate.fetch(ENDPOINT, { method: "POST", body: body(max) }));

export async function runTransportTests() {
	const parent = process.env.PI_S3T_WORK_ROOT!, temporary = await mkdtemp(path.join(parent, "tests-"));
	let count = 0;
	const test = async (name: string, run: () => void | Promise<void>) => { try { await run(); count++; } catch (error) { console.error(`S3 transport failed: ${name}`); throw error; } };
	try {
		console.log("S3 transport: shared quota, serialized summary queue, and durable cancellation");
		await test("legacy exact-output default unchanged", async () => {
			const gate = createBoundedTransport(options, policyFor("manual")); await assert.rejects(() => consume(gate)); assert.equal(gate.snapshot().requestsReserved, 0);
			assert.equal(gate.snapshot().stopCode, "OUTPUT_FIELD_INVALID");
		});
		await test("bounded summary output reserves exact serialized field", async () => {
			const gate = createBoundedTransport({ ...options, outputMode: "bounded" }, policyFor("manual")); await consume(gate); await consume(gate, 1024);
			assert.deepEqual(gate.snapshot().requests.map(row => row.outputReserved), [1638, 1024]); assert.equal(gate.snapshot().outputReserved, 2662);
		});
		for (const value of [0, -1, 2049, 1.5, NaN, Infinity]) await test(`invalid output ${value}`, async () => {
			const gate = createBoundedTransport({ ...options, outputMode: "bounded" }, policyFor("manual")); await assert.rejects(() => consume(gate, value)); assert.equal(gate.snapshot().requestsReserved, 0);
		});
		await test("both output fields forbidden", async () => {
			const gate = createBoundedTransport({ ...options, outputMode: "bounded" }, policyFor("manual"));
			await assert.rejects(() => gate.invoke(TASK_ID, () => gate.fetch(ENDPOINT, { method: "POST", body: JSON.stringify({ model: MODEL.id, max_tokens: 1024, max_completion_tokens: 1024 }) })));
			assert.equal(gate.snapshot().requestsReserved, 0);
		});
		await test("aggregate output cap before dispatch", async () => {
			const policy = policyFor("manual"), gate = createBoundedTransport({ ...options, outputMode: "bounded" }, { ...policy, limits: { ...policy.limits, maxTotalOutputTokens: 2050 } });
			await consume(gate, 1024); await consume(gate, 1024); await assert.rejects(() => consume(gate, 1024));
			assert.equal(gate.snapshot().stopCode, "BATCH_OUTPUT_LIMIT"); assert.equal(gate.snapshot().outputReserved, 2048);
		});
		await test("summary usage cannot borrow ordinary output allowance", async () => {
			const gate = createBoundedTransport({ ...options, outputMode: "bounded", fetchImpl: async () => syntheticSse("ready", { completionTokens: 1025 }) }, policyFor("manual"));
			await assert.rejects(() => consume(gate, 1024)); assert.equal(gate.snapshot().stopCode, "PROVIDER_USAGE_LIMIT"); assert.equal(gate.snapshot().requestsReserved, 1);
		});
		for (const cached of [undefined, 0, 60]) await test(`parsed cache retains ${cached}`, async () => {
			const gate = createBoundedTransport({ ...options, outputMode: "bounded", fetchImpl: async () => syntheticSse("ready", { cache: cached }) }, policyFor("manual"));
			await consume(gate); assert.equal(gate.snapshot().requests[0].usage!.cachedTokens, cached ?? null);
		});
		for (const phase of ["reserve", "settle"]) await test(`${phase} persistence failure blocks delivery`, async () => {
			let sent = 0;
			const gate = createBoundedTransport({ ...options, outputMode: "bounded", fetchImpl: async () => { sent++; return syntheticSse(); },
				...(phase === "reserve" ? { beforeDispatch: async () => { throw new Error("private-canary"); } } : { onRequestFinished: async () => { throw new Error("private-canary"); } }) }, policyFor("manual"));
			await assert.rejects(() => consume(gate)); assert.equal(sent, phase === "reserve" ? 0 : 1); assert.equal(gate.snapshot().stopCode, "JOURNAL_FAILURE");
			assert.equal(gate.snapshot().requestsReserved, 1); assert.throws(() => gate.reset());
		});
		await test("same invocation cannot retry at transport", async () => {
			const gate = createBoundedTransport({ ...options, outputMode: "bounded" }, policyFor("manual"));
			await assert.rejects(() => gate.invoke(TASK_ID, async () => { await gate.fetch(ENDPOINT, { method: "POST", body: body() }); await gate.fetch(ENDPOINT, { method: "POST", body: body() }); }));
			assert.equal(gate.snapshot().requestsReserved, 1); assert.equal(gate.snapshot().stopCode, "INVOCATION_REUSED");
		});
		await test("cancel active and queued summary without quota refund", async () => {
			const directory = await mkdtemp(path.join(temporary, "queue-")); let began!: () => void, sent = 0;
			const begun = new Promise<void>(resolve => { began = resolve; });
			const broker = await createContextBroker({ directory, manifestSha256: "a".repeat(64), policy: policyFor("manual"), fetchImpl: async () => { sent++; began(); return new Promise<Response>(() => {}); } });
			const first = broker.submit({ id: 1, kind: "summary", body: body() }); await begun;
			const second = broker.submit({ id: 2, kind: "summary", body: body(1024) });
			const settled = Promise.allSettled([first, second]); broker.stop("REQUEST_ABORTED");
			assert.ok((await settled).every(row => row.status === "rejected")); const journal = await broker.close();
			assert.equal(sent, 1); assert.equal(journal.reserved, 1); assert.equal(journal.unknown, 1); assert.equal(journal.outputReserved, 1638);
			assert.equal(broker.snapshot().maxConcurrentOffers, 2); assert.equal(broker.snapshot().offered, 2); assert.equal(journal.canPass, false);
			await assert.rejects(() => broker.submit({ id: 3, kind: "ordinary", body: body() }));
		});
		await test("queued offers cannot become an unbounded backlog", async () => {
			const directory = await mkdtemp(path.join(temporary, "backlog-"));
			const broker = await createContextBroker({ directory, manifestSha256: "b".repeat(64), policy: policyFor("manual"), fetchImpl: async () => new Promise<Response>(() => {}) });
			const pending = [broker.submit({ id: 1, kind: "summary", body: body() }), broker.submit({ id: 2, kind: "summary", body: body() }), broker.submit({ id: 3, kind: "summary", body: body() })];
			assert.ok((await Promise.allSettled(pending)).every(row => row.status === "rejected")); await broker.close(); assert.equal(broker.snapshot().offered, 2);
		});
		await test("durable crash reserve is unknown and not resumable", async () => {
			const directory = await mkdtemp(path.join(temporary, "crash-")), scope = createJournalScope(policyFor("manual")), sha = "c".repeat(64);
			const journal = await scope.create(directory, sha, "dry-run");
			await journal.reserve({ ordinal: 1, taskId: TASK_ID, invocationId: 1, inputEstimate: 3, inputBytes: 3, outputReserved: 1638, requestSha256: "d".repeat(64) });
			const before = await treeManifest(directory), recovery = await scope.recover(directory, sha);
			assert.equal(recovery.unknown, 1); assert.equal(recovery.pending, 1); assert.equal(recovery.outputReserved, 1638); assert.equal(recovery.canPass, false);
			assert.deepEqual(await treeManifest(directory), before); await assert.rejects(() => scope.create(directory, sha, "dry-run"));
		});
		let normal: Awaited<ReturnType<typeof runTransportProbe>> | undefined;
		for (const scenario of SCENARIOS) {
			console.log(`S3 transport SDK path: ${scenario}`);
			const batch = await runTransportProbe(scenario), a = batch.aggregate;
			await test(`${scenario}: native path contract`, () => { assert.equal(a.contractPassed, true, JSON.stringify(a)); assert.equal(a.stopCode, expectedStop(scenario)); });
			await test(`${scenario}: synthetic accounting never reported actual`, () => { assert.equal(a.realHttpDispatches, 0); assert.equal(a.providerActualUsage, null); assert.equal(a.costUsd, null); assert.equal(a.ordinary.costUsd, null); assert.equal(a.summary.costUsd, null); });
			await test(`${scenario}: all requests share one reservation pool`, () => { assert.equal(a.sharedReserved, a.ordinary.reserved + a.summary.reserved); assert.equal(a.sharedOutputReserved, a.ordinary.outputReserved + a.summary.outputReserved); assert.equal(a.maxConcurrentDispatches, 1); });
			await test(`${scenario}: read-only reconstruction`, async () => { const before = await treeManifest(batch.directory); assert.deepEqual(await recover(batch.directory), a); assert.deepEqual(await treeManifest(batch.directory), before); });
			await test(`${scenario}: no raw text or credential artifacts`, async () => { for (const filename of Object.keys(await treeManifest(batch.directory))) assert.ok(!/private-canary|synthetic-only-not-a-credential|https?:\/\/|S3_TRANSPORT_READY/.test(await readFile(path.join(batch.directory, filename), "utf8"))); });
			if (scenario === "manual") normal = batch;
			if (scenario.startsWith("split")) await test(`${scenario}: true concurrent summary offers`, () => assert.equal(a.maxConcurrentOffers, 2));
			if (scenario === "summary-limit") await test("summary counts against ordinary quota", () => { assert.equal(a.simulatedHttpDispatches, 1); assert.equal(a.summary.reserved, 0); assert.equal(a.requestOutcome, "stopped"); });
			if (scenario === "summary-http-error") await test("implicit SDK fetch retries blocked before IPC and dispatch", () => { assert.ok(a.blockedSdkFetchRetries! > 0); assert.equal(a.summary.reserved, 1); });
			if (["summary-cancel", "summary-timeout", "summary-http-error", "summary-missing-usage"].includes(scenario)) await test(`${scenario}: no continuation and no refund`, () => { assert.equal(a.sharedReserved, 2); assert.equal(a.unknownRequests, 1); assert.equal(a.summary.syntheticParsedUsage.total, null); assert.equal(a.nativeCompactions, 0); });
			console.log(`S3 transport retained ${scenario}: ${path.basename(batch.directory)}`);
		}
		assert.ok(normal);
		const manifest = JSON.parse(await readFile(path.join(normal.directory, "manifest.json"), "utf8"));
		for (const mutate of [(m: any) => m.kind = "live", (m: any) => m.policy.limits.maxHttpRequests++, (m: any) => m.settings.retry.enabled = true,
			(m: any) => m.modelSha256 = "0".repeat(64), (m: any) => m.promptsSha256 = "0".repeat(64), (m: any) => m.rawPrompt = "private-canary", (m: any) => m.code.files["../private"] = "0".repeat(64)]) {
			await test("frozen policy schema mutation", () => { const copy = structuredClone(manifest); mutate(copy); assert.throws(() => validateManifest(copy)); });
		}
		for (const fault of ["missing", "extra", "raw", "binding", "journal", "index"]) await test(`artifact tamper ${fault}`, async () => {
			const folder = await mkdtemp(path.join(temporary, "tamper-")); await cp(normal!.directory, folder, { recursive: true });
			if (fault === "missing") await rm(path.join(folder, "result.json"));
			else if (fault === "extra") await writeFile(path.join(folder, "extra.json"), "{}");
			else await writeFile(path.join(folder, fault === "raw" ? "result.json" : fault === "binding" ? "requests/request-000002.json" : fault === "journal" ? "journal/event-000002.json" : "index.json"), "{}");
			await assert.rejects(() => recover(folder));
		});
		const raw = JSON.parse(await readFile(path.join(normal.directory, "result.json"), "utf8"));
		for (const mutate of [(r: any) => r.worker.receipts[0].id = 3, (r: any) => r.worker.rawText = "private-canary", (r: any) => r.broker.maxConcurrentOffers = 3,
			(r: any) => r.broker.stopCode = "private-canary", (r: any) => r.simulation.summaries = -1]) await test("strict raw validation", () => {
			const copy = structuredClone(raw); mutate(copy); assert.throws(() => validateResult(copy, raw.manifestSha256));
		});
		return count;
	} finally { await assertInside(parent, temporary); await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
}
