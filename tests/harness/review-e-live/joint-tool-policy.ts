import { digest } from "./journal.js";
import { allowedTools } from "./fixtures.js";

/** Read-only final-body proof, separate from semantic U/C/R outcome. */
export function jointToolPolicyEvidence(results: any[], rows: any[]) {
	const reservations = rows.filter(row => row.event === "reserved");
	const noTools = reservations.filter(row => row.data.worker !== "worker-r");
	const read = reservations.filter(row => row.data.worker === "worker-r");
	const proofs = noTools.map(({ data }) => {
		const result = results.find(row => "worker-" + row.id === data.worker)?.result;
		const { tool_choice, ...before } = data.body;
		const adjustments = (result?.protocolAdjustments ?? []).filter((p: any) => p.afterSha256 === data.bodySha256 && p.phase === data.phase);
		const terminal = rows.find(row => row.event === "terminal" && row.data.id === data.id)?.data;
		return { requestId: data.id, worker: data.worker, kind: data.kind,
			explicitNone: tool_choice === "none",
			nativeToolsShapePreserved: data.kind === "summary" ? data.body.tools === undefined : Array.isArray(data.body.tools) && data.body.tools.length === 0,
			onlyChoiceAdded: adjustments.length === 1 && adjustments[0].boundary === "native-provider-onPayload"
				&& adjustments[0].beforeSha256 === digest(JSON.stringify(before)) && data.bodySha256 === digest(JSON.stringify(data.body)),
			completeWithoutRawTools: terminal?.status === "complete" && terminal.toolCallDeltas === 0 };
	});
	const completeNoToolsStages = ["u", "c-control", "c-treatment"].every(id => {
		const stage = results.find(row => row.id === id), count = noTools.filter(row => row.data.worker === "worker-" + id).length;
		return stage?.status === "completed" && stage.result?.protocolAdjustments?.length === count
			&& stage.result.activeTools?.length === 0 && stage.result.tools?.length === 0 && stage.result.blockedTools?.length === 0;
	});
	const r = results.find(row => row.id === "r");
	const readToolsUnchanged = read.length > 0 && r?.status === "completed" && r.result?.protocolAdjustments?.length === 0
		&& JSON.stringify([...(r.result.activeTools ?? [])].sort()) === JSON.stringify([...allowedTools].sort())
		&& read.every(({ data }) => data.body.tool_choice === undefined
			&& JSON.stringify((data.body.tools ?? []).map((tool: any) => tool.function.name).sort()) === JSON.stringify([...allowedTools].sort()));
	const ordinary = noTools.filter(row => row.data.kind === "ordinary").length, summaries = noTools.filter(row => row.data.kind === "summary").length;
	const passed = ordinary === 4 && summaries === 2 && completeNoToolsStages && readToolsUnchanged
		&& proofs.every(p => p.explicitNone && p.nativeToolsShapePreserved && p.onlyChoiceAdded && p.completeWithoutRawTools);
	return { profile: results[0]?.result?.executionProfile ?? "joint-tool-none", passed, noToolsOrdinaryRequests: ordinary, noToolsSummaryRequests: summaries, readRequests: read.length,
		completeNoToolsStages, readToolsUnchanged, proofs, productionAgentModified: false, rootCauseEstablished: false };
}
