import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRunSupervisor } from "../../src/harness/run-supervisor.js";
import { createSupervisorRuntime } from "../../src/extensions/supervisor-runtime.js";
import { createContextMaintenance } from "../../src/extensions/context-maintenance.js";
import { lifecycleExtensionSource } from "../sdk-context/lifecycle-extension.js";
import { expectedInventory as baseInventory, validateContextProvenance } from "../sdk-context/extension.js";
import { CONTROL_KEY } from "../sdk-context/policy.js";
import { digest, sha256 } from "../core/io.js";
import { FEATURES, FAULT, KEY, LIMITS, MODEL, PROFILES, SUPERVISOR_LIMITS, TARGET, VALID, VERIFY, emptyMetrics, type Profile } from "./policy.js";
import provenance from "./provenance.json";

/** Eval-only wiring. Factories are production code; the small public verifier
 * and lifecycle adapter are NOT the full production novel extension. */
export function installLayer(pi: any, deps: any, features: { supervisor: boolean; maintenance: boolean }, metrics: ReturnType<typeof emptyMetrics>) {
  const { path, readFile, createHash, Type, target, valid, verify, key, controlKey, faultKey, limits, modelId, supervisorLimits } = deps;
  const sha = (text: any) => createHash("sha256").update(text).digest("hex");
  const base = () => (globalThis as any)[Symbol.for(controlKey)];
  const fault = () => (globalThis as any)[Symbol.for(faultKey)];
  const maintenance = features.maintenance ? deps.createContextMaintenance() : null;
  const runtime = features.supervisor ? deps.createSupervisorRuntime({
    createSupervisor: () => deps.createRunSupervisor({ digest: sha, ...supervisorLimits }),
    append: (snapshot: any) => {
      if (fault()?.persistence) throw new Error("S4_PERSISTENCE_PROBE");
      pi.appendEntry("pi-desktop-run-status/v1", snapshot); metrics.snapshots++;
    },
  }) : null;
  let run: any = null, pressure = false, generation = 0;
  const stopIfTerminal = (ctx: any) => {
    if (runtime?.snapshot() && runtime.snapshot().state !== "RUNNING") { metrics.terminalFences++; ctx.abort(); return true; }
    return false;
  };
  const owns = () => !runtime || run && runtime.snapshot()?.scope.runId === run.scope.runId;
  // This tool is common to every profile. It reads exactly one public candidate;
  // it is not the chapter verifier and never writes an approval/Canon artifact.
  pi.registerTool({ name: verify, label: "Verify public probe", description: "Deterministically verify the current bytes of the public probe candidate.", parameters: Type.Object({}),
    async execute(_id: string, _args: any, _signal: any, _update: any, ctx: any) {
      const bytes = await readFile(path.join(ctx.cwd, target));
      const data = { subject: target, artifactSha256: sha(bytes), passed: bytes.toString("utf8") === valid, full: true };
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: { publicVerification: data } };
    } });
  if (runtime) {
    for (const event of ["session_start", "session_switch"]) pi.on(event, (_e: any, ctx: any) => {
      generation++; run = null;
      const s = base().current(ctx).scope;
      runtime.restore(ctx.sessionManager.getBranch(), { projectId: s.projectId, sessionId: s.sessionId, role: s.role }, generation);
    });
    pi.on("input", (event: any) => { runtime.markExplicitInput(event.source); });
    pi.on("agent_start", (_e: any, ctx: any) => {
      run = base().current(ctx);
      try { runtime.start(run.scope); metrics.supervisorStarts++; stopIfTerminal(ctx); }
      catch { metrics.toolBlocks++; ctx.abort(); }
    });
    pi.on("tool_call", (event: any, ctx: any) => {
      try {
        if (!owns() || !runtime.tool(event.toolCallId, event.toolName).allowed) { metrics.toolBlocks++; ctx.abort(); return { block: true, reason: "S4_SUPERVISOR_STOP" }; }
      } catch { metrics.toolBlocks++; ctx.abort(); return { block: true, reason: "S4_SUPERVISOR_PERSISTENCE" }; }
    });
    pi.on("tool_result", async (event: any, ctx: any) => {
      if (!owns() || event.isError) return;
      if (event.toolName === verify && event.details?.publicVerification) {
        const receipt = event.details.publicVerification;
        runtime.artifact(receipt.subject, receipt.artifactSha256);
        runtime.verification({ callId: event.toolCallId, ...receipt, errorDigest: receipt.passed ? null : sha("PUBLIC_MARKER_MISMATCH") });
        metrics.verificationEvents++;
      } else if (event.toolName === "write") {
        runtime.artifact(target, sha(await readFile(path.join(ctx.cwd, target))));
      } else if (event.toolName === "read_story_document" || event.toolName === "read") {
        runtime.evidence(JSON.stringify([event.input.path, sha(await readFile(path.join(ctx.cwd, event.input.path)))]));
      }
    });
    pi.on("turn_end", (_e: any, ctx: any) => {
      if (!owns()) return;
      try { if (runtime.snapshot()?.state === "RUNNING") runtime.turn(); stopIfTerminal(ctx); }
      catch { metrics.toolBlocks++; ctx.abort(); }
    });
    pi.on("agent_end", async (event: any, ctx: any) => {
      if (!owns() || !runtime.snapshot() || runtime.snapshot().state !== "RUNNING") return;
      const checkpoint = await base().runtime.inspect(ctx, run);
      const last = [...event.messages].reverse().find((m: any) => m.role === "assistant");
      const state = runtime.snapshot(), artifacts = Object.entries(state.artifactHashes);
      let verified = true;
      for (const [name, hash] of artifacts) {
        const receipt = state.verificationReceipts[name];
        if (!receipt?.passed || !receipt.full || receipt.artifactSha256 !== hash || sha(await readFile(path.join(ctx.cwd, name))) !== hash) verified = false;
      }
      runtime.finish({ stopReason: last?.stopReason ?? "error", hasText: last?.content?.some((p: any) => p.type === "text" && p.text.trim()) ?? false,
        checkpointReady: !checkpoint.error && ["empty", "ready"].includes(checkpoint.status), pendingOperations: !!checkpoint.blockedOperationIds.length, completionVerified: verified });
    });
  }
  if (maintenance) {
    const pending = (ctx: any) => ([...ctx.sessionManager.getBranch()].reverse().find((e: any) => e.type === "custom" && e.customType === "pi-desktop-task-checkpoint")?.data?.pendingOperations ?? [])
      .filter((op: any) => !["completed", "failed", "cancelled"].includes(op.state)).map((op: any) => op.toolName);
    const project = (ctx: any, text: string) => {
      const messages = maintenance.reconstructActiveMessages(ctx.sessionManager.getBranch());
      messages.push({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
      const active = new Set(pi.getActiveTools());
      const tools = pi.getAllTools().filter((t: any) => active.has(t.name)).map(({ name, description, parameters }: any) => ({ name, description, parameters }));
      const size = (messages: any[]) => Buffer.byteLength(JSON.stringify({ model: modelId, system: ctx.getSystemPrompt(), messages, tools, max_tokens: limits.reserve })) + limits.reserve + limits.safety;
      const before = size(messages);
      const trimmed = before > limits.contextBytes * 0.85 ? maintenance.trimOldToolResults(messages, { maxInlineBytes: 1500, pendingToolNames: pending(ctx) }) : { messages, trimmed: [] };
      return { before, after: size(trimmed.messages), trimmed: trimmed.trimmed.length };
    };
    pi.on("input", async (event: any, ctx: any) => {
      if (!["interactive", "rpc"].includes(event.source) || !ctx.isIdle() || event.images?.length) return;
      metrics.maintenanceInputs++;
      let projected = project(ctx, event.text);
      metrics.projectedBefore = projected.before; metrics.projectedAfter = projected.after; metrics.preflightTrimmed += projected.trimmed;
      pressure = projected.trimmed > 0;
      if (projected.after <= limits.contextBytes * 0.85 || pending(ctx).length || fault()?.maintenanceEnabled?.() === false) return;
      const epoch = generation, sessionId = ctx.sessionManager.getSessionId();
      metrics.compactAttempts++;
      let failed = false;
      try { await new Promise((resolve, reject) => ctx.compact({ onComplete: resolve, onError: reject })); }
      catch { metrics.compactErrors++; failed = true; }
      if (generation !== epoch || ctx.sessionManager.getSessionId() !== sessionId) { metrics.handledInputs++; return { action: "handled" }; }
      projected = project(ctx, event.text); metrics.projectedAfter = projected.after;
      if (failed || projected.after > limits.contextBytes) {
        metrics.handledInputs++; ctx.ui?.setEditorText?.(event.text); return { action: "handled" };
      }
      // Return control to the same SDK input, never send a replacement prompt.
    });
    pi.on("context", (event: any, ctx: any) => {
      if (!pressure) return;
      const before = JSON.stringify(event.messages);
      const result = maintenance.trimOldToolResults(event.messages, { maxInlineBytes: 1500, pendingToolNames: pending(ctx) });
      metrics.contextUnmodified = metrics.contextUnmodified && before === JSON.stringify(event.messages);
      metrics.contextTrimmed += result.trimmed.length; return { messages: result.messages };
    });
  }
  (globalThis as any)[Symbol.for(key)] = { runtime, metrics };
}

export async function validateProvenance() {
  await validateContextProvenance();
  for (const [file, expected] of Object.entries(provenance.files)) {
    assert.equal(sha256(await readFile(file)), expected, "S4_FACTORY_DRIFT");
    const old = spawnSync("git", ["show", provenance.commit + ":" + file], { windowsHide: true, maxBuffer: 2_000_000 });
    assert.equal(old.status, 0); assert.equal(sha256(old.stdout), expected, "S4_GIT_FACTORY_DRIFT");
  }
}
export function extensionSource(profile: Profile) {
  assert.ok(PROFILES.includes(profile));
  const source = lifecycleExtensionSource("sdk-b3-checkpoint-ops-v2");
  // The embedded B1 and B2 functions also have defaults replaced already; only
  // the last (B3 durable operations) export remains at this point.
  assert.equal(source.split("export default function (pi)").length, 2);
  const factories = { ...(FEATURES[profile].supervisor ? { createRunSupervisor, createSupervisorRuntime } : {}),
    ...(FEATURES[profile].maintenance ? { createContextMaintenance } : {}) };
  const deps = { target: TARGET, valid: VALID, verify: VERIFY, key: KEY, controlKey: CONTROL_KEY, faultKey: FAULT,
    limits: LIMITS, modelId: MODEL.id, supervisorLimits: SUPERVISOR_LIMITS };
  return source.replace("export default function (pi)", "function registerS4Base(pi)") +
    "\nexport default function (pi) {\n const ends = [];\n" +
    " registerS4Base({...pi,on(name, handler) { if (name === 'agent_end') ends.push(handler); else pi.on(name, name === 'tool_call' ? (event,ctx) => event.toolName === " + JSON.stringify(VERIFY) + " ? undefined : handler(event,ctx) : handler); }});\n" +
    " const metrics = " + JSON.stringify(emptyMetrics()) + ";\n" +
    " (" + installLayer.toString() + ")(pi,{path,readFile,createHash,Type,..." + JSON.stringify(deps) + "," +
    Object.entries(factories).map(([name, fn]) => name + ":(" + fn.toString() + ")").join(",") + "}," + JSON.stringify(FEATURES[profile]) + ",metrics);\n" +
    " for (const handler of ends) pi.on('agent_end',handler);\n}\n";
}
export function expectedInventory(profile: Profile) {
  const base = baseInventory("sdk-b3-checkpoint");
  const handlers: Record<string, number> = { ...base.handlers, tool_call: base.handlers.tool_call + 2, tool_result: (base.handlers.tool_result ?? 0) + 1 };
  const add = (names: string[]) => names.forEach(n => handlers[n] = (handlers[n] ?? 0) + 1);
  if (FEATURES[profile].supervisor) add(["session_start", "session_switch", "input", "agent_start", "tool_call", "tool_result", "turn_end", "agent_end"]);
  if (FEATURES[profile].maintenance) add(["input", "context"]);
  return { tools: [...base.tools, VERIFY].sort(), commands: base.commands, handlers };
}
export function auditInventory(profile: Profile, loaded: any) {
  assert.equal(loaded.errors.length, 0); assert.equal(loaded.extensions.length, 1);
  const e = loaded.extensions[0];
  assert.equal(digest({ tools: [...e.tools.keys()].sort(), commands: [...e.commands.keys()].sort(),
    handlers: Object.fromEntries([...e.handlers.entries()].map(([name, list]: any) => [name, list.length])) }), digest(expectedInventory(profile)), "S4_CAPABILITY_LEAK");
}
