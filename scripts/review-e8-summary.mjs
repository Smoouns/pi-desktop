/** Fixed historical evidence review, not a model judge or a live test runner.
 * Semantic judgements below were made by the assistant reading the summary.
 * Assertions verify their provenance, not the quality of arbitrary summaries.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const batch = "artifacts/harness/review-e8/joint-upstream-gYx27t";
const hash = value => createHash("sha256").update(value).digest("hex");
const read = name => readFileSync(path.join(root, batch, name));
const json = name => JSON.parse(read(name).toString("utf8"));
const pins = {
	"manifest.json": "c6f071d650f6b4d04ad0606cf4d1e48ea3ad2b1a33f1de37fcffd73ce81ba780",
	"assets/inputs.json": "d8003ed643728cdd4d1122a569cff3514e43d1bc1b08ce8afa6449778fc7a499",
	"assets/novel-tools.ts": "15409ac3c37468eaa92065ccc9d8898ab4e5b413bc0c68c59a02dc0dc920ae0c",
	"assets/worker.mjs": "fc094bb9e88cf5b1565fc839d994faf1fc19f06d03be8d1276ee5b217243f6e9",
	"live/report.json": "f8dcb5d5c268d386f4de7be42654ea2623d4898f8083cfd92d70ca6656e93a17",
	"live/broker.jsonl": "55050346cadf797d5c6a112f96d64616baf470d92288405ac3c8b9383e476dbf",
	"live/worker-c-treatment/worker-result.json": "472e0dbce24f1a61ef88bc30a05763e3b89cf6f04a7148470f67d5596fad7e85",
	"live/worker-c-control/worker-result.json": "e7d82740973c974e311e7d600aa8d737cedb728daf681e53d7ea354ca5361df4",
	"live/worker-c-treatment/agent/sessions/2026-09-25T11-04-35-419Z_30d4425f-093f-4a03-a532-4fd30d8b7766.jsonl": "1a5486772590dbfdd7b0ffefa03ffe2236746f8867996b385e897bc9242465dc",
	"live/worker-c-control/agent/sessions/2026-09-25T11-04-13-861Z_4a26dcf9-4db0-4686-b7ab-35d0fcd64667.jsonl": "028cb163318b3ba94e145483c5e84dadde822462cf5fa10eaa3f4888b1cf3ad6",
};
const verifyPins = () => { for (const [name, digest] of Object.entries(pins)) assert.equal(hash(read(name)), digest, "Historical evidence changed: " + name); };
verifyPins();
const manifest = json("manifest.json"), inputs = json("assets/inputs.json"), report = json("live/report.json");
const treatment = json("live/worker-c-treatment/worker-result.json"), control = json("live/worker-c-control/worker-result.json");
for (const [name, digest] of Object.entries(manifest.assets)) assert.equal(hash(read(name)), digest, "Frozen asset changed: " + name);
const text = message => typeof message.content === "string" ? message.content : (message.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");
const seedUsers = inputs.seed.filter(m => m.role === "user").map(text);
const summary = treatment.compaction.summary, summaryLines = summary.split("\n");
assert.equal(summary, report.compaction.summary);
for (const [stage, worker] of [["c-treatment", treatment], ["c-control", control]]) {
	const session = Object.keys(pins).find(name => name.startsWith("live/worker-" + stage + "/agent/sessions/"));
	assert.equal(path.resolve(root, batch, session), path.resolve(worker.sessionFile));
	const entries = read(session).toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
	assert.deepEqual(entries.filter(e => e.type === "message").slice(0, inputs.seed.length).map(e => e.message), inputs.seed);
	const lastAnswer = [...worker.messages].reverse().find(m => m.role === "assistant");
	assert.deepEqual(JSON.parse(text(lastAnswer)), inputs.oracle);
	assert.equal(worker.failure, undefined); assert.deepEqual(worker.finalizationErrors, []);
	assert.deepEqual(worker.tools, []); assert.deepEqual(worker.blockedTools, []);
	if (stage === "c-treatment") {
		assert.equal(entries.filter(e => e.type === "compaction").length, 1);
		assert.equal(entries.find(e => e.type === "compaction").summary, summary);
		assert.equal(worker.seedPreserved, true);
	}
}
assert.notEqual(treatment.sessionFile, control.sessionFile);
assert.equal(treatment.seedSha256, control.seedSha256);
assert.equal(treatment.seedSha256, hash(JSON.stringify(inputs.seed)));
const checkpoint = report.compactionStructured.checkpoint;
assert.deepEqual(checkpoint.hardConstraints, seedUsers);
const rowsText = read("live/broker.jsonl").toString("utf8"); assert.ok(rowsText.endsWith("\n"));
const rows = rowsText.trimEnd().split("\n").map(line => JSON.parse(line));
let previous = "0".repeat(64);
rows.forEach((row, index) => { const { sha256, ...payload } = row; assert.equal(row.sequence, index + 1); assert.equal(row.previous, previous); assert.equal(hash(JSON.stringify(payload)), sha256); previous = sha256; });
const cRequests = rows.filter(r => r.event === "reserved" && r.data.worker === "worker-c-treatment").map(r => r.data);
assert.deepEqual(cRequests.filter(r => r.kind === "summary").map(r => r.id), ["e8-4", "e8-5"]);
for (const request of cRequests) {
	assert.equal(rows.filter(r => r.event === "terminal" && r.data.id === request.id && r.data.status === "complete").length, 1);
	assert.equal(request.body.tool_choice, "none");
	assert.ok(!request.body.messages.some(m => text(m).includes(text([...control.messages].reverse().find(a => a.role === "assistant")))));
}
const finalRequest = cRequests.find(r => r.kind === "ordinary");
assert.equal(finalRequest.id, "e8-6"); assert.deepEqual(finalRequest.body, report.compactionFinalProjection);
const finalMessages = finalRequest.body.messages;
const placeholder = "原生摘要仅供会话存档，不作为当前事实；请依据版本检查点重新读取证据。";
assert.equal(text(finalMessages[1]), "The conversation history before this point was compacted into the following summary:\n\n<summary>\n" + placeholder + "\n</summary>");
assert.ok(read("assets/novel-tools.ts").toString("utf8").includes(placeholder));
assert.ok(!finalMessages.some(m => text(m).includes(summary)));
const projected = finalMessages.map(text).find(t => t.startsWith("结构化任务检查点"));
const projectedCheckpoint = JSON.parse(projected.slice(projected.indexOf("\n") + 1));
assert.deepEqual(projectedCheckpoint.checkpoint.hardConstraints, seedUsers);
assert.equal(projectedCheckpoint.writeAuthority, false);

// Explicit local semantic judgements. Presence checks only bind excerpts to
// immutable evidence; they must not be advertised as an automatic quality score.
const judgements = [
	["goal", 0, "Organize next-step planning under a read-only boundary without writing body text, approving chapter cards, or promoting content to Canon."],
	["boundary", 0, "Execution boundary is strictly read-only; no body text writing."],
	["card", 0, "Chapter card approval and Canon promotion are blocked pending manual user verification."],
	["body", 0, "chapter cards and body text require manual verification.", "not_explicit", "泛称需要人工检查，未明确保留正文当前尚未验证；也未误写成已经通过。"],
	["failure", 1, "Identified previous failure cause: source version mismatch (v1 vs. v2)."],
	["rejected", 1, "Do not skip source verification (skipping source checks explicitly rejected)."],
	["source", 1, "Current source version: v2."],
	["next", 1, "Re-read invalidated sources against v2.\n2. Refresh checkpoints as needed based on re-read sources."],
	["unresolved", 1, "Unresolved facts must remain marked as unknown."],
	["writerPlanningWrite", 1, "Writing agent is strictly prohibited from modifying planning."],
].map(([key, sourceIndex, excerpt, status = "explicitly_preserved", note = "逐项审读认为保留；不等于已完成实际工具核验。"] ) => {
	assert.ok(summary.includes(excerpt), "Review excerpt missing: " + key);
	return { key, expected: inputs.oracle[key], critical: inputs.critical.includes(key), status, note,
		seedUserIndex: sourceIndex, originalUserText: seedUsers[sourceIndex], summaryExcerpt: excerpt,
		summaryStartLine: summaryLines.findIndex(line => line.includes(excerpt.split("\n")[0])) + 1,
		finalRequestEvidence: "e8-6 checkpoint.hardConstraints[" + sourceIndex + "]", checkpointPreservedVerbatim: true };
});
assert.deepEqual(judgements.map(j => j.key), Object.keys(inputs.oracle));
assert.equal(report.summaryContentReview, "pending_review"); // Never rewrite historical run-time reports.
assert.equal(globalThis[Symbol.for("pi.eval.networkGuard")]?.attempts, 0, "Run with eval-network-guard.mjs");
verifyPins();
const result = {
	schemaVersion: 1, kind: "e8-local-summary-content-review", batch, manifestSha256: pins["manifest.json"],
	reviewer: "assistant-local-evidence-review", userAcceptance: "not_recorded", reviewStatus: "completed_with_gap",
	summaryContentReview: { status: "not_fully_preserved", explicit: 9, total: 10, criticalExplicit: 5, criticalTotal: 6, missingExplicitState: ["body"] },
	systemRecovery: { control: "10/10", treatment: "10/10", critical: "6/6", checkpointConstraintsPreserved: 3 },
	projection: { requestId: finalRequest.id, naturalSummaryIncluded: false, summaryPlaceholderIncluded: true, checkpointIncluded: true, nativeSummaryCausalContribution: "absent_from_this_request", checkpointOnlyCausalNecessity: "not_tested" },
	limitations: ["One public synthetic seed with one native manual compaction; not general semantic quality.", "No summary-only ablation, automatic/overflow compaction, Desktop or real novel test.", "Does not regrade the original report, approve a chapter, or close all E items."],
	summaryRequestIds: ["e8-4", "e8-5"], judgementBasis: "assistant close reading, not keyword-based semantic scoring", judgements,
	originalEvidenceUnchanged: true, evidenceSha256: pins, archivedAssetsChecked: Object.keys(manifest.assets).length,
	newHttpRequests: 0, realModelCalls: 0, credentialResolved: false,
};
const output = mkdtempSync(path.join(root, "artifacts/harness/review-e8/summary-content-review-"));
writeFileSync(path.join(output, "review.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
writeFileSync(path.join(output, "native-summary.txt"), summaryLines.map((line, i) => `${i + 1}: ${line}`).join("\n") + "\n", { flag: "wx" });
verifyPins();
console.log(JSON.stringify({ output, reviewStatus: result.reviewStatus, summaryContentReview: result.summaryContentReview, projection: result.projection, originalEvidenceUnchanged: true, newHttpRequests: 0 }));
