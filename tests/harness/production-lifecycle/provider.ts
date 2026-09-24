import assert from "node:assert/strict";
import { createAssistantMessageEventStream, registerApiProvider, unregisterApiProviders, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { sha256 } from "../testkit.js";

export const MODEL: Model<"openai-completions"> = {
	id: "production-lifecycle-synthetic", name: "Offline lifecycle fixture", provider: "lifecycle-fixture", api: "openai-completions",
	baseUrl: "https://invalid.example", reasoning: false, input: ["text"], contextWindow: 1_048_576, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export type Reply = (context: Context, ordinal: number, signal?: AbortSignal) => AssistantMessage["content"] | Promise<AssistantMessage["content"]>;
export type RequestReceipt = { kind: "agent" | "summary"; bytes: number; sha256: string; disposition: "synthetic" | "aborted" | "error" };

/** Only the provider is synthetic. SDK context, admission, tools, compaction,
 * persistence and completion hooks are the unmodified production extension. */
export function installProvider() {
	const receipts: RequestReceipt[] = [], errors: string[] = [];
	let kind: RequestReceipt["kind"] = "agent", ordinal = 0, reply: Reply = () => [{ type: "text", text: "离线测试回复。" }];
	const stream = (model: Model<any>, context: Context, options: SimpleStreamOptions = {}) => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			const payload = { model: model.id, system: context.systemPrompt ?? "", messages: context.messages, tools: context.tools ?? [], max_tokens: options.maxTokens ?? model.maxTokens };
			const serialized = JSON.stringify(payload);
			const receipt: RequestReceipt = { kind, bytes: Buffer.byteLength(serialized), sha256: sha256(serialized), disposition: "synthetic" };
			const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
				role: "assistant", content, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, stopReason, timestamp: 1,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			});
			try {
				assert.equal(model.id, MODEL.id); assert.equal(model.provider, MODEL.provider); assert.equal(options.apiKey, "synthetic-only");
				assert.ok(receipts.length < 64 && receipt.bytes < 1_000_000, "OFFLINE_PROVIDER_OUTER_LIMIT");
				receipts.push(receipt);
				options.signal?.throwIfAborted();
				await options.onPayload?.(payload, model); // Exercise the real final-payload preflight.
				options.signal?.throwIfAborted();
				const content = kind === "summary"
					? [{ type: "text" as const, text: "本地合成压缩摘要，仅供会话存档。任务目标和版本凭证以结构化合同为准；此摘要不是 Canon 或写入许可。" }]
					: await reply(context, ++ordinal, options.signal);
				options.signal?.throwIfAborted();
				const value = message(content, content.some(p => p.type === "toolCall") ? "toolUse" : "stop");
				outer.push({ type: "start", partial: value });
				outer.push({ type: "done", reason: value.stopReason as "stop" | "toolUse", message: value });
			} catch (error) {
				const reason = options.signal?.aborted ? "aborted" : "error";
				receipt.disposition = reason;
				if (reason === "error") errors.push(error instanceof Error ? error.message : String(error));
				outer.push({ type: "error", reason, error: { ...message([], reason), errorMessage: "OFFLINE_LIFECYCLE_STOP" } });
			}
		})();
		return outer;
	};
	registerApiProvider({ api: MODEL.api, stream, streamSimple: stream }, "production-lifecycle-test");
	return { receipts, errors, agent(callback: Reply) { kind = "agent"; ordinal = 0; reply = callback; }, summary() { kind = "summary"; }, dispose() { unregisterApiProviders("production-lifecycle-test"); } };
}
