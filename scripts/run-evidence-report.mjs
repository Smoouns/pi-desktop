/** Read-only evidence reconstruction. No live/prepare mode or auth arguments. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), mode = process.argv[2];
assert.ok(["run", "verify", "test"].includes(mode), "REPORT_OFFLINE_ONLY");
assert.equal(process.argv.length, mode === "verify" ? 4 : 3, "REPORT_ARGUMENTS");
const parent = path.join(root, "artifacts/harness");
for (const item of [path.join(root, "artifacts"), parent]) {
  try { assert.ok(!(await lstat(item)).isSymbolicLink(), "REPORT_BUILD_LINK"); }
  catch (error) { if (error.code !== "ENOENT") throw error; await mkdir(item); }
}
const work = await mkdtemp(path.join(parent, ".evidence-report-build-"));
try {
  const bundle = path.join(work, "report.mjs"), inputs = {};
  const options = { bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning", plugins: [{
      name: "report-source-map", setup(api) { api.onLoad({ filter: /\.(ts|json)$/ }, async ({ path: filename }) => {
        const name = path.relative(root, filename).replaceAll("\\", "/");
        assert.ok(/^(evals|tests|src)\//.test(name) && !name.includes(".."), "REPORT_BUILD_INPUT");
        const contents = await readFile(filename); inputs[name] = createHash("sha256").update(contents).digest("hex");
        return { contents, loader: filename.endsWith(".json") ? "json" : "ts" };
      }); }
    }] };
  await build({ ...options, entryPoints: [path.join(root, "evals/report/cli.ts")], outfile: bundle });
  // These validators fingerprint Function.toString() output. Keep each original
  // entry graph separate from the report and from each other. Workers have a
  // fixed recover action; no live/prepare command or credentials are forwarded.
  for (const family of ["sdk-context-live", "sdk-supervision-live"]) {
    await build({ ...options, entryPoints: [path.join(root, "evals", family, "cli.ts")], outfile: path.join(work, family + ".mjs"),
      plugins: [{ name: "legacy-sdk-externals", setup(api) {
        api.onResolve({ filter: /node_modules\/@mariozechner\/pi-coding-agent\/dist\/core\/.*\.js$/ }, ({ path: importPath, resolveDir }) =>
          ({ path: pathToFileURL(path.resolve(resolveDir, importPath)).href, external: true }));
      } }, ...options.plugins] });
  }
  for (const name of ["package.json", "package-lock.json", "scripts/run-evidence-report.mjs", "scripts/eval-network-guard.mjs"])
    inputs[name] = createHash("sha256").update(await readFile(path.join(root, name))).digest("hex");
  const inputFile = path.join(work, "inputs.json");
  await writeFile(inputFile, JSON.stringify(Object.fromEntries(Object.entries(inputs).sort())), { flag: "wx" });
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)) env[key] = value;
  Object.assign(env, { PI_CODING_AGENT_DIR: path.join(work, "agent"), PI_EVAL_WORKER: "1", PI_REPORT_WORK: work, PI_REPORT_INPUTS: inputFile });
  process.exitCode = await new Promise(resolve => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/eval-network-guard.mjs")).href, bundle, ...process.argv.slice(2)],
      { cwd: root, env, stdio: "inherit", windowsHide: true });
    let interrupted = false;
    const stop = () => { interrupted = true; child.kill(); }, timer = setTimeout(stop, 120_000);
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const done = code => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(interrupted ? 1 : code ?? 1); };
    child.once("error", () => done(1)); child.once("close", done);
  });
} finally {
  const relative = path.relative(await realpath(parent), await realpath(work));
  assert.ok(relative.startsWith(".evidence-report-build-") && !relative.includes(path.sep), "REPORT_CLEANUP");
  await rm(work, { recursive: true, force: true, maxRetries: 3 });
}
