import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRunSupervisor } from "../../src/harness/run-supervisor.js";
import { createVerificationProgressEvidence } from "../../src/harness/verification-progress.js";
import { createSupervisorRuntime } from "../../src/extensions/supervisor-runtime.js";
import { withRunner } from "./phase4-extension.js";
import { sha256, withProject, type RunCase } from "./testkit.js";

const scope = { projectId: "effective-project", sessionId: "effective-session", runId: "effective-run", generation: 1, role: "write" };
const receipt = (callId: string, patch: Record<string, unknown> = {}) => ({ callId, subject: "drafts/003.md", artifactSha256: sha256("body"), errorDigest: "MIN_CHARS", passed: false, full: true, ...patch });

export async function runEffectiveProgressCases(runCase: RunCase): Promise<void> {
	await runCase("E6-PROGRESS unrelated evidence and artifacts cannot reset a subject", () => {
		const supervisor = createRunSupervisor({ digest: sha256 }); supervisor.begin(scope);
		for (let i = 1; i <= 3; i++) {
			supervisor.evidence(scope, `notes/unrelated.md#${i}`);
			supervisor.artifact(scope, "drafts/unrelated.md", sha256(`unrelated ${i}`));
			const status = supervisor.verification(scope, receipt(`v${i}`));
			assert.equal(status?.unchangedAttempts, i);
		}
		assert.equal(supervisor.snapshot()?.reasonCode, "UNCHANGED_VERIFICATION");
		assert.equal(supervisor.snapshot()?.verificationAttempts, 3);
		assert.equal(supervisor.tool(scope, "late-write", "write").allowed, false);
	});
	await runCase("E6-PROGRESS body SHA churn alone is not a repair", () => {
		const supervisor = createRunSupervisor({ digest: sha256 }); supervisor.begin(scope);
		for (let i = 1; i <= 3; i++) supervisor.verification(scope, receipt(`v${i}`, { artifactSha256: sha256(`same failure body ${i}`) }));
		assert.equal(supervisor.snapshot()?.state, "NO_PROGRESS");
		assert.equal(supervisor.snapshot()?.verificationAttempts, 3);
	});
	await runCase("E6-PROGRESS alternating subjects and diagnostics retain recurrence", () => {
		const supervisor = createRunSupervisor({ digest: sha256 }); supervisor.begin(scope);
		for (const [i, subject] of ["a", "b", "a", "b", "a"].entries()) supervisor.verification(scope, receipt(`v${i}`, { subject }));
		assert.equal(supervisor.snapshot()?.reasonCode, "UNCHANGED_VERIFICATION");
		assert.equal(supervisor.snapshot()?.verificationAttempts, 5);
		const errors = createRunSupervisor({ digest: sha256 }); errors.begin(scope);
		for (const [i, errorDigest] of ["a", "b", "a", "b", "a"].entries()) errors.verification(scope, receipt(`e${i}`, { errorDigest }));
		assert.equal(errors.snapshot()?.reasonCode, "UNCHANGED_VERIFICATION");
	});
	await runCase("E6-PROGRESS normalized diagnostics ignore report/body hashes but preserve mechanical deficits", () => {
		const derive = createVerificationProgressEvidence({ digest: sha256 });
		const base = { subject: "drafts/003.md", mode: "full", passed: false, failures: ["[MIN_CHARS] Chapter has 10 characters; required min_chars=300."], sources: [{ path: "drafts/003.md", sha256: sha256("body") }, { path: "planning/card.md", sha256: sha256("card") }, { path: "planning/verifications/003.md", sha256: sha256("timestamp 1") }] };
		const before = JSON.stringify(base), first = derive(base);
		const next = derive({ ...base, failures: ["  [MIN_CHARS]  Chapter has 20 characters; required min_chars=300.  "], sources: [...base.sources].reverse().map(item => item.path === "planning/card.md" ? item : { ...item, sha256: sha256("different output") }) });
		assert.equal(next.relatedSourcesDigest, first.relatedSourcesDigest);
		assert.deepEqual(Object.keys(next.diagnostics), Object.keys(first.diagnostics));
		assert.deepEqual(Object.values(first.diagnostics), [290]); assert.deepEqual(Object.values(next.diagnostics), [280]);
		assert.equal(JSON.stringify(base), before, "normalizer must not mutate verified sources");
		const changed = derive({ ...base, sources: base.sources.map(item => ({ ...item, sha256: sha256("updated contract") })) });
		assert.notEqual(changed.relatedSourcesDigest, first.relatedSourcesDigest);
		for (const [failure, expected] of [
			["[MAX_CHARS] Chapter has 1250 characters; allowed max_chars=1200.", 50],
			["[MAX_CHARS] Chapter already has 1250 characters; max_chars=1200.", 50],
			["[SCENE_MIN_CHARS] Scene radio-check has 20 characters; required min_chars=120.", 100],
			["[SCENE_BUDGET] Scene count 5 is outside scene_budget 1..3.", 2],
			["[SCENE_BUDGET_MAX] Scene count 5 exceeds scene_budget.max=3.", 2],
			["[HTML_COMMENT] Found 2 invalid HTML comment(s); only SCENE boundaries are allowed.", 2],
			["[CONTRACT] Unknown contract diagnostic.", 1],
		] as const) assert.deepEqual(Object.values(derive({ ...base, failures: [failure] }).diagnostics), [expected]);
		const a = derive({ ...base, failures: ["[SCENE_MISSING] Missing required scene boundary: A"] });
		const b = derive({ ...base, failures: ["[SCENE_MISSING] Missing required scene boundary: B"] });
		assert.notDeepEqual(a.diagnostics, b.diagnostics, "different target scenes are not collapsed into one code");
		assert.throws(() => derive({ ...base, passed: true }), /Passing/);
		assert.throws(() => derive({ ...base, failures: Array(129).fill(base.failures[0]) }), /capacity/);
		const rebuilt = Function(`return (${createVerificationProgressEvidence.toString()})`)() as typeof createVerificationProgressEvidence;
		assert.deepEqual(rebuilt({ digest: sha256 })(base), first);
	});
	await runCase("E6-PROGRESS real mechanical improvement continues but regressions and tradeoffs do not reset", () => {
		const supervisor = createRunSupervisor({ digest: sha256 }); supervisor.begin(scope);
		for (let i = 0; i < 5; i++) {
			const status = supervisor.verification(scope, receipt(`better-${i}`, { diagnostics: { length: 100 - i * 10, scenes: 1 } }));
			assert.equal(status?.state, "RUNNING"); assert.equal(status?.unchangedAttempts, 1);
		}
		assert.equal(supervisor.verification(scope, receipt("worse-1", { diagnostics: { length: 50, scenes: 2 } }))?.unchangedAttempts, 2, "one improved metric cannot hide another regression");
		assert.equal(supervisor.verification(scope, receipt("worse-2", { diagnostics: { length: 70, scenes: 1 } }))?.reasonCode, "UNCHANGED_VERIFICATION");
		assert.equal(supervisor.snapshot()?.verificationAttempts, 7);
	});
	await runCase("E6-PROGRESS new relevant evidence is allowed but cycling dependencies retains counters", () => {
		const supervisor = createRunSupervisor({ digest: sha256 }); supervisor.begin(scope);
		for (const [i, dependency] of ["A", "A", "B", "B"].entries()) {
			const status = supervisor.verification(scope, receipt(`v${i}`, { relatedSourcesDigest: sha256(dependency) }));
			assert.equal(status?.state, "RUNNING"); assert.equal(status?.unchangedAttempts, i % 2 + 1);
		}
		assert.equal(supervisor.verification(scope, receipt("v4", { relatedSourcesDigest: sha256("A") }))?.reasonCode, "UNCHANGED_VERIFICATION");
	});
	await runCase("E6-PROGRESS scene modes and passing repair have distinct bounded tracks", () => {
		const supervisor = createRunSupervisor({ digest: sha256 }); supervisor.begin(scope);
		for (const [i, mode] of ["full", "scene:A", "scene:B", "full", "scene:A", "scene:B"].entries()) assert.equal(supervisor.verification(scope, receipt(`mode-${i}`, { full: mode === "full", mode }))?.state, "RUNNING");
		assert.equal(supervisor.verification(scope, receipt("pass-A", { full: false, mode: "scene:A", passed: true, errorDigest: null }))?.state, "RUNNING");
		assert.equal(supervisor.verification(scope, receipt("A-again", { full: false, mode: "scene:A" }))?.unchangedAttempts, 1);
		assert.equal(supervisor.verification(scope, receipt("full-again"))?.state, "NO_PROGRESS", "a scene PASS cannot reset the full-chapter failure track");
		assert.equal(supervisor.snapshot()?.userAccepted, false);
	});
	await runCase("E6-PROGRESS scoped dedup and roundtrip retain the failure track", () => {
		const supervisor = createRunSupervisor({ digest: sha256 }); supervisor.begin(scope);
		supervisor.verification(scope, receipt("v1", { diagnostics: { length: 50 } }));
		const second = supervisor.verification(scope, receipt("v2", { diagnostics: { length: 50 } }))!;
		assert.equal(supervisor.verification(scope, receipt("v2", { diagnostics: { length: 10 } }))?.id, second.id);
		assert.equal(supervisor.verification({ ...scope, generation: 2 }, receipt("foreign")), null);
		assert.equal(supervisor.snapshot()?.id, second.id);
		assert.ok(Object.isFrozen(Object.values(second.verificationProgress!)[0].bestDiagnostics));
		const rebuilt = Function(`return (${createRunSupervisor.toString()})`)() as typeof createRunSupervisor;
		const restored = rebuilt({ digest: sha256 }); restored.restore(JSON.parse(JSON.stringify(second)), scope);
		assert.equal(restored.verification(scope, receipt("v3", { diagnostics: { length: 50 } }))?.state, "NO_PROGRESS");
		assert.deepEqual(restored.parse(restored.snapshot()), restored.snapshot());
		const before = supervisor.snapshot();
		for (const diagnostics of [{ x: 0 }, { x: NaN }, Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`x${i}`, 1])), JSON.parse('{"__proto__":1}')]) assert.throws(() => supervisor.verification(scope, receipt("invalid", { diagnostics })));
		assert.throws(() => supervisor.verification(scope, receipt("bad-mode", { full: false, mode: "full" })), /mode/);
		assert.equal(supervisor.snapshot()?.id, before?.id, "invalid progress cannot partially mutate counters");
	});
	await runCase("E6-PROGRESS legacy snapshots remain readable and latest corrupt progress fails closed", () => {
		const core = createRunSupervisor({ digest: sha256 }); const { id: _id, verificationProgress: _progress, ...content } = core.begin(scope);
		const oldContent = { ...content, schemaVersion: 1 as const }, legacy = { ...oldContent, id: "run_" + sha256(JSON.stringify(oldContent)) };
		assert.deepEqual(core.parse(legacy), legacy);
		const runtime = createSupervisorRuntime({ createSupervisor: () => createRunSupervisor({ digest: sha256 }), append: () => undefined });
		const entry = (data: unknown) => ({ type: "custom", customType: "pi-desktop-run-status/v1", data });
		assert.equal(runtime.restore([entry(legacy)], scope, 2)?.reasonCode, "INTERRUPTED_RUN");
		assert.equal(runtime.tool("no-auto", "write").allowed, false);
		runtime.markExplicitInput("interactive"); const fresh = runtime.start({ ...scope, generation: 3, runId: "new-run" })!;
		assert.equal(fresh.schemaVersion, 2); assert.equal(fresh.state, "RUNNING");
		const { verificationProgress: _missing, ...broken } = fresh;
		assert.equal(runtime.restore([entry(legacy), entry(broken)], scope, 4)?.reasonCode, "CORRUPT_RUN_STATUS");
		assert.throws(() => core.parse({ ...fresh, schemaVersion: 3 }), /schemaVersion/);
	});
	await runCase("E6-PROGRESS novel diagnostic shapes remain subject to hard caps", () => {
		const supervisor = createRunSupervisor({ digest: sha256 }); supervisor.begin(scope);
		for (let i = 0; i < 12; i++) assert.equal(supervisor.verification(scope, receipt(`v${i}`, { diagnostics: { [`different-${i}`]: 1 }, relatedSourcesDigest: sha256(`dependency-${i}`) }))?.state, "RUNNING");
		assert.equal(supervisor.verification(scope, receipt("v13"))?.reasonCode, "MAX_VERIFICATION_ATTEMPTS");
		assert.equal(supervisor.snapshot()?.verificationAttempts, 12); assert.equal(supervisor.snapshot()?.userAccepted, false);
		assert.deepEqual(supervisor.parse(supervisor.snapshot()), supervisor.snapshot());
	});
}

