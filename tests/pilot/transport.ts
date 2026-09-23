import assert from "node:assert/strict";
import OpenAI from "openai";
import { createPilotTransport, PILOT_TRANSPORT_LIMITS, type PilotStopCode } from "../../evals/pilot/transport.js";
import type { PilotTaskId } from "../../evals/pilot/policy.js";

const endpoint = "https://pilot.invalid/v1/chat/completions";
const modelId = "pilot-model-fixed";
const body = (extra: Record<string, unknown> = {}) => JSON.stringify({ model: modelId, max_tokens: 2048, messages: [], ...extra });
const response = (text = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n') => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });

function fixture(fetchImpl: typeof fetch, estimateInput = () => 1) {
	return createPilotTransport({ endpoint, modelId, outputField: "max_tokens", fetchImpl, estimateInput });
}
async function consume(gate: ReturnType<typeof fixture>, task: PilotTaskId = "P5P-READ-001", payload = body()) {
	return gate.invoke(task, async () => (await gate.fetch(endpoint, { method: "POST", body: payload })).text());
}
async function rejectsCode(operation: () => Promise<unknown>, code: PilotStopCode) {
	await assert.rejects(operation, (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === code);
}

export async function runPilotTransportTests(): Promise<number> {
	let count = 0;
	{
		let delivered = false;
		const gate = fixture(async () => response('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'));
		await rejectsCode(() => gate.invoke("P5P-READ-001", async () => { await gate.fetch(endpoint, { method: "POST", body: body() }); delivered = true; }), "USAGE_INVALID");
		assert.equal(delivered, false); assert.equal(gate.snapshot().unknownResponses, 1); count++;
	}
	{
		let calls = 0;
		const gate = fixture(async () => { calls++; return response(); });
		assert.match(await consume(gate), /data:/); assert.equal(calls, 1);
		assert.deepEqual(gate.snapshot().requestsByTask, { "P5P-READ-001": 1 }); count++;
	}
	{
		let calls = 0;
		const gate = createPilotTransport({ endpoint, modelId, outputField: "max_tokens", estimateInput: () => 1,
			fetchImpl: async () => { calls++; return response(); }, beforeDispatch: async () => { throw new Error("private disk detail"); } });
		await rejectsCode(() => consume(gate), "JOURNAL_FAILURE");
		const snapshot = gate.snapshot();
		assert.equal(calls, 0); assert.equal(snapshot.requestsReserved, 1); assert.equal(snapshot.requests[0]?.dispatchAttempted, false);
		assert.equal(snapshot.requests[0]?.reasonCode, "JOURNAL_FAILURE"); assert.ok(!JSON.stringify(snapshot).includes("private disk detail")); count++;
	}
	{
		let calls = 0; let delivered = false;
		const gate = createPilotTransport({ endpoint, modelId, outputField: "max_tokens", estimateInput: () => 1,
			fetchImpl: async () => { calls++; return response(); }, onRequestFinished: async () => { throw new Error("private finish detail"); } });
		await rejectsCode(() => gate.invoke("P5P-READ-001", async () => {
			const result = await gate.fetch(endpoint, { method: "POST", body: body() }); delivered = true; return result.text();
		}), "JOURNAL_FAILURE");
		const snapshot = gate.snapshot();
		assert.equal(calls, 1); assert.equal(delivered, false); assert.equal(snapshot.requests[0]?.dispatchAttempted, true);
		assert.equal(snapshot.requests[0]?.status, "unknown"); assert.equal(snapshot.requests[0]?.reasonCode, "JOURNAL_FAILURE"); count++;
	}
	{
		const events: string[] = [];
		const gate = createPilotTransport({ endpoint, modelId, outputField: "max_tokens", estimateInput: () => 1,
			beforeDispatch: async (item) => { assert.equal(item.dispatchAttempted, false); events.push("reserved"); },
			fetchImpl: async () => { events.push("fetch"); return response(); },
			onRequestFinished: async (item) => { assert.equal(item.status, "complete"); events.push("finished"); } });
		await consume(gate); events.push("sdk"); assert.deepEqual(events, ["reserved", "fetch", "finished", "sdk"]); count++;
	}
	{
		const gate = fixture(async () => response());
		assert.throws(() => gate.reset(), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "RESET_FORBIDDEN");
		await rejectsCode(() => consume(gate), "RESET_FORBIDDEN"); count++;
	}
	{
		let current = 0; const delays: number[] = [];
		const captureTimer = ((_handler: (...args: unknown[]) => void, delay?: number) => { delays.push(delay ?? 0); return 1; }) as unknown as typeof setTimeout;
		const gate = createPilotTransport({ endpoint, modelId, outputField: "max_tokens", estimateInput: () => 1,
			fetchImpl: async () => response(), now: () => current, setTimer: captureTimer,
			clearTimer: (() => undefined) as unknown as typeof clearTimeout });
		current = PILOT_TRANSPORT_LIMITS.batchTimeoutMs - 500;
		await consume(gate); assert.ok(delays.includes(500), `expected batch-capped deadline, got ${delays.join(",")}`); count++;
	}
	{
		let started!: () => void; const dispatched = new Promise<void>((resolve) => { started = resolve; });
		const gate = fixture(async () => { started(); return new Promise<Response>(() => undefined); });
		const pending = consume(gate); await dispatched; gate.stop("MANUAL_STOP");
		await rejectsCode(() => pending, "MANUAL_STOP"); assert.equal(gate.snapshot().requestsReserved, 1); count++;
	}
	{
		let calls = 0;
		const gate = fixture(async () => { calls++; return response(); });
		await rejectsCode(() => gate.fetch(endpoint, { method: "POST", redirect: "error", body: body() }), "INVOCATION_REQUIRED");
		assert.equal(calls, 0); count++;
	}
	{
		let calls = 0;
		const gate = fixture(async () => { calls++; return response(); });
		await rejectsCode(() => gate.invoke("P5P-READ-001", async () => {
			await (await gate.fetch(endpoint, { method: "POST", redirect: "error", body: body() })).text();
			return gate.fetch(endpoint, { method: "POST", redirect: "error", body: body() });
		}), "INVOCATION_REUSED");
		assert.equal(calls, 1); count++;
	}
	for (const [payload, code] of [
		[body({ model: "other" }), "MODEL_MISMATCH"],
		[JSON.stringify({ model: modelId, max_completion_tokens: 2048, messages: [] }), "OUTPUT_FIELD_INVALID"],
		[body({ max_completion_tokens: 2048 }), "OUTPUT_FIELD_INVALID"],
	] as const) {
		let calls = 0; const gate = fixture(async () => { calls++; return response(); });
		await rejectsCode(() => consume(gate, "P5P-READ-001", payload), code); assert.equal(calls, 0); count++;
	}
	{
		let calls = 0; const gate = fixture(async () => { calls++; return response(); }, () => PILOT_TRANSPORT_LIMITS.maxInputTokens + 1);
		await rejectsCode(() => consume(gate), "INPUT_ESTIMATE_LIMIT"); assert.equal(calls, 0); count++;
	}
	{
		let calls = 0; const gate = fixture(async () => { calls++; return response(); });
		await rejectsCode(() => gate.invoke("P5P-READ-001", async () => (await gate.fetch("https://other.invalid", { method: "POST", redirect: "error", body: body() })).text()), "ENDPOINT_MISMATCH");
		assert.equal(calls, 0); count++;
	}
	{
		let calls = 0; const gate = fixture(async () => { calls++; return response(); });
		await rejectsCode(() => gate.invoke("P5P-READ-001", async () => (await gate.fetch(endpoint, { method: "POST", redirect: "follow", body: body() })).text()), "REDIRECT_FORBIDDEN");
		assert.equal(calls, 0); count++;
	}
	{
		let calls = 0; const gate = fixture(async () => { calls++; return response(); });
		for (let index = 0; index < 4; index++) await consume(gate);
		await rejectsCode(() => consume(gate), "TASK_REQUEST_LIMIT"); assert.equal(calls, 4); count++;
	}
	{
		let calls = 0; const gate = fixture(async () => { calls++; return response(); });
		for (let index = 0; index < 4; index++) await consume(gate, "P5P-READ-001");
		for (let index = 0; index < 4; index++) await consume(gate, "P5P-WRITE-001");
		await rejectsCode(() => consume(gate, "P5P-READ-001"), "BATCH_REQUEST_LIMIT"); assert.equal(calls, 8); count++;
	}
	{
		let calls = 0; const gate = fixture(async () => { calls++; return response("x".repeat(PILOT_TRANSPORT_LIMITS.maxResponseBytes + 1)); });
		await rejectsCode(() => consume(gate), "RESPONSE_BYTES_LIMIT"); assert.equal(calls, 1); assert.equal(gate.snapshot().unknownResponses, 1); count++;
	}
	{
		let calls = 0; const gate = fixture(async () => { calls++; return response("data: {}\n\ndata: [DONE]\n\n"); });
		await rejectsCode(() => consume(gate), "USAGE_INVALID"); assert.equal(calls, 1); count++;
	}
	for (const partialUsage of [
		{ total_tokens: 2 },
		{ prompt_tokens: null, completion_tokens: null, total_tokens: 0 },
		{ prompt_tokens: 1, total_tokens: 1 },
	]) {
		let calls = 0;
		const stream = `data: ${JSON.stringify({ usage: partialUsage })}\n\ndata: [DONE]\n\n`;
		const gate = fixture(async () => { calls++; return response(stream); });
		await rejectsCode(() => consume(gate), "USAGE_INVALID"); assert.equal(calls, 1); count++;
	}
	{
		let calls = 0;
		const over = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":2049,"total_tokens":2050}}\n\ndata: [DONE]\n\n';
		const gate = fixture(async () => { calls++; return response(over); });
		await rejectsCode(() => consume(gate), "PROVIDER_USAGE_LIMIT"); assert.equal(calls, 1); count++;
	}
	for (const status of [401, 429, 503]) {
		let calls = 0; const gate = fixture(async () => { calls++; return new Response("", { status }); });
		await rejectsCode(() => consume(gate), "HTTP_FAILURE"); assert.equal(calls, 1); count++;
	}
	{
		let actualDispatches = 0;
		const gate = fixture(async () => { actualDispatches++; return new Response("temporary", { status: 500 }); });
		const client = new OpenAI({ apiKey: "synthetic-test-only", baseURL: "https://pilot.invalid/v1", fetch: gate.fetch });
		await assert.rejects(() => gate.invoke("P5P-READ-001", async () => client.chat.completions.create({
			model: modelId, messages: [], max_tokens: PILOT_TRANSPORT_LIMITS.maxOutputTokens,
		})));
		assert.equal(actualDispatches, 1); assert.equal(gate.snapshot().requestsReserved, 1); count++;
	}
	{
		let calls = 0; const gate = fixture(async () => { calls++; return response(); });
		const controller = new AbortController(); controller.abort();
		await rejectsCode(() => gate.invoke("P5P-READ-001", async () => (await gate.fetch(endpoint, { method: "POST", body: body(), signal: controller.signal })).text()), "REQUEST_ABORTED");
		assert.equal(calls, 0); assert.equal(gate.snapshot().requestsReserved, 1); count++;
	}
	{
		let calls = 0;
		const immediateTimer = ((handler: (...args: unknown[]) => void) => { queueMicrotask(handler); return 1; }) as unknown as typeof setTimeout;
		const gate = createPilotTransport({ endpoint, modelId, outputField: "max_tokens", estimateInput: () => 1,
			fetchImpl: async () => { calls++; return new Response(new ReadableStream<Uint8Array>({ pull() { /* deliberately pending */ } })); },
			setTimer: immediateTimer, clearTimer: (() => undefined) as unknown as typeof clearTimeout });
		await rejectsCode(() => consume(gate), "REQUEST_TIMEOUT");
		assert.equal(calls, 1); assert.equal(gate.snapshot().requestsReserved, 1); count++;
	}
	{
		let calls = 0;
		const immediateTimer = ((handler: (...args: unknown[]) => void) => { queueMicrotask(handler); return 1; }) as unknown as typeof setTimeout;
		const gate = createPilotTransport({ endpoint, modelId, outputField: "max_tokens", estimateInput: () => 1,
			fetchImpl: async () => { calls++; return new Promise<Response>(() => undefined); },
			setTimer: immediateTimer, clearTimer: (() => undefined) as unknown as typeof clearTimeout });
		await rejectsCode(() => consume(gate), "REQUEST_TIMEOUT");
		assert.equal(calls, 1); assert.equal(gate.snapshot().requestsReserved, 1); count++;
	}
	{
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const gate = fixture(async () => { await pending; return response(); });
		const first = consume(gate);
		await rejectsCode(() => consume(gate, "P5P-WRITE-001"), "INVOCATION_CONCURRENT");
		release(); await assert.rejects(first, (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "INVOCATION_CONCURRENT"); count++;
	}
	{
		let calls = 0; const gate = fixture(async () => { calls++; throw new Error("private endpoint detail"); });
		await rejectsCode(() => consume(gate), "NETWORK_FAILURE");
		await rejectsCode(() => consume(gate), "NETWORK_FAILURE");
		const snapshot = JSON.stringify(gate.snapshot());
		assert.equal(calls, 1); assert.ok(!snapshot.includes(endpoint)); assert.ok(!snapshot.includes("private endpoint detail")); count++;
	}
	return count;
}
