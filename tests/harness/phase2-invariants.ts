import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withLoadedExtension } from "./contracts.js";
import { withProject, type RunCase } from "./testkit.js";

const context = (cwd: string, role = "write", sessionId = "phase2-invariants") => ({ cwd, sessionManager: {
	getSessionId: () => sessionId,
	getBranch: () => [{ type: "custom", customType: "pi-desktop-novel-role", data: { role } }],
} });

const text = (result: any): string => result.content
	.filter((part: any) => part.type === "text")
	.map((part: any) => part.text)
	.join("\n");

async function typedFailure(pending: Promise<unknown>, kind = "precondition", code?: string): Promise<any> {
	let caught: any;
	try { await pending; } catch (error) { caught = error; }
	assert.ok(caught instanceof Error, "budget failures must be thrown through the Pi wrapper");
	assert.match(caught.message, /<tool-error>/);
	const result = (caught as Error & { toolResult?: any }).toolResult;
	assert.equal(result?.isError, true);
	assert.equal(result?.details?.harness?.error?.kind, kind);
	if (code) assert.equal(result.details.harness.error.code, code);
	return result;
}

function budgetReport(result: any): any {
	return JSON.parse(text(result));
}

export async function runPhase2InvariantCases(runCase: RunCase): Promise<void> {
	await runCase("P2-INVARIANT cumulative output budget charges duplicate reads", (record) => withProject(async (root) => {
		// Keep each result inline but large enough to exhaust 64 KiB in roughly 60
		// calls. The source and observation ID are intentionally identical.
		await writeFile(path.join(root, "canon/world.md"), `# 累计输出测试\n\n${"重复证据。".repeat(60)}\n`, "utf8");
		await withLoadedExtension(root, false, async (extension) => {
			const read = extension.tools.get("read_story_document")!.definition;
			const ctx = context(root);
			let successes = 0;
			let observationId = "";
			for (; successes < 100; successes += 1) {
				try {
					const result: any = await read.execute(`duplicate-${successes}`, { path: "canon/world.md" }, undefined, undefined, ctx as never);
					const id = result.details?.observation?.id;
					assert.ok(id);
					if (observationId) assert.equal(id, observationId, "deduplication must not reset cumulative output accounting");
					observationId = id;
				} catch (error) {
					const failure = await typedFailure(Promise.reject(error), "precondition", "OUTPUT_BUDGET");
					assert.match(text(failure), /累计预算已用尽/);
					break;
				}
			}
			assert.ok(successes >= 45 && successes <= 80, `expected an approximately 60-read boundary, got ${successes}`);
			record("phase2.output_cumulative", { successfulReads: successes, duplicateObservation: true, typedFailure: true });
		});
	}));

	await runCase("P2-INVARIANT read exhaustion is sticky and memory cannot partially succeed", (record) => withProject(async (root) => {
		const oneMegabyte = "x".repeat(1_000_000);
		await writeFile(path.join(root, "canon/large-budget-source.md"), oneMegabyte, "utf8");
		await withLoadedExtension(root, false, async (extension) => {
			const ctx = context(root);
			const read = extension.tools.get("read_story_document")!.definition;
			const inspect = extension.tools.get("get_context_budget")!.definition;
			let successfulReads = 0;
			for (; successfulReads < 32; successfulReads += 1) {
				try {
					const result: any = await read.execute(`large-${successfulReads}`, { path: "canon/large-budget-source.md" }, undefined, undefined, ctx as never);
					assert.equal(result.details?.offloaded, true);
					assert.ok(text(result).length < 6_000, "large source must be represented by an observation reference");
				} catch (error) {
					await typedFailure(Promise.reject(error), "precondition", "READ_BUDGET");
					break;
				}
			}
			assert.ok(successfulReads >= 15 && successfulReads <= 16, `one-megabyte reads should approach the 16 MiB boundary, got ${successfulReads}`);
			await typedFailure(read.execute("small-after-over", { path: "canon/world.md" }, undefined, undefined, ctx as never), "precondition", "READ_BUDGET");
			await typedFailure(
				extension.tools.get("search_story_memory")!.definition.execute("memory-after-over", { query: "白潮" }, undefined, undefined, ctx as never),
				"precondition",
				"READ_BUDGET",
			);
			const report = budgetReport(await inspect.execute("inspect-read-budget", {}, undefined, undefined, ctx as never));
			assert.equal(report.run.readUsed, successfulReads * 1_000_000);
			assert.equal(report.run.readLimit, 16 * 1024 * 1024);
			assert.ok(report.run.readUsed >= 15_000_000 && report.run.readUsed <= report.run.readLimit);
			assert.ok(report.run.availableRead > 0, "sticky exhaustion must not be confused with simple remaining-byte arithmetic");
			assert.equal(report.observations.records, 1, "failed large and memory reads must not commit partial observations");
			assert.equal(report.observations.accesses, successfulReads);
			assert.match(report.notes, /累计/);
			record("phase2.read_sticky", { chargedBytes: report.run.readUsed, failedMemorySnapshot: true, partialObservation: false });
		});
	}));

	await runCase("P2-INVARIANT late native results cannot contaminate another project or role", (record) => withProject(async (projectA) => withProject(async (projectB) => {
		await withLoadedExtension(projectA, false, async (extension) => {
			const active = context(projectB, "write", "active-session");
			const read = extension.tools.get("read_story_document")!.definition;
			const inspect = extension.tools.get("get_context_budget")!.definition;
			await read.execute("active-evidence", { path: "canon/world.md" }, undefined, undefined, active as never);
			const beforeResult: any = await inspect.execute("inspect-before-late", {}, undefined, undefined, active as never);
			const before = budgetReport(beforeResult);
			const inspectionCharge = Buffer.byteLength(JSON.stringify(beforeResult.content), "utf8");
			const nativeResult = extension.handlers.get("tool_result")!.at(-1)!;
			const raw = "FOREIGN_NATIVE_RESULT".repeat(1_000);
			const event = { type: "tool_result", toolName: "read", toolCallId: "late-native", input: { path: "canon/world.md" }, content: [{ type: "text", text: raw }], isError: false, details: undefined };
			for (const foreign of [
				context(projectA, "write", "active-session"),
				context(projectB, "plan", "active-session"),
				context(projectB, "write", "foreign-session"),
			]) {
				assert.equal(await nativeResult(event, foreign as never), undefined);
				let aborted = false;
				await extension.handlers.get("before_provider_request")![0]({ type: "before_provider_request", payload: { messages: [raw] } }, {
					...foreign, model: { contextWindow: 32, maxTokens: 16 }, abort: () => { aborted = true; },
				} as never);
				assert.equal(aborted, false, "a late audit may not abort the current run");
			}
			const afterAudit = budgetReport(await inspect.execute("inspect-after-audit", {}, undefined, undefined, active as never));
			assert.equal(afterAudit.run.readUsed, before.run.readUsed);
			assert.ok(afterAudit.run.readUsed > 0, "late provider audit must not end and recreate the active run");
			const nativeCall = extension.handlers.get("tool_call")!.at(-1)!;
			await nativeCall({ type: "tool_call", toolName: "read", toolCallId: "old-same-scope", input: { path: "canon/world.md" } }, active as never);
			await extension.handlers.get("agent_start")![0]({ type: "agent_start" }, active as never);
			assert.equal(await nativeResult({ ...event, toolCallId: "old-same-scope" }, active as never), undefined, "an old native call id must not cross an agent run boundary");
			const after = budgetReport(await inspect.execute("inspect-after-late", {}, undefined, undefined, active as never));
			assert.equal(after.observations.records, before.observations.records, "the old result must not create a new observation");
			assert.equal(after.observations.accesses, before.observations.accesses, "the old result must not add an access receipt");
			assert.equal(after.run.readUsed, 0);
			assert.equal(after.run.outputUsed, 0, "the first inspection in a fresh run reports the pre-charge snapshot");
			assert.ok(inspectionCharge > 0 && before.run.outputUsed > 0);
			record("phase2.native_scope", { foreignProjects: 1, foreignRoles: 1, foreignSessions: 1, oldSameScopeRuns: 1, newObservations: 0 });
		});
	})));

	await runCase("P2-INVARIANT mixed image context aborts without mutation or text offload", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		let aborted = false;
		const ctx = {
			...context(root),
			model: { contextWindow: 1_000_000, maxTokens: 1_000 },
			getSystemPrompt: () => "SYSTEM_INTACT",
			abort: () => { aborted = true; },
			ui: { notify: () => undefined },
		};
		const tail = "MIXED_TEXT_TAIL";
		const image = { type: "image", data: "synthetic-image-bytes", mimeType: "image/png" };
		const messages: any[] = [{ role: "user", content: [{ type: "text", text: "large ".repeat(2_000) + tail }, image], timestamp: 0 }];
		const before = structuredClone(messages);
		const transformed: any = await extension.handlers.get("context")![0]({ type: "context", messages }, ctx as never);
		assert.equal(aborted, true);
		assert.deepEqual(messages, before, "stored mixed content must remain byte-for-byte equivalent structurally");
		assert.deepEqual(transformed.messages[0].content, before[0].content, "preflight must not offload or trim the user's mixed content");
		assert.match(JSON.stringify(transformed.messages[0]), new RegExp(tail));
		assert.deepEqual(transformed.messages[0].content[1], image);
		record("phase2.mixed_media", { aborted: true, originalTextPreserved: true, originalImagePreserved: true, preflightOffload: false });
	})));

	await runCase("P2-INVARIANT offloaded error result remains recoverable by observation id", (record) => withProject(async (root) => withLoadedExtension(root, false, async (extension) => {
		const ctx = context(root);
		const tail = "ERROR_RESULT_RECOVERY_TAIL";
		const raw = "synthetic error output ".repeat(600) + tail;
		const handler = extension.handlers.get("context")![0];
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "foreign-error", name: "third_party_tool", arguments: {} }], timestamp: 0 },
			{ role: "toolResult", toolCallId: "foreign-error", toolName: "third_party_tool", content: [{ type: "text", text: raw }], details: { duplicate: raw }, isError: true, timestamp: 0 },
		];
		const transformed: any = await handler({ type: "context", messages }, ctx as never);
		const compacted = transformed.messages[1];
		assert.doesNotMatch(JSON.stringify(compacted), new RegExp(tail));
		const match = /observation (obs_[A-Za-z0-9_-]+)/.exec(text(compacted));
		assert.ok(match?.[1], "offloaded error must expose an observation reference");
		const fetch = extension.tools.get("read_observation")!.definition;
		let start = 0;
		let recovered = "";
		for (let page = 0; page < 10; page += 1) {
			const result: any = await fetch.execute(`error-page-${page}`, { id: match[1], start, limit: 4_000 }, undefined, undefined, ctx as never);
			recovered += text(result);
			if (!result.details.hasMore) break;
			start += result.content[0].text.replace(/\n\[更多内容：[\s\S]*$/, "").length;
		}
		assert.match(recovered, new RegExp(tail));
		record("phase2.error_observation", { originalError: true, offloaded: true, recovered: true });
	})));
}
