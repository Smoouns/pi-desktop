// Read back D-07 evidence after manual native-window acceptance. This does not
// drive the UI and cannot certify visibility; record those observations separately.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const repo = process.cwd();
const work = path.resolve(process.argv[2] ?? "");
const restoredAfter = process.argv[3];
const relative = path.relative(path.join(repo, "artifacts/harness/native-desktop"), work);
assert.match(relative, /^d7-[a-z0-9]+$/i, "Pass one prepared D-07 directory, not a user project");
assert.ok(restoredAfter && Number.isFinite(Date.parse(restoredAfter)), "Pass the observed cold-relaunch time (ISO)");
const setup = JSON.parse(await readFile(path.join(work, "setup.json"), "utf8"));
assert.equal(setup.work, work);
const hash = data => createHash("sha256").update(data).digest("hex");
async function manifest(root) {
	const files = {};
	async function visit(dir) {
		for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
			const name = path.join(dir, entry.name);
			assert.ok(!entry.isSymbolicLink(), "Unexpected link in evidence tree");
			if (entry.isDirectory()) await visit(name);
			else files[name.replaceAll("\\", "/")] = hash(await readFile(path.join(root, name)));
		}
	}
	await visit(""); return files;
}
const originalFixture = await manifest(path.join(repo, "fixtures/harness-novel"));
assert.deepEqual(originalFixture, setup.originalFixture, "Committed public fixture changed");
assert.deepEqual(await manifest(path.join(process.env.USERPROFILE, ".pi/agent/extensions")), setup.originalGlobalExtensions, "Global Pi extensions changed");
const projects = {};
for (const name of ["project-a", "project-b"]) {
	const actual = await manifest(path.join(work, name));
	for (const [file, sha] of Object.entries(originalFixture)) assert.equal(actual[file], sha, `${name}/${file} changed`);
	const added = Object.keys(actual).filter(file => !(file in originalFixture)).sort();
	assert.deepEqual(added, name === "project-a"
		? [".novel/tools/verify-novel-chapter.ts", "planning/verifications/002-verification.md"]
		: [".novel/tools/verify-novel-chapter.ts"]);
	assert.equal(actual[".novel/tools/verify-novel-chapter.ts"], hash(await readFile(path.join(repo, "scripts/verify-novel-chapter.ts"))));
	projects[name] = { unchangedOriginalFiles: Object.keys(originalFixture).length, added, files: actual };
}
const report = await readFile(path.join(work, "project-a/planning/verifications/002-verification.md"), "utf8");
assert.match(report, /^verification_status: PASS$/m);
assert.match(report, /^mode: full$/m);
assert.match(report, new RegExp(`^source_sha256: ${originalFixture["drafts/candidates/chapters/002.md"]}$`, "m"));

