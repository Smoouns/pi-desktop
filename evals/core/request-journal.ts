import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { freezeRequestPolicy, type RequestPolicy } from "./request-policy.js";
import type { ProviderUsage } from "../pilot/usage.js";

export class PilotJournalError extends Error {
	constructor(public readonly code: string) { super(code); this.name = "PilotJournalError"; }
}
const fail = (code: string): never => { throw new PilotJournalError(code); };
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identifier = (value: unknown, code: string): string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : fail(code);
const count = (value: unknown, code: string): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fail(code);
const object = (value: unknown, code: string): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail(code);
const exact = (value: Record<string, unknown>, keys: readonly string[], code: string): void => {
	const actual = Object.keys(value).sort(), expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
};

export type PilotJournalMode = "live" | "dry-run";
export type PilotReserveSnapshot<TaskId extends string = string> = { ordinal: number; taskId: TaskId; invocationId: number; inputEstimate: number; inputBytes: number; outputReserved: number; requestSha256: string };
export type PilotSettleSnapshot<TaskId extends string = string> = { ordinal: number; taskId: TaskId; invocationId: number; dispatchAttempted: boolean; status: "complete" | "unknown"; reasonCode: string | null; usage: ProviderUsage | null };
export type PilotReserveEvent<TaskId extends string = string> = PilotReserveSnapshot<TaskId> & { schemaVersion: 1; kind: "reserve"; seq: number; ordinal: number; manifestSha256: string; mode: PilotJournalMode; prevSha256: string };
export type PilotSettleEvent<TaskId extends string = string> = PilotSettleSnapshot<TaskId> & { schemaVersion: 1; kind: "settle"; seq: number; manifestSha256: string; mode: PilotJournalMode; prevSha256: string };
export type PilotJournalIndex = { schemaVersion: 1; kind: string; manifestSha256: string; mode: PilotJournalMode; outcome: "complete" | "aborted"; eventCount: number; lastSha256: string };
export type PilotJournalSummary<TaskId extends string = string> = { manifestSha256: string; mode: PilotJournalMode; reserved: number; settled: number; complete: number; dispatchAttempted: number; unknown: number; pending: number; inputReserved: number; outputReserved: number; requestsByTask: Record<TaskId, number>; finalized: boolean; outcome: "complete" | "aborted" | null; canPass: boolean };
export type PilotJournalRecovery<TaskId extends string = string> = PilotJournalSummary<TaskId> & { reservations: Array<PilotReserveEvent<TaskId> & { settlement: PilotSettleEvent<TaskId> | null; effectiveStatus: "complete" | "unknown" }> };

type Claim = { schemaVersion: 1; kind: string; manifestSha256: string; mode: PilotJournalMode };
type Event<TaskId extends string = string> = PilotReserveEvent<TaskId> | PilotSettleEvent<TaskId>;


