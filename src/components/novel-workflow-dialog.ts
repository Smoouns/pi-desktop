import { html, nothing, render, type TemplateResult } from "lit";
import type { NovelChapterRecord, NovelPromotionHistoryEntry, NovelRecordUpdatePreview } from "../novel/index.js";

export type NovelWorkflowAction = "inspect" | "accept-card" | "accept-manuscript" | "request-card-revision" | "request-manuscript-revision" | "resume-card-revision" | "resume-manuscript-revision" | "promote" | "rollback";
type NovelWorkflowOperation = Exclude<NovelWorkflowAction, "inspect">;

export interface NovelWorkflowDialogRequest {
	action: NovelWorkflowAction;
	projectName: string;
	record: NovelChapterRecord;
	recordUpdates?: NovelRecordUpdatePreview[];
	promotionHistory?: NovelPromotionHistoryEntry;
	onConfirm?: (recordUpdates: NovelRecordUpdatePreview[], feedback?: string) => Promise<void> | void;
	onAction?: (action: NovelWorkflowOperation) => void;
	onOpenFile?: (path: string) => void;
}

/** A user-owned confirmation surface for the filesystem-backed chapter workflow. */
export class NovelWorkflowDialog {
	private container: HTMLElement;
	private request: NovelWorkflowDialogRequest | null = null;
	private processing = false;
	private error = "";
	private selectedRecordUpdateIds = new Set<string>();
	private feedback = "";

	constructor(container: HTMLElement) {
		this.container = container;
	}

	isVisible(): boolean {
		return this.request !== null;
	}

	open(request: NovelWorkflowDialogRequest): void {
		this.request = request;
		this.processing = false;
		this.error = "";
		this.selectedRecordUpdateIds = new Set(request.recordUpdates?.map((update) => update.id) ?? []);
		this.feedback = "";
		this.render();
	}

	close(): void {
		if (this.processing) return;
		this.request = null;
		this.error = "";
		this.render();
	}

	private async confirm(): Promise<void> {
		if (!this.request?.onConfirm || this.processing) return;
		this.processing = true;
		this.error = "";
		this.render();
		try {
			await this.request.onConfirm((this.request.recordUpdates ?? []).filter((update) => this.selectedRecordUpdateIds.has(update.id)), this.feedback);
			this.request = null;
		} catch (err) {
			this.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.processing = false;
			this.render();
		}
	}

	private renderPath(label: string, path: string | null, openable = true): TemplateResult {
		return html`
			<div class="novel-workflow-dialog-path">
				<span>${label}</span>
				${path && openable ? html`<button title=${`在编辑器中打开 ${path}`} @click=${() => this.openFile(path)}><code>${path}</code></button>` : html`<code>${path ?? "未找到"}</code>`}
			</div>
		`;
	}

	private verificationLabel(status: NovelChapterRecord["verification"]): string {
		return { pass: "PASS", "pass-with-warnings": "有警告", failed: "失败", missing: "缺失" }[status];
	}

	private openFile(path: string): void {
		if (!this.request || this.processing) return;
		this.request.onOpenFile?.(path);
		this.close();
	}

	private startAction(action: NovelWorkflowOperation): void {
		if (!this.request || this.processing) return;
		const onAction = this.request.onAction;
		this.close();
		onAction?.(action);
	}

	private toggleRecordUpdate(id: string, enabled: boolean): void {
		if (enabled) this.selectedRecordUpdateIds.add(id);
		else this.selectedRecordUpdateIds.delete(id);
		this.render();
	}

	private updateFeedback(value: string): void {
		this.feedback = value;
		this.render();
	}

