import { html, nothing, render } from "lit";
import type { ContextItem } from "../novel/context.js";
import type { StoryMemory, StoryMemoryHit, StoryMemoryQuery, StoryMemorySearch } from "../novel/memory-engine.js";

const PIN_STORAGE_KEY = "pi-desktop.novel.pinned-context.v1";

export class ContextInspector {
	private readonly container: HTMLElement;
	private items: ContextItem[] = [];
	private estimatedTotal = 0;
	private projectPath: string | null = null;
	private removed = new Set<string>();
	private onChange: ((items: ContextItem[]) => void) | null = null;
	private available: Array<{ path: string; relativePath: string; authority: string }> = [];
	private manuallyAdded = new Set<string>();
	private workbenchOpen = false;
	private search = "";
	private mode: "documents" | "memory" = "documents";
	private memoryQuery = "";
	private throughChapter = "";
	private includePlanned = false;
	private memoryResult: StoryMemorySearch | null = null;
	private memorySelections = new Map<string, StoryMemoryHit>();
	private memoryBusy = false;
	private memoryError = "";
	private memoryVersion = 0;
	private onMemorySearch: ((project: string, query: StoryMemoryQuery) => Promise<StoryMemorySearch>) | null = null;
	private onOpenSource: ((path: string) => void) | null = null;

	constructor(container: HTMLElement) {
		this.container = container;
		this.render();
	}

	setOnChange(callback: (items: ContextItem[]) => void): void {
		this.onChange = callback;
	}

	setMemorySearch(callback: (project: string, query: StoryMemoryQuery) => Promise<StoryMemorySearch>): void { this.onMemorySearch = callback; }
	setOnOpenSource(callback: (path: string) => void): void { this.onOpenSource = callback; }
	getSelectedMemories(): StoryMemoryHit[] { return [...this.memorySelections.values()]; }

	retainMemorySelections(memories: StoryMemory[]): void {
		const current = new Map(memories.map((memory) => [memory.id, memory]));
		for (const [id, selected] of this.memorySelections) {
			const valid = current.get(id);
			if (valid) this.memorySelections.set(id, { ...selected, ...valid });
			else { this.memorySelections.delete(id); this.memoryError = "来源或验收状态已变化，已移除失效的记忆引用。请重新检索。"; }
		}
	}

	setProjectPath(path: string | null): void {
		if (this.projectPath === path) return;
		this.projectPath = path;
		this.items = [];
		this.estimatedTotal = 0;
		this.removed.clear();
		this.manuallyAdded.clear();
		this.available = [];
		this.memorySelections.clear();
		this.memoryResult = null;
		this.memoryQuery = "";
		this.throughChapter = "";
		this.includePlanned = false;
		this.memoryBusy = false;
		this.memoryError = "";
		this.memoryVersion++;
		this.render();
	}

	setItems(items: ContextItem[]): void {
		this.items = items.filter((item) => !this.removed.has(item.memory?.id ?? item.path));
		this.estimatedTotal = this.items.reduce((sum, item) => sum + item.estimatedTokens, 0);
		this.render();
	}

	setAvailableDocuments(documents: Array<{ path: string; relativePath: string; authority: string }>): void {
		this.available = documents;
		this.render();
	}

	getManuallyAddedPaths(): string[] {
		return [...this.manuallyAdded];
	}

	getItems(): ContextItem[] {
		return [...this.items];
	}

	getPinnedPaths(): string[] {
		try {
			const values = JSON.parse(localStorage.getItem(PIN_STORAGE_KEY) || "[]") as unknown;
			return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
		} catch {
			return [];
		}
	}

	private addForRequest(path: string): void {
		this.removed.delete(path);
		this.manuallyAdded.add(path);
		this.onChange?.(this.getItems());
		this.render();
	}

	private async searchMemory(): Promise<void> {
		if (!this.projectPath || !this.onMemorySearch || this.memoryBusy) return;
		const version = ++this.memoryVersion;
		this.memoryBusy = true;
		this.memoryError = "";
		this.memoryResult = null;
		this.render();
		try {
			const result = await this.onMemorySearch(this.projectPath, { query: this.memoryQuery, throughChapter: this.throughChapter.trim() ? Number(this.throughChapter) : undefined, includePlanned: this.includePlanned });
			if (version !== this.memoryVersion) return;
			this.memoryResult = result;
		} catch (error) { if (version === this.memoryVersion) this.memoryError = error instanceof Error ? error.message : String(error); }
		finally { if (version === this.memoryVersion) { this.memoryBusy = false; this.render(); } }
	}

