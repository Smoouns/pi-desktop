import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { BODY, CARD, OBJECTIVE, PROPOSAL, SOURCE, binding, calls, candidate, checkpointOf, inside, openSession, plain, proposal, statusOf, submit, taskOf } from "./session.js";
import { sha256, treeManifest } from "../testkit.js";
import { sendMessageFlow } from "../../../src/components/chat-view/send-message-flow.js";
import { stripNovelContextForDisplay } from "../../../src/components/chat-view/backend-message-mapper.js";
import { extensionStatusSummary } from "../../../src/components/chat-view/extension-status-view.js";
import { rpcBridge } from "../../../src/rpc/bridge.js";

const [stage, workArg] = process.argv.slice(2), work = path.resolve(workArg);
assert.equal(process.env.PI_PRODUCTION_LIFECYCLE_WORKER, "1");
const project = path.join(work, "project"), statePath = path.join(work, "state.json"), output = path.join(work, `${stage}.json`);
const before = await treeManifest(project);
const state: any = stage.endsWith("seed") || stage === "mutation" || stage === "isolation" ? {} : JSON.parse(await readFile(statePath, "utf8"));
const proof: any = { stage, pid: process.pid, modelCalls: 0, networkAttempts: 0, checks: [] };
const check = (label: string, actual: unknown, expected: unknown = true) => { assert.deepEqual(actual, expected, label); proof.checks.push(label); };
const sessionFile = state.sessionFile ? path.resolve(work, state.sessionFile) : null;
if (sessionFile) inside(path.join(work, "agent/sessions"), sessionFile);
const lostContent = "# 离线连续性提案\n本章事实仍待用户确认。\n";

const s = await openSession(work, sessionFile, {
	mutate: stage === "mutation",
		afterWrite: stage === "lost-seed" ? async info => {
		// Deliberately exit after the genuine filesystem effect, before SDK's
		// tool_result/agent_end. Not a synthetic hook or a thrown tool failure.
		const op = checkpointOf(info.manager).pendingOperations.find((op: any) => op.operationId === "lost-write");
		check("dispatched intent still issued at process death", op.state, "issued");
		check("one native write before lost acknowledgement", info.nativeDispatches.filter((row: any) => row.tool === "write").length, 1);
		state.sessionFile = path.relative(work, info.manager.getSessionFile());
		proof.nativeDispatches = info.nativeDispatches; proof.verifierCalls = info.verifierCalls;
		proof.requests = info.provider.receipts; proof.extensionSha256 = sha256(info.source);
		proof.checkpoint = checkpointOf(info.manager); proof.task = taskOf(info.manager);
		check("network guard active at interrupted exit", (globalThis as any)[Symbol.for("pi.eval.networkGuard")].attempts, 0);
		writeFileSync(statePath, JSON.stringify(state)); writeFileSync(output, JSON.stringify(proof, null, 2));
		process.exit(86);
	} : undefined,
});

