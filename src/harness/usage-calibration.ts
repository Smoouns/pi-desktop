/** Matched request/response diagnostics, never a budget or authority grant.
 * Embeddable, process-local and bounded; stores hashes and scalars, not text.
 * Input usage follows pinned Pi 0.63.1 OpenAI/Google normalization, not billing.
 */
export function createUsageCalibration(deps: {
	digest: (text: string) => string;
	estimate: (payload: unknown) => number;
}) {
	type Kind = "ordinary" | "summary" | "branchSummary";
	type Ticket = { epoch: number; sequence: number; owner: string; kind: Kind; key: string; history: string[];
		estimate: number; bytes: number; anchored: number | null; invalidation: string; model: string; api: string; provider: string };
	type Anchor = Ticket & { inputTokens: number };
	type Slot = { sequence: number; anchor: Anchor | null };
	let epoch = 0, sequence = 0, lastInvalidation = "cold_start";
	const owners = new Map<string, Map<Kind, Slot>>();
	const pending = new Set<Ticket>();
	const samples: Array<Record<string, any>> = [];
	const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
	const hash = (value: unknown) => deps.digest(JSON.stringify(value));
	const label = (value: unknown) => typeof value === "string" ? value.slice(0, 160) : "unknown";
	const scope = (owner: unknown) => hash(owner);
	function start(request: { owner: unknown; model: any; endpoint: string; kind: Kind; body: string; projection: unknown }): Ticket | null {
		if (pending.size >= 16) { invalidate("diagnostic_capacity"); return null; }
		const { model, kind } = request;
		if (!["openai-completions", "google-generative-ai"].includes(model.api)) { invalidate("unsupported_api"); return null; }
		const payload = JSON.parse(request.body);
		const field = model.api === "openai-completions" ? "messages" : "contents";
		const history = payload?.[field];
		if (!Array.isArray(history) || history.length > 2048) { invalidate("unsupported_history"); return null; }
		const estimate = deps.estimate(payload), bytes = new TextEncoder().encode(request.body).byteLength;
		if (!integer(estimate) || estimate === 0 || bytes > 16 * 1024 * 1024) { invalidate("unsupported_estimate"); return null; }
		const fixed = { ...payload }; delete fixed[field];
		// OpenAI embeds system/developer messages in the message array. Hash them
		// separately as well, so changing the system prompt is never an append.
		const system = model.api === "openai-completions" ? history.filter((m: any) => m?.role === "system" || m?.role === "developer") : null;
		const endpoint = new URL(request.endpoint);
		const key = hash(["pi-0.63.1/multilingual-json-v1", kind, model.api, model.provider, model.id,
			model.baseUrl, endpoint.origin + endpoint.pathname, model.contextWindow, model.maxTokens, request.projection, fixed, system]);
		const owner = scope(request.owner);
		if (!owners.has(owner)) {
			if (owners.size >= 32) owners.delete(owners.keys().next().value!);
			owners.set(owner, new Map());
		}
		const slots = owners.get(owner)!;
		const previous = slots.get(kind)?.anchor;
		const hashes = history.map((message: unknown) => hash(message));
		let anchored: number | null = null, invalidation = lastInvalidation;
		if (previous) {
			if (previous.key !== key) invalidation = "model_or_static_context_changed";
			else if (previous.history.length > hashes.length || previous.history.some((value, index) => value !== hashes[index])) invalidation = "history_not_append_only";
			else if (estimate < previous.estimate || !integer(previous.inputTokens + estimate - previous.estimate)) invalidation = "invalid_delta";
			else { anchored = previous.inputTokens + estimate - previous.estimate; invalidation = "compatible_append"; }
		} else if (slots.has(kind)) invalidation = "no_eligible_anchor";
		const ticket: Ticket = { epoch, sequence: ++sequence, owner, kind, key, history: hashes, estimate, bytes, anchored, invalidation,
			model: label(model.id), api: label(model.api), provider: label(model.provider) };
		// Any new call supersedes an in-flight predecessor, including a failed
		// predecessor. A late response cannot silently reinstate its old anchor.
		slots.set(kind, { sequence: ticket.sequence, anchor: null });
		pending.add(ticket);
		return ticket;
	}
	function finish(ticket: Ticket | null, response: { status: string; usage: any; dispatchAttempts: number; bodiesComplete: number; redirected: boolean; scopeCurrent: boolean }) {
		if (!ticket || !pending.delete(ticket)) return;
		const slot = owners.get(ticket.owner)?.get(ticket.kind);
		if (ticket.epoch !== epoch || !slot || slot.sequence !== ticket.sequence || !response.scopeCurrent) return;
		// Both supported SDK adapters subtract cacheRead from raw prompt tokens.
		// Re-add normalized caches for context occupancy, never for a cost quote.
		const usage = response.usage;
		const fields = [usage?.input, usage?.cacheRead, usage?.cacheWrite];
		const sum = fields.every(integer) ? fields.reduce((n: number, v: number) => n + v, 0) : null;
		const input = integer(sum) && sum > 0 ? sum : null;
		const reason = response.status !== "complete" ? "response_not_complete"
			: response.dispatchAttempts !== 1 ? "ambiguous_send_count"
			: response.bodiesComplete !== 1 || response.redirected ? "response_body_or_route_unverified"
			: input === null ? "usage_missing_or_invalid" : null;
		if (!reason) slot.anchor = { ...ticket, inputTokens: input! };
		samples.push({ owner: ticket.owner, generation: epoch, sequence: ticket.sequence, kind: ticket.kind,
			model: ticket.model, api: ticket.api, provider: ticket.provider, contextFingerprint: ticket.key,
			estimatedInputTokens: ticket.estimate, rawRequestBytes: ticket.bytes, sdkInputTokens: input,
			anchoredInputEstimate: ticket.anchored, anchorCompatibility: ticket.invalidation,
			baselineErrorTokens: !reason ? ticket.estimate - input! : null,
			anchoredErrorTokens: !reason && ticket.anchored !== null ? ticket.anchored - input! : null,
			eligible: reason === null, reason, dispatchAttempts: response.dispatchAttempts,
			usageSource: "sdk_normalized_pi_0.63.1", cacheBreakdownVerified: false });
		if (samples.length > 32) samples.shift();
	}
	function invalidate(reason: string) {
		epoch++; lastInvalidation = label(reason); owners.clear(); pending.clear();
	}
	return {
		start, finish, invalidate,
		reset() { invalidate("scope_or_model_reset"); samples.length = 0; },
		snapshot(owner: unknown) {
			const key = scope(owner), slots = owners.get(key);
			return { version: 1, processLocal: true, diagnosticOnly: true, appliedToBudget: false,
				providerTokenizerVerified: false, costUsd: null, generation: epoch, lastInvalidation,
				anchorUse: "requires_exact_context_match_on_next_request",
				anchorCount: slots ? [...slots.values()].filter(slot => slot.anchor !== null).length : 0,
				samples: samples.filter(sample => sample.owner === key).map(({ owner: _owner, ...sample }) => ({ ...sample })) };
		},
	};
}
