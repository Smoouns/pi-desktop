import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream, type Model } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { AuthStorage, ModelRegistry, createAgentSession, createReadTool, createWriteTool, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import type { ResourceLoader } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/resource-loader.js";
import type { LoadExtensionsResult } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.js";
import { NOVEL_TOOLS_EXTENSION_CONTENT } from "../../src/extensions/novel-tools-extension.js";
import { PILOT_LIMITS, PILOT_PROBE_CONTENT, PILOT_PROBE_PATH, PILOT_PROMPTS, PILOT_SYSTEM, type PilotTaskId } from "./policy.js";
import { diagnosePilotAnswer, pilotAnswerAccepted, unevaluatedPilotAnswer, type PilotAnswerDiagnostic } from "./answer-diagnostics.js";

type ProviderUsage = { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; totalTokens: number | null };
export interface PilotSdkSessionOptions {
	projectRoot: string;
	agentDir: string;
	model: Model<any>;
	credential: string;
	taskId: PilotTaskId;
	/** Must keep the invocation active until the returned provider stream is fully consumed. */
	invokeProvider: (taskId: PilotTaskId, create: () => ReturnType<StreamFn>) => ReturnType<StreamFn>;
	assertActive: (taskId: PilotTaskId) => void;
	onPrepared?: (value: { taskId: PilotTaskId; toolNames: string[]; toolsSha256: string; systemSha256: string; promptSha256: string; roleSha256: string; extensionSha256: string }) => void;
	prepareOnly?: boolean;
}
export interface PilotSdkTransport {
	invoke<T>(taskId: PilotTaskId, callback: () => Promise<T>): Promise<T>;
	assertActive(taskId: PilotTaskId): void;
}
export type PilotSdkTaskOptions = Omit<PilotSdkSessionOptions, "invokeProvider" | "assertActive"> & { transport: PilotSdkTransport };
export interface PilotSdkSessionSummary {
	taskId: PilotTaskId;
	status: "pass" | "fail";
	reasonCode: string;
	checks: Record<string, boolean>;
	toolNames: string[];
	toolCounts: Record<string, number>;
	fileHash: string | null;
	usage: ProviderUsage;
	answerDiagnostic: PilotAnswerDiagnostic;
	prepared?: { taskId: PilotTaskId; toolNames: string[]; toolsSha256: string; systemSha256: string; promptSha256: string; roleSha256: string; extensionSha256: string };
}

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
async function explicitlyLoadExtension(filename: string, cwd: string): Promise<LoadExtensionsResult> {
	const url = pathToFileURL(path.resolve("node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js")).href;
	const loader = await import(url) as { loadExtensions(paths: string[], cwd: string): Promise<LoadExtensionsResult> };
	return loader.loadExtensions([filename], cwd);
}
async function writeExactOrCreate(filename: string, content: string): Promise<void> {
	try { await writeFile(filename, content, { flag: "wx" }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(filename, "utf8") !== content) throw new Error("ISOLATED_INFRA_DRIFT");
	}
}
function fixedLoader(loaded: LoadExtensionsResult): ResourceLoader {
	return { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => PILOT_SYSTEM,
		getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
}
type EffectivePromptRunner = { emitBeforeAgentStart(prompt: string, images: undefined, systemPrompt: string): Promise<{ systemPrompt?: string } | undefined> };
async function effectiveSystemPrompt(session: Awaited<ReturnType<typeof createAgentSession>>["session"], prompt: string): Promise<string> {
	// Pinned SDK 0.63.1 exposes the base prompt publicly, while the per-turn extension augmentation
	// is applied by AgentSession's ExtensionRunner immediately before provider dispatch.
	const runner = (session as unknown as { _extensionRunner?: EffectivePromptRunner })._extensionRunner;
	if (!runner) throw new Error("EXTENSION_RUNNER_UNAVAILABLE");
	const result = await runner.emitBeforeAgentStart(prompt, undefined, session.systemPrompt);
	return result?.systemPrompt ?? session.systemPrompt;
}
function canonicalEffectivePrompt(prompt: string, projectRoot: string): string {
	const normalizedRoot = path.resolve(projectRoot).replaceAll("\\", "/");
	return prompt.replaceAll(normalizedRoot, "<PROJECT_ROOT>").replace(/Current date: \d{4}-\d{2}-\d{2}/g, "Current date: <CURRENT_DATE>");
}
async function files(root: string, relative = ""): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const name of (await readdir(path.join(root, relative))).sort()) {
		const rel = relative ? `${relative}/${name}` : name;
		const full = path.join(root, rel); const info = await stat(full);
		if (info.isDirectory()) Object.assign(result, await files(root, rel));
		else if (info.isFile()) result[rel] = sha256(await readFile(full));
	}
	return result;
}

const emptyUsage = (): ProviderUsage => ({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null });

