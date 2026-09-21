import assert from "node:assert/strict";
import { createObservationStore, type ObservationSourceRef } from "../../src/harness/observation-store.js";
import type { RunScope } from "../../src/harness/types.js";

const scope = (patch: Partial<RunScope> = {}): RunScope => ({ projectId: "project-a", sessionId: "session-a", runId: "run-1", generation: 1, role: "planning", ...patch });
const source = (patch: Partial<ObservationSourceRef> = {}): ObservationSourceRef => ({ path: "canon/world.md", sha256: "a".repeat(64), startLine: 1, endLine: 10, authority: "canon", temporal: "current", memoryId: "memory-1", ...patch });
const expectKind = (body: () => unknown, expected: string): void => assert.throws(body, (error: unknown) => typeof error === "object" && error !== null && "kind" in error && (error as { kind: string }).kind === expected);

export function runObservationStoreTests(): void {
	const deterministicDigest = (text: string): string => Array.from(text).reduce((value, char) => (value * 33 + (char.codePointAt(0) ?? 0)) >>> 0, 5381).toString(16);
	{
		const store = createObservationStore({ digest: deterministicDigest });
		const first = store.put({ scope: scope(), toolName: "read", toolCallId: "call-1", text: "完整证据🙂", sources: [source()] });
		const again = store.put({ scope: scope({ runId: "run-2", generation: 9 }), toolName: "read_section", toolCallId: "call-2", text: "完整证据🙂", sources: [source()] });
		assert.equal(first.id, again.id);
		assert.deepEqual(store.stats(), { records: 1, accesses: 2, payloadBytes: 16, maxRecords: 512, maxAccesses: 4096, maxPayloadBytes: 8 * 1024 * 1024, maxSourceRefs: 32, maxFieldChars: 4096 });
		assert.equal(store.getAccesses(scope()).length, 2);
		const beforePeek = store.stats().accesses;
		assert.equal(store.peek({ id: first.id, scope: scope({ runId: "run-3" }) }).sourceRefs[0]!.memoryId, "memory-1");
		assert.equal(store.stats().accesses, beforePeek, "peek must not create an evidence access receipt");
		const read = store.read({ id: first.id, scope: scope({ runId: "run-3", generation: 10 }), start: 2, limit: 2, toolCallId: "read-1" });
		assert.equal(read.payload, "证据"); assert.equal(read.freshness, "unverified"); assert.equal(store.getAccesses(scope()).length, 3);
	}
	{
		const store = createObservationStore();
		const record = store.put({ scope: scope(), toolName: "read", toolCallId: "one", text: "secret", sources: [source()] });
		for (const foreign of [scope({ projectId: "project-b" }), scope({ sessionId: "session-b" }), scope({ role: "drafting" })]) {
			expectKind(() => store.read({ id: record.id, scope: foreign }), "stale_source");
			expectKind(() => store.peek({ id: record.id, scope: foreign }), "stale_source");
		}
		expectKind(() => store.read({ id: "obs_after_restart", scope: scope() }), "stale_source");
	}
	{
		const store = createObservationStore();
		const records = [
			store.put({ scope: scope(), toolName: "read", toolCallId: "a", text: "payload", sources: [source()] }),
			store.put({ scope: scope(), toolName: "read", toolCallId: "b", text: "payload", sources: [source({ sha256: "b".repeat(64) })] }),
			store.put({ scope: scope(), toolName: "read", toolCallId: "c", text: "payload", sources: [source({ endLine: 11 })] }),
			store.put({ scope: scope(), toolName: "read", toolCallId: "d", text: "payload", sources: [source({ authority: "candidate" })] }),
			store.put({ scope: scope(), toolName: "read", toolCallId: "e", text: "payload", sources: [source({ memoryId: "memory-2" })] }),
		];
		assert.equal(new Set(records.map((record) => record.id)).size, records.length);
	}
	{
		const unicode = createObservationStore({ maxPayloadBytes: 5, maxRecords: 2, maxAccesses: 3 });
		unicode.put({ scope: scope(), toolName: "read", toolCallId: "u", text: "🙂", sources: [] });
		expectKind(() => unicode.put({ scope: scope(), toolName: "read", toolCallId: "x", text: "好", sources: [] }), "capacity");
		const bounded = createObservationStore({ maxRecords: 1, maxPayloadBytes: 100, maxAccesses: 2 });
		const one = bounded.put({ scope: scope(), toolName: "read", toolCallId: "1", text: "a", sources: [] });
		expectKind(() => bounded.put({ scope: scope(), toolName: "read", toolCallId: "2", text: "b", sources: [] }), "capacity");
		bounded.read({ id: one.id, scope: scope() });
		expectKind(() => bounded.read({ id: one.id, scope: scope() }), "capacity");
		assert.throws(() => createObservationStore({ maxRecords: 0 }), TypeError);
	}
	{
		const store = createObservationStore({ maxSourceRefs: 1 });
		assert.throws(() => store.put({ scope: scope(), toolName: "read", toolCallId: "many", text: "x", sources: [source(), source({ path: "canon/two.md" })] }), TypeError);
		assert.throws(() => store.put({ scope: scope(), toolName: "x".repeat(4097), toolCallId: "long", text: "x", sources: [] }), TypeError);
		assert.throws(() => store.put({ scope: scope(), toolName: "read", toolCallId: "bad-sha", text: "x", sources: [source({ sha256: "not-a-digest" })] }), TypeError);
		const record = store.put({ scope: scope(), toolName: "read", toolCallId: "page", text: "abc", sources: [] });
		const before = store.stats().accesses;
		expectKind(() => store.read({ id: record.id, scope: scope(), start: 4, limit: 1 }), "invalid_input");
		assert.equal(store.stats().accesses, before, "an invalid page must not create an access receipt");
		assert.equal(store.read({ id: record.id, scope: scope(), start: 3, limit: 10 }).payload, "");
	}
	{
		const store = createObservationStore(); const mutable = source();
		const descriptor = store.put({ scope: scope(), toolName: "read", toolCallId: "m", text: "immutable", sources: [mutable] });
		mutable.path = "changed.md"; descriptor.sourceRefs[0]!.path = "also-changed.md";
		assert.equal(store.read({ id: descriptor.id, scope: scope() }).sourceRefs[0]!.path, "canon/world.md");
		const returned = store.getAccesses(scope()); returned[0]!.scope.projectId = "mutated";
		assert.equal(store.getAccesses(scope())[0]!.scope.projectId, "project-a");
	}
	{
		const factoryText = createObservationStore.toString(); assert.ok(!factoryText.includes("RunScope"));
		const standalone = Function(`"use strict"; return (${factoryText});`)() as typeof createObservationStore;
		const compact = Function(`"use strict";return(${factoryText.replace(/\n\s*/g, "")})`)() as typeof createObservationStore;
		for (const factory of [standalone, compact]) { const store = factory({ maxRecords: 1 }); const record = store.put({ scope: scope(), toolName: "read", toolCallId: "s", text: "standalone", sources: [source()] }); assert.equal(store.read({ id: record.id, scope: scope() }).payload, "standalone"); }
	}
	{
		const store = createObservationStore({ digest: () => "same" });
		store.put({ scope: scope(), toolName: "read", toolCallId: "1", text: "alpha", sources: [] });
		expectKind(() => store.put({ scope: scope(), toolName: "read", toolCallId: "2", text: "beta", sources: [] }), "observation_id_collision");
		assert.equal(store.stats().records, 1);
	}
}
