import type { RunScope } from "./types.js";
import type { SourceVersionRef } from "./source-version.js";

export type CheckpointCause = "manual" | "before_compact" | "after_compact" | "write_intent" | "write_result" | "refresh";
export type { SourceVersionRef } from "./source-version.js";
export interface PendingCheckpointOperation {
	operationId: string; toolName: string; target: string; preHash: string | null; expectedPostHash: string | null;
	argsDigest: string; state: string; dispatched: boolean;
}
export interface CheckpointInput {
	scope: RunScope;
	/** Absent in legacy checkpoints; those references are not delivery receipts. */
	evidenceFormat?: "delivered-v1";
	objective: string;
	hardConstraints: string[];
	evidence: SourceVersionRef[];
	observationIds: string[];
	artifacts: SourceVersionRef[];
	unresolvedIssues: Array<{ code: string; message: string }>;
	allowedNextActions: string[];
	pendingOperations: PendingCheckpointOperation[];
	budget: { readUsed: number; outputUsed: number; requestEstimate: number | null };
	cause: CheckpointCause;
	parentId?: string;
}
export interface TaskCheckpoint extends CheckpointInput { schemaVersion: 1; id: string }
export interface CheckpointEntry { type?: unknown; customType?: unknown; data?: unknown }
export interface CheckpointStore {
	build(input: CheckpointInput): TaskCheckpoint;
	parse(value: unknown): TaskCheckpoint;
	latest(entries: readonly CheckpointEntry[], scope: RunScope): TaskCheckpoint | null;
}

