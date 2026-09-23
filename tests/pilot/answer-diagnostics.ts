import assert from "node:assert/strict";
import { diagnosePilotAnswer, pilotAnswerAccepted, unevaluatedPilotAnswer, validatePilotAnswerDiagnostic, type PilotAnswerCode } from "../../evals/pilot/answer-diagnostics.js";
import { PILOT_TASK_IDS, type PilotTaskId } from "../../evals/pilot/policy.js";

const read = PILOT_TASK_IDS[0], write = PILOT_TASK_IDS[1];
const valid = '{"canPredictStorm":false,"signers":["记录员","设备技师"]}';
const canary = "private-answer-canary-never-export";
// The exact previous implementation is the acceptance regression oracle.
function previousAccepted(task: PilotTaskId, text: string): boolean {
	if (task === write) return text.trim() === "ready";
	try { const value = JSON.parse(text); return value.canPredictStorm === false && JSON.stringify(value.signers) === JSON.stringify(["记录员", "设备技师"]); }
	catch { return false; }
}

export function runAnswerDiagnosticTests(): number {
	let count = 0;
	const cases: Array<[PilotTaskId, string, PilotAnswerCode[]]> = [
		[read, valid, ["ANSWER_OK"]], [read, ` \n${valid}\r\n`, ["ANSWER_OK"]],
		[read, '{"signers":["记录员","设备技师"],"canPredictStorm":false}', ["ANSWER_OK"]],
		[read, valid.replace(/}$/, `,"extra":"${canary}"}`), ["ANSWER_OK"]],
		[read, "", ["ANSWER_EMPTY"]], [read, " \t\r\n", ["ANSWER_EMPTY"]],
		[read, `\x60\x60\x60json\n${valid}\n\x60\x60\x60`, ["ANSWER_MARKDOWN_FENCE"]],
		[read, `~~~json\r\n${valid}\r\n~~~`, ["ANSWER_MARKDOWN_FENCE"]],
		[read, `回答：${valid}`, ["ANSWER_JSON_INVALID"]], [read, valid + valid, ["ANSWER_JSON_INVALID"]],
		[read, `\x60\x60\x60json\n${valid}`, ["ANSWER_JSON_INVALID"]],
		[read, "{" + canary, ["ANSWER_JSON_INVALID"]], [read, "\ufeff" + valid, ["ANSWER_JSON_INVALID"]],
		...(["null", "[]", '"string"', "true", "0"] as const).map((text): [PilotTaskId, string, PilotAnswerCode[]] => [read, text, ["ANSWER_JSON_NOT_OBJECT"]]),
		[read, "{}", ["ANSWER_STORM_MISSING", "ANSWER_SIGNERS_MISSING"]],
		[read, '{"signers":["记录员","设备技师"]}', ["ANSWER_STORM_MISSING"]],
		[read, '{"canPredictStorm":false}', ["ANSWER_SIGNERS_MISSING"]],
		[read, valid.replace("false", '"false"'), ["ANSWER_STORM_TYPE"]],
		[read, valid.replace("false", "null"), ["ANSWER_STORM_TYPE"]],
		[read, valid.replace("false", "true"), ["ANSWER_STORM_VALUE"]],
		[read, '{"canPredictStorm":false,"signers":"记录员"}', ["ANSWER_SIGNERS_TYPE"]],
		[read, '{"canPredictStorm":false,"signers":["记录员",1]}', ["ANSWER_SIGNERS_TYPE"]],
		[read, '{"canPredictStorm":false,"signers":[]}', ["ANSWER_SIGNERS_MEMBERS"]],
		[read, '{"canPredictStorm":false,"signers":["记录员","记录员"]}', ["ANSWER_SIGNERS_MEMBERS"]],
		[read, valid.replace("设备技师", canary), ["ANSWER_SIGNERS_MEMBERS"]],
		[read, '{"canPredictStorm":false,"signers":["设备技师","记录员"]}', ["ANSWER_SIGNERS_ORDER"]],
		[read, '{"canPredictStorm":true,"signers":["设备技师","记录员"]}', ["ANSWER_STORM_VALUE", "ANSWER_SIGNERS_ORDER"]],
		[write, "ready", ["ANSWER_OK"]], [write, " \nready\r\n", ["ANSWER_OK"]],
		[write, "", ["ANSWER_EMPTY"]], [write, "READY", ["ANSWER_READY_MISMATCH"]],
		[write, '"ready"', ["ANSWER_READY_MISMATCH"]], [write, canary, ["ANSWER_READY_MISMATCH"]],
		[write, "```\nready\n```", ["ANSWER_MARKDOWN_FENCE"]],
	];
	for (const [taskId, text, codes] of cases) {
		const diagnostic = diagnosePilotAnswer(taskId, text);
		assert.deepEqual(diagnostic.codes, codes);
		assert.deepEqual(validatePilotAnswerDiagnostic(diagnostic, taskId), diagnostic);
		assert.equal(pilotAnswerAccepted(diagnostic), previousAccepted(taskId, text));
		assert.doesNotMatch(JSON.stringify(diagnostic), /private-answer-canary|记录员|设备技师|SyntaxError|position/);
		assert.ok(JSON.stringify(diagnostic).length < 240);
		count++;
	}
	// Type, membership, duplicate/extra entries and missing fields preserve the
	// historical boolean result across a wider matrix than the named diagnoses.
	for (const storm of [undefined, null, false, true, "false", 0]) {
		for (const signers of [undefined, null, [], "记录员", ["记录员", "设备技师"], ["设备技师", "记录员"], ["记录员", "记录员"], ["记录员", "设备技师", "其他"], ["记录员", 1]]) {
			const text = JSON.stringify({ canPredictStorm: storm, signers });
			assert.equal(pilotAnswerAccepted(diagnosePilotAnswer(read, text)), previousAccepted(read, text));
		}
	}
	count++;
	for (const id of PILOT_TASK_IDS) {
		const unavailable = unevaluatedPilotAnswer(id);
		assert.deepEqual(validatePilotAnswerDiagnostic(unavailable, id), unavailable);
		assert.equal(pilotAnswerAccepted(unavailable), false);
		count++;
	}
	const base = diagnosePilotAnswer(read, valid);
	for (const invalid of [null, [], { ...base, schemaVersion: 2 }, { ...base, taskId: write }, { ...base, rawText: canary },
		{ ...base, codes: [] }, { ...base, codes: [canary] }, { ...base, codes: ["ANSWER_OK", "ANSWER_STORM_VALUE"] },
		{ ...base, codes: ["ANSWER_STORM_VALUE", "ANSWER_STORM_VALUE"] }, { ...base, codes: ["ANSWER_SIGNERS_ORDER", "ANSWER_STORM_VALUE"] },
		{ ...base, codes: ["ANSWER_READY_MISMATCH"] }, { ...base, codes: ["ANSWER_JSON_INVALID", "ANSWER_STORM_VALUE"] },
		{ ...base, codes: ["ANSWER_OK", "ANSWER_OK", "ANSWER_OK"] }]) {
		assert.throws(() => validatePilotAnswerDiagnostic(invalid, read), { message: "PILOT_ANSWER_DIAGNOSTIC_INVALID" }); count++;
	}
	assert.throws(() => validatePilotAnswerDiagnostic({ ...base, taskId: write, codes: ["ANSWER_SIGNERS_ORDER"] }, write), /PILOT_ANSWER_DIAGNOSTIC_INVALID/); count++;
	return count;
}
