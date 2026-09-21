import assert from "node:assert/strict";
import { runAgentLoop, type AgentEvent } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import { createSupervisorRuntime } from "../../src/extensions/supervisor-runtime.js";
import { createRunSupervisor } from "../../src/harness/run-supervisor.js";
import { sha256, type RunCase } from "./testkit.js";

const model: Model<"openai-completions"> = {
	id: "supervisor-offline", name: "Supervisor offline", api: "openai-completions", provider: "synthetic", baseUrl: "http://127.0.0.1/unused",
	reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export async function runSupervisorAgentLoopCases(runCase: RunCase): Promise<void> {
	await runCase("P4-LOOP real Pi loop aborts on supervisor no-progress terminal", async (record) => {
		const persisted: unknown[] = [];
		const runtime = createSupervisorRuntime({
			createSupervisor: () => createRunSupervisor({ digest: sha256 }),
			append: (snapshot) => persisted.push(JSON.parse(JSON.stringify(snapshot))),
		});
		const scope = { projectId: "offline-project", sessionId: "offline-session", runId: "offline-run", generation: 1, role: "write" };
		runtime.markExplicitInput("interactive"); runtime.start(scope);
		const controller = new AbortController();
		let providerCalls = 0; let toolCalls = 0;
		const events: AgentEvent[] = [];
		const loop = runAgentLoop(
			[{ role: "user", content: "repeat a repair until supervision stops it", timestamp: 0 }],
			{
				systemPrompt: "", messages: [],
				tools: [{
					name: "synthetic_repair", label: "Synthetic repair", description: "Always returns the same invalid repair.", parameters: {} as never,
					execute: async (callId: string) => {
						const gate = runtime.tool(callId, "synthetic_repair");
						if (!gate.allowed) throw new Error("supervisor denied tool dispatch");
						toolCalls += 1;
						const snapshot = runtime.failure({ kind: "invalid_input", code: "SAME_INVALID_ARGUMENT", signature: "same-repair" });
						if (snapshot?.state !== "RUNNING") controller.abort();
						throw Object.assign(new Error("[invalid_input] same repair failed"), { kind: "invalid_input" });
					},
				}],
			},
			{ model, convertToLlm: (messages) => messages as never },
			(event) => { events.push(event); }, controller.signal,
			(_model, _context, options) => {
				options?.signal?.throwIfAborted();
				providerCalls += 1;
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant", content: [{ type: "toolCall", id: `repair-${providerCalls}`, name: "synthetic_repair", arguments: {} }],
					api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: 0,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				stream.push({ type: "done", reason: "toolUse", message }); stream.end(message); return stream;
			},
		);
		await assert.rejects(loop, /abort|cancel/i);
		assert.equal(providerCalls, 3, "terminal supervision must prevent a fourth provider request");
		assert.equal(toolCalls, 3);
		assert.equal(runtime.snapshot()?.state, "NO_PROGRESS"); assert.equal(runtime.snapshot()?.reasonCode, "REPEATED_REPAIR_FAILURE");
		assert.equal(events.filter((event) => event.type === "tool_execution_start").length, 3);
		const before = runtime.snapshot()?.id;
		runtime.finish({ stopReason: "stop", hasText: true, checkpointReady: true, pendingOperations: false, completionVerified: true });
		assert.equal(runtime.snapshot()?.id, before, "agent-end finalization cannot overwrite the terminal state");
		assert.equal(runtime.snapshot()?.state, "NO_PROGRESS");
		for (const snapshot of persisted) createRunSupervisor({ digest: sha256 }).parse(snapshot);
		record("phase4.native_loop", { providerCalls, toolCalls, fourthRequest: false, terminalStable: true });
	});
}
