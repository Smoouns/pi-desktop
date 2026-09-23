/** Offline-only S1 entry point. No live mode, provider configuration or credential resolver. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
assert.ok(["run", "test", "rebuild"].includes(mode), "SDK_ABLATION_OFFLINE_ONLY");
assert.equal(process.argv.length, mode === "rebuild" ? 4 : 3, "SDK_ABLATION_ARGUMENTS");
const parent = path.join(root, "artifacts/harness"); await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, ".sdk-ablation-build-"));
try {
	const bundle = path.join(work, "sdk-ablation.mjs"), inputs = {};
	await build({ entryPoints: [path.join(root, "evals/sdk-ablation/cli.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning",
		plugins: [{ name: "sdk-ablation-frozen-inputs", setup(api) {
			api.onLoad({ filter: /\.(ts|json)$/ }, async ({ path: filename }) => {
				const name = path.relative(root, filename).replaceAll("\\", "/"); assert.ok(/^(evals|tests)\//.test(name), "SDK_UNEXPECTED_IMPORT");
				const contents = await readFile(filename); inputs[name] = createHash("sha256").update(contents).digest("hex");
				return { contents, loader: filename.endsWith(".json") ? "json" : "ts" };
			});
		} }] });
	const inputFile = path.join(work, "inputs.json"); await writeFile(inputFile, JSON.stringify(inputs), { flag: "wx" });
	const env = {};
	for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|npm_config_user_agent)$/i.test(key)) env[key] = value;
	Object.assign(env, { PI_CODING_AGENT_DIR: path.join(work, "agent"), PI_ABLATION_BUILD_INPUTS: inputFile, PI_ABLATION_WORK_ROOT: work, PI_ABLATION_BUNDLE: bundle,
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(work, "empty-git-config") });
	process.exitCode = await new Promise(resolve => {
		const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href, bundle, ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit", windowsHide: true });
		let interrupted = false;
		const stop = () => { interrupted = true; child.kill(); };
		const timer = setTimeout(stop, 240000); process.once("SIGINT", stop); process.once("SIGTERM", stop);
		const done = code => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(interrupted ? 1 : code ?? 1); };
		child.once("error", () => done(1)); child.once("close", done);
	});
} finally {
	const relative = path.relative(await realpath(parent), await realpath(work));
	assert.ok(relative.startsWith(".sdk-ablation-build-") && !relative.includes(path.sep), "SDK_UNSAFE_CLEANUP");
	await rm(work, { recursive: true, force: true, maxRetries: 3 });
}
