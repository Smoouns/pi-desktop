export interface ChatPanelWidthBounds {
	min: number;
	max: number;
}

export interface ChatPanelWidthOptions {
	minChatWidth: number;
	minFileWidth: number;
	dividerWidth: number;
}

export function resolveChatPanelWidthBounds(
	availableWidth: number,
	options: ChatPanelWidthOptions,
): ChatPanelWidthBounds {
	const normalize = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
	const available = normalize(availableWidth);
	const configuredChatMin = normalize(options.minChatWidth);
	const configuredFileMin = normalize(options.minFileWidth);
	const divider = normalize(options.dividerWidth);
	const usable = Math.max(0, available - divider);

	// On normal layouts both panes retain their configured minimum. When the
	// container gets narrower, preserve the chat minimum first and let the
	// editor contract. Below the chat minimum, fit chat to the actual container
	// instead of forcing horizontal overflow.
	const min = Math.min(configuredChatMin, usable);
	const max = usable >= configuredChatMin + configuredFileMin
		? usable - configuredFileMin
		: min;
	return { min, max };
}

export function clampChatPanelWidth(
	value: number,
	availableWidth: number,
	options: ChatPanelWidthOptions,
): number {
	const bounds = resolveChatPanelWidthBounds(availableWidth, options);
	const rounded = Number.isFinite(value) ? Math.round(value) : bounds.min;
	return Math.min(bounds.max, Math.max(bounds.min, rounded));
}

/**
 * The chat panel is on the right of its divider. Moving the divider left
 * enlarges the panel; moving it right shrinks it.
 */
export function chatPanelWidthFromPointer(startWidth: number, startX: number, currentX: number): number {
	return Math.round(startWidth + startX - currentX);
}
