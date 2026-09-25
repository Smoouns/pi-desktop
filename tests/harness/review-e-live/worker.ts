import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, SettingsManager, createAgentSession, createReadTool, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import { getApiProvider } from "@mariozechner/pi-ai";
import { loadExtensions } from "../../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";
import { createTaskSubmission } from "../../../src/novel/task-submission.js";
import { digest } from "./journal.js";
import { finalizeWorkerEvidence } from "./worker-finalization.js";
import { enumeratedStateProfile, executionProfile, jointExplicitNone } from "./protocol-profile.js";
import { installNoToolsPayloadPolicy } from "./no-tools-provider.js";
import { QUESTION_V2, RESPONSE_CONTRACT_V2 } from "./response-contract-v2.js";
import { SOURCE, GOAL, QUESTION, source, seed, systemPrompt, prompts, allowedTools, settingsFor } from "./fixtures.js";

const [work, id, scenario, scopeExtension, generatedExtension, profileFile] = process.argv.slice(2);
const profile = profileFile ? JSON.parse(readFileSync(profileFile, "utf8")) : null;
assert.ok(!profile || ["probe", "live"].includes(profile.mode), "E8_PROFILE_INVALID");
const selectedProfile = executionProfile(profile?.executionProfile);
assert.equal(scenario === "tool-none", selectedProfile.name === "tool-none", "E8_DIAGNOSTIC_PROFILE_MISMATCH");
assert.ok(work && id && scenario && scopeExtension && process.send, "E8_WORKER_REQUIRES_OFFLINE_PARENT");
const project = path.join(work, "project"), agentDir = path.join(work, "agent"), sessionDir = path.join(agentDir, "sessions");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
const network = (globalThis as any)[Symbol.for("pi.e8.networkGuard")]; assert.ok(network?.active);
let rpcId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
process.on("message", (m: any) => {
	if (m?.control === "abort") { void session?.abort(); return; }
	const item = pending.get(m?.replyTo); if (!item) return;
	pending.delete(m.replyTo); clearTimeout(item.timer); m.error ? item.reject(Error(m.error)) : item.resolve(m.value);
});
async function rpc(kind: string, data: any): Promise<any> {
	const n = ++rpcId;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { pending.delete(n); reject(Error("E8_PARENT_TIMEOUT")); }, profile ? 95_000 : 10_000);
		pending.set(n, { resolve, reject, timer }); process.send!({ rpcId: n, kind, data });
	});
}
const result: any = { profile: profile ? `full-production-extension/${profile.mode}-ipc-transport` : "full-production-extension/local-synthetic-http", pid: process.pid, scenario, realModelCalls: profile?.mode === "live" ? null : 0,
	streamDeltas: [], events: [], tools: [], blockedTools: [], snapshots: [], fetchAttempts: [], errors: [], liveAuthorized: profile?.mode === "live" ? null : false,
	authorizationAuthority: profile?.mode === "live" ? "broker-approval-receipt" : null };
