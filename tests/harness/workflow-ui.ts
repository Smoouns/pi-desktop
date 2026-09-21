import assert from "node:assert/strict";
import { renderAssistantWorkflowView } from "../../src/components/chat-view/assistant-workflow-view.js";
import {
	getWorkflowThinkingPresentation,
	type AssistantWorkflow,
} from "../../src/components/chat-view/workflow-utils.js";
import type { RunCase } from "./testkit.js";

function templateText(value: unknown): string {
	if (value === null || value === undefined || value === false) return "";
	if (typeof value === "string" || typeof value === "number") return String(value);
	if (Array.isArray(value)) return value.map(templateText).join("");
	if (typeof value !== "object") return "";
	const candidate = value as { strings?: readonly string[]; values?: readonly unknown[] };
	if (!candidate.strings || !candidate.values) return "";
	return candidate.strings.map((part, index) => part + templateText(candidate.values?.[index])).join("");
}

function renderThinkingWorkflow(isStreaming: boolean): string {
	const workflow: AssistantWorkflow = {
		id: "workflow-test",
		messages: [{
			id: "assistant-thinking",
			role: "assistant",
			text: "",
			toolCalls: [],
			thinking: "Preserved reasoning content",
			isStreaming,
			isThinkingStreaming: true,
		}],
		toolCalls: [],
		toolGroups: [],
		thinkingText: "Preserved reasoning content",
		finalText: "",
		errorText: "",
		isStreaming,
		startedAt: 0,
		endedAt: 0,
		isTerminal: true,
	};
	return templateText(renderAssistantWorkflowView({
		workflow,
		resolveWorkflowExpansionState: () => ({ total: 0, running: 0, autoExpanded: true, expanded: true }),
		normalizeThinkingText: (value) => value.trim(),
		summarizeToolCall: () => "unused",
		renderToolPreview: () => { throw new Error("No tool preview expected"); },
		formatDuration: () => "0s",
		isWorkflowThinkingExpanded: () => true,
		toggleWorkflowThinkingExpanded: () => undefined,
		isToolGroupExpanded: () => false,
		toggleToolGroupExpanded: () => undefined,
		toggleToolWorkflowExpanded: () => undefined,
		clearCollapsedWorkflowState: () => undefined,
		piGlyphIcon: () => { throw new Error("Pi glyph should only render while streaming"); },
	}));
}

export async function runWorkflowUiCases(runCase: RunCase): Promise<void> {
	await runCase("UI-THINKING-01", () => {
		assert.deepEqual(getWorkflowThinkingPresentation(true, true), {
			animating: true,
			label: "正在思考…",
		});
		assert.deepEqual(getWorkflowThinkingPresentation(false, true), {
			animating: false,
			label: "思考过程",
		});
		assert.deepEqual(getWorkflowThinkingPresentation(true, false), {
			animating: false,
			label: "思考过程",
		});
		assert.deepEqual(getWorkflowThinkingPresentation(true, true, false), {
			animating: false,
			label: "思考过程",
		});

		const completed = renderThinkingWorkflow(false);
		assert.match(completed, /思考过程/);
		assert.doesNotMatch(completed, /正在思考…/);
		assert.match(completed, /Preserved reasoning content/);

		const streamingWorkflow: AssistantWorkflow = {
			id: "workflow-streaming",
			messages: [{
				id: "assistant-thinking-streaming",
				role: "assistant",
				text: "",
				toolCalls: [],
				thinking: "Streaming reasoning content",
				isStreaming: true,
				isThinkingStreaming: true,
			}],
			toolCalls: [], toolGroups: [], thinkingText: "Streaming reasoning content",
			finalText: "", errorText: "", isStreaming: true, startedAt: 0, endedAt: 0, isTerminal: true,
		};
		const streaming = templateText(renderAssistantWorkflowView({
			workflow: streamingWorkflow,
			resolveWorkflowExpansionState: () => ({ total: 0, running: 0, autoExpanded: true, expanded: true }),
			normalizeThinkingText: (value) => value.trim(), summarizeToolCall: () => "unused",
			renderToolPreview: () => { throw new Error("No tool preview expected"); }, formatDuration: () => "0s",
			isWorkflowThinkingExpanded: () => true, toggleWorkflowThinkingExpanded: () => undefined,
			isToolGroupExpanded: () => false, toggleToolGroupExpanded: () => undefined,
			toggleToolWorkflowExpanded: () => undefined, clearCollapsedWorkflowState: () => undefined,
			piGlyphIcon: () => ({ strings: ["pi"], values: [] } as never),
		}));
		assert.match(streaming, /正在思考…/);
		assert.match(streaming, /Streaming reasoning content/);
	});
}
