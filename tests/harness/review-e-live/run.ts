import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { freezeRequestPolicy } from "../../../evals/core/request-policy.js";
import { NOVEL_TOOLS_EXTENSION_CONTENT } from "../../../src/extensions/novel-tools-extension.js";
import { treeManifest } from "../testkit.js";
import { digest, Journal, rawUsage, recover } from "./journal.js";
import { OfflineBroker } from "./broker.js";
import { SOURCE, CONTROL_ONLY, BAD_SUMMARY, oracle, score, seed, source } from "./fixtures.js";

const root = process.cwd(), directory = "tests/harness/review-e-live";
const parent = path.join(root, "artifacts/harness/review-e8"); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "offline-"));
const before = { src: await treeManifest(path.join(root, "src")), fixtures: await treeManifest(path.join(root, "fixtures")), evals: await treeManifest(path.join(root, "evals")) };
const planBytes = await readFile("docs/REVIEW_E_LIVE_VALIDATION_PLAN.json", "utf8"), plan = JSON.parse(planBytes);
assert.equal(plan.authorization.granted, false); assert.equal(plan.executable, false);
const policy = freezeRequestPolicy(plan.policy);
assert.equal(JSON.parse(await readFile("node_modules/@mariozechner/pi-coding-agent/package.json", "utf8")).version, "0.63.1");
const cases: any[] = [], workers: any[] = [];
const sourceHashes = { ...await treeManifest(path.join(root, directory)), extension: digest(NOVEL_TOOLS_EXTENSION_CONTENT), plan: digest(planBytes), lock: digest(await readFile("package-lock.json")) };
await writeFile(path.join(output, "source-manifest.json"), JSON.stringify({ before, driver: sourceHashes, runner: digest(await readFile("scripts/run-public-tests.mjs")), package: digest(await readFile("package.json")) }, null, 2));
const generatedExtension = path.join(output, "novel-tools.ts");
await writeFile(generatedExtension, NOVEL_TOOLS_EXTENSION_CONTENT);
const bundle = path.join(output, "worker.mjs");
await build({ entryPoints: [directory + "/worker.ts"], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning",
	plugins: [{ name: "pinned-loader", setup(api) { api.onResolve({ filter: /node_modules\/@mariozechner\/pi-coding-agent\/dist\/core\/extensions\/index\.js$/ }, () => ({ path: pathToFileURL(path.join(root, "node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js")).href, external: true })); } }] });
