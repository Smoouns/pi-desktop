import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { NOVEL_TOOLS_EXTENSION_CONTENT } from "../../../src/extensions/novel-tools-extension.js";
import { PreparedBroker } from "./prepared-broker.js";
import { allowedTools, GOAL, QUESTION, critical, oracle, prompts, score, seed, settingsFor, SOURCE, source, systemPrompt } from "./fixtures.js";
import { digest } from "./journal.js";
import { writeNew } from "./prepared-manifest.js";
import { enumeratedStateProfile, executionProfile, jointNoToolsProfile, upstreamBudget, upstreamBudgetProfile, type ExecutionProfile } from "./protocol-profile.js";
import { jointToolPolicyEvidence } from "./joint-tool-policy.js";
import { QUESTION_V2, RESPONSE_CONTRACT_V2, responseContractSchema, scoreResponseV2 } from "./response-contract-v2.js";

export const blueprint = {
	"canon/protected.md": "Public Canon sentinel. Model may not modify.\n",
	"planning/approval.json": '{"userAccepted":false}\n',
};
export const stages = executionProfile("joint").stages;
export const inputs = () => ({ systemPrompt, prompts, goal: GOAL, question: QUESTION, oracle, critical, seed: seed(), allowedTools, settings: settingsFor("normal"), stages,
	sourceV1: source("v1"), sourceV2: source("v2"), blueprint });
