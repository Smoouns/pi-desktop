export type ToolErrorKind =
	| "transient"
	| "invalid_input"
	| "stale_source"
	| "permission"
	| "precondition"
	| "validation"
	| "cancelled"
	| "unknown_outcome"
	| "fatal";

export interface ToolFailure {
	kind: ToolErrorKind;
	code: string;
	message: string;
}

export type ToolResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: ToolFailure };

export type ToolPolicyAction = "retry" | "repair" | "refresh_sources" | "reconcile" | "block" | "stop";

export interface ToolExecutionRequest<T, P> {
	params: P;
	operation: (params: P, context: { signal: AbortSignal; attempt: number }) => Promise<ToolResult<T>>;
	sideEffect?: boolean;
	signal?: AbortSignal;
	deadlineMs?: number;
	refreshSources?: (params: P, error: ToolFailure) => Promise<P | undefined>;
	repair?: (params: P, error: ToolFailure) => Promise<P | undefined>;
	reconcile?: (params: P, error: ToolFailure) => Promise<ToolResult<T>>;
	maxTransientRetries?: number;
	maxRepairs?: number;
	maxRefreshes?: number;
}

export interface ToolExecution<T, P> {
	result: ToolResult<T>;
	actions: ToolPolicyAction[];
	attempts: number;
	params: P;
}

export interface ToolRuntimeOptions {
	now?: () => number;
	sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	backoffMs?: (retry: number) => number;
	maxTransientRetries?: number;
	maxRepairs?: number;
	maxRefreshes?: number;
}

/**
 * Deliberately self-contained: production may embed this factory's source in a
 * generated Pi extension. Keep every runtime dependency inside the function.
 */
