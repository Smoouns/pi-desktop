import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const outputParent = path.join(root, "artifacts/harness");
await mkdir(outputParent, { recursive: true });
const work = await mkdtemp(path.join(outputParent, ".build-"));
const mode = process.argv[2];
assert.ok(mode === "harness" || mode === "regression", "Usage: run-public-tests.mjs harness|regression");

// Always use the installed, pinned loader. Bundled tests still resolve runtime packages
// from this checkout, not a user's global Pi installation or home extensions.
const loaderPlugin = {
	name: "local-pi-loader",
	setup(buildApi) {
		buildApi.onResolve({ filter: /node_modules\/@mariozechner\/pi-coding-agent\/dist\/core\/extensions\/index\.js$/ }, () => ({
			path: pathToFileURL(path.join(root, "node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js")).href, external: true,
		}));
	},
};
const aliases = {
	"@tauri-apps/api/core": "./tests/support/rpc-tauri-core.ts",
	"@tauri-apps/api/event": "./tests/support/rpc-tauri-event.ts",
};

async function bundle(entry, alias = {}) {
	const outfile = path.join(work, path.basename(entry, ".ts") + ".mjs");
	await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", packages: "external", alias, plugins: [loaderPlugin], logLevel: "warning" });
	return outfile;
}

function execute(filename) {
	const environment = { ...process.env, PI_DESKTOP_NOVEL_ROLE: "", PI_CODING_AGENT_DIR: path.join(work, "empty-agent") };
	// Test inputs are synthetic. Do not pass provider credentials to the test process.
	for (const key of Object.keys(environment)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_ACCESS_KEY)$/.test(key)) delete environment[key];
	const result = spawnSync(process.execPath, ["--experimental-strip-types", filename], {
		cwd: root, stdio: "inherit", timeout: 180_000,
		env: environment,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${path.basename(filename)} failed (${result.signal ?? result.status})`);
}

async function fixtureBytes() {
	const files = {};
	async function visit(relative) {
		for (const entry of (await readdir(path.join(root, "fixtures/harness-novel", relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await visit(name);
			else files[name] = (await readFile(path.join(root, "fixtures/harness-novel", name))).toString("base64");
		}
	}
	await visit("");
	return files;
}

try {
	if (mode === "harness") {
		execute(await bundle("tests/harness/run.ts", aliases));
	} else {
		const before = await fixtureBytes();
		const results = [];
		const cases = [
			["scripts/novel-domain-smoke.ts", true, {}],
			["scripts/novel-tools-extension-smoke.ts", false, {}],
			["scripts/novel-verifier-smoke.ts", false, {}],
			["scripts/world-change-smoke.ts", true, { "@tauri-apps/plugin-fs": "./scripts/world-change-test-fs.ts" }],
			["scripts/novel-memory-smoke.ts", false, {}],
		];
		for (const [entry, bundled, alias] of cases) {
			try {
				execute(bundled ? await bundle(entry, alias) : entry);
				assert.deepEqual(await fixtureBytes(), before, `${entry} changed repository fixture`);
				results.push({ entry, status: "pass" });
			} catch (error) {
				results.push({ entry, status: "fail" });
				throw error;
			} finally {
				await writeFile(path.join(outputParent, "regression.json"), JSON.stringify({ caseId: "REG-01", node: process.version, platform: process.platform, cases: results }, null, 2) + "\n");
			}
		}
	}
} finally {
	const relative = path.relative(outputParent, work);
	assert.ok(relative.startsWith(".build-") && !relative.includes(path.sep), "Unsafe temporary cleanup target");
	await rm(work, { recursive: true, force: true });
}
