/** Manual browser harness. No Tauri calls and no filesystem writes. */
import "../src/styles/app.css";
import { WorldChangeDialog, type WorldChangeDialogData } from "../src/components/world-change-dialog.js";
import { canRollbackWorldChange, type NovelWorldChangeHistoryEntry } from "../src/novel/world-change.js";
import { classifyNovelDocument } from "../src/novel/project.js";

const targetPath = "canon/world/01-江湖格局与公开秩序.md";
const before = "# 江湖格局\n\n## 公开秩序\n城内禁止公开私斗。\n\n## 保留边界\n" + "城外的争端仍由地方势力自行调解。\n".repeat(20);
const after = before.replace("城内禁止公开私斗。", "城内禁止公开私斗；双方可在执事见证下于指定场所比武。");
const fingerprint = (text: string) => {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
	return `${text.length}:${(hash >>> 0).toString(16)}`;
};
const mode = new URLSearchParams(location.search).get("mode");
const history: NovelWorldChangeHistoryEntry = {
	version: 1, id: "world-change-preview", createdAt: "2026-09-03T08:00:00.000Z", targetPath,
	before, after, beforeFingerprint: fingerprint(before), afterFingerprint: fingerprint(after),
	proposalPath: "planning/world-proposals/world-change-preview-proposal.md",
	affectedPaths: ["planning/chapter-cards/001.md"],
};
const data: WorldChangeDialogData = {
	canonDocuments: mode === "missing" ? [] : [{ path: `C:/preview/${targetPath}`, relativePath: targetPath, name: "01-江湖格局与公开秩序.md", category: "canon", classification: classifyNovelDocument(targetPath, { formatVersion: 1 }), estimatedTokens: 100, text: mode === "conflict" ? after + "作者的后续编辑。\n" : after }],
	histories: mode === "empty" ? [] : [history],
	proposals: mode === "pending" ? [{ version: 1, id: "next-change", targetPath, proposalPath: "planning/world-proposals/next-change-proposal.md", targetFingerprint: history.afterFingerprint, proposedText: after + "\n## 新增边界\n不得越权追捕。\n", affectedPaths: [], createdAt: null }] : [],
};
const dialog = new WorldChangeDialog(document.querySelector("#world-change-dialog-pane")!);
const report = (action: string) => { document.querySelector("#actions")!.textContent = action; };
const open = () => dialog.open({
	projectName: "昼殇江湖 · 虚拟测试", ...structuredClone(data),
	onReload: async () => structuredClone(data),
	onRollback: async (entry) => {
		const guard = canRollbackWorldChange(entry, data.histories, data.canonDocuments[0]?.text ?? null);
		if (!guard.allowed) throw new Error(guard.reason);
		data.histories[0].rolledBackAt = new Date().toISOString();
		data.canonDocuments[0].text = entry.before;
		report("回滚完成，保留历史");
	},
	onRequest: () => report("已创建虚拟请求"),
	onApply: () => report("已合并虚拟提案"),
	onRevise: () => report("已预填虚拟返工"),
	onOpenFile: (path) => report(`查看文件：${path}`),
});
document.querySelector("#reopen")!.addEventListener("click", open);
open();
