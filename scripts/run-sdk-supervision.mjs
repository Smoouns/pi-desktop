/** Strictly offline: public fixtures, local synthetic API, isolated Pi settings. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), mode = process.argv[2];
assert.ok(["run", "test", "rebuild"].includes(mode), "S4_OFFLINE_ONLY"); assert.equal(process.argv.length, mode === "rebuild" ? 4 : 3, "S4_ARGUMENTS");
const parent = path.join(root, "artifacts/harness"); await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, ".sdk-supervision-build-"));
try {
  const bundle = path.join(work, "sdk-supervision.mjs"), inputs = {};
  await build({ entryPoints: [path.join(root, "evals/sdk-supervision/cli.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning", plugins: [{
    name: "s4-pinned-inputs", setup(api) { api.onLoad({ filter: /\.(ts|json)$/ }, async ({ path: filename }) => {
      const name = path.relative(root, filename).replaceAll("\\", "/"); assert.ok(/^(evals|tests)\//.test(name) || name === "src/extensions/context-maintenance.ts");
      const contents = await readFile(filename); inputs[name] = createHash("sha256").update(contents).digest("hex"); return { contents, loader: filename.endsWith(".json") ? "json" : "ts" };
    }); }
  }] });
  const inputFile = path.join(work, "inputs.json"); await writeFile(inputFile, JSON.stringify(inputs), { flag: "wx" });
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)) env[key] = value;
  Object.assign(env, { PI_CODING_AGENT_DIR: path.join(work, "agent"), PI_S4_WORK_ROOT: work, PI_S4_BUNDLE: bundle, PI_S4_BUILD_INPUTS: inputFile,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(work, "empty-git-config") });
  process.exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href, bundle, ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit", windowsHide: true });
    let interrupted = false; const stop = () => { interrupted = true; child.kill(); };
    const timer = setTimeout(stop, 480_000); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const finish = code => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(interrupted ? 1 : code ?? 1); };
    child.once("error", () => finish(1)); child.once("close", finish);
  });
} finally {
  const relative = path.relative(await realpath(parent), await realpath(work)); assert.ok(relative.startsWith(".sdk-supervision-build-") && !relative.includes(path.sep), "S4_UNSAFE_CLEANUP");
  await rm(work, { recursive: true, force: true, maxRetries: 3 });
}
