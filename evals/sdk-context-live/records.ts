import assert from "node:assert/strict";
import path from "node:path";
import { readBounded, sha256, treeManifest } from "../core/io.js";
import { createJournalScope } from "../core/request-journal.js";
import { validateSdkPrepared } from "../sdk-ablation/records.js";
import { emptyMetrics } from "../sdk-context/policy.js";
import { CONTENT_V1, CONTENT_V2, LIMITS, POLICY, PROFILES, REASONS, RUNS, SETTINGS, SOURCE, SOURCE_V2, TARGET, stagesFor, type Run, type Stage } from "./policy.js";
import { count, durableJson, exact, hash, hashes, readManifest, type Manifest } from "./manifest.js";
import type { StageResult, WorkerResult } from "./session.js";

export interface RecordRow {
	schemaVersion: 1; manifestSha256: string; run: Run; status: "pass" | "fail" | "unknown" | "blocked"; reasonCode: typeof REASONS[number];
	sourceStable: boolean; stages: WorkerResult[];
}
export const journalScope = createJournalScope(POLICY);
export function validateStage(value: unknown): StageResult {
	const r = exact(value, ["stage", "prepared", "settings", "inventory", "boundary", "zeroNetwork", "safe", "normalStop", "answer", "reads", "pages", "markerObserved", "currentSourceObserved", "writes", "staleWrites", "tools", "compactions", "inheritedCompactions", "fromHook", "reopened", "durableIntents", "finalFileSha256", "metrics", "operations", "bridge"]);
	assert.ok(["single", "seed", "resume"].includes(r.stage)); validateSdkPrepared(r.prepared);
	for (const name of ["settings", "inventory", "boundary", "zeroNetwork", "safe", "normalStop", "answer", "fromHook", "reopened", "markerObserved", "currentSourceObserved"]) assert.equal(typeof r[name], "boolean");
	for (const name of ["reads", "pages", "writes", "staleWrites", "tools", "compactions", "inheritedCompactions", "durableIntents"]) count(r[name], LIMITS.maxTaskTools + 1);
	assert.ok(r.staleWrites <= r.writes && r.durableIntents <= r.writes); assert.equal(r.reopened, r.stage === "resume");
	if (r.finalFileSha256 !== null) hash(r.finalFileSha256);
	exact(r.metrics, Object.keys(emptyMetrics())); for (const item of Object.values(r.metrics)) count(item, 256);
	exact(r.operations, ["intents", "results", "replayBlocks", "persistenceBlocks", "staleResults"]); for (const item of Object.values(r.operations)) count(item, 256);
	const b = exact(r.bridge, ["fetchAttempts", "retryBlocks", "receipts", "stopped"]); count(b.fetchAttempts, 64); count(b.retryBlocks, 64); assert.equal(typeof b.stopped, "boolean");
	assert.ok(Array.isArray(b.receipts) && b.receipts.length <= LIMITS.maxTaskHttpRequests + 1);
	for (let i = 0; i < b.receipts.length; i++) {
		const row = exact(b.receipts[i], ["id", "kind", "status", "input", "output", "cacheRead", "cacheWrite", "total"]);
		assert.equal(row.id, i + 1); assert.ok(["ordinary", "summary"].includes(row.kind)); assert.ok(["complete", "error", "aborted"].includes(row.status));
		for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"]) count(row[field]);
	}
	return r as StageResult;
}
export function validateWorker(value: unknown, prepareOnly = false): WorkerResult {
	const r = exact(value, ["prepared", "result", "before", "after"]); validateSdkPrepared(r.prepared); hashes(r.before); hashes(r.after);
	if (prepareOnly) assert.equal(r.result, null); else { validateStage(r.result); assert.deepEqual(r.prepared, r.result.prepared); }
	return r as WorkerResult;
}
export function boundary(stage: Stage, before: Record<string, string>, after: Record<string, string>) {
	return Object.entries(before).every(([name, hash]) => after[name] === hash) && Object.keys(after).every(name => name in before || name === ".pi/settings.json" && after[name] === sha256(JSON.stringify(SETTINGS) + "\n")
		|| stage === "resume" && name === TARGET && [sha256(CONTENT_V1), sha256(CONTENT_V2)].includes(after[name]));
}
export function stageSafe(s: StageResult) { return s.settings && s.inventory && s.boundary && s.zeroNetwork && s.safe && !s.bridge.stopped && !s.fromHook && s.normalStop; }
export function taskPassed(run: Run, values: WorkerResult[]) {
	const rows = values.map(item => item.result!); if (rows.length !== stagesFor(run).length || !rows.every(stageSafe) || !rows.every(s => s.answer)) return false;
	if (run.task === "bounded-read") return rows[0].reads >= 1 && rows[0].pages >= 1 && rows[0].markerObserved && rows[0].writes === 0 && rows[0].compactions === 0;
	const [seed, resume] = rows;
	return seed.reads >= 1 && seed.writes === 0 && seed.compactions === 1 && resume.reopened && resume.inheritedCompactions === 1 && resume.compactions === 0
		&& resume.reads >= 1 && resume.currentSourceObserved && resume.writes === 1 && resume.staleWrites === 0 && resume.finalFileSha256 === sha256(CONTENT_V2)
		&& (run.profile !== PROFILES[1] || resume.durableIntents === 1 && resume.metrics.refreshes >= 1 && resume.operations.intents === 1 && resume.operations.results === 1 && resume.operations.persistenceBlocks === 0);
}
export function validateRecord(value: unknown, manifest: Manifest, manifestSha: string, run: Run): RecordRow {
	const r = exact(value, ["schemaVersion", "manifestSha256", "run", "status", "reasonCode", "sourceStable", "stages"]);
	assert.equal(r.schemaVersion, 1); assert.equal(r.manifestSha256, manifestSha); assert.deepEqual(r.run, run);
	assert.ok(["pass", "fail", "unknown", "blocked"].includes(r.status)); assert.ok(REASONS.includes(r.reasonCode)); assert.equal(typeof r.sourceStable, "boolean");
	assert.ok(Array.isArray(r.stages) && r.stages.length <= stagesFor(run).length);
	let prior: WorkerResult | undefined;
	for (let i = 0; i < r.stages.length; i++) {
		const item = validateWorker(r.stages[i]), stage = stagesFor(run)[i], s = item.result!;
		assert.equal(s.stage, stage); assert.deepEqual(item.prepared, manifest.prepared[run.runId][stage]);
		if (run.profile === PROFILES[0]) for (const n of Object.values(s.operations)) assert.equal(n, 0, "S3L_CAPABILITY_LEAK");
		assert.deepEqual(item.before, prior ? { ...prior.after, [SOURCE]: sha256(SOURCE_V2) } : manifest.fixture.files);
		assert.equal(s.boundary, boundary(stage, item.before, item.after)); assert.equal(s.finalFileSha256, item.after[TARGET] ?? null); prior = item;
	}
	assert.ok(r.stages.reduce((n: number, v: WorkerResult) => n + v.result!.tools, 0) <= LIMITS.maxTaskTools + 1);
	if (r.status === "pass" || r.status === "fail") {
		assert.ok(r.sourceStable && r.stages.length === stagesFor(run).length && r.stages.every((v: WorkerResult) => stageSafe(v.result!)));
		assert.equal(r.status === "pass", taskPassed(run, r.stages)); assert.equal(r.reasonCode, r.status === "pass" ? "PASS" : "TASK_FAILED");
	} else if (r.status === "blocked") { assert.equal(r.reasonCode, "BATCH_STOPPED"); assert.equal(r.stages.length, 0); assert.equal(r.sourceStable, false); }
	else assert.ok(["WORKER_UNKNOWN", "SOURCE_DRIFT", "SAFETY_STOP"].includes(r.reasonCode));
	return r as RecordRow;
}
export async function seal(directory: string) {
	const { manifestSha256 } = await readManifest(directory), files = await treeManifest(directory); delete files["manifest.json"];
	await durableJson(path.join(directory, "index.json"), { schemaVersion: 1, manifestSha256, files });
}

