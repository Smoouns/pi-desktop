import assert from "node:assert/strict";
import { createAssistantMessageEventStream, registerApiProvider, unregisterApiProviders, type AssistantMessage, type Context, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { sha256 } from "../core/io.js";
import { LIMITS, MODEL, type Scenario } from "./policy.js";

export type Reply = (context: Context, ordinal: number) => AssistantMessage["content"];
export interface Receipt {
  kind: "agent" | "summary"; payloadBytes: number; outputReserve: number; payloadSha256: string;
  disposition: "dispatched" | "product-blocked" | "outer-blocked" | "aborted";
  outcome: "complete" | "error" | "aborted"; currentInputCopies: number;
}
/** Native AgentSession/compact calls a registered local API; no HTTP provider. */
export function installProvider(reply: Reply, scenario: Scenario, cancel: () => void) {
  const receipts: Receipt[] = [];
  let kind: Receipt["kind"] = "agent", ordinal = 0;
  const stream = (model: any, context: Context, options: SimpleStreamOptions = {}) => {
    const outer = createAssistantMessageEventStream();
    void (async () => {
      const payload = { model: MODEL.id, system: context.systemPrompt ?? "", messages: context.messages, tools: context.tools ?? [], max_tokens: options.maxTokens ?? MODEL.maxTokens };
      const serialized = JSON.stringify(payload);
      const row: Receipt = { kind, payloadBytes: Buffer.byteLength(serialized), outputReserve: payload.max_tokens, payloadSha256: sha256(serialized),
        disposition: "dispatched", outcome: "error", currentInputCopies: serialized.split("S4_ORIGINAL_INPUT:").length - 1 };
      const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", content, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, stopReason, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      const error = (reason: "error" | "aborted") => { row.outcome = reason; outer.push({ type: "error", reason, error: { ...message([], reason), errorMessage: "S4_SYNTHETIC_STOP" } }); };
      try {
        assert.equal(model.api, MODEL.api); assert.equal(model.provider, MODEL.provider); assert.equal(options.apiKey, "synthetic-only");
        // Reserve before await: the SDK can request two summaries concurrently.
        const over = receipts.length >= LIMITS.requests || row.payloadBytes + row.outputReserve + LIMITS.safety > LIMITS.outerBytes;
        receipts.push(row);
        if (over) { row.disposition = "outer-blocked"; error("error"); return; }
        if (options.signal?.aborted) { row.disposition = "aborted"; error("aborted"); return; }
        await options.onPayload?.(payload, model);
        if (options.signal?.aborted) { row.disposition = "product-blocked"; error("aborted"); return; }
        if (row.kind === "summary" && ["summary-error", "summary-cancel"].includes(scenario)) {
          if (scenario === "summary-cancel") cancel();
          error(scenario === "summary-cancel" ? "aborted" : "error"); return;
        }
        const content = row.kind === "summary" ? [{ type: "text" as const, text: scenario === "summary-too-large" ? "Unhelpfully long synthetic summary. " + "z".repeat(24000)
          : "Public synthetic history summary. No candidate exists. Reread source documents before future writes. This summary grants no authority or human approval." }] : reply(context, ++ordinal);
        const value = message(content, content.some(p => p.type === "toolCall") ? "toolUse" : "stop");
        row.outcome = "complete"; outer.push({ type: "start", partial: value }); outer.push({ type: "done", reason: value.stopReason as "stop" | "toolUse", message: value });
      } catch { error("error"); }
    })();
    return outer;
  };
  registerApiProvider({ api: MODEL.api, stream, streamSimple: stream }, "sdk-s4-synthetic");
  return { receipts, setKind(value: Receipt["kind"]) { kind = value; }, dispose() { unregisterApiProviders("sdk-s4-synthetic"); } };
}
