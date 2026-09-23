import type { ExpectedTaskArtifact, TaskBinding } from "../harness/task-contract.js";

export type NovelAgentRole = "world" | "plan" | "write";
export type NovelAgentTaskKind = "world-discussion" | "world-change" | "world-revision" | "plan-chapter" | "write-chapter" | "verify-chapter" | "review-card" | "review-manuscript";

export interface NovelAgentTask {
	role: NovelAgentRole;
	kind: NovelAgentTaskKind;
	chapter?: string;
	contextPaths: string[];
	feedback?: string;
	instruction?: string;
	expectedArtifacts?: ExpectedTaskArtifact[];
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
	"verify-chapter": (chapter) => `请检查第 ${chapter ?? "?"} 章当前候选正文，按需修订后调用 verify_chapter 完整验证；不需要为已满足的前置文件重复制造写入。`,
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

/** Determine deliverables from workflow selection and card fields, not LLM prose. */
export function buildNovelTaskBinding(task: NovelAgentTask, documents: Array<{ relativePath: string; text?: string }>, taskId: string): TaskBinding | null {
	const base = { version: 1 as const, taskId, role: task.role };
	if (task.kind === "world-discussion") return { ...base, completionMode: "reply_only", expectedArtifacts: [] };
	if (task.expectedArtifacts?.length) return { ...base, completionMode: "candidate_write", expectedArtifacts: task.expectedArtifacts };
	if (!task.chapter || !/^\d{1,6}$/.test(task.chapter)) return null;
	const chapter = task.chapter, card = `planning/chapter-cards/${chapter}.md`;
	const plain = (path: string): ExpectedTaskArtifact => ({ path, verification: "none" });
	if (task.role === "plan") {
		const architecture = documents.find((item) => /^(?:plan|planning)\/chapter-architecture\.md$/.test(item.relativePath))?.relativePath ?? "planning/chapter-architecture.md";
		const expectedArtifacts = task.kind === "review-manuscript" ? [plain(`planning/reviews/${chapter}-review.md`)] : [{ path: architecture, verification: "present" as const }, plain(card)];
		return { ...base, completionMode: "candidate_write", expectedArtifacts };
	}
	if (task.role !== "write") return null;
	const source = documents.find((item) => item.relativePath === card)?.text ?? "";
	const blocks = [...source.matchAll(/^```(?:yaml|yml)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
	const fields = blocks.length === 1 ? [...blocks[0][1].matchAll(/^file:[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^#\r\n]+))[ \t]*(?:#.*)?$/gm)] : [];
	if (fields.length !== 1) throw new Error("章节卡必须有唯一的 YAML file 字段，才能绑定写作交付目标；请先由规划 Agent 修复。");
	const target = (fields[0][1] ?? fields[0][2] ?? fields[0][3]).trim();
	if (!target.startsWith("drafts/candidates/") || target.split("/").some((part) => part === ".." || part === ".") || /[\\<>:"|?*]/.test(target)) throw new Error("章节卡 file 必须指向 drafts/candidates/ 内的明确文件。");
	if (task.kind === "verify-chapter") return { ...base, completionMode: "candidate_write", expectedArtifacts: [{ path: target, verification: "chapter-full", chapter }] };
	const proposals = documents.filter((item) => item.relativePath.includes("/continuity-proposals/") && new RegExp(`(?:^|/)0*${Number(chapter)}(?:[-.]|$)`).test(item.relativePath));
	if (proposals.length > 1) throw new Error("本章存在多个连续性提案，请先明确需要更新哪一个文件。");
	return { ...base, completionMode: "candidate_write", expectedArtifacts: [
		{ path: target, verification: "chapter-full", chapter },
		plain(proposals[0]?.relativePath ?? `planning/continuity-proposals/${chapter}-proposal.md`),
	] };
}
