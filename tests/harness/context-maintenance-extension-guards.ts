import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SettingsManager } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/settings-manager.js";
import { withLoadedExtension } from "./contracts.js";
import { withProject, type RunCase } from "./testkit.js";

const messageEntries = (messages: any[]) => messages.map((message, index) => ({
	id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, type: "message", message,
}));

const largeHistory = (text = "必须保留的短用户约束") => messageEntries([
	{ role: "user", content: text, timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "可压缩的旧回答" + "乙".repeat(28_000) }], timestamp: 2 },
]);

async function fixture<T>(body: (state: {
	root: string; extension: any; branch: { current: any[] }; ctx: any; editor: string[]; notices: string[];
	agentDir: string; statuses: Array<[string, string | undefined]>;
}) => Promise<T>): Promise<T> {
	return withProject(async (root) => {
		const agentDir = await mkdtemp(path.join(tmpdir(), "pi-context-guards-"));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const settings = SettingsManager.create(root, agentDir);
			settings.setCompactionEnabled(true);
			await settings.flush();
			return await withLoadedExtension(root, false, async (extension, runtime) => {
				// Direct hook tests still need the Pi runtime interfaces used by the
				// request planner. Empty is a valid, fully known active tool registry.
				runtime.getActiveTools = () => [];
				runtime.getAllTools = () => [];
				const branch = { current: largeHistory() };
				const editor: string[] = [], notices: string[] = [], statuses: Array<[string, string | undefined]> = [];
				const ctx = {
					cwd: root,
					model: { provider: "synthetic", id: "guard-model", contextWindow: 12_000, maxTokens: 1_024 },
					isIdle: () => true, hasPendingMessages: () => false,
					getSystemPrompt: () => "system",
					sessionManager: { getSessionId: () => "guard-session", getBranch: () => branch.current },
					ui: {
						setEditorText: (text: string) => editor.push(text),
						notify: (text: string) => notices.push(text), setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
					},
				};
				return await body({ root, extension, branch, ctx, editor, notices, agentDir, statuses });
			});
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
			await rm(agentDir, { recursive: true, force: true });
		}
	});
}

const inputHook = (extension: any) => extension.handlers.get("input")[0] as (event: any, ctx: any) => Promise<any>;

