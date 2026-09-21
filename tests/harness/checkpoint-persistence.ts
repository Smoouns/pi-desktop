import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createCheckpointStore, type CheckpointInput } from "../../src/harness/checkpoint-store.js";
import type { RunScope } from "../../src/harness/types.js";
import { sha256, withProject, type RunCase } from "./testkit.js";

const assistant = (text: string) => ({
	role: "assistant" as const, content: [{ type: "text" as const, text }], api: "openai-completions" as const,
	provider: "synthetic", model: "scripted", timestamp: 0, stopReason: "stop" as const,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

export async function runCheckpointPersistenceCases(runCase: RunCase): Promise<void> {
	await runCase("P3-CP-PERSIST real Pi session reopen and corruption fail closed", (record) => withProject(async (root) => {
		const sessionDir = path.join(root, "checkpoint-sessions");
		const manager = SessionManager.create(root, sessionDir);
		const store = createCheckpointStore({ digest: sha256 });
		const scope: RunScope = { projectId: "synthetic-a", sessionId: manager.getSessionId(), runId: "run-1", generation: 1, role: "write" };
		const base: CheckpointInput = {
			scope, objective: "Preserve the exact instruction", hardConstraints: ["Do not alter accepted canon.", "Only edit drafts/candidates/001.md."],
			evidence: [{ path: "canon/world.md", sha256: "a".repeat(64), authority: "canonical", temporal: "current" }], observationIds: ["obs_1"], artifacts: [],
			unresolvedIssues: [], allowedNextActions: ["Inspect the candidate"], pendingOperations: [],
			budget: { readUsed: 1, outputUsed: 0, requestEstimate: null }, cause: "manual",
		};
		const first = store.build(base);
		const firstId = manager.appendCustomEntry("pi-desktop-task-checkpoint", first);
		manager.appendMessage(assistant("flush first checkpoint"));
		manager.branch(firstId);
		const sibling = store.build({ ...base, scope: { ...scope, runId: "sibling", generation: 2 }, objective: "inactive sibling checkpoint", cause: "refresh", parentId: first.id });
		manager.appendCustomEntry("pi-desktop-task-checkpoint", sibling);
		manager.appendMessage(assistant("flush inactive sibling"));
		manager.branch(firstId);
		const latest = store.build({ ...base, scope: { ...scope, runId: "run-2", generation: 2 }, objective: "Resume without losing constraints", cause: "before_compact", parentId: first.id });
		manager.appendCustomEntry("pi-desktop-task-checkpoint", latest);
		manager.appendMessage(assistant("flush latest checkpoint and active leaf"));
		const sessionFile = manager.getSessionFile();
		assert.ok(sessionFile);
		const persisted = await readFile(sessionFile, "utf8");
		assert.match(persisted, /pi-desktop-task-checkpoint/);

		const reopened = SessionManager.open(sessionFile, sessionDir);
		const recovered = store.latest(reopened.getBranch(), { ...scope, runId: "resume-run", generation: 99 });
		assert.equal(recovered?.id, latest.id);
		assert.notEqual(recovered?.id, sibling.id, "inactive sibling checkpoint must not enter active-branch recovery");
		assert.deepEqual(recovered?.hardConstraints, base.hardConstraints);
		assert.notEqual(recovered?.hardConstraints, latest.hardConstraints);
		assert.equal(reopened.getLeafEntry()?.type, "message", "reopen must recover the active branch leaf, not scan unrelated entries");

		const lines = persisted.trimEnd().split("\n");
		let corrupted = false;
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const entry = JSON.parse(lines[index]!);
			if (entry.type === "custom" && entry.customType === "pi-desktop-task-checkpoint") {
				entry.data.objective = "corrupted after persistence";
				lines[index] = JSON.stringify(entry);
				corrupted = true;
				break;
			}
		}
		assert.equal(corrupted, true);
		await writeFile(sessionFile, lines.join("\n") + "\n");
		const corruptedReopen = SessionManager.open(sessionFile, sessionDir);
		assert.throws(() => store.latest(corruptedReopen.getBranch(), scope), /integrity/i, "newest matching corruption must not fall back to the older checkpoint");
		record("checkpoint.persisted", { reopened: true, exactConstraints: true, activeBranch: true, corruptionBlocked: true });
	}));
}
