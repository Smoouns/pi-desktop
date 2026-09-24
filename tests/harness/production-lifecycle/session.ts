import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, ModelRegistry, createAgentSession, createReadTool, createWriteTool, createEditTool, SessionManager, SettingsManager, type ResourceLoader, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { loadExtensions } from "../../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";
import { NOVEL_TOOLS_EXTENSION_CONTENT } from "../../../src/extensions/novel-tools-extension.js";
import { createTaskSubmission } from "../../../src/novel/task-submission.js";
import type { TaskBinding } from "../../../src/harness/task-contract.js";
import { sha256 } from "../testkit.js";
import { installProvider, MODEL, type Reply } from "./provider.js";

export const BODY = "drafts/candidates/chapters/002.md", PROPOSAL = "planning/continuity-proposals/002-lifecycle.md";
export const SOURCE = "notes/lifecycle-source.md", CARD = "planning/chapter-cards/002.md";
export const OBJECTIVE = "完成第 002 章候选正文与连续性提案；不得改动 Canon。";
export const binding = (taskId: string, artifacts: TaskBinding["expectedArtifacts"], mode: TaskBinding["completionMode"] = "candidate_write", role: TaskBinding["role"] = "write"): TaskBinding => ({ version: 1, taskId, role, completionMode: mode, expectedArtifacts: artifacts });
export const submit = (text: string, task: TaskBinding) => createTaskSubmission().encode(text, task);
export const candidate = { path: BODY, verification: "chapter-full" as const, chapter: "002" };
export const proposal = { path: PROPOSAL, verification: "none" as const };
export const plain = [{ type: "text" as const, text: "本轮输出结束；候选内容仍待人工验收。" }];
export const calls = (...items: Array<[string, Record<string, unknown>, string]>): ReturnType<Reply> => items.map(([name, args, id]) => ({ type: "toolCall" as const, name, arguments: args, id }));
export const latest = (manager: SessionManager, customType: string): any => ([...manager.getBranch()].reverse().find((entry: any) => entry.type === "custom" && entry.customType === customType) as any)?.data;
export const taskOf = (manager: SessionManager): any => latest(manager, "pi-desktop-task-contract/v1");
export const statusOf = (manager: SessionManager): any => latest(manager, "pi-desktop-run-status/v1");
export const checkpointOf = (manager: SessionManager): any => latest(manager, "pi-desktop-task-checkpoint");
export function inside(root: string, target: string): string {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "TEST_PATH_OUTSIDE_ISOLATION");
	return relative;
}

