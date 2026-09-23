import assert from "node:assert/strict";
import { digest, sha256 } from "../core/io.js";
import { CONTROL_KEY } from "./policy.js";
import { extensionSource, expectedInventory } from "./extension.js";
import { LIFE_FAULT, LIFE_METRICS, type LifeProfile } from "./lifecycle-policy.js";
import { createBaselineSafety as createSafety } from "../sdk-ablation/safety.js";

/** Eval-only operation event wiring around the unchanged Phase 3 runtime.
 * Intent is durable before dispatch; an error never claims a successful write.
 * Registered before/after the original gates so blocked calls have no new intent.
 */
export function installDurableOperations(pi: any, deps: any, register: (api: any) => void) {
	const { createHash, path, lstat, readFile, controlKey, metricsKey, faultKey } = deps;
	const sha = (value: any) => createHash("sha256").update(value).digest("hex");
	const safety = deps.createSafety({ path, lstat, readFile });
	const pending = new Map<string, any>();
	const metrics = { intents: 0, results: 0, replayBlocks: 0, persistenceBlocks: 0, staleResults: 0 };
	(globalThis as any)[Symbol.for(metricsKey)] = metrics;
	const control = () => (globalThis as any)[Symbol.for(controlKey)];
	const fingerprint = async (ctx: any, target: string) => {
		try { return sha(await readFile(await safety.checkedPath(ctx.cwd, target, true))); }
		catch (error) { if ((error as any).code === "ENOENT") return null; throw error; }
	};
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (event.toolName !== "write") return;
		try {
			await safety.check("write", event.input, ctx);
			const c = control(), run = c.current(ctx);
			const reason = await c.runtime.writeGate(ctx, run, { operationId: event.toolCallId, toolName: "write", target: event.input.path, argsDigest: sha(JSON.stringify([event.input.content])) });
			if (reason) { metrics.replayBlocks++; return { block: true, reason }; }
		} catch { metrics.persistenceBlocks++; return { block: true, reason: "[checkpoint_persistence] Durable write gate unavailable." }; }
	});
	register({ ...pi, appendEntry(type: string, data: any) {
		const fault = (globalThis as any)[Symbol.for(faultKey)];
		if (type === "pi-desktop-task-checkpoint" && fault === data.cause) throw new Error("S3_SYNTHETIC_PERSISTENCE_FAILURE");
		return pi.appendEntry(type, data);
	} });
	pi.on("tool_call", async (event: any, ctx: any) => {
		if (event.toolName !== "write") return;
		try {
			const c = control(), run = c.current(ctx);
			const op = { operationId: event.toolCallId, toolName: "write", target: event.input.path,
				preHash: await fingerprint(ctx, event.input.path), expectedPostHash: sha(event.input.content), argsDigest: sha(JSON.stringify([event.input.content])), state: "issued", dispatched: false };
			c.runtime.operation(ctx, run, op);
			c.runtime.operation(ctx, run, { ...op, dispatched: true });
			pending.set(event.toolCallId, { run, op: { ...op, dispatched: true } }); metrics.intents++;
		} catch { metrics.persistenceBlocks++; return { block: true, reason: "[checkpoint_persistence] Intent not durable; write denied." }; }
	});
	pi.on("tool_result", async (event: any, ctx: any) => {
		if (event.toolName !== "write") return;
		const item = pending.get(event.toolCallId); if (!item) return;
		pending.delete(event.toolCallId);
		const c = control();
		if (item.run !== c.current(ctx) || item.run.controller.signal.aborted) { metrics.staleResults++; return; }
		try {
			const post = await fingerprint(ctx, item.op.target);
			if (item.run !== c.current(ctx) || item.run.controller.signal.aborted) { metrics.staleResults++; return; }
			const state = !event.isError && post === item.op.expectedPostHash ? "completed" : "unknown";
			c.runtime.operation(ctx, item.run, { ...item.op, state }, state === "completed" ? post : null); metrics.results++;
		} catch { metrics.persistenceBlocks++; ctx.abort(); }
	});
}

export function lifecycleExtensionSource(profile: LifeProfile): string {
	if (profile !== "sdk-b3-checkpoint-ops-v2") return extensionSource(profile);
	const source = extensionSource("sdk-b3-checkpoint");
	assert.equal(source.split("export default function (pi)").length, 2);
	// The shared safety factory is already embedded in the B1 source. Reuse its
	// implementation via a separate import at bundle time, never private settings.
	return source.replace("export default function (pi)", "function registerContextV1(pi)") + `
export default function (pi) {
 (${installDurableOperations.toString()})(pi, {createHash,path,lstat,readFile,createSafety:(${createSafety.toString()}),controlKey:${JSON.stringify(CONTROL_KEY)},metricsKey:${JSON.stringify(LIFE_METRICS)},faultKey:${JSON.stringify(LIFE_FAULT)}}, registerContextV1);
}
`;
}
export function auditLifecycleInventory(profile: LifeProfile, loaded: any, source: string) {
	assert.equal(sha256(source), sha256(lifecycleExtensionSource(profile)));
	assert.equal(loaded.errors.length, 0); assert.equal(loaded.extensions.length, 1);
	const expected = expectedInventory(profile === "sdk-b3-checkpoint-ops-v2" ? "sdk-b3-checkpoint" : profile);
	if (profile === "sdk-b3-checkpoint-ops-v2") { expected.handlers.tool_call += 2; expected.handlers.tool_result = (expected.handlers.tool_result ?? 0) + 1; }
	const e = loaded.extensions[0];
	assert.equal(digest({ tools: [...e.tools.keys()].sort(), commands: [...e.commands.keys()].sort(), handlers: Object.fromEntries([...e.handlers.entries()].map(([name, list]: any) => [name, list.length])) }), digest(expected), "S3_LIFECYCLE_CAPABILITY_LEAK");
}
