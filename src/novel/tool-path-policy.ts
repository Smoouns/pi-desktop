export type NovelToolRole = "world" | "plan" | "write" | "review";

export interface NovelPathPolicy {
	safeRelative(value: unknown): string | null;
	roleAllows(role: string | null | undefined, value: unknown): boolean;
}

/** Self-contained so its source can be embedded in the generated Pi extension. */
export function createNovelPathPolicy(): NovelPathPolicy {
	const allowed: Record<string, string[]> = {
		world: ["planning/world-proposals/"],
		plan: [
			"planning/chapter-architecture.md",
			"planning/progress.md",
			"planning/event-outlines/",
			"planning/chapter-cards/",
			"planning/reviews/",
			"planning/revision-requests/",
			"plan/chapter-architecture.md",
			"plan/progress.md",
			"plan/chapter-cards/",
		],
		write: ["drafts/candidates/", "planning/continuity-proposals/"],
		review: ["planning/reviews/", "planning/revision-requests/"],
	};
	const reserved = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
	const illegal = /[<>:"|?*\u0000-\u001f]/;

	function safeRelative(value: unknown): string | null {
		if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return null;
		if (value.includes("\\") || value.startsWith("/") || value.startsWith("//")) return null;
		if (/^[A-Za-z]:/.test(value) || value.includes(":")) return null;
		const segments = value.split("/");
		if (segments.some((segment) =>
			!segment || segment === "." || segment === ".." ||
			segment.endsWith(".") || segment.endsWith(" ") ||
			illegal.test(segment) || reserved.test(segment))) return null;
		return segments.join("/");
	}

	function roleAllows(role: string | null | undefined, value: unknown): boolean {
		const relative = safeRelative(value);
		if (!relative || !role || !Object.prototype.hasOwnProperty.call(allowed, role)) return false;
		return allowed[role].some((entry) => entry.endsWith("/") ? relative.startsWith(entry) : relative === entry);
	}

	return { safeRelative, roleAllows };
}
