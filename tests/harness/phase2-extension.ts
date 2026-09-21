import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withLoadedExtension } from "./contracts.js";
import { withProject, type RunCase } from "./testkit.js";

const context = (cwd: string, sessionId = "p2-session") => ({ cwd, sessionManager: {
	getSessionId: () => sessionId,
	getBranch: () => [{ type: "custom", customType: "pi-desktop-novel-role", data: { role: "write" } }],
} });
const text = (result: any) => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
async function failure(pending: Promise<unknown>, kind: string) {
	await assert.rejects(pending, (error: any) => error?.toolResult?.details?.harness?.error?.kind === kind);
}

export async function runPhase2ExtensionCases(runCase: RunCase): Promise<void> {
	await runCase("P2-ADAPTER large reads offload and revalidate with real Pi loader", (record) => withProject(async (root) => {
		const large = Array.from({ length: 180 }, (_, index) => `line-${index + 1}: 原创合成资料 ${"x".repeat(100)}`).join("\n");
		await writeFile(path.join(root, "canon/p2-large.md"), large);
		for (const minified of [false, true]) await withLoadedExtension(root, minified, async (extension) => {
			const ctx = context(root);
			const read = extension.tools.get("read_story_document")!.definition;
			const fetch = extension.tools.get("read_observation")!.definition;
			const first: any = await read.execute("large-1", { path: "canon/p2-large.md" }, undefined, undefined, ctx as never);
			assert.ok(first.details.observation.id);
			assert.ok(text(first).length < 6000);
			assert.doesNotMatch(text(first), /line-180:/);
			assert.match(text(first), /read_observation/);
			const second: any = await read.execute("large-2", { path: "canon/p2-large.md" }, undefined, undefined, ctx as never);
			assert.equal(second.details.observation.id, first.details.observation.id);
			const part: any = await fetch.execute("page", { id: first.details.observation.id, start: 0, limit: 600 }, undefined, undefined, ctx as never);
			assert.match(text(part), /line-1:/);
			assert.ok(part.details.hasMore);
			await failure(fetch.execute("foreign", { id: first.details.observation.id }, undefined, undefined, context(root, "foreign") as never), "stale_source");
			await writeFile(path.join(root, "canon/p2-large.md"), large + "\nchanged");
			await failure(fetch.execute("stale", { id: first.details.observation.id }, undefined, undefined, ctx as never), "stale_source");
			await writeFile(path.join(root, "canon/p2-large.md"), large);
		});
		record("observations.adapter", { minified: true, versionChecked: true, crossSessionBlocked: true });
	}));
	await runCase("P2-READ line and section boundaries do not truncate silently", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		await writeFile(path.join(root, "canon/p2-ranges.md"), "# 测试\n## 甲\n内容甲\n```md\n## 伪标题\n```\n### 子段\n子内容\n## 乙\n内容乙\n");
		const read = extension.tools.get("read_story_document")!.definition;
		const ctx = context(root);
		const range: any = await read.execute("range", { path: "canon/p2-ranges.md", startLine: 3, endLine: 3 }, undefined, undefined, ctx as never);
		assert.match(text(range), /内容甲/);
		assert.doesNotMatch(text(range), /内容乙/);
		assert.equal(range.details.sources[0].startLine, 3);
		const section: any = await read.execute("section", { path: "canon/p2-ranges.md", section: "甲" }, undefined, undefined, ctx as never);
		assert.match(text(section), /子内容/);
		assert.doesNotMatch(text(section), /内容乙/);
		await failure(read.execute("bad-range", { path: "canon/p2-ranges.md", startLine: 0 }, undefined, undefined, ctx as never), "invalid_input");
		await failure(read.execute("ambiguous-range", { path: "canon/p2-ranges.md", startLine: 2, section: "甲" }, undefined, undefined, ctx as never), "invalid_input");
		await writeFile(path.join(root, "canon/p2-ranges.md"), "## 重名\nx\n## 重名\ny");
		await failure(read.execute("duplicate-section", { path: "canon/p2-ranges.md", section: "重名" }, undefined, undefined, ctx as never), "invalid_input");
		record("read.range", { exactLines: true, nestedSection: true, fencesIgnored: true, ambiguousBlocked: true });
	})));
	await runCase("P2-CONTEXT repeated evidence and source changes preserve tool pairing", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const ctx = context(root);
		const read = extension.tools.get("read_story_document")!.definition;
		const a: any = await read.execute("one", { path: "canon/world.md" }, undefined, undefined, ctx as never);
		const b: any = await read.execute("two", { path: "canon/world.md" }, undefined, undefined, ctx as never);
		const messages = [
			{ role: "user", content: "不要删我的约束", timestamp: 0 },
			{ role: "assistant", content: [{ type: "toolCall", id: "one", name: "read_story_document", arguments: { path: "canon/world.md" } }], timestamp: 0 },
			{ role: "toolResult", toolCallId: "one", toolName: "read_story_document", ...a, isError: false, timestamp: 0 },
			{ role: "assistant", content: [{ type: "toolCall", id: "two", name: "read_story_document", arguments: { path: "canon/world.md" } }], timestamp: 0 },
			{ role: "toolResult", toolCallId: "two", toolName: "read_story_document", ...b, isError: false, timestamp: 0 },
		];
		const handler = extension.handlers.get("context")![0];
		const result: any = await handler({ type: "context", messages }, ctx as never);
		assert.equal(result.messages.length, messages.length);
		assert.equal(result.messages[0].content, "不要删我的约束");
		assert.equal(result.messages[4].toolCallId, "two");
		assert.ok(text(result.messages[4]).length < text(b).length);
		assert.deepEqual(messages[4].content, b.content, "stored conversation must not be mutated");
		const source = await readFile(path.join(root, "canon/world.md"), "utf8");
		await writeFile(path.join(root, "canon/world.md"), source + "\n修订");
		const stale: any = await handler({ type: "context", messages }, ctx as never);
		assert.match(text(stale.messages[2]), /stale_source/);
		record("context.evidence", { duplicateCompacted: true, pairingPreserved: true, sourceChangeDetected: true });
	})));
}
