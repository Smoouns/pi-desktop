import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { loadExtensions } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";
import { stripNovelContextForDisplay } from "../../src/components/chat-view/backend-message-mapper.js";
import { NOVEL_TOOLS_EXTENSION_CONTENT } from "../../src/extensions/novel-tools-extension.ts";
import { shouldAttachNovelContext } from "../../src/novel/context-attachment.js";
import { buildNovelContext, serializeNovelContextManifest, type ContextItem } from "../../src/novel/context.js";
import type { NovelAuthority, NovelContentType, NovelDocument } from "../../src/novel/project.js";
import { withProject, type RunCase } from "./testkit.js";

type Loaded = Awaited<ReturnType<typeof loadExtensions>>["extensions"][number];
type HookResult = { block?: boolean; systemPrompt?: string; messages?: Array<Record<string, unknown>> } | undefined;
const hookResult = (value: unknown): HookResult => value as HookResult;
const errorFlag = (value: unknown): boolean | undefined => (value as { isError?: boolean } | null)?.isError;
const resultText = (result: { content?: Array<{ type?: string; text?: string }> }): string => result.content?.find((part) => part.type === "text")?.text ?? "";
const item = (relativePath: string, reason: string, overrides: Partial<ContextItem> = {}): ContextItem => ({
	path: `C:/synthetic/${relativePath}`, relativePath, contentType: "canon", authority: "canonical", reason,
	readRequirement: reason === "active document" ? "required" : "on-demand", estimatedTokens: 8, priority: 1, pinned: false, ...overrides,
});
const document = (relativePath: string, estimatedTokens: number, authority: NovelAuthority = "canonical", contentType: NovelContentType = "canon"): NovelDocument => ({
	path: `C:/synthetic/${relativePath}`, relativePath, name: path.posix.basename(relativePath), category: contentType,
	classification: { authority, contentType, reason: "test" }, estimatedTokens, text: relativePath,
});

async function withLoadedExtension<T>(project: string, minified: boolean, body: (extension: Loaded) => Promise<T>): Promise<T> {
	const temp = await mkdtemp(path.join(tmpdir(), "pi-harness-extension-"));
	try {
		const extensionPath = path.join(temp, "novel-tools.ts");
		let source = NOVEL_TOOLS_EXTENSION_CONTENT;
		if (minified) {
			const factoryModule = path.join(temp, "factory.mjs");
			await build({ entryPoints: [path.resolve("src/extensions/novel-tools-extension.ts")], outfile: factoryModule, bundle: true, platform: "node", format: "esm", packages: "external", minify: true });
			const builtFactory = await import(`${pathToFileURL(factoryModule).href}?case=${Date.now()}`) as { NOVEL_TOOLS_EXTENSION_CONTENT: string };
			source = builtFactory.NOVEL_TOOLS_EXTENSION_CONTENT;
		}
		await writeFile(extensionPath, source, "utf8");
		const loaded = await loadExtensions([extensionPath], project);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		return await body(loaded.extensions[0]);
	} finally { await rm(temp, { recursive: true, force: true }); }
}

function userContext(manifest: string, block = false, crlf = false) {
	const text = `请求正文\n\n<novel-context>\n${manifest}\n</novel-context>`;
	return { role: "user", content: block ? [{ type: "text", text: crlf ? text.replace(/\n/g, "\r\n") : text }] : (crlf ? text.replace(/\n/g, "\r\n") : text) };
}

