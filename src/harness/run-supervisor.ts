import type { RunScope } from "./types.js";
import type { ToolErrorKind } from "./tool-policy.js";

export type RunSupervisorState = "RUNNING" | "BLOCKED_USER" | "BLOCKED_PREREQUISITE" | "NO_PROGRESS" | "CANCELLED" | "FAILED" | "COMPLETED_CANDIDATE";
export interface VerificationReceiptInput {
	callId: string; subject: string; artifactSha256: string | null; errorDigest: string | null; passed: boolean; full: boolean;
	/** Host-validated mechanical hints, not model-supplied evidence or write authority. */
	mode?: string; relatedSourcesDigest?: string; diagnostics?: Record<string, number>;
}
export interface VerificationProgressTrack {
	subject: string; mode: string; relatedSourcesDigest: string | null;
	bestDiagnostics: Record<string, number>; attempts: number;
}
export interface RunSupervisorSnapshot {
	schemaVersion: 1 | 2; id: string; scope: RunScope; state: RunSupervisorState; reasonCode: string | null;
	toolCalls: number; turns: number; verificationAttempts: number; evidenceCount: number; unchangedAttempts: number; userAccepted: false;
	evidenceDigests: string[]; artifactHashes: Record<string, string>; failureSignatures: Record<string, number>;
	seenToolCallIds: string[]; seenVerificationCallIds: string[]; verificationFingerprints: Record<string, string>;
	lastVerificationSubject: string | null;
	lastVerification: { subject: string; artifactSha256: string | null; errorDigest: string | null; passed: boolean; full: boolean; evidenceCount: number } | null;
	verificationReceipts: Record<string, { artifactSha256: string | null; errorDigest: string | null; passed: boolean; full: boolean; evidenceCount: number }>;
	lastFailureSignature: string | null;
	/** Required in schema 2; omitted from legacy schema 1 to preserve its seal. */
	verificationProgress?: Record<string, VerificationProgressTrack>;
}
export interface ToolGate { allowed: boolean; snapshot: RunSupervisorSnapshot | null }
export interface RunSupervisor {
	begin(scope: RunScope): RunSupervisorSnapshot;
	snapshot(scope?: RunScope): RunSupervisorSnapshot | null;
	tool(scope: RunScope, callId: string, name: string): ToolGate;
	turn(scope: RunScope): RunSupervisorSnapshot | null;
	evidence(scope: RunScope, identity: string): RunSupervisorSnapshot | null;
	artifact(scope: RunScope, path: string, sha256: string): RunSupervisorSnapshot | null;
	verification(scope: RunScope, value: VerificationReceiptInput): RunSupervisorSnapshot | null;
	failure(scope: RunScope, value: { kind: ToolErrorKind; code: string; signature?: string }): RunSupervisorSnapshot | null;
	stop(scope: RunScope, state: Exclude<RunSupervisorState, "RUNNING">, reasonCode: string): RunSupervisorSnapshot | null;
	finish(scope: RunScope, value: { stopReason: string; hasText: boolean; checkpointReady: boolean; pendingOperations: boolean; completionVerified: boolean; completionReason?: "STOP_VERIFIED" | "REPLY_ONLY" | "INSPECTION_COMPLETE" | "UNBOUND_REPLY" }): RunSupervisorSnapshot | null;
	parse(raw: unknown): RunSupervisorSnapshot;
	restore(raw: unknown, expectedScope?: RunScope): RunSupervisorSnapshot;
}

