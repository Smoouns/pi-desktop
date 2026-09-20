/** Portable read-only engine. The factory is embedded in the managed Pi extension. */
export interface MemoryIO {
	read(path: string): Promise<string | null>;
	list(path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink?: boolean }>>;
}
export interface StoryMemory {
	id: string;
	project: string;
	path: string;
	sourceFingerprint: string;
	startLine: number;
	endLine: number;
	heading: string;
	text: string;
	layer: "CANON" | "DERIVED";
	authority: "canonical" | "approved";
	kind: "world" | "canonical-prose" | "accepted-prose" | "continuity";
	temporal: "setting" | "recorded" | "planned";
	chapter: number | null;
	observedAt: string;
	generatedBy: "pi-desktop-source-index/v1";
	estimatedTokens: number;
}
export interface StoryMemorySnapshot {
	project: string;
	revision: string;
	memories: StoryMemory[];
	sourceCount: number;
	scannedFiles: number;
	warnings: string[];
	observedAt: string;
}
export interface StoryMemoryQuery {
	query: string;
	limit?: number;
	maxChars?: number;
	throughChapter?: number;
	includePlanned?: boolean;
}
export interface StoryMemoryHit extends StoryMemory {
	score: number;
	reason: string;
}
export interface StoryMemorySearch {
	query: string;
	revision: string;
	project: string;
	hits: StoryMemoryHit[];
	sourceCount: number;
	matchedCount: number;
	warnings: string[];
	observedAt: string;
}