/** Read-only recovery never starts workers, reads credentials, or refunds a reservation. */
export async function recover(directory: string) {
	const { manifest, manifestSha256 } = await readManifest(directory), files = await treeManifest(directory);
	const sealed = "index.json" in files;
	if (sealed) {
		const index = exact(JSON.parse(await readBounded(path.join(directory, "index.json"))), ["schemaVersion", "manifestSha256", "files"]);
		assert.equal(index.schemaVersion, 1); assert.equal(index.manifestSha256, manifestSha256); hashes(index.files);
		const actual = { ...files }; for (const file of ["manifest.json", "index.json", "aggregate.json"]) delete actual[file]; assert.deepEqual(actual, index.files, "S3L_EVIDENCE_DRIFT");
	}
	for (const file of Object.keys(files)) assert.ok(["manifest.json", "index.json", "aggregate.json"].includes(file) || /^journal\/(claim|index|event-\d{6})\.json$/.test(file)
		|| /^requests\/request-\d{6}\.json$/.test(file) || RUNS.some(run => file === `raw/${run.runId}.json`), "S3L_EXTRA_ARTIFACT");
	const journal = "journal/claim.json" in files ? await journalScope.recover(path.join(directory, "journal"), manifestSha256) : null;
	if (journal) assert.equal(journal.mode, manifest.mode);
	const bindings: Array<{ ordinal: number; offerId: number; kind: "ordinary" | "summary"; taskId: string; stage: Stage }> = [];
	for (const file of Object.keys(files).filter(name => name.startsWith("requests/")).sort()) {
		const b = exact(JSON.parse(await readBounded(path.join(directory, file))), ["schemaVersion", "ordinal", "offerId", "kind", "requestSha256", "taskId", "stage"]);
		assert.equal(b.schemaVersion, 1); assert.equal(b.ordinal, bindings.length + 1); assert.equal(file, `requests/request-${String(b.ordinal).padStart(6, "0")}.json`);
		const reserved = journal?.reservations[b.ordinal - 1]; assert.ok(reserved); assert.equal(reserved.taskId, b.taskId); assert.equal(reserved.requestSha256, b.requestSha256);
		assert.ok(["ordinary", "summary"].includes(b.kind)); assert.equal(b.offerId, b.ordinal); assert.equal(reserved.invocationId, b.ordinal);
		const run = RUNS.find(run => run.runId === b.taskId)!; assert.ok(run && stagesFor(run).includes(b.stage)); if (b.kind === "summary") assert.equal(b.stage, "seed");
		bindings.push(b as any);
	}
	if (sealed) { assert.ok(journal?.finalized); assert.equal(bindings.length, journal.reserved); }
	let stopped = false;
	const rows = [];
	for (const run of RUNS) {
		const file = `raw/${run.runId}.json`, record = file in files ? validateRecord(JSON.parse(await readBounded(path.join(directory, file))), manifest, manifestSha256, run) : null;
		if (sealed) assert.ok(record);
		if (record && stopped) assert.equal(record.status, "blocked"); if (record?.status === "unknown") stopped = true;
		const requests = journal?.reservations.filter(r => r.taskId === run.runId) ?? [];
		if (record?.status === "blocked") assert.equal(requests.length, 0);
		for (const stage of record?.stages ?? []) {
			const bound = bindings.filter(b => b.taskId === run.runId && b.stage === stage.result!.stage), receipts = stage.result!.bridge.receipts;
			if (stageSafe(stage.result!)) assert.equal(bound.length, receipts.length);
			for (let i = 0; i < bound.length; i++) {
				const receipt = receipts[i], settlement = journal!.reservations[bound[i].ordinal - 1].settlement; assert.ok(receipt); assert.equal(receipt.kind, bound[i].kind);
				if (settlement?.status === "complete") {
					assert.equal(receipt.status, "complete");
					// Pinned SDK adds reasoning to output and recomputes total. Raw
					// provider total may use different semantics; keep both views.
					assert.equal(receipt.output, settlement.usage!.completionTokens! + (settlement.usage!.reasoningTokens ?? 0));
					assert.equal(receipt.cacheRead, settlement.usage!.cachedTokens ?? 0); assert.equal(receipt.cacheWrite, 0);
					assert.equal(receipt.input + receipt.cacheRead, settlement.usage!.promptTokens); assert.equal(receipt.total, receipt.input + receipt.cacheRead + receipt.output);
				} else assert.notEqual(receipt.status, "complete");
			}
		}
		if (record && ["pass", "fail"].includes(record.status)) assert.ok(requests.length > 0 && requests.every(r => r.effectiveStatus === "complete"));
		const sum = (field: "promptTokens" | "completionTokens" | "totalTokens" | "cachedTokens" | "reasoningTokens") => requests.length > 0 && requests.every(r => r.settlement?.status === "complete" && r.settlement.usage![field] !== null) ? requests.reduce((n, r) => n + r.settlement!.usage![field]!, 0) : null;
		const parsedUsage = { input: sum("promptTokens"), output: sum("completionTokens"), total: sum("totalTokens"), cached: sum("cachedTokens"), reasoning: sum("reasoningTokens") };
		const s = record?.stages.map(v => v.result!) ?? [];
		const receipts = s.flatMap(s => s.bridge.receipts), sdkSum = (field: "input" | "output" | "total" | "cacheRead" | "cacheWrite") => receipts.length === requests.length && receipts.length > 0 && receipts.every(r => r.status === "complete") ? receipts.reduce((n, r) => n + r[field], 0) : null;
		rows.push({ run, status: sealed ? record!.status : "unknown", reasonCode: record?.reasonCode ?? "WORKER_UNKNOWN", requests: requests.length,
			ordinary: bindings.filter(b => b.taskId === run.runId && b.kind === "ordinary").length, summaries: bindings.filter(b => b.taskId === run.runId && b.kind === "summary").length,
			parsedUsage, providerActualUsage: manifest.mode === "live" ? parsedUsage : null, costUsd: null, sdkUsage: { input: sdkSum("input"), output: sdkSum("output"), total: sdkSum("total"), cacheRead: sdkSum("cacheRead"), cacheWrite: sdkSum("cacheWrite") },
			tools: s.length ? s.reduce((n, r) => n + r.tools, 0) : null, writes: s.length ? s.reduce((n, r) => n + r.writes, 0) : null, staleWrites: s.length ? s.reduce((n, r) => n + r.staleWrites, 0) : null,
			nativeCompactions: s.length ? s.reduce((n, r) => n + r.compactions, 0) : null, reopened: s.some(r => r.reopened), durableIntents: s.length ? s.reduce((n, r) => n + r.durableIntents, 0) : null,
			staleWriteBlocks: s.length ? s.reduce((n, r) => n + r.metrics.staleWriteBlocks, 0) : null, durableGateBlocks: s.length ? s.reduce((n, r) => n + r.operations.replayBlocks, 0) : null });
	}
	const complete = sealed && journal?.canPass && rows.every(r => r.status === "pass" || r.status === "fail");
	return { schemaVersion: 1, kind: "sdk-context-live-aggregate", manifestSha256, mode: manifest.mode, simulation: manifest.simulation,
		status: !journal ? "prepared" : !complete ? "incomplete" : rows.every(r => r.status === "pass") ? "pass" : "completed-with-failures",
		sealed, realHttpDispatches: manifest.mode === "live" ? journal?.dispatchAttempted ?? 0 : 0, simulatedHttpDispatches: manifest.mode === "dry-run" ? journal?.dispatchAttempted ?? 0 : 0,
		sharedReserved: journal?.reserved ?? 0, inputReserved: journal?.inputReserved ?? 0, outputReserved: journal?.outputReserved ?? 0, unknownRequests: journal?.unknown ?? 0, pendingRequests: journal?.pending ?? 0,
		ordinary: bindings.filter(b => b.kind === "ordinary").length, summaries: bindings.filter(b => b.kind === "summary").length, actualCostUsd: null, rows };
}
