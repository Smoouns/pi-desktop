import { rpcBridge, type RpcImageInput, type RpcSessionState } from "../../rpc/bridge.js";
import type { TaskBinding } from "../../harness/task-contract.js";
import { createTaskSubmission } from "../../novel/task-submission.js";

type NoticeKind = "info" | "success" | "error";

type DeliveryMode = "prompt" | "steer" | "followUp";

interface SendMessageFlowParams<ImageItem> {
	mode: DeliveryMode;
	bindingStatusText: string | null;
	isComposerInteractionLocked: () => boolean;
	inputText: string;
	displayInputText?: string;
	selectedSkillCommandText: string;
	pendingImages: ImageItem[];
	slashQueryFromInput: () => string | null;
	executeSlashCommandFromComposer: () => Promise<void>;
	rememberComposerHistoryEntry: (text: string) => void;
	currentIsStreaming: () => boolean;
	applyBackendState: (state: RpcSessionState) => void;
	clearStreamingUiState: () => void;
	render: () => void;
	enqueueComposerQueueMessage: (text: string, images: ImageItem[]) => string;
	pushNotice: (text: string, kind: NoticeKind) => void;
	pushUserEcho: (text: string, mode: DeliveryMode, images: ImageItem[]) => void;
	clearComposer: () => void;
	setSendingPrompt: (value: boolean) => void;
	toRpcImages: (images: ImageItem[]) => RpcImageInput[];
	removeComposerQueueMessage: (id: string) => void;
	onPromptSubmitted?: () => void;
	taskBinding?: TaskBinding | null;
}

export async function sendMessageFlow<ImageItem>({
	mode,
	bindingStatusText,
	isComposerInteractionLocked,
	inputText,
	displayInputText,
	selectedSkillCommandText,
	pendingImages,
	slashQueryFromInput,
	executeSlashCommandFromComposer,
	rememberComposerHistoryEntry,
	currentIsStreaming,
	applyBackendState,
	clearStreamingUiState,
	render,
	enqueueComposerQueueMessage,
	pushNotice,
	pushUserEcho,
	clearComposer,
	setSendingPrompt,
	toRpcImages,
	removeComposerQueueMessage,
	onPromptSubmitted,
	taskBinding,
}: SendMessageFlowParams<ImageItem>): Promise<void> {
	if (isComposerInteractionLocked()) {
		pushNotice(bindingStatusText || "Session is still loading. Try again in a moment.", "info");
		return;
	}
	const promptText = inputText.trim();
	const selectedSkillCommand = selectedSkillCommandText.trim();
	const text = selectedSkillCommand ? (promptText ? `${selectedSkillCommand}\n\n${promptText}` : selectedSkillCommand) : promptText;
	const displayPromptText = (displayInputText ?? inputText).trim();
	const displayText = selectedSkillCommand ? (displayPromptText ? `${selectedSkillCommand}\n\n${displayPromptText}` : selectedSkillCommand) : displayPromptText;
	const images = [...pendingImages];
	// A slash command is an explicit composer action even when a skill draft is
	// staged. Execute it first and keep the staged skill for the next prompt.
	if (images.length === 0 && slashQueryFromInput() !== null) {
		await executeSlashCommandFromComposer();
		return;
	}
	if (!text && images.length === 0) return;
	if (displayText) rememberComposerHistoryEntry(displayText);

	let streaming = currentIsStreaming();
	if (streaming) {
		try {
			const backendState = await rpcBridge.getState();
			const backendStreaming = Boolean(backendState.isStreaming);
			applyBackendState(backendState);
			if (!backendStreaming) {
				streaming = false;
				clearStreamingUiState();
				render();
			}
		} catch {
			// ignore pre-flight run-state check failures
		}
	}

	let actualMode: DeliveryMode = mode;
	if (!streaming) {
		actualMode = "prompt";
	}
	if (taskBinding && streaming) {
		pushNotice("请等当前运行结束后再发送新的交付任务；输入已保留。", "info");
		return;
	}

	let queuedMessageId: string | null = null;
	if (actualMode === "followUp") {
		queuedMessageId = enqueueComposerQueueMessage(displayText, images);
		pushNotice("Queued message", "info");
	} else {
		pushUserEcho(displayText, actualMode, images);
	}
	clearComposer();
	setSendingPrompt(true);
	render();

	try {
		const rpcImages = toRpcImages(images);
		if (actualMode === "prompt") {
			await rpcBridge.prompt(taskBinding ? createTaskSubmission().encode(text, taskBinding) : text, { images: rpcImages });
		} else if (actualMode === "steer") {
			await rpcBridge.steer(text, rpcImages);
		} else {
			await rpcBridge.followUp(text, rpcImages);
			void rpcBridge
				.getState()
				.then((state) => {
					applyBackendState(state);
					render();
				})
				.catch(() => {
					/* ignore */
				});
		}
		onPromptSubmitted?.();
	} catch (err) {
		if (queuedMessageId) {
			removeComposerQueueMessage(queuedMessageId);
		}
		console.error("Failed to send message:", err);
		pushNotice(err instanceof Error ? err.message : "Failed to send message", "error");
	} finally {
		setSendingPrompt(false);
		render();
	}
}
