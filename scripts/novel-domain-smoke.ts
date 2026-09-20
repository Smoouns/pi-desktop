import { strict as assert } from "node:assert";
import { buildNovelContext, serializeNovelContextManifest } from "../src/novel/context.js";
import { buildNovelAgentPrompt } from "../src/novel/agents.js";
import { stripNovelContextForDisplay } from "../src/components/chat-view/backend-message-mapper.js";
import { translateChineseUiText } from "../src/i18n/ui-chinese.js";
import { resolveWorkflowExpansionState } from "../src/components/chat-view/workflow-utils.js";
import { canPromoteChapter, canRollbackPromotion, chapterWorkflowState, isRevisionRequestOpen, materializeRecordUpdate, parseProposalRecordUpdates, readChapterVerification, resolveNextWorkflowChapter, type NovelAcceptanceRecord, type NovelChapterRecord, type NovelPromotionHistoryEntry } from "../src/novel/workflow.js";
import { listWorldChangeProposals, parseWorldChangeProposal } from "../src/novel/world-change.js";
import { classifyNovelDocument, resolveNovelPath, type NovelDocument, type NovelProject, type NovelProjectConfig } from "../src/novel/project.js";

const config: NovelProjectConfig = { formatVersion: 1, layout: { manuscript: ["chapters"], drafts: ["drafts"] }, authority: { canonicalPaths: ["chapters"], proposedPaths: ["drafts/proposed"] } };
const make = (relativePath: string, authority = classifyNovelDocument(relativePath, config).authority, estimatedTokens = 10): NovelDocument => ({
	path: `C:/novel/${relativePath}`,
	relativePath,
	name: relativePath.split("/").pop() ?? relativePath,
	category: "manuscript",
	classification: { ...classifyNovelDocument(relativePath, config), authority },
	estimatedTokens,
});

