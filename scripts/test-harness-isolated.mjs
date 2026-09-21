/** Isolated source snapshot smoke. Does not stage/commit/push the user's worktree. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts/harness");
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && path.isAbsolute(npmCli), "Run this check through npm run test:harness:isolated");
const temporary = await mkdtemp(path.join(tmpdir(), "pi-harness-isolated-"));
const checkout = path.join(temporary, "checkout");
await mkdir(output, { recursive: true });

// Existing tracked files plus an explicit allowlist of uncommitted Harness
// deliverable. Do not copy arbitrary untracked files or ignored private fixtures.
const additions = [
	"src/extensions/budget-diagnostics.ts",
	"src/extensions/context-maintenance.ts", "src/components/chat-view/context-usage-view.ts",
	"scripts/test-context-usage-ui.mjs", "scripts/test-global-pi-context-maintenance.mjs", "docs/CONTEXT_BUDGET_RESEARCH.md",
	"scripts/test-context-entry-ui.mjs",
	"src/layout/chat-panel-resize.ts", "scripts/test-chat-panel-resize.mjs",
	"src/extensions/supervisor-runtime.ts", "docs/HARNESS_PHASE4_ACCEPTANCE.md", "docs/HARNESS_PHASE4_RESULTS.md",
	".gitattributes", "tsconfig.harness.json", "fixtures/harness-novel", "tests/harness", "tests/support",
	"src/harness", "src/novel/context-attachment.ts", "scripts/run-public-tests.mjs",
	"src/extensions/checkpoint-runtime.ts", "docs/HARNESS_PHASE3_ACCEPTANCE.md", "docs/HARNESS_PHASE3_RESULTS.md",
	"src/extensions/session-title-core.ts", "src/extensions/session-title-extension.ts",
	"src/components/chat-view/session-refresh-scope.ts", "tests/session-title-core.ts", "tests/session-title-extension.ts",
	"scripts/test-chat-layout.mjs", "docs/SESSION_UX_FIXES.md",
	"scripts/test-extension-status-ui.mjs",
	"src/components/chat-view/extension-status-view.ts",
	"src/novel/tool-path-policy.ts", "src/novel/read-range.ts", "docs/HARNESS_PHASE2_ACCEPTANCE.md", "docs/HARNESS_PHASE2_RESULTS.md",
	"src/rpc/session-restore.ts", "src-tauri/src/session_file.rs",
	"scripts/run-harness-baseline.mjs", "scripts/test-harness-isolated.mjs",
];
try {
	await execute("git", ["clone", "--local", "--no-hardlinks", "--no-checkout", root, checkout]);
	const { stdout } = await execute("git", ["ls-files", "-z"], { cwd: root });
	const files = new Set(stdout.split("\0").filter(Boolean));
	async function addFiles(relative) {
		const full = path.join(root, relative);
		try {
			for (const entry of await readdir(full, { withFileTypes: true })) {
				assert.ok(!entry.isSymbolicLink(), "Source snapshot cannot include links");
				if (entry.isDirectory()) await addFiles(`${relative}/${entry.name}`);
				else files.add(`${relative}/${entry.name}`);
			}
		} catch (error) {
			if (error.code !== "ENOTDIR") throw error;
			files.add(relative);
		}
	}
	for (const relative of additions) await addFiles(relative);
	const manifest = {};
	for (const relative of [...files].sort()) {
		assert.ok(!relative.startsWith("fixtures/novel-projects/"), "Private fixture must not enter snapshot");
		assert.ok(!relative.includes("..") && !path.isAbsolute(relative));
		const destination = path.join(checkout, relative);
		await mkdir(path.dirname(destination), { recursive: true });
		await cp(path.join(root, relative), destination);
		manifest[relative] = createHash("sha256").update(await readFile(destination)).digest("hex");
	}
	const commands = [
		["ci", "--no-audit", "--no-fund"],
		["run", "check"], ["run", "check:harness-tests"], ["run", "test:harness"],
		["run", "test:harness:long-horizon"],
		["run", "test:novel-domain"], ["run", "build:frontend"],
	];
	const results = [];
	for (const args of commands) {
		console.log(`Isolated: npm ${args.join(" ")}`);
		const label = args[0] === "ci" ? "ci" : args[1].replaceAll(":", "-");
		try {
			const result = await execute(process.execPath, [npmCli, ...args], { cwd: checkout, timeout: 300_000, maxBuffer: 4_000_000 });
			await writeFile(path.join(output, `isolated-${label}.log`), (result.stdout + result.stderr).replaceAll(checkout, "<isolated-checkout>"));
			results.push({ command: `npm ${args.join(" ")}`, exitCode: 0 });
		} catch (error) {
			await writeFile(path.join(output, `isolated-${label}.log`), String(error.stdout ?? "") + String(error.stderr ?? ""));
			throw error;
		}
	}
	const harness = JSON.parse(await readFile(path.join(checkout, "artifacts/harness/summary.json"), "utf8"));
	await writeFile(path.join(output, "isolated-summary.json"), JSON.stringify({
		kind: "isolated-uncommitted-source-snapshot", node: process.version, platform: process.platform,
		baselineHead: harness.implementationHead, sourceManifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
		fileCount: files.size, dependenciesInstalledFresh: true, ignoredPrivateFilesCopied: false,
		results, harnessCaseCount: harness.cases.length, deterministic: harness.deterministic,
		note: "New deliverables are explicitly allowlisted until committed; this is not a remote CI or committed clean-clone claim.",
	}, null, 2) + "\n");
	console.log(`Isolated source snapshot: all ${commands.length} commands passed`);
} finally {
	const relative = path.relative(path.resolve(tmpdir()), path.resolve(temporary));
	assert.ok(relative.startsWith("pi-harness-isolated-") && !relative.includes(path.sep), "Unsafe cleanup target");
	await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
