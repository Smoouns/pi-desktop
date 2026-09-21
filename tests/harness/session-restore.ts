import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { RpcBridge, RpcRequestError, SessionFileMissingError } from "../../src/rpc/bridge.js";
import { restoreSessionTab, startSessionTab } from "../../src/rpc/session-restore.js";
import { rpcSetInvokeHandler } from "../support/rpc-tauri-core.js";
import { rpcEmit, rpcResetEventMock } from "../support/rpc-tauri-event.js";
import { withProject, type RunCase } from "./testkit.js";

// Tauri's header inspector is covered by Rust tests. This adapter connects the
// production bridge/restore policy to the real pinned SDK's session persistence.
async function withRuntime(root: string, body: (bridge: RpcBridge, manager: SessionManager, sent: string[]) => Promise<void>): Promise<void> {
	if (!("window" in globalThis)) Object.assign(globalThis, { window: globalThis });
	rpcResetEventMock();
	const manager = SessionManager.create(root, path.join(root, "test-sessions"));
	const sent: string[] = [];
	rpcSetInvokeHandler(async (command, args) => {
		if (command === "rpc_start") return { discovery: "synthetic", generation: 1 };
		if (command === "rpc_stop") return;
		if (command === "get_session_file_status") {
			let content: string;
			try { content = await readFile(String(args?.sessionPath), "utf8"); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
				throw error;
			}
			const header = JSON.parse(content.trim().split("\n")[0]);
			assert.equal(header.type, "session");
			assert.ok(typeof header.id === "string" && header.id.trim());
			return { status: "valid", session_id: header.id };
		}
		if (command === "rpc_send") {
			const request = JSON.parse(String(args?.command));
			sent.push(request.type);
			if (request.type === "switch_session") manager.setSessionFile(request.sessionPath);
			else if (request.type === "new_session") manager.newSession();
			else if (request.type === "get_state") { /* read-only identity check below */ }
			else throw new Error(`Unexpected RPC: ${request.type}`);
			rpcEmit("rpc-event", { instance_id: "restore-test", generation: 1, line: JSON.stringify({
				type: "response", id: request.id, success: true,
				data: request.type === "get_state" ? { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile() } : { cancelled: false },
			}) });
			return;
		}
		throw new Error(`Unexpected invoke: ${command}`);
	});
	const bridge = new RpcBridge("restore-test");
	try {
		await bridge.start({ cwd: root, cliPath: null });
		await body(bridge, manager, sent);
	} finally { await bridge.teardownListeners(); }
}

