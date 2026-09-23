import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInside, digest, sha256, treeManifest } from "../../evals/core/io.js";
import { createContextBroker } from "../../evals/sdk-context-transport/broker.js";
import { createBoundedTransport } from "../../evals/core/request-transport.js";
import { ACK, LIMITS, MODEL, POLICY, RUNS, SIMULATIONS } from "../../evals/sdk-context-live/policy.js";
import { authorize, durableJson, readManifest, validateManifest } from "../../evals/sdk-context-live/manifest.js";
import { journalScope, recover, validateRecord } from "../../evals/sdk-context-live/records.js";
import { evidenceRoot, runDry, runLive } from "../../evals/sdk-context-live/runner.js";

export async function runTests() {
	let count = 0; const temporary = await mkdtemp(path.join(process.env.PI_S3L_WORK_ROOT!, "tests-"));
	const test = async (name: string, fn: () => void | Promise<void>) => { try { await fn(); count++; } catch (error) { console.error(`S3 live tooling failed: ${name}`); throw error; } };
	try {
		console.log("S3 live tooling: shared reservation caps");
		await test("separate reasoning participates in bounded output", async () => {
			const endpoint = "https://pilot.invalid/v1/chat/completions", gate = createBoundedTransport({ endpoint, modelId: MODEL.id, outputField: "max_tokens", outputMode: "bounded", estimateInput: () => 1,
				fetchImpl: async () => new Response('data: {"usage":{"prompt_tokens":1,"completion_tokens":100,"completion_tokens_details":{"reasoning_tokens":925},"total_tokens":1026}}\n\ndata: [DONE]\n\n') }, POLICY);
			await assert.rejects(() => gate.invoke(RUNS[0].runId, async () => (await gate.fetch(endpoint, { method: "POST", body: JSON.stringify({ model: MODEL.id, max_tokens: 1024 }) })).text()));
			assert.equal(gate.snapshot().stopCode, "PROVIDER_USAGE_LIMIT"); assert.equal(gate.snapshot().requests[0].status, "unknown");
		});
		for (const cap of ["task", "batch"] as const) await test(`${cap} shared ordinary and summary quota`, async () => {
			const directory = await mkdtemp(path.join(temporary, "broker-"));
			const broker = await createContextBroker({ directory, manifestSha256: "a".repeat(64), policy: POLICY, route: { endpoint: "https://pilot.invalid/v1/chat/completions", modelId: MODEL.id, outputField: "max_tokens", mode: "dry-run" },
				fetchImpl: async () => new Response('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n') });
			const offer = (i: number) => ({ id: i, kind: (i % 2 ? "ordinary" : "summary") as "ordinary" | "summary", taskId: RUNS[cap === "task" ? 0 : Math.floor((i - 1) / 8)].runId, stage: "seed" as const, body: JSON.stringify({ model: MODEL.id, max_tokens: i % 2 ? 2048 : 1024, messages: [] }) });
			const max = cap === "task" ? LIMITS.maxTaskHttpRequests : LIMITS.maxHttpRequests;
			for (let i = 1; i <= max; i++) await broker.submit(offer(i));
			await assert.rejects(() => broker.submit({ ...offer(1), id: max + 1 }));
			assert.equal(broker.snapshot().transport.stopCode, cap === "task" ? "TASK_REQUEST_LIMIT" : "BATCH_REQUEST_LIMIT");
			const disk = await broker.close(); assert.equal(disk.reserved, max); assert.equal(disk.inputReserved > 0, true); assert.equal(disk.outputReserved, max * 1536);
		});
		console.log("S3 live tooling: actual SDK offline read, compact, independent-process resume");
		const good = await runDry();
		await test("normal tasks pass", () => { assert.equal(good.aggregate.status, "pass"); assert.deepEqual(good.aggregate.rows.map(r => r.status), ["pass", "pass", "pass", "pass"]); assert.equal(good.aggregate.rows[2].durableIntents, 1); assert.equal(good.aggregate.rows[3].durableIntents, 0); assert.equal(good.aggregate.summaries, 2); });
		const { manifest, manifestSha256 } = await readManifest(good.directory);
		await test("read-only deterministic recover", async () => { const before = await treeManifest(good.directory); assert.deepEqual(await recover(good.directory), good.aggregate); assert.deepEqual(await treeManifest(good.directory), before); });
		await test("cache absent and dry-run cost unknown", () => { for (const row of good.aggregate.rows) { assert.equal(row.parsedUsage.cached, null); assert.equal(row.costUsd, null); assert.equal(row.providerActualUsage, null); } });
		await test("authorization before nonexistent private config", async () => { await assert.rejects(() => runLive(good.directory, "nonexistent-private-config", manifestSha256, true), /S3L_DRY_NOT_AUTHORIZABLE/); await assert.rejects(() => runLive(good.directory, "nonexistent-private-config", manifestSha256, false), /S3L_APPROVAL_REQUIRED/); });
		const live = structuredClone(manifest); live.mode = "live"; live.simulation = "none"; live.batchId = "s3-live-synthetic-test";
		const sha = sha256(JSON.stringify(live, null, 2) + "\n"), token = `${sha}\n${ACK}`, now = Date.parse(live.createdAt) + 1;
		await test("exact fresh approval", () => authorize(live, sha, token, now));
		for (const approval of [null, "", manifestSha256, `${manifestSha256}\n${ACK}`, `${sha}\nI authorize at most 24 live HTTP requests`]) await test("old or partial approval rejected", () => assert.throws(() => authorize(live, sha, approval, now)));
		for (const at of [NaN, Date.parse(live.createdAt) - 1, Date.parse(live.expiresAt), Date.parse(live.expiresAt) + 1]) await test("expiry enforced", () => assert.throws(() => authorize(live, sha, token, at)));
		const mutations: Array<(m: any) => void> = [m => m.limits.maxHttpRequests++, m => m.policy.namespace = "sdk-ablation-live-v1", m => m.model.id = "other", m => m.model.maxTokens++, m => m.version.driver = "scripted", m => m.settings.retry.enabled = true, m => m.runs.reverse(), m => m.prompts.resume = "a".repeat(64), m => m.prepared[RUNS[0].runId].single.toolsSha256 = "a".repeat(64), m => m.code.files["../secret"] = "a".repeat(64), m => m.expiresAt = m.createdAt, m => m.rawAnswer = "private-canary"];
		for (const mutate of mutations) await test("strict manifest", () => { const copy = structuredClone(manifest); mutate(copy); assert.throws(() => validateManifest(copy)); });
		const first = JSON.parse(await readFile(path.join(good.directory, `raw/${RUNS[0].runId}.json`), "utf8"));
		for (const mutate of [(r: any) => r.stages = [], (r: any) => r.stages[0].result.pages = 0, (r: any) => r.stages[0].result.bridge.stopped = true, (r: any) => r.stages[0].after.extra = "a".repeat(64), (r: any) => r.stages[0].result.rawReply = "private-canary", (r: any) => r.reasonCode = "TASK_FAILED"]) await test("raw result cannot assert a false pass", () => { const copy = structuredClone(first); mutate(copy); assert.throws(() => validateRecord(copy, manifest, manifestSha256, RUNS[0])); });
		for (const fault of ["raw-missing", "raw-drift", "extra", "binding-drift", "journal-gap"]) await test(fault, async () => {
			const folder = await mkdtemp(path.join(temporary, "tamper-")); await cp(good.directory, folder, { recursive: true });
			if (fault === "raw-missing") await rm(path.join(folder, `raw/${RUNS[0].runId}.json`));
			if (fault === "raw-drift") await writeFile(path.join(folder, `raw/${RUNS[0].runId}.json`), JSON.stringify({ ...first, status: "fail" }));
			if (fault === "extra") await writeFile(path.join(folder, "extra.json"), "{}");
			if (fault === "binding-drift") await writeFile(path.join(folder, "requests/request-000001.json"), "{}");
			if (fault === "journal-gap") await rm(path.join(folder, "journal/event-000001.json"));
			await assert.rejects(() => recover(folder));
		});
		await test("unsealed crash recovery unknown and read-only", async () => {
			const folder = await mkdtemp(path.join(temporary, "crash-")); await durableJson(path.join(folder, "manifest.json"), manifest); const journal = await journalScope.create(path.join(folder, "journal"), manifestSha256, "dry-run");
			await journal.reserve({ ordinal: 1, taskId: RUNS[0].runId, invocationId: 1, inputEstimate: 1, inputBytes: 1, outputReserved: 2048, requestSha256: "c".repeat(64) });
			const before = await treeManifest(folder), aggregate = await recover(folder); assert.equal(aggregate.status, "incomplete"); assert.equal(aggregate.unknownRequests, 1); assert.equal(aggregate.simulatedHttpDispatches, 1); assert.deepEqual(await treeManifest(folder), before);
		});
		for (const fault of ["source", "claimed"] as const) await test(`${fault} denied before auth config`, async () => {
			const folder = await mkdtemp(path.join(evidenceRoot, "s3-live-test-"));
			try {
				const m = structuredClone(live); m.batchId = path.basename(folder);
				if (fault === "source") { m.code.files[Object.keys(m.code.files)[0]] = "0".repeat(64); m.code.sha256 = digest(m.code.files); }
				const h = await durableJson(path.join(folder, "manifest.json"), m); if (fault === "claimed") await durableJson(path.join(folder, "claim.json"), {});
				await assert.rejects(() => runLive(folder, "nonexistent-private-config", h, true), fault === "source" ? /S3L_SOURCE_DRIFT/ : /S3L_ALREADY_CLAIMED/);
			} finally { await assertInside(evidenceRoot, folder); await rm(folder, { recursive: true, force: true }); }
		});
		for (const simulation of SIMULATIONS.filter(s => s !== "none" && s !== "readback")) {
			console.log(`S3 live tooling fault: ${simulation}`); const batch = await runDry(simulation as Exclude<typeof simulation, "none">), a = batch.aggregate;
			await test(`${simulation} no real calls`, () => assert.equal(a.realHttpDispatches, 0));
			await test(`${simulation} outcome`, () => {
				if (simulation === "stale-first") { assert.equal(a.status, "completed-with-failures"); assert.deepEqual(a.rows.map(r => r.status), ["pass", "pass", "pass", "fail"]); assert.equal(a.rows[2].writes, 1); assert.equal(a.rows[2].staleWrites, 0); assert.equal(a.rows[2].durableGateBlocks, 1); assert.equal(a.rows[3].writes, 2); assert.equal(a.rows[3].staleWrites, 1); }
				else if (simulation === "answer-format") { assert.equal(a.status, "completed-with-failures"); assert.deepEqual(a.rows.map(r => r.status), ["fail", "pass", "pass", "pass"]); }
				else if (simulation === "wrong-page") { assert.equal(a.status, "completed-with-failures"); assert.deepEqual(a.rows.map(r => r.status), ["fail", "fail", "pass", "pass"]); }
				else if (simulation === "reasoning-cache") { assert.equal(a.status, "pass"); for (const r of a.rows) { assert.equal(r.parsedUsage.cached, r.requests * 25); assert.equal(r.parsedUsage.reasoning, r.requests * 20); assert.equal(r.sdkUsage.total, r.requests * 130); assert.equal(r.parsedUsage.total, r.requests * 110); assert.equal(r.costUsd, null); } }
				else { assert.equal(a.status, "incomplete"); assert.deepEqual(a.rows.map(r => r.status), simulation.startsWith("summary-") ? ["pass", "pass", "unknown", "blocked"] : ["unknown", "blocked", "blocked", "blocked"]); }
			});
			await test(`${simulation} readback`, async () => { const before = await treeManifest(batch.directory); assert.deepEqual(await recover(batch.directory), a); assert.deepEqual(await treeManifest(batch.directory), before); });
			await test(`${simulation} no sensitive retained data`, async () => { for (const file of Object.keys(await treeManifest(batch.directory))) assert.ok(!/https?:\/\/|private-canary|broker-placeholder-not-a-key/.test(await readFile(path.join(batch.directory, file), "utf8"))); });
			console.log(`S3 live retained ${simulation}: ${path.basename(batch.directory)}`);
		}
		console.log(`S3 live retained readback: ${path.basename(good.directory)}`); return count;
	} finally { await assertInside(process.env.PI_S3L_WORK_ROOT!, temporary); await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
}
