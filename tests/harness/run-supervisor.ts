import assert from "node:assert/strict";
import { createRunSupervisor, type RunSupervisorSnapshot } from "../../src/harness/run-supervisor.js";
import type { RunScope } from "../../src/harness/types.js";
import type { RunCase } from "./testkit.js";

const digest = (text: string): string => {
	let value = 2166136261;
	for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
	return (value >>> 0).toString(16).padStart(8, "0");
};
const scope = (patch: Partial<RunScope> = {}): RunScope => ({ projectId: "project-a", sessionId: "session-a", runId: "run-a", generation: 1, role: "write", ...patch });
const sha = (character: string): string => character.repeat(64);

export async function runSupervisorCases(runCase: RunCase): Promise<void> {
	await runCase("P4-SUP-01 supervisor is scoped, immutable and tool-gated", () => {
		const supervisor = createRunSupervisor({ digest });
		const own = scope(); const foreign = scope({ generation: 2 });
		const begun = supervisor.begin(own);
		assert.equal(begun.state, "RUNNING");
		assert.equal(supervisor.tool(foreign, "late", "write").allowed, false, "late foreign generations are ignored");
		assert.equal(supervisor.snapshot(foreign), null);
		assert.equal(supervisor.tool(own, "call-1", "read").allowed, true);
		assert.equal(supervisor.tool(own, "call-1", "read").snapshot?.toolCalls, 1, "duplicate dispatch IDs are idempotent");
		assert.ok(Object.isFrozen(supervisor.snapshot(own)));
		assert.throws(() => { (supervisor.snapshot(own) as { state: string }).state = "FAILED"; });
		supervisor.stop(own, "BLOCKED_USER", "USER_ACTION_REQUIRED");
		assert.equal(supervisor.tool(own, "call-2", "write").allowed, false, "non-running states never dispatch tools");
		assert.equal(supervisor.stop(own, "FAILED", "OVERWRITE")?.state, "BLOCKED_USER", "terminal states cannot be overwritten");
		assert.throws(() => createRunSupervisor({ digest, maxToolCalls: 4097 }), /bounded/);
		assert.throws(() => { const item = createRunSupervisor({ digest }); const itemScope = scope({ runId: "unsafe-path" }); item.begin(itemScope); item.artifact(itemScope, "../escape.md", sha("a")); }, /project-relative/);
	});

	await runCase("P4-SUP-02 deterministic no-progress needs unchanged artifact, error and evidence", () => {
		const supervisor = createRunSupervisor({ digest, noProgressLimit: 3 }); const own = scope(); supervisor.begin(own);
		supervisor.evidence(own, "obs-a"); supervisor.artifact(own, "drafts/018.md", sha("a"));
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			const result = supervisor.verification(own, { callId: `verify-${attempt}`, subject: "018", artifactSha256: sha("a"), errorDigest: "same-error", passed: false, full: true });
			assert.equal(result?.state, "RUNNING");
		}
		supervisor.evidence(own, "obs-b");
		assert.equal(supervisor.verification(own, { callId: "verify-3", subject: "018", artifactSha256: sha("a"), errorDigest: "same-error", passed: false, full: true })?.unchangedAttempts, 1, "new evidence resets the streak");
		supervisor.artifact(own, "drafts/018.md", sha("b"));
		assert.equal(supervisor.verification(own, { callId: "verify-4", subject: "018", artifactSha256: sha("b"), errorDigest: "same-error", passed: false, full: true })?.unchangedAttempts, 1, "real artifact change resets the streak");
		supervisor.verification(own, { callId: "verify-5", subject: "018", artifactSha256: sha("b"), errorDigest: "same-error", passed: false, full: true });
		const stopped = supervisor.verification(own, { callId: "verify-6", subject: "018", artifactSha256: sha("b"), errorDigest: "same-error", passed: false, full: true });
		assert.equal(stopped?.state, "NO_PROGRESS");
		assert.equal(stopped?.reasonCode, "UNCHANGED_VERIFICATION");
		assert.equal(supervisor.verification(own, { callId: "verify-6", subject: "018", artifactSha256: sha("b"), errorDigest: "same-error", passed: false, full: true })?.verificationAttempts, 6, "duplicate results do not advance counters");
		const alternating = createRunSupervisor({ digest }); const alternatingScope = scope({ runId: "alternating" }); alternating.begin(alternatingScope);
		for (const [index, subject] of ["A", "B", "A"].entries()) assert.equal(alternating.verification(alternatingScope, { callId: `alt-${index}`, subject, artifactSha256: null, errorDigest: "same", passed: false, full: true })?.state, "RUNNING", "A-B-A is not consecutive no progress");
	});

	await runCase("P4-SUP-03 hard budgets stop changing-error loops", () => {
		const verify = createRunSupervisor({ digest, maxVerificationAttempts: 2 }); const a = scope({ runId: "verify-cap" }); verify.begin(a);
		verify.verification(a, { callId: "v1", subject: "x", artifactSha256: null, errorDigest: "one", passed: false, full: true });
		verify.verification(a, { callId: "v2", subject: "x", artifactSha256: null, errorDigest: "two", passed: false, full: true });
		assert.equal(verify.verification(a, { callId: "v3", subject: "x", artifactSha256: null, errorDigest: "three", passed: false, full: true })?.state, "FAILED");
		assert.equal(verify.snapshot(a)?.verificationAttempts, 2);

		const tools = createRunSupervisor({ digest, maxToolCalls: 1 }); const b = scope({ runId: "tool-cap" }); tools.begin(b);
		assert.equal(tools.tool(b, "t1", "read").allowed, true);
		assert.equal(tools.tool(b, "t2", "read").allowed, false); assert.equal(tools.snapshot(b)?.reasonCode, "MAX_TOOL_CALLS");
		const turns = createRunSupervisor({ digest, maxTurns: 1 }); const c = scope({ runId: "turn-cap" }); turns.begin(c);
		assert.equal(turns.turn(c)?.turns, 1); assert.equal(turns.turn(c)?.reasonCode, "MAX_TURNS");
	});

	await runCase("P4-SUP-04 failures route conservatively and repair loops are bounded", () => {
		for (const [kind, expected] of [["permission", "BLOCKED_USER"], ["precondition", "BLOCKED_PREREQUISITE"], ["unknown_outcome", "BLOCKED_PREREQUISITE"], ["fatal", "FAILED"], ["transient", "FAILED"], ["cancelled", "CANCELLED"]] as const) {
			const supervisor = createRunSupervisor({ digest }); const own = scope({ runId: kind }); supervisor.begin(own);
			assert.equal(supervisor.failure(own, { kind, code: kind })?.state, expected);
		}
		for (const kind of ["stale_source", "validation", "invalid_input"] as const) {
			const supervisor = createRunSupervisor({ digest }); const own = scope({ runId: kind }); supervisor.begin(own);
			for (let n = 1; n <= 2; n += 1) assert.equal(supervisor.failure(own, { kind, code: "REPAIR", signature: "same" })?.state, "RUNNING");
			assert.equal(supervisor.failure(own, { kind, code: "REPAIR", signature: "same" })?.state, "NO_PROGRESS");
		}
		const progress = createRunSupervisor({ digest }); const own = scope({ runId: "repair-reset" }); progress.begin(own);
		progress.failure(own, { kind: "validation", code: "REPAIR", signature: "same" }); progress.failure(own, { kind: "validation", code: "REPAIR", signature: "same" });
		progress.evidence(own, "new-source-version");
		assert.equal(progress.failure(own, { kind: "validation", code: "REPAIR", signature: "same" })?.state, "RUNNING", "real progress clears a repair loop streak");
		const alternating = createRunSupervisor({ digest }); const alternatingScope = scope({ runId: "repair-alternating" }); alternating.begin(alternatingScope);
		for (const signature of ["A", "B", "A", "B", "A"]) assert.equal(alternating.failure(alternatingScope, { kind: "validation", code: "REPAIR", signature })?.state, "RUNNING", "only adjacent identical repair failures form a streak");
	});

	await runCase("P4-SUP-05 completion is only a mechanically verified candidate", () => {
		const supervisor = createRunSupervisor({ digest }); const own = scope(); supervisor.begin(own);
		const incomplete = supervisor.finish(own, { stopReason: "stop", hasText: false, checkpointReady: true, pendingOperations: false, completionVerified: true });
		assert.equal(incomplete?.state, "FAILED"); assert.equal(incomplete?.reasonCode, "NO_FINAL_RESPONSE");
		const successful = createRunSupervisor({ digest }); const successScope = scope({ runId: "success" }); successful.begin(successScope);
		const candidate = successful.finish(successScope, { stopReason: "stop", hasText: true, checkpointReady: true, pendingOperations: false, completionVerified: true });
		assert.equal(candidate?.state, "COMPLETED_CANDIDATE"); assert.equal(candidate?.userAccepted, false);
		for (const [stopReason, state] of [["length", "BLOCKED_PREREQUISITE"], ["error", "FAILED"], ["aborted", "CANCELLED"]] as const) { const item = createRunSupervisor({ digest }); const itemScope = scope({ runId: stopReason }); item.begin(itemScope); assert.equal(item.finish(itemScope, { stopReason, hasText: true, checkpointReady: true, pendingOperations: false, completionVerified: true })?.state, state); }
	});

	await runCase("P4-SUP-06 persisted snapshots are bounded, integral and do not resume", () => {
		const supervisor = createRunSupervisor({ digest }); const own = scope(); const original = supervisor.begin(own);
		const parsed = supervisor.parse(JSON.parse(JSON.stringify(original)));
		assert.deepEqual(parsed, original); assert.notEqual(parsed, original);
		assert.equal(supervisor.snapshot(scope({ runId: "not-started" })), null, "parse must not install executable state");
		const resumed = createRunSupervisor({ digest }); resumed.restore(original, own);
		assert.equal(resumed.snapshot(own)?.id, original.id, "resume is explicit and scope fenced");
		assert.throws(() => createRunSupervisor({ digest }).restore(original, scope({ generation: 2 })), /scope mismatch/i);
		const tampered = JSON.parse(JSON.stringify(original)); tampered.turns = 99;
		assert.throws(() => supervisor.parse(tampered), /integrity|bounds/i);
		const inconsistent = JSON.parse(JSON.stringify(original)); inconsistent.evidenceCount = 1; inconsistent.id = `run_${digest(JSON.stringify({ ...inconsistent, id: undefined }))}`;
		assert.throws(() => supervisor.parse(inconsistent), /counter|integrity/i);
		assert.throws(() => supervisor.parse({ ...original, extra: true }), /unexpected/i);
		for (const subject of ["__proto__", "constructor", "prototype"]) {
			const guarded = createRunSupervisor({ digest }); const guardedScope = scope({ runId: `reserved-${subject}` }); const before = guarded.begin(guardedScope);
			assert.throws(() => guarded.verification(guardedScope, { callId: "reserved", subject, artifactSha256: null, errorDigest: "error", passed: false, full: true }), /reserved/);
			assert.equal(guarded.snapshot(guardedScope)?.id, before.id, "reserved subjects are rejected before mutation");
			assert.deepEqual(guarded.parse(guarded.snapshot(guardedScope)), before);
		}
		assert.throws(() => supervisor.parse("x".repeat(200_000)), /object|size|bytes/i);
		const rebuilt = Function(`return (${createRunSupervisor.toString()})`)() as typeof createRunSupervisor;
		assert.deepEqual(rebuilt({ digest }).parse(JSON.parse(JSON.stringify(original))), original);
	});
}

export function assertSupervisorSnapshot(_snapshot: RunSupervisorSnapshot): void { /* compile-time contract */ }
