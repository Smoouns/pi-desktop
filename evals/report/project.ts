import assert from "node:assert/strict";
import { token, type Family } from "./catalog.js";

export const STATUSES = ["pass", "fail", "blocked", "blocked_user", "blocked_prerequisite", "no_progress", "cancelled", "invalid", "unsupported", "unknown"] as const;
export type Status = typeof STATUSES[number];
export const emptyStatuses = () => Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<Status, number>;
export const count = (v: unknown): number => { assert.ok(Number.isSafeInteger(v) && (v as number) >= 0, "REPORT_COUNT"); return v as number; };
export const sumKnown = (values: Array<number | null | undefined>) =>
  values.length > 0 && values.every(v => v !== null && v !== undefined) ? values.reduce<number>((n, v) => n + count(v), 0) : null;
export interface Group {
  profile: string; task: string; samples: number; statuses: Record<Status, number>;
  runIds: string[]; reasonCodes: string[]; operationOutcomes: Record<string, number>;
  businessOutcomes: Record<string, number>;
}
export interface ProviderUsage {
  prompt: number | null; completion: number | null; reasoning: number | null; cached: number | null; total: number | null;
}
export const notes: Record<Family, string> = {
  module: "离线模块合同，不是完整历史 Desktop。旧预算字节与新 token 估算不可直接比较；C3/current-full 在此使用相同 factory。",
  pilot: "固定 SDK 最小读写实测；不评价创作质量。早期 V1 没有原始答案，具体失败原因不可追溯，不能补造。",
  "sdk-read-write": "合成脚本驱动的读写/丢回执切片；预登记基线负例仍按 fail 报告，不等于模型实际行为。",
  "sdk-live": "每格仅一轮真实模型或明确标记的合成 dry run；格式失败保留，不能推出整体优劣。",
  "sdk-context": "固定响应摘要、手动原生压缩及跨进程重开；不是摘要质量、自动压缩或 Desktop 全流程。",
  "sdk-lifecycle": "合成 usage/overflow 的自动压缩切片；未知写入被阻止不等于创作完成。",
  "sdk-transport": "单个预登记传输探针；机械合同通过与 requestOutcome 分开，不代表整个故障套件或模型效果。",
  "sdk-context-live": "两 profile 各两项限定任务；真实样本每格一次，手动压缩不代表自动压缩或普遍摘要质量。",
  "sdk-recovery": "固定屏障的子进程强杀恢复；pass 仅指恢复安全合同，unknown-replay-blocked 仍未完成写入。不覆盖断电、父 broker 或 Desktop。",
  "sdk-supervision": "三种 SDK 配置的合成对照；无进展停止、待验证与公开候选通过分开，不等于正文验收。输入维护触发的原生 manual compaction 不是自动阈值压缩；不评价真实摘要质量或模型节省。",
  "sdk-supervision-live": "固定 SDK、公开合成任务、每格一次；旧 6/54 与新 8/72 合同分批保留。候选验证、缺前提停止、压力预算阻断和只读答复不是人工验收。未触发分支不算效果证据；真实手动压缩不代表自动压缩、长篇质量或总体收益。",
};

