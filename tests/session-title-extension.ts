import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { loadExtensions } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";
import { SESSION_TITLE_EXTENSION_CONTENT } from "../src/extensions/session-title-extension.ts";

export async function runSessionTitleExtensionTests(): Promise<void> {
	const previousOptIn = process.env.PI_DESKTOP_SESSION_TITLE;
	try {
	for (const minified of [false, true]) {
		const temp = await mkdtemp(path.join(tmpdir(), "pi-session-title-"));
		try {
			let source = SESSION_TITLE_EXTENSION_CONTENT;
			if (minified) {
				const builtPath = path.join(temp, "factory.mjs");
				await build({ entryPoints: [path.resolve("src/extensions/session-title-extension.ts")], outfile: builtPath, bundle: true, platform: "node", format: "esm", packages: "external", minify: true });
				const built = await import(`${pathToFileURL(builtPath).href}?v=${Date.now()}`) as { SESSION_TITLE_EXTENSION_CONTENT: string };
				source = built.SESSION_TITLE_EXTENSION_CONTENT;
			}
			const messages = [
				{ role: "user", content: "<novel-context>hidden</novel-context>测试自动命名" },
				{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "测试完成" }] },
			];
			let scenario = 0;
			delete process.env.PI_DESKTOP_SESSION_TITLE;
			const disabledPath = path.join(temp, `session-title-${scenario++}.ts`);
			await writeFile(disabledPath, source, "utf8");
			const disabled = await loadExtensions([disabledPath], temp);
			assert.deepEqual(disabled.errors, []);
			assert.equal(disabled.extensions[0]?.handlers.get("agent_end"), undefined, "global extension must register no naming handler without Desktop opt-in");
			assert.equal(disabled.extensions[0]?.handlers.get("session_switch"), undefined);

			const setup = async (complete: (...args: unknown[]) => Promise<unknown>) => {
				const extensionPath = path.join(temp, `session-title-${scenario++}.ts`);
				await writeFile(extensionPath, source, "utf8");
				process.env.PI_DESKTOP_SESSION_TITLE = "1";
				const loaded = await loadExtensions([extensionPath], temp);
				assert.deepEqual(loaded.errors, []);
				assert.equal(loaded.extensions.length, 1);
				const extension = loaded.extensions[0];
				const end = extension.handlers.get("agent_end")?.[0];
				const switchSession = extension.handlers.get("session_switch")?.[0];
				assert.ok(end && switchSession);
				let name: string | undefined;
				const entries: Array<{ type: string; customType: string; data: unknown }> = [];
				const statuses: Array<{ key: string; text: string | undefined }> = [];
				loaded.runtime.getSessionName = () => name;
				loaded.runtime.setSessionName = (next) => { name = next; };
				loaded.runtime.appendEntry = (customType, data) => { entries.push({ type: "custom", customType, data }); };
				const manager = {
					getSessionName: () => name,
					getSessionId: () => "session-a",
					getSessionFile: () => "session-a.jsonl",
					getEntries: () => entries.slice(),
				};
				const ctx = {
					sessionManager: manager,
					model: { provider: "synthetic", id: "offline" },
					modelRegistry: { complete },
					ui: { setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }) },
				};
				return { end: end!, switchSession: switchSession!, ctx, entries, statuses, getName: () => name, setName: (next: string) => { name = next; } };
			};
			const response = (title: string) => ({ content: [{ type: "thinking", thinking: "not displayed" }, { type: "text", text: title }] });
			const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

			let successOptions: Record<string, unknown> | undefined;
			const success = await setup(async (_model, _request, options) => {
				successOptions = options as Record<string, unknown>;
				return response("标题：第一章规划");
			});
			await success.end({ type: "agent_end", messages } as never, success.ctx as never);
			await settle();
			assert.equal(success.getName(), "第一章规划", "new ModelRegistry.complete path must write the generated title");
			assert.equal(success.entries.length, 1, "successful naming must persist one durable attempt");
			assert.equal(successOptions?.maxTokens, 384, "small title request must leave room for thinking-model output");
			assert.equal(Object.hasOwn(successOptions ?? {}, "reasoningEffort"), false, "title request must not inherit the chat's high thinking effort");
			assert.deepEqual(success.statuses, [{
				key: "pi-desktop-session-title",
				text: JSON.stringify({ sessionId: "session-a", sessionFile: "session-a.jsonl", title: "第一章规划" }),
			}], "successful naming must emit one RPC setStatus payload for immediate desktop refresh");
			await success.end({ type: "agent_end", messages } as never, success.ctx as never);
			assert.equal(success.entries.length, 1, "named sessions must not attempt another model call");

			let resolveSwitch!: (value: unknown) => void;
			const afterSwitch = await setup(() => new Promise((resolve) => { resolveSwitch = resolve; }));
			await afterSwitch.end({ type: "agent_end", messages } as never, afterSwitch.ctx as never);
			await afterSwitch.switchSession({ type: "session_switch", reason: "resume", previousSessionFile: "old" } as never, afterSwitch.ctx as never);
			resolveSwitch(response("不应写入"));
			await settle();
			assert.equal(afterSwitch.getName(), undefined, "a response arriving after session switch must be discarded");
			assert.deepEqual(afterSwitch.statuses, []);

			let resolveManual!: (value: unknown) => void;
			const manual = await setup(() => new Promise((resolve) => { resolveManual = resolve; }));
			await manual.end({ type: "agent_end", messages } as never, manual.ctx as never);
			manual.setName("人工标题");
			resolveManual(response("模型标题"));
			await settle();
			assert.equal(manual.getName(), "人工标题", "manual naming during the background request must win");
			assert.deepEqual(manual.statuses, []);

			const modelError = await setup(async () => ({
				stopReason: "error", errorMessage: "authentication failed",
				content: [{ type: "text", text: "authentication failed" }],
			}));
			await modelError.end({ type: "agent_end", messages } as never, modelError.ctx as never);
			await settle();
			assert.equal(modelError.getName(), undefined, "model errors must never become session titles");
			assert.deepEqual(modelError.statuses, []);

			const failedCurrentTurn = await setup(async () => response("不应请求模型"));
			await failedCurrentTurn.end({ type: "agent_end", messages: [
				...messages,
				{ role: "user", content: "当前请求" },
				{ role: "assistant", stopReason: "error", content: [{ type: "text", text: "当前失败" }] },
			] } as never, failedCurrentTurn.ctx as never);
			await settle();
			assert.equal(failedCurrentTurn.entries.length, 0, "a failed latest turn must not name from an older successful turn");
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	}
	} finally {
		if (previousOptIn === undefined) delete process.env.PI_DESKTOP_SESSION_TITLE;
		else process.env.PI_DESKTOP_SESSION_TITLE = previousOptIn;
	}
}
