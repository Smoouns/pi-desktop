import assert from "node:assert/strict";
import { createReadDelivery } from "../../src/harness/read-delivery.js";
import type { RunCase } from "./testkit.js";

const source = { path: "canon/world.md", sha256: "a".repeat(64), startLine: 4, endLine: 6, authority: "reference", temporal: "unspecified" };
export async function runReadDeliveryCases(runCase: RunCase): Promise<void> {
	await runCase("read-delivery.exact-spans-pages-and-generation", () => {
		const f = createReadDelivery();
		const body = "首行😀\r\nsecond\r\nthird";
		f.register("observation", body.length + 8, [f.span(source, body, 8)]);
		assert.deepEqual(f.deliver("observation", "epoch-a", 0, 8).sourceRefs, [], "a header is not source text");
		assert.deepEqual(f.deliver("observation", "epoch-a", 8, 10).sourceRefs, []);
		const end = 8 + "首行😀\r".length;
		assert.deepEqual(f.deliver("observation", "epoch-a", 10, end).sourceRefs.map((r) => [r.startLine, r.endLine]), [[4, 4]]);
		assert.deepEqual(f.deliver("observation", "epoch-b", 10, end).sourceRefs, [], "freshness epoch retires old partial coverage");
		assert.deepEqual(f.deliver("observation", "epoch-b", 8, 10).deliveredSourceRefs, [], "per-call range does not pretend this page contained the earlier half");
		assert.deepEqual(f.deliver("observation", "epoch-b", 8, body.length + 8).sourceRefs.map((r) => [r.startLine, r.endLine]), [[4, 6]]);
		assert.throws(() => f.deliver("observation", "epoch-b", 0, body.length + 9), /bounds/);
		assert.throws(() => f.register("observation", 1, []), /identity/);
	});
	await runCase("read-delivery.atomic-memory-never-upgrades-a-partial-excerpt", () => {
		const f = createReadDelivery();
		const ref = { ...source, memoryId: "mem-1", authority: "approved" };
		f.register("memory", 12, [f.span(ref, "encoded text", 0, true)]);
		assert.deepEqual(f.deliver("memory", "run", 0, 5).sourceRefs, []);
		const result = f.deliver("memory", "run", 5, 12);
		assert.deepEqual(result.sourceRefs, [ref]); assert.deepEqual(result.deliveredSourceRefs, []);
	});
	await runCase("read-delivery.factory-is-standalone-and-bounded", () => {
		const factory = Function(`return (${createReadDelivery.toString()})`)() as typeof createReadDelivery;
		const f = factory({ maxRecords: 1, maxUnits: 3 });
		f.register("a", 5, [f.span(source, "a\nb\nc", 0)]);
		assert.throws(() => f.register("b", 1, []), /capacity/);
		assert.throws(() => f.span(source, "only one line", 0), /range/);
		assert.throws(() => f.deliver("missing", "run", 0, 0), /unavailable/);
	});
}
