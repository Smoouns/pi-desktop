import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream, type Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry, createAgentSession, createReadTool, createWriteTool, SessionManager, SettingsManager, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import { digest, sha256, treeManifest } from "../core/io.js";
import { auditSdkInventory, SDK_METRICS_KEY, emptySdkMetrics, sdkExtensionSource } from "../sdk-ablation/extensions.js";
import { loadSdkExtension, type SdkPrepared } from "../sdk-ablation/session.js";
import { SDK_CONTENT, SDK_TARGET } from "../sdk-ablation/policy.js";
import { diagnosePilotAnswer, type PilotAnswerCode } from "../pilot/answer-diagnostics.js";
import { LIVE_CHECKS, LIVE_LIMITS, LIVE_MODEL, LIVE_PROMPTS, LIVE_REASONS, LIVE_SYSTEM, type LiveRun } from "./policy.js";

export type LiveSdkSummary = {
	status: "pass" | "fail" | "unknown"; reasonCode: typeof LIVE_REASONS[number];
	checks: Record<typeof LIVE_CHECKS[number], boolean>; prepared: SdkPrepared;
	metrics: ReturnType<typeof emptySdkMetrics> & { invocations: number; completions: number; tools: number; writeDispatches: number; duplicateWriteDispatches: number; ackLosses: number };
	sdkUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number } | null;
	answerCodes: PilotAnswerCode[]; finalFileSha256: string | null;
};
export interface LiveSessionOptions {
	run: LiveRun; projectRoot: string; agentDir: string; model: Model<"openai-completions">;
	prepareOnly: boolean; expected: SdkPrepared | null;
	bridge: { assertActive(): void; invoke<T>(callback: () => Promise<T>): Promise<T> };
}
const normalize = (text: string, root: string) => text.replaceAll(root, "<PROJECT_ROOT>").replaceAll(root.replaceAll("\\", "/"), "<PROJECT_ROOT>").replace(/Current date: \d{4}-\d{2}-\d{2}/g, "Current date: <CURRENT_DATE>");
const toolsDigest = (tools: readonly { name: string; description: string; parameters: unknown }[]) => digest(tools.map(({ name, description, parameters }) => ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name)));

