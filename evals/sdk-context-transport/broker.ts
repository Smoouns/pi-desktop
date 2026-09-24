import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createBoundedTransport, type RequestStopCode, type TransportOptions } from "../core/request-transport.js";
import { createJournalScope } from "../core/request-journal.js";
import type { RequestPolicy } from "../core/request-policy.js";
import { durableJson } from "../sdk-live/manifest.js";
import { ENDPOINT, MODEL, TASK_ID, type RequestKind } from "./policy.js";

export interface Offer { id: number; kind: RequestKind; body: string; taskId?: string; stage?: "single" | "seed" | "resume"; }
export interface RequestBinding { schemaVersion: 1; ordinal: number; offerId: number; kind: RequestKind; requestSha256: string; taskId?: string; stage?: "single" | "seed" | "resume"; }

/** Single privileged outlet for *both* ordinary and native-summary SDK requests.
 * Concurrent split-summary offers are serialized; waiting offers are not HTTP
 * reservations. Every actual dispatch reserves the shared quota durably first. */
export async function createContextBroker(options: {
	directory: string; manifestSha256: string; policy: RequestPolicy<string>;
	fetchImpl: typeof fetch;
	/** Explicit projection supplied only after the caller's batch authorization. */
	route?: { endpoint: string; modelId: string; outputField: "max_tokens" | "max_completion_tokens"; mode: "live" | "dry-run" };
	beforeReserve?: () => Promise<void>;
	/** Offline phase tests only. Live requests must always use the real deadlines. */
	testClock?: Required<Pick<TransportOptions, "now" | "setTimer" | "clearTimer">>;
}) {
	const scope = createJournalScope(options.policy);
	const route = options.route ?? { endpoint: ENDPOINT, modelId: MODEL.id, outputField: "max_tokens" as const, mode: "dry-run" as const };
	if (options.testClock !== undefined) {
		assert.equal(route.mode, "dry-run", "S3T_TEST_CLOCK_DRY_ONLY");
		assert.ok([options.testClock.now, options.testClock.setTimer, options.testClock.clearTimer].every(fn => typeof fn === "function"), "S3T_TEST_CLOCK_INVALID");
	}
	const journal = await scope.create(path.join(options.directory, "journal"), options.manifestSha256, route.mode);
	await mkdir(path.join(options.directory, "requests"));
	let active: Offer | null = null, nextId = 0, queued = 0, highWater = 0, closed = false;
	let tail = Promise.resolve();
	const kinds: RequestBinding[] = [];
	const gate = createBoundedTransport({ endpoint: route.endpoint, modelId: route.modelId, outputField: route.outputField, outputMode: "bounded",
		fetchImpl: options.fetchImpl, estimateInput: body => body.byteLength,
		now: options.testClock?.now, setTimer: options.testClock?.setTimer, clearTimer: options.testClock?.clearTimer,
		beforeDispatch: async request => {
			assert.ok(active, "S3T_BINDING_REQUIRED");
			await options.beforeReserve?.();
			await journal.reserve(request);
			const binding: RequestBinding = { schemaVersion: 1, ordinal: request.ordinal, offerId: active.id, kind: active.kind, requestSha256: request.requestSha256 };
			if (active.taskId !== undefined) { binding.taskId = active.taskId; binding.stage = active.stage; }
			await durableJson(path.join(options.directory, "requests", `request-${String(request.ordinal).padStart(6, "0")}.json`), binding);
			kinds.push(binding);
		},
		onRequestFinished: async request => {
			await journal.settle({ ordinal: request.ordinal, taskId: request.taskId, invocationId: request.invocationId,
				dispatchAttempted: request.dispatchAttempted, status: "complete", reasonCode: null, usage: request.usage });
		},
	}, options.policy);
	const stop = (reason: RequestStopCode = "MANUAL_STOP") => gate.stop(reason);
	return {
		stop,
		/** No body text, headers, URLs, or SDK error strings enter a retained record. */
		snapshot: () => ({ transport: gate.snapshot(), offered: nextId, maxConcurrentOffers: highWater, kinds: kinds.map(item => ({ ...item })) }),
		submit(offer: Offer): Promise<{ status: number; body: string }> {
			try {
				gate.assertActive();
				assert.ok(!closed && Number.isSafeInteger(offer.id) && offer.id === nextId + 1 && ["ordinary", "summary"].includes(offer.kind));
				assert.ok(typeof offer.body === "string" && Buffer.byteLength(offer.body) <= options.policy.limits.maxInputBytes);
				assert.ok(offer.taskId === undefined ? offer.stage === undefined : options.policy.taskIds.includes(offer.taskId) && ["single", "seed", "resume"].includes(offer.stage!));
				assert.ok(queued < 2 && (queued === 0 || offer.kind === "summary" && active?.kind !== "ordinary"), "S3T_QUEUE_BOUND");
				if (queued && active) assert.ok(active.taskId === offer.taskId && active.stage === offer.stage, "S3T_QUEUE_SCOPE");
			} catch { stop(); return Promise.reject(new Error("S3T_OFFER_REJECTED")); }
			const accepted = { ...offer };
			nextId++; queued++; highWater = Math.max(highWater, queued);
			const result = tail.then(async () => {
				gate.assertActive(); active = accepted;
				return gate.invoke(accepted.taskId ?? TASK_ID, async () => {
					const response = await gate.fetch(route.endpoint, { method: "POST", body: accepted.body, redirect: "error" });
					return { status: response.status, body: await response.text() };
				});
			}).finally(() => { queued--; active = null; });
			// The SDK may start two native summaries together. Never let their
			// journals interleave, nor let one failure silently permit the other.
			tail = result.then(() => undefined, () => { stop(); });
			return result;
		},
		async close(aborted = false) {
			closed = true; if (aborted) stop(); await tail;
			const disk = await scope.recover(path.join(options.directory, "journal"), options.manifestSha256);
			for (const reservation of disk.reservations.filter(row => !row.settlement)) {
				const request = gate.snapshot().requests.find(row => row.ordinal === reservation.ordinal);
				await journal.settle({ ordinal: reservation.ordinal, taskId: reservation.taskId, invocationId: reservation.invocationId,
					dispatchAttempted: request?.dispatchAttempted ?? true, status: "unknown", reasonCode: request?.reasonCode ?? "MANUAL_STOP", usage: null });
			}
			await journal.finalize(gate.snapshot().state === "active" ? "complete" : "aborted");
			return scope.recover(path.join(options.directory, "journal"), options.manifestSha256);
		},
	};
}
