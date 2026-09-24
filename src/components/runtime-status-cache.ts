/** Display-only snapshots owned by one live workspace/tab runtime.
 * Never replay dialogs, notifications, editor writes or RPC responses. */
export class RuntimeStatusCache {
	private entries = new Map<string, string>();

	clear(): void { this.entries.clear(); }

	observe(event: Record<string, unknown>): void {
		if (event.type !== "extension_ui_request" || !["setStatus", "set_status"].includes(String(event.method))) return;
		const key = typeof event.statusKey === "string" ? event.statusKey.trim() : "";
		// These are structured control messages, not the compact status display.
		if (["pi-desktop-session-title", "pi-desktop-context-budget"].includes(key) || key.length > 256) return;
		this.entries.delete(key);
		if (typeof event.statusText === "string" && event.statusText.trim() && event.statusText.length <= 16_384) {
			this.entries.set(key, event.statusText);
		}
		while (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!);
	}

	snapshot(): Array<{ statusKey: string; statusText: string }> {
		return [...this.entries].map(([statusKey, statusText]) => ({ statusKey, statusText }));
	}
}
