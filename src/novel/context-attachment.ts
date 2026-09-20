export interface NovelContextAttachmentDecision {
	text: string;
	isSlashCommand: boolean;
	alreadyAttached: boolean;
}

/** Pure send-boundary decision shared by the UI and deterministic harness tests. */
export function shouldAttachNovelContext(input: NovelContextAttachmentDecision): boolean {
	return !input.isSlashCommand && !input.alreadyAttached && input.text.trim().length > 0;
}
