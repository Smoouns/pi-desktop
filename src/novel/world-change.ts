import { exists, mkdir, readDir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { DEFAULT_NOVEL_LAYOUT, joinFsPath, resolveNovelPath, type NovelDocument, type NovelProject } from "./project.js";

export interface NovelWorldChangeRequest {
	version: 1;
	id: string;
	targetPath: string;
	targetFingerprint: string;
	requestPath: string;
	createdAt: string;
}

export interface NovelWorldChangeProposal {
	version: 1;
	id: string;
	proposalPath: string;
	targetPath: string;
	targetFingerprint: string;
	proposedText: string;
	affectedPaths: string[];
	createdAt: string | null;
}

export interface NovelWorldChangeHistoryEntry {
	version: 1;
	id: string;
	createdAt: string;
	targetPath: string;
	before: string;
	after: string;
	beforeFingerprint: string;
	afterFingerprint: string;
	proposalPath: string;
	affectedPaths: string[];
	/** Missing on legacy snapshots. New records are bound to their project. */
	projectRoot?: string;
	rolledBackAt?: string;
}

const worldChangesInFlight = new Set<string>();
const projectKey = (project: NovelProject): string => project.rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

async function exclusively<T>(project: NovelProject, operation: () => Promise<T>): Promise<T> {
	const key = projectKey(project);
	if (worldChangesInFlight.has(key)) throw new Error("该项目正在处理世界观变更，请完成后重试。");
	worldChangesInFlight.add(key);
	try { return await operation(); } finally { worldChangesInFlight.delete(key); }
}

function textFingerprint(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function headerValue(text: string, name: string): string | null {
	const header = text.split(/^##\s+/m, 1)[0] ?? text;
	const match = new RegExp(`^${name}:\\s*["']?(.+?)["']?\\s*$`, "im").exec(header);
	return match?.[1]?.trim() || null;
}

function normalizeRelativePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function proposalDirectory(project: NovelProject): string {
	return joinFsPath(project.rootPath, "planning/world-proposals");
}

function historyDirectory(project: NovelProject): string {
	return joinFsPath(project.rootPath, ".novel/world-change-history");
}

function isCanonTarget(project: NovelProject, relativePath: string): boolean {
	try { validatePath(project, relativePath); } catch { return false; }
	const layout = { ...DEFAULT_NOVEL_LAYOUT, ...(project.config.layout ?? {}) };
	const normalized = normalizeRelativePath(relativePath);
	return layout.canon.some((root) => normalized === root || normalized.startsWith(`${normalizeRelativePath(root).replace(/\/$/, "")}/`));
}

function validatePath(project: NovelProject, path: string): void {
	resolveNovelPath(project.rootPath, path);
	// Reject Windows aliases, streams, control characters and ambiguous dot segments.
	if (/[<>:"|?*\x00-\x1f]/.test(path) || path.replace(/\\/g, "/").split("/").some((part) => !part || part === "." || /[. ]$/.test(part))) {
		throw new Error("世界观变更包含无效的项目相对路径。");
	}
}

function createChangeId(stamp: string): string {
	return `world-change-${stamp.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseAffectedPaths(value: string | null): string[] {
	if (!value) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("World change proposal affected_paths must be a JSON array.");
	}
	if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== "string")) throw new Error("World change proposal affected_paths must be a JSON array of project-relative paths.");
	return [...new Set(parsed.map((path) => normalizeRelativePath(path)).filter(Boolean))];
}

function parseProposedText(text: string): string {
	const sectionStart = /^##\s+Proposed Canon Text\s*\r?\n/im.exec(text);
	const section = sectionStart ? text.slice(sectionStart.index + sectionStart[0].length).trimStart() : "";
	// Find the enclosing fence before interpreting headings: Canon itself can contain ## headings.
	const fence = /^(`{3,})(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)^\1[ \t]*\r?$/m.exec(section);
	const trailing = fence ? section.slice(fence[0].length).split(/^##[ \t]+/m, 1)[0] : "";
	if (!fence || fence.index !== 0 || !fence[2].trim() || trailing.trim()) {
		throw new Error("World change proposal must contain exactly one markdown fence under ## Proposed Canon Text.");
	}
	return fence[2].replace(/\r\n/g, "\n").trimEnd() + "\n";
}

/** Creates a user-owned handoff. The World Agent can only turn it into a proposal. */
export async function requestWorldChange(project: NovelProject, targetPath: string, feedback: string): Promise<NovelWorldChangeRequest> {
	const normalizedTarget = normalizeRelativePath(targetPath);
	if (!isCanonTarget(project, normalizedTarget)) throw new Error("Only Canon documents can receive a world change request.");
	const trimmedFeedback = feedback.trim();
	if (!trimmedFeedback) throw new Error("Please describe the requested worldbuilding change.");
	const target = resolveNovelPath(project.rootPath, normalizedTarget);
	if (!(await exists(target))) throw new Error("The selected Canon document no longer exists.");
	const createdAt = new Date().toISOString();
	const id = createChangeId(createdAt);
	const requestPath = `planning/world-proposals/${id}-request.md`;
	const content = `# World Change Request\n\nstatus: USER_CHANGE_REQUESTED\nchange_id: ${id}\ntarget_path: ${normalizedTarget}\ntarget_fingerprint: ${textFingerprint(await readTextFile(target))}\ncreated_at: ${createdAt}\n\n## User Feedback\n\n${trimmedFeedback}\n`;
	await mkdir(proposalDirectory(project), { recursive: true });
	if (await exists(resolveNovelPath(project.rootPath, requestPath))) throw new Error("同名世界观变更请求已存在。");
	await writeTextFile(resolveNovelPath(project.rootPath, requestPath), content);
	return { version: 1, id, targetPath: normalizedTarget, targetFingerprint: headerValue(content, "target_fingerprint")!, requestPath, createdAt };
}

/** Parses the strict, user-reviewable replacement contract produced by the World Agent. */
export function parseWorldChangeProposal(document: NovelDocument, project: NovelProject): NovelWorldChangeProposal | null {
	if (!document.relativePath.startsWith("planning/world-proposals/") || !document.relativePath.endsWith(".md")) return null;
	const text = document.text ?? "";
	if (headerValue(text, "status") !== "PROPOSED_PENDING_USER_ACCEPTANCE") return null;
	const id = headerValue(text, "change_id");
	const targetPath = headerValue(text, "target_path");
	const targetFingerprint = headerValue(text, "target_fingerprint");
	if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || !targetPath || !targetFingerprint) throw new Error(`World change proposal ${document.relativePath} is missing its change contract.`);
	const normalizedTarget = normalizeRelativePath(targetPath);
	if (!isCanonTarget(project, normalizedTarget)) throw new Error(`World change proposal ${document.relativePath} targets a non-Canon path.`);
	for (const affectedPath of parseAffectedPaths(headerValue(text, "affected_paths"))) validatePath(project, affectedPath);
	return {
		version: 1,
		id,
		proposalPath: document.relativePath,
		targetPath: normalizedTarget,
		targetFingerprint,
		proposedText: parseProposedText(text),
		affectedPaths: parseAffectedPaths(headerValue(text, "affected_paths")),
		createdAt: headerValue(text, "created_at"),
	};
}

export function listWorldChangeProposals(project: NovelProject, documents: NovelDocument[], histories: NovelWorldChangeHistoryEntry[] = []): NovelWorldChangeProposal[] {
	// Applied and rolled-back proposals remain evidence, never silently become pending again.
	const consumedPaths = new Set(histories.map((entry) => entry.proposalPath));
	const consumedIds = new Set(histories.map((entry) => entry.id));
	const proposals = documents
		.filter((document) => !consumedPaths.has(document.relativePath) && !consumedIds.has(headerValue(document.text ?? "", "change_id") ?? ""))
		.map((document) => parseWorldChangeProposal(document, project))
		.filter((proposal): proposal is NovelWorldChangeProposal => proposal !== null)
		.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || right.proposalPath.localeCompare(left.proposalPath));
	const ids = new Set<string>();
	for (const proposal of proposals) {
		if (ids.has(proposal.id)) throw new Error(`World change proposals reuse change_id ${proposal.id}. Resolve the duplicate before review.`);
		ids.add(proposal.id);
	}
	return proposals;
}

/** Applies one exact, reviewed Canon replacement only if the reviewed baseline is still current. */
export async function applyWorldChange(project: NovelProject, proposal: NovelWorldChangeProposal): Promise<NovelWorldChangeHistoryEntry> {
	return exclusively(project, () => applyWorldChangeUnlocked(project, proposal));
}

async function applyWorldChangeUnlocked(project: NovelProject, proposal: NovelWorldChangeProposal): Promise<NovelWorldChangeHistoryEntry> {
	if (!isCanonTarget(project, proposal.targetPath)) throw new Error("World change target is not a Canon document.");
	const target = resolveNovelPath(project.rootPath, proposal.targetPath);
	const proposalFile = resolveNovelPath(project.rootPath, proposal.proposalPath);
	if (!(await exists(target)) || !(await exists(proposalFile))) throw new Error("The Canon document or world change proposal no longer exists.");
	const currentProposal = parseWorldChangeProposal({ path: proposalFile, relativePath: proposal.proposalPath, name: proposal.proposalPath.split("/").pop() ?? proposal.proposalPath, category: "planning", classification: { contentType: "planning", authority: "reference", reason: "World change proposal." }, estimatedTokens: 0, text: await readTextFile(proposalFile) }, project);
	if (!currentProposal || JSON.stringify(currentProposal) !== JSON.stringify(proposal)) throw new Error("世界观提案在审阅后发生变化，请刷新并重新审阅。");
	const histories = await loadWorldChangeHistory(project);
	const before = await readTextFile(target);
	if (textFingerprint(before) !== proposal.targetFingerprint) throw new Error("The Canon document changed after this proposal was created. Create or review a new proposal instead of overwriting it.");
	if (before === proposal.proposedText) throw new Error("The proposal does not change the Canon document.");
	// Ensure ordering stays unambiguous even for two changes in the same millisecond.
	const createdAt = new Date(Math.max(Date.now(), ...histories.map((entry) => Date.parse(entry.createdAt) + 1))).toISOString();
	const history: NovelWorldChangeHistoryEntry = {
		version: 1,
		id: proposal.id,
		createdAt,
		targetPath: proposal.targetPath,
		before,
		after: proposal.proposedText,
		beforeFingerprint: textFingerprint(before),
		afterFingerprint: textFingerprint(proposal.proposedText),
		proposalPath: proposal.proposalPath,
		affectedPaths: proposal.affectedPaths,
		projectRoot: projectKey(project),
	};
	await mkdir(historyDirectory(project), { recursive: true });
	const historyPath = joinFsPath(historyDirectory(project), `${proposal.id}.json`);
	if (await exists(historyPath)) throw new Error("A history entry already exists for this world change. It cannot be applied again.");
	const auditPath = joinFsPath(project.rootPath, ".novel/world-change-log.md");
	const audit = await readOptional(auditPath);
	await commitWorldChange([
		{ path: historyPath, before: null, after: JSON.stringify(history, null, "\t") + "\n" },
		{ path: target, before, after: proposal.proposedText },
		{ path: auditPath, before: audit, after: `${(audit ?? "# World Change Log\n").trimEnd()}\n\n- ${createdAt}: applied ${proposal.id}\n  target: ${proposal.targetPath}\n  proposal: ${proposal.proposalPath}\n  impacts: ${proposal.affectedPaths.length ? proposal.affectedPaths.join(", ") : "none declared"}\n` },
	]);
	return history;
}

async function readOptional(path: string): Promise<string | null> {
	return await exists(path) ? readTextFile(path) : null;
}

interface WorldChangeWrite { path: string; before: string | null; after: string }

/** Compensates for caught I/O failures, including a write that failed after truncation. */
async function commitWorldChange(writes: WorldChangeWrite[]): Promise<void> {
	const started: WorldChangeWrite[] = [];
	try {
		for (const write of writes) {
			if (await readOptional(write.path) !== write.before) throw new Error(`文件已变化，已停止操作：${write.path}`);
			started.push(write);
			await writeTextFile(write.path, write.after);
		}
	} catch (error) {
		const failures: string[] = [];
		for (const write of started.reverse()) {
			// Keep newly-created snapshots if recovering Canon or the audit log failed.
			if (write.before === null && failures.length) continue;
			try {
				if (write.before === null) { if (await exists(write.path)) await remove(write.path); }
				else await writeTextFile(write.path, write.before);
			} catch { failures.push(write.path); }
		}
		throw new Error(`${error instanceof Error ? error.message : String(error)}${failures.length ? `；自动恢复失败，已保留可用快照，请勿继续操作：${failures.join("、")}` : "；本次已开始的文件写入已恢复。"}`);
	}
}

function historyPath(project: NovelProject, id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("世界观变更历史 ID 无效。");
	return joinFsPath(historyDirectory(project), `${id}.json`);
}

export function parseWorldChangeHistory(text: string, project: NovelProject): NovelWorldChangeHistoryEntry {
	const value = JSON.parse(text) as Partial<NovelWorldChangeHistoryEntry> | null;
	if (!value || value.version !== 1 || typeof value.id !== "string" || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.targetPath !== "string" || typeof value.proposalPath !== "string" || typeof value.before !== "string" || typeof value.after !== "string" || !Array.isArray(value.affectedPaths) || value.affectedPaths.some((path) => typeof path !== "string")) {
		throw new Error("世界观变更历史格式损坏，无法安全使用。");
	}
	historyPath(project, value.id);
	if (!isCanonTarget(project, value.targetPath)) throw new Error("历史目标不属于当前项目的 Canon。");
	validatePath(project, value.proposalPath);
	if (!value.proposalPath.startsWith("planning/world-proposals/") || !value.proposalPath.endsWith(".md")) throw new Error("历史中的提案路径无效。");
	for (const path of value.affectedPaths) validatePath(project, path);
	if (value.beforeFingerprint !== textFingerprint(value.before) || value.afterFingerprint !== textFingerprint(value.after)) throw new Error("历史快照内容与指纹不一致，已阻止回滚。");
	if (value.rolledBackAt !== undefined && (typeof value.rolledBackAt !== "string" || !Number.isFinite(Date.parse(value.rolledBackAt)))) throw new Error("历史回滚记录无效。");
	if (value.projectRoot !== undefined && value.projectRoot !== projectKey(project)) throw new Error("该历史快照属于另一个项目，不能在此执行回滚。");
	return value as NovelWorldChangeHistoryEntry;
}

export async function loadWorldChangeHistory(project: NovelProject): Promise<NovelWorldChangeHistoryEntry[]> {
	const directory = historyDirectory(project);
	if (!(await exists(directory))) return [];
	const entries: NovelWorldChangeHistoryEntry[] = [];
	for (const file of await readDir(directory)) {
		if (!file.isFile || !file.name.endsWith(".json")) continue;
		const entry = parseWorldChangeHistory(await readTextFile(joinFsPath(directory, file.name)), project);
		if (`${entry.id}.json` !== file.name) throw new Error(`历史文件名与 ID 不匹配：${file.name}`);
		entries.push(entry);
	}
	return entries.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id));
}

