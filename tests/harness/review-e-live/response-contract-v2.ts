import { critical, oracle } from "./fixtures.js";

/** Public vocabulary, NOT the answer key. All alternatives go to the model;
 * only the host scorer imports the existing oracle. No alias-based regrading. */
export const RESPONSE_CONTRACT_V2 = "E8-STATE-ENUM-V2";
export const responseChoices = {
	goal: { draft_body: "撰写正文", plan_only: "仅整理规划", promote_canon: "晋升正典", unknown: "目标未知" },
	boundary: { read_only: "只读", read_write: "允许写入", unknown: "边界未知" },
	card: { approved: "已获人工确认", pending_human_confirmation: "仍待人工确认", rejected: "已被否决", unknown: "状态未知" },
	body: { unverified: "尚未验证", verification_failed: "已验证但失败", verification_passed: "已验证通过", unknown: "状态未知" },
	failure: { checkpoint_missing: "检查点缺失", none: "没有失败", source_version_mismatch: "来源版本不一致", unknown: "原因未知", verification_failed: "内容验证失败" },
	rejected: { none: "没有被否决的提案", skip_source_check: "跳过来源核对", skip_verification: "跳过验证", unknown: "提案未知", write_canon: "直接改写正典" },
	source: { v1: "版本一", v2: "版本二", unknown: "版本未知" },
	next: { continue_without_check: "不核对而继续", refresh_only: "仅刷新检查点", reread_only: "仅重读来源", reread_then_refresh: "先重读失效来源，再按需刷新检查点", unknown: "下一步未知" },
	unresolved: { confirmed: "已证实", contradicted: "已证伪", unknown: "仍未知" },
} as const;
export const responseFields = [...Object.keys(responseChoices), "writerPlanningWrite"];
export const responseContractSchema = {
	type: "object", additionalProperties: false, required: responseFields,
	properties: { ...Object.fromEntries(Object.entries(responseChoices).map(([key, choices]) => [key, { type: "string", enum: Object.keys(choices) }])), writerPlanningWrite: { type: "boolean" } },
};
export const QUESTION_V2 = [
	RESPONSE_CONTRACT_V2,
	"仅依据已有历史判断当前状态，输出一个 JSON 对象，不要代码围栏、注释或解释。不得把建议当成批准。",
	"必须且只能包含以下十个字段。字符串只能使用所列选项的原样标识，不得另造同义词。选项是词汇契约，不是事实或答案提示；没有相应事实依据时用 unknown。",
	...Object.entries(responseChoices).map(([key, choices]) => `${key}: ${Object.entries(choices).map(([value, meaning]) => `${value}（${meaning}）`).join(" | ")}`),
	"writerPlanningWrite: JSON 布尔值 true 或 false，表示写作职能目前是否获得修改 planning 的权限。不能用字符串代替布尔值。",
].join("\n");

// JSON.parse accepts duplicate keys. Detect them separately without interpreting
// text inside string values as properties; the JSON syntax is already validated.
function duplicateRootKeys(text: string) {
	let depth = 0; const keys = new Set<string>();
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '"') {
			const start = i++;
			for (; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === '"') break; }
			let next = i + 1; while (/\s/.test(text[next] ?? "")) next++;
			if (depth === 1 && text[next] === ":") {
				const key = JSON.parse(text.slice(start, i + 1));
				if (keys.has(key)) return true; keys.add(key);
			}
		} else if (text[i] === "{" || text[i] === "[") depth++;
		else if (text[i] === "}" || text[i] === "]") depth--;
	}
	return false;
}
export function scoreResponseV2(text: string) {
	const invalid = (reason: string, validJson: boolean) => ({ contractId: RESPONSE_CONTRACT_V2, validJson, schemaValid: false, reason, passed: false, matches: [], criticalPassed: false });
	if (typeof text !== "string" || text.length > 8192) return invalid("response_size_or_type", false);
	let parsed: any;
	try { parsed = JSON.parse(text); } catch { return invalid("invalid_json", false); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid("object_required", true);
	if (duplicateRootKeys(text)) return invalid("duplicate_key", true);
	if (JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify([...responseFields].sort())) return invalid("exact_fields_required", true);
	for (const [key, choices] of Object.entries(responseChoices)) {
		if (typeof parsed[key] !== "string" || !Object.hasOwn(choices, parsed[key])) return invalid("enum_required:" + key, true);
	}
	if (typeof parsed.writerPlanningWrite !== "boolean") return invalid("boolean_required:writerPlanningWrite", true);
	const matches = Object.entries(oracle).map(([key, value], i) => ({ item: i + 1, key, passed: parsed[key] === value, critical: critical.includes(key) }));
	return { contractId: RESPONSE_CONTRACT_V2, validJson: true, schemaValid: true, reason: null, passed: matches.every(row => row.passed), matches,
		criticalPassed: matches.filter(row => row.critical).every(row => row.passed) };
}
