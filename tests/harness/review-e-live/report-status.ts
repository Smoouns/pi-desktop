/** Exit 0 means the automated U/C/R checks ran and passed; it never means
 * human summary-quality review passed. Missing, stopped and partial reports fail. */
import { jointNoToolsProfile } from "./protocol-profile.js";
export function batchExitCode(report: any): 0 | 1 {
	if (report?.executionProfile === "read-upstream") return report.mechanicalStatus === "completed" && report.stopReason === null
		&& report.stages?.length === 1 && report.stages[0].id === "r" && report.stages[0].status === "completed"
		&& report.businessOutcome?.r === "read_freshness_observed" && report.businessOutcome.u === "not_run" && report.businessOutcome.c === "not_run"
		&& report.summaryRequestIds?.length === 0 && report.reservations > 0 && report.reservations <= 12
		&& report.usageCoverage?.paired === report.reservations && report.usageCoverage?.terminal === report.reservations
		&& report.pairs?.length === report.reservations
		&& ["sameContextDuplicateSourceReused", "nextContextRevalidated", "sourceTransitionRecorded", "freshV2ReadObserved", "finalAnswerReportsV2"].every(key => report.readEvidence?.[key] === true)
		&& report.pairs?.every((p: any) => p.matched === true && p.outputMatched === true) ? 0 : 1;
	if (report?.executionProfile === "tool-none") return report.mechanicalStatus === "completed" && report.stopReason === null
		&& report.stages?.length === 1 && report.stages[0].id === "tool-none" && report.stages[0].status === "completed"
		&& report.reservations === 1 && report.usageCoverage?.terminal === 1 && report.usageCoverage?.paired === 1
		&& report.pairs?.length === 1 && report.pairs[0].outputMatched === true
		&& report.businessOutcome?.toolNone === "text_without_tool_call" && report.protocolObservation?.explicitNoneSent === true
		&& report.protocolObservation.rawToolCallDeltas === 0 && report.protocolObservation.sdkToolCalls?.length === 0
		&& report.protocolObservation.successfulToolExecutions === 0 ? 0 : 1;
	const expected = ["u", "c-control", "c-treatment", "r"];
	return report?.mechanicalStatus === "completed" && report.stopReason === null
		&& (!jointNoToolsProfile(report.executionProfile) || report.toolPolicyEvidence?.passed === true)
		&& Array.isArray(report.stages) && report.stages.length === expected.length
		&& expected.every(id => report.stages.filter((s: any) => s.id === id && s.status === "completed").length === 1)
		&& report.businessOutcome?.u === "reply_observed"
		&& report.businessOutcome?.c === "answers_passed_summary_review_pending"
		&& report.businessOutcome?.r === "read_freshness_observed" ? 0 : 1;
}
