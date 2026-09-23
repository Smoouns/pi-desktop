import type { Model } from "@mariozechner/pi-ai";
import { freezeRequestPolicy } from "../core/request-policy.js";

/** Offline transport preflight, not a new authorization to use S2's remaining quota. */
export const SCENARIOS = ["manual", "split", "threshold", "summary-http-error", "summary-missing-usage", "summary-cancel", "summary-limit", "split-limit", "summary-timeout", "ordinary-cancel"] as const;
export type Scenario = typeof SCENARIOS[number];
export type RequestKind = "ordinary" | "summary";
export const TASK_ID = "S3T-CTX-001";
export const ENDPOINT = "https://s3-transport.invalid/v1/chat/completions";
export const MODEL: Model<"openai-completions"> = {
	id: "synthetic-s3-transport", name: "Synthetic S3 transport", api: "openai-completions", provider: "synthetic-s3-transport",
	baseUrl: "https://s3-transport.invalid/v1", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 2048,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true, supportsDeveloperRole: true, supportsReasoningEffort: false },
};
export const LIMITS = Object.freeze({ maxHttpRequests: 6, maxTaskHttpRequests: 6, maxInputTokens: 32768, maxInputBytes: 32768,
	maxOutputTokens: 2048, safetyMargin: 512, maxTotalInputTokens: 196608, maxTotalOutputTokens: 8192,
	requestTimeoutMs: 5000, taskTimeoutMs: 20000, batchTimeoutMs: 30000, maxResponseBytes: 32768, maxTaskTools: 1 });
export const VERSION = Object.freeze({ transport: "sdk-native-summary-broker-v1", driver: "synthetic-sse-real-provider-v1", estimator: "serialized-utf8-bytes-upper-bound-v1",
	summary: "native-sdk-compaction", output: "bounded-exact-serialized-field-v1", queue: "serial-dispatch-two-summary-offers-v1" });
export const SYSTEM = "Test public synthetic conversation compaction. No file access, tools, chapter drafting, or approvals. Reply briefly.";
export const SEED_USER = "Public synthetic history. ".repeat(120);
export const SEED_ASSISTANT = "Public historical acknowledgement. ".repeat(40);
export const PROMPT = "Remember the public marker S3_TRANSPORT_READY. " + "Public recent context. ".repeat(130);
export const CONTINUE = "Continue after the native summary. Reply ready. Do not request tools.";
export const settingsFor = (scenario: Scenario) => ({ compaction: { enabled: scenario === "threshold", reserveTokens: 2048, keepRecentTokens: scenario === "split" || scenario === "split-limit" ? 128 : 512 }, retry: { enabled: false }, enableSkillCommands: false });
export function policyFor(scenario: Scenario) {
	return freezeRequestPolicy({ namespace: "sdk-context-transport-v1", taskIds: [TASK_ID], limits: { ...LIMITS,
		maxTaskHttpRequests: scenario === "summary-limit" ? 1 : scenario === "split-limit" ? 2 : LIMITS.maxTaskHttpRequests,
		requestTimeoutMs: scenario === "summary-timeout" ? 500 : LIMITS.requestTimeoutMs } });
}
export const isSuccessScenario = (scenario: Scenario) => ["manual", "split", "threshold"].includes(scenario);
export const expectedStop = (scenario: Scenario): string | null => ({
	manual: null, split: null, threshold: null, "summary-http-error": "HTTP_FAILURE", "summary-missing-usage": "USAGE_INVALID",
	"summary-cancel": "REQUEST_ABORTED", "summary-limit": "TASK_REQUEST_LIMIT", "split-limit": "TASK_REQUEST_LIMIT",
	"summary-timeout": "REQUEST_TIMEOUT", "ordinary-cancel": "REQUEST_ABORTED",
})[scenario];