function streamThroughTransport(transport: PilotSdkTransport, taskId: PilotTaskId, model: Model<any>, create: () => ReturnType<StreamFn>): ReturnType<StreamFn> {
	const outer = createAssistantMessageEventStream();
	void transport.invoke(taskId, async () => {
		const inner = await create();
		for await (const event of inner) outer.push(event);
		const result = await inner.result(); outer.end(result); return result;
	}).catch(() => outer.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider,
		model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "error", errorMessage: "PILOT_TRANSPORT_FAILED", timestamp: Date.now() } }));
	return outer;
}

export function runPilotSdkTask(options: PilotSdkTaskOptions): Promise<PilotSdkSessionSummary> {
	return runPilotSdkSession({ ...options, assertActive: options.transport.assertActive,
		invokeProvider: (taskId, create) => streamThroughTransport(options.transport, taskId, options.model, create) });
}

export async function runPilotSdkSession(options: PilotSdkSessionOptions): Promise<PilotSdkSessionSummary> {
	const { projectRoot, agentDir, model, credential, taskId } = options;
	const checks: Record<string, boolean> = { settings: false, extension: false, allowlist: false, role: false, files: false };
	const toolNames: string[] = []; const toolCounts: Record<string, number> = {};
	let successfulToolResults = 0; let failedToolResults = 0;
	let readEvidenceValid = taskId !== "P5P-READ-001"; let budgetEvidenceValid = taskId !== "P5P-READ-001";
	let stickyReason: string | null = null;
	const stop = (reason: string): never => { stickyReason ??= reason; throw new Error(reason); };
	const assertGuardActive = (): void => { if (stickyReason) throw new Error(stickyReason); options.assertActive(taskId); };
	let reasonCode = "SDK_SESSION_FAILED"; let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let prepared: PilotSdkSessionSummary["prepared"];
	let answerDiagnostic = unevaluatedPilotAnswer(taskId);
	try {
		if (!process.env.PI_CODING_AGENT_DIR || path.resolve(process.env.PI_CODING_AGENT_DIR) !== path.resolve(agentDir)) throw new Error("AGENT_DIR_NOT_ISOLATED");
		if (model.maxTokens !== PILOT_LIMITS.maxOutputTokens) throw new Error("MODEL_OUTPUT_LIMIT_MISMATCH");
		await mkdir(agentDir, { recursive: true }); await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
		const settings = JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false }, null, 2) + "\n";
		await writeExactOrCreate(path.join(agentDir, "settings.json"), settings);
		await writeExactOrCreate(path.join(projectRoot, ".pi", "settings.json"), settings);
		const manager = SettingsManager.create(projectRoot, agentDir); await manager.flush(); manager.reload();
		const globalSettings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
		const projectSettings = JSON.parse(await readFile(path.join(projectRoot, ".pi", "settings.json"), "utf8"));
		checks.settings = !manager.getCompactionEnabled() && !manager.getRetryEnabled() && globalSettings.compaction?.enabled === false
			&& globalSettings.retry?.enabled === false && projectSettings.compaction?.enabled === false && projectSettings.retry?.enabled === false;
		const extensionPath = path.join(agentDir, "pi-desktop-novel-tools.ts");
		await writeExactOrCreate(extensionPath, NOVEL_TOOLS_EXTENSION_CONTENT);
		const loaded = await explicitlyLoadExtension(extensionPath, projectRoot);
		if (loaded.errors.length) throw new Error("EXTENSION_LOAD_ERRORS");
		if (loaded.extensions.length !== 1) throw new Error("EXTENSION_COUNT_INVALID");
		checks.extension = loaded.extensions[0]!.tools.has("read_story_document") && loaded.extensions[0]!.tools.has("get_context_budget");
		const auth = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: credential } });
		const registry = new ModelRegistry(auth, path.join(agentDir, "models-disabled.json"));
		const before = await files(projectRoot);
		if (taskId === "P5P-WRITE-001") {
			try { await stat(path.join(projectRoot, PILOT_PROBE_PATH)); throw new Error("TARGET_ALREADY_EXISTS"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		const builtins = taskId === "P5P-WRITE-001" ? [createWriteTool(projectRoot), createReadTool(projectRoot)] : [];
		({ session } = await createAgentSession({ cwd: projectRoot, agentDir, authStorage: auth, modelRegistry: registry, model, thinkingLevel: "off", tools: builtins,
			resourceLoader: fixedLoader(loaded), settingsManager: manager, sessionManager: SessionManager.create(projectRoot, path.join(agentDir, "sessions")) }));
		const expectedRole = taskId === "P5P-WRITE-001" ? "write" : "planning";
		session.sessionManager.appendCustomEntry("pi-desktop-novel-role", { role: expectedRole });
		checks.role = [...session.sessionManager.getEntries()].reverse().some((entry) => entry.type === "custom" && entry.customType === "pi-desktop-novel-role" && (entry.data as { role?: unknown })?.role === expectedRole);
		const allowed = taskId === "P5P-READ-001" ? new Set(["read_story_document", "get_context_budget"]) : new Set(["write", "read"]);
		const wrapped = session.agent.state.tools.filter((tool) => allowed.has(tool.name)).map((tool) => ({ ...tool, execute: async (callId: string, args: any, signal?: AbortSignal, update?: any) => {
			assertGuardActive(); toolNames.push(tool.name); toolCounts[tool.name] = (toolCounts[tool.name] ?? 0) + 1;
			if (toolCounts[tool.name]! > 1 || toolNames.length > PILOT_LIMITS.maxTaskTools) stop("TOOL_LIMIT_EXCEEDED");
			if (taskId === "P5P-READ-001") {
				if (tool.name === "read_story_document" && args?.path !== "canon/world.md") stop("TOOL_ARGUMENT_DENIED");
			} else {
				if (args?.path !== PILOT_PROBE_PATH || (tool.name === "write" && args?.content !== PILOT_PROBE_CONTENT)) stop("TOOL_ARGUMENT_DENIED");
			}
			try { return await tool.execute(callId, args, signal, update); } catch { return stop("TOOL_EXECUTION_FAILED"); }
		} }));
		session.agent.setTools(wrapped); checks.allowlist = wrapped.length === 2;
		const preparedTools = wrapped.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })).sort((a, b) => a.name.localeCompare(b.name));
		const role = taskId === "P5P-WRITE-001" ? "write" : "planning";
		const effectivePrompt = canonicalEffectivePrompt(await effectiveSystemPrompt(session, PILOT_PROMPTS[taskId]), projectRoot);
		const effectiveSystemSha256 = sha256(effectivePrompt);
		prepared = { taskId, toolNames: preparedTools.map((tool) => tool.name), toolsSha256: sha256(JSON.stringify(preparedTools)), systemSha256: effectiveSystemSha256,
			promptSha256: sha256(PILOT_PROMPTS[taskId]), roleSha256: sha256(role), extensionSha256: sha256(NOVEL_TOOLS_EXTENSION_CONTENT) };
		options.onPrepared?.(prepared);
		if (options.prepareOnly) return { taskId, status: "pass", reasonCode: "SDK_SESSION_PREPARED", checks, toolNames: [], toolCounts: {}, fileHash: null, usage: emptyUsage(), answerDiagnostic, prepared };
		const expectedWorldHash = sha256(await readFile(path.join(projectRoot, "canon", "world.md")));
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				for (const part of event.message.content) if (part.type === "toolCall") {
					if (!allowed.has(part.name)) stickyReason ??= "TOOL_NOT_ALLOWED";
					else if ((toolCounts[part.name] ?? 0) >= 1 || toolNames.length >= PILOT_LIMITS.maxTaskTools) stickyReason ??= "TOOL_LIMIT_EXCEEDED";
					else if (taskId === "P5P-READ-001" && part.name === "read_story_document" && part.arguments?.path !== "canon/world.md") stickyReason ??= "TOOL_ARGUMENT_DENIED";
					else if (taskId === "P5P-WRITE-001" && (part.arguments?.path !== PILOT_PROBE_PATH || (part.name === "write" && part.arguments?.content !== PILOT_PROBE_CONTENT))) stickyReason ??= "TOOL_ARGUMENT_DENIED";
				}
			}
			if (event.type !== "tool_execution_end") return;
			if (event.isError) { failedToolResults += 1; stickyReason ??= "TOOL_EXECUTION_FAILED"; return; }
			successfulToolResults += 1;
			if (taskId === "P5P-READ-001" && event.toolName === "read_story_document") {
				const details = event.result?.details as { path?: unknown; sources?: Array<{ sha256?: unknown }> } | undefined;
				readEvidenceValid = details?.path === "canon/world.md" && details.sources?.some((source) => source.sha256 === expectedWorldHash) === true;
			}
			if (taskId === "P5P-READ-001" && event.toolName === "get_context_budget") {
				try { const text = event.result?.content?.filter((item: { type?: string }) => item.type === "text").map((item: { text?: string }) => item.text ?? "").join("") ?? "";
					const budget = JSON.parse(text) as { run?: { allowed?: unknown; reason?: unknown } }; budgetEvidenceValid = budget.run?.allowed === true && budget.run.reason === null; }
				catch { budgetEvidenceValid = false; }
			}
		});
		const underlying = session.agent.streamFn;
		session.agent.streamFn = (requestModel, context, streamOptions) => {
			assertGuardActive();
			if (requestModel.maxTokens !== PILOT_LIMITS.maxOutputTokens) throw new Error("MODEL_OUTPUT_LIMIT_MISMATCH");
			if (sha256(canonicalEffectivePrompt(context.systemPrompt ?? "", projectRoot)) !== effectiveSystemSha256) throw new Error("EFFECTIVE_SYSTEM_PROMPT_DRIFT");
			const source = options.invokeProvider(taskId, () => underlying(requestModel, context, { ...streamOptions, maxTokens: PILOT_LIMITS.maxOutputTokens }));
			const guarded = createAssistantMessageEventStream();
			void (async () => {
				const input = await source;
				for await (const event of input) {
					const calls = event.type === "toolcall_end" ? [event.toolCall] : event.type === "done" ? event.message.content.filter((part) => part.type === "toolCall") : [];
					for (const call of calls) {
						if (!allowed.has(call.name)) stickyReason ??= "TOOL_NOT_ALLOWED";
						else if ((toolCounts[call.name] ?? 0) >= 1 || toolNames.length >= PILOT_LIMITS.maxTaskTools) stickyReason ??= "TOOL_LIMIT_EXCEEDED";
						else if (taskId === "P5P-READ-001" && call.name === "read_story_document" && call.arguments?.path !== "canon/world.md") stickyReason ??= "TOOL_ARGUMENT_DENIED";
						else if (taskId === "P5P-WRITE-001" && (call.arguments?.path !== PILOT_PROBE_PATH || (call.name === "write" && call.arguments?.content !== PILOT_PROBE_CONTENT))) stickyReason ??= "TOOL_ARGUMENT_DENIED";
					}
					guarded.push(event);
				}
			})().catch(() => guarded.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: requestModel.api, provider: requestModel.provider,
				model: requestModel.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "error", errorMessage: "PILOT_STREAM_GUARD_FAILED", timestamp: Date.now() } }));
			return guarded;
		};
		await session.prompt(PILOT_PROMPTS[taskId]); unsubscribe();
		const after = await files(projectRoot); let fileHash: string | null = null;
		if (taskId === "P5P-WRITE-001") fileHash = sha256(await readFile(path.join(projectRoot, PILOT_PROBE_PATH)));
		const permitted = new Set(Object.keys(before)); if (taskId === "P5P-WRITE-001") permitted.add(PILOT_PROBE_PATH);
		const allowedInfra = new Set([".pi/settings.json"]);
		checks.files = Object.keys(after).every((name) => permitted.has(name) || allowedInfra.has(name)) && Object.entries(before).every(([name, hash]) => after[name] === hash)
			&& (taskId !== "P5P-WRITE-001" || fileHash === sha256(PILOT_PROBE_CONTENT));
		const required = taskId === "P5P-READ-001" ? ["read_story_document", "get_context_budget"] : ["write", "read"];
		checks.allowlist = checks.allowlist && required.every((name) => toolCounts[name] === 1) && toolNames.length === 2;
		checks.toolResults = successfulToolResults === 2 && failedToolResults === 0 && readEvidenceValid && budgetEvidenceValid;
		const last = [...session.agent.state.messages].reverse().find((message) => message.role === "assistant");
		checks.normalStop = last?.role === "assistant" && last.stopReason === "stop";
		const finalText = last?.role === "assistant" ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
		answerDiagnostic = diagnosePilotAnswer(taskId, finalText);
		checks.finalAnswer = pilotAnswerAccepted(answerDiagnostic);
		reasonCode = stickyReason ?? (Object.values(checks).every(Boolean) ? "SDK_SESSION_PASS" : (!readEvidenceValid ? "READ_EVIDENCE_INVALID" : (!budgetEvidenceValid ? "BUDGET_EVIDENCE_INVALID" : "MECHANICAL_CHECK_FAILED")));
		const assistant = session.agent.state.messages.filter((message) => message.role === "assistant");
		const usage = assistant.length ? assistant.reduce<ProviderUsage>((sum, message) => ({
			inputTokens: (sum.inputTokens ?? 0) + message.usage.input,
			outputTokens: (sum.outputTokens ?? 0) + message.usage.output,
			cacheReadTokens: (sum.cacheReadTokens ?? 0) + message.usage.cacheRead,
			cacheWriteTokens: (sum.cacheWriteTokens ?? 0) + message.usage.cacheWrite,
			totalTokens: (sum.totalTokens ?? 0) + message.usage.totalTokens,
		}), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }) : emptyUsage();
		return { taskId, status: reasonCode === "SDK_SESSION_PASS" ? "pass" : "fail", reasonCode, checks, toolNames, toolCounts, fileHash, usage, answerDiagnostic, prepared };
	} catch (error) {
		const code = stickyReason ?? (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : reasonCode);
		return { taskId, status: "fail", reasonCode: code, checks, toolNames, toolCounts, fileHash: null, usage: emptyUsage(), answerDiagnostic, prepared };
	} finally { session?.dispose(); }
}
