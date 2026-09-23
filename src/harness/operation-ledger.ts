import type { RunScope } from "./types.js";

export type OperationState = "issued" | "completed" | "unknown" | "cancelled" | "failed";

export interface OperationIntent {
	scope: RunScope;
	toolCallId: string;
	toolName: "write" | "edit" | string;
	target: string;
	preHash: string | null;
	expectedPostHash: string | null;
	argsDigest: string;
}

export interface OperationDecision {
	action: "dispatch" | "satisfied" | "blocked";
	operationId: string;
	state: OperationState;
	reason?: string;
}

export interface OperationRecord extends OperationIntent {
	operationId: string;
	target: string;
	state: OperationState;
	dispatched: boolean;
	acknowledgedPostHash: string | null;
}

export interface OperationLedger {
	prepare(intent: OperationIntent, currentFingerprint: string | null): OperationDecision;
	markDispatched(operationId: string): OperationDecision;
	complete(operationId: string, postHash: string | null): OperationDecision;
	completeAcknowledged(operationId: string, observedPostHash: string): OperationDecision;
	completeFailed(operationId: string, observedFingerprint: string | null): OperationDecision;
	cancel(operationId: string): OperationDecision;
	snapshot(): OperationRecord[];
}

/**
 * Bounded process-local reconciliation for write/edit tool calls. This is intentionally
 * self-contained: generated Pi extensions may embed `createOperationLedger.toString()`.
 * It stores fingerprints and scope metadata only, never file contents or raw arguments.
 */
