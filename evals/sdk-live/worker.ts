import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { treeManifest } from "../core/io.js";
import type { SdkPrepared } from "../sdk-ablation/session.js";
import { LIVE_LIMITS, type LiveRun } from "./policy.js";
import { runLiveSdkSession, type LiveSdkSummary } from "./session.js";
export type SdkLiveWorkerStart = { type: "start"; run: LiveRun; projectRoot: string; agentDir: string; model: Model<"openai-completions">; prepareOnly: boolean; expected: SdkPrepared | null };
export type SdkLiveWorkerResult = { prepared: SdkPrepared; summary: LiveSdkSummary | null; before: Record<string,string>; after: Record<string,string> };
/** No endpoint/key IPC from parent: the SDK uses an inert placeholder, and its
 * HTTP body alone is forwarded to the privileged, metered parent broker. */
export async function runSdkLiveWorker(): Promise<void> {
	assert.equal(process.env.PI_EVAL_WORKER, "1", "PILOT_WORKER_REQUIRED");
	assert.ok(process.send, "PILOT_IPC_REQUIRED");
	assert.equal((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active, true, "PILOT_NETWORK_GUARD_REQUIRED");
	const start = await new Promise<SdkLiveWorkerStart>((resolve) => process.once("message", (value) => resolve(value as SdkLiveWorkerStart)));
	assert.equal(start.type, "start", "PILOT_IPC_START");
	assert.equal(path.resolve(start.agentDir), path.resolve(process.env.PI_CODING_AGENT_DIR!), "PILOT_AGENT_DIR_MISMATCH");
	const scope = new AsyncLocalStorage<{ id: number }>();
	let next = 0, pending = false, stopped = false;
	// A dead broker can neither approve another request nor supervise further tools.
	process.once("disconnect", () => { stopped = true; process.exit(0); });
	const send = (value: unknown) => new Promise<void>((resolve, reject) => process.send!(value as any, (error: Error | null) => error ? reject(new Error("PILOT_IPC_FAILED")) : resolve()));
	globalThis.fetch = async (url, init) => {
		const invocation = scope.getStore();
		if (!invocation || stopped || pending || String(url) !== "https://pilot.invalid/v1/chat/completions" || init?.method !== "POST" || typeof init.body !== "string"
			|| Buffer.byteLength(init.body) > LIVE_LIMITS.maxInputBytes) throw new Error("PILOT_IPC_REQUEST_REJECTED");
		pending = true;
		try {
			const response = await new Promise<{ type: string; invocation: number; status?: number; body?: string }>((resolve, reject) => {
				const timer = setTimeout(() => { stopped = true; cleanup(); reject(new Error("PILOT_IPC_TIMEOUT")); }, LIVE_LIMITS.requestTimeoutMs + 5000);
				const handler = (data: any) => { if (data?.invocation !== invocation.id || !["response", "stop"].includes(data?.type)) return; cleanup(); resolve(data); };
				const cleanup = () => { clearTimeout(timer); process.off("message", handler); };
				process.on("message", handler);
				void send({ type: "request", invocation: invocation.id, body: init.body }).catch(() => { cleanup(); reject(new Error("PILOT_IPC_FAILED")); });
			});
			if (response.type !== "response" || !Number.isInteger(response.status) || response.status! < 200 || response.status! > 299 || typeof response.body !== "string" || Buffer.byteLength(response.body) > LIVE_LIMITS.maxResponseBytes) {
				stopped = true; throw new Error("PILOT_BROKER_STOPPED");
			}
			return new Response(response.body, { status: response.status, headers: { "content-type": "text/event-stream" } });
		} finally { pending = false; }
	};
	const before = await treeManifest(start.projectRoot);
	const result = await runLiveSdkSession({ ...start, bridge: {
		assertActive() { if (stopped) throw new Error("S2_BROKER_STOPPED"); },
		invoke: callback => { if (stopped) throw new Error("S2_BROKER_STOPPED"); return scope.run({ id: ++next }, callback); },
	} });
	await send({ type: "result", value: { ...result, before, after: await treeManifest(start.projectRoot) } satisfies SdkLiveWorkerResult });
	process.disconnect?.();
}