export async function runContextMaintenanceGuardCases(runCase: RunCase): Promise<void> {
	await runCase("CM-GUARD-01 failed compact restores unsent input without replay", () => fixture(async ({ extension, ctx, editor }) => {
		let compacts = 0;
		ctx.compact = ({ onError }: any) => { compacts++; queueMicrotask(() => onError(new Error("synthetic failure"))); };
		const result = await inputHook(extension)({ type: "input", source: "interactive", text: "UNSENT_SENTINEL", images: [] }, ctx);
		assert.deepEqual(result, { action: "handled" }, `failed compact must handle input; compacts=${compacts}`);
		assert.equal(compacts, 1);
		assert.deepEqual(editor, ["UNSENT_SENTINEL"]);
		assert.doesNotMatch(JSON.stringify(ctx.sessionManager.getBranch()), /UNSENT_SENTINEL/);
	}));

	await runCase("CM-GUARD-02 still-large history stops after one compact", () => fixture(async ({ extension, ctx, editor }) => {
		let compacts = 0;
		ctx.compact = ({ onComplete }: any) => { compacts++; queueMicrotask(onComplete); };
		const result = await inputHook(extension)({ type: "input", source: "interactive", text: "ONE_SHOT", images: [] }, ctx);
		assert.deepEqual(result, { action: "handled" }, `still-large compact must handle input; compacts=${compacts}`);
		assert.equal(compacts, 1, "one input must never enter an automatic compaction loop");
		assert.deepEqual(editor, ["ONE_SHOT"]);
	}));

	await runCase("CM-GUARD-03 session switch fences a pending compact callback", () => fixture(async ({ extension, branch, ctx, editor }) => {
		let complete!: () => void;
		ctx.compact = ({ onComplete }: any) => { complete = onComplete; };
		const pending = inputHook(extension)({ type: "input", source: "interactive", text: "OLD_SESSION", images: [] }, ctx);
		for (let attempt = 0; attempt < 50 && typeof complete !== "function"; attempt++)
			await new Promise<void>((resolve) => setTimeout(resolve, 2));
		assert.equal(typeof complete, "function", "input hook must start compact before session switch");
		branch.current = messageEntries([{ role: "user", content: "NEW_SESSION", timestamp: 3 }]);
		ctx.sessionManager.getSessionId = () => "new-session";
		await extension.handlers.get("session_switch")[0]({ type: "session_switch" }, ctx);
		complete();
		assert.deepEqual(await pending, { action: "handled" });
		assert.deepEqual(editor, [], "stale callback must not restore text into the new session editor");
		assert.match(JSON.stringify(branch.current), /NEW_SESSION/);
	}));

	await runCase("CM-GUARD-04 busy or pending extension inputs never compact", () => fixture(async ({ extension, ctx }) => {
		let compacts = 0;
		ctx.compact = () => { compacts++; };
		assert.equal(await inputHook(extension)({ type: "input", source: "extension", text: "x", images: [] }, ctx), undefined);
		ctx.isIdle = () => false;
		assert.equal(await inputHook(extension)({ type: "input", source: "interactive", text: "x", images: [] }, ctx), undefined);
		ctx.isIdle = () => true; ctx.hasPendingMessages = () => true;
		assert.equal(await inputHook(extension)({ type: "input", source: "interactive", text: "x", images: [] }, ctx), undefined);
		assert.equal(compacts, 0);
	}));

	await runCase("CM-GUARD-05 trimming old tool results can avoid model compaction", () => fixture(async ({ extension, branch, ctx }) => {
		const messages: any[] = [{ role: "user", content: "读取资料", timestamp: 1 }];
		for (let index = 0; index < 8; index++) messages.push({
			role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} }], timestamp: index + 2,
		}, {
			role: "toolResult", toolCallId: `call-${index}`, toolName: "read", isError: false,
			content: [{ type: "text", text: "a".repeat(20_000) }], timestamp: index + 2,
		});
		branch.current = messageEntries(messages);
		ctx.model = { ...ctx.model, contextWindow: 60_000 };
		let compacts = 0;
		ctx.compact = () => { compacts++; };
		const result = await inputHook(extension)({ type: "input", source: "interactive", text: "继续", images: [] }, ctx);
		assert.equal(result, undefined, "trimmed projection below pressure threshold must continue the original input");
		assert.equal(compacts, 0);
		assert.equal(branch.current.length, 17, "projection trimming must not mutate persisted history");
	}));

	await runCase("CM-GUARD-06 disabled compaction setting is honored", () => fixture(async ({ extension, root, agentDir, ctx, editor }) => {
		const settings = SettingsManager.create(root, agentDir);
		settings.setCompactionEnabled(false);
		await settings.flush();
		let compacts = 0;
		ctx.compact = () => { compacts++; };
		const result = await inputHook(extension)({ type: "input", source: "interactive", text: "NO_AUTO_COMPACT", images: [] }, ctx);
		assert.equal(result, undefined, "disabled maintenance must leave the original input path untouched");
		assert.equal(compacts, 0);
		assert.deepEqual(editor, []);
	}));

	await runCase("CM-GUARD-07 context status is readonly and reports SDK-default capacity", () => fixture(async ({ extension, branch, ctx, agentDir, statuses }) => {
		await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
			providers: { synthetic: { api: "openai-completions", models: [{ id: "guard-model" }] } },
		}), "utf8");
		ctx.model = { ...ctx.model, contextWindow: 128_000, maxTokens: 16_384 };
		let compacts = 0;
		ctx.compact = () => { compacts++; };
		const before = JSON.stringify(branch.current);
		await extension.commands.get("novel-context-status").handler("", ctx);
		assert.equal(compacts, 0);
		assert.equal(JSON.stringify(branch.current), before, "readonly telemetry must not append a message or entry");
		const raw = [...statuses].reverse().find(([key, value]) => key === "pi-desktop-context-budget" && value)?.[1];
		assert.ok(raw, "command must emit context telemetry");
		const snapshot = JSON.parse(raw!);
		assert.equal(snapshot.sessionId, "guard-session");
		assert.equal(snapshot.capacity.contextWindow, 128_000);
		assert.equal(snapshot.capacity.source, "sdk-default");
		assert.equal(snapshot.capacity.verified, false);
		assert.equal(snapshot.estimator, "estimated_tokens");
	}));

	await runCase("CM-GUARD-08 image input bypasses automatic maintenance without draft mutation", () => fixture(async ({ extension, ctx, editor, notices, statuses }) => {
		let compacts = 0;
		ctx.compact = () => { compacts++; };
		const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		const result = await inputHook(extension)({ type: "input", source: "interactive", text: "KEEP_IMAGE", images: [image] }, ctx);
		assert.equal(result, undefined, "multimodal input must continue through Pi's original input path");
		assert.equal(compacts, 0, "automatic maintenance cannot start when image recovery is unavailable");
		assert.deepEqual(editor, [], "extension must not overwrite the composer text or detach its images");
		assert.deepEqual(notices, []);
		assert.equal(statuses.some(([key]) => key === "novel-context-maintenance"), false);
	}));

	await runCase("CM-GUARD-09 declared provider capability never expands effective working budget", () => fixture(async ({ extension, ctx, agentDir, statuses, branch }) => {
		ctx.model = { ...ctx.model, contextWindow: 262_144, maxTokens: 16_384 };
		await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
			providers: { synthetic: { models: [{ id: "guard-model", contextWindow: 262_144, maxTokens: 16_384 }] } },
		}));
		const declaration = { provider: "synthetic", id: "guard-model", contextWindow: 1_048_576, maxOutputTokens: 65_536, source: "user-confirmed", privateField: "never-expose" };
		const target = path.join(agentDir, "pi-desktop-model-capabilities.json");
		const status = async () => {
			await extension.commands.get("novel-context-status").handler("", ctx);
			const raw = [...statuses].reverse().find(([key, value]) => key === "pi-desktop-context-budget" && value)?.[1];
			assert.ok(raw);
			assert.doesNotMatch(raw!, /never-expose/);
			return JSON.parse(raw!);
		};
		await writeFile(target, JSON.stringify({ version: 1, models: [declaration] }));
		const before = JSON.stringify(branch.current);
		const snapshot = await status();
		assert.equal(snapshot.capacity.contextWindow, 262_144);
		assert.equal(snapshot.capacity.maxOutputTokens, 16_384);
		assert.equal(snapshot.capacity.declaredContextWindow, 1_048_576);
		assert.equal(snapshot.capacity.declaredMaxOutputTokens, 65_536);
		assert.equal(snapshot.capacity.declaredSource, "user-confirmed");
		assert.equal(snapshot.capacity.verified, false);
		assert.equal(snapshot.ledger.limit, 262_144);
		assert.equal(snapshot.ledger.outputReserve, 16_384);
		assert.equal(JSON.stringify(branch.current), before);
		await writeFile(target, JSON.stringify({ version: 1, models: [declaration, declaration] }));
		assert.equal((await status()).capacity.declaredContextWindow, undefined, "ambiguous declaration is ignored");
		await writeFile(target, JSON.stringify({ version: 1, models: [{ ...declaration, contextWindow: 128_000 }] }));
		assert.equal((await status()).capacity.declaredContextWindow, undefined, "capacity below working budget is ignored");
		await writeFile(target, "not valid JSON");
		const invalid = await status();
		assert.equal(invalid.capacity.declaredContextWindow, undefined);
		assert.equal(invalid.ledger.limit, 262_144, "invalid display metadata cannot alter enforcement");
	}));
}
