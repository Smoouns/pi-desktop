import assert from "node:assert/strict";
import { normalizeGeneratedSessionTitle, sessionTitleSeed, visibleSessionTitleText } from "../src/extensions/session-title-core.ts";

export function runSessionTitleCoreTests(): void {
	const seed = sessionTitleSeed([
		{ role: "user", content: [{ type: "text", text: "<novel-role>plan</novel-role><novel-context>秘密上下文</novel-context>规划第18章 API_KEY=abcdef1234567890" }] },
		{ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "私密思考" }, { type: "text", text: "已完成章节卡规划。" }, { type: "toolCall", name: "write", arguments: { secret: true } }] },
	]);
	assert.deepEqual(seed, { user: "规划第18章 [已隐藏]", assistant: "已完成章节卡规划。" });
	assert.equal(sessionTitleSeed([{ role: "assistant", stopReason: "error", content: "失败" }]), null);
	assert.equal(sessionTitleSeed([
		{ role: "user", content: "旧请求" },
		{ role: "assistant", stopReason: "stop", content: "旧成功回复" },
		{ role: "user", content: "后续请求" },
		{ role: "assistant", stopReason: "error", content: "当前失败" },
	]), null, "a failed latest turn must not fall back to an older successful assistant message");
	assert.equal(visibleSessionTitleText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), "[已隐藏]");
	assert.equal(normalizeGeneratedSessionTitle("标题：\"第十八章规划\"\n解释"), "第十八章规划");
	assert.equal(normalizeGeneratedSessionTitle("x"), null);
}
