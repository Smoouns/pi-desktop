import { lstat, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { joinFsPath } from "./project.js";
import { createNovelMemoryEngine, type MemoryIO, type StoryMemoryQuery, type StoryMemorySearch, type StoryMemorySnapshot } from "./memory-engine.js";

export const novelMemoryEngine = createNovelMemoryEngine();

/** Each scan receives its own adapter, so neither content nor path checks cross projects. */
export function createTauriMemoryIO(root: string): MemoryIO {
	const resolve = async (relative: string): Promise<string> => {
		if (!novelMemoryEngine.safePath(relative)) throw new Error("记忆路径必须位于当前小说项目内。");
		let path = root;
		for (const segment of relative.split("/")) {
			path = joinFsPath(path, segment);
			const info = await lstat(path);
			if (info.isSymlink) throw new Error("记忆索引不跟随符号链接。");
		}
		return path;
	};
	return {
		async read(relative) {
			const path = await resolve(relative);
			const info = await lstat(path);
			if (!info.isFile || info.size > 1_600_000) throw new Error("文件超过记忆索引读取范围。");
			return readTextFile(path);
		},
		async list(relative) {
			const path = relative ? await resolve(relative) : root;
			return (await readDir(path)).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory, isFile: entry.isFile, isSymlink: entry.isSymlink }));
		},
	};
}

export async function loadStoryMemorySnapshot(root: string): Promise<StoryMemorySnapshot> {
	return novelMemoryEngine.snapshot(root, createTauriMemoryIO(root));
}

export async function searchStoryMemory(root: string, query: StoryMemoryQuery): Promise<StoryMemorySearch> {
	return novelMemoryEngine.search(await loadStoryMemorySnapshot(root), query);
}
