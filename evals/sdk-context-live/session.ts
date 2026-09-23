import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry, createAgentSession, createReadTool, createWriteTool, SessionManager, SettingsManager, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import { assertInside, sha256, treeManifest, writeOnce } from "../core/io.js";
import { loadSdkExtension, type SdkPrepared } from "../sdk-ablation/session.js";
import { CONTROL_KEY, METRICS_KEY, emptyMetrics } from "../sdk-context/policy.js";
import { LIFE_METRICS } from "../sdk-context/lifecycle-policy.js";
import { CONTENT_V1, CONTENT_V2, LARGE, LIMITS, MARKER, PROMPTS, PROFILES, SETTINGS, SOURCE, SYSTEM, TARGET, type Run, type Stage } from "./policy.js";
import { auditProfile, profileSource, schemaDigest } from "./profile.js";
import { installBridge, send } from "./bridge.js";

export interface StageResult {
	stage: Stage; prepared: SdkPrepared; settings: boolean; inventory: boolean; boundary: boolean; zeroNetwork: boolean; safe: boolean; normalStop: boolean; answer: boolean;
	reads: number; pages: number; markerObserved: boolean; currentSourceObserved: boolean; writes: number; staleWrites: number; tools: number; compactions: number; inheritedCompactions: number; fromHook: boolean; reopened: boolean;
	durableIntents: number; finalFileSha256: string | null; metrics: ReturnType<typeof emptyMetrics>;
	operations: { intents: number; results: number; replayBlocks: number; persistenceBlocks: number; staleResults: number };
	bridge: ReturnType<ReturnType<typeof installBridge>["snapshot"]>;
}
export interface Start { type: "start"; run: Run; stage: Stage; work: string; model: Model<"openai-completions">; prepareOnly: boolean; expected: SdkPrepared | null; priorTools: number; }
export interface WorkerResult { prepared: SdkPrepared; result: StageResult | null; before: Record<string, string>; after: Record<string, string>; }
const normalize = (text: string, root: string) => text.replaceAll(root, "<PROJECT_ROOT>").replaceAll(root.replaceAll("\\", "/"), "<PROJECT_ROOT>").replace(/Current date: \d{4}-\d{2}-\d{2}/g, "Current date: <CURRENT_DATE>");

