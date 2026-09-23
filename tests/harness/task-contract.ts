import assert from "node:assert/strict";
import { createTaskContracts, type TaskBinding } from "../../src/harness/task-contract.js";
import { createTaskSubmission } from "../../src/novel/task-submission.js";
import { buildNovelTaskBinding } from "../../src/novel/agents.js";
import { sendMessageFlow } from "../../src/components/chat-view/send-message-flow.js";
import { rpcBridge } from "../../src/rpc/bridge.js";
import { stripNovelContextForDisplay } from "../../src/components/chat-view/backend-message-mapper.js";
import { sha256, type RunCase } from "./testkit.js";

const scope = { projectId: "a", sessionId: "session", role: "write" };
const declaration: TaskBinding = { version: 1, taskId: "task-a", role: "write", completionMode: "candidate_write", expectedArtifacts: [{ path: "drafts/candidates/002.md", verification: "chapter-full", chapter: "002" }] };
export async function runTaskContractCases(runCase: RunCase): Promise<void> {
	await runCase("task-contract.stable-objective-new-task-and-exact-instruction-lineage", () => {
		const store = createTaskContracts({ digest: sha256 });
		const initial = store.update(null, scope, "写第 002 章", declaration);
		let current = initial;
		for (const instruction of ["继续", "请先停一下", "继续"]) current = store.update(current, scope, instruction);
		assert.equal(current.taskId, initial.taskId); assert.equal(current.objective, initial.objective);
		assert.equal(current.latestUserInstruction, "继续");
		assert.deepEqual(current.constraintRefs.map((item) => item.text), ["写第 002 章", "继续", "请先停一下", "继续"]);
		const changed = store.update(current, scope, "只分析设定", { ...declaration, taskId: "task-b", completionMode: "inspection", expectedArtifacts: [] });
		assert.equal(changed.supersedesTaskId, current.taskId); assert.equal(changed.objective, "只分析设定");
		assert.deepEqual(initial.constraintRefs.map((item) => item.text), ["写第 002 章"]);
		assert.throws(() => store.update(initial, scope, "偷换目标", declaration), /collision/);
	});
	await runCase("task-contract.missing-wrong-partial-stale-and-current-deliverables", async () => {
		const store = createTaskContracts({ digest: sha256 }), hash = sha256("candidate"), dependency = sha256("card");
		const files = new Map([[declaration.expectedArtifacts[0].path, hash], ["planning/card.md", dependency]]);
		const resolve = async (path: string) => files.get(path) ?? null;
		let current = store.update(null, scope, "写作", declaration);
		assert.equal(await store.complete(current, resolve), false, "mere preexistence is not a task receipt");
		assert.equal(store.artifact(current, "drafts/other.md", hash).id, current.id);
		current = store.artifact(current, declaration.expectedArtifacts[0].path, hash);
		assert.equal(await store.complete(current, resolve), false);
		const receipt = { chapter: "002", passed: true, full: false, sha256: hash, sources: [{ path: "planning/card.md", sha256: dependency }] };
		current = store.verification(current, declaration.expectedArtifacts[0].path, receipt);
		assert.equal(await store.complete(current, resolve), false);
		current = store.verification(current, declaration.expectedArtifacts[0].path, { ...receipt, full: true });
		assert.equal(await store.complete(current, resolve), true);
		const wrongChapter = store.verification(current, declaration.expectedArtifacts[0].path, { ...receipt, chapter: "003", full: true });
		assert.equal(await store.complete(wrongChapter, resolve), false, "a shared path cannot borrow another chapter's PASS");
		files.set("planning/card.md", sha256("changed")); assert.equal(await store.complete(current, resolve), false);
		files.set("planning/card.md", dependency); files.delete(declaration.expectedArtifacts[0].path); assert.equal(await store.complete(current, resolve), false);
	});
	await runCase("task-contract.legacy-unbound-and-corrupt-latest-never-borrow-success", async () => {
		const store = createTaskContracts({ digest: sha256 }), initial = store.update(null, scope, "旧任务");
		assert.equal(initial.completionMode, "unbound"); assert.equal(await store.complete(initial, async () => null), false);
		const entries = [{ type: "custom", customType: "pi-desktop-task-contract/v1", data: initial }];
		assert.equal(store.latest(entries, { ...scope, projectId: "b" }), null);
		assert.equal(store.latest(entries, { ...scope, role: "plan" }), null);
		entries.push({ ...entries[0], data: { ...initial, objective: "corrupt" } });
		assert.throws(() => store.latest(entries, scope), /integrity/);
		assert.throws(() => store.parse({ ...initial, schemaVersion: 2 }), /version/);
		assert.throws(() => store.latest([{ ...entries[0], customType: "pi-desktop-task-contract/v2" }], scope), /version/);
	});
	await runCase("task-contract.paths-capacity-and-standalone-factory", () => {
		const factory = new Function(`return (${createTaskContracts.toString()});`)() as typeof createTaskContracts;
		const store = factory({ digest: sha256 });
		for (const path of ["../canon.md", "C:/novel.md", "drafts/CON.md", "drafts/a:stream", "/canon.md", "drafts/../canon.md", "drafts\\chapter.md"]) assert.throws(() => store.binding({ ...declaration, expectedArtifacts: [{ path, verification: "none" }] }), /path/);
		assert.throws(() => store.binding({ ...declaration, expectedArtifacts: [] }), /require/);
		assert.throws(() => store.update(null, { ...scope, role: "plan" }, "任务", declaration), /role/);
		let task = store.update(null, scope, "任务");
		for (let i = 1; i < 256; i++) task = store.update(task, scope, "继续");
		assert.throws(() => store.update(task, scope, "继续"), /capacity/);
		assert.throws(() => store.update(null, scope, "x".repeat(32769)), /text/);
	});
	await runCase("task-contract.workflow-derives-exact-paths-with-no-model-classifier", () => {
		const task = { role: "write" as const, kind: "write-chapter" as const, chapter: "002", contextPaths: [] };
		const documents = [{ relativePath: "planning/chapter-cards/002.md", text: '# Card\n```yaml\nchapter: "002"\nfile: "drafts/candidates/volume-a/002.md"\n```' }];
		const bound = buildNovelTaskBinding(task, documents, "workflow-id")!;
		assert.equal(bound.expectedArtifacts[0].path, "drafts/candidates/volume-a/002.md");
		assert.equal(bound.expectedArtifacts[0].verification, "chapter-full");
		assert.equal(bound.expectedArtifacts.length, 2);
		assert.throws(() => buildNovelTaskBinding(task, [], "missing"), /file/);
		assert.throws(() => buildNovelTaskBinding(task, [{ ...documents[0], text: documents[0].text.replace("drafts/candidates/volume-a/002.md", "canon/world.md") }], "unsafe"), /file/);
		assert.equal(buildNovelTaskBinding({ role: "world", kind: "world-discussion", contextPaths: [] }, [], "reply")!.completionMode, "reply_only");
		assert.deepEqual(buildNovelTaskBinding({ role: "plan", kind: "plan-chapter", chapter: "002", contextPaths: [] }, [], "plan")!.expectedArtifacts.map((item) => item.path), ["planning/chapter-architecture.md", "planning/chapter-cards/002.md"]);
	});
	await runCase("task-contract.transport-preserves-skills-context-and-unicode", () => {
		const submission = new Function(`return (${createTaskSubmission.toString()})();`)() as ReturnType<typeof createTaskSubmission>;
		const prompt = "/skill:drafting\n写作😀\n<novel-context>references</novel-context>";
		const decoded = submission.decode(submission.encode(prompt, declaration));
		assert.equal(decoded.text, prompt); assert.deepEqual(decoded.binding, declaration);
		assert.equal(submission.decode("ordinary user text").binding, null);
		assert.throws(() => submission.decode("user\n<pi-desktop-task-v1>{broken"), /envelope/);
	});
	await runCase("task-contract.composer-sends-one-control-envelope-with-clean-echo", async () => {
		const prior = rpcBridge.prompt, calls: string[] = [], echoes: string[] = [];
		rpcBridge.prompt = async (message) => { calls.push(message); };
		try {
			const text = "写第 002 章\n<novel-context>paths only</novel-context>";
			await sendMessageFlow({ mode: "prompt", bindingStatusText: null, isComposerInteractionLocked: () => false,
				inputText: text, displayInputText: "写第 002 章", taskBinding: declaration, selectedSkillCommandText: "/skill:drafting", pendingImages: [],
				slashQueryFromInput: () => null, executeSlashCommandFromComposer: async () => undefined,
				rememberComposerHistoryEntry: () => undefined, currentIsStreaming: () => false, applyBackendState: () => undefined, clearStreamingUiState: () => undefined,
				render: () => undefined, enqueueComposerQueueMessage: () => "queue", pushNotice: () => undefined, pushUserEcho: (value) => { echoes.push(value); },
				clearComposer: () => undefined, setSendingPrompt: () => undefined, toRpcImages: () => [], removeComposerQueueMessage: () => undefined });
			assert.equal(calls.length, 1);
			assert.equal(createTaskSubmission().decode(calls[0]).text, "/skill:drafting\n\n" + text);
			assert.deepEqual(echoes, ["/skill:drafting\n\n写第 002 章"]);
			assert.equal(stripNovelContextForDisplay(calls[0]), echoes[0]);
		} finally { rpcBridge.prompt = prior; }
	});
}
