import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry, createAgentSession, createReadTool, createWriteTool, SessionManager, SettingsManager, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import { digest, sha256, treeManifest } from "../core/io.js";
import { auditSdkInventory, SDK_METRICS_KEY, emptySdkMetrics, sdkExtensionSource } from "./extensions.js";
import { SDK_CHECKS, SDK_CONTENT, SDK_LIMITS, SDK_MODEL, SDK_PROMPTS, SDK_SYSTEM, SDK_TARGET, type SdkProfile, type SdkTask, type SdkScenario, type SdkReason } from "./policy.js";

export interface SdkPrepared { extensionSha256: string; toolsSha256: string; systemSha256: string; promptSha256: string; }
export interface SdkResult {
	status: "pass" | "fail" | "unknown" | "cancelled" | "blocked";
	reasonCode: SdkReason;
	checks: Record<typeof SDK_CHECKS[number], boolean>;
	prepared: SdkPrepared | null;
	metrics: (ReturnType<typeof emptySdkMetrics> & { syntheticInvocations: number; tools: number; writeDispatches: number; duplicateWriteDispatches: number; readAttempts: number; realHttpDispatches: 0 }) | null;
	syntheticUsage: { input: number; output: number; total: number } | null;
	finalFileSha256: string | null;
	answerCode: "ANSWER_OK" | "ANSWER_INVALID" | "ANSWER_NOT_EVALUATED";
}
export interface SdkSessionOptions { projectRoot: string; agentDir: string; profile: SdkProfile; taskId: SdkTask; scenario?: SdkScenario; prepareOnly?: boolean; expected?: SdkPrepared; }
const normalizePrompt = (prompt: string, root: string) => prompt.replaceAll(root, "<PROJECT_ROOT>").replaceAll(root.replaceAll("\\", "/"), "<PROJECT_ROOT>").replace(/Current date: \d{4}-\d{2}-\d{2}/g, "Current date: <CURRENT_DATE>");

export async function loadSdkExtension(filename: string, projectRoot: string) {
	const loader = await import(pathToFileURL(path.resolve("node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js")).href);
	return loader.loadExtensions([filename], projectRoot);
}

