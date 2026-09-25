export interface TransportOwner { projectId: string; sessionId: string; role: string | null; taskId: string; }
export type TransportKind = "ordinary" | "summary" | "branchSummary";

/** Bounded scalar journal; no prompts, bodies, headers, URLs, error text or keys.
 * A dispatch reservation is durable BEFORE handing bytes to fetch. A reservation
 * is an attempt, not proof that the server received or billed a request.
 * Embedded in the managed extension: keep runtime dependencies injected.
 */
export function createTaskTransportLedger(deps: { digest: (text: string) => string }) {
	const customType = "pi-desktop-transport-ledger/v1";
	const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
	const counters = ["ordinary", "summary", "branchSummary", "completed", "errors", "aborted", "unknown", "fetchAttempts", "dispatchAttempts", "blockedBeforeDispatch", "redispatches", "httpErrors", "bodiesComplete", "bodiesUnknown", "requestBytes", "responseBytes", "unsupportedCalls", "missingFetchCalls", "redirectedResponses", "interruptedCalls", "usageResponses", "unknownUsageResponses"] as const;
	type Counter = typeof counters[number];
	type Pending = { id: number; kind: TransportKind; supported: boolean; fetches: number; attempts: number[] };
	type State = { version: number; owner: TransportOwner; counters: Record<Counter, number>; usageSums: Record<string, number>; usageSamples: Record<string, number>; pending: Pending[] };
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
	const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	const ownerKey = (value: TransportOwner) => JSON.stringify([value.projectId, value.sessionId, value.role, value.taskId]);
	const owner = (value: TransportOwner): TransportOwner => {
		const result = { projectId: value?.projectId, sessionId: value?.sessionId, role: value?.role, taskId: value?.taskId };
		if ([result.projectId, result.sessionId, result.taskId].some(item => typeof item !== "string" || !item || item.length > 256 || /[\u0000-\u001f]/.test(item))
			|| (result.role !== null && (typeof result.role !== "string" || !/^[a-z_-]{1,32}$/.test(result.role)))) throw new Error("TRANSPORT_OWNER_INVALID");
		return result;
	};
	const zero = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, 0]));
	const blank = (scope: TransportOwner): State => ({ version: 1, owner: owner(scope), counters: zero(counters) as State["counters"], usageSums: zero(fields), usageSamples: zero(fields), pending: [] });
	const read = (raw: any, scope: TransportOwner): State => {
		if (!raw || typeof raw !== "object" || JSON.stringify(raw).length > 32_000 || typeof raw.sha256 !== "string") throw new Error("TRANSPORT_LEDGER_INVALID");
		const { sha256, ...value } = raw;
		if (sha256 !== deps.digest(JSON.stringify(value)) || value.version !== 1 || ownerKey(owner(value.owner)) !== ownerKey(scope)) throw new Error("TRANSPORT_LEDGER_INVALID");
		if (Object.keys(value.owner).sort().join() !== "projectId,role,sessionId,taskId") throw new Error("TRANSPORT_LEDGER_INVALID");
		for (const [key, names] of [["counters", counters], ["usageSums", fields], ["usageSamples", fields]] as const) {
			if (!value[key] || Object.keys(value[key]).sort().join() !== [...names].sort().join() || names.some(name => !valid(value[key][name]))) throw new Error("TRANSPORT_LEDGER_INVALID");
		}
		if (Object.keys(value).sort().join() !== ["version", "owner", "counters", "usageSums", "usageSamples", "pending"].sort().join()
			|| !Array.isArray(value.pending) || value.pending.length > 16) throw new Error("TRANSPORT_LEDGER_INVALID");
		const ids = new Set<number>();
		for (const item of value.pending) {
			if (!item || !valid(item.id) || item.id < 1 || ids.has(item.id) || !["ordinary", "summary", "branchSummary"].includes(item.kind)
				|| typeof item.supported !== "boolean" || !valid(item.fetches) || !Array.isArray(item.attempts) || item.attempts.length > 32
				|| item.attempts.some((n: unknown) => !valid(n) || n < 1 || n > item.fetches) || new Set(item.attempts).size !== item.attempts.length
				|| Object.keys(item).sort().join() !== ["id", "kind", "supported", "fetches", "attempts"].sort().join()) throw new Error("TRANSPORT_LEDGER_INVALID");
			ids.add(item.id);
		}
		return clone(value) as State;
	};
	let active: { key: string; meter: ReturnType<typeof make> } | null = null;
	function make(scope: TransportOwner, state: State, append: (type: string, data: unknown) => void, isCurrent: () => boolean) {
		let poisoned = false;
		let restoredPending = state.pending.length;
		const assertCurrent = () => { if (poisoned) throw new Error("TRANSPORT_JOURNAL_FAILURE"); if (!isCurrent() || active?.meter !== meter) throw new Error("TRANSPORT_STALE_OWNER"); };
		const add = (value: number, amount: number) => { if (!valid(amount) || !Number.isSafeInteger(value + amount)) throw new Error("TRANSPORT_COUNTER_LIMIT"); return value + amount; };
		const bump = (next: State, name: Counter, amount = 1) => { next.counters[name] = add(next.counters[name], amount); };
		const change = <T>(fn: (next: State) => T): T => {
			assertCurrent(); const next = clone(state);
			if (restoredPending) {
				bump(next, "interruptedCalls", next.pending.length); bump(next, "unknown", next.pending.length);
				bump(next, "bodiesUnknown", next.pending.reduce((n, item) => n + item.attempts.length, 0));
				next.pending = [];
			}
			const result = fn(next);
			try { assertCurrent(); append(customType, { ...next, sha256: deps.digest(JSON.stringify(next)) }); }
			catch { poisoned = true; throw new Error("TRANSPORT_JOURNAL_FAILURE"); }
			state = next; restoredPending = 0; return result;
		};
		const find = (next: State, id: number) => { const item = next.pending.find(row => row.id === id); if (!item) throw new Error("TRANSPORT_INVOCATION_UNKNOWN"); return item; };
		const meter = {
			assertCurrent,
			begin(kind: TransportKind, supported: boolean) {
				return change(next => {
					if (!["ordinary", "summary", "branchSummary"].includes(kind) || next.pending.length >= 16) throw new Error("TRANSPORT_INVOCATION_LIMIT");
					bump(next, kind); if (!supported) bump(next, "unsupportedCalls");
					const id = next.counters.ordinary + next.counters.summary + next.counters.branchSummary;
					if (!valid(id)) throw new Error("TRANSPORT_COUNTER_LIMIT");
					next.pending.push({ id, kind, supported, fetches: 0, attempts: [] }); return id;
				});
			},
			attempt(id: number, bytes: number, dispatch: boolean) {
				return change(next => {
					const item = find(next, id); if (item.attempts.length >= 32) throw new Error("TRANSPORT_ATTEMPT_LIMIT");
					if (item.fetches > 0) bump(next, "redispatches"); item.fetches++;
					bump(next, "fetchAttempts"); bump(next, dispatch ? "dispatchAttempts" : "blockedBeforeDispatch");
					if (dispatch) { bump(next, "requestBytes", bytes); item.attempts.push(item.fetches); }
					return item.fetches;
				});
			},
			settleAttempt(id: number, attempt: number, result: "complete" | "httpError" | "unknown", bytes: number, redirected = false) {
				if (!state.pending.find(row => row.id === id)?.attempts.includes(attempt)) return;
				change(next => {
					const item = find(next, id); item.attempts = item.attempts.filter(value => value !== attempt);
					bump(next, result === "complete" ? "bodiesComplete" : result === "httpError" ? "httpErrors" : "bodiesUnknown");
					bump(next, "responseBytes", bytes); if (redirected) bump(next, "redirectedResponses");
				});
			},
			finish(id: number, result: "complete" | "error" | "aborted" | "unknown", usage: any) {
				if (!state.pending.some(row => row.id === id)) return;
				change(next => {
					const item = find(next, id);
					bump(next, result === "complete" ? "completed" : result === "error" ? "errors" : result === "aborted" ? "aborted" : "unknown");
					if (!item.fetches && item.supported) bump(next, "missingFetchCalls");
					bump(next, "bodiesUnknown", item.attempts.length);
					bump(next, "usageResponses");
					const known = fields.some(field => valid(usage?.[field]) && usage[field] > 0);
					if (!known || fields.some(field => !valid(usage?.[field]))) bump(next, "unknownUsageResponses");
					for (const field of fields) if (known && valid(usage?.[field])) {
						next.usageSums[field] = add(next.usageSums[field], usage[field]); next.usageSamples[field] = add(next.usageSamples[field], 1);
					}
					next.pending = next.pending.filter(row => row.id !== id);
				});
			},
			snapshot() {
				const incomplete = restoredPending > 0 || state.pending.length > 0 || state.counters.interruptedCalls > 0 || state.counters.unknown > 0;
				return { version: 1, owner: { ...state.owner }, status: poisoned ? "journal-failed" : "observed",
					coverage: "observed-provider-invocations-and-scoped-fetch-attempts", taskTotalComplete: false,
					counters: { ...state.counters }, openCalls: state.pending.length - restoredPending, coldUnsettled: restoredPending,
					sdkUsage: { source: "sdk-provider-terminal-message", totals: Object.fromEntries(fields.map(field => [field, !incomplete && state.counters.usageResponses > 0 && state.usageSamples[field] === state.counters.usageResponses ? state.usageSums[field] : null])), knownSubtotals: { ...state.usageSums }, samples: { ...state.usageSamples }, cacheBreakdownVerified: false, costUsd: null },
					httpRequests: null, agentRetryClassification: "unavailable", preMeterHistoryIncluded: false };
			},
		};
		return meter;
	}
	return {
		customType,
		reset() { active = null; },
		current(scope: TransportOwner) { return active?.key === ownerKey(owner(scope)) ? active.meter : null; },
		open(scope: TransportOwner, branch: any[], append: (type: string, data: unknown) => void, isCurrent: () => boolean) {
			const key = ownerKey(owner(scope)); if (active?.key === key) return active.meter;
			const latest = [...branch].reverse().find(entry => entry?.type === "custom" && entry.customType === customType && ownerKey(owner(entry.data?.owner)) === key);
			const meter = make(scope, latest ? read(latest.data, scope) : blank(scope), append, isCurrent);
			active = { key, meter }; return meter;
		},
	};
}
