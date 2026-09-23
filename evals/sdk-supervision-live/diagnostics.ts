import assert from "node:assert/strict";
import type { RequestStopCode } from "../core/request-transport.js";
import type { RequestLimits } from "../core/request-policy.js";
import { sha256 } from "../core/io.js";
import type { createContextBroker } from "../sdk-context-transport/broker.js";
import { count, exact, hash } from "../sdk-live/manifest.js";
import { LIMITS, RUNS, type Run } from "./policy.js";

// Fixed enum projection only: never retain exception messages, payloads or URLs.
export const STOP_LABELS: Record<RequestStopCode, string> = {
  MANUAL_STOP: "执行器停止", INVOCATION_REQUIRED: "缺少有效请求入口", INVOCATION_CONCURRENT: "请求入口并发冲突",
  INVOCATION_REUSED: "重复使用请求入口", TASK_REQUEST_LIMIT: "达到单项请求上限", BATCH_REQUEST_LIMIT: "达到全批请求上限",
  INPUT_ESTIMATE_LIMIT: "单次输入估算超限", BATCH_INPUT_LIMIT: "全批输入预留超限", BATCH_OUTPUT_LIMIT: "全批输出预留超限",
  REQUEST_BYTES_LIMIT: "请求字节超限", OUTPUT_FIELD_INVALID: "输出限制参数无效", MODEL_MISMATCH: "模型不匹配",
  ENDPOINT_MISMATCH: "请求端点不匹配", METHOD_INVALID: "请求方法无效", REDIRECT_FORBIDDEN: "禁止重定向",
  REQUEST_TIMEOUT: "请求超时", TASK_TIMEOUT: "单项超时", BATCH_TIMEOUT: "全批超时", REQUEST_ABORTED: "请求已取消",
  NETWORK_FAILURE: "网络失败", HTTP_FAILURE: "HTTP 失败", RESPONSE_BYTES_LIMIT: "响应字节超限", RESPONSE_INCOMPLETE: "响应不完整",
  USAGE_INVALID: "用量缺失或无效", PROVIDER_USAGE_LIMIT: "返回用量超限", JOURNAL_FAILURE: "请求日志故障", RESET_FORBIDDEN: "禁止重置额度",
};
export interface OfferDiagnostic {
  id: number; kind: "ordinary" | "summary"; payloadBytes: number; requestSha256: string;
  reservationOrdinal: number | null; dispatchAttempted: boolean; returned: boolean; stopCode: RequestStopCode | null;
}
export interface TransportDiagnostic { stopCode: RequestStopCode | null; offers: OfferDiagnostic[]; }
type Broker = Awaited<ReturnType<typeof createContextBroker>>;

const stopCode = (value: unknown) => assert.ok(value === null || typeof value === "string" && Object.hasOwn(STOP_LABELS, value), "S4L_STOP_CODE_INVALID");
export function validateTransportDiagnostic(value: unknown, limits: Readonly<RequestLimits> = LIMITS): TransportDiagnostic {
  const d = exact(value, ["stopCode", "offers"]); stopCode(d.stopCode);
  assert.ok(Array.isArray(d.offers) && d.offers.length <= limits.maxTaskHttpRequests + 2);
  let previousOrdinal = 0;
  for (let i = 0; i < d.offers.length; i++) {
    const o = exact(d.offers[i], ["id", "kind", "payloadBytes", "requestSha256", "reservationOrdinal", "dispatchAttempted", "returned", "stopCode"]);
    assert.equal(o.id, i + 1); assert.ok(["ordinary", "summary"].includes(o.kind)); count(o.payloadBytes, limits.maxInputBytes); hash(o.requestSha256);
    assert.equal(typeof o.dispatchAttempted, "boolean"); assert.equal(typeof o.returned, "boolean"); stopCode(o.stopCode);
    if (o.reservationOrdinal !== null) { count(o.reservationOrdinal, limits.maxHttpRequests); assert.ok(o.reservationOrdinal > previousOrdinal); previousOrdinal = o.reservationOrdinal; }
    if (o.dispatchAttempted) assert.notEqual(o.reservationOrdinal, null);
    if (o.returned) { assert.ok(o.dispatchAttempted); assert.equal(o.stopCode, null); }
    else { assert.notEqual(o.stopCode, null); assert.equal(o.stopCode, d.stopCode); }
    if (o.reservationOrdinal === null) assert.equal(o.dispatchAttempted, false);
  }
  return d as TransportDiagnostic;
}