// Keep every runtime dependency inside this factory: .toString() must be standalone
// after both TypeScript stripping and production minification.
export function createNovelMemoryEngine() {
	const engineVersion = "pi-desktop-source-index/v1" as const;
	const skipped = new Set([".git", ".novel", "node_modules", "dist", "archive", "exports", "research", "assets", "memory"]);
	const key = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const safePath = (value: unknown): value is string => typeof value === "string" && Boolean(value) && !/[\\<>:"|?*\x00-\x1f]/.test(value) && !value.startsWith("/") && value.split("/").every((part) => Boolean(part) && part !== "." && part !== ".." && !/[. ]$/.test(part));
	const legacyFingerprint = (text: string) => {
		let hash = 2166136261;
		for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
		return `${text.length}:${(hash >>> 0).toString(16)}`;
	};
	const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const parse = (text: string | null): Record<string, any> | null => {
		try { const value = JSON.parse((text ?? "").replace(/^\uFEFF/, "")); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
	};
	const status = (text: string) => /^(?:status|approval_status):\s*["']?([^\r\n"']+)/im.exec(text)?.[1]?.trim().toUpperCase() ?? "";
	const chapterOf = (path: string): number | null => {
		const match = /(?:^|\/)(?:chapter[-_ ]?)?(\d{1,6})(?:[-_][^/]*)?\.(?:md|markdown|txt)$/i.exec(path);
		return match ? Number(match[1]) : null;
	};
	const tokens = (text: string): string[] => {
		const words = text.toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? [];
		return words.flatMap((word) => /\p{Script=Han}/u.test(word) ? (word.length === 1 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))) : [word]);
	};
	const estimate = (text: string) => Math.ceil((text.match(/\p{Script=Han}/gu)?.length ?? 0) * 0.85 + text.length / 4);

	async function snapshot(root: string, io: MemoryIO): Promise<StoryMemorySnapshot> {
		const project = key(root);
		const observedAt = new Date().toISOString();
		const warnings: string[] = [];
		const rawConfig = await io.read(".novel/project.json");
		const config = parse(rawConfig);
		if (!config || config.formatVersion !== 1) throw new Error("当前目录没有有效的小说项目配置。");
		const layout = { canon: ["canon"], manuscript: ["manuscript"], drafts: ["drafts"], ...config.layout };
		const authority = config.authority ?? {};
		const matches = (path: string, paths: unknown) => Array.isArray(paths) && paths.some((prefix) => {
			if (typeof prefix !== "string") return false;
			const clean = prefix.replace(/\\/g, "/").replace(/\/+$/, "");
			return safePath(clean) && (key(path) === key(clean) || key(path).startsWith(key(clean) + "/"));
		});
		const docs = new Map<string, { path: string; text: string }>();
		let scannedFiles = 0;
		let totalChars = 0;
		let visitedDirectories = 0;
		const read = async (path: string) => {
			if (!safePath(path)) return null;
			try {
				const text = await io.read(path);
				if (text === null) return null;
				if (text.length > 512_000 || totalChars + text.length > 24_000_000) { warnings.push(`读取预算已达上限，已跳过 ${path}`); return null; }
				totalChars += text.length;
				return text;
			} catch { warnings.push(`无法安全读取 ${path}`); return null; }
		};
		const walk = async (directory: string, depth: number) => {
			if (++visitedDirectories > 4000 || depth > 16 || scannedFiles >= 3000) { warnings.push("扫描达到上限，结果可能不完整。"); return; }
			let entries;
			try { entries = await io.list(directory); } catch { warnings.push(`无法读取目录 ${directory || "."}`); return; }
			for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
				const path = directory ? `${directory}/${entry.name}` : entry.name;
				if (entry.isSymlink || !safePath(path)) continue;
				if (entry.isDirectory) {
					if (!skipped.has(entry.name.toLowerCase())) await walk(path, depth + 1);
				} else if (entry.isFile && /\.(md|markdown|txt)$/i.test(path)) {
					if (++scannedFiles > 3000) { warnings.push("扫描达到文件上限，结果可能不完整。"); break; }
					const text = await read(path);
					if (text !== null) docs.set(key(path), { path, text });
				}
			}
		};
		await walk("", 0);
		const accepted = new Map<string, string>();
		let acceptances: Awaited<ReturnType<MemoryIO["list"]>> = [];
		try { acceptances = await io.list(".novel/acceptances"); } catch { /* An unstarted project has no acceptances. */ }
		for (const file of acceptances.slice(0, 3000)) {
			if (!file.isFile || file.isSymlink || !/^[\w-]+-manuscript\.json$/i.test(file.name)) continue;
			const raw = await read(`.novel/acceptances/${file.name}`);
			const record = parse(raw);
			if (!record || record.version !== 1 || record.kind !== "manuscript" || !safePath(record.sourcePath) || !safePath(record.cardPath) || !Number.isFinite(Date.parse(record.acceptedAt))) continue;
			const source = docs.get(key(record.sourcePath));
			const card = docs.get(key(record.cardPath));
			if (source && card && legacyFingerprint(source.text) === record.sourceFingerprint && legacyFingerprint(card.text) === record.cardFingerprint) accepted.set(key(source.path), raw!);
		}
		// Only explicit table rows in the Canonical Text Index are interpreted.
		// Narrative mentions of historical drafts must never grant authority.
		const index = safePath(authority.canonicalTextIndex) ? docs.get(key(authority.canonicalTextIndex)) : undefined;
		const indexMappings: Array<{ path: string; start: number; end: number }> = [];
		for (const line of (index?.text ?? "").split(/\r?\n/)) {
			const match = /^\|\s*(\d{1,6})(?:\s*[-–]\s*(\d{1,6}))?\s*\|\s*`([^`]+)`\s*\|.*\|\s*(?:user-accepted formal prose|canonical|正典|已验收)\s*\|$/i.exec(line);
			if (match && safePath(match[3].replace(/\/$/, ""))) indexMappings.push({ path: match[3].replace(/\/$/, ""), start: Number(match[1]), end: Number(match[2] ?? match[1]) });
		}
		const memories: StoryMemory[] = [];
		let sourceCount = 0;
		const projectHash = (await digest(project)).slice(0, 16);
		for (const doc of docs.values()) {
			const declaredStatus = status(doc.text);
			if (/RETIRED|SUPERSEDED|HISTORICAL|ARCHIVED/.test(declaredStatus)) continue;
			if (matches(doc.path, config.layout?.archive ?? ["archive"]) || matches(doc.path, config.layout?.memory ?? ["memory"]) || matches(doc.path, config.layout?.research ?? ["research"])) continue;
			if (index && key(doc.path) === key(index.path)) continue;
			const chapter = chapterOf(doc.path);
			const isContinuity = [authority.currentState, authority.continuityLedger].some((path) => typeof path === "string" && key(path) === key(doc.path));
			const isProposed = matches(doc.path, authority.proposedPaths) || /PROPOSED|AWAITING|PENDING/.test(declaredStatus);
			const mapped = matches(doc.path, authority.canonicalPaths) || indexMappings.some((mapping) => matches(doc.path, [mapping.path]) && chapter !== null && chapter >= mapping.start && chapter <= mapping.end);
			let kind: StoryMemory["kind"];
			if (isContinuity && !isProposed) kind = "continuity";
			else if (!isProposed && (mapped || matches(doc.path, layout.manuscript))) kind = "canonical-prose";
			else if (!isProposed && matches(doc.path, layout.canon)) kind = "world";
			else if (accepted.has(key(doc.path)) && (matches(doc.path, layout.drafts) || matches(doc.path, authority.proposedPaths))) kind = "accepted-prose";
			else continue;
			const sourceFingerprint = await digest(doc.text);
			const sourceId = (await digest(doc.path + "\n" + sourceFingerprint + "\n" + kind + "\n" + (accepted.get(key(doc.path)) ?? ""))).slice(0, 40);
			const lines = doc.text.split(/\r?\n/);
			const headings: string[] = [];
			let start = 0;
			let size = 0;
			let fence = "";
			const flush = (end: number) => {
				const text = lines.slice(start, end).join("\n").trim();
				if (!text) return;
				// Keep source excerpts intact, but never return an unbounded single
				// paragraph or fenced block through read_story_memory.
				if (text.length > 8000) { warnings.push(`片段超过 8,000 字，已跳过 ${doc.path}:L${start + 1}–${end}，请直接查看来源文件。`); return; }
				const heading = headings.filter(Boolean).join(" / ");
				const sectionChapter = /(?:第\s*|chapter\s*)(\d{1,6})(?:\s*章)?/i.exec(heading);
				const effectiveChapter = (kind === "world" ? null : chapter) ?? (sectionChapter ? Number(sectionChapter[1]) : null);
				const temporal = /未来|未发生|尚未发生|未来节点|future|planned/i.test(heading) ? "planned" : kind === "world" ? "setting" : "recorded";
				memories.push({ id: `mem-${projectHash}-${sourceId}-${start + 1}-${end}`, project, path: doc.path, sourceFingerprint, startLine: start + 1, endLine: end, heading: heading || doc.path, text, layer: kind === "world" || kind === "canonical-prose" ? "CANON" : "DERIVED", authority: kind === "accepted-prose" ? "approved" : "canonical", kind, temporal, chapter: effectiveChapter, observedAt, generatedBy: engineVersion, estimatedTokens: estimate(text) });
			};
			for (let i = 0; i < lines.length; i++) {
				const heading = !fence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]) : null;
				if (heading) {
					flush(i); start = i; size = 0;
					headings.length = heading[1].length;
					headings[heading[1].length - 1] = heading[2];
				} else if (size >= 1400 && !fence) { flush(i); start = i; size = 0; }
				const marker = /^\s*(`{3,}|~{3,})/.exec(lines[i])?.[1];
				if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""; }
				size += lines[i].length + 1;
			}
			flush(lines.length);
			sourceCount++;
		}
		const revision = await digest(project + rawConfig + memories.map((memory) => memory.id).join("\n"));
		return { project, revision, memories, sourceCount, scannedFiles, warnings: [...new Set(warnings)], observedAt };
	}

	function search(index: StoryMemorySnapshot, options: StoryMemoryQuery): StoryMemorySearch {
		const query = options.query.trim();
		if (!query || query.length > 240) throw new Error("请输入 1–240 字的检索内容。");
		if (options.throughChapter !== undefined && (!Number.isInteger(options.throughChapter) || options.throughChapter < 0)) throw new Error("章节范围必须是非负整数。");
		if ((options.limit !== undefined && !Number.isFinite(options.limit)) || (options.maxChars !== undefined && !Number.isFinite(options.maxChars))) throw new Error("检索预算必须是有限数字。");
		const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 8)));
		const maxChars = Math.max(200, Math.min(24000, Math.floor(options.maxChars ?? 10000)));
		const terms = [...new Set(tokens(query))];
		const corpus = index.memories.filter((memory) => {
			if (memory.temporal === "planned" && !options.includePlanned) return false;
			if (options.throughChapter === undefined || memory.kind === "world") return true;
			// An unversioned current-state paragraph cannot establish a past chapter's state.
			return memory.chapter !== null && memory.chapter <= options.throughChapter;
		});
		const frequencies = new Map<string, number>();
		const tokenized = corpus.map((memory) => tokens(memory.text));
		for (const list of tokenized) for (const term of new Set(list)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
		const average = tokenized.reduce((sum, list) => sum + list.length, 0) / Math.max(1, corpus.length);
		const ranked: StoryMemoryHit[] = [];
		for (let i = 0; i < corpus.length; i++) {
			const memory = corpus[i];
			const counts = new Map<string, number>();
			for (const token of tokenized[i]) counts.set(token, (counts.get(token) ?? 0) + 1);
			const headingTokens = new Set(tokens(memory.heading + " " + memory.path));
			let score = 0;
			const matched: string[] = [];
			for (const term of terms) {
				const frequency = counts.get(term) ?? 0;
				if (!frequency && !headingTokens.has(term)) continue;
				matched.push(term);
				const df = frequencies.get(term) ?? 0;
				const idf = Math.log(1 + (corpus.length - df + 0.5) / (df + 0.5));
				score += idf * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * tokenized[i].length / Math.max(1, average))) + (headingTokens.has(term) ? 0.35 : 0));
			}
			if (memory.text.toLowerCase().includes(query.toLowerCase())) score += 3;
			if (score <= 0 || matched.length === 0) continue;
			ranked.push({ ...memory, score: Number(score.toFixed(5)), reason: `原文词项匹配：${matched.slice(0, 6).join("、")}${memory.kind === "accepted-prose" ? "；已验收，未晋升" : ""}` });
		}
		ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
		const hits: StoryMemoryHit[] = [];
		let chars = 0;
		const duplicates = new Set<string>();
		for (const hit of ranked) {
			const duplicateKey = `${hit.kind}:${hit.authority}:${hit.temporal}:${hit.chapter}:${hit.text}`;
			if (duplicates.has(duplicateKey) || hits.length >= limit || chars + hit.text.length > maxChars) continue;
			duplicates.add(duplicateKey); hits.push(hit); chars += hit.text.length;
		}
		return { query, revision: index.revision, project: index.project, hits, sourceCount: index.sourceCount, matchedCount: ranked.length, warnings: [...index.warnings, ...(ranked.length && !hits.length ? ["匹配片段超过本次字符预算，请增加预算或打开来源文件。"] : [])], observedAt: index.observedAt };
	}

	function read(index: StoryMemorySnapshot, id: string): StoryMemory {
		const memory = index.memories.find((item) => item.id === id);
		if (!memory) throw new Error("该记忆已失效或不属于当前项目，请重新检索。源文件或验收状态可能已经变化。");
		return memory;
	}
	return { snapshot, search, read, safePath };
}