try {
	if (stage === "submission-seed") {
		const prior = rpcBridge.prompt, submitted: string[] = [], echoes: string[] = [], notices: string[] = [];
		rpcBridge.prompt = async (message) => { submitted.push(message); await s.prompt(message); };
		try {
			await sendMessageFlow({ mode: "prompt", bindingStatusText: null, isComposerInteractionLocked: () => false,
				inputText: "解释当前创作流程。\n\n<novel-context>\n仅包含公开测试文件引用\n</novel-context>", displayInputText: "解释当前创作流程。", taskBinding: binding("d-ui", [], "reply_only"), selectedSkillCommandText: "", pendingImages: [],
				slashQueryFromInput: () => null, executeSlashCommandFromComposer: async () => undefined,
				rememberComposerHistoryEntry: () => undefined, currentIsStreaming: () => false, applyBackendState: () => undefined, clearStreamingUiState: () => undefined,
				render: () => undefined, enqueueComposerQueueMessage: () => "queue", pushNotice: text => { notices.push(text); }, pushUserEcho: value => { echoes.push(value); },
				clearComposer: () => undefined, setSendingPrompt: () => undefined, toRpcImages: () => [], removeComposerQueueMessage: () => undefined });
		} finally { rpcBridge.prompt = prior; }
		check("real composer flow submits exactly once", submitted.length, 1);
		check("clean local echo", echoes, ["解释当前创作流程。"]);
		check("history mapper also hides metadata", stripNovelContextForDisplay(submitted[0]), echoes[0]);
		check("production input creates declared task", taskOf(s.manager).taskId, "d-ui");
		check("only visible user request becomes objective", taskOf(s.manager).objective, echoes[0]);
		check("composer has no transport error", notices, []);
		const status = [...s.ui.statuses].reverse().find(row => row.key === "novel-supervisor" && row.text)!;
		check("actual SDK status feeds UI summary", extensionStatusSummary({ key: status.key, text: status.text!, onOpen() {} }), "回复已结束");
		check("reply status is not candidate-file completion", statusOf(s.manager).reasonCode, "REPLY_ONLY");
	} else if (stage === "delivery-seed") {
		const body = (await readFile(path.join(project, BODY), "utf8")) + "\n";
		await s.prompt(submit(OBJECTIVE, binding("d-delivery", [candidate, proposal])), (_ctx, n) => n === 1
			? calls(["read", { path: CARD }, "read-card"], ["read", { path: SOURCE, offset: 8, limit: 2 }, "read-source"])
			: n === 2 ? calls(["write", { path: BODY, content: body }, "write-body"])
			: n === 3 ? calls(["verify_chapter", { chapter: "002" }, "verify-full"])
			: plain);
		check("real full verifier ran", s.verifierCalls.length, 1);
		check("actual verifier passed", taskOf(s.manager).progress.verifications[BODY].passed);
		check("missing proposal prevents completion", statusOf(s.manager).reasonCode, "COMPLETION_NOT_VERIFIED");
		await s.prompt("继续：补齐连续性提案，保持原始任务目标。", (_ctx, n) => n === 1 ? calls(["write", { path: PROPOSAL, content: lostContent }, "write-proposal"]) : plain);
		check("all current artifacts complete", statusOf(s.manager).reasonCode, "STOP_VERIFIED");
		check("not user acceptance", statusOf(s.manager).userAccepted, false);
		await s.prompt("继续：保持所有限制，不做新的写入。", (_ctx, n) => n === 1 ? calls(["capture_task_checkpoint", {}, "capture-delivery"]) : plain);
		state.constraints = taskOf(s.manager).constraintRefs;
		state.artifactHashes = taskOf(s.manager).progress.artifacts;
		state.taskId = taskOf(s.manager).taskId;
		const compaction = await s.compact();
		check("SDK compaction produced summary", Boolean(compaction.summary));
		const entries = s.manager.getBranch().filter(entry => entry.type === "compaction");
		check("one native SDK compaction persisted", entries.length, 1);
		check("compaction is SDK generated, not replacement hook", Boolean((entries[0] as any).fromHook), false);
		check("provider used for native summary", s.provider.receipts.some(row => row.kind === "summary"));
		check("objective survives real compaction", taskOf(s.manager).objective, OBJECTIVE);
		check("constraints survive in order", taskOf(s.manager).constraintRefs, state.constraints);
		check("exactly two native writes", s.nativeDispatches.filter(row => row.tool === "write").length, 2);
	} else if (stage === "delivery-resume") {
		check("native compaction present in fresh process", s.manager.getBranch().filter(e => e.type === "compaction").length, 1);
		check("task identity persisted", taskOf(s.manager).taskId, state.taskId);
		check("pre-reopen constraints persisted in order", taskOf(s.manager).constraintRefs, state.constraints);
		check("artifact receipts persisted", taskOf(s.manager).progress.artifacts, state.artifactHashes);
		await s.prompt("继续", (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, "cold-get"]) : plain);
		check("cold current checkpoint ready", s.json("cold-get").status, "ready");
		check("original objective, not continue", s.json("cold-get").task.objective, OBJECTIVE);
		check("current receipts suffice after reopen", statusOf(s.manager).reasonCode, "STOP_VERIFIED");
		check("no native writes or verification replay", [s.nativeDispatches.length, s.verifierCalls.length], [0, 0]);
	} else if (stage === "delivery-changed") {
		await writeFile(path.join(project, CARD), (await readFile(path.join(project, CARD), "utf8")) + "\n外部规划说明已更新。\n");
		await s.prompt("继续：检查更新后的章节卡。", (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, "stale-card"])
			: n === 2 ? calls(["read", { path: CARD }, "reread-card"])
			: n === 3 ? calls(["refresh_task_checkpoint", {}, "refresh-card"]) : plain);
		check("changed contract invalidates checkpoint", s.json("stale-card").status, "needs_revalidation");
		check("reread refreshes checkpoint", s.json("refresh-card").status, "ready");
		check("old full verifier receipt cannot pass new contract bytes", statusOf(s.manager).reasonCode, "COMPLETION_NOT_VERIFIED");
		check("old verification is not automatically rerun", s.verifierCalls.length, 0);
		await s.prompt("继续：对当前版本重新执行完整验证。", (_ctx, n) => n === 1 ? calls(["verify_chapter", { chapter: "002" }, "reverify-current"]) : plain);
		check("fresh full verification completes current version", statusOf(s.manager).reasonCode, "STOP_VERIFIED");
		check("one explicit revalidation", s.verifierCalls.length, 1);
	} else if (stage === "range-seed" || stage === "mutation") {
		await s.prompt(submit("只读取第 8–9 行作为依赖。", binding("d-range", [], "inspection")), (_ctx, n) => n === 1
			? calls(["read", { path: SOURCE, offset: 8, limit: 2 }, "range-read"])
			: n === 2 ? calls(["capture_task_checkpoint", {}, "range-capture"]) : plain);
		const refs = s.json("range-capture").checkpoint.evidence.filter((ref: any) => ref.path === SOURCE);
		check("only actual SDK delivered lines recorded", refs.map((ref: any) => [ref.startLine, ref.endLine]), [[8, 9]]);
		state.observationId = s.result("range-read").result.details?.observation?.id;
		check("observation identifier captured", typeof state.observationId, "string");
		if (stage === "mutation") {
			await writeFile(path.join(project, SOURCE), (await readFile(path.join(project, SOURCE), "utf8")).replace("line-8", "changed-8"));
			await s.prompt("继续", (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, "range-stale"]) : plain);
			// Identical oracle to the non-mutated cold test. The runner requires
			// this exact assertion failure, never just a nonzero setup failure.
			check("SOURCE_VERSION_ORACLE", s.json("range-stale").status, "needs_revalidation");
		}
	} else if (stage === "range-resume") {
		await writeFile(path.join(project, SOURCE), (await readFile(path.join(project, SOURCE), "utf8")).replace("line-8", "changed-8"));
		await s.prompt("继续", (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, "range-stale"])
			: n === 2 ? calls(["read", { path: SOURCE, offset: 1, limit: 1 }, "unrelated-read"])
			: n === 3 ? calls(["refresh_task_checkpoint", {}, "unrelated-refresh"])
			: n === 4 ? calls(["read", { path: SOURCE, offset: 8, limit: 1 }, "relevant-8"], ["read", { path: SOURCE, offset: 9, limit: 1 }, "relevant-9"])
			: n === 5 ? calls(["refresh_task_checkpoint", {}, "relevant-refresh"]) : plain);
		check("SOURCE_VERSION_ORACLE", s.json("range-stale").status, "needs_revalidation");
		check("unrelated read cannot restore missing lines", s.json("unrelated-refresh").status, "needs_revalidation");
		check("full related delivery and explicit refresh restores", s.json("relevant-refresh").status, "ready");
		check("read-only flow has zero writes", s.nativeDispatches.filter(row => row.tool !== "read").length, 0);
		await s.prompt("继续：核对旧观察引用。", (_ctx, n) => n === 1 ? calls(["read_observation", { id: state.observationId }, "old-observation"]) : plain);
		check("old process observation unavailable", s.result("old-observation").isError);
	} else if (stage === "lost-seed") {
		await s.prompt(submit("生成连续性提案，不触碰正典。", binding("d-lost", [proposal])), (_ctx, n) => n === 1 ? calls(["write", { path: PROPOSAL, content: lostContent }, "lost-write"]) : plain);
		assert.fail("Expected intentional process death before write acknowledgement");
	} else if (stage === "lost-resume") {
		check("cold process sees dispatched unacknowledged intent", checkpointOf(s.manager).pendingOperations[0].state, "issued");
		await s.prompt("继续：先核对已经落盘的提案，不要重放。", (_ctx, n) => n === 1 ? calls(["write", { path: PROPOSAL, content: lostContent }, "after-cold-new-id"]) : plain);
		check("current post-image already satisfies old write", /currently_satisfied/.test(JSON.stringify(s.result("after-cold-new-id").result)));
		check("cold recovery did not dispatch native write", s.nativeDispatches.length, 0);
		check("completed operation persisted", checkpointOf(s.manager).pendingOperations[0].state, "completed");
		check("exact post-image preserved", await s.fileHash(PROPOSAL), sha256(lostContent));
	} else if (stage === "lost-conflict") {
		await writeFile(path.join(project, PROPOSAL), "B: external current proposal\n");
		await s.prompt("继续：读取并核对当前 B。", (_ctx, n) => n === 1 ? calls(["read", { path: PROPOSAL }, "read-b"])
			: n === 2 ? calls(["refresh_task_checkpoint", {}, "refresh-b"]) : plain);
		check("current B can be explicitly refreshed", s.json("refresh-b").status, "ready");
		await s.prompt("继续", (_ctx, n) => n === 1 ? calls(["write", { path: PROPOSAL, content: lostContent }, "old-a-new-id"]) : plain);
		check("old intent cannot overwrite B", /post_state_conflict/.test(JSON.stringify(s.result("old-a-new-id").result)));
		check("historical completion retained", checkpointOf(s.manager).pendingOperations[0].state, "completed");
		check("no replay dispatch", s.nativeDispatches.filter(row => row.tool !== "read").length, 0);
		check("current B survives", await s.fileHash(PROPOSAL), sha256("B: external current proposal\n"));
	} else if (stage === "cancel-seed") {
		let reached!: () => void; const waiting = new Promise<void>(resolve => { reached = resolve; });
		const pending = s.prompt(submit("待取消的提案任务", binding("d-cancel", [proposal])), async (_ctx, _n, signal) => {
			reached(); await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
			return calls(["write", { path: PROPOSAL, content: lostContent }, "must-not-dispatch"]);
		});
		await waiting; await s.session.abort(); await pending;
		check("SDK abort persisted cancelled state", statusOf(s.manager).state, "CANCELLED");
		check("pre-dispatch cancel no side effect", await s.fileHash(PROPOSAL), null);
		check("pre-dispatch cancel no native dispatch", s.nativeDispatches.length, 0);
	} else if (stage === "cancel-resume") {
		check("cancelled status survives cold process", statusOf(s.manager).state, "CANCELLED");
		check("reopen does not call provider", s.provider.receipts.length, 0);
		check("reopen does not create missing proposal", await s.fileHash(PROPOSAL), null);
		check("cancelled task goal survives", taskOf(s.manager).objective, "待取消的提案任务");
	} else if (stage === "corrupt-seed") {
		await s.prompt(submit("只回复，准备损坏记录负例。", binding("d-corrupt", [], "reply_only")));
		check("valid prior task exists", statusOf(s.manager).reasonCode, "REPLY_ONLY");
		s.manager.appendCustomEntry("pi-desktop-task-contract/v1", { ...taskOf(s.manager), objective: "tampered without updating digest" });
	} else if (stage === "corrupt-resume") {
		await s.prompt("继续");
		check("corrupt latest contract blocks before provider", s.provider.receipts.length, 0);
		check("corrupt branch has no file side effect", s.nativeDispatches.length, 0);
		check("no fallback to older valid task", taskOf(s.manager).objective, "tampered without updating digest");
		check("unsent input restored", s.ui.editor, "继续");
		check("corruption reported to user", s.ui.notices.some(text => text.includes("任务合同无法核验")));
	} else if (stage === "isolation") {
		await s.prompt(submit("会话 A 的写作职能只读任务。", binding("d-session-a", [], "inspection")), (_ctx, n) => n === 1 ? calls(["capture_task_checkpoint", {}, "a-capture"]) : plain);
		const fileA = s.manager.getSessionFile()!, idA = s.manager.getSessionId(), taskA = taskOf(s.manager);
		check("SDK creates independent B session", await s.session.newSession({ setup: async manager => { manager.appendCustomEntry("pi-desktop-novel-role", { role: "plan" }); } }));
		check("B starts without A contract", taskOf(s.manager) === undefined);
		await s.prompt(submit("会话 B 的规划职能独立任务。", binding("d-session-b", [], "inspection", "plan")), (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, "b-get"]) : plain);
		const fileB = s.manager.getSessionFile()!, idB = s.manager.getSessionId(), taskB = taskOf(s.manager);
		check("session IDs differ", idA !== idB);
		check("B checkpoint has no A dependencies", s.json("b-get").status, "empty");
		check("SDK switches B to A", await s.session.switchSession(fileA));
		check("A original task restored", taskOf(s.manager).id, taskA.id);
		check("A original role restored", taskOf(s.manager).owner.role, "write");
		let entered!: () => void, aborted!: () => void, release!: () => void;
		const entry = new Promise<void>(resolve => { entered = resolve; }), abortSeen = new Promise<void>(resolve => { aborted = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
		const pending = s.prompt("继续：等待迟到的响应。", async (_ctx, _n, signal) => {
			signal?.addEventListener("abort", aborted, { once: true }); entered(); await held;
			return calls(["write", { path: PROPOSAL, content: "must not cross into B" }, "late-a-write"]);
		});
		await entry; const switching = s.session.switchSession(fileB); await abortSeen; release(); await pending; check("SDK switch waits for old abort", await switching);
		await s.drain();
		check("late A reply cannot alter B task", taskOf(s.manager).id, taskB.id);
		check("B role remains plan", taskOf(s.manager).owner.role, "plan");
		check("late A write not dispatched", s.nativeDispatches.filter(row => row.tool !== "read").length, 0);
		check("late A write no file", await s.fileHash(PROPOSAL), null);
		await s.prompt("继续", (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, "b-again"]) : plain);
		check("B objective remains its own", s.json("b-again").task.objective, "会话 B 的规划职能独立任务。");
		const requestsBeforeReturn = s.provider.receipts.length;
		check("switching back to interrupted A", await s.session.switchSession(fileA));
		// SDK switchSession disconnects the old event listener before aborting;
		// unlike explicit abort(), its agent_end is not delivered. The persisted
		// RUNNING record must become INTERRUPTED_RUN, never a fresh running task.
		check("A interruption fenced on return", statusOf(s.manager).state, "BLOCKED_PREREQUISITE");
		check("A interruption reason exact", statusOf(s.manager).reasonCode, "INTERRUPTED_RUN");
		check("returning to A does not call provider", s.provider.receipts.length, requestsBeforeReturn);
	} else assert.fail(`Unknown lifecycle stage: ${stage}`);
	state.sessionFile = path.relative(work, s.manager.getSessionFile()!);
	await writeFile(statePath, JSON.stringify(state));
} catch (error) {
	proof.failure = { name: (error as Error).name, message: (error as Error).message };
	console.error(error); process.exitCode = 1;
} finally {
	proof.extensionSha256 = s.sourceHash; proof.nativeDispatches = s.nativeDispatches; proof.verifierCalls = s.verifierCalls; proof.requests = s.provider.receipts; proof.events = s.events;
	proof.task = taskOf(s.manager); proof.status = statusOf(s.manager); proof.checkpoint = checkpointOf(s.manager);
	proof.resultStatuses = s.results.map(row => ({ name: row.name, id: row.id, isError: row.isError }));
	await s.close();
	const after = await treeManifest(project);
	proof.changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]);
	const allowed = new Set([BODY, PROPOSAL, "planning/verifications/002-verification.md", ...(stage === "delivery-changed" ? [CARD] : []), ...(["range-resume", "mutation"].includes(stage) ? [SOURCE] : [])]);
	assert.ok(proof.changedFiles.every((name: string) => allowed.has(name)), "UNEXPECTED_PROJECT_MUTATION");
	proof.finalFileHashes = { body: after[BODY], proposal: after[PROPOSAL] ?? null, source: after[SOURCE], card: after[CARD] };
	await writeFile(output, JSON.stringify(proof, null, 2) + "\n", { flag: "wx" });
}
