import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream, getApiProvider, registerApiProvider, type AssistantMessage, type AssistantMessageEventStream, type ApiProvider } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry, createAgentSession, SessionManager, SettingsManager, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import { CONTINUE, ENDPOINT, LIMITS, MODEL, PROMPT, SCENARIOS, SEED_ASSISTANT, SEED_USER, SYSTEM, settingsFor, type RequestKind, type Scenario } from "./policy.js";

export interface SdkReceipt { id: number; kind: RequestKind; status: "complete" | "error" | "aborted"; input: number; output: number; total: number; }
export interface WorkerResult {
	settings: boolean; zeroNetwork: boolean; toolCount: number; ordinaryHooks: number; fetchAttempts: number; blockedFetches: number;
	manualCompactions: number; automaticStarts: number; automaticEnds: number; nativeCompactions: number; fromHook: boolean;
	continued: boolean; summaryFailed: boolean; receipts: SdkReceipt[];
}
export interface WorkerStart { type: "start"; scenario: Scenario; work: string; }
const send = (value: unknown) => new Promise<void>((resolve, reject) => process.send!(value as any, error => error ? reject(new Error("S3T_IPC_FAILURE")) : resolve()));
const aborted = () => Object.assign(new Error("S3T_ABORTED"), { name: "AbortError" });

/** Tests the actual provider registry path, including completeSimple() called by
 * SDK compaction. No script-chosen replacement API or normal-agent-only meter. */
