export interface StoryRangeSelector { startLine?: number; endLine?: number; section?: string; }
export interface StoryRangeResult { text: string; startLine: number; endLine: number; totalLines: number; complete: boolean; }
export interface StoryRangeReader { select(text: string, selector?: StoryRangeSelector): StoryRangeResult; }

/** Pure text selector designed for embedding in generated Pi extensions. */
export function createStoryRangeReader(): StoryRangeReader {
	const invalid = (message: string): Error & { kind: string } => Object.assign(new Error(message), { kind: "invalid_input" });
	const split = (text: string): { content: string; ending: string }[] => {
		const lines: { content: string; ending: string }[] = [];
		let offset = 0;
		for (let index = 0; index < text.length; index += 1) {
			if (text[index] !== "\n") continue;
			const contentEnd = index > offset && text[index - 1] === "\r" ? index - 1 : index;
			lines.push({ content: text.slice(offset, contentEnd), ending: text.slice(contentEnd, index + 1) });
			offset = index + 1;
		}
		lines.push({ content: text.slice(offset), ending: "" });
		return lines;
	};
	const integer = (value: number | undefined, name: string): number | undefined => {
		if (value === undefined) return undefined;
		if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${name} must be a positive safe integer`);
		return value;
	};
	const join = (lines: { content: string; ending: string }[], start: number, end: number): string => lines.slice(start - 1, end).map((line) => line.content + line.ending).join("");
	return {
		select(text, selector = {}) {
			if (typeof text !== "string") throw invalid("text must be a string");
			if (!selector || typeof selector !== "object" || Array.isArray(selector)) throw invalid("selector must be an object");
			const lines = split(text); const totalLines = lines.length;
			const startInput = integer(selector.startLine, "startLine"); const endInput = integer(selector.endLine, "endLine");
			if (selector.section !== undefined && (startInput !== undefined || endInput !== undefined)) throw invalid("section cannot be combined with a line range");
			if (selector.section !== undefined) {
				if (typeof selector.section !== "string" || !selector.section.trim()) throw invalid("section must not be empty");
				const target = selector.section.trim();
				const headings: { line: number; level: number; title: string }[] = [];
				let fence: { marker: string; length: number } | null = null;
				for (let index = 0; index < lines.length; index += 1) {
					const content = lines[index]!.content;
					const fenceMatch = content.match(/^ {0,3}(`{3,}|~{3,})/);
					if (fenceMatch) {
						const marker = fenceMatch[1]![0]!; const length = fenceMatch[1]!.length;
						if (fence === null) fence = { marker, length };
						else if (marker === fence.marker && length >= fence.length && new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(content)) fence = null;
						continue;
					}
					if (fence !== null) continue;
					const heading = content.match(/^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/);
					if (heading) {
						const title = heading[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
						headings.push({ line: index + 1, level: heading[1]!.length, title });
					}
				}
				const matches = headings.filter((heading) => heading.title === target);
				if (matches.length !== 1) throw invalid(matches.length === 0 ? `section not found: ${target}` : `section is ambiguous: ${target}`);
				const match = matches[0]!; const next = headings.find((heading) => heading.line > match.line && heading.level <= match.level);
				const endLine = (next?.line ?? (totalLines + 1)) - 1;
				return { text: join(lines, match.line, endLine), startLine: match.line, endLine, totalLines, complete: match.line === 1 && endLine === totalLines };
			}
			const startLine = startInput ?? 1; const endLine = endInput ?? totalLines;
			if (startLine > totalLines || endLine > totalLines) throw invalid("line range exceeds document bounds");
			if (endLine < startLine) throw invalid("endLine must be greater than or equal to startLine");
			if (startInput === undefined && endInput === undefined) return { text, startLine: 1, endLine: totalLines, totalLines, complete: true };
			return { text: join(lines, startLine, endLine), startLine, endLine, totalLines, complete: startLine === 1 && endLine === totalLines };
		},
	};
}
