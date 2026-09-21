import assert from "node:assert/strict";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
import { createContextMaintenance } from "../../src/extensions/context-maintenance.js";
import type { RunCase } from "./testkit.js";

const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
const tool = (id: string, name: string, text: string, timestamp: number) => ({
	role: "toolResult", toolCallId: id, toolName: name,
	content: [{ type: "text", text }], isError: false, timestamp,
});

export async function runContextMaintenanceCases(runCase: RunCase): Promise<void> {
	await runCase("CM-RECONSTRUCT matches pinned SDK branch and compaction semantics", () => {
		const entries: any[] = [
			{ type: "custom_message", id: "c", parentId: null, timestamp: "2026-01-01T00:00:00Z", customType: "guide", content: "keep", display: false, details: { a: 1 } },
			{ type: "message", id: "u1", parentId: "c", timestamp: "2026-01-01T00:00:01Z", message: user("old", 1) },
			{ type: "message", id: "u2", parentId: "u1", timestamp: "2026-01-01T00:00:02Z", message: user("kept", 2) },
			{ type: "compaction", id: "cmp", parentId: "u2", timestamp: "2026-01-01T00:00:03Z", summary: "summary", firstKeptEntryId: "u2", tokensBefore: 123 },
			{ type: "branch_summary", id: "b", parentId: "cmp", timestamp: "2026-01-01T00:00:04Z", summary: "branch", fromId: "other" },
			{ type: "message", id: "u3", parentId: "b", timestamp: "2026-01-01T00:00:05Z", message: user("new", 5) },
			{ type: "message", id: "fork", parentId: "u1", timestamp: "2026-01-01T00:00:06Z", message: user("not active", 6) },
		];
		const helper = createContextMaintenance();
		assert.deepEqual(helper.reconstructActiveMessages(entries, "u3"), buildSessionContext(entries as never, "u3").messages);
		assert.deepEqual(helper.reconstructActiveMessages(entries, "fork"), buildSessionContext(entries as never, "fork").messages);
		assert.deepEqual(helper.reconstructActiveMessages(entries, null), []);
		assert.doesNotThrow(() => new Function(`return (${createContextMaintenance.toString()})`)());
	});

	await runCase("CM-TRIM preserves pairs, latest results, pending tools and input immutability", () => {
		const large = "x".repeat(2048);
		const assistant = (id: string, name: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], timestamp: 0 });
		const messages: any[] = [user("instruction", 0)];
		for (let index = 0; index < 7; index += 1) messages.push(assistant(`id-${index}`, index === 1 ? "pending_write" : "read"), tool(`id-${index}`, index === 1 ? "pending_write" : "read", large + index, index));
		const before = structuredClone(messages);
		const result = createContextMaintenance().trimOldToolResults(messages, {
			maxInlineBytes: 512, keepRecentToolResults: 4, pendingToolCallIds: ["id-1"],
		});
		assert.deepEqual(messages, before, "request-level trimming must not mutate session messages");
		assert.deepEqual(result.trimmed.map((item) => item.toolCallId), ["id-0", "id-2"]);
		assert.equal(result.messages.length, messages.length);
		for (let index = 0; index < messages.length; index += 1) {
			if (messages[index].role !== "toolResult") assert.strictEqual(result.messages[index], messages[index]);
		}
		assert.deepEqual(result.messages[4], messages[4], "pending operation result remains complete");
		for (const id of ["id-3", "id-4", "id-5", "id-6"]) {
			const index = messages.findIndex((message) => message.toolCallId === id);
			assert.strictEqual(result.messages[index], messages[index], "latest tool result remains complete");
		}
		for (const item of result.trimmed) {
			const callIndex = result.messages.findIndex((message) => message.role === "assistant" && message.content?.some((part: any) => part.id === item.toolCallId));
			const resultIndex = result.messages.findIndex((message) => message.role === "toolResult" && message.toolCallId === item.toolCallId);
			assert.ok(callIndex >= 0 && resultIndex === callIndex + 1, "tool call/result pairing and order survive trimming");
			assert.match(JSON.stringify(result.messages[resultIndex].content), /旧工具结果已从本次模型上下文裁剪/);
		}
	});

	await runCase("CM-TRIM ignores small and non-text tool payloads", () => {
		const binary = { role: "toolResult", toolCallId: "image", toolName: "view", content: [{ type: "image", data: "x".repeat(2000), mimeType: "image/png" }] };
		const small = tool("small", "read", "ok", 0);
		const result = createContextMaintenance().trimOldToolResults([binary, small], { maxInlineBytes: 512, keepRecentToolResults: 0 });
		assert.equal(result.trimmed.length, 0);
		assert.strictEqual(result.messages[0], binary);
		assert.strictEqual(result.messages[1], small);
	});

	await runCase("CM-CHECKPOINT projects only byte-exact active user copies", () => {
		const helper = createContextMaintenance();
		const checkpoint = {
			id: "checkpoint", objective: "same", hardConstraints: ["old compacted", "same", "same", "new"],
			evidence: [{ path: "canon/world.md", sha256: "a".repeat(64) }],
		};
		const before = structuredClone(checkpoint);
		const messages = [
			{ role: "compactionSummary", summary: "summary", timestamp: 0 },
			{ role: "user", content: "same", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "same" }], timestamp: 2 },
			{ role: "user", content: [{ type: "text", text: "same" }], timestamp: 3 },
			{ role: "user", content: [{ type: "text", text: "new" }, { type: "image", data: "x" }], timestamp: 4 },
		];
		const projected = helper.projectCheckpoint(checkpoint, messages);
		assert.deepEqual(checkpoint, before, "durable checkpoint must not be mutated");
		assert.notStrictEqual(projected, checkpoint);
		assert.deepEqual(projected.hardConstraints, [
			"old compacted",
			{ ref: "active-user-message", messageIndex: 1 },
			{ ref: "active-user-message", messageIndex: 3 },
			{ ref: "active-user-message", messageIndex: 4 },
		]);
		assert.deepEqual(projected.objective, { ref: "active-user-message", messageIndex: 3 }, "objective references the latest exact active user copy");
		assert.deepEqual(projected.evidence, checkpoint.evidence);
		assert.deepEqual(projected.projection, { version: 1, referenceBase: "activeMessages", exactTextOnly: true });
	});

	await runCase("CM-CHECKPOINT preserves constraint order and excess multiplicity", () => {
		const projected = createContextMaintenance().projectCheckpoint(
			{ objective: "x", hardConstraints: ["x", "x", "x", "y"] },
			[{ role: "user", content: "x" }, { role: "user", content: "y" }],
		);
		assert.deepEqual(projected.hardConstraints, [
			{ ref: "active-user-message", messageIndex: 0 }, "x", "x",
			{ ref: "active-user-message", messageIndex: 1 },
		]);
		assert.deepEqual(projected.objective, { ref: "active-user-message", messageIndex: 0 });
	});

	await runCase("CM-RECONSTRUCT normalizes nullable legacy message content", () => {
		const entries: any[] = [
			{ type: "message", id: "u", parentId: null, timestamp: 0, message: { role: "user", content: null, timestamp: 0 } },
			{ type: "custom_message", id: "c", parentId: "u", timestamp: 1, customType: "legacy", content: null, display: false },
		];
		assert.deepEqual(createContextMaintenance().reconstructActiveMessages(entries), [
			{ role: "user", content: [], timestamp: 0 },
			{ role: "custom", customType: "legacy", content: [], display: false, details: undefined, timestamp: 1 },
		]);
	});
}
