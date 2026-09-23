import assert from "node:assert/strict";
import { PILOT_MODEL, PILOT_PROBE_CONTENT, PILOT_PROBE_PATH, type PilotTaskId } from "./policy.js";

/** Scripted SSE fixture, not an LLM and never a network implementation. */
export function createRehearsalProvider(taskId: PilotTaskId): { fetch: typeof fetch; calls(): number } {
	let count = 0;
	const fakeFetch: typeof fetch = async (_input, init) => {
		assert.equal(typeof init?.body, "string", "REHEARSAL_BODY_INVALID");
		const request = JSON.parse(init!.body as string);
		assert.equal(request.model, PILOT_MODEL.id, "REHEARSAL_MODEL_INVALID");
		assert.equal(request.stream_options?.include_usage, true, "REHEARSAL_USAGE_NOT_REQUESTED");
		assert.equal(request.stream, true, "REHEARSAL_STREAM_REQUIRED");
		count++;
		assert.ok(count <= 3, "REHEARSAL_EXTRA_REQUEST");
		const previousTools = request.messages.filter((message: { role: string }) => message.role === "tool");
		assert.equal(previousTools.length, count - 1, "REHEARSAL_TOOL_RESULT_MISSING");
		const step = taskId === "P5P-READ-001"
			? [{ name: "read_story_document", arguments: { path: "canon/world.md" } }, { name: "get_context_budget", arguments: {} }]
			: [{ name: "write", arguments: { path: PILOT_PROBE_PATH, content: PILOT_PROBE_CONTENT } }, { name: "read", arguments: { path: PILOT_PROBE_PATH } }];
		const call = step[count - 1];
		const delta = call
			? { role: "assistant", tool_calls: [{ index: 0, id: `call_${count}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }
			: { role: "assistant", content: taskId === "P5P-READ-001" ? '{"canPredictStorm":false,"signers":["记录员","设备技师"]}' : "ready" };
		const chunk = (choices: unknown[], usage?: unknown) => ({ id: `synthetic-${count}`, object: "chat.completion.chunk", created: 0, model: PILOT_MODEL.id, choices, ...(usage ? { usage } : {}) });
		const text = [chunk([{ index: 0, delta, finish_reason: null }]), chunk([{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }]),
			chunk([], { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } })]
			.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
		return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return { fetch: fakeFetch, calls: () => count };
}
