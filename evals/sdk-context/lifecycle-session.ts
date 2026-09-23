import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, ModelRegistry, createAgentSession, createReadTool, createWriteTool, SessionManager, SettingsManager, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import { assertInside, digest, sha256, treeManifest, writeOnce } from "../core/io.js";
import { loadSdkExtension } from "../sdk-ablation/session.js";
import { CONTROL_KEY, METRICS_KEY, MODEL, SOURCE, SYSTEM } from "./policy.js";
import { auditLifecycleInventory, lifecycleExtensionSource } from "./lifecycle-extension.js";
import { installLifecycleProvider, type LifeReceipt, type LifeReply } from "./lifecycle-provider.js";
import { LIFE_CONTENT, LIFE_FAULT, LIFE_LIMITS, LIFE_METRICS, LIFE_PARTIAL, LIFE_PROMPTS, LIFE_TARGET, isWriteTask, type LifeProfile, type LifeScenario, type LifeTask } from "./lifecycle-policy.js";

export type LifeStage = "single" | "seed" | "resume";
export type OperationState = "none" | "issued" | "unknown" | "completed";
export interface LifeStageResult {
	stage: LifeStage; inventory: boolean; settings: boolean; boundary: boolean; zeroNetwork: boolean; reopened: boolean;
	receipts: LifeReceipt[]; tools: number; writes: number; writeEffects: number; lostAcks: number;
	durableIntentBeforeWrite: boolean; unknownAtCompaction: boolean;
	pendingBefore: OperationState; pendingAfter: OperationState;
	starts: Array<"threshold" | "overflow">;
	ends: Array<{ reason: "threshold" | "overflow"; success: boolean; aborted: boolean; willRetry: boolean; error: boolean }>;
	inheritedCompactions: number; nativeCompactions: number; fromHook: boolean; agentEnds: number;
	writeResults: Array<"reconciled" | "unknown" | "persistence" | "error" | "success">;
	operationMetrics: { intents: number; results: number; replayBlocks: number; persistenceBlocks: number; staleResults: number };
	finalFileSha256: string | null; extensionSha256: string; toolSchemaSha256: string; promptSha256: string;
}
export const emptyOperationMetrics = () => ({ intents: 0, results: 0, replayBlocks: 0, persistenceBlocks: 0, staleResults: 0 });
const latestOperation = (manager: SessionManager): any => ([...manager.getBranch()].reverse().find((e: any) => e.type === "custom" && e.customType === "pi-desktop-task-checkpoint") as any)?.data?.pendingOperations?.at(-1);
const operationState = (manager: SessionManager): OperationState => latestOperation(manager)?.state ?? "none";

