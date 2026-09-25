import assert from "node:assert/strict";
import { createRunSupervisor } from "../adapters/snapshots/run-supervisor.js";
import { createSupervisorRuntime } from "../adapters/snapshots/supervisor-runtime.js";
import { createContextMaintenance } from "../adapters/snapshots/context-maintenance.js";
import { lifecycleExtensionSource } from "../sdk-context/lifecycle-extension.js";
import { expectedInventory } from "../sdk-context/extension.js";
import { CONTROL_KEY, LIMITS as OLD_LIMITS } from "../sdk-context/policy.js";
import { SUPERVISOR_LIMITS } from "../sdk-supervision/policy.js";
import { validateProvenance } from "../sdk-supervision/extension.js";
import { digest, sha256 } from "../core/io.js";
import { FEATURES, KEY, PRODUCT_LIMITS, PROFILES, PREREQUISITE, TARGET, VALID, VERIFY, emptyMetrics, type Profile } from "./policy.js";
export { validateProvenance };

/** S4 live-specific adapter, not the old deterministic provider or task oracle. */
export function installLiveLayer(pi: any, d: any, features: { supervisor: boolean; maintenance: boolean }) {
  const { path, readFile, createHash, Type, key, target, valid, prerequisite, verify, controlKey, limits } = d;
  const sha = (text: any) => createHash("sha256").update(text).digest("hex");
  const base = () => (globalThis as any)[Symbol.for(controlKey)];
  const options = () => (globalThis as any)[Symbol.for(key + ".options")];
  const metrics = d.emptyMetrics();
  const maintenance = features.maintenance ? d.createContextMaintenance() : null;
  const runtime = features.supervisor ? d.createSupervisorRuntime({ createSupervisor: () => d.createRunSupervisor({ digest: sha, ...d.supervisorLimits }),
    append: (s: any) => { if (options()?.persistenceFailure) { metrics.persistenceFailed = true; throw new Error("S4L_PERSISTENCE"); } pi.appendEntry("pi-desktop-run-status/v1", s); metrics.snapshots++; } }) : null;
  let run: any = null, generation = 0, pressure = false, receipt: any = null;
  const terminal = (ctx: any) => { if (runtime?.snapshot() && runtime.snapshot().state !== "RUNNING") { metrics.terminalFences++; ctx.abort(); return true; } return false; };
  const owned = () => run && runtime?.snapshot()?.scope.runId === run.scope.runId;
  pi.registerTool({ name: verify, label: "Verify public candidate", description: "Check current public candidate bytes and read-only prerequisites. Never grants human approval.", parameters: Type.Object({}),
    async execute(_id: string, _args: any, _signal: any, _update: any, ctx: any) {
      const bytes = await readFile(path.join(ctx.cwd, target)), pre = JSON.parse(await readFile(path.join(ctx.cwd, prerequisite), "utf8"));
      const reason = pre.available !== true ? "PREREQUISITE_MISSING" : bytes.toString("utf8") !== valid ? "CONTENT_MISMATCH" : "PASS";
      const data = { subject: target, artifactSha256: sha(bytes), passed: reason === "PASS", full: true, reason };
      return { content: [{ type: "text", text: JSON.stringify(data) }], details: { publicVerification: data } };
    } });
  // All profiles observe identical verification evidence, irrespective of SUP.
  pi.on("tool_result", (event: any) => { if (!event.isError && event.toolName === verify) receipt = event.details?.publicVerification ?? null; });
  if (runtime) {
    for (const event of ["session_start", "session_switch"]) pi.on(event, (_e: any, ctx: any) => { generation++; run = null; const s = base().current(ctx).scope;
      runtime.restore(ctx.sessionManager.getBranch(), { projectId: s.projectId, sessionId: s.sessionId, role: s.role }, generation); });
    pi.on("input", (e: any) => runtime.markExplicitInput(e.source));
    pi.on("agent_start", (_e: any, ctx: any) => { run = base().current(ctx); try { runtime.start(run.scope); metrics.starts++; terminal(ctx); } catch { metrics.persistenceFailed = true; ctx.abort(); } });
    pi.on("tool_call", (e: any, ctx: any) => { try { if (!owned() || !runtime.tool(e.toolCallId, e.toolName).allowed) { metrics.toolBlocks++; ctx.abort(); return { block: true, reason: "S4L_SUPERVISOR_STOP" }; } }
      catch { metrics.persistenceFailed = true; ctx.abort(); return { block: true, reason: "S4L_SUPERVISOR_PERSISTENCE" }; } });
    pi.on("tool_result", async (e: any, ctx: any) => {
      if (!owned() || e.isError || runtime.snapshot()?.state !== "RUNNING") return;
      if (e.toolName === verify && receipt) { runtime.artifact(target, receipt.artifactSha256); runtime.verification({ callId: e.toolCallId, ...receipt, errorDigest: receipt.passed ? null : sha(receipt.reason) }); metrics.verificationEvents++; }
      else if (e.toolName === "write") runtime.artifact(target, sha(await readFile(path.join(ctx.cwd, target))));
      else if (["read", "read_story_document"].includes(e.toolName)) runtime.evidence(JSON.stringify([e.input.path, sha(await readFile(path.join(ctx.cwd, e.input.path)))]));
    });
    pi.on("turn_end", (_e: any, ctx: any) => { if (!owned()) return; try { if (runtime.snapshot()?.state === "RUNNING") runtime.turn(); terminal(ctx); } catch { metrics.persistenceFailed = true; ctx.abort(); } });
    pi.on("agent_end", async (event: any, ctx: any) => {
      if (!owned() || runtime.snapshot()?.state !== "RUNNING") return;
      const checkpoint = await base().runtime.inspect(ctx, run), last = [...event.messages].reverse().find((m: any) => m.role === "assistant");
      // Required artifact comes from the task, NOT the set of observed writes.
      const verified = options().readOnly || !!receipt?.passed && receipt.full && receipt.artifactSha256 === sha(await readFile(path.join(ctx.cwd, target)));
      runtime.finish({ stopReason: last?.stopReason ?? "error", hasText: last?.content?.some((p: any) => p.type === "text" && p.text.trim()) ?? false,
        checkpointReady: !checkpoint.error && ["empty", "ready"].includes(checkpoint.status), pendingOperations: !!checkpoint.blockedOperationIds.length, completionVerified: verified });
    });
  }
  const pending = (ctx: any) => ([...ctx.sessionManager.getBranch()].reverse().find((e: any) => e.type === "custom" && e.customType === "pi-desktop-task-checkpoint")?.data?.pendingOperations ?? [])
    .filter((op: any) => !["completed", "failed", "cancelled"].includes(op.state)).map((op: any) => op.toolName);
  if (maintenance) {
    const project = async (ctx: any, text: string) => {
      const messages = maintenance.reconstructActiveMessages(ctx.sessionManager.getBranch()); messages.push({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
      const trimmed = maintenance.trimOldToolResults(messages, { maxInlineBytes: 1500, pendingToolNames: pending(ctx) });
      const measure = (globalThis as any)[Symbol.for(key + ".measure")];
      return { before: (await measure(messages)).bytes + limits.outputReserve + limits.safetyMargin,
        after: (await measure(trimmed.messages)).bytes + limits.outputReserve + limits.safetyMargin, trimmed: trimmed.trimmed.length };
    };
    pi.on("input", async (e: any, ctx: any) => {
      if (!["interactive", "rpc"].includes(e.source) || !ctx.isIdle() || e.images?.length) return;
      metrics.maintenanceInputs++; let p = await project(ctx, e.text);
      metrics.projectedBefore = p.before; metrics.projectedAfter = p.after; metrics.preflightTrimmed += p.trimmed; pressure = p.trimmed > 0;
      if (p.after <= limits.contextBytes * .85 || pending(ctx).length || options().maintenanceDisabled) return;
      const epoch = generation, id = ctx.sessionManager.getSessionId(); metrics.compactAttempts++; let failed = false;
      try { await new Promise((resolve, reject) => ctx.compact({ onComplete: resolve, onError: reject })); } catch { metrics.compactErrors++; failed = true; }
      if (epoch !== generation || id !== ctx.sessionManager.getSessionId()) { metrics.handledInputs++; return { action: "handled" }; }
      p = await project(ctx, e.text); metrics.projectedAfter = p.after;
      if (failed || p.after > limits.contextBytes) { metrics.handledInputs++; ctx.ui?.setEditorText?.(e.text); return { action: "handled" }; }
    });
    pi.on("context", (e: any, ctx: any) => { if (!pressure) return; const before = JSON.stringify(e.messages);
      const result = maintenance.trimOldToolResults(e.messages, { maxInlineBytes: 1500, pendingToolNames: pending(ctx) });
      metrics.historyIntact = metrics.historyIntact && before === JSON.stringify(e.messages); metrics.contextTrimmed += result.trimmed.length; return { messages: result.messages }; });
  }
  (globalThis as any)[Symbol.for(key)] = { runtime, metrics, receipt: () => receipt };
}

export function profileSource(profile: Profile) {
  assert.ok(PROFILES.includes(profile)); let base = lifecycleExtensionSource("sdk-b3-checkpoint-ops-v2");
  const old = `limits:${JSON.stringify(OLD_LIMITS)}`; assert.equal(base.split(old).length, 2); base = base.replace(old, `limits:${JSON.stringify(PRODUCT_LIMITS)}`);
  assert.equal(base.split("export default function (pi)").length, 2);
  const features = FEATURES(profile), factories = { ...(features.supervisor ? { createRunSupervisor, createSupervisorRuntime } : {}), ...(features.maintenance ? { createContextMaintenance } : {}) };
  const deps = { key: KEY, target: TARGET, valid: VALID, prerequisite: PREREQUISITE, verify: VERIFY, controlKey: CONTROL_KEY, limits: PRODUCT_LIMITS, supervisorLimits: SUPERVISOR_LIMITS };
  return base.replace("export default function (pi)", "function registerS4LiveBase(pi)") +
    "\nexport default function(pi){const ends=[]; registerS4LiveBase({...pi,on(name,handler){if(name==='agent_end')ends.push(handler);else pi.on(name,name==='tool_call'?(e,c)=>e.toolName===" + JSON.stringify(VERIFY) + "?undefined:handler(e,c):handler);}});\n" +
    "(" + installLiveLayer.toString() + ")(pi,{path,readFile,createHash,Type,..." + JSON.stringify(deps) + ",emptyMetrics:(" + emptyMetrics.toString() + ")," +
    Object.entries(factories).map(([n, f]) => n + ":(" + f.toString() + ")").join(",") + "}," + JSON.stringify(features) + ");for(const h of ends)pi.on('agent_end',h);}\n";
}
export function auditProfile(profile: Profile, loaded: any) {
  assert.equal(loaded.errors.length, 0); assert.equal(loaded.extensions.length, 1);
  const base = expectedInventory("sdk-b3-checkpoint"), h: Record<string, number> = { ...base.handlers, tool_call: base.handlers.tool_call + 2, tool_result: (base.handlers.tool_result ?? 0) + 2 };
  const add = (names: string[]) => names.forEach(n => h[n] = (h[n] ?? 0) + 1);
  if (FEATURES(profile).supervisor) add(["session_start", "session_switch", "input", "agent_start", "tool_call", "tool_result", "turn_end", "agent_end"]);
  if (FEATURES(profile).maintenance) add(["input", "context"]);
  const e = loaded.extensions[0]; assert.equal(digest({ tools: [...e.tools.keys()].sort(), commands: [...e.commands.keys()].sort(), handlers: Object.fromEntries([...e.handlers.entries()].map(([n, a]: any) => [n, a.length])) }),
    digest({ tools: [...base.tools, VERIFY].sort(), commands: base.commands, handlers: h }), "S4L_CAPABILITY_LEAK");
}
export const schemaDigest = (tools: readonly { name: string; description: string; parameters: unknown }[]) => digest(tools.map(({ name, description, parameters }) => ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name)));
