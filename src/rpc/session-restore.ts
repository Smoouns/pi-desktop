import {
	RpcRequestError,
	SessionFileMissingError,
	type RpcBridge,
	type RpcRequestOptions,
	type RpcStartOptions,
} from "./bridge.js";

export interface StartSessionTabResult {
	discovery: string;
	replacedMissingDraft: boolean;
}

/**
 * Start a cold runtime directly on its persisted session. A missing path is
 * replaced only for a proven empty ephemeral draft. Pi creates a fresh draft
 * during ordinary startup, so no second new_session mutation is necessary.
 */
export async function startSessionTab(
	bridge: Pick<RpcBridge, "start">,
	startOptions: RpcStartOptions,
	tab: { sessionPath: string | null; ephemeral: boolean; messageCount: number | null },
	assertCurrent: () => void = () => undefined,
): Promise<StartSessionTabResult> {
	const sessionPath = tab.sessionPath?.trim() || null;
	if (!sessionPath) {
		assertCurrent();
		const discovery = await bridge.start({ ...startOptions, sessionPath: undefined });
		assertCurrent();
		return { discovery, replacedMissingDraft: false };
	}

	try {
		const discovery = await bridge.start({ ...startOptions, sessionPath });
		assertCurrent();
		return { discovery, replacedMissingDraft: false };
	} catch (error) {
		if (!(error instanceof SessionFileMissingError) || !tab.ephemeral || tab.messageCount !== 0) throw error;

		// The error carries the ticket of the failed inspection. start() checks it
		// and advances the ticket synchronously, making the fallback conditional
		// on that exact attempt rather than on an identity sampled in this catch.
		if (error.runtimeTicket === null) {
			throw new RpcRequestError("cancelled", "rpc_start", "Missing draft recovery has no runtime scope");
		}
		assertCurrent();
		const discovery = await bridge.start({ ...startOptions, sessionPath: undefined }, error.runtimeTicket);
		assertCurrent();
		return { discovery, replacedMissingDraft: true };
	}
}

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
