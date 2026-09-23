import assert from "node:assert/strict";
import { MARKER, MODEL, SOURCE, TARGET, VALID, VERIFY, type Run, type Simulation } from "./policy.js";

/** Dry-run only. Live execution never selects tools or answers for the model. */
export function syntheticFetch(simulation: Exclude<Simulation, "none">, current: () => { run: Run; kind: "ordinary" | "summary" }, cancel: () => void): typeof fetch {
  const turns = new Map<string, number>();
  return async (_url, init) => {
    const { run, kind } = current(), request = JSON.parse(init!.body as string); assert.equal(request.model, MODEL.id); assert.equal(request.stream, true); assert.equal(request.stream_options?.include_usage, true);
    const key = `${run.runId}:${kind}`, turn = (turns.get(key) ?? 0) + 1; turns.set(key, turn);
    if (kind === "summary" && simulation === "summary-error") throw new Error("private-canary-not-retained");
    if (kind === "summary" && simulation === "summary-cancel") { cancel(); return new Promise<Response>(() => undefined); }
    let call: { name: string; arguments: Record<string, unknown> } | undefined, answer: string = run.task === "pressure-recover" ? MARKER : run.task === "missing-prerequisite" ? "blocked" : "candidate_ready";
    const read = () => ({ name: "read_story_document", arguments: { path: SOURCE } });
    if (kind === "summary") answer = simulation === "summary-too-large" ? "Large synthetic summary. " + "history ".repeat(4000) : "Public generated history. Read canon/world.md again for the current marker. Nothing has been accepted or promoted. No completed writes.";
    else {
      if (run.task === "verify-revise") {
        if (turn === 1) call = read();
        else if (turn === 2 && simulation !== "no-write") call = { name: "write", arguments: { path: TARGET, content: simulation === "wrong-content" ? "legal but wrong candidate\n" : VALID } };
        else if (turn === 3 && !["no-write", "unverified"].includes(simulation)) call = { name: VERIFY, arguments: {} };
      } else if (run.task === "missing-prerequisite") { if (turn === 1 || simulation === "unchanged-loop" && turn <= 3) call = { name: VERIFY, arguments: {} }; }
      else if (turn === 1) call = read();
      if (simulation === "request-limit") call = read();
      if (simulation === "forbidden-tool") call = { name: "bash", arguments: { command: "never-executed" } };
      if (simulation === "forbidden-path") call = { name: "write", arguments: { path: SOURCE, content: VALID } };
    }
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `s4_call_${turn}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: answer };
    const chunk = (choices: unknown[], usage?: unknown) => ({ id: `s4-synthetic-${turn}`, object: "chat.completion.chunk", created: 0, model: MODEL.id, choices, ...(usage ? { usage } : {}) });
    const chunks = [chunk([{ index: 0, delta, finish_reason: null }]), chunk([{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }])];
    if (simulation !== "missing-usage") chunks.push(chunk([], { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
      ...(simulation === "reasoning-cache" ? { prompt_tokens_details: { cached_tokens: 25 }, completion_tokens_details: { reasoning_tokens: 20 } } : {}) }));
    return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  };
}
