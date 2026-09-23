import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { completeSimple } from "@mariozechner/pi-ai";
import { assertInside, sha256, treeManifest } from "../../evals/core/io.js";
import { loadSdkExtension } from "../../evals/sdk-ablation/session.js";
import { validateContextProvenance } from "../../evals/sdk-context/extension.js";
import { MODEL } from "../../evals/sdk-context/policy.js";
import { setupWork } from "../../evals/sdk-context/runner.js";
import { auditLifecycleInventory, lifecycleExtensionSource } from "../../evals/sdk-context/lifecycle-extension.js";
import { installLifecycleProvider } from "../../evals/sdk-context/lifecycle-provider.js";
import { LIFE_CONTENT, LIFE_LIMITS, LIFE_PROFILES, lifeExpected } from "../../evals/sdk-context/lifecycle-policy.js";
import { expectedLifecycleResult, judgeLifecycle, rebuildLifecycle, validateLifeManifest, validateLifeResult, validateLifeStage } from "../../evals/sdk-context/lifecycle-records.js";
import { runLifecycleBatch, runLifecycleScenario } from "../../evals/sdk-context/lifecycle-runner.js";

export async function lifecycleUnitWorker() {
	assert.equal(process.env.PI_EVAL_WORKER, "1"); const work = await setupWork(); let checks = 0;
	try {
		for (const profile of LIFE_PROFILES) {
			const source = lifecycleExtensionSource(profile), file = path.join(work, profile + ".ts"); await writeFile(file, source);
			const loaded = await loadSdkExtension(file, path.join(work, "project")); auditLifecycleInventory(profile, loaded, source); checks++;
			assert.throws(() => auditLifecycleInventory(profile, loaded, source + "\n// drift")); checks++;
			const e = loaded.extensions[0];
			for (const name of ["turn_end", "unknown_event", "session_fork"]) { e.handlers.set(name, [() => undefined]); assert.throws(() => auditLifecycleInventory(profile, loaded, source)); e.handlers.delete(name); checks++; }
			e.tools.set("supervisor_approve", {}); assert.throws(() => auditLifecycleInventory(profile, loaded, source)); e.tools.delete("supervisor_approve"); checks++;
		}
		const model = { ...MODEL, input: ["text" as const] }, context = { systemPrompt: "Public synthetic concurrent summary probe", messages: [] };
		const provider = installLifecycleProvider();
		try {
			provider.event({ type: "compaction_start" });
			const responses = await Promise.all(Array.from({ length: LIFE_LIMITS.requests + 4 }, () => completeSimple(model, context, { apiKey: "synthetic-only", maxTokens: 512 })));
			assert.equal(responses.filter(r => r.stopReason === "stop").length, LIFE_LIMITS.requests);
			assert.equal(provider.receipts.filter(r => r.disposition === "dispatched").length, LIFE_LIMITS.requests);
			assert.equal(provider.receipts.filter(r => r.disposition === "outer-blocked").length, 4); checks++;
			assert.ok(provider.receipts.every(r => r.kind === "summary")); checks++;
		} finally { provider.dispose(); }
		for (const probe of ["bytes", "cancel"] as const) {
			const p = installLifecycleProvider();
			try {
				const abort = new AbortController(); if (probe === "cancel") abort.abort();
				await completeSimple(model, { ...context, systemPrompt: probe === "bytes" ? "x".repeat(LIFE_LIMITS.outerBytes) : context.systemPrompt }, { apiKey: "synthetic-only", maxTokens: 512, signal: abort.signal });
				assert.equal(p.receipts.length, 1); assert.equal(p.receipts[0].disposition, probe === "bytes" ? "outer-blocked" : "aborted"); checks++;
			} finally { p.dispose(); }
		}
		const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")], prior = guard.attempts;
		await assert.rejects(async () => fetch("https://sdk-s3.invalid")); assert.throws(() => spawnSync(process.execPath, ["--version"])); assert.equal(guard.attempts, prior + 2); checks++;
		return checks;
	} finally { await assertInside(process.env.PI_CONTEXT_WORK_ROOT!, work); await rm(work, { recursive: true, force: true, maxRetries: 3 }); }
}

