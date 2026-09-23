import type { RunScope } from "./types.js";

export interface ObservationSourceRef {
	path: string;
	sha256: string;
	startLine?: number;
	endLine?: number;
	authority?: string;
	temporal?: string;
	memoryId?: string;
}

export interface ObservationDescriptor {
	id: string;
	preview: string;
	payloadBytes: number;
	toolName: string;
	sourceRefs: ObservationSourceRef[];
}

export interface ObservationAccess {
	sequence: number;
	action: "put" | "read";
	observationId: string;
	scope: RunScope;
	toolName: string;
	toolCallId: string;
}

export interface ObservationRead extends ObservationDescriptor {
	payload: string;
	start: number;
	limit: number;
	totalChars: number;
	hasMore: boolean;
	freshness: "unverified";
}

export interface ObservationStoreStats {
	records: number;
	accesses: number;
	payloadBytes: number;
	maxRecords: number;
	maxAccesses: number;
	maxPayloadBytes: number;
	maxSourceRefs: number;
	maxFieldChars: number;
}
export interface ObservationStore {
	put(input: { scope: RunScope; toolName: string; toolCallId: string; text: string; sources: ObservationSourceRef[]; previewChars?: number }): ObservationDescriptor;
	read(input: { id: string; scope: RunScope; toolName?: string; toolCallId?: string; start?: number; limit?: number }): ObservationRead;
	peek(input: { id: string; scope: RunScope }): ObservationDescriptor;
	getAccesses(scope: RunScope): ObservationAccess[];
	stats(): ObservationStoreStats;
}

