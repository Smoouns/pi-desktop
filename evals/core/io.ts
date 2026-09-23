import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
/** Stable object ordering; arrays retain task/trace order. Only JSON values accepted. */
export function canonical(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	throw new Error("NON_JSON_VALUE");
}
export const digest = (value: unknown): string => sha256(canonical(value));

export async function treeManifest(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	async function visit(relative: string): Promise<void> {
		const full = path.join(root, relative);
		const stat = await lstat(full);
		assert.ok(!stat.isSymbolicLink(), "SOURCE_LINK_REJECTED");
		if (stat.isFile()) { files[relative] = sha256(await readFile(full)); return; }
		assert.ok(stat.isDirectory(), "SOURCE_TYPE_REJECTED");
		for (const name of (await readdir(full)).sort()) await visit(relative ? `${relative}/${name}` : name);
	}
	await visit("");
	return files;
}

export async function writeOnce(filename: string, value: unknown): Promise<void> {
	await writeFile(filename, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
}

export async function readBounded(filename: string, maxBytes = 1024 * 1024): Promise<string> {
	const stat = await lstat(filename);
	assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, "INVALID_ARTIFACT_FILE");
	const bytes = await readFile(filename);
	assert.ok(bytes.byteLength <= maxBytes, "ARTIFACT_TOO_LARGE");
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Reject symlink/junction ancestors before reading or deleting bounded work paths. */
export async function assertInside(root: string, target: string): Promise<void> {
	const base = path.resolve(root), resolved = path.resolve(target);
	const relative = path.relative(base, resolved);
	assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "PATH_OUTSIDE_EVAL_ROOT");
	const physicalBase = await realpath(base);
	const physicalTarget = await realpath(resolved);
	const physicalRelative = path.relative(physicalBase, physicalTarget);
	assert.ok(physicalRelative && !physicalRelative.startsWith("..") && !path.isAbsolute(physicalRelative), "PATH_OUTSIDE_EVAL_ROOT");
	let current = base;
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);
		assert.ok(!(await lstat(current)).isSymbolicLink(), "ARTIFACT_LINK_REJECTED");
	}
}
