/** Reproduce raw contract failures against the frozen Phase-0 baseline. */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { loadExtensions } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";

const BASELINE = "3b5f8b06131d46ee0b4b97dd646ba3d6f6bcd887";
const sourceMode = process.argv.includes("--current") ? "current" : "baseline";
const git = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "pi-desktop-contract-raw-"));

try {
	const checkout = path.join(root, sourceMode);
	let extensionSource = path.resolve("src/extensions/novel-tools-extension.ts");
	let contextSource = path.resolve("src/novel/context.ts");
	if (sourceMode === "baseline") {
		extensionSource = path.join(checkout, "src/extensions/novel-tools-extension.ts");
		const memorySource = path.join(checkout, "src/novel/memory-engine.ts");
		contextSource = path.join(checkout, "src/novel/context.ts");
		await mkdir(path.dirname(extensionSource), { recursive: true });
		await mkdir(path.dirname(memorySource), { recursive: true });
		for (const [gitPath, output] of [["src/extensions/novel-tools-extension.ts", extensionSource], ["src/novel/memory-engine.ts", memorySource], ["src/novel/context.ts", contextSource]] as const) {
			const { stdout } = await git("git", ["show", `${BASELINE}:${gitPath}`], { cwd: path.resolve(".") });
			await writeFile(output, stdout, "utf8");
		}
	}
	const extensionModule = await import(`${pathToFileURL(extensionSource).href}?probe=${sourceMode}`) as { NOVEL_TOOLS_EXTENSION_CONTENT: string };
	const sourceHashes = {
		extension: createHash("sha256").update(await readFile(extensionSource)).digest("hex"),
		context: createHash("sha256").update(await readFile(contextSource)).digest("hex"),
	};
	const contextModule = await import(`${pathToFileURL(contextSource).href}?probe=${sourceMode}`) as { serializeNovelContextManifest(items: unknown[]): string };
	const project = path.join(root, "project"), outside = path.join(root, "sentinel.md");
	await mkdir(path.join(project, ".novel"), { recursive: true });
	await mkdir(path.join(project, "canon"), { recursive: true });
	await writeFile(path.join(project, ".novel", "project.json"), JSON.stringify({ formatVersion: 1, layout: { canon: ["canon"] } }));
	await writeFile(path.join(project, "canon", "active.md"), "ACTIVE");
	await writeFile(outside, "OUTSIDE_SENTINEL");
	let symlinkSupported = true;
	let symlinkUnsupportedReason: string | null = null;
	try { await symlink(outside, path.join(project, "canon", "linked.md"), "file"); } catch (error) {
		symlinkSupported = false;
		symlinkUnsupportedReason = (error as NodeJS.ErrnoException).code ?? "unknown";
		assert.equal(process.platform, "win32");
		assert.match(symlinkUnsupportedReason, /^(?:EPERM|EACCES|ENOTSUP)$/);
	}
	const extensionPath = path.join(root, "novel-tools.ts");
	await writeFile(extensionPath, extensionModule.NOVEL_TOOLS_EXTENSION_CONTENT);
	const loaded = await loadExtensions([extensionPath], project);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const manifest = contextModule.serializeNovelContextManifest([{
		path: path.join(project, "canon", "active.md"), relativePath: "canon/active.md", contentType: "canon", authority: "canonical", reason: "active document",
		readRequirement: "required", estimatedTokens: 2, priority: 1, pinned: false,
	}]);
	const ctx = { cwd: project, sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: `request\n\n<novel-context>\n${manifest}\n</novel-context>` } }] } };
	const current = await extension.tools.get("get_current_document")!.definition.execute("raw-current", {}, undefined, undefined, ctx as never);
	const currentText = current.content.find((part) => part.type === "text")?.text ?? "";
	let linkText = "unsupported";
	if (symlinkSupported) {
		const linked = await extension.tools.get("read_story_document")!.definition.execute("raw-link", { path: "canon/linked.md" }, undefined, undefined, { cwd: project } as never);
		linkText = linked.content.find((part) => part.type === "text")?.text ?? "";
	}
	await writeFile(path.join(project, ".novel", "project.json"), "{ malformed");
	const toolCall = (extension.handlers.get("tool_call") ?? [])[0];
	const malformedDecision = await toolCall({ type: "tool_call", toolName: "write", toolCallId: "raw", input: { path: "drafts/candidates/001.md", content: "x" } }, { cwd: project, sessionManager: { getBranch: () => [] } } as never);
	console.log(JSON.stringify({
		source: sourceMode,
		baseline: sourceMode === "baseline" ? BASELINE : null,
		node: process.version, platform: process.platform, sourceHashes,
		parserRejectedRealManifest: currentText.includes("did not supply an active document"),
		symlinkSupported,
		symlinkUnsupportedReason,
		symlinkReadOutsideSentinel: symlinkSupported ? linkText.includes("OUTSIDE_SENTINEL") : null,
		malformedMetadataAllowedWrite: malformedDecision === undefined,
	}, null, 2));
} finally {
	await rm(root, { recursive: true, force: true });
}
