import assert from "node:assert/strict";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { digest } from "./journal.js";
import { loadConfig } from "./model-projection.js";
import { profileForManifest, profiles } from "./protocol-profile.js";

export const PREPARED_PARENT = "artifacts/harness/review-e8";
export const hashObject = (value: unknown) => digest(JSON.stringify(value));
export function ownedPath(root: string, name: string) {
	assert.ok(name && !path.isAbsolute(name) && !name.split(/[\\/]/).includes(".."), "E8_UNSAFE_PATH");
	const target = path.resolve(root, name), relative = path.relative(path.resolve(root), target);
	assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "E8_OUTSIDE_ROOT");
	let current = target;
	while (current !== path.dirname(current)) { if (existsSync(current)) assert.ok(!lstatSync(current).isSymbolicLink(), "E8_LINKED_PATH"); current = path.dirname(current); }
	return target;
}
export function writeNew(file: string, value: string) {
	mkdirSync(path.dirname(file), { recursive: true });
	const fd = openSync(file, "wx", 0o600);
	try { writeFileSync(fd, value, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
}
export function safeJson(file: string, max = 4 * 1024 * 1024) {
	const stat = lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= max, "E8_FILE_INVALID");
	try { return JSON.parse(readFileSync(file, "utf8")); } catch { throw Error("E8_JSON_INVALID"); }
}
function tree(root: string, relative: string, output: Record<string, string>) {
	for (const item of readdirSync(ownedPath(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
		const name = relative + "/" + item.name; assert.ok(!item.isSymbolicLink(), "E8_LINKED_SOURCE");
		if (item.isDirectory()) tree(root, name, output);
		else if (/\.(?:ts|js|mjs|cjs|json|node|exe|wasm)$/.test(name) || item.name === "esbuild") output[name] = digest(readFileSync(ownedPath(root, name)));
	}
}
export function sourceManifest(root = process.cwd()) {
	const source: Record<string, string> = {};
	for (const folder of ["src", "tests/harness/review-e-live", "evals/core", "evals/pilot"]) tree(root, folder, source);
	for (const file of ["package.json", "package-lock.json", "scripts/run-review-e8.mjs", "scripts/run-public-tests.mjs", "scripts/eval-network-guard.mjs", "scripts/pilot-broker-network.mjs", "tests/support/loopback-http.ts", "docs/REVIEW_E_LIVE_VALIDATION_PLAN.json"]) source[file] = digest(readFileSync(ownedPath(root, file)));
	for (const profile of Object.values(profiles)) source[profile.planFile] = digest(readFileSync(ownedPath(root, profile.planFile)));
	const dependencies: Record<string, string> = {};
	for (const pkg of ["@mariozechner/pi-coding-agent", "@mariozechner/pi-ai", "@mariozechner/pi-agent-core", "@mariozechner/pi-tui", "openai", "jiti", "yaml", "@sinclair/typebox", "esbuild", "@esbuild/" + process.platform + "-" + process.arch]) tree(root, "node_modules/" + pkg, dependencies);
	assert.equal(safeJson(path.join(root, "node_modules/@mariozechner/pi-coding-agent/package.json")).version, "0.63.1");
	return { source, dependencies, runtime: { node: process.version, platform: process.platform, arch: process.arch, executableSha256: digest(readFileSync(process.execPath)), piSdk: "0.63.1" } };
}
export function verifyFiles(root: string, files: Record<string, string>, code: string) {
	for (const [name, expected] of Object.entries(files)) {
		assert.match(expected, /^[a-f0-9]{64}$/); const target = ownedPath(root, name);
		assert.equal(digest(readFileSync(target)), expected, code + ":" + name);
	}
}
export function inspectPrepared(file: string, privateConfig: string, expectedSha?: string, now = Date.now()) {
	const root = process.cwd(), parent = realpathSync(path.join(root, PREPARED_PARENT)), dir = realpathSync(path.dirname(file));
	assert.equal(path.dirname(dir), parent, "E8_MANIFEST_LOCATION");
	assert.equal(path.resolve(file), path.join(dir, "manifest.json"), "E8_MANIFEST_LOCATION");
	const manifest = safeJson(file), sha256 = digest(readFileSync(file));
	const profile = profileForManifest(manifest.kind);
	assert.match(path.basename(dir), new RegExp("^" + profile.prefix + "[A-Za-z0-9]+$"), "E8_MANIFEST_LOCATION");
	assert.equal(manifest.executionProfile ?? "joint", profile.name, "E8_MANIFEST_PROFILE_MISMATCH");
	assert.equal(manifest.liveAllowed ?? true, profile.liveAllowed, "E8_MANIFEST_LIVE_POLICY_MISMATCH");
	if (expectedSha !== undefined) assert.equal(sha256, expectedSha, "E8_APPROVAL_HASH_MISMATCH");
	assert.equal(manifest.batchDirectory, path.relative(root, dir).replaceAll("\\", "/"), "E8_MANIFEST_COPY_NOT_AUTHORIZED");
	assert.equal(manifest.approval.granted, false); assert.equal(manifest.approval.singleUse, true);
	assert.ok(Number.isSafeInteger(now) && now >= manifest.createdAt && now < manifest.expiresAt, "E8_APPROVAL_EXPIRED_OR_CLOCK_REVERSED");
	assert.equal(manifest.expiresAt - manifest.createdAt, 24 * 3600_000);
	assert.equal(manifest.runtime.node, process.version); assert.equal(manifest.runtime.platform, process.platform); assert.equal(manifest.runtime.arch, process.arch);
	assert.equal(manifest.runtime.executableSha256, digest(readFileSync(process.execPath)), "E8_RUNTIME_DRIFT");
	verifyFiles(root, manifest.source, "E8_SOURCE_DRIFT"); verifyFiles(root, manifest.dependencies, "E8_DEPENDENCY_DRIFT");
	verifyFiles(dir, manifest.assets, "E8_ASSET_DRIFT");
	const projection = loadConfig(privateConfig);
	assert.equal(projection.configSha256, manifest.configSha256, "E8_SELECTED_CONFIG_DRIFT");
	assert.equal(projection.publicProjection.endpointSha256, manifest.model.endpointSha256);
	assert.deepEqual(manifest.policy, safeJson(path.join(root, profile.planFile)).policy, "E8_POLICY_DRIFT");
	return { manifest, dir, sha256, projection, profile };
}
export function authorizePrepared(file: string, config: string, approval: string, unknownCost: boolean, now = Date.now()) {
	assert.match(approval, /^[a-f0-9]{64}$/, "E8_EXPLICIT_APPROVAL_REQUIRED");
	assert.equal(unknownCost, true, "E8_UNKNOWN_COST_ACK_REQUIRED");
	const value = inspectPrepared(file, config, approval, now);
	assert.equal(value.profile.liveAllowed, true, "E8_OFFLINE_ONLY_PROFILE");
	// Consumption is durable before anybody is allowed to resolve a credential.
	// Failed execution still consumes the batch; a copied directory is invalid.
	const receipt = { kind: "e8-single-use-approval/v1", manifestSha256: approval, acceptedUnknownCost: true, consumedAt: now, batchDirectory: value.manifest.batchDirectory };
	writeNew(path.join(value.dir, "authorization-consumed.json"), JSON.stringify(receipt) + "\n");
	return value;
}
export function activatePrepared(file: string, config: string, approval: string) {
	const value = inspectPrepared(file, config, approval);
	assert.equal(value.profile.liveAllowed, true, "E8_OFFLINE_ONLY_PROFILE");
	const receipt = safeJson(path.join(value.dir, "authorization-consumed.json"));
	assert.equal(receipt.kind, "e8-single-use-approval/v1"); assert.equal(receipt.manifestSha256, approval); assert.equal(receipt.acceptedUnknownCost, true);
	assert.equal(receipt.batchDirectory, value.manifest.batchDirectory);
	assert.ok(receipt.consumedAt >= value.manifest.createdAt && receipt.consumedAt < value.manifest.expiresAt && receipt.consumedAt <= Date.now());
	writeNew(path.join(value.dir, "execution-started.json"), JSON.stringify({ manifestSha256: approval, startedAt: Date.now(), replayAllowed: false }) + "\n");
	return value;
}
