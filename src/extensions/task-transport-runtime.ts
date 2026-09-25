/** Process-wide adapter for the pinned Pi provider registry. Dependencies are
 * injected so the exact factory can be embedded and tested without home config.
 * Only explicitly bound calls are metered. Unrelated fetches pass unchanged.
 */
export function createTaskTransportRuntime(deps: {
	storage: { run: (store: any, callback: () => any) => any; getStore: () => any };
	getProvider: (api: string) => any;
	getFetch: () => typeof fetch; setFetch: (value: typeof fetch) => void;
}) {
	type Binding = { meter: any; model: { api: string; provider: string; id: string }; assertCurrent: () => void;
		signal?: AbortSignal; audit: (body: string, model: any) => { allowed: boolean; reason?: string | null }; blocked?: (reason: string) => void;
		diagnostics?: { request: (body: string, model: any, endpoint: string, kind: any) => any; response: (ticket: any, result: any) => void } };
	const summaries = new WeakMap<AbortSignal, { binding: Binding; kind: "summary" | "branchSummary" }>();
	const wrapped = new WeakSet<object>();
	const supported = new Set(["openai-completions", "google-generative-ai"]);
	let originalFetch: typeof fetch | undefined;
	const matches = (a: any, b: any) => a.api === b.api && a.provider === b.provider && a.id === b.id;
	const error = (code: string) => Object.assign(new Error(code), { code });
	const settle = (call: any, attempt: number, status: string, bytes: number, redirected = false) => {
		if (status === "complete") call.bodiesComplete++;
		if (redirected) call.redirected = true;
		// A changed owner must never receive a late journal append. Its durable
		// open reservation stays unknown and is reconciled as such on cold load.
		try { call.binding.assertCurrent(); call.binding.meter.settleAttempt(call.id, attempt, status, bytes, redirected); } catch { /* Meter is poisoned or owner ended; no guessed settlement. */ }
	};
	const endpointMatches = (input: RequestInfo | URL, init: RequestInit | undefined, model: any) => {
		try {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const base = new URL(model.baseUrl);
			if (url.origin !== base.origin || (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() !== "POST") return false;
			return model.api === "openai-completions" ? /\/chat\/completions\/?$/.test(url.pathname)
				: model.api === "google-generative-ai" && /\/models\/[^/]+:streamGenerateContent$/.test(url.pathname);
		} catch { return false; }
	};
	const gatedFetch: typeof fetch = async (input, init) => {
		const call = deps.storage.getStore();
		// A payload hook may fail before it can open/bind the journal. Some SDK
		// paths swallow that hook error and dispatch despite a late abort; retain
		// an explicit refusal in this invocation's sending context as well.
		if (call?.refused && supported.has(call.model.api) && endpointMatches(input, init, call.model)) throw error(call.refused);
		if (!call?.binding || !supported.has(call.model.api) || !endpointMatches(input, init, call.model)) return originalFetch!(input, init);
		const binding: Binding = call.binding;
		let reason: string | null = null, size = 0;
		try {
			binding.assertCurrent(); binding.meter.assertCurrent();
			if (call.signal?.aborted || binding.signal?.aborted || init?.signal?.aborted) reason = "TRANSPORT_ABORTED";
			else if (typeof init?.body !== "string") reason = "TRANSPORT_BODY_UNSUPPORTED";
			else {
				size = new TextEncoder().encode(init.body).length;
				if (size > 16 * 1024 * 1024) reason = "TRANSPORT_REQUEST_BYTES_LIMIT";
				else if (!binding.audit(init.body, call.model).allowed) reason = "TRANSPORT_INPUT_BUDGET";
			}
		} catch { reason = "TRANSPORT_SCOPE_OR_JOURNAL_INVALID"; }
		// No journal write failure may be swallowed before dispatch.
		const attempt = binding.meter.attempt(call.id, size, reason === null);
		if (reason) { binding.blocked?.(reason); throw error(reason); }
		call.dispatchAttempts++;
		if (call.dispatchAttempts === 1) try {
			call.ticket = binding.diagnostics?.request(init!.body as string, call.model, input instanceof Request ? input.url : String(input), call.kind);
		} catch { /* Optional diagnostics must not change dispatch or budget policy. */ }
		const signals = [call.signal, binding.signal, init?.signal].filter(Boolean) as AbortSignal[];
		const signal = signals.length ? AbortSignal.any(signals) : undefined;
		let response: Response;
		try { response = await originalFetch!(input, { ...init, ...(signal ? { signal } : {}) }); }
		catch (failure) { settle(call, attempt, "unknown", 0); throw failure; }
		if (!response.ok) { settle(call, attempt, "httpError", 0, response.redirected); return response; }
		if (!response.body) { settle(call, attempt, "complete", 0, response.redirected); return response; }
		// Forward with backpressure: no tee, SSE buffering, raw usage parser or
		// replacement assistant stream. The SDK remains the response consumer.
		const reader = response.body.getReader(); let bytes = 0, done = false;
		const finish = (status: "complete" | "unknown") => { if (done) return; done = true; settle(call, attempt, status, bytes, response.redirected); };
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const chunk = await reader.read();
					if (chunk.done) { finish("complete"); controller.close(); reader.releaseLock(); }
					else { bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + chunk.value.byteLength); controller.enqueue(chunk.value); }
				} catch (failure) { finish("unknown"); controller.error(failure); reader.releaseLock(); }
			},
			async cancel(reason) { finish("unknown"); try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
		});
		const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
		for (const key of ["url", "redirected", "type"] as const) Object.defineProperty(result, key, { value: response[key] });
		return result;
	};
	function bind(call: any, binding: Binding, kind: "ordinary" | "summary" | "branchSummary") {
		if (!call || !matches(binding.model, call.model)) return false;
		binding.assertCurrent();
		if (call.binding) {
			if (call.binding.meter !== binding.meter) throw error("TRANSPORT_SCOPE_COLLISION");
			return true;
		}
		call.binding = binding;
		call.kind = kind;
		call.id = binding.meter.begin(kind, supported.has(call.model.api) && deps.getFetch() === gatedFetch);
		return true;
	}
	function wrap(delegate: (...args: any[]) => any, provider: any) {
		return (model: any, context: any, options: any) => {
			const call: any = { model: { ...model }, signal: options?.signal, binding: null, id: null, dispatchAttempts: 0, bodiesComplete: 0, redirected: false };
			const finish = (status: string, usage: any) => {
				if (!call.binding || !call.id) return;
				let scopeCurrent = false;
				try { call.binding.assertCurrent(); scopeCurrent = true; call.binding.meter.finish(call.id, status, usage); } catch { /* Preserve unknown ledger reservation. */ }
				try { call.binding.diagnostics?.response(call.ticket, { status, usage, scopeCurrent, dispatchAttempts: call.dispatchAttempts, bodiesComplete: call.bodiesComplete, redirected: call.redirected }); }
				catch { /* No optional diagnostics may change the model stream. */ }
			};
			const summary = options?.signal && summaries.get(options.signal);
			if (summary) bind(call, summary.binding, summary.kind);
			let stream: any;
			try { stream = deps.storage.run(call, () => delegate.call(provider, model, context, options)); }
			catch (failure) {
				finish("unknown", null);
				throw failure;
			}
			// Observe the terminal promise without consuming/replacing its iterator.
			// This callback is attached before the caller can observe that promise.
			void stream.result().then((message: any) => {
				finish(message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "complete", message.usage);
			}, () => finish("unknown", null));
			return stream;
		};
	}
	return {
		ensure(api: string) {
			if (!originalFetch) { originalFetch = deps.getFetch(); deps.setFetch(gatedFetch); }
			const provider = deps.getProvider(api);
			if (!provider || wrapped.has(provider)) return Boolean(provider);
			// Preserve registry identity/sourceId so SDK unregister/reload still works.
			provider.stream = wrap(provider.stream, provider); provider.streamSimple = wrap(provider.streamSimple, provider); wrapped.add(provider);
			return true;
		},
		bindOrdinary(binding: Binding) { return bind(deps.storage.getStore(), binding, "ordinary"); },
		denyOrdinary(model: Binding["model"], reason = "TRANSPORT_JOURNAL_FAILURE") { const call = deps.storage.getStore(); if (call && matches(model, call.model)) call.refused = reason; },
		bindSummary(binding: Binding, signal: AbortSignal, kind: "summary" | "branchSummary" = "summary") { summaries.set(signal, { binding, kind }); },
	};
}
