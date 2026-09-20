/**
 * Chinese presentation layer for Desktop-owned UI chrome.
 *
 * It deliberately leaves project files, code blocks, model identifiers and chat
 * messages untouched. The runtime and extension APIs still exchange their
 * original English identifiers; only the visible Desktop vocabulary is mapped.
 */

const replacements: ReadonlyArray<readonly [string, string]> = [
	["Search commands, skills, templates…", "搜索命令、技能与模板…"],
	["Search commands, files, and sessions", "搜索命令、文件与会话"],
	["Search name, folder, or path...", "搜索名称、文件夹或路径…"],
	["Search branches or type a new name", "搜索分支或输入新名称"],
	["Search user messages", "搜索用户消息"],
	["Search tree entries", "搜索树状条目"],
	["Search packages", "搜索扩展包"],
	["Search models...", "搜索模型…"],
	["Search models", "搜索模型"],
	["Search emojis", "搜索表情"],
	["Select a file to start editing", "选择文件后开始编辑"],
	["Choose a document from the Explorer or create a new tab.", "从资源管理器选择文档，或新建一个标签页。"],
	["Describe the next change — type / for commands", "描述下一步要做什么；输入 / 查看命令"],
	["Session not ready…", "会话尚未就绪…"],
	["Starting pi agent…", "正在启动 Pi 智能体…"],
	["Ready when you are", "准备好了就开始吧"],
	["Your move when you’re back", "等你回来继续"],
	["Come back when you want, I’m here", "想继续时，我就在这里"],
	["I’m waiting for you", "我在这里等你"],
	["Add project", "添加项目"],
	["Add new project", "添加项目"],
	["Refreshing local Pi inventory…", "正在刷新本地 Pi 资源…"],
	["Pi is working", "Pi 正在工作"],
	["Task finished", "任务已完成"],
	["Run ended with an error", "任务因错误结束"],
	["Agent finished its current task.", "智能体已完成当前任务。"],
	["Agent run ended with an error.", "智能体运行时发生错误。"],

	["Settings", "设置"],
	["Choose a section", "选择一个分类"],
	["Assistant behavior, model scope, and queue defaults.", "智能体行为、模型范围与队列默认项。"],
	["Theme mode and desktop appearance profiles.", "主题模式与桌面外观配置。"],
	["Provider auth status and package config notes.", "提供方认证状态与扩展包配置说明。"],
	["Desktop releases, CLI version, and runtime diagnostics.", "桌面端版本、CLI 版本与运行时诊断。"],
	["General", "通用"],
	["Appearance", "外观"],
	["Account", "账户"],
	["Updates", "更新"],
	["Assistant", "智能体"],
	["Message queue", "消息队列"],
	["Theme", "主题"],
	["Light", "浅色"],
	["Dark", "深色"],
	["System", "跟随系统"],
	["Light theme", "浅色主题"],
	["Dark theme", "深色主题"],
	["Create theme", "创建主题"],
	["Create a new theme", "创建新主题"],
	["Theme name", "主题名称"],
	["Save theme", "保存主题"],
	["Cancel", "取消"],
	["Accent", "强调色"],
	["Background", "背景"],
	["Foreground", "前景色"],
	["UI font", "界面字体"],
	["Code font", "代码字体"],
	["Translucent sidebar", "半透明侧边栏"],
	["Contrast", "对比度"],
	["Scoped models", "可轮换模型"],
	["Enable all", "全部启用"],
	["Clear all", "全部清除"],
	["Save scoped models", "保存可轮换模型"],
	["Enable provider", "启用提供方"],
	["Disable provider", "禁用提供方"],
	["(unsaved)", "（未保存）"],
	["Enabled:", "已启用："],
	["enabled", "已启用"],
	["Settings file:", "设置文件："],
	["Unresolved saved patterns:", "无法解析的已保存模式："],
	["No models available for scoped configuration.", "没有可用于配置的模型。"],
	["Loading available models…", "正在加载可用模型…"],
	["Choose which models are included when cycling models with Ctrl+P. This matches CLI", "选择按 Ctrl+P 切换时可参与轮换的模型；此行为与 CLI 的"],
	["behavior.", "行为一致。"],
	["Use light, dark, or match your system.", "选择浅色、深色，或跟随系统。"],
	["Choose light, dark, or system mode.", "选择浅色、深色或跟随系统。"],
	["Loading available Pi themes…", "正在加载可用 Pi 主题…"],
	["Theme catalog error:", "主题目录错误："],
	["Create a new theme from current adjustments", "根据当前调整创建新主题"],
	["Adjust colors, fonts, contrast, or translucency first", "请先调整颜色、字体、对比度或透明度"],

	["Desktop updates", "桌面端更新"],
	["CLI updates", "CLI 更新"],
	["Refresh diagnostics", "刷新诊断"],
	["Refresh desktop status", "刷新桌面端状态"],
	["Download desktop update", "下载桌面端更新"],
	["Open release page", "打开发布页"],
	["Refresh CLI status", "刷新 CLI 状态"],
	["Update CLI now", "立即更新 CLI"],
	["Run RPC compatibility check", "运行 RPC 兼容性检查"],
	["Advanced details", "高级信息"],
	["Advanced CLI diagnostics", "高级 CLI 诊断"],
	["CLI binary path override (optional)", "CLI 可执行文件路径覆盖（可选）"],
	["Save path override", "保存路径覆盖"],
	["Clear override", "清除覆盖"],
	["Browse…", "浏览…"],
	["Checking account diagnostics…", "正在检查账户诊断信息…"],
	["Checking desktop release…", "正在检查桌面端版本…"],
	["Checking CLI version…", "正在检查 CLI 版本…"],
	["A newer Pi Desktop release is available.", "有可用的新版 Pi Desktop。"],
	["No desktop update available right now.", "当前没有可用的桌面端更新。"],
	["A newer Pi CLI is available.", "有可用的新版 Pi CLI。"],
	["No update available right now.", "当前没有可用更新。"],
	["CLI status unavailable. Install or reconnect CLI, then refresh.", "无法获取 CLI 状态。请安装或重新连接 CLI 后刷新。"],
	["Desktop update status unavailable. Check your network and try again.", "无法获取桌面端更新状态。请检查网络后重试。"],
	["Current account diagnostics", "当前账户诊断"],
	["Account (work in progress)", "账户（开发中）"],
	["No provider credentials detected.", "未检测到提供方凭据。"],
	["Connected providers detected:", "已检测到的提供方数量："],
	["Open a project to enable CLI runtime diagnostics.", "打开项目后可使用 CLI 运行时诊断。"],
	["Unable to render settings right now.", "当前无法显示设置。"],

	["Explorer", "资源管理器"],
	["Sessions", "会话"],
	["Files", "文件"],
	["Novel", "小说"],
	["Packages", "扩展包"],
	["Open settings", "打开设置"],
	["CLI update available", "检测到 CLI 更新"],
	["Desktop update available", "检测到桌面端更新"],
	["Return to workspace", "返回工作台"],
	["Switch workspace", "切换工作区"],
	["Create workspace", "新建工作区"],
	["New workspace", "新建工作区"],
	["Rename workspace", "重命名工作区"],
	["Delete workspace", "删除工作区"],
	["Collapse sidebar", "收起侧边栏"],
	["Expand sidebar", "展开侧边栏"],
	["Change workspace emoji", "更改工作区表情"],
	["Change emoji", "更改表情"],
	["Create a Space", "创建工作区"],
	["Create Space", "创建工作区"],
	["Create space", "创建工作区"],
	["Space Name", "工作区名称"],
	["Choose emoji", "选择表情"],
	["No emojis found", "未找到表情"],
	["No projects yet. Open a folder to get started.", "尚未打开项目。请先打开一个文件夹。"],
	["Open a project to browse novel files.", "打开项目后浏览小说文件。"],
	["Loading novel project…", "正在加载小说项目…"],
	["Could not read novel project.", "无法读取小说项目。"],
	["is not initialized", "尚未初始化"],
	["Initialize as Novel Project", "初始化为小说项目"],
	["Create only missing novel folders and metadata. Existing files stay untouched.", "只创建缺失的小说目录和元数据，不会修改现有文件。"],
	["Accept proposal", "接受提案"],
	["Promote to Canon", "提升为正典"],
	["No documents", "没有文档"],
	["Manuscript / Chapters", "正文 / 章节"],
	["Drafts & History", "草稿与历史"],
	["Planning", "规划"],
	["Canon", "正典"],
	["Craft", "写作技法"],
	["Notes", "笔记"],
	["Memory", "记忆"],
	["Loading…", "正在加载…"],
	["Loading sessions…", "正在加载会话…"],
	["Loading files…", "正在加载文件…"],
	["Refreshing…", "正在刷新…"],
	["Empty", "空"],
	["Empty project folder.", "项目文件夹为空。"],
	["Cannot read folder", "无法读取文件夹"],
	["Could not read files.", "无法读取文件。"],
	["No files match this filter.", "没有符合筛选条件的文件。"],
	["No sessions yet.", "暂时没有会话。"],
	["No relevant sessions yet.", "暂时没有相关会话。"],
	["No sessions match your filter.", "没有符合筛选条件的会话。"],
	["No projects match current filters.", "没有符合当前筛选条件的项目。"],
	["New session", "新建会话"],
	["New file", "新建文件"],
	["Rename session", "重命名会话"],
	["Delete session", "删除会话"],
	["Rename project", "重命名项目"],
	["Remove project", "移除项目"],
	["Relink folder", "重新关联文件夹"],
	["Project actions", "项目操作"],
	["Session running", "会话正在运行"],
	["Organize sessions", "整理会话"],
	["Filter files", "筛选文件"],
	["Refresh novel files", "刷新小说文件"],
	["Organize", "整理方式"],
	["By project", "按项目"],
	["Chronological list", "按时间顺序"],
	["Sort by", "排序方式"],
	["Created", "创建时间"],
	["Updated", "更新时间"],
	["Show", "显示"],
	["All threads", "全部会话"],
	["Relevant", "相关会话"],
	["Sort files", "文件排序"],
	["All", "全部"],
	["Folders", "文件夹"],
	["Collapse", "收起"],
	["Expand", "展开"],

	["Context", "上下文"],
	["Why this project context is included", "本次请求为何包含这些项目上下文"],
	["documents included for this request", "个文档已加入本次请求"],
	["Open a project to inspect context.", "打开项目后查看上下文。"],
	["No context selected for this request.", "本次请求尚未选择上下文。"],
	["Add document to this request", "将文档加入本次请求"],
	["Pin context", "固定上下文"],
	["Unpin context", "取消固定"],
	["Remove from this request", "从本次请求移除"],
	["Remove", "移除"],
	["Pin", "固定"],
	["Unpin", "取消固定"],

	["New file", "新建文件"],
	["Write file content…", "编写文件内容…"],
	["Create file", "创建文件"],
	["Loading file…", "正在加载文件…"],
	["Saving…", "正在保存…"],
	["Close file panel", "关闭文件面板"],
	["Close tab", "关闭标签页"],
	["New tab", "新建标签页"],
	["Rename tab", "重命名标签页"],
	["Tab color", "标签页颜色"],
	["Default", "默认"],
	["Open terminal", "打开终端"],
	["Resize sidebar", "调整侧边栏宽度"],
	["Toggle sidebar", "切换侧边栏"],
	["Resize file panel", "调整文件面板宽度"],

	["Keyboard shortcuts", "键盘快捷键"],
	["New session", "新建会话"],
	["Open sessions browser", "打开会话浏览器"],
	["Open session history viewer", "打开会话历史"],
	["Open command palette", "打开命令面板"],
	["Open command palette (when editor not focused)", "打开命令面板（编辑器未聚焦时）"],
	["Open settings", "打开设置"],
	["Open this shortcuts panel", "打开快捷键面板"],
	["Navigation", "导航"],
	["Input", "输入"],
	["Model", "模型"],
	["Display", "显示"],
	["Utility", "工具"],
	["Agent", "智能体"],
	["No command matches your query.", "没有匹配的命令。"],
	["run", "执行"],
	["close", "关闭"],
	["Clear terminal", "清空终端"],
	["Clear", "清空"],
	["Close terminal", "关闭终端"],
	["Resize terminal", "调整终端高度"],
	["Back", "返回"],
	["Close", "关闭"],
	["Refresh", "刷新"],
	["Fork current session", "从当前会话分支"],
	["Loading fork points...", "正在加载分支点…"],
	["No fork points found.", "未找到可分支的位置。"],
	["Loading sessions...", "正在加载会话…"],
	["No sessions found.", "未找到会话。"],
	["fork here", "从此处分支"],

	["Loading models...", "正在加载模型…"],
	["No models found", "未找到模型"],
	["(current)", "（当前）"],
	["thinking", "推理"],
	["vision", "视觉"],
	["Available models", "可用模型"],
	["No models", "没有模型"],
	["Stop generation", "停止生成"],
	["Sending", "正在发送"],
	["Send (Enter) · Queue while streaming (Alt+Enter)", "发送（Enter）· 生成时加入队列（Alt+Enter）"],
	["Attach file", "附加文件"],
	["Copy message", "复制消息"],
	["Resend message", "重新发送消息"],
	["Jump to latest", "跳至最新消息"],
	["Toggle thinking", "切换推理过程"],
	["Thinking…", "正在思考…"],
	["Queued", "已排队"],
	["Remove image", "移除图片"],
	["Remove file reference", "移除文件引用"],
	["Remove skill", "移除技能"],
	["Loading commands…", "正在加载命令…"],
	["No commands match", "没有匹配的命令"],

	["Installed", "已安装"],
	["Recommended", "推荐"],
	["Install", "安装"],
	["Open folder", "打开文件夹"],
	["Open page", "打开页面"],
	["Try in chat", "在对话中试用"],
	["Removing…", "正在移除…"],
	["Uninstall skill", "卸载技能"],
	["Loading packages…", "正在加载扩展包…"],
	["Loading installed items…", "正在加载已安装项目…"],
	["No packages installed yet.", "尚未安装扩展包。"],
	["Loading results…", "正在加载结果…"],
	["Config error:", "配置错误："],
	["Resource error:", "资源错误："],
	["Catalog error:", "目录错误："],
	["Package settings", "扩展包设置"],
	["Extension settings", "扩展设置"],
	["Model lookup failed:", "模型查询失败："],
	["Use package default", "使用扩展包默认值"],
	["Resource type", "资源类型"],
	["Destination", "目标位置"],
	["What should this resource do?", "此资源应完成什么工作？"],
	["Prompt template", "提示词模板"],
	["Skill", "技能"],
	["Description", "描述"],
	["Content", "内容"],
	["Name", "名称"],
	["Type", "类型"],
	["Save to", "保存到"],
	["Global", "全局"],
	["Project", "项目"],
	["Select project…", "选择项目…"],
	["Enabled", "已启用"],
	["On", "开"],
	["Off", "关"],
];

