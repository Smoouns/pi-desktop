import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAgentLoop, type AgentEvent } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import { withLoadedExtension } from "./contracts.js";
import { withProject, type RunCase } from "./testkit.js";

const context = (cwd: string, role = "write", sessionId = "session-a") => ({ cwd, sessionManager: {
	getSessionId: () => sessionId,
	getBranch: () => [{ type: "custom", customType: "pi-desktop-novel-role", data: { role } }],
} });
const harness = (result: unknown): any => (result as any)?.details?.harness;
async function failure(pending: Promise<unknown>): Promise<any> {
	let caught: any;
	try { await pending; } catch (error) { caught = error; }
	assert.ok(caught instanceof Error, "Pi must receive a thrown error, not a success with an ignored isError property");
	assert.match(caught.message, /<tool-error>/);
	return (caught as any).toolResult;
}

export async function runExtensionRuntimeCases(runCase: RunCase): Promise<void> {
	await runCase("P1-PI real core receives tool errors without provider API", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const definition = extension.tools.get("read_story_document")!.definition;
		const model: Model<"openai-completions"> = { id: "synthetic", name: "synthetic", api: "openai-completions", provider: "synthetic", baseUrl: "http://unused.invalid", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		let calls = 0;
		const events: AgentEvent[] = [];
		await runAgentLoop([{ role: "user", content: "synthetic tool check", timestamp: 0 }], { systemPrompt: "", messages: [], tools: [{ ...definition, execute: (id, args, signal, update) => definition.execute(id, args, signal, update, context(root) as never) }] }, { model, convertToLlm: (messages) => messages as never }, (event) => { events.push(event); }, undefined, () => {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = { role: "assistant", content: calls++ === 0 ? [{ type: "toolCall", id: "invalid-read", name: "read_story_document", arguments: { path: "../outside.md" } }] : [{ type: "text", text: "stopped" }], api: model.api, provider: model.provider, model: model.id, stopReason: calls === 1 ? "toolUse" : "stop", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			stream.end(message);
			return stream;
		});
		const result = events.find((event) => event.type === "tool_execution_end");
		assert.ok(result?.type === "tool_execution_end" && result.isError);
		assert.match(JSON.stringify(result.result.content), /permission/);
		assert.equal(calls, 2);
		record("pi_core_error", { toolError: true, scriptedResponses: 2, providerRequests: 0 });
	})));
	await runCase("P1-EXT typed results survive generated/minified Pi loader", (record) => withProject(async (root) => {
		for (const minified of [false, true]) await withLoadedExtension(root, minified, async (extension) => {
			const ctx = context(root);
			const read = extension.tools.get("read_story_document")!.definition;
			for (const [name, args, kind] of [
				["read_story_document", { path: "../outside.md" }, "permission"],
				["read_story_document", { path: "canon/missing.md" }, "precondition"],
				["read_chapter", { identifier: "../x" }, "invalid_input"],
				["read_story_memory", { id: "old-id" }, "stale_source"],
			] as const) {
				const result = await failure(extension.tools.get(name)!.definition.execute(name, args, undefined, undefined, ctx as never));
				assert.equal(harness(result)?.ok, false);
				assert.equal(harness(result).error.kind, kind);
				assert.equal(harness(result).attempts, 1);
			}
			const success = await read.execute("success", { path: "canon/world.md" }, undefined, undefined, ctx as never);
			assert.equal(harness(success).ok, true);
			assert.equal(harness(success).scope.sessionId, "session-a");
			assert.ok(harness(success).scope.projectId && harness(success).scope.runId);
			const abort = new AbortController(); abort.abort();
			const cancelled = await failure(read.execute("cancelled", { path: "canon/world.md" }, abort.signal, undefined, ctx as never));
			assert.equal(harness(cancelled).error.kind, "cancelled");
			assert.equal(harness(cancelled).attempts, 0);
		});
		record("typed_adapter", { minified: true, preCancelledAttempts: 0, kinds: 4 });
	}));
	await runCase("P1-PATH built-in read and exact file allowlist", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const hook = extension.handlers.get("tool_call")![0];
		for (const [toolName, target] of [["read", "../secret.md"], ["write", "planning/progress.md-extra"], ["write", "planning/chapter-architecture.md/extra"]]) {
			const result = await hook({ type: "tool_call", toolName, toolCallId: target, input: { path: target, content: "x" } }, context(root, "plan") as never) as any;
			assert.equal(result?.block, true);
		}
		record("builtin_paths", { denied: 3 });
	})));
	await runCase("P1-OP production hook commit then lost response does not dispatch twice", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const hook = extension.handlers.get("tool_call")![0];
		const ctx = context(root);
		const target = "drafts/candidates/chapters/recovery.md";
		const input = { path: target, content: "原创测试：只写一次。\n" };
		const first = await hook({ type: "tool_call", toolName: "write", toolCallId: "write-1", input }, ctx as never) as any;
		assert.notEqual(first?.block, true);
		await writeFile(path.join(root, target), input.content, "utf8"); // underlying Pi write committed, result event dropped
		const replay = await hook({ type: "tool_call", toolName: "write", toolCallId: "write-2", input }, ctx as never) as any;
		assert.equal(replay?.block, true);
		assert.match(replay.reason, /satisfied|已满足/);
		assert.equal(await readFile(path.join(root, target), "utf8"), input.content);
		record("commit_then_drop", { underlyingWrites: 1, replayBlocked: true, exactlyOnceClaim: false });
	})));
	await runCase("P1-SCOPE late write result cannot abort new session", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const hook = extension.handlers.get("tool_call")![0];
		const results = extension.handlers.get("tool_result")![0];
		const target = "drafts/candidates/chapters/late.md";
		const a = context(root, "write", "session-a"), b = context(root, "write", "session-b");
		await hook({ type: "tool_call", toolName: "write", toolCallId: "late-a", input: { path: target, content: "a" } }, a as never);
		await extension.handlers.get("session_switch")![0]({ type: "session_switch", reason: "resume" }, b as never);
		const read = extension.tools.get("read_story_document")!.definition;
		const first = await read.execute("b-before", { path: "canon/world.md" }, undefined, undefined, b as never);
		await results({ type: "tool_result", toolName: "write", toolCallId: "late-a", input: { path: target, content: "a" }, content: [], isError: false, details: undefined }, a as never);
		const second = await read.execute("b-after", { path: "canon/world.md" }, undefined, undefined, b as never);
		assert.equal(harness(first).scope.runId, harness(second).scope.runId);
		record("late_write", { newerRunUnaffected: true });
	})));
	await runCase("P1-VFY verifier contract failure typed and child cancellation fenced", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const ctx = context(root);
		const directory = path.join(root, ".novel/tools");
		await mkdir(directory, { recursive: true });
		await copyFile("scripts/verify-novel-chapter.ts", path.join(directory, "verify-novel-chapter.ts"));
		const verify = extension.tools.get("verify_chapter")!.definition;
		const missing = await failure(verify.execute("contract", { chapter: "999" }, undefined, undefined, ctx as never));
		assert.equal(harness(missing).error.kind, "precondition");
		for (const action of ["abort", "session_switch"]) {
			const marker = path.join(directory, action + ".pid");
			await writeFile(path.join(directory, "verify-novel-chapter.ts"), 'import {writeFileSync} from "node:fs"; writeFileSync(' + JSON.stringify(marker) + ', String(process.pid)); setInterval(() => {}, 1000);', "utf8");
			const abort = new AbortController();
			const pending = failure(verify.execute("cancel-child-" + action, { chapter: "002" }, abort.signal, undefined, ctx as never));
			try {
				let pid = 0;
				for (let count = 0; count < 500 && !pid; count++) {
					pid = Number(await readFile(marker, "utf8").catch(() => "0"));
					if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.ok(pid, "test verifier must actually start before cancellation");
				if (action === "abort") abort.abort();
				else await extension.handlers.get("session_switch")![0]({ type: "session_switch", reason: "resume" }, context(root, "write", "session-b") as never);
				const stopped = await pending;
				assert.equal(harness(stopped).error.kind, "unknown_outcome"); // verifier can write its report
				assert.notEqual(harness(stopped).ok, true);
				assert.throws(() => process.kill(pid, 0), "cancelled verifier process must be gone, not just fenced");
			} finally { abort.abort(); await pending; }
		}
		record("verifier_abort", { lateSuccess: false, reportMayHaveChanged: true, childrenTerminated: 2 });
	})));
}