	private addMemory(hit: StoryMemoryHit): void {
		if (hit.project !== this.projectPath?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()) return;
		if (this.memorySelections.size >= 8 || [...this.memorySelections.values()].reduce((sum, item) => sum + item.text.length, hit.text.length) > 16_000) {
			this.memoryError = "本次最多加入 8 条、共 16,000 字的记忆片段，请先移除不需要的引用。";
			this.render(); return;
		}
		this.removed.delete(hit.id);
		this.memorySelections.set(hit.id, hit);
		this.onChange?.(this.getItems());
		this.render();
	}

	private removeMemory(id: string): void {
		this.memorySelections.delete(id);
		this.removed.add(id);
		this.items = this.items.filter((item) => item.memory?.id !== id);
		this.estimatedTotal = this.items.reduce((sum, item) => sum + item.estimatedTokens, 0);
		this.onChange?.(this.getItems());
		this.render();
	}

	private memoryLabel(hit: StoryMemory): string {
		if (hit.temporal === "planned") return "未来规划";
		if (hit.kind === "accepted-prose") return "已验收，未晋升";
		if (hit.kind === "continuity") return "连续性记录";
		return hit.kind === "world" ? "正典设定" : "正典正文";
	}

	private renderMemory(hit: StoryMemoryHit, selected: boolean): unknown {
		return html`<article class="context-memory-item"><header><strong>${hit.heading}</strong><em>${this.memoryLabel(hit)}</em></header><button class="context-memory-source" title=${hit.path} @click=${() => this.onOpenSource?.(hit.path)}>${hit.path} · L${hit.startLine}–${hit.endLine}</button><p>${hit.text.slice(0, 200)}${hit.text.length > 200 ? "…" : ""}</p><details><summary>查看原文片段</summary><pre>${hit.text}</pre></details><div class="context-memory-meta"><span>${hit.reason}</span><span>~${hit.estimatedTokens} tokens</span></div><footer><span>${hit.layer} · ${hit.chapter === null ? "章节未标注" : `第 ${hit.chapter} 章`}</span>${selected ? html`<button @click=${() => this.removeMemory(hit.id)}>移除引用</button>` : html`<button ?disabled=${this.memorySelections.has(hit.id)} @click=${() => this.addMemory(hit)}>${this.memorySelections.has(hit.id) ? "已加入" : "加入本次请求"}</button>`}</footer></article>`;
	}

