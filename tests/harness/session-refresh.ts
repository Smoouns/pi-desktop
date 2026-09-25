import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SessionRefreshScope } from "../../src/components/chat-view/session-refresh-scope.js";
import { SessionBrowser } from "../../src/components/session-browser.js";
import { RuntimeStatusCache } from "../../src/components/runtime-status-cache.js";
import type { RunCase } from "./testkit.js";

export async function runSessionRefreshCases(runCase: RunCase): Promise<void> {
	await runCase("SESSION-UI-05 runtime status survives A B A without replaying actions", () => {
		const a = new RuntimeStatusCache(), b = new RuntimeStatusCache();
		const status = (text?: string, key = "novel-supervisor") => ({ type: "extension_ui_request", method: "setStatus", statusKey: key, statusText: text });
		a.observe(status("已取消（AGENT_ABORTED）"));
		assert.deepEqual(b.snapshot(), []);
		b.observe(status("候选任务已完成（STOP_VERIFIED）"));
		// A can finish in the background while B remains the visible runtime.
		a.observe(status("已取消（AGENT_ABORTED）"));
		assert.equal(a.snapshot()[0].statusText, "已取消（AGENT_ABORTED）");
		assert.equal(b.snapshot()[0].statusText, "候选任务已完成（STOP_VERIFIED）");
		for (const method of ["confirm", "notify", "set_editor_text"]) a.observe({ ...status("must not replay"), method });
		a.observe(status("control metadata", "pi-desktop-context-budget"));
		a.observe(status("control metadata", "pi-desktop-session-title"));
		assert.equal(a.snapshot().length, 1);
		const copy = a.snapshot(); copy[0].statusText = "mutated";
		assert.equal(a.snapshot()[0].statusText, "已取消（AGENT_ABORTED）");
		a.observe(status()); assert.deepEqual(a.snapshot(), [], "clear event remains cleared after switching");
		b.clear(); assert.deepEqual(b.snapshot(), [], "new process or session cannot inherit previous status");
		b.observe(status("cold restored")); assert.equal(b.snapshot()[0].statusText, "cold restored");
	});
	await runCase("SESSION-UI-06 status cache is bounded and wired after projection reset", async () => {
		const cache = new RuntimeStatusCache();
		for (let i = 0; i < 40; i++) cache.observe({ type: "extension_ui_request", method: "setStatus", statusKey: String(i), statusText: String(i) });
		assert.equal(cache.snapshot().length, 32); assert.equal(cache.snapshot()[0].statusKey, "8");
		cache.observe({ type: "extension_ui_request", method: "setStatus", statusKey: "39", statusText: "x".repeat(16_385) });
		assert.equal(cache.snapshot().length, 31);
		const main = await readFile("src/main.ts", "utf8");
		assert.match(main, /runtime\.extensionStatuses\.observe\(event\)/);
		assert.match(main, /chatView\.prepareForSessionSwitch\([\s\S]*?restoreSessionStatus\(bindingRuntime\?\.extensionStatuses\.snapshot\(\)/);
		assert.match(main, /if \(!bridge\.isConnected\) \{\s*runtime.phase = "starting";[\s\S]*?runtime\.extensionStatuses\.clear\(\);/);
	});
	await runCase("SESSION-UI-01 late responses across A B A", () => {
		const scope = new SessionRefreshScope();
		let identity = "runtime-a:1:1";
		const oldA = scope.capture(identity, () => identity);
		assert.equal(oldA(), true);
		scope.invalidate();
		identity = "runtime-b:1:2";
		const b = scope.capture(identity, () => identity);
		assert.equal(oldA(), false);
		scope.invalidate();
		identity = "runtime-a:1:1";
		assert.equal(oldA(), false, "returning to A cannot revive A's old async response");
		assert.equal(b(), false);
		assert.equal(scope.capture(identity, () => identity)(), true);
	});
	await runCase("SESSION-UI-02 restart invalidates same instance", () => {
		const scope = new SessionRefreshScope();
		let identity = "runtime-a:1:1";
		const previous = scope.capture(identity, () => identity);
		identity = "runtime-a:2:3";
		assert.equal(previous(), false);
		const current = scope.capture(identity, () => identity);
		scope.invalidate();
		assert.equal(current(), false, "explicit UI reset or disconnect must fence in-flight data");
	});
	await runCase("SESSION-UI-03 activation does not await ancillary CLIs", async () => {
		const main = await readFile("src/main.ts", "utf8");
		for (const [start, end] of [
			["async function ensureRuntimeForSessionTabImpl", "async function ensureRpcForProject"],
			["const activateSidebarSession =", "const stageNovelAgentTask ="],
			["contentTabsBar.setOnSelect(", "contentTabsBar.setOnOpenTerminal("],
		]) {
			const from = main.indexOf(start);
			const to = main.indexOf(end, from);
			assert.ok(from >= 0 && to > from);
			const body = main.slice(from, to);
			assert.doesNotMatch(body, /await (?:refreshCliUpdateStatus|chatView\?\.refreshModels)\(/);
		}
		assert.match(main, /await startSessionTab\(bridge,/);
		assert.match(main, /PI_DESKTOP_SESSION_TITLE: "1"/);
		assert.match(main, /PI_DESKTOP_NOVEL_ROLE: requestedNovelRole \?\? ""/);
		assert.match(main, /const novelRoleChanged = runtime\.launchedNovelRole !== requestedNovelRole/);
		assert.match(main, /if \(\(projectChanged \|\| novelRoleChanged\) && bridge\.isConnected\)/);
		assert.match(main, /runtime\.launchedNovelRole = requestedNovelRole/);
		assert.match(main, /await ensureSessionTitleExtensionInstalled\(\)/);
		assert.match(main, /if \(err instanceof StaleProjectTaskError\) \{[\s\S]*?runtime.phase = "idle"/);
	});
	await runCase("SESSION-UI-04 history picker delegates to workspace navigation", () => {
		const browser = Object.create(SessionBrowser.prototype) as {
			setOnOpenSession: SessionBrowser["setOnOpenSession"];
			selectSession: (session: { path: string; cwd: string; name: string }) => void;
			close: () => void;
		};
		let closed = 0;
		let received: unknown;
		browser.close = () => { closed += 1; };
		const session = { path: "B/history.jsonl", cwd: "B", name: "项目 B" };
		browser.setOnOpenSession((selected) => { received = selected; return true; });
		browser.selectSession(session);
		assert.equal(received, session);
		assert.equal(closed, 1);
		browser.setOnOpenSession(() => false);
		browser.selectSession(session);
		assert.equal(closed, 1, "unavailable project stays open rather than mutating the active runtime");
	});
}
