import assert from "node:assert/strict";
import { createCheckpointStore, type CheckpointInput, type TaskCheckpoint } from "../../src/harness/checkpoint-store.js";
import type { RunScope } from "../../src/harness/types.js";
import type { RunCase } from "./testkit.js";

const digest = (text: string): string => {
	let value = 2166136261;
	for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
	return (value >>> 0).toString(16).padStart(8, "0");
};
const scope = (patch: Partial<RunScope> = {}): RunScope => ({ projectId: "project-a", sessionId: "session-a", role: "write", runId: "run-1", generation: 1, ...patch });
const ref = (patch: Record<string, unknown> = {}) => ({ path: "canon/world.md", sha256: "a".repeat(64), authority: "canonical", temporal: "current", ...patch });
const input = (patch: Partial<CheckpointInput> = {}): CheckpointInput => ({
	scope: scope(), objective: "Continue the accepted chapter", hardConstraints: ["Do not edit canon"], evidence: [ref()], observationIds: ["obs_1"], artifacts: [ref({ path: "drafts/001.md", authority: "draft" })],
	unresolvedIssues: [{ code: "needs-review", message: "Ending is not accepted" }], allowedNextActions: ["Read the latest review"],
	pendingOperations: [{ operationId: "op_1", toolName: "write", target: "drafts/001.md", preHash: null, expectedPostHash: "b".repeat(64), argsDigest: "c".repeat(64), state: "issued", dispatched: false }],
	budget: { readUsed: 2, outputUsed: 3, requestEstimate: null }, cause: "manual", ...patch,
});
const entry = (checkpoint: TaskCheckpoint) => ({ type: "custom", customType: "pi-desktop-task-checkpoint", data: checkpoint });

export function runCheckpointStoreTests(): void {
	const store = createCheckpointStore({ digest });
	const first = store.build(input());
	assert.match(first.id, /^cp_[0-9a-f]+$/); assert.equal(first.schemaVersion, 1);
	const parsed = store.parse(JSON.parse(JSON.stringify(first))); assert.deepEqual(parsed, first); assert.notEqual(parsed, first);
	const delivered = store.build(input({ evidenceFormat: "delivered-v1" } as Partial<CheckpointInput>));
	assert.equal((store.parse(delivered) as any).evidenceFormat, "delivered-v1");
	assert.equal((store.parse(first) as any).evidenceFormat, undefined, "legacy checkpoints retain their exact original digest and lack of receipt provenance");
	assert.throws(() => store.build(input({ evidenceFormat: "future-format" } as any)), /evidenceFormat/);
	const mutable = input(); const built = store.build(mutable); mutable.hardConstraints[0] = "changed"; mutable.evidence[0]!.path = "changed.md"; assert.equal(built.hardConstraints[0], "Do not edit canon"); assert.equal(built.evidence[0]!.path, "canon/world.md");
	(parsed.scope as RunScope).projectId = "mutated"; parsed.evidence[0]!.path = "mutated.md"; assert.equal(store.parse(first).scope.projectId, "project-a"); assert.equal(store.parse(first).evidence[0]!.path, "canon/world.md");

	const second = store.build(input({ scope: scope({ runId: "run-2", generation: 2 }), objective: "newer", parentId: first.id, cause: "after_compact" }));
	const third = store.build(input({ scope: scope({ runId: "run-3", generation: 3 }), objective: "newest", hardConstraints: second.hardConstraints, parentId: second.id, cause: "refresh" }));
	assert.deepEqual(third.hardConstraints, first.hardConstraints, "exact user constraints survive repeated build/parse cycles");
	assert.equal(store.latest([entry(first), { type: "assistant", data: {} }, entry(second)], scope({ runId: "current", generation: 99 }))?.id, second.id);
	for (const foreign of [scope({ projectId: "project-b" }), scope({ sessionId: "session-b" }), scope({ role: "planning" })]) assert.equal(store.latest([entry(first)], foreign), null);
	assert.equal(store.latest([{ type: "custom", customType: "other", data: { huge: "ignored" } }, entry(first)], scope())?.id, first.id);

	const tampered = JSON.parse(JSON.stringify(second)); tampered.objective = "tampered";
	assert.throws(() => store.parse(tampered), /integrity/i);
	assert.throws(() => store.latest([entry(first), entry(tampered)], scope()), /integrity/i, "malformed newest matching checkpoint must fail closed");
	assert.throws(() => store.parse({ ...first, schemaVersion: 2 }), /schemaVersion/);
	assert.throws(() => store.parse({ ...first, unknown: true }), /unexpected/);
	assert.throws(() => createCheckpointStore({ digest, maxEntries: 1 }).latest([{}, {}], scope()), /maxEntries/);
	assert.throws(() => store.build(input({ evidence: Array.from({ length: 129 }, (_, i) => ref({ path: `canon/${i}.md` })) })), /evidence/);
	assert.throws(() => store.build(input({ hardConstraints: Array.from({ length: 257 }, (_, i) => `constraint ${i}`) })), /hardConstraints/);
	assert.throws(() => store.build(input({ objective: "x".repeat(16_385) })), /objective/);
	assert.throws(() => createCheckpointStore({ digest, maxBytes: 200 }).build(input()), /maxBytes/);
	for (const path of ["../canon.md", "/canon.md", "C:/canon.md", "canon\\world.md", "con/file.md", "canon//world.md"]) {
		assert.throws(() => store.build(input({ evidence: [ref({ path })] })), /path|safe|canonical/);
		assert.throws(() => store.build(input({ pendingOperations: [{ ...input().pendingOperations[0]!, target: path }] })), /target|safe|canonical/);
	}
	assert.throws(() => store.build(input({ evidence: [ref({ authority: "x".repeat(257) })] })), /authority/);
	assert.throws(() => store.build(input({ pendingOperations: [{ ...input().pendingOperations[0]!, preHash: "bad" }] })), /preHash/);
	assert.throws(() => store.build(input({ pendingOperations: [{ ...input().pendingOperations[0]!, argsDigest: "bad" }] })), /argsDigest/);
	assert.throws(() => store.build(input({ pendingOperations: [{ ...input().pendingOperations[0]!, state: "prepared" }] })), /state/);
	assert.throws(() => store.latest([{ type: "custom", customType: "pi-desktop-task-checkpoint", data: null }], scope()), /data/);
	assert.throws(() => store.latest([{ type: "custom", customType: "pi-desktop-task-checkpoint", data: { scope: null } }], scope()), /scope/);
	assert.throws(() => store.latest([{ type: "custom", customType: "pi-desktop-task-checkpoint", data: { scope: { projectId: "project-b" } } }], scope()), /scope/);

	const factoryText = createCheckpointStore.toString();
	assert.ok(!factoryText.includes("RunScope") && !factoryText.includes("SourceVersionRef"));
	for (const text of [factoryText, factoryText.replace(/\n\s*/g, "")]) {
		const standalone = Function(`"use strict";return(${text});`)() as typeof createCheckpointStore;
		const fresh = standalone({ digest }); const restored = fresh.parse(JSON.parse(JSON.stringify(first))); assert.equal(restored.id, first.id);
	}
}

export async function runCheckpointStoreCases(runCase: RunCase): Promise<void> {
	await runCase("P3-CP durable bounded checkpoint store", () => { runCheckpointStoreTests(); });
}
