import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPilotJournal, PilotJournalError, recoverPilotJournal, type PilotReserveSnapshot } from "../../evals/pilot/journal.js";
import { PILOT_TASK_IDS } from "../../evals/pilot/policy.js";

const manifestSha256 = "a".repeat(64), requestSha256 = "b".repeat(64);
const errorCode = (code: string) => (error: unknown): boolean => error instanceof PilotJournalError && error.code === code;
const reserve = (ordinal: number, invocationId = ordinal, taskId = PILOT_TASK_IDS[0]): PilotReserveSnapshot => ({ ordinal, taskId, invocationId, inputEstimate: 100, inputBytes: 500, outputReserved: 2048, requestSha256 });
const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedTokens: null, reasoningTokens: null };
async function cleanup(directory: string): Promise<void> {
	const parent = await realpath(os.tmpdir()), target = await realpath(directory), relative = path.relative(parent, target);
	assert.ok(/^pilot-journal-[^\\/]+$/.test(relative), "UNSAFE_JOURNAL_TEST_CLEANUP"); await rm(target, { recursive: true, force: true });
}

export async function runPilotJournalTests(): Promise<number> {
	let count = 0; const test = async (_name: string, action: () => Promise<void>): Promise<void> => { await action(); count++; };
	await test("reserve is durable before return and complete journal rebuilds", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-journal-"));
		try { const journal = await createPilotJournal(directory, manifestSha256, "dry-run"); const event = await journal.reserve(reserve(1)); const disk = JSON.parse(await readFile(path.join(directory, "event-000001.json"), "utf8")); assert.equal(disk.ordinal, event.ordinal);
			await journal.settle({ ordinal: 1, taskId: PILOT_TASK_IDS[0], invocationId: 1, dispatchAttempted: true, status: "complete", reasonCode: null, usage }); await journal.finalize("complete");
			const recovered = await recoverPilotJournal(directory, manifestSha256); assert.equal(recovered.canPass, true); assert.equal(recovered.dispatchAttempted, 1); assert.equal(recovered.unknown, 0); }
		finally { await cleanup(directory); }
	});
	await test("crash after reserve recovers as unknown without refund or pass", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-journal-"));
		try { const journal = await createPilotJournal(directory, manifestSha256, "live"); await journal.reserve(reserve(1)); const recovered = await recoverPilotJournal(directory, manifestSha256); assert.equal(recovered.pending, 1); assert.equal(recovered.unknown, 1); assert.equal(recovered.inputReserved, 100); assert.equal(recovered.outputReserved, 2048); assert.equal(recovered.canPass, false); }
		finally { await cleanup(directory); }
	});
	await test("claim is exclusive and prevents rerun", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-journal-"));
		try { await createPilotJournal(directory, manifestSha256, "dry-run"); await assert.rejects(() => createPilotJournal(directory, manifestSha256, "dry-run"), errorCode("JOURNAL_ALREADY_CLAIMED")); }
		finally { await cleanup(directory); }
	});
	await test("rejects duplicate invocation and fifth request for one task", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-journal-"));
		try { const journal = await createPilotJournal(directory, manifestSha256, "dry-run"); await journal.reserve(reserve(1, 1)); await assert.rejects(() => journal.reserve(reserve(2, 1)), errorCode("JOURNAL_REQUEST_DUPLICATE"));
			await journal.reserve(reserve(2, 2)); await journal.reserve(reserve(3, 3)); await journal.reserve(reserve(4, 4)); await assert.rejects(() => journal.reserve(reserve(5, 5)), errorCode("JOURNAL_BUDGET_EXCEEDED")); }
		finally { await cleanup(directory); }
	});
	await test("partial or tampered event fails closed", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-journal-"));
		try { const journal = await createPilotJournal(directory, manifestSha256, "dry-run"); await journal.reserve(reserve(1)); await writeFile(path.join(directory, "event-000001.json"), "{\n", "utf8"); await assert.rejects(() => recoverPilotJournal(directory, manifestSha256)); }
		finally { await cleanup(directory); }
	});
	await test("journal write failure prevents caller from reaching fetch", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-journal-"));
		try { const journal = await createPilotJournal(directory, manifestSha256, "dry-run"); await writeFile(path.join(directory, "event-000001.json"), "partial", { encoding: "utf8", flag: "wx" }); let fetches = 0;
			await assert.rejects(async () => { await journal.reserve(reserve(1)); fetches++; }, errorCode("JOURNAL_WRITE_FAILED")); assert.equal(fetches, 0); await assert.rejects(() => journal.reserve(reserve(1)), errorCode("JOURNAL_CLOSED")); }
		finally { await cleanup(directory); }
	});
	await test("strict settle schema rejects incomplete usage and ordinal mismatch", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pilot-journal-"));
		try { const journal = await createPilotJournal(directory, manifestSha256, "dry-run"); await assert.rejects(() => journal.reserve(reserve(2)), errorCode("JOURNAL_ORDINAL_MISMATCH")); await journal.reserve(reserve(1));
			await assert.rejects(() => journal.settle({ ordinal: 1, taskId: PILOT_TASK_IDS[0], invocationId: 1, dispatchAttempted: true, status: "complete", reasonCode: null, usage: { ...usage, promptTokens: null } }), errorCode("JOURNAL_SETTLE_STATE")); }
		finally { await cleanup(directory); }
	});
	return count;
}
