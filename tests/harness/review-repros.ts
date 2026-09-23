import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { withRunner } from "./phase4-extension.js";
import { sha256, withProject, type RunCase } from "./testkit.js";

/** These are RED acceptance contracts, not passing assertions of buggy behavior. */
export class ReviewContractViolation extends Error {}
function contract(condition: boolean, code: string): void {
	if (!condition) throw new ReviewContractViolation(code);
}
const text = (result: any): string => result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
type RunnerState = Parameters<Parameters<typeof withRunner>[2]>[0];

export async function start(state: RunnerState): Promise<void> {
	await state.runner.emit({ type: "session_start" } as never);
	await state.runner.emitInput("在当前候选目录内执行审查复现", undefined, "interactive");
	await state.runner.emit({ type: "agent_start" } as never);
}
export async function checkpoint(state: RunnerState, name: "get" | "capture" | "refresh", id: string): Promise<any> {
	const result = await state.extension.tools.get(`${name}_task_checkpoint`)!.definition.execute(id, {}, undefined, undefined, state.ctx());
	assert.notEqual(result.isError, true, text(result));
	return JSON.parse(text(result));
}

/** Real pinned SDK native tools + ExtensionRunner hooks; no provider or model. */
export async function native(state: RunnerState, root: string, toolName: "read" | "write", id: string, input: Record<string, unknown>, afterExecute?: () => Promise<void>): Promise<{ native: any; delivered: any }> {
	const before = await state.runner.emitToolCall({ type: "tool_call", toolName, toolCallId: id, input } as never);
	assert.notEqual(before?.block, true, before?.reason);
	const tool = toolName === "read" ? createReadTool(root) : createWriteTool(root);
	const result = await tool.execute(id, input as never);
	await afterExecute?.();
	const patched = await state.runner.emitToolResult({ type: "tool_result", toolName, toolCallId: id, input,
		content: result.content, details: result.details, isError: false } as never);
	return { native: result, delivered: { ...result, ...patched } };
}

