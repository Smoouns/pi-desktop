import { access, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Bind verification to the exact bytes read, including BOM/EOL and contracts.
// A fresh receipt can be revalidated without trusting model-declared hashes.
const verificationSources = new Map<string, string>();

type Scalar = string | number | boolean | null;
type YamlValue = Scalar | YamlValue[] | { [key: string]: YamlValue };
type Issue = { code: string; message: string };
type Warning = { code: string; message: string };
type Line = { indent: number; content: string; number: number };

class ContractError extends Error {}

const YAML_FENCE = String.fromCharCode(96).repeat(3);
const SCENE_RE = /<!--\s*SCENE:\s*([A-Za-z0-9_.-]+)\s*-->/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const HEADING_RE = /^\s*#{1,6}\s+.*(?:\r?\n|$)/gm;
const LIST_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/m;
const CARD_FIELD_RE = /^\s*(?:chapter|file|min_chars|target_chars|max_chars|scene_budget|required_scenes|primary_tension|secondary_threads|forbidden_reveals|paragraphs|required_heading|function|end_state|type)\s*:/im;
const CONTAMINATION_PATTERNS: Array<[string, RegExp]> = [
	["TODO/TBD marker", /\b(?:TODO|TBD)\b/i],
	["planning placeholder", /\[(?:待补|待写|待扩写|占位)[^\]]*\]|<(?:待补|待写|placeholder)[^>]*>/i],
	["task or prompt residue", /写作要求|任务说明|提示词|请扩写|请继续|占位符|prompt\s*:|instruction\s*:/i],
	["fenced code block", new RegExp(YAML_FENCE)],
];

function option(name: string): string | null {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function normalized(value: string): string {
	return value.replace(/\\/g, "/");
}

function chapterId(value: unknown): string {
	const raw = String(value ?? "").trim();
	return /^\d+$/.test(raw) ? raw.padStart(3, "0") : raw;
}

function parseScalar(value: string): YamlValue {
	const raw = value.trim();
	if (raw === "[]") return [];
	if (raw === "{}") return {};
	if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === "true";
	if (/^(null|none|~)$/i.test(raw)) return null;
	if (/^[-+]?\d+$/.test(raw) || /^[-+]?(?:\d+\.\d*|\d*\.\d+)$/.test(raw)) return Number(raw);
	if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1).replace(raw.startsWith("'") ? /''/g : /\\"/g, raw.startsWith("'") ? "'" : "\"");
	return raw;
}

function pair(content: string, source: string, number: number): [string, string] {
	const match = /^([^:\n]+?):(?=$|\s)(.*)$/.exec(content);
	if (!match?.[1]?.trim()) throw new ContractError(source + ":" + number + ": mapping key is invalid.");
	return [match[1].trim(), match[2].trim()];
}

class SimpleYamlParser {
	private readonly lines: Line[] = [];
	private readonly source: string;
	constructor(text: string, source: string) {
		this.source = source;
		for (const [index, raw] of text.split(/\r?\n/).entries()) {
			if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
			const leading = raw.match(/^ */)?.[0].length ?? 0;
			if (raw.slice(0, leading).includes("\t")) throw new ContractError(source + ":" + (index + 1) + ": tabs are not allowed for YAML indentation.");
			this.lines.push({ indent: leading, content: raw.trim(), number: index + 1 });
		}
	}

	parse(): YamlValue {
		if (!this.lines.length) throw new ContractError(this.source + ": YAML document is empty.");
		const [value, index] = this.parseBlock(0, this.lines[0].indent);
		if (index !== this.lines.length) throw new ContractError(this.source + ":" + this.lines[index].number + ": could not parse YAML line.");
		return value;
	}

	private parseBlock(index: number, indent: number): [YamlValue, number] {
		if (this.lines[index]?.indent !== indent) throw new ContractError(this.source + ":" + (this.lines[index]?.number ?? "?") + ": inconsistent indentation.");
		return this.lines[index].content.startsWith("-") ? this.parseList(index, indent) : this.parseMapping(index, indent);
	}

