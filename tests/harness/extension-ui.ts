import assert from "node:assert/strict";
import { ExtensionUiHandler } from "../../src/components/extension-ui-handler.js";
import { extensionStatusSummary, type ExtensionStatusView } from "../../src/components/chat-view/extension-status-view.js";
import type { RunCase } from "./testkit.js";

type CapturedTemplate = { strings: readonly string[]; values: unknown[] };

function createWindowStub(): {
	window: Pick<Window, "addEventListener" | "removeEventListener">;
	dispatchEscape: () => void;
	listenerCount: () => number;
} {
	const listeners = new Set<EventListenerOrEventListenerObject>();
	return {
		window: {
			addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { listeners.add(listener); },
			removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => { listeners.delete(listener); },
		} as Pick<Window, "addEventListener" | "removeEventListener">,
		dispatchEscape: () => {
			const event = {
				key: "Escape",
				preventDefault: () => undefined,
				stopPropagation: () => undefined,
			} as KeyboardEvent;
			for (const listener of [...listeners]) {
				if (typeof listener === "function") listener(event);
				else listener.handleEvent(event);
			}
		},
		listenerCount: () => listeners.size,
	};
}

function createReadonlyDialogHarness(responseFails = false): {
	handler: ExtensionUiHandler;
	template: () => CapturedTemplate;
	responses: Array<{ id: string; data: Record<string, unknown> }>;
	closed: () => number;
	traces: string[];
} {
	const handler = Object.create(ExtensionUiHandler.prototype) as ExtensionUiHandler;
	let captured: CapturedTemplate | null = null;
	let closeCount = 0;
	const responses: Array<{ id: string; data: Record<string, unknown> }> = [];
	const traces: string[] = [];
	const internal = handler as unknown as Record<string, unknown>;
	internal.overlayContainer = {};
	internal.activeReadonlyDialogClose = null;
	internal.showOverlay = (value: CapturedTemplate) => { captured = value; };
	internal.closeOverlay = () => { closeCount += 1; };
	internal.sendResponse = async (id: string, data: Record<string, unknown>) => {
		responses.push({ id, data });
		if (responseFails) throw new Error("synthetic response failure");
	};
	internal.trace = (message: string) => { traces.push(message); };
	return {
		handler,
		template: () => {
			assert.ok(captured, "dialog template must be rendered");
			return captured;
		},
		responses,
		closed: () => closeCount,
		traces,
	};
}

function dialogCallbacks(template: CapturedTemplate): Array<(...args: unknown[]) => void> {
	return template.values.filter((value): value is (...args: unknown[]) => void => typeof value === "function");
}

