import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const npmRoot = (process.platform === "win32"
	? execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm root -g"], { encoding: "utf8" })
	: execFileSync("npm", ["root", "-g"], { encoding: "utf8" })).trim();
const piRoot = path.join(npmRoot, "@earendil-works", "pi-coding-agent");
const load = (file) => import(pathToFileURL(path.join(piRoot, file)).href);
const [{ createAgentSession }, { ModelRuntime }, { SessionManager }, { SettingsManager }, { DefaultResourceLoader }] = await Promise.all([
	load("dist/core/sdk.js"), load("dist/core/model-runtime.js"), load("dist/core/session-manager.js"),
	load("dist/core/settings-manager.js"), load("dist/core/resource-loader.js"),
]);
const version = JSON.parse(await readFile(path.join(piRoot, "package.json"), "utf8")).version;
assert.equal(version, "0.84.2");

const temp = await mkdtemp(path.join(tmpdir(), "pi-global-managed-context-"));
const project = path.join(temp, "project"), agentDir = path.join(temp, "agent");
let server;
try {
	await cp(path.resolve("fixtures/harness-novel"), project, { recursive: true });
	const factoryBundle = path.join(temp, "factory.mjs"), extensionPath = path.join(temp, "pi-desktop-novel-tools.ts");
	await build({ entryPoints: [path.resolve("src/extensions/novel-tools-extension.ts")], outfile: factoryBundle,
		bundle: true, platform: "node", format: "esm", packages: "external" });
	const factory = await import(pathToFileURL(factoryBundle).href);
	await writeFile(extensionPath, factory.NOVEL_TOOLS_EXTENSION_CONTENT, "utf8");

	let httpCalls = 0;
	server = http.createServer((request, response) => {
		request.resume(); request.on("end", () => {
			httpCalls++;
			response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
			response.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "global-offline", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "global-offline", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address(); assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	const model = { id: "global-offline", name: "Global offline", api: "openai-completions", provider: "synthetic", baseUrl,
		reasoning: false, input: ["text"], contextWindow: 50_000, maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerProvider("synthetic", { baseUrl, apiKey: "offline-test-key", api: model.api, models: [model] });
	await modelRuntime.setRuntimeApiKey("synthetic", "offline-test-key");
	const settingsManager = SettingsManager.create(project, agentDir); settingsManager.setCompactionEnabled(true); await settingsManager.flush();
	const sessionManager = SessionManager.inMemory(project);
	sessionManager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
	sessionManager.appendMessage({ role: "user", content: "必须保留的短约束", timestamp: 1 });
	sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "可压缩旧说明" + "甲".repeat(80_000) }],
		api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const summaryExtension = (pi) => pi.on("session_before_compact", () => ({ compaction: {
		summary: "global synthetic summary", firstKeptEntryId: "discard-old-history", tokensBefore: 20_000,
	} }));
	const loader = new DefaultResourceLoader({ cwd: project, agentDir, settingsManager,
		additionalExtensionPaths: [extensionPath], extensionFactories: [summaryExtension], noSkills: true, noPromptTemplates: true, noThemes: true });
	await loader.reload();
	const { session, extensionsResult } = await createAgentSession({ cwd: project, agentDir, modelRuntime, model, tools: [],
		resourceLoader: loader, sessionManager, settingsManager });
	assert.deepEqual(extensionsResult.errors, []);
	let compactStarts = 0; session.subscribe((event) => { if (event.type === "compaction_start") compactStarts++; });
	const statuses = [];
	await session.bindExtensions({ uiContext: { setStatus: (key, value) => statuses.push([key, value]), notify: () => undefined,
		setEditorText: () => { throw new Error("global managed request unexpectedly restored editor"); } } });
	let deadline;
	try {
		await Promise.race([session.prompt("GLOBAL_ORIGINAL_PROMPT", { source: "interactive" }),
			new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("global managed lifecycle deadlocked")), 10_000); })]);
		if (session._agentEventQueue) await session._agentEventQueue;
		assert.equal(compactStarts, 1); assert.equal(httpCalls, 1);
		assert.ok(statuses.some(([key, value]) => key === "pi-desktop-context-budget" && value?.includes('"autoCompaction":"completed"')));
		assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message?.role === "user"
			&& JSON.stringify(entry.message.content).includes("GLOBAL_ORIGINAL_PROMPT")).length, 1);
		console.log(JSON.stringify({ ok: true, package: "@earendil-works/pi-coding-agent", version, generatedExtension: true,
			nativeCompaction: compactStarts, providerHttpCalls: httpCalls, originalPromptWrites: 1 }));
	} finally { clearTimeout(deadline); session.dispose(); }
} finally {
	if (server) await new Promise((resolve) => server.close(resolve));
	const relative = path.relative(path.resolve(tmpdir()), path.resolve(temp));
	assert.ok(relative.startsWith("pi-global-managed-context-") && !relative.includes(path.sep), "Unsafe cleanup target");
	await rm(temp, { recursive: true, force: true });
}
