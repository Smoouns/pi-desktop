import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTraceRecorder } from "../../src/harness/trace.js";
import type { TraceEvent } from "../../src/harness/types.js";
import { runContractCases } from "./contracts.js";
import { runMemoryCases } from "./memory.js";
import { runRpcCases } from "./rpc.js";
import { runTraceCases } from "./trace.js";
import { runVerifierCases } from "./verifier.js";
import { runExtensionRuntimeCases } from "./extension-runtime.js";
import { runToolPolicyCases } from "./tool-policy.js";
import { runOperationCases } from "./operations.js";
import { runToolPathPolicyCases } from "./tool-path-policy.js";
import { runBuiltinWriteCases } from "./builtin-writes.js";
import { runWriteStateExtensionCases } from "./write-state-extension.js";
import { runReadDeliveryCases } from "./read-delivery.js";
import { runReadDeliveryExtensionCases } from "./read-delivery-extension.js";
import { runReviewRepros } from "./review-repros.js";
import { runWorkflowUiCases } from "./workflow-ui.js";
import { runSessionRestoreCases } from "./session-restore.js";
import { runSessionRefreshCases } from "./session-refresh.js";
import { runSessionTitleCoreTests } from "../session-title-core.js";
import { runSessionTitleExtensionTests } from "../session-title-extension.js";
import { runObservationStoreTests } from "./observation-store.js";
import { runContextBudgetCases } from "./context-budget.js";
import { runBudgetDiagnosticCases } from "./budget-diagnostics.js";
import { runContextUsageCases } from "./context-usage.js";
import { runContextMaintenanceCases } from "./context-maintenance.js";
import { runContextMaintenanceExtensionCases } from "./context-maintenance-extension.js";
import { runContextMaintenanceGuardCases } from "./context-maintenance-extension-guards.js";
import { runPhase2ExtensionCases } from "./phase2-extension.js";
import { runProviderBudgetCases } from "./provider-budget.js";
import { runStoryRangeCases } from "./read-range.js";
import { runPhase2InvariantCases } from "./phase2-invariants.js";
import { runCheckpointStoreCases } from "./checkpoint-store.js";
import { runSourceVersionCases, runInvalidationCases } from "./source-version.js";
import { runPhase3ExtensionCases } from "./phase3-extension.js";
import { runCheckpointPersistenceCases } from "./checkpoint-persistence.js";
import { runCheckpointRuntimeCases } from "./checkpoint-runtime.js";
import { runSupervisorCases } from "./run-supervisor.js";
import { runSupervisorRuntimeCases } from "./supervisor-runtime.js";
import { runSupervisorAgentLoopCases } from "./supervisor-agent-loop.js";
import { runPhase4ExtensionCases, runLongHorizonCases } from "./phase4-extension.js";
import { runExtensionUiCases } from "./extension-ui.js";
import { runStatusCommandRpcCases } from "./status-command-rpc.js";
import { fixtureRoot, sha256, treeManifest, type RunCase } from "./testkit.js";

type CaseResult = { id: string; status: "pass" | "fail" | "partial"; trace: TraceEvent[]; unsupported: Array<{ subcase: string; reason: string }>; error?: string };
const original = await treeManifest(fixtureRoot);
const repetitions: CaseResult[][] = [];
const output = path.resolve("artifacts/harness");
await mkdir(output, { recursive: true });

