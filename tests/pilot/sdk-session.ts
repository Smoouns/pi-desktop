import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@mariozechner/pi-ai";
import { runPilotSdkSession } from "../../evals/pilot/sdk-session.js";
import { PILOT_LIMITS, PILOT_PROBE_CONTENT, PILOT_SYSTEM } from "../../evals/pilot/policy.js";
import { createHash } from "node:crypto";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: "gemini-3.8-flash-high", name: "Pilot", provider: "gemini-proxy", api: "openai-completions", baseUrl: "https://invalid.example/v1", reasoning: false,
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: PILOT_LIMITS.maxOutputTokens } as Model<any>;
const message = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() });
const stream = (m: AssistantMessage) => { const s = createAssistantMessageEventStream(); queueMicrotask(() => { s.push({ type: "start", partial: m }); s.push({ type: "done", reason: m.stopReason === "toolUse" ? "toolUse" : "stop", message: m } as any); }); return s; };

async function fixture(): Promise<{ projectRoot: string; agentDir: string }> {
	const parent = process.env.PI_PILOT_WORK_ROOT ?? path.join(process.cwd(), "artifacts", "harness");
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(path.join(parent, "pi-pilot-sdk-")); const projectRoot = path.join(root, "project");
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(root, "agent");
	await mkdir(path.join(projectRoot, ".novel"), { recursive: true }); await mkdir(path.join(projectRoot, "canon"), { recursive: true }); await mkdir(path.join(projectRoot, "drafts", "candidates"), { recursive: true });
	await writeFile(path.join(projectRoot, ".novel", "project.json"), JSON.stringify({ formatVersion: 1, name: "pilot", localFirst: true, layout: { manuscript: "manuscript", canon: "canon", planning: "planning", drafts: "drafts", craft: "craft", notes: "notes", memory: "memory" } }));
	await writeFile(path.join(projectRoot, "canon", "world.md"), "风暴不可预测。签字：记录员、设备技师。\n"); return { projectRoot, agentDir };
}

