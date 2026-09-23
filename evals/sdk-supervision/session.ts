import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, ModelRegistry, createAgentSession, createReadTool, createWriteTool, SessionManager, SettingsManager, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { createRunSupervisor, type RunSupervisorSnapshot } from "../adapters/snapshots/run-supervisor.js";
import { digest, sha256, treeManifest } from "../core/io.js";
import { loadSdkExtension } from "../sdk-ablation/session.js";
import { METRICS_KEY as BASE_METRICS, CONTROL_KEY } from "../sdk-context/policy.js";
import { LIFE_METRICS } from "../sdk-context/lifecycle-policy.js";
import { extensionSource, auditInventory } from "./extension.js";
import { installProvider, type Receipt, type Reply } from "./provider.js";
import { FAULT, KEY, LIMITS, MODEL, PROMPTS, SETTINGS, SOURCE, SYSTEM, TARGET, VALID, INVALID, VERIFY, emptyMetrics, type Profile, type Task, type Scenario } from "./policy.js";

export interface Evidence {
  inventory: boolean; settings: boolean; boundary: boolean; zeroNetwork: boolean; historyIntact: boolean; persisted: boolean;
  metrics: ReturnType<typeof emptyMetrics>; budgetBlocks: number; intents: number; operationResults: number;
  tools: number; writes: number; verifications: number; receipts: Receipt[];
  compactions: number; compactionStarts: number; compactionErrors: number; fromHook: boolean; automaticCompactions: number;
  currentInputCopies: number; restoredInput: boolean; finalReady: boolean; finalFileSha256: string | null;
  supervisor: RunSupervisorSnapshot | null; extensionSha256: string; toolSchemaSha256: string; promptSha256: string; seedSha256: string;
}
const ready = (): ReturnType<Reply> => [{ type: "text", text: "ready" }];
const tool = (name: string, args: Record<string, unknown>, n: number): ReturnType<Reply> => [{ type: "toolCall", id: `s4-call-${n}`, name, arguments: args }];
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: 1,
  stopReason: content.some(p => p.type === "toolCall") ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
/** Seeded public history is data, not historical model output or executed tools. */
export function seedMessages(task: Task): any[] {
  if (task === "trim-fit") return [
    { role: "user", content: "Public old tool history.", timestamp: 1 },
    ...Array.from({ length: 5 }, (_, i) => [assistant([{ type: "toolCall", id: `seed-${i}`, name: "read", arguments: { path: SOURCE } }]),
      { role: "toolResult", toolCallId: `seed-${i}`, toolName: "read", content: [{ type: "text", text: i ? "Short recent public result." : "Large old public result. " + "x".repeat(24000) }], details: {}, isError: false, timestamp: 1 }]).flat(), assistant(ready()),
  ];
  if (task === "compact-fallback") return [
    { role: "user", content: "Public old discussion.", timestamp: 1 }, assistant([{ type: "text", text: "Old synthetic discussion. " + "history ".repeat(3000) }]),
    ...Array.from({ length: 4 }, (_, i) => [{ role: "user", content: `Keep recent public turn ${i}. ` + "tail ".repeat(30), timestamp: 1 }, assistant([{ type: "text", text: "Recent public turn retained." }])]).flat(),
  ];
  return [];
}

