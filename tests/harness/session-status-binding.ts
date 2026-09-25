import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { RuntimeStatusCache } from "../../src/components/runtime-status-cache.js";
import type { RunCase } from "./testkit.js";

/** Execute the real main.ts navigation functions, without booting the app or
 * replacing their branching logic with a test implementation. The surrounding
 * widgets/transport are inert recorders; native window evidence is separate. */
async function navigationFixture() {
	const source = await readFile("src/main.ts", "utf8");
	const file = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const names = ["normalizeProjectPath", "normalizeSessionPath", "setActiveRuntime", "syncActiveChatRuntimeBinding", "isRuntimeReadyForSessionTab"];
	const declarations = file.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
	for (const name of names.slice(0, 4)) assert.ok(declarations.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === name), name);
	const code = ts.transpileModule(declarations.map((node) => node.getText(file)).join("\n"), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
	}).outputText;
	const runtimes = new Map<string, any>();
	let activeBridge: any = null;
	let displayed: Array<{ statusKey: string; statusText: string }> = [];
	const frames: string[][] = [];
	const workspace = { id: "workspace-a", activeSessionTabId: "tab-a", activeProjectPath: "C:/novel-a", sessionTabs: [] as any[] };
	const handler = {
		clearSessionStatus: () => { displayed = []; frames.push([]); },
		restoreSessionStatus: (entries: typeof displayed) => { displayed = entries; frames.push(entries.map((entry) => entry.statusText)); },
	};
	const env = {
		chatView: { prepareForSessionSwitch: () => { displayed = []; frames.push([]); } },
		extensionUiHandler: handler,
		getActiveWorkspace: () => workspace,
		getActiveSessionTab: () => workspace.sessionTabs.find((tab) => tab.id === workspace.activeSessionTabId),
		getSessionTabProjectPath: (tab: any) => tab.projectPath,
		getWorkspaceActiveProjectPath: () => workspace.activeProjectPath,
		getRuntimeForTab: (workspaceId: string, tabId: string) => runtimes.get(`${workspaceId}::${tabId}`) ?? null,
		ensureWorkspaceContentState: () => {}, recordDebugTrace: () => {}, syncDebugOverlay: () => {},
		setActiveRpcBridge: (bridge: any) => { activeBridge = bridge; },
	};
	const api = new Function("env", `
		const { ${Object.keys(env).join(", ")} } = env;
		let activeSessionRuntimeKey = null;
		${code}
		return { sync: syncActiveChatRuntimeBinding, activate: setActiveRuntime };
	`)(env) as { sync: (workspace: any, options?: { forceReset: boolean }) => void; activate: (runtime: any) => void };
	const make = (id: string, projectPath: string, sessionPath: string | null, role: string | null = null) => {
		const tab = { id, projectPath, sessionPath, novelRole: role };
		const runtime = { key: `${workspace.id}::${id}`, workspaceId: workspace.id, tabId: id, projectPath,
			lastKnownSessionPath: sessionPath, launchedNovelRole: role, phase: "ready", bridge: { isConnected: true, id },
			extensionStatuses: new RuntimeStatusCache() };
		workspace.sessionTabs.push(tab); runtimes.set(runtime.key, runtime);
		return { tab, runtime };
	};
	const emit = (runtime: any, text: string) => {
		runtime.extensionStatuses.observe({ type: "extension_ui_request", method: "setStatus", statusKey: "novel-supervisor", statusText: text });
		if (activeBridge === runtime.bridge) handler.restoreSessionStatus(runtime.extensionStatuses.snapshot());
	};
	return { ...api, make, emit, workspace, frames, displayed: () => displayed.map((entry) => entry.statusText), bridge: () => activeBridge };
}

