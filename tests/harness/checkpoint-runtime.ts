import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCheckpointRuntime } from "../../src/extensions/checkpoint-runtime.js";
import { createCheckpointStore, type PendingCheckpointOperation } from "../../src/harness/checkpoint-store.js";
import { createCheckpointInvalidation } from "../../src/harness/invalidation.js";
import { createSourceVersioning, type SourceVersionRef } from "../../src/harness/source-version.js";
import type { RunCase } from "./testkit.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const scope = { projectId: "p", sessionId: "s", runId: "r", generation: 1, role: "write" };
const ref = (patch: Partial<SourceVersionRef> = {}): SourceVersionRef => ({ path: "canon/world.md", sha256: hash("old"), authority: "canonical", temporal: "current", ...patch });
const operation = (patch: Partial<PendingCheckpointOperation> = {}): PendingCheckpointOperation => ({ operationId: "op-1", toolName: "write", target: "drafts/a.md", preHash: null, expectedPostHash: hash("post"), argsDigest: hash("args"), state: "issued", dispatched: false, ...patch });

function fixture(options: { failAppend?: boolean } = {}) {
	const entries: any[] = [];
	const current = new Map<string, { sha256: string | null; authority?: string; temporal?: string; memoryId?: string; eligible?: boolean }>();
	const versions = createSourceVersioning();
	const branch: any[] = [{ type: "message", message: { role: "user", content: "exact constraint" } }];
	const ctx = { sessionManager: { getBranch: () => [...branch, ...entries] } };
	let active = true;
	const run = { scope: { ...scope }, controller: new AbortController() };
	const runtime = createCheckpointRuntime({
		store: createCheckpointStore({ digest: hash }), versions, invalidation: createCheckpointInvalidation(),
		append: (checkpoint) => { if (options.failAppend) throw new Error("disk full"); entries.push({ type: "custom", customType: "pi-desktop-task-checkpoint", data: checkpoint }); },
		resolve: async (source) => current.get(source.path) ?? { sha256: source.sha256, authority: source.authority, temporal: source.temporal, memoryId: source.memoryId, eligible: true },
		assertRun: () => { if (!active) throw new Error("stale run"); }, budget: () => ({ readUsed: 0, outputUsed: 0 }),
	});
	return { runtime, current, ctx, run, entries, branch, deactivate: () => { active = false; } };
}

