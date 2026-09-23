import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertInside, digest, readBounded, sha256 } from "../core/io.js";
import { createJournalScope } from "../core/request-journal.js";
import { validatePilotAnswerDiagnostic } from "../pilot/answer-diagnostics.js";
import { emptySdkMetrics } from "../sdk-ablation/extensions.js";
import { SDK_CONTENT } from "../sdk-ablation/policy.js";
import { validateSdkPrepared } from "../sdk-ablation/records.js";
import { count, durableJson, exact, hash, readManifest, type SdkLiveManifest } from "./manifest.js";
import { LIVE_CHECKS, LIVE_LIMITS, LIVE_POLICY, LIVE_REASONS, LIVE_RUNS, type LiveRun } from "./policy.js";
import type { LiveSdkSummary } from "./session.js";

export const journalScope = createJournalScope(LIVE_POLICY);
export interface SdkLiveRecord {
	schemaVersion: 1; manifestSha256: string; run: LiveRun; status: "pass" | "fail" | "unknown" | "blocked";
	reasonCode: typeof LIVE_REASONS[number]; checks: { source: boolean; fixture: boolean; prepared: boolean; boundary: boolean }; summary: LiveSdkSummary | null;
}
export function validateSummary(value: unknown, run: LiveRun): LiveSdkSummary {
	const s = exact(value, ["status","reasonCode","checks","prepared","metrics","sdkUsage","answerCodes","finalFileSha256"]);
	assert.ok(["pass","fail","unknown"].includes(s.status)); assert.ok(LIVE_REASONS.includes(s.reasonCode)); validateSdkPrepared(s.prepared);
	exact(s.checks, LIVE_CHECKS); for (const v of Object.values(s.checks)) assert.equal(typeof v, "boolean");
	exact(s.metrics, [...Object.keys(emptySdkMetrics()),"invocations","completions","tools","writeDispatches","duplicateWriteDispatches","ackLosses"]);
	for (const v of Object.values(s.metrics)) count(v);
	count(s.metrics.invocations, LIVE_LIMITS.maxTaskHttpRequests); count(s.metrics.completions, s.metrics.invocations);
	count(s.metrics.tools, LIVE_LIMITS.maxTaskTools + 1); count(s.metrics.writeDispatches, LIVE_LIMITS.maxTaskTools); count(s.metrics.ackLosses, 1);
	assert.equal(s.metrics.duplicateWriteDispatches, Math.max(0, s.metrics.writeDispatches - 1));
	if (run.profile === "sdk-b0-safety-fixed") for (const key of Object.keys(emptySdkMetrics())) assert.equal(s.metrics[key], 0, "S2_CAPABILITY_LEAK");
	if (s.sdkUsage !== null) { exact(s.sdkUsage, ["inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","totalTokens"]); for (const v of Object.values(s.sdkUsage)) count(v); assert.equal(s.metrics.completions, s.metrics.invocations); }
	const diagnosis = validatePilotAnswerDiagnostic({ schemaVersion: 1, taskId: run.taskId === "P5A-READ-001" ? "P5P-READ-001" : "P5P-WRITE-001", codes: s.answerCodes }, run.taskId === "P5A-READ-001" ? "P5P-READ-001" : "P5P-WRITE-001");
	assert.equal(s.checks.answer, diagnosis.codes.length === 1 && diagnosis.codes[0] === "ANSWER_OK");
	if (s.finalFileSha256 !== null) hash(s.finalFileSha256);
	assert.equal(s.status === "pass", s.reasonCode === "PASS"); assert.equal(s.status === "fail", s.reasonCode === "TASK_FAILED");
	if (s.status !== "unknown") assert.ok(s.checks.boundary && s.checks.limits && s.sdkUsage !== null);
	if (s.status === "pass") {
		assert.ok(Object.values(s.checks).every(Boolean)); assert.ok(s.metrics.invocations >= 2 && s.metrics.tools >= 1);
		assert.equal(s.metrics.writeDispatches, run.taskId === "P5A-READ-001" ? 0 : 1); assert.equal(s.metrics.ackLosses, run.taskId === "P5A-READ-001" ? 0 : 1);
		assert.equal(s.finalFileSha256, run.taskId === "P5A-READ-001" ? null : sha256(SDK_CONTENT));
		if (run.profile === "sdk-b1-reliability") { assert.equal(s.metrics.agentStarts, 1); assert.equal(s.metrics.runStops, 1); }
	}
	return s as LiveSdkSummary;
}
export function validateRecord(value: unknown, manifest: SdkLiveManifest, manifestSha256: string, run: LiveRun): SdkLiveRecord {
	const r = exact(value, ["schemaVersion","manifestSha256","run","status","reasonCode","checks","summary"]);
	assert.equal(r.schemaVersion, 1); assert.equal(r.manifestSha256, manifestSha256); assert.deepEqual(r.run, run);
	assert.ok(["pass","fail","unknown","blocked"].includes(r.status)); assert.ok(LIVE_REASONS.includes(r.reasonCode));
	exact(r.checks, ["source","fixture","prepared","boundary"]); for (const v of Object.values(r.checks)) assert.equal(typeof v, "boolean");
	if (r.summary !== null) { validateSummary(r.summary, run); assert.equal(digest(r.summary.prepared), digest(manifest.prepared[run.runId])); }
	if (r.status === "blocked") assert.ok(r.reasonCode === "BATCH_STOPPED" && r.summary === null && Object.values(r.checks).every(v => v === false));
	if (r.status === "pass" || r.status === "fail") { assert.ok(r.summary && Object.values(r.checks).every(Boolean)); assert.equal(r.status, r.summary.status); assert.equal(r.reasonCode, r.summary.reasonCode); }
	else assert.notEqual(r.reasonCode, "PASS");
	return r as SdkLiveRecord;
}
export async function sealResults(directory: string) {
	const { manifest, manifestSha256 } = await readManifest(directory), entries = [];
	const journal = await journalScope.recover(path.join(directory, "journal"), manifestSha256); assert.ok(journal.finalized);
	for (const run of manifest.runs) { const file = `raw/${run.runId}.json`, text = await readBounded(path.join(directory, file));
		validateRecord(JSON.parse(text), manifest, manifestSha256, run); entries.push({ runId: run.runId, file, sha256: sha256(text) }); }
	await durableJson(path.join(directory, "result-index.json"), { schemaVersion: 1, kind: "sdk-ablation-live-index", manifestSha256, entries });
}
const sum = (values: (number | null | undefined)[]) => values.length && values.every(v => typeof v === "number") ? (values as number[]).reduce((a,b) => a+b, 0) : null;

