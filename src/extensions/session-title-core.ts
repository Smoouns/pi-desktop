export interface SessionTitleMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
}

export interface SessionTitleSeed {
	user: string;
	assistant: string;
}

const SECRET_PATTERNS = [
	/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
	/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
	/\b(?:sk|AIza|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}\b/g,
];

export function visibleSessionTitleText(value: unknown, limit = 1200): string {
	let text = typeof value === "string"
		? value
		: Array.isArray(value)
			? value.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
				? [String((part as { text?: unknown }).text ?? "")]
				: []).join("\n")
			: "";
	text = text
		.replace(/<novel-(?:context|role|project|task|checkpoint)\b[^>]*>[\s\S]*?<\/novel-(?:context|role|project|task|checkpoint)>/gi, " ")
		.replace(/<novel-(?:context|role|project|task|checkpoint)\b[^>]*\/>/gi, " ");
	for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[已隐藏]");
	return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

export function sessionTitleSeed(messages: SessionTitleMessage[]): SessionTitleSeed | null {
	let assistantIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant") { assistantIndex = index; break; }
	}
	if (assistantIndex < 0) return null;
	const latestAssistant = messages[assistantIndex];
	if (latestAssistant.stopReason !== "stop" && latestAssistant.stopReason !== "length") return null;
	const assistant = visibleSessionTitleText(latestAssistant.content, 700);
	if (!assistant) return null;
	for (let index = assistantIndex - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const user = visibleSessionTitleText(message.content, 1200);
		if (user) return { user, assistant };
	}
	return null;
}

export function normalizeGeneratedSessionTitle(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const firstLine = value.split(/\r?\n/).find((line) => line.trim()) ?? "";
	const title = firstLine
		.replace(/^\s*(?:标题|title)\s*[:：]\s*/i, "")
		.replace(/^[`'"“”‘’#*\s]+|[`'"“”‘’#*\s]+$/g, "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60);
	return title.length >= 2 ? title : null;
}
