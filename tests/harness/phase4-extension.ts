import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ExtensionRunner } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";
import { withLoadedExtension } from "./contracts.js";
import { withProject, type RunCase } from "./testkit.js";

const RUN_STATUS_ENTRY = "pi-desktop-run-status/v1";
const SYNTHETIC_MODEL = {
	id: "phase4-offline", name: "Phase 4 offline", api: "openai-completions", provider: "synthetic", baseUrl: "http://127.0.0.1/unused",
	reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
type Entry = { type: string; customType?: string; data?: any; id?: string; parentId?: string | null };

function resultText(result: any): string {
	return result?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
}

async function toolResult(tool: any, id: string, params: Record<string, unknown>, ctx: any): Promise<any> {
	try { return await tool.execute(id, params, undefined, undefined, ctx); }
	catch (error) {
		const result = (error as any)?.toolResult;
		if (result) return result;
		throw error;
	}
}

async function withRunner<T>(root: string, minified: boolean, body: (state: {
	extension: any; runner: ExtensionRunner; entries: Entry[]; branch: () => Entry[];
	setBranch: (entries: Entry[]) => void; setAppendFailure: (value: boolean) => void;
	aborts: () => number; ctx: () => any;
	config: { model: any; activeTools: () => any; allTools: () => any; systemPrompt: () => any };
}) => Promise<T>): Promise<T> {
	return withLoadedExtension(root, minified, async (extension, runtime) => {
		let currentBranch: Entry[] = [{ type: "custom", customType: "pi-desktop-novel-role", data: { role: "write" }, id: "role", parentId: null }];
		const entries: Entry[] = [...currentBranch];
		let appendFailure = false; let abortCount = 0;
		const sessionManager = {
			getSessionId: () => "phase4-session",
			getBranch: () => currentBranch.slice(), getEntries: () => entries.slice(),
			appendCustomEntry: (customType: string, data: unknown) => {
				if (appendFailure) throw new Error("synthetic run-status persistence failure");
				const entry = { type: "custom", customType, data, id: `legacy-${entries.length}`, parentId: currentBranch.at(-1)?.id ?? null };
				entries.push(entry); currentBranch.push(entry); return entry.id;
			},
		};
		const runner = new ExtensionRunner([extension], runtime as never, root, sessionManager as never, {} as never);
		const appendEntry = (customType: string, data: unknown) => {
			if (appendFailure) throw new Error("synthetic run-status persistence failure");
			const entry = { type: "custom", customType, data, id: `entry-${entries.length}`, parentId: currentBranch.at(-1)?.id ?? null };
			entries.push(entry); currentBranch.push(entry);
		};
		const noop = () => undefined;
		const config = { model: { ...SYNTHETIC_MODEL } as any, activeTools: (): any => [], allTools: (): any => [], systemPrompt: (): any => "" };
		runner.bindCore({ sendMessage: noop, sendUserMessage: noop, appendEntry, setSessionName: noop, getSessionName: () => undefined,
			setLabel: noop, getActiveTools: () => config.activeTools(), getAllTools: () => config.allTools(), setActiveTools: noop, refreshTools: noop,
			getCommands: () => [], setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel: noop } as never,
			{ getModel: () => config.model, isIdle: () => true, abort: () => { abortCount++; }, hasPendingMessages: () => false,
				shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => config.systemPrompt() } as never);
		return body({ extension, runner, entries, branch: () => currentBranch.slice(), setBranch: (next) => { currentBranch = next.slice(); },
			setAppendFailure: (value) => { appendFailure = value; }, aborts: () => abortCount, ctx: () => runner.createContext(), config });
	});
}

function latestStatus(entries: Entry[]): any {
	return [...entries].reverse().find((entry) => entry.customType === RUN_STATUS_ENTRY)?.data;
}

function assistant(text: string, stopReason = "stop"): any {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 1, api: "openai-completions", provider: "synthetic", model: "phase4-offline",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason };
}

