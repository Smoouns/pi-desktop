import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createTaskTransportLedger, type TransportOwner } from "../../src/harness/task-transport-ledger.js";
import { createTaskTransportRuntime } from "../../src/extensions/task-transport-runtime.js";
import { createTaskTransportJournal } from "../../src/extensions/task-transport-journal.js";
import { sha256, withProject, type RunCase } from "./testkit.js";

const owner: TransportOwner = { projectId: "public-project", sessionId: "a", role: "write", taskId: "task-1" };
const usage = { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13 };
function journal() {
	const ledger = createTaskTransportLedger({ digest: sha256 }), entries: any[] = [];
	let current = owner, fail = false;
	const open = (scope = owner) => { current = scope; return ledger.open(scope, entries, (customType, data) => { if (fail) throw Error("PRIVATE"); entries.push({ type: "custom", customType, data }); }, () => current === scope); };
	return { ledger, entries, open, failure: () => { fail = true; } };
}

export async function runTaskTransportCases(runCase: RunCase): Promise<void> {
	await runCase("TRANSPORT-01 durable task totals include ordinary summary and redispatch", record => {
		const j = journal(), meter = j.open();
		const id = meter.begin("ordinary", true), first = meter.attempt(id, 100, true);
		assert.equal(j.entries.at(-1).data.pending[0].attempts.length, 1, "reservation is already in durable append callback");
		meter.settleAttempt(id, first, "httpError", 0);
		const second = meter.attempt(id, 100, true); meter.settleAttempt(id, second, "complete", 20); meter.finish(id, "complete", usage);
		const summary = meter.begin("summary", true), s = meter.attempt(summary, 200, true); meter.settleAttempt(summary, s, "complete", 30); meter.finish(summary, "complete", usage);
		const branch = meter.begin("branchSummary", false); meter.finish(branch, "complete", usage);
		const result = meter.snapshot();
		assert.equal(result.counters.ordinary, 1); assert.equal(result.counters.summary, 1); assert.equal(result.counters.branchSummary, 1);
		assert.equal(result.counters.dispatchAttempts, 3); assert.equal(result.counters.redispatches, 1); assert.equal(result.counters.requestBytes, 400);
		assert.equal(result.sdkUsage.totals.input, 30); assert.equal(result.httpRequests, null); assert.equal(result.sdkUsage.costUsd, null); assert.equal(result.taskTotalComplete, false);
		j.ledger.reset(); const restored = j.open(); assert.deepEqual(restored.snapshot(), result);
		record("transport.totals", { ordinary: 1, summaries: 2, attempts: 3, redispatches: 1, durable: true });
	});
	await runCase("TRANSPORT-02 cold unsettled and missing usage remain unknown", record => {
		const j = journal(), meter = j.open();
		const complete = meter.begin("ordinary", true); meter.finish(complete, "complete", usage);
		const id = meter.begin("summary", true); meter.attempt(id, 20, true);
		j.ledger.reset(); const cold = j.open();
		assert.equal(cold.snapshot().coldUnsettled, 1); assert.equal(cold.snapshot().sdkUsage.totals.input, null); assert.equal(cold.snapshot().sdkUsage.knownSubtotals.input, 10);
		const next = cold.begin("ordinary", true); cold.attempt(next, 0, false); cold.finish(next, "aborted", { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(cold.snapshot().counters.interruptedCalls, 1); assert.equal(cold.snapshot().counters.bodiesUnknown, 1); assert.equal(cold.snapshot().counters.unknownUsageResponses, 1);
		assert.equal(cold.snapshot().sdkUsage.totals.input, null); assert.equal(cold.snapshot().counters.blockedBeforeDispatch, 1);
		record("transport.unknown", { coldUnsettled: true, zeroNotFree: true, noReplay: true });
	});
	await runCase("TRANSPORT-03 scope journal failure and corruption never authorize dispatch", record => {
		const j = journal(), meter = j.open(); const id = meter.begin("ordinary", true);
		const foreign = j.open({ ...owner, sessionId: "b" }); const count = j.entries.length;
		assert.throws(() => meter.attempt(id, 10, true), /STALE_OWNER/); assert.equal(j.entries.length, count); assert.equal(foreign.snapshot().counters.ordinary, 0);
		j.ledger.reset(); const a = j.open(); j.failure(); assert.throws(() => a.begin("ordinary", true), /JOURNAL_FAILURE/); assert.throws(() => a.begin("ordinary", true), /JOURNAL_FAILURE/);
		assert.equal(a.snapshot().status, "journal-failed");
		const bad = journal(); bad.open().begin("summary", true); bad.entries.at(-1).data.counters.summary++;
		bad.ledger.reset(); assert.throws(() => bad.open(), /LEDGER_INVALID/);
		record("transport.scope", { foreignLateDenied: true, journalFailClosed: true, corruptLatestRejected: true });
	});
	await runCase("TRANSPORT-04 embeddable bounded scalar snapshots have no payloads", record => {
		const factory = Function(`return (${createTaskTransportLedger.toString()})`)() as typeof createTaskTransportLedger;
		const ledger = factory({ digest: sha256 }), entries: any[] = [];
		const meter = ledger.open(owner, [], (type, data) => entries.push({ type, data }), () => true);
		for (let n = 0; n < 16; n++) meter.begin("summary", true);
		assert.throws(() => meter.begin("ordinary", true), /INVOCATION_LIMIT/);
		assert.equal(meter.snapshot().openCalls, 16); assert.doesNotMatch(JSON.stringify(entries), /Bearer|PRIVATE|https?:|prompt|content/);
		const result = meter.snapshot(); result.counters.summary = 555; assert.equal(meter.snapshot().counters.summary, 16);
		record("transport.bounds", { standalone: true, cap: 16, scalarOnly: true });
	});
	await runCase("TRANSPORT-05 fetch gate rejects inflated serialized input before outlet", async record => {
		for (const aborted of [false, true]) {
			const j = journal(), meter = j.open(), signal = new AbortController(); let dispatches = 0;
			const model = { api: "openai-completions", provider: "offline", id: "offline", baseUrl: "https://loopback.invalid" };
			let fetcher: typeof fetch = async () => { dispatches++; return new Response("ok"); };
			let host: ReturnType<typeof createTaskTransportRuntime>;
			const provider: any = {};
			const binding = { meter, model, signal: signal.signal, assertCurrent: () => undefined, audit: (body: string) => ({ allowed: body.length < 50 }) };
			provider.stream = provider.streamSimple = () => {
				const output = createAssistantMessageEventStream();
				void (async () => {
					host.bindOrdinary(binding);
					try { await fetcher(model.baseUrl + "/chat/completions", { method: "POST", body: "X".repeat(100) }); assert.fail("must block"); }
					catch (e: any) { assert.match(e.message, /TRANSPORT_INPUT_BUDGET|TRANSPORT_ABORTED/); }
					output.push({ type: "error", reason: "aborted", error: { role: "assistant", stopReason: "aborted", usage: {} } as any });
				})(); return output;
			};
			host = createTaskTransportRuntime({ storage: new AsyncLocalStorage(), getProvider: () => provider, getFetch: () => fetcher, setFetch: value => { fetcher = value; } });
			host.ensure(model.api); if (aborted) signal.abort(); await provider.streamSimple(model, {}, {} as any).result();
			assert.equal(dispatches, 0); assert.equal(meter.snapshot().counters.blockedBeforeDispatch, 1); assert.equal(meter.snapshot().counters.dispatchAttempts, 0);
			assert.equal(meter.snapshot().sdkUsage.totals.input, null);
		}
		record("transport.gate", { inflatedBlocked: true, cancelledBlocked: true, outletCalls: 0 });
	});
	await runCase("TRANSPORT-06 bound summary forwards stream without buffering or changing registration", async record => {
		const j = journal(), meter = j.open(), signal = new AbortController(); let unbound = 0;
		const model = { api: "google-generative-ai", provider: "offline", id: "offline", baseUrl: "https://loopback.invalid" };
		let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; });
		let fetcher: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("first")); void held.then(() => { controller.enqueue(new TextEncoder().encode("last")); controller.close(); }); } }));
		let first!: () => void; const firstSeen = new Promise<void>(resolve => { first = resolve; });
		const provider: any = {};
		provider.stream = provider.streamSimple = () => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				const response = await fetcher(model.baseUrl + "/models/offline:streamGenerateContent", { method: "POST", body: "{}" });
				const reader = response.body!.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), "first"); first();
				assert.equal(new TextDecoder().decode((await reader.read()).value), "last"); assert.equal((await reader.read()).done, true);
				stream.push({ type: "done", reason: "stop", message: { role: "assistant", stopReason: "stop", usage } as any });
			})(); return stream;
		};
		const host = createTaskTransportRuntime({ storage: new AsyncLocalStorage(), getProvider: () => provider, getFetch: () => fetcher, setFetch: value => { fetcher = value; } });
		host.ensure(model.api); const wrapped = provider.stream; host.ensure(model.api); assert.equal(provider.stream, wrapped);
		host.bindSummary({ meter, model, assertCurrent: () => undefined, audit: () => ({ allowed: true }) }, signal.signal);
		const stream = provider.streamSimple(model, {}, { signal: signal.signal });
		await firstSeen; assert.equal(meter.snapshot().counters.bodiesComplete, 0); finish(); await stream.result();
		assert.equal(meter.snapshot().counters.summary, 1); assert.equal(meter.snapshot().counters.responseBytes, 9); assert.equal(meter.snapshot().counters.bodiesComplete, 1);
		// Registry replacement remains possible; unrelated requests never acquire a task.
		const previous = meter.snapshot(); await fetcher("https://unrelated.invalid", { method: "POST", body: "{}" }); unbound++;
		assert.deepEqual(meter.snapshot(), previous); assert.equal(unbound, 1);
		record("transport.streaming", { firstChunkBeforeEnd: true, summaryAttributed: true, unrelatedNotCharged: true });
	});
	await runCase("TRANSPORT-07 first dispatch survives a fresh process before any assistant", async record => {
		await withProject(async root => {
			const sessionFile = path.join(root, "no-assistant.jsonl"), disk = createTaskTransportJournal({ fs, path, digest: sha256 }).open(sessionFile, owner);
			const ledger = createTaskTransportLedger({ digest: sha256 });
			const meter = ledger.open(owner, [], (_type, data) => disk.append(data), () => true);
			const id = meter.begin("ordinary", true); meter.attempt(id, 100, true);
			assert.equal(fs.existsSync(sessionFile), false, "never fabricate a Pi conversation to force persistence");
			const script = `import * as fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
const digest = text => createHash('sha256').update(text).digest('hex');
const scope = ${JSON.stringify(owner)};
const journal = (${createTaskTransportJournal.toString()})({fs, path, digest}).open(${JSON.stringify(sessionFile)}, scope);
const ledger = (${createTaskTransportLedger.toString()})({digest});
const meter = ledger.open(scope, [{type:'custom',customType:ledger.customType,data:journal.record}], () => {throw Error('READ_ONLY');}, () => true);
process.stdout.write(JSON.stringify({pid:process.pid,snapshot:meter.snapshot()}));`;
			const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)));
			const cold = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: environment, windowsHide: true, timeout: 15_000 }));
			assert.notEqual(cold.pid, process.pid); assert.equal(cold.snapshot.counters.dispatchAttempts, 1); assert.equal(cold.snapshot.coldUnsettled, 1);
			assert.equal(cold.snapshot.sdkUsage.totals.input, null); assert.equal(cold.snapshot.sdkUsage.costUsd, null);
			const other = createTaskTransportJournal({ fs, path, digest: sha256 }).open(sessionFile, { ...owner, role: "plan" });
			assert.equal(other.record, null);
		});
		record("transport.cold", { firstAssistantNotRequired: true, independentProcess: true, unknownNotReplayed: true });
	});
	await runCase("TRANSPORT-08 disk conflict partial write and stale locks fail closed", async record => {
		await withProject(async root => {
			const sessionFile = path.join(root, "journal.jsonl"), factory = createTaskTransportJournal({ fs, path, digest: sha256 });
			const a = factory.open(sessionFile, owner), b = factory.open(sessionFile, owner);
			const valid = { owner, test: 1 }; a.append(valid);
			assert.throws(() => b.append({ owner, test: 2 }), /STORAGE/);
			assert.deepEqual(factory.open(sessionFile, owner).record, valid);
			const failedFs = { ...fs, writeFileSync(fd: number, _text: string) { fs.writeFileSync(fd, '{"partial":'); throw Error("SIMULATED_DISK_FAILURE"); } };
			const partial = createTaskTransportJournal({ fs: failedFs, path, digest: sha256 }).open(sessionFile, owner);
			assert.throws(() => partial.append({ owner, test: 3 }), /SIMULATED/);
			assert.deepEqual(factory.open(sessionFile, owner).record, valid, "partial next image cannot overwrite committed totals");
			const directory = path.join(root, ".pi-desktop-transport"), filename = fs.readdirSync(directory)[0];
			assert.ok(filename.endsWith(".json")); fs.writeFileSync(path.join(directory, filename + ".lock"), "", { flag: "wx" });
			assert.throws(() => factory.open(sessionFile, owner), /STORAGE/);
			assert.equal(fs.existsSync(path.join(directory, filename + ".lock")), true, "never steal a stale/foreign transaction lock");
		});
		record("transport.disk", { concurrentOverwriteRejected: true, partialWritePreservesOld: true, staleLockNotRemoved: true });
	});
	await runCase("TRANSPORT-09 malformed foreign and oversized sidecars never reset totals", async record => {
		await withProject(async root => {
			const sessionFile = path.join(root, "journal.jsonl"), factory = createTaskTransportJournal({ fs, path, digest: sha256 });
			const disk = factory.open(sessionFile, owner); disk.append({ owner });
			const directory = path.join(root, ".pi-desktop-transport"), file = path.join(directory, fs.readdirSync(directory)[0]);
			const original = fs.readFileSync(file, "utf8");
			for (const value of ["{broken", "X".repeat(36_001), JSON.stringify({ ...JSON.parse(original), record: { owner: { ...owner, sessionId: "b" } } })]) {
				fs.writeFileSync(file, value); assert.throws(() => factory.open(sessionFile, owner), /STORAGE/);
			}
			fs.writeFileSync(file, original); const link = path.join(root, "linked-ledger.json"); fs.linkSync(file, link);
			assert.throws(() => factory.open(sessionFile, owner), /STORAGE/, "hardlinked journal is not private mutable storage");
			assert.throws(() => disk.append({ owner, body: "X".repeat(36_001) }), /STORAGE/);
		});
		record("transport.integrity", { malformedDenied: true, foreignOwnerDenied: true, sizeBound: true, hardlinkDenied: true });
	});
	await runCase("TRANSPORT-10 explicit refusal survives a swallowed pre-binding journal error", async record => {
		for (const api of ["openai-completions", "google-generative-ai"]) {
			const model = { api, provider: "offline", id: "offline", baseUrl: "https://loopback.invalid" };
			let dispatches = 0, host: ReturnType<typeof createTaskTransportRuntime>;
			let fetcher: typeof fetch = async () => { dispatches++; return new Response("must never send"); };
			const provider: any = {};
			provider.stream = provider.streamSimple = () => {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					host.denyOrdinary(model); // Binding failed; caller swallowed its exception and ignores abort.
					const endpoint = api === "openai-completions" ? "/chat/completions" : "/models/offline:streamGenerateContent";
					await assert.rejects(fetcher(model.baseUrl + endpoint, { method: "POST", body: "{}" }), /TRANSPORT_JOURNAL_FAILURE/);
					stream.push({ type: "error", reason: "error", error: { role: "assistant", stopReason: "error", usage: {} } as any });
				})(); return stream;
			};
			host = createTaskTransportRuntime({ storage: new AsyncLocalStorage(), getProvider: () => provider, getFetch: () => fetcher, setFetch: value => { fetcher = value; } });
			host.ensure(api); await provider.streamSimple(model, {}, {}).result(); assert.equal(dispatches, 0);
		}
		record("transport.refusal", { missingBindingDenied: true, doesNotRelyOnAbort: true, outletCalls: 0 });
	});
}
