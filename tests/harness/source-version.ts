import assert from "node:assert/strict";
import { createCheckpointInvalidation } from "../../src/harness/invalidation.js";
import { createSourceVersioning, type SourceVersionRef } from "../../src/harness/source-version.js";
import type { RunCase } from "./testkit.js";

const digest = (character = "a"): string => character.repeat(64);
const source = (patch: Partial<SourceVersionRef> = {}): SourceVersionRef => ({
	path: "canon/world.md", sha256: digest(), authority: "canonical", temporal: "current", memoryId: "memory-1", ...patch,
});

export async function runSourceVersionCases(runCase: RunCase): Promise<void> {
	await runCase("source-version.normalizes-and-keys-complete-identity", () => {
		const versions = createSourceVersioning();
		const normalized = versions.normalize({ path: "canon/世界.md", sha256: digest("A"), startLine: 2, endLine: 4, authority: " canonical ", temporal: " current ", memoryId: " memory-1 " });
		assert.deepEqual(normalized, { path: "canon/世界.md", sha256: digest(), startLine: 2, endLine: 4, authority: "canonical", temporal: "current", memoryId: "memory-1" });
		assert.notEqual(versions.key(normalized), versions.key({ ...normalized, memoryId: "memory-2" }));
	});

	await runCase("source-version.rejects-unsafe-or-unbounded-input", () => {
		const versions = createSourceVersioning();
		for (const path of ["", " ../x", "../x", "/x", "C:/x", "//server/x", "a\\b", "a//b", "a/./b", "a/../b", "a:x", "a?.md", "a\0b", "file. ", "CON", "dir/LPT9.txt", "https://example.test/x"])
			assert.throws(() => versions.normalize({ path, sha256: digest() }), TypeError, path);
		assert.throws(() => versions.normalize({ path: "a.md", sha256: "x" }), TypeError);
		assert.throws(() => versions.normalize({ path: "a.md", sha256: digest(), startLine: 1 }), TypeError);
		assert.throws(() => versions.normalize({ path: "a.md", sha256: digest(), startLine: 3, endLine: 2 }), TypeError);
		assert.throws(() => versions.normalize({ path: "a.md", sha256: digest(), authority: "x".repeat(257) }), TypeError);
	});

	await runCase("source-version.revalidates-bytes-and-metadata-without-mutation", async () => {
		const versions = createSourceVersioning();
		const original = source();
		const valid = await versions.revalidate([original], async () => ({ sha256: digest(), authority: "canonical", temporal: "current", memoryId: "memory-1", eligible: true }));
		assert.equal(valid.valid, true);
		assert.equal(valid.checks[0]?.status, "valid");
		valid.checks[0]!.ref.path = "mutated.md";
		assert.equal(original.path, "canon/world.md");
		const changed = await versions.revalidate([original], async () => ({ sha256: digest("b"), authority: "canonical", temporal: "current", memoryId: "memory-1", eligible: true }));
		assert.equal(changed.checks[0]?.status, "changed");
		const authority = await versions.revalidate([original], async () => ({ sha256: digest(), authority: "draft", temporal: "current", memoryId: "memory-1", eligible: true }));
		assert.equal(authority.checks[0]?.status, "changed");
		const temporal = await versions.revalidate([original], async () => ({ sha256: digest(), authority: "canonical", temporal: "past", memoryId: "memory-1", eligible: true }));
		assert.equal(temporal.checks[0]?.status, "changed");
		const acceptance = await versions.revalidate([original], async () => ({ sha256: digest(), authority: "canonical", temporal: "current", memoryId: "memory-2", eligible: true }));
		assert.equal(acceptance.checks[0]?.status, "changed");
	});

	await runCase("source-version.deletion-ineligibility-unavailable-and-rollback", async () => {
		const versions = createSourceVersioning();
		assert.equal((await versions.revalidate([source()], async () => ({ sha256: null }))).checks[0]?.status, "missing");
		assert.equal((await versions.revalidate([source()], async () => ({ sha256: digest(), eligible: false }))).checks[0]?.status, "ineligible");
		assert.equal((await versions.revalidate([source({ authority: "unclassified" })], async () => ({ sha256: digest(), authority: "unclassified", eligible: true }))).checks[0]?.status, "ineligible");
		assert.equal((await versions.revalidate([source({ authority: undefined })], async () => ({ sha256: digest(), authority: "unclassified", eligible: true }))).checks[0]?.status, "ineligible", "resolver classification cannot promote unclassified material");
		assert.equal((await versions.revalidate([source()], async () => { throw new Error("read failed"); })).checks[0]?.status, "unavailable");
		assert.equal((await versions.revalidate([source()], async () => ({ sha256: digest("b"), eligible: true }))).valid, false);
		assert.equal((await versions.revalidate([source()], async () => ({ sha256: digest(), authority: "canonical", temporal: "current", memoryId: "memory-1", eligible: true }))).valid, true, "same bytes may validate later without sticky state");
	});

	await runCase("source-version.capacity-isolation-cancellation-and-embedding", async () => {
		const versions = createSourceVersioning();
		await assert.rejects(versions.revalidate(Array.from({ length: 129 }, (_, index) => source({ path: `canon/${index}.md` })), async () => ({ sha256: digest() })), TypeError);
		const controller = new AbortController(); controller.abort();
		await assert.rejects(versions.revalidate([source()], async () => ({ sha256: digest() }), controller.signal), (error: unknown) => error instanceof Error && error.name === "AbortError");
		const embedded = Function(`return (${createSourceVersioning.toString()})()`)() as ReturnType<typeof createSourceVersioning>;
		assert.equal(embedded.normalize(source()).path, "canon/world.md");
	});
}