async function acceptanceSnapshot(root: string): Promise<{ serialized: string; count: number }> {
	const values: string[] = [];
	const visit = async (relative: string): Promise<void> => {
		for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await visit(child);
			else if (/(?:^|\/)(?:acceptances?|approvals?)(?:\/|$)/i.test(child)) values.push(`${child}:${await readFile(path.join(root, child), "utf8")}`);
		}
	};
	await visit(""); return { serialized: JSON.stringify(values.sort()), count: values.length };
}

async function startExplicit(runner: ExtensionRunner): Promise<void> {
	await runner.emitInput("继续当前任务", undefined, "interactive");
	await runner.emit({ type: "agent_start" } as never);
}

export async function runPhase4ExtensionCases(runCase: RunCase): Promise<void> {
	await runCase("P4-BUDGET precise reasons survive abort and reopen without payload persistence", (record) => withProject(async (root) => {
		const cases: Array<[string, (config: any) => void]> = [
			["MODEL_INPUT_BUDGET_EXCEEDED", (config) => { config.model.contextWindow = 128; }],
			["INVALID_BUDGET", (config) => { config.model.contextWindow = -1; }],
			["BUDGET_TOOL_REGISTRY_UNAVAILABLE", (config) => { config.activeTools = () => { throw new Error("PRIVATE_ERROR_SENTINEL"); }; }],
			["BUDGET_TOOL_SCHEMA_UNAVAILABLE", (config) => { config.activeTools = () => ["missing"]; }],
			["BUDGET_SYSTEM_PROMPT_UNAVAILABLE", (config) => { config.systemPrompt = () => { throw new Error("PRIVATE_ERROR_SENTINEL"); }; }],
			["BUDGET_MODEL_UNAVAILABLE", (config) => { config.model = undefined; }],
		];
		for (const [reason, configure] of cases) await withRunner(root, false, async ({ runner, extension, entries, ctx, config, aborts, branch, setBranch }) => {
			const statuses: string[] = [];
			const dialogs: Array<{title: string; text: string}> = [];
			runner.setUIContext({ setStatus: (_key: string, value: string) => statuses.push(value), notify: () => undefined,
				confirm: async (title: string, text: string) => { dialogs.push({ title, text }); return false; } } as never);
			await runner.emit({ type: "session_start" } as never); await startExplicit(runner);
			configure(config);
			const user = { role: "user", content: "PRIVATE_USER_SENTINEL", timestamp: 0 };
			const transformed = await runner.emitContext([user] as never);
			assert.equal((transformed[0] as any).content, user.content);
			assert.ok(aborts() > 0);
			assert.equal(latestStatus(entries).reasonCode, reason);
			assert.equal(latestStatus(entries).toolCalls, 0);
			assert.equal(latestStatus(entries).verificationAttempts, 0);
			const diagnosticEntries = entries.filter((entry) => entry.customType === "pi-desktop-budget-diagnostic/v1");
			assert.equal(diagnosticEntries.length, 1);
			assert.doesNotMatch(JSON.stringify(diagnosticEntries), /PRIVATE_USER|PRIVATE_ERROR/);
			await runner.emit({ type: "agent_end", messages: [assistant("", "aborted")] } as never);
			assert.equal(latestStatus(entries).reasonCode, reason, "generic aborted cannot replace specific failure");
			await runner.emit({ type: "session_start" } as never);
			const status = JSON.parse(resultText(await extension.tools.get("get_run_status")!.definition.execute("status", {}, undefined, undefined, ctx())));
			assert.equal(status.budgetDiagnostic.reason, reason.toLowerCase());
			assert.ok(statuses.at(-1)?.includes(reason), "persistent UI status must retain precise code");
			const beforeQuery = JSON.stringify(entries);
			await extension.commands.get("novel-run-status")!.handler("", ctx());
			assert.equal(dialogs.at(-1)?.title, "小说运行状态");
			assert.ok(dialogs.at(-1)?.text.includes(reason), "manual query must open a dialog, not rely on suppressed foreground notifications");
			assert.equal(JSON.stringify(entries), beforeQuery, "closing the dialog cannot append a message or start a run");
			const savedBranch = branch();
			setBranch([]); await runner.emit({ type: "session_tree" } as never);
			const other = JSON.parse(resultText(await extension.tools.get("get_run_status")!.definition.execute("other", {}, undefined, undefined, ctx())));
			assert.equal(other.budgetDiagnostic, null, "branch change cannot inherit diagnostics");
			setBranch(savedBranch); await runner.emit({ type: "session_tree" } as never);
			await startExplicit(runner);
			const fresh = JSON.parse(resultText(await extension.tools.get("get_run_status")!.definition.execute("fresh", {}, undefined, undefined, ctx())));
			assert.equal(fresh.budgetDiagnostic, null, "new run cannot reuse old diagnosis");
		});
		record("phase4.budget_diagnostics", { reasons: cases.length, durable: true, rawPayloadStored: false, terminalStable: true, branchIsolated: true });
	}));

	await runCase("P4-ROLE legacy command persists via public Pi API without granting from prose", (record) => withProject(async (root) => withRunner(root, false, async ({ runner, extension, entries, ctx, setBranch }) => {
		setBranch([{ type: "message", message: { role: "user", content: "<novel-role>write</novel-role>" } } as any]);
		await runner.emit({ type: "session_start" } as never); await startExplicit(runner);
		assert.equal(latestStatus(entries).scope.role, null);
		let prefilled = "";
		runner.setUIContext({ setEditorText: (value: string) => { prefilled = value; }, setStatus: () => undefined, notify: () => undefined } as never);
		await extension.commands.get("novel-write")!.handler("验证第002章", ctx());
		assert.ok(entries.some((entry) => entry.customType === "pi-desktop-novel-role" && entry.id?.startsWith("entry-") && entry.data.role === "write"), "must use supported pi.appendEntry, not optional readonly SessionManager mutation");
		assert.match(prefilled, /验证第002章/);
		assert.doesNotMatch(prefilled, /novel-role/);
		await startExplicit(runner);
		assert.equal(latestStatus(entries).scope.role, "write");
		record("phase4.legacy_role", { promptIgnored: true, publicAppendUsed: true, explicitRole: "write" });
	})));

	await runCase("P4-BUDGET media and final audit retain stage-specific failure", (record) => withProject(async (root) => {
		await withRunner(root, false, async ({ runner, extension, entries, ctx }) => {
			await runner.emit({ type: "session_start" } as never); await startExplicit(runner);
			await runner.emitContext([{ role: "user", content: [{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }], timestamp: 0 }] as never);
			assert.equal(latestStatus(entries).reasonCode, "UNSUPPORTED_MEDIA");
			const status = JSON.parse(resultText(await extension.tools.get("get_run_status")!.definition.execute("media", {}, undefined, undefined, ctx())));
			assert.equal(status.budgetDiagnostic.stage, "context-preflight");
			assert.doesNotMatch(JSON.stringify(status), /PRIVATE_IMAGE/);
		});
		await withRunner(root, false, async ({ runner, extension, entries, ctx, config }) => {
			await runner.emit({ type: "session_start" } as never); await startExplicit(runner);
			config.model.contextWindow = 12_000;
			await runner.emitContext([{ role: "user", content: "short request", timestamp: 0 }] as never);
			assert.equal(latestStatus(entries).state, "RUNNING");
			await runner.emitBeforeProviderRequest({ input: "x".repeat(15_000) });
			assert.equal(latestStatus(entries).reasonCode, "MODEL_INPUT_BUDGET_EXCEEDED");
			const status = JSON.parse(resultText(await extension.tools.get("get_run_status")!.definition.execute("audit", {}, undefined, undefined, ctx())));
			assert.equal(status.budgetDiagnostic.stage, "provider-audit");
			assert.match(status.guidanceZh, /不保证请求尚未发出/);
		});
		record("phase4.budget_stages", { mediaBlocked: true, providerStage: true, noAbsoluteLateGateClaim: true });
	}));

	await runCase("P4-ADAPTER first start supervised and only explicit input resets", (record) => withProject(async (root) => {
		for (const minified of [false, true]) await withRunner(root, minified, async ({ extension, runner, entries, ctx }) => {
			assert.ok(extension.tools.has("get_run_status"), "managed extension must expose run supervision status");
			await runner.emit({ type: "session_start" } as never);
			await runner.emit({ type: "agent_start" } as never);
			const initial = latestStatus(entries);
			assert.equal(initial?.state, "RUNNING", "the first agent start must never escape supervision");
			await runner.emit({ type: "agent_start" } as never);
			assert.equal(latestStatus(entries).scope.runId, initial.scope.runId, "an SDK/provider retry without new user input must keep its run");
			await startExplicit(runner);
			const begun = latestStatus(entries);
			assert.equal(begun?.state, "RUNNING");
			assert.equal(begun?.scope?.sessionId, "phase4-session");
			assert.equal(begun?.scope?.role, "write");
			const status = JSON.parse(resultText(await toolResult(extension.tools.get("get_run_status")!.definition, "status", {}, ctx())));
			assert.equal(status.snapshot?.state ?? status.state, "RUNNING");
			assert.match(status.guidanceZh ?? status.guidance ?? "", /运行|监管|继续/);
			const runId = begun.scope.runId;
			await runner.emit({ type: "agent_start" } as never);
			assert.equal(latestStatus(entries).scope.runId, runId, "automatic agent retry must keep the same supervised run");
		});
		record("phase4.adapter", { realLoader: true, minified: true, firstStartSupervised: true, explicitResetOnly: true, durableStatus: true });
	}));

	await runCase("P4-STATE terminal status gates later tools and agent_end cannot overwrite it", (record) => withProject(async (root) => withRunner(root, false, async ({ extension, runner, entries, aborts, ctx }) => {
		await mkdir(path.join(root, ".novel/tools"), { recursive: true });
		await copyFile(path.resolve("scripts/verify-novel-chapter.ts"), path.join(root, ".novel/tools/verify-novel-chapter.ts"));
		await runner.emit({ type: "session_start" } as never);
		await startExplicit(runner);
		for (let attempt = 1; attempt <= 3; attempt++) {
			const result = await toolResult(extension.tools.get("verify_chapter")!.definition, `verify-${attempt}`, { chapter: "003" }, ctx());
			assert.equal(result.isError, true);
			await runner.emit({ type: "turn_end", turnIndex: attempt - 1, message: assistant("仍需修复"), toolResults: [] } as never);
		}
		assert.equal(latestStatus(entries)?.state, "NO_PROGRESS");
		assert.equal(latestStatus(entries)?.reasonCode, "UNCHANGED_VERIFICATION");
		assert.ok(aborts() >= 1, "terminal no-progress must stop Pi's active agent loop");
		const blocked = await runner.emitToolCall({ type: "tool_call", toolCallId: "after-stop", toolName: "write", input: { path: "drafts/candidates/chapters/002.md", content: "must not dispatch" } } as never);
		assert.equal(blocked?.block, true);
		await runner.emit({ type: "agent_end", messages: [assistant("完成")] } as never);
		assert.equal(latestStatus(entries)?.state, "NO_PROGRESS", "agent_end must not overwrite a terminal state");
		record("phase4.terminal_gate", { threeStrikes: true, laterToolBlocked: true, terminalStable: true });
	})));

	await runCase("P4-FAIL-CLOSED run-status persistence failure blocks dispatch", (record) => withProject(async (root) => withRunner(root, false, async ({ runner, entries, setAppendFailure }) => {
		await runner.emit({ type: "session_start" } as never);
		await startExplicit(runner);
		const persisted = entries.filter((entry) => entry.customType === RUN_STATUS_ENTRY).length;
		setAppendFailure(true);
		const decision = await runner.emitToolCall({ type: "tool_call", toolCallId: "persistence-failure", toolName: "write", input: { path: "drafts/candidates/chapters/002.md", content: "must not dispatch" } } as never);
		assert.equal(decision?.block, true);
		assert.match(decision?.reason ?? "", /persist|保存|状态|监管/i);
		assert.equal(entries.filter((entry) => entry.customType === RUN_STATUS_ENTRY).length, persisted);
		record("phase4.fail_closed", { persistenceFailureBlocked: true, sideEffectDispatched: false });
	})));

	await runCase("P4-COMPLETE only a current full PASS can become a candidate", async (record) => {
		const scenario = async (name: string, action: (state: { root: string; extension: any; runner: ExtensionRunner; entries: Entry[]; ctx: () => any }) => Promise<void>) => withProject(async (root) => withRunner(root, false, async (state) => {
			const acceptanceBefore = await acceptanceSnapshot(root);
			assert.ok(acceptanceBefore.count > 0, "completion cases must cover real acceptance records");
			await mkdir(path.join(root, ".novel/tools"), { recursive: true });
			await copyFile(path.resolve("scripts/verify-novel-chapter.ts"), path.join(root, ".novel/tools/verify-novel-chapter.ts"));
			await state.runner.emit({ type: "session_start" } as never); await startExplicit(state.runner);
			await action({ root, ...state });
			assert.ok(latestStatus(state.entries), `${name} must persist a final status`);
			assert.deepEqual(await acceptanceSnapshot(root), acceptanceBefore, `${name} must not mutate user acceptance`);
		}));
		const verify = async (state: { extension: any; ctx: () => any }, id: string, params: Record<string, unknown>) => {
			const result = await toolResult(state.extension.tools.get("verify_chapter")!.definition, id, params, state.ctx());
			assert.equal(result.isError, undefined, resultText(result));
		};
		await scenario("full-pass", async (state) => {
			await verify(state, "complete-full", { chapter: "002" });
			await state.runner.emit({ type: "agent_end", messages: [assistant("完整机械验证已经通过")] } as never);
			assert.equal(latestStatus(state.entries).state, "COMPLETED_CANDIDATE");
			assert.equal(latestStatus(state.entries).userAccepted, false);
		});
		await scenario("partial-pass", async (state) => {
			await verify(state, "complete-partial", { chapter: "002", scene: "radio-check" });
			await state.runner.emit({ type: "agent_end", messages: [assistant("局部场景完成")] } as never);
			assert.notEqual(latestStatus(state.entries).state, "COMPLETED_CANDIDATE");
		});
		await scenario("edited-after-pass", async (state) => {
			await verify(state, "complete-before-edit", { chapter: "002" });
			const target = path.join(state.root, "drafts/candidates/chapters/002.md");
			await writeFile(target, `${await readFile(target, "utf8")}\n验证后编辑。\n`, "utf8");
			await state.runner.emit({ type: "agent_end", messages: [assistant("验证后又发生编辑")] } as never);
			assert.notEqual(latestStatus(state.entries).state, "COMPLETED_CANDIDATE");
		});
		await scenario("dependency-changed", async (state) => {
			await verify(state, "complete-before-dependency", { chapter: "002" });
			const dependency = path.join(state.root, "planning/chapter-cards/002.md");
			await writeFile(dependency, `${await readFile(dependency, "utf8")}\n`, "utf8");
			await toolResult(state.extension.tools.get("read_story_document")!.definition, "dependency-reread", { path: "planning/chapter-cards/002.md" }, state.ctx());
			await toolResult(state.extension.tools.get("refresh_task_checkpoint")!.definition, "dependency-refresh", {}, state.ctx());
			await state.runner.emit({ type: "agent_end", messages: [assistant("依赖已变化")] } as never);
			assert.notEqual(latestStatus(state.entries).state, "COMPLETED_CANDIDATE");
		});
		for (const stopReason of ["length", "error", "aborted"]) await scenario(stopReason, async (state) => {
			await verify(state, `complete-${stopReason}`, { chapter: "002" });
			await state.runner.emit({ type: "agent_end", messages: [assistant("非正常停止", stopReason)] } as never);
			assert.notEqual(latestStatus(state.entries).state, "COMPLETED_CANDIDATE");
		});
		record("phase4.completion", { fullPassCandidate: true, partialRejected: true, editedRejected: true, dependencyRejected: true, abnormalStopsRejected: 3, acceptanceMutations: 0 });
	});

	await runCase("P4-SCOPE non-novel sessions remain ordinary coding sessions", (record) => withProject(async (root) => {
		await rm(path.join(root, ".novel/project.json"));
		await withRunner(root, false, async ({ runner, entries }) => {
			await runner.emit({ type: "session_start" } as never);
			await runner.emit({ type: "agent_start" } as never);
			assert.equal(latestStatus(entries), undefined);
			const coding = await runner.emitToolCall({ type: "tool_call", toolCallId: "ordinary-write", toolName: "write", input: { path: "ordinary.txt", content: "ordinary coding" } } as never);
			assert.equal(coding?.block, undefined, coding?.reason);
		});
		record("phase4.non_novel", { statusEntries: 0, codingToolBlocked: false });
	}));

	await runCase("P4-FAILURES permission, cancellation and late callbacks are terminal", (record) => withProject(async (root) => {
		await withRunner(root, false, async ({ runner, entries }) => {
			await runner.emit({ type: "session_start" } as never); await startExplicit(runner);
			const denied = await runner.emitToolCall({ type: "tool_call", toolCallId: "permission-denied", toolName: "write", input: { path: "canon/world.md", content: "forbidden" } } as never);
			assert.equal(denied?.block, true);
			assert.equal(latestStatus(entries)?.state, "BLOCKED_USER");
			assert.match(latestStatus(entries)?.reasonCode ?? "", /PERMISSION|ROLE|WRITE/i);
		});
		await withRunner(root, false, async ({ runner, entries }) => {
			await runner.emit({ type: "session_start" } as never); await startExplicit(runner);
			await runner.emit({ type: "agent_end", messages: [assistant("用户取消", "aborted")] } as never);
			const cancelled = latestStatus(entries);
			assert.equal(cancelled.state, "CANCELLED");
			await runner.emit({ type: "tool_result", toolCallId: "late-error", toolName: "read_story_document", input: { path: "missing.md" }, content: [{ type: "text", text: "late" }], isError: true,
				details: { harness: { error: { kind: "precondition", code: "LATE_TYPED_FAILURE", message: "late callback" } } } } as never);
			assert.equal(latestStatus(entries).id, cancelled.id, "late typed failures cannot mutate an ended generation");
		});
		record("phase4.failures", { permissionTerminal: true, cancelledTerminal: true, lateIgnored: true });
	}));

	await runCase("P4-DEDUP reliable tool failures count once across execute and tool_result", (record) => withProject(async (root) => withRunner(root, false, async ({ extension, runner, entries, ctx }) => {
		await mkdir(path.join(root, ".novel/tools"), { recursive: true });
		await copyFile(path.resolve("scripts/verify-novel-chapter.ts"), path.join(root, ".novel/tools/verify-novel-chapter.ts"));
		await runner.emit({ type: "session_start" } as never); await startExplicit(runner);
		const failed = await toolResult(extension.tools.get("verify_chapter")!.definition, "dedup-verify", { chapter: "003" }, ctx());
		assert.equal(failed.isError, true);
		await runner.emit({ type: "turn_end", turnIndex: 0, message: assistant("验证未通过"), toolResults: [] } as never);
		const afterExecute = latestStatus(entries);
		const failureCount = Object.values(afterExecute.failureSignatures as Record<string, number>).reduce((sum: number, count) => sum + count, 0);
		assert.ok(failureCount <= 1, "one verifier failure must never create multiple generic failure samples");
		assert.equal(afterExecute.verificationAttempts, 1);
		await runner.emit({ type: "tool_result", toolCallId: "dedup-verify", toolName: "verify_chapter", input: { chapter: "003" },
			content: failed.content, details: failed.details, isError: true } as never);
		const afterEvent = latestStatus(entries);
		assert.equal(Object.values(afterEvent.failureSignatures as Record<string, number>).reduce((sum: number, count) => sum + count, 0), failureCount, "the SDK result event must not count the reliable execute failure twice");
		assert.equal(afterEvent.verificationAttempts, 1, "the verifier receipt must remain idempotent by call id");
		record("phase4.failure_dedup", { executeFailures: 1, toolResultDuplicates: 1, countedFailures: failureCount, verificationAttempts: 1 });
	})));

	await runCase("P4-GENERATION late agent and turn ends cannot mutate a newer run", (record) => withProject(async (root) => withRunner(root, false, async ({ runner, entries }) => {
		await runner.emit({ type: "session_start" } as never); await startExplicit(runner);
		const oldRun = latestStatus(entries);
		const oldAgentEnd = runner.emit({ type: "agent_end", messages: [assistant("旧运行结束")] } as never);
		await runner.emitInput("在旧结束钩子核验期间开始明确的新任务", undefined, "interactive");
		await runner.emit({ type: "agent_start" } as never);
		const newRun = latestStatus(entries);
		assert.notEqual(newRun.scope.runId, oldRun.scope.runId);
		assert.equal(newRun.state, "RUNNING");
		await oldAgentEnd;
		assert.equal(latestStatus(entries).scope.runId, newRun.scope.runId, "late agent_end must retain the new run scope");
		assert.equal(latestStatus(entries).state, "RUNNING", "late agent_end must not complete or clear the new run");
		const beforeTurns = latestStatus(entries).turns;
		const staleTurn = runner.emit({ type: "turn_end", turnIndex: 0, message: assistant("旧轮次"), toolResults: [] } as never);
		await runner.emitInput("再开始一个明确的新运行", undefined, "interactive");
		await runner.emit({ type: "agent_start" } as never);
		const newest = latestStatus(entries);
		await staleTurn;
		assert.equal(latestStatus(entries).scope.runId, newest.scope.runId);
		assert.equal(latestStatus(entries).turns, 0, `stale turn_end must not transfer old turn count ${beforeTurns} into the new generation`);
		record("phase4.generation_fence", { lateAgentEndsIgnored: 1, lateTurnEndsIgnored: 1, newRunsPreserved: 2 });
	})));
}

