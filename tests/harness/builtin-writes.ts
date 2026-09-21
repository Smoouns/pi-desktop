import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEditTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import { withLoadedExtension } from "./contracts.js";
import { withProject, type RunCase } from "./testkit.js";

const context = (cwd: string, sessionId = "builtin-write-session") => ({ cwd, sessionManager: {
	getSessionId: () => sessionId,
	getBranch: () => [{ type: "custom", customType: "pi-desktop-novel-role", data: { role: "write" } }],
} });

type LoadedExtension = Awaited<Parameters<Parameters<typeof withLoadedExtension>[2]>[0]>;
type NativeResult = { content: Array<{ type: "text"; text: string }>; details: unknown };

/** Mirrors pi-coding-agent 0.63.1 AgentSession: failed native results ignore hook patches. */
async function executeBuiltin(
	extension: LoadedExtension,
	root: string,
	toolName: "write" | "edit",
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<{ blocked: boolean; nativeError: boolean; result?: NativeResult }> {
	const ctx = context(root);
	const callHook = extension.handlers.get("tool_call")![0];
	const before = await callHook({ type: "tool_call", toolName, toolCallId, input }, ctx as never) as { block?: boolean } | undefined;
	if (before?.block) return { blocked: true, nativeError: false };
	const tool = toolName === "write" ? createWriteTool(root) : createEditTool(root);
	try {
		const native = await tool.execute(toolCallId, input as never);
		const patch = await extension.handlers.get("tool_result")![0]({
			type: "tool_result", toolName, toolCallId, input,
			content: native.content, details: native.details, isError: false,
		}, ctx as never) as Partial<NativeResult> | undefined;
		return { blocked: false, nativeError: false, result: {
			content: patch?.content ?? native.content,
			details: patch?.details === undefined ? native.details : patch.details,
		} as NativeResult };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await extension.handlers.get("tool_result")![0]({
			type: "tool_result", toolName, toolCallId, input,
			content: [{ type: "text", text: message }], details: undefined, isError: true,
		}, ctx as never);
		// AgentSession ignores the hook patch when the native result is an error.
		return { blocked: false, nativeError: true, result: { content: [{ type: "text", text: message }], details: undefined } };
	}
}

export async function runBuiltinWriteCases(runCase: RunCase): Promise<void> {
	await runCase("P1-BUILTIN sequential native write and edits share reconciled target", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const target = "drafts/candidates/chapters/native-sequential.md";
		const write = await executeBuiltin(extension, root, "write", "native-write", { path: target, content: "甲\n" });
		assert.equal(write.blocked, false); assert.equal(write.nativeError, false);
		const first = await executeBuiltin(extension, root, "edit", "native-edit-1", { path: target, oldText: "甲", newText: "乙" });
		assert.equal(first.blocked, false); assert.equal(first.nativeError, false);
		const second = await executeBuiltin(extension, root, "edit", "native-edit-2", { path: target, oldText: "乙", newText: "丙" });
		assert.equal(second.blocked, false); assert.equal(second.nativeError, false);
		assert.equal(await readFile(`${root}/${target}`, "utf8"), "丙\n");
		record("builtin_sequential", { nativeExecutions: 3, successfulMutations: 3 });
	})));

	await runCase("P1-BUILTIN explicit failed edit permits changed repair only", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const target = "drafts/candidates/chapters/native-repair.md";
		await executeBuiltin(extension, root, "write", "repair-write", { path: target, content: "原文\n" });
		const invalid = await executeBuiltin(extension, root, "edit", "repair-invalid", { path: target, oldText: "不存在", newText: "错误" });
		assert.equal(invalid.nativeError, true);
		const repeated = await executeBuiltin(extension, root, "edit", "repair-repeat", { path: target, oldText: "不存在", newText: "错误" });
		assert.equal(repeated.blocked, true, "Unchanged failed arguments require repair");
		const corrected = await executeBuiltin(extension, root, "edit", "repair-corrected", { path: target, oldText: "原文", newText: "修正" });
		assert.equal(corrected.blocked, false); assert.equal(corrected.nativeError, false);
		assert.equal(await readFile(`${root}/${target}`, "utf8"), "修正\n");
		record("builtin_repair", { nativeExecutions: 3, blockedUnchanged: 1, correctedMutations: 1 });
	})));

	await runCase("P1-BUILTIN committed write with lost result blocks fresh replay", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const target = "drafts/candidates/chapters/native-lost-result.md";
		const input = { path: target, content: "只提交一次\n" };
		const ctx = context(root);
		const callHook = extension.handlers.get("tool_call")![0];
		const first = await callHook({ type: "tool_call", toolName: "write", toolCallId: "lost-write-1", input }, ctx as never) as { block?: boolean } | undefined;
		assert.notEqual(first?.block, true);
		await createWriteTool(root).execute("lost-write-1", input); // result callback intentionally lost
		const replay = await callHook({ type: "tool_call", toolName: "write", toolCallId: "lost-write-2", input }, ctx as never) as { block?: boolean; reason?: string } | undefined;
		assert.equal(replay?.block, true);
		assert.match(replay?.reason ?? "", /satisfied|已满足/);
		let caseAliasBlocked = 0;
		if (process.platform === "win32") {
			const aliasInput = { ...input, path: "drafts/candidates/chapters/NATIVE-LOST-RESULT.md" };
			const alias = await callHook({ type: "tool_call", toolName: "write", toolCallId: "lost-write-3", input: aliasInput }, ctx as never) as { block?: boolean; reason?: string } | undefined;
			assert.equal(alias?.block, true, "Windows path case aliases must share one operation target");
			assert.match(alias?.reason ?? "", /satisfied|已满足/);
			caseAliasBlocked = 1;
		}
		assert.equal(await readFile(`${root}/${target}`, "utf8"), input.content);
		record("builtin_lost_result", { nativeExecutions: 1, replayBlocked: 1, windowsCaseAliasBlocked: caseAliasBlocked });
	})));
}
