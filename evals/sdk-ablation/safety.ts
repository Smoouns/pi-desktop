/** Embedded verbatim after TypeScript transpilation. No retry, ledger or context policy. */
export function createBaselineSafety(io: { path: typeof import("node:path"); lstat: typeof import("node:fs/promises").lstat; readFile: typeof import("node:fs/promises").readFile }) {
	const { path, lstat, readFile } = io;
	const checkedPath = async (root: string, candidate: unknown, missing: boolean): Promise<string> => {
		if (typeof candidate !== "string" || !candidate || candidate.includes("\\") || candidate.includes(":") || path.isAbsolute(candidate)
			|| candidate.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error("SDK_PATH_DENIED");
		let current = path.resolve(root);
		if ((await lstat(current)).isSymbolicLink()) throw new Error("SDK_PATH_DENIED");
		for (const part of candidate.split("/")) {
			current = path.join(current, part);
			try { if ((await lstat(current)).isSymbolicLink()) throw new Error("SDK_PATH_DENIED"); }
			catch (error) { if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return path.resolve(root, candidate); throw error; }
		}
		return current;
	};
	return {
		checkedPath,
		async check(toolName: string, input: { path?: unknown }, ctx: { cwd: string }) {
			if (!["read_story_document", "read", "write"].includes(toolName)) throw new Error("SDK_TOOL_DENIED");
			try {
				const metadata = await checkedPath(ctx.cwd, ".novel/project.json", false);
				const config = JSON.parse((await readFile(metadata, "utf8")).replace(/^\uFEFF/, ""));
				if (!config || typeof config !== "object" || Array.isArray(config) || config.formatVersion !== 1) throw new Error();
			} catch { throw new Error("SDK_METADATA_DENIED"); }
			// Missing read targets remain ordinary read errors; only unsafe paths are rejected here.
			await checkedPath(ctx.cwd, input.path, true);
		},
	};
}
