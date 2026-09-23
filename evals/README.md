# Phase 5 离线评测

整个 Phase 5 的当前状态和证据入口见 [交接索引](../docs/HARNESS_PHASE5_HANDOFF.md)，下一步同 SDK 对照的实现范围见 [正式对照计划](../docs/HARNESS_PHASE5_ABLATION_PLAN.md)。本页列出独立 SDK 入口，后续任务表、七个 profile 与通用离线命令仍只说明模块轨道。

封存证据的统一只读入口为 `npm run eval:report`；生成全新中文 Markdown/JSON 报告后，使用 `npm run eval:report:verify -- <report-dir>` 从原始批次再次核验。当前显式目录包含 **15 批**（原 13 批加上新旧 S4 live，保留失败/未知），不会自动筛选通过批次，不产生模型请求，也不把缺失的历史产物当成成功。测试入口 `npm run test:evidence-report`，**199 项检查覆盖 11 种 family**；S4 live 原 CLI 独立打包只执行 recover，分开显示预算、业务结局、未观测分支及用量覆盖，cache 缺失不补零。当前报告 `report-CPUudb` 已验证 15/15，范围与兼容处理见 [报告说明](../docs/HARNESS_PHASE5_EVIDENCE_REPORT.md)。

当前版本已通过全新依赖的本地隔离回归：`isolated-run-RqGXwI`，496 文件、19/19 条命令通过，含 S4 live 150 项及报告 199 项。187 个待交付候选均进入快照，原证据与报告保持不变；不是远端 CI、已提交 clean clone 或原生 Desktop 验收。证据及保留警告见 [结果第三十二增量](../docs/HARNESS_PHASE5_RESULTS.md#32-第三十二增量完整隔离回归与交付范围复核)。

真实 pilot 的前置 SDK 离线演练是独立入口 `npm run test:pilot`；详见 [工装说明](../docs/HARNESS_PHASE5_PILOT_TOOLING.md)。其模拟请求和合成 usage 不并入下方模块矩阵，不代表真实模型测评。

新增的同 SDK 读写切片为 `npm run test:sdk-ablation`，使用独立 `sdk-*` profile 和批次。其原始基线、安全差异、固定重放负例与证据边界见 [S1 说明](../docs/HARNESS_PHASE5_SDK_ABLATION.md)；不改变下面七个模块 profile，也不把完整 Desktop 变体标记为已实现。

独立 S2 实测工装的离线入口为 `npm run test:sdk-live`，通过真实 SDK 序列化/parser 和父进程 broker 喂入合成 SSE。其四项清单、批准、额度与日志说明见 [S2 说明](../docs/HARNESS_PHASE5_SDK_LIVE.md)；dry-run 不授权实际模型调用，旧 pilot 的 8 次上限不变。

S3 上下文/原生压缩的独立离线入口为 `npm run test:sdk-context`；`npm run eval:sdk-context` 生成固定 27 格矩阵，`npm run eval:sdk-context:rebuild -- <batch-dir>` 只读重建。它使用真实 SDK 生命周期和两个独立进程，但普通回答与摘要都是本地固定响应，没有 live 入口。103 项检查与 15 pass / 12 缺能力负例 fail 的边界见 [S3 说明](../docs/HARNESS_PHASE5_SDK_CONTEXT.md)，不并入下方模块矩阵。

S3 自动压缩/未知写入补充使用 `npm run test:sdk-lifecycle`、`npm run eval:sdk-lifecycle` 和 `npm run eval:sdk-lifecycle:rebuild -- <batch-dir>`。独立的 v2 `s3-lifecycle-*` 清单为 3 profiles × 6 tasks × 3 轮；`sdk-b3-checkpoint-ops-v2` 明确新增写入事件持久化接线，不回填原 S3 profile。详见 [生命周期测试](../docs/HARNESS_PHASE5_SDK_LIFECYCLE.md)；usage 是本地触发样例，不是真实 provider 用量。

S3 真实工装的统一出口离线预检为 `npm run test:sdk-context-transport`。它通过实际 SDK OpenAI-compatible 序列化/parser 验证普通请求和原生单/双摘要共享额度、Journal、串行派发及取消；仅本地 SSE，没有 live/认证入口，不是 B1/B2/B3 效果矩阵。说明与命令见 [传输预检](../docs/HARNESS_PHASE5_SDK_CONTEXT_TRANSPORT.md)。

S3 受控强杀/迟到结果补充使用 `npm run test:sdk-recovery-races`、`npm run eval:sdk-recovery-races` 和 `npm run eval:sdk-recovery-races:rebuild -- <batch-dir>`。独立 4 场景 × 3 轮，真正结束自建 SDK 子进程，再从磁盘重开；另测回调代际隔离。全部离线，不修改生产 runtime，不将“安全阻止未知写入”说成任务成功。范围见 [强杀与迟到结果测试](../docs/HARNESS_PHASE5_SDK_RECOVERY_RACES.md)。

S4 Supervisor / 上下文维护使用 `npm run test:sdk-supervision`、`npm run eval:sdk-supervision` 和 `npm run eval:sdk-supervision:rebuild -- <batch-dir>`。三个独立 `sdk-b3-s4-*` 配置共用 B3 底座、工具和任务，45 格正常矩阵与五种故障分开，真实请求 0。188 项检查通过；安全停止不等于业务完成，合成摘要不等于模型质量。见 [S4 说明](../docs/HARNESS_PHASE5_SDK_SUPERVISION.md)。S4 保留独立清单和 aggregate，并作为第 13 个选定批次纳入统一报告，机械结果与业务结局分栏。

[S4 独立真实工装](../docs/HARNESS_PHASE5_SDK_SUPERVISION_LIVE_PLAN.md) 使用三配置 × 三任务。现行 schema v3 / 预算 namespace v2 为普通/摘要共用**每格 8 / 全批 72 次**；旧 v1/v2 记录仍按 6/54 只读重建，不能重新授权。首批 `s4-live-orlzII` 曾以 12 次真实 HTTP 提前停止并封存，不能继续执行。`eval:sdk-supervision-live:diagnose -- <batch-dir>` 区分 SDK 入口、实际 HTTP 和停止码，旧缺失项不回填。`test:sdk-supervision-live` / `dry-run` 只做离线测试，`recover` 只读核验。第二十九增量只实现预算版本并准备新清单，没有真实模型请求；执行仍须单独批准精确 SHA 和费用未知边界，不复用旧批余额。

以下说明 **P5-A 离线模块合同评测**。该轨道只使用公开合成 fixture 与故障注入，不读取 provider 凭据、不调用付费模型，也不实施 Phase X（向量数据库、embedding、reranker 或自动多 Agent 编排）。

当前任务集包含 6 个合成合同任务，覆盖 CTX、VER、TOOL、ISO 四类。它们用于验证 runner、冻结信息、状态分类、结果重建与确定性；不能证明真实模型质量、token 节省、长期恢复率或 Desktop 发布可用。

| task | schema | 类别 | 合同边界 |
| --- | --- | --- | --- |
| `CTX-001-budget-fail-closed` | v2 | CTX | 请求预算与不支持载荷 fail-closed |
| `VER-001-source-invalidation-recovery` | v2 | VER | 来源变更、旧证据阻断与刷新 |
| `TOOL-001-write-unknown-outcome` | v2 | TOOL | 丢失确认及取消后的写入对账 |
| `ISO-001-authority-boundaries` | v2 | ISO | project/session/role/generation 边界 |
| `TOOL-002-typed-recovery` | v2 | TOOL | typed failure、有限重试与 unknown outcome |
| `VER-002-long-horizon` | v2 | VER | 在同一临时 project 中串联预算、磁盘 checkpoint、来源刷新、写入对账和 authority 边界 |

v1 task 保持向后兼容；v2 task 额外声明 `requiredCapabilities`。矩阵运行器按能力决定执行或返回 `unsupported`，不会为缺失 factory 注入当前实现作为隐式 fallback。聚合仍提供 category `groups`，schema v2 矩阵另按 `taskGroups` 分表，避免同类别不同任务被合并后掩盖差异。

`VER-002-long-horizon` 的“边界”是 checkpoint 写入磁盘、丢弃进程内引用后再从文件恢复的合成序列。它不调用 LLM 做摘要，也不经过 Pi 原生 compaction 生命周期，因此不能作为 native compaction 或摘要质量证据。

## 变体边界

[`variants.ts`](variants.ts) 是声明性的 feature matrix。当前有 7 个可运行变体，分为历史模块快照与当前源码 profile 两条轨道：

| 轨道 | 可运行变体 | 含义 |
| --- | --- | --- |
| 历史模块快照 | `historical-b1`、`historical-b2`、`historical-b3` | 从指定 phase commit 提取的 production module；每个源文件按 commit、Git blob 与 SHA-256 provenance 冻结并在运行前校验 |
| 当前源码 profile | `c1-tool-contract`、`c2-observation-budget`、`c3-versioned-checkpoint` | 在同一当前 runner/scaffold 中逐级开放 current-source component factory |
| 当前完整声明 | `current-full-contract` | 当前 production capability 的完整声明，但任务实际只覆盖已列出的合成合同 |

这两条轨道用于检查模块合同和能力缺失行为，不是公平的全栈 B0→B3 性能消融。历史快照没有复现各阶段完整 Desktop、当时 SDK、外围修复和运行时环境；当前 profile 也没有关闭所有后来加入的 scaffold 行为。`c3-versioned-checkpoint` 与 `current-full-contract` 在本任务集所需 factory 上语义相同，因此得到相同合同覆盖并不构成独立性能证据。

这 7 个可运行变体都不测试 Supervisor、context maintenance 或 Pi 原生 compaction 生命周期。`current-full-contract` 中相应 feature flag 仅描述 production 能力存在，不能把未被任务触达的能力写成已验证。

`b0-raw`、`b0-safety-fixed`、`b1-tool-session`、`b2-observation-budget`、`b3-checkpoint-compaction`、`b3-supervisor` 与 `b3-supervisor-maintenance` 在通用完整变体表中仍标记为 `not_implemented`。上方 S1—S4 使用明确限定的独立 SDK 名称，不回填完整 Desktop 变体。历史 commit 能证明各阶段曾实现，却不能自动成为公平消融变体：只有在同一冻结 runner 下实现可审计且边界等价的适配层，才能把它们用于这种比较。

`b4-dense-retrieval` 同样未实施。当前无 dense retrieval，也不会借用现有 lexical/authority/temporal 行为冒充 B4。

外层合成沙箱、凭据隔离与禁止访问真实项目是所有变体共有的安全不变量，不属于可关闭的性能开关。被评测的 isolation、reconciliation、budget 等产品能力仍须按 feature matrix 明确区分。

## 命令与产物

稳定入口为：

```powershell
npm run eval:offline
npm run eval:matrix
npm run eval:rebuild -- <batch-dir>
npm run test:evals
```

`eval:offline` 仅选择 `current-full-contract`：6 tasks × 3 repetitions，共预登记 18 runs。`eval:matrix` 选择上述 7 个 runnable variants：7 variants × 6 tasks × 3 repetitions，共预登记 126 runs。这些数字是 manifest 的**设计运行规模**，不是本页声称已执行或通过的结果；真实状态应以特定 batch 的不可变产物为准。

`eval:offline` 为每次运行创建唯一目录：

```text
artifacts/harness/evals/<unique-batch-id>/
  manifest.json
  raw/
  result-index.json
  aggregate.json
  report.md
```

每个 task/variant 组合固定运行三次，保存独立 raw 结果；`unsupported`、`unknown`、缺失能力与未执行项均不计为 pass。产物只含有界、脱敏的 synthetic 数据和 hash/provenance，不含密钥、认证 header、私人 prompt 或小说正文。

### 不可变 manifest 与结果索引

`manifest.json` 在执行前写入并冻结，记录代码、依赖、fixture、task set、变体、预算和预登记 run 清单。其 SHA-256 随后写入每个 raw 结果。

为避免 manifest 把自身或尚未产生的结果 hash 纳入自身而形成 hash 循环，raw 文件 hash 不回写 manifest。全部 raw 落盘后单独生成 `result-index.json`，其中保存 `manifestSha256` 及每个 raw 文件的 SHA-256。`aggregate.json` 只能从 manifest 与 hash 匹配的 raw/index 重建。

`eval:rebuild` 不补写实验结果；遇到 manifest 漂移、重复 run ID、缺失 raw、hash 不符、schema 不匹配或超出预登记 run 时应拒绝聚合。

重建只输出 JSON，不修改被审计的 batch；失败时在外层 `evals/rejections/` 下新建脱敏原因记录，保留审计而不改输入证据。`manifestSha256` 对递归键排序后的规范 JSON 求哈希，raw 文件的 SHA-256 则按实际 UTF-8 文件字节计算。哈希用于检测漂移与误改，不是防止本机恶意篡改的签名。

运行器通过环境变量白名单启动子进程，清除用户 HOME/认证路径，任务进程禁止网络与再次启动子进程。每项任务超时 20 秒，复制前后核验公开 fixture，编译输入及任务前后源码都必须匹配冻结哈希。这是针对受信任仓库评测代码的纵深防护，**不是操作系统级安全沙箱**，不接受用户提供的任意脚本或模型代码。

公开 fixture 为仓库原创合成数据，按仓库 MIT 许可使用。仅操作临时副本；不从真实小说抽样。每项 `definition.requiredChecks` 是判定依据，`unsupportedConditions` 声明该最小任务不覆盖的外部能力，并非已执行且通过的子测试。

指标口径：`pass / planned` 的分母为该类别所有预登记运行，包括 unknown/unsupported；`recoveries` 是注入故障后达到预期机械终态的次数，不是模型恢复成功率；`blockedDuplicateDispatches` 是重试没有再次派发的次数，`duplicateSideEffects` 则是真实临时文件多余写入次数。`staleEvidenceUsed` 在首批 VER 中测量旧来源被错误授予写权限的次数，不外推为真实模型正文误用。`usage` 全部标为 unavailable/null；没有 token 节省或费用结论。

## 证据边界

后续 SDK 切片使用独立入口和证据：S1 读写、S2 真实工装、S3 上下文/生命周期与统一出口。新 [S3 限定任务及逐批授权](../docs/HARNESS_PHASE5_SDK_CONTEXT_LIVE.md) 为 B2/B3 各接两项公开任务，仍先离线验证；`test:sdk-context-live` / `eval:sdk-context-live:dry-run` 不读取个人配置或请求模型。真实执行必须另行 prepare、批准精确 SHA 和普通/摘要共享预算，不复用旧批次余额。

单个离线 batch 只能表述为“该 batch 中明确列出的 task/variant 合同结果”。即使矩阵实际运行，也不存在由此自动推出的 B0→B3 全栈改善百分比；不能把冻结模块快照称为完整历史 Desktop baseline，也不能把合成故障恢复率外推成真实模型长期恢复率。真实 provider pilot 必须另获明确授权，并使用新的 batch 与预算。
