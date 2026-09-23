import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInside, canonical, digest, readBounded, sha256, writeOnce } from "../core/io.js";
import { hash, validateCatalog, type Catalog, type Selection } from "./catalog.js";
import { projectAggregate, type Projection } from "./project.js";
import { rebuildEvidence } from "./rebuild.js";

export const LIMITATIONS = [
  "这是显式选定封存批次的核验报告，不是全量实验目录扫描；代表性 dry run 不代表其整个故障测试套件。",
  "证据核验通过仅表示重建与哈希一致，不表示任务成功；fail、blocked、unknown、unsupported 均保留。",
  "各批任务、故障、profile 与计量口径不同，不合并成功率，不排名，不生成节省或提升百分比。",
  "真实模型样本很少，比较证据不足；未执行人工创作质量评审、完整历史 Desktop/Rust/RPC 对照或原生发布验收。",
  "Supervisor 与 context maintenance 已有 S4 离线对照和限定真实样本；旧未完成批与新压力负例均保留，每格一次不证明总体优势，安全停止不等于业务完成。B4/Phase X 未实施，整个 Phase 5 尚未完成。",
  "SDK 标准化 output 可能包含 reasoning；provider completion、reasoning、total 独立保留，cache 未报告仍为 null，实际费用未知。",
  "本工具不读取认证、不执行模型/SDK 会话、不复用旧批授权。报告包仅含脱敏重建摘要和哈希索引，不复制原始 prompt、配置或小说。",
  "原始证据仍在本地已忽略的 artifacts 目录；验证包仍需原批次。哈希用于完整性核对，不是第三方签名或远端 CI 证明。",
];
class ReportError extends Error {}
const requireReport = (value: unknown, code: string) => { if (!value) throw new ReportError(code); };

/** Bounded traversal, rejecting links/junctions and special files before reads. */
export async function inventory(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}; let bytes = 0, nodes = 0;
  async function walk(relative: string) {
    requireReport(++nodes <= 4096 && relative.split("/").length <= 6, "REPORT_TREE_LIMIT");
    const full = path.join(directory, relative), stat = await lstat(full);
    requireReport(!stat.isSymbolicLink(), "REPORT_LINK");
    if (stat.isDirectory()) {
      for (const name of (await readdir(full)).sort()) {
        requireReport(/^[A-Za-z0-9_.-]+$/.test(name), "REPORT_FILE_NAME");
        await walk(relative ? relative + "/" + name : name);
      }
    } else {
      requireReport(stat.isFile() && /\.(json|md)$/.test(relative) && stat.size <= 1024 * 1024, "REPORT_FILE_TYPE");
      bytes += stat.size; requireReport(bytes <= 32 * 1024 * 1024, "REPORT_TREE_LIMIT");
      files[relative] = sha256(await readBounded(full));
    }
  }
  await walk(""); return files;
}
export interface Verified {
  selection: Selection; integrity: "verified"; problem: null;
  manifestByteSha256: string; files: Record<string, string>;
  provenance: { commit: string; dirty: boolean; sourceSha256: string; sourceFiles: number };
  savedAggregateCompared: boolean; aggregate: unknown; summary: Projection;
}
export interface Rejected { selection: Selection; integrity: "unavailable" | "invalid"; problem: string; }
export type BatchReport = Verified | Rejected;

