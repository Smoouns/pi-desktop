import { exists, mkdir, readDir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { joinFsPath, resolveNovelPath, type NovelDocument, type NovelProject } from "./project.js";

export type NovelWorkflowState = "awaiting-card-review" | "card-revision-requested" | "planned" | "awaiting-user-review" | "manuscript-revision-requested" | "accepted" | "promoted" | "blocked";
export type NovelVerificationStatus = "pass" | "pass-with-warnings" | "failed" | "missing";

export interface NovelVerificationRecord {
	status: NovelVerificationStatus;
	declaredChapter: string | null;
	sourceTextPath: string | null;
	reason: string;
}

export interface NovelChapterRecord {
	chapter: string;
	architecturePath: string | null;
	architectureRegistered: boolean;
	cardPath: string;
	candidatePath: string | null;
	proposalPath: string | null;
	reviewPath: string | null;
	verificationPath: string | null;
	canonicalPath: string | null;
	state: NovelWorkflowState;
	verification: NovelVerificationStatus;
	verificationReason: string;
	reasons: string[];
	cardAccepted: boolean;
	manuscriptAcceptance: NovelAcceptanceRecord | null;
	cardRevisionRequestPath: string | null;
	manuscriptRevisionRequestPath: string | null;
	rollbackHistory: NovelPromotionHistoryEntry | null;
}

export type NovelAcceptanceKind = "chapter-card" | "manuscript";

export interface NovelAcceptanceRecord {
	version: 1;
	kind: NovelAcceptanceKind;
	chapter: string;
	sourcePath: string;
	sourceFingerprint: string;
	cardPath: string;
	cardFingerprint: string;
	acceptedAt: string;
}

export type NovelRevisionScope = "chapter-card" | "manuscript";

export interface NovelPromotionHistoryRecord {
	id: string;
	label: string;
	targetPath: string;
	operation: "append" | "replace-once";
	before: string;
	after: string;
	beforeFingerprint: string;
	afterFingerprint: string;
}

export interface NovelPromotionHistoryEntry {
	version: 1;
	id: string;
	createdAt: string;
	chapter: string;
	candidatePath: string;
	canonicalPath: string;
	canonicalFingerprint: string;
	recordUpdates: NovelPromotionHistoryRecord[];
	rolledBackAt?: string;
}

export type NovelRecordUpdateTarget = "current-state" | "continuity-ledger" | "progress";

export interface NovelRecordUpdatePreview {
	id: string;
	target: NovelRecordUpdateTarget;
	targetPath: string;
	label: string;
	operation: "append" | "replace-once";
	append?: string;
	anchor?: string;
	replacement?: string;
	before: string;
	after: string;
	sourceFingerprint: string;
}

interface SerializedRecordUpdate {
	id?: unknown;
	target?: unknown;
	operation?: unknown;
	append?: unknown;
	anchor?: unknown;
	replacement?: unknown;
}

function matchChapter(path: string, chapter: string): boolean {
	return new RegExp(`(?:^|/)(?:chapter[-_ ]?)?${chapter}(?:[-_][^/]+)?\\.md$`, "i").test(path.replace(/\\/g, "/"));
}

function statusOf(text: string): string {
	return /^(?:status|approval_status|next_state):\s*["']?(.+?)["']?\s*$/im.exec(text)?.[1]?.trim().toUpperCase() ?? "";
}

function headerValue(text: string, names: string[]): string | null {
	const header = text.split(/^##\s+/m, 1)[0] ?? text;
	for (const name of names) {
		const match = new RegExp(`^${name}:\\s*["']?(.+?)["']?\\s*$`, "im").exec(header);
		if (match?.[1]) return match[1].trim();
	}
	return null;
}

function normalizeRelativePath(value: string | null): string | null {
	if (!value) return null;
	const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^`|`$/g, "").trim();
	return normalized || null;
}

function chapterCardContractReason(text: string): string | null {
	const yamlFence = String.raw`\`\`\`ya?ml\s*\r?\n([\s\S]*?)\`\`\``;
	const documents = [...text.matchAll(new RegExp(yamlFence, "gi"))];
	if (documents.length !== 1 || !documents[0]?.[1]?.trim()) return "expected exactly one fenced YAML document.";
	return null;
}

export function readChapterVerification(
	text: string,
	chapter: string,
	candidatePath: string | null,
): NovelVerificationRecord {
	if (!text) return { status: "missing", declaredChapter: null, sourceTextPath: null, reason: "No verification report was found." };
	const rawStatus = headerValue(text, ["verification_status", "verification", "status", "result"]);
	const normalizedStatus = rawStatus?.replace(/[\s_]+/g, "-").toUpperCase() ?? "";
	const declaredChapter = headerValue(text, ["chapter", "chapter_id"]);
	const sourceTextPath = normalizeRelativePath(headerValue(text, ["source_text", "candidate_path", "manuscript_path"]));
	if (chapter && declaredChapter && declaredChapter.replace(/^0+/, "") !== chapter.replace(/^0+/, "")) {
		return { status: "failed", declaredChapter, sourceTextPath, reason: `Verification report declares Chapter ${declaredChapter}, not Chapter ${chapter}.` };
	}
	if (sourceTextPath && candidatePath && sourceTextPath !== normalizeRelativePath(candidatePath)) {
		return { status: "failed", declaredChapter, sourceTextPath, reason: "Verification report points to a different candidate manuscript." };
	}
	if (normalizedStatus === "PASS") {
		return { status: "pass", declaredChapter, sourceTextPath, reason: sourceTextPath ? "Structured PASS report matches the candidate manuscript." : "PASS report has no source_text binding; it is accepted as a legacy report." };
	}
	if (normalizedStatus === "PASS-WITH-WARNINGS") {
		return { status: "pass-with-warnings", declaredChapter, sourceTextPath, reason: sourceTextPath ? "Structured PASS_WITH_WARNINGS report matches the candidate manuscript." : "PASS_WITH_WARNINGS report has no source_text binding; review warnings before promotion." };
	}
	if (!rawStatus) return { status: "missing", declaredChapter, sourceTextPath, reason: "Verification report has no explicit status field." };
	const failure = /^\s*-\s*(\[[A-Z_]+\]\s*.+)$/m.exec(text)?.[1];
	return { status: "failed", declaredChapter, sourceTextPath, reason: failure ? `Verification report status is ${rawStatus}: ${failure}` : `Verification report status is ${rawStatus}.` };
}

export function chapterWorkflowState(input: { card?: string; candidate?: string; canonical?: boolean; cardAccepted?: boolean; cardRevisionRequested?: boolean; manuscriptAccepted?: boolean; manuscriptRevisionRequested?: boolean; architectureReady?: boolean }): NovelChapterRecord["state"] {
	if (input.canonical) return "promoted";
	if (input.architectureReady === false) return "blocked";
	if (!input.card) return "blocked";
	if (input.cardRevisionRequested) return "card-revision-requested";
	if (!input.cardAccepted) return "awaiting-card-review";
	if (!input.candidate) return "planned";
	if (input.manuscriptRevisionRequested) return "manuscript-revision-requested";
	if (input.manuscriptAccepted) return "accepted";
	return "awaiting-user-review";
}

function chapterNumber(value: string): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Resolves the chapter that should be shown as the current workflow entry. */
export function resolveNextWorkflowChapter(records: Array<Pick<NovelChapterRecord, "chapter" | "state">>): string {
	const sorted = [...records].sort((left, right) => chapterNumber(left.chapter) - chapterNumber(right.chapter));
	const highestPromoted = sorted
		.filter((record) => record.state === "promoted")
		.reduce((highest, record) => Math.max(highest, chapterNumber(record.chapter)), 0);
	const firstPending = sorted.find((record) => record.state !== "promoted");
	const expectedNumber = highestPromoted > 0 ? highestPromoted + 1 : chapterNumber(firstPending?.chapter ?? "1") || 1;
	if (firstPending && chapterNumber(firstPending.chapter) < expectedNumber) return firstPending.chapter;
	const expectedRecord = sorted.find((record) => chapterNumber(record.chapter) === expectedNumber && record.state !== "promoted");
	if (expectedRecord) return expectedRecord.chapter;
	const width = Math.max(3, ...sorted.map((record) => record.chapter.length));
	return String(Math.max(1, expectedNumber)).padStart(width, "0");
}

export function canPromoteChapter(record: NovelChapterRecord): { allowed: boolean; reason: string } {
	if (record.architectureRegistered === false) return { allowed: false, reason: "Chapter architecture registration is required before promotion." };
	if (record.state !== "accepted") return { allowed: false, reason: "Only an explicitly accepted chapter may be promoted." };
	if (!record.candidatePath) return { allowed: false, reason: "Candidate manuscript is missing." };
	if (!record.manuscriptAcceptance) return { allowed: false, reason: "A current user acceptance record is required." };
	return { allowed: true, reason: "Current user acceptance is present." };
}

function resolveRecordTarget(project: NovelProject, target: NovelRecordUpdateTarget): { path: string; label: string } | null {
	const configured = target === "current-state"
		? project.config.authority?.currentState
		: target === "continuity-ledger"
			? project.config.authority?.continuityLedger
			: "planning/progress.md";
	if (!configured) return null;
	return {
		path: configured.replace(/\\/g, "/"),
		label: target === "current-state" ? "当前故事状态" : target === "continuity-ledger" ? "连续性账本" : "进度记录",
	};
}

/**
 * Reads only a strict, opt-in JSON block from the proposal. The application never
 * infers Canon edits from prose in a continuity proposal.
 *
 * <!-- novel-record-updates
 * [{"target":"current-state","operation":"replace-once","anchor":"- Old fact.","replacement":"- Accepted fact."}]
 * -->
 */
export function parseProposalRecordUpdates(text: string, project: NovelProject): NovelRecordUpdatePreview[] {
	const match = /<!--\s*novel-record-updates\s*\n([\s\S]*?)\n\s*-->/i.exec(text);
	if (!match?.[1]) return [];
	let serialized: unknown;
	try {
		serialized = JSON.parse(match[1]);
	} catch {
		throw new Error("The proposal's novel-record-updates block is not valid JSON.");
	}
	if (!Array.isArray(serialized)) throw new Error("The proposal's novel-record-updates block must be a JSON array.");
	const seenTargets = new Set<string>();
	return serialized.map((item, index) => {
		if (!item || typeof item !== "object") throw new Error(`Record update ${index + 1} is not an object.`);
		const update = item as SerializedRecordUpdate;
		const target = update.target;
		if (target !== "current-state" && target !== "continuity-ledger" && target !== "progress") {
			throw new Error(`Record update ${index + 1} has an unsupported target.`);
		}
		const destination = resolveRecordTarget(project, target);
		if (!destination) throw new Error(`Record update ${index + 1} has no configured target path.`);
		if (seenTargets.has(destination.path)) throw new Error(`Record update ${index + 1} targets ${destination.label} more than once.`);
		seenTargets.add(destination.path);
		const operation = update.operation === undefined ? "append" : update.operation;
		if (operation !== "append" && operation !== "replace-once") throw new Error(`Record update ${index + 1} has an unsupported operation.`);
		const append = typeof update.append === "string" ? update.append.trim() : "";
		const anchor = typeof update.anchor === "string" ? update.anchor : "";
		const replacement = typeof update.replacement === "string" ? update.replacement : "";
		const activeText = operation === "append" ? append : anchor;
		if (!activeText || activeText.length > 8000) throw new Error(`Record update ${index + 1} must contain 1-8000 characters of ${operation === "append" ? "append text" : "anchor text"}.`);
		if (operation === "replace-once" && replacement.length > 8000) throw new Error(`Record update ${index + 1} replacement must contain at most 8000 characters.`);
		if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(`${activeText}${replacement}`)) throw new Error(`Record update ${index + 1} contains unsupported control characters.`);
		const customId = typeof update.id === "string" ? update.id.trim() : "";
		return { id: customId || `${target}-${index + 1}`, target, targetPath: destination.path, label: destination.label, operation, append: operation === "append" ? append : undefined, anchor: operation === "replace-once" ? anchor : undefined, replacement: operation === "replace-once" ? replacement : undefined, before: "", after: "", sourceFingerprint: "" };
	});
}

function textFingerprint(text: string): string {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function acceptanceDirectory(project: NovelProject): string {
	return joinFsPath(project.rootPath, ".novel/acceptances");
}

function acceptancePath(project: NovelProject, chapter: string, kind: NovelAcceptanceKind): string {
	const safeChapter = chapter.replace(/[^A-Za-z0-9_-]/g, "-") || "chapter";
	return joinFsPath(acceptanceDirectory(project), `${safeChapter}-${kind}.json`);
}

function parseAcceptanceRecord(text: string): NovelAcceptanceRecord {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("Acceptance record is not valid JSON.");
	}
	if (!raw || typeof raw !== "object") throw new Error("Acceptance record has an invalid shape.");
	const record = raw as Partial<NovelAcceptanceRecord>;
	if (record.version !== 1 || (record.kind !== "chapter-card" && record.kind !== "manuscript") || typeof record.chapter !== "string" || typeof record.sourcePath !== "string" || typeof record.sourceFingerprint !== "string" || typeof record.cardPath !== "string" || typeof record.cardFingerprint !== "string" || typeof record.acceptedAt !== "string") {
		throw new Error("Acceptance record has an invalid shape.");
	}
	return record as NovelAcceptanceRecord;
}

async function loadCurrentAcceptance(project: NovelProject, chapter: string, kind: NovelAcceptanceKind, sourcePath: string, sourceText: string, cardPath: string, cardText: string): Promise<NovelAcceptanceRecord | null> {
	const path = acceptancePath(project, chapter, kind);
	if (!(await exists(path))) return null;
	const record = parseAcceptanceRecord(await readTextFile(path));
	if (record.kind !== kind || record.chapter !== chapter || record.sourcePath !== sourcePath || record.cardPath !== cardPath) return null;
	if (record.sourceFingerprint !== textFingerprint(sourceText) || record.cardFingerprint !== textFingerprint(cardText)) return null;
	return record;
}

function revisionRequestDirectory(project: NovelProject): string {
	return joinFsPath(project.rootPath, "planning/revision-requests");
}

export function isRevisionRequestOpen(requestText: string, sourceText: string, scope: NovelRevisionScope): boolean {
	if (!/USER_REVISION_REQUESTED/.test(statusOf(requestText))) return false;
	const baselineFingerprint = headerValue(requestText, ["revision_baseline_fingerprint"]);
	if (baselineFingerprint) return textFingerprint(sourceText) === baselineFingerprint;
	if (scope === "manuscript") {
		const sourceFingerprint = headerValue(requestText, ["source_fingerprint"]);
		return !sourceFingerprint || textFingerprint(sourceText) === sourceFingerprint;
	}
	return true;
}

function latestRevisionRequest(documents: NovelDocument[], chapter: string, scope: NovelRevisionScope, sourceText: string): NovelDocument | null {
	return documents
		.filter((document) => /planning\/revision-requests\//.test(document.relativePath) && matchChapter(document.relativePath, chapter) && headerValue(document.text ?? "", ["scope"]) === scope && isRevisionRequestOpen(document.text ?? "", sourceText, scope))
		.sort((left, right) => right.relativePath.localeCompare(left.relativePath))[0] ?? null;
}

function promotionHistoryDirectory(project: NovelProject): string {
	return joinFsPath(project.rootPath, ".novel/promotion-history");
}

function promotionHistoryPath(project: NovelProject, id: string): string {
	return joinFsPath(promotionHistoryDirectory(project), `${id}.json`);
}

function createPromotionId(chapter: string, stamp: string): string {
	const safeChapter = chapter.replace(/[^A-Za-z0-9_-]/g, "-") || "chapter";
	return `promotion-${safeChapter}-${stamp.replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
}

function parsePromotionHistory(text: string): NovelPromotionHistoryEntry {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error("Promotion history is not valid JSON.");
	}
	if (!raw || typeof raw !== "object") throw new Error("Promotion history has an invalid shape.");
	const entry = raw as Partial<NovelPromotionHistoryEntry>;
	if (entry.version !== 1 || typeof entry.id !== "string" || typeof entry.createdAt !== "string" || typeof entry.chapter !== "string" || typeof entry.candidatePath !== "string" || typeof entry.canonicalPath !== "string" || typeof entry.canonicalFingerprint !== "string" || !Array.isArray(entry.recordUpdates)) {
		throw new Error("Promotion history has an invalid shape.");
	}
	if (entry.rolledBackAt !== undefined && typeof entry.rolledBackAt !== "string") throw new Error("Promotion history has an invalid rollback state.");
	const recordUpdates = entry.recordUpdates.map((update) => {
		if (!update || typeof update !== "object") throw new Error("Promotion history contains an invalid record update.");
		const record = update as Partial<NovelPromotionHistoryRecord>;
		if (typeof record.id !== "string" || typeof record.label !== "string" || typeof record.targetPath !== "string" || (record.operation !== "append" && record.operation !== "replace-once") || typeof record.before !== "string" || typeof record.after !== "string" || typeof record.beforeFingerprint !== "string" || typeof record.afterFingerprint !== "string") {
			throw new Error("Promotion history contains an invalid record update.");
		}
		return record as NovelPromotionHistoryRecord;
	});
	return { ...entry, version: 1, recordUpdates } as NovelPromotionHistoryEntry;
}

async function readPromotionHistory(project: NovelProject, id: string): Promise<NovelPromotionHistoryEntry> {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Promotion history id is invalid.");
	const path = promotionHistoryPath(project, id);
	if (!(await exists(path))) throw new Error("Promotion history does not exist.");
	return parsePromotionHistory(await readTextFile(path));
}

export async function loadLatestActivePromotion(project: NovelProject, chapter: string): Promise<NovelPromotionHistoryEntry | null> {
	const directory = promotionHistoryDirectory(project);
	if (!(await exists(directory))) return null;
	const entries = await readDir(directory);
	const histories = await Promise.all(entries
		.filter((entry) => entry.isFile && entry.name.endsWith(".json"))
		.map(async (entry) => parsePromotionHistory(await readTextFile(joinFsPath(directory, entry.name)))));
	return histories
		.filter((entry) => entry.chapter === chapter && !entry.rolledBackAt)
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function replaceExactlyOnce(text: string, anchor: string, replacement: string, label: string): string {
	const first = text.indexOf(anchor);
	if (first < 0) throw new Error(`${label} no longer contains the declared replacement anchor.`);
	if (text.indexOf(anchor, first + anchor.length) >= 0) throw new Error(`${label} contains the declared replacement anchor more than once.`);
	return `${text.slice(0, first)}${replacement}${text.slice(first + anchor.length)}`;
}

export function materializeRecordUpdate(update: NovelRecordUpdatePreview, current: string): string {
	return update.operation === "append"
		? `${current.trimEnd()}\n\n${update.after}\n`
		: replaceExactlyOnce(current, update.before, update.after, update.label);
}

export async function planChapterRecordUpdates(project: NovelProject, record: NovelChapterRecord): Promise<NovelRecordUpdatePreview[]> {
	if (!record.proposalPath) return [];
	const proposalPath = resolveNovelPath(project.rootPath, record.proposalPath);
	if (!(await exists(proposalPath))) throw new Error("Continuity proposal does not exist.");
	const updates = parseProposalRecordUpdates(await readTextFile(proposalPath), project);
	return Promise.all(updates.map(async (update) => {
		const updatePath = resolveNovelPath(project.rootPath, update.targetPath);
		if (!(await exists(updatePath))) throw new Error(`${update.label} does not exist; it will not be created automatically.`);
		const current = await readTextFile(updatePath);
		if (update.operation === "append") {
			const append = update.append ?? "";
			return { ...update, before: "", after: append, sourceFingerprint: textFingerprint(current) };
		}
		const anchor = update.anchor ?? "";
		const replacement = update.replacement ?? "";
		replaceExactlyOnce(current, anchor, replacement, update.label);
		return { ...update, before: anchor, after: replacement, sourceFingerprint: textFingerprint(current) };
	}));
}

export async function promoteChapter(project: NovelProject, record: NovelChapterRecord, selectedRecordUpdates: NovelRecordUpdatePreview[] = []): Promise<string> {
	const guard = canPromoteChapter(record);
	if (!guard.allowed || !record.candidatePath || !record.canonicalPath) throw new Error(guard.reason);
	const source = resolveNovelPath(project.rootPath, record.candidatePath);
	const target = resolveNovelPath(project.rootPath, record.canonicalPath);
	if (!(await exists(source))) throw new Error("Candidate manuscript does not exist.");
	if (await exists(target)) throw new Error("Canonical target already exists; promotion will not overwrite it.");
	const canonicalText = await readTextFile(source);
	const availableUpdates = await planChapterRecordUpdates(project, record);
	const updateById = new Map(availableUpdates.map((update) => [update.id, update]));
	const selectedUpdates = selectedRecordUpdates.map((selected) => {
		const fresh = updateById.get(selected.id);
		if (!fresh || fresh.operation !== selected.operation || fresh.before !== selected.before || fresh.after !== selected.after || fresh.sourceFingerprint !== selected.sourceFingerprint) {
			throw new Error("An associated record changed after the preview. Reopen promotion to review it again.");
		}
		return fresh;
	});
	if (new Set(selectedUpdates.map((update) => update.id)).size !== selectedUpdates.length) throw new Error("A record update was selected more than once.");
	const preparedUpdates = [] as Array<{ path: string; previous: string; next: string }>;
	for (const update of selectedUpdates) {
		const updatePath = resolveNovelPath(project.rootPath, update.targetPath);
		const previous = await readTextFile(updatePath);
		if (textFingerprint(previous) !== update.sourceFingerprint) throw new Error(`${update.label} changed after the preview. Reopen promotion to review it again.`);
		const next = materializeRecordUpdate(update, previous);
		preparedUpdates.push({ path: updatePath, previous, next });
	}
	const auditPath = joinFsPath(project.rootPath, ".novel/promotion-log.md");
	const priorAudit = await exists(auditPath) ? await readTextFile(auditPath) : "# Canon Promotion Log\n";
	const stamp = new Date().toISOString();
	const history: NovelPromotionHistoryEntry = {
		version: 1,
		id: createPromotionId(record.chapter, stamp),
		createdAt: stamp,
		chapter: record.chapter,
		candidatePath: record.candidatePath,
		canonicalPath: record.canonicalPath,
		canonicalFingerprint: textFingerprint(canonicalText),
		recordUpdates: preparedUpdates.map((update, index) => {
			const preview = selectedUpdates[index];
			return {
				id: preview.id,
				label: preview.label,
				targetPath: preview.targetPath,
				operation: preview.operation,
				before: update.previous,
				after: update.next,
				beforeFingerprint: textFingerprint(update.previous),
				afterFingerprint: textFingerprint(update.next),
			};
		}),
	};
	const historyPath = promotionHistoryPath(project, history.id);
	const recordUpdateLog = selectedUpdates.length > 0
		? `\n  record_updates:\n${selectedUpdates.map((update) => `    - ${update.targetPath}`).join("\n")}`
		: "\n  record_updates: none";
	const nextAudit = `${priorAudit.trimEnd()}\n\n- ${stamp}: promoted chapter ${record.chapter}\n  source: ${record.candidatePath}\n  target: ${record.canonicalPath}\n  manuscript_acceptance: explicit user action\n  history: .novel/promotion-history/${history.id}.json${recordUpdateLog}\n`;
	const auditAlreadyExisted = await exists(auditPath);
	let copiedTarget = false;
	const writtenUpdates: Array<{ path: string; previous: string }> = [];
	let auditWritten = false;
	let historyWriteStarted = false;
	try {
	await mkdir(target.slice(0, Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"))), { recursive: true });
	await writeTextFile(target, canonicalText);
		copiedTarget = true;
		for (const update of preparedUpdates) {
			await writeTextFile(update.path, update.next);
			writtenUpdates.push({ path: update.path, previous: update.previous });
		}
		await writeTextFile(auditPath, nextAudit);
		auditWritten = true;
		await mkdir(promotionHistoryDirectory(project), { recursive: true });
		historyWriteStarted = true;
		await writeTextFile(historyPath, `${JSON.stringify(history, null, "\t")}\n`);
	} catch (error) {
		const rollbackErrors: string[] = [];
		if (historyWriteStarted && await exists(historyPath)) {
			try { await remove(historyPath); } catch { rollbackErrors.push("promotion history"); }
		}
		if (auditWritten) {
			try {
				if (auditAlreadyExisted) await writeTextFile(auditPath, priorAudit);
				else await remove(auditPath);
			} catch {
				rollbackErrors.push("audit log");
			}
		}
		for (const update of writtenUpdates.reverse()) {
			try {
				await writeTextFile(update.path, update.previous);
			} catch {
				rollbackErrors.push(update.path);
			}
		}
		if (copiedTarget) {
			try {
				await remove(target);
			} catch {
				rollbackErrors.push(record.canonicalPath);
			}
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(rollbackErrors.length > 0 ? `${message} Rollback also failed for: ${rollbackErrors.join(", ")}.` : message);
	}
	return target;
}

export function canRollbackPromotion(record: NovelChapterRecord): { allowed: boolean; reason: string } {
	if (record.state !== "promoted") return { allowed: false, reason: "Only a promoted chapter can be rolled back." };
	if (!record.rollbackHistory) return { allowed: false, reason: "No active promotion history exists for this chapter." };
	return { allowed: true, reason: "Promotion history is available for review." };
}

/** Reverts one promotion only when all promoted files are still unchanged. */
export async function rollbackPromotion(project: NovelProject, record: NovelChapterRecord): Promise<void> {
	const guard = canRollbackPromotion(record);
	if (!guard.allowed || !record.rollbackHistory) throw new Error(guard.reason);
	const history = await readPromotionHistory(project, record.rollbackHistory.id);
	if (history.rolledBackAt) throw new Error("This promotion was already rolled back.");
	if (history.chapter !== record.chapter || history.canonicalPath !== record.canonicalPath) throw new Error("Promotion history does not match this chapter.");
	const target = resolveNovelPath(project.rootPath, history.canonicalPath);
	if (!(await exists(target))) throw new Error("Canonical file no longer exists; rollback is unavailable.");
	const canonicalText = await readTextFile(target);
	if (textFingerprint(canonicalText) !== history.canonicalFingerprint) throw new Error("Canonical text changed after promotion. Rollback will not overwrite it.");
	const preparedUpdates: Array<{ path: string; current: string; restore: string }> = [];
	for (const update of history.recordUpdates) {
		const path = resolveNovelPath(project.rootPath, update.targetPath);
		if (!(await exists(path))) throw new Error(`${update.label} no longer exists; rollback is unavailable.`);
		const current = await readTextFile(path);
		if (textFingerprint(current) !== update.afterFingerprint) throw new Error(`${update.label} changed after promotion. Rollback will not overwrite it.`);
		preparedUpdates.push({ path, current, restore: update.before });
	}
	const auditPath = joinFsPath(project.rootPath, ".novel/promotion-log.md");
	const auditAlreadyExisted = await exists(auditPath);
	const priorAudit = auditAlreadyExisted ? await readTextFile(auditPath) : "# Canon Promotion Log\n";
	const stamp = new Date().toISOString();
	const nextAudit = `${priorAudit.trimEnd()}\n\n- ${stamp}: rolled back promotion ${history.id}\n  chapter: ${history.chapter}\n  target: ${history.canonicalPath}\n  reason: explicit user action\n`;
	const historyPath = promotionHistoryPath(project, history.id);
	const rolledBackHistory: NovelPromotionHistoryEntry = { ...history, rolledBackAt: stamp };
	const writtenUpdates: Array<{ path: string; current: string }> = [];
	let removedTarget = false;
	let auditWritten = false;
	let historyWriteStarted = false;
	try {
		for (const update of preparedUpdates) {
			await writeTextFile(update.path, update.restore);
			writtenUpdates.push({ path: update.path, current: update.current });
		}
		await remove(target);
		removedTarget = true;
		await writeTextFile(auditPath, nextAudit);
		auditWritten = true;
		historyWriteStarted = true;
		await writeTextFile(historyPath, `${JSON.stringify(rolledBackHistory, null, "\t")}\n`);
	} catch (error) {
		const rollbackErrors: string[] = [];
		if (historyWriteStarted) {
			try { await writeTextFile(historyPath, `${JSON.stringify(history, null, "\t")}\n`); } catch { rollbackErrors.push("promotion history"); }
		}
		if (auditWritten) {
			try {
				if (auditAlreadyExisted) await writeTextFile(auditPath, priorAudit);
				else await remove(auditPath);
			} catch { rollbackErrors.push("audit log"); }
		}
		if (removedTarget) {
			try { await writeTextFile(target, canonicalText); } catch { rollbackErrors.push(history.canonicalPath); }
		}
		for (const update of writtenUpdates.reverse()) {
			try { await writeTextFile(update.path, update.current); } catch { rollbackErrors.push(update.path); }
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(rollbackErrors.length > 0 ? `${message} Recovery also failed for: ${rollbackErrors.join(", ")}.` : message);
	}
}

async function writeAcceptance(project: NovelProject, record: NovelChapterRecord, kind: NovelAcceptanceKind, sourcePath: string, sourceText: string, cardText: string): Promise<void> {
	const acceptance: NovelAcceptanceRecord = {
		version: 1,
		kind,
		chapter: record.chapter,
		sourcePath,
		sourceFingerprint: textFingerprint(sourceText),
		cardPath: record.cardPath,
		cardFingerprint: textFingerprint(cardText),
		acceptedAt: new Date().toISOString(),
	};
	await mkdir(acceptanceDirectory(project), { recursive: true });
	await writeTextFile(acceptancePath(project, record.chapter, kind), `${JSON.stringify(acceptance, null, "\t")}\n`);
}

function acceptedCardText(text: string): string {
	if (/^approval_status:\s*.+$/im.test(text)) return text.replace(/^approval_status:\s*.+$/im, "approval_status: APPROVED_BY_USER");
	return `${text.trimEnd()}\n\napproval_status: APPROVED_BY_USER\n`;
}

function pendingCardText(text: string): string {
	if (/^approval_status:\s*.+$/im.test(text)) return text.replace(/^approval_status:\s*.+$/im, "approval_status: PROPOSED_PENDING_USER_ACCEPTANCE");
	return `${text.trimEnd()}\n\napproval_status: PROPOSED_PENDING_USER_ACCEPTANCE\n`;
}

export async function acceptChapterCard(project: NovelProject, record: NovelChapterRecord): Promise<void> {
	if (record.architectureRegistered === false) throw new Error("Chapter architecture registration is required before accepting a chapter card.");
	const cardPath = resolveNovelPath(project.rootPath, record.cardPath);
	if (!(await exists(cardPath))) throw new Error("Chapter card does not exist.");
	const previous = await readTextFile(cardPath);
	if (/REVISION_REQUESTED/.test(statusOf(previous))) throw new Error("The chapter card is awaiting a revision.");
	const next = acceptedCardText(previous);
	let cardWritten = false;
	try {
		if (next !== previous) {
			await writeTextFile(cardPath, next);
			cardWritten = true;
		}
		await writeAcceptance(project, record, "chapter-card", record.cardPath, next, next);
	} catch (error) {
		if (cardWritten) {
			try { await writeTextFile(cardPath, previous); } catch { /* The acceptance write error remains the primary error. */ }
		}
		throw error;
	}
}

export async function acceptChapterManuscript(project: NovelProject, record: NovelChapterRecord): Promise<void> {
	if (record.architectureRegistered === false) throw new Error("Chapter architecture registration is required before accepting a manuscript.");
	if (!record.cardAccepted) throw new Error("The chapter card must be accepted first.");
	if (!record.candidatePath) throw new Error("Candidate manuscript is missing.");
	if (record.verification !== "pass" && record.verification !== "pass-with-warnings") throw new Error("The candidate manuscript needs a current PASS verification report before user acceptance.");
	const cardPath = resolveNovelPath(project.rootPath, record.cardPath);
	const candidatePath = resolveNovelPath(project.rootPath, record.candidatePath);
	if (!(await exists(cardPath)) || !(await exists(candidatePath))) throw new Error("Chapter card or candidate manuscript no longer exists.");
	await writeAcceptance(project, record, "manuscript", record.candidatePath, await readTextFile(candidatePath), await readTextFile(cardPath));
}

export async function requestChapterRevision(project: NovelProject, record: NovelChapterRecord, scope: NovelRevisionScope, feedback: string): Promise<string> {
	const text = feedback.trim();
	if (!text || text.length > 8000) throw new Error("Revision feedback must contain 1-8000 characters.");
	const sourcePath = scope === "chapter-card" ? record.cardPath : record.candidatePath;
	if (!sourcePath) throw new Error(scope === "chapter-card" ? "Chapter card is missing." : "Candidate manuscript is missing.");
	const fullPath = resolveNovelPath(project.rootPath, sourcePath);
	if (!(await exists(fullPath))) throw new Error("The requested revision source no longer exists.");
	const sourceText = await readTextFile(fullPath);
	const revisionBaseline = scope === "chapter-card" ? pendingCardText(sourceText) : sourceText;
	const stamp = new Date().toISOString();
	const id = `${record.chapter}-${scope}-${stamp.replace(/[:.]/g, "-")}`;
	const relativePath = `planning/revision-requests/${id}.md`;
	const requestPath = resolveNovelPath(project.rootPath, relativePath);
	await mkdir(revisionRequestDirectory(project), { recursive: true });
	if (await exists(requestPath)) throw new Error("A revision request with this id already exists.");
	const title = scope === "chapter-card" ? "Chapter Card" : "Manuscript";
	const content = `# Revision Request: Chapter ${record.chapter} ${title}\n\nstatus: USER_REVISION_REQUESTED\nscope: ${scope}\nsource_text: ${sourcePath}\nsource_fingerprint: ${textFingerprint(sourceText)}\nrevision_baseline_fingerprint: ${textFingerprint(revisionBaseline)}\ncreated_at: ${stamp}\n\n## User Feedback\n\n${text}\n`;
	await writeTextFile(requestPath, content);
	const acceptance = acceptancePath(project, record.chapter, scope === "chapter-card" ? "chapter-card" : "manuscript");
	if (await exists(acceptance)) await remove(acceptance);
	if (scope === "chapter-card") await writeTextFile(fullPath, revisionBaseline);
	return relativePath;
}

export async function prepareRevisionRequestForWork(project: NovelProject, record: NovelChapterRecord, scope: NovelRevisionScope, requestPath: string): Promise<void> {
	const sourcePath = scope === "chapter-card" ? record.cardPath : record.candidatePath;
	if (!sourcePath) throw new Error(scope === "chapter-card" ? "Chapter card is missing." : "Candidate manuscript is missing.");
	const sourceFullPath = resolveNovelPath(project.rootPath, sourcePath);
	const requestFullPath = resolveNovelPath(project.rootPath, requestPath);
	if (!(await exists(sourceFullPath)) || !(await exists(requestFullPath))) throw new Error("The saved revision request or its source file no longer exists.");
	const requestText = await readTextFile(requestFullPath);
	if (!/USER_REVISION_REQUESTED/.test(statusOf(requestText))) throw new Error("The saved revision request is no longer open.");
	if (headerValue(requestText, ["revision_baseline_fingerprint"])) return;
	const baseline = textFingerprint(await readTextFile(sourceFullPath));
	const insertion = `revision_baseline_fingerprint: ${baseline}\n`;
	const next = /^created_at:\s*.+$/im.test(requestText)
		? requestText.replace(/^created_at:\s*.+$/im, (line) => `${insertion}${line}`)
		: `${requestText.trimEnd()}\n${insertion}`;
	await writeTextFile(requestFullPath, next);
}

export async function inspectChapterWorkflow(project: NovelProject, documents: NovelDocument[], chapter: string): Promise<NovelChapterRecord> {
	const byPath = (path: string | null | undefined) => path ? documents.find((doc) => doc.relativePath === path)?.text ?? "" : "";
	const architecture = documents.find((doc) => doc.relativePath === "planning/chapter-architecture.md" || doc.relativePath === "plan/chapter-architecture.md");
	const architecturePath = architecture?.relativePath ?? null;
	const normalizedChapter = chapter.replace(/^0+/, "") || "0";
	const architectureChapterPattern = new RegExp("^\\s*-\\s*chapter:\\s*[\"']?0*" + normalizedChapter + "[\"']?\\s*(?:#.*)?$", "im");
	const architectureRegistered = Boolean(architecture && architectureChapterPattern.test(architecture.text ?? ""));
	const cardPath = `planning/chapter-cards/${chapter}.md`;
	const candidate = documents.find((doc) => doc.category === "drafts" && doc.classification.authority === "proposed" && matchChapter(doc.relativePath, chapter));
	const proposal = documents.find((doc) => /continuity-proposals/.test(doc.relativePath) && matchChapter(doc.relativePath, chapter));
	const review = documents.find((doc) => /reviews/.test(doc.relativePath) && matchChapter(doc.relativePath, chapter));
	const verification = documents.find((doc) => {
		if (!matchChapter(doc.relativePath, chapter)) return false;
		return /(^|\/)verifications?(\/|$)|(^|\/)[^/]*verification[^/]*\.(md|mdx|txt)$/i.test(doc.relativePath);
	});
	const canonicalRoot = project.config.authority?.canonicalPaths?.[0] ?? "manuscript";
	const canonicalTargetRoot = canonicalRoot.replace(/\\/g, "/").replace(/\/$/, "");
	const canonical = documents.find((doc) => doc.classification.authority === "canonical" && matchChapter(doc.relativePath, chapter));
	const card = byPath(cardPath);
	const cardRevisionRequest = latestRevisionRequest(documents, chapter, "chapter-card", card);
	const manuscriptRevisionRequest = latestRevisionRequest(documents, chapter, "manuscript", candidate?.text ?? "");
	const acceptedCard = card ? await loadCurrentAcceptance(project, chapter, "chapter-card", cardPath, card, cardPath, card) : null;
	const cardAccepted = Boolean(acceptedCard) || /APPROVED_BY_USER/.test(statusOf(card));
	const manuscriptAcceptance = card && candidate
		? await loadCurrentAcceptance(project, chapter, "manuscript", candidate.relativePath, candidate.text ?? "", cardPath, card)
		: null;
	const verificationRecord = readChapterVerification(verification?.text ?? "", chapter, candidate?.relativePath ?? null);
	const reasons: string[] = [];
	if (!architecturePath) reasons.push("Missing chapter architecture: planning/chapter-architecture.md");
	else if (!architectureRegistered) reasons.push("Missing chapter architecture registration: Chapter " + chapter + " is not registered.");
	if (!card) reasons.push(`Missing chapter card: ${cardPath}`);
	const cardContractReason = card ? chapterCardContractReason(card) : null;
	if (cardContractReason) reasons.push(`Invalid chapter card contract: ${cardContractReason}`);
	if (!candidate) reasons.push("No proposed candidate manuscript found.");
	if (cardRevisionRequest) reasons.push("A user revision request is open for the chapter card.");
	if (manuscriptRevisionRequest) reasons.push("A user revision request is open for the candidate manuscript.");
	if (!proposal) reasons.push("No continuity proposal found; promotion will not update associated records.");
	return {
		chapter, architecturePath, architectureRegistered, cardPath, candidatePath: candidate?.relativePath ?? null, proposalPath: proposal?.relativePath ?? null,
		reviewPath: review?.relativePath ?? null, verificationPath: verification?.relativePath ?? null,
		canonicalPath: canonical?.relativePath ?? `${canonicalTargetRoot}/${chapter}.md`,
		state: chapterWorkflowState({ card, candidate: candidate?.text, canonical: Boolean(canonical), architectureReady: architectureRegistered, cardAccepted, cardRevisionRequested: Boolean(cardRevisionRequest), manuscriptAccepted: Boolean(manuscriptAcceptance), manuscriptRevisionRequested: Boolean(manuscriptRevisionRequest) }),
		verification: verificationRecord.status, verificationReason: verificationRecord.reason, reasons,
		cardAccepted, manuscriptAcceptance,
		cardRevisionRequestPath: cardRevisionRequest?.relativePath ?? null,
		manuscriptRevisionRequestPath: manuscriptRevisionRequest?.relativePath ?? null,
		rollbackHistory: canonical ? await loadLatestActivePromotion(project, chapter) : null,
	};
}