/** Scripted stream only. No underlying provider callback or credential resolver is reachable. */
export async function runSdkSession(options: SdkSessionOptions): Promise<SdkResult> {
	const { projectRoot, agentDir, profile, taskId } = options;
	const scenario = options.scenario ?? "normal";
	assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR!), path.resolve(agentDir), "SDK_AGENT_DIR_NOT_ISOLATED");
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")];
	assert.ok(guard?.active, "SDK_NETWORK_GUARD_REQUIRED");
	assert.equal(process.env.PI_EVAL_WORKER, "1", "SDK_WORKER_REQUIRED");
	const attemptsBefore = guard.attempts;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const checks = Object.fromEntries(SDK_CHECKS.map(key => [key, false])) as SdkResult["checks"];
	let prepared: SdkPrepared = { extensionSha256: "", toolsSha256: "", systemSha256: "", promptSha256: "" };
	let syntheticInvocations = 0, syntheticCompletions = 0, tools = 0, writeDispatches = 0, successfulReads = 0;
	let sticky: SdkReason | null = null;
	let unsubscribe: (() => void) | undefined;
	const fail = (code: SdkReason): never => { sticky ??= code; throw new Error(code); };
	const metricsKey = Symbol.for(SDK_METRICS_KEY), faultKey = Symbol.for("pi.sdk-ablation.readFault");
	const shared = globalThis as any;
	shared[faultKey] = { remaining: scenario === "transient-read" ? 1 : 0, attempts: 0 };
	try {
		await mkdir(agentDir, { recursive: true }); await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
		const settingsText = JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false }) + "\n";
		await writeFile(path.join(agentDir, "settings.json"), settingsText, { flag: "wx" });
		await writeFile(path.join(projectRoot, ".pi/settings.json"), settingsText, { flag: "wx" });
		const settings = SettingsManager.create(projectRoot, agentDir); await settings.flush(); settings.reload();
		checks.settings = !settings.getCompactionEnabled() && !settings.getRetryEnabled()
			&& await readFile(path.join(agentDir, "settings.json"), "utf8") === settingsText
			&& await readFile(path.join(projectRoot, ".pi/settings.json"), "utf8") === settingsText;
		const source = sdkExtensionSource(profile), extensionPath = path.join(agentDir, "sdk-profile.ts");
		await writeFile(extensionPath, source, { flag: "wx" });
		const loaded = await loadSdkExtension(extensionPath, projectRoot);
		auditSdkInventory(profile, loaded, source); checks.profile = true;
		const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => SDK_SYSTEM,
			getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
		const auth = AuthStorage.inMemory({ [SDK_MODEL.provider]: { type: "api_key", key: "synthetic-no-provider-key" } });
		const registry = new ModelRegistry(auth, path.join(agentDir, "disabled-models.json"));
		({ session } = await createAgentSession({ cwd: projectRoot, agentDir, authStorage: auth, modelRegistry: registry, model: { ...SDK_MODEL, input: ["text"] } as Model<any>, thinkingLevel: "off",
			tools: [createReadTool(projectRoot), createWriteTool(projectRoot)], settingsManager: settings, resourceLoader: resources, sessionManager: SessionManager.create(projectRoot, path.join(agentDir, "sessions")) }));
		await session.bindExtensions({ onError: () => { sticky ??= "SDK_WORKER_FAILED"; } });
		session.sessionManager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
		checks.role = session.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === "pi-desktop-novel-role" && (entry.data as any)?.role === "write");
		const allowed = new Set(["read_story_document", "read", "write"]);
		const wrapped = session.agent.state.tools.filter(tool => allowed.has(tool.name)).map(tool => ({ ...tool, execute: async (id: string, args: any, signal?: AbortSignal, update?: any) => {
			if (sticky) throw new Error(sticky);
			if (++tools > SDK_LIMITS.taskTools) fail("SDK_LIMIT");
			if (taskId === "P5A-READ-001" ? tool.name === "write" || args.path !== "canon/world.md" : args.path !== SDK_TARGET || tool.name === "write" && args.content !== SDK_CONTENT) fail("SDK_PATH_DENIED");
			// SDK 0.63.1 uses options.tools as name selection, then constructs its own
			// built-ins. Inject after that construction so this counts actual writes.
			if (tool.name === "write") writeDispatches++;
			const result = await tool.execute(id, args, signal, update);
			if (tool.name === "write" && writeDispatches === 1) {
				if (scenario === "unknown-write") await writeFile(path.join(projectRoot, SDK_TARGET), "synthetic-partial-write\n");
				throw new Error("SYNTHETIC_ACK_LOST");
			}
			return result;
		} }));
		assert.equal(wrapped.length, 3, "SDK_TOOL_SET_DRIFT"); session.agent.setTools(wrapped);
		const toolsHash = digest(wrapped.map(({ name, description, parameters }) => ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name)));
		const runner = (session as any)._extensionRunner;
		const augmented = await runner.emitBeforeAgentStart(SDK_PROMPTS[taskId], undefined, session.systemPrompt);
		prepared = { extensionSha256: sha256(source), toolsSha256: toolsHash, systemSha256: sha256(normalizePrompt(augmented?.systemPrompt ?? session.systemPrompt, projectRoot)), promptSha256: sha256(SDK_PROMPTS[taskId]) };
		if (options.expected) assert.equal(digest(prepared), digest(options.expected), "SDK_PREPARED_DRIFT");
		const before = await treeManifest(projectRoot);
		if (options.prepareOnly) return { status: "pass", reasonCode: "SDK_PASS", checks, prepared,
			metrics: { ...emptySdkMetrics(), syntheticInvocations: 0, tools: 0, writeDispatches: 0, duplicateWriteDispatches: 0, readAttempts: 0, realHttpDispatches: 0 }, syntheticUsage: { input: 0, output: 0, total: 0 }, finalFileSha256: null, answerCode: "ANSWER_NOT_EVALUATED" };
		const expectedRead = taskId === "P5A-READ-001" ? await readFile(path.join(projectRoot, "canon/world.md"), "utf8") : SDK_CONTENT;
		unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_end" && !event.isError && ["read", "read_story_document"].includes(event.toolName)
				&& event.result?.content?.some((part: any) => part.type === "text" && part.text.includes(expectedRead.trim()))) successfulReads++;
		});
		session.agent.streamFn = (_model, context) => {
			if (sticky) throw new Error(sticky);
			if (scenario === "cancel") fail("SDK_CANCELLED");
			if (syntheticInvocations >= (scenario === "request-limit" ? 1 : SDK_LIMITS.taskInvocations)) fail("SDK_LIMIT");
			assert.equal(sha256(normalizePrompt(context.systemPrompt ?? "", projectRoot)), prepared.systemSha256, "SDK_SYSTEM_DRIFT");
			assert.equal(digest((context.tools ?? []).map(({ name, description, parameters }) => ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name))), prepared.toolsSha256, "SDK_TOOLS_DRIFT");
			syntheticInvocations++;
			if (scenario === "missing-usage") fail("SDK_USAGE_MISSING");
			let content: AssistantMessage["content"];
			const call = (name: string, args: Record<string, unknown>): AssistantMessage["content"] => [{ type: "toolCall", id: `call-${syntheticInvocations}`, name, arguments: args }];
			if (scenario === "forbidden-tool") { content = call("bash", { command: "not-executed" }); fail("SDK_TOOL_DENIED"); }
			else if (scenario === "forbidden-path") { content = call("write", { path: "canon/world.md", content: SDK_CONTENT }); fail("SDK_PATH_DENIED"); }
			else if (taskId === "P5A-READ-001") content = syntheticInvocations === 1 ? call("read_story_document", { path: "canon/world.md" }) : [{ type: "text", text: '{"canPredictStorm":false,"signers":["记录员","设备技师"]}' }];
			else {
				const readTurn = scenario === "readback" ? 2 : 3;
				content = syntheticInvocations < readTurn ? call("write", { path: SDK_TARGET, content: SDK_CONTENT })
					: syntheticInvocations === readTurn ? call("read", { path: SDK_TARGET }) : [{ type: "text", text: "ready" }];
			}
			const message: AssistantMessage = { role: "assistant", content, api: SDK_MODEL.api, provider: SDK_MODEL.provider, model: SDK_MODEL.id,
				stopReason: content[0]?.type === "toolCall" ? "toolUse" : "stop", timestamp: 0,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); syntheticCompletions++; });
			return stream;
		};
		try { await session.prompt(SDK_PROMPTS[taskId]); } catch { sticky ??= "SDK_WORKER_FAILED"; }
		await (session as any)._agentEventQueue;
		const after = await treeManifest(projectRoot);
		const finalFileSha256 = after[SDK_TARGET] ?? null;
		checks.files = Object.entries(before).every(([name, hash]) => after[name] === hash)
			&& Object.keys(after).every(name => name in before || taskId === "P5A-TOOL-001" && name === SDK_TARGET)
			&& (taskId !== "P5A-TOOL-001" || finalFileSha256 === sha256(SDK_CONTENT));
		checks.read = successfulReads === 1;
		checks.singleWrite = writeDispatches === (taskId === "P5A-READ-001" ? 0 : 1);
		const last = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
		checks.normalStop = last?.role === "assistant" && last.stopReason === "stop";
		const answer = last?.role === "assistant" ? last.content.filter(part => part.type === "text").map(part => part.text).join("") : "";
		checks.answer = taskId === "P5A-READ-001" ? answer === '{"canPredictStorm":false,"signers":["记录员","设备技师"]}' : answer === "ready";
		checks.limits = !sticky && guard.attempts === attemptsBefore && syntheticInvocations <= SDK_LIMITS.taskInvocations && tools <= SDK_LIMITS.taskTools;
		const reasonCode = (sticky ?? (Object.values(checks).every(Boolean) ? "SDK_PASS" : "SDK_CONTRACT_FAILED")) as SdkReason;
		return { status: reasonCode === "SDK_PASS" ? "pass" : reasonCode === "SDK_CANCELLED" ? "cancelled" : reasonCode === "SDK_USAGE_MISSING" ? "unknown" : "fail", reasonCode, checks, prepared,
			metrics: { ...(shared[metricsKey] ?? emptySdkMetrics()), syntheticInvocations, tools, writeDispatches, duplicateWriteDispatches: Math.max(0, writeDispatches - 1), readAttempts: shared[faultKey].attempts, realHttpDispatches: 0 },
			syntheticUsage: syntheticCompletions !== syntheticInvocations ? null : { input: syntheticCompletions, output: syntheticCompletions, total: syntheticCompletions * 2 }, finalFileSha256,
			answerCode: !answer ? "ANSWER_NOT_EVALUATED" : checks.answer ? "ANSWER_OK" : "ANSWER_INVALID" };
	} finally { unsubscribe?.(); session?.dispose(); delete shared[metricsKey]; delete shared[faultKey]; }
}
