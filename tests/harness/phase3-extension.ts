import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ExtensionRunner } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";
import { prepareCompaction } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js";
import { createCheckpointStore, type CheckpointInput, type TaskCheckpoint } from "../../src/harness/checkpoint-store.js";
import { withLoadedExtension } from "./contracts.js";
import { withProject, type RunCase } from "./testkit.js";

const CHECKPOINT_TYPE = "pi-desktop-task-checkpoint";
const checkpointStore = createCheckpointStore({ digest: (value) => createHash("sha256").update(value).digest("hex") });
const SYNTHETIC_MODEL = {
	id: "phase3-offline", name: "Phase 3 offline", api: "openai-completions", provider: "synthetic", baseUrl: "http://127.0.0.1/unused",
	reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
type Entry = { type: string; customType?: string; data?: any; id?: string; parentId?: string | null };

function text(result: any): string {
	return result?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") ?? "";
}

function checkpointFrom(result: any): any {
	if (result?.details?.checkpoint) return result.details.checkpoint;
	const raw = text(result).trim();
	if (!raw) return undefined;
	try { return JSON.parse(raw).checkpoint ?? JSON.parse(raw); } catch { return result?.details?.harness?.checkpoint; }
}

function rebuildCheckpoint(checkpoint: TaskCheckpoint, patch: Partial<CheckpointInput>): TaskCheckpoint {
	const { schemaVersion: _schemaVersion, id: _id, ...input } = checkpoint;
	return checkpointStore.build({ ...input, ...patch });
}

async function toolResult(tool: any, id: string, params: Record<string, unknown>, ctx: any): Promise<any> {
	try { return await tool.execute(id, params, undefined, undefined, ctx); }
	catch (error) {
		const result = (error as any)?.toolResult;
		if (result) return result;
		throw error;
	}
}

async function restoredToolText(extension: any, result: any, ctx: any, idPrefix: string): Promise<string> {
	if (!result?.details?.offloaded) return text(result);
	const observationId = result?.details?.observation?.id;
	assert.equal(typeof observationId, "string", "offloaded tool output must expose its observation id");
	const fetch = extension.tools.get("read_observation")?.definition;
	assert.ok(fetch, "real extension must expose paginated observation reads");
	let start = 0;
	let restored = "";
	for (let page = 0; page < 128; page += 1) {
		const part = await toolResult(fetch, `${idPrefix}-page-${page}`, { id: observationId, start, limit: 4_000 }, ctx);
		const payload = text(part).replace(/\n\[(?:更多内容：start=\d+|记录结束)\]$/, "");
		restored += payload;
		if (!part.details?.hasMore) return restored;
		assert.ok(payload.length > 0, "observation pagination must make forward progress");
		start += payload.length;
	}
	assert.fail("observation pagination exceeded the bounded page limit");
}

async function withRunner<T>(root: string, minified: boolean, body: (state: {
	extension: any;
	runner: ExtensionRunner;
	entries: Entry[];
	setBranch: (entries: Entry[]) => void;
	setAppendFailure: (enabled: boolean) => void;
	ctx: () => any;
}) => Promise<T>): Promise<T> {
	return withLoadedExtension(root, minified, async (extension, loadedRuntime?: unknown) => {
		let branch: Entry[] = [{ type: "custom", customType: "pi-desktop-novel-role", data: { role: "write" }, id: "role", parentId: null }];
		const entries: Entry[] = [...branch];
		const sessionManager = {
			getSessionId: () => "phase3-session",
			getBranch: () => branch.slice(),
			getEntries: () => entries.slice(),
			appendCustomEntry: (customType: string, data: unknown) => {
				const entry = { type: "custom", customType, data, id: `legacy-${entries.length}`, parentId: branch.at(-1)?.id ?? null };
				entries.push(entry); branch.push(entry); return entry.id;
			},
		};
		assert.ok(loadedRuntime, "withLoadedExtension must expose the real SDK runtime");
		const runner = new ExtensionRunner([extension], loadedRuntime as never, root, sessionManager as never, {} as never);
		let appendFailure = false;
		const appendEntry = (customType: string, data: unknown) => {
			if (appendFailure) throw new Error("synthetic appendEntry persistence failure");
			const entry = { type: "custom", customType, data, id: `entry-${entries.length}`, parentId: branch.at(-1)?.id ?? null };
			entries.push(entry); branch.push(entry);
		};
		const noop = () => undefined;
		runner.bindCore({ sendMessage: noop, sendUserMessage: noop, appendEntry, setSessionName: noop, getSessionName: () => undefined,
			setLabel: noop, getActiveTools: () => [], getAllTools: () => [], setActiveTools: noop, refreshTools: noop,
			getCommands: () => [], setModel: async () => true, getThinkingLevel: () => "off", setThinkingLevel: noop } as never,
			{ getModel: () => SYNTHETIC_MODEL, isIdle: () => true, abort: noop, hasPendingMessages: () => false, shutdown: noop,
				getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => "" } as never);
		return await body({ extension, runner, entries, setBranch: (next) => { branch = next.slice(); }, setAppendFailure: (enabled) => { appendFailure = enabled; }, ctx: () => runner.createContext() });
	});
}

export async function runPhase3ExtensionCases(runCase: RunCase): Promise<void> {
	await runCase("P3-CHECKPOINT native compaction seam survives real loader variants", (record) => withProject(async (root) => {
		for (const minified of [false, true]) await withRunner(root, minified, async ({ extension, runner, entries, ctx }) => {
			assert.ok(extension.tools.has("get_task_checkpoint"));
			assert.ok(extension.tools.has("refresh_task_checkpoint"));
			await toolResult(extension.tools.get("read_story_document")!.definition, "checkpoint-source", { path: "canon/world.md" }, ctx());
			const rawToolPayload = "RAW_NATIVE_TOOL_PAYLOAD_MUST_BE_EXTERNALIZED";
			const nativeEntries = [
				{ type: "custom_message", id: "native-system", parentId: null, timestamp: "2026-01-01T00:00:00Z", customType: "system-guidance", content: "SYSTEM_GUIDANCE_MUST_SURVIVE", display: false },
				{ type: "message", id: "native-user-1", parentId: "native-system", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "USER_INSTRUCTION_MUST_SURVIVE " + "A".repeat(2000), timestamp: 0 } },
				{ type: "message", id: "native-assistant-1", parentId: "native-user-1", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "assistant preface" }, { type: "toolCall", id: "native-tool", name: "read", arguments: { path: "canon/world.md" } }], timestamp: 1, api: "openai-completions", provider: "synthetic", model: "phase3-offline", usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" } },
				{ type: "message", id: "native-result-1", parentId: "native-assistant-1", timestamp: "2026-01-01T00:00:03Z", message: { role: "toolResult", toolCallId: "native-tool", toolName: "read", content: [{ type: "text", text: rawToolPayload }], isError: false, timestamp: 2, details: { observation: { sourceRefs: [{ path: "canon/world.md", sha256: "a".repeat(64) }] } } } },
				{ type: "message", id: "native-user-2", parentId: "native-result-1", timestamp: "2026-01-01T00:00:04Z", message: { role: "user", content: "recent", timestamp: 3 } },
			] as never;
			const preparation = prepareCompaction(nativeEntries, { enabled: true, reserveTokens: 4096, keepRecentTokens: 1 });
			assert.ok(preparation, "real SDK must produce a native preparation fixture");
			const nativeInputBeforeHook = structuredClone(preparation);
			const result = await runner.emit({ type: "session_before_compact", preparation, branchEntries: nativeEntries, customInstructions: "KEEP_NATIVE_COMPACTOR", signal: new AbortController().signal });
			assert.equal(result, undefined, "checkpoint hook must not replace Pi's native LLM compaction");
			for (const field of ["messagesToSummarize", "turnPrefixMessages"] as const) {
				assert.deepEqual(preparation[field].map((message: any) => message.role), nativeInputBeforeHook[field].map((message: any) => message.role), "message order and roles must be preserved");
				for (let index = 0; index < preparation[field].length; index += 1) {
					const before = nativeInputBeforeHook[field][index] as any;
					const after = preparation[field][index] as any;
					if (before.role !== "toolResult") assert.deepEqual(after, before, "user, assistant and system/custom text must remain byte-for-byte unchanged");
					else {
						assert.equal(after.toolCallId, before.toolCallId);
						assert.equal(after.toolName, before.toolName);
						assert.equal(after.isError, before.isError);
						assert.equal(after.timestamp, before.timestamp);
						assert.doesNotMatch(JSON.stringify(after.content), new RegExp(rawToolPayload));
						assert.match(JSON.stringify(after.content), /工具观察已外置/);
						assert.equal(after.details, undefined);
					}
				}
			}
			assert.match(JSON.stringify(preparation), /USER_INSTRUCTION_MUST_SURVIVE/);
			assert.match(JSON.stringify(preparation), /SYSTEM_GUIDANCE_MUST_SURVIVE/);
			assert.doesNotMatch(JSON.stringify(preparation), new RegExp(rawToolPayload));
			const sdkCompactorSource = await readFile(path.resolve("node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js"), "utf8");
			assert.match(sdkCompactorSource, /const \{ firstKeptEntryId, messagesToSummarize, turnPrefixMessages,[\s\S]*\} = preparation;/, "pinned native compact must consume the shared preparation object after hooks");
			assert.match(sdkCompactorSource, /generateSummary\(messagesToSummarize,/);
			const saved = entries.filter((entry) => entry.customType === CHECKPOINT_TYPE);
			assert.equal(saved.length, 1);
			assert.equal(saved[0].data?.scope?.sessionId, "phase3-session");
			assert.equal(saved[0].data?.scope?.role, "write");
			assert.equal(typeof saved[0].data?.id, "string");
			assert.ok(Array.isArray(saved[0].data?.evidence));
			assert.notEqual(saved[0].data?.writeAuthority, true, "checkpoint data is never automatic write authority");
			const cancelledPreparation = prepareCompaction(nativeEntries, { enabled: true, reserveTokens: 4096, keepRecentTokens: 1 })!;
			const cancelledBefore = structuredClone(cancelledPreparation);
			const abort = new AbortController(); abort.abort();
			const cancelled = await runner.emit({ type: "session_before_compact", preparation: cancelledPreparation, branchEntries: nativeEntries, signal: abort.signal });
			assert.equal(cancelled?.cancel, true);
			assert.deepEqual(cancelledPreparation, cancelledBefore, "an already-cancelled hook must not rewrite native compaction input");
		});
		record("checkpoint.compaction", { realLoader: true, minified: true, nativeCompactorPreserved: true });
	}));

	await runCase("P3-COMPRESSION preserves constraints across three native cycles", (record) => withProject(async (root) => withRunner(root, false, async ({ extension, runner, entries, setBranch, ctx }) => {
		const constraint = "硬约束：不得修改 Canon，必须等待用户确认。";
		const rawSummary = "STALE_RAW_COMPACTION_SUMMARY_MUST_NOT_GAIN_AUTHORITY";
		setBranch([
			...ctx().sessionManager.getBranch(),
			{ type: "message", id: "constraint", parentId: "role", data: undefined, message: { role: "user", content: constraint } } as any,
			{ type: "compaction", id: "old-summary", parentId: "constraint", summary: rawSummary } as any,
		]);
		await toolResult(extension.tools.get("read_story_document")!.definition, "cycle-source", { path: "canon/world.md" }, ctx());
		const sourcePath = path.join(root, "canon/world.md");
		await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\nstale-after-first-cycle`, "utf8");
		for (let cycle = 1; cycle <= 3; cycle += 1) {
			const before = await runner.emit({ type: "session_before_compact", preparation: {} as never, branchEntries: ctx().sessionManager.getBranch(), signal: new AbortController().signal });
			assert.equal(before, undefined);
			await runner.emit({ type: "session_compact", compactionEntry: { type: "compaction", id: `compact-${cycle}`, parentId: null, timestamp: "2026-01-01T00:00:00Z", summary: `summary-${cycle}`, firstKeptEntryId: "constraint", tokensBefore: 100, fromHook: false } as never, fromExtension: false });
		}
		const latest = checkpointStore.parse([...entries].reverse().find((entry) => entry.customType === CHECKPOINT_TYPE)!.data);
		assert.ok(latest.hardConstraints.includes(constraint));
		assert.doesNotMatch(JSON.stringify(latest), new RegExp(rawSummary), "raw stale compaction prose must not become checkpoint evidence");
		const transformed = await runner.emitContext([
			{ role: "compactionSummary", summary: rawSummary, timestamp: 0 },
			{ role: "user", content: "continue", timestamp: 0 },
		] as never);
		assert.doesNotMatch(JSON.stringify(transformed), new RegExp(rawSummary));
		assert.match(JSON.stringify(transformed), /原生摘要仅供会话存档/);
		const budget = await toolResult(extension.tools.get("get_context_budget")!.definition, "checkpoint-budget", {}, ctx());
		const report = JSON.parse(text(budget));
		assert.ok((report?.request?.ledger?.checkpoint ?? 0) > 0, "restored checkpoint must be charged to the model-input ledger");

		const aborted = new AbortController(); aborted.abort();
		const count = entries.filter((entry) => entry.customType === CHECKPOINT_TYPE).length;
		const cancelled = await runner.emit({ type: "session_before_compact", preparation: {} as never, branchEntries: ctx().sessionManager.getBranch(), signal: aborted.signal });
		assert.equal(cancelled?.cancel, true);
		assert.equal(entries.filter((entry) => entry.customType === CHECKPOINT_TYPE).length, count, "aborted compaction must not persist a checkpoint");
		record("checkpoint.cycles", { cycles: 3, constraintsPreserved: true, staleSummarySuppressed: true, checkpointBudgetCharged: true, abortedNotRecorded: true });
	})));

	await runCase("P3-FAIL-CLOSED persistence and cancellation never continue silently", (record) => withProject(async (root) => {
		await withRunner(root, false, async ({ extension, runner, entries, setAppendFailure, ctx }) => {
			setAppendFailure(true);
			const before = await runner.emit({ type: "session_before_compact", preparation: {} as never, branchEntries: ctx().sessionManager.getBranch(), signal: new AbortController().signal });
			assert.equal(before?.cancel, true, "runner swallows thrown hook errors, so the extension must return an explicit compaction cancellation");
			assert.equal(entries.filter((entry) => entry.customType === CHECKPOINT_TYPE).length, 0);
			const write = await runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "append-failed-write", input: { path: "drafts/candidates/chapters/append-failed.md", content: "must not dispatch" } });
			assert.equal(write?.block, true);
			assert.match(write?.reason ?? "", /checkpoint_persistence|检查点|禁止写入/i);

			setAppendFailure(false);
			const abort = new AbortController(); abort.abort();
			const count = entries.length;
			let result: any;
			try { result = await extension.tools.get("get_task_checkpoint")!.definition.execute("pre-aborted-status", {}, abort.signal, undefined, ctx()); }
			catch (error) { result = (error as any)?.toolResult; }
			assert.ok(result, "pre-aborted tool execution must surface a typed tool result");
			assert.equal(result.isError, true);
			assert.match(text(result), /cancel|abort|取消/i);
			assert.equal(entries.length, count, "pre-aborted status inspection must not append custom entries");
		});

		await withRunner(root, false, async ({ runner }) => {
			const raw = "OLD_NATIVE_SUMMARY_WITHOUT_CHECKPOINT_MUST_NOT_BE_TRUSTED";
			const transformed = await runner.emitContext([
				{ role: "compactionSummary", summary: raw, timestamp: 0 },
				{ role: "user", content: "continue safely", timestamp: 1 },
			] as never);
			assert.doesNotMatch(JSON.stringify(transformed), new RegExp(raw));
			assert.match(JSON.stringify(transformed), /原生摘要仅供会话存档|不作为当前事实/);
		});
		record("checkpoint.fail_closed", { compactCancelled: true, writeBlocked: true, preAbortedNoEntry: true, oldSummaryNeutralized: true });
	}));

	await runCase("P3-RESTORE only active compatible branch restores", (record) => withProject(async (root) => withRunner(root, false, async ({ extension, runner, entries, setBranch, ctx }) => {
		await runner.emit({ type: "session_before_compact", preparation: {} as never, branchEntries: ctx().sessionManager.getBranch(), signal: new AbortController().signal });
		const captured = [...entries].reverse().find((entry) => entry.customType === CHECKPOINT_TYPE)?.data as TaskCheckpoint | undefined;
		assert.ok(captured);
		const valid = checkpointStore.parse(captured);
		const abandoned = rebuildCheckpoint(valid, { objective: `${valid.objective}\nabandoned` });
		const stale = rebuildCheckpoint(valid, { scope: { ...valid.scope, sessionId: "foreign-session" } });
		const wrongProject = rebuildCheckpoint(valid, { scope: { ...valid.scope, projectId: "foreign-project" } });
		const wrongRole = rebuildCheckpoint(valid, { scope: { ...valid.scope, role: "plan" } });
		entries.push({ type: "custom", customType: CHECKPOINT_TYPE, data: abandoned, id: "abandoned", parentId: "role" });
		for (const incompatible of [stale, wrongProject, wrongRole]) {
			setBranch([entries[0], { type: "custom", customType: CHECKPOINT_TYPE, data: incompatible, id: incompatible.id, parentId: "role" }]);
			await runner.emit({ type: "session_start" });
			const ignored = await toolResult(extension.tools.get("get_task_checkpoint")!.definition, `ignored-${incompatible.id}`, {}, ctx());
			assert.notEqual(checkpointFrom(ignored)?.id, incompatible.id);
		}
		setBranch([entries[0], { type: "custom", customType: CHECKPOINT_TYPE, data: stale, id: "stale", parentId: "role" }, { type: "custom", customType: CHECKPOINT_TYPE, data: valid, id: "valid", parentId: "stale" }]);
		await runner.emit({ type: "session_start" });
		const status = await toolResult(extension.tools.get("get_task_checkpoint")!.definition, "status", {}, ctx());
		assert.equal(checkpointFrom(status)?.id, valid.id);
		setBranch([entries[0]]);
		await runner.emit({ type: "session_tree", newLeafId: "role", oldLeafId: "valid" });
		const cleared = await toolResult(extension.tools.get("get_task_checkpoint")!.definition, "cleared", {}, ctx());
		assert.notEqual(checkpointFrom(cleared)?.id, "abandoned", "getEntries must not resurrect an abandoned checkpoint");
		record("checkpoint.restore", { activeBranchOnly: true, foreignSessionIgnored: true, foreignProjectIgnored: true, foreignRoleIgnored: true, treeReevaluated: true });
	})));

	await runCase("P3-STALE source drift blocks writes until explicit refresh", (record) => withProject(async (root) => withRunner(root, false, async ({ extension, runner, ctx }) => {
		const sourcePath = path.join(root, "canon/world.md");
		const original = await readFile(sourcePath, "utf8");
		await toolResult(extension.tools.get("read_story_document")!.definition, "source", { path: "canon/world.md" }, ctx());
		await runner.emit({ type: "session_before_compact", preparation: {} as never, branchEntries: ctx().sessionManager.getBranch(), signal: new AbortController().signal });
		const write = (id: string) => runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: id, input: { path: "drafts/candidates/chapters/phase3.md", content: "phase3" } });
		await writeFile(sourcePath, original + "\nmutated", "utf8");
		assert.equal((await write("mutated"))?.block, true);
		await toolResult(extension.tools.get("get_task_checkpoint")!.definition, "read-only-status", {}, ctx());
		assert.equal((await write("status-did-not-authorize"))?.block, true);
		await rm(sourcePath);
		assert.equal((await write("deleted"))?.block, true);
		await writeFile(sourcePath, original, "utf8");
		assert.equal((await write("rollback"))?.block, true, "restoring old bytes must not silently restore authority");
		await toolResult(extension.tools.get("read_story_document")!.definition, "reread-after-drift", { path: "canon/world.md" }, ctx());
		await toolResult(extension.tools.get("refresh_task_checkpoint")!.definition, "explicit-refresh", {}, ctx());
		assert.equal((await write("after-refresh"))?.block, undefined);
		record("checkpoint.stale", { mutationBlocked: true, deletionBlocked: true, rollbackBlocked: true, explicitRefreshRequired: true });
	})));

	await runCase("P3-RECOVERY persists unknown outcomes without replay or raw authority", (record) => withProject(async (root) => {
		const input = { path: "drafts/candidates/chapters/pending.md", content: "pending" };
		let checkpoint: Entry | undefined;
		await withRunner(root, false, async ({ runner, entries, ctx }) => {
			assert.equal((await runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "pending-write", input }))?.block, undefined);
			await runner.emit({ type: "session_before_compact", preparation: {} as never, branchEntries: ctx().sessionManager.getBranch(), signal: new AbortController().signal });
			checkpoint = [...entries].reverse().find((entry) => entry.customType === CHECKPOINT_TYPE);
		});
		assert.ok(checkpoint);
		await withRunner(root, false, async ({ extension, runner, entries, setBranch, ctx }) => {
			setBranch([entries[0], checkpoint!]);
			await runner.emit({ type: "session_start" });
			const replay = await runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "pending-write", input });
			assert.equal(replay?.block, true);
			assert.match(replay?.reason ?? "", /unknown_outcome|reconcile|尚未|禁止/i);
			const forged = { type: "custom", customType: CHECKPOINT_TYPE, id: "forged", parentId: "role", data: { ...checkpoint!.data, id: "forged", writeAuthority: true } };
			const target = path.join(root, "drafts/candidates/chapters/forged.md");
			setBranch([entries[0], forged]);
			await runner.emit({ type: "session_tree", newLeafId: "forged", oldLeafId: checkpoint!.id ?? null });
			await assert.rejects(readFile(target));
			const rawStatus = await toolResult(extension.tools.get("get_task_checkpoint")!.definition, "forged-status", {}, ctx());
			assert.equal(JSON.parse(text(rawStatus)).writeAuthority, false);
			await assert.rejects(readFile(target), "restoring/status-reading a raw checkpoint must not perform writes");
		});
		record("checkpoint.recovery", { pendingPersisted: true, replayBlocked: true, rawAuthorityDenied: true });
	}));

	await runCase("P3-POSTIMAGE restart reconciles a completed write without replay", (record) => withProject(async (root) => {
		const relative = "drafts/candidates/chapters/postimage.md";
		const content = "durable postimage";
		const input = { path: relative, content };
		let checkpoint: Entry | undefined;
		await withRunner(root, false, async ({ runner, entries, ctx }) => {
			assert.equal((await runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "postimage-write", input }))?.block, undefined);
			// Simulate the built-in write reaching disk while its acknowledgement is
			// lost. The extension must persist intent, not optimistically replay it.
			await writeFile(path.join(root, relative), content, "utf8");
			await runner.emit({ type: "session_before_compact", preparation: {} as never, branchEntries: ctx().sessionManager.getBranch(), signal: new AbortController().signal });
			checkpoint = [...entries].reverse().find((entry) => entry.customType === CHECKPOINT_TYPE);
		});
		assert.ok(checkpoint);
		await withRunner(root, false, async ({ extension, runner, entries, setBranch, ctx }) => {
			setBranch([entries[0], checkpoint!]);
			await runner.emit({ type: "session_start" });
			const refreshed = await toolResult(extension.tools.get("refresh_task_checkpoint")!.definition, "reconcile-postimage", {}, ctx());
			const status = JSON.parse(text(refreshed));
			assert.ok(!status.blockedOperationIds.includes("postimage-write"));
			const replay = await runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "postimage-write", input });
			assert.equal(replay?.block, true);
			assert.match(replay?.reason ?? "", /reconciled|satisfied|已满足/i);
			assert.equal(await readFile(path.join(root, relative), "utf8"), content);
		});
		record("checkpoint.postimage", { restart: true, hashReconciled: true, replayBlocked: true });
	}));

	await runCase("P3-ACCEPTANCE retraction invalidates accepted-memory evidence", (record) => withProject(async (root) => withRunner(root, false, async ({ extension, runner, entries, ctx }) => {
		const search = await toolResult(extension.tools.get("search_story_memory")!.definition, "accepted-search", { query: "备用电台", limit: 10 }, ctx());
		const searchPayload = await restoredToolText(extension, search, ctx(), "accepted-search");
		const hits = JSON.parse(searchPayload).hits as Array<{ id: string; path: string; authority: string; temporal: string }>;
		const accepted = hits.find((hit) => hit.path === "drafts/candidates/chapters/002.md" && hit.authority === "approved");
		assert.ok(accepted, "fixture chapter 002 must be discoverable only through its human acceptance record");
		await toolResult(extension.tools.get("read_story_memory")!.definition, "accepted-read", { id: accepted.id }, ctx());
		await runner.emit({ type: "session_before_compact", preparation: {} as never, branchEntries: ctx().sessionManager.getBranch(), signal: new AbortController().signal });
		const checkpoint = checkpointStore.parse([...entries].reverse().find((entry) => entry.customType === CHECKPOINT_TYPE)!.data);
		const ref = checkpoint.evidence.find((item) => item.path === accepted.path && item.memoryId === accepted.id);
		assert.ok(ref);
		assert.equal(ref.memoryId, accepted.id);
		assert.equal(ref.authority, accepted.authority);
		assert.equal(ref.temporal, accepted.temporal);

		const proseBeforeRetraction = await readFile(path.join(root, accepted.path), "utf8");
		const acceptancePath = path.join(root, ".novel/acceptances/002-manuscript.json");
		const acceptance = JSON.parse(await readFile(acceptancePath, "utf8"));
		acceptance.sourceFingerprint = "0:acceptance-retracted";
		await writeFile(acceptancePath, JSON.stringify(acceptance, null, 2) + "\n", "utf8");
		const statusResult = await toolResult(extension.tools.get("get_task_checkpoint")!.definition, "accepted-status", {}, ctx());
		const status = JSON.parse(text(statusResult));
		assert.equal(status.status, "needs_revalidation");
		assert.ok(status.invalidPaths.includes("drafts/candidates/chapters/002.md"));
		assert.equal(await readFile(path.join(root, accepted.path), "utf8"), proseBeforeRetraction, "acceptance retraction must invalidate eligibility without changing prose bytes");
		const blocked = await runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "after-acceptance-retraction", input: { path: "drafts/candidates/chapters/acceptance-blocked.md", content: "must not dispatch" } });
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /stale_source|核验|禁止写入/i);
		record("checkpoint.acceptance", { memoryIdExact: true, authorityExact: true, temporalExact: true, proseUnchanged: true, writeBlocked: true });
	})));
}