assert.throws(() => resolveNovelPath("C:/novel", "../outside.md"));
assert.equal(classifyNovelDocument("drafts/proposed/017.md", config).authority, "proposed");
const items = buildNovelContext({ activeDocument: make("chapters/001.md"), adjacentDocuments: [make("chapters/002.md")], relevantDocuments: [make("drafts/proposed/017.md")], tokenBudget: 25 });
assert.deepEqual(items.map((item) => item.relativePath), ["chapters/001.md", "chapters/002.md"]);
assert.deepEqual(items.map((item) => item.readRequirement), ["required", "on-demand"]);
const contextManifest = serializeNovelContextManifest(items);
assert.match(contextManifest, /文件正文未内联/);
assert.match(contextManifest, /### chapters\/001\.md[\s\S]*read_requirement: required/);
assert.match(contextManifest, /### chapters\/002\.md[\s\S]*read_requirement: on-demand/);
assert.equal(buildNovelContext({ activeDocument: make("chapters/001.md", "canonical", 30), tokenBudget: 10 }).length, 1);
const writePrompt = buildNovelAgentPrompt({ role: "write", kind: "write-chapter", chapter: "018", contextPaths: ["planning/chapter-cards/018.md"], feedback: "保持第 017 章的事实边界。" });
assert.doesNotMatch(writePrompt, /<novel-role>/);
assert.match(writePrompt, /第 018 章/);
assert.match(writePrompt, /planning\/chapter-cards\/018\.md/);
assert.match(writePrompt, /保持第 017 章的事实边界/);
const commandPrompt = buildNovelAgentPrompt({ role: "plan", kind: "plan-chapter", contextPaths: [], instruction: "只规划初始评估事件，不创建正文。" });
assert.match(commandPrompt, /本次任务：/);
assert.match(commandPrompt, /只规划初始评估事件，不创建正文/);
const worldChangePrompt = buildNovelAgentPrompt({ role: "world", kind: "world-change", contextPaths: ["planning/world-proposals/world-change-test-request.md", "canon/world.md"] });
assert.match(worldChangePrompt, /完整替换正文/);
assert.match(worldChangePrompt, /不得直接修改 Canon/);
assert.equal(stripNovelContextForDisplay("用户请求\n\n<novel-context>\n内部索引\n</novel-context>"), "用户请求");
assert.equal(stripNovelContextForDisplay("<novel-context>\n内部索引\n</novel-context>"), "");
assert.equal(translateChineseUiText("vision"), "视觉");
assert.equal(translateChineseUiText("Revision Request"), "Revision Request");
assert.equal(resolveWorkflowExpansionState({ workflowId: "workflow-smoke", toolCalls: [{ id: "tool-smoke", name: "read", args: {}, isRunning: false, isExpanded: false }], isTerminal: true, runSawToolActivity: true, expandedWorkflowIds: new Set(), collapsedAutoWorkflowIds: new Set() }).expanded, true);
assert.equal(isRevisionRequestOpen("status: USER_REVISION_REQUESTED\nscope: manuscript\nsource_fingerprint: 4:cd0c4a3b", "same", "manuscript"), true);
assert.equal(isRevisionRequestOpen("status: USER_REVISION_REQUESTED\nscope: manuscript\nsource_fingerprint: 4:cd0c4a3b", "changed", "manuscript"), false);
assert.equal(isRevisionRequestOpen("status: USER_REVISION_REQUESTED\nscope: chapter-card\nrevision_baseline_fingerprint: 4:cd0c4a3b", "same", "chapter-card"), true);
assert.equal(isRevisionRequestOpen("status: USER_REVISION_REQUESTED\nscope: chapter-card\nrevision_baseline_fingerprint: 4:cd0c4a3b", "changed", "chapter-card"), false);
assert.equal(chapterWorkflowState({ card: "approval_status: PROPOSED_PENDING_USER_ACCEPTANCE" }), "awaiting-card-review");
assert.equal(chapterWorkflowState({ card: "approval_status: APPROVED_BY_USER", cardAccepted: true, architectureReady: false }), "blocked");
assert.equal(chapterWorkflowState({ card: "approval_status: APPROVED_BY_USER", cardAccepted: true, architectureReady: true }), "planned");
assert.equal(chapterWorkflowState({ card: "approval_status: APPROVED_BY_USER", candidate: "drafts/017.md", cardAccepted: true }), "awaiting-user-review");
const passReview = "chapter: '017'\nsource_text: drafts/017.md\nverification_status: PASS\n";
assert.equal(readChapterVerification(passReview, "017", "drafts/017.md").status, "pass");
assert.equal(readChapterVerification("The previous run said PASS.", "017", "drafts/017.md").status, "missing");
assert.equal(readChapterVerification("chapter: '018'\nverification_status: PASS", "017", "drafts/017.md").status, "failed");
assert.equal(readChapterVerification("chapter: '017'\nsource_text: drafts/016.md\nverification_status: PASS", "017", "drafts/017.md").status, "failed");
assert.equal(readChapterVerification("chapter: '017'\nsource_text: drafts/017.md\nverification_status: PASS", "017", "drafts/017.md").status, "pass");
assert.match(readChapterVerification("chapter: '019'\nverification_status: FAIL\n\n- [CONTRACT] planning/chapter-cards/019.md: expected exactly one fenced YAML document.", "019", "drafts/019.md").reason, /\[CONTRACT\].*fenced YAML/);
assert.equal(chapterWorkflowState({ card: "approval_status: APPROVED_BY_USER", candidate: "drafts/017.md", cardAccepted: true, manuscriptRevisionRequested: true }), "manuscript-revision-requested");
assert.equal(chapterWorkflowState({ card: "approval_status: APPROVED_BY_USER", candidate: "drafts/017.md", cardAccepted: true, manuscriptAccepted: true }), "accepted");
const workflowRecord = (chapter: string, state: NovelChapterRecord["state"]): Pick<NovelChapterRecord, "chapter" | "state"> => ({ chapter, state });
const promotedChapters = Array.from({ length: 17 }, (_, index) => workflowRecord(String(index + 1).padStart(3, "0"), "promoted"));
assert.equal(resolveNextWorkflowChapter(promotedChapters), "018");
assert.equal(resolveNextWorkflowChapter([...promotedChapters.slice(0, 16), workflowRecord("017", "accepted")]), "017");
assert.equal(resolveNextWorkflowChapter([workflowRecord("001", "promoted"), workflowRecord("002", "awaiting-user-review"), workflowRecord("003", "promoted")]), "002");
const acceptance: NovelAcceptanceRecord = { version: 1, kind: "manuscript", chapter: "017", sourcePath: "drafts/017.md", sourceFingerprint: "12:abc", cardPath: "planning/chapter-cards/017.md", cardFingerprint: "9:def", acceptedAt: "2026-08-14T00:00:00.000Z" };
const acceptedRecord = { chapter: "017", architecturePath: "planning/chapter-architecture.md", architectureRegistered: true, cardPath: "planning/chapter-cards/017.md", candidatePath: "drafts/017.md", proposalPath: "planning/continuity-proposals/017.md", reviewPath: "planning/reviews/017-review.md", verificationPath: "planning/verifications/017-verification.md", canonicalPath: "manuscript/017.md", state: "accepted" as const, verification: "missing" as const, verificationReason: "No verification report was found.", reasons: [], cardAccepted: true, manuscriptAcceptance: acceptance, cardRevisionRequestPath: null, manuscriptRevisionRequestPath: null, rollbackHistory: null };
assert.equal(canPromoteChapter({ ...acceptedRecord, state: "awaiting-user-review" }).allowed, false);
assert.equal(canPromoteChapter(acceptedRecord).allowed, true);
const history: NovelPromotionHistoryEntry = { version: 1, id: "promotion-017-test", createdAt: "2026-08-14T00:00:00.000Z", chapter: "017", candidatePath: "drafts/017.md", canonicalPath: "manuscript/017.md", canonicalFingerprint: "10:abc", recordUpdates: [] };
assert.equal(canRollbackPromotion({ ...acceptedRecord, state: "promoted", rollbackHistory: history }).allowed, true);
assert.equal(canRollbackPromotion({ ...acceptedRecord, state: "promoted", rollbackHistory: null }).allowed, false);
const project: NovelProject = { rootPath: "C:/novel", configPath: "C:/novel/.novel/project.json", initialized: true, config: { ...config, authority: { ...config.authority, currentState: "canon/current.md", continuityLedger: "canon/ledger.md" } } };
const updates = parseProposalRecordUpdates("<!-- novel-record-updates\n[{\"target\":\"current-state\",\"append\":\"- Accepted fact.\"}]\n-->", project);
assert.deepEqual(updates.map((update) => [update.targetPath, update.operation, update.append]), [["canon/current.md", "append", "- Accepted fact."]]);
const replacements = parseProposalRecordUpdates("<!-- novel-record-updates\n[{\"target\":\"current-state\",\"operation\":\"replace-once\",\"anchor\":\"- Old fact.\",\"replacement\":\"- New fact.\"}]\n-->", project);
assert.deepEqual(replacements.map((update) => [update.operation, update.anchor, update.replacement]), [["replace-once", "- Old fact.", "- New fact."]]);
const replacementPreview = { ...replacements[0], before: "- Old fact.", after: "- New fact." };
assert.equal(materializeRecordUpdate(replacementPreview, "Before\n- Old fact.\nAfter"), "Before\n- New fact.\nAfter");
assert.throws(() => materializeRecordUpdate(replacementPreview, "- Old fact.\n- Old fact."));
assert.throws(() => parseProposalRecordUpdates("<!-- novel-record-updates\n[{\"target\":\"outside\",\"append\":\"No\"}]\n-->", project));
assert.throws(() => parseProposalRecordUpdates("<!-- novel-record-updates\n[{\"target\":\"current-state\",\"operation\":\"replace-once\",\"anchor\":\"\",\"replacement\":\"No\"}]\n-->", project));
const worldProject: NovelProject = { rootPath: "C:/novel", configPath: "C:/novel/.novel/project.json", initialized: true, config: { formatVersion: 1, layout: { canon: ["canon"] } } };
const worldProposalDocument: NovelDocument = {
	path: "C:/novel/planning/world-proposals/world-change-test-proposal.md",
	relativePath: "planning/world-proposals/world-change-test-proposal.md",
	name: "world-change-test-proposal.md",
	category: "planning",
	classification: classifyNovelDocument("planning/world-proposals/world-change-test-proposal.md", worldProject.config),
	estimatedTokens: 20,
	text: "# World Change Proposal\n\nstatus: PROPOSED_PENDING_USER_ACCEPTANCE\nchange_id: world-change-test\ntarget_path: canon/world.md\ntarget_fingerprint: 10:abcd\naffected_paths: [\"planning/chapter-cards/019.md\"]\ncreated_at: 2026-08-17T00:00:00.000Z\n\n## Proposed Canon Text\n\n```markdown\n# Updated World\n\nNew boundary.\n```\n",
};
const worldProposal = parseWorldChangeProposal(worldProposalDocument, worldProject);
assert.equal(worldProposal?.targetPath, "canon/world.md");
assert.equal(worldProposal?.proposedText, "# Updated World\n\nNew boundary.\n");
assert.deepEqual(worldProposal?.affectedPaths, ["planning/chapter-cards/019.md"]);
assert.equal(listWorldChangeProposals(worldProject, [worldProposalDocument]).length, 1);
assert.throws(() => listWorldChangeProposals(worldProject, [worldProposalDocument, { ...worldProposalDocument, relativePath: "planning/world-proposals/world-change-test-copy.md" }]));
assert.throws(() => parseWorldChangeProposal({ ...worldProposalDocument, text: (worldProposalDocument.text ?? "") + "\n```markdown\nAnother replacement\n```\n" }, worldProject));
console.log("Novel domain smoke passed");
