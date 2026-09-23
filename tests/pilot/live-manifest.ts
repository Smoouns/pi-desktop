import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLiveManifest, liveAuthorizationToken, liveManifestDigest, LIVE_AUTHORIZATION_ACKNOWLEDGEMENT, LiveManifestError, readLiveManifest, validateLiveAuthorization, validateLiveManifest, writeLiveManifest, type PreparedFingerprint } from "../../evals/pilot/live-manifest.js";
import { PILOT_TASK_IDS } from "../../evals/pilot/policy.js";

const h = (letter: string) => letter.repeat(64);
const input = () => ({ executionMode: "live" as const, batchId: "live-test", createdAt: "2026-09-22T00:00:00.000Z", outputField: "max_tokens" as const, reasoning: false, compatibilitySha256: h("7"), endpointSha256: h("a"), configSha256: h("6"),
	code: { commit: "abc123", dirty: true, files: { "evals/pilot/policy.ts": h("b") }, sha256: "" }, fixture: { files: { "README.md": h("c") }, sha256: "" },
	prepared: Object.fromEntries(PILOT_TASK_IDS.map((id, index) => [id, { toolsSha256: h(String(index + 1)), systemSha256: h("d"), promptSha256: h("e"), roleSha256: h("f"), extensionSha256: h("0") }])) as Record<(typeof PILOT_TASK_IDS)[number], PreparedFingerprint>,
	runtime: { node: "v24", platform: "win32", arch: "x64", piSdk: "0.63.1", lockSha256: h("9") }, estimator: { kind: "pilot-estimator", version: "1", units: "estimated_tokens" as const, maxInputBytes: 262144 } });
const digestMap = async (value: Record<string, string>) => { const { createHash } = await import("node:crypto"); return createHash("sha256").update(JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))).digest("hex"); };
async function manifest() { const value = input(); value.code.sha256 = await digestMap(value.code.files); value.fixture.sha256 = await digestMap(value.fixture.files); return createLiveManifest(value); }
const error = (code: string) => (value: unknown) => value instanceof LiveManifestError && value.code === code;

export async function runLiveManifestTests(): Promise<number> {
	let count = 0; const value = await manifest(); assert.equal(validateLiveManifest(value).kind, "pilot-live-manifest"); count += 1;
	const sha = liveManifestDigest(value), approval = liveAuthorizationToken(sha); assert.equal(validateLiveAuthorization(sha, approval, new Date("2026-09-22T01:00:00Z"), value), true); count += 1;
	assert.match(LIVE_AUTHORIZATION_ACKNOWLEDGEMENT, /at most 8 live HTTP calls/); assert.doesNotMatch(LIVE_AUTHORIZATION_ACKNOWLEDGEMENT, /exactly 8/); count += 1;
	assert.throws(() => validateLiveAuthorization(sha, `${approval} `, new Date("2026-09-22T01:00:00Z"), value), error("LIVE_AUTHORIZATION_REQUIRED")); count += 1;
	assert.throws(() => validateLiveAuthorization(h("8"), liveAuthorizationToken(h("8")), new Date("2026-09-22T01:00:00Z"), value), error("LIVE_MANIFEST_DRIFT")); count += 1;
	assert.throws(() => validateLiveAuthorization(sha, approval, new Date("2026-09-24T00:00:00Z"), value), error("LIVE_AUTHORIZATION_EXPIRED")); count += 1;
	assert.throws(() => validateLiveAuthorization(sha, approval, new Date(value.expiresAt), value), error("LIVE_AUTHORIZATION_EXPIRED")); count += 1;
	const dryRun = createLiveManifest({ ...input(), code: value.code, fixture: value.fixture, executionMode: "dry-run" }); const drySha = liveManifestDigest(dryRun);
	assert.throws(() => validateLiveAuthorization(drySha, liveAuthorizationToken(drySha), new Date("2026-09-22T01:00:00Z"), dryRun), error("LIVE_DRY_RUN_NOT_AUTHORIZABLE")); count += 1;
	const directory = await mkdtemp(path.join(process.cwd(), "artifacts", "harness", "live-manifest-")), filename = path.join(directory, "live-manifest.json");
	assert.equal(await writeLiveManifest(filename, value), sha); assert.equal((await readLiveManifest(filename)).sha256, sha); count += 2;
	await assert.rejects(() => writeLiveManifest(filename, value), (reason: unknown) => (reason as NodeJS.ErrnoException).code === "EEXIST"); count += 1;
	const tampered = JSON.parse(JSON.stringify(value)); tampered.limits.maxHttpRequests = 9; assert.throws(() => validateLiveManifest(tampered), error("LIVE_LIMITS")); count += 1;
	await writeFile(path.join(directory, "oversize.json"), "x".repeat(1025)); await assert.rejects(() => readLiveManifest(path.join(directory, "oversize.json"), 1024), error("LIVE_MANIFEST_FILE")); count += 1;
	await assert.rejects(() => readLiveManifest(filename, Number.NaN), error("LIVE_MANIFEST_READ_LIMIT")); count += 1;
	assert.equal(JSON.stringify(value).includes("https://"), false); count += 1;
	return count;
}
