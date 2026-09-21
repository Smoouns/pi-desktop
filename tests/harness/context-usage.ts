import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ChatView } from "../../src/components/chat-view.js";
import { renderContextUsageView, sanitizeContextBudgetSnapshot } from "../../src/components/chat-view/context-usage-view.js";
import type { RunCase } from "./testkit.js";

const snapshot = () => ({
	version: 1, sessionId: "session-a", provider: "google", modelId: "gemini-3.8-flash-high",
	capacity: { contextWindow: 128000, maxOutputTokens: 16384, source: "sdk-default", verified: false },
	ledger: { system: 100, tools: 200, history: 300, checkpoint: 40, observationPreview: 20, newEvidence: 10, serializationOverhead: 12, outputReserve: 16384, safetyMargin: 4096, total: 21162, limit: 128000, available: 106838, inputEstimate: 682, rawInputBytes: 1200 },
	estimator: "estimated_tokens", phase: "preflight", trimmedToolResults: 2, autoCompaction: "idle", measuredAt: 1,
});

export async function runContextUsageCases(runCase: RunCase): Promise<void> {
	await runCase("UI-CONTEXT-00 telemetry routing never renders raw JSON and refresh checks registration", async () => {
		const main = await readFile("src/main.ts", "utf8");
		assert.match(main, /event\.statusKey === "pi-desktop-context-budget"[\s\S]*setContextBudgetSnapshot\(JSON\.parse\(event\.statusText\)\)[\s\S]*return;/);
		const chat = await readFile("src/components/chat-view.ts", "utf8");
		assert.match(chat, /slashRuntimeCommands\.some\(\(command\) => command\.name === "novel-context-status" && command\.source === "extension"\)/);
		assert.match(chat, /await rpcBridge\.prompt\("\/novel-context-status"\)/);
	});
	await runCase("UI-CONTEXT-01 budget snapshot sanitizer is bounded and versioned", () => {
		const valid = sanitizeContextBudgetSnapshot(snapshot());
		assert.ok(valid);
		assert.equal(valid.capacity.verified, false);
		assert.equal(valid.ledger.total, 21162);
		assert.equal(sanitizeContextBudgetSnapshot({ ...snapshot(), version: 2 }), null);
		assert.equal(sanitizeContextBudgetSnapshot({ ...snapshot(), ledger: { ...snapshot().ledger, total: Number.POSITIVE_INFINITY } }), null);
		assert.equal(sanitizeContextBudgetSnapshot({ ...snapshot(), reason: "x".repeat(241) }), null);
		const withPrivate = sanitizeContextBudgetSnapshot({ ...snapshot(), privatePayload: "must-not-survive" }) as unknown as Record<string, unknown>;
		assert.equal(withPrivate.privatePayload, undefined);
		const declared = sanitizeContextBudgetSnapshot({
			...snapshot(),
			capacity: { ...snapshot().capacity, contextWindow: 262144, maxOutputTokens: 16384, declaredContextWindow: 1048576, declaredMaxOutputTokens: 65536, declaredSource: "user-confirmed" },
		});
		assert.equal(declared?.capacity.declaredContextWindow, 1048576);
		assert.equal(declared?.capacity.declaredMaxOutputTokens, 65536);
		assert.equal(sanitizeContextBudgetSnapshot({ ...snapshot(), capacity: { ...snapshot().capacity, declaredContextWindow: 1048576 } }), null);
		assert.equal(sanitizeContextBudgetSnapshot({ ...snapshot(), capacity: { ...snapshot().capacity, declaredContextWindow: 64000, declaredMaxOutputTokens: 65536, declaredSource: "user-confirmed" } }), null);
		assert.equal(sanitizeContextBudgetSnapshot({ ...snapshot(), capacity: { ...snapshot().capacity, declaredContextWindow: 1048576.5, declaredMaxOutputTokens: 65536, declaredSource: "user-confirmed" } }), null);
	});

	await runCase("UI-CONTEXT-02 snapshots are fenced to current session and model", () => {
		const chat = Object.create(ChatView.prototype) as ChatView;
		const internal = chat as unknown as Record<string, unknown>;
		internal.state = { sessionId: "session-a", model: { provider: "google", id: "gemini-3.8-flash-high" } };
		internal.contextBudgetSnapshot = null;
		internal.render = () => undefined;
		assert.equal(chat.setContextBudgetSnapshot(snapshot()), true);
		assert.equal((internal.contextBudgetSnapshot as { sessionId: string }).sessionId, "session-a");
		assert.equal(chat.setContextBudgetSnapshot({ ...snapshot(), sessionId: "session-b" }), false);
		assert.equal(chat.setContextBudgetSnapshot({ ...snapshot(), modelId: "other" }), false);
	});

	await runCase("UI-CONTEXT-03 unknown current usage is not rendered as zero", () => {
		const rendered = renderContextUsageView({
			open: true, refreshing: false, compacting: false, connected: true, streaming: false,
			currentTokens: null, contextWindow: 128000, usageRatio: null, autoCompactionEnabled: true,
			budget: sanitizeContextBudgetSnapshot(snapshot()), onClose: () => undefined, onRefresh: () => undefined,
			onCompact: () => undefined, onToggleAutoCompaction: () => undefined,
		}) as unknown as { strings: readonly string[]; values: unknown[] };
		const presentation = rendered.strings.join(" ") + rendered.values.filter((value) => typeof value === "string").join(" ");
		assert.match(presentation, /Pi 当前上下文估算/);
		assert.match(presentation, /压缩后需等待下一次成功回复/);
		assert.match(presentation, /UTF-8 字节估算|token 估算/);
		assert.doesNotMatch(presentation, /Pi 当前上下文估算[^]*?>0</);
	});
}
