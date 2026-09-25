import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry, createAgentSession, createReadTool, createWriteTool, convertToLlm, SessionManager, SettingsManager, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import { createRunSupervisor } from "../adapters/snapshots/run-supervisor.js";
import { createContextMaintenance } from "../adapters/snapshots/context-maintenance.js";
import { digest, sha256, treeManifest } from "../core/io.js";
import { loadSdkExtension, type SdkPrepared } from "../sdk-ablation/session.js";
import { CONTROL_KEY, METRICS_KEY, emptyMetrics as baseMetrics } from "../sdk-context/policy.js";
import { LIFE_METRICS } from "../sdk-context/lifecycle-policy.js";
import { FEATURES, KEY, LIMITS, MARKER, PREREQUISITE, PRODUCT_LIMITS, PROMPTS, SETTINGS, SOURCE, SYSTEM, TARGET, VALID, VERIFY, emptyMetrics, type Run, type Simulation } from "./policy.js";
import { seedMessages, seedHash } from "./fixture.js";
import { auditProfile, profileSource, schemaDigest } from "./profile.js";
import { createWireProbe, installBridge, send } from "./bridge.js";

export interface Prepared extends SdkPrepared { seedSha256: string; wire: { beforeBytes: number; afterTrimBytes: number; beforeSha256: string; afterTrimSha256: string; trimmed: number }; }
export interface Calibration { summaryBytes: number[]; ordinaryBytes: number[]; compactions: number; historyIntact: boolean; }
export interface Evidence {
  settings: boolean; inventory: boolean; boundary: boolean; zeroNetwork: boolean; safe: boolean; normalStop: boolean;
  answer: "candidate_ready" | "blocked" | "marker" | "other" | "none"; reads: number; markerObserved: boolean;
  proposals: number; tools: number; writes: number; verifications: number; durableIntents: number; finalFileSha256: string;
  receipt: { artifactSha256: string; passed: boolean; full: boolean; reason: "PASS" | "CONTENT_MISMATCH" | "PREREQUISITE_MISSING" } | null;
  verificationCurrent: boolean; compactions: number; automaticCompactions: number; fromHook: boolean; historyIntact: boolean;
  currentInputCopies: number; restoredInput: boolean; persisted: boolean;
  supervisor: { state: string; reasonCode: string | null; userAccepted: false } | null;
  metrics: ReturnType<typeof emptyMetrics>; base: ReturnType<typeof baseMetrics>;
  operations: { intents: number; results: number; replayBlocks: number; persistenceBlocks: number; staleResults: number };
  bridge: ReturnType<ReturnType<typeof installBridge>["snapshot"]>;
}
export interface Start { type: "start"; run: Run; work: string; model: Model<"openai-completions">; prepareOnly: boolean; expected: Prepared | null; simulation: Simulation; }
export interface WorkerResult { prepared: Prepared; calibration: Calibration | null; result: Evidence | null; before: Record<string, string>; after: Record<string, string>; }
const normalize = (s: string, root: string) => s.replaceAll(root.replaceAll("\\", "\\\\"), "<PROJECT_ROOT>").replaceAll(root, "<PROJECT_ROOT>")
  .replaceAll(root.replaceAll("\\", "/"), "<PROJECT_ROOT>").replace(/Current date: \d{4}-\d{2}-\d{2}/g, "Current date: <CURRENT_DATE>");

