/** Additive S3 lifecycle contract. Never changes the sealed v1 policy or task IDs. */
export const LIFE_PROFILES = ["sdk-b1-reliability", "sdk-b2-context", "sdk-b3-checkpoint-ops-v2"] as const;
export type LifeProfile = typeof LIFE_PROFILES[number];
export const LIFE_TASKS = ["auto-threshold", "auto-overflow", "write-acklost", "write-partial", "write-missing", "write-after-compact"] as const;
export type LifeTask = typeof LIFE_TASKS[number];
export const LIFE_SCENARIOS = ["normal", "summary-error", "summary-cancel", "summary-limit", "overflow-repeat", "intent-persistence", "result-persistence"] as const;
export type LifeScenario = typeof LIFE_SCENARIOS[number];
export const LIFE_LIMITS = Object.freeze({ requests: 16, tools: 16, outerBytes: 131072, timeoutMs: 45000, reserveTokens: 2048, keepRecentTokens: 128, repetitions: 3 });
export const LIFE_TARGET = "drafts/candidates/sdk-lifecycle-probe.md";
export const LIFE_CONTENT = "phase5-lifecycle: ready\n";
export const LIFE_PARTIAL = "phase5-lifecycle: partial\n";
export const LIFE_METRICS = "pi.sdk-lifecycle.operations";
export const LIFE_FAULT = "pi.sdk-lifecycle.persistence-fault";
export const LIFE_PROMPTS = {
	seed: "Read canon/world.md. Keep its source dependency; do not write yet.",
	history: "Preserve source and unresolved operation constraints. " + "public history ".repeat(128),
	continue: "Confirm you can continue using the compacted history. Do not call any tool.",
	write: `Write ${JSON.stringify(LIFE_CONTENT)} to ${LIFE_TARGET} exactly once. Do not repeat an already satisfied or unresolved write.`,
	refresh: "Refresh the checkpoint if available. A refresh is not permission to replay an unknown write.",
};
export const isWriteTask = (task: LifeTask) => task.startsWith("write-");
export const lifePlan = () => [1, 2, 3].flatMap(repetition => LIFE_TASKS.flatMap((task, index) =>
	(index % 2 ? [...LIFE_PROFILES].reverse() : [...LIFE_PROFILES]).map(profile => ({ runId: `${profile}-${task}-r${repetition}`, profile, task, repetition }))));
export type LifeRun = ReturnType<typeof lifePlan>[number];
export const lifeExpected = (run: LifeRun) => !isWriteTask(run.task) || run.profile === "sdk-b3-checkpoint-ops-v2" ? "pass" : "fail";
