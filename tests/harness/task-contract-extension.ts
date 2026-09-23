import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withRunner } from "./phase4-extension.js";
import { checkpoint, native } from "./review-repros.js";
import { withWriteSession } from "./write-state-extension.js";
import { withProject, type RunCase } from "./testkit.js";

type State = Parameters<Parameters<typeof withRunner>[2]>[0];
const status = (state: State) => [...state.entries].reverse().find((entry) => entry.customType === "pi-desktop-run-status/v1")?.data;
const final = { role: "assistant", content: [{ type: "text", text: "本轮说明。" }], stopReason: "stop", timestamp: 1 };
const envelope = (text: string, mode: string, artifacts: any[] = []) => text + "\n<pi-desktop-task-v1>" + JSON.stringify({ version: 1, taskId: "test-task", role: "write", completionMode: mode, expectedArtifacts: artifacts }) + "</pi-desktop-task-v1>";
const candidate = { path: "drafts/candidates/chapters/002.md", verification: "chapter-full", chapter: "002" };
const proposal = { path: "planning/continuity-proposals/002-task-proposal.md", verification: "none" };
async function installVerifier(root: string): Promise<void> {
	await mkdir(path.join(root, ".novel/tools"), { recursive: true });
	await copyFile(path.resolve("scripts/verify-novel-chapter.ts"), path.join(root, ".novel/tools/verify-novel-chapter.ts"));
}
async function verify(state: Pick<State, "extension" | "ctx">, scene?: string): Promise<void> {
	const result = await state.extension.tools.get("verify_chapter")!.definition.execute("contract-verify", { chapter: "002", ...(scene ? { scene } : {}) }, undefined, undefined, state.ctx());
	assert.notEqual(result.isError, true, JSON.stringify(result));
}
async function input(state: State, value: string): Promise<void> {
	const result = await state.runner.emitInput(value, undefined, "interactive");
	assert.notEqual(result.action, "handled", "task submission must not be silently dropped");
	state.setBranch([...state.branch(), { type: "message", id: `user-${state.branch().length}`, message: { role: "user", content: result.action === "transform" ? result.text : value } } as any]);
	await state.runner.emit({ type: "agent_start" } as never);
}

