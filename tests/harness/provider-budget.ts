import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentLoop } from "@mariozechner/pi-agent-core";
import { streamSimple, type Api, type Model } from "@mariozechner/pi-ai";
import {
	ExtensionRunner,
	loadExtensions,
} from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/index.js";
import { NOVEL_TOOLS_EXTENSION_CONTENT } from "../../src/extensions/novel-tools-extension.js";
import { closeLoopbackServer, listenForFetch } from "../support/loopback-http.js";
import { withProject, type RunCase } from "./testkit.js";

type RecordedRequest = { path: string; body: string };
type RunnerInterfaces = {
	getSystemPrompt?: () => unknown;
	getActiveTools?: () => unknown;
	getAllTools?: () => unknown;
};

async function withCountingServer<T>(body: (baseUrl: string, requests: RecordedRequest[]) => Promise<T>): Promise<T> {
	const requests: RecordedRequest[] = [];
	let started = 0, aborted = 0;
	const server = http.createServer((request, response) => {
		started++;
		request.on("aborted", () => { aborted++; });
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			requests.push({ path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
			// A non-retryable response is sufficient: these tests assert dispatch, not decoding.
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "scripted local response" } }));
		});
	});
	const address = await listenForFetch(server);
	try {
		const result = await body(address.origin, requests);
		assert.equal(started, requests.length, "Every received request must be accounted for, including incomplete bodies");
		assert.equal(aborted, 0, "Counting server must not conceal an aborted body");
		return result;
	} catch (error) {
		if (error instanceof Error) error.message += ` [loopback port=${address.port}; started=${started}; completed=${requests.length}; aborted=${aborted}; excludedBindings=${address.skippedPorts.length}]`;
		throw error;
	} finally {
		await closeLoopbackServer(server);
	}
}

