export type NovelAgentRole = "world" | "plan" | "write";
export type NovelAgentTaskKind = "world-discussion" | "world-change" | "world-revision" | "plan-chapter" | "write-chapter" | "review-card" | "review-manuscript";

export interface NovelAgentTask {
	role: NovelAgentRole;
	kind: NovelAgentTaskKind;
	chapter?: string;
	contextPaths: string[];
	feedback?: string;
	instruction?: string;
}

export const NOVEL_AGENT_LABELS: Record<NovelAgentRole, string> = {
	world: "世界观 Agent",
	plan: "规划 Agent",
	write: "写作 Agent",
};

const TASK_TEXT: Record<NovelAgentTaskKind, (chapter: string | undefined) => string> = {
	"world-discussion": () => "请先读取必要的项目资料，再开始本次世界观讨论或提案。",
	"world-change": () => "请读取世界观变更请求和目标 Canon 文件。只在 planning/world-proposals/ 中创建对应的提案：保留 change_id、target_path、target_fingerprint，status 必须是 PROPOSED_PENDING_USER_ACCEPTANCE，affected_paths 必须是 JSON 路径数组，并在 ## Proposed Canon Text 下用唯一的 markdown fenced block 给出完整替换正文。不得直接修改 Canon。",
	"world-revision": () => "请读取已有世界观变更提案、目标 Canon 和用户补充意见。只更新该提案中的完整替换正文、affected_paths 和必要说明；保留 change_id、target_path、target_fingerprint，并保持 status 为 PROPOSED_PENDING_USER_ACCEPTANCE。不得直接修改 Canon。",
	"plan-chapter": (chapter) => `请先将第 ${chapter ?? "?"} 章登记到 chapter-architecture.md，再建立或补全章节卡；两者共享字段必须一致。章节卡只能有一个 \`yaml\` fenced block，所有机器读取字段（包括 required_scenes）必须置于同一 YAML 文档中。修改已确认章节卡后，必须将 approval_status 设为 PROPOSED_PENDING_USER_ACCEPTANCE 并停下，等待用户重新确认。`,
	"write-chapter": (chapter) => `请确认第 ${chapter ?? "?"} 章已登记 chapter-architecture 且章节卡已获用户确认；满足后才生成候选正文，并同步写出本章 Continuity Proposal。`,
	"review-card": (chapter) => `请根据用户意见诊断第 ${chapter ?? "?"} 章章节卡，并生成针对性的 review 或返工交接。`,
	"review-manuscript": (chapter) => `请根据用户意见诊断第 ${chapter ?? "?"} 章候选正文，并生成针对性的 review 或返工交接。`,
};

export function buildNovelAgentPrompt(task: NovelAgentTask): string {
	const contextText = task.contextPaths.length > 0
		? task.contextPaths.map((path) => `- ${path}`).join("\n")
		: "- （没有找到可用的项目上下文，请先使用受限读取工具检查项目结构）";
	const feedback = task.feedback?.trim() ? `\n\n用户意见：\n${task.feedback.trim()}` : "";
	const instruction = task.instruction?.trim() ? `\n\n本次任务：\n${task.instruction.trim()}` : "";
	return `${TASK_TEXT[task.kind](task.chapter)}${instruction}${feedback}\n\n开始前请使用小说项目的受限读取工具读取以下项目内文件；这里只提供路径，不内联正文：\n${contextText}`;
}
