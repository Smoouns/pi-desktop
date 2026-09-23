export type ProviderUsage = {
	promptTokens: number | null;
	completionTokens: number | null;
	totalTokens: number | null;
	cachedTokens: number | null;
	reasoningTokens: number | null;
};

export type UsageObservationErrorCode =
	| "SSE_RESPONSE_TOO_LARGE"
	| "SSE_INVALID_UTF8"
	| "SSE_INVALID_FIELD"
	| "SSE_INVALID_JSON"
	| "SSE_DATA_AFTER_DONE"
	| "SSE_DONE_MISSING"
	| "PROVIDER_USAGE_MISSING"
	| "PROVIDER_USAGE_SCHEMA"
	| "PROVIDER_USAGE_CONFLICT"
	| "USAGE_OBSERVER_FINISHED";

export class UsageObservationError extends Error {
	constructor(public readonly code: UsageObservationErrorCode) {
		super(code);
		this.name = "UsageObservationError";
	}
}

export type SseUsageObserver = {
	feed(chunk: Uint8Array): void;
	finish(): ProviderUsage;
};

const DEFAULT_MAX_BYTES = 256 * 1024;
const fail = (code: UsageObservationErrorCode): never => { throw new UsageObservationError(code); };
const object = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const exact = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
	Object.keys(value).every((key) => allowed.includes(key));
const countOrNull = (value: unknown): number | null => {
	if (value === undefined || value === null) return null;
	if (!Number.isSafeInteger(value) || (value as number) < 0) fail("PROVIDER_USAGE_SCHEMA");
	return value as number;
};

function parseUsage(value: unknown): ProviderUsage {
	const usage = object(value);
	if (!usage || !exact(usage, ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details"])) {
		return fail("PROVIDER_USAGE_SCHEMA");
	}
	const promptDetails = usage.prompt_tokens_details === undefined || usage.prompt_tokens_details === null
		? null : object(usage.prompt_tokens_details);
	if (usage.prompt_tokens_details !== undefined && usage.prompt_tokens_details !== null &&
		(!promptDetails || !exact(promptDetails, ["cached_tokens"]))) fail("PROVIDER_USAGE_SCHEMA");
	const completionDetails = usage.completion_tokens_details === undefined || usage.completion_tokens_details === null
		? null : object(usage.completion_tokens_details);
	if (usage.completion_tokens_details !== undefined && usage.completion_tokens_details !== null &&
		(!completionDetails || !exact(completionDetails, ["reasoning_tokens"]))) fail("PROVIDER_USAGE_SCHEMA");
	return {
		promptTokens: countOrNull(usage.prompt_tokens),
		completionTokens: countOrNull(usage.completion_tokens),
		totalTokens: countOrNull(usage.total_tokens),
		cachedTokens: countOrNull(promptDetails?.cached_tokens),
		reasoningTokens: countOrNull(completionDetails?.reasoning_tokens),
	};
}

const sameUsage = (left: ProviderUsage, right: ProviderUsage): boolean =>
	left.promptTokens === right.promptTokens && left.completionTokens === right.completionTokens &&
	left.totalTokens === right.totalTokens && left.cachedTokens === right.cachedTokens &&
	left.reasoningTokens === right.reasoningTokens;

export function createSseUsageObserver(options: { maxBytes?: number } = {}): SseUsageObserver {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("INVALID_MAX_BYTES");
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	let pending = "";
	let eventData: string[] = [];
	let done = false;
	let finished = false;
	let observed: ProviderUsage | null = null;

	const observeEvent = (): void => {
		if (eventData.length === 0) return;
		const data = eventData.join("\n");
		eventData = [];
		if (data === "[DONE]") { done = true; return; }
		if (done) fail("SSE_DATA_AFTER_DONE");
		let envelope: unknown;
		try { envelope = JSON.parse(data); } catch { return fail("SSE_INVALID_JSON"); }
		const record = object(envelope);
		if (record === null) return fail("SSE_INVALID_JSON");
		if (!("usage" in record) || record.usage === null || record.usage === undefined) return;
		const next = parseUsage(record.usage);
		if (observed && !sameUsage(observed, next)) fail("PROVIDER_USAGE_CONFLICT");
		observed = next;
	};

	const acceptLine = (rawLine: string): void => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "") { observeEvent(); return; }
		if (line.startsWith(":")) return;
		if (!line.startsWith("data:")) fail("SSE_INVALID_FIELD");
		let data = line.slice(5);
		if (data.startsWith(" ")) data = data.slice(1);
		eventData.push(data);
	};

	const consume = (text: string): void => {
		pending += text;
		for (;;) {
			const newline = pending.indexOf("\n");
			if (newline < 0) break;
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			acceptLine(line);
		}
		if (new TextEncoder().encode(pending).byteLength > maxBytes) fail("SSE_RESPONSE_TOO_LARGE");
	};

	return {
		feed(chunk: Uint8Array): void {
			if (finished) fail("USAGE_OBSERVER_FINISHED");
			bytes += chunk.byteLength;
			if (bytes > maxBytes) fail("SSE_RESPONSE_TOO_LARGE");
			try { consume(decoder.decode(chunk, { stream: true })); } catch (error) {
				if (error instanceof UsageObservationError) throw error;
				return fail("SSE_INVALID_UTF8");
			}
		},
		finish(): ProviderUsage {
			if (finished) fail("USAGE_OBSERVER_FINISHED");
			finished = true;
			try { consume(decoder.decode()); } catch (error) {
				if (error instanceof UsageObservationError) throw error;
				return fail("SSE_INVALID_UTF8");
			}
			if (pending.length > 0) { acceptLine(pending); pending = ""; }
			observeEvent();
			if (!done) fail("SSE_DONE_MISSING");
			if (observed === null) return fail("PROVIDER_USAGE_MISSING");
			const result: ProviderUsage = observed;
			return { ...result };
		},
	};
}
