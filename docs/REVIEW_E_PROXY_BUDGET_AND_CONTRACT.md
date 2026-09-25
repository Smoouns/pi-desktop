# E8 输出预算映射与评分契约 v2：离线核查

2026-09-25。按本轮批准范围，仅核对本机安装、历史请求记录和固定 SDK，并改进测试工具中的评分契约；**新增真实模型请求 0**，不提高额度、不修改全局配置、不重跑已消耗批次。

## 结论：代理保存的转发参数没有保留客户端上限

当前选定模型为 `gemini-proxy / gemini-3.8-flash-high`，通过 `openai-completions` 进入本机 Antigravity Tools 4.7.8。版本来自 Windows 可执行文件元数据；本机未找到可审读的代理源码。

以公开合成批次 `joint-tool-none-XbVP5l` 的唯一标记，只读查询代理 SQLite 日志，恰好匹配原来的 **3** 条请求。逐条与独立 broker 原始请求和 usage 对照：

| 项目 | 客户端最终请求 | 代理保存的上游请求 |
| --- | --- | --- |
| 输出上限 | `max_completion_tokens: 2048` | `maxOutputTokens: 65536` |
| 思考参数 | 未发送 `reasoning_effort` | `thinkingBudget: 16384` |
| 思考输出 | 未发送显式开关 | `includeThoughts: true` |

代理的规范化请求记录与原 body 相比，恰好缺少 `max_completion_tokens`、`stream_options`、`store`；其余字段逐项规范化后哈希相同。三条都没有另一个 `max_tokens` 字段。三条输入 / completion 用量与 broker 原始回执对应，第三条仍为 completion 93 + reasoning 9,016 = SDK 输出 9,109。

因此已定位到**代理记录中的输出上限丢失和思考预算映射不一致**，不是 Pi 界面显示错误。这里的证据是代理保存的转发记录，**不是抓包，也不证明最终供应商实际执行了所有字段**；不据此推断全部上游计费语义。

独立脱敏审计：

- `artifacts/harness/review-e8/proxy-budget-audit-20260925/audit.mjs`
- `artifacts/harness/review-e8/proxy-budget-audit-20260925/summary.json`

数据库以 `readOnly` 和 `query_only` 打开。没有查询账户、凭据、请求头列，不导出完整请求、思考内容或私有配置；只记录参数、用量和公开测试请求的哈希。历史三个批次的 **8 + 8 + 10** 项证据 SHA 未变。

## Pi / SDK 与当前网关配置

固定 Pi 0.63.1 的原生 Agent / SDK 零网络 payload 捕获确认：

- `thinkingLevel: off` 会省略 reasoning 参数，不是显式发送“关闭上游思考”。
- `reasoning: false` 时，即使选 low / high，SDK 也不发送普通 `reasoning_effort`。当前私有模型配置没有声明 `reasoning`；E8 投影为 false。名称里的 `-high` 不会自行启用 SDK 能力标记。
- 声明 `reasoning: true` 且兼容性允许时，low / high 才发送相应 effort；off 仍省略。
- SDK 支持通过 `compat.maxTokensField` 在 `max_completion_tokens` 和 `max_tokens` 之间选择。测试只证明序列化能力，**未证明本机代理接受后者或正确约束总输出**。

当前代理配置的 `thinking_budget.control_source` 是 `gateway`，Flash 自定义 high 为 16,384；与历史转发记录的值一致。但当前配置不是历史配置快照，也不能单靠配置名称断言所有路由的优先级。未修改 Pi / 代理配置或重启代理，未解析 `GEMINI_API_KEY` 的值。

本地终态超额检查继续计算 reasoning，不能把它删掉来绕过停批。这种回执后检查不能追回上游已经生成的 token，因此也不应把本地 2,048 预留说成已生效的上游硬限额。

## 独立评分契约 v2

新增 `E8-STATE-ENUM-V2`，实现位于 `tests/harness/review-e-live/response-contract-v2.ts`，设计位于 `docs/REVIEW_E_ENUM_V2_PLAN.json`。

