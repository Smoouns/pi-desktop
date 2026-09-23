import type { AssistantMessage } from "@mariozechner/pi-ai";
import { digest, sha256 } from "../core/io.js";
import { MODEL, SOURCE, SOURCE_TEXT, TARGET, PREREQUISITE, INITIAL, type Task } from "./policy.js";

/** Public generated data, not an extraction from a real novel or real history. */
export const fixture = (task: Task): Record<string, string> => ({ ".novel/project.json": JSON.stringify({ formatVersion: 1, name: "S4 public probe", localFirst: true }) + "\n", [SOURCE]: SOURCE_TEXT,
  [PREREQUISITE]: JSON.stringify({ available: task !== "missing-prerequisite", origin: "public-synthetic-prerequisite-not-human-approval" }) + "\n", [TARGET]: INITIAL });
export const fixtureHashes = (task: Task) => Object.fromEntries(Object.entries(fixture(task)).sort().map(([p, s]) => [p, sha256(s)]));
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content, api: MODEL.api, model: MODEL.id, provider: MODEL.provider,
  stopReason: content.some(p => p.type === "toolCall") ? "toolUse" : "stop", timestamp: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
export function seedMessages(task: Task): any[] {
  if (task !== "pressure-recover") return [];
  return [
    { role: "user", content: "The following is public generated seed history, not actual earlier executions. Reread current sources for new tasks.", timestamp: 1 },
    assistant([{ type: "toolCall", id: "seed-old", name: "read", arguments: { path: SOURCE } }]),
    { role: "toolResult", toolCallId: "seed-old", toolName: "read", content: [{ type: "text", text: "Old synthetic tool context. " + "x".repeat(12000) }], isError: false, timestamp: 1 },
    assistant([{ type: "text", text: "Old synthetic discussion; not a current source. " + "history ".repeat(3100) }]),
    ...Array.from({ length: 4 }, (_, i) => [
      { role: "user", content: `Recent generated turn ${i}. ` + "tail ".repeat(40), timestamp: 1 },
      assistant([{ type: "toolCall", id: `seed-${i}`, name: "read", arguments: { path: SOURCE } }]),
      { role: "toolResult", toolCallId: `seed-${i}`, toolName: "read", content: [{ type: "text", text: "Short recent generated result." }], isError: false, timestamp: 1 },
      assistant([{ type: "text", text: "Recent generated context retained." }]),
    ]).flat(),
  ];
}
export const seedHash = (task: Task) => digest(seedMessages(task));
