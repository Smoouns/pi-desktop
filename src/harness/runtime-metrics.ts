/** Diagnostic-only, bounded counters. Never grants budget or write permission.
 * Embedded in the managed extension with Function#toString: no runtime imports.
 */
export function createRuntimeMetrics(options: { maxTrackedFiles?: number } = {}) {
	type ReadKind = "document" | "fingerprint" | "observationValidation" | "checkpointValidation" | "memory" | "verifierReceipt";
	type ReferenceKind = "observationSources" | "checkpointSources" | "observationPages" | "observationPageBytes";
	const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	const number = (value: unknown): number | null => valid(value) ? value : null;
	let overflow = false;
	const add = (left: number, right: number) => {
		if (left > Number.MAX_SAFE_INTEGER - right) { overflow = true; return Number.MAX_SAFE_INTEGER; }
		return left + right;
	};
	const maxFiles = valid(options.maxTrackedFiles) ? Math.max(1, Math.min(512, options.maxTrackedFiles)) : 512;
	const counter = () => ({ calls: 0, bytes: 0, failures: 0 });
	const reads = () => ({
		total: counter(), byKind: { document: counter(), fingerprint: counter(), observationValidation: counter(), checkpointValidation: counter(), memory: counter(), verifierReceipt: counter() },
		files: new Set<string>(), repeatedPathReadsAtLeast: 0, fileTrackingTruncated: false,
		logicalReferences: { observationSources: 0, checkpointSources: 0, observationPages: 0, observationPageBytes: 0 },
		sourceCache: { hits: 0, misses: 0, invalidations: 0, capacityBypasses: 0, reusedSourceBytes: 0 },
	});
	type Reads = ReturnType<typeof reads>;
	const allReads = reads();
	const readSnapshot = (value: Reads) => ({ total: { ...value.total }, byKind: Object.fromEntries(Object.entries(value.byKind).map(([key, value]) => [key, { ...value }])),
		distinctPathsTracked: value.files.size, repeatedPathReadsAtLeast: value.repeatedPathReadsAtLeast, fileTrackingTruncated: value.fileTrackingTruncated,
		logicalReferences: { ...value.logicalReferences }, sourceCache: { ...value.sourceCache } });
	let sequence = 0, overlappingContexts = false;
	let context: { sequence: number; reads: Reads } | null = null;
	let lastContext: { sequence: number; reads: ReturnType<typeof readSnapshot> } | null = null;
	function beginContext() {
		if (context) overlappingContexts = true;
		context = { sequence: ++sequence, reads: reads() };
		return sequence;
	}
	function endContext(id: number) {
		if (context?.sequence !== id) return;
		lastContext = { sequence: id, reads: readSnapshot(context.reads) };
		context = null;
	}
	function read(kind: ReadKind, identity: string, byteCount: number | null) {
		if (!Object.prototype.hasOwnProperty.call(allReads.byKind, kind)) return;
		for (const target of context ? [allReads, context.reads] : [allReads]) {
			for (const value of [target.total, target.byKind[kind]]) {
				value.calls = add(value.calls, 1);
				if (valid(byteCount)) value.bytes = add(value.bytes, byteCount);
				else value.failures = add(value.failures, 1);
			}
			if (!valid(byteCount)) continue;
			// Callers pass a canonical-path digest, never raw file paths or content.
			if (!/^[a-f0-9]{64}$/.test(identity)) { target.fileTrackingTruncated = true; continue; }
			if (target.files.has(identity)) target.repeatedPathReadsAtLeast = add(target.repeatedPathReadsAtLeast, 1);
			else if (target.files.size < maxFiles) target.files.add(identity);
			else target.fileTrackingTruncated = true;
		}
	}
	function reference(kind: ReferenceKind, amount = 1) {
		if (!valid(amount) || !Object.prototype.hasOwnProperty.call(allReads.logicalReferences, kind)) return;
		for (const target of context ? [allReads, context.reads] : [allReads]) target.logicalReferences[kind] = add(target.logicalReferences[kind], amount);
	}
	function sourceCache(kind: "hit" | "miss" | "invalidated" | "capacityBypass", sourceBytes = 0) {
		const field = { hit: "hits", miss: "misses", invalidated: "invalidations", capacityBypass: "capacityBypasses" }[kind] as "hits" | "misses" | "invalidations" | "capacityBypasses";
		if (!field || !valid(sourceBytes)) return;
		for (const target of context ? [allReads, context.reads] : [allReads]) {
			target.sourceCache[field] = add(target.sourceCache[field], 1);
			if (kind === "hit") target.sourceCache.reusedSourceBytes = add(target.sourceCache.reusedSourceBytes, sourceBytes);
		}
	}
	const estimate = () => ({ checks: 0, allowed: 0, blocked: 0, latest: null as null | { allowed: boolean | null; estimatedInputTokens: number | null; serializedInputBytes: number | null; totalWithReserves: number | null; limit: number | null } });
	const contextPreflight = estimate(), providerPayloadAudit = estimate();
	function plan(stage: "context-preflight" | "provider-audit", result: unknown) {
		const target = stage === "provider-audit" ? providerPayloadAudit : contextPreflight;
		target.checks = add(target.checks, 1);
		try {
			const value = result as { allowed?: unknown; ledger?: Record<string, unknown> } | null;
			const allowed = typeof value?.allowed === "boolean" ? value.allowed : null;
			if (allowed === true) target.allowed = add(target.allowed, 1);
			if (allowed === false) target.blocked = add(target.blocked, 1);
			target.latest = { allowed, estimatedInputTokens: number(value?.ledger?.inputEstimate), serializedInputBytes: number(value?.ledger?.rawInputBytes),
				totalWithReserves: number(value?.ledger?.total), limit: number(value?.ledger?.limit) };
		} catch { target.latest = null; }
	}
	const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
	type Field = typeof fields[number];
	const sums: Record<Field, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	const samples = { ...sums };
	const seenMessages = new WeakSet<object>();
	let responses = 0, unknownResponses = 0, failedOrAbortedResponses = 0;
	function usage(message: unknown) {
		if (!message || typeof message !== "object" || seenMessages.has(message)) return;
		try { if ((message as { role?: unknown }).role !== "assistant") return; } catch { return; }
		seenMessages.add(message);
		responses = add(responses, 1);
		let values: Record<Field, number | null> = { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null };
		try {
			const value = message as { usage?: Record<string, unknown>; stopReason?: string };
			if (value.stopReason === "error" || value.stopReason === "aborted") failedOrAbortedResponses = add(failedOrAbortedResponses, 1);
			const parsed = Object.fromEntries(fields.map(key => [key, number(value.usage?.[key])])) as Record<Field, number | null>;
			// Pi initializes absent usage to all zero, including failed requests.
			// An all-zero object cannot establish a free / zero-token response.
			if (fields.some(key => (parsed[key] ?? 0) > 0)) values = parsed;
		} catch { /* Keep unknown; never retain raw response/error/credential data. */ }
		if (fields.some(key => values[key] === null)) unknownResponses = add(unknownResponses, 1);
		for (const key of fields) if (values[key] !== null) { sums[key] = add(sums[key], values[key]!); samples[key] = add(samples[key], 1); }
	}
	function snapshot() {
		const snapshotEstimate = (value: ReturnType<typeof estimate>) => ({ ...value, latest: value.latest ? { ...value.latest } : null });
		return {
			version: 1, scope: "active-run-in-process", overflow,
			contextPreflight: snapshotEstimate(contextPreflight), providerPayloadAudit: snapshotEstimate(providerPayloadAudit),
			sdkUsage: { source: "sdk-assistant-message", responses, unknownResponses, failedOrAbortedResponses,
				totals: Object.fromEntries(fields.map(key => [key, responses > 0 && samples[key] === responses ? sums[key] : null])),
				knownSubtotals: { ...sums }, samples: { ...samples }, cacheBreakdownVerified: false, costUsd: null },
			transport: { source: "not-observable-in-extension", httpDispatches: null, retries: null, summaryRequests: null, taskTotalComplete: false },
			reads: { coverage: "budgeted-extension-readFile-calls-only", ...readSnapshot(allReads), lastContext: lastContext ? JSON.parse(JSON.stringify(lastContext)) as typeof lastContext : null, overlappingContexts },
		};
	}
	return { read, reference, sourceCache, plan, usage, beginContext, endContext, snapshot };
}