export async function contextLiveWorker() {
	assert.equal(process.env.PI_EVAL_WORKER, "1"); assert.ok(process.send);
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")]; assert.ok(guard?.active);
	const start = await new Promise<Start>(resolve => process.once("message", value => resolve(value as Start))); assert.equal(start.type, "start");
	const { work, run, stage, model, prepareOnly } = start, project = path.join(work, "project"), agentDir = path.join(work, "agent");
	assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR!), path.resolve(agentDir));
	assert.ok(Number.isSafeInteger(start.priorTools) && start.priorTools >= 0 && start.priorTools <= LIMITS.maxTaskTools);
	const initial = await treeManifest(project), attempts = guard.attempts;
	let safe = true, reads = 0, pages = 0, writes = 0, staleWrites = 0, tools = 0, durableIntents = 0, markerObserved = false, currentSourceObserved = false;
	const allowed = new Set(["read", "write", "read_story_document", "read_observation", ...(run.profile === PROFILES[1] ? ["get_task_checkpoint", "refresh_task_checkpoint"] : [])]);
	const reject = (): never => { safe = false; throw new Error("S3L_SAFETY_STOP"); };
	const validateCall = (name: string, args: any) => {
		if (!allowed.has(name) || !args || typeof args !== "object") reject();
		if (["read", "read_story_document"].includes(name) && args.path !== (run.task === "bounded-read" ? LARGE : SOURCE)) reject();
		if (name === "write" && (stage !== "resume" || args.path !== TARGET || ![CONTENT_V1, CONTENT_V2].includes(args.content))) reject();
		if (name === "read_observation" && (typeof args.id !== "string" || args.id.length > 128 || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 4000))) reject();
	};
	const bridge = installBridge(model, (message, kind) => {
		if (kind !== "ordinary") return;
		for (const call of message.content) if (call.type === "toolCall") { if (++tools + start.priorTools > LIMITS.maxTaskTools) reject(); validateCall(call.name, call.arguments); }
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const cancellation = (value: any) => { if (value?.type === "cancel-fixture") session?.abortCompaction(); };
	process.on("message", cancellation); process.once("disconnect", () => { bridge.stop(); process.exit(0); });
	try {
		await mkdir(agentDir, { recursive: true }); await mkdir(path.join(project, ".pi"), { recursive: true });
		const settingsText = JSON.stringify(SETTINGS) + "\n", extension = path.join(agentDir, "s3-live-profile.ts"), source = profileSource(run.profile);
		if (stage !== "resume" || prepareOnly) {
			for (const file of [path.join(agentDir, "settings.json"), path.join(project, ".pi/settings.json")]) await writeFile(file, settingsText, { flag: "wx" });
			await writeFile(extension, source, { flag: "wx" });
		} else assert.equal(await readFile(extension, "utf8"), source);
		const settings = SettingsManager.create(project, agentDir); await settings.flush(); settings.reload();
		const loaded = await loadSdkExtension(extension, project); auditProfile(run.profile, loaded, source);
		const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => SYSTEM, getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
		let manager: SessionManager;
		if (stage === "resume" && !prepareOnly) {
			const state = JSON.parse(await readFile(path.join(work, "resume.json"), "utf8")); assert.equal(typeof state.sessionFile, "string");
			const sessionFile = path.resolve(agentDir, state.sessionFile); await assertInside(agentDir, sessionFile); manager = SessionManager.open(sessionFile);
		} else manager = SessionManager.create(project, path.join(agentDir, "sessions"));
		const inheritedCompactions = manager.getBranch().filter(entry => entry.type === "compaction").length;
		const auth = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "broker-placeholder-not-a-key" } });
		({ session } = await createAgentSession({ cwd: project, agentDir, authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "disabled-models.json")), model,
			thinkingLevel: "off", tools: [createReadTool(project), createWriteTool(project)], settingsManager: settings, resourceLoader: resources, sessionManager: manager }));
		await session.bindExtensions({ onError: () => { safe = false; } });
		if (stage !== "resume" || prepareOnly) manager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
		const wrapped = session.agent.state.tools.filter(tool => allowed.has(tool.name)).map(tool => ({ ...tool, execute: async (id: string, args: any, signal?: AbortSignal, update?: any) => {
			bridge.active(); if (!safe) reject(); validateCall(tool.name, args);
			if (tool.name === "write") {
				writes++; if (args.content !== CONTENT_V2) staleWrites++;
				if (run.profile === PROFILES[1]) {
					const entries = (await readFile(manager.getSessionFile()!, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
					const op = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === "pi-desktop-task-checkpoint")?.data?.pendingOperations?.at(-1);
					if (op?.operationId !== id || op.state !== "issued" || op.dispatched !== true) reject(); durableIntents++;
				}
			}
			let result: any;
			try { result = await tool.execute(id, args, signal, update); } catch (error) { if (tool.name === "write") safe = false; throw error; }
			const text = result.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
			if (!result.isError && ["read", "read_story_document"].includes(tool.name)) { reads++; if (stage === "resume" && /source-version: 2/.test(text)) currentSourceObserved = true; }
			if (!result.isError && tool.name === "read_observation") { pages++; if (text.includes(MARKER)) markerObserved = true; }
			return result;
		} }));
		assert.equal(wrapped.length, allowed.size); session.agent.setTools(wrapped);
		const prompt = PROMPTS[stage], augmented = await (session as any)._extensionRunner.emitBeforeAgentStart(prompt, undefined, session.systemPrompt);
		const prepared: SdkPrepared = { extensionSha256: sha256(source), toolsSha256: schemaDigest(wrapped), systemSha256: sha256(normalize(augmented?.systemPrompt ?? session.systemPrompt, project)), promptSha256: sha256(prompt) };
		if (start.expected) assert.deepEqual(prepared, start.expected, "S3L_PREPARED_DRIFT");
		if (prepareOnly) { await send({ type: "result", value: { prepared, result: null, before: initial, after: await treeManifest(project) } satisfies WorkerResult }); return; }
		const checksSettings = !settings.getRetryEnabled() && !settings.getCompactionEnabled() && await readFile(path.join(agentDir, "settings.json"), "utf8") === settingsText;
		bridge.attach(session);
		try { await session.prompt(prompt); await (session as any)._agentEventQueue; } catch { safe = false; }
		const last = [...session.agent.state.messages].reverse().find(message => message.role === "assistant");
		const normalStop = last?.role === "assistant" && last.stopReason === "stop";
		const answerText = last?.role === "assistant" ? last.content.filter(part => part.type === "text").map(part => part.text).join("") : "";
		const answer = answerText.trim() === (stage === "single" ? MARKER : "ready");
		if (stage === "seed" && safe && normalStop && reads > 0) {
			try { await session.compact(); } catch { safe = false; }
			if (safe) await writeOnce(path.join(work, "resume.json"), { sessionFile: path.relative(agentDir, manager.getSessionFile()!) });
		}
		const after = await treeManifest(project), compactions = manager.getBranch().filter(entry => entry.type === "compaction");
		const boundary = Object.entries(initial).every(([name, hash]) => after[name] === hash) && Object.keys(after).every(name => name in initial || name === ".pi/settings.json" && after[name] === sha256(settingsText)
			|| stage === "resume" && name === TARGET && [sha256(CONTENT_V1), sha256(CONTENT_V2)].includes(after[name]));
		if (!boundary) safe = false;
		const result: StageResult = { stage, prepared, settings: checksSettings, inventory: true, boundary, zeroNetwork: attempts === guard.attempts, safe,
			normalStop, answer, reads, pages, markerObserved, currentSourceObserved, writes, staleWrites, tools, compactions: compactions.length - inheritedCompactions, inheritedCompactions, fromHook: compactions.some((entry: any) => entry.fromHook === true), reopened: stage === "resume",
			durableIntents, finalFileSha256: after[TARGET] ?? null, metrics: (globalThis as any)[Symbol.for(METRICS_KEY)] ?? emptyMetrics(),
			operations: (globalThis as any)[Symbol.for(LIFE_METRICS)] ?? { intents: 0, results: 0, replayBlocks: 0, persistenceBlocks: 0, staleResults: 0 }, bridge: bridge.snapshot() };
		await send({ type: "result", value: { prepared, result, before: initial, after } satisfies WorkerResult });
	} finally {
		session?.dispose(); bridge.dispose(); process.off("message", cancellation);
		for (const key of [CONTROL_KEY, METRICS_KEY, LIFE_METRICS, "pi.sdk-ablation.metrics"]) delete (globalThis as any)[Symbol.for(key)];
		process.disconnect?.();
	}
}
