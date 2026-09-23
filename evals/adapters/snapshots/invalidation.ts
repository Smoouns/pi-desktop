import type { SourceVersionCheck } from "./source-version.js";

export interface CheckpointInvalidationInput {
	scopeMatches: boolean;
	sources: SourceVersionCheck[];
	artifactChecks?: SourceVersionCheck[];
	pendingOperations: Array<{ operationId: string; state: string }>;
}

export interface CheckpointInvalidationResult {
	status: "ready" | "needs_revalidation" | "blocked";
	invalidPaths: string[];
	blockedOperationIds: string[];
	allowedToWrite: boolean;
}

export interface CheckpointInvalidation {
	evaluate(input: CheckpointInvalidationInput): CheckpointInvalidationResult;
}

/** Pure checkpoint decision; safe to embed via this function's toString(). */
export function createCheckpointInvalidation(): CheckpointInvalidation {
	const settled = new Set(["completed", "cancelled", "failed"]);
	return {
		evaluate(input) {
			if (!input || typeof input !== "object") throw new TypeError("input must be an object");
			if (typeof input.scopeMatches !== "boolean") throw new TypeError("scopeMatches must be boolean");
			if (!Array.isArray(input.sources) || !Array.isArray(input.pendingOperations) || (input.artifactChecks !== undefined && !Array.isArray(input.artifactChecks))) {
				throw new TypeError("checks and pendingOperations must be arrays");
			}
			const checks = [...input.sources, ...(input.artifactChecks ?? [])];
			const invalidPaths = [...new Set(checks.filter((check) => check?.status !== "valid").map((check) => check?.ref?.path).filter((path): path is string => typeof path === "string"))];
			const blockedOperationIds = [...new Set(input.pendingOperations
				.filter((operation) => !settled.has(operation?.state))
				.map((operation) => operation?.operationId)
				.filter((id): id is string => typeof id === "string" && id.length > 0))];
			if (!input.scopeMatches || blockedOperationIds.length > 0) return { status: "blocked", invalidPaths, blockedOperationIds, allowedToWrite: false };
			if (invalidPaths.length > 0) return { status: "needs_revalidation", invalidPaths, blockedOperationIds: [], allowedToWrite: false };
			return { status: "ready", invalidPaths: [], blockedOperationIds: [], allowedToWrite: true };
		},
	};
}
