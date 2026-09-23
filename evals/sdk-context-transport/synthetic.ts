import assert from "node:assert/strict";
import { MODEL, type RequestKind, type Scenario } from "./policy.js";

/** Local SSE responses only. SDK serialization and parsing are NOT replaced. */
export function syntheticSse(text = "ready", options: { missingUsage?: boolean; promptTokens?: number; completionTokens?: number; cache?: number } = {}) {
	const prompt = options.promptTokens ?? 100, completion = options.completionTokens ?? 10;
	const chunk = (choices: unknown[], usage?: unknown) => ({ id: "public-synthetic-s3", object: "chat.completion.chunk", created: 0, model: MODEL.id, choices, ...(usage ? { usage } : {}) });
	const chunks = [chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]), chunk([{ index: 0, delta: {}, finish_reason: "stop" }])];
	if (!options.missingUsage) chunks.push(chunk([], { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
		...(options.cache !== undefined ? { prompt_tokens_details: { cached_tokens: options.cache } } : {}) }));
	return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
export function createSyntheticFetch(scenario: Scenario, currentKind: () => RequestKind, cancelWorker: (kind: RequestKind) => void) {
	let ordinary = 0, summaries = 0, concurrent = 0, highWater = 0;
	const fetchImpl: typeof fetch = async (_input, init) => {
		const body = JSON.parse(init!.body as string), kind = currentKind();
		assert.equal(body.model, MODEL.id); assert.equal(body.stream, true); assert.equal(body.stream_options?.include_usage, true);
		assert.ok(Array.isArray(body.messages) && body.messages.length > 0);
		if (kind === "ordinary") ordinary++; else summaries++;
		concurrent++; highWater = Math.max(highWater, concurrent);
		try {
			if (scenario === `${kind}-cancel` || kind === "summary" && scenario === "summary-timeout") {
				if (scenario.endsWith("cancel")) cancelWorker(kind);
				return await new Promise<Response>((_resolve, reject) => {
					const abort = () => reject(new Error("private-canary-abort"));
					if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
				});
			}
			if (kind === "summary" && scenario === "summary-http-error") return new Response("private-canary-provider-error", { status: 500 });
			// Ensure concurrently-created summaries overlap as offers, while the
			// privileged outlet still has exactly one actual dispatch at a time.
			await new Promise(resolve => setTimeout(resolve, 5));
			return syntheticSse(kind === "summary" ? "Public synthetic summary. Preserve S3_TRANSPORT_READY." : ordinary === 1 && ["split", "split-limit"].includes(scenario) ? "Public current assistant content. ".repeat(40) : "ready", {
				missingUsage: kind === "summary" && scenario === "summary-missing-usage",
				promptTokens: kind === "ordinary" && ordinary === 1 && scenario === "threshold" ? MODEL.contextWindow - 2048 + 1 : 100,
			});
		} finally { concurrent--; }
	};
	return { fetchImpl, snapshot: () => ({ ordinary, summaries, maxConcurrentDispatches: highWater }) };
}
