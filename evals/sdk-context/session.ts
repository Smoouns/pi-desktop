import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, ModelRegistry, createAgentSession, createReadTool, createWriteTool, SessionManager, SettingsManager, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import type { Context } from "@mariozechner/pi-ai";
import { assertInside, digest, sha256, treeManifest, writeOnce } from "../core/io.js";
import { loadSdkExtension } from "../sdk-ablation/session.js";
import { auditInventory, extensionSource } from "./extension.js";
import { installSyntheticProvider, type Reply, type RequestReceipt } from "./provider.js";
import { CONTENT, CONTROL_KEY, FEATURES, LARGE, LIMITS, METRICS_KEY, MODEL, PROMPTS, SOURCE, SYSTEM, TARGET, emptyMetrics, type Profile, type Scenario, type Task } from "./policy.js";

export type Stage = "single" | "seed" | "resume";
export interface StageResult {
	stage: Stage; inventory: boolean; settings: boolean; boundary: boolean; zeroNetwork: boolean;
	metrics: ReturnType<typeof emptyMetrics>; receipts: RequestReceipt[];
	tools: number; writes: number; markerSeen: boolean; nativeCompactions: number; fromHook: boolean;
	compactionFailed: boolean; reopened: boolean; checkpointRestored: boolean; oldObservationDenied: boolean;
	blockedBeforeRefresh: boolean; prematureRefreshBlocked: boolean; refreshSucceeded: boolean; finalFileSha256: string | null;
	extensionSha256: string; toolSchemaSha256: string; promptSha256: string;
}
const tool = (name: string, args: Record<string, unknown>, n: number): ReturnType<Reply> => [{ type: "toolCall", id: `s3-call-${n}`, name, arguments: args }];
const ready = (): ReturnType<Reply> => [{ type: "text", text: "ready" }];
const latest = (context: Context) => [...context.messages].reverse().find(m => m.role === "toolResult");
const textOf = (message: any) => message?.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";