export async function contextTransportWorker() {
	assert.equal(process.env.PI_EVAL_WORKER, "1"); assert.ok(process.send);
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")]; assert.ok(guard?.active);
	const start = await new Promise<WorkerStart>(resolve => process.once("message", value => resolve(value as WorkerStart)));
	assert.equal(start.type, "start"); assert.ok(SCENARIOS.includes(start.scenario));
	const project = path.join(start.work, "project"), agentDir = path.join(start.work, "agent");
	assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR!), path.resolve(agentDir));
	const attempts = guard.attempts, phase = { compacting: false };
	const ordinaryScope = new AsyncLocalStorage<boolean>();
	const requestScope = new AsyncLocalStorage<{ id: number; kind: RequestKind; fetches: number }>();
	let next = 0, stopped = false, ordinaryHooks = 0, fetchAttempts = 0, blockedFetches = 0, manualCompactions = 0, automaticStarts = 0, automaticEnds = 0, continued = false, summaryFailed = false;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const receipts: SdkReceipt[] = [];
	const underlying = getApiProvider(MODEL.api); assert.ok(underlying);
	const originalFetch = globalThis.fetch;
	const pending = new Set<number>();
	const setPhase = (value: boolean) => {
		assert.notEqual(phase.compacting, value, "S3T_PHASE_DUPLICATE"); phase.compacting = value;
		void send({ type: "phase", compacting: value }).catch(() => { stopped = true; });
	};
	const wrap = (delegate: ApiProvider["stream"] | ApiProvider["streamSimple"]) => (model: any, context: any, options: any): AssistantMessageEventStream => {
		const kind: RequestKind = ordinaryScope.getStore() ? "ordinary" : "summary";
		assert.ok(!stopped && (kind === "summary" ? phase.compacting : !phase.compacting), "S3T_UNSCOPED_PROVIDER");
		const scope = { id: ++next, kind, fetches: 0 }, output = createAssistantMessageEventStream();
		const stream = requestScope.run(scope, () => delegate(model, context, options));
		void (async () => {
			for await (const event of stream) {
				// Record before delivering the terminal event; the consumer may start
				// another turn or send its final IPC result as soon as it sees it.
				if (event.type === "done" || event.type === "error") {
					const result = event.type === "done" ? event.message : event.error;
					receipts.push({ id: scope.id, kind, status: result.stopReason === "error" ? "error" : result.stopReason === "aborted" ? "aborted" : "complete",
						input: result.usage.input, output: result.usage.output, total: result.usage.totalTokens });
				}
				output.push(event);
			}
			const result = await stream.result();
			output.end(result);
		})();
		return output;
	};
	registerApiProvider({ api: MODEL.api, stream: wrap(underlying.stream), streamSimple: wrap(underlying.streamSimple) }, "s3-transport-wrapper");
	globalThis.fetch = async (url, init) => {
		fetchAttempts++;
		const request = requestScope.getStore();
		if (!request || stopped || request.fetches++ !== 0 || String(url) !== ENDPOINT || init?.method !== "POST" || typeof init.body !== "string"
			|| Buffer.byteLength(init.body) > LIMITS.maxInputBytes) { stopped = true; blockedFetches++; throw new Error("S3T_FETCH_REJECTED"); }
		if (init.signal?.aborted) throw aborted();
		pending.add(request.id);
		try {
			return await new Promise<Response>((resolve, reject) => {
				const cleanup = () => { clearTimeout(timer); process.off("message", handler); init.signal?.removeEventListener("abort", cancel); };
				const cancel = () => { stopped = true; cleanup(); void send({ type: "cancel", id: request.id }).catch(() => undefined); reject(aborted()); };
				const handler = (value: any) => {
					if (value?.id !== request.id || !["response", "stop"].includes(value?.type)) return;
					cleanup();
					if (value.type === "stop" || !Number.isInteger(value.status) || value.status !== 200 || typeof value.body !== "string" || Buffer.byteLength(value.body) > LIMITS.maxResponseBytes) {
						stopped = true; reject(new Error("S3T_BROKER_STOPPED"));
					} else resolve(new Response(value.body, { status: value.status, headers: { "content-type": "text/event-stream" } }));
				};
				const timer = setTimeout(cancel, LIMITS.requestTimeoutMs + 2000);
				process.on("message", handler); init.signal?.addEventListener("abort", cancel, { once: true });
				void send({ type: "request", id: request.id, kind: request.kind, body: init.body }).catch(() => { cleanup(); stopped = true; reject(new Error("S3T_IPC_FAILURE")); });
			});
		} finally { pending.delete(request.id); }
	};
	const cancelHandler = (value: any) => {
		if (value?.type !== "cancel-fixture") return;
		if (value.kind === "summary") session?.abortCompaction(); else void session?.abort();
	};
	process.on("message", cancelHandler);
	process.once("disconnect", () => { stopped = true; process.exit(0); });
	try {
		await mkdir(path.join(project, ".pi"), { recursive: true }); await mkdir(agentDir, { recursive: true });
		const settingsText = JSON.stringify(settingsFor(start.scenario)) + "\n";
		for (const file of [path.join(agentDir, "settings.json"), path.join(project, ".pi/settings.json")]) await writeFile(file, settingsText, { flag: "wx" });
		const settings = SettingsManager.create(project, agentDir); await settings.flush(); settings.reload();
		const manager = SessionManager.create(project, path.join(agentDir, "sessions"));
		manager.appendMessage({ role: "user", content: SEED_USER, timestamp: 0 });
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: SEED_ASSISTANT }], api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: 0, stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage);
		const resources: ResourceLoader = { getExtensions: () => ({ extensions: [], errors: [], runtime: {} as any }), getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => SYSTEM, getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
		const auth = AuthStorage.inMemory({ [MODEL.provider]: { type: "api_key", key: "synthetic-only-not-a-credential" } });
		({ session } = await createAgentSession({ cwd: project, agentDir, authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "disabled-models.json")), model: MODEL,
			thinkingLevel: "off", tools: [], settingsManager: settings, resourceLoader: resources, sessionManager: manager }));
		const originalStream = session.agent.streamFn;
		session.agent.streamFn = (model, context, options) => { ordinaryHooks++; return ordinaryScope.run(true, () => originalStream(model, context, { ...options, maxTokens: LIMITS.maxOutputTokens })); };
		session.subscribe(event => {
			if (event.type === "compaction_start") { if (event.reason !== "manual") automaticStarts++; setPhase(true); }
			if (event.type === "compaction_end") { if (event.reason !== "manual") automaticEnds++; if (!event.result) summaryFailed = true; setPhase(false); }
		});
		await session.prompt(PROMPT); await (session as any)._agentEventQueue;
		if (!stopped && start.scenario !== "threshold") {
			manualCompactions++;
			try { await session.compact(); } catch { summaryFailed = true; }
		}
		if (!stopped && !summaryFailed) {
			await session.prompt(CONTINUE); await (session as any)._agentEventQueue; continued = true;
		}
		const compactions = manager.getBranch().filter(entry => entry.type === "compaction");
		assert.equal(pending.size, 0);
		const result: WorkerResult = { settings: !settings.getRetryEnabled() && await readFile(path.join(agentDir, "settings.json"), "utf8") === settingsText
			&& await readFile(path.join(project, ".pi/settings.json"), "utf8") === settingsText,
			zeroNetwork: attempts === guard.attempts, toolCount: session.agent.state.tools.length, ordinaryHooks, fetchAttempts, blockedFetches, manualCompactions, automaticStarts, automaticEnds,
			nativeCompactions: compactions.length, fromHook: compactions.some((entry: any) => entry.fromHook === true), continued, summaryFailed, receipts: receipts.sort((a, b) => a.id - b.id) };
		await send({ type: "result", value: result });
	} finally {
		session?.dispose(); globalThis.fetch = originalFetch; registerApiProvider(underlying);
		process.off("message", cancelHandler); process.disconnect?.();
	}
}
