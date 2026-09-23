import type { RunScope } from "./types.js";

export type TaskCompletionMode = "unbound" | "reply_only" | "inspection" | "candidate_write";
export interface ExpectedTaskArtifact { path: string; verification: "none" | "present" | "chapter-full"; chapter?: string }
/** Explicit user/UI declaration, never a tool argument or a grant of filesystem authority. */
export interface TaskBinding {
	version: 1; taskId: string; role: string; completionMode: Exclude<TaskCompletionMode, "unbound">;
	expectedArtifacts: ExpectedTaskArtifact[];
}
export interface TaskContract {
	schemaVersion: 1; id: string; taskId: string; revision: number;
	owner: Pick<RunScope, "projectId" | "sessionId" | "role">;
	objective: string; latestUserInstruction: string; completionMode: TaskCompletionMode;
	expectedArtifacts: ExpectedTaskArtifact[]; supersedesTaskId: string | null;
	constraintRefs: Array<{ id: string; text: string; relation: "initial" | "append" }>;
	progress: {
		artifacts: Record<string, string>;
		verifications: Record<string, { chapter: string; passed: boolean; full: boolean; sha256: string | null; sources: Array<{ path: string; sha256: string }> }>;
	};
}

/** Independent versioned, bounded session record. No model-derived completion claims. */
export function createTaskContracts(options: { digest: (text: string) => string; pathKey?: (value: string) => string }) {
	const fail = (message: string): never => { throw new Error("Task contract: " + message); };
	const object = (raw: any, keys: string[]) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !keys.includes(key))) fail("invalid object fields");
		return raw;
	};
	const text = (raw: any, max = 16384): string => typeof raw === "string" && raw.trim().length > 0 && raw.length <= max && !raw.includes("\0") ? raw : fail("invalid text");
	const integer = (raw: any): number => Number.isSafeInteger(raw) && raw > 0 && raw <= 10000 ? raw : fail("invalid revision");
	const list = <T>(raw: any, max: number, convert: (value: any) => T): T[] => Array.isArray(raw) && raw.length <= max ? raw.map(convert) : fail("capacity or invalid list");
	const sha = (raw: any): string => typeof raw === "string" && /^[a-f0-9]{64}$/.test(raw) ? raw : fail("invalid digest");
	const chapter = (raw: any): string => typeof raw === "string" && /^\d{1,6}$/.test(raw) ? raw : fail("invalid chapter");
	const path = (raw: any): string => {
		const value = text(raw, 4096);
		if (value !== value.trim() || /[\\\u0000-\u001f\u007f<>:"|?*]/.test(value) || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || ["__proto__", "constructor", "prototype"].includes(part))) fail("unsafe artifact path");
		return options.pathKey?.(value) ?? value;
	};
	const artifact = (raw: any): ExpectedTaskArtifact => {
		object(raw, ["path", "verification", "chapter"]);
		if (!["none", "present", "chapter-full"].includes(raw.verification)) fail("invalid verification requirement");
		if (raw.verification === "chapter-full" && (typeof raw.chapter !== "string" || !/^\d{1,6}$/.test(raw.chapter))) fail("chapter-full requires a chapter");
		if (raw.verification !== "chapter-full" && raw.chapter !== undefined) fail("unexpected chapter");
		return { path: path(raw.path), verification: raw.verification, ...(raw.chapter === undefined ? {} : { chapter: raw.chapter }) };
	};
	const mode = (value: any): TaskCompletionMode => ["unbound", "reply_only", "inspection", "candidate_write"].includes(value) ? value : fail("invalid completion mode");
	const expected = (raw: any, completionMode: TaskCompletionMode) => {
		const result = list(raw, 16, artifact);
		if ((completionMode === "candidate_write") !== (result.length > 0)) fail("candidate tasks require declared artifacts; reply tasks cannot declare them");
		if (new Set(result.map((item) => item.path)).size !== result.length) fail("duplicate artifact path");
		return result;
	};
	const owner = (raw: any) => ({ projectId: text(raw.projectId, 4096), sessionId: text(raw.sessionId, 4096), role: raw.role === null ? null : text(raw.role, 256) });
	const sameOwner = (left: TaskContract["owner"], right: TaskContract["owner"]) => JSON.stringify(owner(left)) === JSON.stringify(owner(right));
	const binding = (raw: any): TaskBinding => {
		object(raw, ["version", "taskId", "role", "completionMode", "expectedArtifacts"]);
		if (raw.version !== 1 || raw.completionMode === "unbound") fail("unsupported binding version or mode");
		const completionMode = mode(raw.completionMode) as TaskBinding["completionMode"];
		return { version: 1, taskId: text(raw.taskId, 256), role: text(raw.role, 256), completionMode, expectedArtifacts: expected(raw.expectedArtifacts, completionMode) };
	};
	const seal = (value: Omit<TaskContract, "id">): TaskContract => {
		const result = { ...value, id: "task_" + options.digest(JSON.stringify(value)) };
		if (new TextEncoder().encode(JSON.stringify(result)).length > 128 * 1024) fail("record capacity exceeded");
		return result;
	};
	const parse = (raw: any): TaskContract => {
		object(raw, ["schemaVersion", "id", "taskId", "revision", "owner", "objective", "latestUserInstruction", "completionMode", "expectedArtifacts", "supersedesTaskId", "constraintRefs", "progress"]);
		if (raw.schemaVersion !== 1) fail("unsupported record version");
		object(raw.owner, ["projectId", "sessionId", "role"]);
		const completionMode = mode(raw.completionMode);
		object(raw.progress, ["artifacts", "verifications"]);
		const map = <T>(value: any, convert: (item: any) => T): Record<string, T> => {
			if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 16) fail("invalid progress map");
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [path(key), convert(item)]));
		};
		const result = seal({ schemaVersion: 1, taskId: text(raw.taskId, 256), revision: integer(raw.revision), owner: owner(raw.owner), objective: text(raw.objective), latestUserInstruction: text(raw.latestUserInstruction, 32768), completionMode,
			expectedArtifacts: expected(raw.expectedArtifacts, completionMode), supersedesTaskId: raw.supersedesTaskId === null ? null : text(raw.supersedesTaskId, 256),
			constraintRefs: list(raw.constraintRefs, 256, (item) => { object(item, ["id", "text", "relation"]); if (item.relation !== "initial" && item.relation !== "append") fail("invalid constraint relation"); return { id: sha(item.id), text: text(item.text, 32768), relation: item.relation }; }),
			progress: { artifacts: map(raw.progress.artifacts, sha), verifications: map(raw.progress.verifications, (item) => {
				object(item, ["chapter", "passed", "full", "sha256", "sources"]);
				if (typeof item.passed !== "boolean" || typeof item.full !== "boolean") fail("invalid verification receipt");
				return { chapter: chapter(item.chapter), passed: item.passed, full: item.full, sha256: item.sha256 === null ? null : sha(item.sha256), sources: list(item.sources, 128, (source) => { object(source, ["path", "sha256"]); return { path: path(source.path), sha256: sha(source.sha256) }; }) };
			}) },
		});
		if (result.id !== raw.id) fail("record integrity mismatch");
		if (result.constraintRefs.length === 0 || result.constraintRefs[0].text !== result.objective || result.constraintRefs.at(-1)!.text !== result.latestUserInstruction) fail("instruction lineage mismatch");
		for (const key of [...Object.keys(result.progress.artifacts), ...Object.keys(result.progress.verifications)]) if (!result.expectedArtifacts.some((item) => item.path === key)) fail("unrelated progress");
		return result;
	};
	const update = (previous: TaskContract | null, scope: TaskContract["owner"], instruction: string, declaration?: TaskBinding): TaskContract => {
		const value = text(instruction, 32768), prior = previous ? parse(previous) : null, declared = declaration ? binding(declaration) : null;
		if (prior && !sameOwner(prior.owner, scope)) fail("owner mismatch");
		if (declared && declared.role !== scope.role) fail("role mismatch; a task cannot bind an agent role");
		const isNew = !prior || (declared && declared.taskId !== prior.taskId);
		if (!isNew && declared && (declared.completionMode !== prior!.completionMode || JSON.stringify(declared.expectedArtifacts) !== JSON.stringify(prior!.expectedArtifacts) || value !== prior!.objective)) fail("task identity collision; declare a new task for a revised goal");
		const constraint = { id: options.digest(JSON.stringify([prior?.id ?? null, value])), text: value, relation: isNew ? "initial" as const : "append" as const };
		if (isNew) return parse(seal({ schemaVersion: 1, taskId: declared?.taskId ?? "unbound_" + options.digest(JSON.stringify([owner(scope), value])), revision: 1, owner: owner(scope), objective: text(value), latestUserInstruction: value,
			completionMode: declared?.completionMode ?? "unbound", expectedArtifacts: declared?.expectedArtifacts ?? [], supersedesTaskId: prior?.taskId ?? null, constraintRefs: [constraint], progress: { artifacts: {}, verifications: {} } }));
		// IDs are not part of their own digest.
		const { id: _id, ...content } = prior!;
		return parse(seal({ ...content, revision: prior!.revision + 1, latestUserInstruction: value, constraintRefs: [...prior!.constraintRefs, constraint] }));
	};
	const change = (raw: TaskContract, mutate: (value: TaskContract) => void) => {
		const value = parse(raw); mutate(value);
		const { id: _id, ...content } = value;
		return parse(seal({ ...content, revision: value.revision + 1 }));
	};
	return {
		parse, binding, update,
		latest(entries: any[], scope: TaskContract["owner"]): TaskContract | null {
			if (entries.length > 10000) fail("branch capacity exceeded");
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				if (entry?.type !== "custom" || typeof entry.customType !== "string" || !entry.customType.startsWith("pi-desktop-task-contract/")) continue;
				if (!entry.data?.owner) fail("missing record owner");
				if (!sameOwner(entry.data.owner, scope)) continue;
				if (entry.customType !== "pi-desktop-task-contract/v1") fail("unsupported record version");
				return parse(entry.data); // Invalid latest record must never fall back to an older success.
			}
			return null;
		},
		artifact(raw: TaskContract, target: string, hash: string) {
			const key = path(target); if (!raw.expectedArtifacts.some((item) => item.path === key)) return raw;
			return change(raw, (value) => { value.progress.artifacts[key] = sha(hash); });
		},
		verification(raw: TaskContract, target: string, receipt: TaskContract["progress"]["verifications"][string]) {
			const key = path(target); if (!raw.expectedArtifacts.some((item) => item.path === key && item.verification === "chapter-full")) return raw;
			return change(raw, (value) => { value.progress.verifications[key] = receipt; if (receipt.passed && receipt.full && receipt.sha256) value.progress.artifacts[key] = receipt.sha256; });
		},
		async complete(raw: TaskContract, resolve: (target: string) => Promise<string | null>): Promise<boolean> {
			const value = parse(raw);
			if (value.completionMode === "unbound") return false;
			if (value.completionMode !== "candidate_write") return true;
			for (const item of value.expectedArtifacts) {
				if (item.verification === "present") { if (!await resolve(item.path)) return false; continue; }
				const hash = value.progress.artifacts[item.path];
				if (!hash || await resolve(item.path) !== hash) return false;
				if (item.verification === "chapter-full") {
					const receipt = value.progress.verifications[item.path];
					if (!receipt?.passed || !receipt.full || Number(receipt.chapter) !== Number(item.chapter) || receipt.sha256 !== hash || receipt.sources.length === 0) return false;
					for (const source of receipt.sources) if (await resolve(source.path) !== source.sha256) return false;
				}
			}
			return true;
		},
	};
}