export async function openSession(work: string, sessionFile: string | null, options: { mutate?: boolean; role?: string; afterWrite?: (state: any) => Promise<void> } = {}) {
	const project = path.join(work, "project"), agentDir = path.join(work, "agent"), sessionDir = path.join(agentDir, "sessions");
	assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR!), agentDir);
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")]; assert.ok(guard?.active); assert.equal(guard.attempts, 0);
	let source = NOVEL_TOOLS_EXTENSION_CONTENT;
	if (options.mutate) {
		const needle = 'if (currentSha !== ref.sha256) changedFields.push("sha256");';
		assert.equal(source.split(needle).length, 2, "Mutation must match exactly one current production SHA comparison");
		source = source.replace(needle, 'if (false) changedFields.push("sha256");');
	}
	const extensionPath = path.join(agentDir, options.mutate ? "novel-tools-mutant.ts" : "novel-tools.ts");
	await writeFile(extensionPath, source);
	const loaded = await loadExtensions([extensionPath], project);
	assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
	const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "Public synthetic fixture. No network. Exercise the registered production tools.", getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
	if (sessionFile) inside(sessionDir, sessionFile);
	const manager = sessionFile ? SessionManager.open(sessionFile, sessionDir) : SessionManager.create(project, sessionDir);
	if (!sessionFile) manager.appendCustomEntry("pi-desktop-novel-role", { role: options.role ?? "write" });
	const auth = AuthStorage.inMemory({ [MODEL.provider]: { type: "api_key", key: "synthetic-only" } });
	const registry = new ModelRegistry(auth, path.join(agentDir, "disabled-models.json"));
	const provider = installProvider();
	const nativeDispatches: Array<{ tool: string; id: string; path: string; preHash: string | null; postHash: string | null }> = [];
	const verifierCalls: Array<{ chapter: string }> = [], events: string[] = [], results: Array<{ name: string; id: string; isError: boolean; result: any }> = [], extensionErrors: unknown[] = [];
	const ui = { statuses: [] as Array<{ key: string; text: string | undefined }>, editor: "", notices: [] as string[] };
	const fileHash = async (relative: string) => { try { return sha256(await readFile(path.join(project, relative))); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; } };
	const customTools: ToolDefinition[] = [createReadTool(project), createWriteTool(project), createEditTool(project)].map(tool => ({
		...tool, async execute(id, args: any, signal, update) {
			inside(project, path.resolve(project, args.path));
			const row = { tool: tool.name, id, path: args.path, preHash: await fileHash(args.path), postHash: null as string | null };
			if (tool.name !== "read") {
				// This is inside the real SDK dispatch, after its production tool_call hook.
				const entries = (await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
				const durable = entries.reverse().find(entry => entry.customType === "pi-desktop-task-checkpoint")?.data?.pendingOperations?.find((op: any) => op.operationId === id);
				assert.ok(durable?.state === "issued" && durable.dispatched, "DURABLE_INTENT_BEFORE_NATIVE_WRITE");
			}
			nativeDispatches.push(row);
			const result = await tool.execute(id, args, signal, update); row.postHash = await fileHash(args.path);
			if (tool.name === "write") await options.afterWrite?.({ manager, nativeDispatches, verifierCalls, events, provider, source });
			return result;
		},
	}));
	// Permit only the actual installed verifier through execFile; descendants also
	// inherit the network guard via NODE_OPTIONS. No shell tool is activated.
	const originalExecFile = childProcess.execFile;
	childProcess.execFile = ((command: string, args: string[], ...rest: any[]) => {
		assert.equal(path.resolve(command), process.execPath);
		assert.equal(args[0], "--experimental-strip-types"); assert.equal(args[1], path.join(project, ".novel/tools/verify-novel-chapter.ts"));
		assert.equal(args[2], "--project"); assert.equal(args[3], project); assert.equal(args[4], "--chapter");
		verifierCalls.push({ chapter: args[5] });
		return (originalExecFile as any)(command, args, ...rest);
	}) as typeof childProcess.execFile;
	syncBuiltinESMExports();
	const settings = SettingsManager.create(project, agentDir);
	const { session } = await createAgentSession({ cwd: project, agentDir, model: MODEL, thinkingLevel: "off", authStorage: auth, modelRegistry: registry,
		tools: [createReadTool(project), createWriteTool(project), createEditTool(project)], customTools, settingsManager: settings, sessionManager: manager, resourceLoader: resources });
	session.subscribe(event => {
		events.push(event.type);
		if (event.type === "tool_execution_end") results.push({ name: event.toolName, id: event.toolCallId, isError: event.isError, result: event.result });
	});
	await session.bindExtensions({ onError: error => extensionErrors.push(error), uiContext: {
		setStatus: (key: string, text: string | undefined) => { ui.statuses.push({ key, text }); },
		setEditorText: (text: string) => { ui.editor = text; }, notify: (text: string) => { ui.notices.push(text); },
	} as any });
	assert.ok(session.getActiveToolNames().includes("verify_chapter")); assert.ok(!session.getActiveToolNames().includes("bash"));
	const drain = async () => { await (session as any)._agentEventQueue; assert.deepEqual(extensionErrors, []); assert.deepEqual(provider.errors, []); };
	return {
		session, manager, provider, nativeDispatches, verifierCalls, events, results, fileHash, drain, ui,
		sourceHash: sha256(source),
		async prompt(text: string, reply: Reply = () => plain) { provider.agent(reply); await session.prompt(text); await drain(); },
		async compact() { provider.summary(); const result = await session.compact(); await drain(); return result; },
		result(id: string): any { const item = [...results].reverse().find(item => item.id === id); assert.ok(item, `Missing SDK tool result ${id}`); return item; },
		json(id: string): any { const result = [...results].reverse().find(item => item.id === id)?.result; return JSON.parse(result.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n")); },
		async close() { session.dispose(); provider.dispose(); childProcess.execFile = originalExecFile; syncBuiltinESMExports(); assert.equal(guard.attempts, 0); await settings.flush(); },
	};
}