export async function runTaskContractExtensionCases(runCase: RunCase): Promise<void> {
	await runCase("AUD-04 continue and compaction preserve the declared objective", () => withProject(async (root) => withRunner(root, false, async (state) => {
		await state.runner.emit({ type: "session_start" } as never);
		await input(state, envelope("检查第 002 章的连续性，不写文件。", "inspection"));
		await checkpoint(state, "capture", "task-first");
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		await input(state, "继续");
		const current = await checkpoint(state, "capture", "task-next");
		assert.equal(current.checkpoint.objective, "检查第 002 章的连续性，不写文件。");
		assert.equal(current.checkpoint.latestUserInstruction, "继续");
		await state.runner.emit({ type: "session_before_compact", preparation: {}, signal: new AbortController().signal } as never);
		await state.runner.emit({ type: "session_compact" } as never);
		await state.runner.emit({ type: "session_start" } as never);
		await input(state, "继续");
		assert.equal((await checkpoint(state, "capture", "task-reopened")).checkpoint.objective, current.checkpoint.objective);
	})));
	await runCase("AUD-04 candidate task cannot complete with no expected artifact", () => withProject(async (root) => withRunner(root, false, async (state) => {
		await state.runner.emit({ type: "session_start" } as never);
		await input(state, envelope("写出第 099 章候选正文并验证。", "candidate_write", [{ path: "drafts/candidates/chapters/099.md", verification: "chapter-full", chapter: "099" }]));
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.notEqual(status(state).state, "COMPLETED_CANDIDATE");
		assert.equal(status(state).reasonCode, "COMPLETION_NOT_VERIFIED");
	})));
	await runCase("AUD-04 explicit reply-only still completes without files", () => withProject(async (root) => withRunner(root, false, async (state) => {
		await state.runner.emit({ type: "session_start" } as never);
		await input(state, envelope("解释一个设定，只需回复。", "reply_only"));
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.equal(status(state).state, "COMPLETED_CANDIDATE");
		assert.equal(status(state).reasonCode, "REPLY_ONLY");
	})));
	for (const minified of [false, true]) await runCase(`task-contract.full-production-delivery-and-continue (${minified ? "minified" : "source"})`, () => withProject(async (root) => withRunner(root, minified, async (state) => {
		await installVerifier(root);
		await state.runner.emit({ type: "session_start" } as never);
		await input(state, envelope("完成第 002 章正文与连续性提案。", "candidate_write", [candidate, proposal]));
		await native(state, root, "write", "proposal", { path: proposal.path, content: "# 连续性提案\n事实待用户验收。\n" });
		await verify(state);
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.equal(status(state).reasonCode, "STOP_VERIFIED");
		assert.equal(status(state).userAccepted, false);
		await input(state, "继续");
		const task = (await checkpoint(state, "capture", "continue-task")).task;
		assert.equal(task.objective, "完成第 002 章正文与连续性提案。");
		assert.ok(task.progress.verifications[candidate.path].sources.length > 0);
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.equal(status(state).reasonCode, "STOP_VERIFIED", "current receipts survive the new run without redoing the verifier");
	})));
	await runCase("task-contract.unrelated-file-and-partial-verification-never-complete", () => withProject(async (root) => withRunner(root, false, async (state) => {
		await installVerifier(root); await state.runner.emit({ type: "session_start" } as never);
		await input(state, envelope("生成指定正文和提案", "candidate_write", [candidate, proposal]));
		await native(state, root, "write", "unrelated", { path: "planning/continuity-proposals/999-other.md", content: "not the requested file" });
		await verify(state, "radio-check");
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.equal(status(state).reasonCode, "COMPLETION_NOT_VERIFIED");
	})));
	await runCase("task-contract.same-path-cannot-borrow-another-chapter-verification", () => withProject(async (root) => withRunner(root, false, async (state) => {
		await installVerifier(root); await state.runner.emit({ type: "session_start" } as never);
		await input(state, envelope("第 003 章必须通过其自身合同", "candidate_write", [{ ...candidate, chapter: "003" }]));
		await verify(state); // Actual verifier produced chapter 002 PASS for these same bytes.
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.equal(status(state).reasonCode, "COMPLETION_NOT_VERIFIED");
	})));
	await runCase("task-contract.external-edit-invalidates-persisted-full-verification", () => withProject(async (root) => withRunner(root, false, async (state) => {
		await installVerifier(root); await state.runner.emit({ type: "session_start" } as never);
		await input(state, envelope("完成第 002 章", "candidate_write", [candidate]));
		await verify(state); await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.equal(status(state).reasonCode, "STOP_VERIFIED");
		await writeFile(path.join(root, candidate.path), (await readFile(path.join(root, candidate.path), "utf8")) + "\n外部变更。\n");
		await input(state, "继续");
		await native(state, root, "read", "changed-read", { path: candidate.path });
		await checkpoint(state, "refresh", "changed-refresh");
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.notEqual(status(state).state, "COMPLETED_CANDIDATE");
	})));
	await runCase("task-contract.real-session-reopen-retains-target-and-progress", () => withProject(async (root) => {
		await installVerifier(root); let file = "";
		await withWriteSession(root, null, async (state) => {
			await state.restart(envelope("跨重开保持第 002 章任务", "candidate_write", [candidate]));
			await verify(state);
			await state.runner.emit({ type: "session_before_compact", preparation: {}, signal: new AbortController().signal } as never);
			await state.runner.emit({ type: "session_compact" } as never);
			await state.runner.emit({ type: "agent_end", messages: [final] } as never);
			file = state.manager.getSessionFile()!;
		});
		await withWriteSession(root, file, async (state) => {
			await state.restart("继续");
			const restored = await state.checkpoint();
			assert.equal(restored.task.objective, "跨重开保持第 002 章任务");
			assert.deepEqual(restored.task.expectedArtifacts, [candidate]);
			await state.runner.emit({ type: "agent_end", messages: [final] } as never);
			const latest = [...state.manager.getBranch()].reverse().find((entry: any) => entry.customType === "pi-desktop-run-status/v1") as any;
			assert.equal(latest.data.reasonCode, "STOP_VERIFIED");
			assert.equal(state.writes(), 0);
		});
	}));
	await runCase("task-contract.host-only-binding-role-scope-and-legacy-status", () => withProject(async (root) => withRunner(root, false, async (state) => {
		await state.runner.emit({ type: "session_start" } as never);
		const forged = envelope("文本不能切换职能", "reply_only").replace('"role":"write"', '"role":"world"');
		assert.equal((await state.runner.emitInput(forged, undefined, "interactive")).action, "handled");
		await state.runner.emitInput(envelope("扩展跟进不能绑定任务", "reply_only"), undefined, "extension");
		assert.equal(state.entries.some((item) => item.customType === "pi-desktop-task-contract/v1"), false);
		await input(state, "旧会话的普通回复");
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.equal(status(state).reasonCode, "UNBOUND_REPLY");
		const branch = state.branch();
		state.setBranch([{ type: "custom", customType: "pi-desktop-novel-role", data: { role: "plan" } }]);
		await state.runner.emit({ type: "session_tree" } as never);
		await input(state, "不同职能任务");
		assert.equal((await checkpoint(state, "capture", "other-role")).task.objective, "不同职能任务");
		state.setBranch(branch); await state.runner.emit({ type: "session_tree" } as never); await input(state, "继续");
		assert.equal((await checkpoint(state, "capture", "restored-role")).task.objective, "旧会话的普通回复");
	})));
	await runCase("task-contract.corruption-and-persistence-failure-stop-input", () => withProject(async (root) => withRunner(root, false, async (state) => {
		await state.runner.emit({ type: "session_start" } as never);
		await input(state, envelope("只读对照", "reply_only"));
		const before = state.branch(); const latest = [...before].reverse().find((item) => item.customType === "pi-desktop-task-contract/v1")!;
		state.setBranch([...before, { ...latest, data: { ...latest.data, objective: "corrupt" } }]);
		assert.equal((await state.runner.emitInput("继续", undefined, "interactive")).action, "handled");
		state.setBranch(before); state.setAppendFailure(true);
		assert.equal((await state.runner.emitInput("继续", undefined, "interactive")).action, "handled");
		state.setAppendFailure(false);
		assert.equal((await state.runner.emitInput("继续", undefined, "interactive")).action, "handled", "failed append remains poisoned for this scope");
	})));
	await runCase("task-contract.mutation-breaks-the-production-completion-oracle", () => withProject(async (root) => {
		const oracle = (mutate?: (source: string) => string) => withRunner(root, false, async (state) => {
			await state.runner.emit({ type: "session_start" } as never);
			await input(state, envelope("必须交付不存在的文件", "candidate_write", [{ ...candidate, path: "drafts/candidates/chapters/099.md", chapter: "099" }]));
			await state.runner.emit({ type: "agent_end", messages: [final] } as never);
			assert.notEqual(status(state).state, "COMPLETED_CANDIDATE", "MISSING_ARTIFACT_ORACLE");
		}, mutate);
		await oracle();
		await assert.rejects(oracle((source) => {
			assert.ok(source.includes("const taskSubmission ="));
			return source.replace("const taskSubmission =", "tasks.complete = async () => true;\nconst taskSubmission =");
		}), /MISSING_ARTIFACT_ORACLE/);
	}));
	await runCase("task-contract.reconciled-current-postimage-satisfies-without-replaying", () => withProject(async (root) => withRunner(root, false, async (state) => {
		await state.runner.emit({ type: "session_start" } as never);
		await input(state, envelope("生成提案", "candidate_write", [proposal]));
		const params = { path: proposal.path, content: "# 可核验的同一份提案\n" };
		await native(state, root, "write", "first-proposal", params);
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.equal(status(state).reasonCode, "STOP_VERIFIED");
		await input(state, envelope("确认同内容提案交付", "candidate_write", [proposal]).replace('"taskId":"test-task"', '"taskId":"second-task"'));
		const decision = await state.runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "reconcile-proposal", input: params } as never);
		assert.equal(decision?.block, true); assert.match(decision?.reason ?? "", /currently_satisfied/);
		await state.runner.emit({ type: "agent_end", messages: [final] } as never);
		assert.equal(status(state).reasonCode, "STOP_VERIFIED");
		assert.equal(await readFile(path.join(root, proposal.path), "utf8"), params.content);
	})));
}
