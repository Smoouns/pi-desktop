import assert from "node:assert/strict";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import type { RequestPolicy } from "../../../evals/core/request-policy.js";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export type Row = { sequence: number; previous: string; event: string; data: any; sha256: string };
export function recover(file: string) {
	const text = readFileSync(file, "utf8");
	assert.ok(text.endsWith("\n"), "E8_JOURNAL_INCOMPLETE");
	const rows: Row[] = []; let previous = "0".repeat(64);
	for (const line of text.trimEnd().split("\n")) {
		const row = JSON.parse(line), { sha256, ...raw } = row;
		assert.equal(row.sequence, rows.length + 1, "E8_JOURNAL_SEQUENCE");
		assert.equal(row.previous, previous, "E8_JOURNAL_CHAIN");
		assert.equal(sha256, digest(JSON.stringify(raw)), "E8_JOURNAL_HASH");
		rows.push(row); previous = sha256;
	}
	assert.ok(["offline-start", "probe-start", "live-start"].includes(rows[0]?.event), "E8_JOURNAL_PROFILE_INVALID");
	const reservations = rows.filter(row => row.event === "reserved"), completed = rows.filter(row => row.event === "terminal");
	const known = new Set(reservations.map(row => row.data.id)), seen = new Set();
	for (const row of completed) { assert.ok(known.has(row.data.id) && !seen.has(row.data.id), "E8_TERMINAL_NOT_UNIQUE"); seen.add(row.data.id); }
	return { rows, reservations: reservations.length, completed: completed.length,
		unsettled: reservations.filter(row => !seen.has(row.data.id)).map(row => ({ id: row.data.id, status: "unknown_outcome", replayAllowed: false })),
		httpReceived: rows.filter(row => row.event === "loopback-received").length,
		remoteDispatchAttempts: rows.filter(row => row.event === "upstream-dispatched").length,
		stops: rows.filter(row => row.event === "stop").map(row => row.data.reason),
		readOnly: true, newHttpRequests: 0, actualCostUsd: null, replayAllowed: false };
}

/** Test-only append-only receipt. wx prevents recovery from becoming replay.
 * Each reservation is fsynced before returning its one-use transport permit.
 * It is not a production billing ledger or an OS-level security boundary.
 */
export class Journal {
	readonly rows: Row[] = [];
	readonly started = Date.now();
	private fd: number;
	private previous = "0".repeat(64);
	private stopped: string | null = null;
	private expected = "";
	private taskStart = new Map<string, number>();
	constructor(readonly file: string, readonly policy: RequestPolicy, profile: "offline" | "probe" | "live" = "offline", authorizationSha256?: string) {
		if (authorizationSha256 !== undefined) { assert.equal(profile, "live"); assert.match(authorizationSha256, /^[a-f0-9]{64}$/); }
		this.fd = openSync(file, "wx", 0o600);
		this.append(profile + "-start", { profile: "full-production-extension/" + profile, liveAuthorized: authorizationSha256 !== undefined, authorizationSha256: authorizationSha256 ?? null, policy });
	}
	append(event: string, data: any) {
		// Fail closed on replacement, truncation or edits while a batch is open.
		// This synthetic journal is bounded by the request/response policy; reading
		// it here is test bookkeeping, not included in novel-source read metrics.
		const disk = lstatSync(this.file), opened = fstatSync(this.fd);
		assert.ok(disk.isFile() && !disk.isSymbolicLink() && disk.nlink === 1 && disk.ino === opened.ino && disk.dev === opened.dev, "E8_JOURNAL_REPLACED");
		assert.equal(readFileSync(this.file, "utf8"), this.expected, "E8_JOURNAL_CHANGED");
		const raw = { sequence: this.rows.length + 1, previous: this.previous, event, data };
		const row = { ...raw, sha256: digest(JSON.stringify(raw)) };
		const bytes = Buffer.from(JSON.stringify(row) + "\n");
		let offset = 0; while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
		fsyncSync(this.fd); this.expected += bytes.toString("utf8"); this.previous = row.sha256; this.rows.push(row); return row;
	}
	stop(reason: string) { if (!this.stopped) { this.stopped = reason; this.append("stop", { reason }); } }
	get stopReason() { return this.stopped; }
	assertRunning() {
		if (Date.now() - this.started > this.policy.limits.batchTimeoutMs) this.stop("batch_timeout");
		if (this.stopped) throw Error("E8_BATCH_STOPPED:" + this.stopped);
	}
	reserve(task: string, bytes: number, output: number, details: any) {
		this.assertRunning();
		const fail = (reason: string): never => { this.stop(reason); throw Error("E8_POLICY:" + reason); };
		const p = this.policy.limits, rows = this.rows.filter(row => row.event === "reserved");
		if (!this.policy.taskIds.includes(task)) fail("unknown_task");
		if (!this.taskStart.has(task)) this.taskStart.set(task, Date.now());
		if (Date.now() - this.taskStart.get(task)! > p.taskTimeoutMs) fail("task_timeout");
		if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > p.maxInputBytes || bytes > p.maxInputTokens) fail("input_limit");
		if (!Number.isSafeInteger(output) || output < 1 || output > p.maxOutputTokens) fail("output_limit");
		if (bytes + output + p.safetyMargin > 262144) fail("window_limit");
		if (rows.length >= p.maxHttpRequests || rows.filter(row => row.data.task === task).length >= p.maxTaskHttpRequests) fail("request_limit");
		if (rows.reduce((sum, row) => sum + row.data.inputReservation, bytes) > p.maxTotalInputTokens
			|| rows.reduce((sum, row) => sum + row.data.outputReservation, output) > p.maxTotalOutputTokens) fail("aggregate_limit");
		const id = "e8-" + (rows.length + 1);
		this.append("reserved", { ...details, id, task, inputReservation: bytes, outputReservation: output, refunded: false }); return id;
	}
	tool(task: string, name: string, id: string) {
		this.assertRunning();
		if (this.rows.filter(row => row.event === "tool" && row.data.task === task).length >= this.policy.limits.maxTaskTools) {
			this.stop("tool_limit"); throw Error("E8_TOOL_LIMIT");
		}
		this.append("tool", { task, name, id });
	}
	terminal(id: string, data: any) {
		assert.ok(this.rows.some(row => row.event === "reserved" && row.data.id === id), "E8_NO_RESERVATION");
		assert.ok(!this.rows.some(row => row.event === "terminal" && row.data.id === id), "E8_DUPLICATE_TERMINAL");
		this.append("terminal", { ...data, id });
		if (data.status !== "complete") this.stop(data.status);
	}
	close() { closeSync(this.fd); }
}

// Raw provider field presence matters: Pi normalizes a missing cache field to
// zero. Never turn that zero into a verified cache amount or a bill.
export function rawUsage(value: any) {
	const valid = (n: any) => Number.isSafeInteger(n) && n >= 0;
	const cache = value?.prompt_tokens_details?.cached_tokens;
	return { present: value !== undefined && value !== null,
		input: valid(value?.prompt_tokens) ? value.prompt_tokens : null,
		output: valid(value?.completion_tokens) ? value.completion_tokens : null,
		cacheFieldPresent: !!value?.prompt_tokens_details && Object.hasOwn(value.prompt_tokens_details, "cached_tokens"),
		cacheRead: valid(cache) ? cache : null, actualCostUsd: null };
}