export async function runExtensionUiCases(runCase: RunCase): Promise<void> {
	await runCase("UI-EXT-01 novel run status is a visible readonly dialog", async () => {
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		const stub = createWindowStub();
		Object.defineProperty(globalThis, "window", { configurable: true, value: stub.window });
		try {
			const harness = createReadonlyDialogHarness();
			const pending = harness.handler.handleRequest({
				id: "status-1",
				method: "confirm",
				title: "小说运行状态",
				message: "前置条件不足（MODEL_INPUT_BUDGET_EXCEEDED）。输入 345071，上限 128000。",
			});
			const template = harness.template();
			const markup = template.strings.join("");
			assert.match(markup, /role="dialog"/);
			assert.ok(template.values.includes("小说运行状态"));
			assert.match(markup, /max-h-\[min\(60vh,32rem\)\]/);
			assert.equal((markup.match(/<button/g) ?? []).length, 1, "readonly dialog must expose only Close");
			assert.ok(template.values.includes("前置条件不足（MODEL_INPUT_BUDGET_EXCEEDED）。输入 345071，上限 128000。"));
			assert.equal(stub.listenerCount(), 1);
			const callbacks = dialogCallbacks(template);
			assert.equal(callbacks.length, 2, "backdrop and Close are the only dialog actions");
			callbacks.at(-1)!();
			callbacks.at(-1)!();
			await pending;
			assert.deepEqual(harness.responses, [{ id: "status-1", data: { confirmed: false } }]);
			assert.equal(harness.closed(), 1);
			assert.equal(stub.listenerCount(), 0);
		} finally {
			if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
			else delete (globalThis as { window?: unknown }).window;
		}
	});

	await runCase("UI-EXT-02 readonly status closes safely on backdrop Escape timeout and RPC failure", async () => {
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		const stub = createWindowStub();
		Object.defineProperty(globalThis, "window", { configurable: true, value: stub.window });
		try {
			const backdrop = createReadonlyDialogHarness();
			const backdropPending = backdrop.handler.handleRequest({ id: "backdrop", method: "confirm", title: "小说运行状态", message: "状态" });
			const backdropCallback = dialogCallbacks(backdrop.template())[0];
			const marker = {};
			backdropCallback({ target: marker, currentTarget: marker });
			await backdropPending;
			assert.equal(backdrop.responses.length, 1);

			const escape = createReadonlyDialogHarness(true);
			const escapePending = escape.handler.handleRequest({ id: "escape", method: "confirm", title: "小说运行状态", message: "状态" });
			stub.dispatchEscape();
			await escapePending;
			assert.equal(escape.responses.length, 1);
			assert.match(escape.traces.join("\n"), /readonly-dialog:response-failed synthetic response failure/);
			assert.equal(stub.listenerCount(), 0);

			const switched = createReadonlyDialogHarness();
			const switchedInternal = switched.handler as unknown as Record<string, unknown>;
			switchedInternal.statusTexts = new Map();
			switchedInternal.renderLatestStatus = () => undefined;
			const switchedPending = switched.handler.handleRequest({ id: "switch", method: "confirm", title: "小说运行状态", message: "状态" });
			switched.handler.clearSessionStatus();
			await switchedPending;
			assert.deepEqual(switched.responses, [{ id: "switch", data: { cancelled: true } }]);
			assert.equal(stub.listenerCount(), 0, "switch must remove the previous runtime's dialog listener");

			const timeout = createReadonlyDialogHarness();
			await timeout.handler.handleRequest({ id: "timeout", method: "confirm", title: "小说运行状态", message: "状态", timeout: 1 });
			assert.deepEqual(timeout.responses, [{ id: "timeout", data: { cancelled: true } }]);
			assert.equal(stub.listenerCount(), 0);
		} finally {
			if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
			else delete (globalThis as { window?: unknown }).window;
		}
	});

	await runCase("UI-EXT-03 keyed statuses are bounded and session-clearable", () => {
		const handler = Object.create(ExtensionUiHandler.prototype) as ExtensionUiHandler;
		const internal = handler as unknown as Record<string, unknown>;
		internal.statusTexts = new Map<string, string>();
		internal.renderLatestStatus = () => undefined;
		const setStatus = internal.setStatus as (request: Record<string, unknown>) => void;
		setStatus.call(handler, { statusKey: "novel-supervisor", statusText: "小说状态" });
		setStatus.call(handler, { statusKey: "other", statusText: "其他状态" });
		setStatus.call(handler, { statusKey: "other", statusText: undefined });
		const statuses = internal.statusTexts as Map<string, string>;
		assert.equal(statuses.get("novel-supervisor"), "小说状态", "clearing another key must preserve supervisor status");
		for (let index = 0; index < 40; index++) setStatus.call(handler, { statusKey: `key-${index}`, statusText: `status-${index}` });
		assert.equal(statuses.size, 32);
		handler.clearSessionStatus();
		assert.equal(statuses.size, 0, "runtime switch must be able to clear all prior-session statuses");
	});

	await runCase("UI-EXT-04 status host gets a compact summary with lossless local details", async () => {
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		const stub = createWindowStub();
		Object.defineProperty(globalThis, "window", { configurable: true, value: stub.window });
		try {
			const harness = createReadonlyDialogHarness();
			const internal = harness.handler as unknown as Record<string, unknown>;
			internal.statusTexts = new Map();
			const displays: Array<ExtensionStatusView | null> = [];
			harness.handler.setStatusDisplayHandler((status) => displays.push(status));
			assert.equal(displays.at(-1), null);
			const text = "前置条件不足（MODEL_INPUT_BUDGET_EXCEEDED）。当前估算 345071 / 预算上限 128000。\n" + "长诊断".repeat(200);
			await harness.handler.handleRequest({ id: "s1", method: "setStatus", statusKey: "novel-supervisor", statusText: text });
			const status = displays.at(-1)!;
			assert.ok(status);
			assert.equal(extensionStatusSummary(status), "前置条件不足");
			assert.equal(status.text, text, "summary must not destroy full diagnostic");
			status.onOpen();
			assert.ok(harness.template().values.includes(text));
			stub.dispatchEscape();
			assert.equal(harness.responses.length, 0, "local details must not send a fake RPC reply");
			status.onOpen();
			const confirmation = harness.handler.handleRequest({ id: "other-confirm", method: "confirm", title: "另一个确认", message: "需要人工处理" });
			assert.equal(stub.listenerCount(), 0, "new RPC dialog must retire the local details Escape handler");
			const closedBeforeEscape = harness.closed();
			stub.dispatchEscape();
			assert.equal(harness.closed(), closedBeforeEscape, "stale local listener cannot hide the pending RPC dialog");
			dialogCallbacks(harness.template())[0]();
			await confirmation;
			assert.deepEqual(harness.responses, [{ id: "other-confirm", data: { confirmed: false } }]);
			harness.handler.clearSessionStatus();
			assert.equal(displays.at(-1), null);
			assert.equal(extensionStatusSummary({ ...status, key: "third-party", text: "x".repeat(400) }).length, 80);
		} finally {
			if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
			else delete (globalThis as { window?: unknown }).window;
		}
	});
}
