import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import {
	categoryForRelativePath,
	classifyNovelDocument,
	estimateTokens,
	joinFsPath,
	normalizeFsPath,
	parseDeclaredStatus,
	type NovelDocument,
	type NovelProject,
} from "./project.js";

function isTextPath(path: string): boolean {
	return /\.(?:md|markdown|mdx|txt)$/i.test(path);
}

function baseName(path: string): string {
	return normalizeFsPath(path).split("/").pop() ?? path;
}

async function scanDirectory(project: NovelProject, directory: string, relativeBase: string, output: NovelDocument[]): Promise<void> {
	const entries = await readDir(directory);
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const fullPath = joinFsPath(directory, entry.name);
		const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
		if (entry.isDirectory) {
			await scanDirectory(project, fullPath, relativePath, output);
			continue;
		}
		if (!isTextPath(entry.name)) continue;
		let text = "";
		try {
			text = await readTextFile(fullPath);
		} catch {
			continue;
		}
		const declaredStatus = parseDeclaredStatus(text);
		const classification = classifyNovelDocument(relativePath, project.config, declaredStatus);
		output.push({
			path: fullPath,
			relativePath,
			name: baseName(fullPath),
			category: categoryForRelativePath(relativePath, project.config),
			classification,
			estimatedTokens: estimateTokens(text),
			text,
		});
	}
}

export async function scanNovelDocuments(project: NovelProject): Promise<NovelDocument[]> {
	const documents: NovelDocument[] = [];
	await scanDirectory(project, project.rootPath, "", documents);
	return documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
