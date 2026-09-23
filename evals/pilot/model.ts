import type { Model } from "@mariozechner/pi-ai";
import { digest } from "../core/io.js";
import { PILOT_MODEL } from "./policy.js";

export type OutputField = "max_tokens" | "max_completion_tokens";
export interface PublicPilotModel {
	provider: string; id: string; api: "openai-completions";
	contextWindow: number; maxTokens: number; outputField: OutputField;
	reasoning: boolean; compatSha256: string;
}
const fail = (): never => { throw new Error("PILOT_MODEL_INVALID"); };
const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
	return value as Record<string, unknown>;
};
type EffectiveCompat = NonNullable<Model<"openai-completions">["compat"]> & {
	reasoningEffortMap: Record<string, string>;
	openRouterRouting: Record<string, unknown>;
	vercelGatewayRouting: Record<string, unknown>;
};

/** Mirrors pinned pi-ai 0.63.1 openai-completions detectCompat for the fields
 * that can change payload semantics when the worker later receives a sentinel URL. */
function detectedCompat(provider: string, baseUrl: string): EffectiveCompat {
	const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
	const isNonStandard = provider === "cerebras" || baseUrl.includes("cerebras.ai")
		|| provider === "xai" || baseUrl.includes("api.x.ai") || baseUrl.includes("chutes.ai")
		|| baseUrl.includes("deepseek.com") || isZai || provider === "opencode" || baseUrl.includes("opencode.ai");
	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: !isNonStandard,
		supportsReasoningEffort: !isGrok && !isZai,
		reasoningEffortMap: {},
		supportsUsageInStreaming: true,
		maxTokensField: baseUrl.includes("chutes.ai") ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		thinkingFormat: isZai ? "zai" : provider === "openrouter" || baseUrl.includes("openrouter.ai") ? "openrouter" : "openai",
		openRouterRouting: {}, vercelGatewayRouting: {}, supportsStrictMode: true,
	};
}

/** Pure single-model projection. Does not read files, resolve auth, execute commands or discover providers. */
export function projectPilotModel(config: unknown): { publicModel: PublicPilotModel; runtimeModel: Model<"openai-completions"> } {
	const providers = object(object(config).providers);
	const provider = object(providers[PILOT_MODEL.provider]);
	if (!Array.isArray(provider.models)) return fail();
	const matches = provider.models.filter((value) => object(value).id === PILOT_MODEL.id);
	if (matches.length !== 1) return fail();
	const model = object(matches[0]);
	const api = model.api ?? provider.api;
	if (api !== PILOT_MODEL.api || provider.headers || model.headers || provider.authHeader || provider.oauth || model.input && JSON.stringify(model.input) !== '["text"]') return fail();
	const baseUrl = model.baseUrl ?? provider.baseUrl;
	if (typeof baseUrl !== "string" || baseUrl.length > 2048) return fail();
	let url: URL; try { url = new URL(baseUrl); } catch { return fail(); }
	if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) return fail();
	// Check the original spelling too: URL normalizes numeric IPv4 aliases,
	// encoded hostnames and backslashes before exposing hostname/href.
	if (url.protocol === "http:" && (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(baseUrl)
		|| /[\u0000-\u0020\u007f\\]/.test(baseUrl)
		|| !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return fail();
	if (model.contextWindow !== PILOT_MODEL.contextWindow || !Number.isSafeInteger(model.maxTokens) || (model.maxTokens as number) < PILOT_MODEL.maxTokens) return fail();
	if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") return fail();
	const rawCompat = model.compat === undefined ? {} : object(model.compat);
	const booleanFields = ["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming", "supportsStrictMode", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText"];
	for (const [key, value] of Object.entries(rawCompat)) {
		if (key === "maxTokensField") { if (value !== "max_tokens" && value !== "max_completion_tokens") return fail(); }
		else if (!booleanFields.includes(key) || typeof value !== "boolean") return fail();
	}
	if (rawCompat.supportsUsageInStreaming === false) return fail();
	const detected = detectedCompat(PILOT_MODEL.provider, url.href);
	const outputField = (rawCompat.maxTokensField ?? detected.maxTokensField) as OutputField;
	const compat: EffectiveCompat = {
		...detected, ...rawCompat,
		maxTokensField: outputField, supportsUsageInStreaming: true,
		// These structured fields are intentionally not accepted from private config.
		reasoningEffortMap: detected.reasoningEffortMap,
		openRouterRouting: detected.openRouterRouting,
		vercelGatewayRouting: detected.vercelGatewayRouting,
		thinkingFormat: detected.thinkingFormat,
	};
	// Explicit construction prevents endpoint/credential/other-provider data leaking into artifacts.
	const publicModel: PublicPilotModel = { provider: PILOT_MODEL.provider, id: PILOT_MODEL.id, api: PILOT_MODEL.api,
		contextWindow: PILOT_MODEL.contextWindow, maxTokens: PILOT_MODEL.maxTokens, reasoning: model.reasoning === true, outputField, compatSha256: digest(compat) };
	return { publicModel, runtimeModel: {
		provider: PILOT_MODEL.provider, id: PILOT_MODEL.id, name: PILOT_MODEL.id, api: PILOT_MODEL.api,
		baseUrl: url.href.replace(/\/$/, ""), reasoning: model.reasoning === true, input: ["text"],
		contextWindow: PILOT_MODEL.contextWindow, maxTokens: PILOT_MODEL.maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat,
	} };
}
