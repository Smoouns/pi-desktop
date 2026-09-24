// Windows native D-07 setup. Does not start or control a Desktop window.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const repo = process.cwd(), parent = path.join(repo, "artifacts/harness/native-desktop");
await mkdir(parent, { recursive: true });
const work = await mkdtemp(path.join(parent, "d7-"));
const app = path.join(work, "app"), agent = path.join(work, "agent");
const hash = data => createHash("sha256").update(data).digest("hex");
async function manifest(root) {
	const files = {};
	async function visit(dir) { for (const e of await readdir(path.join(root, dir), { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) await visit(file); else files[file.replaceAll("\\", "/")] = hash(await readFile(path.join(root, file))); } }
	await visit(""); return files;
}
const originalFixture = await manifest(path.join(repo, "fixtures/harness-novel"));
const originalGlobalExtensions = await manifest(path.join(process.env.USERPROFILE, ".pi/agent/extensions"));
for (const name of ["project-a", "project-b"]) {
	const project = path.join(work, name);
	await cp(path.join(repo, "fixtures/harness-novel"), project, { recursive: true });
	await mkdir(path.join(project, ".novel/tools"), { recursive: true });
	await cp(path.join(repo, "scripts/verify-novel-chapter.ts"), path.join(project, ".novel/tools/verify-novel-chapter.ts"));
}
await mkdir(path.join(agent, "extensions"), { recursive: true });
await mkdir(path.join(work, "node_modules"), { recursive: true });
const settings = { defaultProvider: "desktop-offline", defaultModel: "d7-synthetic", compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false };
await writeFile(path.join(agent, "settings.json"), JSON.stringify(settings, null, 2));
await writeFile(path.join(agent, "auth.json"), "{}");
const sourceModule = path.join(work, "source.mjs");
await build({ entryPoints: ["src/extensions/novel-tools-extension.ts"], outfile: sourceModule, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning" });
const { NOVEL_TOOLS_EXTENSION_CONTENT } = await import(pathToFileURL(sourceModule).href);
const productionExtension = path.join(agent, "extensions/novel-tools.ts"), providerExtension = path.join(agent, "extensions/native-provider.mjs");
await writeFile(productionExtension, NOVEL_TOOLS_EXTENSION_CONTENT);
await build({ entryPoints: ["tests/harness/production-lifecycle/native-provider.ts"], outfile: providerExtension, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning" });
const wrapper = path.join(work, "node_modules/desktop-rpc.js");
await writeFile(wrapper, `import assert from 'node:assert/strict';
import path from 'node:path';
process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(agent)};
process.env.PI_DESKTOP_D7_WORK = ${JSON.stringify(work)};
process.env.PI_DESKTOP_SESSION_TITLE = '0';
await import(${JSON.stringify(pathToFileURL(path.join(repo, "scripts/eval-network-guard.mjs")).href)});
const { main } = await import(${JSON.stringify(pathToFileURL(path.join(repo, "node_modules/@mariozechner/pi-coding-agent/dist/main.js")).href)});
const args = process.argv.slice(2);
if (args.includes('--mode')) assert.ok(['project-a','project-b'].some(n => process.cwd() === path.join(${JSON.stringify(work)}, n)), 'D7_CWD_OUTSIDE_FIXTURE');
await main([...args, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '-e', ${JSON.stringify(productionExtension)}, '-e', ${JSON.stringify(providerExtension)}, '--provider', 'desktop-offline', '--model', 'd7-synthetic', '--tools', 'read,write,edit']);
`);
await writeFile(path.join(work, "pi-offline.cmd"), '@echo off\r\nnode "%~dp0\\node_modules\\desktop-rpc.js" %*\r\n');
await mkdir(app, { recursive: true });
for (const entry of ["src", "icons", "build.rs", "Cargo.lock"]) await cp(path.join(repo, "src-tauri", entry), path.join(app, entry), { recursive: true });
// Test bootstrap only; all production Rust command/bridge implementations stay identical.
const main = await readFile(path.join(app, "src/main.rs"), "utf8");
await writeFile(path.join(app, "src/main.rs"), main.replace('#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]', '#![windows_subsystem = "windows"]').replace('    pi_desktop_lib::run();', `    std::env::set_var("PI_CODING_AGENT_DIR", ${JSON.stringify(agent)});\n    std::env::set_var("NODE_OPTIONS", ${JSON.stringify("--import=" + pathToFileURL(path.join(repo, "scripts/eval-network-guard.mjs")).href)});\n    pi_desktop_lib::run();`));
let cargo = await readFile(path.join(repo, "src-tauri/Cargo.toml"), "utf8");
cargo = cargo.replace('name = "pi-desktop"', 'name = "pi-desktop-d7"');
await writeFile(path.join(app, "Cargo.toml"), cargo);
const identifier = `com.pi.desktop.d7${path.basename(work).slice(3).toLowerCase()}`;
const config = JSON.parse(await readFile(path.join(repo, "src-tauri/tauri.conf.json"), "utf8"));
config.identifier = identifier;
config.productName = "Pi Desktop D7 Offline";
config.build = { frontendDist: path.relative(app, path.join(repo, "dist")).replaceAll("\\", "/") };
config.bundle = { active: false, icon: ["icons/icon.ico"] };
config.app.windows[0].title = "Pi Desktop - D7 Offline";
config.app.windows[0].width = 1200;
config.app.windows[0].height = 800;
// Never enable the production broad home scope in this isolated package.
const allowed = [work, `${work}/**`, `${work}/**/.*`, `${work}/**/.*/**`].map(p => p.replaceAll("\\", "/"));
config.app.security.capabilities = [{ identifier: "d7-isolated", windows: ["main"], permissions: ["core:default", "core:window:default", "core:window:allow-close", "core:window:allow-minimize", "core:window:allow-toggle-maximize", "core:window:allow-start-dragging", "dialog:allow-open", "fs:read-all", "fs:write-all", { identifier: "fs:scope", allow: allowed }] }];
await writeFile(path.join(app, "tauri.conf.json"), JSON.stringify(config, null, 2));
const dataDir = path.join(process.env.APPDATA, identifier);
await mkdir(dataDir, { recursive: true });
await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ theme: "light", thinking_level: "off", auto_compaction: false, auto_retry: false, steering_mode: "one-at-a-time", follow_up_mode: "one-at-a-time", model_provider: "desktop-offline", model_id: "d7-synthetic", pi_path: path.join(work, "pi-offline.cmd") }));
await writeFile(path.join(work, "setup.json"), JSON.stringify({ work, app, agent, identifier, dataDir, productionExtensionSha256: hash(NOVEL_TOOLS_EXTENSION_CONTENT), originalFixture, originalGlobalExtensions, rustSources: await manifest(path.join(repo, "src-tauri/src")), frontend: await manifest(path.join(repo, "dist")), boundary: "Production frontend/Rust source unchanged. Separate package name, identifier and restricted fixture-only FS capability. Synthetic provider; actual pinned SDK CLI/RPC; no global Pi writes. Not packaged-product install/update acceptance." }, null, 2));
assert.deepEqual(await manifest(path.join(repo, "fixtures/harness-novel")), originalFixture);
console.log(work);
