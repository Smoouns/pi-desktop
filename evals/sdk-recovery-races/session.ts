import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, SettingsManager, createAgentSession, createReadTool, createWriteTool, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import { assertInside, digest, readBounded, sha256, treeManifest, writeOnce } from "../core/io.js";
import { loadSdkExtension } from "../sdk-ablation/session.js";
import { lifecycleExtensionSource, auditLifecycleInventory } from "../sdk-context/lifecycle-extension.js";
import { installLifecycleProvider, type LifeReply } from "../sdk-context/lifecycle-provider.js";
import { CONTROL_KEY, METRICS_KEY, MODEL, SOURCE, SYSTEM } from "../sdk-context/policy.js";
import { LIFE_METRICS } from "../sdk-context/lifecycle-policy.js";
import { CONTENT, PARTIAL, PROFILE, PROMPTS, SETTINGS, TARGET, type RaceCase, type Resume, type Seed, type State } from "./policy.js";

const latest = (manager: SessionManager): any => [...manager.getBranch()].reverse().find((e: any) => e.type === "custom" && e.customType === "pi-desktop-task-checkpoint");
const state = (manager: SessionManager): State => latest(manager)?.data.pendingOperations.at(-1)?.state ?? "none";
const send = (message: unknown) => new Promise<void>((resolve, reject) => process.send!(message, error => error ? reject(error) : resolve()));
export const settingsText = () => JSON.stringify(SETTINGS) + "\n";
export function projectBoundary(before: Record<string, string>, after: Record<string, string>) {
  return Object.entries(before).every(([name, hash]) => name === TARGET || after[name] === hash)
    && Object.entries(after).every(([name, hash]) => name === TARGET ? [sha256(CONTENT), sha256(PARTIAL)].includes(hash)
      : name in before || name === ".pi/settings.json" && hash === sha256(settingsText()));
}
export async function readSessionPath(work: string) {
  const state = JSON.parse(await readBounded(path.join(work, "resume.json")));
  assert.deepEqual(Object.keys(state), ["sessionFile"]);
  assert.equal(typeof state.sessionFile, "string");
  const file = path.resolve(work, "agent", state.sessionFile);
  await assertInside(path.join(work, "agent"), file);
  return file;
}

