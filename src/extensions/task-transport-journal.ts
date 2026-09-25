import type { TransportOwner } from "../harness/task-transport-ledger.ts";

type FileStat = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; nlink: number; isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean };
type JournalFs = {
	lstatSync(file: string): FileStat; fstatSync(fd: number): FileStat;
	openSync(file: string, flags: string | number, mode?: number): number; closeSync(fd: number): void;
	readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
	writeFileSync(fd: number, text: string, encoding: "utf8"): void; fsyncSync(fd: number): void;
	mkdirSync(file: string, options: { mode: number }): unknown; renameSync(from: string, to: string): void; unlinkSync(file: string): void;
	constants: { O_RDONLY: number; O_NOFOLLOW?: number };
};

/** Pi buffers session entries until the first assistant message. This small
 * sidecar is the sending-layer receipt, not a second conversation/history.
 * One bounded scalar snapshot per session/task; no automatic eviction/replay.
 * The synchronous commit finishes before fetch. Power-loss guarantees still
 * depend on the OS/filesystem; a leftover lock fails closed, never steals a lock.
 */
export function createTaskTransportJournal(deps: { fs: JournalFs; path: { dirname(file: string): string; basename(file: string): string; join(...parts: string[]): string; isAbsolute(file: string): boolean }; digest: (text: string) => string }) {
	const { fs, path } = deps;
	const limit = 36_000;
	const failure = () => new Error("TRANSPORT_STORAGE_INVALID_OR_BUSY");
	const stat = (file: string) => { try { return fs.lstatSync(file); } catch (error: any) { if (error.code === "ENOENT") return null; throw failure(); } };
	const same = (a: FileStat, b: FileStat) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
	const directories = (directory: string) => {
		let item = directory;
		for (;;) {
			const info = stat(item);
			if (!info?.isDirectory() || info.isSymbolicLink()) throw failure();
			const parent = path.dirname(item); if (parent === item) break; item = parent;
		}
	};
	const read = (file: string): string | null => {
		const info = stat(file); if (!info) return null;
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) throw failure();
		const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		try {
			const opened = fs.fstatSync(fd); if (!same(info, opened)) throw failure();
			const buffer = new Uint8Array(limit + 1); let size = 0, count;
			while (size <= limit && (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
			if (size > limit || size !== opened.size || !same(opened, fs.fstatSync(fd))) throw failure();
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
		} finally { fs.closeSync(fd); }
	};
	return {
		open(sessionFile: string, owner: TransportOwner) {
			if (typeof sessionFile !== "string" || !path.isAbsolute(sessionFile)) throw failure();
			const parent = path.dirname(sessionFile), directory = path.join(parent, ".pi-desktop-transport");
			directories(parent);
			const key = deps.digest(JSON.stringify([path.basename(sessionFile), owner]));
			if (!/^[a-f0-9]{64}$/.test(key)) throw failure();
			const file = path.join(directory, key + ".json"), lock = file + ".lock", temporary = file + ".next";
			const folder = stat(directory);
			if (folder && (!folder.isDirectory() || folder.isSymbolicLink())) throw failure();
			if (stat(lock) || stat(temporary)) throw failure();
			let expected = folder ? read(file) : null;
			let record = null;
			if (expected !== null) {
				try {
					const parsed = JSON.parse(expected);
					if (Object.keys(parsed).sort().join() !== "key,record,version" || parsed.version !== 1 || parsed.key !== key || !parsed.record || JSON.stringify(parsed.record.owner) !== JSON.stringify(owner)) throw failure();
					record = parsed.record;
				} catch { throw failure(); }
			}
			return {
				record,
				append(data: unknown) {
					const text = JSON.stringify({ version: 1, key, record: data });
					if (new TextEncoder().encode(text).length > limit) throw failure();
					directories(parent);
					if (!stat(directory)) fs.mkdirSync(directory, { mode: 0o700 });
					directories(directory);
					// Exclusive transaction lock + optimistic version check. A second
					// process cannot overwrite the first process's more recent totals.
					const lockFd = fs.openSync(lock, "wx", 0o600);
					let tempFd: number | null = null, createdTemporary = false;
					try {
						if (read(file) !== expected) throw failure();
						tempFd = fs.openSync(temporary, "wx", 0o600); createdTemporary = true;
						fs.writeFileSync(tempFd, text, "utf8"); fs.fsyncSync(tempFd); fs.closeSync(tempFd); tempFd = null;
						directories(directory); fs.renameSync(temporary, file); createdTemporary = false;
						expected = text;
					} finally {
						if (tempFd !== null) fs.closeSync(tempFd);
						// Only remove files created by this transaction, never a stale lock.
						if (createdTemporary) fs.unlinkSync(temporary);
						fs.closeSync(lockFd); fs.unlinkSync(lock);
					}
				},
			};
		},
	};
}
