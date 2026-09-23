# Phase 5 S2：同 SDK 读写切片的独立实测工装

本增量接通真实 SDK provider 路径、四项运行的父进程 broker、额度、持久化 Journal、清单批准与只读恢复。**开发验收只用合成 SSE，不调用真实模型、不读取用户认证配置、不自动准备或批准真实批次。** 它不代表整个 Phase 5 或完整 Desktop/Rust/RPC 已完成。

## 1. 与既有轨道的区别

- S1 的 `sdk-b0-safety-fixed` / `sdk-b1-reliability` 扩展及安全包装不变。新工装在 `evals/sdk-live/`，公开产物进入 `artifacts/harness/sdk-live/`；不改 S1 记录格式和固定脚本演练。
- 真实入口保留 SDK 模型循环和序列化/parser，模型自行决定使用共同的 `read_story_document`、`read`、`write`。不把 S1 的固定重放回复、预设事实答案或评分 oracle 送给真实模型。
- 复用冻结 SDK `0.63.1`，准备阶段记录两个任务各 profile 的工具、有效系统提示、业务提示和扩展 SHA。相同任务跨 profile 的系统提示、工具和业务提示必须相同。
- 旧 pilot 的传输/Journal 实现抽到 `evals/core/request-*`；原入口仍绑定原两个 task、每任务 4 次/共 8 次上限与原 Journal 身份。S2 绑定独立 namespace 和四个 run ID，每个 run 的额度独立，不能把两个 profile 合并到同一 task 额度。
- 两条轨道各自封存并拒绝重跑；不能重用旧 pilot 授权或剩余额度。`evals/variants.ts` 的完整历史桌面 B0/B1 状态不变。

## 2. 固定合同

顺序：READ B0 → READ B1 → TOOL B1 → TOOL B0，各一次，并发 1。

READ 读取 `canon/world.md`，严格 JSON 的事实值/签字顺序正确、至少一次有效读取、无业务写入、正常结束才通过。复用 pilot 的安全答案诊断，只输出枚举，不保存最终回答、异常原文或思考。

TOOL 仅允许写固定内容到 `drafts/candidates/sdk-ablation-probe.md`，首次原生写入成功后丢弃回执。模型可以普通读回，也可以由 B1 拦住相同意图重放；必须最终字节正确、有效读回且只发生一次原生写入。重复派发与重复文本不是同一概念，本例不宣称产生重复正文。

任务版本为 `sdk-read-write-v2`，driver 为 `provider-selected-tools-v1`，故障/评分/停止策略分别版本化。S1 的任务 ID 沿用，但不得把旧脚本结果并入本轨道真实样本。

| 固定上限 | 值 |
| --- | ---: |
| 任务运行 / HTTP | 4 次运行；每项最多 6 次，共最多 24 次 |
| 每请求输入估算 / 输出参数 / 安全余量 | 32,768 / 2,048 / 4,096 |
| 批次输入估算预留 / 输出预留 | 786,432 / 49,152 |
| 请求 / 任务 / 批次超时 | 90 / 360 / 1,440 秒 |
| 每任务工具请求 | 最多 6 次 |

输入按完整序列化 UTF-8 字节保守估算，不是实际 token。provider 原始 usage、SDK 标准化 usage、本地预留分列；cache/费用未报告为 null。客户端无法控制代理内部行为或保证服务商账单，费用仍未知。首批关闭自动重试、压缩、命名、skills 和全局资源发现。

普通答案/单次写入合同失败保留为 fail，并执行剩余预登记项；不补跑、不根据结果改顺序。越权、未知写入、worker 失联、用量缺失、来源漂移或预算耗尽停止批次，后续为 blocked。停止不是验收通过；没有 worker 回执时 metrics 为 null，不能推断零写入。

## 3. 权限与日志链

