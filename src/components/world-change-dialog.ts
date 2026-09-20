import { html, nothing, render } from "lit";
import { canRollbackWorldChange, type NovelDocument, type NovelWorldChangeHistoryEntry, type NovelWorldChangeProposal } from "../novel/index.js";

export interface WorldChangeDialogData {
	canonDocuments: NovelDocument[];
	proposals: NovelWorldChangeProposal[];
	histories: NovelWorldChangeHistoryEntry[];
}

export interface WorldChangeDialogRequest extends WorldChangeDialogData {
	projectName: string;
	onRequest: (targetPath: string, feedback: string) => Promise<void> | void;
	onApply: (proposal: NovelWorldChangeProposal) => Promise<void> | void;
	onRevise: (proposal: NovelWorldChangeProposal, feedback: string) => Promise<void> | void;
	onOpenFile: (path: string) => void;
	onReload: () => Promise<WorldChangeDialogData>;
	onRollback: (entry: NovelWorldChangeHistoryEntry) => Promise<void>;
}

/** User-owned review surface for proposed changes to existing Canon documents. */
export class WorldChangeDialog {
	private container: HTMLElement;
	private request: WorldChangeDialogRequest | null = null;
	private selectedTarget = "";
	private selectedProposalId: string | null = null;
	private selectedHistoryId: string | null = null;
	private view: "new" | "pending" | "history" = "new";
	private rollbackConfirm = false;
	private feedback = "";
	private processing = false;
	private error = "";

	constructor(container: HTMLElement) {
		this.container = container;
	}

	isVisible(): boolean {
		return this.request !== null;
	}

	open(request: WorldChangeDialogRequest): void {
		this.request = request;
		this.selectedTarget = request.canonDocuments[0]?.relativePath ?? "";
		this.selectedProposalId = request.proposals[0]?.id ?? null;
		this.selectedHistoryId = request.histories[0]?.id ?? null;
		this.view = request.proposals.length ? "pending" : request.histories.length ? "history" : "new";
		this.rollbackConfirm = false;
		this.feedback = "";
		this.processing = false;
		this.error = "";
		this.render();
	}

	close(): void {
		if (this.processing) return;
		this.request = null;
		this.render();
	}

	private selectedProposal(): NovelWorldChangeProposal | null {
		return this.view === "pending" ? this.request?.proposals.find((proposal) => proposal.id === this.selectedProposalId) ?? null : null;
	}

	private changeView(view: typeof this.view): void {
		if (this.processing) return;
		this.view = view;
		this.feedback = "";
		this.error = "";
		this.rollbackConfirm = false;
		this.render();
	}

	private async reload(): Promise<void> {
		if (!this.request || this.processing) return;
		this.processing = true;
		this.error = "";
		this.rollbackConfirm = false;
		this.render();
		try {
			Object.assign(this.request, await this.request.onReload());
			if (!this.request.histories.some((entry) => entry.id === this.selectedHistoryId)) this.selectedHistoryId = this.request.histories[0]?.id ?? null;
			if (!this.request.proposals.some((entry) => entry.id === this.selectedProposalId)) this.selectedProposalId = this.request.proposals[0]?.id ?? null;
		} catch (error) { this.error = error instanceof Error ? error.message : String(error); }
		finally { this.processing = false; this.render(); }
	}

	private async rollback(): Promise<void> {
		const request = this.request;
		const entry = request?.histories.find((item) => item.id === this.selectedHistoryId);
		if (!request || !entry || !this.rollbackConfirm || this.processing) return;
		this.processing = true;
		this.error = "";
		this.render();
		try {
			await request.onRollback(entry);
			// Keep the completed result visible even if the following refresh fails.
			entry.rolledBackAt = new Date().toISOString();
			Object.assign(request, await request.onReload());
		} catch (error) { this.error = error instanceof Error ? error.message : String(error); }
		finally { this.processing = false; this.rollbackConfirm = false; this.render(); }
	}

	private async createRequest(): Promise<void> {
		if (!this.request || this.processing) return;
		this.processing = true;
		this.error = "";
		this.render();
		try {
			await this.request.onRequest(this.selectedTarget, this.feedback);
			this.request = null;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.processing = false;
			this.render();
		}
	}

	private async applyProposal(): Promise<void> {
		const proposal = this.selectedProposal();
		if (!proposal || !this.request || this.processing) return;
		this.processing = true;
		this.error = "";
		this.render();
		try {
			await this.request.onApply(proposal);
			this.request = null;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.processing = false;
			this.render();
		}
	}

	private async reviseProposal(): Promise<void> {
		const proposal = this.selectedProposal();
		if (!proposal || !this.request || this.processing) return;
		this.processing = true;
		this.error = "";
		this.render();
		try {
			await this.request.onRevise(proposal, this.feedback);
			this.request = null;
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.processing = false;
			this.render();
		}
	}