const orderedReplacements = [...replacements].sort(([left], [right]) => right.length - left.length);

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const protectedSelector = [
	"pre",
	"code",
	".markdown",
	".bubble-text",
	".message-content",
	".assistant-message",
	".tool-workflow",
	".history-tree-line",
	".history-message-preview",
	".file-viewer-editor",
	"textarea",
].join(", ");

export function translateChineseUiText(value: string): string {
	let translated = value;
	for (const [english, chinese] of orderedReplacements) {
		const isWord = /^[A-Za-z]+$/.test(english);
		const pattern = isWord
			? new RegExp(`\\b${escapeRegExp(english)}\\b`, "g")
			: new RegExp(escapeRegExp(english), "g");
		translated = translated.replace(pattern, chinese);
	}
	return translated;
}

function isProtected(element: Element | null): boolean {
	return Boolean(element?.closest(protectedSelector));
}

function localizeTextNode(node: Text): void {
	if (isProtected(node.parentElement)) return;
	const translated = translateChineseUiText(node.data);
	if (translated !== node.data) node.data = translated;
}

function localizeElement(element: Element): void {
	if (isProtected(element)) return;
	for (const name of ["title", "placeholder", "aria-label", "alt"]) {
		const current = element.getAttribute(name);
		if (!current) continue;
		const translated = translateChineseUiText(current);
		if (translated !== current) element.setAttribute(name, translated);
	}
}

function localizeTree(root: Node): void {
	if (root.nodeType === Node.TEXT_NODE) {
		localizeTextNode(root as Text);
		return;
	}
	if (!(root instanceof Element) && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
	if (root instanceof Element && isProtected(root)) return;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
	let current: Node | null = walker.currentNode;
	while (current) {
		if (current.nodeType === Node.ELEMENT_NODE) localizeElement(current as Element);
		else if (current.nodeType === Node.TEXT_NODE) localizeTextNode(current as Text);
		current = walker.nextNode();
	}
}

let installed = false;

export function installChineseUiLocalization(): void {
	if (installed) return;
	installed = true;
	localizeTree(document.body);
	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type === "characterData") {
				localizeTextNode(mutation.target as Text);
				continue;
			}
			if (mutation.type === "attributes" && mutation.target instanceof Element) {
				localizeElement(mutation.target);
				continue;
			}
			for (const node of mutation.addedNodes) localizeTree(node);
		}
	});
	observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder", "aria-label", "alt"] });
}