export async function buildAssets(dir: string, model: any, profile: ExecutionProfile = "joint") {
	const root = process.cwd(); await mkdir(path.join(dir, "assets"));
	writeNew(path.join(dir, "assets/novel-tools.ts"), NOVEL_TOOLS_EXTENSION_CONTENT);
	writeNew(path.join(dir, "assets/inputs.json"), JSON.stringify(profile !== "tool-none" ? { ...inputs(), stages: executionProfile(profile).stages,
		...(enumeratedStateProfile(profile) ? { question: QUESTION_V2, responseContractId: RESPONSE_CONTRACT_V2, responseContractSchema } : {}),
		...(jointNoToolsProfile(profile) ? { toolPolicy: { u: "none", "c-control": "none", "c-treatment": "none-including-native-summaries", r: "unchanged" } } : {}) } : {
		systemPrompt, prompt: prompts.u1, stages: executionProfile(profile).stages, activeTools: [], toolChoice: "none", settings: settingsFor("normal"), sourceV1: source("v1"), blueprint,
	}, null, 2) + "\n");
	for (const mode of ["probe", "live"]) writeNew(path.join(dir, "assets/" + mode + ".json"), JSON.stringify({ version: 1, mode, model, executionProfile: profile }, null, 2) + "\n");
	await build({ entryPoints: ["tests/harness/review-e-live/worker.ts"], outfile: path.join(dir, "assets/worker.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "warning",
		plugins: [{ name: "fixed-sdk-loader", setup(api) { api.onResolve({ filter: /node_modules\/@mariozechner\/pi-coding-agent\/dist\/core\/extensions\/index\.js$/ }, () => ({ path: pathToFileURL(path.join(root, "node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js")).href, external: true })); } }] });
}
export async function runPreparedBatch(dir: string, broker: PreparedBroker) {
	const results: any[] = [];
	const taskStarted = new Map<string, number>();
	for (const stage of executionProfile(broker.options.executionProfile).stages) {
		if (broker.journal.stopReason) { results.push({ ...stage, status: "not_run", reason: broker.journal.stopReason }); continue; }
		if (!taskStarted.has(stage.task)) taskStarted.set(stage.task, Date.now());
		// C's independent sessions share one task deadline, just like its allowance.
		const taskDeadline = taskStarted.get(stage.task)! + (broker.mode === "probe" ? 45_000 : broker.policy.limits.taskTimeoutMs);
		if (Date.now() >= taskDeadline) { broker.stop("task_timeout"); results.push({ ...stage, status: "not_run", reason: "task_timeout" }); continue; }
		const id = "worker-" + stage.id, work = path.join(broker.output, id), project = path.join(work, "project"), agentDir = path.join(work, "agent");
		await mkdir(path.join(project, ".novel"), { recursive: true }); await mkdir(agentDir);
		const layout = Object.fromEntries(["manuscript", "canon", "planning", "drafts", "craft", "notes", "memory", "research", "assets", "archive", "exports"].map(p => [p, [p]]));
		for (const directory of Object.keys(layout)) await mkdir(path.join(project, directory));
		writeNew(path.join(project, ".novel/project.json"), JSON.stringify({ formatVersion: 1, name: "E8 public synthetic", localFirst: true, layout }));
		for (const [file, text] of Object.entries(blueprint)) writeNew(path.join(project, file), text);
		writeNew(path.join(project, SOURCE), source("v1"));
		const env: NodeJS.ProcessEnv = {};
		for (const key of Object.keys(process.env)) if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LANG|LC_ALL)$/i.test(key)) env[key] = process.env[key];
		Object.assign(env, { PI_CODING_AGENT_DIR: agentDir, PI_EVAL_WORKER: "1", NODE_OPTIONS: `--import=${pathToFileURL(path.resolve("tests/harness/review-e-live/probe-guard.mjs")).href}` });
		broker.register(id, work, stage.task, stage.id);
		const child = spawn(process.execPath, [path.join(dir, "assets/worker.mjs"), work, id, stage.id, path.resolve("tests/harness/review-e-live/scope-extension.ts"), path.join(dir, "assets/novel-tools.ts"), path.join(dir, "assets/" + broker.mode + ".json")],
			{ cwd: process.cwd(), env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
		broker.attach(id, child); let stderrBytes = 0;
		child.stderr!.on("data", data => { stderrBytes += data.length; }); // Do not persist arbitrary provider/SDK error text.
		const timeout = setTimeout(() => { broker.stop("task_timeout"); child.kill(); }, Math.max(1, taskDeadline - Date.now()));
		const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); }); clearTimeout(timeout);
		for (const [file, text] of Object.entries(blueprint)) assert.equal(await readFile(path.join(project, file), "utf8"), text, "E8_PROTECTED_CHANGED");
		if (stage.id === "tool-none") assert.equal(await readFile(path.join(project, SOURCE), "utf8"), source("v1"), "E8_DIAGNOSTIC_SOURCE_CHANGED");
		let result: any;
		try { result = JSON.parse(await readFile(path.join(work, "worker-result.json"), "utf8")); } catch { broker.stop("worker_result_missing"); }
		if (exit.code !== 0 || !result || result.network.denied !== 0 || result.failure || result.errors.length) broker.stop("worker_failed");
		const status = broker.journal.stopReason ? "stopped" : "completed";
		results.push({ ...stage, status, pid: child.pid, exit, stderrBytes, resultFile: path.relative(dir, path.join(work, "worker-result.json")).replaceAll("\\", "/"), result });
	}
	return results;
}
function nativeTerminals(result: any) {
	const terminals: any[] = []; let previous: any;
	for (const record of result?.ledgerRecords ?? []) {
		if (previous) for (const ended of previous.pending.filter((p: any) => !record.pending.some((q: any) => q.id === p.id))) {
			terminals.push({ id: ended.id, kind: ended.kind, usage: record.counters.unknownUsageResponses > previous.counters.unknownUsageResponses ? null
				: Object.fromEntries(Object.keys(record.usageSums).map(key => [key, record.usageSums[key] - previous.usageSums[key]])) });
		}
		previous = record;
	}
	return terminals;
}
export function analyzeBatch(results: any[], broker: PreparedBroker) {
	const messages = (id: string) => results.find(row => row.id === id)?.result;
	const stageStatus = (id: string) => results.find(row => row.id === id)?.status ?? "not_run";
	const answer = (r: any) => [...(r?.messages ?? [])].reverse().find((m: any) => m.role === "assistant")?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") ?? "";
	const reservations = broker.journal.rows.filter(row => row.event === "reserved");
	const pairs = reservations.map(({ data }) => {
		const result = results.find(row => "worker-" + row.id === data.worker)?.result;
		const native = nativeTerminals(result).filter(t => t.id === data.productionCallId);
		const terminal = broker.journal.rows.find(row => row.event === "terminal" && row.data.id === data.id)?.data;
		const usage = native.length === 1 ? native[0].usage : null;
		const input = usage ? usage.input + usage.cacheRead + usage.cacheWrite : null;
		const diagnostic = result?.snapshots?.at(-1)?.transport?.calibration?.samples?.find((s: any) => s.sequence === data.productionCallId);
		const matched = terminal?.status === "complete" && input !== null && input > 0 && input === terminal.rawUsage.input;
		return { requestId: data.id, kind: data.kind, worker: data.worker, productionCallId: data.productionCallId,
			matched, sdkInput: input, raw: terminal?.rawUsage ?? null, bytes: data.inputReservation, diagnostic: diagnostic ?? null,
			sdkOutput: usage?.output ?? null, reasoningTokens: terminal?.reasoningTokens ?? null,
			brokerNormalizedOutput: terminal?.sdkNormalizedOutput ?? null,
			outputMatched: terminal?.status === "complete" && usage?.output != null && usage.output === terminal.sdkNormalizedOutput,
			errorTokens: matched && diagnostic?.eligible ? diagnostic.estimatedInputTokens - input : null,
			errorRatio: matched && diagnostic?.eligible ? (diagnostic.estimatedInputTokens - input) / input : null };
	});
	const treatment = messages("c-treatment"), control = messages("c-control"), read = messages("r");
	const budgetTools = (read?.tools ?? []).filter((t: any) => t.name === "get_context_budget").map((t: any) => {
		try { return { phase: t.phase, value: JSON.parse(t.result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")) }; } catch { return { phase: t.phase, value: null }; }
	});
	const readsFor = (phase: string) => budgetTools.filter((tool: any) => tool.phase === phase).map((tool: any) => tool.value?.metrics?.reads?.lastContext?.reads).filter(Boolean);
	const readEvidence = read ? {
		sameContextDuplicateSourceReused: readsFor("r1").some((r: any) => r.sourceCache?.hits > 0 && r.logicalReferences?.checkpointSources > 0 && r.logicalReferences?.observationSources > 0
			&& r.total?.calls === 1 && r.total.bytes === Buffer.byteLength(source("v1"))),
		nextContextRevalidated: readsFor("r2").some((r: any) => r.total?.calls > 0),
		sourceTransitionRecorded: broker.journal.rows.filter(row => row.event === "host-transition").length === 1,
		freshV2ReadObserved: (read?.tools ?? []).some((t: any) => t.phase === "r3" && ["read", "read_story_document"].includes(t.name) && !t.isError
			&& t.result?.content?.some((part: any) => part.type === "text" && part.text.includes("v2") && part.text.includes("COBAL"))),
		finalAnswerReportsV2: answer(read).includes("v2"),
	} : null;
	const terminals = broker.journal.rows.filter(row => row.event === "terminal");
	const scoreAnswer = enumeratedStateProfile(broker.options.executionProfile) ? scoreResponseV2 : score;
	const controlScore = control ? scoreAnswer(answer(control)) : null, systemRecoveryScore = treatment ? scoreAnswer(answer(treatment)) : null;
	const errorSamples = pairs.filter(p => p.errorTokens !== null);
	return { mode: broker.mode, executionProfile: broker.options.executionProfile ?? "joint",
		...(enumeratedStateProfile(broker.options.executionProfile) ? { responseContractId: RESPONSE_CONTRACT_V2, liveAllowed: executionProfile(broker.options.executionProfile).liveAllowed } : {}),
		...(upstreamBudgetProfile(broker.options.executionProfile) ? { upstreamBudget, clientOutputCapEnforced: false } : {}),
		...(jointNoToolsProfile(broker.options.executionProfile) ? { toolPolicyEvidence: jointToolPolicyEvidence(results, broker.journal.rows) } : {}),
		mechanicalStatus: broker.journal.stopReason ? "stopped" : "completed", stopReason: broker.journal.stopReason,
		stages: results.map(({ result: _result, ...row }) => row), reservations: reservations.length,
		remoteDispatchAttempts: broker.journal.rows.filter(row => row.event === "upstream-dispatched").length,
		pairs, anchorObserved: pairs.some(p => p.diagnostic?.anchoredInputEstimate != null),
		controlScore, systemRecoveryScore, summaryContentReview: treatment?.compaction ? "pending_review" : "not_run",
		businessOutcome: { u: stageStatus("u") === "not_run" ? "not_run" : stageStatus("u") !== "completed" ? "not_completed" : answer(messages("u")) ? "reply_observed" : "failed",
			c: stageStatus("c-control") === "not_run" && stageStatus("c-treatment") === "not_run" ? "not_run"
				: stageStatus("c-control") !== "completed" || stageStatus("c-treatment") !== "completed" ? "not_completed"
				: controlScore?.passed && systemRecoveryScore?.passed && treatment?.compaction ? "answers_passed_summary_review_pending" : "failed",
			r: stageStatus("r") === "not_run" ? "not_run" : stageStatus("r") !== "completed" ? "not_completed"
				: readEvidence && Object.values(readEvidence).every(Boolean) ? "read_freshness_observed" : "failed" },
		usageCoverage: { reserved: reservations.length, terminal: terminals.length, paired: pairs.filter(p => p.matched).length,
			unknownInputOrOutput: terminals.filter(row => row.data.rawUsage.input === null || row.data.sdkNormalizedOutput == null).length,
			unknownCache: terminals.filter(row => row.data.rawUsage.cacheRead === null).length },
		estimationError: { eligibleSamples: errorSamples.length, underestimated: errorSamples.filter(p => p.errorTokens! < 0).length,
			minimumTokens: errorSamples.length ? Math.min(...errorSamples.map(p => p.errorTokens!)) : null, maximumTokens: errorSamples.length ? Math.max(...errorSamples.map(p => p.errorTokens!)) : null },
		compaction: treatment?.compaction ?? null, compactionStructured: treatment?.snapshots?.[0] ?? null,
		compactionRecentMessages: treatment?.recentAfterCompaction ?? null,
		compactionFinalProjection: reservations.filter(row => row.data.worker === "worker-c-treatment" && row.data.kind === "ordinary").at(-1)?.data.body ?? null,
		independentSeed: control && treatment ? control.seedSha256 === treatment.seedSha256 && control.sessionFile !== treatment.sessionFile : null,
		summaryCausalAttribution: "not_established", readBudgets: budgetTools, readFinalAnswer: read ? answer(read) : null, readEvidence,
		summaryRequestIds: reservations.filter(row => row.data.kind === "summary").map(row => row.data.id), seedPreserved: treatment?.seedPreserved ?? null,
		referenceCostUsd: terminals.length === reservations.length && terminals.length > 0 && terminals.every(row => row.data.referenceCostUsd !== null)
			? terminals.reduce((sum, row) => sum + row.data.referenceCostUsd, 0) : null,
		readCoverage: "budgeted-extension-readFile-only", actualCostUsd: null, providerAvailabilityVerified: broker.mode === "live" ? "see_per_request_evidence" : false,
		toolSchemaHashes: Object.fromEntries(broker.toolSchemas), maxConcurrentUpstream: broker.maxActive };
}

/** One protocol observation, not the joint U/C/R or semantic acceptance. */
export function analyzeToolNone(results: any[], broker: PreparedBroker) {
	const base = analyzeBatch(results, broker), result = results[0]?.result;
	const reservation = broker.journal.rows.find(row => row.event === "reserved")?.data;
	const terminals = broker.journal.rows.filter(row => row.event === "terminal");
	const assistant = (result?.messages ?? []).filter((m: any) => m.role === "assistant");
	const toolCalls = assistant.flatMap((m: any) => m.content.filter((c: any) => c.type === "toolCall"));
	const reply = assistant.at(-1), text = (reply?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
	const rawToolCallDeltas = terminals.reduce((count, row) => count + (row.data.toolCallDeltas ?? 0), 0);
	const toolAttempted = rawToolCallDeltas > 0 || toolCalls.length > 0 || (result?.blockedTools?.length ?? 0) > 0;
	const explicitNoneSent = reservation?.body.tool_choice === "none" && Array.isArray(reservation?.body.tools) && reservation.body.tools.length === 0;
	const responseClassification = toolAttempted ? "tool_call_observed" : base.mechanicalStatus === "stopped" ? "request_stopped"
		: reply?.stopReason === "stop" && text.trim() ? "text_without_tool_call" : "no_complete_text";
	return { ...base, executionProfile: "tool-none", businessOutcome: { toolNone: responseClassification },
		protocolObservation: { explicitNoneSent, httpStatuses: terminals.map(row => row.data.httpStatus ?? null), rawToolCallDeltas, sdkToolCalls: toolCalls.map((c: any) => ({ name: c.name, id: c.id })), replyText: text,
			stopReason: reply?.stopReason ?? null, payloadAdjustments: result?.protocolAdjustments ?? [], successfulToolExecutions: (result?.tools ?? []).filter((t: any) => !t.isError).length },
		ucrAcceptance: "not_run", rootCauseEstablished: false, upstreamIdentityVerified: false };
}
