import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { DEFAULT_NOVEL_LAYOUT, NOVEL_FORMAT_VERSION, joinFsPath, type NovelProject, type NovelProjectConfig } from "./project.js";

function defaultConfig(name: string): NovelProjectConfig {
	return {
		formatVersion: NOVEL_FORMAT_VERSION,
		name,
		localFirst: true,
		layout: DEFAULT_NOVEL_LAYOUT,
	};
}

export async function loadNovelProject(rootPath: string): Promise<NovelProject | null> {
	const configPath = joinFsPath(rootPath, ".novel/project.json");
	if (!(await exists(configPath))) return null;
	try {
		const parsed = JSON.parse(await readTextFile(configPath)) as Partial<NovelProjectConfig>;
		return {
			rootPath,
			configPath,
			config: {
				...defaultConfig(rootPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Novel Project"),
				...parsed,
			},
			initialized: true,
		};
	} catch {
		return null;
	}
}

export async function initializeNovelProject(rootPath: string, name?: string): Promise<NovelProject> {
	const existing = await loadNovelProject(rootPath);
	if (existing) return existing;
	const config = defaultConfig(name?.trim() || rootPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Novel Project");
	const novelRoot = joinFsPath(rootPath, ".novel");
	await mkdir(novelRoot, { recursive: true });
	for (const directory of ["manuscript", "canon", "planning", "drafts", "craft", "notes", "memory"]) {
		await mkdir(joinFsPath(rootPath, directory), { recursive: true });
	}
	const configPath = joinFsPath(novelRoot, "project.json");
	if (!(await exists(configPath))) await writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
	return { rootPath, configPath, config, initialized: true };
}