	render(): void {
		const request = this.request;
		if (!request) {
			render(nothing, this.container);
			return;
		}
		const { action, projectName, record } = request;
		const inspecting = action === "inspect";
		const acceptingCard = action === "accept-card";
		const acceptingManuscript = action === "accept-manuscript";
		const requestingRevision = action === "request-card-revision" || action === "request-manuscript-revision";
		const revisingCard = action === "request-card-revision";
		const rollingBack = action === "rollback";
		const title = inspecting ? "章节验收" : acceptingCard ? "确认章节卡" : acceptingManuscript ? "确认正文通过验收" : requestingRevision ? revisingCard ? "要求修改章节卡" : "要求修改正文" : rollingBack ? "回滚 Canon 晋升" : "晋升正文至 Canon";
		const confirmLabel = acceptingCard ? "确认章节卡" : acceptingManuscript ? "确认正文验收" : requestingRevision ? "提交修改意见" : rollingBack ? "确认回滚晋升" : "确认晋升";
		const recordUpdates = request.recordUpdates ?? [];
		const promotionHistory = request.promotionHistory;
		render(html`
			<div class="novel-workflow-dialog-backdrop" @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.close(); }}>
				<section class="novel-workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="novel-workflow-dialog-title">
					<header class="novel-workflow-dialog-header">
						<div>
							<h2 id="novel-workflow-dialog-title">${title}</h2>
							<p>${projectName} · 第 ${record.chapter} 章</p>
						</div>
						<button class="novel-workflow-dialog-close" aria-label="关闭" ?disabled=${this.processing} @click=${() => this.close()}>×</button>
					</header>
					<div class="novel-workflow-dialog-body">
						${inspecting ? html`
							<div class="novel-workflow-dialog-notice">
								<strong>所有验收操作集中在这里，文件仍以项目内 Markdown 为准。</strong>
								<span>先查看关联文件；确认或提出返工后，状态会重新按文件内容计算。</span>
							</div>
							<section class="novel-workflow-file-list">
								${this.renderPath("章节卡", record.cardPath)}
								${this.renderPath("候选正文", record.candidatePath)}
								${this.renderPath("连续性提案", record.proposalPath)}
								${this.renderPath(`机械验证报告 · ${this.verificationLabel(record.verification)}`, record.verificationPath)}
								${this.renderPath(record.state === "promoted" ? "当前 Canon" : "新 Canon 目标", record.canonicalPath, record.state === "promoted")}
								${record.cardRevisionRequestPath ? this.renderPath("章节卡返工请求", record.cardRevisionRequestPath) : nothing}
								${record.manuscriptRevisionRequestPath ? this.renderPath("正文返工请求", record.manuscriptRevisionRequestPath) : nothing}
							</section>
							<section class="novel-workflow-inspect-actions" aria-label="验收操作">
								${record.state === "awaiting-card-review" ? html`
									<button class="novel-workflow-inspect-primary" @click=${() => this.startAction("accept-card")}>确认章节卡</button>
									<button @click=${() => this.startAction("request-card-revision")}>需要修改章节卡</button>
								` : nothing}
								${record.state === "awaiting-user-review" ? html`
									<button class="novel-workflow-inspect-primary" @click=${() => this.startAction("accept-manuscript")}>确认正文通过验收</button>
									<button @click=${() => this.startAction("request-manuscript-revision")}>需要修改正文</button>
								` : nothing}
								${record.state === "accepted" ? html`<button class="novel-workflow-inspect-primary" @click=${() => this.startAction("promote")}>晋升至 Canon</button>` : nothing}
								${record.cardAccepted && record.state !== "promoted" && record.state !== "card-revision-requested" ? html`<button @click=${() => this.startAction("request-card-revision")}>需要修改章节卡</button>` : nothing}
								${record.state === "card-revision-requested" ? html`<button class="novel-workflow-inspect-primary" @click=${() => this.startAction("resume-card-revision")}>继续章节卡返工</button>` : nothing}
								${record.state === "manuscript-revision-requested" ? html`<button class="novel-workflow-inspect-primary" @click=${() => this.startAction("resume-manuscript-revision")}>继续正文返工</button>` : nothing}
								${record.state === "promoted" && record.rollbackHistory ? html`<button class="novel-workflow-inspect-danger" @click=${() => this.startAction("rollback")}>回滚本次晋升</button>` : nothing}
								${record.state === "card-revision-requested" || record.state === "manuscript-revision-requested" ? html`<span class="novel-workflow-inspect-status">已有返工请求，可随时重新预填写任务。</span>` : nothing}
								${record.state === "planned" ? html`<span class="novel-workflow-inspect-status">章节卡已确认，等待候选正文。</span>` : nothing}
								${record.state === "blocked" ? html`<span class="novel-workflow-inspect-status">当前条件不足，无法执行晋升。</span>` : nothing}
							</section>
						` : acceptingCard ? html`
							<div class="novel-workflow-dialog-notice">
								<strong>本次只确认章节卡，不会生成或改写正文。</strong>
								<span>确认记录将绑定章节卡当前内容；章节卡后续变化时，确认会自动失效。</span>
							</div>
							${this.renderPath("章节卡", record.cardPath)}
						` : acceptingManuscript ? html`
							<div class="novel-workflow-dialog-notice">
								<strong>请在已阅读正文后确认本章通过人工验收。</strong>
								<span>确认记录会同时绑定候选正文和章节卡；任一文件随后变化，都必须重新验收。</span>
							</div>
							${this.renderPath("章节卡", record.cardPath)}
							${this.renderPath("候选正文", record.candidatePath)}
							${this.renderPath("连续性提案", record.proposalPath)}
						` : requestingRevision ? html`
							<div class="novel-workflow-dialog-notice novel-workflow-dialog-notice-warning">
								<strong>${revisingCard ? "章节卡确认将失效，规划 Agent 应先处理本次返工。" : "正文验收将失效，写文 Agent 应依据规划 Agent 的返工记录生成新候选稿。"}</strong>
								<span>修改意见会保存为独立 Markdown 交接单，不会覆盖当前${revisingCard ? "章节卡" : "正文"}。</span>
							</div>
							${this.renderPath(revisingCard ? "章节卡" : "候选正文", revisingCard ? record.cardPath : record.candidatePath)}
							<label class="novel-workflow-feedback">
								<span>修改意见</span>
								<textarea .value=${this.feedback} ?disabled=${this.processing} @input=${(event: Event) => this.updateFeedback((event.target as HTMLTextAreaElement).value)} placeholder=${revisingCard ? "说明章节目标、节奏、信息边界或事件安排需要如何调整" : "说明正文中需要修改的情节、人物、表达或连续性问题"}></textarea>
							</label>
						` : rollingBack && promotionHistory ? html`
							<div class="novel-workflow-dialog-notice novel-workflow-dialog-notice-warning">
								<strong>仅当晋升后的文件仍未被修改时，才会恢复本次晋升。</strong>
								<span>正文会移除，关联记录恢复至晋升前版本；连续性提案的 <code>USER_ACCEPTED</code> 状态不会改变。</span>
							</div>
							${this.renderPath("当前 Canon 正文", promotionHistory.canonicalPath)}
							${this.renderPath("历史快照", `.novel/promotion-history/${promotionHistory.id}.json`)}
							${this.renderPath("审计记录", ".novel/promotion-log.md")}
							${promotionHistory.recordUpdates.length > 0 ? html`
								<section class="novel-workflow-record-updates">
									<header><strong>将恢复的关联记录</strong><span>所有项目必须保持未修改</span></header>
									${promotionHistory.recordUpdates.map((update) => html`
										<div class="novel-workflow-record-update novel-workflow-record-update-static">
											<span><strong>${update.label} · 恢复晋升前内容</strong><code>${update.targetPath}</code><em>- ${update.after}\n+ ${update.before}</em></span>
										</div>
									`)}
								</section>
							` : html`
								<div class="novel-workflow-dialog-manual">
									<strong>本次晋升没有关联记录更新</strong>
									<span>回滚只会移除该次创建的 Canon 正文，并追加审计记录。</span>
								</div>
							`}
						` : html`
							<div class="novel-workflow-dialog-notice">
								<strong>仅复制已通过人工验收的候选正文。</strong>
								<span>若 Canon 目标已存在，操作将被拒绝，绝不会覆盖已有文件。</span>
							</div>
							${this.renderPath("候选正文", record.candidatePath)}
							${this.renderPath("新 Canon 正文", record.canonicalPath)}
							${this.renderPath("审计记录", ".novel/promotion-log.md")}
							${recordUpdates.length > 0 ? html`
								<section class="novel-workflow-record-updates">
									<header><strong>关联记录更新</strong><span>仅应用你勾选的显式补丁</span></header>
									${recordUpdates.map((update) => html`
										<label class="novel-workflow-record-update">
											<input type="checkbox" .checked=${this.selectedRecordUpdateIds.has(update.id)} ?disabled=${this.processing} @change=${(event: Event) => this.toggleRecordUpdate(update.id, (event.target as HTMLInputElement).checked)} />
											<span><strong>${update.label} · ${update.operation === "append" ? "追加" : "精确替换"}</strong><code>${update.targetPath}</code><em>${update.operation === "replace-once" ? `- ${update.before}\n+ ${update.after}` : `+ ${update.after}`}</em></span>
										</label>
									`)}
								</section>
							` : html`
								<div class="novel-workflow-dialog-manual">
									<strong>关联记录保持手动维护</strong>
									<span>提案未提供可审计的显式更新块，因此进度、当前故事状态与连续性账本不会被自动改写。</span>
								</div>
							`}
						`}
						${this.error ? html`<div class="novel-workflow-dialog-error" role="alert">${this.error}</div>` : nothing}
					</div>
					<footer class="novel-workflow-dialog-footer">
						<button class="novel-workflow-dialog-cancel" ?disabled=${this.processing} @click=${() => this.close()}>${inspecting ? "关闭" : "取消"}</button>
						${inspecting ? nothing : html`<button class="novel-workflow-dialog-confirm" ?disabled=${this.processing} @click=${() => void this.confirm()}>${this.processing ? "处理中…" : confirmLabel}</button>`}
					</footer>
				</section>
			</div>
		`, this.container);
	}
}