export async function runSdkSessionTests(): Promise<number> {
	let count = 0;
	for (const taskId of ["P5P-READ-001", "P5P-WRITE-001"] as const) {
		const { projectRoot, agentDir } = await fixture(); let turn = 0; let active = true; let prepared: string[] = []; let systemSha256 = "";
		const result = await runPilotSdkSession({ projectRoot, agentDir, model: { ...model }, credential: "synthetic-test-only", taskId,
			assertActive: () => assert.equal(active, true), onPrepared: (value) => { prepared = value.toolNames; systemSha256 = value.systemSha256; },
			invokeProvider: (_id, _create) => {
				turn += 1;
				if (taskId === "P5P-READ-001") {
					if (turn === 1) return stream(message([{ type: "toolCall", id: "r1", name: "read_story_document", arguments: { path: "canon/world.md" } }], "toolUse"));
					if (turn === 2) return stream(message([{ type: "toolCall", id: "r2", name: "get_context_budget", arguments: {} }], "toolUse"));
					return stream(message([{ type: "text", text: '{"canPredictStorm":false,"signers":["记录员","设备技师"]}' }], "stop"));
				}
				if (turn === 1) return stream(message([{ type: "toolCall", id: "w1", name: "write", arguments: { path: "drafts/candidates/pilot-probe.md", content: PILOT_PROBE_CONTENT } }], "toolUse"));
				if (turn === 2) return stream(message([{ type: "toolCall", id: "w2", name: "read", arguments: { path: "drafts/candidates/pilot-probe.md" } }], "toolUse"));
				return stream(message([{ type: "text", text: "ready" }], "stop"));
			},
		});
		assert.equal(result.status, "pass", JSON.stringify(result)); count += 1;
		assert.deepEqual(prepared, taskId === "P5P-READ-001" ? ["get_context_budget", "read_story_document"] : ["read", "write"]); count += 1;
		assert.match(systemSha256, /^[a-f0-9]{64}$/); assert.notEqual(systemSha256, createHash("sha256").update(PILOT_SYSTEM).digest("hex")); count += 1;
		assert.equal(result.toolNames.length, 2); count += 1;
		assert.equal(result.usage.totalTokens, 6); count += 1;
		assert.deepEqual(result.answerDiagnostic, { schemaVersion: 1, taskId, codes: ["ANSWER_OK"] }); count += 1;
		if (taskId === "P5P-WRITE-001") { assert.equal(await readFile(path.join(projectRoot, "drafts/candidates/pilot-probe.md"), "utf8"), PILOT_PROBE_CONTENT); count += 1; }
		active = false;
	}
	for (const [text, codes] of [
		['```json\n{"canPredictStorm":false,"signers":["记录员","设备技师"]}\n```', ["ANSWER_MARKDOWN_FENCE"]],
		['{"canPredictStorm":false,"signers":["设备技师","记录员"]}', ["ANSWER_SIGNERS_ORDER"]],
		['{"canPredictStorm":true,"signers":["记录员","设备技师"]}', ["ANSWER_STORM_VALUE"]],
		['{"private-answer-canary":', ["ANSWER_JSON_INVALID"]],
	] as const) {
		const { projectRoot, agentDir } = await fixture(); let turn = 0;
		const result = await runPilotSdkSession({ projectRoot, agentDir, model: { ...model }, credential: "synthetic-test-only", taskId: "P5P-READ-001",
			assertActive: () => undefined, invokeProvider: () => {
				turn++;
				if (turn === 1) return stream(message([{ type: "toolCall", id: "d1", name: "read_story_document", arguments: { path: "canon/world.md" } }], "toolUse"));
				if (turn === 2) return stream(message([{ type: "toolCall", id: "d2", name: "get_context_budget", arguments: {} }], "toolUse"));
				return stream(message([{ type: "text", text }], "stop"));
			} });
		assert.equal(result.status, "fail"); assert.equal(result.checks.finalAnswer, false); assert.equal(result.checks.normalStop, true);
		assert.equal(result.checks.toolResults, true); assert.equal(turn, 3); assert.deepEqual(result.answerDiagnostic.codes, codes);
		assert.doesNotMatch(JSON.stringify(result), /private-answer-canary/); count++;
	}
	const failures: Array<{ name: string; calls: AssistantMessage["content"][]; reason: string; invocations: number; file: boolean }> = [
		{ name: "unauthorized-tool", calls: [[{ type: "toolCall", id: "x1", name: "bash", arguments: { command: "echo denied" } }]], reason: "TOOL_NOT_ALLOWED", invocations: 1, file: false },
		{ name: "unauthorized-path", calls: [[{ type: "toolCall", id: "x2", name: "write", arguments: { path: "drafts/candidates/other.md", content: PILOT_PROBE_CONTENT } }]], reason: "TOOL_ARGUMENT_DENIED", invocations: 1, file: false },
		{ name: "duplicate-write", calls: [
			[{ type: "toolCall", id: "x3", name: "write", arguments: { path: "drafts/candidates/pilot-probe.md", content: PILOT_PROBE_CONTENT } }],
			[{ type: "toolCall", id: "x4", name: "write", arguments: { path: "drafts/candidates/pilot-probe.md", content: PILOT_PROBE_CONTENT } }],
		], reason: "TOOL_LIMIT_EXCEEDED", invocations: 2, file: true },
		{ name: "tool-error", calls: [[{ type: "toolCall", id: "x5", name: "read", arguments: { path: "drafts/candidates/pilot-probe.md" } }]], reason: "TOOL_EXECUTION_FAILED", invocations: 1, file: false },
	];
	for (const failure of failures) {
		const { projectRoot, agentDir } = await fixture(); let invocations = 0;
		const result = await runPilotSdkSession({ projectRoot, agentDir, model: { ...model }, credential: "synthetic-test-only", taskId: "P5P-WRITE-001",
			assertActive: () => undefined, invokeProvider: () => { const content = failure.calls[invocations] ?? [{ type: "text", text: "must-not-run" }]; invocations += 1; return stream(message(content, content[0]?.type === "toolCall" ? "toolUse" : "stop")); },
		});
		assert.equal(result.status, "fail", `${failure.name}:${JSON.stringify(result)}`); assert.equal(result.reasonCode, failure.reason, `${failure.name}:${JSON.stringify(result)}`); count += 2;
		assert.equal(invocations, failure.invocations, `${failure.name}: provider continued after sticky stop`); count += 1;
		let exists = true; try { await readFile(path.join(projectRoot, "drafts/candidates/pilot-probe.md")); } catch { exists = false; }
		assert.equal(exists, failure.file, `${failure.name}: unexpected write state`); count += 1;
	}
	return count;
}
