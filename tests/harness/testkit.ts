import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunScope } from "../../src/harness/types.js";

export type RecordEvent = (event: string, data?: Record<string, string | number | boolean | null>) => void;
export type RunCase = (
	id: string,
	body: (record: RecordEvent) => Promise<void> | void,
	scope?: Partial<RunScope>,
) => Promise<void>;
export const fixtureRoot = path.resolve("fixtures/harness-novel");
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export async function treeManifest(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	async function visit(relative: string): Promise<void> {
		for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
			assert.ok(!entry.isSymbolicLink(), "Committed fixture must not contain links");
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await visit(name);
			else if (entry.isFile()) files[name] = sha256(await readFile(path.join(root, name)));
		}
	}
	await visit("");
	return files;
}

/** Tests mutate a private temporary copy, never the committed fixture. */
export async function withProject<T>(body: (root: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-harness-case-"));
	try {
		await cp(fixtureRoot, root, { recursive: true });
		return await body(root);
	} finally {
		const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
		assert.ok(relative.startsWith("pi-harness-case-") && !relative.includes(path.sep), "Unsafe cleanup target");
		await rm(root, { recursive: true, force: true });
	}
}
