export const NOVEL_FORMAT_VERSION = 1;

export const NOVEL_CONTENT_TYPES = [
	"manuscript",
	"canon",
	"planning",
	"draft",
	"craft",
	"note",
	"research",
	"memory",
	"archive",
	"asset",
	"export",
] as const;
export type NovelContentType = (typeof NOVEL_CONTENT_TYPES)[number];

export const NOVEL_AUTHORITIES = [
	"canonical",
	"approved",
	"proposed",
	"draft",
	"historical",
	"derived",
	"reference",
	"external-reference",
] as const;
export type NovelAuthority = (typeof NOVEL_AUTHORITIES)[number];

export interface NovelLayout {
	manuscript?: string[];
	canon?: string[];
	planning?: string[];
	drafts?: string[];
	craft?: string[];
	notes?: string[];
	memory?: string[];
	research?: string[];
	assets?: string[];
	archive?: string[];
	exports?: string[];
}

export interface NovelAuthorityEntrypoints {
	canonicalTextIndex?: string;
	currentState?: string;
	continuityLedger?: string;
	canonicalPaths?: string[];
	proposedPaths?: string[];
}

export interface NovelProjectConfig {
	formatVersion: number;
	name?: string;
	localFirst?: boolean;
	layout?: NovelLayout;
	authority?: NovelAuthorityEntrypoints;
}

export interface NovelProject {
	rootPath: string;
	configPath: string;
	config: NovelProjectConfig;
	initialized: boolean;
}

export interface NovelDocumentClassification {
	contentType: NovelContentType;
	authority: NovelAuthority;
	reason: string;
	declaredStatus?: string;
}

export interface NovelDocument {
	path: string;
	relativePath: string;
	name: string;
	category: string;
	classification: NovelDocumentClassification;
	estimatedTokens: number;
	text?: string;
}

export const DEFAULT_NOVEL_LAYOUT: Required<NovelLayout> = {
	manuscript: ["manuscript"],
	canon: ["canon"],
	planning: ["planning"],
	drafts: ["drafts"],
	craft: ["craft"],
	notes: ["notes"],
	memory: ["memory"],
	research: ["research"],
	assets: ["assets"],
	archive: ["archive"],
	exports: ["exports"],
};

export function normalizeFsPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

export function joinFsPath(base: string, relative: string): string {
	const separator = base.includes("\\") ? "\\" : "/";
	return `${base.replace(/[\\/]+$/, "")}${separator}${relative.replace(/^[\\/]+/, "")}`;
}

export function relativeNovelPath(root: string, candidate: string): string | null {
	const normalizedRoot = normalizeFsPath(root).toLowerCase();
	const normalizedCandidate = normalizeFsPath(candidate);
	const compare = normalizedCandidate.toLowerCase();
	if (compare === normalizedRoot) return "";
	if (!compare.startsWith(`${normalizedRoot}/`)) return null;
	return normalizedCandidate.slice(normalizedRoot.length + 1);
}

export function resolveNovelPath(root: string, relative: string): string {
	const clean = relative.replace(/\\/g, "/");
	if (!clean || clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.split("/").some((part) => part === "..")) {
		throw new Error("Path must remain inside the Novel Project.");
	}
	return joinFsPath(root, clean);
}

export function categoryForRelativePath(relativePath: string, config: NovelProjectConfig): string {
	const normalized = relativePath.replace(/\\/g, "/");
	const layout = { ...DEFAULT_NOVEL_LAYOUT, ...(config.layout ?? {}) };
	for (const category of Object.keys(layout) as Array<keyof NovelLayout>) {
		if (layout[category]?.some((root) => normalized === root || normalized.startsWith(`${root}/`))) return category;
	}
	return "other";
}

export function classifyNovelDocument(relativePath: string, config: NovelProjectConfig, declaredStatus?: string): NovelDocumentClassification {
	const normalized = relativePath.replace(/\\/g, "/");
	const status = declaredStatus?.trim().toUpperCase();
	const matchesPath = (paths: string[] | undefined): boolean => Boolean(paths?.some((path) => normalized === path || normalized.startsWith(`${path.replace(/\\/g, "/").replace(/\/$/, "")}/`)));
	if (matchesPath(config.authority?.canonicalPaths)) return { contentType: "manuscript", authority: "canonical", reason: "Explicit canonical path mapping in project metadata.", declaredStatus };
	if (matchesPath(config.authority?.proposedPaths)) return { contentType: "draft", authority: "proposed", reason: "Explicit proposed path mapping in project metadata.", declaredStatus };
	if (config.authority?.canonicalTextIndex && normalized === config.authority.canonicalTextIndex) {
		return { contentType: "canon", authority: "canonical", reason: "Canonical text index; it defines project authority." };
	}
	if (status?.includes("RETIRED") || status?.includes("SUPERSEDED")) {
		return { contentType: "archive", authority: "historical", reason: "Document declares retired or superseded status.", declaredStatus };
	}
	if (status?.includes("PROPOSED") || status?.includes("AWAITING_USER_REVIEW")) {
		return { contentType: categoryForRelativePath(normalized, config) as NovelContentType, authority: "proposed", reason: "Document declares a pending or review state.", declaredStatus };
	}
	const category = categoryForRelativePath(normalized, config);
	if (category === "manuscript") return { contentType: "manuscript", authority: "canonical", reason: "Formal manuscript directory; overridden by explicit authority entries when present.", declaredStatus };
	if (category === "canon") return { contentType: "canon", authority: "canonical", reason: "Author-controlled Canon directory.", declaredStatus };
	if (category === "planning") return { contentType: "planning", authority: "reference", reason: "Planning record; its Markdown status remains authoritative.", declaredStatus };
	if (category === "drafts") return { contentType: "draft", authority: "draft", reason: "Candidate or historical draft directory.", declaredStatus };
	if (category === "craft") return { contentType: "craft", authority: "reference", reason: "Writing-process reference.", declaredStatus };
	if (category === "memory") return { contentType: "memory", authority: "derived", reason: "Reserved memory directory; provenance must be shown.", declaredStatus };
	if (category === "notes") return { contentType: "note", authority: "proposed", reason: "Working note; not Canon by default.", declaredStatus };
	if (category === "research") return { contentType: "research", authority: "external-reference", reason: "External research; source material is not automatically Canon.", declaredStatus };
	if (category === "archive") return { contentType: "archive", authority: "historical", reason: "Archived project material.", declaredStatus };
	if (category === "assets") return { contentType: "asset", authority: "reference", reason: "Project asset; not injected as text by default.", declaredStatus };
	if (category === "exports") return { contentType: "export", authority: "derived", reason: "Generated export; not a source of truth.", declaredStatus };
	return { contentType: "note", authority: "reference", reason: "Unmapped file; requires explicit selection." };
}

export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

export function parseDeclaredStatus(text: string): string | undefined {
	return /^status:\s*(.+)$/im.exec(text)?.[1]?.trim();
}