async function loadRunner(
	project: string,
	getModel: () => Model<Api> | undefined,
	abort: () => void,
	interfaces: RunnerInterfaces = {},
) {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-provider-budget-"));
	const extensionPath = path.join(directory, "novel-tools.ts");
	await writeFile(extensionPath, NOVEL_TOOLS_EXTENSION_CONTENT, "utf8");
	const loaded = await loadExtensions([extensionPath], project);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const sessionManager = {
		getSessionId: () => "provider-budget-session",
		getBranch: () => [],
		getEntries: () => [],
		appendCustomEntry: () => undefined,
	};
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		project,
		sessionManager as never,
		{} as never,
	);
	const noop = () => undefined;
	runner.bindCore({
		sendMessage: noop,
		sendUserMessage: noop,
		appendEntry: noop,
		setSessionName: noop,
		getSessionName: () => undefined,
		setLabel: noop,
		getActiveTools: interfaces.getActiveTools ?? (() => []),
		getAllTools: interfaces.getAllTools ?? (() => []),
		setActiveTools: noop,
		refreshTools: noop,
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "off",
		setThinkingLevel: noop,
	} as never, {
		getModel,
		isIdle: () => false,
		abort,
		hasPendingMessages: () => false,
		shutdown: noop,
		getContextUsage: () => undefined,
		compact: noop,
		getSystemPrompt: interfaces.getSystemPrompt ?? (() => SYSTEM_SENTINEL),
	} as never);
	return { runner, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const SYSTEM_SENTINEL = "SYSTEM_MUST_REMAIN_INTACT";
const USER_SENTINEL = "USER_MUST_REMAIN_INTACT";

function model(api: "openai-completions" | "google-generative-ai", baseUrl: string, contextWindow: number): Model<any> {
	return {
		id: `synthetic-${api}`,
		name: `synthetic-${api}`,
		api,
		provider: "synthetic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		contextWindow,
		maxTokens: 32,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

async function exerciseProvider(
	api: "openai-completions" | "google-generative-ai",
	baseUrl: string,
	contextWindow: number,
	userText: string,
	options: { history?: unknown[]; interfaces?: RunnerInterfaces } = {},
): Promise<{ transformed: unknown[]; stopReason: string; errorMessage: string }> {
	const controller = new AbortController();
	let currentModel: Model<any> | undefined = model(api, baseUrl, contextWindow);
	const project = exerciseProvider.project;
	assert.ok(project);
	const { runner, cleanup } = await loadRunner(project, () => currentModel, () => controller.abort(), options.interfaces);
	let transformed: unknown[] = [];
	let stopReason = "";
	let errorMessage = "";
	try {
		await runAgentLoop(
			[{ role: "user", content: userText, timestamp: 0 }],
			{ systemPrompt: SYSTEM_SENTINEL, messages: (options.history ?? []) as never[], tools: [] },
			{
				model: currentModel,
				convertToLlm: (messages) => messages as never,
				transformContext: async (messages) => {
					transformed = await runner.emitContext(messages);
					return transformed as never;
				},
			},
			(event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					stopReason = event.message.stopReason;
					errorMessage = (event.message.errorMessage ?? "").replace(/http:\/\/127\.0\.0\.1:\d+/g, "<loopback>").slice(0, 512);
				}
			},
			controller.signal,
			(selectedModel, context, options) => streamSimple(selectedModel, context, {
				...options,
				apiKey: "synthetic-local-key",
				onPayload: async (payload) => runner.emitBeforeProviderRequest(payload),
			}),
		);
		return { transformed, stopReason, errorMessage };
	} finally {
		currentModel = undefined;
		await cleanup();
	}
}
exerciseProvider.project = "";

export async function runProviderBudgetCases(runCase: RunCase): Promise<void> {
	await runCase("P2-BUDGET real providers enforce pre-dispatch hard budget", (record) => withProject(async (project) => {
		exerciseProvider.project = project;
		for (const api of ["openai-completions", "google-generative-ai"] as const) {
			await withCountingServer(async (baseUrl, normalRequests) => {
				const normal = await exerciseProvider(api, baseUrl, 100_000, `${USER_SENTINEL}: short request`);
				assert.equal(normalRequests.length, 1, `${api} budgeted request must reach the provider once; ${normal.stopReason}: ${normal.errorMessage}`);
				assert.equal(normal.stopReason, "error");
				assert.match(normalRequests[0].body, new RegExp(SYSTEM_SENTINEL));
				assert.match(normalRequests[0].body, new RegExp(USER_SENTINEL));

				const oversizedUser = `${USER_SENTINEL}:` + " evidence".repeat(2_000);
				const before = normalRequests.length;
				const blocked = await exerciseProvider(api, baseUrl, 128, oversizedUser);
				assert.equal(normalRequests.length, before, `${api} over-budget request must be blocked before HTTP`);
				assert.equal(blocked.stopReason, "aborted");
				assert.equal((blocked.transformed[0] as { content?: string }).content, oversizedUser, "budget gate must not trim the user request");
				record("provider_budget", { api, normalHttpRequests: 1, blockedHttpRequests: 0, preservesSystem: true, preservesUser: true });
			});
		}
	}));

	await runCase("P2-BUDGET missing budget interfaces fail closed before provider HTTP", (record) => withProject(async (project) => {
		exerciseProvider.project = project;
		const brokenInterfaces: Array<readonly [string, RunnerInterfaces]> = [
			["missing-system", { getSystemPrompt: () => undefined }],
			["throwing-system", { getSystemPrompt: () => { throw new Error("system unavailable"); } }],
			["missing-active-tool-registry", { getActiveTools: () => undefined }],
			["missing-tool-list", { getAllTools: () => undefined }],
			["broken-tool-schema", {
				getActiveTools: () => ["broken"],
				getAllTools: () => [{ name: "broken", description: "broken", parameters: { impossible: 1n } }],
			}],
		];
		for (const api of ["openai-completions", "google-generative-ai"] as const) {
			await withCountingServer(async (baseUrl, requests) => {
				for (const [name, interfaces] of brokenInterfaces) {
					const blocked = await exerciseProvider(api, baseUrl, 100_000, `${USER_SENTINEL}: ${name}`, { interfaces });
					assert.equal(blocked.stopReason, "aborted", `${api}/${name} must fail closed`);
					assert.equal(requests.length, 0, `${api}/${name} must abort before HTTP`);
					assert.equal((blocked.transformed.at(-1) as { content?: string }).content, `${USER_SENTINEL}: ${name}`);
				}
			});
			record("budget_interface_gate", { api, cases: brokenInterfaces.length, httpRequests: 0, preservesUser: true });
		}
	}));

	await runCase("P2-BUDGET foreign and error tool outputs cannot bypass aggregate gate", (record) => withProject(async (project) => {
		exerciseProvider.project = project;
		const tail = "THIRD_PARTY_TOOL_SECRET_TAIL";
		for (const api of ["openai-completions", "google-generative-ai"] as const) {
			await withCountingServer(async (baseUrl, requests) => {
				for (const isError of [false, true]) {
					const toolCallId = isError ? "foreign-error" : "foreign-success";
					const raw = "foreign output ".repeat(2_000) + tail;
					const history = [
						{ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "third_party_tool", arguments: {} }], timestamp: 0 },
						{ role: "toolResult", toolCallId, toolName: "third_party_tool", content: [{ type: "text", text: raw }], details: { duplicatedPayload: raw }, isError, timestamp: 0 },
					];
					const before = requests.length;
					const result = await exerciseProvider(api, baseUrl, 10_000, `${USER_SENTINEL}: continue`, { history });
					assert.equal(requests.length, before + 1, `${api}/${isError ? "error" : "success"} should fit only after deterministic offload; ${result.stopReason}: ${result.errorMessage}`);
					assert.equal(result.stopReason, "error");
					const transformedTool = result.transformed.find((message: any) => message?.role === "toolResult") as { content?: unknown; details?: unknown };
					assert.ok(transformedTool, "tool result protocol row must remain paired with its assistant call");
					assert.equal(transformedTool.details, undefined, "large untrusted details must not bypass the budget");
					assert.doesNotMatch(JSON.stringify(transformedTool.content), new RegExp(tail));
					assert.doesNotMatch(requests.at(-1)!.body, new RegExp(tail));
					assert.match(requests.at(-1)!.body, /完整结果未内联/);
				}
			});
			record("foreign_tool_output", { api, successOffloaded: true, errorOffloaded: true, pairingPreserved: true, leakedTail: false });
		}
	}));

	await runCase("P2-BUDGET late provider abort limitation remains explicit", async (record) => {
		for (const api of ["openai-completions", "google-generative-ai"] as const) {
			await withCountingServer(async (baseUrl, requests) => {
				const controller = new AbortController();
				const response = streamSimple(
					model(api, baseUrl, 100_000),
					{ systemPrompt: SYSTEM_SENTINEL, messages: [{ role: "user", content: USER_SENTINEL, timestamp: 0 }], tools: [] },
					{
						apiKey: "synthetic-local-key",
						signal: controller.signal,
						onPayload: (payload) => {
							controller.abort();
							return payload;
						},
					},
				);
				for await (const _event of response) { /* consume the real provider stream */ }
				const message = await response.result();
				assert.equal(message.stopReason, "aborted");
				// The pinned Google client attaches an abort listener after onPayload
				// without checking the already-aborted signal. Retain this exact oracle;
				// selecting a valid fetch port must not mask it with a transport failure.
				const expectedRequests = api === "google-generative-ai" ? 1 : 0;
				assert.equal(requests.length, expectedRequests, `${api} late-abort behavior changed; revisit the documented provider boundary; ${message.errorMessage ?? "no SDK error"}`);
				record("late_provider_abort", { api, httpRequests: requests.length, strictNoHttpGate: false });
			});
		}
	});
}
