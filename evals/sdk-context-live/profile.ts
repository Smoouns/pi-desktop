import assert from "node:assert/strict";
import { digest, sha256 } from "../core/io.js";
import { auditLifecycleInventory, lifecycleExtensionSource } from "../sdk-context/lifecycle-extension.js";
import { LIMITS as OLD_LIMITS } from "../sdk-context/policy.js";
import { PRODUCT_LIMITS, PROFILES, type Profile } from "./policy.js";

export function baseProfile(profile: Profile) { return profile === PROFILES[0] ? "sdk-b2-context" as const : "sdk-b3-checkpoint-ops-v2" as const; }
/** Same frozen factories and versioned eval-only wiring; only the declared
 * context budget changes. Do not relabel this as the original S3 profile. */
export function profileSource(profile: Profile) {
	assert.ok(PROFILES.includes(profile)); const source = lifecycleExtensionSource(baseProfile(profile)), old = `limits:${JSON.stringify(OLD_LIMITS)}`;
	assert.equal(source.split(old).length, 2); return source.replace(old, `limits:${JSON.stringify(PRODUCT_LIMITS)}`);
}
export function auditProfile(profile: Profile, loaded: any, source: string) {
	assert.equal(sha256(source), sha256(profileSource(profile)));
	// Inventory is unchanged by the explicitly versioned budget substitution.
	auditLifecycleInventory(baseProfile(profile), loaded, lifecycleExtensionSource(baseProfile(profile)));
}
export const schemaDigest = (tools: readonly { name: string; description: string; parameters: unknown }[]) => digest(tools.map(({ name, description, parameters }) => ({ name, description, parameters })).sort((a, b) => a.name.localeCompare(b.name)));
