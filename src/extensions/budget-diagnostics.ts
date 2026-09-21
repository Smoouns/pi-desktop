export type BudgetDiagnosticStage = "context-preflight" | "provider-audit";

export type BudgetDiagnosticReason =
	| "model_input_budget_exceeded"
	| "invalid_budget"
	| "invalid_payload"
	| "unsupported_media"
	| "budget_tool_registry_unavailable"
	| "budget_tool_schema_unavailable"
	| "budget_system_prompt_unavailable"
	| "budget_plan_unavailable"
	| "budget_model_unavailable"
	| "read_budget_exceeded"
	| "output_budget_exceeded"
	| "output_capacity"
	| "context_preflight_failed";

export interface BudgetDiagnosticDetail {
	version: 1 | 2;
	stage: BudgetDiagnosticStage;
	reason: BudgetDiagnosticReason;
	ledger?: Record<string, number>;
}

/**
 * Dependency-free diagnostics factory. The generated Pi extension embeds this
 * factory with Function#toString, so keep every runtime dependency local.
 */
export function createBudgetDiagnostics() {
	type Stage = "context-preflight" | "provider-audit";
	type Reason = BudgetDiagnosticReason;
	type Detail = { version: 1 | 2; stage: Stage; reason: Reason; ledger?: Record<string, number> };

	const stages = new Set<string>(["context-preflight", "provider-audit"]);
	const reasons = new Set<string>([
		"model_input_budget_exceeded", "invalid_budget", "invalid_payload", "unsupported_media",
		"budget_tool_registry_unavailable", "budget_tool_schema_unavailable",
		"budget_system_prompt_unavailable", "budget_plan_unavailable", "budget_model_unavailable",
		"read_budget_exceeded", "output_budget_exceeded", "output_capacity", "context_preflight_failed",
	]);
	const ledgerFields = new Set<string>([
		"system", "tools", "history", "checkpoint", "observationPreview", "newEvidence",
		"serializationOverhead", "payload", "outputReserve", "safetyMargin", "total", "limit",
		"rawInputBytes", "inputEstimate",
		"available", "readLimit", "outputLimit", "readUsed", "outputUsed", "availableRead", "availableOutput",
	]);
	const finiteUnit = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	const cleanLedger = (value: unknown): Record<string, number> | undefined => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const clean: Record<string, number> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const candidate = (value as Record<string, unknown>)[key];
			if (ledgerFields.has(key) && finiteUnit(candidate)) clean[key] = candidate;
		}
		return Object.keys(clean).length > 0 ? clean : undefined;
	};

	function sanitize(input: unknown): Detail | null {
		try {
			if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
			const candidate = input as Record<string, unknown>;
			if ((candidate.version !== 1 && candidate.version !== 2) || typeof candidate.stage !== "string" || !stages.has(candidate.stage)
				|| typeof candidate.reason !== "string" || !reasons.has(candidate.reason)) return null;
			const detail: Detail = { version: candidate.version, stage: candidate.stage as Stage, reason: candidate.reason as Reason };
			const ledger = cleanLedger(candidate.ledger);
			if (ledger) detail.ledger = ledger;
			return detail;
		} catch {
			// Proxies/getters are untrusted too; diagnostics must never turn a
			// provider failure into a second failure or retain its raw text.
			return null;
		}
	}

	function from(reason: unknown, stage: unknown, ledger?: unknown): Detail {
		const safeStage: Stage = stage === "provider-audit" ? "provider-audit" : "context-preflight";
		const aliases: Record<string, Reason> = {
			run_capacity_exceeded: "output_capacity",
			budget_interface_unavailable: "budget_plan_unavailable",
			run_not_started: "context_preflight_failed",
		};
		const mapped = typeof reason === "string" ? (aliases[reason] ?? reason) : "context_preflight_failed";
		const safeReason: Reason = reasons.has(mapped) ? mapped as Reason : "context_preflight_failed";
		let estimatedTokens = false;
		try {
			const candidate = ledger as { estimator?: { kind?: unknown } } | null | undefined;
			estimatedTokens = candidate?.estimator?.kind === "estimated_tokens";
		} catch { /* untrusted ledger */ }
		const version = estimatedTokens ? 2 as const : 1 as const;
		return sanitize({ version, stage: safeStage, reason: safeReason, ledger })
			?? { version, stage: safeStage, reason: safeReason };
	}

	function format(input: unknown): string {
		const detail = sanitize(input);
		if (!detail) return "请求在预算检查阶段被阻止，但诊断记录无效。请重新打开会话后重试；若仍出现，请查看运行状态。";
		const messages: Record<Reason, string> = {
			model_input_budget_exceeded: "本次请求的完整输入估算超过模型上下文上限。请减少本次附加材料，或在保留当前工作后开启新会话。",
			invalid_budget: "模型公布的上下文或输出预算无效，无法安全发出请求。请检查模型配置中的 contextWindow 与 maxTokens。",
			invalid_payload: "请求内容无法被完整、稳定地序列化，安全检查未通过。请移除异常附件后重试。",
			unsupported_media: "请求包含当前预算器无法可靠计量的媒体内容。请移除该附件或改用文件路径引用。",
			budget_tool_registry_unavailable: "无法读取当前启用工具列表，预算检查不能确认完整请求。请重启 Pi Desktop 后重试。",
			budget_tool_schema_unavailable: "一个或多个启用工具缺少可计量的参数定义。请检查扩展兼容性或重启 Pi Desktop。",
			budget_system_prompt_unavailable: "无法读取本次请求的系统提示，预算检查无法覆盖完整输入。请重启 Pi Desktop 后重试。",
			budget_plan_unavailable: "预算规划器未能完成检查。请重试；若持续出现，请查看运行状态中的检查阶段。",
			budget_model_unavailable: "当前会话没有可用的模型预算信息。请重新选择模型后重试。",
			read_budget_exceeded: "本轮运行累计读取量已达到安全上限。请保留当前结果，并在新一轮运行中继续。",
			output_budget_exceeded: "本轮运行累计工具输出已达到安全上限。请缩小单次读取范围，或在新一轮运行中继续。",
			output_capacity: "本轮历史工具结果或预算状态达到容量上限。请使用 /compact 压缩历史，或保留任务摘要后开启新会话。",
			context_preflight_failed: "上下文安全检查失败，已请求停止。请查看运行状态中的原因码后重试。",
		};
		let suffix = "";
		const total = detail.ledger?.total;
		const limit = detail.ledger?.limit;
		if (finiteUnit(total) && finiteUnit(limit)) suffix = detail.version === 2
			? ` 当前估算 token ${total} / 上下文预算 ${limit}，含输出预留与安全余量；这是多语言保守估算，不是模型实际 token 计数。`
			: ` 当前保守估算 ${total} / 预算上限 ${limit}。输入按 UTF-8 字节估算，并含输出预留与安全余量；不是模型实际 token 数。`;
		else if (detail.reason === "model_input_budget_exceeded") suffix = detail.version === 2
			? " 预算值为多语言 token 估算，不是模型实际 token 计数。"
			: " 预算值采用 UTF-8 字节保守估算，不是模型实际 token 数。";
		const stageText = detail.stage === "provider-audit" ? "最终请求审计未通过，已请求取消；此阶段不保证请求尚未发出。" : "";
		return stageText + messages[detail.reason] + suffix;
	}

	return { sanitize, from, format };
}
