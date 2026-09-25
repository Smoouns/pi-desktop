/** Bounded host receipts for navigation after compaction, never current facts,
 * approval, completion evidence or instructions supplied by a model. */
export function createTaskProgress(options: { digest: (text: string) => string }) {
	type Owner = { projectId: string; sessionId: string; role: string | null; taskId: string };
	type Source = { path: string; sha256: string; startLine?: number; endLine?: number };
	type Receipt = {
		id: string; actionId: string; kind: "read" | "write" | "verification" | "failure"; tool: string;
		outcome: "returned" | "written" | "passed" | "failed" | "unknown" | "blocked";
		attemptHash: string; target: string | null; artifactSha256: string | null;
		sources: Source[]; omittedSources: number; report: { path: string; sha256: string } | null;
		observationId: string | null; full: boolean | null;
		error: { kind: string; code: string; fingerprint: string } | null; diagnosticCodes: string[];
	};
	type RecordValue = { schemaVersion: 1; id: string; owner: Owner; dropped: number; items: Receipt[] };
	const customType = "pi-desktop-task-progress/v1";
	const fail = (): never => { throw new Error("TASK_PROGRESS_INVALID"); };
	const exact = (v: any, keys: string[]) => {
		if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(key => !keys.includes(key))) fail();
	};
	const text = (v: any, max = 256): string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : fail();
	const int = (v: any): number => Number.isSafeInteger(v) && v >= 0 ? v : fail();
	const digest = (v: any): string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : fail();
	const hash = (v: unknown) => options.digest(JSON.stringify(v));
	const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
	const list = <T>(v: any, max: number, convert: (item: any) => T): T[] => Array.isArray(v) && v.length <= max ? v.map(convert) : fail();
	const path = (v: any): string => {
		const p = text(v, 1024);
		if (p !== p.trim() || /[\\<>:"|?*]/.test(p) || p.startsWith("/") || p.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail();
		return p;
	};
	const owner = (v: any): Owner => {
		exact(v, ["projectId", "sessionId", "role", "taskId"]);
		return { projectId: text(v.projectId, 4096), sessionId: text(v.sessionId, 4096), role: v.role === null ? null : text(v.role, 256), taskId: text(v.taskId, 256) };
	};
	const source = (v: any): Source => {
		exact(v, ["path", "sha256", "startLine", "endLine"]);
		const range = v.startLine !== undefined || v.endLine !== undefined;
		if (range && (int(v.startLine) < 1 || int(v.endLine) < v.startLine)) fail();
		return { path: path(v.path), sha256: digest(v.sha256), ...(range ? { startLine: v.startLine, endLine: v.endLine } : {}) };
	};
	const code = (v: any): string => typeof v === "string" && /^[A-Z0-9_:-]{1,80}$/.test(v) ? v : fail();
	const kinds = ["transient", "invalid_input", "stale_source", "permission", "precondition", "validation", "cancelled", "unknown_outcome", "fatal"];
	const receipt = (v: any): Receipt => {
		exact(v, ["id", "actionId", "kind", "tool", "outcome", "attemptHash", "target", "artifactSha256", "sources", "omittedSources", "report", "observationId", "full", "error", "diagnosticCodes"]);
		if (!["read", "write", "verification", "failure"].includes(v.kind) || !["returned", "written", "passed", "failed", "unknown", "blocked"].includes(v.outcome)) fail();
		if (!/^[a-z][a-z0-9_]{0,63}$/.test(v.tool)) fail();
		if (v.full !== null && typeof v.full !== "boolean") fail();
		const outcomes = { read: ["returned"], write: ["written", "failed", "unknown"], verification: ["passed", "failed"], failure: ["failed", "unknown", "blocked"] };
		if (!outcomes[v.kind as keyof typeof outcomes].includes(v.outcome)) fail();
		if (v.kind === "verification" ? (typeof v.full !== "boolean" || !v.report || !v.target || !v.artifactSha256) : (v.full !== null || v.report !== null)) fail();
		if (v.kind === "write" && v.outcome === "written" && (!v.target || !v.artifactSha256)) fail();
		if (v.kind === "failure" && !v.error) fail();
		let report = null, error = null;
		if (v.report !== null) { exact(v.report, ["path", "sha256"]); report = { path: path(v.report.path), sha256: digest(v.report.sha256) }; }
		if (v.error !== null) {
			exact(v.error, ["kind", "code", "fingerprint"]); if (!kinds.includes(v.error.kind)) fail();
			error = { kind: v.error.kind, code: code(v.error.code), fingerprint: digest(v.error.fingerprint) };
		}
		if (v.observationId !== null && (typeof v.observationId !== "string" || !/^obs_[a-zA-Z0-9_-]{1,128}$/.test(v.observationId))) fail();
		const content = { actionId: digest(v.actionId), kind: v.kind, tool: v.tool, outcome: v.outcome, attemptHash: digest(v.attemptHash),
			target: v.target === null ? null : path(v.target), artifactSha256: v.artifactSha256 === null ? null : digest(v.artifactSha256),
			sources: list(v.sources, 4, source), omittedSources: int(v.omittedSources), report, observationId: v.observationId, full: v.full, error, diagnosticCodes: list(v.diagnosticCodes, 8, code) };
		const result = { id: "step_" + hash(content), ...content };
		if (v.id !== undefined && v.id !== result.id) fail();
		return result;
	};
	const seal = (v: Omit<RecordValue, "id">): RecordValue => {
		const content = { schemaVersion: 1 as const, owner: v.owner, dropped: v.dropped, items: v.items };
		return { ...content, id: "progress_" + hash(content) };
	};
	const parse = (v: any): RecordValue => {
		exact(v, ["schemaVersion", "id", "owner", "dropped", "items"]); if (v.schemaVersion !== 1 || size(v) > 24_576) fail();
		const result = seal({ schemaVersion: 1, owner: owner(v.owner), dropped: int(v.dropped), items: list(v.items, 24, item => { if (typeof item?.id !== "string") fail(); return receipt(item); }) });
		if (result.id !== v.id || new Set(result.items.map(item => item.id)).size !== result.items.length) fail();
		return result;
	};
	const same = (a: Owner, b: Owner) => JSON.stringify(owner(a)) === JSON.stringify(owner(b));
	function latest(entries: any[], scope: Owner): RecordValue | null {
		owner(scope); if (!Array.isArray(entries) || entries.length > 10000) fail();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type !== "custom" || typeof entry.customType !== "string" || !entry.customType.startsWith("pi-desktop-task-progress/")) continue;
			if (!entry.data?.owner) fail();
			if (!same(entry.data.owner, scope)) continue;
			if (entry.customType !== customType) fail();
			return parse(entry.data); // Never fall back to an earlier success.
		}
		return null;
	}
	function append(previous: RecordValue | null, scope: Owner, input: Omit<Receipt, "id">): RecordValue {
		const prior = previous ? parse(previous) : null, item = receipt(input), normalized = owner(scope);
		if (prior && !same(prior.owner, normalized)) fail();
		if (prior?.items.some(old => old.id === item.id)) return prior;
		const items = [...(prior?.items ?? []), item]; let dropped = prior?.dropped ?? 0;
		let result = seal({ schemaVersion: 1, owner: normalized, items, dropped });
		while (items.length > 24 || size(result) > 24_576) {
			if (!items.length) fail(); items.shift(); dropped = int(dropped + 1);
			result = seal({ schemaVersion: 1, owner: normalized, items, dropped });
		}
		return parse(result);
	}
	const recovery = (item: Receipt, stale: boolean): string => {
		if (item.outcome === "unknown") return "核对目标文件与检查点；结果未知，不得自动重放。";
		if (stale || item.error?.kind === "stale_source") return "重新读取失效来源并显式刷新检查点；历史记录不能解锁。";
		if (item.error?.kind === "permission" || item.error?.code === "CONTRACT") return "停止当前尝试，请用户或对应职能补齐权限 / 前置合同。";
		if (item.outcome === "failed" || item.outcome === "blocked") return item.report ? "读取并核对验证报告当前版本，修复后显式重新验证。" : "核对错误码及原工具调用，修正参数或前置条件；不要盲目重复。";
		return "仅历史结果；使用前核对当前来源版本，仍需人工验收。";
	};
	function view(record: RecordValue | null, invalidPaths: string[] = [], unavailable = false) {
		const parsed = record ? parse(record) : null, stale = new Set(invalidPaths);
		const items = (unavailable ? [] : parsed?.items ?? []).slice(-12).map(item => {
			const needsReread = [item.target, item.report?.path, ...item.sources.map(ref => ref.path)].some(p => p && stale.has(p));
			return { ...item, historical: true, sourceStatus: needsReread ? "needs_revalidation" : "not_checked_here", nextCheck: recovery(item, needsReread) };
		});
		const base = { schemaVersion: 1, status: unavailable ? "unavailable" : parsed ? "available" : "empty", authority: false, userAccepted: false,
			coverage: "partial_host_receipts_only", checkpointGatesUnchanged: true, storedItems: unavailable ? 0 : parsed?.items.length ?? 0, droppedItems: unavailable ? null : parsed?.dropped ?? 0,
			observationAvailability: "revalidate_or_reread", omittedFromView: 0, items };
		base.omittedFromView = base.storedItems - items.length;
		while (items.length && size(base) > 12_288) { items.shift(); base.omittedFromView++; }
		return base;
	}
	return { customType, parse, latest, append, view, safeTarget(value: unknown) { try { return path(value); } catch { return null; } } };
}
