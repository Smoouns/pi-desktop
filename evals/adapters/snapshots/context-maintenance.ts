export interface ContextMaintenanceOptions {
	maxInlineBytes?: number;
	keepRecentToolResults?: number;
	pendingToolCallIds?: Iterable<string>;
	pendingToolNames?: Iterable<string>;
}

export interface TrimmedContext {
	messages: any[];
	trimmed: Array<{ toolCallId: string; toolName: string; originalBytes: number }>;
}

export interface CheckpointMessageReference {
	ref: "active-user-message";
	messageIndex: number;
}

/**
 * Kept as a self-contained factory because the desktop extension generator
 * embeds helpers with Function#toString rather than importing application code.
 */
export function createContextMaintenance() {
	const timestamp = (value: unknown): number => new Date(value as string | number).getTime();
	const appendMessage = (messages: any[], entry: any): void => {
		if (entry?.type === "message") {
			const message = entry.message;
			if (message && (message.role === "user" || message.role === "assistant" || message.role === "toolResult") && message.content == null) messages.push({ ...message, content: [] });
			else messages.push(message);
		}
		else if (entry?.type === "custom_message") messages.push({
			role: "custom", customType: entry.customType, content: entry.content ?? [],
			display: entry.display, details: entry.details, timestamp: timestamp(entry.timestamp),
		});
		else if (entry?.type === "branch_summary" && entry.summary) messages.push({
			role: "branchSummary", summary: entry.summary, fromId: entry.fromId,
			timestamp: timestamp(entry.timestamp),
		});
	};

	const userMessageText = (message: any): string | null => {
		if (message?.role !== "user") return null;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return null;
		const textParts = message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string");
		return textParts.length ? textParts.map((part: any) => part.text).join("\n") : null;
	};

	const projectCheckpoint = (checkpoint: any, activeMessages: any[]): any => {
		if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return checkpoint;
		const occurrences = new Map<string, number[]>();
		for (let index = 0; index < activeMessages.length; index += 1) {
			const value = userMessageText(activeMessages[index]);
			if (value === null) continue;
			const indexes = occurrences.get(value) ?? [];
			indexes.push(index);
			occurrences.set(value, indexes);
		}
		const consumed = new Map<string, number>();
		const reference = (value: unknown, consume: boolean): unknown => {
			if (typeof value !== "string") return value;
			const indexes = occurrences.get(value);
			if (!indexes?.length) return value;
			const cursor = consume ? (consumed.get(value) ?? 0) : indexes.length - 1;
			if (cursor >= indexes.length) return value;
			if (consume) consumed.set(value, cursor + 1);
			return { ref: "active-user-message", messageIndex: indexes[cursor] };
		};
		const constraints = Array.isArray(checkpoint.hardConstraints)
			? checkpoint.hardConstraints.map((value: unknown) => reference(value, true))
			: checkpoint.hardConstraints;
		return {
			...checkpoint,
			...(Object.prototype.hasOwnProperty.call(checkpoint, "hardConstraints") ? { hardConstraints: constraints } : {}),
			...(Object.prototype.hasOwnProperty.call(checkpoint, "objective") ? { objective: reference(checkpoint.objective, false) } : {}),
			projection: { version: 1, referenceBase: "activeMessages", exactTextOnly: true },
		};
	};

	const reconstructActiveMessages = (entries: any[], leafId?: string | null): any[] => {
		if (leafId === null) return [];
		const byId = new Map<string, any>();
		for (const entry of entries) if (entry?.id) byId.set(entry.id, entry);
		let leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
		if (!leaf) return [];
		const path: any[] = [];
		const visited = new Set<string>();
		while (leaf) {
			if (leaf.id && visited.has(leaf.id)) break;
			if (leaf.id) visited.add(leaf.id);
			path.unshift(leaf);
			leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
		}
		let compaction: any = null;
		for (const entry of path) if (entry.type === "compaction") compaction = entry;
		const messages: any[] = [];
		if (!compaction) {
			for (const entry of path) appendMessage(messages, entry);
			return messages;
		}
		messages.push({ role: "compactionSummary", summary: compaction.summary,
			tokensBefore: compaction.tokensBefore, timestamp: timestamp(compaction.timestamp) });
		const compactionIndex = path.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
		let foundFirstKept = false;
		for (let index = 0; index < compactionIndex; index += 1) {
			const entry = path[index];
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) appendMessage(messages, entry);
		}
		for (let index = compactionIndex + 1; index < path.length; index += 1) appendMessage(messages, path[index]);
		return messages;
	};

	const trimOldToolResults = (input: any[], options: ContextMaintenanceOptions = {}): TrimmedContext => {
		const maxInlineBytes = Math.max(256, Math.floor(options.maxInlineBytes ?? 6000));
		const keepRecent = Math.max(0, Math.floor(options.keepRecentToolResults ?? 4));
		const pendingIds = new Set(options.pendingToolCallIds ?? []);
		const pendingNames = new Set(options.pendingToolNames ?? []);
		const toolResultIndexes: number[] = [];
		for (let index = 0; index < input.length; index += 1) if (input[index]?.role === "toolResult") toolResultIndexes.push(index);
		const protectedIndexes = new Set(toolResultIndexes.slice(-keepRecent));
		const encoder = new TextEncoder();
		const trimmed: TrimmedContext["trimmed"] = [];
		const messages = input.map((message, index) => {
			if (message?.role !== "toolResult" || protectedIndexes.has(index)) return message;
			const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
			const toolName = typeof message.toolName === "string" ? message.toolName : "";
			if (pendingIds.has(toolCallId) || pendingNames.has(toolName)) return message;
			if (!Array.isArray(message.content) || message.content.some((part: any) => part?.type !== "text" || typeof part.text !== "string")) return message;
			const originalBytes = encoder.encode(message.content.map((part: any) => part.text).join("\n")).byteLength;
			if (originalBytes <= maxInlineBytes) return message;
			trimmed.push({ toolCallId, toolName, originalBytes });
			const metadata = JSON.stringify({ trimmed: true, toolCallId, toolName, originalBytes });
			return { ...message, content: [{ type: "text", text: "[旧工具结果已从本次模型上下文裁剪；需要时请重新读取来源] " + metadata }], details: undefined };
		});
		return { messages, trimmed };
	};

	return { reconstructActiveMessages, projectCheckpoint, trimOldToolResults };
}

export type ContextMaintenance = ReturnType<typeof createContextMaintenance>;
