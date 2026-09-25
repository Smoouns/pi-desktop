import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { RequestPolicy } from "../../../evals/core/request-policy.js";
import { listenForFetch, closeLoopbackServer } from "../../support/loopback-http.js";
import { Journal, digest, rawUsage } from "./journal.js";
import { SOURCE, SUMMARY, BAD_SUMMARY, CONTROL_ONLY, oracle } from "./fixtures.js";

type Worker = { id: string; work: string; task: string; scenario: string; child?: ChildProcess; sessionFile?: string; phases: Record<string, number> };
type Permit = { id: string; worker: Worker; phase: string; kind: string; productionCallId: number; body: string; received: boolean; settled: boolean; timer?: NodeJS.Timeout };
const textDelta = (text: string) => ({ role: "assistant", content: text });
const calls = (...items: Array<[string, any, string]>) => ({ role: "assistant", tool_calls: items.map(([name, args, id], index) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
function reply(scenario: string, phase: string, n: number) {
	if (phase === "summary") return textDelta(scenario === "c-lossy" ? BAD_SUMMARY : SUMMARY);
	if (scenario.startsWith("c-")) return textDelta(JSON.stringify({ ...oracle, ...(scenario === "c-control" ? { _controlOnly: CONTROL_ONLY } : {}) }));
	if (scenario === "forbidden-tool") return calls(["write", { path: "canon/protected.md", content: "ILLEGAL" }, "denied-write"]);
	if (scenario === "forbidden-path") return calls(["read", { path: "canon/protected.md" }, "denied-path"]);
	if (scenario !== "r") return textDelta("只读边界已确认。Synthetic E8 reply.");
	if ((phase === "r1" || phase === "r3") && n === 1) return calls(["read", { path: SOURCE, offset: 2, limit: 2 }, phase + "-read"]);
	if (phase === "r1" && n === 2 || phase === "r2" && n === 1) return calls(["get_context_budget", {}, phase + "-budget"]);
	if (phase === "r3" && n === 2) return calls(["refresh_task_checkpoint", {}, "r3-refresh"], ["get_context_budget", {}, "r3-budget"]);
	return textDelta(phase === "r3" ? "当前版本 v2，标记 COBAL。" : "当前版本 v1，标记 AMBER。");
}
export { reply as syntheticReply };
const frame = (choices: any[], usage?: any) => `data: ${JSON.stringify({ id: "e8-public-fixture", object: "chat.completion.chunk", created: 1, model: "e8-synthetic", choices, ...(usage === undefined ? {} : { usage }) })}\n\n`;

/** Local synthetic broker ONLY. There is deliberately no upstream URL,
 * credential loader, remote fetch, authorization bypass or live mode here.
 */
export class OfflineBroker {
	readonly journal: Journal;
	readonly workers = new Map<string, Worker>();
	readonly permits = new Map<string, Permit>();
	readonly errors: string[] = [];
	readonly trace: any[] = [];
	origin = "";
	private queue: Promise<void> = Promise.resolve();
	private activeResponses = 0;
	maxConcurrentResponses = 0;
	private server: http.Server;
	constructor(readonly output: string, readonly policy: RequestPolicy) {
		this.journal = new Journal(path.join(output, "broker.jsonl"), policy);
		this.server = http.createServer((request, response) => {
			const chunks: Buffer[] = []; let size = 0;
			request.on("data", chunk => { size += chunk.length; if (size > policy.limits.maxInputBytes) { this.journal.stop("input_limit"); request.destroy(); } else chunks.push(chunk); });
			request.on("end", () => {
				try {
					const permit = this.permits.get(String(request.headers["x-e8-permit"]));
					assert.ok(permit && !permit.received, "E8_PERMIT_NOT_ONE_USE");
					assert.equal(request.method, "POST"); assert.equal(request.url, `/${permit.worker.id}/v1/chat/completions`);
					assert.equal(Buffer.concat(chunks).toString("utf8"), permit.body, "E8_BODY_CHANGED_AFTER_RESERVATION");
					permit.received = true;
					this.journal.append("loopback-received", { id: permit.id, bytes: size, phase: permit.phase });
					// Parallel native summaries get distinct permits, but synthetic
					// response dispatch is serialized. SDK streams remain untouched.
					this.queue = this.queue.then(() => this.serve(permit, response)).catch(error => { this.errors.push(String(error)); this.journal.stop("broker_error"); response.destroy(); });
				} catch (error) { this.errors.push(String(error)); this.journal.stop("broker_validation"); response.writeHead(409); response.end(); }
			});
		});
	}
	async start() { const selected = await listenForFetch(this.server); this.origin = selected.origin; return selected; }
	register(id: string, work: string, task: string, scenario: string) {
		assert.ok(!this.workers.has(id)); const worker = { id, work, task, scenario, phases: {} }; this.workers.set(id, worker); return worker;
	}
	attach(id: string, child: ChildProcess) {
		const worker = this.workers.get(id)!; worker.child = child;
		child.on("message", (m: any) => {
			if (m?.kind === "tool-unavailable") {
				this.journal.append("tool-denied", { worker: id, name: m.name, id: m.id, reason: "inactive-tool" }); this.journal.stop("tool_permission"); return;
			}
			if (m?.kind === "visible") {
				this.journal.append("sdk-visible-delta", { worker: id, phase: m.phase });
				if (worker.scenario === "crash") child.kill();
				if (worker.scenario === "cancel") child.send({ control: "abort" });
				return;
			}
			if (!m?.rpcId) return;
			try { const value = this.handle(worker, m.kind, m.data); child.send({ replyTo: m.rpcId, value }); }
			catch (error) { this.journal.stop("broker_validation"); child.send({ replyTo: m.rpcId, error: error instanceof Error ? error.message : "E8_BROKER_FAILURE" }); }
		});
	}
	private handle(worker: Worker, kind: string, data: any): any {
		if (kind === "ready") { worker.sessionFile = data.sessionFile; return true; }
		if (kind === "result") return true;
		if (kind === "transition") { assert.equal(worker.scenario, "r"); assert.equal(data.path, SOURCE); this.journal.append("host-transition", data); return true; }
		if (kind === "tool-denied") { this.journal.append("tool-denied", data); this.journal.stop("tool_permission"); return true; }
		if (kind === "tool") { this.journal.tool(worker.task, data.name, data.id); return true; }
		assert.equal(kind, "reserve");
		this.trace.push({ worker: worker.id, phase: data.phase, layer: "worker-fetch", kind: data.kind });
		this.journal.assertRunning();
		const payload = JSON.parse(data.body);
		assert.equal(payload.model, "e8-synthetic"); assert.equal(payload.stream, true);
		assert.ok(Array.isArray(payload.messages));
		const expectedTools = worker.scenario === "r" || worker.scenario === "forbidden-path" ? ["read", "read_story_document", "read_observation", "get_context_budget", "get_task_checkpoint", "refresh_task_checkpoint"] : [];
		assert.deepEqual((payload.tools ?? []).map((t: any) => t.function.name).sort(), expectedTools.sort());
		assert.ok(data.kind === "ordinary" || data.kind === "summary" && worker.scenario.startsWith("c-"), "E8_KIND_NOT_ALLOWED");
		assert.equal(data.kind === "summary", data.phase === "summary");
		if (data.kind === "summary" && [...this.permits.values()].filter(p => p.worker.task === worker.task && p.kind === "summary").length >= 2) { this.journal.stop("summary_limit"); throw Error("E8_SUMMARY_LIMIT"); }
		const sessionDir = path.dirname(worker.sessionFile!);
		assert.equal(path.dirname(data.productionJournal), path.join(sessionDir, ".pi-desktop-transport"));
		assert.match(path.basename(data.productionJournal), /^[a-f0-9]{64}\.json$/);
		const disk = JSON.parse(readFileSync(data.productionJournal, "utf8"));
		const { sha256, ...record } = disk.record; assert.equal(sha256, digest(JSON.stringify(record)));
		assert.equal(disk.key, digest(JSON.stringify([path.basename(worker.sessionFile!), record.owner])));
		assert.ok(record.pending.some((p: any) => p.id === data.productionCallId && p.kind === data.kind && p.supported && p.attempts.includes(data.attempt)), "E8_PRODUCTION_PENDING_NOT_DURABLE");
		const outputField = payload.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
		const id = this.journal.reserve(worker.task, Buffer.byteLength(data.body), payload[outputField], {
			worker: worker.id, phase: data.phase, kind: data.kind, bodySha256: digest(data.body), body: payload, outputField,
			productionCallId: data.productionCallId, productionAttempt: data.attempt, productionJournalSha256: digest(JSON.stringify(disk)),
		});
		const permit: Permit = { id, worker, phase: data.phase, kind: data.kind, productionCallId: data.productionCallId, body: data.body, received: false, settled: false };
		this.permits.set(id, permit);
		return { id };
	}
	private async serve(permit: Permit, response: http.ServerResponse) {
		if (response.destroyed) return;
		this.activeResponses++; this.maxConcurrentResponses = Math.max(this.maxConcurrentResponses, this.activeResponses);
		this.journal.append("synthetic-dispatched", { id: permit.id });
		const { worker, phase } = permit;
		const n = worker.phases[phase] = (worker.phases[phase] ?? 0) + 1;
		let bytes = 0;
		await new Promise<void>((resolve) => {
			const finish = (status: string, raw?: any) => {
				if (permit.settled) return;
				permit.settled = true; clearTimeout(permit.timer);
				this.activeResponses--;
				this.journal.terminal(permit.id, { status, responseBytes: bytes, rawUsage: rawUsage(raw), rawProviderUsage: raw ?? null }); resolve();
			};
			response.on("close", () => { if (!permit.settled) finish("unknown_outcome"); });
			const write = (text: string) => {
				const next = bytes + Buffer.byteLength(text);
				if (next > this.policy.limits.maxResponseBytes) { finish("response_limit"); response.destroy(); return false; }
				bytes = next;
				return response.write(text);
			};
			// Fault deadlines are deliberately shorter than the registered live
			// proposal and only apply to synthetic local responses.
			permit.timer = setTimeout(() => { finish("request_timeout"); response.destroy(); }, worker.scenario === "timeout" ? 300 : this.policy.limits.requestTimeoutMs);
			if (["http401", "http429", "http500", "redirect"].includes(worker.scenario)) {
				const status = worker.scenario === "redirect" ? 302 : Number(worker.scenario.slice(4));
				finish("http_" + status); response.writeHead(status, { "content-type": "application/json", ...(status === 302 ? { location: "https://example.invalid/never-follow" } : {}) });
				response.end('{"error":{"message":"Public synthetic failure"}}'); return;
			}
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const delta = reply(worker.scenario, phase, n);
			write(frame([{ index: 0, delta, finish_reason: null }]));
			if (["timeout", "cancel", "crash"].includes(worker.scenario)) return;
			if (worker.scenario === "response-limit") { write("X".repeat(this.policy.limits.maxResponseBytes + 1)); return; }
			let usage: any = { prompt_tokens: 128 + this.permits.size, completion_tokens: 32, total_tokens: 160 + this.permits.size,
				prompt_tokens_details: { cached_tokens: 16 } };
			if (worker.scenario === "missing-cache") delete usage.prompt_tokens_details;
			if (worker.scenario === "missing-usage") usage = undefined;
			if (worker.scenario === "over-output") usage.completion_tokens = 4096;
			if (worker.scenario === "missing-output") delete usage.completion_tokens;
			if (worker.scenario === "missing-input") delete usage.prompt_tokens;
			// One event-loop boundary makes incremental display observable without
			// sleeps or a buffered replacement for the SDK assistant stream.
			setImmediate(() => {
				if (permit.settled || response.destroyed) return;
				write(frame([{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }]));
				if (usage) write(frame([], usage));
				write("data: [DONE]\n\n");
				const raw = rawUsage(usage), output = this.journal.rows.find(row => row.event === "reserved" && row.data.id === permit.id)!.data.outputReservation;
				const status = raw.input === null || raw.output === null ? "usage_unknown" : raw.input > Buffer.byteLength(permit.body) || raw.output > output ? "usage_exceeded_reservation" : "complete";
				finish(status, usage); response.end();
			});
		});
	}
	async close() {
		this.server.closeAllConnections(); await this.queue;
		for (const permit of this.permits.values()) if (!permit.settled) { clearTimeout(permit.timer); this.journal.stop("unknown_outcome"); }
		await closeLoopbackServer(this.server); this.journal.close();
	}
}
