/** E8 owns a new allowance. Preparation/verification never resolve a key.
 * Only an exact explicit live approval can consume the batch and forward the
 * selected environment credential to the network-owning broker process.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); process.chdir(root);
const [mode, ...args] = process.argv.slice(2);
assert.ok(["prepare", "prepare-tool-none", "prepare-joint-tool-none", "prepare-upstream", "prepare-read-upstream", "verify", "recover", "test", "test-tool-none", "test-joint-tool-none", "test-budget-contracts", "test-upstream", "test-read-upstream", "live"].includes(mode), "E8_MODE_INVALID");
const testMode = mode === "test" || mode === "test-tool-none" || mode === "test-joint-tool-none" || mode === "test-budget-contracts" || mode === "test-upstream" || mode === "test-read-upstream";
assert.equal(args.length, mode === "live" ? 5 : testMode ? 0 : mode === "verify" ? 2 : 1, "E8_ARGUMENTS_INVALID");
if (mode === "live") { assert.equal(args[2], "--approve"); assert.match(args[3], /^[a-f0-9]{64}$/); assert.equal(args[4], "--accept-unknown-cost"); }
const parent = path.join(root, "artifacts/harness"); await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, ".e8-build-"));
// Filter names before accessing values; do not enumerate credential values
// while preparing the credential-free authorization process.
const env = Object.fromEntries(Object.keys(process.env).filter(k => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(k)).map(k => [k, process.env[k]]));
Object.assign(env, { PI_CODING_AGENT_DIR: path.join(work, "empty-agent"), PI_E8_CLI: testMode ? "0" : "1" });
try {
	const file = path.join(work, "cli.mjs");
	await build({ entryPoints: ["tests/harness/review-e-live/" + (mode === "test-read-upstream" ? "read-upstream-tests.ts" : mode === "test-upstream" ? "upstream-tests.ts" : mode === "test-budget-contracts" ? "budget-contract-tests.ts" : mode === "test-joint-tool-none" ? "joint-tool-none-tests.ts" : mode === "test-tool-none" ? "tool-none-tests.ts" : mode === "test" ? "prepared-tests.ts" : "prepared-cli.ts")], outfile: file, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning" });
	const guard = ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href];
	if (mode === "live") {
		// Deliberately separate this credential-free process from the sender.
		const authorize = spawnSync(process.execPath, [...guard, file, "authorize", args[0], args[1], args[3], args[4]], { cwd: root, env, stdio: "pipe", windowsHide: true, timeout: 60_000 });
		assert.equal(authorize.status, 0, "E8_AUTHORIZATION_REJECTED_BEFORE_CREDENTIAL");
		try {
			const config = JSON.parse(await readFile(args[1], "utf8"));
			const reference = config.providers["gemini-proxy"].apiKey;
			assert.match(reference, /^[A-Z][A-Z0-9_]*$/); assert.ok(!/^(NODE_|PI_|GIT_|NPM_|PATH$|SYSTEMROOT$|COMSPEC$|PATHEXT$|TEMP$|TMP$|WINDIR$)/.test(reference));
			if (process.env[reference] !== undefined) env[reference] = process.env[reference];
		} catch { throw Error("E8_CONFIG_REJECTED_AFTER_AUTHORIZATION"); }
	}
	const argv = mode === "live" ? [file, "execute", args[0], args[1], args[3]] : [...guard, file, mode, ...args];
	process.exitCode = await new Promise(resolve => {
		const child = spawn(process.execPath, argv, { cwd: root, env, windowsHide: true, stdio: "inherit" });
		const stop = () => child.kill(); const timer = setTimeout(stop, mode === "live" ? 1_560_000 : 240_000);
		process.once("SIGINT", stop); process.once("SIGTERM", stop);
		child.once("error", () => { clearTimeout(timer); resolve(1); });
		child.once("close", code => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(code ?? 1); });
	});
} finally {
	const relative = path.relative(parent, work); assert.ok(relative.startsWith(".e8-build-") && !relative.includes(path.sep));
	await rm(work, { recursive: true, force: true });
}
