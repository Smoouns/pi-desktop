import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { freezeRequestPolicy } from "../../../evals/core/request-policy.js";
import { digest, recover } from "./journal.js";
import { PreparedBroker } from "./prepared-broker.js";

/** Additional IPC-outlet fault injection, not real model/network evidence.
 * The full SDK positive probe lives in prepared-tests; these unit cases use an
 * explicitly synthetic production-sidecar shape to target admission races. */
export async function transportTests(output: string, model: any, policyInput: any, test: (id: string, fn: () => Promise<any>) => Promise<void>) {
	const make = async (name: string, fetch: (body: string, signal: AbortSignal) => Promise<Response>, limits = {}) => {
		const dir = path.join(output, name), work = path.join(dir, "worker"), sessionFile = path.join(work, "agent/sessions/public.jsonl");
		await mkdir(path.join(work, "agent/sessions/.pi-desktop-transport"), { recursive: true });
		const policy = freezeRequestPolicy({ ...policyInput, limits: { ...policyInput.limits, ...limits } });
		const broker = new PreparedBroker(dir, policy, model, "live", { assertFresh: () => undefined, fetch });
		assert.equal(broker.journal.rows[0].data.liveAuthorized, false);
		broker.register("unit", work, "E8-U", "u"); const worker = broker.workers.get("unit")!;
		const handle = (kind: string, data: any) => (broker as any).handle(worker, kind, data) as Promise<any>;
		await handle("ready", { sessionFile }); let serial = 0;
		const reserve = async (attempt = 1) => {
			const call = "synthetic-" + (++serial), record = { owner: "public-unit-only", pending: [{ id: call, kind: "ordinary", supported: true, attempts: [1] }] };
			const productionJournal = path.join(path.dirname(sessionFile), ".pi-desktop-transport/unit.json");
			await writeFile(productionJournal, JSON.stringify({ key: digest(JSON.stringify([path.basename(sessionFile), record.owner])), record: { ...record, sha256: digest(JSON.stringify(record)) } }));
			return handle("reserve", { productionJournal, productionCallId: call, attempt, kind: "ordinary", phase: "u1", body: JSON.stringify({ model: model.id, stream: true,
				messages: [{ role: "user", content: "Public unit test; no real request." }], tools: [], stream_options: { include_usage: true }, [model.compat.maxTokensField]: 2048 }) });
		};
		return { broker, handle, reserve, dir };
	};
	const frame = (usage?: any) => `data: ${JSON.stringify({ choices: [], ...(usage === undefined ? {} : { usage }) })}\n\n`;
	const usage = { prompt_tokens: 20, completion_tokens: 2 };
	const response = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
	const done = "data: [DONE]\n\n";

	await test("E8P-ipc-cache-unknown-not-zero", async () => {
		const t = await make("ipc-no-cache", async () => response(frame(usage) + done));
		try {
			const permit = await t.reserve(); await t.handle("open", permit); await t.handle("pull", permit); assert.deepEqual(await t.handle("pull", permit), { done: true });
			const terminal = t.broker.journal.rows.find(row => row.event === "terminal")!.data;
			assert.equal(terminal.status, "complete"); assert.equal(terminal.rawUsage.cacheRead, null); assert.equal(terminal.referenceCostUsd, null); assert.equal(t.broker.journal.stopReason, null);
			assert.equal(terminal.reasoningTokens, null); assert.equal(terminal.reasoningFieldPresent, false); assert.equal(terminal.sdkNormalizedOutput, 2);
		} finally { t.broker.close(); }
		return { networkRequests: 0, cacheAndCostUnknown: true };
	});
	await test("E8P-ipc-reasoning-output-ceiling-stops", async () => {
		const t = await make("ipc-reasoning-output", async () => response(frame({ ...usage, completion_tokens_details: { reasoning_tokens: 2047 } }) + done));
		try {
			const permit = await t.reserve(); await t.handle("open", permit);
			await assert.rejects(t.handle("pull", permit));
			assert.equal(t.broker.journal.stopReason, "usage_exceeded_reservation"); await assert.rejects(t.reserve());
			const terminal = t.broker.journal.rows.find(row => row.event === "terminal")!.data;
			assert.equal(terminal.rawUsage.output, 2); assert.equal(terminal.reasoningTokens, 2047); assert.equal(terminal.sdkNormalizedOutput, 2049);
			assert.equal(terminal.referenceCostUsd, null);
		} finally { t.broker.close(); }
		return { networkRequests: 0, rawCompletion: 2, sdkNormalizedOutput: 2049, laterRequestsRejected: true };
	});
	for (const reasoning of [0, 708, 2046] as const) await test("E8P-ipc-reasoning-" + reasoning + "-accounting", async () => {
		const t = await make("ipc-reasoning-" + reasoning, async () => response(frame({ ...usage, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: reasoning } }) + done));
		try {
			const permit = await t.reserve(); await t.handle("open", permit); await t.handle("pull", permit);
			const terminal = t.broker.journal.rows.find(row => row.event === "terminal")!.data;
			assert.equal(terminal.status, "complete"); assert.equal(terminal.reasoningTokens, reasoning); assert.equal(terminal.reasoningFieldPresent, true);
			assert.equal(terminal.sdkNormalizedOutput, 2 + reasoning); assert.equal(terminal.providerBillingVerified, false);
			assert.equal(terminal.referenceCostUsd, reasoning === 0 ? (20 * 0.75 + 2 * 3.75) / 1_000_000 : null);
			assert.equal(terminal.actualCostUsd, null);
		} finally { t.broker.close(); }
		return { networkRequests: 0, rawCompletion: 2, sdkNormalizedOutput: 2 + reasoning, billingNotAssumed: true };
	});
	for (const [id, value] of Object.entries({ null: null, negative: -1, fraction: 0.5, string: "708", boolean: true, overflow: Number.MAX_SAFE_INTEGER })) {
		await test("E8P-ipc-invalid-reasoning-" + id + "-stops", async () => {
			const t = await make("ipc-invalid-reasoning-" + id, async () => response(frame({ ...usage, completion_tokens_details: { reasoning_tokens: value } }) + done));
			try {
				const permit = await t.reserve(); await t.handle("open", permit); await assert.rejects(t.handle("pull", permit));
				assert.equal(t.broker.journal.stopReason, "usage_unknown"); await assert.rejects(t.reserve());
				const terminal = t.broker.journal.rows.find(row => row.event === "terminal")!.data;
				assert.equal(terminal.sdkNormalizedOutput, null); assert.equal(terminal.referenceCostUsd, null);
			} finally { t.broker.close(); }
			return { networkRequests: 0, invalidUsageNotCoercedToZero: true };
		});
	}
	for (const fault of ["missing-usage", "duplicate-usage", "excess-output", "large-response", "missing-done", "malformed-stream"] as const) {
		await test("E8P-ipc-" + fault + "-stops", async () => {
			let sends = 0;
			const text = fault === "missing-usage" ? frame() + done : fault === "duplicate-usage" ? frame(usage) + frame(usage) + done
				: fault === "excess-output" ? frame({ ...usage, completion_tokens: 2049 }) + done : fault === "missing-done" ? frame(usage)
				: fault === "malformed-stream" ? "data: invalid-json\n\n" : "x".repeat(513);
			const t = await make("ipc-" + fault, async () => { sends++; return response(text); }, fault === "large-response" ? { maxResponseBytes: 512 } : {});
			try {
				const permit = await t.reserve(); await t.handle("open", permit);
				await assert.rejects(async () => { for (let n = 0; n < 3; n++) await t.handle("pull", permit); });
				assert.ok(t.broker.journal.stopReason); await assert.rejects(t.reserve()); assert.equal(sends, 1);
				assert.equal(t.broker.journal.rows.filter(row => row.event === "terminal").length, 1);
			} finally { t.broker.close(); }
			assert.equal(recover(path.join(t.dir, "broker.jsonl")).reservations, 1);
			return { simulatedDispatches: sends, networkRequests: 0, laterRequestsRejected: true };
		});
	}
	await test("E8P-ipc-timeout-late-header-not-revived", async () => {
		let finish!: (response: Response) => void, cancelled = false;
		const t = await make("ipc-timeout", () => new Promise(resolve => { finish = resolve; }), { requestTimeoutMs: 25 });
		try {
			const permit = await t.reserve(), opening = assert.rejects(t.handle("open", permit), /LATE_RESPONSE/);
			await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(t.broker.journal.stopReason, "request_timeout");
			finish(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }));
			await opening; assert.equal(cancelled, true); await assert.rejects(t.reserve());
		} finally { t.broker.close(); }
		return { networkRequests: 0, lateResponseDiscarded: true };
	});
	await test("E8P-ipc-cancel-during-pull", async () => {
		const t = await make("ipc-cancel", async () => new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }));
		try {
			const permit = await t.reserve(); await t.handle("open", permit); const pulling = assert.rejects(t.handle("pull", permit), /INTERRUPTED/);
			await t.handle("cancel", permit); await pulling; await assert.rejects(t.handle("pull", permit));
			assert.equal(t.broker.journal.rows.filter(row => row.event === "terminal").length, 1);
			assert.equal(t.broker.journal.stopReason, "unknown_outcome");
		} finally { t.broker.close(); }
		return { networkRequests: 0, chunksAfterCancel: 0 };
	});
	await test("E8P-ipc-queued-cancel-no-second-dispatch", async () => {
		let finish!: (response: Response) => void, sends = 0;
		const t = await make("ipc-queued", () => { sends++; return new Promise(resolve => { finish = resolve; }); });
		try {
			const one = await t.reserve(), first = assert.rejects(t.handle("open", one), /LATE_RESPONSE/);
			const two = await t.reserve(), second = assert.rejects(t.handle("open", two));
			assert.equal((t.broker as any).active, 1); await t.handle("cancel", two); await second;
			assert.equal((t.broker as any).active, 1, "queued ticket must not decrement an acquired slot");
			finish(response(frame(usage) + done)); await first; assert.equal((t.broker as any).active, 0); assert.equal(sends, 1);
			assert.equal(t.broker.maxActive, 1);
		} finally { t.broker.close(); }
		return { simulatedDispatches: sends, networkRequests: 0 };
	});
	await test("E8P-ipc-ticket-and-retry-cannot-resend", async () => {
		let sends = 0; const t = await make("ipc-single-use", async () => { sends++; return response(frame(usage) + done); });
		try {
			await assert.rejects(t.reserve(2), /REDISPATCH_NOT_AUTHORIZED/);
			const permit = await t.reserve(); await t.handle("open", permit); await t.handle("pull", permit);
			await assert.rejects(t.handle("open", permit)); assert.equal(sends, 1);
		} finally { t.broker.close(); }
		return { networkRequests: 0, noDuplicateSend: true };
	});
}
