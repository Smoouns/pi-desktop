import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { freezeRequestPolicy, type RequestPolicy } from "./request-policy.js";
import { createSseUsageObserver, UsageObservationError, type ProviderUsage } from "../pilot/usage.js";


export type RequestStopCode =
	| "MANUAL_STOP" | "INVOCATION_REQUIRED" | "INVOCATION_CONCURRENT" | "INVOCATION_REUSED"
	| "TASK_REQUEST_LIMIT" | "BATCH_REQUEST_LIMIT" | "INPUT_ESTIMATE_LIMIT"
	| "BATCH_INPUT_LIMIT" | "BATCH_OUTPUT_LIMIT" | "REQUEST_BYTES_LIMIT" | "OUTPUT_FIELD_INVALID"
	| "MODEL_MISMATCH" | "ENDPOINT_MISMATCH" | "METHOD_INVALID" | "REDIRECT_FORBIDDEN"
	| "REQUEST_TIMEOUT" | "TASK_TIMEOUT" | "BATCH_TIMEOUT" | "REQUEST_ABORTED"
	| "NETWORK_FAILURE" | "HTTP_FAILURE" | "RESPONSE_BYTES_LIMIT" | "RESPONSE_INCOMPLETE"
	| "USAGE_INVALID" | "PROVIDER_USAGE_LIMIT" | "JOURNAL_FAILURE" | "RESET_FORBIDDEN";

export interface RequestSnapshot<TaskId extends string = string> {
	ordinal: number;
	taskId: TaskId;
	invocationId: number;
	status: "dispatched" | "complete" | "unknown";
	reasonCode: RequestStopCode | null;
	inputEstimate: number;
	inputBytes: number;
	outputReserved: number;
	requestSha256: string;
	dispatchAttempted: boolean;
	usage: ProviderUsage | null;
}

export interface TransportSnapshot<TaskId extends string = string> {
	state: "active" | "stopped";
	stopCode: RequestStopCode | null;
	endpointSha256: string;
	modelSha256: string;
	requestsReserved: number;
	inputReserved: number;
	outputReserved: number;
	requestsByTask: Readonly<Record<string, number>>;
	completedResponses: number;
	unknownResponses: number;
	requests: readonly RequestSnapshot<TaskId>[];
}

export interface TransportOptions<TaskId extends string = string> {
	endpoint: string;
	modelId: string;
	outputField: "max_tokens" | "max_completion_tokens";
	/** Opt-in for native summaries with smaller output budgets. Legacy callers remain exact. */
	outputMode?: "exact" | "bounded";
	/** Required: the caller must explicitly supply the only permitted network implementation. */
	fetchImpl: typeof fetch;
	/** Conservative input estimate over the exact serialized request bytes. */
	estimateInput(body: Uint8Array): number;
	/** Must durably record the reservation before the real fetch may start. */
	beforeDispatch?: (request: Readonly<RequestSnapshot<TaskId>>) => Promise<void>;
	/** Must durably record completion before the response may reach the SDK. */
	onRequestFinished?: (request: Readonly<RequestSnapshot<TaskId>>) => Promise<void>;
	now?: () => number;
	setTimer?: typeof setTimeout;
	clearTimer?: typeof clearTimeout;
}

