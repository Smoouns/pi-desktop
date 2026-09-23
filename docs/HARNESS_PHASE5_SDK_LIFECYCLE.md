# Phase 5 S3 第二离线增量：自动压缩与未知写入恢复

这是 [S3 首个切片](HARNESS_PHASE5_SDK_CONTEXT.md) 的独立、版本化补充。使用固定 Pi SDK 0.63.1、公开合成文件和本地提供器；**没有 live 入口，没有真实模型、认证读取或费用估算**。不修改生产扩展或把测试接线冒充完整历史版本。

## 任务与预登记矩阵

| 任务 | 实际经过的 SDK 路径与机械判定 |
| --- | --- |
| `auto-threshold` | 合成 usage 触发真实 SDK 阈值检查；两次自动 native compaction，每次之后低用量续聊不重触发，不自动重发 |
| `auto-overflow` | 合成 context-overflow 错误触发 SDK 自动压缩和其内部一次 continuation；不是开启 provider 的一般错误重试 |
| `write-acklost` | 实际写成预期字节，但工具抛出丢回执错误；自动压缩、独立进程重开后对账，不重复派发 |
| `write-partial` | 临时目标只写入部分样例，回执丢失；压缩/重开后保持未知，refresh 不授予重放权限 |
| `write-missing` | 写工具已派发但目标尚不存在，回执丢失；没有文件不等于证实未发生，不自动重写 |
| `write-after-compact` | 先自动压缩一次，再写入并丢回执，第二次自动压缩后重开；验证跨多个压缩边界的去重 |

固定 3 profiles × 6 tasks × 3 轮，共 54 格；沿用按任务交错 profile 的预登记顺序。

- `sdk-b1-reliability` / `sdk-b2-context`：原 S3 扩展源码原样复用，进程内 ledger 不持久化。
- `sdk-b3-checkpoint-ops-v2`：显式新增 **eval-only 写入事件适配**，接入冻结 Phase 3 runtime 的 `operation` / intent-aware `writeGate`。与原 `sdk-b3-checkpoint` 名称分开，不回填旧结果，不混入 Supervisor/maintenance。
- 全部 profile 应通过两类自动压缩合同；四类写入任务中 B1/B2 缺少持久化操作恢复，保留为预登记负例 fail。设计期望为 **30 pass、24 缺能力负例 fail**，实际结果必须引用冻结批次，不能把期望当实测。

这不是模型能力测试：工具调用和摘要都是固定脚本，usage 数字只是压缩触发输入。B1/B2 的重复调用是对机械屏障的探针，不意味着真实模型必然选择重写；这些负例不用于总体模型优劣或效率结论。

## 未知写入的安全边界

v2 接线先过权限及已有检查点门，随后在实际工具派发前保存 issued/dispatched 意图。测试在写入点读回真实 SDK 会话文件，确认指纹和操作 ID 已落盘；不以进程内 Map 存在作为持久化成功。

工具错误保留为错误，未知状态随 checkpoint custom entry 跨越 native compaction。另一独立进程通过 `SessionManager.open()` 恢复：

- 当前文件等于 expected post-hash：标为 completed，并阻止相同意图再次派发。
- 部分结果或无目标文件：保持 unknown；尝试 refresh 后仍阻止同意图重放。
- 写入意图持久化失败：实际工具不得执行。
- 写入结果持久化失败：中止当前运行，保留落盘的 issued/dispatched 意图；重开后仍按文件指纹对账或阻止，不把缺失结果当成功。

`writeDispatches` 统计真正进入受控写工具的次数；`writeEffects` 只统计目标字节发生变化的次数。重复写相同字节有重复派发，但没有第二次字节变化，两者不能混称重复副作用。机械测试 pass 可能是“正确阻止继续写入”，不等于正文任务完成或人工验收通过。

## 自动压缩、预算与故障

不直接调用 `session.compact()`，不注入替代 compaction，不手工调用 SDK 私有压缩入口；通过真实 `session.prompt()` 和 SDK 事件订阅观察自动生命周期。摘要使用 API registry 的本地提供器，与普通请求共用外层上限，但分别计数。压缩摘要不经过普通 Agent 的同一个 budget hook，这一限制仍保留。

每阶段最多 16 个本地请求、16 个工具调用、45 秒；完整合成载荷加输出预留/余量不得超过 128 KiB。B2/B3 的普通请求仍受原 16,384 字节估算预算。并发摘要在第一次 await 前预留调用份额，测试超过上限的并发请求会被拒绝。自动压缩开启，一般模型错误 retry 关闭；所有设置只写隔离临时目录。

负测试包含阈值/溢出摘要失败、真实 AbortSignal 取消、摘要限额、重试后再次 overflow、意图/结果持久化失败，以及能力清单泄漏和记录篡改。重复 overflow 只允许一次 compact-and-retry，不形成无限循环。测试额外观察 SDK 的 100 ms continuation 定时窗口，避免过早返回掩盖额外重试。

## 运行与证据

```powershell
npm run test:sdk-lifecycle
npm run eval:sdk-lifecycle
npm run eval:sdk-lifecycle:rebuild -- artifacts/harness/sdk-context/<s3-lifecycle-batch>
```

开发探针：`node scripts/run-sdk-context.mjs lifecycle-probe <profile> <task> [scenario]`。全部离线，不接受 provider/key/live 参数。

schema v2 使用新的 `s3-lifecycle-*` 批次，冻结源码/依赖、fixture、提示、工具扩展及顺序。旧 v1 S3 和 S2 批次保持只读。manifest/raw/index/aggregate 采用严格字段白名单、哈希核验和只读重建；非预登记失败、来源漂移、未知派发停止后续矩阵，已观测阶段不能被清空。哈希用于检出漂移，不是防止同机恶意改写并重新计算整条记录的签名。usage/cache/费用均为 null，不能用内部合成数字计算节省率。

最终实测批次、检查数量与隔离回归指纹见 [结果记录](HARNESS_PHASE5_RESULTS.md) 第十五增量。

当前封存批次 `s3-lifecycle-b8USvY` 实测为 30 pass、24 预登记负例 fail，72 次自动原生压缩、36 次独立进程重开，真实 HTTP 为 0。175 项检查及全新依赖的 13 命令隔离回归通过；不合并旧 v1 或开发批次的分母。

## 仍未证明

本轮不覆盖真实 LLM 摘要质量或真实 provider 的费用/隐式重试、任意时刻断电/强杀、写入仍在后台完成的迟到竞态、所有跨项目/角色迁移、Rust/RPC/UI 或完整长篇创作流程。已有分层测试不能拼接成这些端到端成功结论。Supervisor/maintenance 独立对照、真实 S3 工装和整个 Phase 5 仍未完成；真实普通/摘要请求必须另建清单并另获批准。

后续证据单列，不回填上述 v2 结果：[S3 真实小批次](HARNESS_PHASE5_SDK_CONTEXT_LIVE.md) 已另获批准执行；[受控进程强杀与迟到结果](HARNESS_PHASE5_SDK_RECOVERY_RACES.md) 补充了四种固定屏障处的进程恢复。后者没有原生压缩，不把两个切片拼成压缩/任意断电/外部执行器的全生命周期保证。
