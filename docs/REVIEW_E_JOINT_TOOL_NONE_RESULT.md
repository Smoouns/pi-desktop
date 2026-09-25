# E8 新版联合实测：输出用量超出预留，已停批

2026-09-25。用户批准精确清单 `joint-tool-none-XbVP5l` 及费用可能未知的边界后，执行前 verify、有效期、SHA 和未消耗检查全部通过。于 **18:20:16.403 UTC+8** 消耗单次授权，**18:20:18.362** 开始执行。

清单 SHA-256：`1c77cdb7c7b4d3c068003e23e06dc32b0d0d7f634182f9f2d60fd47e1adf18fa`。该授权现已消耗，失败不返还额度，禁止重放或续用剩余额度。

## 执行结果

共 **3 次预留、3 次真实派发、3 条终态回执**；前 2 条被接受为完整响应，第 3 条因 `usage_exceeded_reservation` 停批。三次均为 HTTP 200，原始 SSE 工具片段、SDK 工具调用和实际工具执行均为 0。没有第 4 次派发，没有重试、压缩或追加探测。

| 请求 | 阶段 | 原始输入 | 原始 completion | 原始 reasoning | SDK 输出 | 终态 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| e8-1 | U 第一次 | 797 | 139 | 746 | 885 | complete |
| e8-2 | U 第二次 | 1,058 | 51 | 334 | 385 | complete |
| e8-3 | C 未压缩对照 | 3,846 | 93 | 9,016 | 9,109 | usage_exceeded_reservation |

每次输出预留均为 **2,048**。固定 Pi 0.63.1 的 OpenAI-completions 通道按 `completion + reasoning` 归一化，第三条为 `93 + 9016 = 9109`，超出预留 **7,061**。SDK 持久会话记录也为 9,109，不是界面读数或自动报告算术错误。

- U：两次真实调用的最终请求、用量与生产诊断成功配对；第一条回复仍偏长，不额外记“简短表达通过”。
- C：对照请求被本地中止，`not_completed`。处理组 `not_run`，原生摘要请求 **0**，摘要内容审读 `not_run`。不能将此次中止或对照答案差异归因于压缩。
- R：`not_run`，无文件版本变更或工具调用；不把未覆盖记成缓存命中 0 或通过。
- 进程退出 **1**。`toolPolicyEvidence.passed=false` 反映联合流程未完成，不能把已观察的三次无工具回复升级为全套通过。

## 参数与计量的证据边界

最终实际请求包含 `tools: []`、`tool_choice: "none"` 和 `max_completion_tokens: 2048`。三次修改前后 SHA 均对应最终预留 body，确实只增加了 tool_choice，未改生产扩展。

但第三次返回的总输出口径超过了发送的参数值。最终请求中没有 `reasoning_effort`、`thinking` 或 `enable_thinking`；客户端 `thinkingLevel=off` **不能证明上游已关闭思考**。当前只能确认“按已批准的本地计量规则发生超额并停批”，尚不能区分代理对参数的映射、上游输出限额语义和供应商统计口径，不能声称具体根因已确定。更没有在执行中提高上限或删掉 reasoning 来取得通过。

原始 usage、SDK assistant usage 和原生持久台账三条数值均一致，但只有前两条属于完整成功响应。第三条 SDK `stopReason=aborted` / `E8_RESPONSE_INTERRUPTED`，生产计数为 aborted 1、bodiesUnknown 1；broker 收到终态 usage 后主动中断，不应改写为 SDK 正常完成。

因此原报告的 `usageCoverage.paired=2`、第三条 `matched/outputMatched=false` 保留原样。第三条诊断 `eligible=false / response_not_complete`，不能补成第三条合格估算样本。只读审计中的“三条用量数值核对一致”不是“三条校准通过”。

两个合格输入估算分别为 1,652 对 797（+855）和 2,229 对 1,058（+1,171）。未观察到兼容锚点；U 第二条为 `history_not_append_only`。没有修改历史投影或据样本调整生产估算器。

累计原始输入 **5,701**、completion **283**、reasoning **10,096**，SDK 输出合计 **10,379**。三条缓存字段均缺失，参考和实际费用均为 **未知**，不把 SDK 的价格 0 当作免费。

## 额外发现：题目与严格评分之间存在歧义

对照组留下了 JSON 文本，但请求已中止，所以以下只作诊断，不是有效验收。现有严格 oracle 计 **6/10**，关键项 **4/6**，原分数不改。

- `goal=organize_next_planning` 对 `plan_only`、`card=needs_human_confirmation` 对 `pending_human_confirmation`、`unresolved=remain_unknown` 对 `unknown`，存在同义表达被字符串比较拒绝的风险。
- 题目只给字段名并要求简短 snake_case，没有给出可选枚举；不能据这三个字符串差异直接声称模型忘记了事实。
- `next=reread_stale_source` 确实没有包含“按需刷新检查点”步骤，不将全部失分一律解释为同义词。

后续应在下一份冻结设计中明确枚举契约或预先登记合理的语义评分方式，不能看到本次答案后回填当前成绩。本轮不修改题目、oracle 或评测代码；这也不构成对本次超额原因的因果证明。

## 只读审计与收尾

- 原报告：`artifacts/harness/review-e8/joint-tool-none-XbVP5l/live/report.json`。
- 独立审计：`artifacts/harness/review-e8/readback-joint-tool-none-XbVP5l/summary.json`，同目录 `audit.mjs` 保存核对过程；deny-all 网络 guard 下运行，新增请求 0。
- 核对 broker 哈希链、每个原生台账 SHA、同调用 pending→terminal 用量变化、SDK usage、payload 修改前后 SHA、原 seed、完整扩展字节及 Canon / 人工验收哨兵与来源 v1。
- 本批 10 项原始证据审计前后 SHA 不变；两次历史实测各 8 项证据 SHA 也不变。没有创建 C 处理组或 R 的 worker 目录。
- `recover` 为 3 预留 / 3 终态、0 未结、0 新请求、禁止重放。其中字段 `completed=3` 在该工具内表示“已有 terminal 回执”，不是三条正常模型响应。
- 执行后独立 verify 通过，源码、依赖、准备资产和模型配置仍匹配；明确返回 `approvalConsumed=true`。没有修改生产策略、全局 Pi、真实小说或冻结评测实现，没有 Desktop 操作、commit/push，也不新增 Rust / 远程 CI / 完整功能验收结论。

下一步建议先离线核实代理输出 / 思考预算参数的含义，并处理题目与评分契约的歧义；不直接扩大额度。需要新的真实探测或重跑联合测试时，必须重新准备精确清单并取得批准。

## 后续离线核查（2026-09-25）

随后获得的本机代理历史记录已进一步定位映射差异：三次请求的 `max_completion_tokens: 2048` 均未保留在代理规范化日志中，保存的上游配置均为输出 65,536、思考 16,384。新增独立评分契约 v2 仅供离线测试，旧成绩及本页原执行结论不改。详见 [预算映射与评分契约核查](REVIEW_E_PROXY_BUDGET_AND_CONTRACT.md)；没有新增模型请求，具体兼容修复仍未实测。
