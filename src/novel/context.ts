import type { NovelAuthority, NovelContentType, NovelDocument } from "./project.js";
import type { StoryMemoryHit } from "./memory-engine.js";

export interface ContextCandidate {
	document: NovelDocument;
	reason: string;
	priority: number;
	pinned?: boolean;
}

export interface ContextItem {
	path: string;
	relativePath: string;
	contentType: NovelContentType;
	authority: NovelAuthority;
	reason: string;
	readRequirement: "required" | "on-demand";
	estimatedTokens: number;
	priority: number;
	pinned: boolean;
	memory?: StoryMemoryHit;
}

export interface ContextBuildInput {
	activeDocument?: NovelDocument | null;
	pinnedDocuments?: NovelDocument[];
	selectedDocuments?: NovelDocument[];
	adjacentDocuments?: NovelDocument[];
	mentionedDocuments?: NovelDocument[];
	relevantDocuments?: NovelDocument[];
	styleDocuments?: NovelDocument[];
	manualDocuments?: NovelDocument[];
	excludedPaths?: string[];
	/** Soft UI selection estimate only; runtime read and model-input budgets are enforced separately. */
	selectionTokenBudget?: number;
	/** @deprecated Use selectionTokenBudget. Retained for compatibility as a soft selection estimate. */
	tokenBudget?: number;
}

function pathKey(path: string): string {
	return path.replace(/\\/g, "/").toLowerCase();
}

function readRequirement(candidate: ContextCandidate): ContextItem["readRequirement"] {
	if (candidate.pinned || ["active document", "relevant planning record", "style guide"].includes(candidate.reason)) return "required";
	return "on-demand";
}

function chapterNumber(document: NovelDocument): number | null {
	const match = /(?:chapter[-_ ]?)?(\d{1,4})\.md$/i.exec(document.relativePath.replace(/\\/g, "/"));
	return match ? Number(match[1]) : null;
}

export function findAdjacentCanonicalChapters(documents: NovelDocument[], activeDocument: NovelDocument | null | undefined): NovelDocument[] {
	if (!activeDocument || activeDocument.classification.contentType !== "manuscript") return [];
	const activeNumber = chapterNumber(activeDocument);
	if (activeNumber === null) return [];
	return documents.filter((document) => {
		if (document.path === activeDocument.path || document.classification.authority !== "canonical" || document.classification.contentType !== "manuscript") return false;
		const number = chapterNumber(document);
		return number !== null && Math.abs(number - activeNumber) === 1;
	}).sort((a, b) => (chapterNumber(a) ?? 0) - (chapterNumber(b) ?? 0));
}

export function findMentionedDocuments(documents: NovelDocument[], prompt: string): NovelDocument[] {
	const terms = [...new Set((prompt.match(/[\p{Script=Han}]{2,}|[A-Za-z][A-Za-z0-9_-]{2,}/gu) ?? []).filter((term) => term.length >= 2))];
	if (terms.length === 0) return [];
	return documents.filter((document) => {
		if (document.classification.authority === "historical" || document.classification.authority === "external-reference") return false;
		const searchable = `${document.name}\n${document.relativePath}\n${document.text ?? ""}`;
		return terms.some((term) => searchable.includes(term));
	});
}

export function buildNovelContext(input: ContextBuildInput): ContextItem[] {
	const candidates: ContextCandidate[] = [];
	if (input.activeDocument) candidates.push({ document: input.activeDocument, reason: "active document", priority: 1 });
	for (const document of input.pinnedDocuments ?? []) candidates.push({ document, reason: "pinned document", priority: 2, pinned: true });
	for (const document of input.selectedDocuments ?? []) candidates.push({ document, reason: "selected entity", priority: 3 });
	for (const document of input.adjacentDocuments ?? []) candidates.push({ document, reason: "adjacent canonical chapter", priority: 4 });
	for (const document of input.mentionedDocuments ?? []) candidates.push({ document, reason: "mentioned entity", priority: 5 });
	for (const document of input.relevantDocuments ?? []) candidates.push({ document, reason: "relevant planning record", priority: 6 });
	for (const document of input.styleDocuments ?? []) candidates.push({ document, reason: "style guide", priority: 7 });
	for (const document of input.manualDocuments ?? []) candidates.push({ document, reason: "manually added document", priority: 3, pinned: true });

	const excluded = new Set((input.excludedPaths ?? []).map(pathKey));
	const seen = new Set<string>();
	const result: ContextItem[] = [];
	let total = 0;
	const selectionTokenBudget = input.selectionTokenBudget ?? input.tokenBudget;
	for (const candidate of candidates.sort((a, b) => a.priority - b.priority)) {
		const key = pathKey(candidate.document.path);
		if (seen.has(key) || excluded.has(key)) continue;
		if (candidate.document.classification.authority === "historical" || candidate.document.classification.authority === "external-reference") continue;
		const estimatedTokens = candidate.document.estimatedTokens;
		if (selectionTokenBudget !== undefined && total + estimatedTokens > selectionTokenBudget && result.length > 0 && !candidate.pinned) continue;
		seen.add(key);
		total += estimatedTokens;
		result.push({
			path: candidate.document.path,
			relativePath: candidate.document.relativePath,
			contentType: candidate.document.classification.contentType,
			authority: candidate.document.classification.authority,
			reason: candidate.reason,
			readRequirement: readRequirement(candidate),
			estimatedTokens,
			priority: candidate.priority,
			pinned: Boolean(candidate.pinned),
		});
	}
	return result;
}

export function serializeNovelContextManifest(items: ContextItem[]): string {
	if (items.length === 0) return "";
	const lines = [
		"以下是本次请求的小说上下文索引；文件正文未内联。",
		"开始写作或修改前，必须使用 read_story_document、read_chapter、read_outline 或 read_character 读取所有标记为 required 的文件；其余文件按任务需要读取。",
		"带 memory_id 的条目必须使用 read_story_memory(id) 重新核验并读取；失效时重新搜索，勿引用旧片段。设定被确认不代表角色已经知情。",
	];
	for (const item of items) {
		lines.push(`### ${item.relativePath}\ncontentType: ${item.contentType}\nauthority: ${item.authority}\nread_requirement: ${item.readRequirement}\nreason: ${item.reason}\nactive_document: ${item.reason === "active document" ? "true" : "false"}\nestimated_tokens: ${item.estimatedTokens}${item.memory ? `\nmemory_id: ${item.memory.id}\nsource_sha256: ${item.memory.sourceFingerprint}\nsource_lines: ${item.memory.startLine}-${item.memory.endLine}\nlayer: ${item.memory.layer}\ntime_scope: ${item.memory.temporal}\nsource_kind: ${item.memory.kind}` : ""}`);
	}
	return lines.join("\n\n");
}
