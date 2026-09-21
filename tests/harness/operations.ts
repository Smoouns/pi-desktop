import assert from "node:assert/strict";
import { createOperationLedger, type OperationIntent } from "../../src/harness/operation-ledger.js";
import type { RunCase } from "./testkit.js";

const scope = { projectId: "project-a", sessionId: "session-a", runId: "run-a", generation: 1, role: "drafting" };
const intent = (overrides: Partial<OperationIntent> = {}): OperationIntent => ({
	scope,
	toolCallId: "call-1",
	toolName: "write",
	target: "drafts\\candidates/./017.md",
	preHash: "before",
	expectedPostHash: "after",
	argsDigest: "args-a",
	...overrides,
});

export async function runOperationCases(runCase: RunCase): Promise<void> {
	await runCase("operations.missing-result-reconciles", (record) => {
		const ledger = createOperationLedger();
		assert.equal(ledger.prepare(intent(), "before").action, "dispatch");
		ledger.markDispatched("call-1");
		const satisfied = ledger.prepare(intent({ target: "drafts/candidates/017.md" }), "after");
		assert.deepEqual(satisfied, { action: "satisfied", operationId: "call-1", state: "completed", reason: "expected-post-state-observed" });
		assert.equal(ledger.snapshot()[0]?.target, "drafts/candidates/017.md");
		record("operation.reconciled", { state: satisfied.state });
	});

	await runCase("operations.new-id-same-intent-reconciles-across-run", () => {
		const ledger = createOperationLedger();
		ledger.prepare(intent(), "before");
		ledger.markDispatched("call-1");
		const retried = intent({
			toolCallId: "call-2",
			preHash: "after",
			scope: { ...scope, runId: "run-b", generation: 2 },
		});
		const decision = ledger.prepare(retried, "after");
		assert.equal(decision.action, "satisfied");
		assert.equal(decision.operationId, "call-2");
		assert.equal(ledger.snapshot().length, 2);
	});

	await runCase("operations.new-id-different-write-waits-for-prior-target", () => {
		const ledger = createOperationLedger();
		ledger.prepare(intent(), "before");
		ledger.markDispatched("call-1");
		const competing = intent({ toolCallId: "call-2", argsDigest: "args-b", expectedPostHash: "other", preHash: "before" });
		assert.equal(ledger.prepare(competing, "before").reason, "prior-target-operation-unresolved");
		assert.equal(ledger.prepare(competing, "concurrent").reason, "prior-target-operation-unresolved");
	});

	await runCase("operations.unknown-never-replays", () => {
		const ledger = createOperationLedger();
		ledger.prepare(intent(), "before");
		const duplicate = ledger.prepare(intent(), "before");
		assert.equal(duplicate.action, "blocked");
		assert.equal(duplicate.state, "issued", "An undispatched duplicate is in flight, not a replay opportunity");
		ledger.markDispatched("call-1");
		const conflict = ledger.prepare(intent(), "concurrent-change");
		assert.equal(conflict.action, "blocked");
		assert.equal(conflict.state, "unknown");
		assert.equal(ledger.prepare(intent(), "before").action, "blocked");
	});

	await runCase("operations.pre-state-conflict-blocks-dispatch", () => {
		const ledger = createOperationLedger();
		const decision = ledger.prepare(intent(), "already-changed");
		assert.equal(decision.action, "blocked");
		assert.equal(decision.state, "unknown");
		assert.equal(decision.reason, "pre-state-conflict");
		assert.equal(ledger.prepare(intent(), "before").action, "blocked", "A conflicted operation ID is not reusable");
	});

	await runCase("operations.scope-and-args-collisions", () => {
		const ledger = createOperationLedger();
		ledger.prepare(intent(), "before");
		assert.equal(ledger.prepare(intent({ argsDigest: "args-b" }), "before").action, "blocked");
		assert.equal(ledger.prepare(intent({ scope: { ...scope, role: "planning" } }), "before").action, "blocked");
		assert.equal(ledger.prepare(intent({ scope: { ...scope, projectId: "project-b", runId: "run-b" } }), "before").action, "blocked");
		assert.equal(ledger.snapshot().length, 1);
	});

	await runCase("operations.success-is-not-reused-across-authority-scope", () => {
		for (const changedScope of [
			{ ...scope, role: "planning" },
			{ ...scope, projectId: "project-b" },
			{ ...scope, sessionId: "session-b" },
		]) {
			const ledger = createOperationLedger();
			ledger.prepare(intent(), "before");
			ledger.markDispatched("call-1");
			ledger.complete("call-1", "after");
			const separate = intent({ toolCallId: "call-2", scope: changedScope, preHash: "after" });
			assert.equal(ledger.prepare(separate, "after").action, "dispatch");
		}
	});

	await runCase("operations.same-id-replay-ignores-new-observation-only", () => {
		const ledger = createOperationLedger();
		ledger.prepare(intent(), "before");
		ledger.markDispatched("call-1");
		assert.equal(ledger.prepare(intent({ preHash: "after" }), "after").action, "satisfied");
		assert.equal(ledger.prepare(intent({ preHash: "after", expectedPostHash: "different" }), "after").reason, "operation-id-collision");
	});

	await runCase("operations.completion-requires-expected-state", () => {
		const ledger = createOperationLedger();
		ledger.prepare(intent(), "before");
		ledger.markDispatched("call-1");
		assert.equal(ledger.complete("call-1", "wrong").state, "unknown");
		assert.equal(ledger.prepare(intent(), "after").action, "satisfied");
		// A matching hash proves target satisfaction, not globally exactly-once execution.
		assert.equal(ledger.snapshot()[0]?.state, "completed");
	});

	await runCase("operations.acknowledged-fuzzy-edit-reconciles", () => {
		const ledger = createOperationLedger();
		const fuzzy = intent({ toolName: "edit", expectedPostHash: null, argsDigest: "fuzzy-a" });
		ledger.prepare(fuzzy, "before");
		ledger.markDispatched("call-1");
		assert.equal(ledger.completeAcknowledged("call-1", "observed-after").action, "satisfied");
		const replay = intent({ toolCallId: "call-2", toolName: "edit", preHash: "observed-after", expectedPostHash: null, argsDigest: "fuzzy-a" });
		assert.equal(ledger.prepare(replay, "observed-after").action, "satisfied");
	});

	await runCase("operations.explicit-failure-no-change-requires-repair", () => {
		const ledger = createOperationLedger();
		ledger.prepare(intent(), "before");
		ledger.markDispatched("call-1");
		const failed = ledger.completeFailed("call-1", "before");
		assert.deepEqual(failed, { action: "blocked", operationId: "call-1", state: "failed", reason: "confirmed-failure-no-change" });
		assert.equal(ledger.prepare(intent({ toolCallId: "call-2" }), "before").reason, "repair-required");
		const repaired = ledger.prepare(intent({ toolCallId: "call-3", argsDigest: "args-repaired", expectedPostHash: "after-repair" }), "before");
		assert.equal(repaired.action, "dispatch");
	});

	await runCase("operations.failed-callback-reconciles-post-or-conflict", () => {
		const applied = createOperationLedger();
		applied.prepare(intent(), "before");
		applied.markDispatched("call-1");
		assert.equal(applied.completeFailed("call-1", "after").action, "satisfied", "A failed callback can arrive after the mutation committed");

		const conflict = createOperationLedger();
		conflict.prepare(intent(), "before");
		conflict.markDispatched("call-1");
		assert.equal(conflict.completeFailed("call-1", "concurrent").state, "unknown");
		assert.equal(conflict.prepare(intent({ toolCallId: "call-2", argsDigest: "changed" }), "concurrent").reason, "prior-target-operation-unresolved");
	});

	await runCase("operations.unknown-result-unchanged-is-not-known-failure", () => {
		const ledger = createOperationLedger();
		ledger.prepare(intent(), "before");
		ledger.markDispatched("call-1");
		assert.equal(ledger.prepare(intent({ toolCallId: "call-2", argsDigest: "changed" }), "before").reason, "prior-target-operation-unresolved");
		assert.equal(ledger.snapshot()[0]?.state, "issued");
	});

	await runCase("operations.write-edit-cannot-bypass-target-conflict", () => {
		const ledger = createOperationLedger();
		ledger.prepare(intent({ toolName: "write" }), "before");
		ledger.markDispatched("call-1");
		const edit = intent({ toolCallId: "call-2", toolName: "edit", argsDigest: "edit-a", expectedPostHash: null });
		assert.equal(ledger.prepare(edit, "before").reason, "prior-target-operation-unresolved");
	});

	await runCase("operations.cancellation-boundary", () => {
		const before = createOperationLedger();
		before.prepare(intent(), "before");
		assert.equal(before.cancel("call-1").state, "cancelled");
		assert.equal(before.prepare(intent(), "before").action, "dispatch", "Cancellation before dispatch may be retried");
		const changed = createOperationLedger();
		changed.prepare(intent(), "before");
		changed.cancel("call-1");
		assert.equal(changed.prepare(intent(), "changed").action, "blocked", "Even a pre-dispatch retry rechecks its pre-state");

		const after = createOperationLedger();
		after.prepare(intent(), "before");
		after.markDispatched("call-1");
		assert.equal(after.cancel("call-1").state, "unknown");
		assert.equal(after.prepare(intent(), "before").action, "blocked", "Cancellation after dispatch must not replay blindly");
	});

	await runCase("operations.capacity-fails-closed", () => {
		const ledger = createOperationLedger({ maxEntries: 1 });
		ledger.prepare(intent(), "before");
		const blocked = ledger.prepare(intent({ toolCallId: "call-2", target: "drafts/018.md" }), "before");
		assert.equal(blocked.action, "blocked");
		assert.equal(blocked.reason, "ledger-capacity");
		assert.equal(ledger.snapshot()[0]?.operationId, "call-1");
	});

	await runCase("operations.capacity-retains-terminal-id-tombstones", () => {
		const ledger = createOperationLedger({ maxEntries: 1 });
		ledger.prepare(intent(), "before");
		ledger.markDispatched("call-1");
		ledger.complete("call-1", "after");
		assert.equal(ledger.prepare(intent({ toolCallId: "call-2", target: "drafts/018.md", preHash: "x", expectedPostHash: "y" }), "x").reason, "ledger-capacity");
		assert.equal(ledger.prepare(intent({ argsDigest: "changed" }), "after").reason, "operation-id-collision");
	});

	await runCase("operations.factory-is-embeddable", () => {
		const source = `(${createOperationLedger.toString()})({ maxEntries: 2 })`;
		const embedded = Function(`return ${source}`)() as ReturnType<typeof createOperationLedger>;
		assert.equal(embedded.prepare(intent(), "before").action, "dispatch");
	});
}