/** Durable checkpoint validation with no storage or runtime dependency; safe to embed via this function's toString(). */
export function createCheckpointStore(options: { digest: (text: string) => string; maxBytes?: number; maxEntries?: number }): CheckpointStore {
	if (!options || typeof options !== "object" || typeof options.digest !== "function") throw new TypeError("digest is required and must be a function");
	const maxBytes = options.maxBytes ?? 128 * 1024;
	const maxEntries = options.maxEntries ?? 10_000;
	const positive = (value: number, name: string): number => {
		if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
		return value;
	};
	positive(maxBytes, "maxBytes"); positive(maxEntries, "maxEntries");
	const encoder = new TextEncoder();
	const object = (value: unknown, name: string): Record<string, unknown> => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
		return value as Record<string, unknown>;
	};
	const exact = (value: Record<string, unknown>, allowed: readonly string[], name: string): void => {
		for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${name} has unexpected property ${key}`);
	};
	const text = (value: unknown, name: string, max = 32_768, empty = false): string => {
		if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
		if (!empty && value.length === 0) throw new TypeError(`${name} must not be empty`);
		if (value.length > max) throw new TypeError(`${name} exceeds its character limit`);
		return value;
	};
	const integer = (value: unknown, name: string): number => {
		if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
		return value as number;
	};
	const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
	const clean = (value: unknown, name: string, max: number): string => {
		if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
		const result = value.trim();
		if (!result) throw new TypeError(`${name} must not be empty`);
		if (result.length > max) throw new TypeError(`${name} exceeds its character limit`);
		if (/[\u0000-\u001f\u007f]/.test(result)) throw new TypeError(`${name} contains control characters`);
		return result;
	};
	const safePath = (value: unknown, name: string): string => {
		const path = clean(value, name, 4096);
		if (path !== value) throw new TypeError(`${name} must not have surrounding whitespace`);
		if (path.includes("\\") || path.startsWith("/") || path.startsWith("//") || /^[a-z]:/i.test(path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new TypeError(`${name} must be a project-relative canonical path`);
		const parts = path.split("/");
		if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":") || /[<>"|?*]/.test(part) || /[. ]$/.test(part) || reserved.test(part))) throw new TypeError(`${name} is not a safe project-relative path`);
		return path;
	};
	const sha = (value: unknown, name: string): string => {
		const result = clean(value, name, 64).toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(result)) throw new TypeError(`${name} must be a SHA-256 hex digest`);
		return result;
	};
	const list = <T>(value: unknown, name: string, max: number, convert: (item: unknown, index: number) => T): T[] => {
		if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
		if (value.length > max) throw new TypeError(`${name} exceeds its item limit`);
		return value.map(convert);
	};
	const normalizeScope = (value: unknown): RunScope => {
		const raw = object(value, "scope"); exact(raw, ["projectId", "sessionId", "runId", "generation", "role"], "scope");
		return {
			projectId: text(raw.projectId, "scope.projectId", 4096), sessionId: text(raw.sessionId, "scope.sessionId", 4096),
			runId: text(raw.runId, "scope.runId", 4096), generation: integer(raw.generation, "scope.generation"),
			role: raw.role === null ? null : text(raw.role, "scope.role", 4096),
		};
	};
	const normalizeRef = (value: unknown, index: number, name: string): SourceVersionRef => {
		const raw = object(value, `${name}[${index}]`); exact(raw, ["path", "sha256", "startLine", "endLine", "authority", "temporal", "memoryId"], `${name}[${index}]`);
		const sha256 = sha(raw.sha256, `${name}[${index}].sha256`);
		const hasStart = raw.startLine !== undefined; const hasEnd = raw.endLine !== undefined;
		if (hasStart !== hasEnd) throw new TypeError(`${name}[${index}] must supply startLine and endLine together`);
		const startLine = hasStart ? integer(raw.startLine, `${name}[${index}].startLine`) : undefined;
		const endLine = hasEnd ? integer(raw.endLine, `${name}[${index}].endLine`) : undefined;
		if (startLine !== undefined && (startLine < 1 || endLine! < startLine)) throw new TypeError(`${name}[${index}] has an invalid line range`);
		return {
			path: safePath(raw.path, `${name}[${index}].path`), sha256,
			...(startLine === undefined ? {} : { startLine, endLine: endLine! }),
			...(raw.authority === undefined ? {} : { authority: clean(raw.authority, `${name}[${index}].authority`, 256) }),
			...(raw.temporal === undefined ? {} : { temporal: clean(raw.temporal, `${name}[${index}].temporal`, 256) }),
			...(raw.memoryId === undefined ? {} : { memoryId: clean(raw.memoryId, `${name}[${index}].memoryId`, 256) }),
		};
	};
	const normalizeInput = (value: unknown, parsing: boolean): CheckpointInput => {
		const raw = object(value, "checkpoint");
		const base = ["scope", "objective", "hardConstraints", "evidence", "observationIds", "artifacts", "unresolvedIssues", "allowedNextActions", "pendingOperations", "budget", "cause", "parentId", "evidenceFormat"];
		exact(raw, parsing ? ["schemaVersion", "id", ...base] : base, "checkpoint");
		if (raw.evidenceFormat !== undefined && raw.evidenceFormat !== "delivered-v1") throw new TypeError("checkpoint.evidenceFormat is invalid");
		const cause = raw.cause;
		if (cause !== "manual" && cause !== "before_compact" && cause !== "after_compact" && cause !== "write_intent" && cause !== "write_result" && cause !== "refresh") throw new TypeError("checkpoint.cause is invalid");
		const budget = object(raw.budget, "budget"); exact(budget, ["readUsed", "outputUsed", "requestEstimate"], "budget");
		return {
			scope: normalizeScope(raw.scope), objective: text(raw.objective, "objective", 16_384, true),
			hardConstraints: list(raw.hardConstraints, "hardConstraints", 256, (item, index) => text(item, `hardConstraints[${index}]`, 32_768)),
			evidence: list(raw.evidence, "evidence", 128, (item, index) => normalizeRef(item, index, "evidence")),
			observationIds: list(raw.observationIds, "observationIds", 128, (item, index) => text(item, `observationIds[${index}]`, 4096)),
			artifacts: list(raw.artifacts, "artifacts", 128, (item, index) => normalizeRef(item, index, "artifacts")),
			unresolvedIssues: list(raw.unresolvedIssues, "unresolvedIssues", 128, (item, index) => { const issue = object(item, `unresolvedIssues[${index}]`); exact(issue, ["code", "message"], `unresolvedIssues[${index}]`); return { code: text(issue.code, `unresolvedIssues[${index}].code`, 4096), message: text(issue.message, `unresolvedIssues[${index}].message`) }; }),
			allowedNextActions: list(raw.allowedNextActions, "allowedNextActions", 128, (item, index) => text(item, `allowedNextActions[${index}]`)),
			pendingOperations: list(raw.pendingOperations, "pendingOperations", 64, (item, index) => { const operation = object(item, `pendingOperations[${index}]`); exact(operation, ["operationId", "toolName", "target", "preHash", "expectedPostHash", "argsDigest", "state", "dispatched"], `pendingOperations[${index}]`); if (typeof operation.dispatched !== "boolean") throw new TypeError(`pendingOperations[${index}].dispatched must be a boolean`); const nullable = (field: "preHash" | "expectedPostHash") => operation[field] === null ? null : sha(operation[field], `pendingOperations[${index}].${field}`); const state = operation.state; if (state !== "issued" && state !== "completed" && state !== "unknown" && state !== "cancelled" && state !== "failed") throw new TypeError(`pendingOperations[${index}].state is invalid`); return { operationId: text(operation.operationId, `pendingOperations[${index}].operationId`, 4096), toolName: text(operation.toolName, `pendingOperations[${index}].toolName`, 4096), target: safePath(operation.target, `pendingOperations[${index}].target`), preHash: nullable("preHash"), expectedPostHash: nullable("expectedPostHash"), argsDigest: sha(operation.argsDigest, `pendingOperations[${index}].argsDigest`), state, dispatched: operation.dispatched }; }),
			budget: { readUsed: integer(budget.readUsed, "budget.readUsed"), outputUsed: integer(budget.outputUsed, "budget.outputUsed"), requestEstimate: budget.requestEstimate === null ? null : integer(budget.requestEstimate, "budget.requestEstimate") },
			cause, ...(raw.parentId === undefined ? {} : { parentId: text(raw.parentId, "parentId", 4096) }),
			...(raw.evidenceFormat === undefined ? {} : { evidenceFormat: "delivered-v1" as const }),
		};
	};
	const serialize = (input: CheckpointInput): string => JSON.stringify({ schemaVersion: 1, ...input });
	const identifier = (content: string): string => `cp_${text(options.digest(content), "digest result", 4096)}`;
	const finish = (input: CheckpointInput): TaskCheckpoint => {
		const content = serialize(input);
		const checkpoint: TaskCheckpoint = { schemaVersion: 1, id: identifier(content), ...input };
		if (encoder.encode(JSON.stringify(checkpoint)).byteLength > maxBytes) throw Object.assign(new Error("Checkpoint exceeds maxBytes"), { kind: "capacity" });
		return checkpoint;
	};
	const parse = (value: unknown): TaskCheckpoint => {
		const raw = object(value, "checkpoint");
		if (raw.schemaVersion !== 1) throw new TypeError("checkpoint.schemaVersion must be 1");
		const id = text(raw.id, "checkpoint.id", 4096);
		const checkpoint = finish(normalizeInput(raw, true));
		if (id !== checkpoint.id) throw Object.assign(new Error("Checkpoint integrity check failed"), { kind: "checkpoint_integrity" });
		return checkpoint;
	};
	return {
		build(value) { return finish(normalizeInput(value, false)); },
		parse,
		latest(entries, requestedScope) {
			if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
			if (entries.length > maxEntries) throw Object.assign(new Error("entries exceeds maxEntries"), { kind: "capacity" });
			const scope = normalizeScope(requestedScope);
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (!entry || typeof entry !== "object" || entry.type !== "custom" || entry.customType !== "pi-desktop-task-checkpoint") continue;
				const data = entry.data;
				if (!data || typeof data !== "object" || Array.isArray(data)) throw new TypeError("checkpoint entry data must be an object");
				const candidate = (data as Record<string, unknown>).scope;
				if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError("checkpoint entry scope must be an object");
				const owner = normalizeScope(candidate);
				if (owner.projectId !== scope.projectId || owner.sessionId !== scope.sessionId || owner.role !== scope.role) continue;
				return parse(data);
			}
			return null;
		},
	};
}
