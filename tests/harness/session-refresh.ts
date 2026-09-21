import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SessionRefreshScope } from "../../src/components/chat-view/session-refresh-scope.js";
import { SessionBrowser } from "../../src/components/session-browser.js";
import type { RunCase } from "./testkit.js";

export async function runSessionRefreshCases(runCase: RunCase): Promise<void> {
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
