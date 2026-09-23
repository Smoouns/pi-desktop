import { SDK_PROFILES, SDK_TASKS, SDK_PROMPTS, SDK_SYSTEM } from "../sdk-ablation/policy.js";
import { PILOT_MODEL } from "../pilot/policy.js";
import { freezeRequestPolicy } from "../core/request-policy.js";

export const LIVE_RUNS = SDK_TASKS.flatMap((taskId, index) => (index === 0 ? [...SDK_PROFILES] : [...SDK_PROFILES].reverse())
	.map(profile => ({ runId: `${profile}-${taskId}-r1`, profile, taskId, repetition: 1 as const })));
export type LiveRun = typeof LIVE_RUNS[number];
export const LIVE_LIMITS = Object.freeze({ maxHttpRequests: 24, maxTaskHttpRequests: 6, maxInputTokens: 32768, maxInputBytes: 262144,
	maxOutputTokens: 2048, safetyMargin: 4096, maxTotalInputTokens: 786432, maxTotalOutputTokens: 49152,
	requestTimeoutMs: 90000, taskTimeoutMs: 360000, batchTimeoutMs: 1440000, maxResponseBytes: 262144, maxTaskTools: 6 });
export const LIVE_POLICY = freezeRequestPolicy({ namespace: "sdk-ablation-live-v1", taskIds: LIVE_RUNS.map(run => run.runId), limits: LIVE_LIMITS });
export const LIVE_MODEL = PILOT_MODEL;
export const LIVE_PROMPTS = SDK_PROMPTS;
export const LIVE_SYSTEM = SDK_SYSTEM;
export const LIVE_VERSION = Object.freeze({ task: "sdk-read-write-v2", driver: "provider-selected-tools-v1", fault: "first-successful-native-write-ack-lost-v1",
	answer: "strict-json-source-order-trim-ready-v1", stop: "ordinary-fail-continue-safety-unknown-stop-v1" });
export const LIVE_SETTINGS = Object.freeze({ retry: false, compaction: false, sessionTitle: false, skills: false, discovery: false });
export const LIVE_ACK = "I authorize at most 24 live HTTP calls for this SDK slice manifest and acknowledge that provider cost is unknown.";
export const LIVE_TTL = 86400000;
export const LIVE_CHECKS = ["profile", "settings", "role", "boundary", "files", "read", "singleWrite", "normalStop", "answer", "limits"] as const;
export const LIVE_REASONS = ["PASS", "TASK_FAILED", "SAFETY_STOP", "WRITE_UNKNOWN", "WORKER_UNKNOWN", "SOURCE_DRIFT", "BATCH_STOPPED"] as const;
