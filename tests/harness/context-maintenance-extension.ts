import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import { AuthStorage } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/auth-storage.js";
import { ModelRegistry } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/model-registry.js";
import { SessionManager } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js";
import { SettingsManager } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/settings-manager.js";
import { createAgentSession } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.js";
import { withLoadedExtension } from "./contracts.js";
import { withProject, type RunCase } from "./testkit.js";

const MODEL: Model<"openai-completions"> = {
	id: "context-maintenance-offline", name: "Context maintenance offline", api: "openai-completions", provider: "synthetic",
	baseUrl: "http://127.0.0.1/unused", reasoning: false, input: ["text"], contextWindow: 50_000, maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const timeout = async <T>(promise: Promise<T>, milliseconds = 4_000): Promise<T> => {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("AgentSession.prompt deadlocked")), milliseconds); })]);
	} finally { if (timer) clearTimeout(timer); }
};

export async function runContextMaintenanceExtensionCases(runCase: RunCase): Promise<void> {
	await runCase("CM-SDK input awaits callback then continues original prompt exactly once", (record) => withProject(async (root) => {
		const agentDir = await mkdtemp(path.join(tmpdir(), "pi-context-maintenance-agent-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			await mkdir(agentDir, { recursive: true });
			const authStorage = AuthStorage.inMemory({ synthetic: { type: "api_key", key: "offline-test-key" } });
			const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
			const settingsManager = SettingsManager.create(root, agentDir);
			settingsManager.setCompactionEnabled(true);
			await settingsManager.flush();
			const sessionManager = SessionManager.inMemory(root);
			sessionManager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
			sessionManager.appendMessage({ role: "user", content: "必须保留：不可改写用户约束。", timestamp: 1 });
			sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "可压缩的旧推理与说明：" + "甲".repeat(80_000) }],
				api: MODEL.api, provider: MODEL.provider, model: MODEL.id, stopReason: "stop", timestamp: 2,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

			await withLoadedExtension(root, false, async (extension, runtime) => {
				// Keep the entire pinned SDK compaction lifecycle, but replace only the
				// summary provider call. This is the public session_before_compact seam.
				extension.handlers.get("session_before_compact")!.push(async () => ({ compaction: {
					summary: "旧历史已由测试扩展压缩。", firstKeptEntryId: "not-a-real-kept-entry", tokensBefore: 20_000,
				} }));
				const loader = {
					getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
					getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
					getSystemPrompt: () => "", getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined,
				};
				const { session } = await createAgentSession({ cwd: root, agentDir, authStorage, modelRegistry, model: MODEL,
					tools: [], resourceLoader: loader as never, sessionManager, settingsManager });
				let providerCalls = 0, compactCalls = 0, compactCompleted = false;
				const statuses: Array<[string, string | undefined]> = [];
				await session.bindExtensions({ uiContext: {
					setStatus: (key: string, value: string | undefined) => statuses.push([key, value]), notify: () => undefined,
					setEditorText: () => { throw new Error("successful maintenance must not restore or rewrite the editor"); },
				} as never });
				const nativeCompact = session.compact.bind(session);
				(session as any).compact = async (...args: unknown[]) => {
					compactCalls++;
					const result = await nativeCompact(...args as [string | undefined]);
					compactCompleted = true;
					return result;
				};
				(session as any).agent.streamFn = () => {
					providerCalls++;
					assert.equal(compactCompleted, true, "normal request must wait for compact callback completion");
					const stream = createAssistantMessageEventStream();
					const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "ok" }], api: MODEL.api,
						provider: MODEL.provider, model: MODEL.id, stopReason: "stop", timestamp: 3,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
					queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
					return stream;
				};
				try {
					await timeout(session.prompt("ORIGINAL_PROMPT_SENTINEL", { source: "interactive" }));
					if ((session as any)._agentEventQueue) await (session as any)._agentEventQueue;
					assert.equal(compactCalls, 1, "input hook must invoke native compact exactly once; statuses=" + JSON.stringify(statuses));
					assert.equal(providerCalls, 1, "maintenance cannot replay the original request");
					let sentinels: any[] = [];
					for (let attempt = 0; attempt < 50; attempt++) {
						sentinels = sessionManager.getBranch().filter((entry: any) => entry.type === "message" && entry.message?.role === "user"
							&& JSON.stringify(entry.message.content).includes("ORIGINAL_PROMPT_SENTINEL"));
						if (sentinels.length) break;
						await new Promise((resolve) => setTimeout(resolve, 2));
					}
					assert.equal(sentinels.length, 1, "the SDK session must persist exactly one copy of the original input; branch="
						+ JSON.stringify(sessionManager.getBranch().map((entry: any) => [entry.type, entry.message?.role, entry.message?.content])));
					assert.ok(statuses.some(([key, value]) => key === "pi-desktop-context-budget" && value?.includes('"autoCompaction":"running"')));
					assert.ok(statuses.some(([key, value]) => key === "pi-desktop-context-budget" && value?.includes('"autoCompaction":"completed"')));
					record("sdk_auto_compact", { compactCalls, providerCalls, originalPromptWrites: sentinels.length, deadlock: false });
				} finally { session.dispose(); }
			});
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(agentDir, { recursive: true, force: true });
		}
	}));
}