/** Parent-owned IPC observations. The existing Journal is authoritative for
 * durable HTTP dispatch/usage. Diagnostics are sealed with the task record;
 * they are not a new arbitrary-crash recovery journal. */
export function observeRunTransport(broker: Broker, run: Run) {
  const offers: OfferDiagnostic[] = [], pending: Promise<unknown>[] = [];
  let finished = false;
  const observed: Broker = { ...broker, submit(offer) {
    assert.ok(!finished && offer.taskId === run.runId && offers.length < LIMITS.maxTaskHttpRequests + 2, "S4L_DIAGNOSTIC_SCOPE");
    const item: OfferDiagnostic = { id: offers.length + 1, kind: offer.kind, payloadBytes: Buffer.byteLength(offer.body), requestSha256: sha256(offer.body),
      reservationOrdinal: null, dispatchAttempted: false, returned: false, stopCode: null };
    offers.push(item);
    const request = broker.submit(offer).then(response => { item.returned = true; return response; }).finally(() => {
      const snapshot = broker.snapshot().transport;
      const reserved = snapshot.requests.find(r => r.taskId === run.runId && r.invocationId === offer.id);
      if (reserved) { item.reservationOrdinal = reserved.ordinal; item.dispatchAttempted = reserved.dispatchAttempted; }
      if (!item.returned) item.stopCode = snapshot.stopCode ?? "MANUAL_STOP";
    });
    pending.push(request.then(() => undefined, () => undefined)); return request;
  } };
  return { broker: observed, async finish(): Promise<TransportDiagnostic> {
    finished = true; await Promise.all(pending);
    return validateTransportDiagnostic({ stopCode: broker.snapshot().transport.stopCode, offers: structuredClone(offers) });
  } };
}

export function formatDiagnostics(aggregate: {
  schemaVersion: number; status: string; realHttpDispatches: number; simulatedHttpDispatches: number;
  rows: Array<{ run: Run; status: string; reasonCode: string; requests: number; transportDiagnostics?: {
    stopCode: RequestStopCode | null; sdkEntries: number | null; offered: number; dispatched: number;
    rejectedBeforeReservation: number; reservedNotDispatched: number; failedAfterDispatch: number; retryBlocks: number | null;
  } | null }>;
}) {
  const lines = [`S4 批次诊断（记录 v${aggregate.schemaVersion}）`, `批次状态：${aggregate.status}；真实 HTTP ${aggregate.realHttpDispatches}；合成 HTTP ${aggregate.simulatedHttpDispatches}`,
    "SDK 入口 ≠ 提交给 broker ≠ 实际 HTTP；本地拒绝/重试拦截不计实际派发。", "",
    "| 任务 / 配置 | 状态 | SDK 入口回执 | broker 提交 | HTTP 预留 | HTTP 派发 | 预留前拒绝 | 已预留未派发 | 派发后失败 | 本地 fetch 拦截 | 停止原因 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of aggregate.rows) {
    assert.ok(RUNS.some(r => r.runId === row.run.runId));
    const d = row.transportDiagnostics, profile = row.run.profile.includes("maintenance") ? "M" : row.run.profile.includes("supervisor-v1") ? "S" : "C";
    const reason = d?.stopCode ? `${d.stopCode}（${STOP_LABELS[d.stopCode]}）` : aggregate.schemaVersion === 1 ? "历史未记录细分原因" : row.status === "blocked" ? "全批已停止，未运行" : d ? "无传输停止" : "尚未观测";
    lines.push(`| ${row.run.task} / ${profile} | ${row.status} | ${d?.sdkEntries ?? "—"} | ${d?.offered ?? "—"} | ${row.requests} | ${d?.dispatched ?? "—"} | ${d?.rejectedBeforeReservation ?? "—"} | ${d?.reservedNotDispatched ?? "—"} | ${d?.failedAfterDispatch ?? "—"} | ${d?.retryBlocks ?? "—"} | ${reason} |`);
  }
  lines.push("", "费用仍按独立用量证据判断；cache 不明时费用未知。诊断不重跑、不追加额度，也不改写业务结果。");
  return lines.join("\n");
}