/** Bounded process-local evidence storage; safe to embed via this function's toString(). */
export function createObservationStore(options: {
	digest?: (text: string) => string;
	maxPayloadBytes?: number;
	maxRecords?: number;
	maxAccesses?: number;
	maxSourceRefs?: number;
	maxFieldChars?: number;
} = {}): ObservationStore {
	type Stored = ObservationDescriptor & { payload: string; identity: string; owner: string };
	const maxPayloadBytes = options.maxPayloadBytes ?? 8 * 1024 * 1024;
	const maxRecords = options.maxRecords ?? 512;
	const maxAccesses = options.maxAccesses ?? 4096;
	const maxSourceRefs = options.maxSourceRefs ?? 32;
	const maxFieldChars = options.maxFieldChars ?? 4096;
	const positive = (value: number, name: string): number => {
		if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
		return value;
	};
	positive(maxPayloadBytes, "maxPayloadBytes");
	positive(maxRecords, "maxRecords");
	positive(maxAccesses, "maxAccesses");
	positive(maxSourceRefs, "maxSourceRefs");
	positive(maxFieldChars, "maxFieldChars");
	const fallbackDigest = (value: string): string => {
		let first = 2166136261;
		let second = 2246822519;
		for (let index = 0; index < value.length; index += 1) {
			const unit = value.charCodeAt(index);
			first = Math.imul(first ^ unit, 16777619);
			second = Math.imul(second ^ unit, 3266489917);
		}
		return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
	};
	const digest = options.digest ?? fallbackDigest;
	if (typeof digest !== "function") throw new TypeError("digest must be a function");
	const encoder = new TextEncoder();
	const records = new Map<string, Stored>();
	const identityToId = new Map<string, string>();
	const accesses: ObservationAccess[] = [];
	let payloadBytes = 0;
	let accessSequence = 0;
	const clean = (value: string, name: string): string => {
		if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
		const result = value.trim();
		if (!result) throw new TypeError(`${name} must not be empty`);
		if (result.length > maxFieldChars) throw new TypeError(`${name} exceeds maxFieldChars`);
		return result;
	};
	const normalizeScope = (scope: RunScope): RunScope => {
		if (!scope || typeof scope !== "object") throw new TypeError("scope must be an object");
		if (!Number.isSafeInteger(scope.generation) || scope.generation < 0) {
			throw new TypeError("scope.generation must be a non-negative safe integer");
		}
		return {
			projectId: clean(scope.projectId, "scope.projectId"),
			sessionId: clean(scope.sessionId, "scope.sessionId"),
			runId: clean(scope.runId, "scope.runId"),
			generation: scope.generation,
			role: scope.role === null ? null : clean(scope.role, "scope.role"),
		};
	};
	const ownerOf = (scope: RunScope): string => JSON.stringify([scope.projectId, scope.sessionId, scope.role]);
	const normalizeSource = (source: ObservationSourceRef, index: number): ObservationSourceRef => {
		if (!source || typeof source !== "object") throw new TypeError(`sources[${index}] must be an object`);
		const path = clean(source.path, `sources[${index}].path`).replaceAll("\\", "/");
		const sha256 = clean(source.sha256, `sources[${index}].sha256`).toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError(`sources[${index}].sha256 must be a SHA-256 hex digest`);
		const line = (value: number | undefined, name: string): number | undefined => {
			if (value === undefined) return undefined;
			if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
			return value;
		};
		const startLine = line(source.startLine, `sources[${index}].startLine`);
		const endLine = line(source.endLine, `sources[${index}].endLine`);
		if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
			throw new TypeError(`sources[${index}] has an invalid line range`);
		}
		return {
			path,
			sha256,
			...(startLine === undefined ? {} : { startLine }),
			...(endLine === undefined ? {} : { endLine }),
			...(source.authority === undefined ? {} : { authority: clean(source.authority, `sources[${index}].authority`) }),
			...(source.temporal === undefined ? {} : { temporal: clean(source.temporal, `sources[${index}].temporal`) }),
			...(source.memoryId === undefined ? {} : { memoryId: clean(source.memoryId, `sources[${index}].memoryId`) }),
		};
	};
	const copySources = (sources: ObservationSourceRef[]): ObservationSourceRef[] => sources.map((source) => ({ ...source }));
	const descriptor = (record: Stored): ObservationDescriptor => ({
		id: record.id,
		preview: record.preview,
		payloadBytes: record.payloadBytes,
		toolName: record.toolName,
		sourceRefs: copySources(record.sourceRefs),
	});
	const stale = (): Error & { kind: string } => Object.assign(new Error("Observation is unavailable or belongs to another scope"), { kind: "stale_source" });
	const capacity = (message: string): Error & { kind: string } => Object.assign(new Error(message), { kind: "capacity" });
	const appendAccess = (action: "put" | "read", record: Stored, scope: RunScope, toolName: string, toolCallId: string): void => {
		if (accesses.length >= maxAccesses) throw capacity("Observation access capacity reached");
		accesses.push({ sequence: ++accessSequence, action, observationId: record.id, scope: { ...scope }, toolName, toolCallId });
	};
	return {
		put(input) {
			if (!input || typeof input !== "object") throw new TypeError("input must be an object");
			const scope = normalizeScope(input.scope);
			const toolName = clean(input.toolName, "toolName");
			const toolCallId = clean(input.toolCallId, "toolCallId");
			if (typeof input.text !== "string") throw new TypeError("text must be a string");
			if (!Array.isArray(input.sources)) throw new TypeError("sources must be an array");
			if (input.sources.length > maxSourceRefs) throw new TypeError("sources exceeds maxSourceRefs");
			const sources = input.sources.map(normalizeSource);
			const previewChars = input.previewChars ?? 240;
			if (!Number.isSafeInteger(previewChars) || previewChars < 0) throw new TypeError("previewChars must be a non-negative safe integer");
			const bytes = encoder.encode(input.text).byteLength;
			const payloadDigest = clean(digest(input.text), "digest result");
			const owner = ownerOf(scope);
			const identity = JSON.stringify([owner, sources, payloadDigest]);
			const existingId = identityToId.get(identity);
			if (existingId) {
				const existing = records.get(existingId);
				if (!existing || existing.identity !== identity || existing.payload !== input.text) {
					throw Object.assign(new Error("Observation identity collision"), { kind: "observation_id_collision" });
				}
				appendAccess("put", existing, scope, toolName, toolCallId);
				return descriptor(existing);
			}
			if (records.size >= maxRecords || bytes > maxPayloadBytes - payloadBytes) throw capacity("Observation payload capacity reached");
			if (accesses.length >= maxAccesses) throw capacity("Observation access capacity reached");
			const id = `obs_${clean(digest(identity), "digest result")}`;
			if (records.has(id)) throw Object.assign(new Error("Observation id collision"), { kind: "observation_id_collision" });
			const record: Stored = {
				id,
				preview: input.text.slice(0, previewChars),
				payloadBytes: bytes,
				toolName,
				sourceRefs: copySources(sources),
				payload: input.text,
				identity,
				owner,
			};
			records.set(id, record);
			identityToId.set(identity, id);
			payloadBytes += bytes;
			appendAccess("put", record, scope, toolName, toolCallId);
			return descriptor(record);
		},
		read(input) {
			if (!input || typeof input !== "object") throw new TypeError("input must be an object");
			const scope = normalizeScope(input.scope);
			const id = clean(input.id, "id");
			const record = records.get(id);
			if (!record || record.owner !== ownerOf(scope)) throw stale();
			const start = input.start ?? 0;
			const limit = input.limit ?? record.payload.length;
			if (!Number.isSafeInteger(start) || start < 0) throw new TypeError("start must be a non-negative safe integer");
			if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("limit must be a non-negative safe integer");
			if (start > record.payload.length) {
				throw Object.assign(new Error("Observation read start exceeds payload bounds"), { kind: "invalid_input" });
			}
			const toolName = input.toolName === undefined ? "observation_read" : clean(input.toolName, "toolName");
			const toolCallId = input.toolCallId === undefined ? `read:${accessSequence + 1}` : clean(input.toolCallId, "toolCallId");
			appendAccess("read", record, scope, toolName, toolCallId);
			const payload = record.payload.slice(start, start + limit);
			return {
				...descriptor(record), payload, start, limit,
				totalChars: record.payload.length,
				hasMore: start + payload.length < record.payload.length,
				freshness: "unverified",
			};
		},
		peek(input) {
			if (!input || typeof input !== "object") throw new TypeError("input must be an object");
			const scope = normalizeScope(input.scope);
			const record = records.get(clean(input.id, "id"));
			if (!record || record.owner !== ownerOf(scope)) throw stale();
			return descriptor(record);
		},
		getAccesses(rawScope) {
			const scope = normalizeScope(rawScope);
			const owner = ownerOf(scope);
			return accesses
				.filter((access) => ownerOf(access.scope) === owner)
				.map((access) => ({ ...access, scope: { ...access.scope } }));
		},
		stats() {
			return { records: records.size, accesses: accesses.length, payloadBytes, maxRecords, maxAccesses, maxPayloadBytes, maxSourceRefs, maxFieldChars };
		},
	};
}