export async function runStage(work: string, profile: Profile, task: Task, stage: Stage, scenario: Scenario = "normal"): Promise<StageResult> {
	const project = path.join(work, "project"), agentDir = path.join(work, "agent");
	assert.equal(process.env.PI_EVAL_WORKER, "1"); assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR!), path.resolve(agentDir));
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")]; assert.ok(guard?.active);
	const initialAttempts = guard.attempts, before = await treeManifest(project);
	const shared = globalThis as any, metricsKey = Symbol.for(METRICS_KEY), controlKey = Symbol.for(CONTROL_KEY);
	shared[metricsKey] = emptyMetrics();
	const provider = installSyntheticProvider();
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let tools = 0, writes = 0, markerSeen = false, compactionFailed = false, checkpointRestored = false, oldObservationDenied = false;
	let blockedBeforeRefresh = false, prematureRefreshBlocked = false, refreshSucceeded = false, extensionError = false;
	try {
		await mkdir(agentDir, { recursive: true }); await mkdir(path.join(project, ".pi"), { recursive: true });
		const settingsText = JSON.stringify({ compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: 128 }, retry: { enabled: false }, enableSkillCommands: false }) + "\n";
		if (stage !== "resume") { await writeFile(path.join(agentDir, "settings.json"), settingsText, { flag: "wx" }); await writeFile(path.join(project, ".pi/settings.json"), settingsText, { flag: "wx" }); }
		const settings = SettingsManager.create(project, agentDir); await settings.flush(); settings.reload();
		const source = extensionSource(profile), extensionPath = path.join(agentDir, "s3-profile.ts");
		if (stage !== "resume") await writeFile(extensionPath, source, { flag: "wx" }); else assert.equal(await readFile(extensionPath, "utf8"), source);
		const loaded = await loadSdkExtension(extensionPath, project); auditInventory(profile, loaded, source);
		const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => SYSTEM, getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
		let manager: SessionManager, state: { sessionFile: string; observationId: string | null } | null = null;
		if (stage === "resume") {
			state = JSON.parse(await readFile(path.join(work, "resume-state.json"), "utf8")); assert.ok(state && typeof state.sessionFile === "string");
			const file = path.resolve(agentDir, state.sessionFile); await assertInside(agentDir, file); manager = SessionManager.open(file);
		} else manager = SessionManager.create(project, path.join(agentDir, "sessions"));
		const auth = AuthStorage.inMemory({ [MODEL.provider]: { type: "api_key", key: "synthetic-only" } });
		({ session } = await createAgentSession({ cwd: project, agentDir, authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "disabled-models.json")),
			model: { ...MODEL, input: ["text"] }, thinkingLevel: "off", tools: [createReadTool(project), createWriteTool(project)], settingsManager: settings, resourceLoader: resources, sessionManager: manager }));
		await session.bindExtensions({ onError: () => { extensionError = true; } });
		if (stage !== "resume") manager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
		const allowed = new Set(["read_story_document", "read", "write", ...(FEATURES[profile].observations ? ["read_observation"] : []), ...(FEATURES[profile].checkpoint ? ["get_task_checkpoint", "refresh_task_checkpoint"] : [])]);
		const wrapped = session.agent.state.tools.filter(t => allowed.has(t.name)).map(t => ({ ...t, execute: async (id: string, args: any, signal?: AbortSignal, update?: any) => {
			if (++tools > LIMITS.tools) throw new Error("S3_TOOL_LIMIT");
			if (["read", "read_story_document"].includes(t.name)) assert.ok([SOURCE, LARGE].includes(args.path));
			if (t.name === "write") { assert.equal(args.path, TARGET); assert.equal(args.content, CONTENT); writes++; }
			return t.execute(id, args, signal, update);
		} }));
		assert.equal(wrapped.length, allowed.size); session.agent.setTools(wrapped);
		const schemaHash = digest(wrapped.map(({ name, description, parameters }) => ({ name, description, parameters })).sort((a,b) => a.name.localeCompare(b.name)));
		const prompt = async (message: string, reply: Reply) => { provider.agent(reply); await session!.prompt(message); await (session as any)._agentEventQueue; };
		if (task === "large-result") {
			await prompt(PROMPTS.large, (context, n) => {
				if (n === 1) return tool("read_story_document", { path: LARGE }, n);
				const text = textOf(latest(context));
				if (text.includes("S3_END_MARKER")) { markerSeen = true; return ready(); }
				const page = JSON.parse(text); return tool("read_observation", { id: page.observationId, start: page.payloadChars - 64, limit: 64 }, n);
			});
		} else if (task === "request-budget") await prompt(PROMPTS.budget, ready);
		else if (stage === "seed") {
			await prompt(PROMPTS.seed, (_context, n) => n === 1 ? tool("read_story_document", { path: SOURCE }, n) : ready());
			const observationId = manager.getBranch().filter((e: any) => e.type === "message" && e.message.role === "toolResult").map((e: any) => e.message.details?.observation?.id).find(Boolean) ?? null;
			await prompt(PROMPTS.history, ready);
			provider.summary(scenario === "summary-error" ? "error" : scenario === "summary-cancel" ? "cancel" : scenario === "summary-limit" ? "limit" : "normal", () => session!.abortCompaction());
			try { await session.compact(); } catch { compactionFailed = true; }
			await writeOnce(path.join(work, "resume-state.json"), { sessionFile: path.relative(agentDir, manager.getSessionFile()!), observationId });
		} else {
			assert.equal(stage, "resume");
			if (FEATURES[profile].checkpoint) {
				await prompt("Inspect the restored checkpoint without changing it.", (_context, n) => n === 1 ? tool("get_task_checkpoint", {}, n) : ready());
				checkpointRestored = manager.getBranch().some((e: any) => e.type === "custom" && e.customType === "pi-desktop-task-checkpoint");
			}
			if (state?.observationId) {
				await prompt(PROMPTS.oldObservation, (context, n) => { if (n === 1) return tool("read_observation", { id: state!.observationId!, start: 0, limit: 64 }, n); oldObservationDenied = latest(context)?.isError === true; return ready(); });
			}
			await prompt(PROMPTS.write, (_context, n) => n === 1 ? tool("write", { path: TARGET, content: CONTENT }, n) : ready());
			blockedBeforeRefresh = !(TARGET in await treeManifest(project));
			if (profile === "sdk-b3-checkpoint" && scenario === "normal") {
				await prompt(PROMPTS.refreshWithoutRead, (context, n) => { if (n === 1) return tool("refresh_task_checkpoint", {}, n); prematureRefreshBlocked = JSON.parse(textOf(latest(context))).status === "needs_revalidation"; return ready(); });
				await prompt(PROMPTS.refresh, (_context, n) => n === 1 ? tool("read_story_document", { path: SOURCE }, n) : n === 2 ? tool("refresh_task_checkpoint", {}, n) : n === 3 ? tool("write", { path: TARGET, content: CONTENT }, n) : ready());
				refreshSucceeded = (await treeManifest(project))[TARGET] === sha256(CONTENT);
			}
		}
		const after = await treeManifest(project), compactions = manager.getBranch().filter(e => e.type === "compaction");
		const boundary = Object.entries(before).every(([name, hash]) => after[name] === hash) && Object.keys(after).every(name => name in before || name === ".pi/settings.json" && after[name] === sha256(settingsText) || task === "compact-resume" && stage === "resume" && name === TARGET && after[name] === sha256(CONTENT));
		return { stage, inventory: !extensionError, settings: !settings.getRetryEnabled() && !settings.getCompactionEnabled() && await readFile(path.join(agentDir, "settings.json"), "utf8") === settingsText,
			boundary, zeroNetwork: guard.attempts === initialAttempts, metrics: { ...shared[metricsKey] }, receipts: provider.receipts, tools, writes, markerSeen,
			nativeCompactions: compactions.length, fromHook: compactions.some((e: any) => e.fromHook === true), compactionFailed, reopened: stage === "resume", checkpointRestored, oldObservationDenied,
			blockedBeforeRefresh, prematureRefreshBlocked, refreshSucceeded, finalFileSha256: after[TARGET] ?? null, extensionSha256: sha256(source), toolSchemaSha256: schemaHash,
			promptSha256: digest(task === "large-result" ? PROMPTS.large : task === "request-budget" ? PROMPTS.budget : PROMPTS) };
	} finally { session?.dispose(); provider.dispose(); delete shared[metricsKey]; delete shared[controlKey]; delete shared[Symbol.for("pi.sdk-ablation.metrics")]; }
}