/** Called only after the family-specific raw/schema/hash reconstruction. */
export function projectAggregate(family: Family, a: any, manifest: any) {
  const groups: Group[] = [];
  const group = (profile: string, task: string) => {
    profile = token(profile); task = token(task);
    let g = groups.find(g => g.profile === profile && g.task === task);
    if (!g) { g = { profile, task, samples: 0, statuses: emptyStatuses(), runIds: [], reasonCodes: [], operationOutcomes: {}, businessOutcomes: {} }; groups.push(g); }
    return g;
  };
  const add = (profile: string, task: string, id: string, status: Status, reason?: string, outcome?: string, businessOutcome?: string) => {
    assert.ok(STATUSES.includes(status), "REPORT_STATUS");
    const g = group(profile, task); g.samples++; g.statuses[status]++; g.runIds.push(token(id));
    if (reason && !g.reasonCodes.includes(reason)) g.reasonCodes.push(token(reason));
    if (outcome) { token(outcome); g.operationOutcomes[outcome] = (g.operationOutcomes[outcome] ?? 0) + 1; }
    if (businessOutcome) { token(businessOutcome); g.businessOutcomes[businessOutcome] = (g.businessOutcomes[businessOutcome] ?? 0) + 1; }
  };
  if (family === "module" || family === "sdk-read-write") {
    for (const item of a.taskGroups ?? a.groups) {
      const g = group(item.variant ?? item.profile, item.taskId ?? item.category);
      g.samples = count(item.count);
      for (const [status, n] of Object.entries(item.statuses)) {
        assert.ok(STATUSES.includes(status as Status), "REPORT_STATUS"); g.statuses[status as Status] = count(n);
      }
      g.runIds = (item.runIds ?? manifest.runs.filter((r: any) => r.profile === g.profile && r.taskId === g.task).map((r: any) => r.runId)).map(token);
    }
  } else if (family === "pilot") {
    for (const t of a.tasks) add("pilot-current", t.taskId, t.taskId, t.status, t.reasonCode);
  } else if (family === "sdk-transport") {
    add("unified-transport", a.scenario, a.scenario, a.contractPassed ? "pass" : "fail", a.stopCode ?? undefined, a.requestOutcome);
  } else {
    for (const r of a.rows) {
      const run = r.run ?? r;
      if (family === "sdk-supervision") {
        assert.equal(r.userAccepted, false, "REPORT_NO_SYNTHETIC_APPROVAL");
        assert.ok(["no-progress-stopped", "verification-required", "budget-blocked", "unverified-final-answer", "verified-public-candidate", "read-only-answer", "unobserved"].includes(r.businessOutcome), "REPORT_BUSINESS_OUTCOME");
      }
      if (family === "sdk-supervision-live") {
        assert.equal(r.userAccepted, false, "REPORT_NO_SYNTHETIC_APPROVAL");
        assert.ok(["unknown", "no_progress_stopped", "budget_blocked", "blocked_prerequisite", "read_only_answer", "verified_candidate", "verification_required", "unverified_final_answer"].includes(r.businessOutcome), "REPORT_BUSINESS_OUTCOME");
      }
      add(run.profile ?? "sdk-b3-checkpoint-ops-v2", run.taskId ?? run.task ?? run.scenario, run.runId, r.status, r.reasonCode ?? r.reason, r.operationOutcome,
        family === "sdk-supervision" || family === "sdk-supervision-live" ? r.businessOutcome : undefined);
    }
  }
  const ids: string[] = [];
  for (const g of groups) {
    assert.equal(Object.values(g.statuses).reduce((a, b) => a + b, 0), g.samples, "REPORT_STATUS_SUM");
    assert.equal(g.runIds.length, g.samples, "REPORT_RUN_IDS");
    if (family === "sdk-supervision" || family === "sdk-supervision-live") assert.equal(Object.values(g.businessOutcomes).reduce((n, v) => n + v, 0), g.samples, "REPORT_BUSINESS_SUM");
    g.runIds.sort(); g.reasonCodes.sort(); ids.push(...g.runIds);
  }
  assert.equal(new Set(ids).size, ids.length, "REPORT_DUPLICATE_RUN");
  const totals = emptyStatuses();
  for (const g of groups) for (const s of STATUSES) totals[s] += g.statuses[s];
  const live = a.mode === "live";
  let provider: ProviderUsage | null = null, sdkOutput: number | null = null;
  const usage = (items: any[], keys: string[]): ProviderUsage => {
    const fields = ["prompt", "completion", "reasoning", "cached", "total"];
    return Object.fromEntries(fields.map((f, i) => [f, sumKnown(items.map(u => u?.[keys[i]]))])) as unknown as ProviderUsage;
  };
  if (live && family === "pilot") {
    provider = usage([a.providerUsage], ["promptTokens", "completionTokens", "reasoningTokens", "cachedTokens", "totalTokens"]);
    sdkOutput = sumKnown([a.sdkUsage.outputTokens]);
  } else if (live && family === "sdk-live") {
    provider = usage(a.rows.map((r: any) => r.providerUsage), ["promptTokens", "completionTokens", "reasoningTokens", "cachedTokens", "totalTokens"]);
    sdkOutput = sumKnown(a.rows.map((r: any) => r.sdkUsage?.outputTokens));
  } else if (live && family === "sdk-context-live") {
    provider = usage(a.rows.map((r: any) => r.providerActualUsage), ["input", "output", "reasoning", "cached", "total"]);
    sdkOutput = sumKnown(a.rows.map((r: any) => r.sdkUsage?.output));
  } else if (live && family === "sdk-supervision-live") {
    // Zero-reservation tasks have no provider receipt; leave their raw usage
    // null without hiding missing usage from any task that reserved a request.
    const measured = a.rows.filter((r: any) => count(r.requests) > 0);
    provider = usage(measured.map((r: any) => r.providerActualUsage), ["input", "output", "reasoning", "cached", "total"]);
    sdkOutput = sumKnown(measured.map((r: any) => r.sdkUsage?.output));
  }
  const supervisionLive = family === "sdk-supervision-live" ? supervisionLiveSummary(a, manifest) : null;
  // Never use normalized SDK cacheRead=0 to fill missing provider cache counters.
  return {
    evidenceKind: live ? "live-model" : family === "module" ? "offline-contract" : "synthetic-sdk",
    samples: ids.length, statuses: totals, groups, providerActualUsage: provider, sdkNormalizedOutput: sdkOutput, actualCostUsd: null,
    realHttpDispatches: family === "module" ? 0 : count(a.realHttpDispatches),
    simulatedHttpDispatches: a.simulatedHttpDispatches === undefined ? null : count(a.simulatedHttpDispatches),
    unknownHttpRequests: live ? count(a.possibleUnknownDispatches ?? a.unknownRequests) : null,
    boundary: notes[family],
    ...(supervisionLive ? { supervisionLive } : {}),
  };
}
export type Projection = ReturnType<typeof projectAggregate>;

