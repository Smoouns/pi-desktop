import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createReadTool } from "@mariozechner/pi-coding-agent";
import { withRunner } from "./phase4-extension.js";
import { checkpoint, native, start } from "./review-repros.js";
import { withWriteSession } from "./write-state-extension.js";
import { sha256, withProject, type RunCase } from "./testkit.js";

const target = "canon/world.md";
type State = Parameters<Parameters<typeof withRunner>[2]>[0];
const text = (result: any): string => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
const tool = async (state: State, name: string, id: string, input: any): Promise<any> => state.extension.tools.get(name)!.definition.execute(id, input, undefined, undefined, state.ctx());
const covers = (refs: any[], line: number): boolean => refs.some((ref) => ref.path === target && ref.startLine <= line && ref.endLine >= line);

export async function runReadDeliveryExtensionCases(runCase: RunCase): Promise<void> {
	for (const newline of ["\n", "\r\n"]) await runCase(`REV-READ native BOM and ${newline === "\n" ? "LF" : "CRLF"} retain exact bytes`, (record) => withProject(async (root) => withRunner(root, false, async (s) => {
		const content = "\uFEFF首行" + newline + "中间😀" + newline + "未读末行";
		await writeFile(path.join(root, target), content); await start(s);
		const result = await native(s, root, "read", "bom-range", { path: target, offset: 2, limit: 1 });
		assert.match(text(result.delivered), /中间😀/); assert.doesNotMatch(text(result.delivered), /未读末行/);
		const refs = (await checkpoint(s, "capture", "bom-cp")).checkpoint.evidence;
		assert.deepEqual(refs.map((ref: any) => [ref.sha256, ref.startLine, ref.endLine]), [[sha256(content), 2, 2]]);
		record("read.bom", { exactFingerprint: true, deliveredLines: 1 });
	})));

	for (const minified of [false, true]) await runCase(`REV-READ paginated partial line, gap and fresh scope (${minified ? "minified" : "source"})`, (record) => withProject(async (root) => withRunner(root, minified, async (s) => {
		const lines = Array.from({ length: 70 }, (_, index) => `L${index + 1}: ${"资料😀".repeat(14)}`);
		await writeFile(path.join(root, target), lines.join("\n")); await start(s);
		await native(s, root, "read", "old-dependency", { path: target, offset: 55, limit: 1 });
		await checkpoint(s, "capture", "old-cp");
		lines[54] += " changed"; await writeFile(path.join(root, target), lines.join("\n"));
		assert.equal((await checkpoint(s, "get", "changed")).status, "needs_revalidation");
		const read = await tool(s, "read_story_document", "capture-only", { path: target });
		assert.equal(read.details.offloaded, true);
		assert.equal((await checkpoint(s, "refresh", "preview-refresh")).status, "needs_revalidation");
		const payload = `# ${target}\n\n${lines.join("\n")}`;
		const lineStart = payload.indexOf(lines[54]), cut = lineStart + 17;
		const id = read.details.observation.id;
		await tool(s, "read_observation", "partial-a", { id, start: lineStart, limit: 17 });
		await tool(s, "read_observation", "partial-gap", { id, start: cut + 1, limit: lines[54].length - 18 });
		assert.equal((await checkpoint(s, "refresh", "gap-cp")).status, "needs_revalidation", "a one-character gap cannot prove a full source line");
		await tool(s, "read_observation", "fill-gap", { id, start: cut, limit: 1 });
		assert.equal((await checkpoint(s, "refresh", "complete-cp")).status, "ready");
		const refs = (await checkpoint(s, "capture", "delivered-cp")).checkpoint.evidence;
		assert.equal(covers(refs, 55), true); assert.equal(covers(refs, 65), false);
		// A stale latch must retire pre-change character coverage, even after rollback.
		const restored = lines.join("\n");
		await writeFile(path.join(root, target), restored + " drift");
		assert.equal((await checkpoint(s, "get", "drift-again")).status, "needs_revalidation");
		await writeFile(path.join(root, target), restored);
		await tool(s, "read_observation", "one-char-after-rollback", { id, start: cut, limit: 1 });
		assert.equal((await checkpoint(s, "refresh", "rollback-cp")).status, "needs_revalidation");
		record("read.page_coverage", { minified, gapBlocked: true, completeLineAccepted: true, hiddenTailUnread: true, rollbackNeedsFreshCoverage: true });
	})));

	await runCase("REV-READ native truncation notice pages never prove omitted tail", (record) => withProject(async (root) => withRunner(root, false, async (s) => {
		const lines = Array.from({ length: 2300 }, (_, index) => `source-${index + 1}`);
		await writeFile(path.join(root, target), lines.join("\n")); await start(s);
		const result = await native(s, root, "read", "sdk-truncated", { path: target });
		assert.doesNotMatch(JSON.stringify(result.delivered.details), /source-2000/, "offloading must not smuggle the native truncation body through details");
		const payload = text(result.native), id = result.delivered.details.observation.id;
		const startAt = payload.indexOf("source-1999");
		await tool(s, "read_observation", "last-source-and-notice", { id, start: startAt, limit: Math.min(1000, payload.length - startAt) });
		const refs = (await checkpoint(s, "capture", "native-tail-cp")).checkpoint.evidence;
		assert.equal(covers(refs, 2000), true); assert.equal(covers(refs, 2001), false);
		assert.ok(refs.every((ref: any) => ref.endLine <= 2000));
		record("read.native_tail", { capturedEnd: 2000, omittedTailUnread: true, noticeNotSource: true });
	})));

	await runCase("REV-READ budget-rejected output cannot create a delivered receipt", (record) => withProject(async (root) => withRunner(root, false, async (s) => {
		await writeFile(path.join(root, "canon/budget-filler.md"), "x".repeat(5000));
		await writeFile(path.join(root, target), "THIS_WAS_NOT_DELIVERED" + "y".repeat(4980)); await start(s);
		let rejected = false;
		for (let i = 0; i < 20; i++) {
			const result = await native(s, root, "read", `budget-${i}`, { path: "canon/budget-filler.md" });
			if (result.delivered.details?.budgetBlocked) { rejected = true; break; }
		}
		assert.equal(rejected, true);
		const result = await native(s, root, "read", "budget-unseen", { path: target });
		assert.equal(result.delivered.details?.budgetBlocked, true);
		assert.doesNotMatch(text(result.delivered), /THIS_WAS_NOT_DELIVERED/);
		await s.runner.emit({ type: "session_before_compact", preparation: {}, branchEntries: s.branch(), signal: new AbortController().signal } as never);
		const persisted = s.entries.slice().reverse().find((entry) => entry.customType === "pi-desktop-task-checkpoint")?.data;
		assert.ok(persisted); assert.equal(persisted.evidence.some((ref: any) => ref.path === target), false);
		record("read.budget_rejected", { delivered: false, receipt: false });
	})));

	await runCase("REV-READ multiple documents and search snippets cannot certify hidden lines", (record) => withProject(async (root) => withRunner(root, false, async (s) => {
		await writeFile(path.join(root, "planning/delivery-first.md"), Array.from({ length: 120 }, (_, i) => `line-${i}: ${"x".repeat(90)}`).join("\n"));
		await writeFile(path.join(root, "planning/delivery-last.md"), "HIDDEN_LAST_DOCUMENT");
		await writeFile(path.join(root, target), "plain\nneedle完整行\nneedle" + "x".repeat(400) + "\nsecret");
		await start(s);
		const outline = await tool(s, "read_outline", "outlines", { scope: "delivery-" });
		assert.equal(outline.details.offloaded, true); assert.doesNotMatch(text(outline), /HIDDEN_LAST_DOCUMENT/);
		await tool(s, "search_story", "search-snippets", { query: "needle" });
		const refs = (await checkpoint(s, "capture", "multi-cp")).checkpoint.evidence;
		assert.equal(refs.some((ref: any) => ref.path === "planning/delivery-last.md"), false);
		assert.equal(covers(refs, 2), true); assert.equal(covers(refs, 3), false); assert.equal(covers(refs, 4), false);
		record("read.multiple_sources", { hiddenDocumentUnread: true, fullSearchLineAccepted: true, truncatedSearchLineUnread: true });
	})));

	await runCase("REV-READ native ABA content mismatch cannot borrow the capture hash", (record) => withProject(async (root) => withRunner(root, false, async (s) => {
		const a = "version A\nkept", b = "version B\nchanged", input = { path: target, offset: 1, limit: 1 };
		await writeFile(path.join(root, target), a); await start(s);
		const before = await s.runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "aba-read", input } as never);
		assert.notEqual(before?.block, true);
		await writeFile(path.join(root, target), b);
		const result = await createReadTool(root).execute("aba-read", input);
		await writeFile(path.join(root, target), a);
		const patched = await s.runner.emitToolResult({ type: "tool_result", toolName: "read", toolCallId: "aba-read", input, ...result, isError: false } as never);
		assert.match(text({ ...result, ...patched }), /未交付/);
		assert.equal((await checkpoint(s, "capture", "aba-cp")).checkpoint.evidence.length, 0);
		record("read.aba", { sourceContentMismatchRejected: true });
	})));

	await runCase("REV-READ real session file restores bounded receipts and paged refresh", (record) => withProject(async (root) => {
		const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
		await writeFile(path.join(root, target), lines.join("\n"));
		let sessionFile: string | null = null;
		await withWriteSession(root, null, async (s) => {
			const result = await s.call("read", "persisted-range", { path: target, offset: 8, limit: 2 });
			s.manager.appendMessage({ role: "toolResult", toolCallId: "persisted-range", toolName: "read", content: result.content, details: result.details, isError: false, timestamp: 0 });
			sessionFile = s.manager.getSessionFile()!;
		});
		assert.ok(sessionFile);
		await withWriteSession(root, sessionFile, async (s) => {
			const restored = await s.checkpoint("refresh");
			assert.equal(restored.status, "ready");
			assert.deepEqual(restored.checkpoint.evidence.map((ref: any) => [ref.startLine, ref.endLine]), [[8, 9]]);
			lines[8] += " changed"; await writeFile(path.join(root, target), lines.join("\n"));
			assert.equal((await s.checkpoint()).status, "needs_revalidation");
			await s.call("read", "unrelated", { path: target, offset: 1, limit: 1 });
			assert.equal((await s.checkpoint("refresh")).status, "needs_revalidation");
			await s.call("read", "relevant-a", { path: target, offset: 8, limit: 1 });
			await s.call("read", "relevant-b", { path: target, offset: 9, limit: 1 });
			assert.equal((await s.checkpoint("refresh")).status, "ready");
			assert.equal(s.writes(), 0);
		});
		record("read.disk_restore", { realSessionFile: true, freshExtension: true, nativeWrites: 0, unrelatedBlocked: true, pagedRereadAccepted: true });
	}));

	await runCase("REV-READ memory preview is not a full accepted excerpt", (record) => withProject(async (root) => withRunner(root, false, async (s) => {
		const memoryPath = "canon/delivery-memory.md";
		await writeFile(path.join(root, memoryPath), "# receipt probe\n" + "独有凭证段落😀".repeat(390));
		await start(s);
		const search = await tool(s, "search_story_memory", "memory-search", { query: "独有凭证段落", limit: 1 });
		const memory = search.details.hits?.[0] ?? search.details.sources?.[0];
		assert.ok(memory);
		const memoryId = memory.id ?? memory.memoryId;
		const read = await tool(s, "read_story_memory", "memory-read", { id: memoryId });
		assert.equal(read.details.offloaded, true);
		assert.equal((await checkpoint(s, "capture", "memory-preview-cp")).checkpoint.evidence.some((ref: any) => ref.memoryId === memoryId), false);
		const id = read.details.observation.id;
		let offset = 0, more = true;
		while (more) {
			const page = await tool(s, "read_observation", `memory-page-${offset}`, { id, start: offset, limit: 1200 });
			more = page.details.hasMore; offset += Math.min(1200, page.details.totalChars - offset);
		}
		const refs = (await checkpoint(s, "capture", "memory-delivered-cp")).checkpoint.evidence;
		assert.ok(refs.some((ref: any) => ref.memoryId === memoryId && ref.authority === "canonical"));
		record("read.memory", { previewNotAcceptedAsFull: true, fullPagedExcerptAccepted: true, memoryIdentityPreserved: true });
	})));

	await runCase("REV-READ receipt survives fresh extension, old capture-only result does not", (record) => withProject(async (root) => {
		await writeFile(path.join(root, target), "one\ntwo\nthree\nfour");
		let receipt: any;
		await withRunner(root, false, async (s) => {
			await start(s);
			receipt = (await native(s, root, "read", "durable-read", { path: target, offset: 2, limit: 1 })).delivered;
		});
		for (const legacy of [false, true]) await withRunner(root, false, async (s) => {
			const details = structuredClone(receipt.details);
			if (legacy) delete details.readDelivery;
			s.setBranch([...s.branch(), { type: "message", id: "read-receipt", message: { role: "toolResult", toolCallId: "durable-read", toolName: "read", content: receipt.content, details, isError: false } } as any]);
			await start(s);
			const status = await checkpoint(s, "capture", "restore-receipt");
			assert.equal(status.status, legacy ? "needs_revalidation" : "ready");
			assert.equal(covers(status.checkpoint.evidence, 4), false);
			if (legacy) {
				await native(s, root, "read", "fresh-read", { path: target, offset: 2, limit: 1 });
				assert.equal((await checkpoint(s, "refresh", "legacy-refreshed")).status, "ready");
			}
		});
		record("read.restore", { freshExtension: true, legacyCaptureNotReceipt: true, rereadRepairsLegacy: true });
	}));
}