const records = [];
const rpcFiles = (await readdir(work)).filter(file => /^rpc-\d+\.jsonl$/.test(file));
for (const file of rpcFiles) {
	const lines = (await readFile(path.join(work, file), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
	for (const line of lines) {
		assert.ok([path.join(work, "project-a"), path.join(work, "project-b")].includes(line.root));
		if (line.networkAttempts !== undefined) assert.equal(line.networkAttempts, 0);
	}
	records.push(...lines);
}
records.sort((a, b) => a.at.localeCompare(b.at));
const ends = records.filter(e => e.event === "agent_end");
assert.equal(ends.length, 4, "Expected A read, A cancel, A verifier, and B read only");
const [readA, cancelA, verifiedA, readB] = ends;
assert.equal(readA.status.reasonCode, "UNBOUND_REPLY");
assert.equal(cancelA.status.reasonCode, "AGENT_ABORTED");
assert.equal(cancelA.status.state, "CANCELLED");
assert.equal(cancelA.status.toolCalls, 0);
assert.equal(cancelA.task.taskId, readA.task.taskId);
assert.equal(cancelA.task.objective, readA.task.objective);
assert.match(cancelA.task.latestUserInstruction, /^D7-CANCEL/);
assert.equal(verifiedA.status.reasonCode, "STOP_VERIFIED");
assert.equal(verifiedA.status.verificationAttempts, 1);
assert.equal(verifiedA.task.completionMode, "candidate_write");
assert.equal(verifiedA.task.owner.role, "write");
assert.deepEqual(verifiedA.task.expectedArtifacts, [{ path: "drafts/candidates/chapters/002.md", verification: "chapter-full", chapter: "002" }]);
assert.equal(verifiedA.task.progress.verifications["drafts/candidates/chapters/002.md"].full, true);
assert.equal(verifiedA.task.progress.verifications["drafts/candidates/chapters/002.md"].sha256, originalFixture["drafts/candidates/chapters/002.md"]);
assert.equal(readB.status.reasonCode, "UNBOUND_REPLY");
assert.equal(readB.root, path.join(work, "project-b"));
assert.notEqual(readB.task.owner.projectId, readA.task.owner.projectId);
assert.equal(verifiedA.task.owner.projectId, readA.task.owner.projectId);
assert.equal(new Set(ends.map(e => e.session)).size, 3);
for (const end of ends) {
	assert.equal(end.status.userAccepted, false);
	assert.equal(end.task.owner.sessionId, end.session);
	assert.doesNotMatch(end.task.objective, /<novel-(?:role|context|task)/);
}
const synthetic = records.filter(e => e.event === "synthetic_request");
assert.equal(synthetic.length, 8);
assert.equal(records.filter(e => e.event === "input").length, 4);
assert.equal(records.filter(e => e.event === "aborted").length, 1);
assert.equal(records.filter(e => e.event === "error").length, 0);
const results = records.filter(e => e.event === "tool_result");
assert.deepEqual(results.map(e => e.name).sort(), ["read", "read", "read", "verify_chapter"]);
assert.ok(results.every(e => e.isError === false));
const restored = records.filter(e => e.root === readA.root && Date.parse(e.at) >= Date.parse(restoredAfter));
assert.ok(restored.filter(e => e.event === "boot").length >= 2, "Missing cold-relaunch evidence");
assert.ok(restored.every(e => e.event === "boot"), "Restore unexpectedly ran an input, provider, or tool");

const sessions = [];
for (const end of [cancelA, verifiedA, readB]) {
	assert.ok(path.relative(setup.agent, end.file).startsWith(`sessions${path.sep}`));
	const entries = (await readFile(end.file, "utf8")).trim().split("\n").map(JSON.parse);
	assert.equal(entries[0].id, end.session);
	assert.equal(entries[0].cwd, end.root);
	const last = type => entries.filter(e => e.customType === type).at(-1)?.data;
	assert.deepEqual(last("pi-desktop-task-contract/v1"), end.task, "Cold restore changed task contract");
	assert.deepEqual(last("pi-desktop-run-status/v1"), end.status, "Cold restore changed terminal status");
	const calls = entries.flatMap(e => e.message?.role === "assistant" ? e.message.content.filter(c => c.type === "toolCall") : []);
	assert.deepEqual(calls.map(c => c.name), end === verifiedA ? ["read", "verify_chapter"] : ["read"]);
	sessions.push({ sessionId: end.session, projectId: end.task.owner.projectId, role: end.task.owner.role, taskId: end.task.taskId, reasonCode: end.status.reasonCode, file: path.relative(work, end.file).replaceAll("\\", "/"), fileSha256: hash(await readFile(end.file)), toolCalls: calls });
}

const rust = await manifest(path.join(repo, "src-tauri/src"));
assert.deepEqual(rust, setup.rustSources, "Production Rust changed after setup");
for (const name of ["lib.rs", "session_file.rs"]) assert.equal(hash(await readFile(path.join(setup.app, "src", name))), rust[name]);
// New evidence directory; initial setup/build hashes are never overwritten.
await mkdir(path.join(work, "audits"), { recursive: true });
const auditDir = await mkdtemp(path.join(work, "audits/check-"));
const bundle = path.join(auditDir, "current-extension.mjs");
await build({ entryPoints: ["src/extensions/novel-tools-extension.ts"], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning" });
const { NOVEL_TOOLS_EXTENSION_CONTENT } = await import(pathToFileURL(bundle).href);
assert.equal(hash(NOVEL_TOOLS_EXTENSION_CONTENT), setup.productionExtensionSha256);
assert.equal(hash(await readFile(path.join(setup.agent, "extensions/novel-tools.ts"))), setup.productionExtensionSha256);
const provider = await build({ entryPoints: ["tests/harness/production-lifecycle/native-provider.ts"], write: false, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning" });
assert.equal(hash(provider.outputFiles[0].contents), hash(await readFile(path.join(setup.agent, "extensions/native-provider.mjs"))), "Native provider differs from reviewed synthetic source");
const sourceFiles = ["src/main.ts", "src/components/runtime-status-cache.ts", "src/components/extension-ui-handler.ts", "tests/harness/production-lifecycle/native-prepare.mjs", "tests/harness/production-lifecycle/native-provider.ts", "tests/harness/production-lifecycle/native-audit.mjs"];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.join(repo, file)))])));
const summary = {
	passed: true, checkedAt: new Date().toISOString(), work, restoredAfter,
	head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
	node: process.version, sdk: JSON.parse(await readFile("node_modules/@mariozechner/pi-coding-agent/package.json", "utf8")).version,
	realModelCalls: 0, syntheticProviderInvocations: synthetic.length, guardedRpcNetworkAttempts: 0,
	toolResults: results.map(e => ({ pid: e.pid, name: e.name, isError: e.isError })), sessions,
	postRelaunchProjectABoots: restored.length, postRelaunchProjectAProviderOrToolCalls: 0,
	fixtureUnchanged: true, globalPiExtensionsUnchanged: true, projects,
	productionExtensionSha256: setup.productionExtensionSha256, sourceHashes, rust,
	frontendAfterFix: await manifest(path.join(repo, "dist")),
	limits: ["UI visibility is a separately recorded computer-use observation, not certified by this readback script.", "Separate app identifier/bootstrap/fixture-only Tauri capabilities; no production install/update/theme acceptance.", "Guard covers synthetic RPC/SDK and verifier; Desktop ancillary version checks are not claimed network-free.", "Native process environment is inherited, not the whitelist environment of the separate SDK suite.", "No real model quality, automatic compaction quality, or remote CI claim."],
};
await writeFile(path.join(auditDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ passed: true, summary: path.join(auditDir, "summary.json"), realModelCalls: 0, syntheticProviderInvocations: synthetic.length, sessions: sessions.length, postRelaunchProjectAProviderOrToolCalls: 0 }, null, 2));
