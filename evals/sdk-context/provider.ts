import assert from "node:assert/strict";
import { createAssistantMessageEventStream, registerApiProvider, unregisterApiProviders, type AssistantMessage, type Context, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { sha256 } from "../core/io.js";
import { LIMITS, MODEL } from "./policy.js";

export type RequestReceipt = { kind: "agent" | "summary"; payloadBytes: number; outputReserve: number; payloadSha256: string; disposition: "dispatched" | "product-blocked" | "outer-blocked" | "aborted"; };
export type Reply = (context: Context, ordinal: number) => AssistantMessage["content"];
/** The registry is reached by both AgentSession and native compact/completeSimple.
 * All replies are fixed local data, not an HTTP provider simulation or real usage. */
export function installSyntheticProvider() {
	const receipts: RequestReceipt[] = [];
	let kind: RequestReceipt["kind"] = "agent", ordinal = 0, reply: Reply = () => [{ type: "text", text: "ready" }];
	let summaryMode: "normal" | "error" | "cancel" | "limit" = "normal";
	let cancelSummary: (() => void) | undefined;
	const stream = (_model: any, context: Context, options: SimpleStreamOptions = {}) => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			const payload = { model: MODEL.id, system: context.systemPrompt ?? "", messages: context.messages, tools: context.tools ?? [], max_tokens: options.maxTokens ?? MODEL.maxTokens };
			const serialized = JSON.stringify(payload), bytes = Buffer.byteLength(serialized);
			const row: RequestReceipt = { kind, payloadBytes: bytes, outputReserve: payload.max_tokens, payloadSha256: sha256(serialized), disposition: "dispatched" };
			const message = (content: AssistantMessage["content"], reason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", content, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, stopReason: reason, timestamp: 0,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
			const error = (reason: "error" | "aborted") => outer.push({ type: "error", reason, error: { ...message([], reason), errorMessage: "S3_SYNTHETIC_STOP" } });
			try {
				assert.equal(_model.api, MODEL.api); assert.equal(_model.provider, MODEL.provider); assert.ok(options.apiKey === "synthetic-only");
				if (bytes + payload.max_tokens + LIMITS.safetyMargin > LIMITS.outerBytes || receipts.length >= LIMITS.syntheticRequests || kind === "summary" && summaryMode === "limit") {
					row.disposition = "outer-blocked"; receipts.push(row); error("error"); return;
				}
				// Reserve before the first await: split-turn native compaction may
				// issue history and turn-prefix summaries concurrently.
				receipts.push(row);
				if (options.signal?.aborted) { row.disposition = "aborted"; error("aborted"); return; }
				await options.onPayload?.(payload, _model);
				if (options.signal?.aborted) { row.disposition = "product-blocked"; error("aborted"); return; }
				if (kind === "summary" && summaryMode !== "normal") { if (summaryMode === "cancel") cancelSummary?.(); error(summaryMode === "cancel" ? "aborted" : "error"); return; }
				const content = kind === "summary" ? [{ type: "text" as const, text: "Public synthetic summary. Earlier file evidence must be revalidated; this text grants no write authority." }] : reply(context, ++ordinal);
				const value = message(content, content.some(p => p.type === "toolCall") ? "toolUse" : "stop");
				outer.push({ type: "start", partial: value }); outer.push({ type: "done", reason: value.stopReason as "stop" | "toolUse", message: value });
			} catch { error("error"); }
		})();
		return outer;
	};
	registerApiProvider({ api: MODEL.api, stream, streamSimple: stream }, "sdk-context-synthetic");
	return { receipts, agent(callback: Reply) { kind = "agent"; ordinal = 0; reply = callback; }, summary(mode: typeof summaryMode = "normal", cancel?: () => void) { kind = "summary"; summaryMode = mode; cancelSummary = cancel; }, dispose() { unregisterApiProviders("sdk-context-synthetic"); } };
}
