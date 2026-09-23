import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { digest, readBounded, sha256, treeManifest } from "../core/io.js";
import { createJournalScope } from "../core/request-journal.js";
import { count, durableJson, exact, hash, hashes } from "../sdk-live/manifest.js";
import { CONTINUE, MODEL, PROMPT, SCENARIOS, SEED_ASSISTANT, SEED_USER, SYSTEM, TASK_ID, VERSION, expectedStop, isSuccessScenario, policyFor, settingsFor, type Scenario } from "./policy.js";
import type { WorkerResult } from "./worker.js";
import type { RequestBinding } from "./broker.js";

export interface Manifest {
	schemaVersion: 1; kind: "sdk-context-transport-offline"; batchId: string; createdAt: string; scenario: Scenario;
	code: { commit: string; dirty: boolean; files: Record<string, string>; sha256: string };
	runtime: { node: string; platform: string; arch: string; sdk: "0.63.1" };
	policy: ReturnType<typeof policyFor>; settings: ReturnType<typeof settingsFor>; version: typeof VERSION; promptsSha256: string; modelSha256: string;
}
export interface Result {
	schemaVersion: 1; manifestSha256: string; worker: WorkerResult | null; sourceStable: boolean; zeroNetwork: boolean;
	broker: { offered: number; maxConcurrentOffers: number; stopCode: string | null };
	simulation: { ordinary: number; summaries: number; maxConcurrentDispatches: number };
}
export const promptDigest = () => digest({ SYSTEM, SEED_USER, SEED_ASSISTANT, PROMPT, CONTINUE });
export function validateManifest(value: unknown): Manifest {
	const m = exact(value, ["schemaVersion", "kind", "batchId", "createdAt", "scenario", "code", "runtime", "policy", "settings", "version", "promptsSha256", "modelSha256"]);
	assert.equal(m.schemaVersion, 1); assert.equal(m.kind, "sdk-context-transport-offline"); assert.match(m.batchId, /^s3-transport-[A-Za-z0-9_-]{1,64}$/);
	assert.ok(SCENARIOS.includes(m.scenario)); assert.equal(new Date(m.createdAt).toISOString(), m.createdAt);
	exact(m.code, ["commit", "dirty", "files", "sha256"]); assert.match(m.code.commit, /^[a-f0-9]{40}$/); assert.equal(typeof m.code.dirty, "boolean");
	hashes(m.code.files); hash(m.code.sha256); assert.equal(m.code.sha256, digest(m.code.files));
	exact(m.runtime, ["node", "platform", "arch", "sdk"]); assert.equal(m.runtime.sdk, "0.63.1");
	for (const key of ["node", "platform", "arch"]) assert.match(m.runtime[key], /^[A-Za-z0-9_.-]{1,64}$/);
	assert.deepEqual(m.policy, policyFor(m.scenario)); assert.deepEqual(m.settings, settingsFor(m.scenario)); assert.deepEqual(m.version, VERSION);
	assert.equal(m.promptsSha256, promptDigest()); assert.equal(m.modelSha256, digest(MODEL)); return m as Manifest;
}
export function validateWorker(value: unknown): WorkerResult {
	const r = exact(value, ["settings", "zeroNetwork", "toolCount", "ordinaryHooks", "fetchAttempts", "blockedFetches", "manualCompactions", "automaticStarts", "automaticEnds", "nativeCompactions", "fromHook", "continued", "summaryFailed", "receipts"]);
	for (const key of ["settings", "zeroNetwork", "fromHook", "continued", "summaryFailed"]) assert.equal(typeof r[key], "boolean");
	for (const key of ["toolCount", "ordinaryHooks", "fetchAttempts", "blockedFetches", "manualCompactions", "automaticStarts", "automaticEnds", "nativeCompactions"]) count(r[key], 24);
	assert.ok(Array.isArray(r.receipts) && r.receipts.length <= 8);
	for (let i = 0; i < r.receipts.length; i++) {
		const row = exact(r.receipts[i], ["id", "kind", "status", "input", "output", "total"]);
		assert.equal(row.id, i + 1); assert.ok(["ordinary", "summary"].includes(row.kind)); assert.ok(["complete", "error", "aborted"].includes(row.status));
		for (const key of ["input", "output", "total"]) count(row[key]);
	}
	return r as WorkerResult;
}
export function validateResult(value: unknown, manifestSha: string): Result {
	const r = exact(value, ["schemaVersion", "manifestSha256", "worker", "sourceStable", "zeroNetwork", "broker", "simulation"]);
	assert.equal(r.schemaVersion, 1); assert.equal(r.manifestSha256, manifestSha);
	if (r.worker !== null) validateWorker(r.worker);
	for (const key of ["sourceStable", "zeroNetwork"]) assert.equal(typeof r[key], "boolean");
	exact(r.broker, ["offered", "maxConcurrentOffers", "stopCode"]); count(r.broker.offered, 8); count(r.broker.maxConcurrentOffers, 2);
	if (r.broker.stopCode !== null) assert.ok(["MANUAL_STOP", "REQUEST_ABORTED", "TASK_REQUEST_LIMIT", "HTTP_FAILURE", "USAGE_INVALID", "REQUEST_TIMEOUT", "JOURNAL_FAILURE", "INVOCATION_REUSED", "BATCH_OUTPUT_LIMIT", "PROVIDER_USAGE_LIMIT"].includes(r.broker.stopCode));
	exact(r.simulation, ["ordinary", "summaries", "maxConcurrentDispatches"]); for (const value of Object.values(r.simulation)) count(value, 6);
	return r as Result;
}
async function readManifest(directory: string) {
	const text = await readBounded(path.join(directory, "manifest.json")); return { manifest: validateManifest(JSON.parse(text)), manifestSha256: sha256(text) };
}
export async function seal(directory: string) {
	const { manifestSha256 } = await readManifest(directory), files = await treeManifest(directory);
	delete files["manifest.json"];
	await durableJson(path.join(directory, "index.json"), { schemaVersion: 1, manifestSha256, files });
}

