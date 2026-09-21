import assert from "node:assert/strict";
import { createTraceRecorder } from "../../src/harness/trace.js";
import { RpcBridge, RpcRequestError, type RpcBridgeDiagnosticEvent } from "../../src/rpc/bridge.js";
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

	await runCase("RPC-02 pending generation rejects generation-less events after handshake", async (record) => {
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
		assert.deepEqual(received.map((event) => event.type), ["rpc_connected"]);
		assert.ok(secondStartGate.resolve);
		secondStartGate.resolve({ discovery: "second", generation: 2 });
		await secondStart;
		record("rpc.start.completed", { currentGeneration: 2, pendingGeneration: null });
		assert.equal(bridge.isConnected, true);
		rpcEmit("rpc-stderr", { instance_id: "pending", line: "Error: invalid api key" });
		rpcEmit("rpc-closed", { instance_id: "pending", reason: "legacy closed" });
		assert.equal(bridge.isConnected, true);
		assert.deepEqual(received.map((event) => event.type), ["rpc_connected", "rpc_connected"]);
		assert.deepEqual(diagnostics.map((item) => [item.type, item.reason]), [
			["discarded_event", "generation_mismatch"],
			["discarded_event", "missing_generation"],
			["discarded_event", "missing_generation"],
			["discarded_event", "missing_generation"],
		]);
		record("rpc.pending_generation", { missingGenerationRejected: true, staleDiscarded: true });
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
			await assert.rejects(pending, (error: unknown) =>
				error instanceof RpcRequestError && error.kind === "transient" && error.command === "get_state");
			record("rpc.pending.timed_out", { currentGeneration: 1, pendingRequests: 0 });
			rpcEmit("rpc-event", {
				instance_id: "timeout",
				generation: 1,
				line: eventLine({ type: "response", id: requestId, success: true, data: { late: true } }),
			});
			assert.deepEqual(received.map((event) => event.type), ["rpc_connected"]);
			assert.deepEqual(diagnostics.map((item) => [item.type, item.reason, item.requestId]), [
				["unmatched_response", "no_pending_request", requestId],
			]);
			record("rpc.late_response", { deliveredAsEvent: false, pendingResolved: false });
			await bridge.teardownListeners();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	}, { generation: 1, role: null });

	await runCase("RPC-03 abort signal cancels a pending read", async (record) => {
		rpcResetEventMock();
		rpcSetInvokeHandler((command) => {
			if (command === "rpc_start") return { discovery: "mock", generation: 1 };
			if (command === "rpc_send") return undefined;
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("abort");
		await bridge.start({ cwd: "C:/fixture", cliPath: null });
		const controller = new AbortController();
		const pending = bridge.getState({ signal: controller.signal });
		await flushMicrotasks();
		controller.abort();
		await assert.rejects(pending, (error: unknown) =>
			error instanceof RpcRequestError && error.kind === "cancelled");
		record("rpc.pending.cancelled", { kind: "cancelled" });
		await bridge.teardownListeners();
	}, { generation: 1, role: null });

	await runCase("RPC-03 mutating deadline reports unknown outcome", async (record) => {
		rpcResetEventMock();
		const timers: Array<() => void> = [];
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		(globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((callback: () => void) => {
			timers.push(callback);
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		(globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = (() => undefined) as typeof clearTimeout;
		try {
			rpcSetInvokeHandler((command) => {
				if (command === "rpc_start") return { discovery: "mock", generation: 1 };
				if (command === "rpc_send") return undefined;
				throw new Error(`Unexpected invoke: ${command}`);
			});
			const bridge = new RpcBridge("write-timeout");
			await bridge.start({ cwd: "C:/fixture", cliPath: null });
			const pending = bridge.prompt("hello", { deadlineMs: 250 });
			await flushMicrotasks();
			assert.equal(timers.length, 1);
			timers[0]();
			await assert.rejects(pending, (error: unknown) =>
				error instanceof RpcRequestError && error.kind === "unknown_outcome" && error.command === "prompt");
			record("rpc.pending.ambiguous", { kind: "unknown_outcome", deadlineMs: 250 });
			await bridge.teardownListeners();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	}, { generation: 1, role: null });

	await runCase("RPC-03 mutating abort and send failure remain unknown", async (record) => {
		rpcResetEventMock();
		let sendMode: "ok" | "fail" = "ok";
		let sendCount = 0;
		rpcSetInvokeHandler((command) => {
			if (command === "rpc_start") return { discovery: "mock", generation: 1 };
			if (command === "rpc_send") {
				sendCount += 1;
				if (sendMode === "fail") throw new Error("partial stdin write");
				return undefined;
			}
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("ambiguous");
		await bridge.start({ cwd: "C:/fixture", cliPath: null });
		const controller = new AbortController();
		const aborted = bridge.prompt("hello", { signal: controller.signal });
		await flushMicrotasks();
		controller.abort();
		await assert.rejects(aborted, (error: unknown) =>
			error instanceof RpcRequestError && error.kind === "unknown_outcome" && error.command === "prompt");
		sendMode = "fail";
		await assert.rejects(bridge.prompt("again"), (error: unknown) =>
			error instanceof RpcRequestError && error.kind === "unknown_outcome" && error.command === "prompt");
		const beforeExpired = sendCount;
		await assert.rejects(bridge.prompt("expired", { deadlineMs: 0 }), (error: unknown) =>
			error instanceof RpcRequestError && error.kind === "cancelled");
		assert.equal(sendCount, beforeExpired, "Expired deadline must not dispatch");
		record("rpc.mutation_ambiguous", { abort: "unknown_outcome", sendFailure: "unknown_outcome", expiredDispatched: false });
		await bridge.teardownListeners();
	}, { generation: 1, role: null });

	await runCase("RPC-03 failed prompt response is typed", async (record) => {
		rpcResetEventMock();
		let requestId = "";
		rpcSetInvokeHandler((command, args) => {
			if (command === "rpc_start") return { discovery: "mock", generation: 1 };
			if (command === "rpc_send") {
				requestId = String((JSON.parse(String(args?.command)) as Record<string, unknown>).id);
				return undefined;
			}
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("failed-response");
		await bridge.start({ cwd: "C:/fixture", cliPath: null });
		const pending = bridge.prompt("hello");
		await flushMicrotasks();
		rpcEmit("rpc-event", { instance_id: "failed-response", generation: 1, line: eventLine({ type: "response", id: requestId, success: false, error: "provider rejected" }) });
		await assert.rejects(pending, (error: unknown) =>
			error instanceof RpcRequestError && error.kind === "fatal" && error.command === "prompt");
		record("rpc.failed_response", { kind: "fatal", command: "prompt" });
		await bridge.teardownListeners();
	}, { generation: 1, role: null });

	await runCase("RPC-04 concurrent start only binds newest ticket", async (record) => {
		rpcResetEventMock();
		const gates: Array<{ resolve: (value: { discovery: string; generation: number }) => void }> = [];
		rpcSetInvokeHandler((command) => {
			if (command !== "rpc_start") throw new Error(`Unexpected invoke: ${command}`);
			return new Promise((resolve) => gates.push({ resolve }));
		});
		const bridge = new RpcBridge("start-race");
		const received: Array<Record<string, unknown>> = [];
		bridge.onEvent((event) => received.push(event));
		const first = bridge.start({ cwd: "C:/fixture", cliPath: null });
		const firstRejected = assert.rejects(first, (error: unknown) =>
			error instanceof RpcRequestError && error.kind === "cancelled" && error.command === "rpc_start");
		for (let index = 0; index < 5 && gates.length < 1; index += 1) await flushMicrotasks();
		const second = bridge.start({ cwd: "C:/fixture", cliPath: null });
		for (let index = 0; index < 5 && gates.length < 2; index += 1) await flushMicrotasks();
		assert.equal(gates.length, 2);
		gates[1].resolve({ discovery: "new", generation: 2 });
		assert.equal(await second, "new");
		gates[0].resolve({ discovery: "old", generation: 1 });
		await firstRejected;
		rpcEmit("rpc-event", { instance_id: "start-race", generation: 1, line: eventLine({ type: "old" }) });
		rpcEmit("rpc-event", { instance_id: "start-race", generation: 2, line: eventLine({ type: "new" }) });
		assert.deepEqual(received.map((event) => event.type), ["rpc_connected", "new"]);
		record("rpc.start_race", { newestBound: true, oldDiscarded: true });
		await bridge.teardownListeners();
	}, { generation: 2, role: null });

	await runCase("RPC-04 stop fences events from a pending start", async (record) => {
		rpcResetEventMock();
		let resolveStart: ((value: { discovery: string; generation: number }) => void) | undefined;
		rpcSetInvokeHandler((command) => {
			if (command === "rpc_start") return new Promise((resolve) => { resolveStart = resolve; });
			if (command === "rpc_stop") return undefined;
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("stop-pending");
		const received: Array<Record<string, unknown>> = [];
		bridge.onEvent((event) => received.push(event));
		const starting = bridge.start({ cwd: "C:/fixture", cliPath: null });
		const startRejected = assert.rejects(starting, (error: unknown) =>
			error instanceof RpcRequestError && error.kind === "cancelled" && error.command === "rpc_start");
		for (let index = 0; index < 5 && !resolveStart; index += 1) await flushMicrotasks();
		await bridge.stop();
		rpcEmit("rpc-event", { instance_id: "stop-pending", generation: 1, line: eventLine({ type: "late_pending_start" }) });
		assert.deepEqual(received, []);
		assert.ok(resolveStart);
		resolveStart({ discovery: "old", generation: 1 });
		await startRejected;
		record("rpc.stop_pending_start", { lateEventDiscarded: true, startRejected: true });
		await bridge.teardownListeners();
	}, { generation: 1, role: null });

	await runCase("RPC-04 restart rejects old pending requests", async (record) => {
		rpcResetEventMock();
		let generation = 0;
		rpcSetInvokeHandler((command) => {
			if (command === "rpc_start") return { discovery: "mock", generation: ++generation };
			if (command === "rpc_send") return undefined;
			throw new Error(`Unexpected invoke: ${command}`);
		});
		const bridge = new RpcBridge("restart");
		await bridge.start({ cwd: "C:/fixture", cliPath: null });
		const pending = bridge.getState();
		await flushMicrotasks();
		await bridge.start({ cwd: "C:/fixture", cliPath: null });
		await assert.rejects(pending, (error: unknown) =>
			error instanceof RpcRequestError && error.kind === "cancelled");
		record("rpc.restart", { oldPendingRejected: true, generation });
		await bridge.teardownListeners();
	}, { generation: 2, role: null });

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
