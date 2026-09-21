import assert from "node:assert/strict";
import { createBudgetDiagnostics } from "../../src/extensions/budget-diagnostics.js";
import type { RunCase } from "./testkit.js";

export async function runBudgetDiagnosticCases(runCase: RunCase): Promise<void> {
	await runCase("BUDGET-DIAGNOSTICS-01 whitelists durable fields and rejects malformed records", (record) => {
		const diagnostics = createBudgetDiagnostics();
		const hostile = diagnostics.sanitize({
			version: 1,
			stage: "context-preflight",
			reason: "model_input_budget_exceeded",
			request: "SECRET_REQUEST",
			error: "SECRET_ERROR",
			ledger: { total: 900, limit: 800, system: 10, apiKey: "SECRET_KEY", negative: -1, fractional: 1.5, infinite: Infinity },
		});
		assert.deepEqual(hostile, {
			version: 1,
			stage: "context-preflight",
			reason: "model_input_budget_exceeded",
			ledger: { limit: 800, system: 10, total: 900 },
		});
		assert.equal(diagnostics.sanitize("raw error"), null);
		assert.equal(diagnostics.sanitize({ version: 1, stage: "unknown", reason: "invalid_budget" }), null);
		assert.equal(diagnostics.sanitize({ version: 1, stage: "provider-audit", reason: "SECRET_ERROR" }), null);
		assert.equal(diagnostics.sanitize(new Proxy({}, { get() { throw new Error("SECRET_GETTER"); } })), null);
		assert.doesNotMatch(JSON.stringify(hostile), /SECRET/);
		record("budget.diagnostics.whitelist", { hostileFieldsStored: false, numericFields: 3 });
	});

	await runCase("BUDGET-DIAGNOSTICS-02 maps known runtime failures and fails closed", (record) => {
		const diagnostics = createBudgetDiagnostics();
		assert.deepEqual(diagnostics.from("run_capacity_exceeded", "provider-audit", { outputUsed: 4 }), {
			version: 1, stage: "provider-audit", reason: "output_capacity", ledger: { outputUsed: 4 },
		});
		assert.equal(diagnostics.from("budget_interface_unavailable", "context-preflight").reason, "budget_plan_unavailable");
		assert.equal(diagnostics.from("unknown secret failure", "hostile-stage").reason, "context_preflight_failed");
		assert.equal(diagnostics.from("unknown secret failure", "hostile-stage").stage, "context-preflight");
		assert.equal(diagnostics.from("invalid_budget", "context-preflight", new Proxy({}, { ownKeys() { throw new Error("PRIVATE"); } })).reason, "invalid_budget");
		record("budget.diagnostics.mapping", { aliases: 2, unknownFailsClosed: true });
	});

	await runCase("BUDGET-DIAGNOSTICS-03 formats actionable Chinese without overstating token precision", (record) => {
		const diagnostics = createBudgetDiagnostics();
		const overflow = diagnostics.format(diagnostics.from("model_input_budget_exceeded", "context-preflight", { total: 1200, limit: 1000 }));
		assert.match(overflow, /完整输入估算超过模型上下文上限/);
		assert.match(overflow, /1200 \/ 预算上限 1000/);
		assert.match(overflow, /UTF-8 字节估算，并含输出预留与安全余量/);
		assert.match(overflow, /不是模型实际 token 数/);
		assert.match(diagnostics.format(diagnostics.from("budget_tool_schema_unavailable", "context-preflight")), /工具缺少可计量的参数定义/);
		assert.match(diagnostics.format(diagnostics.from("budget_model_unavailable", "provider-audit")), /重新选择模型/);
		assert.match(diagnostics.format(diagnostics.from("invalid_payload", "provider-audit")), /不保证请求尚未发出/);
		assert.doesNotMatch(diagnostics.format({ version: 1, stage: "context-preflight", reason: "bad", error: "SECRET" }), /SECRET/);
		record("budget.diagnostics.format", { chinese: true, tokenPrecisionQualified: true });
	});

	await runCase("BUDGET-DIAGNOSTICS-04 factory source is standalone", (record) => {
		const rebuilt = Function(`return (${createBudgetDiagnostics.toString()})`)() as typeof createBudgetDiagnostics;
		const diagnostics = rebuilt();
		assert.equal(diagnostics.from("invalid_payload", "provider-audit").reason, "invalid_payload");
		assert.match(diagnostics.format(diagnostics.from("read_budget_exceeded", "context-preflight", { readUsed: 12, readLimit: 10 })), /累计读取量/);
		record("budget.diagnostics.embeddable", { standalone: true });
	});

	await runCase("BUDGET-DIAGNOSTICS-05 emits v2 for estimated-token ledgers and preserves v1 compatibility", (record) => {
		const diagnostics = createBudgetDiagnostics();
		const v2 = diagnostics.from("model_input_budget_exceeded", "context-preflight", {
			total: 1_200, limit: 1_000, inputEstimate: 900, rawInputBytes: 2_700,
			estimator: { kind: "estimated_tokens" },
		});
		assert.deepEqual(v2, {
			version: 2, stage: "context-preflight", reason: "model_input_budget_exceeded",
			ledger: { inputEstimate: 900, limit: 1_000, rawInputBytes: 2_700, total: 1_200 },
		});
		assert.match(diagnostics.format(v2), /当前估算 token 1200 \/ 上下文预算 1000/);
		assert.match(diagnostics.format(v2), /不是模型实际 token 计数/);
		const legacy = diagnostics.sanitize({ version: 1, stage: "context-preflight", reason: "model_input_budget_exceeded", ledger: { total: 9, limit: 8 } });
		assert.equal(legacy?.version, 1);
		assert.match(diagnostics.format(legacy), /UTF-8 字节估算/);
		record("budget.diagnostics.v2", { estimatedTokens: true, legacyReadable: true });
	});
}