export async function inspectBatch(root: string, selection: Selection): Promise<BatchReport> {
  const directory = path.join(root, selection.directory);
  try {
    // All catalog paths are proper children of the workspace; check ancestors,
    // including artifacts itself, instead of trusting a linked artifact root.
    await assertInside(root, directory);
    const before = await inventory(directory);
    requireReport(digest(before) === selection.treeSha256, "REPORT_TREE_MISMATCH");
    const manifestText = await readBounded(path.join(directory, "manifest.json")), manifest = JSON.parse(manifestText);
    const canonicalManifest = selection.family === "module" || selection.family === "sdk-read-write";
    requireReport((canonicalManifest ? digest(manifest) : sha256(manifestText)) === selection.manifestSha256, "REPORT_MANIFEST_MISMATCH");
    const aggregate = await rebuildEvidence(selection.family, directory, before);
    requireReport(aggregate.manifestSha256 === selection.manifestSha256, "REPORT_BINDING_MISMATCH");
    const savedAggregateCompared = "aggregate.json" in before;
    if (savedAggregateCompared) requireReport(canonical(JSON.parse(await readBounded(path.join(directory, "aggregate.json")))) === canonical(aggregate), "REPORT_AGGREGATE_MISMATCH");
    const summary = projectAggregate(selection.family, aggregate, manifest);
    const code = manifest.code; hash(code.sha256); assert.match(code.commit, /^[a-f0-9]{40}$/); assert.equal(typeof code.dirty, "boolean");
    requireReport(canonical(before) === canonical(await inventory(directory)), "REPORT_CHANGED_DURING_READ");
    return { selection, integrity: "verified", problem: null, manifestByteSha256: sha256(manifestText), files: before,
      provenance: { commit: code.commit, dirty: code.dirty, sourceSha256: code.sha256, sourceFiles: Object.keys(code.files).length },
      savedAggregateCompared, aggregate, summary };
  } catch (error) {
    // Never emit arbitrary parser/assertion messages containing record contents.
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { selection, integrity: absent ? "unavailable" : "invalid", problem: absent ? "REPORT_MISSING_EVIDENCE" : error instanceof ReportError ? error.message : "REPORT_INVALID_EVIDENCE" };
  }
}
export interface Report {
  schemaVersion: 1; kind: "phase5-evidence-report"; phase5Complete: false;
  catalogSha256: string; builderSha256: string; verifiedBatches: number; selectedBatches: number;
  newModelRequests: 0; referenceUsdPerMillion: { input: 0.75; output: 3.75; cachedInput: 0.075; referenceOnly: true };
  limitations: string[]; batches: BatchReport[];
}
export async function createReport(root: string, selection: Catalog, builder: Record<string, string>): Promise<Report> {
  validateCatalog(selection);
  const batches: BatchReport[] = [];
  for (const entry of selection.entries) batches.push(await inspectBatch(root, entry));
  return { schemaVersion: 1, kind: "phase5-evidence-report", phase5Complete: false, catalogSha256: digest(selection), builderSha256: digest(builder),
    verifiedBatches: batches.filter(b => b.integrity === "verified").length, selectedBatches: batches.length, newModelRequests: 0,
    referenceUsdPerMillion: { input: 0.75, output: 3.75, cachedInput: 0.075, referenceOnly: true }, limitations: LIMITATIONS, batches };
}
const number = (v: number | null) => v === null ? "未知" : String(v);
export function markdown(report: Report): string {
  const lines = ["# Phase 5 可重建证据报告", "", "## 范围与结论边界", "",
    "证据核验：" + report.verifiedBatches + " / " + report.selectedBatches + " 批。生成本报告新增模型请求：0。Phase 5 未完成。", "",
    ...report.limitations.map(s => "- " + s), "", "## 批次索引", "",
    "| 批次 | 层级 | 核验 | 样本 | pass | fail | blocked | unknown | unsupported | 其他非 pass | 历史真实 HTTP |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const b of report.batches) {
    if (b.integrity !== "verified") {
      lines.push("| " + b.selection.id + " | 未核验 | " + b.integrity + " | — | — | — | — | — | — | — | — |"); continue;
    }
    const s = b.summary, n = s.statuses, other = s.samples - n.pass - n.fail - n.blocked - n.unknown - n.unsupported;
    lines.push("| " + [b.selection.id, s.evidenceKind, "verified", s.samples, n.pass, n.fail, n.blocked, n.unknown, n.unsupported, other, s.realHttpDispatches].join(" | ") + " |");
  }
  lines.push("", "不提供跨批总成功率；表中 pass 的含义由各批合同决定。其他状态的精确分类与 run ID 保留在 report.json。");
  for (const b of report.batches) if (b.integrity === "verified" && b.selection.family === "sdk-recovery") {
    const unknown = b.summary.groups.reduce((n, g) => n + (g.operationOutcomes["unknown-replay-blocked"] ?? 0), 0);
    const completed = b.summary.groups.reduce((n, g) => n + (g.operationOutcomes["satisfied-by-readback"] ?? 0), 0);
    lines.push("", b.selection.id + "：机械安全合同 pass=" + b.summary.statuses.pass + "；业务结局另计：对账完成 " + completed + "，仍未知且阻止重放 " + unknown + "。");
  }
  for (const b of report.batches) if (b.integrity === "verified" && b.selection.family === "sdk-supervision") {
    const n = (key: string) => b.summary.groups.reduce((total, g) => total + (g.businessOutcomes[key] ?? 0), 0);
    lines.push("", b.selection.id + "：机械合同 pass=" + b.summary.statuses.pass + "；业务结局另计：公开候选已验证 " + n("verified-public-candidate")
      + "，只读答复 " + n("read-only-answer") + "，无进展停止 " + n("no-progress-stopped") + "，等待验证 " + n("verification-required")
      + "，预算阻断 " + n("budget-blocked") + "，未验证最终答案 " + n("unverified-final-answer") + "，未观测 " + n("unobserved")
      + "。没有任何一项代表人工验收或 Canon 晋升。");
  }
  for (const b of report.batches) {
    const e = b.selection;
    lines.push("", "## " + e.id, "", "原批次：" + e.directory, "", "清单 SHA-256：" + e.manifestSha256, "", "证据树 SHA-256：" + e.treeSha256, "");
    if (b.integrity !== "verified") { lines.push("未产生任务统计：" + b.integrity + " / " + b.problem + "。原记录没有删除或补造。"); continue; }
    lines.push(b.summary.boundary, "", "历史代码：" + b.provenance.commit + "；dirty=" + b.provenance.dirty + "。",
      "历史源码映射 SHA-256：" + b.provenance.sourceSha256 + "（" + b.provenance.sourceFiles + " 文件）。", "",
      b.savedAggregateCompared ? "从原始记录重建，并与原汇总逐字段核对一致；原文件前后 SHA 不变。" : "从原始记录重建；该历史批次没有保存 aggregate.json，未向原目录补写。", "",
      "| Profile | 任务 | 样本 | pass | fail | blocked | unknown | unsupported | 其他非 pass | 原因码 |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const g of b.summary.groups) {
      const n = g.statuses, other = g.samples - n.pass - n.fail - n.blocked - n.unknown - n.unsupported;
      lines.push("| " + [g.profile, g.task, g.samples, n.pass, n.fail, n.blocked, n.unknown, n.unsupported, other, g.reasonCodes.join(", ") || "见原始记录"].join(" | ") + " |");
    }
    const outcomes = b.summary.groups.filter(g => Object.keys(g.operationOutcomes).length);
    if (outcomes.length) lines.push("", "独立操作/请求结局（不可用机械 pass 替代）：", "", ...outcomes.map(g =>
      "- " + g.profile + " / " + g.task + "：" + Object.entries(g.operationOutcomes).map(([key, n]) => key + "=" + n).join("；")));
    const business = b.summary.groups.filter(g => Object.keys(g.businessOutcomes).length);
    if (business.length) lines.push("", "独立业务结局（不是机械通过率或人工验收）：", "", ...business.map(g =>
      "- " + g.profile + " / " + g.task + "：" + Object.entries(g.businessOutcomes).map(([key, n]) => key + "=" + n).join("；")));
    const sl = b.summary.supervisionLive;
    if (sl) {
      const n = (key: string) => b.summary.groups.reduce((total, g) => total + (g.businessOutcomes[key] ?? 0), 0);
      const coverage = sl.usageCoverage, branches = sl.noProgressBranches;
      const branchLabels = { triggered: "已触发", not_triggered: "未触发", unobserved: "未观测" };
      lines.push("", "### S4 实测合同与业务边界", "",
        "记录 v" + sl.schemaVersion + "；预算 " + sl.budgetNamespace + "；每项 / 全批请求上限 " + sl.taskHttpLimit + " / " + sl.batchHttpLimit
          + "（普通与原生摘要共享）。封存状态：" + sl.batchStatus + "；待结算请求 " + sl.pendingHttpRequests + "。",
        "", "机械 pass=" + b.summary.statuses.pass + "；业务结局另计：候选已验证 " + n("verified_candidate") + "，前提缺失时停止 " + n("blocked_prerequisite")
          + "，只读答复 " + n("read_only_answer") + "，预算阻断 " + n("budget_blocked") + "，无进展停止 " + n("no_progress_stopped")
          + "，等待验证 " + n("verification_required") + "，未验证最终答案 " + n("unverified_final_answer") + "，未知/未运行 " + n("unknown")
          + "。没有任何一项代表人工验收或 Canon 晋升。",
        "", "NO_PROGRESS 分支：已触发 " + branches.triggered + "，未触发 " + branches.not_triggered + "，未观测 " + branches.unobserved
          + "；未触发不等于分支效果已经验证。",
        "", "| Profile / 任务 | 请求预留（普通 / 摘要） | 实际 HTTP | SDK 入口回执 / broker 提交 | 原生压缩 | NO_PROGRESS | 传输诊断 |",
        "| --- | ---: | ---: | --- | ---: | --- | --- |");
      for (const row of sl.rows) {
        const reason = row.diagnostics === "legacy-not-recorded" ? "历史未记录细分诊断" : row.diagnostics === "unobserved" ? "未运行/未观测"
          : row.stopCode ?? "无传输停止";
        lines.push("| " + [row.profile + " / " + row.task, row.reservations + "（" + row.ordinaryReservations + " / " + row.summaryReservations + "）",
          number(row.httpDispatches), number(row.sdkEntries) + " / " + number(row.brokerOffers), number(row.nativeCompactions), branchLabels[row.noProgressBranch], reason].join(" | ") + " |");
      }
      lines.push("", "SDK 入口、请求预留和 HTTP 派发不是同一计数。产品预算门可在 broker 前阻断；无传输停止不等于业务完成。旧记录不补造细分停止码或 SDK 用量。",
        "", "用量覆盖：" + coverage.tasksWithReservations + " / " + coverage.plannedTasks + " 项有 HTTP 请求预留；其余 " + coverage.tasksWithoutReservations
          + " 项零预留，其中 " + coverage.unrunTasks + " 项未运行。下表仅汇总有预留任务，任一相关字段缺失仍为未知；零请求任务原始用量保留 null，不当成报告了 0。");
    }
    const u = b.summary.providerActualUsage;
    if (u) lines.push("", "历史真实 HTTP：" + b.summary.realHttpDispatches + "；结果未知请求：" + number(b.summary.unknownHttpRequests) + "。", "",
      "| Provider prompt | completion | reasoning | cached | total | SDK output | 实际费用 |",
      "| ---: | ---: | ---: | ---: | ---: | ---: | --- |",
      "| " + [number(u.prompt), number(u.completion), number(u.reasoning), number(u.cached), number(u.total), number(b.summary.sdkNormalizedOutput), "未知"].join(" | ") + " |",
      "", "参考单价 $0.75 / $3.75 / $0.075 每百万 input/output/cache tokens；仅作参考，不按 SDK 的零缓存缺省值估算实付。");
    else lines.push("", "真实 provider usage / 费用：未知；合成 usage 仅保留在重建记录中，不冒充实测。");
  }
  lines.push("", "## 追溯与下一步", "", "report.json 保留每组 run ID、完整状态分类和经过原验证器重建的 aggregate；证据文件名及字节 SHA 在各批 files 中。",
    "selection.json 冻结本次选择；builder-sources.json 记录报告工具源码/依赖指纹。未附原始私有内容，不能在缺失原批次时独立重建。",
    "后续真实模型自主对照须重新定义共同任务与请求预算，并另立清单批准；离线合同、完整 Desktop 与发布验收继续分轨管理。", "");
  return lines.join("\n");
}