export async function runReviewRepros(runCase: RunCase): Promise<void> {
	await runCase("CONTROL completed intent with matching current bytes stays satisfied", (record) => withProject(async (root) => withRunner(root, false, async (state) => {
		await start(state);
		const target = "drafts/candidates/chapters/review-write.md", input = { path: target, content: "A\n" };
		await native(state, root, "write", "control-write-a", input);
		const decision = await state.runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "control-repeat", input } as never);
		assert.equal(decision?.block, true); assert.match(decision?.reason ?? "", /satisfied/);
		assert.equal(await readFile(path.join(root, target), "utf8"), "A\n");
		record("control.current_postimage", { satisfied: true, nativeWrites: 1 });
	})));

	for (const reuseCallId of [false, true]) await runCase(`AUD-02 historical A then external B then request A (${reuseCallId ? "same" : "new"} call id)`, (record) => withProject(async (root) => withRunner(root, false, async (state) => {
		await start(state);
		const target = "drafts/candidates/chapters/review-write.md", input = { path: target, content: "A\n" };
		await native(state, root, "write", "review-write-a", input);
		await writeFile(path.join(root, target), "B\n");
		assert.equal((await checkpoint(state, "get", "inspect-b")).status, "needs_revalidation");
		await native(state, root, "read", "read-b", { path: target });
		assert.equal((await checkpoint(state, "refresh", "refresh-b")).status, "ready");
		const decision = await state.runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: reuseCallId ? "review-write-a" : "review-write-a-again", input } as never);
		const actual = await readFile(path.join(root, target), "utf8");
		assert.equal(actual, "B\n", "gate-only probe must never replay the write");
		const saysSatisfied = /satisfied|已满足/.test(decision?.reason ?? "");
		record("review.historical_vs_current", { reuseCallId, claimedSatisfied: saysSatisfied, currentMatchesIntent: actual === input.content, nativeWrites: 1 });
		contract(!saysSatisfied, "AUD02_HISTORICAL_COMPLETION_IS_NOT_CURRENT_SATISFACTION");
	})));

	for (const newline of ["\n", "\r\n"]) await runCase(`AUD-03 native offset and limit (${newline === "\n" ? "LF" : "CRLF"})`, (record) => withProject(async (root) => withRunner(root, false, async (state) => {
		const target = "canon/world.md", content = ["first", "delivered", "hidden", "last"].join(newline);
		await writeFile(path.join(root, target), content);
		await start(state);
		const result = await native(state, root, "read", "range-read", { path: target, offset: 2, limit: 1 });
		assert.match(text(result.native), /delivered/); assert.doesNotMatch(text(result.native), /first|hidden|last/);
		const status = await checkpoint(state, "capture", "capture-range");
		const refs = status.checkpoint.evidence.filter((ref: any) => ref.path === target);
		assert.ok(refs.length > 0); assert.equal(refs[0].sha256, sha256(content), "whole source fingerprint remains useful; it is not a delivery receipt");
		record("review.native_range", { deliveredStart: 2, deliveredEnd: 2, receiptStart: refs[0].startLine, receiptEnd: refs[0].endLine });
		contract(refs.every((ref: any) => ref.startLine === 2 && ref.endLine === 2), "AUD03_NATIVE_RANGE_EXCEEDS_DELIVERED_LINES");
	})));

	await runCase("AUD-03 native overlong first line delivers no source content", (record) => withProject(async (root) => withRunner(root, false, async (state) => {
		const target = "canon/world.md";
		await writeFile(path.join(root, target), "NOT_DELIVERED_" + "x".repeat(60_000) + "\ntail");
		await start(state);
		const result = await native(state, root, "read", "overlong-read", { path: target, offset: 1, limit: 1 });
		assert.match(text(result.native), /exceeds/); assert.doesNotMatch(text(result.native), /NOT_DELIVERED_/);
		const status = await checkpoint(state, "capture", "capture-overlong");
		const refs = status.checkpoint.evidence.filter((ref: any) => ref.path === target);
		record("review.notice_only", { deliveredSourceLines: 0, evidenceRefs: refs.length });
		contract(refs.length === 0, "AUD03_NATIVE_NOTICE_IS_NOT_SOURCE_DELIVERY");
	})));

	await runCase("AUD-03 native truncated output and preview do not prove the hidden tail", (record) => withProject(async (root) => withRunner(root, false, async (state) => {
		const target = "canon/world.md";
		await writeFile(path.join(root, target), Array.from({ length: 2300 }, (_, index) => `L${String(index + 1).padStart(4, "0")} source`).join("\n"));
		await start(state);
		const result = await native(state, root, "read", "truncated-read", { path: target });
		assert.equal(result.native.details.truncation.truncated, true);
		assert.equal(result.delivered.details.offloaded, true);
		assert.doesNotMatch(text(result.native), /L2300/); assert.doesNotMatch(text(result.delivered), /L2000|L2300/);
		const deliveredLines = [...text(result.delivered).matchAll(/L(\d{4}) source/g)].map((match) => Number(match[1]));
		assert.ok(deliveredLines.length > 0, "fixture must exercise an actual partial preview");
		const deliveredEnd = Math.max(...deliveredLines);
		const status = await checkpoint(state, "capture", "capture-truncated");
		const refs = status.checkpoint.evidence.filter((ref: any) => ref.path === target);
		record("review.truncated_preview", { sourceLines: 2300, nativeLines: result.native.details.truncation.outputLines,
			previewOnly: true, deliveredEnd, receiptEnd: refs[0]?.endLine ?? null });
		contract(refs.every((ref: any) => ref.endLine !== undefined && ref.endLine <= deliveredEnd), "AUD03_PREVIEW_IS_NOT_FULL_SOURCE_DELIVERY");
	})));

	for (const relevant of [false, true]) await runCase(`${relevant ? "CONTROL" : "AUD-03"} reread ${relevant ? "relevant" : "unrelated"} slice after source change`, (record) => withProject(async (root) => withRunner(root, false, async (state) => {
		const target = "canon/world.md", lines = Array.from({ length: 12 }, (_, index) => `source line ${index + 1}`);
		await writeFile(path.join(root, target), lines.join("\n"));
		await start(state);
		await native(state, root, "read", "dependency-read", { path: target, offset: 8, limit: 2 });
		await checkpoint(state, "capture", "capture-dependency");
		lines[8] = "CHANGED_DEPENDENCY"; await writeFile(path.join(root, target), lines.join("\n"));
		assert.equal((await checkpoint(state, "get", "inspect-change")).status, "needs_revalidation");
		const result = await native(state, root, "read", "reread", { path: target, offset: relevant ? 8 : 1, limit: relevant ? 2 : 1 });
		if (relevant) assert.match(text(result.delivered), /CHANGED_DEPENDENCY/);
		else assert.doesNotMatch(text(result.delivered), /CHANGED_DEPENDENCY/);
		const status = await checkpoint(state, "refresh", "refresh-dependency");
		record("review.dependency_refresh", { relevantReread: relevant, actualStatus: status.status });
		if (relevant) assert.equal(status.status, "ready");
		else contract(status.status === "needs_revalidation", "AUD03_UNRELATED_REREAD_CANNOT_REFRESH_DEPENDENCY");
	})));

	await runCase("CONTROL source change between native read and delivery stays rejected", (record) => withProject(async (root) => withRunner(root, false, async (state) => {
		const target = "canon/world.md";
		await start(state);
		const result = await native(state, root, "read", "racing-read", { path: target, offset: 1, limit: 1 }, async () => {
			await writeFile(path.join(root, target), "changed during read\n");
		});
		assert.match(text(result.delivered), /未交付|变化/);
		const status = await checkpoint(state, "capture", "capture-race");
		assert.equal(status.checkpoint.evidence.some((ref: any) => ref.path === target), false);
		record("control.version_race", { deliveryRejected: true, sourceReceiptRecorded: false });
	})));
}
