import path from "node:path";
import { readBounded } from "../core/io.js";
import { aggregateBatch } from "../core/aggregate.js";
import { recoverLiveResults } from "../pilot/live-records.js";
import { sdkAggregate } from "../sdk-ablation/records.js";
import { recoverResults } from "../sdk-live/records.js";
import { rebuild } from "../sdk-context/records.js";
import { rebuildLifecycle } from "../sdk-context/lifecycle-records.js";
import { recover as transport } from "../sdk-context-transport/records.js";
import { rebuild as races } from "../sdk-recovery-races/records.js";
import { rebuild as supervision } from "../sdk-supervision/records.js";
import type { Family } from "./catalog.js";
import { recoverLegacyContext, recoverLegacySupervision } from "./legacy-context.js";

/** Only reconstruction actions. Legacy function-text hashes need their own bundle. */
export async function rebuildEvidence(family: Family, directory: string, files: Record<string, string>) {
  const json = async (name: string) => JSON.parse(await readBounded(path.join(directory, name)));
  if (family === "module" || family === "sdk-read-write") {
    const raw = new Map<string, string>();
    for (const file of Object.keys(files).filter(f => f.startsWith("raw/"))) raw.set(file, await readBounded(path.join(directory, file)));
    const manifest = await json("manifest.json"), index = await json("result-index.json");
    return family === "module" ? aggregateBatch(manifest, index, raw) : sdkAggregate(manifest, index, raw);
  }
  switch (family) {
    case "pilot": return recoverLiveResults(directory);
    case "sdk-live": return recoverResults(directory);
    case "sdk-context": return rebuild(directory);
    case "sdk-lifecycle": return rebuildLifecycle(directory);
    case "sdk-transport": return transport(directory);
    case "sdk-context-live": return recoverLegacyContext(directory);
    case "sdk-recovery": return races(directory);
    case "sdk-supervision": return supervision(directory);
    case "sdk-supervision-live": return recoverLegacySupervision(directory);
  }
}