export function canRollbackWorldChange(entry: NovelWorldChangeHistoryEntry, histories: NovelWorldChangeHistoryEntry[], current: string | null): { allowed: boolean; reason: string } {
	if (entry.rolledBackAt) return { allowed: false, reason: "本次变更已经回滚，快照仍保留供查阅。" };
	const targetKey = entry.targetPath.replace(/\\/g, "/").toLowerCase();
	if (histories.some((other) => other.id !== entry.id && !other.rolledBackAt && other.targetPath.replace(/\\/g, "/").toLowerCase() === targetKey && Date.parse(other.createdAt) >= Date.parse(entry.createdAt))) return { allowed: false, reason: "同一文件还有更晚的变更，请先回滚最新的一条。" };
	if (current === null) return { allowed: false, reason: "当前 Canon 文件不存在或无法读取，不会自动重建。" };
	if (current !== entry.after || textFingerprint(current) !== entry.afterFingerprint) return { allowed: false, reason: "Canon 已被后续编辑，不能直接覆盖；请以当前内容创建新的变更请求。" };
	return { allowed: true, reason: "当前 Canon 与本次变更后的快照一致，可以撤销本次变更。" };
}

/** The caller must supply the exact history that the user reviewed, not just an id. */
export async function rollbackWorldChange(project: NovelProject, reviewed: NovelWorldChangeHistoryEntry): Promise<NovelWorldChangeHistoryEntry> {
	return exclusively(project, async () => {
		const path = historyPath(project, reviewed.id);
		const historyText = await readTextFile(path);
		const entry = parseWorldChangeHistory(historyText, project);
		if (JSON.stringify(entry) !== JSON.stringify(reviewed)) throw new Error("历史记录在预览后已变化，请刷新后重新确认。");
		const histories = await loadWorldChangeHistory(project);
		const target = resolveNovelPath(project.rootPath, entry.targetPath);
		const current = await readOptional(target);
		const guard = canRollbackWorldChange(entry, histories, current);
		if (!guard.allowed) throw new Error(guard.reason);
		const rolledBackAt = new Date().toISOString();
		const next = { ...entry, rolledBackAt };
		const auditPath = joinFsPath(project.rootPath, ".novel/world-change-log.md");
		const audit = await readOptional(auditPath);
		await commitWorldChange([
			{ path: target, before: current, after: entry.before },
			{ path: auditPath, before: audit, after: `${(audit ?? "# World Change Log\n").trimEnd()}\n\n- ${rolledBackAt}: rolled back ${entry.id}\n  target: ${entry.targetPath}\n  reason: explicit user confirmation\n  related files: unchanged\n` },
			{ path, before: historyText, after: JSON.stringify(next, null, "\t") + "\n" },
		]);
		return next;
	});
}