export async function runSessionRestoreCases(runCase: RunCase): Promise<void> {
	await runCase("SESSION-RESTORE-01 missing empty draft gets matching filename and identity", (record) => withProject(async (root) => {
		const draft = SessionManager.create(root, path.join(root, "test-sessions"));
		const oldPath = draft.getSessionFile()!;
		assert.equal(existsSync(oldPath), false);
		// Reproduce the SDK behavior behind the bug, without writing any file.
		const unsafe = SessionManager.open(oldPath);
		assert.notEqual(unsafe.getSessionId(), draft.getSessionId());
		assert.equal(unsafe.getSessionFile(), oldPath);
		await withRuntime(root, async (bridge, manager, sent) => {
			const result = await restoreSessionTab(bridge, { sessionPath: oldPath, ephemeral: true, messageCount: 0 });
			assert.deepEqual(result, { cancelled: false, replacedMissingDraft: true });
			assert.deepEqual(sent, ["new_session"]);
			const newPath = manager.getSessionFile()!;
			assert.notEqual(newPath, oldPath);
			assert.ok(path.basename(newPath).endsWith(`_${manager.getSessionId()}.jsonl`));
			manager.appendMessage({ role: "user", content: "synthetic", timestamp: 0 });
			assert.equal(existsSync(newPath), false);
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "synthetic" }],
				api: "openai-completions", provider: "synthetic", model: "scripted", timestamp: 0,
				stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			});
			const persisted = await readFile(newPath, "utf8");
			assert.equal(JSON.parse(persisted.split("\n")[0]).id, manager.getSessionId());
			assert.equal(existsSync(oldPath), false);
			const id = manager.getSessionId();
			manager.newSession();
			await bridge.switchSession(newPath);
			assert.equal(manager.getSessionId(), id);
			assert.equal(await readFile(newPath, "utf8"), persisted);
			record("session.restored", { recreatedEmptyDraft: true, stalePathWritten: false, persistedIdentityMatches: true });
		});
	}));

	await runCase("SESSION-RESTORE-02 missing history and malformed headers fail closed", (record) => withProject(async (root) => {
		await withRuntime(root, async (bridge, _manager, sent) => {
			const missing = path.join(root, "missing.jsonl");
			for (const metadata of [
				{ ephemeral: false, messageCount: 0 }, { ephemeral: true, messageCount: 1 },
				{ ephemeral: true, messageCount: null }, { ephemeral: false, messageCount: 8 },
			]) await assert.rejects(restoreSessionTab(bridge, { sessionPath: missing, ...metadata }), SessionFileMissingError);
			for (const content of ["", "not-json", '{"type":"message","id":"wrong"}', '{"type":"session","id":""}']) {
				const corrupted = path.join(root, "corrupt.jsonl");
				await writeFile(corrupted, content);
				await assert.rejects(restoreSessionTab(bridge, { sessionPath: corrupted, ephemeral: true, messageCount: 0 }));
				assert.equal(await readFile(corrupted, "utf8"), content);
			}
			assert.deepEqual(sent, []);
			record("session.blocked", { checkedMissingVariants: 4, checkedInvalidVariants: 4, mutatingRpcSent: 0 });
		});
	}));

	await runCase("SESSION-RESTORE-03 legacy filename mismatch keeps authoritative header and bytes", (record) => withProject(async (root) => {
		await withRuntime(root, async (bridge, manager, sent) => {
			const legacy = path.join(root, "legacy-filename-id.jsonl");
			const content = JSON.stringify({ type: "session", version: 3, id: "actual-header-id", timestamp: "2026-01-01T00:00:00Z", cwd: root }) + "\n";
			await writeFile(legacy, content);
			const result = await restoreSessionTab(bridge, { sessionPath: legacy, ephemeral: false, messageCount: null });
			assert.deepEqual(result, { cancelled: false, replacedMissingDraft: false });
			assert.deepEqual(sent, ["switch_session", "get_state"]);
			assert.equal(manager.getSessionId(), "actual-header-id");
			assert.equal(manager.getSessionFile(), legacy);
			assert.equal(await readFile(legacy, "utf8"), content);
			record("session.legacy", { headerAuthoritative: true, bytesUnchanged: true });
		});
	}));

	await runCase("SESSION-RESTORE-04 cancellation and unknown outcomes do not retry mutations", async (record) => {
		let created = 0;
		const bridge = {
			switchSession: async () => { throw new SessionFileMissingError("missing", 1, 1); },
			newSession: async () => { created++; return { cancelled: true }; },
		};
		const tab = { sessionPath: "missing", ephemeral: true, messageCount: 0 };
		assert.deepEqual(await restoreSessionTab(bridge, tab), { cancelled: true, replacedMissingDraft: false });
		assert.equal(created, 1);
		bridge.switchSession = async () => { throw new RpcRequestError("unknown_outcome", "switch_session", "lost ack"); };
		await assert.rejects(restoreSessionTab(bridge, tab), RpcRequestError);
		assert.equal(created, 1);
		record("session.cancelled", { createdOnce: true, unknownNotReplayed: true });
	});

	await runCase("SESSION-RESTORE-05 changed identity after inspection stops the runtime", async (record) => {
		rpcResetEventMock();
		let stopped = false;
		let stoppedGeneration: number | null = null;
		const sent: string[] = [];
		rpcSetInvokeHandler((command, args) => {
			if (command === "rpc_start") return { discovery: "synthetic", generation: 1 };
			if (command === "get_session_file_status") return { status: "valid", session_id: "expected" };
			if (command === "rpc_stop") {
				stopped = true;
				stoppedGeneration = Number(args?.expectedGeneration);
				return true;
			}
			if (command !== "rpc_send") throw new Error(`Unexpected invoke: ${command}`);
			const request = JSON.parse(String(args?.command));
			sent.push(request.type);
			rpcEmit("rpc-event", { instance_id: "restore-race", generation: 1, line: JSON.stringify({
				type: "response", id: request.id, success: true,
				data: request.type === "get_state" ? { sessionId: "unexpected-new-identity" } : { cancelled: false },
			}) });
		});
		const bridge = new RpcBridge("restore-race");
		try {
			await bridge.start({ cwd: "synthetic", cliPath: null });
			await assert.rejects(restoreSessionTab(bridge, { sessionPath: "history.jsonl", ephemeral: true, messageCount: 0 }),
				(error) => error instanceof RpcRequestError && error.kind === "fatal");
			assert.equal(stopped, true);
			assert.equal(stoppedGeneration, 1);
			assert.equal(bridge.isConnected, false);
			assert.deepEqual(sent, ["switch_session", "get_state"]);
			record("session.identity_changed", { stopped: true, newSessionSent: false });
		} finally { await bridge.teardownListeners(); }
	});

	await runCase("SESSION-RESTORE-06 restarted runtime cannot receive a stale inspection", async (record) => {
		rpcResetEventMock();
		let finishInspection!: (value: { status: "valid"; session_id: string }) => void;
		let generation = 0;
		let sent = 0;
		rpcSetInvokeHandler((command) => {
			if (command === "rpc_start") return { discovery: "synthetic", generation: ++generation };
			if (command === "get_session_file_status") return new Promise((resolve) => { finishInspection = resolve; });
			if (command === "rpc_send") { sent++; throw new Error("Stale switch must not dispatch"); }
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("restore-epoch");
		try {
			await bridge.start({ cwd: "synthetic-a", cliPath: null });
			const pending = bridge.switchSession("history.jsonl");
			await bridge.start({ cwd: "synthetic-b", cliPath: null });
			finishInspection({ status: "valid", session_id: "old-session" });
			await assert.rejects(pending, (error) => error instanceof RpcRequestError && error.kind === "cancelled");
			assert.equal(sent, 0);
			record("session.inspection_stale", { mutatingRpcSent: 0 });
		} finally { await bridge.teardownListeners(); }
	});

	await runCase("SESSION-RESTORE-07 restarted runtime survives stale post-switch reconciliation", async (record) => {
		rpcResetEventMock();
		let generation = 0;
		let stopCalls = 0;
		let getStateDispatched!: () => void;
		const stateDispatched = new Promise<void>((resolve) => { getStateDispatched = resolve; });
		rpcSetInvokeHandler((command, args) => {
			if (command === "rpc_start") return { discovery: "synthetic", generation: ++generation };
			if (command === "get_session_file_status") return { status: "valid", session_id: "expected" };
			if (command === "rpc_stop") { stopCalls++; return true; }
			if (command !== "rpc_send") throw new Error(`Unexpected invoke: ${command}`);
			const request = JSON.parse(String(args?.command));
			if (request.type === "switch_session") {
				rpcEmit("rpc-event", { instance_id: "restore-post-switch", generation: 1, line: JSON.stringify({
					type: "response", id: request.id, success: true, data: { cancelled: false },
				}) });
				return;
			}
			if (request.type === "get_state") {
				getStateDispatched();
				return;
			}
			throw new Error(`Unexpected RPC: ${request.type}`);
		});
		const bridge = new RpcBridge("restore-post-switch");
		try {
			await bridge.start({ cwd: "synthetic-a", cliPath: null });
			const pending = bridge.switchSession("history.jsonl");
			await stateDispatched;
			await bridge.start({ cwd: "synthetic-b", cliPath: null });
			await assert.rejects(pending, (error) => error instanceof RpcRequestError && error.kind !== "fatal");
			assert.equal(stopCalls, 0);
			assert.equal(bridge.isConnected, true);
			record("session.reconcile_stale", { newerGenerationConnected: true, stopCalls: 0 });
		} finally { await bridge.teardownListeners(); }
	});

	await runCase("SESSION-RESTORE-08 missing catch cannot create a session on a newer runtime", async (record) => {
		rpcResetEventMock();
		let generation = 0;
		let sent = 0;
		rpcSetInvokeHandler((command) => {
			if (command === "rpc_start") return { discovery: "synthetic", generation: ++generation };
			if (command === "get_session_file_status") return { status: "missing" };
			if (command === "rpc_send") { sent++; throw new Error("Stale draft replacement must not dispatch"); }
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("restore-missing-epoch");
		try {
			await bridge.start({ cwd: "synthetic-a", cliPath: null });
			const guarded = {
				switchSession: async (sessionPath: string, options = {}) => {
					try { return await bridge.switchSession(sessionPath, options); }
					catch (error) {
						if (error instanceof SessionFileMissingError) {
							await bridge.start({ cwd: "synthetic-b", cliPath: null });
						}
						throw error;
					}
				},
				newSession: bridge.newSession.bind(bridge),
			};
			await assert.rejects(
				restoreSessionTab(guarded, { sessionPath: "missing.jsonl", ephemeral: true, messageCount: 0 }),
				(error) => error instanceof RpcRequestError && error.kind === "cancelled",
			);
			assert.equal(sent, 0);
			assert.equal(bridge.isConnected, true);
			record("session.missing_stale", { newSessionSent: false, newerGenerationConnected: true });
		} finally { await bridge.teardownListeners(); }
	});

	await runCase("SESSION-RESTORE-09 late scoped-stop result cannot disconnect a newer runtime", async (record) => {
		rpcResetEventMock();
		let generation = 0;
		let finishStop!: (stopped: boolean) => void;
		let stopExpectedGeneration: number | null = null;
		let stopStarted!: () => void;
		const stopWasStarted = new Promise<void>((resolve) => { stopStarted = resolve; });
		rpcSetInvokeHandler((command, args) => {
			if (command === "rpc_start") return { discovery: "synthetic", generation: ++generation };
			if (command === "get_session_file_status") return { status: "valid", session_id: "expected" };
			if (command === "rpc_stop") {
				stopExpectedGeneration = Number(args?.expectedGeneration);
				stopStarted();
				return new Promise((resolve) => { finishStop = resolve; });
			}
			if (command !== "rpc_send") throw new Error(`Unexpected invoke: ${command}`);
			const request = JSON.parse(String(args?.command));
			rpcEmit("rpc-event", { instance_id: "restore-stop-race", generation: 1, line: JSON.stringify({
				type: "response", id: request.id, success: true,
				data: request.type === "get_state" ? { sessionId: "unexpected" } : { cancelled: false },
			}) });
		});
		const bridge = new RpcBridge("restore-stop-race");
		try {
			await bridge.start({ cwd: "synthetic-a", cliPath: null });
			const pending = bridge.switchSession("history.jsonl");
			await stopWasStarted;
			assert.equal(stopExpectedGeneration, 1);
			await bridge.start({ cwd: "synthetic-b", cliPath: null });
			finishStop(true);
			await assert.rejects(pending, (error) => error instanceof RpcRequestError && error.kind === "fatal");
			assert.equal(bridge.isConnected, true);
			record("session.stop_stale", { expectedGeneration: 1, newerGenerationConnected: true });
		} finally { await bridge.teardownListeners(); }
	});

	await runCase("SESSION-RESTORE-10 cold start restores one exact validated session", async (record) => {
		rpcResetEventMock();
		const calls: string[] = [];
		let startSessionPath: unknown = null;
		rpcSetInvokeHandler((command, args) => {
			calls.push(command);
			if (command === "get_session_file_status") return { status: "valid", session_id: "cold-id" };
			if (command === "rpc_start") {
				startSessionPath = (args?.options as Record<string, unknown>)?.session_path;
				return { discovery: "synthetic", generation: 7 };
			}
			if (command !== "rpc_send") throw new Error(`Unexpected invoke: ${command}`);
			const request = JSON.parse(String(args?.command));
			assert.equal(request.type, "get_state");
			rpcEmit("rpc-event", { instance_id: "cold-start", generation: 7, line: JSON.stringify({
				type: "response", id: request.id, success: true,
				data: { sessionId: "cold-id", sessionFile: "history.jsonl" },
			}) });
		});
		const bridge = new RpcBridge("cold-start");
		try {
			await bridge.start({ cwd: "synthetic", cliPath: null, sessionPath: "history.jsonl" });
			assert.equal(startSessionPath, "history.jsonl");
			assert.equal(bridge.isConnected, true);
			assert.match(bridge.getRuntimeIdentity(), /^cold-start:1:7$/);
			assert.deepEqual(calls, ["get_session_file_status", "rpc_start", "rpc_send"]);
			record("session.cold_start", { inspectedBeforeSpawn: true, startupSessionArg: true, identityChecked: true });
		} finally { await bridge.teardownListeners(); }
	});

	await runCase("SESSION-RESTORE-11 cold start missing or corrupt history never spawns", async (record) => {
		for (const result of [{ status: "missing" }, new Error("invalid session header")]) {
			rpcResetEventMock();
			let spawned = 0;
			rpcSetInvokeHandler((command) => {
				if (command === "get_session_file_status") {
					if (result instanceof Error) throw result;
					return result;
				}
				if (command === "rpc_start") { spawned++; return { discovery: "synthetic", generation: 1 }; }
				throw new Error(`Unexpected invoke: ${command}`);
			});
			const bridge = new RpcBridge("cold-reject");
			try {
				await assert.rejects(bridge.start({ cwd: "synthetic", cliPath: null, sessionPath: "bad.jsonl" }));
				assert.equal(spawned, 0);
				assert.equal(bridge.isConnected, false);
			} finally { await bridge.teardownListeners(); }
		}
		record("session.cold_reject", { checkedMissing: true, checkedCorrupt: true, spawned: 0 });
	});

	await runCase("SESSION-RESTORE-12 cold start identity mismatch stops only its generation", async (record) => {
		rpcResetEventMock();
		let stoppedGeneration: number | null = null;
		rpcSetInvokeHandler((command, args) => {
			if (command === "get_session_file_status") return { status: "valid", session_id: "expected" };
			if (command === "rpc_start") return { discovery: "synthetic", generation: 9 };
			if (command === "rpc_stop") { stoppedGeneration = Number(args?.expectedGeneration); return true; }
			if (command !== "rpc_send") throw new Error(`Unexpected invoke: ${command}`);
			const request = JSON.parse(String(args?.command));
			rpcEmit("rpc-event", { instance_id: "cold-mismatch", generation: 9, line: JSON.stringify({
				type: "response", id: request.id, success: true, data: { sessionId: "other" },
			}) });
		});
		const bridge = new RpcBridge("cold-mismatch");
		try {
			await assert.rejects(bridge.start({ cwd: "synthetic", cliPath: null, sessionPath: "history.jsonl" }),
				(error) => error instanceof RpcRequestError && error.kind === "fatal");
			assert.equal(stoppedGeneration, 9);
			assert.equal(bridge.isConnected, false);
			record("session.cold_mismatch", { stoppedGeneration: 9 });
		} finally { await bridge.teardownListeners(); }
	});

	await runCase("SESSION-RESTORE-13 superseded cold inspection cannot spawn", async (record) => {
		rpcResetEventMock();
		let resolveInspection!: (value: { status: "valid"; session_id: string }) => void;
		let firstInspection = true;
		let spawned = 0;
		rpcSetInvokeHandler((command) => {
			if (command === "get_session_file_status" && firstInspection) {
				firstInspection = false;
				return new Promise((resolve) => { resolveInspection = resolve; });
			}
			if (command === "rpc_start") { spawned++; return { discovery: "synthetic", generation: spawned }; }
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("cold-stale");
		try {
			const stale = bridge.start({ cwd: "synthetic-a", cliPath: null, sessionPath: "old.jsonl" });
			await bridge.start({ cwd: "synthetic-b", cliPath: null });
			resolveInspection({ status: "valid", session_id: "old" });
			await assert.rejects(stale, (error) => error instanceof RpcRequestError && error.kind === "cancelled");
			assert.equal(spawned, 1);
			assert.equal(bridge.isConnected, true);
			record("session.cold_stale", { staleSpawned: false, newerConnected: true });
		} finally { await bridge.teardownListeners(); }
	});

	await runCase("SESSION-RESTORE-14 cold helper replaces only a known empty draft", async (record) => {
		rpcResetEventMock();
		let spawned = 0;
		rpcSetInvokeHandler((command, args) => {
			if (command === "get_session_file_status") return { status: "missing" };
			if (command === "rpc_start") {
				spawned++;
				assert.equal((args?.options as Record<string, unknown>)?.session_path, null);
				return { discovery: "fresh-draft", generation: 4 };
			}
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("cold-helper-empty");
		try {
			const result = await startSessionTab(bridge, { cwd: "synthetic", cliPath: null }, {
				sessionPath: "missing.jsonl", ephemeral: true, messageCount: 0,
			});
			assert.deepEqual(result, { discovery: "fresh-draft", replacedMissingDraft: true });
			assert.equal(spawned, 1);
			record("session.cold_helper_empty", { inspectedExactPath: true, replacementStarts: 1, newSessionRpc: 0 });
		} finally { await bridge.teardownListeners(); }
	});

	await runCase("SESSION-RESTORE-15 cold helper fails closed for non-empty or uncertain history", async (record) => {
		for (const metadata of [
			{ ephemeral: false, messageCount: 0 }, { ephemeral: true, messageCount: 1 },
			{ ephemeral: true, messageCount: null },
		]) {
			rpcResetEventMock();
			let spawned = 0;
			rpcSetInvokeHandler((command) => {
				if (command === "get_session_file_status") return { status: "missing" };
				if (command === "rpc_start") { spawned++; return { discovery: "unsafe", generation: 1 }; }
				throw new Error(`Unexpected invoke: ${command}`);
			});
			const bridge = new RpcBridge("cold-helper-closed");
			try {
				await assert.rejects(startSessionTab(bridge, { cwd: "synthetic", cliPath: null }, {
					sessionPath: "missing.jsonl", ...metadata,
				}), SessionFileMissingError);
				assert.equal(spawned, 0);
			} finally { await bridge.teardownListeners(); }
		}
		record("session.cold_helper_closed", { variants: 3, replacementStarts: 0 });
	});

	await runCase("SESSION-RESTORE-16 stale task cannot start missing-draft replacement", async (record) => {
		rpcResetEventMock();
		let spawned = 0;
		rpcSetInvokeHandler((command) => {
			if (command === "get_session_file_status") return { status: "missing" };
			if (command === "rpc_start") { spawned++; return { discovery: "unsafe", generation: 1 }; }
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("cold-helper-stale");
		try {
			await assert.rejects(startSessionTab(
				bridge,
				{ cwd: "synthetic", cliPath: null },
				{ sessionPath: "missing.jsonl", ephemeral: true, messageCount: 0 },
				() => { throw new Error("stale task"); },
			), /stale task/);
			assert.equal(spawned, 0);
			record("session.cold_helper_stale", { replacementStarts: 0 });
		} finally { await bridge.teardownListeners(); }
	});

	await runCase("SESSION-RESTORE-17 newer start between missing error and catch wins", async (record) => {
		rpcResetEventMock();
		let spawned = 0;
		rpcSetInvokeHandler((command) => {
			if (command === "get_session_file_status") return { status: "missing" };
			if (command === "rpc_start") { spawned++; return { discovery: "newer", generation: spawned }; }
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("cold-helper-race");
		let newerStart: Promise<string> | null = null;
		try {
			await assert.rejects(startSessionTab(
				bridge,
				{ cwd: "synthetic-old", cliPath: null },
				{ sessionPath: "missing.jsonl", ephemeral: true, messageCount: 0 },
				() => { newerStart ??= bridge.start({ cwd: "synthetic-new", cliPath: null }); },
			), (error) => error instanceof RpcRequestError && error.kind === "cancelled");
			await newerStart;
			assert.equal(spawned, 1);
			assert.equal(bridge.isConnected, true);
			record("session.cold_helper_race", { staleReplacementStarts: 0, newerStarts: 1 });
		} finally { await bridge.teardownListeners(); }
	});
}