result.executionProfile = selectedProfile.name;
result.responseContractId = enumeratedStateProfile(selectedProfile.name) ? RESPONSE_CONTRACT_V2 : "legacy-v1";
result.protocolAdjustments = [];
if (selectedProfile.name === "tool-none") (globalThis as any)[Symbol.for("pi.e8.explicitToolNone")] = (payload: any) => {
	assert.deepEqual(payload.tools, []); assert.equal(payload.tool_choice, undefined);
	const adjusted = { ...payload, tool_choice: "none" };
	result.protocolAdjustments.push({ beforeSha256: digest(JSON.stringify(payload)), afterSha256: digest(JSON.stringify(adjusted)), onlyAdded: "tool_choice:none" });
	return adjusted;
};
const manager = SessionManager.create(project, sessionDir);
manager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
const isC = scenario.startsWith("c-");
if (isC) for (const message of seed()) manager.appendMessage(message as any);
result.seedSha256 = isC ? digest(JSON.stringify(seed())) : null;
const originalSeedEntries = isC ? manager.getBranch().filter(entry => entry.type === "message") : [];
let phase = "start";
if (jointExplicitNone(selectedProfile.name, scenario)) {
	installNoToolsPayloadPolicy(getApiProvider("openai-completions"), () => phase, value => result.protocolAdjustments.push(value));
}
const attempted = new Set<string>();
const rawFetch = globalThis.fetch;
// Install BEFORE loading production transport. That transport still wraps this
// exact outlet and must write its durable reservation before this callback runs.
globalThis.fetch = async (input, init) => {
	if (profile) assert.equal(String(input), profile.model.baseUrl.replace(/\/$/, "") + "/chat/completions", "E8_UNEXPECTED_WORKER_ENDPOINT");
	assert.equal(typeof init?.body, "string", "E8_FINAL_BODY_REQUIRED");
	const body = init!.body as string;
	const record = [...manager.getBranch()].reverse().find((e: any) => e.customType === "pi-desktop-transport-ledger/v1") as any;
	assert.ok(record?.data, "E8_PRODUCTION_RESERVATION_MISSING");
	const key = digest(JSON.stringify([path.basename(manager.getSessionFile()!), record.data.owner]));
	const journalFile = path.join(sessionDir, ".pi-desktop-transport", key + ".json");
	const disk = JSON.parse(readFileSync(journalFile, "utf8")); assert.deepEqual(disk.record, record.data);
	const call = record.data.pending.find((row: any) => row.attempts.length && !attempted.has(row.id + ":" + row.fetches));
	assert.ok(call, "E8_ATTEMPT_NOT_IDENTIFIABLE"); attempted.add(call.id + ":" + call.fetches);
	const index = result.fetchAttempts.length + 1;
	result.fetchAttempts.push({ index, phase, productionCallId: call.id, kind: call.kind, bodySha256: digest(body), bytes: Buffer.byteLength(body) });
	const permitted = await rpc("reserve", { phase, body, productionJournal: journalFile, productionCallId: call.id, attempt: call.fetches, kind: call.kind });
	if (profile) {
		// The broker owns the network/credential. Only bytes from its bounded
		// pull stream are forwarded; the real SDK still parses the SSE normally.
		const cancel = () => { void rpc("cancel", { id: permitted.id }).catch(() => undefined); };
		init?.signal?.addEventListener("abort", cancel, { once: true });
		if (init?.signal?.aborted) { cancel(); throw Error("E8_CANCELLED"); }
		let response;
		try { response = await rpc("open", { id: permitted.id }); }
		catch (error) { init?.signal?.removeEventListener("abort", cancel); throw error; }
		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try { const chunk = await rpc("pull", { id: permitted.id });
					if (chunk.done) { init?.signal?.removeEventListener("abort", cancel); controller.close(); }
					else controller.enqueue(Buffer.from(chunk.base64, "base64"));
				} catch { init?.signal?.removeEventListener("abort", cancel); controller.error(Error("E8_RESPONSE_INTERRUPTED")); }
			}, cancel() { init?.signal?.removeEventListener("abort", cancel); cancel(); },
		});
		return new Response(stream, { status: response.status, headers: { "content-type": "text/event-stream" } });
	}
	const headers = new Headers(init?.headers); headers.set("x-e8-permit", permitted.id);
	return rawFetch(input, { ...init, headers, redirect: "error" });
};