export function createJournalScope<TaskId extends string>(requestedPolicy: RequestPolicy<TaskId>) {
const policy = freezeRequestPolicy(requestedPolicy), limits = policy.limits;
const task = (value: unknown): TaskId => policy.taskIds.includes(value as TaskId) ? value as TaskId : fail("JOURNAL_TASK");
async function writeExclusive(filename: string, content: string): Promise<void> {
	const handle = await open(filename, "wx", 0o600);
	try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
}
async function bounded(filename: string, maxBytes = 64 * 1024): Promise<string> {
	const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) fail("JOURNAL_FILE_UNSAFE");
	return readFile(filename, "utf8");
}
function validateUsage(value: unknown): ProviderUsage {
	const usage = object(value, "JOURNAL_USAGE"); exact(usage, ["promptTokens", "completionTokens", "totalTokens", "cachedTokens", "reasoningTokens"], "JOURNAL_USAGE_FIELDS");
	const nullable = (item: unknown): number | null => item === null ? null : count(item, "JOURNAL_USAGE");
	return { promptTokens: nullable(usage.promptTokens), completionTokens: nullable(usage.completionTokens), totalTokens: nullable(usage.totalTokens), cachedTokens: nullable(usage.cachedTokens), reasoningTokens: nullable(usage.reasoningTokens) };
}
function validateClaim(value: unknown, expectedManifest?: string): Claim {
	const claim = object(value, "JOURNAL_CLAIM"); exact(claim, ["schemaVersion", "kind", "manifestSha256", "mode"], "JOURNAL_CLAIM_FIELDS");
	if (claim.schemaVersion !== 1 || claim.kind !== `${policy.namespace}-journal-claim` || !isHash(claim.manifestSha256) || (claim.mode !== "live" && claim.mode !== "dry-run") || (expectedManifest && claim.manifestSha256 !== expectedManifest)) fail("JOURNAL_CLAIM");
	return claim as Claim;
}
function validateEvent(value: unknown, claim: Claim, expectedSeq: number, expectedPrev: string): Event<TaskId> {
	const event = object(value, "JOURNAL_EVENT");
	const common = ["schemaVersion", "kind", "seq", "manifestSha256", "mode", "prevSha256"];
	if (event.kind === "reserve") exact(event, [...common, "ordinal", "taskId", "invocationId", "inputEstimate", "inputBytes", "outputReserved", "requestSha256"], "JOURNAL_RESERVE_FIELDS");
	else if (event.kind === "settle") exact(event, [...common, "ordinal", "taskId", "invocationId", "dispatchAttempted", "status", "reasonCode", "usage"], "JOURNAL_SETTLE_FIELDS");
	else fail("JOURNAL_EVENT_KIND");
	if (event.schemaVersion !== 1 || event.seq !== expectedSeq || event.manifestSha256 !== claim.manifestSha256 || event.mode !== claim.mode || event.prevSha256 !== expectedPrev) fail("JOURNAL_EVENT_CHAIN");
	if (event.kind === "reserve") {
		if (!isHash(event.requestSha256)) fail("JOURNAL_REQUEST_SHA");
		return { schemaVersion: 1, kind: "reserve", seq: count(event.seq, "JOURNAL_SEQ"), ordinal: count(event.ordinal, "JOURNAL_ORDINAL"), manifestSha256: claim.manifestSha256, mode: claim.mode, prevSha256: expectedPrev,
			taskId: task(event.taskId), invocationId: count(event.invocationId, "JOURNAL_INVOCATION"), inputEstimate: count(event.inputEstimate, "JOURNAL_INPUT"), inputBytes: count(event.inputBytes, "JOURNAL_BYTES"), outputReserved: count(event.outputReserved, "JOURNAL_OUTPUT"), requestSha256: event.requestSha256 as string };
	}
	if (event.status !== "complete" && event.status !== "unknown") fail("JOURNAL_SETTLE_STATUS");
	const reasonCode = event.reasonCode === null ? null : identifier(event.reasonCode, "JOURNAL_REASON");
	const usage = event.usage === null ? null : validateUsage(event.usage);
	if (event.status === "complete" ? (event.dispatchAttempted !== true || reasonCode !== null || usage === null || usage.promptTokens === null || usage.completionTokens === null || usage.totalTokens === null) : (reasonCode === null || usage !== null)) fail("JOURNAL_SETTLE_STATE");
	if (typeof event.dispatchAttempted !== "boolean") fail("JOURNAL_DISPATCH_STATE");
	return { schemaVersion: 1, kind: "settle", seq: count(event.seq, "JOURNAL_SEQ"), ordinal: count(event.ordinal, "JOURNAL_ORDINAL"), manifestSha256: claim.manifestSha256, mode: claim.mode, prevSha256: expectedPrev,
		taskId: task(event.taskId), invocationId: count(event.invocationId, "JOURNAL_INVOCATION"), dispatchAttempted: event.dispatchAttempted as boolean, status: event.status as "complete" | "unknown", reasonCode, usage };
}
function validateIndex(value: unknown, claim: Claim): PilotJournalIndex {
	const index = object(value, "JOURNAL_INDEX"); exact(index, ["schemaVersion", "kind", "manifestSha256", "mode", "outcome", "eventCount", "lastSha256"], "JOURNAL_INDEX_FIELDS");
	if (index.schemaVersion !== 1 || index.kind !== `${policy.namespace}-journal-index` || index.manifestSha256 !== claim.manifestSha256 || index.mode !== claim.mode || (index.outcome !== "complete" && index.outcome !== "aborted") || !isHash(index.lastSha256)) fail("JOURNAL_INDEX");
	return { schemaVersion: 1, kind: `${policy.namespace}-journal-index`, manifestSha256: claim.manifestSha256, mode: claim.mode, outcome: index.outcome as "complete" | "aborted", eventCount: count(index.eventCount, "JOURNAL_INDEX_COUNT"), lastSha256: index.lastSha256 as string };
}