- 模型看到所有字段的备选枚举及其含义，不再自行发明同义 snake_case。每个状态字段都提供多个选项，而不是提供正确答案。
- 必须为单个 JSON 对象、恰好 10 个字段、枚举原样字符串和严格布尔值；拒绝重复键（含 Unicode 转义同名键）、缺失 / 多余字段、围栏和错误类型。
- 保留原来的事实 oracle 和 6 个关键项；`reread_then_refresh` 明确为“先重读失效来源，再按需刷新检查点”。只重读不能冒充已包含刷新。
- 不对旧答案补同义词映射，不改旧成绩。原对照残留答案仍为严格 **6/10、关键 4/6**，且原请求中止、不合格于完整验收。
- 使用独立 `joint-enum-v2` profile；两个 C 分支共用新题目，处理组在原生压缩之后才添加题目，不把题目放进摘要输入。TaskContract / checkpoint 仍按生产逻辑分别投影，不删掉它们来让两分支 body 人为相等。
- 完整扩展和原生 SDK 保留，U/C 显式禁止工具，R 不变；全批 24 / 每任务 8、输入 65,536 bytes、输出 2,048 等预留不变。
- 新 profile 明确 `liveAllowed: false`。授权、启动和 broker 三处拒绝真实模式，拒绝发生在消耗授权 / 解析凭据之前；篡改 manifest 标志也不能开放。当前只有使用公开假配置的离线测试入口，没有准备真实可执行批次。

旧三个 profile、JSON 计划、历史题目与数据保留。当前测试工具源码已变化，旧清单的源码指纹不再代表当前代码；不能修改旧 manifest 来消除漂移或重新使用其授权。

## 验证

| 命令 | 结果 | 本轮证据目录（`artifacts/harness/review-e8/` 下） |
| --- | ---: | --- |
| `npm run test:review-e8:budget-contracts` | 16 组通过 | `budget-contract-tests-eueKKW` |
| `npm run test:review-e8:joint-tool-none` | 16 组通过 | `joint-tool-none-tests-gx4Lg7` |
| `npm run test:review-e8:prepare` | 33 组通过 | `gate-tests-yop9Sb` |
| `npm run test:review-e8:tool-none` | 16 组通过 | `tool-none-tests-C8V8bD` |
| `npm run test:review-e8` | 23 组通过 | `offline-riGHJw` |

共 **104 组**。新契约完整流程捕获 14 次原生 SDK 请求，全部在禁止网络的 IPC 合成对端执行；原 offline 套件仍只连接自有 loopback 合成服务器。正确的合成 JSON 只验证接线与评分，不是模型记忆或摘要质量通过。应用 / 测试 TypeScript 与 `git diff --check` 通过。

首轮新测试为 15/16，证据保留在 `budget-contract-tests-DtyOJv`：断言误把“最后一个 user-role 消息”当作题目，而生产系统会在题目后附加 TaskContract / checkpoint。改为核对两边实际题目各出现恰好一次；未改生产投影来迎合断言。

按原批次 manifest 核对，140 项生产 / 既有冻结评测 / 历史题目文件 SHA 不变。没有新增 Desktop、Rust、远程 CI 或完整应用验收；没有真实小说、全局配置、commit / push 操作。

## 下一步

先核实该代理版本对 `max_tokens`、总输出限额与网关思考策略的真实实现，再设计**测试专用、隔离的兼容方案**。不能仅将模型标成 reasoning、把客户端换成 low，或盲目提高 2,048 来宣称问题解决。

需要实际验证时，另行准备最多一次请求的诊断清单并明确未知费用边界，取得批准后同时核对客户端参数和代理转发记录。若必须改全局网关策略，先说明影响并单独征得同意。本轮不发送该请求；联合 U/C/R 实测仍未完成，旧已消耗授权不可续用。

后续决定：用户明确要求不再进行上述参数兼容研究，接受现有上游预算。已按新边界执行独立联合批次；本页历史核查不改，最新进展见 [沿用上游预算的执行结果](REVIEW_E_UPSTREAM_RESULT.md)。
