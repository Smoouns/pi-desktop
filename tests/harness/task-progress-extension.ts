import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { withRunner } from "./phase4-extension.js";
import { checkpoint, native } from "./review-repros.js";
import { createTaskSubmission } from "../../src/novel/task-submission.js";
import { withProject, type RunCase } from "./testkit.js";

export async function runTaskProgressExtensionCases(runCase: RunCase): Promise<void> {
	await runCase("PROGRESS-11 replacing an old projection preserves constraint and request-context indices", () => withProject(root => withRunner(root, false, async state => {
		await state.runner.emit({ type: "session_start" } as never);
		const objective = "仅检查公开资料，不修改正典。";
		const input = await state.runner.emitInput(createTaskSubmission().encode(objective, { version: 1, taskId: "progress-indices", role: "write", completionMode: "inspection", expectedArtifacts: [] }), undefined, "interactive");
		assert.notEqual(input.action, "handled");
		state.setBranch([...state.branch(), { type: "message", id: "user", message: { role: "user", content: objective } } as any]);
		await state.runner.emit({ type: "agent_start" } as never);
		await native(state, root, "read", "read-indices", { path: "canon/world.md" });
		await checkpoint(state, "capture", "indices-capture");
		const projected: any[] = await state.runner.emitContext([
			{ role: "custom", customType: "novel-task-progress", content: "obsolete-progress", display: false, timestamp: 0 },
			{ role: "user", content: objective + "\n\n<novel-context>\n公开附件引用\n</novel-context>", timestamp: 1 },
		] as never);
		assert.equal(projected.filter(message => message.customType === "novel-task-progress").length, 1);
		assert.doesNotMatch(JSON.stringify(projected), /obsolete-progress/);
		assert.equal(projected[0].role, "user");
		assert.equal(projected[1].customType, "novel-request-context");
		const cpMessage = projected.find(message => message.customType === "novel-task-checkpoint");
		const cp = JSON.parse(cpMessage.content.slice(cpMessage.content.indexOf("\n") + 1)).checkpoint;
		assert.deepEqual(cp.objective, { ref: "active-user-message", messageIndex: 0 });
		const before = JSON.stringify(state.entries), dialogs: string[] = [];
		state.runner.setUIContext({ confirm: async (_title: string, text: string) => { dialogs.push(text); return false; } } as never);
		await state.extension.commands.get("novel-run-status").handler("", state.ctx());
		assert.match(dialogs[0], /最近历史进展/);
		assert.match(dialogs[0], /canon\/world.md/);
		assert.equal(JSON.stringify(state.entries), before, "status query cannot append, resume or mutate task history");
	})));
	for (const minified of [false, true]) await runCase(`PROGRESS-10 optional append failure never changes file completion (${minified ? "minified" : "source"})`, () => withProject(root => withRunner(root, minified, async state => {
		await state.runner.emit({ type: "session_start" } as never);
		const target = "planning/continuity-proposals/progress-test.md", content = "PRIVATE_BODY_SENTINEL\n";
		const text = createTaskSubmission().encode("生成公开测试提案。", { version: 1, taskId: "progress-failure", role: "write", completionMode: "candidate_write", expectedArtifacts: [{ path: target, verification: "none" }] });
		const input = await state.runner.emitInput(text, undefined, "interactive");
		assert.notEqual(input.action, "handled");
		state.setBranch([...state.branch(), { type: "message", id: "user", message: { role: "user", content: input.action === "transform" ? input.text : text } } as any]);
		await state.runner.emit({ type: "agent_start" } as never);
		await native(state, root, "read", "first", { path: "canon/world.md" });
		assert.equal((await checkpoint(state, "capture", "first-capture")).progress.status, "available");
		await native(state, root, "write", "write-progress", { path: target, content });
		assert.equal(await readFile(path.join(root, target), "utf8"), content);
		const result = await checkpoint(state, "get", "after-append-failure");
		assert.equal(result.status, "ready");
		assert.equal(result.progress.status, "unavailable");
		assert.deepEqual(result.progress.items, [], "never fall back to the old read receipt");
		await state.runner.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "公开回复。" }], stopReason: "stop", timestamp: 1 }] } as never);
		const status = [...state.entries].reverse().find(entry => entry.customType === "pi-desktop-run-status/v1")!.data;
		assert.equal(status.reasonCode, "STOP_VERIFIED");
		assert.equal(status.userAccepted, false);
		assert.equal(state.aborts(), 0);
		const progress = state.entries.filter(entry => entry.customType === "pi-desktop-task-progress/v1");
		assert.equal(progress.length, 1);
		assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_BODY_SENTINEL/);
	}, source => {
		// Fault injection is restricted to this optional append, never checkpoints,
		// native dispatch, task completion or production implementation on disk.
		const needle = "appendProgress = (record) => pi.appendEntry(progressLog.customType, record);";
		assert.equal(source.split(needle).length, 2);
		return source.replace(needle, "let progressAppends = 0; appendProgress = (record) => { if (++progressAppends > 1) throw new Error('PUBLIC_SYNTHETIC_APPEND_FAILURE'); pi.appendEntry(progressLog.customType, record); };");
	})));
}
