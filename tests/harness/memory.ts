import assert from "node:assert/strict";
import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createNovelMemoryEngine, type MemoryIO } from "../../src/novel/memory-engine.js";
import { sha256, withProject, type RunCase } from "./testkit.js";

const engine = createNovelMemoryEngine();
const candidate = "drafts/candidates/chapters/002.md";
const card = "planning/chapter-cards/002.md";
const acceptance = ".novel/acceptances/002-manuscript.json";

/** Test-only IO seam: each named read can fail on an exact invocation. No retries. */
export function faultIO(root: string, failure?: { path: string; attempt: number }) {
	const calls = new Map<string, number>();
	let faults = 0;
	const io: MemoryIO = {
		async read(relative) {
			const count = (calls.get(relative) ?? 0) + 1;
			calls.set(relative, count);
			if (failure?.path === relative && count === failure.attempt) { faults++; throw new Error("Injected temporary read failure"); }
			return readFile(path.join(root, relative), "utf8");
		},
		async list(relative) {
			return (await readdir(path.join(root, relative), { withFileTypes: true })).map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymlink: entry.isSymbolicLink() }));
		},
	};
	return { io, calls, faults: () => faults };
}

export async function runMemoryCases(runCase: RunCase): Promise<void> {
	await runCase("MEM-01", (record) => withProject(async (root) => {
		const { io } = faultIO(root);
		const before = await engine.snapshot("project-a", io);
		const source = before.memories.find((m) => m.kind === "world")!;
		assert.ok(source);
		const file = path.join(root, source.path);
		await writeFile(file, (await readFile(file, "utf8")) + "\n新增来源标记：潮窗修订。\n");
		const changed = await engine.snapshot("project-a", io);
		assert.throws(() => engine.read(changed, source.id), /失效/);
		assert.ok(engine.search(changed, { query: "潮窗修订" }).hits.some((hit) => hit.path === source.path));
		await unlink(file);
		const deleted = await engine.snapshot("project-a", io);
		assert.throws(() => engine.read(deleted, source.id), /失效/);
		assert.ok(!deleted.memories.some((m) => m.path === source.path));
		record("source_invalidated", { path: source.path, oldSha: source.sourceFingerprint, mutationRejected: true, deletionRejected: true });
	}));
	await runCase("MEM-02", (record) => withProject(async (root) => {
		const { io } = faultIO(root);
		const initial = await engine.snapshot("project-a", io);
		const accepted = initial.memories.find((m) => m.path === candidate)!;
		assert.equal(accepted?.authority, "approved");
		const content = await readFile(path.join(root, candidate), "utf8");
		const savedAcceptance = await readFile(path.join(root, acceptance), "utf8");
		await unlink(path.join(root, acceptance));
		assert.equal(sha256(await readFile(path.join(root, candidate))), sha256(content));
		async function rejectCurrent() {
			const next = await engine.snapshot("project-a", io);
			assert.ok(!next.memories.some((m) => m.path === candidate));
			assert.throws(() => engine.read(next, accepted.id), /失效/);
		}
		await rejectCurrent();
		await writeFile(path.join(root, acceptance), savedAcceptance);
		await writeFile(path.join(root, candidate), content + "\n新段落。\n");
		await rejectCurrent();
		await writeFile(path.join(root, candidate), content);
		await writeFile(path.join(root, card), (await readFile(path.join(root, card), "utf8")) + "\n合同修订\n");
		await rejectCurrent();
		record("acceptance_invalidated", { unchangedBodySha: sha256(content), rejectedVariants: 3 });
	}));
	await runCase("MEM-03", (record) => withProject(async (root) => {
		const { io } = faultIO(root);
		const initial = await engine.snapshot("project-a", io);
		const source = initial.memories.find((m) => m.kind === "world")!;
		const configFile = path.join(root, ".novel/project.json");
		const raw = await readFile(configFile, "utf8");
		const config = JSON.parse(raw);
		config.authority.proposedPaths.push(source.path);
		await writeFile(configFile, JSON.stringify(config));
		const changed = await engine.snapshot("project-a", io);
		assert.throws(() => engine.read(changed, source.id), /失效/);
		await writeFile(configFile, raw);
		assert.equal(engine.read(await engine.snapshot("project-a", io), source.id).sourceFingerprint, source.sourceFingerprint);
		const filename = path.join(root, source.path), original = await readFile(filename, "utf8");
		await writeFile(filename, original + "\n变更\n");
		assert.ok(!(await engine.snapshot("project-a", io)).memories.some((m) => m.id === source.id));
		await writeFile(filename, original);
		assert.equal(engine.read(await engine.snapshot("project-a", io), source.id).sourceFingerprint, source.sourceFingerprint);
		record("dependency_revalidated", { configRevoked: true, exactRestoreAllowed: true, sha: source.sourceFingerprint });
	}));
	await runCase("MEM-04", (record) => withProject(async (root) => {
		const snapshot = await engine.snapshot("project-a", faultIO(root).io);
		const planned = snapshot.memories.find((m) => m.temporal === "planned")!;
		assert.ok(planned, "Fixture needs a planned section");
		const query = planned.text.match(/[\p{Script=Han}]{2,}/u)?.[0] ?? planned.heading;
		assert.ok(!engine.search(snapshot, { query, limit: 20 }).hits.some((m) => m.temporal === "planned"));
		assert.ok(engine.search(snapshot, { query, includePlanned: true, limit: 20 }).hits.some((m) => m.temporal === "planned"));
		const chapterTwoQuery = "红色拨轮 复位";
		const unversionedQuery = "银色保温杯 最近状态";
		assert.ok(engine.search(snapshot, { query: chapterTwoQuery, limit: 20 }).hits.some((m) => m.chapter === 2));
		assert.ok(engine.search(snapshot, { query: unversionedQuery, limit: 20 }).hits.some((m) => m.kind === "continuity" && m.chapter === null));
		const earlyChapterTwo = engine.search(snapshot, { query: chapterTwoQuery, throughChapter: 1, limit: 20 });
		const earlyUnversioned = engine.search(snapshot, { query: unversionedQuery, throughChapter: 1, limit: 20 });
		assert.ok(!earlyChapterTwo.hits.some((m) => m.chapter !== null && m.chapter > 1));
		assert.ok(!earlyUnversioned.hits.some((m) => m.kind === "continuity" && m.chapter === null));
		assert.ok(engine.search(snapshot, { query: "白潮栓", throughChapter: 1, limit: 20 }).hits.some((m) => m.kind === "world"));
		record("temporal_filter", {
			futureExcludedByDefault: true,
			lateChapterVisibleWithoutBound: true,
			lateChapterExcludedAtOne: true,
			unversionedVisibleWithoutBound: true,
			unversionedExcludedAtOne: true,
			worldStillVisible: true,
			characterKnowledgeEnforced: false,
		});
	}));
	await runCase("MEM-05", (record) => withProject(async (a) => withProject(async (b) => {
		const snapA = await engine.snapshot("project-a", faultIO(a).io);
		const source = snapA.memories.find((m) => m.kind === "world")!;
		await writeFile(path.join(b, source.path), "# 项目乙\n\n乙站独有标识，不属于甲站。\n");
		const snapB = await engine.snapshot("project-b", faultIO(b).io);
		assert.throws(() => engine.read(snapB, source.id), /不属于/);
		const hits = engine.search(snapB, { query: "乙站独有标识" }).hits;
		assert.ok(hits.length && hits.every((m) => m.project === "project-b"));
		assert.ok(hits.some((m) => m.path === source.path && m.text.includes("乙站独有标识")));
		const recorderIdentity = engine.search(snapA, { query: "潮位记录员 抄录整点读数", limit: 20 }).hits;
		const technicianIdentity = engine.search(snapA, { query: "设备技师 电台 应急灯 观测尺", limit: 20 }).hits;
		assert.ok(recorderIdentity.some((m) => m.path === "canon/characters.md" && m.text.includes("林岚是白潮站的潮位记录员")));
		assert.ok(technicianIdentity.some((m) => m.path === "canon/characters.md" && m.text.includes("林澜是白潮站的设备技师")));
		record("project_isolation", {
			foreignIdRejected: true,
			samePathDifferentText: true,
			distinctFixtureIdentityFactsRetrieved: true,
			characterKnowledgeEnforced: false,
			aliasReasoningClaimed: false,
		});
	})));
	await runCase("FI-01", (record) => withProject(async (root) => {
		const healthy = await engine.snapshot("project-a", faultIO(root).io);
		const source = healthy.memories.find((m) => m.kind === "world")!;
		const failure = faultIO(root, { path: source.path, attempt: 1 });
		const first = await engine.snapshot("project-a", failure.io);
		assert.ok(!first.memories.some((m) => m.path === source.path));
		assert.ok(first.warnings.some((w) => w.includes(source.path)));
		const second = await engine.snapshot("project-a", failure.io);
		assert.ok(second.memories.some((m) => m.path === source.path));
		assert.equal(failure.calls.get(source.path), 2);
		assert.equal(failure.faults(), 1);
		record("explicit_reread", { faults: 1, attempts: 2, automaticRetries: 0 });
	}));
	await runCase("FI-02", (record) => withProject(async (root) => {
		const io = faultIO(root).io;
		const initial = await engine.snapshot("project-a", io);
		const hit = engine.search(initial, { query: "林岚" }).hits[0];
		assert.ok(hit);
		await writeFile(path.join(root, hit.path), (await readFile(path.join(root, hit.path), "utf8")) + "\n新版本证据标记。\n");
		const changed = await engine.snapshot("project-a", io);
		assert.throws(() => engine.read(changed, hit.id), /失效/);
		const newHit = engine.search(changed, { query: "新版本证据标记" }).hits[0];
		assert.ok(newHit && newHit.sourceFingerprint !== hit.sourceFingerprint);
		record("mutation_between_calls", { oldIdRejected: true, oldSha: hit.sourceFingerprint, newSha: newHit.sourceFingerprint });
	}));
}