function summarize(claim: Claim, events: Event<TaskId>[], index: PilotJournalIndex | null): PilotJournalRecovery<TaskId> {
	const reserves = events.filter((event): event is PilotReserveEvent<TaskId> => event.kind === "reserve");
	const settles = events.filter((event): event is PilotSettleEvent<TaskId> => event.kind === "settle");
	if (new Set(reserves.map((event) => event.ordinal)).size !== reserves.length || new Set(reserves.map((event) => event.invocationId)).size !== reserves.length) fail("JOURNAL_REQUEST_DUPLICATE");
	const settlement = new Map<number, PilotSettleEvent<TaskId>>();
	for (const event of settles) { const reserved = reserves.find((item) => item.ordinal === event.ordinal); if (!reserved || reserved.taskId !== event.taskId || reserved.invocationId !== event.invocationId || settlement.has(event.ordinal)) fail("JOURNAL_SETTLE_BINDING"); settlement.set(event.ordinal, event); }
	const requestsByTask = Object.fromEntries(policy.taskIds.map(id => [id, 0])) as Record<TaskId, number>;
	let inputReserved = 0, outputReserved = 0;
	for (const event of reserves) {
		if (event.inputEstimate > limits.maxInputTokens || event.inputBytes > limits.maxInputBytes || event.outputReserved > limits.maxOutputTokens) fail("JOURNAL_REQUEST_BUDGET");
		requestsByTask[event.taskId]++; inputReserved += event.inputEstimate; outputReserved += event.outputReserved;
	}
	if (reserves.length > limits.maxHttpRequests || (Object.values(requestsByTask) as number[]).some((value) => value > limits.maxTaskHttpRequests) || inputReserved > limits.maxTotalInputTokens || outputReserved > limits.maxTotalOutputTokens) fail("JOURNAL_BATCH_BUDGET");
	const pending = reserves.length - settles.length, unknown = settles.filter((event) => event.status === "unknown").length + pending, complete = settles.filter((event) => event.status === "complete").length;
	if (index && index.eventCount !== events.length) fail("JOURNAL_INDEX_CHAIN");
	const canPass = index?.outcome === "complete" && pending === 0 && unknown === 0 && complete === reserves.length;
	return { manifestSha256: claim.manifestSha256, mode: claim.mode, reserved: reserves.length, settled: settles.length, complete, dispatchAttempted: settles.filter((event) => event.dispatchAttempted).length + pending, unknown, pending, inputReserved, outputReserved, requestsByTask,
		finalized: index !== null, outcome: index?.outcome ?? null, canPass, reservations: reserves.map((event) => ({ ...event, settlement: settlement.get(event.ordinal) ?? null, effectiveStatus: settlement.get(event.ordinal)?.status ?? "unknown" })) };
}