/** Read-only; never restarts a worker, reserves another request, or reads auth. */
export async function recover(directory: string) {
	const { manifest, manifestSha256 } = await readManifest(directory);
	const index = exact(JSON.parse(await readBounded(path.join(directory, "index.json"))), ["schemaVersion", "manifestSha256", "files"]);
	assert.equal(index.schemaVersion, 1); assert.equal(index.manifestSha256, manifestSha256); hashes(index.files);
	const files = await treeManifest(directory); delete files["manifest.json"]; delete files["index.json"]; delete files["aggregate.json"];
	assert.deepEqual(files, index.files, "S3T_EVIDENCE_DRIFT");
	for (const file of Object.keys(files)) assert.ok(file === "result.json" || /^journal\/(claim|index|event-\d{6})\.json$/.test(file) || /^requests\/request-\d{6}\.json$/.test(file), "S3T_EXTRA_ARTIFACT");
	const result = validateResult(JSON.parse(await readBounded(path.join(directory, "result.json"))), manifestSha256);
	const journal = await createJournalScope(manifest.policy).recover(path.join(directory, "journal"), manifestSha256);
	assert.equal(journal.mode, "dry-run"); assert.ok(journal.finalized); assert.equal(journal.requestsByTask[TASK_ID], journal.reserved);
	const bindings: RequestBinding[] = [];
	for (const name of (await readdir(path.join(directory, "requests"))).sort()) {
		const binding = exact(JSON.parse(await readBounded(path.join(directory, "requests", name))), ["schemaVersion", "ordinal", "offerId", "kind", "requestSha256"]);
		assert.equal(binding.schemaVersion, 1); assert.equal(binding.ordinal, bindings.length + 1); assert.equal(name, `request-${String(binding.ordinal).padStart(6, "0")}.json`);
		assert.ok(["ordinary", "summary"].includes(binding.kind)); count(binding.offerId, 8); assert.ok(binding.offerId > 0);
		const reserved = journal.reservations[binding.ordinal - 1]; assert.ok(reserved); assert.equal(binding.requestSha256, reserved.requestSha256);
		assert.equal(reserved.invocationId, binding.ordinal); bindings.push(binding as RequestBinding);
	}
	assert.equal(bindings.length, journal.reserved); assert.equal(new Set(bindings.map(row => row.offerId)).size, bindings.length);
	assert.ok(bindings.every((row, i) => row.offerId === i + 1));
	const worker = result.worker;
	if (worker) {
		assert.equal(worker.ordinaryHooks, worker.receipts.filter(row => row.kind === "ordinary").length);
		assert.equal(worker.receipts.length, result.broker.offered);
		assert.equal(worker.fetchAttempts, result.broker.offered + worker.blockedFetches);
		for (const binding of bindings) {
			const receipt: WorkerResult["receipts"][number] | undefined = worker.receipts.find(row => row.id === binding.offerId); assert.ok(receipt); assert.equal(receipt.kind, binding.kind);
			const settled = journal.reservations[binding.ordinal - 1].settlement;
			if (settled?.status === "complete") {
				assert.equal(receipt.status, "complete"); assert.equal(receipt.total, settled.usage!.totalTokens);
				assert.equal(receipt.input, settled.usage!.promptTokens); assert.equal(receipt.output, settled.usage!.completionTokens);
			} else assert.notEqual(receipt.status, "complete");
		}
	}
	assert.equal(result.simulation.ordinary + result.simulation.summaries, journal.dispatchAttempted);
	assert.ok(result.broker.offered >= journal.reserved);
	const sumKind = (kind: "ordinary" | "summary") => {
		const rows = journal.reservations.filter(row => bindings[row.ordinal - 1].kind === kind);
		const sumUsage = (field: "promptTokens" | "completionTokens" | "totalTokens" | "cachedTokens") => rows.length > 0 && rows.every(row => row.settlement?.status === "complete" && row.settlement.usage?.[field] !== null)
			? rows.reduce((sum, row) => sum + row.settlement!.usage![field]!, 0) : null;
		return { reserved: rows.length, outputReserved: rows.reduce((sum, row) => sum + row.outputReserved, 0), complete: rows.filter(row => row.effectiveStatus === "complete").length,
			unknown: rows.filter(row => row.effectiveStatus === "unknown").length,
			syntheticParsedUsage: { input: sumUsage("promptTokens"), output: sumUsage("completionTokens"), total: sumUsage("totalTokens"), cached: sumUsage("cachedTokens") },
			providerActualUsage: null, costUsd: null };
	};
	const expectedSuccess = isSuccessScenario(manifest.scenario), split = manifest.scenario.startsWith("split");
	const contractPassed = !!worker && result.sourceStable && result.zeroNetwork && worker.settings && worker.zeroNetwork && worker.toolCount === 0 && !worker.fromHook
		&& result.simulation.maxConcurrentDispatches === 1 && result.broker.stopCode === expectedStop(manifest.scenario)
		&& (expectedSuccess ? journal.canPass && worker.continued && !worker.summaryFailed && worker.nativeCompactions === 1
			&& journal.reserved === (split ? 4 : 3) && worker.ordinaryHooks === 2 && result.simulation.summaries === (split ? 2 : 1)
			: !journal.canPass && !worker.continued && worker.nativeCompactions === 0)
		&& (manifest.scenario === "threshold" ? worker.automaticStarts === 1 && worker.automaticEnds === 1 && worker.manualCompactions === 0 : worker.automaticStarts === 0 && worker.manualCompactions === (manifest.scenario === "ordinary-cancel" ? 0 : 1));
	return { schemaVersion: 1, kind: "sdk-context-transport-offline-aggregate", manifestSha256, scenario: manifest.scenario, contractPassed,
		requestOutcome: journal.unknown > 0 ? "unknown" : journal.canPass ? "complete" : "stopped", stopCode: result.broker.stopCode,
		realHttpDispatches: 0, simulatedHttpDispatches: journal.dispatchAttempted, sharedReserved: journal.reserved, sharedOutputReserved: journal.outputReserved,
		unknownRequests: journal.unknown, pendingRequests: journal.pending, offered: result.broker.offered, maxConcurrentOffers: result.broker.maxConcurrentOffers,
		maxConcurrentDispatches: result.simulation.maxConcurrentDispatches, ordinary: sumKind("ordinary"), summary: sumKind("summary"),
		nativeCompactions: worker?.nativeCompactions ?? null, blockedSdkFetchRetries: worker?.blockedFetches ?? null, providerActualUsage: null, costUsd: null };
}
