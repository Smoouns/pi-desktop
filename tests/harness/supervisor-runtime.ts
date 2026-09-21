import assert from "node:assert/strict";
import { createRunSupervisor } from "../../src/harness/run-supervisor.js";
import { createSupervisorRuntime } from "../../src/extensions/supervisor-runtime.js";
import { sha256, type RunCase } from "./testkit.js";

const scope = { projectId: "project-a", sessionId: "session-a", runId: "run-a", generation: 1, role: "write" };
const entry = (data: unknown) => ({ type: "custom", customType: "pi-desktop-run-status/v1", data });
const create = (append: (value: unknown) => void = () => {}) => createSupervisorRuntime({ createSupervisor: () => createRunSupervisor({ digest: sha256 }), append });

export async function runSupervisorRuntimeCases(runCase: RunCase): Promise<void> {
	await runCase("P4-RESUME latest damaged status cannot fall back to older success", () => {
		const core = createRunSupervisor({ digest: sha256 });
		core.begin(scope); const old = core.stop(scope, "COMPLETED_CANDIDATE", "stop")!;
		for (const malformed of [{}, { ...old, id: "invalid" }]) {
			const runtime = create();
			const restored = runtime.restore([entry(old), entry(malformed)], scope, 2);
			assert.equal(restored?.state, "FAILED");
			assert.equal(runtime.tool("after-corruption", "write").allowed, false);
		}
	});
	await runCase("P4-RESUME abandoned running state requires explicit user restart", () => {
		const old = createRunSupervisor({ digest: sha256 }).begin(scope);
		const runtime = create(); const restored = runtime.restore([entry(old)], scope, 2);
		assert.equal(restored?.state, "BLOCKED_PREREQUISITE");
		assert.equal(runtime.tool("replay", "write").allowed, false);
		runtime.start({ ...scope, runId: "automatic", generation: 2 });
		assert.equal(runtime.snapshot()?.state, "BLOCKED_PREREQUISITE", "automatic loop restart is not permission");
		runtime.markExplicitInput("extension");
		runtime.start({ ...scope, runId: "automatic-again", generation: 3 });
		assert.equal(runtime.snapshot()?.state, "BLOCKED_PREREQUISITE");
		runtime.markExplicitInput("rpc");
		runtime.start({ ...scope, runId: "new-user-run", generation: 4 });
		assert.equal(runtime.snapshot()?.state, "RUNNING");
		assert.equal(runtime.snapshot()?.scope.runId, "new-user-run");
	});
	await runCase("P4-RESUME persistence failure poisons tool gate", () => {
		let failed = false;
		const runtime = create(() => { if (failed) throw new Error("synthetic storage failure"); });
		runtime.markExplicitInput("rpc"); runtime.start(scope);
		failed = true;
		try { runtime.tool("will-not-dispatch", "write"); } catch { /* A failed durable gate may throw. */ }
		failed = false;
		assert.equal(runtime.tool("must-not-recover-silently", "write").allowed, false);
		assert.notEqual(runtime.snapshot()?.state, "RUNNING");
	});
	await runCase("P4-RESUME interrupted-run persistence failure stays scoped and fail-closed", () => {
		const running = createRunSupervisor({ digest: sha256 }).begin(scope);
		const runtime = create(() => { throw new Error("synthetic restore persistence failure"); });
		assert.throws(() => runtime.restore([entry(running)], scope, 2), /persistence failed/i);
		const poisoned = runtime.snapshot();
		assert.ok(poisoned, "failed persistence must retain the restored run scope");
		assert.equal(poisoned?.scope.runId, running.scope.runId);
		assert.notEqual(poisoned?.state, "RUNNING"); assert.equal(poisoned?.reasonCode, "INTERRUPTED_RUN");
		assert.equal(runtime.tool("after-restore-failure", "write").allowed, false);
		runtime.markExplicitInput("interactive");
		assert.equal(runtime.start({ ...scope, runId: "must-not-reset", generation: 2 })?.id, poisoned?.id, "explicit input cannot clear a poisoned persistence gate");
		assert.equal(runtime.tool("after-explicit-input", "write").allowed, false);
	});
	await runCase("P4-RESUME role and branch isolation never borrow a status", () => {
		const foreign = createRunSupervisor({ digest: sha256 }).begin({ ...scope, role: "plan" });
		const runtime = create();
		assert.equal(runtime.restore([entry(foreign)], scope, 2), null);
		assert.equal(runtime.restore([], scope, 3), null);
		assert.equal(runtime.snapshot(), null);
		const embedded = Function(`return (${createSupervisorRuntime.toString()})`)() as typeof createSupervisorRuntime;
		const rebuilt = embedded({ createSupervisor: () => createRunSupervisor({ digest: sha256 }), append: () => {} });
		rebuilt.markExplicitInput("interactive"); assert.equal(rebuilt.start(scope)?.state, "RUNNING");
	});
	await runCase("P4-RUNTIME default hard caps persist parseable snapshots", () => {
		const persisted: unknown[] = [];
		const runtime = create((snapshot) => {
			persisted.push(JSON.parse(JSON.stringify(snapshot)));
			createRunSupervisor({ digest: sha256 }).parse(snapshot);
		});
		runtime.markExplicitInput("interactive"); runtime.start({ ...scope, runId: "tool-cap" });
		let seed = 0x12345678;
		const randomId = (prefix: string): string => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return `${prefix}-${seed.toString(16).padStart(8, "0")}`; };
		for (let index = 0; index < 96; index++) assert.equal(runtime.tool(randomId("tool"), "read").allowed, true);
		const denied = runtime.tool(randomId("tool"), "read");
		assert.equal(denied.allowed, false); assert.equal(denied.snapshot?.state, "FAILED"); assert.equal(denied.snapshot?.reasonCode, "MAX_TOOL_CALLS"); assert.equal(denied.snapshot?.toolCalls, 96);
		assert.ok(persisted.length >= 97); for (const value of persisted) createRunSupervisor({ digest: sha256 }).parse(value);

		const turns = create(); turns.markExplicitInput("rpc"); turns.start({ ...scope, runId: "turn-cap" });
		for (let index = 0; index < 32; index++) assert.equal(turns.turn()?.state, "RUNNING");
		assert.equal(turns.turn()?.reasonCode, "MAX_TURNS"); assert.equal(turns.snapshot()?.turns, 32);

		const verifies = create(); verifies.markExplicitInput("interactive"); verifies.start({ ...scope, runId: "verify-cap" });
		for (let index = 0; index < 12; index++) {
			const snapshot = verifies.verification({ callId: randomId("verify"), subject: `chapter-${index}`, artifactSha256: null, errorDigest: randomId("error"), passed: false, full: index % 2 === 0 });
			assert.equal(snapshot?.state, "RUNNING");
		}
		const capped = verifies.verification({ callId: randomId("verify"), subject: "overflow", artifactSha256: null, errorDigest: "overflow", passed: false, full: true });
		assert.equal(capped?.state, "FAILED"); assert.equal(capped?.reasonCode, "MAX_VERIFICATION_ATTEMPTS"); assert.equal(capped?.verificationAttempts, 12);
	});
	await runCase("P4-RUNTIME snapshot capacity fails before tool dispatch", () => {
		const parser = createRunSupervisor({ digest: sha256, maxToolCalls: 4096 });
		const persisted: unknown[] = [];
		const runtime = createSupervisorRuntime({
			createSupervisor: () => createRunSupervisor({ digest: sha256, maxToolCalls: 4096 }),
			append: (snapshot) => { persisted.push(JSON.parse(JSON.stringify(snapshot))); parser.parse(snapshot); },
		});
		runtime.markExplicitInput("interactive"); runtime.start({ ...scope, runId: "byte-cap" });
		let result: ReturnType<typeof runtime.tool> | null = null;
		for (let index = 0; index < 4096; index++) {
			const prefix = `capacity-${index}-`; const callId = prefix + "x".repeat(4096 - prefix.length);
			result = runtime.tool(callId, "read");
			if (!result.allowed) break;
		}
		assert.equal(result?.allowed, false, "the size-crossing tool must not dispatch");
		assert.equal(result?.snapshot?.state, "FAILED"); assert.equal(result?.snapshot?.reasonCode, "CAPACITY");
		assert.ok(Buffer.byteLength(JSON.stringify(result?.snapshot), "utf8") <= 256 * 1024);
		for (const value of persisted) parser.parse(value);
	});
}
