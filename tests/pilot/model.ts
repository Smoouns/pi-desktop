import assert from "node:assert/strict";
import { projectPilotModel } from "../../evals/pilot/model.js";
import { PILOT_MODEL } from "../../evals/pilot/policy.js";

export async function runModelProjectionTests(): Promise<number> {
	let count = 0;
	const config = () => ({ providers: { [PILOT_MODEL.provider]: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "DO_NOT_PERSIST_KEY_CANARY", models: [{ id: PILOT_MODEL.id, contextWindow: 262144, maxTokens: 16384 }] }, privateOther: { apiKey: "OTHER_CREDENTIAL_CANARY" } } });
	const original = config(), before = JSON.stringify(original), result = projectPilotModel(original);
	assert.equal(result.runtimeModel.maxTokens, 2048); assert.equal(JSON.stringify(original), before);
	assert.doesNotMatch(JSON.stringify(result.publicModel), /CANARY|baseUrl|127\.0\.0\.1|apiKey|privateOther/); count++;
	assert.equal(result.publicModel.outputField, "max_completion_tokens"); count++;
	assert.deepEqual(result.runtimeModel.compat, {
		supportsStore: true, supportsDeveloperRole: true, supportsReasoningEffort: true, reasoningEffortMap: {},
		supportsUsageInStreaming: true, maxTokensField: "max_completion_tokens", requiresToolResultName: false,
		requiresAssistantAfterToolResult: false, requiresThinkingAsText: false, thinkingFormat: "openai",
		openRouterRouting: {}, vercelGatewayRouting: {}, supportsStrictMode: true,
	}); count++;
	for (const [baseUrl, expected] of [
		["https://api.deepseek.com/v1", { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_completion_tokens", thinkingFormat: "openai" }],
		["https://llm.chutes.ai/v1", { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens", thinkingFormat: "openai" }],
		["https://api.z.ai/v1", { supportsReasoningEffort: false, maxTokensField: "max_completion_tokens", thinkingFormat: "zai" }],
		["https://openrouter.ai/api/v1", { supportsStore: true, supportsReasoningEffort: true, maxTokensField: "max_completion_tokens", thinkingFormat: "openrouter" }],
	] as const) {
		const value = config(); value.providers[PILOT_MODEL.provider].baseUrl = baseUrl;
		const projected = projectPilotModel(value);
		for (const [key, wanted] of Object.entries(expected)) assert.equal((projected.runtimeModel.compat as Record<string, unknown>)[key], wanted, `${baseUrl}:${key}`);
		assert.equal(projected.publicModel.outputField, expected.maxTokensField); count++;
	}
	{
		const value = config(); value.providers[PILOT_MODEL.provider].baseUrl = "https://api.deepseek.com/v1";
		Object.assign(value.providers[PILOT_MODEL.provider].models[0], { compat: { supportsStore: true, supportsStrictMode: false, requiresToolResultName: true, maxTokensField: "max_tokens" } });
		const projected = projectPilotModel(value);
		assert.equal(projected.runtimeModel.compat?.supportsStore, true); assert.equal(projected.runtimeModel.compat?.supportsStrictMode, false);
		assert.equal(projected.runtimeModel.compat?.requiresToolResultName, true); assert.equal(projected.runtimeModel.compat?.maxTokensField, "max_tokens");
		assert.equal(projected.runtimeModel.compat?.thinkingFormat, "openai"); count++;
	}
	for (const change of [
		(c: any) => { c.providers[PILOT_MODEL.provider].models[0].contextWindow = 1; },
		(c: any) => { c.providers[PILOT_MODEL.provider].models.push(c.providers[PILOT_MODEL.provider].models[0]); },
		(c: any) => { c.providers[PILOT_MODEL.provider].baseUrl = "https://user:secret@example.invalid/v1"; },
		(c: any) => { c.providers[PILOT_MODEL.provider].baseUrl = "http://example.invalid/v1"; },
		(c: any) => { c.providers[PILOT_MODEL.provider].models[0].compat = { supportsUsageInStreaming: false }; },
		(c: any) => { c.providers[PILOT_MODEL.provider].headers = { Authorization: "CANARY" }; },
		(c: any) => { c.providers[PILOT_MODEL.provider].models[0].compat = { secret: "CANARY" }; },
	]) { const value = config(); change(value); assert.throws(() => projectPilotModel(value), /^Error: PILOT_MODEL_INVALID$/); count++; }
	return count;
}
