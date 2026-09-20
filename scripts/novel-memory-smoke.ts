import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createNovelMemoryEngine, type MemoryIO } from "../src/novel/memory-engine.ts";

const engine = createNovelMemoryEngine();
const config = { formatVersion: 1, authority: { currentState: "canon/state.md", proposedPaths: ["drafts/candidates"] } };
const files = new Map<string, string>([
	[".novel/project.json", JSON.stringify(config)],
	["canon/world.md", "# 世界规则\n\n## 武学边界\n青石令只能开启城门，不能控制人的心智。\n\n## 未来节点\n尚未发生：青石令将在第三章损毁。\n"],
	["canon/state.md", "# 当前状态\n\n## 第 1 章\n顾行持有青石令，还不知道它的来源。\n\n## 第 3 章\n顾行已丢失青石令。\n\n## 未标注时间\n这是最近状态，不能用于过去章节。\n"],
	["planning/chapter-cards/002.md", "status: APPROVED_BY_USER\n本章完成青石令的归还。"],
	["drafts/candidates/002.md", "# 第 2 章\n顾行将青石令交还城主。"],
	["drafts/candidates/003.md", "# 第 3 章\n未验收的秘密：青石令能够操纵所有人。"],
	["planning/continuity-proposals/002.md", "# 连续性提案\n未经用户确认的秘密：青石令属于皇帝。"],
	["archive/old.md", "青石令能够召唤神龙。"],
	["canon/retired.md", "status: SUPERSEDED\n青石令是三千岁的妖兽。"],
	["memory/summary.md", "青石令自动摘要：绝对服从。"],
]);
const fingerprint = (text: string) => {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
	return `${text.length}:${(hash >>> 0).toString(16)}`;
};
const acceptance = { version: 1, kind: "manuscript", chapter: "002", sourcePath: "drafts/candidates/002.md", cardPath: "planning/chapter-cards/002.md", sourceFingerprint: fingerprint(files.get("drafts/candidates/002.md")!), cardFingerprint: fingerprint(files.get("planning/chapter-cards/002.md")!), acceptedAt: "2026-09-12T08:00:00.000Z" };
files.set(".novel/acceptances/002-manuscript.json", JSON.stringify(acceptance));
let skippedLinkRead = false;
const io: MemoryIO = {
	async read(file) { assert.ok(engine.safePath(file)); if (file.startsWith("linked")) skippedLinkRead = true; return files.get(file) ?? null; },
	async list(directory) {
		const prefix = directory ? `${directory}/` : "";
		const entries = new Map<string, { name: string; isDirectory: boolean; isFile: boolean; isSymlink?: boolean }>();
		for (const file of files.keys()) {
			if (!file.startsWith(prefix)) continue;
			const rest = file.slice(prefix.length), name = rest.split("/")[0];
			entries.set(name, { name, isDirectory: rest.includes("/"), isFile: !rest.includes("/") });
		}
		if (!directory) entries.set("linked", { name: "linked", isDirectory: true, isFile: false, isSymlink: true });
		return [...entries.values()];
	},
};
const initial = await engine.snapshot("D:/Novel-A", io);
assert.equal(skippedLinkRead, false);
assert.equal(initial.sourceCount, 3);
const hits = engine.search(initial, { query: "青石令" }).hits;
assert.ok(hits.length >= 3);
assert.ok(hits.every((hit) => hit.temporal !== "planned"));
assert.ok(hits.some((hit) => hit.kind === "accepted-prose" && hit.authority === "approved"));
assert.ok(!JSON.stringify(hits).includes("操纵所有人"));
assert.ok(!JSON.stringify(hits).includes("属于皇帝"));
assert.ok(!JSON.stringify(hits).includes("召唤神龙"));
assert.ok(!JSON.stringify(hits).includes("绝对服从"));
assert.ok(engine.search(initial, { query: "青石令", includePlanned: true }).hits.some((hit) => hit.temporal === "planned"));
const past = engine.search(initial, { query: "青石令", throughChapter: 1, includePlanned: false });
assert.ok(past.hits.every((hit) => hit.kind === "world" || (hit.chapter !== null && hit.chapter <= 1)));
assert.ok(!JSON.stringify(past.hits).includes("已丢失"));
assert.ok(engine.search(initial, { query: "最近状态", throughChapter: 1 }).hits.every((hit) => !hit.text.includes("这是最近状态")));
assert.throws(() => engine.search(initial, { query: "", limit: 8 }));
assert.throws(() => engine.search(initial, { query: "青石令", throughChapter: -1 }));
assert.throws(() => engine.search(initial, { query: "青石令", limit: NaN }));
assert.throws(() => engine.search(initial, { query: "青石令", maxChars: Infinity }));
assert.ok(engine.search(initial, { query: "青石令", limit: 2, maxChars: 250 }).hits.length <= 2);
assert.ok(engine.search(initial, { query: "青石令", maxChars: 250 }).hits.reduce((sum, hit) => sum + hit.text.length, 0) <= 250);
assert.equal((await engine.snapshot("D:/Novel-A", io)).revision, initial.revision, "rebuild is deterministic");
assert.throws(() => engine.read({ ...initial, memories: [] }, hits[0].id), /失效/);
const otherProject = await engine.snapshot("D:/Novel-B", io);
assert.throws(() => engine.read(otherProject, hits[0].id), /不属于/);

