# E8：失败收尾与工具协议离线核对

日期：2026-09-25。用户批准首次停批后的离线修复。本轮只改 E8 测试工装和文档，**真实模型请求 0**，没有读取宿主 key、修改全局 Pi 配置、操作 Desktop、提交或推送。旧真实批次不续跑，首次异常的上游根因仍未确定。

## 已修复

- worker 不再等整个场景成功才导出消息、通知、会话路径和生产台账。改为 `finally` 中分字段采集，关闭扩展前后各采集一次；单项采集、事件队列、关闭、dispose、设置 flush 的错误分别记录，保留原始失败原因，继续尝试其余收尾。不会在收尾新增提示或模型调用。强制终止进程仍不保证 `finally` 能执行，不能用此修复声称崩溃后内存证据必然完整。
- 停止 / 不完整 / 业务观察失败的批次返回非零退出码；CLI 仍先输出已保存报告的位置。退出 0 只表示自动 U/C/R 检查完成，不代表人工摘要质量已通过。未执行的 C/R 明确为 `not_run`，不存在的评分、读取证据为 null，不再把空输入评分混写成失败。
- 输出预留比较固定 Pi 0.63.1 的归一化口径 `completion + reasoning`。原始 completion、reasoning 字段是否出现、SDK 归一化输出分别记录；reasoning 字段出现但为 null、负数、小数、字符串、布尔值，或相加不安全时，停止并记 usage 未知。缺少 reasoning 字段时保留原始未知，SDK 比较项按其既有零回退计算，不把它宣称为已验证的真实零 reasoning。
- 未知 cache 仍保留费用未知。即使 cache 已知，只要报告正数 reasoning，当前不能确定供应商是否已将它含在 completion 中，也不猜测参考输出费用。所有实际费用仍为 null；没有改变生产估算器、模型窗口、输出请求参数或既定批次额度。

## 工具协议结论与限制

检查当前已安装 SDK `openai-completions.js` 的 `buildParams`、`streamSimpleOpenAICompletions`，并在实际 `streamSimple` 的 payload hook 截获后立即中止。公开合成配置下，原始地址与占位地址结果一致，均未进入 Fetch：

| 输入策略 | SDK 最终字段 |
| --- | --- |
| 空工具集合 | `tools: []`；没有 `tool_choice` |
| 不提供工具、也没有工具历史 | 两字段均省略 |
| 不提供工具、但保留工具历史 | SDK 补 `tools: []`；没有 `tool_choice` |
| 空工具集合 + 显式禁止 | `tools: []`，`tool_choice: "none"` |

固定 provider 的 simple wrapper 在运行时读取 `toolChoice`，但通用 `SimpleStreamOptions` 类型未声明它。这里证明的是**序列化行为**，不是 AgentSession 新增配置已接通，也不是代理接受 / 遵守该参数的证明。本轮未给 U/C worker 或生产调用偷偷加参数，未开放 `list_dir`、剥离完整生产角色扩展或放松权限拦截。

原真实请求未声明 `list_dir`，回复却要求调用它。缺少 `tool_choice: none` 是一个可进一步排查的协议差异，**不是已经证明的唯一根因**；模型行为、代理转换、上游指令仍不能仅凭一条响应区分。

## 红灯与回归证据

- 修复前定向红灯：`artifacts/harness/review-e8/gate-tests-iSIYO3/summary.json`，22 组中 2 组失败，分别复现中止后会话字段未导出，以及 completion 2 + reasoning 2047 超过 2048 却未拒绝。失败产物保留。
- 修复后准备 / 授权 / IPC 故障门禁：`artifacts/harness/review-e8/gate-tests-XGbEGG/summary.json`，**33 组 / 0 失败**，含 9 个隔离子进程退出码案例、清理故障注入、reasoning 有效 / 无效 / 边界值和四种工具策略序列化。前一轮同样通过的 `gate-tests-k7VZjy` 保留；最终轮为模拟报告补充了明确的合成数据标记。
- 完整生产扩展 + 固定 SDK 接收合成 `list_dir` 响应，保留输入 798 / 归一化输出 714 的 **1 条配对**，与持久会话台账逐项一致。只发生 1 次模拟出口调用，C/R 未运行，后续发送仍被拒绝，费用未知。结果在 `gate-tests-XGbEGG/simulated-inactive-tool/report.json`。这些数字是刻意构造的回归输入，不是新增的真实 usage 样本或模型校准。
- 原 SDK / 本机合成 HTTP 套件：`artifacts/harness/review-e8/offline-88d7g3/summary.json`，**23 组 / 0 失败**。这是 loopback 验证，不是零本机 HTTP，也不是远端模型验收。该轮后仅更新准备测试报告的合成标记和文档，共用 worker 及关闭逻辑未再改变。
- `npm run check`、`npm run check:harness-tests` 通过。无本轮完整 Harness、Rust、安装包、Desktop 或远程 CI 新结论。

原真实批次 `prepared-q4sDJ2` 的清单、两份一次性回执、输入、原报告、broker Journal、worker 结果和原生会话共 **8 项 SHA-256** 与只读审计保存值一致。原报告仍为 `paired=0`，不覆盖历史失败；只读审计恢复的 1 条真实配对与本轮合成回归分别记录。

## 下一步

离线修复已经完成。若继续追查真实工具协议，应另拟范围更小的显式禁用工具诊断，冻结新输入 / 代码 / 模型 / 额度，生成新清单并取得批准后才发送。确认兼容性后，再决定新的 U/C/R 联合验收。

旧真实清单的授权已消耗，且本轮代码已变化；不得改写旧清单、重用旧余量，或把先前执行后的 verify 结果当成当前源码仍匹配的证明。本轮没有为用户实际配置准备新的可批准批次。

后续独立轮次已完成 [单请求显式禁用工具诊断的准备](REVIEW_E_TOOL_PROTOCOL_DIAGNOSTIC.md)，新清单尚待批准，没有新增真实模型请求。上文保留本轮离线修复发生时的证据和边界。