	private parseMapping(index: number, indent: number): [{ [key: string]: YamlValue }, number] {
		const result: { [key: string]: YamlValue } = {};
		while (index < this.lines.length) {
			const line = this.lines[index];
			if (line.indent < indent) break;
			if (line.indent > indent || line.content.startsWith("-")) throw new ContractError(this.source + ":" + line.number + ": unexpected indentation or list item.");
			const [key, rawValue] = pair(line.content, this.source, line.number);
			if (key in result) throw new ContractError(this.source + ":" + line.number + ": duplicate key " + key + ".");
			index += 1;
			let value: YamlValue;
			if (/^[>|][+-]?$/.test(rawValue)) [value, index] = this.parseBlockScalar(index, indent, rawValue, line.number);
			else if (rawValue) value = parseScalar(rawValue);
			else if (index < this.lines.length && this.lines[index].indent > indent) [value, index] = this.parseBlock(index, this.lines[index].indent);
			else value = null;
			result[key] = value;
		}
		return [result, index];
	}

	private parseBlockScalar(index: number, parentIndent: number, indicator: string, lineNumber: number): [string, number] {
		const parts: string[] = [];
		while (index < this.lines.length && this.lines[index].indent > parentIndent) {
			parts.push(this.lines[index].content);
			index += 1;
		}
		if (!parts.length) throw new ContractError(this.source + ":" + lineNumber + ": block scalar has no content.");
		return [parts.join(indicator.startsWith("|") ? "\n" : " ").trim(), index];
	}

	private parseList(index: number, indent: number): [YamlValue[], number] {
		const result: YamlValue[] = [];
		while (index < this.lines.length) {
			const line = this.lines[index];
			if (line.indent < indent) break;
			if (line.indent > indent || !line.content.startsWith("-")) throw new ContractError(this.source + ":" + line.number + ": invalid list indentation.");
			const rest = line.content.slice(1).trim();
			index += 1;
			if (!rest) {
				if (index >= this.lines.length || this.lines[index].indent <= indent) throw new ContractError(this.source + ":" + line.number + ": empty list item.");
				let item: YamlValue;
				[item, index] = this.parseBlock(index, this.lines[index].indent);
				result.push(item);
				continue;
			}
			if (!/^([^:\n]+?):(?=$|\s)/.test(rest)) { result.push(parseScalar(rest)); continue; }
			const [key, rawValue] = pair(rest, this.source, line.number);
			const item: { [key: string]: YamlValue } = {};
			let value: YamlValue;
			if (/^[>|][+-]?$/.test(rawValue)) [value, index] = this.parseBlockScalar(index, indent, rawValue, line.number);
			else if (rawValue) value = parseScalar(rawValue);
			else if (index < this.lines.length && this.lines[index].indent > indent) [value, index] = this.parseBlock(index, this.lines[index].indent);
			else value = null;
			item[key] = value;
			if (index < this.lines.length && this.lines[index].indent > indent) {
				let tail: YamlValue;
				[tail, index] = this.parseBlock(index, this.lines[index].indent);
				if (!tail || Array.isArray(tail) || typeof tail !== "object") throw new ContractError(this.source + ":" + line.number + ": list item tail must be a mapping.");
				for (const [tailKey, tailValue] of Object.entries(tail)) {
					if (tailKey in item) throw new ContractError(this.source + ":" + line.number + ": duplicate list item key " + tailKey + ".");
					item[tailKey] = tailValue;
				}
			}
			result.push(item);
		}
		return [result, index];
	}
}

