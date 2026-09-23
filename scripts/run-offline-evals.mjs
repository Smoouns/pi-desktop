import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
assert.ok(["run", "matrix", "rebuild", "test"].includes(mode), "Usage: run-offline-evals.mjs run|matrix|rebuild <batch>|test");
assert.equal(process.argv.length, mode === "rebuild" ? 4 : 3, "Unexpected eval arguments");
const parent = path.join(root, "artifacts/harness");
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, ".eval-build-"));
try {
	const cli = path.join(work, "eval.mjs");
	const buildInputs = {};
	await build({ entryPoints: [path.join(root, "evals/cli.ts")], outfile: cli, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning", plugins: [{
		name: "freeze-compiled-inputs",
		setup(api) {
			api.onLoad({ filter: /\.(ts|json)$/ }, async ({ path: filename }) => {
				const relative = path.relative(root, filename).replaceAll("\\", "/");
				assert.ok(/^(evals|tests\/evals|src\/harness)\//.test(relative), "UNEXPECTED_EVAL_IMPORT");
				const contents = await readFile(filename);
				buildInputs[relative] = createHash("sha256").update(contents).digest("hex");
				return { contents, loader: filename.endsWith(".json") ? "json" : "ts" };
			});
		},
	}] });
	const buildManifest = path.join(work, "build-inputs.json");
	await writeFile(buildManifest, JSON.stringify(buildInputs), { flag: "wx" });
	// Allowlist rather than guessing every vendor's credential variable name.
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|npm_config_user_agent)$/i.test(key)) env[key] = value;
	}
	env.PI_CODING_AGENT_DIR = path.join(work, "empty-agent");
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = path.join(work, "empty-git-config");
	env.PI_EVAL_BUNDLE = cli;
	env.PI_EVAL_BUILD_INPUTS = buildManifest;
	const guard = pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href;
	const result = spawnSync(process.execPath, ["--import", guard, cli, mode, ...process.argv.slice(3)], {
		cwd: root, env, stdio: "inherit", timeout: 300_000,
	});
	if (result.error || result.signal) throw new Error("OFFLINE_EVAL_PROCESS_FAILED");
	process.exitCode = result.status ?? 1;
} finally {
	const relative = path.relative(await realpath(parent), await realpath(work));
	assert.ok(relative.startsWith(".eval-build-") && !relative.includes(path.sep), "UNSAFE_EVAL_CLEANUP");
	await rm(work, { recursive: true, force: true, maxRetries: 3 });
}
