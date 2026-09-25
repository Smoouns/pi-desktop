/** Complete production extension + pinned provider serializers/parsers + a
 * loopback-only HTTP outlet. No provider response replacement or real auth.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthStorage, ModelRegistry, SessionManager, SettingsManager, createAgentSession, type ResourceLoader } from "@mariozechner/pi-coding-agent";
import { loadExtensions } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";
import { NOVEL_TOOLS_EXTENSION_CONTENT } from "../../src/extensions/novel-tools-extension.js";
import { createTaskSubmission } from "../../src/novel/task-submission.js";
import { fixtureRoot, treeManifest, sha256 } from "./testkit.js";
import { listenForFetch } from "../support/loopback-http.js";

const parent = path.resolve("artifacts/harness/task-transport"); await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "e4-"));
const fixtureBefore = await treeManifest(fixtureRoot), sourceBefore = await treeManifest(path.resolve("src"));
const cases: any[] = [], requests: Array<{ phase: string; bytes: number; api: string; status: number; untrustedSummary: boolean; hardConstraint: boolean }> = [];
let phase = "ordinary", responseMode = "normal", retried = false, serverFailures = 0, blockedExternal = 0;
const firstText = "Public first chunk. ";
const summarySentinel = "SYNTHETIC_UNTRUSTED_SUMMARY_CANON_APPROVED";
const openaiBody = (missing = false) => {
	const chunk = (choices: any[], usage?: any) => `data: ${JSON.stringify({ id: "synthetic-e3", object: "chat.completion.chunk", created: 0, model: "offline", choices, ...(usage ? { usage } : {}) })}\n\n`;
	return chunk([{ index: 0, delta: { role: "assistant", content: responseMode === "lossy-summary" ? summarySentinel : firstText + "Public summary context. ".repeat(10) }, finish_reason: null }])
		+ chunk([{ index: 0, delta: {}, finish_reason: "stop" }])
		+ (missing ? "" : chunk([], { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } })) + "data: [DONE]\n\n";
};
const googleBody = () => `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: firstText }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15, cachedContentTokenCount: 2 } })}\n\n`;
let managerForReservation: SessionManager | undefined;
const server = http.createServer((request, response) => {
	const chunks: Buffer[] = []; let bytes = 0;
	request.on("data", chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { serverFailures++; request.destroy(); } else chunks.push(chunk); });
	request.on("end", () => {
		try {
			const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			assert.ok(Array.isArray(payload.messages) || Array.isArray(payload.contents));
			// This is inside the HTTP server, not a simulated fetch callback.
			const reservation = readReservation();
			assert.ok(reservation?.pending.some((item: any) => item.attempts.length > 0), "DISPATCH_RESERVATION_NOT_DURABLE");
			const api = request.url?.includes("streamGenerateContent") ? "google" : "openai";
			const fail = responseMode === "error" || (responseMode === "retry" && !retried);
			const serialized = JSON.stringify(payload);
			requests.push({ phase, bytes, api, status: fail ? 500 : 200, untrustedSummary: serialized.includes(summarySentinel), hardConstraint: serialized.includes("PUBLIC_DO_NOT_CHANGE_CANON") });
			if (fail) { retried = true; response.writeHead(500, { "content-type": "application/json", "retry-after-ms": "1" }); response.end('{"error":{"message":"synthetic server failure","type":"server_error"}}'); return; }
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (responseMode === "hold") {
				response.write(`data: ${JSON.stringify({ id: "held", object: "chat.completion.chunk", created: 0, model: "offline", choices: [{ index: 0, delta: { role: "assistant", content: firstText }, finish_reason: null }] })}\n\n`);
			} else response.end(api === "google" ? googleBody() : openaiBody(responseMode === "missing"));
		} catch { serverFailures++; response.writeHead(500); response.end("SYNTHETIC_TEST_FAILURE"); }
	});
});
// Server-side evidence reads are synchronous so reservation verification occurs
// before acknowledging the first response byte.
import { readFileSync } from "node:fs";
const readReservation = () => {
	const manager = managerForReservation!, file = manager.getSessionFile()!;
	const mirrored = [...manager.getBranch()].reverse().find((entry: any) => entry.customType === "pi-desktop-transport-ledger/v1") as any;
	assert.ok(mirrored, "NO_SESSION_MIRROR");
	const key = sha256(JSON.stringify([path.basename(file), mirrored.data.owner]));
	const raw = JSON.parse(readFileSync(path.join(path.dirname(file), ".pi-desktop-transport", key + ".json"), "utf8"));
	assert.equal(raw.key, key); assert.deepEqual(raw.record, mirrored.data);
	return raw.record;
};
const { origin } = await listenForFetch(server);
const originalFetch = globalThis.fetch;
// Installed before production transport. Never fall back to provider Internet.
globalThis.fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.origin !== origin) { blockedExternal++; throw Error("E3_EXTERNAL_NETWORK_DENIED"); }
	return originalFetch(input, { ...init, redirect: "error" });
};

async function open(work: string, api: "openai-completions" | "google-generative-ai", options: { sessionFile?: string; inflate?: boolean; keepRecentTokens?: number } = {}) {
	const project = path.join(work, "project"), agentDir = path.join(work, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await mkdir(agentDir, { recursive: true }); await mkdir(path.join(project, ".pi"), { recursive: true });
	const settingsText = JSON.stringify({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: options.keepRecentTokens ?? 64 }, retry: { enabled: false }, enableSkillCommands: false });
	await writeFile(path.join(project, ".pi/settings.json"), settingsText); await writeFile(path.join(agentDir, "settings.json"), settingsText);
	const extensionPath = path.join(agentDir, "novel-tools.ts"); await writeFile(extensionPath, NOVEL_TOOLS_EXTENSION_CONTENT);
	const loaded = await loadExtensions([extensionPath], project); assert.deepEqual(loaded.errors, []);
	if (options.inflate) loaded.extensions[0].handlers.get("before_provider_request")!.push((event: any) => {
		// Another hook mutates AFTER the production payload audit; genuine client
		// serialization must still hit the final sending-layer gate.
		if (api === "openai-completions") event.payload.messages.push({ role: "user", content: "X".repeat(500_000) });
		else event.payload.contents.push({ role: "user", parts: [{ text: "X".repeat(500_000) }] });
		return event.payload;
	});
	const resources: ResourceLoader = { getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "Public loopback fixture. Reply only. No tool calls.", getAppendSystemPrompt: () => [], extendResources: () => undefined, reload: async () => undefined };
	const manager = options.sessionFile ? SessionManager.open(options.sessionFile, path.join(agentDir, "sessions")) : SessionManager.create(project, path.join(agentDir, "sessions"));
	if (!options.sessionFile) manager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
	managerForReservation = manager;
	const model: any = { id: "offline", name: "Offline", api, provider: "synthetic-transport", baseUrl: origin, reasoning: false, input: ["text"], contextWindow: 65_536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const auth = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "synthetic-no-credential" } });
	const settings = SettingsManager.create(project, agentDir);
	const { session } = await createAgentSession({ cwd: project, agentDir, model, thinkingLevel: "off", authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "disabled-models.json")), tools: [], settingsManager: settings, sessionManager: manager, resourceLoader: resources });
	const errors: any[] = [], notices: string[] = [];
	await session.bindExtensions({ onError: error => errors.push(error), uiContext: { notify: (message: string) => notices.push(message), setStatus: () => undefined, setEditorText: () => undefined } as any });
	const budget = async () => {
		const before = notices.length;
		await session.prompt("/novel-transport-status json");
		assert.equal(notices.length, before + 1, "read-only status command responds even when task stopped");
		const { calibration, ...taskTransport } = JSON.parse(notices.at(-1)!);
		return { taskTransport, calibration };
	};
	return { session, manager, model, errors, notices, budget, async prompt(text: string) { await session.prompt(text); await (session as any)._agentEventQueue; },
		async close() { await (session as any)._extensionRunner.emit({ type: "session_shutdown" }); session.dispose(); await settings.flush(); } };
}
const declare = (id: string) => createTaskSubmission().encode("只回复，后续摘要仍属于同一任务。" + "公开测试历史。".repeat(120), { version: 1, taskId: id, role: "write", completionMode: "reply_only", expectedArtifacts: [] });
async function run(name: string, body: (work: string, start: number) => Promise<any>) {
	const work = path.join(output, name); await cp(fixtureRoot, path.join(work, "project"), { recursive: true });
	phase = "ordinary"; responseMode = "normal"; retried = false;
	const start = requests.length;
	try { const details = await body(work, start); cases.push({ name, pass: true, requests: requests.slice(start), ...details }); console.log(`PASS transport-sdk.${name}`); }
	catch (error) { cases.push({ name, pass: false, error: (error as Error).message, requests: requests.slice(start) }); console.error(`FAIL transport-sdk.${name}`, error); }
}
try {
	for (const api of ["openai-completions", "google-generative-ai"] as const) {
		await run(`${api}-summary-restore`, async (work, start) => {
			let s = await open(work, api);
			try {
				await s.prompt(declare("summary-task"));
				const matched = (await s.budget()).calibration;
				assert.equal(matched.anchorCount, 1); assert.equal(matched.samples.at(-1).sdkInputTokens, 12, "cache input included, output excluded");
				assert.equal(matched.samples.at(-1).rawRequestBytes, requests.at(-1)!.bytes); assert.equal(matched.appliedToBudget, false);
				phase = "summary"; await s.session.compact(); await (s.session as any)._agentEventQueue;
				const compacted = (await s.budget()).calibration;
				assert.equal(compacted.anchorCount, 0); assert.equal(compacted.lastInvalidation, "compaction_completed");
				assert.ok(compacted.samples.some((sample: any) => sample.kind === "summary" && sample.eligible && sample.sdkInputTokens === 12));
				phase = "ordinary"; await s.prompt("继续，只回复。");
				assert.equal((await s.budget()).calibration.samples.at(-1).anchoredInputEstimate, null, "no pre-compaction anchor reuse");
				const before = (await s.budget()).taskTransport;
				const expected = requests.slice(start); assert.equal(before.counters.dispatchAttempts, expected.length);
				assert.equal(before.counters.summary, expected.filter(row => row.phase === "summary").length); assert.ok(before.counters.summary >= 1);
				assert.equal(before.counters.ordinary, 2); assert.equal(before.sdkUsage.totals.totalTokens, expected.length * 15);
				assert.equal(before.sdkUsage.costUsd, null); assert.equal(before.sdkUsage.cacheBreakdownVerified, false); assert.equal(before.counters.requestBytes, expected.reduce((n, row) => n + row.bytes, 0));
				assert.deepEqual(s.errors, []);
				const file = s.manager.getSessionFile()!; await s.close(); s = await open(work, api, { sessionFile: file });
				const restored = (await s.budget()).taskTransport; assert.deepEqual(restored, before, "cold extension/session reload retains exact scoped task counters");
				assert.deepEqual((await s.budget()).calibration.samples, []); assert.equal((await s.budget()).calibration.anchorCount, 0);
				return { counters: before.counters, restored: true, totals: before.sdkUsage.totals, matched, compacted, calibrationColdReset: true };
			} finally { await s.close(); }
		});
		await run(`${api}-late-inflation`, async (work, start) => {
			const s = await open(work, api, { inflate: true });
			try {
				await s.prompt(declare("inflate-task")); const budget = await s.budget();
				assert.equal(requests.length, start, "late serialized inflation must produce zero HTTP at server");
				assert.ok(budget.taskTransport.counters.blockedBeforeDispatch >= 1); assert.equal(budget.taskTransport.counters.dispatchAttempts, 0);
				assert.equal(budget.taskTransport.sdkUsage.totals.input, null); assert.ok(s.notices.some(value => value.includes("发送前阻止")));
				return { counters: budget.taskTransport.counters, zeroHttp: true };
			} finally { await s.close(); }
		});
		await run(`${api}-native-branch-summary`, async (work, start) => {
			const s = await open(work, api);
			try {
				await s.prompt(declare("branch-task"));
				const target = s.manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant")!;
				await s.prompt("另一段公开测试历史。".repeat(50)); phase = "branchSummary";
				const navigation = await s.session.navigateTree(target.id, { summarize: true });
				await (s.session as any)._agentEventQueue; assert.equal(navigation.cancelled, false);
				const result = (await s.budget()).taskTransport;
				assert.equal(result.counters.ordinary, 2, "abandoned branch attempts cannot be rolled back");
				assert.equal(result.counters.branchSummary, 1); assert.equal(requests.length - start, 3); assert.equal(result.counters.dispatchAttempts, 3);
				assert.equal(result.sdkUsage.totals.totalTokens, 45); assert.deepEqual(s.errors, []);
				return { counters: result.counters, abandonedBranchCounted: true };
			} finally { await s.close(); }
		});
		await run(`${api}-summary-budget-gate`, async (work, start) => {
			// Force the SDK's history summarizer, which accepts customInstructions.
			// Its separate turn-prefix summarizer intentionally ignores that field.
			const s = await open(work, api, { keepRecentTokens: 100_000 });
			try {
				await s.prompt(declare("summary-budget-task")); const ordinaryCount = requests.length;
				phase = "summary"; await assert.rejects(s.session.compact("X".repeat(500_000)));
				await (s.session as any)._agentEventQueue;
				const result = (await s.budget()).taskTransport;
				assert.equal(ordinaryCount - start, 1); assert.equal(requests.length, ordinaryCount, "over-budget native summary must never reach HTTP outlet");
				assert.equal(result.counters.summary, 1); assert.ok(result.counters.blockedBeforeDispatch >= 1); assert.equal(result.sdkUsage.costUsd, null);
				return { counters: result.counters, summaryZeroHttp: true };
			} finally { await s.close(); }
		});
		await run(`${api}-corrupt-journal`, async (work, start) => {
			let s = await open(work, api);
			try {
				await s.prompt(declare("corrupt-transport-task"));
				const before = (await s.budget()).taskTransport, sessionFile = s.manager.getSessionFile()!;
				const key = sha256(JSON.stringify([path.basename(sessionFile), before.owner]));
				await s.close();
				await writeFile(path.join(path.dirname(sessionFile), ".pi-desktop-transport", key + ".json"), "{corrupt");
				s = await open(work, api, { sessionFile }); await s.prompt("继续同一任务，只回复。");
				assert.equal(requests.length - start, 1, "journal binding failure must prevent a second HTTP request even when SDK swallows payload-hook errors");
				assert.ok(s.notices.some(text => text.includes("计量记录无法安全保存")));
				assert.deepEqual(s.errors.map(({ event, error }) => ({ event, error })), [{ event: "before_provider_request", error: "TRANSPORT_JOURNAL_FAILURE" }]);
				return { corruptJournalZeroHttp: true, oldRecordNotReset: true };
			} finally { await s.close(); }
		});
	}
	await run("native-client-retry", async (work, start) => {
		const s = await open(work, "openai-completions"); responseMode = "retry";
		try {
			await s.prompt(declare("retry-task")); const result = (await s.budget()).taskTransport;
			assert.equal(requests.length - start, 2); assert.equal(result.counters.ordinary, 1); assert.equal(result.counters.redispatches, 1); assert.equal(result.counters.httpErrors, 1); assert.equal(result.counters.dispatchAttempts, 2);
			assert.equal(result.sdkUsage.totals.totalTokens, 15); assert.equal(result.sdkUsage.costUsd, null);
			const diagnostic = (await s.budget()).calibration; assert.equal(diagnostic.anchorCount, 0); assert.equal(diagnostic.samples.at(-1).reason, "ambiguous_send_count");
			return { counters: result.counters, retryPolicyUnchanged: true };
		} finally { await s.close(); }
	});
	await run("cancel-after-first-chunk", async (work, start) => {
		const s = await open(work, "openai-completions"); responseMode = "hold";
		try {
			let first!: () => void; const firstSeen = new Promise<void>(resolve => { first = resolve; });
			const unsubscribe = s.session.subscribe(event => { if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") first(); });
			const pending = s.prompt(declare("cancel-task")); let timer: ReturnType<typeof setTimeout> | undefined;
			try { await Promise.race([firstSeen, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("FIRST_CHUNK_TIMEOUT")), 15_000); })]); }
			finally { clearTimeout(timer); unsubscribe(); await s.session.abort(); await pending; }
			const result = (await s.budget()).taskTransport;
			assert.equal(requests.length - start, 1); assert.equal(result.counters.aborted, 1); assert.equal(result.sdkUsage.totals.input, null); assert.equal(result.counters.bodiesUnknown, 1);
			return { counters: result.counters, firstChunkBeforeEnd: true };
		} finally { await s.close(); }
	});
	await run("missing-usage", async (work, start) => {
		const s = await open(work, "openai-completions"); responseMode = "missing";
		try { await s.prompt(declare("missing-task")); const result = (await s.budget()).taskTransport; assert.equal(requests.length - start, 1); assert.equal(result.counters.unknownUsageResponses, 1); assert.equal(result.sdkUsage.totals.input, null); assert.equal(result.sdkUsage.costUsd, null);
			const diagnostic = (await s.budget()).calibration; assert.equal(diagnostic.anchorCount, 0); assert.equal(diagnostic.samples.at(-1).reason, "usage_missing_or_invalid");
			return { counters: result.counters, unknownNotFree: true }; }
		finally { await s.close(); }
	});
	await run("failed-native-summary", async (work, start) => {
		const s = await open(work, "openai-completions");
		try {
			await s.prompt(declare("failed-summary-task")); phase = "summary"; responseMode = "error";
			await assert.rejects(s.session.compact()); await (s.session as any)._agentEventQueue;
			const result = (await s.budget()).taskTransport;
			assert.equal(result.counters.dispatchAttempts, requests.length - start); assert.ok(result.counters.summary >= 1); assert.ok(result.counters.errors >= 1);
			assert.equal(result.sdkUsage.totals.input, null); assert.equal(result.sdkUsage.knownSubtotals.totalTokens, 15);
			return { counters: result.counters, failedSummaryCounted: true };
		} finally { await s.close(); }
	});
	await run("lossy-summary-three-cycles", async (work, start) => {
		const s = await open(work, "openai-completions"); const canon = await treeManifest(path.join(work, "project/canon"));
		try {
			await s.prompt(createTaskSubmission().encode("PUBLIC_DO_NOT_CHANGE_CANON 只读任务，不得修改正典。", { version: 1, taskId: "lossy-summary", role: "write", completionMode: "reply_only", expectedArtifacts: [] }));
			for (let cycle = 0; cycle < 3; cycle++) {
				phase = "summary"; responseMode = "lossy-summary"; await s.session.compact(); await (s.session as any)._agentEventQueue;
				assert.ok(s.manager.getBranch().some((entry: any) => entry.type === "compaction" && entry.summary.includes(summarySentinel)), "fixture really returned an untrusted native summary");
				phase = "ordinary"; responseMode = "normal"; await s.prompt("继续，仅答复。");
				assert.equal(requests.at(-1)!.untrustedSummary, false, "native prose summary cannot grant Canon authority");
				assert.equal(requests.at(-1)!.hardConstraint, true, "exact user constraint still delivered after every cycle");
				assert.equal((await s.budget()).calibration.samples.at(-1).anchoredInputEstimate, null);
			}
			assert.deepEqual(await treeManifest(path.join(work, "project/canon")), canon); assert.deepEqual(s.errors, []);
			return { cycles: 3, constraintsRetained: true, untrustedSummaryNotAuthority: true, canonUnchanged: true, semanticQuality: "not-measured", requestsCount: requests.length - start };
		} finally { await s.close(); }
	});
	assert.equal(serverFailures, 0); assert.equal(blockedExternal, 0);
} finally {
	server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); globalThis.fetch = originalFetch;
	assert.deepEqual(await treeManifest(fixtureRoot), fixtureBefore); assert.deepEqual(await treeManifest(path.resolve("src")), sourceBefore);
	const summary = { version: 1, modelCalls: 0, loopbackHttpRequests: requests.length, blockedExternal, serverFailures, sourceManifest: sourceBefore,
		extensionSha256: sha256(NOVEL_TOOLS_EXTENSION_CONTENT), sdk: JSON.parse(await readFile("node_modules/@mariozechner/pi-coding-agent/package.json", "utf8")).version,
		cases, boundary: "Complete production extension and actual pinned SDK provider clients to one loopback server; synthetic SSE only. Session/extension reload is not a new OS process. No real models, private projects, global Pi settings or Desktop/Rust/remote CI acceptance." };
	await writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
	console.log(`Transport SDK evidence: ${output}`);
}
assert.equal(cases.length, 15); assert.equal(cases.filter(item => !item.pass).length, 0);