for (let repetition = 1; repetition <= 3; repetition++) {
	const results: CaseResult[] = [];
	const runCase: RunCase = async (id, body, scope = {}) => {
		assert.ok(!results.some((result) => result.id === id), `Duplicate case ID: ${id}`);
		const trace = createTraceRecorder({
			caseId: id,
			scope: { projectId: "synthetic-a", sessionId: "session-a", runId: "baseline-run", generation: 1, role: null, ...scope },
			now: () => 0,
		});
		let failure: unknown;
		const unsupported: CaseResult["unsupported"] = [];
		try {
			assert.deepEqual(await treeManifest(fixtureRoot), original, "Fixture changed before case");
			trace.record("case.started");
			await body((event, summary) => {
				trace.record(event, summary);
				if (event === "case.unsupported") {
					assert.equal(process.platform, "win32", "Required Linux case cannot be unsupported");
					assert.equal(typeof summary?.subcase, "string");
					assert.equal(typeof summary?.reason, "string");
					unsupported.push({ subcase: String(summary?.subcase), reason: String(summary?.reason) });
				}
			});
		} catch (error) { failure = error; }
		try { assert.deepEqual(await treeManifest(fixtureRoot), original, "Fixture changed after case"); }
		catch (error) { failure = error; }
		trace.record("case.completed", { passed: !failure && unsupported.length === 0, unsupportedSubcases: unsupported.length });
		const result: CaseResult = { id, status: failure ? "fail" : unsupported.length ? "partial" : "pass", trace: trace.snapshot(), unsupported };
		if (failure) {
			result.error = (failure instanceof Error ? failure.message : String(failure)).replaceAll(process.cwd(), "<repo>").replaceAll(os.tmpdir(), "<tmp>").slice(0, 2000);
			console.error(`FAIL ${id}: ${result.error}`);
		} else console.log(`${result.status === "partial" ? "PARTIAL" : "PASS"} ${id}${unsupported.length ? `: ${JSON.stringify(unsupported)}` : ""}`);
		results.push(result);
	};
	await runTraceCases(runCase);
	await runContractCases(runCase);
	await runMemoryCases(runCase);
	await runRpcCases(runCase);
	await runVerifierCases(runCase);
	await runToolPolicyCases(runCase);
	await runOperationCases(runCase);
	await runToolPathPolicyCases(runCase);
	await runExtensionRuntimeCases(runCase);
	await runBuiltinWriteCases(runCase);
	await runWriteStateExtensionCases(runCase);
	await runReadDeliveryCases(runCase);
	await runReviewRepros(runCase);
	await runReadDeliveryExtensionCases(runCase);
	await runWorkflowUiCases(runCase);
	await runSessionRestoreCases(runCase);
	await runSessionRefreshCases(runCase);
	await runCase("SESSION-TITLE-01 bounded visible naming input", () => { runSessionTitleCoreTests(); });
	await runCase("SESSION-TITLE-02 loaded extension naming and isolation", () => runSessionTitleExtensionTests());
	await runCase("P2-OBS immutable bounded observation store", () => { runObservationStoreTests(); });
	await runContextBudgetCases(runCase);
	await runBudgetDiagnosticCases(runCase);
	await runContextUsageCases(runCase);
	await runContextMaintenanceCases(runCase);
	await runContextMaintenanceExtensionCases(runCase);
	await runContextMaintenanceGuardCases(runCase);
	await runStoryRangeCases(runCase);
	await runPhase2ExtensionCases(runCase);
	await runPhase2InvariantCases(runCase);
	await runProviderBudgetCases(runCase);
	await runCheckpointStoreCases(runCase);
	await runSourceVersionCases(runCase);
	await runInvalidationCases(runCase);
	await runPhase3ExtensionCases(runCase);
	await runCheckpointPersistenceCases(runCase);
	await runCheckpointRuntimeCases(runCase);
	await runSupervisorCases(runCase);
	await runSupervisorRuntimeCases(runCase);
	await runSupervisorAgentLoopCases(runCase);
	await runPhase4ExtensionCases(runCase);
	await runExtensionUiCases(runCase);
	await runStatusCommandRpcCases(runCase);
	await runLongHorizonCases(runCase);
	repetitions.push(results);
	await writeFile(path.join(output, `run-${repetition}.json`), JSON.stringify(results, null, 2) + "\n");
}