/** Actual pinned SDK provider loop. No scripted replies or real credential enter this worker. */
export async function runLiveSdkSession(options: LiveSessionOptions): Promise<{ prepared: SdkPrepared; summary: LiveSdkSummary | null }> {
	const { projectRoot, agentDir, run, model, bridge } = options;
	assert.equal(process.env.PI_EVAL_WORKER, "1"); assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR!), path.resolve(agentDir));
	assert.ok((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active);
	assert.equal(model.maxTokens, LIVE_LIMITS.maxOutputTokens); assert.equal(model.id, LIVE_MODEL.id);
	const shared = globalThis as any, metricsKey = Symbol.for(SDK_METRICS_KEY), faultKey = Symbol.for("pi.sdk-ablation.readFault");
	shared[faultKey] = { remaining: 0, attempts: 0 };
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined, unsubscribe: (() => void) | undefined;
	let sticky: "SAFETY_STOP" | "WRITE_UNKNOWN" | "WORKER_UNKNOWN" | null = null;
	const stop = (reason: NonNullable<typeof sticky>): never => { sticky ??= reason; throw new Error(reason); };
	const active = () => { if (sticky) throw new Error(sticky); bridge.assertActive(); };
	let invocations = 0, completions = 0, tools = 0, writeDispatches = 0, ackLosses = 0, reads = 0;
	const checks = Object.fromEntries(LIVE_CHECKS.map(key => [key, false])) as LiveSdkSummary["checks"];
	try {
		await mkdir(agentDir, { recursive: true }); await mkdir(path.join(projectRoot, ".pi"), { recursive: true });
		const settingsText = JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false }) + "\n";
		await writeFile(path.join(agentDir, "settings.json"), settingsText, { flag: "wx" });
		await writeFile(path.join(projectRoot, ".pi/settings.json"), settingsText, { flag: "wx" });
		const settings = SettingsManager.create(projectRoot, agentDir); await settings.flush(); settings.reload();
		checks.settings = !settings.getCompactionEnabled() && !settings.getRetryEnabled()
			&& await readFile(path.join(agentDir, "settings.json"), "utf8") === settingsText && await readFile(path.join(projectRoot, ".pi/settings.json"), "utf8") === settingsText;
		const source = sdkExtensionSource(run.profile), extension = path.join(agentDir, "sdk-profile.ts");
		await writeFile(extension, source, { flag: "wx" }); const loaded = await loadSdkExtension(extension, projectRoot);
		auditSdkInventory(run.profile, loaded, source); checks.profile = true;
		const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => LIVE_SYSTEM,
			getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
		const auth = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "broker-placeholder-not-a-key" } });
		({ session } = await createAgentSession({ cwd: projectRoot, agentDir, authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "disabled-models.json")), model,
			thinkingLevel: "off", tools: [createReadTool(projectRoot), createWriteTool(projectRoot)], settingsManager: settings, resourceLoader: resources,
			sessionManager: SessionManager.create(projectRoot, path.join(agentDir, "sessions")) }));
		await session.bindExtensions({ onError: () => { sticky ??= "WORKER_UNKNOWN"; } });
		session.sessionManager.appendCustomEntry("pi-desktop-novel-role", { role: "write" }); checks.role = true;
		const allowed = new Set(["read_story_document", "read", "write"]);
		const validateCall = (name: string, args: any) => {
			if (!allowed.has(name) || !args || typeof args !== "object") stop("SAFETY_STOP");
			if (run.taskId === "P5A-READ-001" ? name === "write" || args.path !== "canon/world.md"
				: args.path !== SDK_TARGET || name === "write" && args.content !== SDK_CONTENT) stop("SAFETY_STOP");
		};
		const wrapped = session.agent.state.tools.filter(tool => allowed.has(tool.name)).map(tool => ({ ...tool, execute: async (id: string, args: any, signal?: AbortSignal, update?: any) => {
			active(); validateCall(tool.name, args);
			if (tool.name === "write") writeDispatches++;
			let result;
			try { result = await tool.execute(id, args, signal, update); }
			catch { if (tool.name === "write") stop("WRITE_UNKNOWN"); throw new Error("READ_FAILED"); }
			if (tool.name === "write" && ackLosses === 0) { ackLosses++; throw new Error("ACKNOWLEDGEMENT_LOST: read the target to determine actual state before any further write."); }
			return result;
		} }));
		assert.equal(wrapped.length, 3); session.agent.setTools(wrapped);
		const prompt = LIVE_PROMPTS[run.taskId], augmented = await (session as any)._extensionRunner.emitBeforeAgentStart(prompt, undefined, session.systemPrompt);
		const prepared: SdkPrepared = { extensionSha256: sha256(source), toolsSha256: toolsDigest(wrapped), systemSha256: sha256(normalize(augmented?.systemPrompt ?? session.systemPrompt, projectRoot)), promptSha256: sha256(prompt) };
		if (options.expected) assert.equal(digest(prepared), digest(options.expected), "S2_PREPARED_DRIFT");
		if (options.prepareOnly) return { prepared, summary: null };
		const before = await treeManifest(projectRoot), expectedRead = run.taskId === "P5A-READ-001" ? await readFile(path.join(projectRoot, "canon/world.md"), "utf8") : SDK_CONTENT;
		unsubscribe = session.subscribe(event => { if (event.type === "tool_execution_end" && !event.isError && ["read", "read_story_document"].includes(event.toolName)
			&& event.result?.content?.some((part: any) => part.type === "text" && part.text.includes(expectedRead.trim()))) reads++; });
		const underlying = session.agent.streamFn;
		session.agent.streamFn = (requestModel, context, streamOptions) => {
			active(); if (invocations >= LIVE_LIMITS.maxTaskHttpRequests) stop("SAFETY_STOP"); invocations++;
			if (sha256(normalize(context.systemPrompt ?? "", projectRoot)) !== prepared.systemSha256 || toolsDigest(context.tools ?? []) !== prepared.toolsSha256) stop("SAFETY_STOP");
			const outer = createAssistantMessageEventStream();
			void bridge.invoke(async () => {
				const inner = await underlying(requestModel, context, { ...streamOptions, maxTokens: LIVE_LIMITS.maxOutputTokens });
				for await (const event of inner) {
					if (event.type === "done") {
						for (const call of event.message.content) if (call.type === "toolCall") { if (++tools > LIVE_LIMITS.maxTaskTools) stop("SAFETY_STOP"); validateCall(call.name, call.arguments); }
						completions++;
					}
					outer.push(event);
				}
				outer.end(await inner.result());
			}).catch(() => { sticky ??= "WORKER_UNKNOWN"; outer.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider,
				model: model.id, timestamp: 0, stopReason: "error", errorMessage: "S2_STREAM_STOPPED", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }); });
			return outer;
		};
		try { await session.prompt(prompt); } catch { sticky ??= "WORKER_UNKNOWN"; }
		await (session as any)._agentEventQueue;
		const after = await treeManifest(projectRoot), finalFileSha256 = after[SDK_TARGET] ?? null;
		checks.boundary = Object.entries(before).every(([name, hash]) => after[name] === hash) && Object.keys(after).every(name => name in before || run.taskId === "P5A-TOOL-001" && name === SDK_TARGET);
		checks.files = checks.boundary && (run.taskId !== "P5A-TOOL-001" || finalFileSha256 === sha256(SDK_CONTENT));
		checks.read = reads >= 1; checks.singleWrite = writeDispatches === (run.taskId === "P5A-READ-001" ? 0 : 1);
		const last = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
		checks.normalStop = last?.role === "assistant" && last.stopReason === "stop";
		const text = last?.role === "assistant" ? last.content.filter(part => part.type === "text").map(part => part.text).join("") : "";
		const answerCodes = diagnosePilotAnswer(run.taskId === "P5A-READ-001" ? "P5P-READ-001" : "P5P-WRITE-001", text).codes;
		checks.answer = answerCodes.length === 1 && answerCodes[0] === "ANSWER_OK";
		checks.limits = !sticky && invocations <= LIVE_LIMITS.maxTaskHttpRequests && tools <= LIVE_LIMITS.maxTaskTools;
		if (!checks.boundary) sticky ??= "SAFETY_STOP";
		const reasonCode = (sticky ?? (Object.values(checks).every(Boolean) ? "PASS" : "TASK_FAILED")) as LiveSdkSummary["reasonCode"];
		const messages = session.agent.state.messages.filter(message => message.role === "assistant");
		const sdkUsage = completions === invocations && completions > 0 ? messages.reduce((sum, message) => ({ inputTokens: sum.inputTokens + message.usage.input,
			outputTokens: sum.outputTokens + message.usage.output, cacheReadTokens: sum.cacheReadTokens + message.usage.cacheRead, cacheWriteTokens: sum.cacheWriteTokens + message.usage.cacheWrite,
			totalTokens: sum.totalTokens + message.usage.totalTokens }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }) : null;
		return { prepared, summary: { status: reasonCode === "PASS" ? "pass" : reasonCode === "TASK_FAILED" ? "fail" : "unknown", reasonCode, checks, prepared,
			metrics: { ...(shared[metricsKey] ?? emptySdkMetrics()), invocations, completions, tools, writeDispatches, duplicateWriteDispatches: Math.max(0, writeDispatches - 1), ackLosses }, sdkUsage, answerCodes, finalFileSha256 } };
	} finally { unsubscribe?.(); session?.dispose(); delete shared[metricsKey]; delete shared[faultKey]; }
}