export async function runInvalidationCases(runCase: RunCase): Promise<void> {
	await runCase("invalidation.ready-needs-revalidation-and-blocked", () => {
		const invalidation = createCheckpointInvalidation();
		const valid = { ref: source(), status: "valid" as const, reason: "current" };
		assert.deepEqual(invalidation.evaluate({ scopeMatches: true, sources: [valid], pendingOperations: [] }), { status: "ready", invalidPaths: [], blockedOperationIds: [], allowedToWrite: true });
		const stale = invalidation.evaluate({ scopeMatches: true, sources: [{ ...valid, status: "changed", reason: "digest changed" }], pendingOperations: [] });
		assert.deepEqual(stale, { status: "needs_revalidation", invalidPaths: ["canon/world.md"], blockedOperationIds: [], allowedToWrite: false });
		const blocked = invalidation.evaluate({ scopeMatches: false, sources: [valid], pendingOperations: [{ operationId: "op-1", state: "dispatched" }] });
		assert.deepEqual(blocked, { status: "blocked", invalidPaths: [], blockedOperationIds: ["op-1"], allowedToWrite: false });
	});

	await runCase("invalidation.artifacts-operations-fresh-results-and-embedding", () => {
		const invalidation = createCheckpointInvalidation();
		const valid = { ref: source(), status: "valid" as const, reason: "current" };
		for (const state of ["unknown", "issued", "dispatched", "mystery"])
			assert.equal(invalidation.evaluate({ scopeMatches: true, sources: [valid], pendingOperations: [{ operationId: `op-${state}`, state }] }).status, "blocked");
		assert.equal(invalidation.evaluate({ scopeMatches: true, sources: [valid], pendingOperations: [{ operationId: "op-done", state: "completed" }] }).status, "ready");
		const first = invalidation.evaluate({ scopeMatches: true, sources: [valid], artifactChecks: [{ ref: source({ path: "drafts/017.md" }), status: "missing", reason: "deleted" }], pendingOperations: [] });
		assert.deepEqual(first.invalidPaths, ["drafts/017.md"]);
		first.invalidPaths.push("mutation");
		assert.deepEqual(invalidation.evaluate({ scopeMatches: true, sources: [valid], pendingOperations: [] }).invalidPaths, []);
		const embedded = Function(`return (${createCheckpointInvalidation.toString()})()`)() as ReturnType<typeof createCheckpointInvalidation>;
		assert.equal(embedded.evaluate({ scopeMatches: true, sources: [valid], pendingOperations: [] }).allowedToWrite, true);
	});
}