let deterministic = true;
try {
	assert.deepEqual(repetitions[1], repetitions[0]);
	assert.deepEqual(repetitions[2], repetitions[0]);
} catch { deterministic = false; }
const packageVersion = async (name: string): Promise<string> => JSON.parse(await readFile(path.join("node_modules", name, "package.json"), "utf8")).version;
const implementationFiles: Record<string, string> = {};
for (const name of [
	"src/extensions/novel-tools-extension.ts", "src/extensions/checkpoint-runtime.ts", "src/novel/context.ts", "src/novel/context-attachment.ts",
	"src/extensions/supervisor-runtime.ts",
	"src/extensions/budget-diagnostics.ts",
	"src/extensions/context-maintenance.ts",
	"src/components/chat-view/context-usage-view.ts",
	"src/components/chat-view/composer-stats-view.ts",
	"src/components/chat-view/event-stream-handlers.ts",
	"src/components/extension-ui-handler.ts",
	"src/components/chat-view/extension-status-view.ts",
	"src/components/chat-view.ts", "src/novel/memory-engine.ts", "src/rpc/bridge.ts",
	"src/novel/tool-path-policy.ts", "src/novel/read-range.ts", "src/components/context-inspector.ts", "src-tauri/src/lib.rs", "src-tauri/src/session_file.rs",
	"src/rpc/session-restore.ts", "src/main.ts", "src/components/chat-view/assistant-workflow-view.ts",
	"src/components/session-browser.ts", "src/components/chat-view/session-refresh-scope.ts", "src/styles/app.css",
	"src/extensions/session-title-core.ts", "src/extensions/session-title-extension.ts", "tests/session-title-core.ts", "tests/session-title-extension.ts",
	"src/components/chat-view/workflow-utils.ts", "src/i18n/ui-chinese.ts",
	"scripts/verify-novel-chapter.ts", "scripts/run-public-tests.mjs", "scripts/run-harness-baseline.mjs",
	"scripts/test-extension-status-ui.mjs",
	"scripts/test-context-usage-ui.mjs",
	"scripts/test-context-entry-ui.mjs",
	"src/layout/chat-panel-resize.ts", "scripts/test-chat-panel-resize.mjs",
	"scripts/novel-domain-smoke.ts", "scripts/novel-tools-extension-smoke.ts", "scripts/novel-verifier-smoke.ts",
	"scripts/novel-memory-smoke.ts", "scripts/world-change-smoke.ts", "package.json", "tsconfig.harness.json",
]) implementationFiles[name] = sha256(await readFile(name));
for (const directory of ["src/harness", "tests/harness", "tests/support"]) {
	for (const [name, hash] of Object.entries(await treeManifest(directory))) implementationFiles[`${directory}/${name}`] = hash;
}
const summary = {
	schemaVersion: 1, phase: "phase4", phaseStartCommit: "828d36d9c0f3140c750616b97e7d7e92287e6444", baselineCommit: "3b5f8b06131d46ee0b4b97dd646ba3d6f6bcd887",
	implementationHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
	node: process.version, npm: process.env.npm_config_user_agent?.split(" ")[0] ?? "unavailable",
	platform: process.platform, arch: process.arch, osRelease: os.release(),
	piSdk: await packageVersion("@mariozechner/pi-coding-agent"), esbuild: await packageVersion("esbuild"),
	lockSha256: sha256(await readFile("package-lock.json")), fixtureSha256: sha256(JSON.stringify(original)),
	implementationFiles, implementationSha256: sha256(JSON.stringify(implementationFiles)),
	fixture: original, repetitions: 3, deterministic,
	cases: repetitions[0].map(({ id, status, unsupported }) => ({ id, status, unsupported })),
	actualModelInputTokens: null, modelCalls: 0,
};
await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
const failed = repetitions.some((results) => results.some((result) => result.status === "fail"));
console.log(`Harness: ${summary.cases.length} cases x 3; deterministic=${deterministic}; failures=${failed}`);
if (failed || !deterministic) process.exitCode = 1;
