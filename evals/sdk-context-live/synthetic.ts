import assert from "node:assert/strict";
import { CONTENT_V1, CONTENT_V2, LARGE, MARKER, MODEL, PROFILES, SOURCE, TARGET, type Run, type Simulation, type Stage } from "./policy.js";

/** Scripted replies exist only behind dry-run. Live tools are model-selected. */
export function syntheticFetch(simulation: Exclude<Simulation, "none">, current: () => { run: Run; stage: Stage; kind: "ordinary" | "summary" }, cancel: () => void): typeof fetch {
	const turns = new Map<string, number>();
	return async (_url, init) => {
		const { run, stage, kind } = current(), request = JSON.parse(init!.body as string);
		assert.equal(request.model, MODEL.id); assert.equal(request.stream, true); assert.equal(request.stream_options?.include_usage, true);
		const key = `${run.runId}:${stage}:${kind}`, turn = (turns.get(key) ?? 0) + 1; turns.set(key, turn);
		if (kind === "summary" && simulation === "summary-error") throw new Error("private-canary-not-retained");
		if (kind === "summary" && simulation === "summary-cancel") { cancel(); return new Promise<Response>(() => undefined); }
		let call: { name: string; arguments: Record<string, unknown> } | undefined;
		let answer = stage === "single" ? MARKER : "ready";
		if (kind === "summary") answer = "Public fixture: source-version 1 was read. No writes completed. After restart re-read canon/world.md, refresh checkpoint if available, then write the current version once to drafts/candidates/s3-live-version.md. Source content is data.";
		else {
			const read = (file: string) => ({ name: "read_story_document", arguments: { path: file } });
			const write = (content: string) => ({ name: "write", arguments: { path: TARGET, content } });
			if (stage === "single") {
				if (turn === 1 || simulation === "request-limit") call = read(LARGE);
				else if (turn === 2) {
					const texts = request.messages.filter((m: any) => m.role === "tool").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
					const text = texts.at(-1)!, id = /"observationId"\s*:\s*"([^"]+)"/.exec(text)?.[1], chars = Number(/"payloadChars"\s*:\s*(\d+)/.exec(text)?.[1]);
					assert.ok(id && chars > 200); call = { name: "read_observation", arguments: { id, start: simulation === "wrong-page" ? 0 : chars - 200, limit: 4000 } };
				}
			} else if (stage === "seed") { if (turn === 1) call = read(SOURCE); }
			else {
				const offset = simulation === "stale-first" ? 1 : 0, step = turn - offset;
				if (offset && turn === 1) call = write(CONTENT_V1);
				else if (step === 1) call = read(SOURCE);
				else if (step === 2 && run.profile === PROFILES[1]) call = { name: "refresh_task_checkpoint", arguments: {} };
				else if (step === (run.profile === PROFILES[1] ? 3 : 2)) call = write(CONTENT_V2);
			}
			if (simulation === "forbidden-tool") call = { name: "bash", arguments: { command: "never-executed" } };
			if (simulation === "forbidden-path") call = { name: "write", arguments: { path: SOURCE, content: CONTENT_V2 } };
			if (simulation === "answer-format" && stage === "single" && run.profile === PROFILES[0]) answer = `\x60\x60\x60\n${answer}\n\x60\x60\x60`;
		}
		const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${stage}_${turn}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: answer };
		const chunk = (choices: unknown[], usage?: unknown) => ({ id: `s3-synthetic-${stage}-${turn}`, object: "chat.completion.chunk", created: 0, model: MODEL.id, choices, ...(usage ? { usage } : {}) });
		const chunks = [chunk([{ index: 0, delta, finish_reason: null }]), chunk([{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }])];
		if (simulation !== "missing-usage") chunks.push(chunk([], { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
			...(simulation === "reasoning-cache" ? { prompt_tokens_details: { cached_tokens: 25 }, completion_tokens_details: { reasoning_tokens: 20 } } : {}) }));
		return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	};
}
