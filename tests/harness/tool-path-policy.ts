import assert from "node:assert/strict";
import { createNovelPathPolicy } from "../../src/novel/tool-path-policy.js";
import type { RunCase } from "./testkit.js";

export async function runToolPathPolicyCases(runCase: RunCase): Promise<void> {
	await runCase("PATH-POLICY-01 canonical relative paths", async (record) => {
		const policy = createNovelPathPolicy();
		for (const value of [
			"", " planning/progress.md", "planning/progress.md ", "/planning/progress.md",
			"C:/project/file.md", "//server/share/file.md", "planning\\progress.md",
			"planning//progress.md", "planning/./progress.md", "planning/../canon.md",
			"planning/file.md:stream", "planning/bad?.md", "planning/bad\0.md",
			"planning/file. ", "planning/file.", "planning/CON", "planning/nul.md",
			"planning/COM1.txt", "planning/lPt9",
		]) assert.equal(policy.safeRelative(value), null, `expected unsafe: ${JSON.stringify(value)}`);
		assert.equal(policy.safeRelative("planning/章节卡/001.md"), "planning/章节卡/001.md");
		assert.equal(policy.safeRelative("drafts/candidates/volume-1/001.md"), "drafts/candidates/volume-1/001.md");
		record("path.policy.canonical", { rejected: 20, accepted: 2 });
	});

	await runCase("PATH-POLICY-02 roles preserve existing directories", async (record) => {
		const policy = createNovelPathPolicy();
		assert.equal(policy.roleAllows("world", "planning/world-proposals/change.md"), true);
		assert.equal(policy.roleAllows("plan", "planning/event-outlines/arc.md"), true);
		assert.equal(policy.roleAllows("plan", "planning/chapter-cards/001.md"), true);
		assert.equal(policy.roleAllows("plan", "planning/reviews/001.md"), true);
		assert.equal(policy.roleAllows("plan", "planning/revision-requests/001.md"), true);
		assert.equal(policy.roleAllows("plan", "plan/chapter-cards/001.md"), true);
		assert.equal(policy.roleAllows("write", "drafts/candidates/001.md"), true);
		assert.equal(policy.roleAllows("write", "planning/continuity-proposals/001.md"), true);
		assert.equal(policy.roleAllows("review", "planning/reviews/001.md"), true);
		assert.equal(policy.roleAllows("review", "planning/revision-requests/001.md"), true);
		record("path.policy.roles", { allowed: 10 });
	});

	await runCase("PATH-POLICY-03 exact file grants are not prefixes", async (record) => {
		const policy = createNovelPathPolicy();
		for (const path of [
			"planning/progress.md-extra",
			"planning/progress.md/child",
			"planning/chapter-architecture.md.bak",
			"plan/progress.md-old",
			"plan/chapter-architecture.md/child",
		]) assert.equal(policy.roleAllows("plan", path), false, `prefix must not be allowed: ${path}`);
		assert.equal(policy.roleAllows("plan", "planning/progress.md"), true);
		assert.equal(policy.roleAllows("plan", "planning/chapter-architecture.md"), true);
		assert.equal(policy.roleAllows("plan", "plan/progress.md"), true);
		assert.equal(policy.roleAllows("plan", "plan/chapter-architecture.md"), true);
		record("path.policy.exact_file", { rejectedPrefixes: 5 });
	});

	await runCase("PATH-POLICY-04 cross-role and unsafe paths fail closed", async (record) => {
		const policy = createNovelPathPolicy();
		assert.equal(policy.roleAllows(null, "planning/progress.md"), false);
		assert.equal(policy.roleAllows("unknown", "planning/progress.md"), false);
		assert.equal(policy.roleAllows("world", "canon/world.md"), false);
		assert.equal(policy.roleAllows("write", "planning/chapter-cards/001.md"), false);
		assert.equal(policy.roleAllows("review", "drafts/candidates/001.md"), false);
		assert.equal(policy.roleAllows("plan", "planning/../canon/world.md"), false);
		record("path.policy.fail_closed", { rejected: 6 });
	});

	await runCase("PATH-POLICY-05 factory source is standalone", async (record) => {
		const rebuilt = Function(`return (${createNovelPathPolicy.toString()})`)() as typeof createNovelPathPolicy;
		const policy = rebuilt();
		assert.equal(policy.roleAllows("plan", "planning/progress.md"), true);
		assert.equal(policy.roleAllows("plan", "planning/progress.md-extra"), false);
		record("path.policy.embeddable", { standalone: true });
	});
}
