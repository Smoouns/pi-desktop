import assert from "node:assert/strict";
import { createTraceRecorder } from "../../src/harness/trace.js";
import { RpcBridge, type RpcBridgeDiagnosticEvent } from "../../src/rpc/bridge.js";
import type { RunCase } from "./testkit.js";
import { rpcSetInvokeHandler } from "../support/rpc-tauri-core.js";
import { rpcEmit, rpcResetEventMock } from "../support/rpc-tauri-event.js";

function eventLine(value: Record<string, unknown>): string {
	return JSON.stringify(value);
}

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => queueMicrotask(resolve));
}

export async function runRpcCases(runCase: RunCase): Promise<void> {
	// The production tracer writes to an optional browser hook. The bridge itself
	// does not require a DOM; this minimal shim keeps the transport test in Node.
	if (!("window" in globalThis)) {
		Object.assign(globalThis, { window: globalThis });
	}
	await runCase("RPC-01/FI-03 filters stale generation and foreign instance events", async (record) => {
		rpcResetEventMock();
		const diagnostics: RpcBridgeDiagnosticEvent[] = [];
		const trace = createTraceRecorder({
			caseId: "RPC-01/FI-03",
			scope: { projectId: "project-a", sessionId: "session-a", runId: "run-a", generation: 2, role: "write" },
			now: () => 1_000,
		});
		const sent: Array<Record<string, unknown>> = [];
		rpcSetInvokeHandler((command, args) => {
			if (command === "rpc_start") return { discovery: "mock", generation: 2 };
			if (command === "rpc_send") {
				sent.push(JSON.parse(String(args?.command)) as Record<string, unknown>);
				return undefined;
			}
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("writer", (diagnostic) => {
			diagnostics.push(diagnostic);
			trace.record(diagnostic.type, {
				channel: diagnostic.channel,
				reason: diagnostic.reason,
				generation: diagnostic.generation,
			});
			record("rpc.diagnostic", {
				type: diagnostic.type,
				channel: diagnostic.channel,
				reason: diagnostic.reason,
				eventGeneration: diagnostic.generation,
				currentGeneration: 2,
			});
		});
		const received: Array<Record<string, unknown>> = [];
		bridge.onEvent((event) => received.push(event));
		await bridge.start({ cwd: "C:/fixture", cliPath: null });
		const pending = bridge.getState();
		await flushMicrotasks();
		assert.equal(sent.length, 1);
		const requestId = String(sent[0].id);
		record("rpc.pending.created", { currentGeneration: 2, pendingRequests: 1 });

		rpcEmit("rpc-event", { instance_id: "writer", generation: 1, line: eventLine({ type: "old_stdout" }) });
		rpcEmit("rpc-stderr", { instance_id: "writer", generation: 1, line: "Error: invalid api key" });
		rpcEmit("rpc-closed", { instance_id: "writer", generation: 1, reason: "old closed" });
		rpcEmit("rpc-event", { instance_id: "planner", generation: 2, line: eventLine({ type: "foreign" }) });
		assert.equal(bridge.isConnected, true);
		assert.deepEqual(received.map((event) => event.type), ["rpc_connected"]);

		rpcEmit("rpc-event", {
			instance_id: "writer",
			generation: 2,
			line: eventLine({ type: "response", id: requestId, success: true, data: { pendingMessageCount: 0 } }),
		});
		assert.deepEqual(await pending, { pendingMessageCount: 0 });
		record("rpc.pending.resolved", { currentGeneration: 2, pendingRequests: 0 });
		assert.equal(diagnostics.filter((item) => item.type === "discarded_event").length, 4);
		assert.deepEqual(diagnostics.map((item) => item.reason), [
			"generation_mismatch",
			"generation_mismatch",
			"generation_mismatch",
			"instance_mismatch",
		]);
		assert.deepEqual(trace.snapshot().map((item) => item.sequence), [1, 2, 3, 4]);
		record("rpc.discarded", { count: 4, currentConnected: bridge.isConnected });
		await bridge.teardownListeners();
	}, { generation: 2, role: null });

	await runCase("RPC-02 pending generation and legacy compatibility", async (record) => {
		rpcResetEventMock();
		const diagnostics: RpcBridgeDiagnosticEvent[] = [];
		const secondStartGate: {
			resolve?: (value: { discovery: string; generation: number }) => void;
		} = {};
		let startCount = 0;
		rpcSetInvokeHandler((command) => {
			if (command !== "rpc_start") throw new Error(`Unexpected invoke: ${command}`);
			startCount += 1;
			if (startCount === 1) return { discovery: "first", generation: 1 };
			return new Promise((resolve) => { secondStartGate.resolve = resolve; });
		});
		const bridge = new RpcBridge("pending", (diagnostic) => {
			diagnostics.push(diagnostic);
			record("rpc.diagnostic", {
				type: diagnostic.type,
				channel: diagnostic.channel,
				reason: diagnostic.reason,
				eventGeneration: diagnostic.generation,
				expectedGeneration: 2,
			});
		});
		const received: Array<Record<string, unknown>> = [];
		bridge.onEvent((event) => received.push(event));
		await bridge.start({ cwd: "C:/fixture", cliPath: null });
		const secondStart = bridge.start({ cwd: "C:/fixture", cliPath: null });
		await flushMicrotasks();
		record("rpc.start.pending", { previousGeneration: 1, pendingGeneration: 2 });
		rpcEmit("rpc-event", { instance_id: "pending", generation: 1, line: eventLine({ type: "old_during_start" }) });
		rpcEmit("rpc-event", { instance_id: "pending", line: eventLine({ type: "legacy_during_start" }) });
		assert.deepEqual(received.map((event) => event.type), ["rpc_connected", "legacy_during_start"]);
		assert.ok(secondStartGate.resolve);
		secondStartGate.resolve({ discovery: "second", generation: 2 });
		await secondStart;
		record("rpc.start.completed", { currentGeneration: 2, pendingGeneration: null });
		assert.equal(bridge.isConnected, true);
		rpcEmit("rpc-stderr", { instance_id: "pending", line: "Error: invalid api key" });
		rpcEmit("rpc-closed", { instance_id: "pending", reason: "legacy closed" });
		assert.equal(bridge.isConnected, false);
		assert.deepEqual(received.map((event) => event.type), [
			"rpc_connected",
			"legacy_during_start",
			"rpc_connected",
			"error",
			"rpc_disconnected",
		]);
		assert.deepEqual(diagnostics.map((item) => [item.type, item.reason]), [
			["discarded_event", "generation_mismatch"],
			["accepted_legacy_event", "missing_generation"],
			["accepted_legacy_event", "missing_generation"],
			["accepted_legacy_event", "missing_generation"],
		]);
		record("rpc.pending_generation", { legacyAccepted: true, staleDiscarded: true, legacyCloseDisconnects: true });
		await bridge.teardownListeners();
	}, { generation: 2, role: null });

	await runCase("RPC-02 timeout removes pending request and late response is observable", async (record) => {
		rpcResetEventMock();
		const diagnostics: RpcBridgeDiagnosticEvent[] = [];
		const timers: Array<() => void> = [];
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((callback: () => void) => {
			timers.push(callback);
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = (() => undefined) as typeof clearTimeout;
		try {
			let requestId = "";
			rpcSetInvokeHandler((command, args) => {
				if (command === "rpc_start") return { discovery: "mock", generation: 1 };
				if (command === "rpc_send") {
					requestId = String((JSON.parse(String(args?.command)) as Record<string, unknown>).id);
					return undefined;
				}
				throw new Error(`Unexpected invoke: ${command}`);
			});
			const bridge = new RpcBridge("timeout", (diagnostic) => {
				diagnostics.push(diagnostic);
				record("rpc.diagnostic", {
					type: diagnostic.type,
					channel: diagnostic.channel,
					reason: diagnostic.reason,
					eventGeneration: diagnostic.generation,
					currentGeneration: 1,
				});
			});
			const received: Array<Record<string, unknown>> = [];
			bridge.onEvent((event) => received.push(event));
			await bridge.start({ cwd: "C:/fixture", cliPath: null });
			const pending = bridge.getState();
			await flushMicrotasks();
			assert.equal(timers.length, 1);
			record("rpc.pending.created", { currentGeneration: 1, pendingRequests: 1, timeoutMs: 35_000 });
			timers[0]();
			await assert.rejects(pending, /Timeout waiting for response to get_state/);
			record("rpc.pending.timed_out", { currentGeneration: 1, pendingRequests: 0 });
			rpcEmit("rpc-event", {
				instance_id: "timeout",
				generation: 1,
				line: eventLine({ type: "response", id: requestId, success: true, data: { late: true } }),
			});
			assert.deepEqual(received.map((event) => event.type), ["rpc_connected", "response"]);
			assert.deepEqual(diagnostics.map((item) => [item.type, item.reason, item.requestId]), [
				["unmatched_response", "no_pending_request", requestId],
			]);
			record("rpc.late_response", { deliveredAsEvent: true, pendingResolved: false });
			await bridge.teardownListeners();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	}, { generation: 1, role: null });

	await runCase("RPC-01 diagnostic callback failures do not alter bridge filtering", async (record) => {
		rpcResetEventMock();
		rpcSetInvokeHandler((command) => {
			if (command === "rpc_start") return { discovery: "mock", generation: 2 };
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("diagnostic", () => {
			throw new Error("observer failed");
		});
		const received: Array<Record<string, unknown>> = [];
		bridge.onEvent((event) => received.push(event));
		await bridge.start({ cwd: "C:/fixture", cliPath: null });
		assert.doesNotThrow(() => {
			rpcEmit("rpc-event", { instance_id: "diagnostic", generation: 1, line: eventLine({ type: "stale" }) });
		});
		assert.deepEqual(received.map((event) => event.type), ["rpc_connected"]);
		assert.equal(bridge.isConnected, true);
		record("rpc.diagnostic_isolated", { staleStillDiscarded: true });
		await bridge.teardownListeners();
	}, { generation: 2, role: null });
}
