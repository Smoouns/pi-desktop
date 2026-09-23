/** Explicit live authorization is separate from offline tests and preparation. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
assert.ok(["test", "rehearse", "rebuild", "broker-dry-run", "prepare-live", "live", "recover-live"].includes(mode), "PILOT_MODE_INVALID");
assert.equal(process.argv.length, mode === "live" ? 8 : ["rebuild", "prepare-live", "recover-live"].includes(mode) ? 4 : 3, "Unexpected pilot arguments");
if (mode === "live") {
	assert.equal(process.argv[5], "--approve");
	assert.match(process.argv[6], /^[a-f0-9]{64}$/, "LIVE_AUTHORIZATION_REQUIRED");
	assert.equal(process.argv[7], "--accept-unknown-cost", "LIVE_COST_ACK_REQUIRED");
}
if (mode === "test") {
	const networkTests = spawnSync(process.execPath, [path.join(root, "scripts/test-pilot-broker-network.mjs")], { cwd: root, stdio: "inherit", windowsHide: true, timeout: 15000 });
	assert.equal(networkTests.status, 0, "PILOT_NETWORK_TEST_FAILED");
}
const parent = path.join(root, "artifacts/harness");
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, ".pilot-build-"));
try {
	const bundle = path.join(work, "pilot.mjs"), inputs = {};
	await build({ entryPoints: [path.join(root, "evals/pilot/cli.ts")], outfile: bundle, bundle: true,
		platform: "node", format: "esm", packages: "external", logLevel: "warning", plugins: [{
			name: "pilot-pinned-inputs", setup(api) {
				api.onResolve({ filter: /node_modules\/@mariozechner\/pi-coding-agent\/dist\/core\/.*\.js$/ }, ({ path: importPath, resolveDir }) => ({
					path: pathToFileURL(path.resolve(resolveDir, importPath)).href, external: true,
				}));
				api.onLoad({ filter: /\.(ts|json)$/ }, async ({ path: filename }) => {
					const name = path.relative(root, filename).replaceAll("\\", "/");
					assert.ok(/^(evals|tests|src)\//.test(name), "UNEXPECTED_PILOT_IMPORT");
					const contents = await readFile(filename);
					inputs[name] = createHash("sha256").update(contents).digest("hex");
					return { contents, loader: filename.endsWith(".json") ? "json" : "ts" };
				});
			},
		}] });
	const buildInputs = path.join(work, "inputs.json");
	await writeFile(buildInputs, JSON.stringify(inputs), { flag: "wx" });
	const env = {};
	for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL|npm_config_user_agent)$/i.test(key)) env[key] = value;
	if (mode === "test") {
		// Hosted Windows runners may expose TEMP via an 8.3 alias. The journal's
		// production policy remains strict; only this isolated test child's trusted
		// temporary root is canonicalized. Never modify the parent's/global env.
		const tempRoot = await realpath(os.tmpdir()), info = await lstat(tempRoot);
		assert.ok(info.isDirectory() && !info.isSymbolicLink(), "PILOT_TEST_TEMP_ROOT_UNSAFE");
		for (const key of Object.keys(env)) if (/^(TEMP|TMP|TMPDIR)$/i.test(key)) delete env[key];
		env.TEMP = tempRoot; env.TMP = tempRoot; env.TMPDIR = tempRoot;
	}
	env.PI_CODING_AGENT_DIR = path.join(work, "agent");
	env.PI_PILOT_BUILD_INPUTS = buildInputs;
	env.PI_PILOT_WORK_ROOT = work;
	env.PI_PILOT_BUNDLE = bundle;
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = path.join(work, "empty-git-config");
	if (mode === "live") {
		// Validate the exact live manifest before even resolving a private credential reference.
		const authorization = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href,
			bundle, "authorize-live", ...process.argv.slice(3)], { cwd: root, env, stdio: "ignore", timeout: 15_000, windowsHide: true });
		assert.equal(authorization.status, 0, "LIVE_AUTHORIZATION_REJECTED");
		// Forward only the selected credential reference, not the user's entire environment.
		try {
			const content = await readFile(process.argv[4], "utf8");
			assert.ok(Buffer.byteLength(content) <= 1024 * 1024);
			const reference = JSON.parse(content)?.providers?.["gemini-proxy"]?.apiKey;
			if (typeof reference === "string" && /^[A-Z][A-Z0-9_]*$/.test(reference) && process.env[reference] !== undefined) {
				assert.ok(!/^(NODE_|PI_|GIT_|NPM_|PATH$|SYSTEMROOT$|COMSPEC$|PATHEXT$|TEMP$|TMP$|WINDIR$)/i.test(reference), "PILOT_CREDENTIAL_ENV_RESERVED");
				env[reference] = process.env[reference];
			}
		} catch { throw new Error("PILOT_PRIVATE_CONFIG_REJECTED"); }
	}
	const guard = mode === "live" ? "scripts/pilot-broker-network.mjs" : "scripts/eval-network-guard.mjs";
	process.exitCode = await new Promise((resolve) => {
		const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(root, guard)).href, bundle, mode, ...process.argv.slice(3)], {
			cwd: root, env, stdio: "inherit", windowsHide: true,
		});
		let interrupted = false;
		const stop = () => { interrupted = true; child.kill(); };
		const timer = setTimeout(stop, mode === "live" ? 550_000 : 180_000);
		process.once("SIGINT", stop); process.once("SIGTERM", stop);
		const finish = (code) => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(interrupted ? 1 : code ?? 1); };
		child.once("error", () => finish(1)); child.once("close", finish);
	});
} finally {
	const relative = path.relative(await realpath(parent), await realpath(work));
	assert.ok(relative.startsWith(".pilot-build-") && !relative.includes(path.sep), "UNSAFE_PILOT_CLEANUP");
	await rm(work, { recursive: true, force: true, maxRetries: 3 });
}
