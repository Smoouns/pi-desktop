import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Extra test perimeter only. The managed production extension is unmodified. */
export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const diagnostic = (globalThis as any)[Symbol.for("pi.e8.explicitToolNone")];
		if (!diagnostic) return;
		try { return diagnostic(event.payload); }
		catch (error) { ctx.abort(); throw error; } // SDK swallows handler throws; abort as well.
	});
	pi.on("tool_call", async event => {
		try { await (globalThis as any)[Symbol.for("pi.e8.toolGuard")](event); }
		catch { return { block: true, reason: "E8 test perimeter: tool or path not allowed" }; }
	});
}