export async function runSession(work: string, profile: Profile, task: Task, scenario: Scenario = "normal"): Promise<Evidence> {
  const project = path.join(work, "project"), agentDir = path.join(work, "agent"), shared = globalThis as any;
  assert.equal(process.env.PI_EVAL_WORKER, "1"); assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR!), path.resolve(agentDir));
  const guard = shared[Symbol.for("pi.eval.networkGuard")]; assert.ok(guard?.active);
  const networkBefore = guard.attempts, before = await treeManifest(project);
  shared[Symbol.for(FAULT)] = { persistence: scenario === "supervisor-persistence" };
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let tools = 0, writes = 0, verifications = 0, extensionError = false, restoredInput = "";
  let compactionStarts = 0, compactionErrors = 0, automaticCompactions = 0;
  const provider = installProvider((_context, n) => {
    if (["trim-fit", "compact-fallback"].includes(task)) return ready();
    if (n === 1) return tool("read_story_document", { path: SOURCE }, n);
    if (n === 2) return tool("write", { path: TARGET, content: task === "unchanged-verification" ? INVALID : VALID }, n);
    if (task === "unverified-stop") return ready();
    if (n === 3 || task === "unchanged-verification" && n <= 8) return tool(VERIFY, {}, n);
    return ready();
  }, scenario, () => session!.abortCompaction());
  try {
    await mkdir(agentDir, { recursive: true }); await mkdir(path.join(project, ".pi"), { recursive: true });
    const settingsText = JSON.stringify({ ...SETTINGS, compaction: { ...SETTINGS.compaction, enabled: scenario !== "maintenance-disabled" } }) + "\n";
    for (const filename of [path.join(agentDir, "settings.json"), path.join(project, ".pi/settings.json")]) await writeFile(filename, settingsText, { flag: "wx" });
    const settings = SettingsManager.create(project, agentDir); await settings.flush(); settings.reload();
    // Mirror the real setting through a test-only callback; it is never a tool.
    shared[Symbol.for(FAULT)].maintenanceEnabled = () => settings.getCompactionEnabled();
    const source = extensionSource(profile), extensionPath = path.join(agentDir, "s4-profile.ts");
    await writeFile(extensionPath, source, { flag: "wx" });
    const loaded = await loadSdkExtension(extensionPath, project); auditInventory(profile, loaded);
    const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => SYSTEM, getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
    const manager = SessionManager.create(project, path.join(agentDir, "sessions")), seed = seedMessages(task);
    manager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
    for (const message of seed) manager.appendMessage(message);
    // Freeze before any hook: comparing two references to a mutated entry would
    // not prove that trimming/compaction preserved the saved source history.
    const history = structuredClone(manager.getBranch().filter(e => e.type === "message"));
    const auth = AuthStorage.inMemory({ [MODEL.provider]: { type: "api_key", key: "synthetic-only" } });
    ({ session } = await createAgentSession({ cwd: project, agentDir, authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "disabled-models.json")), model: { ...MODEL, input: ["text"] },
      thinkingLevel: "off", tools: [createReadTool(project), createWriteTool(project)], settingsManager: settings, resourceLoader: resources, sessionManager: manager }));
    await session.bindExtensions({ onError: () => { extensionError = true; }, uiContext: { setEditorText: (value: string) => { restoredInput = value; } } as any });
    const allowed = new Set(["read_story_document", "read", "write", "read_observation", "get_task_checkpoint", "refresh_task_checkpoint", VERIFY]);
    session.setActiveToolsByName([...allowed]);
    const wrapped = session.agent.state.tools.map(t => ({ ...t, execute: async (id: string, args: any, signal?: AbortSignal, update?: any) => {
      assert.ok(allowed.has(t.name)); if (++tools > LIMITS.tools) throw new Error("S4_TOOL_LIMIT");
      if (["read", "read_story_document"].includes(t.name)) assert.equal(args.path, SOURCE);
      if (t.name === "write") { assert.equal(args.path, TARGET); assert.equal(args.content, task === "unchanged-verification" ? INVALID : VALID); writes++; }
      if (t.name === VERIFY) { assert.deepEqual(args, {}); verifications++; }
      return t.execute(id, args, signal, update);
    } }));
    assert.equal(wrapped.length, allowed.size); session.agent.setTools(wrapped);
    session.subscribe(event => {
      if (event.type === "compaction_start") { compactionStarts++; if (event.reason !== "manual") automaticCompactions++; provider.setKind("summary"); }
      if (event.type === "compaction_end") { if (event.errorMessage || event.aborted) compactionErrors++; provider.setKind("agent"); }
    });
    await session.prompt(PROMPTS[task], { source: "interactive" }); await (session as any)._agentEventQueue;
    const branch = manager.getBranch(), compactions = branch.filter(e => e.type === "compaction");
    const disk = (await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const supervisor: RunSupervisorSnapshot | null = shared[Symbol.for(KEY)].runtime?.snapshot() ?? null;
    if (supervisor) createRunSupervisor({ digest: sha256 }).parse(supervisor);
    const persistedStatus = [...disk].reverse().find(e => e.type === "custom" && e.customType === "pi-desktop-run-status/v1")?.data ?? null;
    const after = await treeManifest(project), expectedTarget = task === "unchanged-verification" ? INVALID : VALID;
    const boundary = Object.entries(before).every(([name, hash]) => after[name] === hash) && Object.keys(after).every(name => name in before || name === ".pi/settings.json" && after[name] === sha256(settingsText) || name === TARGET && after[name] === sha256(expectedTarget));
    const last = [...branch].reverse().find((e: any) => e.type === "message" && e.message.role === "assistant") as any;
    return { inventory: !extensionError, settings: !settings.getRetryEnabled() && settings.getCompactionEnabled() === (scenario !== "maintenance-disabled")
      && await readFile(path.join(agentDir, "settings.json"), "utf8") === settingsText && await readFile(path.join(project, ".pi/settings.json"), "utf8") === settingsText,
      boundary, zeroNetwork: networkBefore === guard.attempts, historyIntact: history.every(e => digest(e) === digest(disk.find(d => d.id === e.id))), persisted: digest(supervisor) === digest(persistedStatus),
      metrics: { ...shared[Symbol.for(KEY)].metrics }, budgetBlocks: shared[Symbol.for(BASE_METRICS)].budgetBlocks,
      intents: shared[Symbol.for(LIFE_METRICS)].intents, operationResults: shared[Symbol.for(LIFE_METRICS)].results,
      tools, writes, verifications, receipts: provider.receipts, compactions: compactions.length, compactionStarts, compactionErrors, fromHook: compactions.some((e: any) => e.fromHook === true), automaticCompactions,
      currentInputCopies: disk.filter(e => e.type === "message" && e.message.role === "user" && (typeof e.message.content === "string" ? e.message.content : e.message.content.map((p: any) => p.text ?? "").join("")) === PROMPTS[task]).length,
      restoredInput: restoredInput === PROMPTS[task], finalReady: last?.message.stopReason === "stop" && last.message.content.some((p: any) => p.type === "text" && p.text === "ready"),
      finalFileSha256: after[TARGET] ?? null, supervisor, extensionSha256: sha256(source), toolSchemaSha256: digest(wrapped.map(({ name, description, parameters }) => ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name))),
      promptSha256: digest(PROMPTS[task]), seedSha256: digest(seed) };
  } finally { session?.dispose(); provider.dispose(); for (const name of [KEY, FAULT, CONTROL_KEY, BASE_METRICS, LIFE_METRICS, "pi.sdk-ablation.metrics"]) delete shared[Symbol.for(name)]; }
}
