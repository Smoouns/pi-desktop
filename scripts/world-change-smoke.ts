import assert from "node:assert/strict";
import { files, faults, reset, readTextFile, writeTextFile } from "./world-change-test-fs.js";
import { applyWorldChange, canRollbackWorldChange, listWorldChangeProposals, loadWorldChangeHistory, parseWorldChangeHistory, parseWorldChangeProposal, requestWorldChange, rollbackWorldChange } from "../src/novel/world-change.js";
import { classifyNovelDocument, type NovelDocument, type NovelProject } from "../src/novel/project.js";

const project: NovelProject = { rootPath: "C:/novel", configPath: "C:/novel/.novel/project.json", config: { formatVersion: 1 }, initialized: true };
const target = "canon/world.md";
const fullTarget = project.rootPath.toLowerCase() + "/" + target;
const original = "# 世界观\r\n\r\n## 边界\r\n旧设定。\r\n";
const first = "# 世界观\n\n## 边界\n新版设定。\n";
const second = "# 世界观\n\n## 边界\n第二次设定。\n";
const snapshot = () => [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
function doc(path: string, text: string): NovelDocument {
	return { relativePath: path, path: project.rootPath + "/" + path, name: path.split("/").pop()!, text, estimatedTokens: 1, category: "planning", classification: classifyNovelDocument(path, project.config) };
}
async function proposalFor(text = first) {
	const request = await requestWorldChange(project, target, "只调整边界措辞");
	const path = `planning/world-proposals/${request.id}-proposal.md`;
	const document = doc(path, `# 提案\nstatus: PROPOSED_PENDING_USER_ACCEPTANCE\nchange_id: ${request.id}\ntarget_path: ${target}\ntarget_fingerprint: ${request.targetFingerprint}\naffected_paths: ["planning/chapter-cards/001.md"]\n\n## Proposed Canon Text\n\n` + "```markdown\n" + text + "```\n\n## 影响说明\n保留原有边界。\n");
	await writeTextFile(document.path, document.text!);
	return { document, proposal: parseWorldChangeProposal(document, project)! };
}
async function setup() {
	reset();
	await writeTextFile(fullTarget, original);
	await writeTextFile("c:/novel/planning/chapter-cards/001.md", "unchanged planning");
	return proposalFor();
}

let { proposal, document } = await setup();
assert.equal(proposal.proposedText, first, "nested Markdown headings remain intact");
const merged = await applyWorldChange(project, proposal);
assert.equal(await readTextFile(fullTarget), first);
assert.deepEqual(await loadWorldChangeHistory(project), [merged]);
assert.deepEqual(listWorldChangeProposals(project, [document], [merged]), []);
assert.equal(canRollbackWorldChange(merged, [merged], first).allowed, true);
const rolledBack = await rollbackWorldChange(project, merged);
assert.ok(rolledBack.rolledBackAt);
assert.equal(await readTextFile(fullTarget), original, "restore exact CRLF snapshot");
assert.equal(await readTextFile("c:/novel/planning/chapter-cards/001.md"), "unchanged planning");
assert.deepEqual(listWorldChangeProposals(project, [document], await loadWorldChangeHistory(project)), []);
assert.match(await readTextFile("c:/novel/.novel/world-change-log.md"), /applied[\s\S]*rolled back/);
const afterRollback = snapshot();
await assert.rejects(() => rollbackWorldChange(project, merged));
await assert.rejects(() => rollbackWorldChange(project, rolledBack));
await assert.rejects(() => applyWorldChange(project, proposal));
assert.deepEqual(snapshot(), afterRollback, "repeat commands never write");

// Legacy histories without projectRoot remain readable and reversible.
const legacy = { ...merged };
delete legacy.projectRoot;
assert.equal(parseWorldChangeHistory(JSON.stringify(legacy), project).id, merged.id);
assert.throws(() => parseWorldChangeHistory(JSON.stringify({ ...legacy, before: "tampered" }), project), /指纹/);
assert.throws(() => parseWorldChangeHistory(JSON.stringify({ ...legacy, targetPath: "canon/../../outside.md" }), project));
assert.throws(() => parseWorldChangeHistory(JSON.stringify({ ...merged, rolledBackAt: "invalid" }), project));
assert.throws(() => parseWorldChangeHistory(JSON.stringify(merged), { ...project, rootPath: "C:/other" }), /另一个项目/);
await assert.rejects(() => requestWorldChange(project, "canon/../planning/test.md", "bad"));
await assert.rejects(() => requestWorldChange(project, "canon/world.md:stream", "bad"));

// Later active changes must be undone first, even if their texts happen to match.
({ proposal } = await setup());
const a = await applyWorldChange(project, proposal);
const b = await applyWorldChange(project, (await proposalFor(second)).proposal);
assert.equal(canRollbackWorldChange(a, [a, b], a.after).allowed, false);
await assert.rejects(() => rollbackWorldChange(project, a), /更晚/);
await rollbackWorldChange(project, b);
await rollbackWorldChange(project, a);
assert.equal(await readTextFile(fullTarget), original);

// External editing, missing Canon, stale or corrupt snapshots never get overwritten.
({ proposal } = await setup());
const entry = await applyWorldChange(project, proposal);
const entryFile = `c:/novel/.novel/world-change-history/${entry.id}.json`;
await writeTextFile(fullTarget, "manual edit");
const edited = snapshot();
await assert.rejects(() => rollbackWorldChange(project, entry), /后续编辑/);
assert.deepEqual(snapshot(), edited);
files.delete(fullTarget);
await assert.rejects(() => rollbackWorldChange(project, entry), /不存在/);
await writeTextFile(fullTarget, entry.after);
await writeTextFile(entryFile, JSON.stringify({ ...entry, affectedPaths: [] }));
await assert.rejects(() => rollbackWorldChange(project, entry), /预览后已变化/);
await writeTextFile(entryFile, "broken json");
await assert.rejects(() => loadWorldChangeHistory(project));

// Reject a changed impact contract as well as changed proposed text.
({ proposal, document } = await setup());
await writeTextFile(document.path, document.text!.replace('["planning/chapter-cards/001.md"]', '[]'));
const changedProposal = snapshot();
await assert.rejects(() => applyWorldChange(project, proposal), /审阅后发生变化/);
assert.deepEqual(snapshot(), changedProposal);

// Fail each of the three writes, both before writing and after truncating the file.
for (const afterPartialWrite of [false, true]) {
	for (const failWrite of [1, 2, 3]) {
		({ proposal } = await setup());
		const before = snapshot();
		Object.assign(faults, { writes: 0, failWrite, afterPartialWrite });
		await assert.rejects(() => applyWorldChange(project, proposal), /injected write failure/);
		assert.deepEqual(snapshot(), before, `apply recovery, stage ${failWrite}, partial=${afterPartialWrite}`);
		faults.failWrite = 0;
		const applied = await applyWorldChange(project, proposal); // recovery must permit retry
		const beforeUndo = snapshot();
		Object.assign(faults, { writes: 0, failWrite, afterPartialWrite });
		await assert.rejects(() => rollbackWorldChange(project, applied), /injected write failure/);
		assert.deepEqual(snapshot(), beforeUndo, `rollback recovery, stage ${failWrite}, partial=${afterPartialWrite}`);
		faults.failWrite = 0;
		await rollbackWorldChange(project, applied);
	}
}

// Project-local concurrency guard, re-entrant double click must not overwrite history.
({ proposal } = await setup());
const concurrent = await Promise.allSettled([applyWorldChange(project, proposal), applyWorldChange(project, proposal)]);
assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
assert.equal((await loadWorldChangeHistory(project)).length, 1);
console.log("World change history/rollback smoke passed (including 12 write-failure cases, 6 with partial writes)");
