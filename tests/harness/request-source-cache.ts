import assert from "node:assert/strict";
import fs, { readFile, writeFile, stat, utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createRequestSourceCache } from "../../src/harness/request-source-cache.js";
import { createRuntimeMetrics } from "../../src/harness/runtime-metrics.js";
import { withLoadedExtension } from "./contracts.js";
import { sha256, withProject, type RunCase } from "./testkit.js";

const SOURCE = "canon/world.md";
const text = (value: any): string => value.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
const model = { id: "cache-offline", name: "Offline", api: "openai-completions", provider: "synthetic", input: ["text"], contextWindow: 1_000_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function withAdapter(root: string, minified: boolean, body: (api: any) => Promise<void>) {
	await withLoadedExtension(root, minified, async (extension, runtime) => {
		let id = 0;
		const branch: any[] = [{ type: "custom", customType: "pi-desktop-novel-role", data: { role: "write" } }];
		runtime.appendEntry = (customType, data) => { branch.push({ type: "custom", customType, data }); };
		const context = (session = "source-cache-a") => ({ cwd: root, model, abort: () => undefined, sessionManager: { getSessionId: () => session, getBranch: () => branch.slice() } });
		const ctx = context();
		const execute = async (name: string, args: any, owner = ctx): Promise<any> => extension.tools.get(name)!.definition.execute(`cache-${++id}`, args, undefined, undefined, owner as never);
		const budget = async (owner = ctx) => JSON.parse(text(await execute("get_context_budget", {}, owner)));
		const invoke = (name: string, event: any, owner = ctx) => extension.handlers.get(name)![0]({ type: name, ...event }, owner as never) as Promise<any>;
		const contextHook = (messages: any[], owner = ctx) => invoke("context", { messages: [{ role: "user", content: "只读核验", timestamp: 0 }, ...messages] }, owner);
		const message = (result: any) => ({ ...result, role: "toolResult", toolName: "read_story_document", toolCallId: `message-${++id}`, timestamp: 0 });
		const writeGate = () => invoke("tool_call", { toolName: "write", toolCallId: `write-${++id}`, input: { path: "drafts/candidates/chapters/cache-test.md", content: "must not dispatch" } });
		await body({ execute, budget, contextHook, message, writeGate, context });
	});
}

/** Targeted IO fault interleaving, restored even on assertion failures. */
async function withIO(method: "stat" | "readFile", wrap: (original: any) => any, body: () => Promise<void>) {
	const original = fs[method];
	(fs as any)[method] = wrap(original); syncBuiltinESMExports();
	try { await body(); } finally { (fs as any)[method] = original; syncBuiltinESMExports(); }
}

export async function runRequestSourceCacheCases(runCase: RunCase): Promise<void> {
	await runCase("SOURCE-CACHE-01 bounded digest-only factory disposes and isolates requests", record => {
		const rebuilt = Function(`return (${createRequestSourceCache.toString()})`)() as typeof createRequestSourceCache;
		const meter = createRuntimeMetrics(); const frame = meter.beginContext();
		const cache = rebuilt({ maxEntries: 1, maxSourceBytes: 10, onEvent: (kind, bytes) => meter.sourceCache(kind, bytes) });
		const a = sha256("a"), b = sha256("b"), s1 = sha256("stat1"), s2 = sha256("stat2");
		const version = { sha256: sha256("contents"), totalLines: 2, sourceBytes: 8, authority: "canonical", raw: "PRIVATE" };
		assert.equal(cache.get(a, s1), undefined); assert.equal(cache.put(a, s1, version), true);
		const hit = cache.get(a, s1)!; assert.deepEqual(Object.keys(hit).sort(), ["sha256", "sourceBytes", "totalLines"]);
		hit.sha256 = b; assert.equal(cache.get(a, s1)!.sha256, version.sha256);
		assert.equal(cache.put(b, s1, version), false, "entry bound falls back to uncached reads");
		assert.equal(cache.get(a, s2), undefined, "stat drift invalidates within one request");
		assert.equal(cache.put(b, s1, { ...version, sourceBytes: 11 }), false, "source byte bound is independent");
		assert.equal(cache.put(a, s2, version), true);
		assert.equal(rebuilt().get(a, s2), undefined, "new request cannot reuse prior cache");
		cache.dispose(); cache.dispose();
		assert.throws(() => cache.get(a, s2), /disposed/); assert.throws(() => cache.put(a, s2, version), /disposed/);
		meter.endContext(frame);
		assert.deepEqual(meter.snapshot().reads.sourceCache, { hits: 2, misses: 2, invalidations: 1, capacityBypasses: 2, reusedSourceBytes: 16 });
		assert.equal(meter.snapshot().reads.total.calls, 0, "cache hits are not physical reads");
		assert.doesNotMatch(JSON.stringify(meter.snapshot()), /PRIVATE|canonical/);
		record("sourceCache.bounds", { digestOnly: true, byteBound: true, entryBound: true, disposed: true });
	});
	await runCase("SOURCE-CACHE-02 checkpoint and observations share one read only within context", record => withProject(async root => {
		const raw = await readFile(path.join(root, SOURCE));
		for (const minified of [false, true]) await withAdapter(root, minified, async api => {
			const first = await api.execute("read_story_document", { path: SOURCE, startLine: 1, endLine: 3 });
			const second = await api.execute("read_story_document", { path: SOURCE, startLine: 5, endLine: 9 });
			const messages = [api.message(first), api.message(second)], before = await api.budget();
			let physical = 0;
			await withIO("readFile", original => async (target: any, ...args: any[]) => { if (String(target) === path.join(root, SOURCE)) physical++; return original(target, ...args); }, async () => {
				assert.doesNotMatch(JSON.stringify(await api.contextHook(messages)), /stale_source/);
			});
			const after = await api.budget(), reads = after.metrics.reads.lastContext.reads;
			assert.equal(physical, 1); assert.equal(reads.total.calls, 1); assert.equal(reads.total.bytes, raw.length);
			assert.equal(reads.logicalReferences.checkpointSources, 2); assert.equal(reads.logicalReferences.observationSources, 2);
			assert.equal(reads.sourceCache.hits, 3); assert.equal(reads.sourceCache.misses, 1);
			assert.equal(after.run.readUsed - before.run.readUsed, raw.length, "charge a physical file read only once");
			await api.contextHook(messages);
			const next = await api.budget(); assert.equal(next.run.readUsed - after.run.readUsed, raw.length, "next context reads again even in same run");
			await api.execute("read_observation", { id: first.details.observation.id, start: 0, limit: 10 });
			const page = await api.budget(); assert.equal(page.run.readUsed - next.run.readUsed, raw.length + 10, "explicit pagination revalidates fresh");
		});
		record("sourceCache.shared", { sourceReads: 1, logicalReferences: 4, hits: 3, nextRequestFresh: true, minified: true });
	}));
	await runCase("SOURCE-CACHE-03 same-size same-mtime edits invalidate next context", record => withProject(async root => withAdapter(root, false, async api => {
		const target = path.join(root, SOURCE), original = await readFile(target), originalStat = await stat(target);
		const result = await api.execute("read_story_document", { path: SOURCE });
		await api.contextHook([api.message(result)]);
		const changed = Buffer.from(original); changed[0] = changed[0] === 35 ? 33 : 35;
		await writeFile(target, changed); await utimes(target, originalStat.atime, originalStat.mtime);
		const output = await api.contextHook([api.message(result)]);
		assert.match(JSON.stringify(output), /stale_source/);
		assert.equal((await api.writeGate())?.block, true);
		const value = await api.budget(); assert.equal(value.metrics.reads.lastContext.reads.total.calls, 1);
		assert.equal(value.metrics.reads.lastContext.reads.sourceCache.misses, 1);
		record("sourceCache.nextRequest", { shaRequired: true, sameSize: true, mtimeRestored: true, staleBlocked: true });
	})));
	await runCase("SOURCE-CACHE-04 final write gate never reuses context snapshot", record => withProject(async root => withAdapter(root, true, async api => {
		const target = path.join(root, SOURCE), original = await readFile(target);
		const result = await api.execute("read_story_document", { path: SOURCE });
		await api.contextHook([api.message(result)]);
		const before = await api.budget();
		await writeFile(target, Buffer.concat([original, Buffer.from("\nchanged after context")]));
		const gate = await api.writeGate(); assert.equal(gate?.block, true); assert.match(gate.reason, /stale_source/);
		const after = await api.budget(); assert.ok(after.run.readUsed > before.run.readUsed);
		assert.deepEqual(after.metrics.reads.sourceCache, before.metrics.reads.sourceCache, "write gate cannot access disposed request cache");
		await assert.rejects(readFile(path.join(root, "drafts/candidates/chapters/cache-test.md")), { code: "ENOENT" });
		record("sourceCache.writeGate", { freshRead: true, dispatchDenied: true });
	})));
	await runCase("SOURCE-CACHE-05 stat drift and size growth cannot reuse an earlier snapshot", record => withProject(async root => {
		const target = path.join(root, SOURCE), original = await readFile(target);
		for (const tooLarge of [false, true]) {
			await writeFile(target, original);
			await withAdapter(root, false, async api => {
				const result = await api.execute("read_story_document", { path: SOURCE }); let stats = 0;
				await withIO("stat", originalStat => async (filename: any, ...args: any[]) => {
					if (String(filename) === target && ++stats === 3) await writeFile(target, tooLarge ? Buffer.alloc(1_600_001, 65) : Buffer.concat([original, Buffer.from("changed")]));
					return originalStat(filename, ...args);
				}, async () => { assert.match(JSON.stringify(await api.contextHook([api.message(result)])), /stale_source/); });
				const reads = (await api.budget()).metrics.reads.lastContext.reads;
				assert.equal(reads.total.calls, tooLarge ? 1 : 2); assert.equal(reads.sourceCache.hits, 0);
				assert.equal(reads.sourceCache.invalidations, tooLarge ? 0 : 1);
			});
		}
		record("sourceCache.drift", { sameContextChanged: true, growthBlockedBeforeRead: true });
	}));
	await runCase("SOURCE-CACHE-06 cache hit does not retain memory acceptance", record => withProject(async root => withAdapter(root, false, async api => {
		const search = await api.execute("search_story_memory", { query: "备用电台", limit: 10 });
		let payload = text(search);
		if (search.details.offloaded) {
			payload = "";
			for (let start = 0, pages = 0; pages < 128; pages++) {
				const part = await api.execute("read_observation", { id: search.details.observation.id, start, limit: 4000 });
				const chunk = text(part).replace(/\n\[(?:更多内容：start=\d+|记录结束)\]$/, ""); payload += chunk;
				if (!part.details.hasMore) break; start += chunk.length;
			}
		}
		const accepted = JSON.parse(payload).hits.find((hit: any) => hit.path === "drafts/candidates/chapters/002.md" && hit.authority === "approved"); assert.ok(accepted);
		const result = await api.execute("read_story_memory", { id: accepted.id });
		const target = path.join(root, accepted.path), before = await readFile(target), acceptancePath = path.join(root, ".novel/acceptances/002-manuscript.json");
		let stats = 0, withdrawn = false;
		await withIO("stat", original => async (filename: any, ...args: any[]) => {
			if (String(filename) === target && ++stats === 3) {
				const acceptance = JSON.parse(await readFile(acceptancePath, "utf8")); acceptance.sourceFingerprint = "0:withdrawn";
				await writeFile(acceptancePath, JSON.stringify(acceptance)); withdrawn = true;
			}
			return original(filename, ...args);
		}, async () => { assert.match(JSON.stringify(await api.contextHook([api.message(result)])), /stale_source.*人工验收|STALE_MEMORY|人工验收已变化/); });
		assert.equal(withdrawn, true); assert.deepEqual(await readFile(target), before);
		assert.ok((await api.budget()).metrics.reads.lastContext.reads.sourceCache.hits >= 1, "source cache hit must still trigger an independent memory snapshot");
		assert.equal((await api.writeGate())?.block, true);
		record("sourceCache.acceptance", { sourceUnchanged: true, cacheHit: true, retractionObserved: true, writeBlocked: true });
	})));
	await runCase("SOURCE-CACHE-07 cancelled old IO cannot populate or abort another session", record => withProject(async root => withAdapter(root, false, async api => {
		const result = await api.execute("read_story_document", { path: SOURCE });
		let enter!: () => void, release!: () => void;
		const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
		let paused = false;
		await withIO("readFile", original => async (filename: any, ...args: any[]) => {
			const raw = await original(filename, ...args);
			if (String(filename) === path.join(root, SOURCE) && !paused) { paused = true; enter(); await held; }
			return raw;
		}, async () => {
			const pending = api.contextHook([api.message(result)]); await entered;
			try {
				const b = api.context("source-cache-b"); let aborts = 0; b.abort = () => { aborts++; };
				assert.equal((await api.budget(b)).metrics.reads.total.calls, 0);
				release(); await assert.rejects(pending, /aborted|ended run|STALE_RUN|Checkpoint run/i);
				const report = await api.budget(b); assert.equal(report.metrics.reads.total.calls, 0); assert.equal(report.metrics.reads.sourceCache.hits, 0); assert.equal(aborts, 0);
			} finally { release(); }
		});
		record("sourceCache.cancel", { cancelledIORejected: true, nextSessionUntouched: true });
	})));
}
