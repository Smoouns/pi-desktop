/** Synthetic provider for the separately packaged, offline D-07 Desktop check.
 * Production UI, Rust RPC, SDK CLI and Novel Tools extension are not substituted. */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const work = process.env.PI_DESKTOP_D7_WORK!;
	assert.ok(work && process.env.PI_CODING_AGENT_DIR === path.join(work, "agent"));
	const root = process.cwd();
	const inside = ["project-a", "project-b"].some(name => root === path.join(work, name));
	if (!inside && !process.argv.includes("--mode")) return; // CLI version/resource diagnostics, not an agent session.
	assert.ok(inside);
	const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")];
	assert.ok(guard?.active);
	const log = (data: Record<string, unknown>) => appendFileSync(path.join(work, `rpc-${process.pid}.jsonl`), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, root, ...data }) + "\n");
	log({ event: "boot", modelCalls: 0, networkAttempts: guard.attempts });
	let round = 0;
	let inputText: string | undefined;
	pi.on("input", (event, ctx) => { round = 0; inputText = event.text; log({ event: "input", text: event.text, session: ctx.sessionManager.getSessionId() }); });
	pi.on("tool_result", event => { log({ event: "tool_result", name: event.toolName, isError: event.isError }); });
	pi.on("agent_end", (_event, ctx) => {
		const entries = ctx.sessionManager.getBranch() as any[];
		const latest = (type: string) => [...entries].reverse().find(e => e.customType === type)?.data;
		log({ event: "agent_end", session: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(), task: latest("pi-desktop-task-contract/v1"), status: latest("pi-desktop-run-status/v1"), networkAttempts: guard.attempts });
	});
	pi.on("tool_call", event => {
		if (["read", "write", "edit"].includes(event.toolName)) {
			const relative = path.relative(root, path.resolve(root, String((event.input as Record<string, unknown>).path)));
			assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "D7_FILE_OUTSIDE_PROJECT");
		}
	});
	pi.registerProvider("desktop-offline", {
		baseUrl: "https://invalid.example", apiKey: "synthetic-only", api: "openai-completions",
		models: [{ id: "d7-synthetic", name: "D7 离线验收（不调用模型）", reasoning: false, input: ["text"], contextWindow: 262144, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple(model, context: Context, options = {}) {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const nth = ++round;
				const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
				try {
					assert.equal(model.provider, "desktop-offline"); assert.equal(model.id, "d7-synthetic");
					assert.equal(options.apiKey, "synthetic-only"); assert.ok(nth <= 8);
					// Pi also maps custom checkpoint/progress projections to user messages.
					// Select the synthetic script from the actual input event, never from
					// the final projected user-role message or a historical trigger.
					assert.equal(typeof inputText, "string", "D7_MISSING_EXPLICIT_INPUT");
					const text = inputText!;
					const trigger = text.match(/D7-(READ|CANCEL|VERIFY)/)?.[0];
					assert.ok(trigger, "D7_UNKNOWN_INPUT");
					assert.ok(context.messages.some(m => m.role === "user" &&
						(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes(trigger)), "D7_INPUT_MISSING_FROM_CONTEXT");
					log({ event: "synthetic_request", round: nth, networkAttempts: guard.attempts });
					await options.onPayload?.({ model: model.id, system: context.systemPrompt, messages: context.messages, tools: context.tools, max_tokens: 4096 }, model);
					options.signal?.throwIfAborted();
					if (text.includes("D7-CANCEL")) {
						log({ event: "awaiting_cancel" });
						await new Promise<void>(resolve => {
							const timer = setTimeout(resolve, 45_000);
							options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
						});
						options.signal?.throwIfAborted();
					}
					let content: AssistantMessage["content"];
					const tool = (name: string, args: Record<string, unknown>) => [{ type: "toolCall" as const, id: `d7-${process.pid}-${Date.now()}-${nth}`, name, arguments: args }];
					if (text.includes("D7-VERIFY") && nth === 1) content = tool("read", { path: "planning/chapter-cards/002.md" });
					else if (text.includes("D7-VERIFY") && nth === 2) content = tool("verify_chapter", { chapter: "002" });
					else if (text.includes("D7-READ") && nth === 1) content = tool("read", { path: "canon/world.md", offset: 1, limit: 3 });
					else content = [{ type: "text", text: `D7 离线验收回复：${path.basename(root)}。本轮使用本地合成响应，没有调用真实模型。文件完成状态以生产监督器为准，仍需用户人工验收。` }];
					const value = message(content, content.some(p => p.type === "toolCall") ? "toolUse" : "stop");
					stream.push({ type: "start", partial: value });
					stream.push({ type: "done", reason: value.stopReason as "toolUse" | "stop", message: value });
				} catch (error) {
					const reason = options.signal?.aborted ? "aborted" : "error";
					log({ event: reason, detail: String(error), networkAttempts: guard.attempts });
					stream.push({ type: "error", reason, error: { ...message([], reason), errorMessage: "D7_OFFLINE_STOP" } });
				}
			})();
			return stream;
		},
	});
}