export function createToolRuntime(options: ToolRuntimeOptions = {}) {
	const now = options.now ?? (() => Date.now());
	const defaultSleep = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("cancelled"));
			return;
		}
		const timer = setTimeout(done, milliseconds);
		function done() {
			signal.removeEventListener("abort", cancelled);
			resolve();
		}
		function cancelled() {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancelled);
			reject(new Error("cancelled"));
		}
		signal.addEventListener("abort", cancelled, { once: true });
	});
	const sleep = options.sleep ?? defaultSleep;
	const backoffMs = options.backoffMs ?? ((retry: number) => Math.min(1_000, 100 * (2 ** (retry - 1))));
	const budget = (value: number | undefined, fallback: number): number =>
		Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : fallback;
	const defaultTransientRetries = budget(options.maxTransientRetries, 2);
	const defaultRepairBudget = budget(options.maxRepairs, 1);
	const defaultRefreshBudget = budget(options.maxRefreshes, 1);
	const failure = (kind: ToolErrorKind, code: string, message: string): ToolResult<never> => ({
		ok: false,
		error: { kind, code, message },
	});

	async function execute<T, P>(request: ToolExecutionRequest<T, P>): Promise<ToolExecution<T, P>> {
		const actions: ToolPolicyAction[] = [];
		if (request.deadlineMs !== undefined && !Number.isFinite(request.deadlineMs)) {
			return {
				result: failure("invalid_input", "INVALID_DEADLINE", "Tool deadline must be a finite number of milliseconds."),
				actions: ["block"],
				attempts: 0,
				params: request.params,
			};
		}
		const startedAt = now();
		const deadlineAt = request.deadlineMs === undefined ? undefined : startedAt + Math.max(0, request.deadlineMs);
		const maxTransientRetries = budget(request.maxTransientRetries, defaultTransientRetries);
		const maxRepairs = budget(request.maxRepairs, defaultRepairBudget);
		const maxRefreshes = budget(request.maxRefreshes, defaultRefreshBudget);
		let params = request.params;
		let attempts = 0;
		let transientRetries = 0;
		let repairs = 0;
		let refreshes = 0;

		const cancelled = (): ToolResult<never> => failure("cancelled", "CANCELLED", "Tool execution was cancelled.");
		const timedOut = (dispatched: boolean): ToolResult<never> => dispatched && request.sideEffect
			? failure("unknown_outcome", "DEADLINE_AFTER_DISPATCH", "The deadline expired after a side effect was dispatched; reconcile before continuing.")
			: failure("transient", "DEADLINE_EXCEEDED", "The tool deadline expired.");
		const interrupted = (dispatched: boolean): ToolResult<never> => dispatched && request.sideEffect
			? failure("unknown_outcome", "CANCELLED_AFTER_DISPATCH", "Cancellation happened after a side effect was dispatched; reconcile before continuing.")
			: cancelled();
		const sameParams = (left: P, right: P): boolean => {
			try { return JSON.stringify(left) === JSON.stringify(right); }
			catch { return left === right; }
		};
		async function bounded<V>(start: () => Promise<V>, dispatched: boolean): Promise<{ done: true; value: V } | { done: false; result: ToolResult<never> }> {
			if (request.signal?.aborted) return { done: false, result: interrupted(dispatched) };
			if (deadlineAt !== undefined && now() >= deadlineAt) return { done: false, result: timedOut(dispatched) };
			const promise = start();
			const guardController = new AbortController();
			let fenced = false;
			let cancelHandler: (() => void) | undefined;
			const candidates: Array<Promise<{ done: true; value: V } | { done: false; result: ToolResult<never> }>> = [
				promise.then((value) => fenced ? { done: false as const, result: interrupted(dispatched) } : { done: true as const, value }),
			];
			if (request.signal) candidates.push(new Promise((resolve) => {
				cancelHandler = () => {
					fenced = true;
					guardController.abort();
					resolve({ done: false, result: interrupted(dispatched) });
				};
				request.signal!.addEventListener("abort", cancelHandler, { once: true });
			}));
			if (deadlineAt !== undefined) candidates.push(
				sleep(Math.max(0, deadlineAt - now()), guardController.signal)
					.then(() => {
						fenced = true;
						return { done: false as const, result: timedOut(dispatched) };
					})
					.catch(() => new Promise<never>(() => undefined)),
			);
			try { return await Promise.race(candidates); }
			finally {
				fenced = true;
				guardController.abort();
				if (cancelHandler) request.signal?.removeEventListener("abort", cancelHandler);
			}
		}

		while (true) {
			if (request.signal?.aborted) return { result: cancelled(), actions: [...actions, "stop"], attempts, params };
			if (deadlineAt !== undefined && now() >= deadlineAt) {
				const result = timedOut(false);
				return { result, actions: [...actions, "stop"], attempts, params };
			}

			attempts += 1;
			const attemptController = new AbortController();
			let result: ToolResult<T>;
			try {
				const guarded = await bounded(() => request.operation(params, { signal: attemptController.signal, attempt: attempts }), true);
				result = guarded.done ? guarded.value : guarded.result;
			} catch (error) {
				result = request.signal?.aborted
					? interrupted(true)
					: failure("fatal", "UNCLASSIFIED_THROW", error instanceof Error ? error.message : String(error));
			} finally {
				attemptController.abort();
			}

			if (result.ok) return { result, actions, attempts, params };
			if (result.error.kind === "cancelled" && request.sideEffect) result = interrupted(true);
			const error = (result as { ok: false; error: ToolFailure }).error;
			if (error.kind === "cancelled") return { result, actions: [...actions, "stop"], attempts, params };
			if (error.kind === "unknown_outcome") {
				actions.push("reconcile");
				if (request.reconcile) {
					try {
						const reconciled = await bounded(() => request.reconcile!(params, error), true);
						return { result: reconciled.done ? reconciled.value : reconciled.result, actions, attempts, params };
					} catch (cause) {
						return { result: failure("fatal", "RECONCILE_FAILED", cause instanceof Error ? cause.message : String(cause)), actions: [...actions, "stop"], attempts, params };
					}
				}
				return { result, actions, attempts, params };
			}
			if (error.kind === "transient") {
				if (error.code === "DEADLINE_EXCEEDED" || request.sideEffect || transientRetries >= maxTransientRetries) return { result, actions: [...actions, "stop"], attempts, params };
				transientRetries += 1;
				actions.push("retry");
				const backoffController = new AbortController();
				let waited: Awaited<ReturnType<typeof bounded<void>>>;
				try {
					const proposedDelay = backoffMs(transientRetries);
					const delay = Number.isFinite(proposedDelay) && proposedDelay >= 0 ? proposedDelay : 0;
					waited = await bounded(() => sleep(delay, backoffController.signal), false);
				} catch (cause) {
					backoffController.abort();
					return { result: failure("fatal", "BACKOFF_FAILED", cause instanceof Error ? cause.message : String(cause)), actions: [...actions, "stop"], attempts, params };
				}
				backoffController.abort();
				if (!waited.done) return { result: waited.result, actions: [...actions, "stop"], attempts, params };
				continue;
			}
			if (error.kind === "stale_source") {
				actions.push("refresh_sources");
				if (refreshes >= maxRefreshes || !request.refreshSources) return { result, actions: [...actions, "block"], attempts, params };
				let refreshed: Awaited<ReturnType<typeof bounded<P | undefined>>>;
				try { refreshed = await bounded(() => request.refreshSources!(params, error), false); }
				catch (cause) { return { result: failure("fatal", "REFRESH_FAILED", cause instanceof Error ? cause.message : String(cause)), actions: [...actions, "stop"], attempts, params }; }
				if (!refreshed.done) return { result: refreshed.result, actions: [...actions, "stop"], attempts, params };
				if (refreshed.value === undefined || sameParams(refreshed.value, params)) return { result, actions: [...actions, "block"], attempts, params };
				refreshes += 1;
				params = refreshed.value;
				continue;
			}
			if (error.kind === "invalid_input" || error.kind === "validation") {
				if (repairs >= maxRepairs || !request.repair) return { result, actions: [...actions, "block"], attempts, params };
				let repaired: Awaited<ReturnType<typeof bounded<P | undefined>>>;
				try { repaired = await bounded(() => request.repair!(params, error), false); }
				catch (cause) { return { result: failure("fatal", "REPAIR_FAILED", cause instanceof Error ? cause.message : String(cause)), actions: [...actions, "stop"], attempts, params }; }
				if (!repaired.done) return { result: repaired.result, actions: [...actions, "stop"], attempts, params };
				if (repaired.value === undefined || sameParams(repaired.value, params)) {
					return { result, actions: [...actions, "block"], attempts, params };
				}
				repairs += 1;
				actions.push("repair");
				params = repaired.value;
				continue;
			}
			if (error.kind === "permission" || error.kind === "precondition") return { result, actions: [...actions, "block"], attempts, params };
			return { result, actions: [...actions, "stop"], attempts, params };
		}
	}

	return { execute };
}