export async function runLifecycleStage(work: string, profile: LifeProfile, task: LifeTask, stage: LifeStage, scenario: LifeScenario): Promise<LifeStageResult> {
	const project = path.join(work, "project"), agentDir = path.join(work, "agent");
	assert.equal(process.env.PI_EVAL_WORKER, "1"); assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR!), path.resolve(agentDir));
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")]; assert.ok(guard?.active);
	const attempts = guard.attempts, before = await treeManifest(project), provider = installLifecycleProvider();
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	const shared = globalThis as any;
	let inventory = true, tools = 0, writes = 0, writeEffects = 0, lostAcks = 0, durableIntentBeforeWrite = false, unknownAtCompaction = false, agentEnds = 0;
	const starts: LifeStageResult["starts"] = [], ends: LifeStageResult["ends"] = [], writeResults: LifeStageResult["writeResults"] = [];
	try {
		await mkdir(agentDir, { recursive: true }); await mkdir(path.join(project, ".pi"), { recursive: true });
		const settingsText = JSON.stringify({ compaction: { enabled: true, reserveTokens: LIFE_LIMITS.reserveTokens, keepRecentTokens: LIFE_LIMITS.keepRecentTokens }, retry: { enabled: false }, enableSkillCommands: false }) + "\n";
		if (stage !== "resume") for (const file of [path.join(agentDir, "settings.json"), path.join(project, ".pi/settings.json")]) await writeFile(file, settingsText, { flag: "wx" });
		const settings = SettingsManager.create(project, agentDir); await settings.flush(); settings.reload();
		const source = lifecycleExtensionSource(profile), extensionPath = path.join(agentDir, "lifecycle-profile.ts");
		if (stage !== "resume") await writeFile(extensionPath, source, { flag: "wx" }); else assert.equal(await readFile(extensionPath, "utf8"), source);
		const loaded = await loadSdkExtension(extensionPath, project); auditLifecycleInventory(profile, loaded, source);
		const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => SYSTEM, getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
		let manager: SessionManager;
		if (stage === "resume") {
			const state = JSON.parse(await readFile(path.join(work, "lifecycle-resume-state.json"), "utf8"));
			assert.equal(typeof state.sessionFile, "string"); const file = path.resolve(agentDir, state.sessionFile); await assertInside(agentDir, file); manager = SessionManager.open(file);
		} else manager = SessionManager.create(project, path.join(agentDir, "sessions"));
		const inheritedCompactions = manager.getBranch().filter(e => e.type === "compaction").length;
		const pendingBefore = operationState(manager);
		const auth = AuthStorage.inMemory({ [MODEL.provider]: { type: "api_key", key: "synthetic-only" } });
		({ session } = await createAgentSession({ cwd: project, agentDir, authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "disabled-models.json")), model: { ...MODEL, input: ["text"] },
			thinkingLevel: "off", tools: [createReadTool(project), createWriteTool(project)], settingsManager: settings, resourceLoader: resources, sessionManager: manager }));
		await session.bindExtensions({ onError: () => { inventory = false; } });
		if (stage !== "resume") manager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
		session.subscribe(event => {
			provider.event(event);
			if (event.type === "agent_end") agentEnds++;
			if (event.type === "compaction_start") { starts.push(event.reason as "threshold" | "overflow"); if (operationState(manager) === "unknown") unknownAtCompaction = true; }
			if (event.type === "compaction_end") ends.push({ reason: event.reason as "threshold" | "overflow", success: Boolean(event.result), aborted: event.aborted, willRetry: event.willRetry, error: Boolean(event.errorMessage) });
			if (event.type === "tool_execution_end" && event.toolName === "write") {
				const text = event.result.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";
				writeResults.push(!event.isError ? "success" : text.includes("[reconciled]") ? "reconciled" : text.includes("[unknown_outcome]") ? "unknown" : text.includes("[checkpoint_persistence]") ? "persistence" : "error");
			}
		});
		provider.summary(scenario.startsWith("summary-") ? scenario.slice(8) : "normal", () => session!.abortCompaction());
		const allowed = new Set(["read_story_document", "read", "write", ...(profile !== "sdk-b1-reliability" ? ["read_observation"] : []), ...(profile === "sdk-b3-checkpoint-ops-v2" ? ["get_task_checkpoint", "refresh_task_checkpoint"] : [])]);
		const wrapped = session.agent.state.tools.filter(t => allowed.has(t.name)).map(t => ({ ...t, execute: async (id: string, args: any, signal?: AbortSignal, update?: any) => {
			assert.ok(++tools <= LIFE_LIMITS.tools, "S3_LIFECYCLE_TOOL_LIMIT");
			if (["read", "read_story_document"].includes(t.name)) assert.equal(args.path, SOURCE);
			if (t.name !== "write") return t.execute(id, args, signal, update);
			assert.equal(args.path, LIFE_TARGET); assert.equal(args.content, LIFE_CONTENT); writes++;
			if (profile === "sdk-b3-checkpoint-ops-v2") {
				const op = latestOperation(manager);
				const diskEntries = (await readFile(manager.getSessionFile()!, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
				const diskOp = [...diskEntries].reverse().find(e => e.type === "custom" && e.customType === "pi-desktop-task-checkpoint")?.data?.pendingOperations?.at(-1);
				durableIntentBeforeWrite = op?.operationId === id && op.state === "issued" && op.dispatched && JSON.stringify(diskOp) === JSON.stringify(op);
				assert.ok(durableIntentBeforeWrite, "S3_INTENT_NOT_DURABLE");
			}
			const prior = (await treeManifest(project))[LIFE_TARGET] ?? null;
			const fault = stage === "seed" && isWriteTask(task);
			let result: any;
			if (!(fault && task === "write-missing")) result = await t.execute(id, fault && task === "write-partial" ? { ...args, content: LIFE_PARTIAL } : args, signal, update);
			if (prior !== ((await treeManifest(project))[LIFE_TARGET] ?? null)) writeEffects++;
			if (fault) { lostAcks++; throw new Error("S3_SYNTHETIC_LOST_WRITE_ACK"); }
			return result;
		} }));
		assert.equal(wrapped.length, allowed.size); session.agent.setTools(wrapped);
		const schemaHash = digest(wrapped.map(({ name, description, parameters }) => ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name)));
		const call = (name: string, args: Record<string, unknown>, n: number): LifeReply => ({ content: [{ type: "toolCall", id: `${stage}-call-${n}`, name, arguments: args }] });
		const prompt = async (message: string, reply: Parameters<typeof provider.agent>[0], expectRetry = false) => {
			const ended = agentEnds; provider.agent(reply); await session!.prompt(message); await (session as any)._agentEventQueue;
			if (expectRetry && ends.at(-1)?.willRetry) {
				const deadline = Date.now() + 5000;
				while (agentEnds < ended + 2) { assert.ok(Date.now() < deadline, "S3_AUTO_RETRY_TIMEOUT"); await new Promise(resolve => setTimeout(resolve, 5)); }
				await (session as any)._agentEventQueue;
			}
		};
		if (stage === "resume") {
			await prompt(LIFE_PROMPTS.write, (_ctx, n, seq) => n === 1 ? call("write", { path: LIFE_TARGET, content: LIFE_CONTENT }, seq) : {});
			if (profile === "sdk-b3-checkpoint-ops-v2") {
				await prompt(LIFE_PROMPTS.refresh, (_ctx, n, seq) => n === 1 ? call("refresh_task_checkpoint", {}, seq) : {});
				await prompt(LIFE_PROMPTS.write, (_ctx, n, seq) => n === 1 ? call("write", { path: LIFE_TARGET, content: LIFE_CONTENT }, seq) : {});
			}
		} else {
			await prompt(LIFE_PROMPTS.seed, (_ctx, n, seq) => n === 1 ? call("read_story_document", { path: SOURCE }, seq) : {});
			if (task === "auto-threshold") {
				for (let round = 0; round < 2; round++) {
					await prompt(LIFE_PROMPTS.history, () => ({ highUsage: true }));
					if (!ends.at(-1)?.success) break;
					await prompt(LIFE_PROMPTS.continue, () => ({}));
				}
			} else if (task === "auto-overflow") {
				await prompt(LIFE_PROMPTS.history, (_ctx, n) => n === 1 || scenario === "overflow-repeat" ? { overflow: true } : {}, true);
			} else {
				if (task === "write-after-compact") await prompt(LIFE_PROMPTS.history, () => ({ highUsage: true }));
				if (scenario === "intent-persistence") shared[Symbol.for(LIFE_FAULT)] = "write_intent";
				if (scenario === "result-persistence") shared[Symbol.for(LIFE_FAULT)] = "write_result";
				await prompt(LIFE_PROMPTS.write, (_ctx, n, seq) => n === 1 ? call("write", { path: LIFE_TARGET, content: LIFE_CONTENT }, seq) : { highUsage: true });
				await writeOnce(path.join(work, "lifecycle-resume-state.json"), { sessionFile: path.relative(agentDir, manager.getSessionFile()!) });
			}
		}
		// The pinned SDK schedules overflow continuation after 100 ms. Observe a
		// full extra scheduling window, so an unexpected second retry is not hidden.
		await new Promise(resolve => setTimeout(resolve, 150)); await (session as any)._agentEventQueue;
		const after = await treeManifest(project), compactions = manager.getBranch().filter(e => e.type === "compaction");
		const allowedTarget = new Set([sha256(LIFE_CONTENT), sha256(LIFE_PARTIAL)]);
		const boundary = Object.entries(before).every(([name, hash]) => name === LIFE_TARGET || after[name] === hash)
			&& Object.keys(after).every(name => name === LIFE_TARGET ? allowedTarget.has(after[name]) : name in before || name === ".pi/settings.json" && after[name] === sha256(settingsText));
		return { stage, inventory, settings: !settings.getRetryEnabled() && settings.getCompactionEnabled() && await readFile(path.join(agentDir, "settings.json"), "utf8") === settingsText,
			boundary, zeroNetwork: guard.attempts === attempts, reopened: stage === "resume", receipts: provider.receipts, tools, writes, writeEffects, lostAcks, durableIntentBeforeWrite, unknownAtCompaction,
			pendingBefore, pendingAfter: operationState(manager), starts, ends, inheritedCompactions, nativeCompactions: compactions.length - inheritedCompactions,
			fromHook: compactions.some((e: any) => e.fromHook === true), agentEnds, writeResults,
			operationMetrics: shared[Symbol.for(LIFE_METRICS)] ?? emptyOperationMetrics(), finalFileSha256: after[LIFE_TARGET] ?? null,
			extensionSha256: sha256(source), toolSchemaSha256: schemaHash, promptSha256: digest(LIFE_PROMPTS) };
	} finally {
		session?.dispose(); provider.dispose();
		for (const key of [CONTROL_KEY, METRICS_KEY, LIFE_METRICS, LIFE_FAULT, "pi.sdk-ablation.metrics"]) delete shared[Symbol.for(key)];
	}
}
