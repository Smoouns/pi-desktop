import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createEditTool, createReadTool, createWriteTool, SessionManager } from "@mariozechner/pi-coding-agent";
import { ExtensionRunner } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";
import { createCheckpointStore, type TaskCheckpoint } from "../../src/harness/checkpoint-store.js";
import { withLoadedExtension } from "./contracts.js";
import { sha256, withProject, type RunCase } from "./testkit.js";

export const WRITE_TARGET = "drafts/candidates/chapters/write-state.md";
const text = (result: any): string => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
const assistant = { role: "assistant", content: [{ type: "text", text: "synthetic persistence flush" }], timestamp: 0,
	api: "openai-completions", provider: "synthetic", model: "offline", stopReason: "stop",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as const;

/** Full production extension and real disk-backed SDK session; never loads a provider. */
export async function withWriteSession<T>(root: string, sessionFile: string | null, body: (state: {
	manager: SessionManager; call: (tool: "write" | "edit" | "read", id: string, input: any, dropResult?: boolean) => Promise<any>;
	checkpoint: (name?: "get" | "refresh") => Promise<any>; writes: () => number;
	persisted: () => TaskCheckpoint; restart: (request: string) => Promise<void>;
	runner: ExtensionRunner; extension: any; ctx: () => any;
}) => Promise<T>): Promise<T> {
	return withLoadedExtension(root, false, async (extension, runtime) => {
		const sessionDir = path.join(root, "test-sessions");
		const manager = sessionFile ? SessionManager.open(sessionFile, sessionDir) : SessionManager.create(root, sessionDir);
		if (!sessionFile) {
			manager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
			manager.appendMessage(structuredClone(assistant) as never); // SDK starts persisting after its first assistant entry.
		}
		const runner = new ExtensionRunner([extension], runtime as never, root, manager as never, {} as never), noop = () => undefined;
		runner.bindCore({ sendMessage: noop, sendUserMessage: noop, appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
			setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => [], getAllTools: () => [],
			setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel: noop } as never,
			{ getModel: () => ({ id: "offline", provider: "synthetic", api: "openai-completions", contextWindow: 1_000_000, maxTokens: 4096 }),
				isIdle: () => true, abort: noop, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => "" } as never);
		await runner.emit({ type: "session_start" } as never);
		const restart = async (request: string) => {
			const result = await runner.emitInput(request, undefined, "interactive");
			assert.notEqual(result.action, "handled");
			manager.appendMessage({ role: "user", content: result.action === "transform" ? result.text : request, timestamp: 0 });
			await runner.emit({ type: "agent_start" } as never);
		};
		await restart("在当前候选目录内测试写入合同");
		let writes = 0;
		const call = async (toolName: "write" | "edit" | "read", id: string, input: any, dropResult = false) => {
			const blocked = await runner.emitToolCall({ type: "tool_call", toolName, toolCallId: id, input } as never);
			if (blocked?.block) return { blocked: true, reason: blocked.reason };
			const native = toolName === "write" ? createWriteTool(root) : toolName === "edit" ? createEditTool(root) : createReadTool(root);
			if (toolName !== "read") writes++;
			let result: any;
			try { result = await native.execute(id, input); }
			catch (error) { result = { content: [{ type: "text", text: (error as Error).message }], isError: true }; }
			if (dropResult) return { blocked: false, dropped: true };
			const patch = await runner.emitToolResult({ type: "tool_result", toolName, toolCallId: id, input, ...result, isError: Boolean(result.isError) } as never);
			return { blocked: false, ...result, ...patch };
		};
		const checkpoint = async (name: "get" | "refresh" = "get") => {
			const result: any = await extension.tools.get(`${name}_task_checkpoint`)!.definition.execute(`cp-${name}`, {}, undefined, undefined, runner.createContext());
			assert.notEqual(result.isError, true, text(result)); return JSON.parse(text(result));
		};
		const persisted = () => {
			const entry = manager.getBranch().slice().reverse().find((item: any) => item.type === "custom" && item.customType === "pi-desktop-task-checkpoint") as any;
			assert.ok(entry); return createCheckpointStore({ digest: sha256 }).parse(entry.data);
		};
		return body({ manager, call, checkpoint, writes: () => writes, persisted, restart, runner, extension, ctx: () => runner.createContext() });
	});
}

export async function runWriteStateExtensionCases(runCase: RunCase): Promise<void> {
	for (const reuseId of [false, true]) await runCase(`REV-02 production A-B-A ${reuseId ? "same" : "new"} call ID`, (record) => withProject(async (root) => withWriteSession(root, null, async (s) => {
		const input = { path: WRITE_TARGET, content: "A\n" };
		assert.equal((await s.call("write", "write-a", input)).blocked, false);
		await writeFile(path.join(root, WRITE_TARGET), "B\n");
		assert.equal((await s.checkpoint()).status, "needs_revalidation");
		await s.call("read", "read-b", { path: WRITE_TARGET });
		assert.equal((await s.checkpoint("refresh")).status, "ready");
		const decision = await s.call("write", reuseId ? "write-a" : "new-id-a", input);
		assert.equal(decision.blocked, true); assert.match(decision.reason, /post_state_conflict/);
		assert.doesNotMatch(decision.reason, /satisfied|已满足/);
		assert.equal(await readFile(path.join(root, WRITE_TARGET), "utf8"), "B\n"); assert.equal(s.writes(), 1);
		const cp = s.persisted(); // The conflict stops the run; inspect durable data without invoking a stopped agent tool.
		assert.equal(cp.pendingOperations.length, 1); assert.equal(cp.pendingOperations[0].state, "completed");
		assert.equal(cp.pendingOperations[0].expectedPostHash, sha256("A\n"));
		assert.equal(cp.artifacts[0].sha256, sha256("B\n"));
		assert.equal((await s.call("write", "without-new-request", { path: WRITE_TARGET, content: "C\n" })).blocked, true);
		await s.restart("已检查当前 B；新任务：将候选内容改为 C");
		assert.equal((await s.call("write", "new-intent-c", { path: WRITE_TARGET, content: "C\n" })).blocked, false);
		assert.equal(await readFile(path.join(root, WRITE_TARGET), "utf8"), "C\n"); assert.equal(s.writes(), 2);
		assert.deepEqual((await s.checkpoint()).checkpoint.pendingOperations.map((op: any) => op.state), ["completed", "completed"]);
		record("write.history_current", { reuseId, oldIntentBlocked: true, historicalSuccessRetained: true, correctedIntentDispatched: true, nativeWrites: 2 });
	})));

	await runCase("REV-03 production failed edit remains failed under old and fresh IDs", (record) => withProject(async (root) => withWriteSession(root, null, async (s) => {
		await s.call("write", "seed", { path: WRITE_TARGET, content: "A\n" });
		const input = { path: WRITE_TARGET, oldText: "missing", newText: "B" };
		assert.equal((await s.call("edit", "bad-edit", input)).isError, true);
		for (const id of ["bad-edit", "repeat-bad-edit"]) {
			const result = await s.call("edit", id, input);
			assert.equal(result.blocked, true); assert.match(result.reason, /operation_failed/); assert.doesNotMatch(result.reason, /satisfied|已满足/);
		}
		assert.equal(s.writes(), 2); assert.equal(await readFile(path.join(root, WRITE_TARGET), "utf8"), "A\n");
		assert.equal(s.persisted().pendingOperations.find((op: any) => op.operationId === "bad-edit")!.state, "failed");
		assert.equal((await s.call("edit", "repair", { path: WRITE_TARGET, oldText: "A", newText: "C" })).blocked, false);
		assert.equal(await readFile(path.join(root, WRITE_TARGET), "utf8"), "C\n");
		record("write.failure", { failedIdRetained: true, repeatedCallsBlocked: 2, nativeMutatingCalls: 3 });
	})));

	await runCase("REV-03 cold process recovery never replays lost acknowledgements", (record) => withProject(async (root) => {
		// Build only a test worker. Its child environment contains no provider credentials.
		const work = path.join(root, "test-worker"); await mkdir(work);
		const buildParent = path.resolve("artifacts/harness"); await mkdir(buildParent, { recursive: true });
		const buildRoot = await mkdtemp(path.join(buildParent, ".write-state-")), worker = path.join(buildRoot, "worker.mjs");
		try {
		await build({ entryPoints: [path.resolve("tests/harness/write-state-worker.ts")], outfile: worker, bundle: true, platform: "node", format: "esm", packages: "external",
			alias: { "@tauri-apps/api/core": "./tests/support/rpc-tauri-core.ts", "@tauri-apps/api/event": "./tests/support/rpc-tauri-event.ts" },
			plugins: [{ name: "pinned-sdk", setup(api) { api.onResolve({ filter: /^@mariozechner\/pi-coding-agent(?:\/.*)?$|node_modules\/@mariozechner\/pi-coding-agent\/dist\/core\/extensions\/index\.js$/ }, (args) => ({ path: args.path === "@mariozechner/pi-coding-agent" ? pathToFileURL(path.resolve("node_modules/@mariozechner/pi-coding-agent/dist/index.js")).href : pathToFileURL(path.resolve("node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js")).href, external: true })); } }], logLevel: "warning" });
		const env: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)) env[key] = value;
		env.PI_CODING_AGENT_DIR = path.join(work, "empty-agent");
		for (const stage of ["seed", "resume", "conflict"] as const) {
			const child = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href, worker, stage, root], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000, windowsHide: true });
			assert.equal(child.status, 0, `Cold ${stage} failed: ${child.stderr}`);
		}
		const proof = JSON.parse(await readFile(path.join(root, "test-worker/proof.json"), "utf8"));
		assert.equal(proof.nativeWrites, 1); assert.equal(proof.satisfiedWithoutReplay, true); assert.equal(proof.conflictBlocked, true);
		assert.equal(new Set(proof.processIds).size, 3); assert.equal(await readFile(path.join(root, WRITE_TARGET), "utf8"), "B\n");
		record("write.cold_recovery", { freshProcesses: 3, realSessionPersistence: true, nativeWrites: 1, lostAckReconciled: true, currentConflictBlocked: true });
		} finally {
			const relative = path.relative(buildParent, path.resolve(buildRoot));
			assert.ok(relative.startsWith(".write-state-") && !relative.includes(path.sep));
			await rm(buildRoot, { recursive: true, force: true });
		}
	}));
}
