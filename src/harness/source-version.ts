export interface SourceVersionRef {
	path: string;
	sha256: string;
	startLine?: number;
	endLine?: number;
	authority?: string;
	temporal?: string;
	memoryId?: string;
}

export type SourceVersionStatus = "valid" | "changed" | "missing" | "ineligible" | "unavailable";

export interface SourceVersionCheck {
	ref: SourceVersionRef;
	status: SourceVersionStatus;
	reason: string;
}

export interface SourceVersionResolverResult {
	sha256: string | null;
	/** Only for comparing a legacy whole-file dependency with fresh delivered ranges. */
	totalLines?: number;
	authority?: string;
	temporal?: string;
	memoryId?: string;
	eligible?: boolean;
}

export interface SourceVersioning {
	normalize(value: SourceVersionRef): SourceVersionRef;
	key(ref: SourceVersionRef): string;
	revalidate(
		refs: SourceVersionRef[],
		resolver: (ref: SourceVersionRef) => Promise<SourceVersionResolverResult>,
		signal?: AbortSignal,
	): Promise<{ valid: boolean; checks: SourceVersionCheck[] }>;
}

/** Stateless, bounded source validation; safe to embed via this function's toString(). */
export function createSourceVersioning(): SourceVersioning {
	const maxRefs = 128;
	const maxPathChars = 4096;
	const maxMetadataChars = 256;
	const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
	const abortError = (): Error => {
		const error = new Error("Source revalidation was aborted");
		error.name = "AbortError";
		return error;
	};
	const throwIfAborted = (signal?: AbortSignal): void => {
		if (signal?.aborted) throw abortError();
	};
	const clean = (value: unknown, name: string, maxChars: number): string => {
		if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
		const result = value.trim();
		if (!result) throw new TypeError(`${name} must not be empty`);
		if (result.length > maxChars) throw new TypeError(`${name} exceeds its character limit`);
		if (/[\u0000-\u001f\u007f]/.test(result)) throw new TypeError(`${name} contains control characters`);
		return result;
	};
	const safePath = (value: unknown): string => {
		const path = clean(value, "path", maxPathChars);
		if (path !== value) throw new TypeError("path must not have surrounding whitespace");
		if (path.includes("\\") || path.startsWith("/") || path.startsWith("//") || /^[a-z]:/i.test(path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
			throw new TypeError("path must be a project-relative canonical path");
		}
		const parts = path.split("/");
		if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":") || /[<>"|?*]/.test(part) || /[. ]$/.test(part) || reserved.test(part))) {
			throw new TypeError("path is not a safe project-relative path");
		}
		return path;
	};
	const metadata = (value: unknown, name: string): string | undefined => value === undefined ? undefined : clean(value, name, maxMetadataChars);
	const normalize = (value: SourceVersionRef): SourceVersionRef => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("source version must be an object");
		const sha256 = clean(value.sha256, "sha256", 64).toLowerCase();
		if (!/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError("sha256 must be a SHA-256 hex digest");
		const hasStart = value.startLine !== undefined;
		const hasEnd = value.endLine !== undefined;
		if (hasStart !== hasEnd) throw new TypeError("startLine and endLine must be supplied together");
		if (hasStart && (!Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine) || value.startLine! < 1 || value.endLine! < value.startLine!)) {
			throw new TypeError("line range must contain positive ordered safe integers");
		}
		const authority = metadata(value.authority, "authority");
		const temporal = metadata(value.temporal, "temporal");
		const memoryId = metadata(value.memoryId, "memoryId");
		return {
			path: safePath(value.path), sha256,
			...(hasStart ? { startLine: value.startLine, endLine: value.endLine } : {}),
			...(authority === undefined ? {} : { authority }),
			...(temporal === undefined ? {} : { temporal }),
			...(memoryId === undefined ? {} : { memoryId }),
		};
	};
	const copy = (ref: SourceVersionRef): SourceVersionRef => ({ ...ref });
	const key = (ref: SourceVersionRef): string => {
		const item = normalize(ref);
		return JSON.stringify([item.path, item.sha256, item.startLine ?? null, item.endLine ?? null, item.authority ?? null, item.temporal ?? null, item.memoryId ?? null]);
	};
	return {
		normalize,
		key,
		async revalidate(refs, resolver, signal) {
			if (!Array.isArray(refs)) throw new TypeError("refs must be an array");
			if (refs.length > maxRefs) throw new TypeError(`refs exceeds maximum of ${maxRefs}`);
			if (typeof resolver !== "function") throw new TypeError("resolver must be a function");
			throwIfAborted(signal);
			const normalized = refs.map(normalize);
			const checks: SourceVersionCheck[] = [];
			for (const ref of normalized) {
				throwIfAborted(signal);
				let current: SourceVersionResolverResult;
				try {
					current = await resolver(copy(ref));
					throwIfAborted(signal);
				} catch (error) {
					if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
					checks.push({ ref: copy(ref), status: "unavailable", reason: "source resolver unavailable" });
					continue;
				}
				if (!current || typeof current !== "object") {
					checks.push({ ref: copy(ref), status: "unavailable", reason: "source resolver returned no result" });
					continue;
				}
				if (current.sha256 === null) {
					checks.push({ ref: copy(ref), status: "missing", reason: "source is missing" });
					continue;
				}
				if (current.eligible === false || ref.authority?.toLowerCase() === "unclassified" || current.authority?.trim().toLowerCase() === "unclassified") {
					checks.push({ ref: copy(ref), status: "ineligible", reason: "source is not eligible" });
					continue;
				}
				let currentSha: string;
				try {
					currentSha = clean(current.sha256, "resolver sha256", 64).toLowerCase();
					if (!/^[0-9a-f]{64}$/.test(currentSha)) throw new TypeError("invalid digest");
				} catch {
					checks.push({ ref: copy(ref), status: "unavailable", reason: "source resolver returned an invalid digest" });
					continue;
				}
				const changedFields: string[] = [];
				if (currentSha !== ref.sha256) changedFields.push("sha256");
				for (const field of ["authority", "temporal", "memoryId"] as const) {
					if (ref[field] !== undefined && current[field] !== ref[field]) changedFields.push(field);
				}
				checks.push(changedFields.length
					? { ref: copy(ref), status: "changed", reason: `source ${changedFields.join(", ")} changed` }
					: { ref: copy(ref), status: "valid", reason: "source version is current" });
			}
			return { valid: checks.every((check) => check.status === "valid"), checks };
		},
	};
}
