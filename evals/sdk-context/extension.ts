import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createObservationStore } from "../adapters/snapshots/observation-store.js";
import { createContextBudget } from "../adapters/snapshots/context-budget.js";
import { createCheckpointStore } from "../adapters/snapshots/checkpoint-store.js";
import { createSourceVersioning } from "../adapters/snapshots/source-version.js";
import { createCheckpointInvalidation } from "../adapters/snapshots/invalidation.js";
import { createCheckpointRuntime } from "../../src/extensions/checkpoint-runtime.js";
import historical from "../adapters/provenance.json";
import { sdkExtensionSource, expectedSdkInventory, validateSdkProvenance } from "../sdk-ablation/extensions.js";
import { createBaselineSafety } from "../sdk-ablation/safety.js";
import { digest, sha256 } from "../core/io.js";
import { CONTROL_KEY, FEATURES, LIMITS, METRICS_KEY, PROFILES, emptyMetrics, type Profile } from "./policy.js";

/** Eval-only event adapter. Frozen production factories, no Supervisor or maintenance. */
export function installContextLayer(pi: any, deps: any, checkpointEnabled: boolean, metrics: ReturnType<typeof emptyMetrics>) {
	const { path, lstat, readFile, createHash, Type, limits, controlKey } = deps;
	const sha = (value: any) => createHash("sha256").update(value).digest("hex");
	const safety = deps.createBaselineSafety({ path, lstat, readFile });
	const observations = deps.createObservationStore({ digest: sha, maxPayloadBytes: 256 * 1024 });
	const budget = deps.createContextBudget();
	const versions = checkpointEnabled ? deps.createSourceVersioning() : null;
	let generation = 0, active: any = null;
	const identity = (ctx: any) => ({ projectId: sha(process.platform === "win32" ? path.resolve(ctx.cwd).toLowerCase() : path.resolve(ctx.cwd)),
		sessionId: ctx.sessionManager.getSessionId(), role: [...ctx.sessionManager.getBranch()].reverse().find((e: any) => e.type === "custom" && e.customType === "pi-desktop-novel-role")?.data?.role ?? null });
	const same = (a: any, b: any) => a.projectId === b.projectId && a.sessionId === b.sessionId && a.role === b.role;
	const stop = () => { if (active) { active.controller.abort(); budget.endRun(active.scope); } active = null; };
	const current = (ctx: any) => { const owner = identity(ctx); if (!active || !same(active.scope, owner)) { stop(); active = { scope: { ...owner, runId: `s3-${++generation}`, generation }, controller: new AbortController() }; budget.beginRun(active.scope); } return active; };
	const assertRun = (run: any) => { if (run !== active || run.controller.signal.aborted) throw new Error("S3_INACTIVE_RUN"); };
	const sourceRef = async (name: string, ctx: any) => ({ path: name, sha256: sha(await readFile(await safety.checkedPath(ctx.cwd, name, false))), authority: "reference", temporal: "unspecified" });
	const runtime = checkpointEnabled ? deps.createCheckpointRuntime({ store: deps.createCheckpointStore({ digest: sha }), versions,
		invalidation: deps.createCheckpointInvalidation(), assertRun,
		append: (checkpoint: any) => { pi.appendEntry("pi-desktop-task-checkpoint", checkpoint); metrics.checkpoints++; },
		budget: (scope: any) => { const b = budget.getRunBudget(scope); return { readUsed: b.readUsed, outputUsed: b.outputUsed }; },
		resolve: async (ref: any, ctx: any) => { try { return { ...await sourceRef(ref.path, ctx), eligible: true }; } catch (error) { if ((error as any).code === "ENOENT") return { sha256: null }; throw error; } },
	}) : null;
	pi.on("agent_start", (_e: any, ctx: any) => { stop(); current(ctx); });
	pi.on("agent_end", stop);
	for (const event of ["session_start", "session_switch", "session_shutdown"]) pi.on(event, () => { stop(); runtime?.reset(); });
	pi.on("tool_result", async (event: any, ctx: any) => {
		if (event.isError || !["read", "read_story_document"].includes(event.toolName)) return;
		const run = current(ctx), ref = await sourceRef(event.input.path, ctx); assertRun(run);
		const text = event.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
		if (!budget.chargeRead(run.scope, Buffer.byteLength(text)).allowed) throw new Error("S3_READ_BUDGET");
		const item = observations.put({ scope: run.scope, toolName: event.toolName, toolCallId: event.toolCallId, text, sources: [ref], previewChars: 120 }); metrics.observations++;
		runtime?.observe(ctx, run, [ref], item.id);
		const content = Buffer.byteLength(text) > 1500 ? [{ type: "text", text: JSON.stringify({ observationId: item.id, preview: item.preview, payloadChars: text.length, payloadBytes: item.payloadBytes, sourceRefs: item.sourceRefs }) }] : event.content;
		if (!budget.chargeOutput(run.scope, Buffer.byteLength(JSON.stringify(content))).allowed) throw new Error("S3_OUTPUT_BUDGET");
		return { content, details: { ...event.details, observation: item, observedRun: run.scope } };
	});
	pi.registerTool({ name: "read_observation", label: "Read observation", description: "Read a bounded current-source page from this process, project, session and role.",
		parameters: Type.Object({ id: Type.String(), start: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
		async execute(id: string, args: any, _signal: any, _update: any, ctx: any) {
			try {
				const run = current(ctx), limit = args.limit ?? 256, start = args.start ?? 0;
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4000 || !Number.isSafeInteger(start) || start < 0) throw new Error("S3_INVALID_PAGE");
				const item = observations.peek({ id: args.id, scope: run.scope });
				for (const ref of item.sourceRefs) { const actual = await sourceRef(ref.path, ctx); assertRun(run); if (actual.sha256 !== ref.sha256) throw new Error("S3_STALE_OBSERVATION"); }
				const page = observations.read({ id: args.id, scope: run.scope, start, limit, toolName: "read_observation", toolCallId: id });
				if (!budget.chargeRead(run.scope, Buffer.byteLength(page.payload)).allowed || !budget.chargeOutput(run.scope, Buffer.byteLength(page.payload)).allowed) throw new Error("S3_PAGE_BUDGET");
				metrics.pages++; return { content: [{ type: "text", text: page.payload }], details: { observationPage: true } };
			} catch { metrics.observationDenied++; throw new Error("S3_OBSERVATION_UNAVAILABLE"); }
		} });
	pi.on("before_provider_request", (event: any, ctx: any) => {
		metrics.budgetChecks++;
		const result = budget.checkPayload(event.payload, limits.contextBytes, limits.outputReserve, limits.safetyMargin);
		if (!result.allowed) { metrics.budgetBlocks++; ctx.abort(); }
	});
	if (runtime) {
		pi.on("session_before_compact", async (event: any, ctx: any) => { metrics.beforeCompact++; try { if (event.signal?.aborted) return { cancel: true }; runtime.capture(ctx, current(ctx), "before_compact"); } catch { metrics.persistenceBlocks++; return { cancel: true }; } });
		pi.on("session_compact", async (_event: any, ctx: any) => { metrics.afterCompact++; try { runtime.capture(ctx, current(ctx), "after_compact"); } catch { metrics.persistenceBlocks++; ctx.abort(); } });
		pi.on("tool_call", async (event: any, ctx: any) => {
			if (event.toolName !== "write") return;
			const reason = await runtime.writeGate(ctx, current(ctx));
			if (reason) { metrics.staleWriteBlocks++; return { block: true, reason }; }
		});
		for (const name of ["get_task_checkpoint", "refresh_task_checkpoint"]) pi.registerTool({ name, label: name, description: "Inspect or refresh versioned checkpoint evidence; this does not grant write authority.", parameters: Type.Object({}),
			async execute(_id: string, _args: any, _signal: any, _update: any, ctx: any) { const run = current(ctx); if (name === "refresh_task_checkpoint") metrics.refreshes++;
				const result = await (name === "refresh_task_checkpoint" ? runtime.refresh(ctx, run) : runtime.inspect(ctx, run));
				return { content: [{ type: "text", text: JSON.stringify({ status: result.status, writeAuthority: result.writeAuthority, invalidPaths: result.invalidPaths }) }] }; } });
	}
	// Test-only handles never become model tools or returned data.
	(globalThis as any)[Symbol.for(controlKey)] = { observations, budget, runtime, current, stop };
}

const B3_RUNTIME_SHA = "9117d598d4cf13fe473794610749e2437a30927c20340b0cb34d7cac7b36cb4e";
export async function validateContextProvenance() {
	await validateSdkProvenance();
	for (const profile of ["historical-b2", "historical-b3"] as const) for (const source of historical.profiles[profile].sources) {
		assert.equal(sha256(await readFile(source.localPath)), source.sha256);
		const original = spawnSync("git", ["show", `${historical.profiles[profile].phaseCommit}:${source.path}`], { windowsHide: true, maxBuffer: 2_000_000 });
		assert.equal(original.status, 0); assert.equal(sha256(original.stdout), source.sha256);
	}
	assert.equal(sha256(await readFile("src/extensions/checkpoint-runtime.ts")), B3_RUNTIME_SHA);
	const original = spawnSync("git", ["show", `${historical.profiles["historical-b3"].phaseCommit}:src/extensions/checkpoint-runtime.ts`], { windowsHide: true });
	assert.equal(original.status, 0); assert.equal(sha256(original.stdout), B3_RUNTIME_SHA);
}

export function extensionSource(profile: Profile): string {
	assert.ok(PROFILES.includes(profile));
	const base = sdkExtensionSource("sdk-b1-reliability");
	if (profile === "sdk-b1-reliability") return base;
	const factories = { createObservationStore, createContextBudget, createCheckpointStore, createSourceVersioning, createCheckpointInvalidation, createCheckpointRuntime, createBaselineSafety };
	const used = Object.entries(factories).filter(([name]) => profile === "sdk-b3-checkpoint" || ["createObservationStore", "createContextBudget", "createBaselineSafety"].includes(name));
	return base.replace("export default function (pi)", "function registerB1(pi)") + `
export default function (pi) {
 const metrics = ${JSON.stringify(emptyMetrics())};
 globalThis[Symbol.for(${JSON.stringify(METRICS_KEY)})] = metrics;
 (${installContextLayer.toString()})(pi, {path,lstat,readFile,createHash,Type,limits:${JSON.stringify(LIMITS)},controlKey:${JSON.stringify(CONTROL_KEY)},${used.map(([name, fn]) => `${name}:(${fn.toString()})`).join(",")}},${FEATURES[profile].checkpoint},metrics);
 const extra = ${JSON.stringify(profile === "sdk-b3-checkpoint" ? ["read_observation", "get_task_checkpoint", "refresh_task_checkpoint"] : ["read_observation"])};
 registerB1({...pi,on(name, handler) {pi.on(name, name === "tool_call" ? (event,ctx) => extra.includes(event.toolName) ? undefined : handler(event,ctx) : handler);}});
}
`;
}
export function expectedInventory(profile: Profile) {
	const b = expectedSdkInventory("sdk-b1-reliability");
	if (profile === "sdk-b1-reliability") return b;
	return { tools: [...b.tools, "read_observation", ...(profile === "sdk-b3-checkpoint" ? ["get_task_checkpoint", "refresh_task_checkpoint"] : [])].sort(), commands: b.commands,
		handlers: { ...b.handlers, agent_start: 2, agent_end: 2, session_start: 2, session_switch: 2, session_shutdown: 2, tool_result: 2, before_provider_request: 1,
			...(profile === "sdk-b3-checkpoint" ? { tool_call: 4, session_before_compact: 1, session_compact: 1 } : {}) } };
}
export function auditInventory(profile: Profile, loaded: any, source: string) {
	assert.equal(sha256(source), sha256(extensionSource(profile))); assert.equal(loaded.errors.length, 0); assert.equal(loaded.extensions.length, 1);
	const e = loaded.extensions[0];
	assert.equal(digest({ tools: [...e.tools.keys()].sort(), commands: [...e.commands.keys()].sort(), handlers: Object.fromEntries([...e.handlers.entries()].map(([name, list]: any) => [name, list.length])) }), digest(expectedInventory(profile)), "S3_CAPABILITY_LEAK");
}
