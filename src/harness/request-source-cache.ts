/** One context-hook invocation only. Retains digests/line counts, never file text
 * or eligibility decisions. The host must recheck path/stat and run ownership on
 * every lookup, and dispose in finally. No runtime imports (embedded factory).
 */
export function createRequestSourceCache(options: {
	maxEntries?: number; maxSourceBytes?: number;
	onEvent?: (kind: "hit" | "miss" | "invalidated" | "capacityBypass", sourceBytes: number) => void;
} = {}) {
	type Version = { sha256: string; totalLines: number; sourceBytes: number };
	const limit = (value: number | undefined, fallback: number, ceiling: number) => value === undefined ? fallback
		: Number.isSafeInteger(value) && value >= 0 ? Math.min(value, ceiling) : 0;
	const maxEntries = limit(options.maxEntries, 128, 128);
	// This bounds the volume of sources represented, not resident text memory.
	const maxSourceBytes = limit(options.maxSourceBytes, 4 * 1024 * 1024, 16 * 1024 * 1024);
	const entries = new Map<string, { stamp: string; value: Version }>();
	let sourceBytes = 0, closed = false;
	const assertOpen = () => { if (closed) throw new Error("Request source cache disposed"); };
	const keyIsValid = (value: string) => /^[a-f0-9]{64}$/.test(value);
	const forget = (key: string) => { const entry = entries.get(key); if (entry) { sourceBytes -= entry.value.sourceBytes; entries.delete(key); } };
	return {
		get(key: string, stamp: string): Version | undefined {
			assertOpen();
			if (!keyIsValid(key) || !keyIsValid(stamp)) throw new Error("Invalid source cache identity");
			const entry = entries.get(key);
			if (entry?.stamp === stamp) { options.onEvent?.("hit", entry.value.sourceBytes); return { ...entry.value }; }
			if (entry) { forget(key); options.onEvent?.("invalidated", 0); }
			options.onEvent?.("miss", 0);
			return undefined;
		},
		put(key: string, stamp: string, value: Version): boolean {
			assertOpen();
			if (!keyIsValid(key) || !keyIsValid(stamp) || !keyIsValid(value.sha256)
				|| !Number.isSafeInteger(value.totalLines) || value.totalLines < 1
				|| !Number.isSafeInteger(value.sourceBytes) || value.sourceBytes < 0) throw new Error("Invalid source cache version");
			forget(key);
			if (entries.size >= maxEntries || sourceBytes + value.sourceBytes > maxSourceBytes) {
				options.onEvent?.("capacityBypass", 0); return false;
			}
			// Pick fields explicitly: callers cannot retain authority/raw payloads.
			entries.set(key, { stamp, value: { sha256: value.sha256, totalLines: value.totalLines, sourceBytes: value.sourceBytes } });
			sourceBytes += value.sourceBytes;
			return true;
		},
		dispose() { closed = true; entries.clear(); sourceBytes = 0; },
	};
}