interface InvocationContext {
	id: number;
	taskId: string;
	fetchCount: number;
	responseFinished: boolean;
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const PILOT_STOP_CODES = new Set<RequestStopCode>([
	"MANUAL_STOP", "INVOCATION_REQUIRED", "INVOCATION_CONCURRENT", "INVOCATION_REUSED",
	"TASK_REQUEST_LIMIT", "BATCH_REQUEST_LIMIT", "INPUT_ESTIMATE_LIMIT", "BATCH_INPUT_LIMIT", "BATCH_OUTPUT_LIMIT",
	"REQUEST_BYTES_LIMIT", "OUTPUT_FIELD_INVALID", "MODEL_MISMATCH", "ENDPOINT_MISMATCH",
	"METHOD_INVALID", "REDIRECT_FORBIDDEN", "REQUEST_TIMEOUT", "TASK_TIMEOUT", "BATCH_TIMEOUT",
	"REQUEST_ABORTED", "NETWORK_FAILURE", "HTTP_FAILURE", "RESPONSE_BYTES_LIMIT", "RESPONSE_INCOMPLETE",
	"USAGE_INVALID", "PROVIDER_USAGE_LIMIT", "JOURNAL_FAILURE", "RESET_FORBIDDEN",
]);
const safeCode = (value: unknown, fallback: RequestStopCode): RequestStopCode => {
	const candidate = typeof value === "object" && value !== null && "code" in value ? value.code : null;
	return typeof candidate === "string" && PILOT_STOP_CODES.has(candidate as RequestStopCode) ? candidate as RequestStopCode : fallback;
};

export function createBoundedTransport<TaskId extends string>(options: TransportOptions<TaskId>, requestedPolicy: RequestPolicy<TaskId>) {
	const policy = freezeRequestPolicy(requestedPolicy), limits = policy.limits;
	if (!options.endpoint || !options.modelId || typeof options.fetchImpl !== "function") throw new Error("PILOT_TRANSPORT_CONFIG_INVALID");
	if (options.outputMode !== undefined && options.outputMode !== "exact" && options.outputMode !== "bounded") throw new Error("PILOT_TRANSPORT_CONFIG_INVALID");
	const endpoint = new URL(options.endpoint).href;
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? setTimeout;
	const clearTimer = options.clearTimer ?? clearTimeout;
	const storage = new AsyncLocalStorage<InvocationContext>();
	const startedAt = now();
	const taskStarted = new Map<string, number>();
	const requestsByTask = new Map<string, number>();
	const records: RequestSnapshot<TaskId>[] = [];
	let activeInvocation = false;
	let nextInvocationId = 1;
	let requestsReserved = 0;
	let inputReserved = 0;
	let outputReserved = 0;
	let completedResponses = 0;
	let unknownResponses = 0;
	let stopCode: RequestStopCode | null = null;
	const inFlight = new Set<AbortController>();

	const stop = (code: RequestStopCode): void => {
		if (stopCode !== null) return;
		stopCode = code;
		for (const controller of inFlight) controller.abort(Object.assign(new Error(code), { code }));
	};
	const failure = (code: RequestStopCode): Error => { stop(code); return Object.assign(new Error(code), { code }); };
	const assertActive = (): void => { if (stopCode !== null) throw Object.assign(new Error(stopCode), { code: stopCode }); };

	const deadlineCode = (taskId: string): RequestStopCode | null => {
		if (now() - startedAt >= limits.batchTimeoutMs) return "BATCH_TIMEOUT";
		const taskStart = taskStarted.get(taskId);
		if (taskStart !== undefined && now() - taskStart >= limits.taskTimeoutMs) return "TASK_TIMEOUT";
		return null;
	};
	const phaseDeadline = (taskId: string): { ms: number; code: RequestStopCode } => [
		{ ms: limits.requestTimeoutMs, code: "REQUEST_TIMEOUT" as const },
		{ ms: limits.taskTimeoutMs - (now() - (taskStarted.get(taskId) ?? now())), code: "TASK_TIMEOUT" as const },
		{ ms: limits.batchTimeoutMs - (now() - startedAt), code: "BATCH_TIMEOUT" as const },
	].reduce((lowest, item) => item.ms < lowest.ms ? item : lowest);
	const journal = async (hook: ((request: Readonly<RequestSnapshot<TaskId>>) => Promise<void>) | undefined,
		request: RequestSnapshot<TaskId>): Promise<void> => {
		if (!hook) return;
		const controller = new AbortController();
		inFlight.add(controller);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let rejectStopped!: (reason: unknown) => void;
		const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
		const onStop = () => rejectStopped(Object.assign(new Error("JOURNAL_FAILURE"), { code: "JOURNAL_FAILURE" }));
		controller.signal.addEventListener("abort", onStop, { once: true });
		const timed = new Promise<never>((_resolve, reject) => {
			timer = setTimer(() => reject(Object.assign(new Error("JOURNAL_FAILURE"), { code: "JOURNAL_FAILURE" })), Math.max(0, phaseDeadline(request.taskId).ms));
		});
		try { await Promise.race([hook(Object.freeze({ ...request, usage: request.usage ? Object.freeze({ ...request.usage }) : null })), timed, stopped]); }
		catch { throw failure("JOURNAL_FAILURE"); }
		finally { if (timer !== undefined) clearTimer(timer); controller.signal.removeEventListener("abort", onStop); inFlight.delete(controller); }
	};

	const gatedFetch: typeof fetch = async (input, init) => {
		assertActive();
		const invocation = storage.getStore();
		if (!invocation) throw failure("INVOCATION_REQUIRED");
		if (invocation.fetchCount !== 0) throw failure("INVOCATION_REUSED");
		invocation.fetchCount++;
		const expired = deadlineCode(invocation.taskId);
		if (expired) throw failure(expired);
		const target = input instanceof Request ? input.url : String(input);
		if (new URL(target).href !== endpoint) throw failure("ENDPOINT_MISMATCH");
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		if (method !== "POST") throw failure("METHOD_INVALID");
		if (init?.redirect !== undefined && init.redirect !== "error") throw failure("REDIRECT_FORBIDDEN");
		const rawBody = init?.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : null);
		if (rawBody === null || rawBody instanceof ReadableStream || rawBody instanceof FormData || rawBody instanceof URLSearchParams || rawBody instanceof Blob) {
			throw failure("REQUEST_BYTES_LIMIT");
		}
		const body = typeof rawBody === "string" ? new TextEncoder().encode(rawBody)
			: rawBody instanceof ArrayBuffer ? new Uint8Array(rawBody)
			: ArrayBuffer.isView(rawBody) ? new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
			: new TextEncoder().encode(String(rawBody));
		if (body.byteLength > limits.maxInputBytes) throw failure("REQUEST_BYTES_LIMIT");
		let payload: unknown;
		try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { throw failure("REQUEST_BYTES_LIMIT"); }
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure("REQUEST_BYTES_LIMIT");
		const record = payload as Record<string, unknown>;
		if (record.model !== options.modelId) throw failure("MODEL_MISMATCH");
		const outputFields = ["max_tokens", "max_completion_tokens"].filter((field) => Object.hasOwn(record, field));
		const requestedOutput = record[options.outputField];
		if (outputFields.length !== 1 || outputFields[0] !== options.outputField || !Number.isSafeInteger(requestedOutput)
			|| (requestedOutput as number) < 1 || (requestedOutput as number) > limits.maxOutputTokens
			|| options.outputMode !== "bounded" && requestedOutput !== limits.maxOutputTokens) {
			throw failure("OUTPUT_FIELD_INVALID");
		}
		const outputReservation = requestedOutput as number;
		const estimatedInput = options.estimateInput(body);
		if (!Number.isSafeInteger(estimatedInput) || estimatedInput < 0 || estimatedInput > limits.maxInputTokens) throw failure("INPUT_ESTIMATE_LIMIT");
		const taskRequests = requestsByTask.get(invocation.taskId) ?? 0;
		if (requestsReserved >= limits.maxHttpRequests) throw failure("BATCH_REQUEST_LIMIT");
		if (taskRequests >= limits.maxTaskHttpRequests) throw failure("TASK_REQUEST_LIMIT");
		if (inputReserved + estimatedInput > limits.maxTotalInputTokens) throw failure("BATCH_INPUT_LIMIT");
		if (outputReserved + outputReservation > limits.maxTotalOutputTokens) throw failure("BATCH_OUTPUT_LIMIT");
		// Reserve before the real dispatch. Nothing below refunds these counters.
		requestsReserved++;
		requestsByTask.set(invocation.taskId, taskRequests + 1);
		inputReserved += estimatedInput;
		outputReserved += outputReservation;
		const requestRecord: RequestSnapshot<TaskId> = {
			ordinal: requestsReserved, taskId: invocation.taskId as TaskId, invocationId: invocation.id,
			status: "dispatched", reasonCode: null, inputEstimate: estimatedInput, inputBytes: body.byteLength,
			outputReserved: outputReservation, requestSha256: sha256(body), dispatchAttempted: false, usage: null,
		};
		records.push(requestRecord);
		try { await journal(options.beforeDispatch, requestRecord); }
		catch (error) {
			unknownResponses++; requestRecord.status = "unknown"; requestRecord.reasonCode = "JOURNAL_FAILURE";
			throw error;
		}
		assertActive();
		const timeout = new AbortController();
		inFlight.add(timeout);
		const callerSignal = init?.signal;
		const abortFromCaller = () => timeout.abort(callerSignal?.reason);
		if (callerSignal?.aborted) abortFromCaller();
		else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
		const deadline = phaseDeadline(invocation.taskId);
		const timer = setTimer(() => timeout.abort(Object.assign(new Error(deadline.code), { code: deadline.code })), Math.max(0, deadline.ms));
		let rejectAbort!: (reason: unknown) => void;
		const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
		const abortDuringResponse = () => {
			const code = callerSignal?.aborted ? "REQUEST_ABORTED" : safeCode(timeout.signal.reason, deadline.code);
			rejectAbort(Object.assign(new Error(code), { code }));
		};
		timeout.signal.addEventListener("abort", abortDuringResponse, { once: true });
		const finishTransport = (): void => {
			clearTimer(timer); callerSignal?.removeEventListener("abort", abortFromCaller);
			timeout.signal.removeEventListener("abort", abortDuringResponse);
			inFlight.delete(timeout);
		};
		if (timeout.signal.aborted) {
			unknownResponses++; requestRecord.status = "unknown"; requestRecord.reasonCode = "REQUEST_ABORTED"; finishTransport();
			throw failure("REQUEST_ABORTED");
		}
		let response: Response;
		try {
			requestRecord.dispatchAttempted = true;
			response = await Promise.race([
				options.fetchImpl(input, { ...init, redirect: "error", signal: timeout.signal }),
				aborted,
			]);
		} catch (error) {
			unknownResponses++;
			requestRecord.status = "unknown";
			requestRecord.reasonCode = timeout.signal.aborted ? (callerSignal?.aborted ? "REQUEST_ABORTED" : safeCode(timeout.signal.reason, deadline.code)) : "NETWORK_FAILURE";
			finishTransport();
			throw failure(timeout.signal.aborted ? (callerSignal?.aborted ? "REQUEST_ABORTED" : safeCode(timeout.signal.reason, deadline.code)) : safeCode(error, "NETWORK_FAILURE"));
		}
		if (!response.ok) { unknownResponses++; requestRecord.status = "unknown"; requestRecord.reasonCode = "HTTP_FAILURE"; finishTransport(); throw failure("HTTP_FAILURE"); }
		if (!response.body) {
			unknownResponses++; requestRecord.status = "unknown"; requestRecord.reasonCode = "USAGE_INVALID"; finishTransport();
			throw failure("USAGE_INVALID");
		}
		const reader = response.body.getReader();
		const observer = createSseUsageObserver({ maxBytes: limits.maxResponseBytes });
		let bytes = 0;
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const part = await Promise.race([reader.read(), aborted]);
				if (part.done) break;
				bytes += part.value.byteLength;
				if (bytes > limits.maxResponseBytes) {
					void reader.cancel("RESPONSE_BYTES_LIMIT").catch(() => undefined);
					throw Object.assign(new Error("RESPONSE_BYTES_LIMIT"), { code: "RESPONSE_BYTES_LIMIT" });
				}
				observer.feed(part.value);
				chunks.push(part.value.slice());
			}
			const observed = observer.finish();
			if (observed.promptTokens === null || observed.completionTokens === null || observed.totalTokens === null) {
				throw Object.assign(new Error("USAGE_INVALID"), { code: "USAGE_INVALID" });
			}
			// Native-summary callers opt into bounded output. Conservatively include
			// separately reported reasoning in that bound, as the pinned SDK does.
			// Legacy exact-mode contracts remain unchanged.
			const observedOutput = (observed.completionTokens ?? 0) + (options.outputMode === "bounded" ? observed.reasoningTokens ?? 0 : 0);
			if ((observed.promptTokens ?? 0) > limits.maxInputTokens || observedOutput > outputReservation) {
				throw Object.assign(new Error("PROVIDER_USAGE_LIMIT"), { code: "PROVIDER_USAGE_LIMIT" });
			}
			const buffered = new Uint8Array(bytes);
			let offset = 0;
			for (const chunk of chunks) { buffered.set(chunk, offset); offset += chunk.byteLength; }
			requestRecord.status = "complete"; requestRecord.usage = observed;
			await journal(options.onRequestFinished, requestRecord);
			invocation.responseFinished = true; completedResponses++;
			finishTransport();
			return new Response(buffered, { status: response.status, statusText: response.statusText, headers: response.headers });
		} catch (error) {
			void reader.cancel("PILOT_RESPONSE_REJECTED").catch(() => undefined);
			unknownResponses++; requestRecord.status = "unknown";
			requestRecord.reasonCode = error instanceof UsageObservationError ? "USAGE_INVALID" : safeCode(error, "NETWORK_FAILURE");
			finishTransport(); throw failure(requestRecord.reasonCode);
		}
	};

	const invoke = async <T>(taskId: TaskId, operation: () => Promise<T>): Promise<T> => {
		assertActive();
		if (activeInvocation) throw failure("INVOCATION_CONCURRENT");
		if (!policy.taskIds.includes(taskId)) throw failure("INVOCATION_REQUIRED");
		const expired = deadlineCode(taskId);
		if (expired) throw failure(expired);
		if (!taskStarted.has(taskId)) taskStarted.set(taskId, now());
		activeInvocation = true;
		const context: InvocationContext = { id: nextInvocationId++, taskId, fetchCount: 0, responseFinished: false };
		try {
			const result = await storage.run(context, operation);
			assertActive();
			if (context.fetchCount !== 1) throw failure("INVOCATION_REQUIRED");
			if (!context.responseFinished) { unknownResponses++; throw failure("RESPONSE_INCOMPLETE"); }
			return result;
		} catch (error) {
			if (stopCode === null) stop(safeCode(error, "NETWORK_FAILURE"));
			throw error;
		} finally { activeInvocation = false; }
	};

	const snapshot = (): TransportSnapshot<TaskId> => Object.freeze({
		state: stopCode === null ? "active" : "stopped",
		stopCode,
		endpointSha256: sha256(endpoint), modelSha256: sha256(options.modelId),
		requestsReserved, inputReserved, outputReserved,
		requestsByTask: Object.freeze(Object.fromEntries([...requestsByTask].sort(([a], [b]) => a.localeCompare(b)))),
		completedResponses, unknownResponses,
		requests: Object.freeze(records.map((item) => Object.freeze({ ...item, usage: item.usage ? Object.freeze({ ...item.usage }) : null }))),
	});
	const reset = (): never => { throw failure("RESET_FORBIDDEN"); };

	return Object.freeze({ invoke, fetch: gatedFetch, assertActive, stop, reset, snapshot });
}