export function createOperationLedger(options: { maxEntries?: number } = {}): OperationLedger {
	type InternalRecord = OperationRecord & { signature: string; sequence: number };
	const maxEntries = options.maxEntries ?? 2048;
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError("maxEntries must be a positive safe integer");
	const entries = new Map<string, InternalRecord>();
	let sequence = 0;

	const clean = (value: string, name: string): string => {
		const result = value.trim();
		if (!result) throw new TypeError(`${name} must not be empty`);
		return result;
	};
	const normalizeTarget = (value: string): string => {
		const input = clean(value, "target").replaceAll("\\", "/");
		const prefix = input.startsWith("/") ? "/" : "";
		const parts: string[] = [];
		for (const part of input.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") { if (parts.length && parts.at(-1) !== "..") parts.pop(); else parts.push(part); }
			else parts.push(part);
		}
		return prefix + parts.join("/");
	};
	const scopeSignature = (scope: RunScope): string => JSON.stringify([
		clean(scope.projectId, "scope.projectId"), clean(scope.sessionId, "scope.sessionId"),
		clean(scope.runId, "scope.runId"), scope.generation, scope.role,
	]);
	const normalize = (intent: OperationIntent): OperationIntent => {
		if (!Number.isSafeInteger(intent.scope.generation) || intent.scope.generation < 0) throw new TypeError("scope.generation must be a non-negative safe integer");
		return {
			scope: { ...intent.scope, projectId: clean(intent.scope.projectId, "scope.projectId"), sessionId: clean(intent.scope.sessionId, "scope.sessionId"), runId: clean(intent.scope.runId, "scope.runId"), role: intent.scope.role === null ? null : clean(intent.scope.role, "scope.role") },
			toolCallId: clean(intent.toolCallId, "toolCallId"), toolName: clean(intent.toolName, "toolName"),
			target: normalizeTarget(intent.target), preHash: intent.preHash, expectedPostHash: intent.expectedPostHash,
			argsDigest: clean(intent.argsDigest, "argsDigest"),
		};
	};
	// preHash describes observed state, not operation identity. A replay of the same
	// tool call may arrive after the write and therefore observe a different preHash.
	const signature = (item: OperationIntent): string => JSON.stringify([scopeSignature(item.scope), item.toolName, item.target, item.expectedPostHash, item.argsDigest]);
	const targetScope = (item: OperationIntent): string => JSON.stringify([
		item.scope.projectId, item.scope.sessionId, item.scope.role, item.target,
	]);
	const intendedPost = (record: InternalRecord): string | null => record.expectedPostHash ?? record.acknowledgedPostHash;
	const decision = (record: InternalRecord, action: OperationDecision["action"], reason?: string): OperationDecision => ({ action, operationId: record.operationId, state: record.state, ...(reason ? { reason } : {}) });
	// Terminal execution history is immutable. "satisfied" is a separate verdict
	// about bytes observed now, never a synonym for having completed in the past.
	const terminalDecision = (record: InternalRecord, observed?: string | null): OperationDecision | null => {
		if (record.state === "failed") return decision(record, "blocked", "repair-required");
		if (record.state === "cancelled") return decision(record, "blocked", "operation-cancelled");
		if (record.state !== "completed") return null;
		if (observed === undefined) return decision(record, "blocked", "operation-already-completed");
		const post = intendedPost(record);
		return post !== null && observed === post ? decision(record, "satisfied", "expected-post-state-observed")
			: decision(record, "blocked", post === null ? "post-state-not-reconcilable" : "completed-state-no-longer-observed");
	};
	const requireRecord = (id: string): InternalRecord => { const record = entries.get(clean(id, "operationId")); if (!record) throw new Error(`Unknown operation: ${id}`); return record; };
	// Entries double as bounded tombstones. Never evict an operation ID inside a
	// process: eviction would allow an old ID to be accepted as a fresh dispatch.
	const hasSpace = (): boolean => entries.size < maxEntries;

	return {
		prepare(rawIntent, currentFingerprint) {
			const item = normalize(rawIntent);
			const existing = entries.get(item.toolCallId);
			if (existing) {
				if (existing.signature !== signature(item)) return decision(existing, "blocked", "operation-id-collision");
				const terminal = terminalDecision(existing, currentFingerprint); if (terminal) return terminal;
				if (!existing.dispatched) return decision(existing, "blocked", existing.state === "issued" ? "operation-in-flight" : "operation-not-dispatched");
				const post = intendedPost(existing);
				if (post !== null && currentFingerprint === post) { existing.state = "completed"; return decision(existing, "satisfied", "expected-post-state-observed"); }
				existing.state = "unknown";
				return decision(existing, "blocked", post === null ? "post-state-not-reconcilable" : "post-state-conflict");
			}

			// A model can retry the same intent under a new toolCallId (and a new run).
			// Resolve all earlier writes to this target before admitting another write.
			const related = [...entries.values()].filter((record) => targetScope(record) === targetScope(item));
			// Do not let an older success hide a later unresolved operation. Also do
			// not infer completion for an intent that was certainly never dispatched.
			for (const prior of related) if ((prior.state === "issued" || prior.state === "unknown") &&
				(!prior.dispatched || intendedPost(prior) === null || currentFingerprint !== intendedPost(prior))) {
				return { action: "blocked", operationId: item.toolCallId, state: "unknown", reason: "prior-target-operation-unresolved" };
			}
			for (const prior of related) {
				if (prior.state === "cancelled" && !prior.dispatched) continue;
				if (prior.state === "failed") {
					if (prior.toolName === item.toolName && prior.argsDigest === item.argsDigest) {
						return { action: "blocked", operationId: item.toolCallId, state: "failed", reason: "repair-required" };
					}
					continue;
				}
				const priorPost = intendedPost(prior);
				if (prior.state === "completed" && prior.toolName === item.toolName && prior.argsDigest === item.argsDigest && (priorPost === null || currentFingerprint !== priorPost)) {
					return { ...terminalDecision(prior, currentFingerprint)!, operationId: item.toolCallId };
				}
				if (priorPost !== null && currentFingerprint === priorPost) {
					prior.state = "completed";
					if (prior.toolName === item.toolName && prior.argsDigest === item.argsDigest && prior.expectedPostHash === item.expectedPostHash) {
						if (!hasSpace()) return { action: "blocked", operationId: item.toolCallId, state: "unknown", reason: "ledger-capacity" };
						const satisfied: InternalRecord = { ...item, operationId: item.toolCallId, state: "completed", dispatched: false, acknowledgedPostHash: prior.acknowledgedPostHash, signature: signature(item), sequence: ++sequence };
						entries.set(satisfied.operationId, satisfied);
						return decision(satisfied, "satisfied", "prior-intent-post-state-observed");
					}
					continue;
				}
				if (prior.state === "issued" || prior.state === "unknown") {
					return { action: "blocked", operationId: item.toolCallId, state: "unknown", reason: "prior-target-operation-unresolved" };
				}
			}

			if (!hasSpace()) return { action: "blocked", operationId: item.toolCallId, state: "unknown", reason: "ledger-capacity" };
			const record: InternalRecord = { ...item, operationId: item.toolCallId, state: "issued", dispatched: false, acknowledgedPostHash: null, signature: signature(item), sequence: ++sequence };
			entries.set(record.operationId, record);
			if (currentFingerprint !== item.preHash) { record.state = "unknown"; return decision(record, "blocked", "pre-state-conflict"); }
			return decision(record, "dispatch");
		},
		markDispatched(operationId) {
			const record = requireRecord(operationId);
			if (record.state !== "issued" || record.dispatched) return decision(record, "blocked", "operation-not-dispatchable");
			record.dispatched = true;
			return decision(record, "blocked", "dispatch-recorded");
		},
		complete(operationId, postHash) {
			const record = requireRecord(operationId);
			const terminal = terminalDecision(record, postHash); if (terminal) return terminal;
			if (!record.dispatched) return decision(record, "blocked", "operation-not-dispatched");
			if (record.expectedPostHash === null || postHash !== record.expectedPostHash) { record.state = "unknown"; return decision(record, "blocked", "completion-fingerprint-mismatch"); }
			record.state = "completed";
			return decision(record, "satisfied", "tool-result-confirmed");
		},
		completeAcknowledged(operationId, observedPostHash) {
			const record = requireRecord(operationId);
			const terminal = terminalDecision(record, observedPostHash); if (terminal) return terminal;
			if (!record.dispatched) return decision(record, "blocked", "operation-not-dispatched");
			const observed = clean(observedPostHash, "observedPostHash");
			if (record.expectedPostHash !== null && observed !== record.expectedPostHash) { record.state = "unknown"; return decision(record, "blocked", "completion-fingerprint-mismatch"); }
			record.acknowledgedPostHash = observed;
			record.state = "completed";
			return decision(record, "satisfied", "tool-result-acknowledged");
		},
		completeFailed(operationId, observedFingerprint) {
			const record = requireRecord(operationId);
			const terminal = terminalDecision(record, observedFingerprint); if (terminal) return terminal;
			if (!record.dispatched) return decision(record, "blocked", "operation-not-dispatched");
			const post = intendedPost(record);
			if (post !== null && observedFingerprint === post) {
				record.state = "completed";
				return decision(record, "satisfied", "expected-post-state-observed");
			}
			if (observedFingerprint === record.preHash) {
				record.state = "failed";
				return decision(record, "blocked", "confirmed-failure-no-change");
			}
			record.state = "unknown";
			return decision(record, "blocked", "failure-state-conflict");
		},
		cancel(operationId) {
			const record = requireRecord(operationId);
			const terminal = terminalDecision(record); if (terminal) return terminal;
			record.state = record.dispatched ? "unknown" : "cancelled";
			return decision(record, "blocked", record.dispatched ? "cancelled-after-dispatch" : "cancelled-before-dispatch");
		},
		snapshot() {
			return [...entries.values()].sort((a, b) => a.sequence - b.sequence).map(({ signature: _signature, sequence: _sequence, ...record }) => ({ ...record, scope: { ...record.scope } }));
		},
	};
}
