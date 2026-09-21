import { SessionFileMissingError, type RpcBridge, type RpcRequestOptions } from "./bridge.js";

/** Only a known empty, ephemeral tab may be recreated. Never rewrite history. */
export async function restoreSessionTab(
	bridge: Pick<RpcBridge, "switchSession" | "newSession">,
	tab: { sessionPath: string; ephemeral: boolean; messageCount: number | null },
	options: RpcRequestOptions = {},
): Promise<{ cancelled: boolean; replacedMissingDraft: boolean }> {
	try {
		const result = await bridge.switchSession(tab.sessionPath, options);
		return { ...result, replacedMissingDraft: false };
	} catch (error) {
		if (!(error instanceof SessionFileMissingError) || !tab.ephemeral || tab.messageCount !== 0) throw error;
		// Let Pi choose a matching ID and filename instead of opening a stale
		// explicit path. Use new_session even on a reused runtime, so another
		// conversation can never be mistaken for this empty draft.
		if (error.runtimeTicket === null) throw error;
		const result = await bridge.newSession(undefined, options, {
			ticket: error.runtimeTicket,
			generation: error.runtimeGeneration,
		});
		return { ...result, replacedMissingDraft: !result.cancelled };
	}
}