/** Read only. Missing receipts are unknown, never inferred zero writes or success. */
export async function recoverResults(directory: string) {
	const { manifest, manifestSha256 } = await readManifest(directory);
	const names = await readdir(directory); assert.ok(names.every(name => ["manifest.json","journal","raw","result-index.json","aggregate.json"].includes(name)));
	const journal = names.includes("journal") ? await journalScope.recover(path.join(directory, "journal"), manifestSha256) : null;
	if (journal) assert.equal(journal.mode, manifest.mode);
	const rawNames = names.includes("raw") ? (await assertInside(directory, path.join(directory, "raw")), await readdir(path.join(directory, "raw"))) : [];
	assert.ok(rawNames.every(name => manifest.runs.some(run => name === `${run.runId}.json`)), "S2_EXTRA_RAW");
	const rows = [], entries = []; let mustBlock = false, lastOrdinal = 0;
	for (const run of manifest.runs) {
		const file = `raw/${run.runId}.json`, present = rawNames.includes(`${run.runId}.json`);
		const text = present ? await readBounded(path.join(directory, file), 128000) : null;
		const record = text ? validateRecord(JSON.parse(text), manifest, manifestSha256, run) : null;
		if (text) entries.push({ runId: run.runId, file, sha256: sha256(text) });
		const reservations = journal?.reservations.filter(item => item.taskId === run.runId) ?? [];
		for (const r of reservations) { assert.ok(r.ordinal > lastOrdinal, "S2_REQUEST_ORDER"); lastOrdinal = r.ordinal; assert.equal(r.outputReserved, LIVE_LIMITS.maxOutputTokens);
			if (r.settlement?.status === "complete") { count(r.settlement.usage!.promptTokens, LIVE_LIMITS.maxInputTokens); count(r.settlement.usage!.completionTokens, LIVE_LIMITS.maxOutputTokens); } }
		if (record?.status === "blocked" || mustBlock) assert.equal(reservations.length, 0, "S2_DISPATCH_AFTER_STOP");
		if (mustBlock && record) assert.equal(record.status, "blocked", "S2_RESULT_AFTER_STOP");
		if (record?.status === "pass" || record?.status === "fail") {
			assert.ok(journal && reservations.length > 0 && reservations.every(r => r.effectiveStatus === "complete"), "S2_RECEIPT_MISSING");
			assert.equal(record.summary!.metrics.invocations, reservations.length); assert.equal(record.summary!.metrics.completions, reservations.length);
		}
		if (record?.status === "unknown" || record?.status === "blocked" || !record) mustBlock = true;
		const usage = reservations.map(r => r.settlement?.usage);
		rows.push({ ...run, status: record?.status ?? "unknown", reasonCode: record?.reasonCode ?? "WORKER_UNKNOWN", answerCodes: record?.summary?.answerCodes ?? ["ANSWER_NOT_EVALUATED"],
			requestsReserved: reservations.length, dispatchAttempted: reservations.filter(r => r.settlement?.dispatchAttempted ?? true).length,
			unknownDispatches: reservations.filter(r => r.effectiveStatus === "unknown").length,
			inputEstimated: reservations.reduce((n,r) => n + r.inputEstimate,0), outputReserved: reservations.reduce((n,r) => n+r.outputReserved,0),
			providerUsage: { source: manifest.mode === "live" ? "provider" : "synthetic", promptTokens: sum(usage.map(u=>u?.promptTokens)), completionTokens: sum(usage.map(u=>u?.completionTokens)),
				totalTokens: sum(usage.map(u=>u?.totalTokens)), cachedTokens: sum(usage.map(u=>u?.cachedTokens)), reasoningTokens: sum(usage.map(u=>u?.reasoningTokens)), costUsd: null },
			sdkUsage: record?.summary?.sdkUsage ?? null, metrics: record?.summary?.metrics ?? null });
	}
	const indexed = names.includes("result-index.json");
	if (indexed) { assert.equal(entries.length, manifest.runs.length, "S2_RECORDS_MISSING"); assert.ok(journal?.finalized);
		assert.deepEqual(JSON.parse(await readBounded(path.join(directory,"result-index.json"))), { schemaVersion:1, kind:"sdk-ablation-live-index", manifestSha256, entries }); }
	return { schemaVersion: 1, kind: "sdk-ablation-live-aggregate", batchId: manifest.batchId, mode: manifest.mode, simulation: manifest.simulation, manifestSha256, indexed,
		status: !journal && rawNames.length === 0 ? "prepared" : !indexed || !journal?.canPass || rows.some(r=>!["pass","fail"].includes(r.status)) ? "incomplete" : rows.every(r=>r.status === "pass") ? "pass" : "completed-with-failures",
		realHttpDispatches: manifest.mode === "live" ? journal?.dispatchAttempted ?? 0 : 0, simulatedHttpDispatches: manifest.mode === "dry-run" ? journal?.dispatchAttempted ?? 0 : 0,
		possibleUnknownDispatches: journal?.unknown ?? 0, rows };
}
