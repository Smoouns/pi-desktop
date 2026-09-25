import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { RequestPolicy } from "../../../evals/core/request-policy.js";
import { Journal, digest, rawUsage } from "./journal.js";
import { syntheticReply } from "./broker.js";
import { allowedTools, SOURCE, source } from "./fixtures.js";
import { ownedPath } from "./prepared-manifest.js";
import { outputAccounting } from "./output-accounting.js";
import { enumeratedStateProfile, executionProfile, jointExplicitNone, jointNoToolsProfile, outputReservationFor, upstreamBudgetProfile, type ExecutionProfile } from "./protocol-profile.js";

type Worker = { id: string; work: string; task: string; scenario: string; sessionFile?: string; child?: ChildProcess; phases: Record<string, number> };
type Ticket = { id: string; worker: Worker; phase: string; kind: string; body: string; output: number; controller: AbortController; timer: NodeJS.Timeout;
	opened: boolean; acquired: boolean; pulling: boolean; finished: boolean; successful: boolean; reader?: ReadableStreamDefaultReader<Uint8Array>; release?: () => void; responseBytes: number; httpStatus?: number; buffer: string; decoder: TextDecoder; usage?: any; usageCount: number; done: boolean; toolCallDeltas: number };
export class PreparedBroker {
	readonly journal: Journal;
	readonly workers = new Map<string, Worker>();
	readonly tickets = new Map<string, Ticket>();
	readonly toolSchemas = new Map<string, string>();
	private queue: Promise<void> = Promise.resolve();
	private active = 0;
	maxActive = 0;
	constructor(readonly output: string, readonly policy: RequestPolicy, readonly model: any, readonly mode: "probe" | "live", readonly options: {
		assertFresh: () => void; fetch?: (body: string, signal: AbortSignal) => Promise<Response>; toolSchemaHashes?: Record<string, string>; authorizationSha256?: string; executionProfile?: ExecutionProfile;
	}) {
		assert.ok(mode !== "live" || executionProfile(options.executionProfile).liveAllowed, "E8_OFFLINE_ONLY_PROFILE");
		this.journal = new Journal(path.join(output, "broker.jsonl"), policy, mode, options.authorizationSha256);
	}
	register(id: string, work: string, task: string, scenario: string) {
		if (jointNoToolsProfile(this.options.executionProfile) || this.options.executionProfile === "read-upstream") assert.ok(executionProfile(this.options.executionProfile).stages.some(stage => stage.id === scenario && stage.task === task), "E8_JOINT_STAGE_INVALID");
		assert.ok(!this.workers.has(id)); this.workers.set(id, { id, work, task, scenario, phases: {} });
	}
	attach(id: string, child: ChildProcess) {
		const worker = this.workers.get(id)!; worker.child = child;
		child.on("message", (m: any) => {
			if (m?.kind === "visible") return; // Do not bloat the durable journal per text delta.
			if (m?.kind === "tool-unavailable") { this.stop("tool_permission"); return; }
			if (!Number.isSafeInteger(m?.rpcId)) return;
			void this.handle(worker, m.kind, m.data).then(value => { if (child.connected) child.send({ replyTo: m.rpcId, value }); }, () => {
				this.stop("broker_rejected"); if (child.connected) child.send({ replyTo: m.rpcId, error: "E8_BROKER_STOPPED" });
			});
		});
	}
	stop(reason: string) {
		try { this.journal.stop(reason); } finally {
			for (const ticket of this.tickets.values()) if (!ticket.finished) { ticket.controller.abort(); ticket.release?.(); void ticket.reader?.cancel().catch(() => undefined); }
			for (const worker of this.workers.values()) if (worker.child?.connected) worker.child.send({ control: "abort" });
		}
	}
	private assertActive() { this.journal.assertRunning(); this.options.assertFresh(); }
	private async handle(worker: Worker, kind: string, data: any): Promise<any> {
		if (kind === "result") return true;
		if (kind === "ready") {
			const relative = path.relative(worker.work, data.sessionFile); ownedPath(worker.work, relative);
			assert.equal(path.dirname(data.sessionFile), path.join(worker.work, "agent/sessions")); worker.sessionFile = data.sessionFile; return true;
		}
		if (kind === "tool-denied") { this.stop("tool_permission"); return true; }
		if (kind === "cancel") { const ticket = this.ticket(worker, data.id); if (!ticket.finished) this.finish(ticket, "unknown_outcome"); return true; }
		if (kind === "pull") return this.pull(this.ticket(worker, data.id));
		if (kind === "open") return this.open(this.ticket(worker, data.id));
		this.assertActive();
		if (kind === "can-continue") return true;
		if (kind === "tool") { assert.equal(worker.scenario, "r"); assert.ok(allowedTools.includes(data.name)); this.journal.tool(worker.task, data.name, data.id); return true; }
		if (kind === "transition") {
			assert.equal(worker.scenario, "r"); assert.deepEqual(data, { path: SOURCE, before: digest(source("v1")), after: digest(source("v2")) });
			assert.equal(digest(readFileSync(path.join(worker.work, "project", SOURCE))), data.after); this.journal.append("host-transition", data); return true;
		}
		assert.equal(kind, "reserve");
		assert.equal(data.attempt, 1, "E8_REDISPATCH_NOT_AUTHORIZED");
		const payload = JSON.parse(data.body), expected = worker.scenario === "r" ? [...allowedTools].sort() : [];
		if (this.options.executionProfile === "tool-none") {
			assert.equal(worker.scenario, "tool-none"); assert.equal(worker.task, "E8-TOOL-NONE");
			assert.equal(data.phase, "tool-none"); assert.equal(data.kind, "ordinary");
			assert.deepEqual(payload.tools, [], "E8_DIAGNOSTIC_TOOLS_CHANGED"); assert.equal(payload.tool_choice, "none", "E8_EXPLICIT_NONE_REQUIRED");
		} else if (jointExplicitNone(this.options.executionProfile, worker.scenario)) {
			assert.equal(payload.tool_choice, "none", "E8_EXPLICIT_NONE_REQUIRED");
			// Preserve native serialization: ordinary tools=[], summaries omit tools.
			if (data.kind === "summary") assert.equal(payload.tools, undefined, "E8_SUMMARY_TOOLS_CHANGED");
			else assert.deepEqual(payload.tools, [], "E8_NO_TOOLS_SCHEMA_CHANGED");
		} else assert.equal(payload.tool_choice, undefined, "E8_UNPLANNED_TOOL_CHOICE");
		assert.equal(payload.model, this.model.id); assert.equal(payload.stream, true); assert.ok(Array.isArray(payload.messages));
		assert.deepEqual((payload.tools ?? []).map((t: any) => t.function.name).sort(), expected);
		assert.equal(payload.stream_options?.include_usage, true);
		const schemaKey = worker.scenario === "r" ? "read" : "none", schemaHash = digest(JSON.stringify(payload.tools ?? []));
		if (this.toolSchemas.has(schemaKey)) assert.equal(schemaHash, this.toolSchemas.get(schemaKey), "E8_TOOL_SCHEMA_CHANGED");
		if (this.options.toolSchemaHashes) assert.equal(schemaHash, this.options.toolSchemaHashes[schemaKey], "E8_TOOL_SCHEMA_DRIFT");
		this.toolSchemas.set(schemaKey, schemaHash);
		assert.ok(data.kind === "ordinary" || data.kind === "summary" && worker.scenario === "c-treatment");
		assert.equal(data.kind === "summary", data.phase === "summary");
		if (data.kind === "summary") assert.ok([...this.tickets.values()].filter(t => t.kind === "summary").length < 2, "E8_SUMMARY_LIMIT");
		const file = ownedPath(worker.work, path.relative(worker.work, data.productionJournal));
		assert.equal(path.dirname(file), path.join(path.dirname(worker.sessionFile!), ".pi-desktop-transport"));
		const disk = JSON.parse(readFileSync(file, "utf8")), { sha256, ...record } = disk.record;
		assert.equal(sha256, digest(JSON.stringify(record))); assert.equal(disk.key, digest(JSON.stringify([path.basename(worker.sessionFile!), record.owner])));
		assert.ok(record.pending.some((p: any) => p.id === data.productionCallId && p.kind === data.kind && p.supported && p.attempts.includes(1)));
		const field = this.model.compat.maxTokensField;
		assert.ok(payload[field] && payload[field === "max_tokens" ? "max_completion_tokens" : "max_tokens"] === undefined);
		const output = outputReservationFor(this.options.executionProfile, payload[field]);
		const id = this.journal.reserve(worker.task, Buffer.byteLength(data.body), output, { worker: worker.id, phase: data.phase, kind: data.kind, bodySha256: digest(data.body), body: payload,
			...(upstreamBudgetProfile(this.options.executionProfile) ? { clientOutputLimit: payload[field], outputBudgetSource: "user-accepted-gateway-policy", clientOutputCapEnforced: false } : {}),
			productionCallId: data.productionCallId, productionAttempt: data.attempt, outputField: field, productionJournalSha256: digest(JSON.stringify(disk)) });
		const controller = new AbortController();
		const timer = setTimeout(() => { const t = this.tickets.get(id); if (t && !t.finished) this.finish(t, "request_timeout"); }, this.policy.limits.requestTimeoutMs);
		this.tickets.set(id, { id, worker, phase: data.phase, kind: data.kind, body: data.body, output, controller, timer,
			opened: false, acquired: false, pulling: false, finished: false, successful: false, responseBytes: 0, buffer: "", decoder: new TextDecoder(), usageCount: 0, done: false, toolCallDeltas: 0 });
		return { id };
	}
	private ticket(worker: Worker, id: string) { const t = this.tickets.get(id); assert.ok(t && t.worker === worker, "E8_FOREIGN_TICKET"); return t; }
	private async open(t: Ticket) {
		assert.ok(!t.opened && !t.finished); t.opened = true;
		const previous = this.queue; this.queue = new Promise(resolve => { t.release = resolve; });
		await Promise.race([previous, new Promise<void>((_, reject) => { t.controller.signal.addEventListener("abort", () => reject(Error("E8_CANCELLED")), { once: true }); })]);
		this.assertActive(); assert.ok(!t.finished && !t.controller.signal.aborted);
		t.acquired = true; this.active++; this.maxActive = Math.max(this.maxActive, this.active);
		let response: Response;
		if (this.mode === "probe") {
			const n = t.worker.phases[t.phase] = (t.worker.phases[t.phase] ?? 0) + 1;
			// Legacy C-control adds a bookkeeping field to its scripted answer.
			// V2 explicitly forbids extra answer fields; use the same oracle-only
			// synthetic text as treatment, without touching legacy fixtures.
			const responseScenario = enumeratedStateProfile(this.options.executionProfile) && t.worker.scenario === "c-control" ? "c-treatment" : t.worker.scenario;
			const delta = syntheticReply(responseScenario, t.phase, n);
			const usage = { prompt_tokens: 128, completion_tokens: 32, total_tokens: 160, prompt_tokens_details: { cached_tokens: 16 } };
			const frame = (choices: any[], usage?: any) => `data: ${JSON.stringify({ id: "e8-probe", object: "chat.completion.chunk", created: 1, model: this.model.id, choices, ...(usage ? { usage } : {}) })}\n\n`;
			const parts = [frame([{ index: 0, delta, finish_reason: null }]), frame([{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }]) + frame([], usage) + "data: [DONE]\n\n"];
			this.journal.append("synthetic-response", { id: t.id, networkRequests: 0 });
			response = new Response(new ReadableStream({ pull(c) { const p = parts.shift(); if (p === undefined) c.close(); else c.enqueue(new TextEncoder().encode(p)); } }), { headers: { "content-type": "text/event-stream" } });
		} else {
			assert.ok(this.options.fetch); this.journal.append("upstream-dispatched", { id: t.id });
			try { response = await this.options.fetch(t.body, t.controller.signal); }
			catch { this.finish(t, "unknown_outcome"); throw Error("E8_UPSTREAM_FAILED"); }
		}
		// A cancelled/expired request must not revive when an upstream ignores abort.
		if (t.finished || t.controller.signal.aborted || this.journal.stopReason) {
			void response.body?.cancel().catch(() => undefined); this.finish(t, "unknown_outcome"); throw Error("E8_LATE_RESPONSE");
		}
		t.httpStatus = response.status;
		if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
			void response.body?.cancel().catch(() => undefined); this.finish(t, "http_or_content_type_error"); throw Error("E8_RESPONSE_REJECTED");
		}
		t.reader = response.body.getReader(); return { status: 200 };
	}
	private frames(t: Ticket, chunk: Uint8Array) {
		t.buffer = (t.buffer + t.decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
		let index;
		while ((index = t.buffer.indexOf("\n\n")) >= 0) {
			const frame = t.buffer.slice(0, index); t.buffer = t.buffer.slice(index + 2);
			const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
			if (!data) continue;
			if (data === "[DONE]") { t.done = true; continue; }
			const value = JSON.parse(data);
			for (const choice of value.choices ?? []) {
				const delta = choice.delta;
				if (delta && (delta.function_call != null || delta.tool_calls != null && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 0))) t.toolCallDeltas++;
			}
			if (value.usage != null) { t.usageCount++; t.usage = value.usage; }
			assert.ok(!value.error, "E8_STREAM_ERROR");
		}
	}
	private async pull(t: Ticket) {
		if (t.finished) { assert.ok(t.successful); return { done: true }; }
		this.assertActive(); assert.ok(!t.controller.signal.aborted);
		assert.ok(t.reader && !t.pulling); t.pulling = true;
		try {
			const { done, value } = await t.reader.read();
			assert.ok(!t.finished && !t.controller.signal.aborted && !this.journal.stopReason, "E8_LATE_CHUNK");
			if (done) { this.finish(t, "unknown_outcome"); throw Error("E8_STREAM_WITHOUT_DONE"); }
			t.responseBytes += value.byteLength; assert.ok(t.responseBytes <= this.policy.limits.maxResponseBytes, "E8_RESPONSE_LIMIT");
			this.frames(t, value);
			if (t.done) {
				void t.reader.cancel().catch(() => undefined); const raw = rawUsage(t.usage), output = outputAccounting(t.usage);
				const status = t.usageCount !== 1 || raw.input === null || output.sdkNormalizedOutput === null ? "usage_unknown"
					: raw.input > Buffer.byteLength(t.body) || output.sdkNormalizedOutput > t.output ? "usage_exceeded_reservation" : "complete";
				this.finish(t, status);
				assert.equal(status, "complete", "E8_USAGE_REJECTED");
				// A no-tools protocol diagnosis must also notice legacy/raw tool
				// deltas that the pinned SDK might ignore. Preserve the receipt but
				// stop before another dispatch; never grant a tool to satisfy it.
				if ((this.options.executionProfile === "tool-none" || jointExplicitNone(this.options.executionProfile, t.worker.scenario)) && t.toolCallDeltas > 0) this.stop("tool_permission");
			}
			return { done: false, base64: Buffer.from(value).toString("base64") };
		} catch { if (!t.finished) this.finish(t, "unknown_outcome"); throw Error("E8_STREAM_INTERRUPTED"); }
		finally { t.pulling = false; }
	}
	private finish(t: Ticket, status: string) {
		if (t.finished) return; t.finished = true; t.successful = status === "complete"; clearTimeout(t.timer); t.controller.abort(); t.release?.();
		void t.reader?.cancel().catch(() => undefined); if (t.acquired) this.active--;
		this.journal.terminal(t.id, { status, httpStatus: t.httpStatus ?? null, responseBytes: t.responseBytes, rawUsage: rawUsage(t.usage), ...outputAccounting(t.usage), toolCallDeltas: t.toolCallDeltas, actualCostUsd: null });
		if (status !== "complete") this.stop(status);
	}
	close() { for (const t of this.tickets.values()) if (!t.finished) this.finish(t, "unknown_outcome"); this.journal.close(); }
}
