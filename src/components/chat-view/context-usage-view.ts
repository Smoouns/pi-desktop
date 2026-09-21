import { html, nothing, type TemplateResult } from "lit";

export type ContextCapacitySource = "model-config" | "sdk-default" | "catalog";
export type ContextBudgetEstimator = "estimated_tokens" | "utf8_bytes";
export type ContextBudgetPhase = "preflight" | "after-tool-trim" | "after-compact" | "blocked";
export type ContextAutoCompaction = "idle" | "running" | "completed" | "failed" | "unavailable";

export interface ContextBudgetSnapshot {
	version: 1;
	sessionId: string;
	provider: string;
	modelId: string;
	capacity: {
		contextWindow: number;
		maxOutputTokens: number;
		source: ContextCapacitySource;
		verified: boolean;
		declaredContextWindow?: number;
		declaredMaxOutputTokens?: number;
		declaredSource?: "user-confirmed";
	};
	ledger: {
		system: number; tools: number; history: number; checkpoint: number; observationPreview: number;
		newEvidence: number; serializationOverhead: number; outputReserve: number; safetyMargin: number;
		total: number; limit: number; available: number; inputEstimate?: number; rawInputBytes?: number;
	};
	estimator: ContextBudgetEstimator;
	phase: ContextBudgetPhase;
	trimmedToolResults: number;
	autoCompaction: ContextAutoCompaction;
	reason?: string;
	measuredAt: number;
}

export interface ContextUsageViewModel {
	open: boolean;
	refreshing: boolean;
	compacting: boolean;
	connected: boolean;
	streaming: boolean;
	currentTokens: number | null;
	contextWindow: number | null;
	usageRatio: number | null;
	autoCompactionEnabled: boolean | null;
	budget: ContextBudgetSnapshot | null;
	onClose: () => void;
	onRefresh: () => void;
	onCompact: () => void;
	onToggleAutoCompaction: (enabled: boolean) => void;
}

const SOURCES = new Set<ContextCapacitySource>(["model-config", "sdk-default", "catalog"]);
const ESTIMATORS = new Set<ContextBudgetEstimator>(["estimated_tokens", "utf8_bytes"]);
const PHASES = new Set<ContextBudgetPhase>(["preflight", "after-tool-trim", "after-compact", "blocked"]);
const AUTO = new Set<ContextAutoCompaction>(["idle", "running", "completed", "failed", "unavailable"]);
const LEDGER_KEYS = ["system", "tools", "history", "checkpoint", "observationPreview", "newEvidence", "serializationOverhead", "outputReserve", "safetyMargin", "total", "limit", "available"] as const;

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, max: number): string | null {
	return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function boundedNumber(value: unknown, max = 1_000_000_000): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

function positiveSafeInteger(value: unknown, max = 1_000_000_000): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
}

