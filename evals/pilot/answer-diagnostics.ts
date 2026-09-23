import { PILOT_TASK_IDS, type PilotTaskId } from "./policy.js";

// Only fixed codes cross the worker/record boundary: never raw model text,
// parsed values, unknown field names, snippets, or JSON parser error messages.
export const PILOT_ANSWER_CODES = [
	"ANSWER_OK", "ANSWER_NOT_EVALUATED", "ANSWER_EMPTY", "ANSWER_MARKDOWN_FENCE", "ANSWER_JSON_INVALID", "ANSWER_JSON_NOT_OBJECT",
	"ANSWER_STORM_MISSING", "ANSWER_STORM_TYPE", "ANSWER_STORM_VALUE",
	"ANSWER_SIGNERS_MISSING", "ANSWER_SIGNERS_TYPE", "ANSWER_SIGNERS_MEMBERS", "ANSWER_SIGNERS_ORDER", "ANSWER_READY_MISMATCH",
] as const;
export type PilotAnswerCode = typeof PILOT_ANSWER_CODES[number];
export type PilotAnswerDiagnostic = { schemaVersion: 1; taskId: PilotTaskId; codes: PilotAnswerCode[] };
const stormCodes: readonly PilotAnswerCode[] = ["ANSWER_STORM_MISSING", "ANSWER_STORM_TYPE", "ANSWER_STORM_VALUE"];
const signerCodes: readonly PilotAnswerCode[] = ["ANSWER_SIGNERS_MISSING", "ANSWER_SIGNERS_TYPE", "ANSWER_SIGNERS_MEMBERS", "ANSWER_SIGNERS_ORDER"];
const sharedCodes: readonly PilotAnswerCode[] = ["ANSWER_OK", "ANSWER_NOT_EVALUATED", "ANSWER_EMPTY", "ANSWER_MARKDOWN_FENCE"];
const readFormatCodes: readonly PilotAnswerCode[] = ["ANSWER_JSON_INVALID", "ANSWER_JSON_NOT_OBJECT"];
const result = (taskId: PilotTaskId, ...codes: PilotAnswerCode[]): PilotAnswerDiagnostic => ({ schemaVersion: 1, taskId, codes });

export const unevaluatedPilotAnswer = (taskId: PilotTaskId): PilotAnswerDiagnostic => result(taskId, "ANSWER_NOT_EVALUATED");
export const pilotAnswerAccepted = (value: PilotAnswerDiagnostic): boolean => value.codes.length === 1 && value.codes[0] === "ANSWER_OK";

/** Strict-v1 acceptance is unchanged: no fence removal/JSON repair, READ values
 * and signer order must match, WRITE must trim to ready. Extra JSON keys remain
 * tolerated as in the original check; we do not publish those keys or values. */
export function diagnosePilotAnswer(taskId: PilotTaskId, text: string): PilotAnswerDiagnostic {
	const trimmed = text.trim();
	if (!trimmed) return result(taskId, "ANSWER_EMPTY");
	if (/^(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*\r?\n\1$/.test(trimmed)) return result(taskId, "ANSWER_MARKDOWN_FENCE");
	if (taskId === "P5P-WRITE-001") return result(taskId, trimmed === "ready" ? "ANSWER_OK" : "ANSWER_READY_MISMATCH");
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { return result(taskId, "ANSWER_JSON_INVALID"); }
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result(taskId, "ANSWER_JSON_NOT_OBJECT");
	const answer = parsed as Record<string, unknown>, codes: PilotAnswerCode[] = [];
	if (!Object.hasOwn(answer, "canPredictStorm")) codes.push("ANSWER_STORM_MISSING");
	else if (typeof answer.canPredictStorm !== "boolean") codes.push("ANSWER_STORM_TYPE");
	else if (answer.canPredictStorm !== false) codes.push("ANSWER_STORM_VALUE");
	if (!Object.hasOwn(answer, "signers")) codes.push("ANSWER_SIGNERS_MISSING");
	else if (!Array.isArray(answer.signers) || answer.signers.some((value) => typeof value !== "string")) codes.push("ANSWER_SIGNERS_TYPE");
	else if (answer.signers.length !== 2 || !answer.signers.includes("记录员") || !answer.signers.includes("设备技师")) codes.push("ANSWER_SIGNERS_MEMBERS");
	else if (answer.signers[0] !== "记录员" || answer.signers[1] !== "设备技师") codes.push("ANSWER_SIGNERS_ORDER");
	return result(taskId, ...(codes.length ? codes : ["ANSWER_OK" as const]));
}

/** Validate both enum membership and canonical combinations before persistence. */
export function validatePilotAnswerDiagnostic(value: unknown, taskId: PilotTaskId): PilotAnswerDiagnostic {
	const fail = (): never => { throw new Error("PILOT_ANSWER_DIAGNOSTIC_INVALID"); };
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).sort().join(",") !== "codes,schemaVersion,taskId" || raw.schemaVersion !== 1
		|| raw.taskId !== taskId || !PILOT_TASK_IDS.includes(taskId) || !Array.isArray(raw.codes) || raw.codes.length < 1 || raw.codes.length > 2) return fail();
	if (!raw.codes.every((code) => typeof code === "string" && PILOT_ANSWER_CODES.includes(code as PilotAnswerCode))) return fail();
	const codes = raw.codes as PilotAnswerCode[];
	const one = codes.length === 1, first = codes[0]!;
	const valid = one && sharedCodes.includes(first) || (taskId === "P5P-WRITE-001"
		? one && first === "ANSWER_READY_MISMATCH"
		: one && (readFormatCodes.includes(first) || stormCodes.includes(first) || signerCodes.includes(first))
			|| codes.length === 2 && stormCodes.includes(first) && signerCodes.includes(codes[1]!));
	if (!valid) return fail();
	return result(taskId, ...codes);
}
