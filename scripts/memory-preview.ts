import "../src/styles/app.css";
import { ContextInspector } from "../src/components/context-inspector.js";
import { createNovelMemoryEngine, type MemoryIO } from "../src/novel/memory-engine.js";
import { createTauriMemoryIO } from "../src/novel/memory-io.js";
import { joinFsPath, type NovelProject } from "../src/novel/project.js";
import { applyWorldChange, parseWorldChangeProposal, requestWorldChange, rollbackWorldChange, loadWorldChangeHistory } from "../src/novel/world-change.js";
import { serializeNovelContextManifest } from "../src/novel/context.js";

const engine = createNovelMemoryEngine();
const native = new URLSearchParams(location.search).has("native");
const original = "# 城中秩序\n\n## 青石令\n青石令是守门人的凭证，只能开启城门，不能操纵人的心智。\n\n## 未来节点\n青石令将在第三章损毁，目前尚未发生。\n";
const sourcePath = "canon/world.md";
const files = new Map([[".novel/project.json", JSON.stringify({ formatVersion: 1, name: "隔离记忆测试" })], [sourcePath, original]]);
let root = "C:/memory-preview";
const inMemory: MemoryIO = {
	async read(path) { return files.get(path) ?? null; },
	async list(directory) {
		if (directory === "") return [{ name: "canon", isDirectory: true, isFile: false }];
		if (directory === "canon") return [{ name: "world.md", isDirectory: false, isFile: true }];
		return [];
	},
};
let io = inMemory;
const inspector = new ContextInspector(document.querySelector("#context-inspector-pane")!);
const report = (message: string) => { document.querySelector("#memory-test-status")!.textContent = message; };
const refresh = async () => {
	const snapshot = await engine.snapshot(root, io);
	inspector.retainMemorySelections(snapshot.memories);
	inspector.setItems(inspector.getSelectedMemories().map((hit) => ({ path: joinFsPath(root, hit.path), relativePath: hit.path, contentType: "memory", authority: hit.authority, reason: hit.reason, readRequirement: "required", estimatedTokens: hit.estimatedTokens, priority: 3, pinned: false, memory: hit })));
	const manifest = serializeNovelContextManifest(inspector.getItems());
	if (manifest.includes("只能开启城门")) throw new Error("FAIL: memory body leaked into prompt manifest");
	report(`就绪 · ${snapshot.sourceCount} 个来源 · ${snapshot.memories.length} 条片段 · 已选 ${inspector.getItems().length} 条引用${native ? ` · ${root}` : ""}`);
};
inspector.setMemorySearch(async (_project, query) => engine.search(await engine.snapshot(root, io), query));
inspector.setOnChange(() => void refresh().catch((error) => report(String(error))));
inspector.setOnOpenSource((path) => report(`来源：${path}`));
document.querySelector("#init-test")!.addEventListener("click", () => void (async () => {
	if (native) {
		const { tempDir } = await import("@tauri-apps/api/path");
		const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
		root = joinFsPath(await tempDir(), `pi-desktop-memory-native-${Date.now()}`);
		await mkdir(joinFsPath(root, ".novel"), { recursive: true });
		await mkdir(joinFsPath(root, "canon"), { recursive: true });
		for (const [path, text] of files) await writeTextFile(joinFsPath(root, path), text);
		io = createTauriMemoryIO(root);
	}
	inspector.setProjectPath(root);
	await refresh();
})().catch((error) => report(String(error))));
document.querySelector("#rollback-test")!.addEventListener("click", () => void (async () => {
	if (!native || io === inMemory) throw new Error("请先在原生测试窗口初始化隔离项目。");
	const { writeTextFile, readTextFile } = await import("@tauri-apps/plugin-fs");
	const project: NovelProject = { rootPath: root, configPath: joinFsPath(root, ".novel/project.json"), config: { formatVersion: 1 }, initialized: true };
	const before = await engine.snapshot(root, io);
	const oldId = engine.search(before, { query: "青石令" }).hits[0].id;
	const request = await requestWorldChange(project, sourcePath, "测试隔离副本中的凭证权限");
	const after = original.replace("只能开启城门", "可以开启城门与仓门");
	const proposalPath = `planning/world-proposals/${request.id}-proposal.md`;
	const text = `# 测试提案\nstatus: PROPOSED_PENDING_USER_ACCEPTANCE\nchange_id: ${request.id}\ntarget_path: ${sourcePath}\ntarget_fingerprint: ${request.targetFingerprint}\naffected_paths: []\n\n## Proposed Canon Text\n\n` + "```markdown\n" + after + "```\n";
	await writeTextFile(joinFsPath(root, proposalPath), text);
	const proposal = parseWorldChangeProposal({ path: joinFsPath(root, proposalPath), relativePath: proposalPath, text, name: "proposal.md", category: "planning", classification: { contentType: "planning", authority: "proposed", reason: "test" }, estimatedTokens: 1 }, project)!;
	const history = await applyWorldChange(project, proposal);
	const changed = await engine.snapshot(root, io);
	if (changed.memories.some((item) => item.id === oldId)) throw new Error("FAIL: old memory survived change");
	if (!engine.search(changed, { query: "仓门" }).hits.some((hit) => hit.text.includes("仓门"))) throw new Error("FAIL: new version not indexed");
	await rollbackWorldChange(project, history);
	if (await readTextFile(joinFsPath(root, sourcePath)) !== original) throw new Error("FAIL: Canon restore mismatch");
	if (!(await loadWorldChangeHistory(project)).some((entry) => entry.id === history.id && entry.rolledBackAt)) throw new Error("FAIL: rollback history missing");
	const restored = await engine.snapshot(root, createTauriMemoryIO(root));
	engine.read(restored, oldId);
	if (engine.search(restored, { query: "仓门" }).hits.length) throw new Error("FAIL: stale changed version remains");
	await refresh();
	report(`PASS · 原生 Tauri 合并、旧引用失效、回滚、重新读盘重建与历史校验通过 · ${root}`);
})().catch((error) => report(String(error))));
if (!native) { inspector.setProjectPath(root); void refresh(); }