	private setPinned(path: string, pinned: boolean): void {
		let values: string[] = [];
		try {
			const parsed = JSON.parse(localStorage.getItem(PIN_STORAGE_KEY) || "[]") as unknown;
			if (Array.isArray(parsed)) values = parsed.filter((value): value is string => typeof value === "string");
		} catch {
			values = [];
		}
		values = values.filter((value) => value !== path);
		if (pinned) values.push(path);
		localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(values));
		this.items = this.items.map((item) => item.path === path ? { ...item, pinned } : item);
		this.render();
		this.onChange?.(this.getItems());
	}

	private removeForRequest(path: string): void {
		this.removed.add(path);
		this.manuallyAdded.delete(path);
		this.items = this.items.filter((item) => item.path !== path);
		this.estimatedTotal = this.items.reduce((sum, item) => sum + item.estimatedTokens, 0);
		this.render();
		this.onChange?.(this.getItems());
	}

	private closeWorkbench(): void {
		this.workbenchOpen = false;
		this.search = "";
		this.render();
	}

	render(): void {
		const hasProject = Boolean(this.projectPath);
		const normalizedSearch = this.search.trim().toLowerCase();
		const available = this.available.filter((doc) => !this.items.some((item) => item.path === doc.path) && !this.manuallyAdded.has(doc.path));
		const filteredAvailable = normalizedSearch ? available.filter((doc) => doc.relativePath.toLowerCase().includes(normalizedSearch)) : available;
		render(html`
			<section class="context-summary ${hasProject ? "" : "empty"}">
				<button class="context-summary-trigger" @click=${() => { this.workbenchOpen = true; this.render(); }} ?disabled=${!hasProject}>
					<span class="context-summary-leading"><span class="context-summary-icon">⌘</span><span><strong>上下文</strong><small>${hasProject ? `${this.items.length} 项资料引用已加入本次请求` : "打开项目后管理上下文"}</small></span></span>
					<span class="context-summary-total">~${this.estimatedTotal.toLocaleString()} tokens</span>
					<span class="context-summary-caret">›</span>
				</button>
			</section>
			${this.workbenchOpen ? html`
				<div class="context-workbench-backdrop" @click=${() => this.closeWorkbench()}>
					<section class="context-workbench" role="dialog" aria-modal="true" aria-label="上下文工作台" @click=${(event: Event) => event.stopPropagation()}>
						<header class="context-workbench-header">
							<div><h2>上下文工作台</h2><p>本次请求可按需读取的小说资料</p></div>
							<div class="context-workbench-header-actions"><span>~${this.estimatedTotal.toLocaleString()} tokens</span><button title="关闭上下文工作台" @click=${() => this.closeWorkbench()}>×</button></div>
						</header>
						<div class="context-workbench-toolbar">
							<nav class="context-memory-tabs" aria-label="资料类型"><button aria-pressed=${String(this.mode === "documents")} @click=${() => { this.mode = "documents"; this.render(); }}>文档</button><button aria-pressed=${String(this.mode === "memory")} @click=${() => { this.mode = "memory"; this.render(); }}>记忆检索</button></nav>
							${this.mode === "documents" ? html`<input aria-label="搜索可加入文档" placeholder="搜索可加入的文档" .value=${this.search} @input=${(event: Event) => { this.search = (event.target as HTMLInputElement).value; this.render(); }} />` : html`<form class="context-memory-search" @submit=${(event: Event) => { event.preventDefault(); void this.searchMemory(); }}><input aria-label="检索小说记忆" placeholder="人物、设定、已发生的事件…" maxlength="240" .value=${this.memoryQuery} @input=${(event: Event) => { this.memoryQuery = (event.target as HTMLInputElement).value; }}><button ?disabled=${this.memoryBusy}>${this.memoryBusy ? "检索中…" : "检索"}</button></form>`}
							<span>${this.items.length} 已加入 · ${available.length} 可选</span>
						</div>
						${this.mode === "memory" ? html`<div class="context-memory-options"><label>截至章节 <input aria-label="记忆截至章节" type="number" min="0" placeholder="不限" .value=${this.throughChapter} @input=${(event: Event) => { this.throughChapter = (event.target as HTMLInputElement).value; }}></label><label><input type="checkbox" .checked=${this.includePlanned} @change=${(event: Event) => { this.includePlanned = (event.target as HTMLInputElement).checked; }}> 包含未来规划</label><span>每次检索核对当前文件 · 设定不代表角色知情</span></div>` : nothing}
						${this.memoryError ? html`<p class="context-memory-error" role="alert">${this.memoryError}</p>` : nothing}
						<div class="context-workbench-columns">
							<section class="context-workbench-column included"><div class="context-workbench-column-header"><strong>已加入</strong><span>来源、理由与 token</span></div>
								<div class="context-workbench-list">
									${this.items.length === 0 ? html`<div class="context-workbench-empty">本次请求尚未选择上下文。</div>` : this.items.map((item) => html`
										${item.memory ? this.renderMemory(item.memory, true) : html`<article class="context-workbench-item"><div class="context-workbench-item-title"><span class="context-inspector-check">✓</span><span title=${item.path}>${item.relativePath}</span><em class=${item.authority}>${item.authority}</em></div><div class="context-workbench-item-meta"><span title=${item.reason}>${item.reason}</span><span>${item.readRequirement === "required" ? "必须读取" : "按需读取"}</span></div><div class="context-workbench-item-actions"><button @click=${() => this.setPinned(item.path, !item.pinned)}>${item.pinned ? "取消固定" : "固定"}</button><button class="danger" @click=${() => this.removeForRequest(item.path)}>移除</button></div></article>`}
									`)}</div>
							</section>
							<section class="context-workbench-column available"><div class="context-workbench-column-header"><strong>${this.mode === "memory" ? "检索结果" : "添加文档"}</strong><span>${this.mode === "memory" && this.memoryResult ? `${this.memoryResult.sourceCount} 个有效来源 · ${this.memoryResult.hits.length} 条结果` : "从当前项目中选择"}</span></div>
								<div class="context-workbench-list">
									${this.mode === "memory" ? html`${this.memoryResult?.warnings.map((warning) => html`<p class="context-memory-error">${warning}</p>`)}${this.memoryResult?.hits.length ? this.memoryResult.hits.map((hit) => this.renderMemory(hit, false)) : html`<div class="context-workbench-empty">${this.memoryBusy ? "正在核对来源并建立本地索引…" : this.memoryResult ? "没有匹配的有效记忆，可调整关键词或章节范围。" : "检索正典设定、已确认正文和连续性记录。"}</div>`}` : filteredAvailable.length === 0 ? html`<div class="context-workbench-empty">没有匹配的可选文档。</div>` : filteredAvailable.map((doc) => html`
										<button class="context-workbench-add-item" title=${doc.relativePath} @click=${() => this.addForRequest(doc.path)}><span>＋</span><span>${doc.relativePath}</span><em class=${doc.authority}>${doc.authority}</em></button>
									`)}</div>
							</section>
						</div>
					</section>
				</div>
			` : nothing}
		`, this.container);
	}
}