async function load(directory: string, expectedManifest: string): Promise<{ claim: Claim; claimText: string; events: Event<TaskId>[]; eventTexts: string[]; index: PilotJournalIndex | null }> {
	if (!isHash(expectedManifest)) fail("JOURNAL_MANIFEST_SHA");
	const rootInfo = await lstat(directory); if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("JOURNAL_DIRECTORY_UNSAFE");
	const names = (await readdir(directory)).sort(); if (!names.includes("claim.json") || names.some((name) => name !== "claim.json" && name !== "index.json" && !/^event-\d{6}\.json$/.test(name))) fail("JOURNAL_FILES");
	const claimText = await bounded(path.join(directory, "claim.json")); const claim = validateClaim(JSON.parse(claimText), expectedManifest);
	const eventNames = names.filter((name) => name.startsWith("event-")); const events: Event<TaskId>[] = [], eventTexts: string[] = []; let prev = hash(claimText);
	for (let index = 0; index < eventNames.length; index++) { const expected = `event-${String(index + 1).padStart(6, "0")}.json`; if (eventNames[index] !== expected) fail("JOURNAL_EVENT_GAP"); const content = await bounded(path.join(directory, expected)); const event = validateEvent(JSON.parse(content), claim, index + 1, prev); events.push(event); eventTexts.push(content); prev = hash(content); }
	const journalIndex = names.includes("index.json") ? validateIndex(JSON.parse(await bounded(path.join(directory, "index.json"))), claim) : null;
	if (journalIndex && journalIndex.lastSha256 !== prev) fail("JOURNAL_INDEX_CHAIN");
	return { claim, claimText, events, eventTexts, index: journalIndex };
}

async function recoverPilotJournal(directory: string, manifestSha256: string): Promise<PilotJournalRecovery<TaskId>> {
	const loaded = await load(directory, manifestSha256); return summarize(loaded.claim, loaded.events, loaded.index);
}