function yamlDocument(text: string, source: string): { [key: string]: YamlValue } {
	const matches = [...text.matchAll(new RegExp(YAML_FENCE + "ya?ml\\s*\\r?\\n([\\s\\S]*?)" + YAML_FENCE, "gi"))];
	if (matches.length !== 1 || !matches[0][1]) throw new ContractError(source + ": expected exactly one fenced YAML document.");
	const parsed = new SimpleYamlParser(matches[0][1], source).parse();
	if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new ContractError(source + ": YAML root must be a mapping.");
	return parsed;
}

function asMapping(value: YamlValue | undefined, label: string): { [key: string]: YamlValue } {
	if (!value || Array.isArray(value) || typeof value !== "object") throw new ContractError(label + " must be a mapping.");
	return value;
}

function asList(value: YamlValue | undefined, label: string): YamlValue[] {
	if (!Array.isArray(value)) throw new ContractError(label + " must be a list.");
	return value;
}

function requiredText(mapping: { [key: string]: YamlValue }, key: string, label: string): string {
	const value = mapping[key];
	if (typeof value !== "string" || !value.trim()) throw new ContractError(label + "." + key + " must be non-empty text.");
	return value.trim();
}

function requiredInt(mapping: { [key: string]: YamlValue }, key: string, label: string, minimum = 0): number {
	const value = mapping[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) throw new ContractError(label + "." + key + " must be an integer >= " + minimum + ".");
	return value;
}

function resolveMember(root: string, relative: string, label: string): string {
	if (relative.split(/[\\/]+/).some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*\u0000-\u001f]/.test(segment))) {
		throw new ContractError(label + " contains an unsafe path segment: " + relative);
	}
	const candidate = path.resolve(root, relative);
	const rel = path.relative(root, candidate);
	if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new ContractError(label + " escapes project root: " + relative);
	return candidate;
}

async function assertNoLinkedSegments(root: string, member: string, label: string, allowMissingLeaf = false): Promise<void> {
	const relative = path.relative(root, member);
	if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
		throw new ContractError(label + " escapes project root.");
	}
	let current = root;
	const segments = relative.split(path.sep);
	for (const [index, segment] of segments.entries()) {
		current = path.join(current, segment);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new ContractError(label + " uses linked path segment: " + normalized(path.relative(root, current)));
		} catch (error) {
			if (error instanceof ContractError) throw error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" && allowMissingLeaf && index === segments.length - 1) return;
			throw error;
		}
	}
}

async function safeRead(root: string, member: string, label: string): Promise<string> {
	await assertNoLinkedSegments(root, member, label);
	const raw = await readFile(member);
	const relative = normalized(path.relative(root, member));
	const digest = createHash("sha256").update(raw).digest("hex");
	const previous = verificationSources.get(relative);
	if (previous && previous !== digest) throw new ContractError("Source changed during verification: " + relative);
	verificationSources.set(relative, digest);
	return raw.toString("utf8").replace(/^\uFEFF/, "");
}

async function exists(filePath: string): Promise<boolean> {
	try { await access(filePath); return true; } catch { return false; }
}

function pathAliases(relative: string): string[] {
	const value = normalized(relative).replace(/^\.\/+/, "");
	return [...new Set([value, value.startsWith("plan/") ? "planning/" + value.slice(5) : "", value.startsWith("planning/") ? "plan/" + value.slice(9) : ""].filter(Boolean))];
}

async function existingMember(root: string, relative: string, label: string): Promise<string> {
	for (const alias of pathAliases(relative)) {
		const candidate = resolveMember(root, alias, label);
		if (await exists(candidate)) return candidate;
	}
	throw new ContractError("Missing " + label + ": " + relative);
}

async function readProjectConfig(root: string): Promise<{ [key: string]: YamlValue }> {
	const metadataPath = resolveMember(root, ".novel/project.json", "Novel Project metadata");
	const parsed: unknown = JSON.parse(await safeRead(root, metadataPath, "Novel Project metadata"));
	if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new ContractError("Novel Project metadata must be an object.");
	return parsed as { [key: string]: YamlValue };
}