export async function runCheckpointRuntimeCases(runCase: RunCase): Promise<void> {
	await runCase("checkpoint-runtime.constraints-preserve-a-b-a-chronology", () => {
		const f = fixture();
		f.branch.splice(0, f.branch.length,
			{ type: "message", message: { role: "user", content: "A" } },
			{ type: "message", message: { role: "user", content: "B" } },
			{ type: "message", message: { role: "user", content: "A" } });
		const checkpoint = f.runtime.capture(f.ctx, f.run);
		assert.deepEqual(checkpoint.hardConstraints, ["A", "B", "A"]);
		assert.equal(checkpoint.objective, "A");
	});
	await runCase("checkpoint-runtime.first-write-validates-uncaptured-receipts", async () => {
		const f = fixture(); f.runtime.observe(f.ctx, f.run, [ref()], "obs-1");
		f.current.set("canon/world.md", { sha256: hash("changed"), authority: "canonical", temporal: "current", eligible: true });
		assert.match((await f.runtime.writeGate(f.ctx, f.run)) ?? "", /stale_source/);
		assert.equal((await f.runtime.refresh(f.ctx, f.run)).status, "needs_revalidation", "initial stale capture must retain pinned evidence");
		f.current.set("canon/world.md", { sha256: hash("old"), authority: "canonical", temporal: "current", eligible: true });
		assert.equal((await f.runtime.refresh(f.ctx, f.run)).status, "needs_revalidation", "rollback still requires a new read");
	});

	await runCase("checkpoint-runtime.rollback-needs-new-read", async () => {
		const f = fixture(); f.runtime.observe(f.ctx, f.run, [ref()], "obs-1"); f.runtime.capture(f.ctx, f.run);
		f.current.set("canon/world.md", { sha256: hash("changed"), authority: "canonical", temporal: "current", eligible: true });
		assert.equal((await f.runtime.inspect(f.ctx, f.run)).status, "needs_revalidation");
		f.current.set("canon/world.md", { sha256: hash("old"), authority: "canonical", temporal: "current", eligible: true });
		assert.equal((await f.runtime.refresh(f.ctx, f.run)).status, "needs_revalidation", "rollback alone cannot reuse the old receipt");
		f.runtime.observe(f.ctx, f.run, [ref()], "obs-2");
		assert.notEqual((await f.runtime.refresh(f.ctx, f.run)).status, "needs_revalidation");
	});

	await runCase("checkpoint-runtime.observe-id-does-not-rewrite-checkpoint", async () => {
		const f = fixture(); f.runtime.observe(f.ctx, f.run, [ref()], "obs-1"); const captured = f.runtime.capture(f.ctx, f.run);
		f.runtime.observe(f.ctx, f.run, [], "obs-2");
		assert.equal((await f.runtime.inspect(f.ctx, f.run)).checkpoint?.id, captured.id);
		assert.deepEqual(f.runtime.capture(f.ctx, f.run).observationIds, ["obs-1", "obs-2"]);
	});

	await runCase("checkpoint-runtime.operation-id-is-immutable", () => {
		const f = fixture(); f.runtime.operation(f.ctx, f.run, { ...operation(), scope: { ignored: true }, acknowledgedPostHash: "ignored" } as any);
		assert.deepEqual(Object.keys(f.runtime.capture(f.ctx, f.run).pendingOperations[0]!).sort(), ["argsDigest", "dispatched", "expectedPostHash", "operationId", "preHash", "state", "target", "toolName"].sort());
		assert.throws(() => f.runtime.operation(f.ctx, f.run, operation({ target: "drafts/b.md" })), /collision/);
		f.runtime.operation(f.ctx, f.run, operation({ state: "unknown", dispatched: true }));
		assert.throws(() => f.runtime.operation(f.ctx, f.run, operation({ state: "issued", dispatched: true })), /replayed/);
		assert.throws(() => fixture().runtime.operation(f.ctx, f.run, operation({ operationId: "late", dispatched: true })), /before dispatch/);
	});

	await runCase("checkpoint-runtime.persistence-failure-poisons-gate", async () => {
		const f = fixture({ failAppend: true });
		assert.throws(() => f.runtime.operation(f.ctx, f.run, operation()), /disk full/);
		assert.match((await f.runtime.writeGate(f.ctx, f.run)) ?? "", /persistence|持久化/);
	});

	await runCase("checkpoint-runtime.post-write-retires-ordinary-evidence-only", async () => {
		const f = fixture(); const ordinary = ref({ path: "drafts/a.md" }), memory = ref({ path: "drafts/a.md", startLine: 1, endLine: 2, memoryId: "accept-1" });
		f.runtime.observe(f.ctx, f.run, [ordinary, memory]); f.runtime.capture(f.ctx, f.run);
		f.runtime.operation(f.ctx, f.run, operation());
		f.runtime.operation(f.ctx, f.run, operation({ state: "completed", dispatched: true }), hash("post"));
		const latest = f.runtime.capture(f.ctx, f.run);
		assert.equal(latest.evidence.some((item) => item.path === "drafts/a.md" && !item.memoryId), false);
		assert.equal(latest.evidence.some((item) => item.memoryId === "accept-1"), true);
		assert.equal(latest.unresolvedIssues.some((item) => item.message === "drafts/a.md"), true);
		assert.equal(latest.artifacts[0]?.authority, "reference");
	});

	await runCase("checkpoint-runtime-first-write-retains-new-receipts", () => {
		const f = fixture(); f.runtime.observe(f.ctx, f.run, [ref()], "obs-before-write");
		f.runtime.operation(f.ctx, f.run, operation());
		const latest = f.runtime.capture(f.ctx, f.run);
		assert.equal(latest.evidence.some((item) => item.path === "canon/world.md"), true);
		assert.deepEqual(latest.observationIds, ["obs-before-write"]);
	});

	await runCase("checkpoint-runtime-restores-only-post-checkpoint-scoped-receipts", () => {
		const f = fixture(); f.runtime.observe(f.ctx, f.run, [ref({ path: "canon/base.md" })]); const checkpoint = f.runtime.capture(f.ctx, f.run);
		const before = { type: "message", message: { role: "toolResult", details: { observedRun: scope, observation: { sourceRefs: [ref({ path: "canon/before.md" })] } } } };
		const after = { type: "message", message: { role: "toolResult", details: { observedRun: scope, observation: { sourceRefs: [ref({ path: "canon/after.md" })] } } } };
		const foreign = { type: "message", message: { role: "toolResult", details: { observedRun: { ...scope, projectId: "other" }, observation: { sourceRefs: [ref({ path: "canon/foreign.md" })] } } } };
		f.branch.splice(0, f.branch.length, before, { type: "custom", customType: "pi-desktop-task-checkpoint", data: checkpoint }, after, foreign);
		f.entries.splice(0, f.entries.length);
		f.runtime.restore(f.ctx, f.run); const restored = f.runtime.capture(f.ctx, f.run);
		assert.equal(restored.evidence.some((item) => item.path === "canon/after.md"), true);
		assert.equal(restored.evidence.some((item) => item.path === "canon/before.md" || item.path === "canon/foreign.md"), false);
	});

	await runCase("checkpoint-runtime-harvests-legacy-raw-ref-as-neutral", () => {
		const f = fixture();
		f.branch.splice(0, f.branch.length, { type: "message", message: { role: "toolResult", details: { observedRun: scope, observation: { sourceRefs: [{ path: "drafts/legacy.md", sha256: hash("legacy"), startLine: 1, endLine: 2, authority: "unclassified", temporal: "old" }] } } } });
		f.runtime.restore(f.ctx, f.run); const checkpoint = f.runtime.capture(f.ctx, f.run);
		const legacy = checkpoint.evidence.find((item) => item.path === "drafts/legacy.md");
		assert.deepEqual({ authority: legacy?.authority, temporal: legacy?.temporal }, { authority: "reference", temporal: "unspecified" });
	});

	await runCase("checkpoint-runtime-artifact-refresh-accepts-fresh-ranged-raw-read", async () => {
		const f = fixture(); f.runtime.operation(f.ctx, f.run, operation()); f.runtime.operation(f.ctx, f.run, operation({ state: "completed", dispatched: true }), hash("post"));
		f.current.set("drafts/a.md", { sha256: hash("changed"), authority: "reference", temporal: "unspecified", eligible: true });
		assert.equal((await f.runtime.inspect(f.ctx, f.run)).status, "needs_revalidation");
		f.current.set("drafts/a.md", { sha256: hash("post"), authority: "reference", temporal: "unspecified", eligible: true });
		f.runtime.observe(f.ctx, f.run, [{ path: "drafts/a.md", sha256: hash("post"), startLine: 1, endLine: 1, authority: "reference", temporal: "unspecified" }]);
		assert.notEqual((await f.runtime.refresh(f.ctx, f.run)).status, "needs_revalidation");
		assert.equal(f.runtime.capture(f.ctx, f.run).artifacts[0]?.startLine, undefined, "artifact identity remains whole-file");
	});

	await runCase("checkpoint-runtime-ordinary-expanded-range-refreshes-to-sha2", async () => {
		const f = fixture(); const old = ref({ path: "canon/chapter.md", startLine: 2, endLine: 4 });
		f.runtime.observe(f.ctx, f.run, [old]); f.runtime.capture(f.ctx, f.run);
		f.current.set("canon/chapter.md", { sha256: hash("sha2"), authority: "canonical", temporal: "current", eligible: true });
		assert.equal((await f.runtime.inspect(f.ctx, f.run)).status, "needs_revalidation");
		f.runtime.observe(f.ctx, f.run, [ref({ path: "canon/chapter.md", sha256: hash("sha2"), startLine: 1, endLine: 8 })]);
		assert.notEqual((await f.runtime.refresh(f.ctx, f.run)).status, "needs_revalidation");
		const updated = f.runtime.capture(f.ctx, f.run).evidence.find((item) => item.path === "canon/chapter.md");
		assert.deepEqual({ sha256: updated?.sha256, start: updated?.startLine, end: updated?.endLine, authority: updated?.authority }, { sha256: hash("sha2"), start: 1, end: 8, authority: "canonical" });
	});

	await runCase("checkpoint-runtime-artifact-external-sha2-keeps-neutral-whole-file", async () => {
		const f = fixture(); f.runtime.operation(f.ctx, f.run, operation()); f.runtime.operation(f.ctx, f.run, operation({ state: "completed", dispatched: true }), hash("post"));
		f.current.set("drafts/a.md", { sha256: hash("external-sha2"), authority: "reference", temporal: "unspecified", eligible: true });
		assert.equal((await f.runtime.inspect(f.ctx, f.run)).status, "needs_revalidation");
		f.runtime.observe(f.ctx, f.run, [{ path: "drafts/a.md", sha256: hash("external-sha2"), startLine: 1, endLine: 3, authority: "reference", temporal: "unspecified" }]);
		assert.notEqual((await f.runtime.refresh(f.ctx, f.run)).status, "needs_revalidation");
		const artifact = f.runtime.capture(f.ctx, f.run).artifacts[0];
		assert.deepEqual({ sha256: artifact?.sha256, start: artifact?.startLine, authority: artifact?.authority }, { sha256: hash("external-sha2"), start: undefined, authority: "reference" });
	});

	await runCase("checkpoint-runtime-read-reconciles-post-image-without-replay", async () => {
		const f = fixture(); f.runtime.operation(f.ctx, f.run, operation()); f.runtime.operation(f.ctx, f.run, operation({ dispatched: true }));
		f.current.set("drafts/a.md", { sha256: hash("post"), authority: "reference", temporal: "unspecified", eligible: true });
		const result = await f.runtime.writeGate(f.ctx, f.run, { operationId: "op-2", target: "drafts/a.md", toolName: "write", argsDigest: hash("args") });
		assert.match(result ?? "", /reconciled/);
		const latest = f.runtime.capture(f.ctx, f.run);
		assert.equal(latest.pendingOperations[0]?.state, "completed");
		assert.equal(latest.artifacts[0]?.sha256, hash("post"));
	});

	await runCase("checkpoint-runtime-stale-async-run-cannot-commit", async () => {
		const f = fixture(); f.runtime.observe(f.ctx, f.run, [ref()]); f.runtime.capture(f.ctx, f.run); f.deactivate();
		await assert.rejects(f.runtime.inspect(f.ctx, f.run), /stale run/);
	});

	await runCase("checkpoint-runtime-completed-history-rechecks-current-post-image", async () => {
		for (const restored of [false, true]) for (const reuseId of [false, true]) {
			const f = fixture(), op = operation();
			f.runtime.operation(f.ctx, f.run, op);
			f.runtime.operation(f.ctx, f.run, { ...op, state: "completed", dispatched: true }, hash("post"));
			const intent = { ...op, operationId: reuseId ? op.operationId : "new-id" };
			assert.match((await f.runtime.writeGate(f.ctx, f.run, intent)) ?? "", /satisfied/);
			f.current.set(op.target, { sha256: hash("external"), authority: "reference", temporal: "unspecified" });
			assert.equal((await f.runtime.inspect(f.ctx, f.run)).status, "needs_revalidation");
			f.runtime.observe(f.ctx, f.run, [{ path: op.target, sha256: hash("external"), authority: "reference", temporal: "unspecified" }]);
			assert.equal((await f.runtime.refresh(f.ctx, f.run)).status, "ready");
			if (restored) f.runtime.restore(f.ctx, f.run);
			const result = await f.runtime.writeGate(f.ctx, f.run, intent);
			assert.match(result ?? "", /post_state_conflict/); assert.doesNotMatch(result ?? "", /satisfied|已满足/);
			const cp = f.runtime.capture(f.ctx, f.run);
			assert.equal(cp.pendingOperations.length, 1); assert.equal(cp.pendingOperations[0]!.state, "completed");
			assert.equal(cp.pendingOperations[0]!.expectedPostHash, hash("post"));
			assert.equal(cp.artifacts[0]!.sha256, hash("external"));
			assert.equal(await f.runtime.writeGate(f.ctx, f.run, { ...intent, operationId: "corrected", argsDigest: hash("new-intent") }), null);
		}
	});

	await runCase("checkpoint-runtime-terminal-or-unverifiable-is-not-satisfied", async () => {
		for (const state of ["cancelled", "failed", "completed"] as const) {
			const f = fixture(), op = operation({ expectedPostHash: state === "completed" ? null : hash("post") });
			f.runtime.operation(f.ctx, f.run, op);
			f.runtime.operation(f.ctx, f.run, { ...op, state, dispatched: state !== "cancelled" });
			f.runtime.restore(f.ctx, f.run);
			const reason = await f.runtime.writeGate(f.ctx, f.run, op);
			assert.match(reason ?? "", state === "completed" ? /post_state_unverifiable/ : new RegExp(`operation_${state}`));
			assert.doesNotMatch(reason ?? "", /satisfied|已满足/);
			assert.equal(f.runtime.capture(f.ctx, f.run).pendingOperations[0]!.state, state);
			if (state === "failed") assert.match((await f.runtime.writeGate(f.ctx, f.run, { ...op, operationId: "retry" })) ?? "", /operation_failed/);
		}
	});

	await runCase("checkpoint-runtime-id-collision-and-undispatched-intent-stay-blocked", async () => {
		const f = fixture(), op = operation();
		f.runtime.operation(f.ctx, f.run, op);
		assert.match((await f.runtime.writeGate(f.ctx, f.run, op)) ?? "", /unknown_outcome/);
		assert.equal(f.runtime.capture(f.ctx, f.run).pendingOperations[0]!.state, "issued");
		f.runtime.operation(f.ctx, f.run, { ...op, state: "completed", dispatched: true }, hash("post"));
		assert.match((await f.runtime.writeGate(f.ctx, f.run, { ...op, argsDigest: hash("collision") })) ?? "", /operation_id_collision/);
	});
}