const originalWorld = files.get("canon/world.md")!;
const worldId = hits.find((hit) => hit.kind === "world")!.id;
files.set("canon/world.md", originalWorld.replace("不能控制", "不能影响"));
const changed = await engine.snapshot("D:/Novel-A", io);
assert.throws(() => engine.read(changed, worldId), /失效/);
files.set("canon/world.md", originalWorld);
assert.equal(engine.read(await engine.snapshot("D:/Novel-A", io), worldId).sourceFingerprint, engine.read(initial, worldId).sourceFingerprint, "exact rollback restores matching source identity");
files.delete("canon/world.md");
const deleted = await engine.snapshot("D:/Novel-A", io);
assert.throws(() => engine.read(deleted, worldId), /失效/);
files.set("canon/world.md", originalWorld);

const acceptedId = hits.find((hit) => hit.kind === "accepted-prose")!.id;
files.set("planning/chapter-cards/002.md", "status: PROPOSED_PENDING_USER_ACCEPTANCE\n需要返工");
assert.ok(!(await engine.snapshot("D:/Novel-A", io)).memories.some((hit) => hit.kind === "accepted-prose"));
assert.throws(() => engine.read(changed, "mem-invalid"), /失效/);
files.set("planning/chapter-cards/002.md", "status: APPROVED_BY_USER\n本章完成青石令的归还。");
files.delete(".novel/acceptances/002-manuscript.json");
const acceptanceRemoved = await engine.snapshot("D:/Novel-A", io);
assert.throws(() => engine.read(acceptanceRemoved, acceptedId), /失效/);
assert.ok(!acceptanceRemoved.memories.some((hit) => hit.kind === "accepted-prose"));
for (const bad of ["../outside.md", "canon/../../x", "C:/x", "/x", "canon/x:ads", "canon/./x", "canon/x.", "canon\\x"]) assert.equal(engine.safePath(bad), false);
files.set("canon/oversized.md", "# 超长记录\n\n" + "青石令".repeat(3000));
const bounded = await engine.snapshot("D:/Novel-A", io);
assert.ok(bounded.warnings.some((warning) => warning.includes("canon/oversized.md")));
assert.ok(bounded.memories.every((memory) => memory.text.length <= 8000));
files.delete("canon/oversized.md");

// Real project data is read only. Assertions freeze useful retrieval cases, not wording.
const fixtureRoot = path.resolve("fixtures/novel-projects/fate-control-cycle-sample");
const fixtureIO: MemoryIO = {
	async read(relative) { return readFile(path.join(fixtureRoot, relative), "utf8"); },
	async list(relative) {
		return (await readdir(path.join(fixtureRoot, relative), { withFileTypes: true })).map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink() }));
	},
};
const fixture = await engine.snapshot(fixtureRoot, fixtureIO);
assert.ok(fixture.sourceCount >= 16);
const cases = [
	{ query: "九级最低 一级最高", expected: "02-cultivation-and-combat.md" },
	{ query: "地级以下 天地规则", expected: "02-cultivation-and-combat.md" },
	{ query: "周静宜 不知道", expected: "current-story-state.md" },
	{ query: "塑料文件袋 书桌抽屉", expected: "current-story-state.md" },
];
let passed = 0;
for (const test of cases) {
	const results = engine.search(fixture, { query: test.query, limit: 8 });
	const found = results.hits.some((hit) => hit.path.endsWith(test.expected));
	console.log(JSON.stringify({ query: test.query, found, paths: results.hits.map((hit) => `${hit.path}:${hit.startLine}`) }));
	assert.ok(found, `fixture retrieval: ${test.query}`); passed++;
}
assert.ok(!engine.search(fixture, { query: "017" }).hits.some((hit) => hit.path.startsWith("drafts/candidates")));
console.log(`Novel memory smoke passed; real fixture recall ${passed}/${cases.length}, ${fixture.sourceCount} sources, ${fixture.memories.length} excerpts`);
