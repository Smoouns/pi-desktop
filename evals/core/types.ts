/** Public, synthetic-only offline evaluation contract. No provider payloads. */
export type Category = "CTX" | "VER" | "TOOL" | "ISO";
export type RunStatus = "pass" | "fail" | "blocked_user" | "blocked_prerequisite" | "no_progress" | "cancelled" | "invalid" | "unsupported" | "unknown";
export type Scalar = string | number | boolean | null;
export type Capability = "toolReliability" | "observations" | "contextBudget" | "versionedCheckpoint";
export interface TaskDefinition {
	id: string;
	version: 1 | 2;
	requiredCapabilities?: Capability[];
	category: Category;
	fixture: "fixtures/harness-novel";
	allowedActions: string[];
	faults: string[];
	requiredChecks: string[];
	unsupportedConditions: string[];
	rubric: null;
}
export interface TaskResult {
	status: RunStatus;
	reasonCode: string;
	checks: Array<{ id: string; passed: boolean }>;
	trace: Array<{ event: string; data: Record<string, Scalar> }>;
	metrics: { modelCalls: number; duplicateSideEffects: number; staleEvidenceUsed: number; blockedDuplicateDispatches: number; recoveries: number };
}
export interface EvalTask {
	definition: TaskDefinition;
	/** Receives an isolated copy of the public fixture, never the repository fixture. */
	run(project: string, adapter?: import("../adapters/components.js").ComponentAdapter): Promise<TaskResult>;
}
export interface VariantDefinition {
	id: string;
	availability: "runnable" | "not_implemented";
	features: Record<string, boolean | null>;
	reason: string;
}
export interface EvalManifest {
	schemaVersion: 1 | 2;
	kind: "offline-contract";
	batchId: string;
	createdAt: string;
	code: { commit: string; dirty: boolean; files: Record<string, string>; sha256: string };
	environment: { node: string; npm: string; platform: string; arch: string; piSdk: string; lockSha256: string };
	fixture: { files: Record<string, string>; sha256: string };
	taskSet: { tasks: TaskDefinition[]; sha256: string };
	variants: VariantDefinition[];
	selectedVariant?: string;
	selectedVariants?: string[];
	budget: { modelCalls: 0; repetitions: 3; maxRuns: number; taskTimeoutMs: number };
	runs: Array<{ runId: string; taskId: string; repetition: number; variant?: string }>;
}
export interface Usage {
	/** Missing fields stay null. Cache counters never silently folded into input. */
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	totalTokens: number | null;
	source: "unavailable" | "synthetic";
}
export interface RawRun extends TaskResult {
	schemaVersion: 1;
	batchId: string;
	manifestSha256: string;
	runId: string;
	taskId: string;
	category: Category;
	variant: string;
	repetition: number;
	usage: Usage;
}
/** Written once after raw files. Manifest stays byte-identical throughout execution. */
export interface ResultIndex {
	schemaVersion: 1;
	batchId: string;
	manifestSha256: string;
	entries: Array<{ runId: string; file: string; sha256: string }>;
}
export interface AggregateGroup {
	variant: string;
	category: Category;
	runIds: string[];
	count: number;
	statuses: Record<RunStatus, number>;
	success: { numerator: number; denominator: number };
	usage: { missingRuns: number; syntheticRuns: number; actualProviderRuns: 0 };
	metrics: TaskResult["metrics"];
}
export interface EvalAggregate {
	schemaVersion: 1;
	batchId: string;
	manifestSha256: string;
	codeCommit: string;
	deterministic: boolean;
	runCount: number;
	groups: AggregateGroup[];
	taskGroups?: Array<AggregateGroup & { taskId: string }>;
	notRunVariants: string[];
	inference: "contract-only; insufficient for model quality, token savings or ablation claims";
}