function authorityProposedRoots(config: { [key: string]: YamlValue }): string[] {
	const authority = config.authority && typeof config.authority === "object" && !Array.isArray(config.authority) ? config.authority as { [key: string]: YamlValue } : {};
	return Array.isArray(authority.proposedPaths) ? authority.proposedPaths.filter((value): value is string => typeof value === "string") : ["drafts/candidates"];
}

async function resolveChapterFile(root: string, config: { [key: string]: YamlValue }, configured: string): Promise<string> {
	for (const alias of pathAliases(configured)) {
		const candidate = resolveMember(root, alias, "chapter file");
		if (await exists(candidate)) return candidate;
	}
	const wantedName = path.basename(configured).replace(/\.(md|mdx|txt)$/i, "");
	const matches: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		if (!(await exists(directory))) return;
		await assertNoLinkedSegments(root, directory, "proposed chapter root");
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const child = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new ContractError("proposed chapter root uses linked path segment: " + normalized(path.relative(root, child)));
			if (entry.isDirectory()) await visit(child);
			else if (entry.isFile() && entry.name.replace(/\.(md|mdx|txt)$/i, "") === wantedName) matches.push(child);
		}
	};
	for (const proposedRoot of authorityProposedRoots(config)) await visit(resolveMember(root, proposedRoot, "proposed chapter root"));
	if (matches.length === 1) return matches[0];
	throw new ContractError(matches.length ? "Chapter file is ambiguous: " + configured : "Missing chapter file: " + configured);
}

type Contract = {
	file: string; requiredHeading: string | null; minChars: number; targetChars: number; maxChars: number; sceneMin: number; sceneMax: number;
	required: Record<string, { minChars: number; type: string; function: string; endState: string }>;
	paragraphMin: number; paragraphChars: number; maxCompactParts: number; forbidden: string[]; prohibitedCharacters: string[];
};