/** Dependency-free deterministic run supervision; safe to embed via this function's toString(). */
export function createRunSupervisor(options: { digest: (text: string) => string; noProgressLimit?: number; maxToolCalls?: number; maxTurns?: number; maxVerificationAttempts?: number }): RunSupervisor {
	if (!options || typeof options !== "object" || typeof options.digest !== "function") throw new TypeError("digest is required and must be a function");
	const limit = (value: number | undefined, fallback: number, name: string): number => {
		const result = value ?? fallback;
		if (!Number.isSafeInteger(result) || result < 1 || result > 4096) throw new TypeError(`${name} must be a positive bounded safe integer`);
		return result;
	};
	const noProgressLimit = limit(options.noProgressLimit, 3, "noProgressLimit");
	const maxToolCalls = limit(options.maxToolCalls, 96, "maxToolCalls");
	const maxTurns = limit(options.maxTurns, 32, "maxTurns");
	const maxVerificationAttempts = limit(options.maxVerificationAttempts, 12, "maxVerificationAttempts");
	const maxBytes = 256 * 1024; const runtimeMaxBytes = maxBytes - 1024; const encoder = new TextEncoder();
	let current: RunSupervisorSnapshot | null = null;
	const object = (value: unknown, name: string): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`); return value as Record<string, unknown>; };
	const exact = (value: Record<string, unknown>, fields: readonly string[], name: string): void => { for (const key of Object.keys(value)) if (!fields.includes(key)) throw new TypeError(`${name} has unexpected property ${key}`); };
	const text = (value: unknown, name: string, max = 4096): string => { if (typeof value !== "string" || value.length < 1) throw new TypeError(`${name} must be a non-empty string`); if (value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`${name} is invalid`); return value; };
	const integer = (value: unknown, name: string): number => { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) throw new TypeError(`${name} must be a bounded non-negative safe integer`); return value as number; };
	const sha = (value: unknown, name: string): string => { const result = text(value, name, 64).toLowerCase(); if (!/^[0-9a-f]{64}$/.test(result)) throw new TypeError(`${name} must be a SHA-256 hex digest`); return result; };
	const reservedKey = (value: string): boolean => value === "__proto__" || value === "constructor" || value === "prototype";
	const diagnosticsValue = (raw: unknown): Record<string, number> => {
		const source = object(raw, "diagnostics"); const keys = Object.keys(source).sort();
		if (!keys.length || keys.length > 128) throw new TypeError("diagnostics must be non-empty and bounded");
		const result: Record<string, number> = {};
		for (const key of keys) {
			text(key, "diagnostic key", 128); if (reservedKey(key)) throw new TypeError("diagnostic key is reserved");
			const value = source[key]; if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000_000) throw new TypeError("diagnostic severity must be positive and bounded");
			result[key] = value as number;
		}
		return result;
	};
	const modeValue = (value: unknown): string => { const result = text(value, "mode", 262); if (!/^(?:full|scene:.+)$/.test(result)) throw new TypeError("invalid verification mode"); return result; };
	const trackKey = (subject: string, mode: string, related: string | null, diagnostics: Record<string, number>): string => "verification_" + text(options.digest(JSON.stringify([subject, mode, related, Object.keys(diagnostics).sort()])), "digest result", 128);
	const safePath = (value: unknown): string => { const result = text(value, "path"); if (result.includes("\\") || result.startsWith("/") || /^[a-z]:/i.test(result) || result.split("/").some((part) => !part || part === "." || part === ".." || reservedKey(part))) throw new TypeError("path must be a safe project-relative path"); return result; };
	const scopeValue = (value: unknown): RunScope => { const raw = object(value, "scope"); exact(raw, ["projectId", "sessionId", "runId", "generation", "role"], "scope"); return { projectId: text(raw.projectId, "scope.projectId"), sessionId: text(raw.sessionId, "scope.sessionId"), runId: text(raw.runId, "scope.runId"), generation: integer(raw.generation, "scope.generation"), role: raw.role === null ? null : text(raw.role, "scope.role") }; };
	const scopeKey = (scope: RunScope): string => JSON.stringify([scope.projectId, scope.sessionId, scope.runId, scope.generation, scope.role]);
	const clone = (value: RunSupervisorSnapshot): RunSupervisorSnapshot => JSON.parse(JSON.stringify(value)) as RunSupervisorSnapshot;
	const frozen = (value: RunSupervisorSnapshot): RunSupervisorSnapshot => { const copy = clone(value); Object.freeze(copy.scope); Object.freeze(copy.evidenceDigests); Object.freeze(copy.artifactHashes); Object.freeze(copy.failureSignatures); Object.freeze(copy.seenToolCallIds); Object.freeze(copy.seenVerificationCallIds); Object.freeze(copy.verificationFingerprints); if (copy.lastVerification) Object.freeze(copy.lastVerification); for (const receipt of Object.values(copy.verificationReceipts)) Object.freeze(receipt); Object.freeze(copy.verificationReceipts); for (const track of Object.values(copy.verificationProgress ?? {})) { Object.freeze(track.bestDiagnostics); Object.freeze(track); } if (copy.verificationProgress) Object.freeze(copy.verificationProgress); return Object.freeze(copy); };
	const identityContent = (value: Omit<RunSupervisorSnapshot, "id">): string => JSON.stringify(value);
	const seal = (value: Omit<RunSupervisorSnapshot, "id">): RunSupervisorSnapshot => ({ ...value, id: `run_${text(options.digest(identityContent(value)), "digest result")}` });
	const set = (patch: Partial<Omit<RunSupervisorSnapshot, "id" | "scope" | "userAccepted">>): RunSupervisorSnapshot => { if (!current) throw new Error("No active run"); const { id: _id, ...content } = current; let candidate = seal({ ...content, ...patch, scope: clone(current).scope, userAccepted: false }); if (encoder.encode(JSON.stringify(candidate)).byteLength > runtimeMaxBytes) candidate = seal({ ...content, state: "FAILED", reasonCode: "CAPACITY", scope: clone(current).scope, userAccepted: false }); current = candidate; return frozen(current); };
	const owned = (scope: RunScope): boolean => !!current && scopeKey(scopeValue(scope)) === scopeKey(current.scope);
	const terminal = (): boolean => !!current && current.state !== "RUNNING";
	const stopInternal = (state: Exclude<RunSupervisorState, "RUNNING">, reasonCode: string): RunSupervisorSnapshot => terminal() ? frozen(current!) : set({ state, reasonCode });
	const parse = (raw: unknown): RunSupervisorSnapshot => {
		if (typeof raw === "string" && encoder.encode(raw).byteLength > maxBytes) throw new TypeError("snapshot exceeds maxBytes");
		const value = object(raw, "snapshot"); if (encoder.encode(JSON.stringify(value)).byteLength > maxBytes) throw new TypeError("snapshot exceeds maxBytes");
		const fields = ["schemaVersion", "id", "scope", "state", "reasonCode", "toolCalls", "turns", "verificationAttempts", "evidenceCount", "unchangedAttempts", "userAccepted", "evidenceDigests", "artifactHashes", "failureSignatures", "seenToolCallIds", "seenVerificationCallIds", "verificationFingerprints", "lastVerificationSubject", "lastVerification", "verificationReceipts", "lastFailureSignature"];
		if (value.schemaVersion !== 1 && value.schemaVersion !== 2) throw new TypeError("snapshot.schemaVersion must be 1 or 2");
		if (value.schemaVersion === 2) fields.push("verificationProgress");
		exact(value, fields, "snapshot"); if (value.userAccepted !== false) throw new TypeError("snapshot.userAccepted must be false");
		const states = ["RUNNING", "BLOCKED_USER", "BLOCKED_PREREQUISITE", "NO_PROGRESS", "CANCELLED", "FAILED", "COMPLETED_CANDIDATE"];
		if (!states.includes(value.state as string)) throw new TypeError("snapshot.state is invalid");
		const list = (input: unknown, name: string): string[] => { if (!Array.isArray(input) || input.length > 4096) throw new TypeError(`${name} must be a bounded array`); const result = input.map((item, i) => text(item, `${name}[${i}]`)); if (new Set(result).size !== result.length) throw new TypeError(`${name} must not contain duplicates`); return result; };
		const map = (input: unknown, name: string, values: "text" | "integer"): Record<string, string> | Record<string, number> => { const source = object(input, name); if (Object.keys(source).length > 4096) throw new TypeError(`${name} exceeds its item limit`); const result: Record<string, string | number> = Object.create(null) as Record<string, string | number>; for (const key of Object.keys(source)) { const safeKey = text(key, `${name} key`); if (safeKey === "__proto__" || safeKey === "constructor" || safeKey === "prototype") throw new TypeError(`${name} contains a reserved key`); result[safeKey] = values === "text" ? text(source[key], `${name}.${key}`) : integer(source[key], `${name}.${key}`); } return result as Record<string, string> | Record<string, number>; };
		let lastVerification: RunSupervisorSnapshot["lastVerification"] = null;
		if (value.lastVerification !== null) { const receipt = object(value.lastVerification, "lastVerification"); exact(receipt, ["subject", "artifactSha256", "errorDigest", "passed", "full", "evidenceCount"], "lastVerification"); if (typeof receipt.passed !== "boolean" || typeof receipt.full !== "boolean") throw new TypeError("lastVerification flags must be boolean"); lastVerification = { subject: text(receipt.subject, "lastVerification.subject"), artifactSha256: receipt.artifactSha256 === null ? null : sha(receipt.artifactSha256, "lastVerification.artifactSha256"), errorDigest: receipt.errorDigest === null ? null : text(receipt.errorDigest, "lastVerification.errorDigest"), passed: receipt.passed, full: receipt.full, evidenceCount: integer(receipt.evidenceCount, "lastVerification.evidenceCount") }; }
		const receiptSource = object(value.verificationReceipts, "verificationReceipts"); if (Object.keys(receiptSource).length > maxVerificationAttempts) throw new TypeError("verificationReceipts exceeds its item limit"); const verificationReceipts: RunSupervisorSnapshot["verificationReceipts"] = Object.create(null) as RunSupervisorSnapshot["verificationReceipts"];
		for (const key of Object.keys(receiptSource)) { const subject = text(key, "verificationReceipts key"); const receipt = object(receiptSource[key], `verificationReceipts.${subject}`); exact(receipt, ["artifactSha256", "errorDigest", "passed", "full", "evidenceCount"], `verificationReceipts.${subject}`); if (typeof receipt.passed !== "boolean" || typeof receipt.full !== "boolean") throw new TypeError("verification receipt flags must be boolean"); verificationReceipts[subject] = { artifactSha256: receipt.artifactSha256 === null ? null : sha(receipt.artifactSha256, "verification receipt artifactSha256"), errorDigest: receipt.errorDigest === null ? null : text(receipt.errorDigest, "verification receipt errorDigest"), passed: receipt.passed, full: receipt.full, evidenceCount: integer(receipt.evidenceCount, "verification receipt evidenceCount") }; }
		const withoutId: Omit<RunSupervisorSnapshot, "id"> = { schemaVersion: 1, scope: scopeValue(value.scope), state: value.state as RunSupervisorState, reasonCode: value.reasonCode === null ? null : text(value.reasonCode, "reasonCode", 128), toolCalls: integer(value.toolCalls, "toolCalls"), turns: integer(value.turns, "turns"), verificationAttempts: integer(value.verificationAttempts, "verificationAttempts"), evidenceCount: integer(value.evidenceCount, "evidenceCount"), unchangedAttempts: integer(value.unchangedAttempts, "unchangedAttempts"), userAccepted: false, evidenceDigests: list(value.evidenceDigests, "evidenceDigests"), artifactHashes: map(value.artifactHashes, "artifactHashes", "text") as Record<string, string>, failureSignatures: map(value.failureSignatures, "failureSignatures", "integer") as Record<string, number>, seenToolCallIds: list(value.seenToolCallIds, "seenToolCallIds"), seenVerificationCallIds: list(value.seenVerificationCallIds, "seenVerificationCallIds"), verificationFingerprints: map(value.verificationFingerprints, "verificationFingerprints", "text") as Record<string, string>, lastVerificationSubject: value.lastVerificationSubject === null ? null : text(value.lastVerificationSubject, "lastVerificationSubject"), lastVerification, verificationReceipts, lastFailureSignature: value.lastFailureSignature === null ? null : text(value.lastFailureSignature, "lastFailureSignature") };
		if (withoutId.state !== "RUNNING" && withoutId.reasonCode === null) throw new TypeError("terminal snapshot must have a reasonCode");
		if (value.schemaVersion === 2) {
			withoutId.schemaVersion = 2;
			const source = object(value.verificationProgress, "verificationProgress");
			if (Object.keys(source).length > withoutId.verificationAttempts) throw new TypeError("verificationProgress exceeds receipt count");
			const tracks: Record<string, VerificationProgressTrack> = {};
			for (const key of Object.keys(source)) {
				const item = object(source[key], "verification progress track"); exact(item, ["subject", "mode", "relatedSourcesDigest", "bestDiagnostics", "attempts"], "verification progress track");
				const track = { subject: text(item.subject, "progress subject"), mode: modeValue(item.mode), relatedSourcesDigest: item.relatedSourcesDigest === null ? null : sha(item.relatedSourcesDigest, "relatedSourcesDigest"), bestDiagnostics: diagnosticsValue(item.bestDiagnostics), attempts: integer(item.attempts, "progress attempts") };
				if (reservedKey(track.subject) || !Object.prototype.hasOwnProperty.call(verificationReceipts, track.subject) || track.attempts < 1 || track.attempts > noProgressLimit || track.attempts > withoutId.verificationAttempts || key !== trackKey(track.subject, track.mode, track.relatedSourcesDigest, track.bestDiagnostics)) throw new TypeError("verification progress track is inconsistent");
				tracks[key] = track;
			}
			withoutId.verificationProgress = tracks;
			if (Object.values(tracks).reduce((sum, track) => sum + track.attempts, 0) > withoutId.verificationAttempts) throw new TypeError("verification progress counters are inconsistent");
		}
		if (withoutId.evidenceCount !== withoutId.evidenceDigests.length || withoutId.toolCalls !== withoutId.seenToolCallIds.length || withoutId.verificationAttempts !== withoutId.seenVerificationCallIds.length) throw new TypeError("snapshot receipt counters are inconsistent");
		if (withoutId.toolCalls > maxToolCalls || withoutId.turns > maxTurns || withoutId.verificationAttempts > maxVerificationAttempts || withoutId.unchangedAttempts > noProgressLimit) throw new TypeError("snapshot counters exceed configured bounds");
		for (const hash of Object.values(withoutId.artifactHashes)) sha(hash, "artifact hash");
		const result = seal(withoutId); if (text(value.id, "id") !== result.id) throw new Error("Snapshot integrity check failed"); return frozen(result);
	};
	return {
		begin(scope) { const normalized = scopeValue(scope); if (current) return frozen(current); current = seal({ schemaVersion: 2, scope: normalized, state: "RUNNING", reasonCode: null, toolCalls: 0, turns: 0, verificationAttempts: 0, evidenceCount: 0, unchangedAttempts: 0, userAccepted: false, evidenceDigests: [], artifactHashes: {}, failureSignatures: {}, seenToolCallIds: [], seenVerificationCallIds: [], verificationFingerprints: {}, lastVerificationSubject: null, lastVerification: null, verificationReceipts: {}, lastFailureSignature: null, verificationProgress: {} }); return frozen(current); },
		snapshot(scope) { if (!current || (scope && !owned(scope))) return null; return frozen(current); },
		tool(scope, callId, name) { text(callId, "callId"); text(name, "name"); if (!owned(scope) || terminal()) return { allowed: false, snapshot: owned(scope) && current ? frozen(current) : null }; if (current!.seenToolCallIds.includes(callId)) return { allowed: true, snapshot: frozen(current!) }; if (current!.toolCalls >= maxToolCalls) return { allowed: false, snapshot: stopInternal("FAILED", "MAX_TOOL_CALLS") }; const snapshot = set({ toolCalls: current!.toolCalls + 1, seenToolCallIds: [...current!.seenToolCallIds, callId] }); return { allowed: snapshot.state === "RUNNING", snapshot }; },
		turn(scope) { if (!owned(scope) || terminal()) return owned(scope) && current ? frozen(current) : null; if (current!.turns >= maxTurns) return stopInternal("FAILED", "MAX_TURNS"); return set({ turns: current!.turns + 1 }); },
		// Preserve the separate legacy repair heuristic, but never give generic
		// activity credit toward per-subject mechanical verification progress.
		evidence(scope, identity) { if (!owned(scope) || terminal()) return owned(scope) && current ? frozen(current) : null; const id = text(options.digest(text(identity, "identity", 32768)), "digest result"); if (current!.evidenceDigests.includes(id)) return frozen(current!); if (current!.evidenceDigests.length >= 4096) return stopInternal("FAILED", "CAPACITY"); return set({ evidenceDigests: [...current!.evidenceDigests, id], evidenceCount: current!.evidenceCount + 1, failureSignatures: {}, lastFailureSignature: null }); },
		artifact(scope, path, hash) { if (!owned(scope) || terminal()) return owned(scope) && current ? frozen(current) : null; const normalizedPath = safePath(path); const normalizedHash = sha(hash, "sha256"); if (Object.prototype.hasOwnProperty.call(current!.artifactHashes, normalizedPath) && current!.artifactHashes[normalizedPath] === normalizedHash) return frozen(current!); if (!Object.prototype.hasOwnProperty.call(current!.artifactHashes, normalizedPath) && Object.keys(current!.artifactHashes).length >= 4096) return stopInternal("FAILED", "CAPACITY"); return set({ artifactHashes: { ...current!.artifactHashes, [normalizedPath]: normalizedHash }, failureSignatures: {}, lastFailureSignature: null }); },
		verification(scope, value) {
			if (!owned(scope) || terminal()) return owned(scope) && current ? frozen(current) : null;
			const callId = text(value.callId, "callId"); if (current!.seenVerificationCallIds.includes(callId)) return frozen(current!);
			if (current!.verificationAttempts >= maxVerificationAttempts) return stopInternal("FAILED", "MAX_VERIFICATION_ATTEMPTS");
			const artifactHash = value.artifactSha256 === null ? null : sha(value.artifactSha256, "artifactSha256");
			const error = value.errorDigest === null ? null : text(value.errorDigest, "errorDigest");
			if (typeof value.passed !== "boolean" || typeof value.full !== "boolean") throw new TypeError("verification flags must be boolean");
			const subject = text(value.subject, "subject"); if (reservedKey(subject)) throw new TypeError("subject is reserved");
			const mode = modeValue(value.mode ?? (value.full ? "full" : "scene:unspecified"));
			if ((mode === "full") !== value.full) throw new TypeError("verification mode does not match full flag");
			const related = value.relatedSourcesDigest === undefined ? null : sha(value.relatedSourcesDigest, "relatedSourcesDigest");
			if (value.passed && value.diagnostics !== undefined && Object.keys(object(value.diagnostics, "diagnostics")).length) throw new TypeError("Passing verification cannot contain failures");
			const diagnostics = value.passed ? {} : diagnosticsValue(value.diagnostics ?? { ["opaque_" + options.digest(error ?? "unspecified-failure")]: 1 });
			const tracks = { ...(current!.verificationProgress ?? {}) };
			let unchangedAttempts = 0;
			if (value.passed) {
				for (const [key, track] of Object.entries(tracks)) if (track.subject === subject && track.mode === mode) delete tracks[key];
			} else {
				const key = trackKey(subject, mode, related, diagnostics), prior = tracks[key];
				// The track's identity includes the diagnostic shape. A strictly
				// Pareto-improved deficit vector is a mechanical repair; merely
				// different bytes, a worse vector, or cycling old shapes is not.
				const improved = !!prior && Object.keys(diagnostics).every(key => diagnostics[key] <= prior.bestDiagnostics[key]) && Object.keys(diagnostics).some(key => diagnostics[key] < prior.bestDiagnostics[key]);
				unchangedAttempts = !prior || improved ? 1 : prior.attempts + 1;
				tracks[key] = { subject, mode, relatedSourcesDigest: related, bestDiagnostics: !prior || improved ? diagnostics : prior.bestDiagnostics, attempts: unchangedAttempts };
			}
			const fingerprint = text(options.digest(JSON.stringify([mode, related, diagnostics])), "digest result");
			const receipt = { artifactSha256: artifactHash, errorDigest: error, passed: value.passed, full: value.full, evidenceCount: current!.evidenceCount };
			const updated = set({ schemaVersion: 2, verificationProgress: tracks, verificationAttempts: current!.verificationAttempts + 1, seenVerificationCallIds: [...current!.seenVerificationCallIds, callId], verificationFingerprints: { ...current!.verificationFingerprints, [subject]: fingerprint }, unchangedAttempts, lastVerificationSubject: subject, lastVerification: { subject, ...receipt }, verificationReceipts: { ...current!.verificationReceipts, [subject]: receipt } });
			return !value.passed && unchangedAttempts >= noProgressLimit ? stopInternal("NO_PROGRESS", "UNCHANGED_VERIFICATION") : updated;
		},
		failure(scope, value) { if (!owned(scope) || terminal()) return owned(scope) && current ? frozen(current) : null; const code = text(value.code, "code", 128); if (value.kind === "permission") return stopInternal("BLOCKED_USER", code); if (value.kind === "precondition" || value.kind === "unknown_outcome") return stopInternal("BLOCKED_PREREQUISITE", code); if (value.kind === "cancelled") return stopInternal("CANCELLED", code); if (value.kind === "fatal" || value.kind === "transient") return stopInternal("FAILED", code); if (value.kind === "stale_source" || value.kind === "validation" || value.kind === "invalid_input") { const signature = text(value.signature ?? `${value.kind}:${code}`, "signature"); if (reservedKey(signature)) throw new TypeError("signature is reserved"); const consecutive = current!.lastFailureSignature === signature; const count = consecutive ? (current!.failureSignatures[signature] ?? 0) + 1 : 1; const result = set({ failureSignatures: { [signature]: count }, lastFailureSignature: signature }); return count >= noProgressLimit ? stopInternal("NO_PROGRESS", "REPEATED_REPAIR_FAILURE") : result; } return stopInternal("BLOCKED_PREREQUISITE", code); },
		stop(scope, state, reasonCode) { if (!owned(scope)) return null; const states = ["BLOCKED_USER", "BLOCKED_PREREQUISITE", "NO_PROGRESS", "CANCELLED", "FAILED", "COMPLETED_CANDIDATE"]; if (!states.includes(state)) throw new TypeError("stop state must be terminal"); return stopInternal(state, text(reasonCode, "reasonCode", 128)); },
		finish(scope, value) { if (!owned(scope) || terminal()) return owned(scope) && current ? frozen(current) : null; const reason = text(value.stopReason, "stopReason", 128); if (reason === "aborted") return stopInternal("CANCELLED", "ABORTED"); if (reason === "error") return stopInternal("FAILED", "AGENT_ERROR"); if (reason === "length") return stopInternal("BLOCKED_PREREQUISITE", "MODEL_TRUNCATED"); if (reason !== "stop") return stopInternal("FAILED", "INVALID_STOP_REASON"); if (!value.hasText) return stopInternal("FAILED", "NO_FINAL_RESPONSE"); if (!value.checkpointReady) return stopInternal("BLOCKED_PREREQUISITE", "CHECKPOINT_NOT_READY"); if (value.pendingOperations) return stopInternal("BLOCKED_PREREQUISITE", "PENDING_OPERATIONS"); if (!value.completionVerified) return stopInternal("BLOCKED_PREREQUISITE", "COMPLETION_NOT_VERIFIED"); const completion = value.completionReason ?? "STOP_VERIFIED"; if (!["STOP_VERIFIED", "REPLY_ONLY", "INSPECTION_COMPLETE", "UNBOUND_REPLY"].includes(completion)) return stopInternal("FAILED", "INVALID_COMPLETION_REASON"); return stopInternal("COMPLETED_CANDIDATE", completion); },
		parse,
		restore(raw, expectedScope) { const restored = parse(raw); if (expectedScope && scopeKey(scopeValue(expectedScope)) !== scopeKey(restored.scope)) throw new Error("Restored snapshot scope mismatch"); current = clone(restored); return frozen(current); },
	};
}
