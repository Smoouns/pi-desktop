# E1：分层计量与 Windows batch 路径修复

日期：2026-09-24。基线 `cbc5862`，本轮工作区变更尚未提交。

这是 review E 批次的第一步，不是 E 的全部完成。诊断计量不改变模型输入预算、工具预算、重试、权限、来源验证、完成合同或人工验收。

## Windows 启动修复

非标准批处理原先通过 `Command::new("cmd.exe").arg("/C").arg(path)` 启动，普通 argv 编码不符合 `cmd` 的规则。定向红灯确认：绝对入口含中文 / 空格 / `&` 时失败；CLI 元字符参数还会被解释为命令。

回退分支改用 Rust 的批处理专用处理，路径与参数分开传递，不自行拼接 shell 字符串；相对入口仍按请求 cwd 解析。标准 npm shim 解析为 Node 的流程不变。当前 Rust 的行为及无法安全编码时拒绝启动的边界见 [Rust batch file special handling](https://doc.rust-lang.org/std/process/index.html#batch-file-special-handling)；未来工具链变更由真实子进程回归捕获，不承诺任意自定义 batch 内部逻辑安全。

`windows_process_tests` 的两项用例各覆盖 7 个生产启动分支，共 14 次 Node 子进程。检查绝对 / 相对入口、`.cmd` / `.bat`、中文、空格、空参数、`& | < > % ! ^`、尾部反斜杠、工作目录、环境、RPC stdin、stdout / stderr 以及实际 `GetConsoleWindow`。只在独立临时目录运行合成夹具，不加载 Pi / 模型 / 用户凭据。

## 计量定义与入口

`get_context_budget` 新增 `metrics` 和 `previousRun`。管理扩展版本 v19；本轮没有直接安装到全局 Pi 配置。已有上下文圆环的交互与预算规则不变。

| 字段 | 含义与边界 |
| --- | --- |
| `contextPreflight` | 最终 Context 预检次数、通过 / 拒绝、最近输入 token 估算、序列化字节、含预留总量。不是 tokenizer 实测。 |
| `providerPayloadAudit` | payload 回调的检查次数和最近载荷估算 / 字节。不是实际 HTTP 派发次数，也不是所有 provider 的零 HTTP 闸门。 |
| `sdkUsage` | 当前运行已结束 assistant 消息的 SDK 归一化 usage。字段缺失、非法或整组全零时保持未知；某字段缺一次，其总量即 `null`，已知小计独立保留。同一消息对象重复通知不重复计数。 |
| `transport` | 扩展无法可靠观测的 HTTP 派发、重试、摘要请求保持 `null`；`taskTotalComplete=false`。不得用检查次数补齐未知或退款。 |
| `reads.byKind` | 纳入预算的扩展 `readFile` 调用次数、成功返回字节和失败数。区分 document / fingerprint / observationValidation / checkpointValidation / memory / verifierReceipt。 |
| `reads.logicalReferences` | Observation 来源、Checkpoint 来源和分页次数 / 字节，独立于文件读取。 |
| `reads.lastContext` | 最近一次 Context hook 区间内的读取 / 引用统计；并发区间出现时显式标记 `overlappingContexts`，不是文件系统事务。 |

所有字节均是读取 API 返回的 Buffer 长度，不是磁盘设备 IO。原生 SDK 工具、验证子进程、stat / readdir、项目元数据和全局模型配置不在此读取覆盖中；既有 `run.readUsed` 仍是原预算账，而不是直接用新计数替换。重复路径读取包含必要的改版检查，不能全部算作浪费。

不记录正文、提示词、原始响应、凭据、URL 或原始文件路径。每运行最多跟踪 512 个路径摘要，超限保留计数并标注路径统计下界；安全整数溢出单独标记。上一运行仅在本进程保存，按项目 / 会话 / 职能隔离，最多保留 64 个 owner。迟到读取仍记入原计量对象。冷启动不从历史消息伪造旧计数。

SDK 可能已把缺失 cache 数据归一化为 0，所以 `cacheBreakdownVerified=false`、`costUsd=null`；这里没有改动现有参考价格。尚未使用 usage 校准估算，因而没有可跨模型 / prompt / schema / 压缩边界复用的校准锚点。

## 本地证据

- `npm run test:runtime-metrics`：5 项，生成源码和前端压缩工厂均实际加载；无真实模型调用。
- `npm run test:production-lifecycle`：9 组 / 17 个独立进程，最新源码报告 `artifacts/harness/production-lifecycle/d-XJiNOk/summary.json`。使用完整生产扩展、固定 SDK、实际原生 read、真实 SessionManager 和网络阻断器，仅 provider 响应为合成。
- 计量场景确认：第二轮请求已有 2 次 Context 预检 / payload 审计，但只有 1 个已完成 usage 消息；最终上一运行统计 3 个响应 / 合成 usage 6 tokens。新运行不继承这些 token；独立进程恢复时上一计量为空。
- 同场景的第二次 Context：来源 87 字节，Checkpoint 重验 1 次、Observation 重验 1 次，文件读取 174 字节、来源引用 2 次、唯一来源 1 个。这是受控重复读取证据，不是用户项目 profiling。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：11 项通过；应用 / 测试 TypeScript、前端构建、领域回归和长程三轮通过。保留既有 Rust unused variable、Vite 混合 import / 大 bundle 提示。
- 最终源码 `npm run test:harness`：290 例 × 3，deterministic=true、failures=false；包括原有累计预算、来源改版 / 验收撤回、取消 / 迟到结果和完成合同回归。
- 首轮全量 Harness 暴露新说明漏掉既有“累计”提示；字节预算行为未变。已补回提示并保留原断言；失败三轮证据保存在 `artifacts/harness/review-e1/harness-first-failure-365683597f504acdad95ba1ecbd5b5e7`，未用后续结果覆盖。

## 后续顺序

后续进展：第 1 项已在 E2 实现并独立记录于 [来源缓存验收](REVIEW_E_SOURCE_CACHE.md)。第 2 项的 E3 实现及覆盖限制见 [任务请求计量](REVIEW_E_TRANSPORT.md)。本文件的 v19、174 字节样本及 290 例结果仍是 E1 历史证据，不改写为后续结果。

1. 基于已测重复读取实现只覆盖单次 Context / 核验周期的来源快照缓存；不跨请求沿用，不以 mtime 替代 SHA。权威性 / 人工验收依赖单独核验，最终写入前重新检查。
2. 完整预算计量另补 transport 层：普通、摘要、允许的重试都入同一任务账；由本地计数服务器验收请求前拒绝、序列化膨胀、取消、失败和 unknown。当前不改变生产重试策略。
3. 获得同模型 / 同投影的真实 usage 后，再评估校准及其失效边界；压缩质量和有效进展另行验收。

本轮未调用真实模型、未驾驶桌面、未改真实小说 / 全局 Pi 设置，也没有新远程 CI 或安装包验收。旧 D 报告和失败证据不改写，Observation 持久化仍是可选项。