export async function runContractCases(runCase: RunCase): Promise<void> {
	await runCase("CTX-01", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const active = { ...document("canon/world.md", 8), text: "CTX_ACTIVE_BODY_SENTINEL" };
		const mentioned = { ...document("canon/characters.md", 8, "reference"), text: "CTX_MENTIONED_BODY_SENTINEL" };
		const built = buildNovelContext({ activeDocument: active, mentionedDocuments: [mentioned] });
		const manifest = serializeNovelContextManifest(built);
		assert.match(manifest, /active_document: true/);
		assert.doesNotMatch(manifest, /CTX_(?:ACTIVE|MENTIONED)_BODY_SENTINEL/);
		assert.match(manifest, /authority: canonical[\s\S]*read_requirement: required/);
		assert.match(manifest, /authority: reference[\s\S]*read_requirement: on-demand/);
		const handler = (extension.handlers.get("context") ?? [])[0];
		for (const block of [false, true]) {
			const messages = [userContext(manifest.replace("canon/world.md", "canon/old.md"), block), { role: "assistant", content: [{ type: "text", text: "工具正文保留" }] }, userContext(manifest, block)];
			const transformed = hookResult(await handler({ type: "context", messages }, { cwd: root } as never));
			assert.ok(transformed?.messages);
			assert.equal(transformed.messages.filter((message: { customType?: string }) => message.customType === "novel-request-context").length, 1);
			assert.doesNotMatch(JSON.stringify(transformed.messages), /<novel-context>|canon\/old\.md/);
			assert.match(JSON.stringify(transformed.messages), /canon\/world\.md/);
			assert.match(JSON.stringify(transformed.messages), /工具正文保留/);
			assert.doesNotMatch(JSON.stringify(transformed.messages), /CTX_(?:ACTIVE|MENTIONED)_BODY_SENTINEL/);
		}
		assert.equal(stripNovelContextForDisplay(`可见请求\n<novel-context>\n${manifest}\n</novel-context>`), "可见请求");
		record("manifest_transformed", { entries: 2, inlineBody: false, textAndBlockMessages: true });
	})));

	await runCase("CTX-02", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const tool = extension.tools.get("get_current_document")!.definition;
		const run = async (messages: unknown[]) => resultText(await tool.execute("current", {}, undefined, undefined, { cwd: root, sessionManager: { getBranch: () => messages.map((message) => ({ type: "message", message })) } } as never));
		const manifest = serializeNovelContextManifest([
			item("canon/characters.md", "mentioned entity"),
			item("canon/world.md", "active document"),
		]);
		for (const [block, crlf] of [[false, false], [true, false], [false, true]] as const) assert.match(await run([userContext(manifest, block, crlf)]), /^# canon\/world\.md/m);
		const legacy = "### canon/world.md\ncontentType: canon\nauthority: canonical\nreason: active";
		assert.match(await run([userContext(legacy)]), /^# canon\/world\.md/m);
		for (const messages of [[], [{ role: "user", content: "无索引" }], [userContext(serializeNovelContextManifest([item("canon/world.md", "memory search", { memory: { id: "x" } as never })]))]]) {
			assert.match(await run(messages), /did not supply an active document/);
		}
		const oldActive = userContext(serializeNovelContextManifest([item("canon/world.md", "active document")]));
		const newestMemoryOnly = userContext(serializeNovelContextManifest([item("canon/characters.md", "memory search", { memory: { id: "latest-memory" } as never })]));
		assert.match(await run([oldActive, newestMemoryOnly]), /did not supply an active document/);
		record("active_document_parsed", { preamble: true, crlf: true, legacy: true, noGuess: true });
	})));

	await runCase("CTX-03", (record) => {
		assert.equal(shouldAttachNovelContext({ text: "开始任务", isSlashCommand: false, alreadyAttached: false }), true);
		assert.equal(shouldAttachNovelContext({ text: "普通追问", isSlashCommand: false, alreadyAttached: true }), false);
		assert.equal(shouldAttachNovelContext({ text: "选择更新后", isSlashCommand: false, alreadyAttached: false }), true);
		assert.equal(shouldAttachNovelContext({ text: "/model", isSlashCommand: true, alreadyAttached: false }), false);
		record("send_decision", { first: true, ordinaryFollowup: false, explicitReset: true, slashCommand: false });
	});

	await runCase("CTX-04", (record) => {
		const first = document("canon/huge.md", 120);
		const duplicate = { ...first, path: "c:/SYNTHETIC/canon/huge.md" };
		const pinned = document("canon/pinned.md", 90);
		const normal = document("canon/normal.md", 2);
		const historical = document("archive/old.md", 1, "historical", "archive");
		const external = document("research/web.md", 1, "external-reference", "research");
		const selected = buildNovelContext({ activeDocument: first, selectedDocuments: [duplicate, normal, historical, external], pinnedDocuments: [pinned], excludedPaths: [normal.path], tokenBudget: 10 });
		assert.deepEqual(selected.map((entry) => entry.relativePath), ["canon/huge.md", "canon/pinned.md"]);
		assert.equal(selected.reduce((sum, entry) => sum + entry.estimatedTokens, 0), 210);
		const manifest = serializeNovelContextManifest(selected);
		record("soft_budget", { selected: selected.length, estimatedTokens: 210, manifestChars: manifest.length, completeModelInputTokens: null });
	});

	await runCase("TOOL-01", (record) => withProject(async (root) => {
		for (const minified of [false, true]) await withLoadedExtension(root, minified, async (extension) => {
			for (const name of ["get_current_document", "read_story_document", "search_story_memory", "read_story_memory"]) assert.ok(extension.tools.has(name));
			const search = await extension.tools.get("search_story_memory")!.definition.execute("search", { query: "白潮栓", limit: 3 }, undefined, undefined, { cwd: root } as never);
			assert.equal(errorFlag(search), undefined, resultText(search));
			const parsed = JSON.parse(resultText(search));
			assert.ok(parsed.hits.length);
			const read = await extension.tools.get("read_story_memory")!.definition.execute("read", { id: parsed.hits[0].id }, undefined, undefined, { cwd: root } as never);
			assert.equal(errorFlag(read), undefined, resultText(read));
		});
		record("actual_pi_loader", { regular: true, minified: true, memoryRoundTrip: true });
	}));

	await runCase("TOOL-02", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const ctx = { cwd: root } as never;
		const normal = await extension.tools.get("read_story_document")!.definition.execute("normal", { path: "canon/world.md" }, undefined, undefined, ctx);
		assert.match(resultText(normal), /^# canon\/world\.md/m);
		const missing = await extension.tools.get("read_story_document")!.definition.execute("missing", { path: "canon/missing.md" }, undefined, undefined, ctx);
		assert.match(resultText(missing), /^Error:/);
		assert.equal(errorFlag(missing), undefined);
		const search = await extension.tools.get("search_story_memory")!.definition.execute("stale-search", { query: "白潮栓", limit: 3 }, undefined, undefined, ctx);
		const searched = JSON.parse(resultText(search)) as { hits: Array<{ id: string; path: string }> };
		assert.ok(searched.hits.length);
		const staleSource = searched.hits[0];
		await writeFile(path.join(root, staleSource.path), `${await readFile(path.join(root, staleSource.path), "utf8")}\n来源已更新。\n`, "utf8");
		const stale = await extension.tools.get("read_story_memory")!.definition.execute("stale-read", { id: staleSource.id }, undefined, undefined, ctx);
		assert.equal(errorFlag(stale), true);
		assert.match(resultText(stale), /失效|不存在|当前项目/);
		const invalid = await extension.tools.get("read_story_memory")!.definition.execute("invalid", { id: "foreign-id" }, undefined, undefined, ctx);
		assert.equal(errorFlag(invalid), true);
		const badChapter = await extension.tools.get("read_chapter")!.definition.execute("bad", { identifier: "../../1" }, undefined, undefined, ctx);
		assert.match(resultText(badChapter), /^Error:/);
		record("error_shapes", { missingPathTypedError: false, staleMemoryTypedError: true, foreignMemoryTypedError: true, invalidArgumentFinished: true });
	})));

	await runCase("SEC-01", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const hook = (extension.handlers.get("tool_call") ?? [])[0];
		const previousRole = process.env.PI_DESKTOP_NOVEL_ROLE;
		delete process.env.PI_DESKTOP_NOVEL_ROLE;
		let sideEffects = 0;
		const invoke = async (role: string | null, toolName: string, target?: string) => {
			const branch = role ? [{ type: "custom", customType: "pi-desktop-novel-role", data: { role } }] : [];
			const decision = hookResult(await hook({ type: "tool_call", toolName, toolCallId: "security", input: target ? { path: target, content: "x" } : { command: "echo x" } }, { cwd: root, sessionManager: { getBranch: () => branch } } as never));
			if (!decision?.block) sideEffects++;
			return decision;
		};
		try {
			assert.equal((await invoke("world", "write", "planning/world-proposals/a.md"))?.block, undefined);
			assert.equal((await invoke("plan", "write", "planning/chapter-cards/004.md"))?.block, undefined);
			assert.equal((await invoke("write", "edit", "drafts/candidates/chapters/003.md"))?.block, undefined);
			assert.equal((await invoke("review", "write", "planning/reviews/003.md"))?.block, undefined);
			const internalAbsolute = path.join(root, "drafts", "candidates", "chapters", "absolute.md");
			assert.equal((await invoke("write", "write", internalAbsolute))?.block, undefined);
			assert.equal((await invoke("write", "edit", internalAbsolute))?.block, undefined);
			const allowed = sideEffects;
			const denied: Array<readonly [string | null, string, string | undefined]> = [[null, "write", "drafts/candidates/chapters/x.md"]];
			for (const role of ["world", "plan", "write", "review"]) {
				denied.push([role, "write", "canon/x.md"], [role, "edit", "manuscript/x.md"], [role, "write", ".novel/x"], [role, "bash", undefined]);
			}
			denied.push(
				["write", "write", "planning/chapter-cards/x.md"],
				["plan", "write", "drafts/candidates/chapters/x.md"],
				["world", "write", "planning/chapter-cards/x.md"],
			);
			for (const [role, tool, target] of denied) assert.equal((await invoke(role, tool, target))?.block, true);
			assert.equal(sideEffects, allowed);
			await writeFile(path.join(root, ".novel/project.json"), "{ malformed", "utf8");
			assert.equal((await invoke(null, "write", "drafts/candidates/chapters/x.md"))?.block, true);
			assert.equal(sideEffects, allowed);
			record("role_policy", { allowedCalls: allowed, deniedCalls: denied.length + 1, deniedSideEffects: sideEffects - allowed, sideEffects });
		} finally {
			if (previousRole === undefined) delete process.env.PI_DESKTOP_NOVEL_ROLE; else process.env.PI_DESKTOP_NOVEL_ROLE = previousRole;
		}
	})));

	await runCase("SEC-02", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const sentinelRoot = await mkdtemp(path.join(tmpdir(), "pi-harness-sentinel-"));
		try {
			const sentinel = path.join(sentinelRoot, "outside.md");
			await writeFile(sentinel, "OUTSIDE_SENTINEL", "utf8");
			const tool = extension.tools.get("read_story_document")!.definition;
			const hook = (extension.handlers.get("tool_call") ?? [])[0];
			const variants = ["../outside.md", sentinel.replace(/\\/g, "/"), "canon\\..\\outside.md", "C:/outside.md", "//server/share/file.md", "canon/world.md:secret", "../project-prefix/outside.md"];
			for (const candidate of variants) {
				const result = await tool.execute("unsafe", { path: candidate }, undefined, undefined, { cwd: root } as never);
				assert.match(resultText(result), /^Error:/);
				assert.doesNotMatch(resultText(result), /OUTSIDE_SENTINEL/);
				for (const toolName of ["write", "edit"]) {
					const decision = hookResult(await hook({ type: "tool_call", toolName, toolCallId: "unsafe", input: { path: candidate, content: "x" } }, { cwd: root, sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-desktop-novel-role", data: { role: "write" } }] } } as never));
					assert.equal(decision?.block, true);
				}
			}
			assert.match(resultText(await tool.execute("safe", { path: "canon/world.md" }, undefined, undefined, { cwd: root } as never)), /^# canon\/world\.md/m);
			record("path_escape_rejected", { rejected: variants.length, writeEditRejected: variants.length * 2, sentinelLeaked: false, legalRead: true });
		} finally { await rm(sentinelRoot, { recursive: true, force: true }); }
	})));

	await runCase("SEC-03", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const outside = await mkdtemp(path.join(tmpdir(), "pi-harness-link-target-"));
		let fileLinkSupported = true, directoryLinkSupported = true;
		let fileLinkUnsupportedReason = "", directoryLinkUnsupportedReason = "";
		try {
			await writeFile(path.join(outside, "sentinel.md"), "LINK_SENTINEL", "utf8");
			try { await symlink(path.join(outside, "sentinel.md"), path.join(root, "canon/linked.md"), "file"); } catch (error) { fileLinkSupported = false; fileLinkUnsupportedReason = (error as NodeJS.ErrnoException).code ?? "unknown"; }
			try { await symlink(outside, path.join(root, "drafts/candidates/linked"), process.platform === "win32" ? "junction" : "dir"); } catch (error) { directoryLinkSupported = false; directoryLinkUnsupportedReason = (error as NodeJS.ErrnoException).code ?? "unknown"; }
			if (fileLinkSupported) {
				const read = await extension.tools.get("read_story_document")!.definition.execute("linked", { path: "canon/linked.md" }, undefined, undefined, { cwd: root } as never);
				assert.match(resultText(read), /^Error:/);
				assert.doesNotMatch(resultText(read), /LINK_SENTINEL/);
				const search = await extension.tools.get("search_story_memory")!.definition.execute("linked-memory", { query: "LINK_SENTINEL" }, undefined, undefined, { cwd: root } as never);
				const memoryResult = JSON.parse(resultText(search));
				assert.ok(!memoryResult.hits.some((hit: { path?: string; text?: string }) => hit.path === "canon/linked.md" || hit.text?.includes("LINK_SENTINEL")));
			}
			if (directoryLinkSupported) {
				const linkedRead = await extension.tools.get("read_story_document")!.definition.execute("linked-directory", { path: "drafts/candidates/linked/sentinel.md" }, undefined, undefined, { cwd: root } as never);
				assert.match(resultText(linkedRead), /^Error:/);
				assert.doesNotMatch(resultText(linkedRead), /LINK_SENTINEL/);
				const hook = (extension.handlers.get("tool_call") ?? [])[0];
				for (const toolName of ["write", "edit"]) {
					const decision = hookResult(await hook({ type: "tool_call", toolName, toolCallId: `linked-${toolName}`, input: { path: "drafts/candidates/linked/new.md", content: "x" } }, { cwd: root, sessionManager: { getBranch: () => [{ type: "custom", customType: "pi-desktop-novel-role", data: { role: "write" } }] } } as never));
					assert.equal(decision?.block, true);
				}
				await assert.rejects(readFile(path.join(outside, "new.md")));
			}
			const linkedMetadataProject = path.join(outside, "metadata-project");
			await mkdir(linkedMetadataProject);
			let metadataLinkSupported = true;
			let metadataLinkUnsupportedReason = "";
			try { await symlink(path.join(root, ".novel"), path.join(linkedMetadataProject, ".novel"), process.platform === "win32" ? "junction" : "dir"); } catch (error) { metadataLinkSupported = false; metadataLinkUnsupportedReason = (error as NodeJS.ErrnoException).code ?? "unknown"; }
			if (metadataLinkSupported) {
				const hook = (extension.handlers.get("tool_call") ?? [])[0];
				const decision = hookResult(await hook({ type: "tool_call", toolName: "write", toolCallId: "linked-metadata", input: { path: "drafts/candidates/x.md", content: "x" } }, { cwd: linkedMetadataProject, sessionManager: { getBranch: () => [] } } as never));
				assert.equal(decision?.block, true);
			}
			for (const [subcase, supported, reason] of [["file-symlink", fileLinkSupported, fileLinkUnsupportedReason], ["directory-link", directoryLinkSupported, directoryLinkUnsupportedReason], ["metadata-link", metadataLinkSupported, metadataLinkUnsupportedReason]] as const) {
				if (supported) continue;
				assert.match(reason, /^(?:EPERM|EACCES|ENOTSUP)$/);
				record("case.unsupported", { subcase, reason });
			}
			if (process.platform !== "win32") assert.ok(fileLinkSupported && directoryLinkSupported && metadataLinkSupported, "Linux must execute every real link subcase");
			if (process.platform === "win32") assert.ok(directoryLinkSupported && metadataLinkSupported, "Windows junction subcases must execute");
			record("links_rejected", { fileLinkSupported, directoryLinkSupported, metadataLinkSupported, sentinelLeaked: false, outsideWrite: false });
		} finally { await rm(outside, { recursive: true, force: true }); }
	})));
}