export async function runLongHorizonCases(runCase: RunCase): Promise<void> {
	await runCase("P4-LONG real extension multi-turn supervision trace", (record) => withProject(async (root) => withRunner(root, false, async ({ extension, runner, entries, ctx }) => {
		await mkdir(path.join(root, ".novel/tools"), { recursive: true });
		await copyFile(path.resolve("scripts/verify-novel-chapter.ts"), path.join(root, ".novel/tools/verify-novel-chapter.ts"));
		const acceptanceBefore = await acceptanceSnapshot(root);
		assert.ok(acceptanceBefore.count > 0, "public fixture must exercise real acceptance files");
		await runner.emit({ type: "session_start" } as never);
		await startExplicit(runner);
		const read = await toolResult(extension.tools.get("read_story_document")!.definition, "long-read", { path: "canon/world.md" }, ctx());
		assert.match(resultText(read), /^# canon\/world\.md/m);
		const chapterPath = path.join(root, "drafts/candidates/chapters/002.md");
		const original = await readFile(chapterPath, "utf8");
		const invalid = `${original}\n- synthetic list pollution\n`;
		let dispatchedWrites = 0;
		const writeOnce = async (id: string, content: string) => {
			const decision = await runner.emitToolCall({ type: "tool_call", toolCallId: id, toolName: "write", input: { path: "drafts/candidates/chapters/002.md", content } } as never);
			assert.equal(decision?.block, undefined, decision?.reason);
			dispatchedWrites++;
			await writeFile(chapterPath, content, "utf8");
			await runner.emit({ type: "tool_result", toolCallId: id, toolName: "write", input: { path: "drafts/candidates/chapters/002.md", content }, content: [{ type: "text", text: "ok" }], details: undefined, isError: false } as never);
		};
		await writeOnce("long-invalid-write", invalid);
		const failed = await toolResult(extension.tools.get("verify_chapter")!.definition, "long-fail", { chapter: "002" }, ctx());
		assert.equal(failed.isError, true);
		await runner.emit({ type: "turn_end", turnIndex: 0, message: assistant("修复机械错误"), toolResults: [] } as never);
		await writeOnce("long-repair-write", original);
		const passed = await toolResult(extension.tools.get("verify_chapter")!.definition, "long-pass", { chapter: "002" }, ctx());
		assert.equal(passed.isError, undefined);
		await runner.emit({ type: "session_before_compact", preparation: { messagesToSummarize: [], turnPrefixMessages: [] }, branchEntries: ctx().sessionManager.getBranch(), signal: new AbortController().signal } as never);
		await runner.emit({ type: "session_compact", compactionEntry: { type: "compaction", id: "long-compact", parentId: null, timestamp: "2026-01-01T00:00:00Z", summary: "bounded summary", firstKeptEntryId: null, tokensBefore: 1, fromHook: false }, fromExtension: false } as never);
		await runner.emit({ type: "agent_end", messages: [assistant("本轮候选稿已通过机械验证")] } as never);
		const completed = latestStatus(entries);
		assert.equal(completed.state, "COMPLETED_CANDIDATE", JSON.stringify(completed));
		const sourcePath = path.join(root, "canon/world.md");
		await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\nsource-version-change\n`, "utf8");
		await runner.emit({ type: "session_start" } as never);
		const stale = await runner.emitToolCall({ type: "tool_call", toolCallId: "long-stale-write", toolName: "write", input: { path: "drafts/candidates/chapters/002.md", content: original } } as never);
		assert.equal(stale?.block, true, "restored terminal run must not replay or accept writes");
		await startExplicit(runner);
		const changed = `${original}\n来源刷新后的新一轮候选内容。\n`;
		const staleSource = await runner.emitToolCall({ type: "tool_call", toolCallId: "long-stale-source-write", toolName: "write", input: { path: "drafts/candidates/chapters/002.md", content: changed } } as never);
		assert.equal(staleSource?.block, true, "a new run must still respect stale checkpoint evidence");
		assert.match(staleSource?.reason ?? "", /stale_source|来源|失效/i);
		assert.equal(await readFile(chapterPath, "utf8"), original, "stale-source gating must not mutate the candidate");
		await toolResult(extension.tools.get("read_story_document")!.definition, "long-reread", { path: "canon/world.md" }, ctx());
		const refreshed = await toolResult(extension.tools.get("refresh_task_checkpoint")!.definition, "long-refresh", {}, ctx());
		assert.equal(refreshed.isError, undefined, resultText(refreshed));
		await writeOnce("long-after-refresh", changed);
		const bytesAfterWrite = await readFile(chapterPath, "utf8");
		const duplicate = await runner.emitToolCall({ type: "tool_call", toolCallId: "long-after-refresh", toolName: "write", input: { path: "drafts/candidates/chapters/002.md", content: changed } } as never);
		assert.equal(duplicate?.block, true, "a completed side effect must not dispatch twice");
		assert.equal(await readFile(chapterPath, "utf8"), bytesAfterWrite);
		assert.equal(dispatchedWrites, 3);
		assert.equal(latestStatus(entries).state, "RUNNING");
		const statusEntries = entries.filter((entry) => entry.customType === RUN_STATUS_ENTRY);
		assert.ok(statusEntries.length >= 2);
		const projectA = latestStatus(entries).scope.projectId;
		const aCount = statusEntries.length;
		await withProject(async (otherRoot) => withRunner(otherRoot, false, async ({ runner: otherRunner, entries: otherEntries }) => {
			await otherRunner.emit({ type: "session_start" } as never);
			await otherRunner.emit({ type: "agent_start" } as never);
			assert.notEqual(latestStatus(otherEntries).scope.projectId, projectA, "project B must have an isolated supervisor scope");
		}));
		assert.equal(entries.filter((entry) => entry.customType === RUN_STATUS_ENTRY).length, aCount, "project B must not append into project A's session");
		const acceptanceAfter = await acceptanceSnapshot(root);
		assert.ok(acceptanceAfter.count > 0);
		assert.deepEqual(acceptanceAfter, acceptanceBefore, "supervision must not mutate user acceptance files");
		record("phase4.long_horizon", {
			storyReadCalls: 2, dispatchedWrites, verificationFailures: 1, verificationPasses: 1, compactionHookCycles: 1, sourceVersionChanges: 1,
			sessionStartRestores: 1, projects: 2, terminalDispatchesBlocked: 1, staleSourceDispatchesBlocked: 1, duplicateDispatchesBlocked: 1,
			staleEvidenceWrites: 0, duplicateSideEffects: 0, acceptanceMutations: 0,
		});
	})));
}