async function loadContract(root: string, chapter: string): Promise<{ config: { [key: string]: YamlValue }; contract: Contract }> {
	const config = await readProjectConfig(root);
	let architecturePath = "";
	for (const relative of ["planning/chapter-architecture.md", "plan/chapter-architecture.md"]) {
		const candidate = resolveMember(root, relative, "chapter architecture");
		if (await exists(candidate)) { architecturePath = candidate; break; }
	}
	if (!architecturePath) throw new ContractError("Missing chapter architecture.");
	const architecture = yamlDocument(await safeRead(root, architecturePath, "chapter architecture"), architecturePath);
	const entries = asList(architecture.chapters, "chapter-architecture.chapters");
	const entry = entries.map((value) => asMapping(value, "chapter-architecture item")).find((value) => chapterId(value.chapter) === chapter);
	if (!entry) throw new ContractError("Chapter " + chapter + " is not registered in chapter architecture.");
	const cardPath = await existingMember(root, requiredText(entry, "card", "chapter architecture"), "chapter card");
	const card = yamlDocument(await safeRead(root, cardPath, "chapter card"), cardPath);
	if (chapterId(entry.chapter) !== chapter || chapterId(card.chapter) !== chapter) throw new ContractError("Architecture and card chapter ids must both equal " + chapter + ".");
	for (const key of ["file", "min_chars", "target_chars", "max_chars"]) if (entry[key] !== card[key]) throw new ContractError("Architecture/card mismatch for " + key + ".");
	const entryBudget = asMapping(entry.scene_budget, "chapter-architecture.scene_budget");
	const cardBudget = asMapping(card.scene_budget, "chapter-card.scene_budget");
	if (JSON.stringify(entryBudget) !== JSON.stringify(cardBudget)) throw new ContractError("Architecture/card mismatch for scene_budget.");
	const minChars = requiredInt(card, "min_chars", "chapter-card", 1);
	const targetChars = requiredInt(card, "target_chars", "chapter-card", 1);
	const maxChars = requiredInt(card, "max_chars", "chapter-card", 1);
	if (!(minChars <= targetChars && targetChars <= maxChars)) throw new ContractError("Chapter lengths must satisfy min_chars <= target_chars <= max_chars.");
	const sceneMin = requiredInt(cardBudget, "min", "chapter-card.scene_budget", 1);
	const sceneMax = requiredInt(cardBudget, "max", "chapter-card.scene_budget", 1);
	if (sceneMin > sceneMax) throw new ContractError("scene_budget.min must be <= scene_budget.max.");
	const heading = card.required_heading === undefined || card.required_heading === null ? null : requiredText(card, "required_heading", "chapter-card");
	if (heading && !/^#{1,6}\s+\S/.test(heading)) throw new ContractError("chapter-card.required_heading must be a Markdown heading.");
	const required: Contract["required"] = {};
	for (const [index, raw] of asList(card.required_scenes, "chapter-card.required_scenes").entries()) {
		const scene = asMapping(raw, "required_scenes[" + index + "]");
		const id = requiredText(scene, "id", "required_scenes[" + index + "]");
		if (!/^[A-Za-z0-9_.-]+$/.test(id) || required[id]) throw new ContractError("Invalid or duplicate required scene id: " + id);
		required[id] = { minChars: requiredInt(scene, "min_chars", "required_scenes[" + index + "]", 1), type: requiredText(scene, "type", "required_scenes[" + index + "]"), function: requiredText(scene, "function", "required_scenes[" + index + "]"), endState: requiredText(scene, "end_state", "required_scenes[" + index + "]") };
	}
	if (!Object.keys(required).length || Object.keys(required).length > sceneMax) throw new ContractError("required_scenes must be non-empty and fit scene_budget.max.");
	const paragraphs = asMapping(card.paragraphs, "chapter-card.paragraphs");
	const maxCompactParts = paragraphs.max_compact_parts === undefined ? 3 : paragraphs.max_compact_parts;
	if (typeof maxCompactParts !== "number" || !Number.isInteger(maxCompactParts) || maxCompactParts < 1 || maxCompactParts > 3) throw new ContractError("chapter-card.paragraphs.max_compact_parts must be an integer from 1 to 3.");
	const secondary = asMapping(card.secondary_threads, "chapter-card.secondary_threads");
	const secondaryMin = requiredInt(secondary, "min", "chapter-card.secondary_threads", 0);
	const secondaryMax = requiredInt(secondary, "max", "chapter-card.secondary_threads", 0);
	if (secondaryMin > secondaryMax || secondaryMax > 2) throw new ContractError("secondary_threads must satisfy 0 <= min <= max <= 2.");
	for (const item of asList(secondary.allowed, "chapter-card.secondary_threads.allowed")) if (typeof item !== "string" || !item.trim()) throw new ContractError("Every secondary_threads.allowed item must be non-empty text.");
	requiredText(card, "primary_tension", "chapter-card");
	const forbidden = asList(card.forbidden_reveals, "chapter-card.forbidden_reveals").map((item, index) => {
		if (typeof item !== "string" || !item.trim()) throw new ContractError("forbidden_reveals[" + index + "] must be non-empty text.");
		return item.trim();
	});
	const allowedCharacters = card.allowed_characters === undefined ? null : asMapping(card.allowed_characters, "chapter-card.allowed_characters");
	const prohibitedCharacters = allowedCharacters?.prohibited === undefined ? [] : asList(allowedCharacters.prohibited, "chapter-card.allowed_characters.prohibited").map((item, index) => {
		if (typeof item !== "string" || !item.trim()) throw new ContractError("allowed_characters.prohibited[" + index + "] must be non-empty text.");
		return item.trim();
	});
	return { config, contract: { file: requiredText(card, "file", "chapter-card"), requiredHeading: heading, minChars, targetChars, maxChars, sceneMin, sceneMax, required, paragraphMin: requiredInt(paragraphs, "min_substantial", "chapter-card.paragraphs", 1), paragraphChars: requiredInt(paragraphs, "min_chars_each", "chapter-card.paragraphs", 1), maxCompactParts, forbidden, prohibitedCharacters } };
}

function cleanBody(text: string): string { return text.replace(COMMENT_RE, "").replace(HEADING_RE, ""); }
function countChars(text: string): number { return cleanBody(text).replace(/\s+/g, "").length; }

function parseScenes(text: string): { ids: string[]; scenes: Record<string, string>; duplicates: string[]; preamble: string; firstSceneIndex: number } {
	const markers = [...text.matchAll(SCENE_RE)];
	const ids: string[] = []; const scenes: Record<string, string> = {}; const duplicates: string[] = [];
	for (const [index, marker] of markers.entries()) {
		const id = marker[1]; ids.push(id);
		const start = (marker.index ?? 0) + marker[0].length;
		const end = index + 1 < markers.length ? (markers[index + 1].index ?? text.length) : text.length;
		if (scenes[id] !== undefined) duplicates.push(id); else scenes[id] = text.slice(start, end);
	}
	return { ids, scenes, duplicates, preamble: markers.length ? text.slice(0, markers[0].index) : text, firstSceneIndex: markers[0]?.index ?? text.length };
}

function narrativeUnits(scenes: Record<string, string>, minimum: number, maxParts: number): number {
	let units = 0;
	for (const scene of Object.values(scenes)) {
		const paragraphs = cleanBody(scene).split(/(?:\r?\n\s*){2,}/).filter((paragraph) => countChars(paragraph) > 0);
		let chars = 0; let parts = 0;
		for (const paragraph of paragraphs) {
			chars += countChars(paragraph); parts += 1;
			if (chars >= minimum) { units += 1; chars = 0; parts = 0; }
			else if (parts >= maxParts) { chars = 0; parts = 0; }
		}
	}
	return units;
}

function makeReport(chapter: string, mode: string, source: string, total: number | null, target: number | null, sceneCounts: Record<string, number>, contract: Contract | null, failures: Issue[], warnings: Warning[]): string {
	const status = failures.length ? "FAIL" : warnings.length ? "PASS_WITH_WARNINGS" : "PASS";
	const sources = [...verificationSources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, sha256]) => ({ path, sha256 }));
	const lines = ["---", "chapter: " + chapter, "mode: " + mode, "source_text: " + source, "source_sha256: " + (verificationSources.get(source) ?? "unavailable"), "verification_sources: " + JSON.stringify(sources), "verification_status: " + status, "generator: pi-desktop-verify-novel-chapter/v3", "generated_at: " + new Date().toISOString(), "body_chars: " + (total ?? "unavailable"), "---", "", "# 第 " + chapter + " 章机械验证报告", ""];
	if (target !== null && total !== null) lines.push("目标字符数（仅供参考）：" + target + "，偏差 " + (total - target >= 0 ? "+" : "") + (total - target) + "。", "");
	if (Object.keys(sceneCounts).length) { lines.push("## 场景计数", ""); for (const [id, count] of Object.entries(sceneCounts)) lines.push("- " + id + "：" + count + (contract?.required[id] ? " / 最低 " + contract.required[id].minChars : "")); lines.push(""); }
	if (failures.length) { lines.push("## 失败原因", ""); for (const item of failures) lines.push("- [" + item.code + "] " + item.message); lines.push(""); }
	if (warnings.length) { lines.push("## 警告", ""); for (const item of warnings) lines.push("- [" + item.code + "] " + item.message); lines.push(""); }
	if (!failures.length && !warnings.length) lines.push("机械结构、长度、场景、污染与禁剧透检查通过。", "");
	lines.push("此报告仅提供可重复的机械证据，不代表用户验收、语义连续性审查或 Canon 晋升。");
	return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
	const projectArgument = option("--project"); const chapterArgument = option("--chapter"); const sceneArgument = option("--scene"); const chapterFile = option("--chapter-file"); const noWrite = process.argv.includes("--no-write");
	if (!projectArgument || !chapterArgument) throw new Error("Usage: node --experimental-strip-types scripts/verify-novel-chapter.ts --project <Novel Project> --chapter <NNN> [--scene <scene-id>] [--chapter-file <relative path>] [--no-write]");
	const root = path.resolve(projectArgument); const chapter = chapterId(chapterArgument);
	let contract: Contract | null = null; let source = chapterFile ? normalized(chapterFile) : ""; let manuscript = "";
	const failures: Issue[] = []; const warnings: Warning[] = [];
	try {
		if (!(await exists(path.join(root, ".novel", "project.json")))) throw new ContractError("Not a Novel Project: .novel/project.json is missing.");
		const loaded = await loadContract(root, chapter); contract = loaded.contract;
		const chapterPath = chapterFile ? resolveMember(root, chapterFile, "chapter file") : await resolveChapterFile(root, loaded.config, contract.file);
		if (!chapterFile) {
			const resolvedPath = normalized(path.relative(root, chapterPath));
			const configuredPath = normalized(contract.file);
			if (resolvedPath !== configuredPath) throw new ContractError("Chapter file path mismatch: architecture/card declare " + configuredPath + ", but the existing candidate is " + resolvedPath + ". Update planning to use authority.proposedPaths and keep the architecture/card file fields identical.");
		}
		if (!(await exists(chapterPath))) throw new ContractError("Chapter file does not exist: " + (chapterFile ?? contract.file));
		source = normalized(path.relative(root, chapterPath)); manuscript = await safeRead(root, chapterPath, "chapter file");
	} catch (error) { failures.push({ code: "CONTRACT", message: error instanceof Error ? error.message : String(error) }); }
	const scenes = parseScenes(manuscript); const counts = Object.fromEntries(Object.entries(scenes.scenes).map(([id, text]) => [id, countChars(text)])); const total = manuscript ? countChars(manuscript) : null;
	if (contract && manuscript) {
		if (contract.requiredHeading) {
			const headings = [...manuscript.matchAll(new RegExp("^" + contract.requiredHeading.replace(/[.*+?^$()|[\]\\]/g, "\\$&") + "[ \\t]*\\r?$", "gm"))];
			if (headings.length !== 1) failures.push({ code: "HEADING", message: "Required heading must appear exactly once: " + contract.requiredHeading });
			else if ((headings[0].index ?? 0) > scenes.firstSceneIndex) failures.push({ code: "HEADING_ORDER", message: "Required heading must appear before the first scene." });
		}
		for (const id of [...new Set(scenes.duplicates)]) failures.push({ code: "SCENE_DUPLICATE", message: "Duplicate scene boundary: " + id });
		if (countChars(scenes.preamble) > 0) failures.push({ code: "SCENE_PREAMBLE", message: "Prose exists before the first scene boundary." });
		const validComments = new Set([...manuscript.matchAll(SCENE_RE)].map((match) => match[0]));
		const invalidComments = [...manuscript.matchAll(COMMENT_RE)].filter((match) => !validComments.has(match[0]));
		if (invalidComments.length) failures.push({ code: "HTML_COMMENT", message: "Found " + invalidComments.length + " invalid HTML comment(s); only SCENE boundaries are allowed." });
		for (const [label, pattern] of CONTAMINATION_PATTERNS) if (pattern.test(manuscript)) failures.push({ code: "CONTAMINATION", message: "Detected " + label + "." });
		if (LIST_RE.test(manuscript)) failures.push({ code: "MARKDOWN_LIST", message: "Markdown list syntax is not allowed in chapter prose." });
		if (CARD_FIELD_RE.test(manuscript)) failures.push({ code: "CARD_FIELD_POLLUTION", message: "Chapter-card field syntax leaked into chapter prose." });
		for (const reveal of contract.forbidden) if (manuscript.toLocaleLowerCase().includes(reveal.toLocaleLowerCase())) failures.push({ code: "FORBIDDEN_REVEAL", message: "Forbidden reveal appears literally: " + reveal });
		for (const name of contract.prohibitedCharacters) if (manuscript.includes(name)) failures.push({ code: "PROHIBITED_CHARACTER", message: "Chapter contains prohibited character: " + name });
		if (scenes.ids.length > contract.sceneMax) failures.push({ code: "SCENE_BUDGET_MAX", message: "Scene count " + scenes.ids.length + " exceeds scene_budget.max=" + contract.sceneMax + "." });
		if (sceneArgument) {
			const scene = contract.required[sceneArgument];
			if (!scene) failures.push({ code: "SCENE_UNKNOWN", message: "Requested scene is not declared in required_scenes: " + sceneArgument });
			else if (scenes.scenes[sceneArgument] === undefined) failures.push({ code: "SCENE_MISSING", message: "Missing required scene boundary: " + sceneArgument });
			else if (counts[sceneArgument] < scene.minChars) failures.push({ code: "SCENE_MIN_CHARS", message: "Scene " + sceneArgument + " has " + counts[sceneArgument] + " characters; required min_chars=" + scene.minChars + "." });
			if (total !== null && total > contract.maxChars) failures.push({ code: "MAX_CHARS", message: "Chapter already has " + total + " characters; max_chars=" + contract.maxChars + "." });
		} else {
			if (total !== null && total < contract.minChars) failures.push({ code: "MIN_CHARS", message: "Chapter has " + total + " characters; required min_chars=" + contract.minChars + "." });
			if (total !== null && total > contract.maxChars) failures.push({ code: "MAX_CHARS", message: "Chapter has " + total + " characters; allowed max_chars=" + contract.maxChars + "." });
			if (scenes.ids.length < contract.sceneMin || scenes.ids.length > contract.sceneMax) failures.push({ code: "SCENE_BUDGET", message: "Scene count " + scenes.ids.length + " is outside scene_budget " + contract.sceneMin + ".." + contract.sceneMax + "." });
			for (const [id, scene] of Object.entries(contract.required)) {
				if (scenes.scenes[id] === undefined) failures.push({ code: "SCENE_MISSING", message: "Missing required scene boundary: " + id });
				else if (counts[id] < scene.minChars) failures.push({ code: "SCENE_MIN_CHARS", message: "Scene " + id + " has " + counts[id] + " characters; required min_chars=" + scene.minChars + "." });
			}
			const units = narrativeUnits(scenes.scenes, contract.paragraphChars, contract.maxCompactParts);
			if (units < contract.paragraphMin) warnings.push({ code: "NARRATIVE_UNITS", message: "Narrative-unit density warning: " + units + " / advisory " + contract.paragraphMin + ". Inspect compressed summaries or micro-paragraphs manually." });
		}
	}
	const report = makeReport(chapter, sceneArgument ? "scene:" + sceneArgument : "full", source || "unavailable", total, contract?.targetChars ?? null, counts, contract, failures, warnings);
	if (!noWrite) {
		const reportPath = resolveMember(root, "planning/verifications/" + chapter + "-verification.md", "verification report");
		await assertNoLinkedSegments(root, path.dirname(reportPath), "verification report directory", true);
		await mkdir(path.dirname(reportPath), { recursive: true });
		await assertNoLinkedSegments(root, path.dirname(reportPath), "verification report directory");
		await assertNoLinkedSegments(root, reportPath, "verification report", true);
		await writeFile(reportPath, report, "utf8");
		console.log("已写入 " + normalized(path.relative(root, reportPath)));
	}
	console.log(report); if (failures.length) process.exitCode = 1;
}

await main();
