import type { VariantDefinition } from "./core/types.js";
import { comparisonVariants, componentProfiles } from "./adapters/components.js";
import { historicalProfiles, historicalProvenance } from "./adapters/historical.js";

type FeatureMatrix = VariantDefinition["features"];

const matrix = (overrides: Partial<FeatureMatrix> = {}): FeatureMatrix => ({
	typedToolSessionReliability: false,
	observationStore: false,
	completeRequestContextBudget: false,
	versionAwareCheckpoint: false,
	nativeCompactionIntegration: false,
	runSupervisor: false,
	contextMaintenance: false,
	denseRetrieval: false,
	...overrides,
});

/**
 * Declared evaluation variants, not experimental results.
 *
 * Vendored historical modules have explicit, hash-verified contract adapters.
 * They do not reproduce full historical Desktop/SDK lifecycles. Full-stack
 * B0-B3 ablations therefore remain unavailable and are listed separately.
 */
export const variants: VariantDefinition[] = [
	...Object.entries(historicalProfiles).map(([id, capabilities]): VariantDefinition => ({
		id, availability: "runnable",
		features: matrix({
			typedToolSessionReliability: capabilities.includes("toolReliability"),
			observationStore: capabilities.includes("observations"),
			completeRequestContextBudget: capabilities.includes("contextBudget"),
			versionAwareCheckpoint: capabilities.includes("versionedCheckpoint"),
		}),
		reason: `Historical production module snapshot from ${historicalProvenance.profiles[id as keyof typeof historicalProfiles].phaseCommit}; exact files/blob/SHA in evals/adapters/provenance.json (frozen in code.files). Shared offline scaffold, NOT full historical Desktop, native compaction or performance baseline. Budget uses historical UTF-8 bytes, not provider tokens.`,
	})),
	...comparisonVariants.map((id): VariantDefinition => ({
		id, availability: "runnable",
		features: matrix({
			typedToolSessionReliability: componentProfiles[id].includes("toolReliability"),
			observationStore: componentProfiles[id].includes("observations"),
			completeRequestContextBudget: componentProfiles[id].includes("contextBudget"),
			versionAwareCheckpoint: componentProfiles[id].includes("versionedCheckpoint"),
		}),
		reason: "Current-source component contract profile in one frozen scaffold, not a historical B1/B2/B3 baseline or Pi lifecycle ablation. Missing factories yield unsupported; no invented fallback. Compaction is a synthetic checkpoint serialization boundary only.",
	})),
	{
		id: "b0-raw",
		availability: "not_implemented",
		features: matrix(),
		reason: "The frozen Phase 0 commit is historical evidence, not a fair B0 adapter. A synthetic-sandbox adapter that preserves raw behavior without exposing real projects has not been implemented.",
	},
	{
		id: "b0-safety-fixed",
		availability: "not_implemented",
		features: matrix(),
		reason: "The minimal safety-only patch set and its auditable diff from B0-raw have not been isolated as an evaluation adapter.",
	},
	{
		id: "b1-tool-session",
		availability: "not_implemented",
		features: matrix({ typedToolSessionReliability: true }),
		reason: "Full Desktop/session lifecycle adapter built on B0-safety-fixed is not implemented. historical-b1 exercises exact historical module contracts only, not this full-stack boundary.",
	},
	{
		id: "b2-observation-budget",
		availability: "not_implemented",
		features: matrix({
			typedToolSessionReliability: true,
			observationStore: true,
			completeRequestContextBudget: true,
		}),
		reason: "Full Desktop/SDK observation and request-dispatch lifecycle adapter is not implemented. historical-b2 covers historical module contracts only, not this full-stack boundary.",
	},
	{
		id: "b3-checkpoint-compaction",
		availability: "not_implemented",
		features: matrix({
			typedToolSessionReliability: true,
			observationStore: true,
			completeRequestContextBudget: true,
			versionAwareCheckpoint: true,
			nativeCompactionIntegration: true,
		}),
		reason: "Phase 3 exists in code history, but a fair adapter with pre-frozen checkpoint and compaction policy has not been implemented.",
	},
	{
		id: "b3-supervisor",
		availability: "not_implemented",
		features: matrix({
			typedToolSessionReliability: true,
			observationStore: true,
			completeRequestContextBudget: true,
			versionAwareCheckpoint: true,
			nativeCompactionIntegration: true,
			runSupervisor: true,
		}),
		reason: "Supervisor code is present in production, but no adapter isolates it from later maintenance changes for a fair ablation.",
	},
	{
		id: "b3-supervisor-maintenance",
		availability: "not_implemented",
		features: matrix({
			typedToolSessionReliability: true,
			observationStore: true,
			completeRequestContextBudget: true,
			versionAwareCheckpoint: true,
			nativeCompactionIntegration: true,
			runSupervisor: true,
			contextMaintenance: true,
		}),
		reason: "This intended ablation boundary is documented, but it does not yet have an independently selectable production adapter.",
	},
	{
		id: "b4-dense-retrieval",
		availability: "not_implemented",
		features: matrix({
			typedToolSessionReliability: true,
			observationStore: true,
			completeRequestContextBudget: true,
			versionAwareCheckpoint: true,
			nativeCompactionIntegration: true,
			denseRetrieval: true,
		}),
		reason: "B4 is deliberately deferred. No vector database, embedding service, reranker or dense-retrieval evaluation path is implemented.",
	},
	{
		id: "current-full-contract",
		availability: "runnable",
		features: matrix({
			typedToolSessionReliability: true,
			observationStore: true,
			completeRequestContextBudget: true,
			versionAwareCheckpoint: true,
			nativeCompactionIntegration: true,
			runSupervisor: true,
			contextMaintenance: true,
		}),
		reason: "Current-source complete contract profile. Flags describe production capabilities, not complete eval coverage; the shared scaffold does not exercise native compaction, Supervisor or maintenance lifecycle. Not a historical baseline.",
	},
];
