import assert from "node:assert/strict";

export type ExecutionProfile = "joint" | "tool-none" | "joint-tool-none" | "joint-enum-v2" | "joint-upstream" | "read-upstream";
export const profiles = {
	joint: { name: "joint", liveAllowed: true, manifestKind: "e8-full-extension-live-manifest/v1", prefix: "prepared-", planFile: "docs/REVIEW_E_LIVE_VALIDATION_PLAN.json",
		stages: [{ id: "u", task: "E8-U" }, { id: "c-control", task: "E8-C" }, { id: "c-treatment", task: "E8-C" }, { id: "r", task: "E8-R" }],
		probeRequests: 14, noCacheReservationReferenceUsd: 1.363968 },
	"tool-none": { name: "tool-none", liveAllowed: true, manifestKind: "e8-tool-none-diagnostic-manifest/v1", prefix: "tool-none-", planFile: "docs/REVIEW_E_TOOL_PROTOCOL_PLAN.json",
		stages: [{ id: "tool-none", task: "E8-TOOL-NONE" }], probeRequests: 1, noCacheReservationReferenceUsd: 0.013824 },
	"joint-tool-none": { name: "joint-tool-none", liveAllowed: true, manifestKind: "e8-joint-tool-none-live-manifest/v1", prefix: "joint-tool-none-", planFile: "docs/REVIEW_E_JOINT_TOOL_NONE_PLAN.json",
		stages: [{ id: "u", task: "E8-U" }, { id: "c-control", task: "E8-C" }, { id: "c-treatment", task: "E8-C" }, { id: "r", task: "E8-R" }],
		probeRequests: 14, noCacheReservationReferenceUsd: 1.363968 },
	"joint-enum-v2": { name: "joint-enum-v2", liveAllowed: false, manifestKind: "e8-joint-enum-offline-manifest/v2", prefix: "joint-enum-v2-", planFile: "docs/REVIEW_E_ENUM_V2_PLAN.json",
		stages: [{ id: "u", task: "E8-U" }, { id: "c-control", task: "E8-C" }, { id: "c-treatment", task: "E8-C" }, { id: "r", task: "E8-R" }],
		probeRequests: 14, noCacheReservationReferenceUsd: 1.363968 },
	"joint-upstream": { name: "joint-upstream", liveAllowed: true, manifestKind: "e8-joint-upstream-live-manifest/v1", prefix: "joint-upstream-", planFile: "docs/REVIEW_E_UPSTREAM_PLAN.json",
		stages: [{ id: "u", task: "E8-U" }, { id: "c-control", task: "E8-C" }, { id: "c-treatment", task: "E8-C" }, { id: "r", task: "E8-R" }],
		probeRequests: 14, noCacheReservationReferenceUsd: 8.552448 },
	"read-upstream": { name: "read-upstream", liveAllowed: true, manifestKind: "e8-read-upstream-live-manifest/v1", prefix: "read-upstream-", planFile: "docs/REVIEW_E_READ_RETEST_PLAN.json",
		stages: [{ id: "r", task: "E8-R" }], probeRequests: 8, noCacheReservationReferenceUsd: 4.276224 },
} as const;
export function executionProfile(name: unknown = "joint") {
	assert.ok(name === "joint" || name === "tool-none" || name === "joint-tool-none" || name === "joint-enum-v2" || name === "joint-upstream" || name === "read-upstream", "E8_EXECUTION_PROFILE_INVALID");
	return profiles[name];
}

/** No production/global policy. These are the only new-profile no-tools stages. */
export function jointExplicitNone(profile: unknown, scenario: string) {
	return jointNoToolsProfile(profile) && ["u", "c-control", "c-treatment"].includes(scenario);
}
export function enumeratedStateProfile(profile: unknown) { return profile === "joint-enum-v2" || profile === "joint-upstream"; }
export function jointNoToolsProfile(profile: unknown) { return profile === "joint-tool-none" || enumeratedStateProfile(profile); }
// User opted into the gateway's existing policy, not a claim that the client
// parameter is enforced. Conservative sum covers the pinned SDK's accounting.
export const upstreamBudget = { maxOutputTokens: 65536, thinkingBudget: 16384, outputReservation: 81920 } as const;
export function upstreamBudgetProfile(profile: unknown) { return profile === "joint-upstream" || profile === "read-upstream"; }
export function outputReservationFor(profile: unknown, clientLimit: number) {
	assert.ok(Number.isSafeInteger(clientLimit) && clientLimit > 0, "E8_INVALID_CLIENT_OUTPUT_LIMIT");
	if (!upstreamBudgetProfile(profile)) return clientLimit;
	assert.ok(clientLimit <= upstreamBudget.outputReservation, "E8_CLIENT_OUTPUT_EXCEEDS_UPSTREAM_RESERVATION");
	return upstreamBudget.outputReservation;
}
export function profileForManifest(kind: unknown) {
	const profile = Object.values(profiles).find(p => p.manifestKind === kind);
	assert.ok(profile, "E8_MANIFEST_KIND_INVALID"); return profile;
}