/** Accept only the versioned, bounded projection; never retain arbitrary extension payloads. */
export function sanitizeContextBudgetSnapshot(value: unknown): ContextBudgetSnapshot | null {
	const raw = record(value), capacity = record(raw?.capacity), ledgerRaw = record(raw?.ledger);
	if (!raw || raw.version !== 1 || !capacity || !ledgerRaw) return null;
	const sessionId = boundedText(raw.sessionId, 256), provider = boundedText(raw.provider, 120), modelId = boundedText(raw.modelId, 240);
	const contextWindow = boundedNumber(capacity.contextWindow), maxOutputTokens = boundedNumber(capacity.maxOutputTokens);
	if (!sessionId || !provider || !modelId || !contextWindow || maxOutputTokens === null) return null;
	if (!SOURCES.has(capacity.source as ContextCapacitySource) || typeof capacity.verified !== "boolean") return null;
	const declarationFields = [capacity.declaredContextWindow, capacity.declaredMaxOutputTokens, capacity.declaredSource];
	const hasDeclaration = declarationFields.some((field) => field !== undefined);
	let declaration: Pick<ContextBudgetSnapshot["capacity"], "declaredContextWindow" | "declaredMaxOutputTokens" | "declaredSource"> = {};
	if (hasDeclaration) {
		const declaredContextWindow = positiveSafeInteger(capacity.declaredContextWindow);
		const declaredMaxOutputTokens = positiveSafeInteger(capacity.declaredMaxOutputTokens);
		if (capacity.declaredSource !== "user-confirmed" || declaredContextWindow === null || declaredMaxOutputTokens === null) return null;
		if (declaredContextWindow < contextWindow || declaredMaxOutputTokens < maxOutputTokens) return null;
		declaration = { declaredContextWindow, declaredMaxOutputTokens, declaredSource: "user-confirmed" };
	}
	if (!ESTIMATORS.has(raw.estimator as ContextBudgetEstimator) || !PHASES.has(raw.phase as ContextBudgetPhase) || !AUTO.has(raw.autoCompaction as ContextAutoCompaction)) return null;
	const ledger = {} as ContextBudgetSnapshot["ledger"];
	for (const key of LEDGER_KEYS) {
		const parsed = boundedNumber(ledgerRaw[key]);
		if (parsed === null) return null;
		ledger[key] = parsed;
	}
	for (const key of ["inputEstimate", "rawInputBytes"] as const) {
		if (ledgerRaw[key] === undefined) continue;
		const parsed = boundedNumber(ledgerRaw[key]);
		if (parsed === null) return null;
		ledger[key] = parsed;
	}
	const trimmedToolResults = boundedNumber(raw.trimmedToolResults, 100_000), measuredAt = boundedNumber(raw.measuredAt, 10_000_000_000_000);
	if (trimmedToolResults === null || measuredAt === null) return null;
	const reason = raw.reason === undefined ? undefined : boundedText(raw.reason, 240);
	if (raw.reason !== undefined && !reason) return null;
	return {
		version: 1, sessionId, provider, modelId,
		capacity: { contextWindow, maxOutputTokens, source: capacity.source as ContextCapacitySource, verified: capacity.verified, ...declaration },
		ledger, estimator: raw.estimator as ContextBudgetEstimator, phase: raw.phase as ContextBudgetPhase,
		trimmedToolResults, autoCompaction: raw.autoCompaction as ContextAutoCompaction,
		...(reason ? { reason } : {}), measuredAt,
	};
}

function number(value: number | null): string { return value === null ? "未知" : Math.round(value).toLocaleString(); }
function percent(value: number | null): string { return value === null ? "未知" : `${(value * 100).toFixed(1)}%`; }
function capacitySource(source: ContextCapacitySource): string {
	return { "model-config": "模型配置", "sdk-default": "SDK 默认值", catalog: "模型目录" }[source];
}
function phaseLabel(phase: ContextBudgetPhase): string {
	return { preflight: "发送前检查", "after-tool-trim": "旧工具结果已精简", "after-compact": "压缩后检查", blocked: "超限或恢复失败" }[phase];
}
function compactionLabel(state: ContextAutoCompaction): string {
	return { idle: "待命", running: "进行中", completed: "已完成", failed: "失败，未重试", unavailable: "不可用" }[state];
}