	private openFile(path: string): void {
		if (!this.request || this.processing) return;
		this.request.onOpenFile(path);
	}

	private renderPath(label: string, path: string): unknown {
		return html`<div class="world-change-path"><span>${label}</span><button title=${`在编辑器中打开 ${path}`} @click=${() => this.openFile(path)}><code>${path}</code></button></div>`;
	}

	render(): void {
		const request = this.request;
		if (!request) {
			render(nothing, this.container);
			return;
		}
		const proposal = this.selectedProposal();
		const history = this.view === "history" ? request.histories.find((item) => item.id === this.selectedHistoryId) ?? null : null;
		const currentHistoryText = history ? request.canonDocuments.find((document) => document.relativePath === history.targetPath)?.text ?? null : null;
		const rollbackGuard = history ? canRollbackWorldChange(history, request.histories, currentHistoryText) : { allowed: false, reason: "" };
		const target = proposal
			? request.canonDocuments.find((document) => document.relativePath === proposal.targetPath) ?? null
			: request.canonDocuments.find((document) => document.relativePath === this.selectedTarget) ?? null;
		render(html`
			<div class="world-change-dialog-backdrop" @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.close(); }}>
				<section class="world-change-dialog" role="dialog" aria-modal="true" aria-labelledby="world-change-dialog-title">
					<header class="world-change-dialog-header">
						<div><h2 id="world-change-dialog-title">世界观变更</h2><p>${request.projectName} · Canon 始终由你确认</p></div>
						<button class="world-change-dialog-close" aria-label="关闭" ?disabled=${this.processing} @click=${() => this.close()}>×</button>
					</header>
					<div class="world-change-dialog-body">
						<nav class="world-change-navigation" aria-label="世界观变更页面">
							${([ ["new", "新建请求"], ["pending", `待审阅 · ${request.proposals.length}`], ["history", `变更历史 · ${request.histories.length}`] ] as const).map(([view, label]) => html`<button aria-pressed=${String(this.view === view)} ?disabled=${this.processing} @click=${() => this.changeView(view)}>${label}</button>`)}
							<button class="world-change-refresh" ?disabled=${this.processing} @click=${() => void this.reload()}>刷新</button>
						</nav>
						${this.view === "history" ? html`
							${request.histories.length ? html`<section class="world-change-proposal-list world-change-history-list" aria-label="世界观变更历史列表">${request.histories.map((item) => html`<button class=${item.id === history?.id ? "active" : ""} aria-pressed=${String(item.id === history?.id)} ?disabled=${this.processing} @click=${() => { this.selectedHistoryId = item.id; this.rollbackConfirm = false; this.error = ""; this.render(); }}><span>${item.targetPath} · ${item.rolledBackAt ? "已回滚" : "已合并"}</span><code>${new Date(item.createdAt).toLocaleString()} · ${item.id}</code></button>`)}</section>` : nothing}
							${history ? html`
								<div class="world-change-dialog-notice"><strong>${this.rollbackConfirm ? "确认撤销本次变更" : history.rolledBackAt ? "已回滚 · 原始快照仍保留" : "已合并 · 可查看原始变更"}</strong><span>${rollbackGuard.reason}</span><span>只恢复此 Canon 文件，不修改章节正文、规划或关联文件；旧提案不会重新进入待审阅。</span></div>
								${this.renderPath("目标 Canon", history.targetPath)}
								${this.renderPath("历史快照", `.novel/world-change-history/${history.id}.json`)}
								${this.renderPath("审计记录", ".novel/world-change-log.md")}
								<p class="world-change-history-meta">合并于 ${new Date(history.createdAt).toLocaleString()}${history.rolledBackAt ? ` · 回滚于 ${new Date(history.rolledBackAt).toLocaleString()}` : ""}</p>
								<section class="world-change-diff"><header><strong>${this.rollbackConfirm ? "回滚预览" : "变更快照"}</strong><span>${this.rollbackConfirm ? "左：当前版本 → 右：将恢复的版本" : "左：变更前 / 右：变更后（非当前文件）"}</span></header><div class="world-change-diff-columns"><pre aria-label=${this.rollbackConfirm ? "当前版本" : "变更前"}>${this.rollbackConfirm ? currentHistoryText : history.before}</pre><pre aria-label=${this.rollbackConfirm ? "将恢复的版本" : "变更后"}>${this.rollbackConfirm ? history.before : history.after}</pre></div></section>
								${history.affectedPaths.length ? html`<section class="world-change-impact-list"><header><strong>原提案声明的关联文件</strong><span>回滚不会自动修改这些文件</span></header>${history.affectedPaths.map((path) => html`<button ?disabled=${this.processing} @click=${() => this.openFile(path)}><code>${path}</code></button>`)}</section>` : nothing}
							` : html`<div class="world-change-dialog-notice">尚无世界观变更历史。</div>`}
						` : proposal ? html`
							<div class="world-change-dialog-notice"><strong>确认后将替换指定 Canon 文件。</strong><span>应用前会重新核验原文指纹；若文件在审阅期间发生变化，操作会被拒绝而不会覆盖新内容。</span></div>
							${this.renderPath("目标 Canon", proposal.targetPath)}
							${this.renderPath("变更提案", proposal.proposalPath)}
							<section class="world-change-impact-list"><header><strong>提案声明的受影响文件</strong><span>${proposal.affectedPaths.length ? "由世界观 Agent 标注，需人工判断是否同步调整" : "未声明自动关联修改"}</span></header>${proposal.affectedPaths.length ? proposal.affectedPaths.map((path) => html`<button @click=${() => this.openFile(path)}><code>${path}</code></button>`) : nothing}</section>
							<section class="world-change-diff"><header><strong>审阅对照</strong><span>左侧为当前 Canon，右侧为建议替换全文</span></header><div class="world-change-diff-columns"><pre>${target?.text ?? "目标文件当前不可读取"}</pre><pre>${proposal.proposedText}</pre></div></section>
							<label class="world-change-feedback"><span>补充意见（需要返工时填写）</span><textarea .value=${this.feedback} ?disabled=${this.processing} @input=${(event: Event) => { this.feedback = (event.target as HTMLTextAreaElement).value; this.render(); }} placeholder="例如：保留旧设定的知识边界，补充分歧的后果"></textarea></label>
						` : this.view === "pending" ? html`<div class="world-change-dialog-notice">暂无待审阅提案。已合并或已回滚的记录请在“变更历史”查看。</div>` : html`
							<div class="world-change-dialog-notice"><strong>先把修改意见交给世界观 Agent。</strong><span>Agent 将创建完整替换提案，不会直接修改 Canon；你随后可在这里对照审阅和合并。</span></div>
							<label class="world-change-target"><span>要调整的 Canon 文件</span><select .value=${this.selectedTarget} ?disabled=${this.processing} @change=${(event: Event) => { this.selectedTarget = (event.target as HTMLSelectElement).value; this.render(); }}>${request.canonDocuments.map((document) => html`<option value=${document.relativePath}>${document.relativePath}</option>`)}</select></label>
							${target ? this.renderPath("当前 Canon", target.relativePath) : html`<div class="world-change-dialog-error">当前项目没有可变更的 Canon 文档。</div>`}
							<label class="world-change-feedback"><span>修改意见</span><textarea .value=${this.feedback} ?disabled=${this.processing} @input=${(event: Event) => { this.feedback = (event.target as HTMLTextAreaElement).value; this.render(); }} placeholder="说明需要调整的设定、保留的边界，以及与既有内容的关系"></textarea></label>
						`}
						${this.view === "pending" && request.proposals.length ? html`<section class="world-change-proposal-list"><header><strong>等待审阅的提案</strong><span>${request.proposals.length}</span></header>${request.proposals.map((item) => html`<button class=${item.id === proposal?.id ? "active" : ""} ?disabled=${this.processing} @click=${() => { this.selectedProposalId = item.id; this.feedback = ""; this.render(); }}><span>${item.targetPath}</span><code>${item.proposalPath}</code></button>`)}</section>` : nothing}
						${this.error ? html`<div class="world-change-dialog-error" role="alert">${this.error}</div>` : nothing}
					</div>
					<footer class="world-change-dialog-footer">
						<button class="world-change-dialog-cancel" ?disabled=${this.processing} @click=${() => this.close()}>取消</button>
						${this.view === "history" ? history ? html`${this.rollbackConfirm ? html`<button class="world-change-dialog-secondary" ?disabled=${this.processing} @click=${() => { this.rollbackConfirm = false; this.render(); }}>返回历史</button>` : nothing}<button class="world-change-dialog-secondary" ?disabled=${this.processing || !rollbackGuard.allowed} @click=${() => { if (this.rollbackConfirm) void this.rollback(); else { this.rollbackConfirm = true; this.render(); } }}>${this.processing ? "处理中…" : this.rollbackConfirm ? "确认回滚此变更" : "回滚此变更"}</button>` : nothing : proposal ? html`<button class="world-change-dialog-secondary" ?disabled=${this.processing || !this.feedback.trim()} @click=${() => void this.reviseProposal()}>交给世界观 Agent 返工</button><button class="world-change-dialog-confirm" ?disabled=${this.processing} @click=${() => void this.applyProposal()}>${this.processing ? "处理中…" : "确认合并至 Canon"}</button>` : this.view === "new" ? html`<button class="world-change-dialog-confirm" ?disabled=${this.processing || !target || !this.feedback.trim()} @click=${() => void this.createRequest()}>${this.processing ? "正在创建…" : "创建变更请求"}</button>` : nothing}
					</footer>
				</section>
			</div>
		`, this.container);
	}
}
