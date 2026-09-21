import { html, nothing, type TemplateResult } from "lit";

export interface ExtensionStatusView {
	key: string;
	text: string;
	onOpen: () => void;
}

/** Keep full diagnostics out of the composer; the detail dialog retains them. */
export function extensionStatusSummary(status: ExtensionStatusView): string {
	const firstLine = status.text.split(/\r?\n/, 1)[0].trim();
	const label = status.key === "novel-supervisor" ? firstLine.split(/[（(。]/, 1)[0].trim() : firstLine;
	return (label || "运行状态已更新").slice(0, 80);
}

export function renderExtensionStatusView(status: ExtensionStatusView | null): TemplateResult | typeof nothing {
	if (!status) return nothing;
	return html`
		<div class="chat-extension-status" role="status" aria-live="polite">
			<span class="chat-extension-status-label">${extensionStatusSummary(status)}</span>
			<button type="button" class="chat-extension-status-details" aria-label="查看完整状态详情" @click=${status.onOpen}>详情</button>
		</div>
	`;
}
