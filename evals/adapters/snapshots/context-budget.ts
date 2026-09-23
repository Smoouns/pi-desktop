export type ContextBudgetMessageKind = "history" | "checkpoint" | "observation_preview" | "new_evidence";

export interface ContextBudgetOptions {
	selectionBudget?: number;
	defaultReadBudget?: number;
	defaultOutputBudget?: number;
	defaultContextWindow?: number;
	defaultOutputReserve?: number;
	defaultSafetyMargin?: number;
	maxRuns?: number;
}

export interface ContextBudgetRequest {
	systemPrompt: unknown;
	tools: readonly unknown[];
	messages: readonly unknown[];
	messageKinds?: readonly ContextBudgetMessageKind[];
	contextWindow?: number;
	outputReserve?: number;
	safetyMargin?: number;
}

/**
 * A dependency-free factory because the Pi extension adapter may embed its
 * source. Units are deliberately conservative UTF-8 bytes, not provider token
 * counts. The provider adapter must still call checkPayload on its final body.
 */
export function createContextBudget(options: ContextBudgetOptions = {}) {
	type MessageKind = "history" | "checkpoint" | "observation_preview" | "new_evidence";
	type RunLimits = { readLimit?: number; outputLimit?: number };
	type RunState = { readLimit: number; outputLimit: number; readUsed: number; outputUsed: number };

	const encoder = new TextEncoder();
	const minimumContextWindow = 32;
	const finiteNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
	const integer = (value: number): number => value;
	const optionEntries: Array<[string, unknown, number, boolean]> = [
		["selectionBudget", options.selectionBudget, 16_000, false],
		["defaultReadBudget", options.defaultReadBudget, 2 * 1024 * 1024, false],
		["defaultOutputBudget", options.defaultOutputBudget, 2 * 1024 * 1024, false],
		["defaultContextWindow", options.defaultContextWindow, 128 * 1024, true],
		["defaultOutputReserve", options.defaultOutputReserve, 4 * 1024, false],
		["defaultSafetyMargin", options.defaultSafetyMargin, 2 * 1024, false],
		["maxRuns", options.maxRuns, 256, true],
	];
	const invalidOptions = optionEntries
		.filter(([, value, , positive]) => value !== undefined && !(positive ? finitePositive(value) : finiteNonNegative(value)))
		.map(([name]) => name);
	const configured = (name: string): number => {
		const entry = optionEntries.find(([entryName]) => entryName === name)!;
		return integer((entry[1] as number | undefined) ?? entry[2]);
	};
	const selectionBudget = configured("selectionBudget");
	const defaultReadBudget = configured("defaultReadBudget");
	const defaultOutputBudget = configured("defaultOutputBudget");
	const defaultContextWindow = configured("defaultContextWindow");
	const defaultOutputReserve = configured("defaultOutputReserve");
	const defaultSafetyMargin = configured("defaultSafetyMargin");
	const maxRuns = configured("maxRuns");
	const runs = new Map<string, RunState>();
	const estimator = {
		kind: "utf8_bytes_upper_bound" as const,
		units: "utf8_bytes" as const,
		exactProviderTokens: false,
		description: "Conservative UTF-8 byte proxy over complete JSON serialization; not a provider tokenizer.",
	};

	function encodedJson(value: unknown): { ok: true; bytes: number } | { ok: false } {
		try {
			const serialized = JSON.stringify(value);
			if (serialized === undefined) return { ok: false };
			return { ok: true, bytes: encoder.encode(serialized).byteLength };
		} catch {
			return { ok: false };
		}
	}

	function safeSum(...values: number[]): number | null {
		let total = 0;
		for (const value of values) {
			if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) return null;
			total += value;
		}
		return total;
	}

	function unsupportedMedia(value: unknown): string[] {
		const found: string[] = [];
		const visited = new Set<object>();
		const visit = (current: unknown, path: string): void => {
			if (current === null || typeof current !== "object") return;
			if (visited.has(current)) return;
			visited.add(current);
			if (current instanceof ArrayBuffer || ArrayBuffer.isView(current) || (typeof Blob !== "undefined" && current instanceof Blob)) {
				found.push(path);
				return;
			}
			const candidate = current as Record<string, unknown>;
			const type = typeof candidate.type === "string" ? candidate.type.toLowerCase() : "";
			const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType.toLowerCase()
				: typeof candidate.mime_type === "string" ? candidate.mime_type.toLowerCase() : "";
			const inlineData = (candidate.inlineData ?? candidate.inline_data) as Record<string, unknown> | null | undefined;
			const hasInlineMedia = inlineData !== null && typeof inlineData === "object"
				&& ("data" in inlineData || "mimeType" in inlineData || "mime_type" in inlineData);
			if (
				["image", "image_url", "input_image"].includes(type)
				|| "image_url" in candidate
				|| hasInlineMedia
				|| mimeType.startsWith("image/")
			) {
				found.push(path);
				return;
			}
			if (Array.isArray(current)) current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
			else for (const [key, entry] of Object.entries(candidate)) visit(entry, `${path}.${key}`);
		};
		visit(value, "$payload");
		return found;
	}

	function invalidPlan(messages: readonly unknown[], reason = "invalid_budget") {
		return {
			allowed: false as const,
			reason,
			messages,
			unsupportedMedia: [] as string[],
			ledger: {
				system: 0, tools: 0, history: 0, checkpoint: 0, observationPreview: 0, newEvidence: 0,
				serializationOverhead: 0, outputReserve: 0, safetyMargin: 0, total: 0, limit: 0, available: 0, estimator,
			},
		};
	}

	function planRequest(request: ContextBudgetRequest) {
		const contextWindow = request.contextWindow ?? defaultContextWindow;
		const outputReserve = request.outputReserve ?? defaultOutputReserve;
		const safetyMargin = request.safetyMargin ?? defaultSafetyMargin;
		if (invalidOptions.length > 0 || !finitePositive(contextWindow) || contextWindow < minimumContextWindow || !finiteNonNegative(outputReserve) || !finiteNonNegative(safetyMargin)) {
			return invalidPlan(request.messages);
		}
		if (!Array.isArray(request.tools) || !Array.isArray(request.messages) || (request.messageKinds !== undefined && request.messageKinds.length !== request.messages.length)) {
			return invalidPlan(request.messages, "invalid_payload");
		}
		const media = unsupportedMedia({ systemPrompt: request.systemPrompt, tools: request.tools, messages: request.messages });
		if (media.length > 0) {
			const blocked = invalidPlan(request.messages, "unsupported_media");
			return { ...blocked, unsupportedMedia: media };
		}
		const payload = encodedJson({ systemPrompt: request.systemPrompt, tools: request.tools, messages: request.messages });
		const system = encodedJson(request.systemPrompt);
		const tools = encodedJson(request.tools);
		if (!payload.ok || !system.ok || !tools.ok) return invalidPlan(request.messages, "invalid_payload");
		const categories: Record<MessageKind, number> = { history: 0, checkpoint: 0, observation_preview: 0, new_evidence: 0 };
		let messageBytes = 0;
		for (let index = 0; index < request.messages.length; index += 1) {
			const measured = encodedJson(request.messages[index]);
			if (!measured.ok) return invalidPlan(request.messages, "invalid_payload");
			const kind = request.messageKinds?.[index] ?? "history";
			if (!["history", "checkpoint", "observation_preview", "new_evidence"].includes(kind)) return invalidPlan(request.messages, "invalid_payload");
			categories[kind] += measured.bytes;
			messageBytes += measured.bytes;
		}
		const serializationOverhead = Math.max(0, payload.bytes - system.bytes - tools.bytes - messageBytes);
		const total = safeSum(payload.bytes, integer(outputReserve), integer(safetyMargin));
		if (total === null) return invalidPlan(request.messages);
		const limit = integer(contextWindow);
		const ledger = {
			system: system.bytes,
			tools: tools.bytes,
			history: categories.history,
			checkpoint: categories.checkpoint,
			observationPreview: categories.observation_preview,
			newEvidence: categories.new_evidence,
			serializationOverhead,
			outputReserve: integer(outputReserve),
			safetyMargin: integer(safetyMargin),
			total,
			limit,
			available: Math.max(0, limit - total),
			estimator,
		};
		return total <= limit
			? { allowed: true as const, reason: null, messages: request.messages, unsupportedMedia: media, ledger }
			: { allowed: false as const, reason: "model_input_budget_exceeded", messages: request.messages, unsupportedMedia: media, ledger };
	}

	function checkPayload(payload: unknown, limit: number, outputReserve = defaultOutputReserve, safetyMargin = defaultSafetyMargin) {
		const empty = { payload: 0, outputReserve: 0, safetyMargin: 0, total: 0, limit: 0, available: 0, estimator };
		if (invalidOptions.length > 0 || !finitePositive(limit) || limit < minimumContextWindow || !finiteNonNegative(outputReserve) || !finiteNonNegative(safetyMargin)) {
			return { allowed: false as const, reason: "invalid_budget", unsupportedMedia: [] as string[], ledger: empty };
		}
		const media = unsupportedMedia(payload);
		if (media.length > 0) return { allowed: false as const, reason: "unsupported_media", unsupportedMedia: media, ledger: empty };
		const measured = encodedJson(payload);
		if (!measured.ok) return { allowed: false as const, reason: "invalid_payload", unsupportedMedia: media, ledger: empty };
		const total = safeSum(measured.bytes, integer(outputReserve), integer(safetyMargin));
		if (total === null) return { allowed: false as const, reason: "invalid_budget", unsupportedMedia: media, ledger: empty };
		const ledger = { payload: measured.bytes, outputReserve: integer(outputReserve), safetyMargin: integer(safetyMargin), total, limit: integer(limit), available: Math.max(0, integer(limit) - total), estimator };
		return total <= limit
			? { allowed: true as const, reason: null, unsupportedMedia: media, ledger }
			: { allowed: false as const, reason: "model_input_budget_exceeded", unsupportedMedia: media, ledger };
	}

	function stableScopeKey(scope: unknown): string | null {
		const seen = new Set<object>();
		const normalize = (value: unknown): unknown => {
			if (typeof value === "number" && !Number.isFinite(value)) throw new Error("invalid number");
			if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
			if (Array.isArray(value)) return value.map(normalize);
			if (typeof value !== "object") throw new Error("invalid scope");
			if (seen.has(value)) throw new Error("cyclic scope");
			seen.add(value);
			const normalized: Record<string, unknown> = {};
			for (const key of Object.keys(value as Record<string, unknown>).sort()) normalized[key] = normalize((value as Record<string, unknown>)[key]);
			return normalized;
		};
		try {
			if (typeof scope === "string") return scope.length > 0 ? `string:${scope}` : null;
			if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return null;
			return `object:${JSON.stringify(normalize(scope))}`;
		} catch { return null; }
	}

	function runResult(allowed: boolean, reason: string | null, state?: RunState) {
		return {
			allowed,
			reason,
			readLimit: state?.readLimit ?? 0,
			outputLimit: state?.outputLimit ?? 0,
			readUsed: state?.readUsed ?? 0,
			outputUsed: state?.outputUsed ?? 0,
			availableRead: state ? Math.max(0, state.readLimit - state.readUsed) : 0,
			availableOutput: state ? Math.max(0, state.outputLimit - state.outputUsed) : 0,
		};
	}

	function beginRun(scope: unknown, limits: RunLimits = {}) {
		const key = stableScopeKey(scope);
		const readLimit = limits.readLimit ?? defaultReadBudget;
		const outputLimit = limits.outputLimit ?? defaultOutputBudget;
		if (!key || invalidOptions.length > 0 || !finiteNonNegative(readLimit) || !finiteNonNegative(outputLimit)) return runResult(false, "invalid_budget");
		const existing = runs.get(key);
		if (existing) return runResult(true, null, existing);
		if (runs.size >= maxRuns) return runResult(false, "run_capacity_exceeded");
		const state = { readLimit: integer(readLimit), outputLimit: integer(outputLimit), readUsed: 0, outputUsed: 0 };
		runs.set(key, state);
		return runResult(true, null, state);
	}

	function charge(scope: unknown, amount: number, kind: "read" | "output") {
		const key = stableScopeKey(scope);
		if (!key || !finiteNonNegative(amount)) return runResult(false, "invalid_budget", key ? runs.get(key) : undefined);
		const state = runs.get(key);
		if (!state) return runResult(false, "run_not_started");
		const units = integer(amount);
		const used = kind === "read" ? state.readUsed : state.outputUsed;
		const limit = kind === "read" ? state.readLimit : state.outputLimit;
		if (units > limit - used) return runResult(false, `${kind}_budget_exceeded`, state);
		if (kind === "read") state.readUsed += units;
		else state.outputUsed += units;
		return runResult(true, null, state);
	}

	function getRunBudget(scope: unknown) {
		const key = stableScopeKey(scope);
		const state = key ? runs.get(key) : undefined;
		return state ? runResult(true, null, state) : runResult(false, "run_not_started");
	}

	function endRun(scope: unknown) {
		const key = stableScopeKey(scope);
		if (!key) return { ended: false, reason: "invalid_scope" };
		return runs.delete(key)
			? { ended: true, reason: null }
			: { ended: false, reason: "run_not_started" };
	}

	function checkSelection(estimatedUnits: number) {
		if (invalidOptions.length > 0 || !finiteNonNegative(estimatedUnits)) return { valid: false, exceeded: true, estimatedUnits: 0, softLimit: selectionBudget };
		const units = integer(estimatedUnits);
		return { valid: true, exceeded: units > selectionBudget, estimatedUnits: units, softLimit: selectionBudget };
	}

	return {
		planRequest,
		checkPayload,
		beginRun,
		chargeRead: (scope: unknown, bytes: number) => charge(scope, bytes, "read"),
		chargeOutput: (scope: unknown, bytes: number) => charge(scope, bytes, "output"),
		getRunBudget,
		endRun,
		checkSelection,
		estimator,
	};
}
