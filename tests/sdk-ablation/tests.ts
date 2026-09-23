import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertInside, digest, sha256, treeManifest } from "../../evals/core/io.js";
import { NOVEL_TOOLS_EXTENSION_CONTENT as RAW_BASELINE } from "../../evals/sdk-ablation/baseline/src/extensions/novel-tools-extension.js";
import { auditSdkInventory, sdkExtensionSource, validateSdkProvenance } from "../../evals/sdk-ablation/extensions.js";
import { createBaselineSafety } from "../../evals/sdk-ablation/safety.js";
import { SDK_PROFILES, SDK_TARGET } from "../../evals/sdk-ablation/policy.js";
import { loadSdkExtension } from "../../evals/sdk-ablation/session.js";
import { checkBaselineGitObjects, emptySdkResult, expectedSdkOutcome, runSdkBatch, runSdkWorker } from "../../evals/sdk-ablation/runner.js";
import { rebuildSdkBatch, sdkAggregate, validateSdkResult, validateSdkManifest } from "../../evals/sdk-ablation/records.js";

export async function runSdkUnitTests(): Promise<number> {
	assert.equal(process.env.PI_EVAL_WORKER, "1");
	let count = 0;
	const directory = await mkdtemp(path.join(process.env.PI_ABLATION_WORK_ROOT!, "unit-"));
	try {
		const project = path.join(directory, "project");
		await mkdir(path.join(project, ".novel"), { recursive: true }); await mkdir(path.join(project, "canon"));
		const metadata = path.join(project, ".novel/project.json");
		await writeFile(metadata, JSON.stringify({ formatVersion: 1 }));
		await writeFile(path.join(project, "canon/world.md"), "SYNTHETIC_WORLD");
		const outside = path.join(directory, "outside"); await mkdir(outside); await writeFile(path.join(outside, "sentinel.md"), "SYNTHETIC_OUTSIDE_SENTINEL");
		await symlink(outside, path.join(project, "canon/linked"), process.platform === "win32" ? "junction" : "dir");
		const ctx = { cwd: project, sessionManager: { getBranch: () => [], getEntries: () => [] } };
		const rawPath = path.join(directory, "raw.ts"); await writeFile(rawPath, RAW_BASELINE);
		const raw = await loadSdkExtension(rawPath, project); assert.equal(raw.errors.length, 0); count++;
		const read = raw.extensions[0].tools.get("read_story_document").definition;
		const rawRead = await read.execute("raw", { path: "canon/linked/sentinel.md" }, undefined, undefined, ctx);
		assert.ok(rawRead.content.some((part: any) => part.text?.includes("SYNTHETIC_OUTSIDE_SENTINEL"))); count++;
		const safety = createBaselineSafety({ path, lstat, readFile });
		await assert.rejects(safety.check("read_story_document", { path: "canon/linked/sentinel.md" }, ctx)); count++;
		for (const candidate of ["../outside/sentinel.md", "C:/outside.md", "canon\\world.md", "canon/world.md:stream", "/outside.md", "canon/../world.md", "canon/./world.md", "canon/world.md."]) {
			await assert.rejects(safety.check("read", { path: candidate }, ctx)); count++;
		}
		await safety.check("read", { path: "canon/world.md" }, ctx); count++;
		await writeFile(metadata, "{ malformed");
		assert.equal(await raw.extensions[0].handlers.get("tool_call")[0]({ toolName: "write", input: { path: SDK_TARGET, content: "x" } }, ctx), undefined); count++;
		for (const tool of ["write", "read", "read_story_document"]) { await assert.rejects(safety.check(tool, { path: "canon/world.md" }, ctx)); count++; }
		await writeFile(metadata, JSON.stringify({ formatVersion: 1 }));
		await assert.rejects(safety.check("bash", { path: "canon/world.md" }, ctx)); count++;
		// A non-security baseline bug is intentionally retained, not laundered into a safety fix.
		const current = raw.extensions[0].tools.get("get_current_document").definition;
		const oldParser = await current.execute("parser", {}, undefined, undefined, { ...ctx, sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "<novel-context>\nRead these references:\n\n### canon/world.md\ncontentType: canon\nreason: active document\nactive_document: true\n</novel-context>" } }] } });
		assert.ok(oldParser.content.some((part: any) => part.text?.includes("did not supply an active document"))); count++;
		for (const profile of SDK_PROFILES) {
			const source = sdkExtensionSource(profile), filename = path.join(directory, `${profile}.ts`); await writeFile(filename, source);
			const loaded = await loadSdkExtension(filename, project); auditSdkInventory(profile, loaded, source); count++;
			const extension = loaded.extensions[0];
			for (const event of ["session_before_compact", "session_compact", "before_provider_request", "turn_end"]) {
				extension.handlers.set(event, [() => undefined]); assert.throws(() => auditSdkInventory(profile, loaded, source)); extension.handlers.delete(event); count++;
			}
			extension.handlers.get("context").push(() => undefined); assert.throws(() => auditSdkInventory(profile, loaded, source)); extension.handlers.get("context").pop(); count++;
			extension.tools.set("get_context_budget", {}); assert.throws(() => auditSdkInventory(profile, loaded, source)); extension.tools.delete("get_context_budget"); count++;
			assert.throws(() => auditSdkInventory(profile, loaded, source + "\n// injected callback")); count++;
			await assert.rejects(extension.tools.get("read_story_document").definition.execute("unsafe", { path: "canon/linked/sentinel.md" }, undefined, undefined, ctx)); count++;
			await writeFile(metadata, "{}");
			const blocked = await extension.handlers.get("tool_call")[0]({ toolName: "write", input: { path: SDK_TARGET } }, ctx);
			assert.equal(blocked.block, true); count++; await writeFile(metadata, JSON.stringify({ formatVersion: 1 }));
			if (profile === "sdk-b1-reliability") {
				await mkdir(path.join(project, "drafts/candidates"), { recursive: true });
				const binding = (sessionId: string, role = "write") => ({ getSessionId: () => sessionId, getBranch: () => [{ type: "custom", customType: "pi-desktop-novel-role", data: { role } }] });
				const scoped = { cwd: project, sessionManager: binding("synthetic-session") };
				const writeHook = extension.handlers.get("tool_call").at(-1), resultHook = extension.handlers.get("tool_result")[0];
				const input = { path: SDK_TARGET, content: "boundary-write" };
				assert.equal((await writeHook({ toolName: "write", toolCallId: "inactive", input }, scoped)).block, true); count++;
				const metrics = (globalThis as any)[Symbol.for("pi.sdk-ablation.metrics")];
				for (const boundary of ["session", "project", "role", "generation"] as const) {
					await extension.handlers.get("agent_start")[0]({}, scoped);
					const currentInput = { ...input, content: boundary };
					assert.equal(await writeHook({ toolName: "write", toolCallId: boundary, input: currentInput }, scoped), undefined);
					await writeFile(path.join(project, SDK_TARGET), boundary);
					const stale = boundary === "session" ? { ...scoped, sessionManager: binding("other-session") } : boundary === "project" ? { ...scoped, cwd: outside }
						: boundary === "role" ? { ...scoped, sessionManager: binding("synthetic-session", "plan") } : scoped;
					if (boundary === "generation") await extension.handlers.get("agent_start")[0]({}, scoped);
					const previous = metrics.staleResults;
					await resultHook({ toolName: "write", toolCallId: boundary, isError: true }, stale);
					assert.equal(metrics.staleResults, previous + 1); count++;
				}
				await extension.handlers.get("session_switch")[0]({}, scoped);
				assert.equal((await writeHook({ toolName: "write", toolCallId: "after-switch", input }, scoped)).block, true); count++;
				await extension.handlers.get("agent_start")[0]({}, scoped);
				const reconciled = await writeHook({ toolName: "write", toolCallId: "after-restart", input: { ...input, content: "generation" } }, scoped);
				assert.equal(reconciled.block, true); assert.match(reconciled.reason, /reconciled/); count++;
			}
		}
		const guard = (globalThis as any)[Symbol.for("pi.eval.networkGuard")]; const start = guard.attempts;
		await assert.rejects(async () => fetch("https://sdk-s1.invalid")); count++;
		assert.throws(() => spawnSync(process.execPath, ["--version"])); count++;
		assert.equal(guard.attempts - start, 2); count++;
		return count;
	} finally { await assertInside(process.env.PI_ABLATION_WORK_ROOT!, directory); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
}