export async function writePackage(root: string, selection: Catalog, builder: Record<string, string>) {
  const report = await createReport(root, selection, builder);
  const parent = path.join(root, "artifacts/harness/reports");
  // Validate the nearest existing ancestor before mkdir can follow a junction.
  await assertInside(root, path.join(root, "artifacts/harness"));
  try { await assertInside(root, parent); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(parent, { recursive: true }); await assertInside(root, parent);
  const directory = await mkdtemp(path.join(parent, "report-"));
  await writeOnce(path.join(directory, "selection.json"), selection);
  await writeOnce(path.join(directory, "builder-sources.json"), builder);
  await writeOnce(path.join(directory, "report.json"), report);
  await writeFile(path.join(directory, "report.md"), markdown(report), { encoding: "utf8", flag: "wx" });
  const files = await inventory(directory);
  await writeOnce(path.join(directory, "manifest.json"), { schemaVersion: 1, kind: "phase5-report-package", files, filesSha256: digest(files) });
  return { directory, report };
}
export async function verifyPackage(root: string, directory: string, builder: Record<string, string>) {
  const relative = path.relative(root, path.resolve(directory)).replaceAll("\\", "/");
  assert.match(relative, /^artifacts\/harness\/reports\/report-[A-Za-z0-9_-]+$/, "REPORT_PACKAGE_PATH");
  await assertInside(root, directory);
  const before = await inventory(directory), read = async (name: string) => JSON.parse(await readBounded(path.join(directory, name)));
  assert.deepEqual(Object.keys(before).sort(), ["builder-sources.json", "manifest.json", "report.json", "report.md", "selection.json"]);
  const manifest = await read("manifest.json");
  assert.deepEqual(Object.keys(manifest).sort(), ["files", "filesSha256", "kind", "schemaVersion"]);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.kind, "phase5-report-package");
  const payload = { ...before }; delete payload["manifest.json"];
  assert.deepEqual(manifest.files, payload); assert.equal(digest(payload), manifest.filesSha256);
  assert.deepEqual(await read("builder-sources.json"), builder, "REPORT_BUILDER_DRIFT");
  const selection = validateCatalog(await read("selection.json")), rebuilt = await createReport(root, selection, builder);
  assert.deepEqual(await read("report.json"), rebuilt, "REPORT_REBUILD_DRIFT");
  assert.equal(await readBounded(path.join(directory, "report.md")), markdown(rebuilt), "REPORT_MARKDOWN_DRIFT");
  assert.deepEqual(await inventory(directory), before, "REPORT_PACKAGE_CHANGED");
  return { verifiedBatches: rebuilt.verifiedBatches, selectedBatches: rebuilt.selectedBatches, newModelRequests: 0, filesSha256: manifest.filesSha256 };
}