export async function supervisionLiveWorker() {
  assert.equal(process.env.PI_EVAL_WORKER, "1"); assert.ok(process.send);
  const shared = globalThis as any, guard = shared[Symbol.for("pi.eval.networkGuard")]; assert.ok(guard?.active);
  const start = await new Promise<Start>(resolve => process.once("message", value => resolve(value as Start)));
  assert.equal(start.type, "start"); const { run, work, model, prepareOnly } = start;
  const project = path.join(work, "project"), agentDir = path.join(work, "agent"), features = FEATURES(run.profile), attempts = guard.attempts;
  assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR!), path.resolve(agentDir));
  const initial = await treeManifest(project), probe = createWireProbe(model);
  shared[Symbol.for(KEY + ".options")] = { readOnly: run.task === "pressure-recover", persistenceFailure: !prepareOnly && start.simulation === "supervisor-persistence",
    maintenanceDisabled: !prepareOnly && start.simulation === "maintenance-disabled" };
  let safe = true, reads = 0, markerObserved = false, proposals = 0, tools = 0, writes = 0, verifications = 0, durableIntents = 0, extensionError = false;
  let restoredInput = "", automaticCompactions = 0;
  const allowed = new Set(["read", "write", "read_story_document", "read_observation", "get_task_checkpoint", "refresh_task_checkpoint", VERIFY]);
  const reject = (): never => { safe = false; throw new Error("S4L_SAFETY_STOP"); };
  const validateCall = (name: string, args: any) => {
    if (!allowed.has(name) || !args || typeof args !== "object" || Array.isArray(args)) reject();
    const keys: Record<string, string[]> = { read: ["path", "offset", "limit"], read_story_document: ["path"], write: ["path", "content"],
      read_observation: ["id", "start", "limit"], get_task_checkpoint: [], refresh_task_checkpoint: [], [VERIFY]: [] };
    if (Object.keys(args).some(k => !keys[name].includes(k))) reject();
    if (["read", "read_story_document"].includes(name) && ![SOURCE, PREREQUISITE, TARGET].includes(args.path)) reject();
    // Restrict write authority, never correctness: wrong legal bytes are task failure.
    if (name === "write" && (run.task === "pressure-recover" || args.path !== TARGET || typeof args.content !== "string" || Buffer.byteLength(args.content) > 4096)) reject();
    if (name === "read_observation" && (typeof args.id !== "string" || args.id.length > 128)) reject();
    for (const k of ["offset", "start", "limit"]) if (args[k] !== undefined && (!Number.isSafeInteger(args[k]) || args[k] < (k === "start" ? 0 : 1) || args[k] > 4000)) reject();
  };
  const bridge = installBridge(model, { allowSummary: features.maintenance && run.task === "pressure-recover", prepareOnly,
    terminal: () => { const s = shared[Symbol.for(KEY)]?.runtime?.snapshot(); return !!s && s.state !== "RUNNING"; },
    onReply: (message, kind) => { if (kind === "ordinary") for (const call of message.content) if (call.type === "toolCall") {
      if (++proposals > LIMITS.maxTaskTools) reject(); validateCall(call.name, call.arguments);
    } } });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const cancel = (value: any) => { if (value?.type === "cancel-fixture") session?.abortCompaction(); };
  process.on("message", cancel); process.once("disconnect", () => { bridge.stop(); process.exit(0); });
  try {
    await mkdir(agentDir, { recursive: true }); await mkdir(path.join(project, ".pi"), { recursive: true });
    const settingsText = JSON.stringify(SETTINGS) + "\n", source = profileSource(run.profile), extension = path.join(agentDir, "s4-live-profile.ts");
    for (const file of [path.join(agentDir, "settings.json"), path.join(project, ".pi/settings.json")]) await writeFile(file, settingsText, { flag: "wx" });
    await writeFile(extension, source, { flag: "wx" });
    const settings = SettingsManager.create(project, agentDir); await settings.flush(); settings.reload();
    const loaded = await loadSdkExtension(extension, project); auditProfile(run.profile, loaded);
    const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => SYSTEM, getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
    const manager = SessionManager.create(project, path.join(agentDir, "sessions")), seed = seedMessages(run.task);
    manager.appendCustomEntry("pi-desktop-novel-role", { role: "write" }); for (const message of seed) manager.appendMessage(message);
    const history = structuredClone(manager.getBranch().filter(e => e.type === "message"));
    const auth = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "broker-placeholder-not-a-key" } });
    ({ session } = await createAgentSession({ cwd: project, agentDir, authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "disabled-models.json")), model,
      thinkingLevel: "off", tools: [createReadTool(project), createWriteTool(project)], settingsManager: settings, resourceLoader: resources, sessionManager: manager }));
    await session.bindExtensions({ onError: () => { extensionError = true; }, uiContext: { setEditorText: (text: string) => { restoredInput = text; } } as any });
    session.setActiveToolsByName([...allowed]);
    const wrapped = session.agent.state.tools.map(tool => ({ ...tool, execute: async (id: string, args: any, signal?: AbortSignal, update?: any) => {
      bridge.active(); if (!safe || ++tools > LIMITS.maxTaskTools) reject(); validateCall(tool.name, args);
      if (tool.name === "write") {
        const disk = (await readFile(manager.getSessionFile()!, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
        const op = [...disk].reverse().find(e => e.type === "custom" && e.customType === "pi-desktop-task-checkpoint")?.data?.pendingOperations?.at(-1);
        if (op?.operationId !== id || op.state !== "issued" || op.dispatched !== true) reject(); durableIntents++; writes++;
      }
      if (tool.name === VERIFY) verifications++;
      let result: any; try { result = await tool.execute(id, args, signal, update); } catch (error) { if (tool.name === "write") safe = false; throw error; }
      const text = result.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";
      if (!result.isError && ["read", "read_story_document"].includes(tool.name) && args.path === SOURCE) { reads++; if (text.includes(MARKER)) markerObserved = true; }
      return result;
    } }));
    assert.equal(wrapped.length, allowed.size); session.agent.setTools(wrapped);
    const prompt = PROMPTS[run.task], augmented = await (session as any)._extensionRunner.emitBeforeAgentStart(prompt, undefined, session.systemPrompt);
    const system = augmented?.systemPrompt ?? session.systemPrompt;
    const measure = (messages: any[]) => probe({ systemPrompt: system, messages: convertToLlm(messages), tools: wrapped }, s => normalize(s, project));
    shared[Symbol.for(KEY + ".measure")] = measure;
    const input = [...seed, { role: "user", content: [{ type: "text", text: prompt }], timestamp: 0 }];
    const trimmed = createContextMaintenance().trimOldToolResults(input, { maxInlineBytes: 1500 });
    const before = await measure(input), afterTrim = await measure(trimmed.messages);
    const prepared: Prepared = { extensionSha256: sha256(source), toolsSha256: schemaDigest(wrapped), systemSha256: sha256(normalize(system, project)), promptSha256: sha256(prompt), seedSha256: seedHash(run.task),
      wire: { beforeBytes: before.bytes, afterTrimBytes: afterTrim.bytes, beforeSha256: before.sha256, afterTrimSha256: afterTrim.sha256, trimmed: trimmed.trimmed.length } };
    if (start.expected) assert.deepEqual(prepared, start.expected, "S4L_PREPARED_DRIFT");
    bridge.attach(session); session.subscribe(e => { if (e.type === "compaction_start" && e.reason !== "manual") automaticCompactions++; });
    if (!prepareOnly || features.maintenance && run.task === "pressure-recover") {
      try { await session.prompt(prompt, { source: "interactive" }); await (session as any)._agentEventQueue; } catch { safe = false; }
    }
    const branch = manager.getBranch(), compactions = branch.filter(e => e.type === "compaction"), all = manager.getEntries();
    const historyIntact = history.every(e => digest(e) === digest(all.find(d => d.id === e.id)));
    const after = await treeManifest(project);
    const boundary = Object.entries(initial).every(([name, hash]) => after[name] === hash || name === TARGET && run.task !== "pressure-recover" && !!after[name])
      && Object.keys(after).every(name => name in initial || name === ".pi/settings.json" && after[name] === sha256(settingsText));
    if (prepareOnly) {
      assert.ok(safe && !extensionError && boundary && historyIntact && attempts === guard.attempts && !bridge.snapshot().stopped);
      const calibration = features.maintenance && run.task === "pressure-recover" ? { summaryBytes: bridge.payloads.filter(p => p.kind === "summary").map(p => p.bytes),
        ordinaryBytes: bridge.payloads.filter(p => p.kind === "ordinary").map(p => p.bytes), compactions: compactions.length, historyIntact } : null;
      await send({ type: "result", value: { prepared, calibration, result: null, before: initial, after } satisfies WorkerResult }); return;
    }
    const layer = shared[Symbol.for(KEY)], snapshot = layer.runtime?.snapshot() ?? null;
    if (snapshot) createRunSupervisor({ digest: sha256 }).parse(snapshot);
    const disk = (await readFile(manager.getSessionFile()!, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    const persisted = [...disk].reverse().find(e => e.type === "custom" && e.customType === "pi-desktop-run-status/v1")?.data ?? null;
    const r = layer.receipt(), receipt = r ? { artifactSha256: r.artifactSha256, passed: r.passed, full: r.full, reason: r.reason } : null;
    const last = [...session.agent.state.messages].reverse().find(m => m.role === "assistant"), normalStop = last?.role === "assistant" && last.stopReason === "stop";
    const text = last?.role === "assistant" ? last.content.filter(p => p.type === "text").map(p => p.text).join("").trim() : "";
    const result: Evidence = { settings: !settings.getRetryEnabled() && settings.getCompactionEnabled() && await readFile(path.join(agentDir, "settings.json"), "utf8") === settingsText,
      inventory: !extensionError, boundary, zeroNetwork: attempts === guard.attempts, safe, normalStop,
      answer: !text ? "none" : text === MARKER ? "marker" : ["candidate_ready", "blocked"].includes(text) ? text as "candidate_ready" | "blocked" : "other",
      reads, markerObserved, proposals, tools, writes, verifications, durableIntents, finalFileSha256: after[TARGET], receipt,
      verificationCurrent: !!r?.passed && r.full && r.artifactSha256 === after[TARGET] && after[TARGET] === sha256(VALID), compactions: compactions.length,
      automaticCompactions, fromHook: compactions.some((e: any) => e.fromHook === true), historyIntact,
      currentInputCopies: disk.filter(e => e.type === "message" && e.message.role === "user" && (typeof e.message.content === "string" ? e.message.content : e.message.content.map((p: any) => p.text ?? "").join("")) === prompt).length,
      restoredInput: restoredInput === prompt, persisted: digest(snapshot) === digest(persisted),
      supervisor: snapshot ? { state: snapshot.state, reasonCode: snapshot.reasonCode, userAccepted: snapshot.userAccepted } : null,
      metrics: { ...layer.metrics }, base: shared[Symbol.for(METRICS_KEY)], operations: shared[Symbol.for(LIFE_METRICS)], bridge: bridge.snapshot() };
    await send({ type: "result", value: { prepared, calibration: null, result, before: initial, after } satisfies WorkerResult });
  } finally {
    session?.dispose(); bridge.dispose(); process.off("message", cancel);
    for (const key of [KEY, KEY + ".options", KEY + ".measure", CONTROL_KEY, METRICS_KEY, LIFE_METRICS, "pi.sdk-ablation.metrics"]) delete shared[Symbol.for(key)];
    process.disconnect?.();
  }
}
