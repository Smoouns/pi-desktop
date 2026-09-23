/** Separate offline contract: never changes the sealed S3 task/profile definitions. */
export const PROFILE = "sdk-b3-checkpoint-ops-v2" as const;
export const CASES = ["before-effect", "partial-effect", "after-effect", "late-effect"] as const;
export type RaceCase = typeof CASES[number];
export const LIMITS = { childMs: 30_000, caseMs: 90_000, repetitions: 3 } as const;
export const TARGET = "drafts/candidates/sdk-recovery-race.md";
export const CONTENT = "public-recovery-race: complete\n";
export const PARTIAL = "public-recovery-race: partial\n";
export const SETTINGS = { compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: false };
export const PROMPTS = { seed: "Read canon/world.md before writing.", write: `Write ${JSON.stringify(CONTENT)} to ${TARGET} once.`, refresh: "Refresh the checkpoint. Do not replay an unresolved or satisfied write." };
export const plan = () => [1, 2, 3].flatMap(repetition => CASES.map(scenario => ({ runId: `${scenario}-r${repetition}`, scenario, repetition })));
export type Run = ReturnType<typeof plan>[number];
export type State = "none" | "issued" | "unknown" | "completed";
export interface Seed {
  durableIntent: boolean; issued: boolean; dispatched: boolean; inventory: boolean; settings: boolean; zeroNetwork: boolean;
  targetSha256: string | null; sessionSha256: string; checkpointSha256: string; providerCalls: number; tools: number; writes: number;
}
export interface Resume {
  reopened: boolean; inventory: boolean; settings: boolean; boundary: boolean; zeroNetwork: boolean;
  pendingBefore: State; pendingAfter: State; targetSha256: string | null;
  writeDispatches: number; replayResults: string[]; refreshes: number; providerCalls: number; tools: number;
  operationMetrics: { intents: number; results: number; replayBlocks: number; persistenceBlocks: number; staleResults: number };
}
export interface Evidence {
  seed: Seed | null; killed: boolean; exited: boolean; gracefulCleanup: boolean;
  seedDiskVerified: boolean; exitCode: number | null; exitSignal: string | null;
  resumes: Resume[]; executorReady: boolean; executorReleasedAfterRecovery: boolean; executorEffects: number;
  boundary: boolean; sourceStable: boolean;
}
export const emptyEvidence = (): Evidence => ({ seed: null, killed: false, exited: false, gracefulCleanup: false, seedDiskVerified: false, exitCode: null, exitSignal: null,
  resumes: [], executorReady: false, executorReleasedAfterRecovery: false, executorEffects: 0, boundary: false, sourceStable: false });
