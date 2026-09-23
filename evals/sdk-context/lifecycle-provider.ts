import assert from "node:assert/strict";
import { createAssistantMessageEventStream, registerApiProvider, unregisterApiProviders, type AssistantMessage, type Context, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { sha256 } from "../core/io.js";
import { MODEL } from "./policy.js";
import { LIFE_LIMITS } from "./lifecycle-policy.js";

export type LifeReply = { content?: AssistantMessage["content"]; highUsage?: boolean; overflow?: boolean };
export type LifeReceipt = { kind: "agent" | "summary"; payloadBytes: number; outputReserve: number; payloadSha256: string; disposition: "dispatched" | "product-blocked" | "outer-blocked" | "aborted"; outcome: "complete" | "error" | "aborted" | "overflow" };
/** Synthetic usage is ONLY a trigger input to the real SDK, never reported usage. */
export function installLifecycleProvider() {
	const receipts: LifeReceipt[] = [];
	let kind: LifeReceipt["kind"] = "agent", ordinal = 0, sequence = 0;
	let reply: (context: Context, ordinal: number, sequence: number) => LifeReply = () => ({});
	let summaryMode = "normal", cancel: (() => void) | undefined;
	const stream = (model: any, context: Context, options: SimpleStreamOptions = {}) => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			const requestKind = kind;
			const payload = { model: model.id, system: context.systemPrompt ?? "", messages: context.messages, tools: context.tools ?? [], max_tokens: options.maxTokens ?? model.maxTokens };
			const serialized = JSON.stringify(payload);
			const row: LifeReceipt = { kind: requestKind, payloadBytes: Buffer.byteLength(serialized), outputReserve: payload.max_tokens, payloadSha256: sha256(serialized), disposition: "dispatched", outcome: "error" };
			const message = (value: LifeReply, stopReason: AssistantMessage["stopReason"]): AssistantMessage => {
				const input = value.highUsage ? MODEL.contextWindow - LIFE_LIMITS.reserveTokens + 1 : 1;
				return { role: "assistant", content: value.content ?? [{ type: "text", text: "ready" }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: Date.now(), stopReason,
					usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			};
			const error = (reason: "error" | "aborted", overflow = false) => { row.outcome = overflow ? "overflow" : reason; outer.push({ type: "error", reason, error: { ...message({ content: [] }, reason), errorMessage: overflow ? "context length exceeded" : "S3_SYNTHETIC_SUMMARY_STOP" } }); };
			try {
				assert.equal(model.api, MODEL.api); assert.equal(model.provider, MODEL.provider); assert.equal(options.apiKey, "synthetic-only");
				if (row.payloadBytes + row.outputReserve + 512 > LIFE_LIMITS.outerBytes || receipts.length >= LIFE_LIMITS.requests || requestKind === "summary" && summaryMode === "limit") {
					row.disposition = "outer-blocked"; receipts.push(row); error("error"); return;
				}
				// Native split-turn summaries can be concurrent: reserve before awaiting.
				receipts.push(row);
				if (options.signal?.aborted) { row.disposition = "aborted"; error("aborted"); return; }
				await options.onPayload?.(payload, model);
				if (options.signal?.aborted) { row.disposition = "product-blocked"; error("aborted"); return; }
				if (requestKind === "summary" && summaryMode !== "normal") { if (summaryMode === "cancel") cancel?.(); error(summaryMode === "cancel" ? "aborted" : "error"); return; }
				const value = requestKind === "summary" ? { content: [{ type: "text" as const, text: "Public synthetic summary. Source and operation checkpoints remain authoritative; do not replay unknown writes." }] } : reply(context, ++ordinal, ++sequence);
				// Keep actual response timestamps later than a preceding compaction entry.
				await new Promise(resolve => setTimeout(resolve, 2));
				if (options.signal?.aborted) { error("aborted"); return; }
				if (value.overflow) { error("error", true); return; }
				const result = message(value, value.content?.some(p => p.type === "toolCall") ? "toolUse" : "stop");
				row.outcome = "complete";
				outer.push({ type: "start", partial: result }); outer.push({ type: "done", reason: result.stopReason as "stop" | "toolUse", message: result });
			} catch { error("error"); }
		})();
		return outer;
	};
	registerApiProvider({ api: MODEL.api, stream, streamSimple: stream }, "sdk-lifecycle-synthetic");
	return { receipts,
		agent(callback: typeof reply) { ordinal = 0; reply = callback; },
		event(event: any) { if (event.type === "compaction_start") kind = "summary"; if (event.type === "compaction_end") kind = "agent"; },
		summary(mode: string, abort: () => void) { summaryMode = mode; cancel = abort; },
		dispose() { unregisterApiProviders("sdk-lifecycle-synthetic"); },
	};
}