export async function runSessionStatusBindingCases(runCase: RunCase): Promise<void> {
	await runCase("SESSION-BIND-01 reused tab hides old project before async launch", async () => {
		const f = await navigationFixture(), a = f.make("tab-a", "C:/novel-a", "C:/sessions/a.jsonl");
		f.activate(a.runtime); f.emit(a.runtime, "A 已取消");
		a.tab.projectPath = "C:/novel-b"; a.tab.sessionPath = "C:/sessions/b.jsonl";
		f.frames.length = 0; f.sync(f.workspace, { forceReset: true });
		assert.deepEqual(f.displayed(), [], "old project status must not be restored during loading");
		assert.equal(f.bridge(), null, "detach the old active-view listener before queued launch starts");
		await Promise.resolve(); f.emit(a.runtime, "A late status");
		assert.deepEqual(f.displayed(), []);
		assert.ok(f.frames.every((frame) => frame.length === 0));
		assert.equal(a.runtime.extensionStatuses.snapshot()[0].statusText, "A late status", "background cache remains owned by A");
	});
	await runCase("SESSION-BIND-02 reused tab hides old same-project session", async () => {
		const f = await navigationFixture(), a = f.make("tab-a", "C:/novel-a", "C:/sessions/a.jsonl");
		f.activate(a.runtime); f.emit(a.runtime, "A 已取消");
		a.tab.sessionPath = "C:/sessions/other.jsonl";
		f.sync(f.workspace, { forceReset: true });
		assert.deepEqual(f.displayed(), []); assert.equal(f.bridge(), null);
	});
	await runCase("SESSION-BIND-03 changed role cannot borrow the old runtime status", async () => {
		const f = await navigationFixture(), a = f.make("tab-a", "C:/novel-a", "C:/sessions/a.jsonl");
		f.activate(a.runtime); f.emit(a.runtime, "ordinary reply");
		a.tab.novelRole = "write"; f.sync(f.workspace, { forceReset: true });
		assert.deepEqual(f.displayed(), []); assert.equal(f.bridge(), null);
	});
	await runCase("SESSION-BIND-04 cold startup retains status without exposing an unready runtime", async () => {
		for (const phase of ["idle", "starting", "switching_session", "creating_session", "failed"]) {
			const f = await navigationFixture(), a = f.make("tab-a", "C:/novel-a", "C:/sessions/a.jsonl", "write");
			a.runtime.phase = phase; f.emit(a.runtime, "candidate complete");
			f.sync(f.workspace, { forceReset: true });
			assert.deepEqual(f.displayed(), [], phase); assert.equal(f.bridge(), null, phase);
			assert.equal(a.runtime.extensionStatuses.snapshot().length, 1);
			a.runtime.phase = "ready"; f.sync(f.workspace);
			assert.deepEqual(f.displayed(), ["candidate complete"]);
		}
	});
	await runCase("SESSION-BIND-05 A B A keeps background and role states independent", async () => {
		const f = await navigationFixture();
		const a = f.make("tab-a", "C:/novel-a", "C:/sessions/a.jsonl"), b = f.make("tab-b", "C:/novel-b", "C:/sessions/b.jsonl", "write");
		f.emit(a.runtime, "A 已取消"); f.emit(b.runtime, "B 候选任务已完成");
		f.sync(f.workspace); assert.deepEqual(f.displayed(), ["A 已取消"]);
		f.workspace.activeSessionTabId = "tab-b"; f.sync(f.workspace);
		f.emit(a.runtime, "A background completed");
		assert.deepEqual(f.displayed(), ["B 候选任务已完成"]);
		f.workspace.activeSessionTabId = "tab-a"; f.sync(f.workspace);
		assert.deepEqual(f.displayed(), ["A background completed"]);
	});
	await runCase("SESSION-BIND-06 new draft and disconnected runtime do not inherit terminal state", async () => {
		for (const change of ["draft", "disconnected"]) {
			const f = await navigationFixture(), a = f.make("tab-a", "C:/novel-a", "C:/sessions/a.jsonl");
			f.activate(a.runtime); f.emit(a.runtime, "old completed");
			if (change === "draft") a.tab.sessionPath = null; else a.runtime.bridge.isConnected = false;
			f.sync(f.workspace, { forceReset: true });
			assert.deepEqual(f.displayed(), [], change); assert.equal(f.bridge(), null, change);
		}
	});
	await runCase("SESSION-BIND-07 rapid reuse only projects the final confirmed identity", async () => {
		const f = await navigationFixture(), a = f.make("tab-a", "C:/novel-a", "C:/sessions/a.jsonl");
		f.activate(a.runtime); f.emit(a.runtime, "A cancelled");
		a.tab.sessionPath = "C:/sessions/b.jsonl"; f.sync(f.workspace, { forceReset: true });
		a.runtime.phase = "switching_session"; a.runtime.extensionStatuses.clear();
		a.tab.sessionPath = "C:/sessions/c.jsonl"; f.sync(f.workspace, { forceReset: true });
		f.emit(a.runtime, "B restored late");
		a.runtime.phase = "ready"; a.runtime.lastKnownSessionPath = "C:/sessions/b.jsonl";
		f.sync(f.workspace); assert.deepEqual(f.displayed(), []);
		a.runtime.extensionStatuses.clear(); a.runtime.lastKnownSessionPath = "C:/sessions/c.jsonl";
		f.emit(a.runtime, "C completed"); f.sync(f.workspace);
		assert.deepEqual(f.displayed(), ["C completed"]);
	});
	await runCase("SESSION-BIND-08 normalized ready target keeps its correct cached status", async () => {
		const f = await navigationFixture(), a = f.make("tab-a", "C:/novel-a", "C:/sessions/a.jsonl", "plan");
		f.emit(a.runtime, "planning needs review");
		a.tab.projectPath = "c:\\NOVEL-a\\"; a.tab.sessionPath = "c:\\SESSIONS\\a.jsonl";
		f.sync(f.workspace, { forceReset: true });
		assert.deepEqual(f.displayed(), ["planning needs review"]); assert.equal(f.bridge(), a.runtime.bridge);
	});
}