1. `prepare` 只投影精确模型选择的配置，不解析密钥、不发请求；生成新的不可变清单，冻结代码/依赖运行树/fixture/运行顺序/版本/预算/环境/有效提示。有效期 24 小时。
2. 真实运行要求清单 SHA 与明确接受费用未知的批准参数。dry-run 清单、旧 pilot 清单、过期/修改/已 claim 的批次均拒绝；先检查授权、源码和运行环境，再读取选定凭据。
3. 父进程只继承选定凭据引用；worker 的环境白名单没有凭据，其模型 URL 为无效哨兵。worker 禁止直接网络和子进程，只把 SDK 序列化请求经 IPC 交给父进程。
4. 父进程对实际 body 做上限检查，先独占写入并同步落盘 reserve，才允许单次派发。完整响应和有效 usage 持久化 settle 后，响应才交回 SDK。重定向、隐式 HTTP 重试、并发/复用 invocation 均拒绝。
5. 每批永久 claim，事件哈希链绑定清单和 namespace。崩溃后未 settle 的 reserve 保守记为可能已派发/unknown，不退款、不自动恢复调用。只读 recover 可以审计残缺批次，但不代替缺失记录补成功。

这是受信任代码的测试隔离，不是操作系统安全沙箱。文件系统和子进程只用于公开 fixture 临时副本；不接触私人小说和全局 Pi 设置。公有 JSON 不含 endpoint、key、原始模型回复或原始异常；只保留指纹、有限原因码和数值。

## 4. 命令与批准边界

离线运行，无需模型配置：

```powershell
npm run test:sdk-live
npm run eval:sdk-live:dry-run
npm run eval:sdk-live:recover -- artifacts/harness/sdk-live/<batch-id>
```

后续决定准备真实批次时：

```powershell
npm run eval:sdk-live:prepare -- <models.json>
```

它只输出新清单的精确 SHA、有效期、公开模型信息和上限。应先向用户展示这些内容并取得该批批准；**本增量的“可以实现”不是最多 24 次真实 HTTP 的授权**。

批准后才使用独立执行入口（以下是格式说明，不表示已经批准）：

```powershell
npm run eval:sdk-live:run -- <batch-dir> <models.json> --approve <exact-manifest-sha256> --accept-unknown-cost
```

不接受更宽预算参数；改代码/任务/模型/上限都须创建新清单。旧 SDK/current-full pilot 的结果不并入新比较，也不将一次真实重复宣传为统计优势。

## 5. 验收证据

S2 的 **95 项离线检查**与全新依赖的 **11 命令隔离回归**均通过。最终读回批次为 `s2-dry-mQwGip`，4/4 pass、10 次模拟派发、真实 HTTP 为 0；八个端到端场景共 156 个产物文件只读重建后 SHA 不变。详细批次、负结果与源码指纹见 [结果记录](HARNESS_PHASE5_RESULTS.md) 第十一增量。

测试覆盖端到端读回、固定重放负例、普通答案失败后继续、安全/网络/用量失败后停止，及批准/预算/Journal/记录防篡改。模拟 SSE 和 synthetic usage 不是模型效果或费用证据。远端 CI 与原生 UI 尚未验收。

2026-09-22，首批真实清单 `s2-live-RGcvnD` 另获批准后已执行一次：**3 pass、1 fail，10 次真实 HTTP、0 unknown**，状态为 `completed-with-failures`。B1 READ 因 `ANSWER_MARKDOWN_FENCE` 不满足严格 JSON 答案合同；两项 TOOL 在丢回执后各通过普通读回恢复，仅一次原生写入，B1 的重复写入对账分支未触发。只读 recover 与存档一致，29 个文件 SHA 不变，模型配置与全局设置未变；详见结果第十三增量。

用户提供的普通输入/输出/cache 输入参考价分别为每百万 tokens $0.75/$3.75/$0.075。本批 provider total 为 15,380，但所有缓存用量均未报告，实际费用继续为 null，不用 SDK 缓存默认零推算。仅有每格一次样本，不声称 B0/B1 总体优劣或成本节省；原清单已封存，任何新真实批次须重新批准。