export async function runLifecycleTests() {
	let checks = 0; await validateContextProvenance(); checks++;
	const unit = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href, process.env.PI_CONTEXT_BUNDLE!, "lifecycle-unit-worker"],
		{ cwd: process.cwd(), env: { ...process.env, PI_EVAL_WORKER: "1" }, encoding: "utf8", timeout: 30000, windowsHide: true });
	assert.equal(unit.status, 0, unit.stderr); const match = unit.stdout.trim().match(/^S3_LIFECYCLE_UNIT_PASS (\d+)$/); assert.ok(match); checks += Number(match[1]);
	for (const task of ["auto-threshold", "auto-overflow"] as const) for (const scenario of ["summary-error", "summary-cancel", "summary-limit"] as const) {
		const stages = await runLifecycleScenario("sdk-b3-checkpoint-ops-v2", task, scenario), s = stages[0];
		assert.equal(stages.length, 1); assert.ok(s.inventory && s.settings && s.boundary && s.zeroNetwork);
		assert.equal(s.nativeCompactions, 0); assert.equal(s.writes, 0); assert.equal(s.starts.length, 1); assert.equal(s.ends.length, 1);
		assert.ok(!s.ends[0].success && !s.ends[0].willRetry); assert.equal(s.ends[0].aborted, scenario === "summary-cancel");
		assert.equal(s.receipts.filter(r => r.kind === "agent").length, 3); assert.equal(s.receipts.filter(r => r.kind === "summary").length, 1); checks++;
	}
	const repeated = (await runLifecycleScenario("sdk-b3-checkpoint-ops-v2", "auto-overflow", "overflow-repeat"))[0];
	assert.equal(repeated.nativeCompactions, 1); assert.equal(repeated.starts.length, 1); assert.equal(repeated.ends.length, 2);
	assert.ok(repeated.ends[0].willRetry && !repeated.ends[1].willRetry && repeated.ends[1].error && !repeated.ends[1].success);
	assert.equal(repeated.receipts.filter(r => r.outcome === "overflow").length, 2); assert.equal(repeated.receipts.filter(r => r.kind === "agent").length, 4); checks++;
	const intent = (await runLifecycleScenario("sdk-b3-checkpoint-ops-v2", "write-acklost", "intent-persistence"))[0];
	assert.equal(intent.writes, 0); assert.equal(intent.finalFileSha256, null); assert.equal(intent.nativeCompactions, 0);
	assert.equal(intent.operationMetrics.persistenceBlocks, 1); assert.ok(intent.writeResults.includes("persistence")); assert.equal(intent.receipts.filter(r => r.kind === "summary").length, 0); checks++;
	for (const task of ["write-acklost", "write-partial", "write-missing"] as const) {
		const [seed, resume] = await runLifecycleScenario("sdk-b3-checkpoint-ops-v2", task, "result-persistence");
		assert.equal(seed.writes, 1); assert.equal(seed.pendingAfter, "issued"); assert.equal(seed.operationMetrics.persistenceBlocks, 1);
		assert.equal(seed.nativeCompactions, 0); assert.equal(resume.pendingBefore, "issued"); assert.equal(resume.writes, 0);
		assert.equal(resume.finalFileSha256, seed.finalFileSha256); assert.equal(resume.pendingAfter, task === "write-acklost" ? "completed" : "issued"); checks++;
	}
	const batch = await runLifecycleBatch(), rows = batch.aggregate.rows;
	assert.equal(rows.length, 54); assert.equal(rows.filter(r => r.status === "pass").length, 30); assert.equal(rows.filter(r => r.status === "fail").length, 24); assert.equal(batch.aggregate.realHttpDispatches, 0); checks++;
	const before = await treeManifest(batch.directory); assert.deepEqual(await rebuildLifecycle(batch.directory), batch.aggregate); assert.deepEqual(await treeManifest(batch.directory), before); checks++;
	const manifest = validateLifeManifest(JSON.parse(await readFile(path.join(batch.directory, "manifest.json"), "utf8")));
	for (const run of manifest.runs) {
		const raw = JSON.parse(await readFile(path.join(batch.directory, "raw", run.runId + ".json"), "utf8")); validateLifeResult(raw.result, run, manifest);
		assert.equal(raw.result.status, lifeExpected(run)); assert.ok(expectedLifecycleResult(run, raw.result)); checks++;
		const partial = judgeLifecycle(run, [raw.result.stages[0]], false); assert.equal(partial.status, "unknown"); assert.deepEqual(partial.stages?.[0], raw.result.stages[0]); checks++;
	}
	const passRun = manifest.runs.find(r => r.profile === "sdk-b3-checkpoint-ops-v2" && r.task === "write-partial")!;
	const raw = JSON.parse(await readFile(path.join(batch.directory, "raw", passRun.runId + ".json"), "utf8"));
	for (const mutate of [
		(r: any) => r.extra = "PRIVATE_CANARY", (r: any) => r.stages[0].receipts[0].apiKey = "PRIVATE_CANARY", (r: any) => r.stages[0].durableIntentBeforeWrite = false,
		(r: any) => r.stages[0].unknownAtCompaction = false, (r: any) => r.stages[0].fromHook = true, (r: any) => r.stages[0].nativeCompactions = 0,
		(r: any) => r.stages[0].ends[0].willRetry = true, (r: any) => r.stages[0].receipts[0].disposition = "outer-blocked",
		(r: any) => r.stages[1].writes = 1, (r: any) => r.stages[1].pendingBefore = "none", (r: any) => r.stages[1].writeResults[0] = "success",
		(r: any) => r.stages[1].pendingAfter = "completed", (r: any) => r.stages[1].finalFileSha256 = sha256(LIFE_CONTENT), (r: any) => r.stages = null,
	]) { const changed = structuredClone(raw.result); mutate(changed); assert.throws(() => validateLifeResult(changed, passRun, manifest)); checks++; }
	const changedManifest = structuredClone(manifest) as any; changedManifest.policy.limits.requests++; assert.throws(() => validateLifeManifest(changedManifest)); checks++;
	const changedStage = structuredClone(raw.result.stages[0]); changedStage.receipts[0].outputReserve = 100000; assert.throws(() => validateLifeStage(changedStage)); checks++;
	const negativeRun = manifest.runs.find(r => r.profile === "sdk-b1-reliability" && r.task === "write-partial")!;
	const negative = JSON.parse(await readFile(path.join(batch.directory, "raw", negativeRun.runId + ".json"), "utf8"));
	for (const mutate of [
		(s: any[]) => s[0].starts = [], (s: any[]) => s[0].ends = [], (s: any[]) => s[0].writeResults = [], (s: any[]) => s[0].lostAcks = 0,
		(s: any[]) => s[0].finalFileSha256 = sha256(LIFE_CONTENT), (s: any[]) => s[1].inheritedCompactions = 0,
		(s: any[]) => s[1].writeEffects = 0, (s: any[]) => s[1].receipts = [],
	]) { const stages = structuredClone(negative.result.stages); mutate(stages); assert.ok(!expectedLifecycleResult(negativeRun, judgeLifecycle(negativeRun, stages))); checks++; }
	const temp = await mkdtemp(path.join(process.env.PI_CONTEXT_WORK_ROOT!, "lifecycle-tamper-"));
	try {
		await cp(batch.directory, temp, { recursive: true }); const indexPath = path.join(temp, "index.json"), indexText = await readFile(indexPath, "utf8");
		for (const mutate of [(i: any) => i.entries.pop(), (i: any) => i.entries.reverse(), (i: any) => i.entries[0].sha256 = "0".repeat(64), (i: any) => i.entries[0].file = "../outside", (i: any) => i.entries[1] = i.entries[0]]) {
			const index = JSON.parse(indexText); mutate(index); await writeFile(indexPath, JSON.stringify(index)); await assert.rejects(rebuildLifecycle(temp)); checks++;
		}
		await writeFile(indexPath, indexText); await writeFile(path.join(temp, "raw/extra.json"), "{}"); await assert.rejects(rebuildLifecycle(temp)); checks++;
	} finally { await assertInside(process.env.PI_CONTEXT_WORK_ROOT!, temp); await rm(temp, { recursive: true, force: true, maxRetries: 3 }); }
	console.log(`S3 lifecycle frozen matrix: ${batch.directory} (30 pass, 24 declared durability negatives).`);
	return checks;
}
