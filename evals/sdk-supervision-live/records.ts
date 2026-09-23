import assert from "node:assert/strict";
import path from "node:path";
import { readBounded, sha256, treeManifest } from "../core/io.js";
import { createJournalScope } from "../core/request-journal.js";
import { emptyMetrics as baseMetrics } from "../sdk-context/policy.js";
import { FEATURES, LIMITS, POLICY, REASONS, RUNS, SETTINGS, TARGET, VALID, emptyMetrics, policyForSchema, type SchemaVersion, type Run } from "./policy.js";
import type { RequestLimits } from "../core/request-policy.js";
import { count, durableJson, exact, hash, hashes, readManifest, validatePrepared, validateCalibration, type Manifest } from "./manifest.js";
import type { Evidence, WorkerResult } from "./session.js";
import { validateTransportDiagnostic, type TransportDiagnostic } from "./diagnostics.js";

export interface RecordRow { schemaVersion: SchemaVersion; manifestSha256: string; run: Run; status: "pass" | "fail" | "unknown" | "blocked";
  reasonCode: typeof REASONS[number]; sourceStable: boolean; stages: WorkerResult[]; transport?: TransportDiagnostic | null; }
export const journalScope = createJournalScope(POLICY);
export function validateStage(value: unknown, limits: Readonly<RequestLimits> = LIMITS): Evidence {
  const r = exact(value, ["settings", "inventory", "boundary", "zeroNetwork", "safe", "normalStop", "answer", "reads", "markerObserved", "proposals", "tools", "writes", "verifications", "durableIntents", "finalFileSha256", "receipt", "verificationCurrent", "compactions", "automaticCompactions", "fromHook", "historyIntact", "currentInputCopies", "restoredInput", "persisted", "supervisor", "metrics", "base", "operations", "bridge"]);
  for (const k of ["settings", "inventory", "boundary", "zeroNetwork", "safe", "normalStop", "markerObserved", "verificationCurrent", "fromHook", "historyIntact", "restoredInput", "persisted"]) assert.equal(typeof r[k], "boolean");
  for (const k of ["reads", "proposals", "tools", "writes", "verifications", "durableIntents"]) count(r[k], limits.maxTaskTools + 1);
  for (const k of ["compactions", "automaticCompactions", "currentInputCopies"]) count(r[k], 1);
  assert.ok(r.tools <= r.proposals && r.writes <= r.tools && r.verifications <= r.tools && r.durableIntents === r.writes);
  assert.ok(["candidate_ready", "blocked", "marker", "other", "none"].includes(r.answer)); hash(r.finalFileSha256);
  if (r.receipt !== null) { const v = exact(r.receipt, ["artifactSha256", "passed", "full", "reason"]); hash(v.artifactSha256); assert.equal(typeof v.passed, "boolean"); assert.equal(v.full, true);
    assert.ok(["PASS", "CONTENT_MISMATCH", "PREREQUISITE_MISSING"].includes(v.reason)); assert.equal(v.passed, v.reason === "PASS"); assert.ok(r.verifications > 0); }
  assert.equal(r.verificationCurrent, !!r.receipt?.passed && r.receipt.full && r.receipt.artifactSha256 === r.finalFileSha256 && r.finalFileSha256 === sha256(VALID));
  if (r.supervisor !== null) { const s = exact(r.supervisor, ["state", "reasonCode", "userAccepted"]); assert.equal(s.userAccepted, false);
    assert.ok(["RUNNING", "BLOCKED_USER", "BLOCKED_PREREQUISITE", "NO_PROGRESS", "CANCELLED", "FAILED", "COMPLETED_CANDIDATE"].includes(s.state));
    if (s.reasonCode !== null) assert.match(s.reasonCode, /^[A-Z0-9_]{1,64}$/); }
  exact(r.metrics, Object.keys(emptyMetrics()));
  for (const [k, v] of Object.entries(r.metrics)) if (["historyIntact", "persistenceFailed"].includes(k)) assert.equal(typeof v, "boolean"); else count(v, k.startsWith("projected") ? limits.maxInputBytes + 6144 : 256);
  exact(r.base, Object.keys(baseMetrics())); for (const v of Object.values(r.base)) count(v, 256);
  exact(r.operations, ["intents", "results", "replayBlocks", "persistenceBlocks", "staleResults"]); for (const v of Object.values(r.operations)) count(v, 256);
  const b = exact(r.bridge, ["fetchAttempts", "retryBlocks", "receipts", "stopped"]); count(b.fetchAttempts, 16); count(b.retryBlocks, 16); assert.equal(typeof b.stopped, "boolean");
  assert.ok(Array.isArray(b.receipts) && b.receipts.length <= limits.maxTaskHttpRequests + 3); let request = 0;
  for (let i = 0; i < b.receipts.length; i++) { const row = exact(b.receipts[i], ["id", "requestId", "kind", "status", "payloadBytes", "input", "output", "cacheRead", "cacheWrite", "total"]);
    assert.equal(row.id, i + 1); if (row.requestId !== null) assert.equal(row.requestId, ++request);
    assert.ok(["ordinary", "summary"].includes(row.kind)); assert.ok(["complete", "error", "aborted"].includes(row.status));
    if (row.payloadBytes !== null) count(row.payloadBytes, limits.maxInputBytes + 1); for (const f of ["input", "output", "cacheRead", "cacheWrite", "total"]) count(row[f]);
    if (row.requestId === null) assert.notEqual(row.status, "complete");
  }
  return r as Evidence;
}
export function validateWorker(value: unknown, prepareOnly = false, limits: Readonly<RequestLimits> = LIMITS): WorkerResult {
  const r = exact(value, ["prepared", "calibration", "result", "before", "after"]); validatePrepared(r.prepared); hashes(r.before); hashes(r.after);
  if (prepareOnly) { assert.equal(r.result, null); if (r.calibration !== null) validateCalibration(r.calibration); }
  else { validateStage(r.result, limits); assert.equal(r.calibration, null); }
  return r as WorkerResult;
}
export function boundary(run: Run, before: Record<string, string>, after: Record<string, string>) {
  return Object.entries(before).every(([name, hash]) => after[name] === hash || name === TARGET && run.task !== "pressure-recover" && !!after[name])
    && Object.keys(after).every(name => name in before || name === ".pi/settings.json" && after[name] === sha256(JSON.stringify(SETTINGS) + "\n"));
}
export function stageSafe(s: Evidence) {
  return s.settings && s.inventory && s.boundary && s.zeroNetwork && s.safe && !s.bridge.stopped && !s.fromHook && !s.automaticCompactions
    && s.historyIntact && s.metrics.historyIntact && !s.metrics.persistenceFailed && s.persisted && s.currentInputCopies <= 1;
}
export function business(run: Run, s: Evidence | null) {
  if (!s || !stageSafe(s)) return "unknown";
  if (s.supervisor?.state === "NO_PROGRESS") return "no_progress_stopped";
  if (s.base.budgetBlocks || s.metrics.handledInputs) return "budget_blocked";
  if (run.task === "missing-prerequisite" && s.normalStop && s.answer === "blocked" && s.receipt?.reason === "PREREQUISITE_MISSING") return "blocked_prerequisite";
  if (run.task === "pressure-recover" && s.normalStop && s.answer === "marker" && s.markerObserved && s.reads > 0 && s.writes === 0) return "read_only_answer";
  if (run.task === "verify-revise" && s.normalStop && s.answer === "candidate_ready" && s.verificationCurrent && s.writes > 0 && s.reads > 0
    && (!FEATURES(run.profile).supervisor || s.supervisor?.state === "COMPLETED_CANDIDATE")) return "verified_candidate";
  if (s.supervisor?.state === "BLOCKED_PREREQUISITE") return "verification_required";
  return "unverified_final_answer";
}
export function taskPassed(run: Run, values: WorkerResult[]) {
  if (values.length !== 1 || !stageSafe(values[0].result!)) return false; const s = values[0].result!, b = business(run, s);
  if (s.currentInputCopies !== 1) return false;
  if (run.task === "verify-revise") return b === "verified_candidate";
  if (run.task === "missing-prerequisite") return (b === "blocked_prerequisite" || b === "no_progress_stopped" && s.receipt?.reason === "PREREQUISITE_MISSING") && s.writes === 0;
  return b === "read_only_answer" && (!FEATURES(run.profile).maintenance || s.compactions === 1 && s.metrics.compactAttempts === 1);
}
export function validateRecord(value: unknown, manifest: Manifest, manifestSha: string, run: Run): RecordRow {
  const r = exact(value, ["schemaVersion", "manifestSha256", "run", "status", "reasonCode", "sourceStable", "stages", ...(manifest.schemaVersion >= 2 ? ["transport"] : [])]);
  assert.equal(r.schemaVersion, manifest.schemaVersion); assert.equal(r.manifestSha256, manifestSha); assert.deepEqual(r.run, run); assert.ok(["pass", "fail", "unknown", "blocked"].includes(r.status));
  assert.ok(REASONS.includes(r.reasonCode)); assert.equal(typeof r.sourceStable, "boolean"); assert.ok(Array.isArray(r.stages) && r.stages.length <= 1);
  for (const value of r.stages) { const item = validateWorker(value, false, manifest.limits), s = item.result!;
    assert.deepEqual(item.prepared, manifest.prepared[run.runId]); assert.deepEqual(item.before, manifest.fixture.files[run.task]);
    assert.equal(s.boundary, boundary(run, item.before, item.after)); assert.equal(s.finalFileSha256, item.after[TARGET]);
    const f = FEATURES(run.profile);
    if (!f.supervisor) { assert.equal(s.supervisor, null); for (const k of ["starts", "snapshots", "verificationEvents", "toolBlocks", "terminalFences"] as const) assert.equal(s.metrics[k], 0); }
    if (!f.maintenance) { assert.equal(s.compactions, 0); for (const k of ["maintenanceInputs", "preflightTrimmed", "contextTrimmed", "compactAttempts", "compactErrors", "handledInputs", "projectedBefore", "projectedAfter"] as const) assert.equal(s.metrics[k], 0); }
    if (run.task !== "pressure-recover") assert.equal(s.compactions, 0);
    if (s.supervisor?.state === "COMPLETED_CANDIDATE" && run.task !== "pressure-recover") assert.ok(s.verificationCurrent, "S4L_UNVERIFIED_COMPLETION");
    if (s.receipt?.reason === "PASS") assert.notEqual(run.task, "missing-prerequisite");
  }
  if (["pass", "fail"].includes(r.status)) { assert.ok(r.sourceStable && r.stages.length === 1 && stageSafe(r.stages[0].result));
    assert.equal(r.status === "pass", taskPassed(run, r.stages)); assert.equal(r.reasonCode, r.status === "pass" ? "PASS" : "TASK_FAILED"); }
  else if (r.status === "blocked") { assert.equal(r.reasonCode, "BATCH_STOPPED"); assert.equal(r.stages.length, 0); assert.equal(r.sourceStable, false); }
  else assert.ok(["WORKER_UNKNOWN", "SOURCE_DRIFT", "SAFETY_STOP"].includes(r.reasonCode));
  if (manifest.schemaVersion >= 2) {
    if (r.status === "blocked") assert.equal(r.transport, null);
    else {
      const transport = validateTransportDiagnostic(r.transport, manifest.limits);
      if (["pass", "fail"].includes(r.status)) assert.equal(transport.stopCode, null);
      for (const offer of transport.offers) if (offer.kind === "summary") assert.ok(FEATURES(run.profile).maintenance && run.task === "pressure-recover");
      for (const stage of r.stages as WorkerResult[]) {
        const receipts = stage.result!.bridge.receipts.filter(receipt => receipt.requestId !== null);
        assert.equal(receipts.length, transport.offers.length, "S4L_OFFER_RECEIPT_COUNT");
        for (const offer of transport.offers) {
          const receipt = receipts.find(item => item.requestId === offer.id)!; assert.ok(receipt);
          assert.equal(receipt.kind, offer.kind); assert.equal(receipt.payloadBytes, offer.payloadBytes);
          if (!offer.returned) assert.notEqual(receipt.status, "complete");
        }
      }
    }
  }
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
		const actual = { ...files }; for (const file of ["manifest.json", "index.json", "aggregate.json"]) delete actual[file]; assert.deepEqual(actual, index.files, "S4L_EVIDENCE_DRIFT");
	}
	for (const file of Object.keys(files)) assert.ok(["manifest.json", "index.json", "aggregate.json"].includes(file) || /^journal\/(claim|index|event-\d{6})\.json$/.test(file)
		|| /^requests\/request-\d{6}\.json$/.test(file) || RUNS.some(run => file === `raw/${run.runId}.json`), "S4L_EXTRA_ARTIFACT");
	const scope = createJournalScope(policyForSchema(manifest.schemaVersion));
	const journal = "journal/claim.json" in files ? await scope.recover(path.join(directory, "journal"), manifestSha256) : null;
	if (journal) assert.equal(journal.mode, manifest.mode);
	const bindings: Array<{ ordinal: number; offerId: number; kind: "ordinary" | "summary"; taskId: string; stage: "single" }> = [];
	for (const file of Object.keys(files).filter(name => name.startsWith("requests/")).sort()) {
		const b = exact(JSON.parse(await readBounded(path.join(directory, file))), ["schemaVersion", "ordinal", "offerId", "kind", "requestSha256", "taskId", "stage"]);
		assert.equal(b.schemaVersion, 1); assert.equal(b.ordinal, bindings.length + 1); assert.equal(file, `requests/request-${String(b.ordinal).padStart(6, "0")}.json`);
		const reserved = journal?.reservations[b.ordinal - 1]; assert.ok(reserved); assert.equal(reserved.taskId, b.taskId); assert.equal(reserved.requestSha256, b.requestSha256);
		assert.ok(["ordinary", "summary"].includes(b.kind)); assert.equal(b.offerId, b.ordinal); assert.equal(reserved.invocationId, b.ordinal);
		const run = RUNS.find(run => run.runId === b.taskId)!; assert.ok(run); assert.equal(b.stage, "single"); if (b.kind === "summary") assert.ok(FEATURES(run.profile).maintenance && run.task === "pressure-recover");
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
		const transport = record?.transport;
		if (transport) {
			for (const request of requests) assert.ok(transport.offers.some(o => o.reservationOrdinal === request.ordinal), "S4L_DIAGNOSTIC_RESERVATION_MISSING");
			for (const offer of transport.offers) {
				if (offer.reservationOrdinal === null) continue;
				const request = requests.find(r => r.ordinal === offer.reservationOrdinal);
				if (!request) { assert.ok(record?.status === "unknown" && offer.stopCode === "JOURNAL_FAILURE" && !offer.dispatchAttempted && !offer.returned); continue; }
				assert.equal(offer.requestSha256, request.requestSha256); assert.equal(offer.payloadBytes, request.inputBytes);
				if (request.settlement) { assert.equal(offer.dispatchAttempted, request.settlement.dispatchAttempted); assert.equal(offer.returned, request.settlement.status === "complete"); }
				if (offer.returned) assert.equal(request.effectiveStatus, "complete");
				const binding = bindings.find(b => b.ordinal === offer.reservationOrdinal); if (binding) assert.equal(binding.kind, offer.kind);
			}
			if (transport.stopCode === "TASK_REQUEST_LIMIT") assert.equal(requests.length, manifest.limits.maxTaskHttpRequests);
			if (transport.stopCode === "BATCH_REQUEST_LIMIT") assert.equal(journal?.reserved, manifest.limits.maxHttpRequests);
		}
		for (const stage of record?.stages ?? []) {
			const bound = bindings.filter(b => b.taskId === run.runId && b.stage === "single"), receipts = stage.result!.bridge.receipts.filter(r => r.requestId !== null);
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
		if (record && ["pass", "fail"].includes(record.status)) assert.ok(requests.every(r => r.effectiveStatus === "complete"));
		const sum = (field: "promptTokens" | "completionTokens" | "totalTokens" | "cachedTokens" | "reasoningTokens") => requests.length > 0 && requests.every(r => r.settlement?.status === "complete" && r.settlement.usage![field] !== null) ? requests.reduce((n, r) => n + r.settlement!.usage![field]!, 0) : null;
		const parsedUsage = { input: sum("promptTokens"), output: sum("completionTokens"), total: sum("totalTokens"), cached: sum("cachedTokens"), reasoning: sum("reasoningTokens") };
		const s = record?.stages.map(v => v.result!) ?? [];
		// V1 is rebuilt byte-for-byte. V2 only sums SDK receipts with a verified
		// durable HTTP binding; a rejected seventh IPC offer is not a seventh HTTP.
		const receipts = s.flatMap(s => s.bridge.receipts).filter(r => r.requestId !== null && (manifest.schemaVersion === 1 || transport?.offers.some(o => o.id === r.requestId && requests.some(q => q.ordinal === o.reservationOrdinal))));
		const sdkSum = (field: "input" | "output" | "total" | "cacheRead" | "cacheWrite") => receipts.length === requests.length && receipts.length > 0 && receipts.every(r => r.status === "complete") ? receipts.reduce((n, r) => n + r[field], 0) : null;
		const transportDiagnostics = transport ? { stopCode: transport.stopCode, sdkEntries: s.length ? s[0].bridge.receipts.length : null,
			offered: transport.offers.length, dispatched: transport.offers.filter(o => o.dispatchAttempted).length,
			rejectedBeforeReservation: transport.offers.filter(o => o.reservationOrdinal === null).length,
			reservedNotDispatched: transport.offers.filter(o => o.reservationOrdinal !== null && !o.dispatchAttempted).length,
			failedAfterDispatch: transport.offers.filter(o => o.dispatchAttempted && !o.returned).length,
			retryBlocks: s.length ? s[0].bridge.retryBlocks : null } : null;
		rows.push({ run, status: sealed ? record!.status : "unknown", reasonCode: record?.reasonCode ?? "WORKER_UNKNOWN", businessOutcome: sealed ? business(run, record?.stages[0]?.result ?? null) : "unknown", userAccepted: false, requests: requests.length,
			supervisor: s[0]?.supervisor ?? null, noProgressBranch: !s.length ? "unobserved" : s[0].supervisor?.state === "NO_PROGRESS" ? "triggered" : "not_triggered",
			verificationCurrent: s[0]?.verificationCurrent ?? null, finalFileSha256: s[0]?.finalFileSha256 ?? null,
			maintenance: s[0] ? { trimmed: s[0].metrics.preflightTrimmed, beforeBytes: s[0].metrics.projectedBefore, afterBytes: s[0].metrics.projectedAfter, handledInputs: s[0].metrics.handledInputs } : null,
			ordinary: bindings.filter(b => b.taskId === run.runId && b.kind === "ordinary").length, summaries: bindings.filter(b => b.taskId === run.runId && b.kind === "summary").length,
			parsedUsage, providerActualUsage: manifest.mode === "live" ? parsedUsage : null, costUsd: null, sdkUsage: { input: sdkSum("input"), output: sdkSum("output"), total: sdkSum("total"), cacheRead: sdkSum("cacheRead"), cacheWrite: sdkSum("cacheWrite") },
			tools: s.length ? s.reduce((n, r) => n + r.tools, 0) : null, writes: s.length ? s.reduce((n, r) => n + r.writes, 0) : null,
			nativeCompactions: s.length ? s.reduce((n, r) => n + r.compactions, 0) : null, durableIntents: s.length ? s.reduce((n, r) => n + r.durableIntents, 0) : null,
			staleWriteBlocks: s.length ? s.reduce((n, r) => n + r.base.staleWriteBlocks, 0) : null, durableGateBlocks: s.length ? s.reduce((n, r) => n + r.operations.replayBlocks, 0) : null,
			...(manifest.schemaVersion >= 2 ? { transportDiagnostics } : {}) });
	}
	const complete = sealed && journal?.canPass && rows.every(r => r.status === "pass" || r.status === "fail");
	const aggregate = { schemaVersion: manifest.schemaVersion, kind: "sdk-supervision-live-aggregate", manifestSha256, mode: manifest.mode, simulation: manifest.simulation,
		status: !journal ? "prepared" : !complete ? "incomplete" : rows.every(r => r.status === "pass") ? "pass" : "completed-with-failures",
		sealed, realHttpDispatches: manifest.mode === "live" ? journal?.dispatchAttempted ?? 0 : 0, simulatedHttpDispatches: manifest.mode === "dry-run" ? journal?.dispatchAttempted ?? 0 : 0,
		sharedReserved: journal?.reserved ?? 0, inputReserved: journal?.inputReserved ?? 0, outputReserved: journal?.outputReserved ?? 0, unknownRequests: journal?.unknown ?? 0, pendingRequests: journal?.pending ?? 0,
		ordinary: bindings.filter(b => b.kind === "ordinary").length, summaries: bindings.filter(b => b.kind === "summary").length, actualCostUsd: null, rows };
	if ("aggregate.json" in files) assert.deepEqual(JSON.parse(await readBounded(path.join(directory, "aggregate.json"))), aggregate, "S4L_AGGREGATE_DRIFT");
	return aggregate;
}
