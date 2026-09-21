import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createRunSupervisor } from "../../src/harness/run-supervisor.js";
import { NOVEL_TOOLS_EXTENSION_CONTENT } from "../../src/extensions/novel-tools-extension.js";
import { withProject, type RunCase } from "./testkit.js";

type RpcValue = Record<string, any>;

const assistant = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "openai-completions" as const,
	provider: "synthetic",
	model: "scripted",
	timestamp: 0,
	stopReason: "stop" as const,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

class RpcProcess {
	readonly events: RpcValue[] = [];
	readonly stderr: string[] = [];
	readonly child: ChildProcessWithoutNullStreams;
	private readonly waiters = new Set<() => void>();
	private stdout = "";
	private stopped = false;

	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			this.stdout += chunk;
			for (;;) {
				const newline = this.stdout.indexOf("\n");
				if (newline < 0) break;
				const line = this.stdout.slice(0, newline).trim();
				this.stdout = this.stdout.slice(newline + 1);
				if (!line) continue;
				try { this.events.push(JSON.parse(line)); }
				catch { this.stderr.push(`non-json stdout: ${line.slice(0, 500)}`); }
				for (const wake of this.waiters) wake();
			}
		});
		child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
		child.on("exit", () => { this.stopped = true; for (const wake of this.waiters) wake(); });
	}

	send(value: RpcValue): void {
		assert.equal(this.stopped, false, `Pi RPC exited early: ${this.stderr.join("").slice(0, 2000)}`);
		this.child.stdin.write(JSON.stringify(value) + "\n");
	}

	async waitFor(predicate: (event: RpcValue) => boolean, label: string, timeout = 10_000): Promise<RpcValue> {
		const deadline = Date.now() + timeout;
		for (;;) {
			const found = this.events.find(predicate);
			if (found) return found;
			if (this.stopped) throw new Error(`Pi RPC exited before ${label}: ${this.stderr.join("").slice(0, 2000)}`);
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`Timed out waiting for ${label}; stderr=${this.stderr.join("").slice(0, 2000)} events=${JSON.stringify(this.events).slice(0, 4000)}`);
			await new Promise<void>((resolve) => {
				const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
				const timer = setTimeout(wake, Math.min(remaining, 250));
				this.waiters.add(wake);
			});
		}
	}

	async close(): Promise<void> {
		if (this.stopped) return;
		this.child.stdin.end();
		for (let elapsed = 0; elapsed < 2_000 && !this.stopped; elapsed += 25) await delay(25);
		if (!this.stopped) this.child.kill();
		for (let elapsed = 0; elapsed < 2_000 && !this.stopped; elapsed += 25) await delay(25);
		assert.equal(this.stopped, true, "Pi RPC child did not stop after stdin close and bounded termination");
	}
}

function cleanEnvironment(agentDirectory: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		PI_CODING_AGENT_DIR: agentDirectory,
		PI_OFFLINE: "1",
		NO_COLOR: "1",
	};
	for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
		if (process.env[key] !== undefined) environment[key] = process.env[key];
	}
	return environment;
}

export async function runStatusCommandRpcCases(runCase: RunCase): Promise<void> {
	await runCase("P4-RPC /novel-run-status is visible and model-free in a real Pi child", (record) => withProject(async (root) => {
		const privateRoot = await mkdtemp(path.join(tmpdir(), "pi-harness-status-rpc-"));
		let rpc: RpcProcess | null = null;
		try {
			const sessionDirectory = path.join(privateRoot, "sessions");
			const manager = SessionManager.create(root, sessionDirectory);
			const projectId = createHash("sha256").update(process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)).digest("hex");
			const scope = { projectId, sessionId: manager.getSessionId(), runId: "rpc-budget-run", generation: 7, role: "write" as const };
			const supervisor = createRunSupervisor({ digest: (text) => createHash("sha256").update(text).digest("hex") });
			supervisor.begin(scope);
			const snapshot = supervisor.stop(scope, "BLOCKED_PREREQUISITE", "MODEL_INPUT_BUDGET_EXCEEDED");
			assert.ok(snapshot);
			manager.appendCustomEntry("pi-desktop-novel-role", { role: "write" });
			manager.appendCustomEntry("pi-desktop-run-status/v1", snapshot);
			manager.appendCustomEntry("pi-desktop-budget-diagnostic/v1", {
				scope,
				detail: { version: 1, stage: "context-preflight", reason: "model_input_budget_exceeded", ledger: { total: 100_000, limit: 80_000 } },
			});
			manager.appendMessage(assistant("flush persisted run status"));
			const sessionFile = manager.getSessionFile();
			assert.ok(sessionFile);
			const extensionPath = path.join(privateRoot, "novel-tools.ts");
			const agentDirectory = path.join(privateRoot, "agent");
			await writeFile(extensionPath, NOVEL_TOOLS_EXTENSION_CONTENT, "utf8");
			await mkdir(agentDirectory, { recursive: true });
			await writeFile(path.join(agentDirectory, "models.json"), JSON.stringify({
				providers: {
					"offline-rpc": {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "offline-test-only",
						models: [{ id: "status-only", name: "Offline status test", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
					},
				},
			}, null, 2) + "\n", "utf8");

			const cli = path.resolve("node_modules/@mariozechner/pi-coding-agent/dist/cli.js");
			const child = spawn(process.execPath, [cli, "--mode", "rpc", "--offline", "--provider", "offline-rpc", "--model", "status-only", "--no-extensions", "-e", extensionPath, "--no-skills", "--no-prompt-templates", "--session", sessionFile, "--session-dir", sessionDirectory], {
				cwd: root,
				env: cleanEnvironment(agentDirectory),
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			rpc = new RpcProcess(child);
			rpc.send({ id: "commands", type: "get_commands" });
			const commands = await rpc.waitFor((event) => event.type === "response" && event.id === "commands", "get_commands response");
			assert.equal(commands.success, true);
			assert.ok(commands.data.commands.some((command: RpcValue) => command.name === "novel-run-status" && command.source === "extension"));

			const before = await readFile(sessionFile);
			const startIndex = rpc.events.length;
			rpc.send({ id: "status", type: "prompt", message: "/novel-run-status" });
			const promptResponse = await rpc.waitFor((event) => event.type === "response" && event.id === "status", "slash-command response");
			assert.equal(promptResponse.success, true);
			const request = await rpc.waitFor((event) => event.type === "extension_ui_request" && event.method === "confirm" && event.title === "小说运行状态", "status confirm dialog");
			assert.match(request.message, /MODEL_INPUT_BUDGET_EXCEEDED/);
			assert.match(request.message, /100000\s*\/\s*预算上限\s*80000/);
			rpc.send({ type: "extension_ui_response", id: request.id, confirmed: false });
			rpc.send({ id: "state", type: "get_state" });
			const state = await rpc.waitFor((event) => event.type === "response" && event.id === "state", "post-command state");
			assert.equal(state.success, true);
			assert.equal(state.data.isStreaming, false);
			await delay(100);
			const queryEvents = rpc.events.slice(startIndex);
			assert.equal(queryEvents.some((event) => ["agent_start", "tool_execution_start", "tool_execution_end", "message_start", "message_update", "message_end"].includes(event.type)), false, "status command must not start an agent, model message, or tool");
			assert.equal(Buffer.compare(before, await readFile(sessionFile)), 0, "status query must not mutate the session JSONL");
			record("status_command_rpc", { commandListed: true, confirmVisible: true, numericBudget: true, modelCalls: 0, sessionUnchanged: true });
		} finally {
			await rpc?.close();
			await rm(privateRoot, { recursive: true, force: true });
		}
	}));
}