export async function runSdkTests(): Promise<number> {
	let count = 0;
	console.log("SDK tests: provenance and safety");
	await validateSdkProvenance(); count += checkBaselineGitObjects();
	const unit = spawnSync(process.execPath, ["--import", pathToFileURL(path.resolve("scripts/eval-network-guard.mjs")).href, process.env.PI_ABLATION_BUNDLE!, "unit-worker"],
		{ env: { ...process.env, PI_EVAL_WORKER: "1" }, cwd: process.cwd(), encoding: "utf8", timeout: 30000, windowsHide: true });
	assert.equal(unit.status, 0, "SDK_UNIT_FAILED");
	const match = unit.stdout.trim().match(/^SDK_UNIT_PASS (\d+)$/); assert.ok(match); count += Number(match[1]);
	console.log("SDK tests: SDK fault scenarios");
	for (const profile of SDK_PROFILES) {
		const readback = await runSdkWorker(profile, "P5A-TOOL-001", { scenario: "readback" });
		console.log(JSON.stringify({ profile, scenario: "readback", status: readback.status, reason: readback.reasonCode, checks: readback.checks, metrics: readback.metrics }));
		assert.equal(readback.status, "pass"); assert.equal(readback.metrics.writeDispatches, 1); count++;
		const transient = await runSdkWorker(profile, "P5A-READ-001", { scenario: "transient-read" });
		assert.equal(transient.status, profile === "sdk-b1-reliability" ? "pass" : "fail");
		assert.equal(transient.metrics.readRetries, profile === "sdk-b1-reliability" ? 1 : 0); count++;
		for (const [scenario, reason, requests] of [["missing-usage", "SDK_USAGE_MISSING", 1], ["request-limit", "SDK_LIMIT", 1], ["cancel", "SDK_CANCELLED", 0], ["forbidden-tool", "SDK_TOOL_DENIED", 1], ["forbidden-path", "SDK_PATH_DENIED", 1]] as const) {
			const result = await runSdkWorker(profile, "P5A-READ-001", { scenario });
			assert.notEqual(result.status, "pass"); assert.equal(result.reasonCode, reason); assert.equal(result.metrics.syntheticInvocations, requests); assert.equal(result.metrics.writeDispatches, 0); count++;
			if (scenario === "missing-usage") { assert.equal(result.syntheticUsage, null); count++; }
		}
		const unknown = await runSdkWorker(profile, "P5A-TOOL-001", { scenario: "unknown-write" });
		assert.notEqual(unknown.status, "pass");
		assert.equal(unknown.metrics.writeDispatches, profile === "sdk-b1-reliability" ? 1 : 2); count++;
	}
	const { directory, aggregate } = await runSdkBatch();
	assert.equal(aggregate.runCount, 12); assert.ok(aggregate.groups.every(group => group.deterministic)); count++;
	const before = await treeManifest(directory); assert.deepEqual(await rebuildSdkBatch(directory), aggregate); assert.deepEqual(await treeManifest(directory), before); count++;
	const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
	const index = JSON.parse(await readFile(path.join(directory, "result-index.json"), "utf8"));
	const files = new Map<string, string>();
	for (const entry of index.entries) files.set(entry.file, await readFile(path.join(directory, entry.file), "utf8"));
	const negative = JSON.parse(files.get(index.entries.find((entry: any) => entry.runId === "sdk-b0-safety-fixed-P5A-TOOL-001-r1").file)!);
	assert.equal(expectedSdkOutcome(negative.run.profile, negative.run.taskId, negative.result), true); count++;
	for (const key of ["files", "role", "settings", "limits", "read"] as const) {
		const bad = structuredClone(negative.result); bad.checks[key] = false;
		assert.equal(expectedSdkOutcome(negative.run.profile, negative.run.taskId, bad), false); count++;
	}
	for (const mutation of [
		(m: any) => { m.policy.limits.realModelRequests = 1; }, (m: any) => { m.runs.pop(); }, (m: any) => { m.runs[1] = m.runs[0]; },
		(m: any) => { m.code.sha256 = "0".repeat(64); }, (m: any) => { m.secret = "private-canary"; },
		(m: any) => { m.code.files["../private"] = "0".repeat(64); }, (m: any) => { const keys = Object.keys(m.prepared); m.prepared[keys[2]].toolsSha256 = "0".repeat(64); },
	]) { const bad = structuredClone(manifest); mutation(bad); assert.throws(() => validateSdkManifest(bad)); count++; }
	for (const mutation of [(i: any) => { i.entries.pop(); }, (i: any) => { i.entries[1] = i.entries[0]; }, (i: any) => { i.entries[0].file = "../private"; }, (i: any) => { i.manifestSha256 = "0".repeat(64); }]) {
		const bad = structuredClone(index); mutation(bad); assert.throws(() => sdkAggregate(manifest, bad, files)); count++;
	}
	const first = index.entries[0];
	for (const [name, body] of [["extra.json", "{}"], [first.file, "{"]]) { const bad = new Map(files); bad.set(name, body); assert.throws(() => sdkAggregate(manifest, index, bad)); count++; }
	const missing = new Map(files); missing.delete(first.file); assert.throws(() => sdkAggregate(manifest, index, missing)); count++;
	const raw = JSON.parse(files.get(first.file)!);
	for (const mutation of [(r: any) => { r.checks.files = false; }, (r: any) => { r.metrics.realHttpDispatches = 1; }, (r: any) => { r.metrics.syntheticInvocations = 7; },
		(r: any) => { r.syntheticUsage = null; }, (r: any) => { r.rawAnswer = "private-canary"; }, (r: any) => { r.answerCode = "PRIVATE_MESSAGE"; }]) {
		const bad = structuredClone(raw.result); mutation(bad); assert.throws(() => validateSdkResult(bad)); count++;
	}
	const leaked = structuredClone(raw); leaked.result.metrics.readRetries = 1;
	const leakedText = JSON.stringify(leaked); const leakedIndex = structuredClone(index); leakedIndex.entries[0].sha256 = sha256(leakedText);
	const leakedFiles = new Map(files); leakedFiles.set(first.file, leakedText); assert.throws(() => sdkAggregate(manifest, leakedIndex, leakedFiles)); count++;
	// A missing child receipt is not zero writes or zero usage, even if the process exited.
	const unknownRaw = structuredClone(raw); unknownRaw.result = emptySdkResult("SDK_WORKER_FAILED");
	validateSdkResult(unknownRaw.result); assert.equal(unknownRaw.result.metrics, null); count++;
	const unknownText = JSON.stringify(unknownRaw), unknownFiles = new Map(files), unknownIndex = structuredClone(index);
	unknownFiles.set(first.file, unknownText); unknownIndex.entries[0].sha256 = sha256(unknownText);
	const unknownGroup = sdkAggregate(manifest, unknownIndex, unknownFiles).groups[0];
	assert.equal(unknownGroup.missingMetrics, 1); assert.equal(unknownGroup.writeDispatches, null); assert.equal(unknownGroup.syntheticInvocations, null); count++;
	assert.ok(!(await readdir(process.env.PI_ABLATION_WORK_ROOT!)).some(name => name.startsWith("task-") || name.startsWith("unit-"))); count++;
	assert.equal(digest(await treeManifest(path.resolve("fixtures/harness-novel"))), manifest.fixture.sha256); count++;
	console.log(`SDK S1 retained batch: ${path.relative(process.cwd(), directory)}`);
	return count;
}
