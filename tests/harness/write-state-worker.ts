import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withWriteSession, WRITE_TARGET } from "./write-state-extension.js";

const [stage, root] = process.argv.slice(2);
assert.ok(root && ["seed", "resume", "conflict"].includes(stage));
assert.ok((globalThis as any)[Symbol.for("pi.eval.networkGuard")]?.active);
const proofPath = path.join(root, "test-worker/proof.json"), input = { path: WRITE_TARGET, content: "A\n" };
const proof: any = stage === "seed" ? { nativeWrites: 0, processIds: [] } : JSON.parse(await readFile(proofPath, "utf8"));
proof.processIds.push(process.pid);
await withWriteSession(root, proof.sessionFile ?? null, async (s) => {
	if (stage === "seed") {
		assert.equal((await s.call("write", "lost-ack", input, true)).blocked, false);
		assert.equal((await s.checkpoint()).checkpoint.pendingOperations[0].state, "issued");
		proof.sessionFile = s.manager.getSessionFile();
	} else if (stage === "resume") {
		const result = await s.call("write", "after-reopen", input);
		assert.equal(result.blocked, true); assert.match(result.reason, /satisfied/);
		assert.equal(s.persisted().pendingOperations[0]!.state, "completed");
		assert.equal(await readFile(path.join(root, WRITE_TARGET), "utf8"), "A\n");
		proof.satisfiedWithoutReplay = true;
	} else {
		await writeFile(path.join(root, WRITE_TARGET), "B\n");
		assert.equal((await s.checkpoint()).status, "needs_revalidation");
		await s.call("read", "read-b", { path: WRITE_TARGET });
		assert.equal((await s.checkpoint("refresh")).status, "ready");
		const result = await s.call("write", "old-intent-new-id", input);
		assert.equal(result.blocked, true); assert.match(result.reason, /post_state_conflict/); assert.doesNotMatch(result.reason, /satisfied|已满足/);
		assert.equal(s.persisted().pendingOperations[0]!.state, "completed");
		proof.conflictBlocked = true;
	}
	proof.nativeWrites += s.writes();
});
await writeFile(proofPath, JSON.stringify(proof));