function supervisionLiveSummary(a: any, manifest: any) {
  assert.equal(a.sealed, true, "REPORT_S4_UNSEALED");
  assert.ok([1, 2, 3].includes(a.schemaVersion)); assert.equal(a.schemaVersion, manifest.schemaVersion);
  assert.ok(["pass", "completed-with-failures", "incomplete"].includes(a.status));
  const branches = { triggered: 0, not_triggered: 0, unobserved: 0 };
  const rows = (a.rows as any[]).map((r: any) => {
    assert.ok(Object.hasOwn(branches, r.noProgressBranch), "REPORT_S4_BRANCH");
    branches[r.noProgressBranch as keyof typeof branches]++;
    const d = r.transportDiagnostics;
    const optionalCount = (v: unknown) => v === null ? null : count(v);
    return { runId: token(r.run.runId), profile: token(r.run.profile), task: token(r.run.task),
      status: r.status as Status, businessOutcome: token(r.businessOutcome), noProgressBranch: r.noProgressBranch as keyof typeof branches,
      reservations: count(r.requests), ordinaryReservations: count(r.ordinary), summaryReservations: count(r.summaries),
      nativeCompactions: optionalCount(r.nativeCompactions),
      diagnostics: a.schemaVersion === 1 ? "legacy-not-recorded" as const : d ? "recorded" as const : "unobserved" as const,
      stopCode: d?.stopCode == null ? null : token(d.stopCode), sdkEntries: d ? optionalCount(d.sdkEntries) : null,
      brokerOffers: d ? count(d.offered) : null, httpDispatches: d ? count(d.dispatched) : null };
  });
  assert.equal(rows.reduce((n: number, r: { reservations: number }) => n + r.reservations, 0), count(a.sharedReserved), "REPORT_S4_RESERVATIONS");
  return { schemaVersion: count(manifest.schemaVersion), budgetNamespace: token(manifest.policy.namespace),
    taskHttpLimit: count(manifest.limits.maxTaskHttpRequests), batchHttpLimit: count(manifest.limits.maxHttpRequests),
    batchStatus: token(a.status), sealed: true as const, pendingHttpRequests: count(a.pendingRequests),
    usageCoverage: { basis: "tasks-with-http-reservations" as const, plannedTasks: rows.length,
      tasksWithReservations: rows.filter((r: { reservations: number }) => r.reservations > 0).length,
      tasksWithoutReservations: rows.filter((r: { reservations: number }) => r.reservations === 0).length,
      unrunTasks: rows.filter((r: { status: Status }) => r.status === "blocked").length },
    noProgressBranches: branches, rows };
}
