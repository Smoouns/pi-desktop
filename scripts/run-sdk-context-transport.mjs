/** Offline real-provider transport rehearsal. Intentionally no live/auth mode. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), mode = process.argv[2];
assert.ok(["test", "run", "recover"].includes(mode), "S3T_OFFLINE_ONLY");
assert.ok(mode === "test" ? process.argv.length === 3 : mode === "recover" ? process.argv.length === 4 : [3, 4].includes(process.argv.length), "S3T_ARGUMENTS");
const parent = path.join(root, "artifacts/harness"); await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, ".s3-transport-build-"));
try {
	const bundle = path.join(work, "s3-transport.mjs"), inputs = {};
	await build({ entryPoints: [path.join(root, "evals/sdk-context-transport/cli.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning",
		plugins: [{ name: "s3t-frozen-inputs", setup(api) { api.onLoad({ filter: /\.(ts|json)$/ }, async ({ path: filename }) => {
			const name = path.relative(root, filename).replaceAll("\\", "/"); assert.ok(/^(evals|tests)\//.test(name));
			const contents = await readFile(filename); inputs[name] = createHash("sha256").update(contents).digest("hex"); return { contents, loader: filename.endsWith(".json") ? "json" : "ts" };
		}); } }] });
	const inputFile = path.join(work, "inputs.json"); await writeFile(inputFile, JSON.stringify(inputs), { flag: "wx" });
	const env = {};
	for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)) env[key] = value;
	Object.assign(env, { PI_CODING_AGENT_DIR: path.join(work, "agent"), PI_S3T_WORK_ROOT: work, PI_S3T_BUNDLE: bundle, PI_S3T_INPUTS: inputFile,
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(work, "empty-git-config") });
	process.exitCode = await new Promise(resolve => {
		const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href, bundle, ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit", windowsHide: true });
		let interrupted = false; const stop = () => { interrupted = true; child.kill(); }, timer = setTimeout(stop, 300000);
		process.once("SIGINT", stop); process.once("SIGTERM", stop);
		const done = code => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(interrupted ? 1 : code ?? 1); };
		child.once("error", () => done(1)); child.once("close", done);
	});
} finally {
	const relative = path.relative(await realpath(parent), await realpath(work)); assert.ok(relative.startsWith(".s3-transport-build-") && !relative.includes(path.sep));
	await rm(work, { recursive: true, force: true, maxRetries: 3 });
}
