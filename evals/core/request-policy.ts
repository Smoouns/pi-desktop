import assert from "node:assert/strict";
export interface RequestLimits {
	maxHttpRequests: number; maxTaskHttpRequests: number;
	maxInputTokens: number; maxInputBytes: number; maxOutputTokens: number; safetyMargin: number;
	maxTotalInputTokens: number; maxTotalOutputTokens: number;
	requestTimeoutMs: number; taskTimeoutMs: number; batchTimeoutMs: number;
	maxResponseBytes: number; maxTaskTools: number;
}
export interface RequestPolicy<TaskId extends string = string> { namespace: string; taskIds: readonly TaskId[]; limits: Readonly<RequestLimits>; }
export function freezeRequestPolicy<TaskId extends string>(input: RequestPolicy<TaskId>): RequestPolicy<TaskId> {
	assert.match(input.namespace, /^[a-z][a-z0-9-]{0,63}$/);
	assert.ok(input.taskIds.length > 0 && input.taskIds.length <= 64 && new Set(input.taskIds).size === input.taskIds.length);
	for (const id of input.taskIds) assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
	const keys = ["maxHttpRequests","maxTaskHttpRequests","maxInputTokens","maxInputBytes","maxOutputTokens","safetyMargin","maxTotalInputTokens","maxTotalOutputTokens","requestTimeoutMs","taskTimeoutMs","batchTimeoutMs","maxResponseBytes","maxTaskTools"];
	assert.deepEqual(Object.keys(input.limits).sort(), keys.sort());
	for (const value of Object.values(input.limits)) assert.ok(Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000);
	assert.ok(input.limits.maxTaskHttpRequests <= input.limits.maxHttpRequests);
	return Object.freeze({ namespace: input.namespace, taskIds: Object.freeze([...input.taskIds]), limits: Object.freeze({ ...input.limits }) });
}