async function createPilotJournal(directory: string, manifestSha256: string, mode: PilotJournalMode) {
	if (!isHash(manifestSha256) || (mode !== "live" && mode !== "dry-run")) fail("JOURNAL_CREATE");
	await mkdir(directory, { recursive: true }); const resolved = await realpath(directory); if (resolved !== path.resolve(directory) || (await lstat(resolved)).isSymbolicLink()) fail("JOURNAL_DIRECTORY_UNSAFE");
	const initialNames = await readdir(resolved); if (initialNames.includes("claim.json")) fail("JOURNAL_ALREADY_CLAIMED"); if (initialNames.length !== 0) fail("JOURNAL_DIRECTORY_NOT_EMPTY");
	const claim: Claim = { schemaVersion: 1, kind: `${policy.namespace}-journal-claim`, manifestSha256, mode }; const claimText = json(claim);
	try { await writeExclusive(path.join(resolved, "claim.json"), claimText); } catch (error) { return fail((error as NodeJS.ErrnoException).code === "EEXIST" ? "JOURNAL_ALREADY_CLAIMED" : "JOURNAL_CLAIM_WRITE_FAILED"); }
	let events: Event<TaskId>[] = [], eventTexts: string[] = [], failed = false, finalized = false, journalIndex: PilotJournalIndex | null = null;
	const currentSummary = (): PilotJournalRecovery<TaskId> => summarize(claim, events, journalIndex);
	const append = async (event: Event<TaskId>): Promise<Event<TaskId>> => {
		if (failed || finalized) fail("JOURNAL_CLOSED"); const content = json(event), filename = path.join(resolved, `event-${String(event.seq).padStart(6, "0")}.json`);
		try { await writeExclusive(filename, content); } catch { failed = true; return fail("JOURNAL_WRITE_FAILED"); }
		events = [...events, event]; eventTexts = [...eventTexts, content]; return event;
	};
	return {
		async reserve(snapshot: PilotReserveSnapshot<TaskId>): Promise<PilotReserveEvent<TaskId>> {
			if (finalized || failed) fail("JOURNAL_CLOSED"); const summary = currentSummary();
			const clean: PilotReserveSnapshot<TaskId> = { ordinal: count(snapshot.ordinal, "JOURNAL_ORDINAL"), taskId: task(snapshot.taskId), invocationId: count(snapshot.invocationId, "JOURNAL_INVOCATION"), inputEstimate: count(snapshot.inputEstimate, "JOURNAL_INPUT"), inputBytes: count(snapshot.inputBytes, "JOURNAL_BYTES"), outputReserved: count(snapshot.outputReserved, "JOURNAL_OUTPUT"), requestSha256: isHash(snapshot.requestSha256) ? snapshot.requestSha256 : fail("JOURNAL_REQUEST_SHA") };
			if (clean.ordinal !== summary.reserved + 1) fail("JOURNAL_ORDINAL_MISMATCH");
			if (events.some((event) => event.kind === "reserve" && event.invocationId === clean.invocationId)) fail("JOURNAL_REQUEST_DUPLICATE");
			if (summary.reserved + 1 > limits.maxHttpRequests || summary.requestsByTask[clean.taskId] + 1 > limits.maxTaskHttpRequests || clean.inputEstimate > limits.maxInputTokens || clean.inputBytes > limits.maxInputBytes || clean.outputReserved > limits.maxOutputTokens || summary.inputReserved + clean.inputEstimate > limits.maxTotalInputTokens || summary.outputReserved + clean.outputReserved > limits.maxTotalOutputTokens) fail("JOURNAL_BUDGET_EXCEEDED");
			const event: PilotReserveEvent<TaskId> = { schemaVersion: 1, kind: "reserve", seq: events.length + 1, manifestSha256, mode, prevSha256: eventTexts.length ? hash(eventTexts.at(-1)!) : hash(claimText), ...clean };
			return await append(event) as PilotReserveEvent<TaskId>;
		},
		async settle(snapshot: PilotSettleSnapshot<TaskId>): Promise<PilotSettleEvent<TaskId>> {
			const reserved = events.find((event): event is PilotReserveEvent<TaskId> => event.kind === "reserve" && event.ordinal === snapshot.ordinal);
			if (!reserved || reserved.taskId !== snapshot.taskId || reserved.invocationId !== snapshot.invocationId || events.some((event) => event.kind === "settle" && event.ordinal === snapshot.ordinal)) fail("JOURNAL_SETTLE_BINDING");
			const candidate = { schemaVersion: 1, kind: "settle", seq: events.length + 1, manifestSha256, mode, prevSha256: eventTexts.length ? hash(eventTexts.at(-1)!) : hash(claimText), ...snapshot };
			const event = validateEvent(candidate, claim, events.length + 1, candidate.prevSha256) as PilotSettleEvent<TaskId>; return await append(event) as PilotSettleEvent<TaskId>;
		},
		async finalize(outcome: "complete" | "aborted"): Promise<PilotJournalIndex> {
			if (failed || finalized || (outcome !== "complete" && outcome !== "aborted")) fail("JOURNAL_CLOSED"); const summary = currentSummary();
			if (outcome === "complete" && (summary.pending !== 0 || summary.unknown !== 0 || summary.complete !== summary.reserved)) fail("JOURNAL_INCOMPLETE");
			const index: PilotJournalIndex = { schemaVersion: 1, kind: `${policy.namespace}-journal-index`, manifestSha256, mode, outcome, eventCount: events.length, lastSha256: events.length ? hash(eventTexts.at(-1)!) : hash(claimText) };
			try { await writeExclusive(path.join(resolved, "index.json"), json(index)); } catch { failed = true; return fail("JOURNAL_WRITE_FAILED"); } journalIndex = index; finalized = true; return index;
		},
		snapshot(): PilotJournalSummary<TaskId> { const { reservations: _, ...summary } = currentSummary(); return summary; },
	};
}

return { create: createPilotJournal, recover: recoverPilotJournal };
}