let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let settings: SettingsManager | undefined;
const notices: string[] = [];
try {
	await mkdir(agentDir, { recursive: true }); await mkdir(path.join(project, ".pi"), { recursive: true });
	const settingsText = JSON.stringify(settingsFor(scenario));
	await writeFile(path.join(agentDir, "settings.json"), settingsText); await writeFile(path.join(project, ".pi/settings.json"), settingsText);
	const extensionContent = await readFile(generatedExtension, "utf8");
	const extensionPath = path.join(agentDir, "novel-tools.ts"); await writeFile(extensionPath, extensionContent);
	result.extensionSha256 = digest(extensionContent);
	const loaded = await loadExtensions([scopeExtension, extensionPath], project); assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 2);
	const allowed = scenario === "r" || scenario === "forbidden-path" ? allowedTools : [];
	(globalThis as any)[Symbol.for("pi.e8.toolGuard")] = async (event: any) => {
		if (!allowed.includes(event.toolName) || ((event.toolName === "read" || event.toolName === "read_story_document") && event.input.path !== SOURCE)) {
			result.blockedTools.push({ name: event.toolName, id: event.toolCallId }); await rpc("tool-denied", { name: event.toolName, id: event.toolCallId }); throw Error("E8_TOOL_DENIED");
		}
		await rpc("tool", { name: event.toolName, id: event.toolCallId });
	};
	const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => systemPrompt, getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
	const model: any = profile?.model ?? { id: "e8-synthetic", name: "E8 synthetic; not a real model", api: "openai-completions", provider: "e8-offline", baseUrl: `${process.env.PI_E8_ORIGIN}/${id}/v1`,
		reasoning: false, input: ["text"], contextWindow: 262144, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsUsageInStreaming: true, maxTokensField: "max_tokens" } };
	const auth = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "E8_SYNTHETIC_NOT_A_CREDENTIAL" } });
	settings = SettingsManager.create(project, agentDir);
	const opened = await createAgentSession({ cwd: project, agentDir, model, thinkingLevel: "off", authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "disabled-models.json")),
		tools: [createReadTool(project)], sessionManager: manager, settingsManager: settings, resourceLoader: resources });
	session = opened.session; const active = session;
	active.subscribe((event: any) => {
		result.events.push({ type: event.type, phase });
		// Unknown/inactive tools fail before Pi emits extension tool_call. Observe
		// that SDK attempt too, so the broker stops rather than buying another turn.
		if (event.type === "tool_execution_start" && !allowed.includes(event.toolName)) {
			result.blockedTools.push({ name: event.toolName, id: event.toolCallId, reason: "inactive-tool" });
			process.send!({ kind: "tool-unavailable", name: event.toolName, id: event.toolCallId });
		}
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			result.streamDeltas.push({ phase, delta: event.assistantMessageEvent.delta });
			process.send!({ kind: "visible", phase });
		}
		if (event.type === "tool_execution_end") result.tools.push({ phase, name: event.toolName, id: event.toolCallId, isError: event.isError, result: event.result });
	});
	await active.bindExtensions({ onError: error => result.errors.push(error), uiContext: { notify: (text: string) => notices.push(text), setStatus: () => undefined, setEditorText: () => undefined } as any });
	active.setActiveToolsByName(allowed); assert.deepEqual(active.getActiveToolNames().sort(), [...allowed].sort()); result.activeTools = allowed;
	await rpc("ready", { sessionFile: manager.getSessionFile(), extensionSha256: result.extensionSha256 });
	const snapshot = async (label: string) => {
		await (active as any)._agentEventQueue;
		const before = notices.length; await active.prompt("/novel-transport-status json");
		assert.equal(notices.length, before + 1);
		const transport = JSON.parse(notices.at(-1)!);
		const custom = (name: string) => ([...manager.getBranch()].reverse().find((e: any) => e.customType === name) as any)?.data ?? null;
		const value = { label, transport, task: custom("pi-desktop-task-contract/v1"), checkpoint: custom("pi-desktop-task-checkpoint"), progress: custom("pi-desktop-task-progress/v1") };
		result.snapshots.push(value); return value;
	};
	const prompt = async (label: string, text: string, bind = false) => {
		if (profile) await rpc("can-continue", {});
		phase = label;
		await active.prompt(bind ? createTaskSubmission().encode(text, { version: 1, taskId: scenario === "r" ? "E8-R" : scenario === "tool-none" ? "E8-TOOL-NONE" : "E8-U", role: "write", completionMode: scenario === "r" ? "inspection" : "reply_only", expectedArtifacts: [] }) : text);
		await snapshot(label);
	};
	if (isC) {
		await active.prompt("/novel-task reply " + GOAL);
		if (scenario !== "c-control") {
			phase = "summary"; result.compaction = await active.compact();
			await snapshot("after_compaction");
			result.compactionEntries = manager.getBranch().filter(entry => entry.type === "compaction");
			result.seedPreserved = originalSeedEntries.every(entry => manager.getEntries().some(current => current.id === entry.id && JSON.stringify(current) === JSON.stringify(entry)));
			result.recentAfterCompaction = structuredClone(active.messages);
		}
		await prompt("answer", enumeratedStateProfile(selectedProfile.name) ? QUESTION_V2 : QUESTION);
	} else if (scenario === "r") {
		await prompt("r1", prompts.r1, true);
		await prompt("r2", prompts.r2);
		phase = "host-transition";
		if (profile) await rpc("can-continue", {});
		assert.equal(await readFile(path.join(project, SOURCE), "utf8"), source("v1"));
		await writeFile(path.join(project, SOURCE), source("v2"));
		await rpc("transition", { path: SOURCE, before: digest(source("v1")), after: digest(source("v2")) });
		await prompt("r3", prompts.r3);
	} else if (scenario === "tool-none") {
		await prompt("tool-none", prompts.u1, true);
	} else if (scenario === "u") {
		await prompt("u1", prompts.u1, true);
		await prompt("u2", prompts.u2);
	} else {
		// Deliberately try one follow-up after the fault. The outer broker must
		// deny new sends; attempted SDK/fetch entries are not HTTP receipts.
		await prompt("fault1", GOAL, true);
		if (!["cancel", "crash", "forbidden-path", "forbidden-tool"].includes(scenario)) await prompt("fault2", "继续只读检查。");
	}
} catch (error) {
	result.failure = error instanceof Error ? error.message : String(error);
} finally {
	await finalizeWorkerEvidence(result, {
		settle: () => (session as any)?._agentEventQueue,
		evidence: {
			messages: () => session ? structuredClone(session.messages) : null,
			notices: () => [...notices],
			ledgerRecords: () => structuredClone(manager.getEntries().filter((entry: any) => entry.customType === "pi-desktop-transport-ledger/v1").map((entry: any) => entry.data)),
			sessionFile: () => manager.getSessionFile(),
		},
		shutdown: () => (session as any)?._extensionRunner?.emit({ type: "session_shutdown" }),
		dispose: () => session?.dispose(),
		flush: () => settings?.flush(),
	});
	result.network = { ...network };
	await writeFile(path.join(work, "worker-result.json"), JSON.stringify(result, null, 2) + "\n");
	try { await rpc("result", { failure: result.failure ?? null }); }
	finally { if (process.connected) process.disconnect!(); }
}