const recoveryBundle = path.join(output, "recover.mjs");
await build({ entryPoints: [directory + "/recover.ts"], outfile: recoveryBundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning" });
await writeFile(path.join(output, "oracle.json"), JSON.stringify({ oracle, critical: [1, 2, 3, 4, 6, 10] }, null, 2));
const zeroExternal = { realModelCalls: 0, globalConfigChanged: false, liveAuthorized: false };
async function test(id: string, body: () => Promise<any>) {
	try { const detail = await body(); cases.push({ id, passed: true, ...detail }); console.log("PASS " + id); }
	catch (error) { cases.push({ id, passed: false, error: error instanceof Error ? error.stack : String(error) }); console.error("FAIL " + id, error); }
}
async function start(name: string, p = policy) {
	const destination = path.join(output, name); await mkdir(destination, { recursive: true });
	const broker = new OfflineBroker(destination, p); await broker.start(); return broker;
}
async function coldRecover(file: string) {
	const before = await readFile(file);
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
	const child = spawn(process.execPath, [recoveryBundle, file], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let text = "", errors = ""; child.stdout.on("data", data => text += data); child.stderr.on("data", data => errors += data);
	const timer = setTimeout(() => child.kill(), 10_000);
	const status = await new Promise(resolve => child.once("exit", resolve)); clearTimeout(timer);
	assert.equal(status, 0, errors); assert.deepEqual(await readFile(file), before);
	return JSON.parse(text);
}
async function runWorker(broker: OfflineBroker, scenario: string, task: string) {
	const id = "worker-" + scenario, work = path.join(broker.output, id), project = path.join(work, "project"), agentDir = path.join(work, "agent");
	await mkdir(path.join(project, ".novel"), { recursive: true }); await mkdir(agentDir, { recursive: true });
	const layout = Object.fromEntries(["manuscript", "canon", "planning", "drafts", "craft", "notes", "memory", "research", "assets", "archive", "exports"].map(p => [p, [p]]));
	await writeFile(path.join(project, ".novel/project.json"), JSON.stringify({ formatVersion: 1, name: "E8 public synthetic", localFirst: true, layout }));
	for (const directory of Object.keys(layout)) await mkdir(path.join(project, directory));
	const protectedFiles = { "canon/protected.md": "Public Canon sentinel. Model may not modify.\n", "planning/approval.json": '{"userAccepted":false}\n' };
	for (const [name, text] of Object.entries(protectedFiles)) await writeFile(path.join(project, name), text);
	await writeFile(path.join(project, SOURCE), source("v1"));
	const environment: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL"]) {
		const actual = Object.keys(process.env).find(k => k.toUpperCase() === key); if (actual) environment[actual] = process.env[actual];
	}
	Object.assign(environment, { PI_CODING_AGENT_DIR: agentDir, PI_E8_ORIGIN: broker.origin,
		NODE_OPTIONS: `--import=${pathToFileURL(path.join(root, directory, "network-guard.mjs")).href}` });
	broker.register(id, work, task, scenario);
	const child = spawn(process.execPath, [bundle, work, id, scenario, path.join(root, directory, "scope-extension.ts"), generatedExtension], { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	broker.attach(id, child);
	let stdout = "", stderr = "", timedOut = false;
	child.stdout!.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-200_000); });
	child.stderr!.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-200_000); });
	const timer = setTimeout(() => { timedOut = true; broker.journal.stop("worker_timeout"); child.kill(); }, 35_000);
	const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { child.on("error", reject); child.on("exit", (code, signal) => resolve({ code, signal })); }); clearTimeout(timer);
	await writeFile(path.join(work, "process.json"), JSON.stringify({ ...exit, timedOut, stdout, stderr }, null, 2));
	for (const [name, text] of Object.entries(protectedFiles)) assert.equal(await readFile(path.join(project, name), "utf8"), text, "E8_PROTECTED_FILE_CHANGED");
	assert.equal(await readFile(path.join(project, SOURCE), "utf8"), source(scenario === "r" ? "v2" : "v1"));
	assert.equal(timedOut, false, "E8_WORKER_TIMED_OUT");
	if (scenario === "crash") return { exit, work, crashed: true };
	assert.equal(exit.code, 0, stderr);
	const result = JSON.parse(await readFile(path.join(work, "worker-result.json"), "utf8"));
	assert.equal(result.network.denied, 0, "unexpected network or subprocess attempt");
	assert.equal(result.extensionSha256, digest(NOVEL_TOOLS_EXTENSION_CONTENT));
	workers.push({ id, pid: result.pid, scenario, task, work, fetches: result.fetchAttempts.length, failure: result.failure ?? null });
	return result;
}
const rows = (b: OfflineBroker, event: string, worker?: string) => b.journal.rows.filter(row => row.event === event && (!worker || row.data.worker === worker));
const answer = (r: any) => [...r.messages].reverse().find((m: any) => m.role === "assistant")?.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";
const toolJson = (r: any, id: string) => JSON.parse(r.tools.find((t: any) => t.id === id).result.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"));
const healthy = (r: any) => { assert.equal(r.failure, undefined); assert.deepEqual(r.errors, []); };

// Native terminal usages include summaries that are not message_end events.
// Use successive *production* ledger commits, not fabricated SDK callbacks.
function terminals(r: any) {
	const values: any[] = []; let previous: any = null;
	for (const current of r.ledgerRecords) {
		if (previous) {
			const removed = previous.pending.filter((p: any) => !current.pending.some((q: any) => p.id === q.id));
			if (removed.length) {
				assert.equal(removed.length, 1, "terminal correlation must be unique");
				const unknown = current.counters.unknownUsageResponses > previous.counters.unknownUsageResponses;
				values.push({ id: removed[0].id, kind: removed[0].kind, usage: unknown ? null : Object.fromEntries(Object.keys(current.usageSums).map(key => [key, current.usageSums[key] - previous.usageSums[key]])) });
			}
		}
		previous = current;
	}
	return values;
}

try {
	await test("e8.fixture-and-oracle-isolation", async () => {
		const bytes = Buffer.byteLength(JSON.stringify(seed())); assert.ok(bytes >= 12 * 1024 && bytes <= 20 * 1024, String(bytes));
		assert.equal(Buffer.byteLength(source("v1")), Buffer.byteLength(source("v2"))); assert.notEqual(digest(source("v1")), digest(source("v2")));
		assert.equal(score(JSON.stringify(oracle)).passed, true);
		assert.equal(score("```json\n" + JSON.stringify(oracle) + "\n```").passed, false);
		assert.equal(score(JSON.stringify({ ...oracle, writerPlanningWrite: true })).criticalPassed, false);
		assert.equal(score(JSON.stringify({ ...oracle, unresolved: "known" })).passed, false);
		return { seedBytes: bytes, sourceBytes: Buffer.byteLength(source("v1")), oracleOutsideProject: true };
	});
	const batch = await start("ucr");
	try {
		await test("e8.u-matched-usage", async () => {
			const r = await runWorker(batch, "u", "E8-U"); healthy(r);
			const requests = rows(batch, "reserved", "worker-u"), final = r.snapshots.at(-1).transport;
			assert.equal(requests.length, 2); assert.equal(final.counters.dispatchAttempts, 2); assert.equal(final.calibration.appliedToBudget, false);
			const native = terminals(r); assert.equal(native.length, 2);
			const pairs = requests.map(request => {
				const terminal = rows(batch, "terminal").find(t => t.data.id === request.data.id)!.data;
				const sdk = native.find(t => t.id === request.data.productionCallId)!.usage;
				const diagnostic = final.calibration.samples.find((s: any) => s.sequence === request.data.productionCallId);
				assert.ok(diagnostic?.eligible); const total = sdk.input + sdk.cacheRead + sdk.cacheWrite;
				assert.equal(total, terminal.rawUsage.input); assert.equal(diagnostic.sdkInputTokens, total);
				assert.equal(diagnostic.rawRequestBytes, request.data.inputReservation);
				return { id: request.data.id, productionCallId: request.data.productionCallId, raw: terminal.rawUsage, sdk, diagnostic,
					errorTokens: diagnostic.estimatedInputTokens - total, errorRatio: (diagnostic.estimatedInputTokens - total) / total };
			});
			assert.ok(r.streamDeltas.length >= 2);
			return { pairs, anchor: pairs[1].diagnostic.anchoredInputEstimate === null ? "not_observed" : "observed_synthetic_only", realUsageAccuracyVerified: false };
		});
		await test("e8.c-independent-native-compaction", async () => {
			const control = await runWorker(batch, "c-control", "E8-C"); healthy(control);
			const treatment = await runWorker(batch, "c-treatment", "E8-C"); healthy(treatment);
			assert.equal(control.seedSha256, treatment.seedSha256); assert.notEqual(control.sessionFile, treatment.sessionFile);
			assert.equal(treatment.seedPreserved, true); assert.equal(treatment.compactionEntries.length, 1);
			assert.equal(treatment.snapshots[0].transport.calibration.anchorCount, 0);
			assert.equal(treatment.snapshots[0].transport.calibration.lastInvalidation, "compaction_completed");
			const requests = rows(batch, "reserved", "worker-c-treatment"), summaries = requests.filter(r => r.data.kind === "summary");
			assert.equal(summaries.length, 2, "fixture must exercise both native summary requests");
			assert.equal(batch.maxConcurrentResponses, 1);
			for (const row of requests) assert.equal(JSON.stringify(row.data.body).includes(CONTROL_ONLY), false, "CONTROL_ANSWER_CONTAMINATION");
			const native = terminals(treatment); assert.equal(native.length, requests.length);
			for (const row of requests) {
				const t = native.find(t => t.id === row.data.productionCallId); assert.ok(t?.usage);
				const raw = rows(batch, "terminal").find(t => t.data.id === row.data.id)!.data.rawUsage;
				assert.equal(t.usage.input + t.usage.cacheRead + t.usage.cacheWrite, raw.input);
			}
			const controlScore = score(answer(control)), treatmentScore = score(answer(treatment)); assert.ok(controlScore.passed && treatmentScore.passed);
			const provenance = { nativeSummary: treatment.compaction, structured: treatment.snapshots[0], recentMessages: treatment.recentAfterCompaction,
				finalProjection: requests.at(-1)!.data.body, summaryContentReview: "pending_review", systemRecovery: treatmentScore,
				causalAttributionToSummary: "not_established", semanticModelQualityVerified: false };
			await writeFile(path.join(output, "compaction-provenance.json"), JSON.stringify(provenance, null, 2));
			return { controlScore, treatmentScore, summaryRequests: summaries.map(s => s.data.id), perCallNativeTerminals: native,
				summaryContentReview: "pending_review", independentSeeds: true, rawHistoryPreserved: true, semanticModelQualityVerified: false };
		});
		await test("e8.r-source-cache-and-freshness", async () => {
			const r = await runWorker(batch, "r", "E8-R"); healthy(r);
			assert.equal(rows(batch, "reserved", "worker-r").length, 8); assert.equal(r.tools.length, 6);
			const first = toolJson(r, "r1-budget"), second = toolJson(r, "r2-budget"), third = toolJson(r, "r3-budget");
			const context = first.metrics.reads.lastContext.reads;
			assert.ok(context.sourceCache.hits >= 1); assert.equal(context.logicalReferences.checkpointSources, 1); assert.equal(context.logicalReferences.observationSources, 1);
			assert.equal(context.total.calls, 1); assert.equal(context.total.bytes, Buffer.byteLength(source("v1")));
			assert.ok(second.metrics.reads.lastContext.reads.total.calls >= 1, "new context must reread sources");
			assert.ok(r.tools.find((t: any) => t.id === "r3-read").result.content.some((p: any) => p.text?.includes("v2") && p.text?.includes("COBAL")));
			assert.equal(r.tools.find((t: any) => t.id === "r3-refresh").isError, false);
			assert.ok(answer(r).includes("v2")); assert.equal(rows(batch, "host-transition").length, 1);
			await writeFile(path.join(output, "read-metrics.json"), JSON.stringify({ first, second, third }, null, 2));
			return { firstContext: context, secondContext: second.metrics.reads.lastContext, thirdContext: third.metrics.reads.lastContext,
				metricsBoundary: "extension-budgeted-readFile-only-not-os-disk-io", sourceChangedSameSize: true, monetarySavingsEstablished: false };
		});
		assert.deepEqual(batch.errors, []);
	} finally { await batch.close(); }
	await test("e8.batch-accounting", async () => {
		const result = recover(path.join(batch.output, "broker.jsonl"));
		assert.equal(result.unsettled.length, 0); assert.deepEqual(result.stops, []);
		assert.equal(result.reservations, 14); assert.equal(result.httpReceived, result.reservations);
		return { reservations: result.reservations, loopbackHttp: result.httpReceived, maxConcurrentResponses: batch.maxConcurrentResponses, ...zeroExternal };
	});
	for (const scenario of ["c-one-summary", "c-lossy", "missing-cache", "missing-usage", "missing-output", "missing-input", "over-output", "http401", "http429", "http500", "redirect", "response-limit", "timeout", "cancel", "crash", "forbidden-path", "forbidden-tool"]) {
		await test("e8." + scenario, async () => {
			const broker = await start(scenario); let r: any;
			try { r = await runWorker(broker, scenario, scenario.startsWith("c-") ? "E8-C" : "E8-U"); }
			finally { await broker.close(); }
			const recovery = recover(path.join(broker.output, "broker.jsonl"));
			const captured = rows(broker, "reserved");
			assert.deepEqual(broker.errors, []);
			if (scenario.startsWith("c-")) {
				healthy(r); assert.equal(captured.filter(row => row.data.kind === "summary").length, scenario === "c-one-summary" ? 1 : 2);
				if (scenario === "c-lossy") {
					assert.ok(r.compaction.summary.includes(BAD_SUMMARY)); assert.equal(JSON.stringify(captured.at(-1)!.data.body).includes(BAD_SUMMARY), false);
					assert.ok(score(answer(r)).passed); // Correct scripted answer does NOT rescue a bad summary.
					return { summaryContentReview: "known_synthetic_failure", systemRecoveryScore: score(answer(r)), causalAttributionToSummary: false, summaryMayGrantAuthority: false };
				}
			} else if (scenario === "missing-cache") {
				healthy(r); assert.equal(captured.length, 2); assert.deepEqual(recovery.stops, []);
				for (const terminal of rows(broker, "terminal")) { assert.equal(terminal.data.rawUsage.cacheFieldPresent, false); assert.equal(terminal.data.rawUsage.cacheRead, null); assert.equal(terminal.data.rawUsage.actualCostUsd, null); }
			} else {
				assert.equal(captured.length, 1, "failed request must not be replayed or refunded"); assert.equal(recovery.httpReceived, 1);
				assert.ok(recovery.stops.length || recovery.unsettled.length, "safety fault must stop the batch");
				if (scenario === "timeout") assert.ok(recovery.stops.includes("request_timeout"));
				if (scenario === "cancel" || scenario === "crash") assert.ok(rows(broker, "sdk-visible-delta").length > 0, "first streamed chunk visible before interruption");
				if (scenario === "crash") {
					const cold = await coldRecover(path.join(broker.output, "broker.jsonl")); assert.equal(cold.newHttpRequests, 0); assert.equal(cold.networkAttempts, 0);
				}
				if (scenario === "forbidden-path") assert.equal(r.blockedTools.length, 1);
				if (scenario === "forbidden-tool") assert.ok(r.tools.every((t: any) => t.isError));
			}
			return { loopbackHttp: recovery.httpReceived, reservations: recovery.reservations, stopReasons: recovery.stops, unsettled: recovery.unsettled, ...zeroExternal };
		});
	}
	await test("e8.journal-no-replay-corruption-and-limits", async () => {
		const p = freezeRequestPolicy({ ...policy, limits: { ...policy.limits, maxHttpRequests: 1, maxTaskHttpRequests: 1 } });
		const file = path.join(output, "unsettled.jsonl"), j = new Journal(file, p);
		j.reserve("E8-U", 1024, 512, { phase: "ordinary" });
		assert.throws(() => j.reserve("E8-U", 1024, 512, {}), /request_limit/); j.close();
		const before = await readFile(file), recovered = recover(file); assert.equal(recovered.unsettled.length, 1); assert.equal(recovered.newHttpRequests, 0);
		const cold = await coldRecover(file); assert.equal(cold.unsettled.length, 1); assert.equal(cold.readOnly, true); assert.equal(cold.replayAllowed, false);
		assert.deepEqual(await readFile(file), before); assert.throws(() => new Journal(file, p), /EEXIST/);
		const corrupt = path.join(output, "corrupt.jsonl"); await writeFile(corrupt, before.toString().replace('"inputReservation":1024', '"inputReservation":1025'));
		assert.throws(() => recover(corrupt), /E8_JOURNAL_HASH/);
		const truncated = path.join(output, "truncated.jsonl"); await writeFile(truncated, before.subarray(0, before.length - 3)); assert.throws(() => recover(truncated), /INCOMPLETE/);
		const changed = path.join(output, "changed-while-open.jsonl"), open = new Journal(changed, policy);
		await writeFile(changed, "corrupt while open\n");
		assert.throws(() => open.reserve("E8-U", 1024, 512, {}), /E8_JOURNAL_CHANGED/); open.close();
		const reordered = new Journal(path.join(output, "reordered-terminals.jsonl"), policy);
		const a = reordered.reserve("E8-U", 1024, 512, {}), b = reordered.reserve("E8-U", 1024, 512, {});
		reordered.terminal(b, { status: "complete" }); reordered.terminal(a, { status: "complete" });
		assert.throws(() => reordered.terminal(a, { status: "complete" }), /E8_DUPLICATE_TERMINAL/);
		assert.throws(() => reordered.terminal("absent", { status: "complete" }), /E8_NO_RESERVATION/); reordered.close();
		assert.equal(recover(path.join(output, "reordered-terminals.jsonl")).unsettled.length, 0);
		for (const [name, input, outputTokens] of [["input", 65537, 2048], ["output", 1024, 2049]] as const) {
			const journal = new Journal(path.join(output, name + "-limit.jsonl"), policy);
			assert.throws(() => journal.reserve("E8-U", input, outputTokens, {}), /E8_POLICY/); journal.close();
		}
		assert.equal(rawUsage({ prompt_tokens: 20, completion_tokens: 2 }).cacheRead, null);
		return { unknownRecoveryReadOnly: true, noReplay: true, corruptionFailsClosed: true, reservationsNeverRefunded: true };
	});
} finally {
	const after = { src: await treeManifest(path.join(root, "src")), fixtures: await treeManifest(path.join(root, "fixtures")), evals: await treeManifest(path.join(root, "evals")) };
	const unchanged = JSON.stringify(before) === JSON.stringify(after);
	const summary = { version: 1, mode: "offline-only", ...zeroExternal, node: process.version, piSdk: "0.63.1", productionExtensionVersion: 24,
		output, sourceHashes, workers, cases, failures: cases.filter(c => !c.passed).length, sourceFixtureFrozenEvalsUnchanged: unchanged,
		actualCostUsd: null, realModelQualityVerified: false, livePrepareReady: false, desktopAcceptance: false };
	await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
	console.log(`E8 offline: ${cases.length} groups; ${summary.failures} failures; real model calls=0; evidence=${output}`);
	assert.ok(unchanged, "SOURCE_OR_FIXTURE_CHANGED"); assert.equal(summary.failures, 0);
}
