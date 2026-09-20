/** In-memory Tauri FS adapter, bundled only into fault-injection tests. */
export const files = new Map<string, string>();
const dirs = new Set<string>();
const names = new Map<string, string>();
export const faults = { writes: 0, failWrite: 0, afterPartialWrite: false };
const key = (path: string) => path.replace(/\\/g, "/").toLowerCase();
export function reset(): void { files.clear(); dirs.clear(); names.clear(); Object.assign(faults, { writes: 0, failWrite: 0, afterPartialWrite: false }); }
export async function exists(path: string): Promise<boolean> { return files.has(key(path)) || dirs.has(key(path)); }
export async function mkdir(path: string): Promise<void> { dirs.add(key(path)); }
export async function readTextFile(path: string): Promise<string> {
	if (!files.has(key(path))) throw new Error(`Missing file: ${path}`);
	return files.get(key(path))!;
}
export async function writeTextFile(path: string, text: string): Promise<void> {
	names.set(key(path), path.replace(/\\/g, "/").split("/").pop()!);
	faults.writes += 1;
	if (faults.writes === faults.failWrite) {
		if (faults.afterPartialWrite) files.set(key(path), text.slice(0, 4));
		throw new Error("injected write failure");
	}
	files.set(key(path), text);
}
export async function remove(path: string): Promise<void> { files.delete(key(path)); names.delete(key(path)); }
export async function readDir(path: string): Promise<Array<{ name: string; isFile: boolean }>> {
	const prefix = key(path) + "/";
	return [...files.keys()].filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes("/"))
		.map((file) => ({ name: names.get(file) ?? file.slice(prefix.length), isFile: true }));
}