export function renderContextUsageView(view: ContextUsageViewModel): TemplateResult | typeof nothing {
	if (!view.open) return nothing;
	const budget = view.budget;
	const compacting = view.compacting || budget?.autoCompaction === "running";
	const compactDisabled = !view.connected || view.streaming || compacting;
	return html`
		<div class="context-usage-backdrop" @click=${view.onClose}>
			<section class="context-usage-dialog" role="dialog" aria-modal="true" aria-label="上下文使用情况" @click=${(event: Event) => event.stopPropagation()}>
				<header><div><h2>上下文使用情况</h2><p>查看和刷新不会调用模型；立即压缩会调用模型生成摘要。</p></div><button class="context-usage-close" title="关闭" @click=${view.onClose}>×</button></header>
				<div class="context-usage-grid">
					<article><span>Pi 当前上下文估算</span><strong>${number(view.currentTokens)}</strong><small>${view.currentTokens === null ? "压缩后需等待下一次成功回复，当前占用未知" : `约占 ${percent(view.usageRatio)}`}</small></article>
					<article><span>当前工作窗口</span><strong>${number(budget?.capacity.contextWindow ?? view.contextWindow)}</strong><small>${budget ? `Pi 有效窗口 · 当前最大输出 ${number(budget.capacity.maxOutputTokens)}` : "Pi 用于预算检查和自动压缩的有效窗口"}</small></article>
					<article><span>完整请求预算估算</span><strong>${budget ? `${number(budget.ledger.total)} / ${number(budget.ledger.limit)}` : "暂无"}</strong><small>${budget ? `${budget.estimator === "utf8_bytes" ? "UTF-8 字节估算" : "token 估算"} · ${phaseLabel(budget.phase)}` : "尚未收到当前会话、当前模型的预算快照"}</small></article>
				</div>
				${budget ? html`<section class="context-usage-budget"><h3>预算明细</h3><dl>
					<dt>系统提示</dt><dd>${number(budget.ledger.system)}</dd><dt>工具定义</dt><dd>${number(budget.ledger.tools)}</dd>
					<dt>会话历史</dt><dd>${number(budget.ledger.history)}</dd><dt>检查点</dt><dd>${number(budget.ledger.checkpoint)}</dd>
					<dt>观察预览</dt><dd>${number(budget.ledger.observationPreview)}</dd><dt>新增证据</dt><dd>${number(budget.ledger.newEvidence)}</dd>
					<dt>序列化与估算余量</dt><dd>${number(budget.ledger.serializationOverhead)}</dd><dt>剩余预算</dt><dd>${number(budget.ledger.available)}</dd>
					<dt>输出预留</dt><dd>${number(budget.ledger.outputReserve)}</dd><dt>安全余量</dt><dd>${number(budget.ledger.safetyMargin)}</dd>
				</dl>${budget.capacity.declaredSource === "user-confirmed" ? html`<p>服务商容量（用户确认）：上下文 ${number(budget.capacity.declaredContextWindow ?? null)} · 最大输出 ${number(budget.capacity.declaredMaxOutputTokens ?? null)}。此声明用于展示，不代表服务商实时校验，也不改变当前工作窗口。</p>` : nothing}
				<p>工作窗口来源：${capacitySource(budget.capacity.source)}${budget.capacity.verified ? "（已验证）" : "（未由服务商实时验证）"} · 自动压缩：${compactionLabel(budget.autoCompaction)}${budget.reason ? ` · ${budget.reason}` : ""}</p>
				<p>已精简 ${number(budget.trimmedToolResults)} 条旧工具结果，仅影响模型输入，完整聊天记录仍保留。预算包含输出预留，和 Pi 当前占用的口径不同。</p>
				${budget.capacity.source === "sdk-default" ? html`<p>当前容量是 SDK 缺省值。请向代理服务确认上限后，在 models.json 中明确设置 contextWindow 和 maxTokens；不会按模型别名自动扩大容量。</p>` : nothing}</section>` : nothing}
				<footer>
					<label><input type="checkbox" .checked=${view.autoCompactionEnabled === true} ?disabled=${view.autoCompactionEnabled === null || !view.connected || compacting} @change=${(event: Event) => view.onToggleAutoCompaction((event.target as HTMLInputElement).checked)}> 自动压缩</label>
					<span>发送前预算达到 85% 时先精简旧工具结果，仍有压力则压缩一次。运行中由 Pi 原生压缩接管。</span>
					<div><button @click=${view.onRefresh} ?disabled=${view.refreshing || !view.connected}>${view.refreshing ? "刷新中…" : "刷新"}</button><button class="primary" @click=${view.onCompact} ?disabled=${compactDisabled}>${compacting ? "压缩中…" : "立即压缩"}</button></div>
				</footer>
			</section>
		</div>
	`;
}
