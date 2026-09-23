import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NOVEL_TOOLS_EXTENSION_CONTENT as BASELINE } from "./baseline/src/extensions/novel-tools-extension.js";
import provenance from "./baseline/provenance.json";
import { createOperationLedger } from "../adapters/snapshots/operation-ledger.js";
import { createToolRuntime } from "../adapters/snapshots/tool-policy.js";
import historical from "../adapters/provenance.json";
import { createBaselineSafety } from "./safety.js";
import { installSdkReliability } from "./reliability.js";
import { sha256, digest } from "../core/io.js";
import { SDK_PROFILES, type SdkProfile } from "./policy.js";

export const SDK_METRICS_KEY = "pi.sdk-ablation.metrics";
export const emptySdkMetrics = () => ({ agentStarts: 0, runStops: 0, readRetries: 0, reconciledWrites: 0, unknownWritesBlocked: 0, staleResults: 0 });

export async function validateSdkProvenance(root = process.cwd()): Promise<void> {
	for (const source of provenance.sources) assert.equal(sha256(await readFile(path.join(root, source.localPath))), source.sha256, "SDK_BASELINE_DRIFT");
	for (const source of historical.profiles["historical-b1"].sources) assert.equal(sha256(await readFile(path.join(root, source.localPath))), source.sha256, "SDK_B1_FACTORY_DRIFT");
}

/** Raw baseline remains byte-exact on disk. Safety wrapper is an explicit, common overlay. */
export function sdkExtensionSource(profile: SdkProfile): string {
	assert.ok(SDK_PROFILES.includes(profile), "SDK_PROFILE_INVALID");
	assert.equal(BASELINE.split("export default function (pi)").length, 2, "SDK_BASELINE_ENTRY_DRIFT");
	const baseline = BASELINE.replace("export default function (pi)", "function registerRawBaseline(pi)");
	const reliability = profile === "sdk-b1-reliability"
		? `const layer = (${installSdkReliability.toString()})(pi, { createOperationLedger: (${createOperationLedger.toString()}), createToolRuntime: (${createToolRuntime.toString()}), path, readFile, createHash, safety }, metrics);`
		: "const layer = null;";
	return baseline + `
import { createHash } from "node:crypto";
export default function (pi) {
  const metrics = ${JSON.stringify(emptySdkMetrics())};
  globalThis[Symbol.for(${JSON.stringify(SDK_METRICS_KEY)})] = metrics;
  const safety = (${createBaselineSafety.toString()})({ path, lstat, readFile });
  pi.on("tool_call", async (event, ctx) => {
    try { await safety.check(event.toolName, event.input, ctx); }
    catch (error) { return { block: true, reason: "[permission] " + (error.message === "SDK_TOOL_DENIED" ? "SDK_TOOL_DENIED" : "SDK_PATH_OR_METADATA_DENIED") }; }
  });
  // Both profiles expose the same research tool; unused baseline tools are not registered.
  // SDK native read/write are supplied by the common host. No executable verifier/bash.
  let wrappedRead;
  registerRawBaseline({ ...pi, registerTool(definition) {
    if (definition.name !== "read_story_document") return;
    wrappedRead = { ...definition, async execute(id, params, signal, update, ctx) {
      await safety.check(definition.name, params, ctx);
      const fault = globalThis[Symbol.for("pi.sdk-ablation.readFault")];
      if (fault) { fault.attempts++; if (fault.remaining > 0) { fault.remaining--; throw Object.assign(new Error("Synthetic read interruption"), { code: "EAGAIN" }); } }
      return definition.execute(id, params, signal, update, ctx);
    } };
  } });
  ${reliability}
  pi.registerTool(layer ? { ...wrappedRead, async execute(...args) { return layer.read(() => wrappedRead.execute(...args), args[2]); } } : wrappedRead);
}
`;
}

export function expectedSdkInventory(profile: SdkProfile) {
	return { tools: ["read_story_document"], commands: ["novel-plan", "novel-review", "novel-world", "novel-write"],
		handlers: { before_agent_start: 1, context: 1, session_start: 1, tool_call: profile === "sdk-b1-reliability" ? 3 : 2,
			...(profile === "sdk-b1-reliability" ? { agent_start: 1, agent_end: 1, session_switch: 1, session_shutdown: 1, tool_result: 1 } : {}) } };
}
/** Strict registered-event count as well as source identity: a feature label alone is not a gate. */
export function auditSdkInventory(profile: SdkProfile, loaded: any, source: string): void {
	assert.equal(sha256(source), sha256(sdkExtensionSource(profile)), "SDK_EXTENSION_SOURCE_DRIFT");
	assert.equal(loaded.errors.length, 0, "SDK_EXTENSION_LOAD_FAILED");
	assert.equal(loaded.extensions.length, 1, "SDK_EXTENSION_COUNT");
	const extension = loaded.extensions[0];
	const actual = { tools: [...extension.tools.keys()].sort(), commands: [...extension.commands.keys()].sort(),
		handlers: Object.fromEntries([...extension.handlers.entries()].map(([name, list]: any) => [name, list.length])) };
	assert.equal(digest(actual), digest(expectedSdkInventory(profile)), "SDK_CAPABILITY_LEAK");
}
