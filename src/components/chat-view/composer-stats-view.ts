import { html, nothing, type TemplateResult } from "lit";

interface RenderComposerStatsViewParams {
	hover: boolean;
	refreshing: boolean;
	currentTokens: number | null;
	contextWindow: number | null;
	ratioPercent: string;
	ringRadius: number;
	circumference: number;
	strokeOffset: number;
	onMouseEnter: () => void;
	onMouseLeave: () => void;
	onOpen: () => void;
}

export function renderComposerStatsView({
	hover,
	refreshing,
	currentTokens,
	contextWindow,
	ratioPercent,
	ringRadius,
	circumference,
	strokeOffset,
	onMouseEnter,
	onMouseLeave,
	onOpen,
}: RenderComposerStatsViewParams): TemplateResult {
	const formatTokens = (value: number | null): string =>
		value !== null && Number.isFinite(value) && value >= 0 ? Math.round(value).toLocaleString("en-US") : "—";
	return html`
		<div class="composer-stats-slot">
			<div class="session-stats-wrap" @mouseenter=${onMouseEnter} @mouseleave=${onMouseLeave} @focusin=${onMouseEnter} @focusout=${onMouseLeave}>
				<div class="session-stats-inline">
					<button
						type="button"
						class="session-stats-ring ${refreshing ? "loading" : ""}"
						aria-label="查看上下文使用情况"
						aria-haspopup="dialog"
						aria-describedby=${hover ? "session-context-usage-tooltip" : nothing}
						@click=${onOpen}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<circle class="session-stats-ring-track" cx="12" cy="12" r=${ringRadius}></circle>
							<circle
								class="session-stats-ring-progress"
								cx="12"
								cy="12"
								r=${ringRadius}
								style=${`stroke-dasharray:${circumference};stroke-dashoffset:${strokeOffset};`}
							></circle>
						</svg>
						<span class="session-stats-label">上下文用量</span>
						<span class="session-stats-percent">${ratioPercent}</span>
					</button>
				</div>
				${hover
					? html`
						<div id="session-context-usage-tooltip" class="session-stats-popover" role="tooltip">
							<span>已用 <strong>${formatTokens(currentTokens)}</strong> / 共计 <strong>${formatTokens(contextWindow)}</strong> tokens</span>
						</div>
					`
					: nothing}
			</div>
		</div>
	`;
}
