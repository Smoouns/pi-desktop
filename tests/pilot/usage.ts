import assert from "node:assert/strict";
import { createSseUsageObserver, UsageObservationError } from "../../evals/pilot/usage.js";

const encoder = new TextEncoder();
const errorCode = (code: string) => (error: unknown): boolean =>
	error instanceof UsageObservationError && error.code === code && error.message === code;

function observe(text: string, cuts: number[] = []): ReturnType<ReturnType<typeof createSseUsageObserver>["finish"]> {
	const bytes = encoder.encode(text), observer = createSseUsageObserver();
	let start = 0;
	for (const end of [...cuts, bytes.length]) { observer.feed(bytes.slice(start, end)); start = end; }
	return observer.finish();
}

export async function runPilotUsageTests(): Promise<number> {
	let count = 0;
	const test = (_name: string, action: () => void): void => { action(); count++; };
	test("extracts exact usage without recomputing totals", () => {
		const result = observe("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":4,\"total_tokens\":99,\"prompt_tokens_details\":{\"cached_tokens\":3},\"completion_tokens_details\":{\"reasoning_tokens\":2}}}\r\n\r\ndata: [DONE]\r\n\r\n");
		assert.deepEqual(result, { promptTokens: 9, completionTokens: 4, totalTokens: 99, cachedTokens: 3, reasoningTokens: 2 });
	});
	test("preserves absent fields as null across split multibyte UTF-8 and CRLF", () => {
		const text = "data: {\"label\":\"测\",\"usage\":{\"prompt_tokens\":7}}\r\n\r\ndata: [DONE]\r\n\r\n";
		const encoded = encoder.encode(text), split = encoded.indexOf(0xe6) + 1;
		assert.deepEqual(observe(text, [split, split + 1, encoded.length - 2]), { promptTokens: 7, completionTokens: null, totalTokens: null, cachedTokens: null, reasoningTokens: null });
	});
	test("accepts identical repeated usage", () => {
		const event = "data: {\"usage\":{\"total_tokens\":5}}\n\n";
		assert.equal(observe(event + event + "data: [DONE]\n\n").totalTokens, 5);
	});
	test("skips standard streamed chunks with null usage before final usage", () => {
		const text = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}],\"usage\":null}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n\ndata: [DONE]\n\n";
		assert.deepEqual(observe(text), { promptTokens: 3, completionTokens: 1, totalTokens: 4, cachedTokens: null, reasoningTokens: null });
	});
	test("rejects conflicting repeated usage", () => assert.throws(() => observe("data: {\"usage\":{\"total_tokens\":5}}\n\ndata: {\"usage\":{\"total_tokens\":6}}\n\ndata: [DONE]\n\n"), errorCode("PROVIDER_USAGE_CONFLICT")));
	test("rejects missing usage", () => assert.throws(() => observe("data: {\"choices\":[]}\n\ndata: [DONE]\n\n"), errorCode("PROVIDER_USAGE_MISSING")));
	test("rejects unknown usage field", () => assert.throws(() => observe("data: {\"usage\":{\"total_tokens\":1,\"secret\":2}}\n\ndata: [DONE]\n\n"), errorCode("PROVIDER_USAGE_SCHEMA")));
	test("rejects unknown nested usage field", () => assert.throws(() => observe("data: {\"usage\":{\"prompt_tokens_details\":{\"cached_tokens\":1,\"other\":2}}}\n\ndata: [DONE]\n\n"), errorCode("PROVIDER_USAGE_SCHEMA")));
	test("rejects unsafe and negative counts", () => {
		assert.throws(() => observe("data: {\"usage\":{\"total_tokens\":-1}}\n\ndata: [DONE]\n\n"), errorCode("PROVIDER_USAGE_SCHEMA"));
		assert.throws(() => observe("data: {\"usage\":{\"total_tokens\":9007199254740992}}\n\ndata: [DONE]\n\n"), errorCode("PROVIDER_USAGE_SCHEMA"));
	});
	test("requires DONE and rejects data after DONE", () => {
		assert.throws(() => observe("data: {\"usage\":{\"total_tokens\":1}}\n\n"), errorCode("SSE_DONE_MISSING"));
		assert.throws(() => observe("data: [DONE]\n\ndata: {\"usage\":{\"total_tokens\":1}}\n\n"), errorCode("SSE_DATA_AFTER_DONE"));
	});
	test("enforces byte bound before parsing", () => {
		const observer = createSseUsageObserver({ maxBytes: 4 });
		assert.throws(() => observer.feed(encoder.encode("12345")), errorCode("SSE_RESPONSE_TOO_LARGE"));
	});
	test("rejects invalid UTF-8 and unknown SSE fields", () => {
		const invalid = createSseUsageObserver();
		assert.throws(() => invalid.feed(Uint8Array.from([0xff])), errorCode("SSE_INVALID_UTF8"));
		assert.throws(() => observe("event: message\n\ndata: [DONE]\n\n"), errorCode("SSE_INVALID_FIELD"));
	});
	test("rejects use after finish", () => {
		const observer = createSseUsageObserver();
		observer.feed(encoder.encode("data: {\"usage\":{\"total_tokens\":1}}\n\ndata: [DONE]\n\n"));
		observer.finish();
		assert.throws(() => observer.feed(new Uint8Array()), errorCode("USAGE_OBSERVER_FINISHED"));
	});
	return count;
}
