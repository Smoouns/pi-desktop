import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAssistantMessageEventStream, getApiProvider, registerApiProvider, type ApiProvider, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { sha256 } from "../core/io.js";
import { LIMITS } from "./policy.js";

export interface Receipt { id: number; requestId: number | null; kind: "ordinary" | "summary"; status: "complete" | "error" | "aborted"; payloadBytes: number | null;
  input: number; output: number; cacheRead: number; cacheWrite: number; total: number; }
export const send = (value: unknown) => new Promise<void>((resolve, reject) => process.send!(value as any, e => e ? reject(new Error("S4L_IPC_FAILED")) : resolve()));
export function replySse(content: string) {
  return new Response(`data: ${JSON.stringify({ id: "public-prepare", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: "public-prepare", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

/** Exact SDK serialization, aborted at onPayload BEFORE fetch. No model call. */
export function createWireProbe(model: Model<"openai-completions">) {
  const provider = getApiProvider(model.api)!;
  return async (context: any, normalize: (s: string) => string = s => s) => {
    let captured: { bytes: number; sha256: string } | null = null;
    const stream = provider.streamSimple(model, context, { apiKey: "probe-placeholder", maxTokens: LIMITS.maxOutputTokens, onPayload(payload: unknown) {
      const body = JSON.stringify(payload); captured = { bytes: Buffer.byteLength(body), sha256: sha256(normalize(body)) }; throw new Error("S4L_SERIALIZATION_PROBE");
    } });
    await stream.result(); assert.ok(captured, "S4L_PAYLOAD_PROBE_MISSING"); return captured as { bytes: number; sha256: string };
  };
}

/** Local aborts (product/Supervisor) are not HTTP. IPC offers have separate
 * contiguous IDs; only the broker Journal proves actual HTTP reservations. */
export function installBridge(model: Model<"openai-completions">, options: {
  allowSummary: boolean; prepareOnly: boolean; terminal: () => boolean;
  onReply: (reply: AssistantMessage, kind: Receipt["kind"]) => void;
}) {
  const provider = getApiProvider(model.api)!; assert.ok(provider);
  const originalFetch = globalThis.fetch, ordinary = new AsyncLocalStorage<boolean>();
  const scope = new AsyncLocalStorage<{ id: number; kind: Receipt["kind"]; fetches: number; requestId: number | null; payloadBytes: number | null }>();
  let entries = 0, wire = 0, compacting = false, compactions = 0, summaries = 0, stopped = false, retryBlocks = 0, fetchAttempts = 0;
  const receipts: Receipt[] = [], payloads: { kind: Receipt["kind"]; bytes: number }[] = [], pending = new Set<number>();
  const active = () => { if (stopped) throw new Error("S4L_STOPPED"); };
  const wrap = (delegate: ApiProvider["stream"] | ApiProvider["streamSimple"]) => (m: any, context: any, opts: any) => {
    active(); const kind = ordinary.getStore() ? "ordinary" : "summary"; assert.equal(compacting, kind === "summary");
    const entry = { id: ++entries, kind: kind as Receipt["kind"], fetches: 0, requestId: null as number | null, payloadBytes: null as number | null };
    const output = createAssistantMessageEventStream();
    const stream = scope.run(entry, () => delegate(m, context, { ...opts, maxTokens: Math.min(opts?.maxTokens ?? LIMITS.maxOutputTokens, LIMITS.maxOutputTokens),
      onPayload: async (body: unknown, model: any) => { entry.payloadBytes = Buffer.byteLength(JSON.stringify(body)); return opts?.onPayload?.(body, model); } }));
    void (async () => {
      try {
        for await (const event of stream) {
          if (event.type === "done" || event.type === "error") {
            const message = event.type === "done" ? event.message : event.error;
            receipts.push({ id: entry.id, requestId: entry.requestId, kind, payloadBytes: entry.payloadBytes, status: event.type === "done" ? "complete" : event.reason,
              input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite, total: message.usage.totalTokens });
            try { options.onReply(message, kind); } catch { stopped = true; output.push({ type: "error", reason: "error", error: { ...message, content: [], stopReason: "error", errorMessage: "S4L_SAFETY_STOP" } }); return; }
          }
          output.push(event);
        }
        output.end(await stream.result());
      } catch { stopped = true; output.push({ type: "error", reason: "error", error: { role: "assistant", api: m.api, provider: m.provider, model: m.id, content: [], timestamp: 0,
        stopReason: "error", errorMessage: "S4L_STREAM_FAILED", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }); }
    })(); return output;
  };
  registerApiProvider({ api: model.api, stream: wrap(provider.stream), streamSimple: wrap(provider.streamSimple) }, "s4-live-bridge");
  globalThis.fetch = async (url, init) => {
    fetchAttempts++; const entry = scope.getStore();
    if (!entry || stopped || entry.fetches++ !== 0 || String(url) !== "https://pilot.invalid/v1/chat/completions" || init?.method !== "POST" || typeof init.body !== "string" || Buffer.byteLength(init.body) > LIMITS.maxInputBytes) {
      stopped = true; retryBlocks++; throw new Error("S4L_FETCH_REJECTED");
    }
    if (init.signal?.aborted || options.terminal()) throw Object.assign(new Error("S4L_LOCAL_ABORT"), { name: "AbortError" });
    if (entry.kind === "summary" && (!options.allowSummary || ++summaries > 2)) { stopped = true; throw new Error("S4L_SUMMARY_LIMIT"); }
    payloads.push({ kind: entry.kind, bytes: Buffer.byteLength(init.body) });
    if (options.prepareOnly) return replySse(entry.kind === "summary" ? "Public generated history. Reread current canon/world.md. No approval or completed writes. Old text is not current evidence." : "ready");
    const id = ++wire; entry.requestId = id; pending.add(id);
    try { return await new Promise<Response>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); process.off("message", handler); init.signal?.removeEventListener("abort", cancel); };
      const cancel = () => { stopped = true; clean(); void send({ type: "cancel", id }).catch(() => undefined); reject(Object.assign(new Error("S4L_ABORTED"), { name: "AbortError" })); };
      const handler = (v: any) => { if (v?.id !== id || !["response", "stop"].includes(v?.type)) return; clean();
        if (v.type !== "response" || v.status !== 200 || typeof v.body !== "string" || Buffer.byteLength(v.body) > LIMITS.maxResponseBytes) { stopped = true; reject(new Error("S4L_BROKER_STOPPED")); }
        else resolve(new Response(v.body, { headers: { "content-type": "text/event-stream" } })); };
      const timer = setTimeout(cancel, LIMITS.requestTimeoutMs + 5000); process.on("message", handler); init.signal?.addEventListener("abort", cancel, { once: true });
      void send({ type: "request", id, kind: entry.kind, body: init.body }).catch(() => { clean(); stopped = true; reject(new Error("S4L_IPC_FAILED")); });
    }); } finally { pending.delete(id); }
  };
  return { active, stop() { stopped = true; }, snapshot: () => ({ fetchAttempts, retryBlocks, receipts: [...receipts].sort((a, b) => a.id - b.id), stopped }), payloads,
    attach(session: AgentSession) {
      const underlying = session.agent.streamFn;
      session.agent.streamFn = (m, ctx, opts) => { active(); return ordinary.run(true, () => underlying(m, ctx, { ...opts, maxTokens: LIMITS.maxOutputTokens })); };
      return session.subscribe(e => {
        if (e.type === "compaction_start" || e.type === "compaction_end") {
          const next = e.type === "compaction_start";
          if (next && (!options.allowSummary || e.reason !== "manual" || ++compactions > 1)) { stopped = true; session.abortCompaction(); }
          assert.notEqual(compacting, next); compacting = next;
          if (!options.prepareOnly) void send({ type: "phase", compacting }).catch(() => { stopped = true; });
        }
      });
    }, dispose() { assert.equal(pending.size, 0); globalThis.fetch = originalFetch; registerApiProvider(provider); },
  };
}