/** Seed is killed by the parent at an explicit barrier inside the actual SDK write. */
export async function sessionWorker(work: string, scenario: RaceCase, stage: "seed" | "resume") {
  const project = path.join(work, "project"), agentDir = path.join(work, "agent");
  assert.equal(process.env.PI_EVAL_WORKER, "1");
  assert.equal(path.resolve(process.env.PI_CODING_AGENT_DIR!), agentDir);
  const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")]; assert.ok(guard?.active);
  const attempts = guard.attempts, before = await treeManifest(project), provider = installLifecycleProvider();
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let inventory = true, tools = 0, writes = 0;
  const replayResults: string[] = [];
  try {
    await mkdir(agentDir, { recursive: true }); await mkdir(path.join(project, ".pi"), { recursive: true });
    if (stage === "seed") for (const file of [path.join(agentDir, "settings.json"), path.join(project, ".pi/settings.json")]) await writeFile(file, settingsText(), { flag: "wx" });
    const settings = SettingsManager.create(project, agentDir); await settings.flush(); settings.reload();
    const settingsOk = async () => !settings.getRetryEnabled() && !settings.getCompactionEnabled()
      && await readFile(path.join(agentDir, "settings.json"), "utf8") === settingsText()
      && await readFile(path.join(project, ".pi/settings.json"), "utf8") === settingsText();
    const source = lifecycleExtensionSource(PROFILE), extensionFile = path.join(agentDir, "race-profile.ts");
    if (stage === "seed") await writeFile(extensionFile, source, { flag: "wx" }); else assert.equal(await readFile(extensionFile, "utf8"), source);
    const loaded = await loadSdkExtension(extensionFile, project); auditLifecycleInventory(PROFILE, loaded, source);
    const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => SYSTEM, getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
    const manager = stage === "seed" ? SessionManager.create(project, path.join(agentDir, "sessions")) : SessionManager.open(await readSessionPath(work));
    const pendingBefore = state(manager);
    const auth = AuthStorage.inMemory({ [MODEL.provider]: { type: "api_key", key: "synthetic-only" } });
    ({ session } = await createAgentSession({ cwd: project, agentDir, authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "disabled-models.json")),
      model: { ...MODEL, input: ["text"] }, thinkingLevel: "off", tools: [createReadTool(project), createWriteTool(project)], settingsManager: settings, resourceLoader: resources, sessionManager: manager }));
    await session.bindExtensions({ onError: () => { inventory = false; } });
    if (stage === "seed") manager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
    session.subscribe(event => {
      provider.event(event);
      if (event.type === "tool_execution_end" && event.toolName === "write") {
        const text = event.result.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";
        replayResults.push(!event.isError ? "success" : text.includes("[reconciled]") ? "reconciled" : text.includes("[unknown_outcome]") ? "unknown" : "other-error");
      }
    });
    const allowed = new Set(["read_story_document", "read", "write", "read_observation", "get_task_checkpoint", "refresh_task_checkpoint"]);
    const wrapped = session.agent.state.tools.filter(t => allowed.has(t.name)).map(t => ({ ...t, execute: async (id: string, args: any, signal?: AbortSignal, update?: any) => {
      assert.ok(++tools <= 12, "RACE_TOOL_LIMIT");
      if (["read", "read_story_document"].includes(t.name)) assert.equal(args.path, SOURCE);
      if (t.name !== "write") return t.execute(id, args, signal, update);
      assert.equal(args.path, TARGET); assert.equal(args.content, CONTENT); writes++;
      if (stage !== "seed") return t.execute(id, args, signal, update);
      const cp = latest(manager), op = cp?.data.pendingOperations.at(-1);
      const sessionBytes = await readFile(manager.getSessionFile()!);
      const disk = sessionBytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
      const diskCheckpoint = [...disk].reverse().find(e => e.type === "custom" && e.customType === "pi-desktop-task-checkpoint");
      const durableIntent = digest(cp.data) === digest(diskCheckpoint?.data) && op?.operationId === id && op.expectedPostHash === sha256(CONTENT);
      assert.ok(durableIntent && op.state === "issued" && op.dispatched, "RACE_INTENT_NOT_DURABLE");
      if (scenario === "partial-effect" || scenario === "after-effect") await t.execute(id, { ...args, content: scenario === "partial-effect" ? PARTIAL : CONTENT }, signal, update);
      const result: Seed = { durableIntent, issued: op.state === "issued", dispatched: op.dispatched, inventory, settings: await settingsOk(), zeroNetwork: guard.attempts === attempts,
        targetSha256: (await treeManifest(project))[TARGET] ?? null, sessionSha256: sha256(sessionBytes), checkpointSha256: digest(cp.data), providerCalls: provider.receipts.length, tools, writes };
      await send({ type: "barrier", value: result });
      // No graceful exception or fake loss-of-ack: the parent must kill this process.
      return await new Promise<never>(() => {});
    } }));
    assert.equal(wrapped.length, allowed.size); session.agent.setTools(wrapped);
    const prompt = async (text: string, name: string, args: object, id: string) => {
      provider.agent((_ctx, n): LifeReply => n === 1 ? { content: [{ type: "toolCall", name, arguments: args as any, id }] } : {});
      await session!.prompt(text); await (session as any)._agentEventQueue;
    };
    if (stage === "seed") {
      await prompt(PROMPTS.seed, "read_story_document", { path: SOURCE }, "seed-read");
      await writeOnce(path.join(work, "resume.json"), { sessionFile: path.relative(agentDir, manager.getSessionFile()!) });
      await prompt(PROMPTS.write, "write", { path: TARGET, content: CONTENT }, "seed-write");
      throw new Error("RACE_SEED_NOT_KILLED");
    }
    await prompt(PROMPTS.write, "write", { path: TARGET, content: CONTENT }, "replay-new-id-a");
    await prompt(PROMPTS.refresh, "refresh_task_checkpoint", {}, "resume-refresh");
    await prompt(PROMPTS.write, "write", { path: TARGET, content: CONTENT }, "replay-new-id-b");
    const after = await treeManifest(project), shared = globalThis as any;
    const result: Resume = { reopened: true, inventory, settings: await settingsOk(), boundary: projectBoundary(before, after), zeroNetwork: guard.attempts === attempts,
      pendingBefore, pendingAfter: state(manager), targetSha256: after[TARGET] ?? null, writeDispatches: writes, replayResults,
      refreshes: shared[Symbol.for(METRICS_KEY)].refreshes, providerCalls: provider.receipts.length, tools, operationMetrics: shared[Symbol.for(LIFE_METRICS)] };
    assert.ok(provider.receipts.every(r => r.kind === "agent" && r.disposition === "dispatched" && r.outcome === "complete"));
    await send({ type: "result", value: result });
  } finally {
    session?.dispose(); provider.dispose();
    if (stage === "seed") await writeOnce(path.join(work, "seed-graceful-cleanup.json"), { graceful: true });
    for (const key of [CONTROL_KEY, METRICS_KEY, LIFE_METRICS]) delete (globalThis as any)[Symbol.for(key)];
  }
}

/** A separately owned test executor can outlive the killed agent. No network. */
export async function executorWorker(work: string) {
  assert.ok((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active);
  await assertInside(process.env.PI_RACE_WORK_ROOT!, work);
  await send({ type: "executor-ready" });
  await new Promise<void>((resolve, reject) => process.once("message", message => {
    void (async () => {
      assert.deepEqual(message, { type: "commit" });
      const dir = path.join(work, "project", path.dirname(TARGET)); await assertInside(work, dir);
      await writeFile(path.join(work, "project", TARGET), CONTENT, { flag: "wx" });
      await send({ type: "executor-done", effects: 1, sha256: sha256(CONTENT) }); resolve();
    })().catch(reject);
  }));
}
