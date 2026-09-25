import assert from "node:assert/strict";
import { readFile, writeFile, stat, utimes } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { BODY, CARD, OBJECTIVE, PROPOSAL, SOURCE, binding, calls, candidate, checkpointOf, inside, latest, openSession, plain, proposal, statusOf, submit, taskOf } from "./session.js";
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
const progressType = "pi-desktop-task-progress/v1";

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
		check("PROGRESS_RECEIPTS_VISIBLE", Boolean(s.json("capture-delivery").progress?.items?.some((item: any) => item.kind === "verification" && item.outcome === "passed")));
		const progress = s.json("capture-delivery").progress;
		check("progress is explicitly non-authoritative and not accepted", [progress.authority, progress.userAccepted], [false, false]);
		check("progress retains actual delivered range only", progress.items.filter((item: any) => item.kind === "read" && item.target === SOURCE).flatMap((item: any) => item.sources.map((ref: any) => [ref.startLine, ref.endLine])), [[8, 9]]);
		check("confirmed write receipts refer to both deliverables", progress.items.filter((item: any) => item.kind === "write").map((item: any) => item.target).sort(), [BODY, PROPOSAL].sort());
		state.progressIds = progress.items.map((item: any) => item.id);
		proof.progress = progress;
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
		let projected = false;
		await s.prompt("继续", (ctx, n) => {
			if (n === 1) projected = JSON.stringify(ctx.messages).includes("历史执行轨迹") && state.progressIds.every((id: string) => JSON.stringify(ctx.messages).includes(id));
			return n === 1 ? calls(["get_task_checkpoint", {}, "cold-get"]) : plain;
		});
		check("host history reaches actual post-compaction model context", projected);
		check("cold progress exactly preserves receipt identities", s.json("cold-get").progress.items.map((item: any) => item.id), state.progressIds);
		check("history never claims current validity on its own", s.json("cold-get").progress.items.every((item: any) => item.historical && item.sourceStatus === "not_checked_here"));
		proof.progress = s.json("cold-get").progress;
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
		const oldPass = s.json("stale-card").progress.items.find((item: any) => item.kind === "verification" && item.outcome === "passed");
		check("changed contract marks old PASS as needing revalidation", oldPass?.sourceStatus, "needs_revalidation");
		check("old PASS is retained as history not an acceptance", [oldPass?.historical, s.json("stale-card").progress.authority], [true, false]);
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
	} else if (stage === "metrics-seed") {
		await s.prompt(submit("只读资料并检查本轮计量。", binding("e-metrics", [], "inspection")), (_ctx, n) => n === 1
			? calls(["read", { path: SOURCE, offset: 8, limit: 2 }, "metrics-read"])
			: n === 2 ? calls(["get_context_budget", {}, "metrics-now"]) : plain);
		const current = s.json("metrics-now").metrics;
		check("usage counts completed SDK messages not preflights", current.sdkUsage.responses, 1);
		check("synthetic SDK usage retained with explicit source", current.sdkUsage.totals.input, 1);
		check("provider audits are a separate count", current.providerPayloadAudit.checks, 2);
		check("current preflight has an estimate", current.contextPreflight.latest.estimatedInputTokens > 0);
		check("serialized payload bytes have distinct provenance", current.providerPayloadAudit.latest.serializedInputBytes > 0);
		check("extension cannot infer HTTP dispatch count", current.transport.httpDispatches, null);
		check("native read pre-capture counted once", current.reads.byKind.document.calls, 1);
		check("context checkpoint reads source once", current.reads.lastContext.reads.byKind.checkpointValidation.calls, 1);
		check("context observation reuses the snapshot", current.reads.lastContext.reads.byKind.observationValidation.calls, 0);
		check("same-context physical byte count halves E1 baseline", current.reads.lastContext.reads.total.bytes, 87);
		check("both logical source references remain", current.reads.lastContext.reads.logicalReferences, { observationSources: 1, checkpointSources: 1, observationPages: 0, observationPageBytes: 0 });
		check("cache reuse separately counted", current.reads.lastContext.reads.sourceCache, { hits: 1, misses: 1, invalidations: 0, capacityBypasses: 0, reusedSourceBytes: 87 });
		check("same-context repeated file reads removed", current.reads.lastContext.reads.repeatedPathReadsAtLeast, 0);
		check("SDK native read not misreported as an extension read", s.nativeDispatches.length, 1);
		await s.prompt("查看上一运行计量，不写入。", (_ctx, n) => n === 1 ? calls(["get_context_budget", {}, "metrics-previous"]) : plain);
		const previous = s.json("metrics-previous");
		check("current run does not inherit previous usage", previous.metrics.sdkUsage.responses, 0);
		check("previous run kept exact completed response count", previous.previousRun.metrics.sdkUsage.responses, 3);
		check("previous SDK subtotal differs from input estimate", previous.previousRun.metrics.sdkUsage.totals.totalTokens, 6);
		check("native verifier was not needed for metrics", s.verifierCalls.length, 0);
		proof.metrics = { current, previous: previous.previousRun.metrics };
		await s.compact();
		await s.prompt("/novel-transport-status json");
		const { calibration, ...durableTransport } = JSON.parse(s.ui.notices.at(-1)!);
		state.transport = durableTransport;
		check("synthetic no-fetch provider cannot create calibration anchors", calibration.anchorCount, 0);
		check("task transport includes every ordinary and native summary invocation", state.transport.counters.ordinary + state.transport.counters.summary, s.provider.receipts.length);
		check("native compaction is separately counted", state.transport.counters.summary > 0);
		check("synthetic provider without HTTP never claims network receipts", state.transport.httpRequests, null);
		check("synthetic provider has no fetch dispatches", state.transport.counters.dispatchAttempts, 0);
		proof.taskTransport = state.transport;
	} else if (stage === "metrics-resume") {
		await s.prompt("/novel-transport-status json");
		const { calibration, ...restoredTransport } = JSON.parse(s.ui.notices.at(-1)!);
		check("cold process has no calibration samples", calibration.samples, []);
		check("cold process has no calibration anchors", calibration.anchorCount, 0);
		check("task transport restores exactly in independent OS process", restoredTransport, state.transport);
		check("read-only transport command does not call provider", s.provider.receipts.length, 0);
		await s.prompt("冷启动后只查看计量。", (_ctx, n) => n === 1 ? calls(["get_context_budget", {}, "metrics-cold"]) : plain);
		const cold = s.json("metrics-cold");
		check("cold start does not invent prior in-process metrics", cold.previousRun, null);
		check("cold start current usage remains unknown before first turn end", cold.metrics.sdkUsage.totals.input, null);
		check("cold start no source writes", s.nativeDispatches.filter(row => row.tool !== "read").length, 0);
	} else if (stage === "cache-seed") {
		const target = path.join(project, SOURCE), beforeStat = await stat(target), original = await readFile(target, "utf8");
		await s.prompt(submit("读取资料后生成候选连续性提案。", binding("e-cache-write", [proposal])), async (_ctx, n) => {
			if (n === 1) return calls(["read", { path: SOURCE, offset: 8, limit: 2 }, "cache-read"]);
			if (n === 2) return calls(["get_context_budget", {}, "cache-before-write"]);
			if (n === 3) {
				// The real context hook has already finished. Change the fixture only
				// now, before the synthetic provider returns the native write intent.
				await writeFile(target, original.replace("line-8", "edit-8")); await utimes(target, beforeStat.atime, beforeStat.mtime);
				return calls(["write", { path: PROPOSAL, content: "stale input must not authorize this" }, "cache-stale-write"]);
			}
			return plain;
		});
		const snapshot = s.json("cache-before-write").metrics.reads.lastContext.reads;
		check("production context actually reused source", snapshot.sourceCache.hits, 1);
		check("production context performed one source read", snapshot.total.calls, 1);
		check("file size unchanged after provider boundary edit", (await stat(target)).size, beforeStat.size);
		check("SHA changed despite same size and restored mtime", await s.fileHash(SOURCE) !== sha256(original));
		check("fresh native write gate detects post-context edit", /stale_source/.test(JSON.stringify(s.result("cache-stale-write").result)));
		check("no stale native write dispatched", s.nativeDispatches.filter(row => row.tool !== "read").length, 0);
		check("no proposal side effect", await s.fileHash(PROPOSAL), null);
		proof.cache = { snapshot, contextBeforeMutation: true, finalGateFresh: true };
	} else if (stage === "cache-resume") {
		await s.prompt("继续：只检查旧来源状态，不写入。", (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, "cache-cold-status"])
			: n === 2 ? calls(["get_context_budget", {}, "cache-cold-budget"]) : plain);
		check("cold checkpoint keeps stale source latch", s.json("cache-cold-status").status, "needs_revalidation");
		check("cold run has no previous process cache or counters", s.json("cache-cold-budget").previousRun, null);
		check("cold check does not restore write authority", s.json("cache-cold-status").writeAuthority, false);
		check("cold check no native writes", s.nativeDispatches.filter(row => row.tool !== "read").length, 0);
		check("cold check still no proposal", await s.fileHash(PROPOSAL), null);
	} else if (stage === "progress-seed") {
		await s.prompt(submit("保留实际失败轨迹，正文仍须通过完整验证。", binding("e-progress", [candidate])), (_ctx, n) => n === 1
			? calls(["read_observation", { id: "obs_missing", start: -1 }, "bad-page"])
			: n === 2 ? calls(["get_task_checkpoint", {}, "failure-checkpoint"]) : plain);
		check("invalid page is an actual SDK error result", s.result("bad-page").isError);
		check("typed failure receipt contains exact structured code", s.json("failure-checkpoint").progress.items.some((item: any) => item.error?.kind === "invalid_input" && item.error?.code === "INVALID_PAGE"));
		await s.prompt("继续：写入一个不足字数的公开负例，并执行真实验证。", (_ctx, n) => n === 1
			? calls(["write", { path: BODY, content: "# 第 002 章　双人复核\n\n<!-- SCENE: radio-check -->\n\n字数不足。\n" }, "short-body"])
			: n === 2 ? calls(["verify_chapter", { chapter: "002" }, "fail-verifier"]) : plain);
		check("negative full verifier really executed", s.verifierCalls.length, 1);
		check("failed body does not complete candidate", statusOf(s.manager).reasonCode, "COMPLETION_NOT_VERIFIED");
		const failed = latest(s.manager, progressType).items.find((item: any) => item.kind === "verification" && item.outcome === "failed");
		check("failed verifier preserves report and diagnostic codes", Boolean(failed?.full && failed.report?.sha256 && failed.diagnosticCodes.length));
		for (let i = 0; i < 3; i++) {
			await s.compact();
			await s.prompt("继续：仅查看检查点和历史，不写入或重试。", (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, `progress-after-summary-${i}`]) : plain);
		}
		const progress = s.json("progress-after-summary-2").progress;
		check("failure causes survive three native compactions", progress.items.some((item: any) => item.error?.code === "INVALID_PAGE") && progress.items.some((item: any) => item.id === failed.id));
		check("all retained receipts explicitly historical", progress.items.every((item: any) => item.historical));
		check("summaries did not retry writes or verification", [s.nativeDispatches.filter(row => row.tool === "write").length, s.verifierCalls.length], [1, 1]);
		state.progressIds = progress.items.map((item: any) => item.id); proof.progress = progress;
	} else if (stage === "progress-resume") {
		let projected = false;
		await s.prompt("继续：从历史失败处核对，不执行修复。", (ctx, n) => {
			if (n === 1) projected = JSON.stringify(ctx.messages).includes("INVALID_PAGE") && JSON.stringify(ctx.messages).includes("历史执行轨迹");
			return n === 1 ? calls(["get_task_checkpoint", {}, "progress-cold"]) : plain;
		});
		check("cold failed history is projected to provider", projected);
		check("failure receipt identities persist across OS process", s.json("progress-cold").progress.items.map((item: any) => item.id), state.progressIds);
		check("cold failure not converted to completed task", statusOf(s.manager).reasonCode, "COMPLETION_NOT_VERIFIED");
		const valid = latest(s.manager, progressType);
		s.manager.appendCustomEntry(progressType, { ...valid, id: "corrupted-latest" });
		await s.prompt("继续：检查进展记录损坏，不修复正文。", (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, "progress-corrupt"]) : plain);
		check("corrupt latest progress unavailable not older-success fallback", s.json("progress-corrupt").progress.status, "unavailable");
		check("corrupt optional progress has no displayed old receipts", s.json("progress-corrupt").progress.items, []);
		check("core checkpoint unaffected by optional corruption", s.json("progress-corrupt").status, "ready");
		check("optional corruption never unlocks completion", statusOf(s.manager).reasonCode, "COMPLETION_NOT_VERIFIED");
		await s.prompt(submit("新任务只检查状态。", binding("e-progress-new", [], "inspection")), (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, "progress-new-task"]) : plain);
		check("new task cannot borrow or be poisoned by old progress", s.json("progress-new-task").progress.status, "empty");
		check("cold status inspection never replays anything", [s.nativeDispatches.length, s.verifierCalls.length], [0, 0]);
		proof.progress = { cold: s.json("progress-cold").progress, corrupt: s.json("progress-corrupt").progress, newTask: s.json("progress-new-task").progress };
	} else if (stage === "effective-stop-seed") {
		const short = "# 第 002 章　双人复核\n\n<!-- SCENE: radio-check -->\n\n字数不足。\n";
		await s.prompt(submit("测试机械停滞：不可用无关读取、提案改动或正文空白冒充修复。", binding("e-effective-stop", [candidate])), (_ctx, n) => {
			if (n === 1) return calls(["write", { path: BODY, content: short }, "effective-short"]);
			if (n === 2 || n === 6 || n === 10) return calls(["verify_chapter", { chapter: "002" }, `effective-verify-${n}`]);
			if (n === 3 || n === 7) return calls(["read", { path: SOURCE, offset: n, limit: 1 }, `effective-unrelated-${n}`]);
			// Keep writes sequential. An overlapping second write correctly hits
			// the existing unresolved-operation fence, before this progress oracle.
			if (n === 4 || n === 8) return calls(["write", { path: PROPOSAL, content: `无关提案改动 ${n}\n` }, `effective-proposal-${n}`]);
			if (n === 5 || n === 9) return calls(["write", { path: BODY, content: short + "\n".repeat(n) }, `effective-whitespace-${n}`]);
			assert.fail("Effective no-progress must stop before provider request eleven");
		});
		const status = statusOf(s.manager);
		check("three real failures stop as NO_PROGRESS not a hard budget", [status.state, status.reasonCode, status.verificationAttempts], ["NO_PROGRESS", "UNCHANGED_VERIFICATION", 3]);
		check("exact attempted tool count retained", status.toolCalls, 10);
		check("exact verifier and provider entry counts", [s.verifierCalls.length, s.provider.receipts.length], [3, 11]);
		// Pi 0.63.1 calls streamFunction after transformContext even when the
		// signal was aborted. Our provider records entry before checking it.
		// Distinguish that cancelled entry from a generated reply or HTTP send.
		check("ten generated replies followed by one cancelled entry only", s.provider.receipts.map(row => row.disposition), [...Array(10).fill("synthetic"), "aborted"]);
		check("unrelated reads and meaningless native writes actually dispatched", [s.nativeDispatches.filter(row => row.tool === "read").length, s.nativeDispatches.filter(row => row.tool === "write").length], [2, 5]);
		check("no accidental acceptance or successful full receipt", [status.userAccepted, taskOf(s.manager).progress.verifications[BODY].passed], [false, false]);
		check("agent_end did not overwrite no-progress terminal", status.reasonCode, "UNCHANGED_VERIFICATION");
		state.stopped = status;
	} else if (stage === "effective-stop-resume") {
		check("cold restart preserves exact no-progress snapshot", statusOf(s.manager), state.stopped);
		check("cold restore has no provider or native dispatch", [s.provider.receipts.length, s.nativeDispatches.length, s.verifierCalls.length], [0, 0, 0]);
		const body = await readFile(path.resolve("fixtures/harness-novel", BODY), "utf8");
		await s.prompt("明确开始新的修复轮次：恢复公开合成正文并执行完整验证。", (_ctx, n) => n === 1 ? calls(["write", { path: BODY, content: body }, "effective-fixed-body"])
			: n === 2 ? calls(["verify_chapter", { chapter: "002" }, "effective-fixed-verify"]) : plain);
		const status = statusOf(s.manager);
		check("only explicit input starts a different run", status.scope.runId !== state.stopped.scope.runId);
		check("real fix yields candidate completion only", [status.state, status.reasonCode, status.userAccepted], ["COMPLETED_CANDIDATE", "STOP_VERIFIED", false]);
		check("real full pass clears its failure tracks", [status.unchangedAttempts, Object.keys(status.verificationProgress).length], [0, 0]);
		check("explicit repair runs once without old replay", [s.nativeDispatches.length, s.verifierCalls.length, s.provider.receipts.length], [1, 1, 3]);
	} else if (stage === "effective-repair-seed") {
		const good = await readFile(path.join(project, BODY), "utf8");
		await s.prompt(submit("机械改善正例：逐次缩小字数差额，最后完整通过；仍待人工验收。", binding("e-effective-repair", [candidate])), (_ctx, n) => {
			if (n === 9) {
				const current = statusOf(s.manager);
				check("four improving failures were not falsely stopped", [current.state, current.verificationAttempts, current.unchangedAttempts], ["RUNNING", 4, 1]);
				check("same diagnostic shape kept one improving track", Object.keys(current.verificationProgress).length, 1);
				return calls(["write", { path: BODY, content: good }, "effective-final-repair"]);
			}
			if (n <= 8 && n % 2 === 1) {
				const chars = "测".repeat((n + 1) * 10);
				return calls(["write", { path: BODY, content: `# 第 002 章　双人复核\n\n<!-- SCENE: radio-check -->\n\n${chars}\n\n<!-- SCENE: paper-trace -->\n\n${chars}\n` }, `effective-improved-${n}`]);
			}
			return n <= 10 ? calls(["verify_chapter", { chapter: "002" }, `effective-improved-verify-${n}`]) : plain;
		});
		const status = statusOf(s.manager);
		check("real progressive repair passes full completion gate", [status.state, status.reasonCode, status.userAccepted], ["COMPLETED_CANDIDATE", "STOP_VERIFIED", false]);
		check("exact progressive repair counts", [status.toolCalls, s.verifierCalls.length, s.nativeDispatches.length, s.provider.receipts.length], [10, 5, 5, 11]);
		check("not a claimed or partial PASS", taskOf(s.manager).progress.verifications[BODY].full && taskOf(s.manager).progress.verifications[BODY].passed);
	} else if (stage === "isolation") {
		await s.prompt(submit("会话 A 的写作职能只读任务。", binding("d-session-a", [], "inspection")), (_ctx, n) => n === 1 ? calls(["read", { path: SOURCE }, "a-read"])
			: n === 2 ? calls(["capture_task_checkpoint", {}, "a-capture"]) : plain);
		check("A has its own historical read", s.json("a-capture").progress.items.length, 1);
		const fileA = s.manager.getSessionFile()!, idA = s.manager.getSessionId(), taskA = taskOf(s.manager);
		check("SDK creates independent B session", await s.session.newSession({ setup: async manager => { manager.appendCustomEntry("pi-desktop-novel-role", { role: "plan" }); } }));
		check("B starts without A contract", taskOf(s.manager) === undefined);
		await s.prompt(submit("会话 B 的规划职能独立任务。", binding("d-session-b", [], "inspection", "plan")), (_ctx, n) => n === 1 ? calls(["get_task_checkpoint", {}, "b-get"]) : plain);
		const fileB = s.manager.getSessionFile()!, idB = s.manager.getSessionId(), taskB = taskOf(s.manager);
		check("session IDs differ", idA !== idB);
		check("B checkpoint has no A dependencies", s.json("b-get").status, "empty");
		check("B role and session have no A progress", s.json("b-get").progress.status, "empty");
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
		check("late A reply does not pollute B progress", s.json("b-again").progress.status, "empty");
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
	const allowed = new Set([BODY, PROPOSAL, "planning/verifications/002-verification.md", ...(stage === "delivery-changed" ? [CARD] : []), ...(["range-resume", "mutation", "cache-seed"].includes(stage) ? [SOURCE] : [])]);
	assert.ok(proof.changedFiles.every((name: string) => allowed.has(name)), "UNEXPECTED_PROJECT_MUTATION");
	proof.finalFileHashes = { body: after[BODY], proposal: after[PROPOSAL] ?? null, source: after[SOURCE], card: after[CARD] };
	await writeFile(output, JSON.stringify(proof, null, 2) + "\n", { flag: "wx" });
}
