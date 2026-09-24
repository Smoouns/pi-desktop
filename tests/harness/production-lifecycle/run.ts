import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { fixtureRoot, sha256, treeManifest } from "../testkit.js";

const originalFixture = await treeManifest(fixtureRoot), originalSources = await treeManifest(path.resolve("src"));
const parent = path.resolve("artifacts/harness/production-lifecycle"); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "d-"));
const buildRoot = await mkdtemp(path.join(path.resolve("artifacts/harness"), ".production-lifecycle-"));
const cases: any[] = [];
const guard = pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href;

async function setup(name: string) {
	const work = path.join(output, name), project = path.join(work, "project"), agent = path.join(work, "agent");
	await cp(fixtureRoot, project, { recursive: true });
	for (const directory of [agent, path.join(agent, "sessions"), path.join(project, ".pi"), path.join(project, ".novel/tools"), path.join(project, "notes")]) await mkdir(directory, { recursive: true });
	await copyFile(path.resolve("scripts/verify-novel-chapter.ts"), path.join(project, ".novel/tools/verify-novel-chapter.ts"));
	await writeFile(path.join(project, "notes/lifecycle-source.md"), Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n") + "\n");
	const settings = JSON.stringify({ compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 128 }, retry: { enabled: false }, enableSkillCommands: false });
	for (const filename of [path.join(agent, "settings.json"), path.join(project, ".pi/settings.json")]) await writeFile(filename, settings);
	return work;
}

try {
	const worker = path.join(buildRoot, "worker.mjs");
	await build({ entryPoints: [path.resolve("tests/harness/production-lifecycle/worker.ts")], outfile: worker, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning",
		alias: { "@tauri-apps/api/core": "./tests/support/rpc-tauri-core.ts", "@tauri-apps/api/event": "./tests/support/rpc-tauri-event.ts" },
		plugins: [{ name: "pinned-extension-loader", setup(api) { api.onResolve({ filter: /node_modules\/@mariozechner\/pi-coding-agent\/dist\/core\/extensions\/index\.js$/ }, () => ({ path: pathToFileURL(path.resolve("node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js")).href, external: true })); } }] });
	for (const [name, stages] of [
		["submission-state", ["submission-seed"]],
		["delivery", ["delivery-seed", "delivery-resume", "delivery-changed"]],
		["read-range", ["range-seed", "range-resume"]],
		["lost-acknowledgement", ["lost-seed", "lost-resume", "lost-conflict"]],
		["cancel", ["cancel-seed", "cancel-resume"]],
		["corrupt-latest", ["corrupt-seed", "corrupt-resume"]],
		["session-role-isolation", ["isolation"]],
		["source-mutation", ["mutation"]],
	] as Array<[string, string[]]>) {
		const work = await setup(name), receipts: any[] = [];
		const record: any = { name, pass: false, stages: receipts };
		try {
			for (const stage of stages) {
				const environment: NodeJS.ProcessEnv = {};
				for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)) environment[key] = value;
				environment.PI_CODING_AGENT_DIR = path.join(work, "agent"); environment.PI_PRODUCTION_LIFECYCLE_WORKER = "1";
				environment.NODE_OPTIONS = `--import=${guard}`;
				const projectBefore = await treeManifest(path.join(work, "project"));
				const child = spawnSync(process.execPath, [worker, stage, work], { cwd: process.cwd(), env: environment, encoding: "utf8", timeout: 60_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
				const projectAfter = await treeManifest(path.join(work, "project"));
				const allowed = new Set(["drafts/candidates/chapters/002.md", "planning/continuity-proposals/002-lifecycle.md", "planning/verifications/002-verification.md",
					...(stage === "delivery-changed" ? ["planning/chapter-cards/002.md"] : []), ...(["range-resume", "mutation"].includes(stage) ? ["notes/lifecycle-source.md"] : [])]);
				const changed = [...new Set([...Object.keys(projectBefore), ...Object.keys(projectAfter)])].filter(key => projectBefore[key] !== projectAfter[key]);
				assert.ok(changed.every(key => allowed.has(key)), "PARENT_PROJECT_BOUNDARY_INCLUDING_CRASH");
				const expectedExit = stage === "lost-seed" ? 86 : stage === "mutation" ? 1 : 0;
				assert.equal(child.status, expectedExit, `${stage}: ${child.error?.message ?? child.stderr}`);
				const receipt = JSON.parse(await readFile(path.join(work, `${stage}.json`), "utf8"));
				if (stage === "mutation") {
					assert.equal(receipt.failure?.name, "AssertionError"); assert.match(receipt.failure?.message, /^SOURCE_VERSION_ORACLE/);
					assert.ok(receipt.checks.includes("only actual SDK delivered lines recorded")); record.mutationDetected = true;
				} else assert.equal(receipt.failure, undefined);
				assert.equal(receipt.modelCalls, 0); assert.equal(receipt.networkAttempts, 0);
				receipts.push({ stage, pid: receipt.pid, exit: child.status, evidence: `${name}/${stage}.json`, checks: receipt.checks.length,
					changedFiles: changed, nativeWrites: receipt.nativeDispatches.filter((row: any) => row.tool === "write" || row.tool === "edit").length,
					verifierCalls: receipt.verifierCalls.length, syntheticProviderInvocations: receipt.requests.length, extensionSha256: receipt.extensionSha256 });
			}
			assert.equal(new Set(receipts.map(row => row.pid)).size, stages.length, "Cold stages must run in independent OS processes");
			if (name === "lost-acknowledgement") assert.equal(receipts.reduce((sum, row) => sum + row.nativeWrites, 0), 1);
			record.pass = true; console.log(`PASS production-lifecycle.${name} (${receipts.length} processes)`);
		} catch (error) { record.failure = String(error); console.error(`FAIL production-lifecycle.${name}`, error); }
		cases.push(record);
		assert.deepEqual(await treeManifest(fixtureRoot), originalFixture, "Repository fixture mutated");
	}
} finally {
	const relative = path.relative(path.resolve("artifacts/harness"), buildRoot);
	assert.ok(relative.startsWith(".production-lifecycle-") && !relative.includes(path.sep));
	await rm(buildRoot, { recursive: true, force: true });
	assert.deepEqual(await treeManifest(path.resolve("src")), originalSources, "Source drift during lifecycle evidence collection");
	assert.deepEqual(await treeManifest(fixtureRoot), originalFixture);
	const implementation: Record<string, string> = {};
	for (const filename of ["package-lock.json", "scripts/verify-novel-chapter.ts", "scripts/eval-network-guard.mjs", "tests/harness/production-lifecycle/provider.ts", "tests/harness/production-lifecycle/session.ts", "tests/harness/production-lifecycle/worker.ts", "tests/harness/production-lifecycle/run.ts"]) implementation[filename] = sha256(await readFile(filename));
	const summary = { schemaVersion: 1, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
		node: process.version, platform: process.platform, piSdk: JSON.parse(await readFile("node_modules/@mariozechner/pi-coding-agent/package.json", "utf8")).version,
		modelCalls: 0, fixtureUnchanged: true, sourceManifest: originalSources, implementation, cases,
		boundary: "Unmodified complete production extension driven by the actual SDK AgentSession, native filesystem tools and installed verifier; synthetic provider only; isolated fresh OS processes; no Desktop, Rust bridge, remote CI or real-model acceptance." };
	await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
	console.log(`Production lifecycle evidence: ${path.relative(process.cwd(), output)}`);
}
assert.equal(cases.filter(row => !row.pass).length, 0, "Production lifecycle acceptance failed");
assert.equal(cases.length, 8);