export async function runEffectiveProgressExtensionCases(runCase: RunCase): Promise<void> {
	for (const minified of [false, true]) await runCase(`E6-PROGRESS extension unrelated reads and whitespace writes (${minified ? "minified" : "source"})`, record => withProject(async root => {
		await mkdir(path.join(root, ".novel/tools"), { recursive: true });
		await copyFile(path.resolve("scripts/verify-novel-chapter.ts"), path.join(root, ".novel/tools/verify-novel-chapter.ts"));
		const bodyPath = "drafts/candidates/chapters/003.md";
		const body = await readFile(path.join(root, bodyPath), "utf8");
		await withRunner(root, minified, async ({ extension, runner, entries, ctx, aborts }) => {
			await runner.emit({ type: "session_start" } as never);
			await runner.emitInput("核对第003章", undefined, "interactive");
			await runner.emit({ type: "agent_start" } as never);
			const tool = async (name: string, id: string, params: Record<string, unknown>) => {
				const gate = await runner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: id, input: params } as never);
				assert.notEqual(gate?.block, true, gate?.reason);
				try { return await extension.tools.get(name).definition.execute(id, params, undefined, undefined, ctx()); }
				catch (error) { if ((error as any).toolResult) return (error as any).toolResult; throw error; }
			};
			const reportHashes = new Set<string>();
			for (let i = 1; i <= 3; i++) {
				await writeFile(path.join(root, "drafts/unrelated.md"), `unrelated ${i}\n`);
				await tool("read_story_document", `read-${i}`, { path: "drafts/unrelated.md" });
				// Simulates an external formatting edit; the real verifier observes the new SHA.
				await writeFile(path.join(root, bodyPath), body + "\n".repeat(i));
				const refreshed = await tool("read_story_document", `body-${i}`, { path: bodyPath });
				assert.notEqual(refreshed.isError, true);
				const checkpoint = await tool("refresh_task_checkpoint", `refresh-${i}`, {});
				assert.notEqual(checkpoint.isError, true);
				const result = await tool("verify_chapter", `verify-${i}`, { chapter: "003" });
				assert.equal(result.isError, true);
				assert.equal(result.details.harness.error.code, "VERIFICATION_FAILED", "must reach real content validation, not a stale-source or contract gate");
				reportHashes.add(sha256(await readFile(path.join(root, "planning/verifications/003-verification.md"))));
				await runner.emit({ type: "turn_end", turnIndex: i, message: { role: "assistant", content: [], stopReason: "toolUse" }, toolResults: [] } as never);
			}
			const status = [...entries].reverse().find(entry => entry.customType === "pi-desktop-run-status/v1")?.data;
			assert.equal(reportHashes.size, 3, "real reports have distinct body SHA / timestamps");
			assert.equal(status.state, "NO_PROGRESS"); assert.equal(status.reasonCode, "UNCHANGED_VERIFICATION");
			assert.equal(status.verificationAttempts, 3); assert.equal(status.toolCalls, 12); assert.equal(status.userAccepted, false);
			assert.ok(aborts() > 0);
			const blocked = await runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "after-stop", input: { path: "drafts/after-stop.md", content: "must not dispatch" } } as never);
			assert.equal(blocked?.block, true);
			record("effective_progress.stopped", { reason: status.reasonCode, tools: status.toolCalls, verifications: status.verificationAttempts, completed: false });
		});
	}));
	await runCase("E6-PROGRESS extension accepts current contract change and a real full repair", record => withProject(async root => {
		await mkdir(path.join(root, ".novel/tools"), { recursive: true });
		await copyFile(path.resolve("scripts/verify-novel-chapter.ts"), path.join(root, ".novel/tools/verify-novel-chapter.ts"));
		await withRunner(root, false, async ({ extension, runner, entries, ctx }) => {
			await runner.emit({ type: "session_start" } as never);
			await runner.emitInput("检查并修复合成正文", undefined, "interactive"); await runner.emit({ type: "agent_start" } as never);
			const latest = () => [...entries].reverse().find(entry => entry.customType === "pi-desktop-run-status/v1")!.data;
			const tool = async (name: string, id: string, params: Record<string, unknown>) => {
				try { return await extension.tools.get(name).definition.execute(id, params, undefined, undefined, ctx()); }
				catch (error) { if ((error as any).toolResult) return (error as any).toolResult; throw error; }
			};
			const verify = async (id: string, passed: boolean) => {
				const result = await tool("verify_chapter", id, { chapter: "003" });
				if (passed) assert.notEqual(result.isError, true, JSON.stringify(result));
				else assert.equal(result.details.harness.error.code, "VERIFICATION_FAILED");
				await runner.emit({ type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [], stopReason: "toolUse" }, toolResults: [] } as never);
			};
			await verify("old-contract-1", false); await verify("old-contract-2", false);
			assert.equal(latest().unchangedAttempts, 2);
			const card = "planning/chapter-cards/003.md";
			await writeFile(path.join(root, card), (await readFile(path.join(root, card), "utf8")) + "\n外部规划依赖的新版本，未更改验收门槛。\n");
			await tool("read_story_document", "reread-card", { path: card });
			await tool("refresh_task_checkpoint", "refresh-card", {});
			await verify("current-contract", false);
			assert.equal(latest().state, "RUNNING"); assert.equal(latest().unchangedAttempts, 1);
			assert.equal(Object.keys(latest().verificationProgress).length, 2, "new relevant SHA does not erase old dependency history");
			const body = "drafts/candidates/chapters/003.md";
			await writeFile(path.join(root, body), (await readFile(path.join(root, body), "utf8")) + "\n" + "测".repeat(350) + "\n");
			await tool("read_story_document", "reread-body", { path: body });
			await tool("refresh_task_checkpoint", "refresh-body", {});
			await verify("fixed-current", true);
			assert.equal(latest().lastVerification.passed, true); assert.equal(latest().unchangedAttempts, 0);
			assert.equal(latest().userAccepted, false); assert.equal(Object.keys(latest().verificationProgress).length, 0);
			record("effective_progress.repaired", { verifiedAttempts: latest().verificationAttempts, fullPass: true, userAccepted: false });
		});
	}));
}
