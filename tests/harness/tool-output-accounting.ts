import assert from "node:assert/strict";
import { withRunner } from "./phase4-extension.js";
import { withProject, type RunCase } from "./testkit.js";

const size = (content: any) => Buffer.byteLength(JSON.stringify(content), "utf8");
const text = (value: any) => value.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
async function adapter(minified: boolean, body: (api: any) => Promise<void>) {
	await withProject(root => withRunner(root, minified, async state => {
		const { extension } = state;
		let counter = 0;
		const context = (id = "output-a") => { const ctx = state.ctx(); return { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => id } }; };
		const ctx = context();
		const budget = async (owner = ctx) => {
			const id = "output-" + ++counter;
			const result: any = await extension.tools.get("get_context_budget")!.definition.execute(id, {}, undefined, undefined, owner as never);
			return { result, value: JSON.parse(text(result)), message: { ...result, role: "toolResult", toolName: "get_context_budget", toolCallId: id, isError: false, timestamp: 0 } };
		};
		const project = (messages: any[], owner = ctx) => extension.handlers.get("context")![0]({ type: "context", messages: [{ role: "user", content: "只读核验", timestamp: 0 }, ...messages] }, owner as never);
		await body({ budget, project, context, aborted: state.aborts });
	}));
}

export async function runToolOutputAccountingCases(runCase: RunCase) {
	for (const minified of [false, true]) await runCase("OUTPUT-RECEIPT same-run repeated context charges once " + minified, record => adapter(minified, async api => {
		const first = await api.budget(); assert.equal(first.value.run.outputUsed, 0);
		const stored = structuredClone(first.message);
		for (let i = 0; i < 4; i++) await api.project([first.message]);
		const next = await api.budget();
		assert.equal(next.value.run.outputUsed, size(first.result.content));
		assert.deepEqual(first.message, stored); assert.equal(api.aborted(), 0);
		record("output.same_run", { charges: 1, projections: 4, persistedMessageUnchanged: true, minified });
	}));
	await runCase("OUTPUT-RECEIPT content or tool identity changes are charged", record => adapter(false, async api => {
		const a = await api.budget();
		const changed = { ...a.message, content: [{ type: "text", text: text(a.result) + " changed" }] };
		const renamed = { ...a.message, toolName: "get_task_checkpoint" };
		await api.project([a.message, changed, renamed]);
		await api.project([a.message, changed, renamed]);
		const b = await api.budget();
		assert.equal(b.value.run.outputUsed, size(a.result.content) + size(changed.content) + size(renamed.content));
		record("output.changed", { distinctContentCharged: true, distinctToolCharged: true });
	}));
	await runCase("OUTPUT-RECEIPT persisted metadata is not a host receipt", record => adapter(false, async api => {
		const a = await api.budget();
		const forged = { ...a.message, toolCallId: "foreign-unseen", content: [{ type: "text", text: "public synthetic".repeat(600) }] };
		await api.project([a.message, forged]);
		const b = await api.budget();
		assert.equal(b.value.run.outputUsed, size(a.result.content) + size(forged.content));
		record("output.foreign", { copiedMetadataNotTrusted: true });
	}));
	await runCase("OUTPUT-RECEIPT scope change does not inherit receipts", record => adapter(false, async api => {
		const a = await api.budget(), other = api.context("output-b");
		await api.project([a.message], other); await api.project([a.message], other);
		const b = await api.budget(other);
		assert.equal(b.value.run.outputUsed, size(a.result.content));
		record("output.scope", { nextSessionChargesHistoryOnce: true });
	}));
	await runCase("OUTPUT-RECEIPT genuinely new output retains 64 KiB limit", record => adapter(false, async api => {
		const a = await api.budget();
		const large = { ...a.message, toolCallId: "historical-large", content: [{ type: "text", text: "x".repeat(60_000) }] };
		await api.project([large]);
		const extra = { ...large, toolCallId: "historical-extra", content: [{ type: "text", text: "x".repeat(10_000) }] };
		await assert.rejects(api.project([large, extra]), (e: any) => e.code === "OUTPUT_BUDGET");
		assert.ok(api.aborted() > 0);
		record("output.limit", { limit: 65536, newOutputBlocked: true });
	}));
}
