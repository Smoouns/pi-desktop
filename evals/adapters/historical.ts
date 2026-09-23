import { createOperationLedger } from "./snapshots/operation-ledger.js";
import { createToolRuntime } from "./snapshots/tool-policy.js";
import { createObservationStore } from "./snapshots/observation-store.js";
import { createContextBudget } from "./snapshots/context-budget.js";
import { createCheckpointStore } from "./snapshots/checkpoint-store.js";
import { createSourceVersioning } from "./snapshots/source-version.js";
import { createCheckpointInvalidation } from "./snapshots/invalidation.js";
import provenanceJson from "./provenance.json";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ComponentAdapter } from "./components.js";
import type { Capability } from "../core/types.js";

export const historicalProfiles = Object.freeze({
	"historical-b1": Object.freeze(["toolReliability"] as Capability[]),
	"historical-b2": Object.freeze(["toolReliability", "observations", "contextBudget"] as Capability[]),
	"historical-b3": Object.freeze(["toolReliability", "observations", "contextBudget", "versionedCheckpoint"] as Capability[]),
});

export type HistoricalProfileId = keyof typeof historicalProfiles;
export const historicalProvenance = provenanceJson;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Always verifies the checked-in snapshot bytes against frozen metadata; does not require Git. */
export async function validateHistoricalSnapshots(root = process.cwd()): Promise<void> {
	for (const profile of Object.values(historicalProvenance.profiles)) {
		for (const source of profile.sources) {
			const bytes = await readFile(path.resolve(root, source.localPath));
			if (sha256(bytes) !== source.sha256) throw new Error(`HISTORICAL_SNAPSHOT_MISMATCH:${source.localPath}`);
		}
	}
}

/** Historical production factories only. Missing capabilities never fall back to current source. */
export function createHistoricalAdapter(id: string): ComponentAdapter {
	const capabilities = historicalProfiles[id as HistoricalProfileId];
	if (!capabilities) throw new Error("HISTORICAL_ADAPTER_UNAVAILABLE");
	return Object.freeze({
		id, capabilities,
		operationLedger: createOperationLedger,
		toolRuntime: createToolRuntime,
		...(capabilities.includes("observations") ? { observationStore: createObservationStore } : {}),
		...(capabilities.includes("contextBudget") ? { contextBudget: createContextBudget } : {}),
		...(capabilities.includes("versionedCheckpoint") ? {
			checkpointStore: createCheckpointStore,
			sourceVersioning: createSourceVersioning,
			checkpointInvalidation: createCheckpointInvalidation,
		} : {}),
	});
}
