import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAssistantMessageEventStream, getApiProvider, registerApiProvider, type ApiProvider, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { LIMITS } from "./policy.js";

export interface Receipt { id: number; kind: "ordinary" | "summary"; status: "complete" | "error" | "aborted"; input: number; output: number; cacheRead: number; cacheWrite: number; total: number; }
export const send = (value: unknown) => new Promise<void>((resolve, reject) => process.send!(value as any, error => error ? reject(new Error("S3L_IPC_FAILED")) : resolve()));

/** Real SDK serializers/parser, fake auth/sentinel URL in the worker. Both
 * ordinary stream and completeSimple native summaries must use this outlet. */
export function installBridge(model: Model<"openai-completions">, onReply: (reply: AssistantMessage, kind: Receipt["kind"]) => void) {
	const provider = getApiProvider(model.api); assert.ok(provider);
	const originalFetch = globalThis.fetch, ordinary = new AsyncLocalStorage<boolean>(), scope = new AsyncLocalStorage<{ id: number; kind: Receipt["kind"]; fetches: number }>();
	let sequence = 0, compacting = false, stopped = false, fetchAttempts = 0, retryBlocks = 0;
	const receipts: Receipt[] = [], pending = new Set<number>();
	const active = () => { if (stopped) throw new Error("S3L_STOPPED"); };
	const wrap = (delegate: ApiProvider["stream"] | ApiProvider["streamSimple"]) => (requestModel: any, context: any, options: any) => {
		active(); const kind = ordinary.getStore() ? "ordinary" : "summary";
		assert.equal(compacting, kind === "summary"); const request = { id: ++sequence, kind: kind as Receipt["kind"], fetches: 0 }, output = createAssistantMessageEventStream();
		const stream = scope.run(request, () => delegate(requestModel, context, options));
		void (async () => {
			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") {
					const message = event.type === "done" ? event.message : event.error;
					receipts.push({ id: request.id, kind, status: event.type === "done" ? "complete" : event.reason,
						input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite, total: message.usage.totalTokens });
					try { onReply(message, kind); } catch {
						stopped = true; output.push({ type: "error", reason: "error", error: { ...message, content: [], stopReason: "error", errorMessage: "S3L_SAFETY_STOP" } }); return;
					}
				}
				output.push(event);
			}
			output.end(await stream.result());
		})();
		return output;
	};
	registerApiProvider({ api: model.api, stream: wrap(provider.stream), streamSimple: wrap(provider.streamSimple) }, "s3-live-bridge");
	globalThis.fetch = async (url, init) => {
		fetchAttempts++; const request = scope.getStore();
		if (!request || stopped || request.fetches++ !== 0 || String(url) !== "https://pilot.invalid/v1/chat/completions" || init?.method !== "POST" || typeof init.body !== "string" || Buffer.byteLength(init.body) > LIMITS.maxInputBytes) {
			stopped = true; retryBlocks++; throw new Error("S3L_FETCH_REJECTED");
		}
		if (init.signal?.aborted) { stopped = true; throw Object.assign(new Error("S3L_ABORTED"), { name: "AbortError" }); }
		pending.add(request.id);
		try {
			return await new Promise<Response>((resolve, reject) => {
				const clean = () => { clearTimeout(timer); process.off("message", handler); init.signal?.removeEventListener("abort", cancel); };
				const cancel = () => { stopped = true; clean(); void send({ type: "cancel", id: request.id }).catch(() => undefined); reject(Object.assign(new Error("S3L_ABORTED"), { name: "AbortError" })); };
				const handler = (value: any) => {
					if (value?.id !== request.id || !["response", "stop"].includes(value?.type)) return;
					clean();
					if (value.type !== "response" || value.status !== 200 || typeof value.body !== "string" || Buffer.byteLength(value.body) > LIMITS.maxResponseBytes) { stopped = true; reject(new Error("S3L_BROKER_STOPPED")); }
					else resolve(new Response(value.body, { headers: { "content-type": "text/event-stream" } }));
				};
				const timer = setTimeout(cancel, LIMITS.requestTimeoutMs + 5000);
				process.on("message", handler); init.signal?.addEventListener("abort", cancel, { once: true });
				void send({ type: "request", id: request.id, kind: request.kind, body: init.body }).catch(() => { clean(); stopped = true; reject(new Error("S3L_IPC_FAILED")); });
			});
		} finally { pending.delete(request.id); }
	};
	return {
		active, stop() { stopped = true; },
		snapshot: () => ({ fetchAttempts, retryBlocks, receipts: [...receipts].sort((a, b) => a.id - b.id), stopped }),
		attach(session: AgentSession) {
			const underlying = session.agent.streamFn;
			session.agent.streamFn = (requestModel, context, options) => { active(); return ordinary.run(true, () => underlying(requestModel, context, { ...options, maxTokens: LIMITS.maxOutputTokens })); };
			return session.subscribe(event => {
				if (event.type === "compaction_start" || event.type === "compaction_end") {
					const next = event.type === "compaction_start"; assert.notEqual(compacting, next); compacting = next;
					void send({ type: "phase", compacting }).catch(() => { stopped = true; });
				}
			});
		},
		dispose() { assert.equal(pending.size, 0); globalThis.fetch = originalFetch; registerApiProvider(provider); },
	};
}
