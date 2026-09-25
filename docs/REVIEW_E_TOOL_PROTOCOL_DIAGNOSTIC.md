# E8：单请求显式禁用工具诊断

日期：2026-09-25。初始轮次完成离线准备；用户随后批准新清单，现已完成 **1 次真实请求，HTTP 200，未观察到工具调用**。新清单授权已消耗，没有重试或追加。下文保留准备记录，并在末尾记录真实执行。本诊断不是 U/C/R 联合验收，也没有自动改生产调用策略。

## 范围与观察目标

保留完整当前生产扩展、固定 Pi SDK 0.63.1、写作角色、TaskContract 和原 U 首条只读确认提示；新建一个隔离的公开合成项目与会话。诊断专用前置 payload handler **只添加 `tool_choice: "none"`**，然后交给原生产审计和发送计量。`tools` 仍为空，实际工具许可为零，没有提示词改写、额外工具 schema 或正文资料。

提示仍为：`仅整理下一步规划，不写正文；不批准章节卡，不晋升 Canon。 只简短确认只读边界。`

本次只观察显式禁用下是返回文本、要求调用工具，还是发生 HTTP / 协议 / 用量错误。即便收到纯文本，也只说明这一次响应的行为，不能证明原异常唯一由缺少参数造成、实际模型身份正确或未来绝不会返回工具调用。模型输出的只读确认不等于任何小说验收。

## 新清单的硬边界

- 模型仍为 `gemini-proxy / gemini-3.8-flash-high / openai-completions`；窗口 262,144，请求输出最多 2,048。配置本身不改。
- **全批最多 1 次派发**，只发 1 条用户提示，禁止追加、重试、摘要、压缩、标题生成、模型裁判及工具执行。
- 输入最多 8,192 UTF-8 bytes，按字节保守预留；单请求 90 秒、任务 120 秒、批次 180 秒；返回字节最多 262,144。原始 completion / reasoning 和 SDK 归一化输出分别保留，超额或必要用量未知即停止。
- 原生工具尝试仍阻断；额外检查 SSE 中的 `tool_calls` 和旧 `function_call` 字段，防止 SDK 未识别的工具字段被误算纯文本成功。不开放 `list_dir` 来消除错误。
- 只保存 HTTP 状态码，不采集任意错误响应体或敏感 headers。无法从状态码确定更具体原因时，仍保留未知。
- 旧共用策略类型要求所有数字上限为正，因此 JSON 的 `maxTaskTools` 仍为 1；这**不是一次工具许可**。此 profile 的独立许可门禁与活动工具列表均为空，允许成功执行工具数为 0。
- 24 小时、精确 SHA-256、单次批准；独立无凭据进程先消费授权，之后才解析所选环境变量。准备 / 核对不解析真实 key，worker 永远只有合成凭据。修改代码、配置、清单、资产、预算或复制目录都会失效，失败也不返还授权。

按用户参考价，满额无缓存预留参考值为 **$0.013824**（约 $0.014）：输入 `8192 × $0.75 / 1M`，输出 `2048 × $3.75 / 1M`。这不是预计账单或美元硬限额；cache 不明或 reasoning 计费口径不明，费用仍未知。上游代理内部行为不在本地请求计数的验证范围内。

## 实现与冻结内容

- 新 `tool-none` profile 使用独立清单类型、`tool-none-*` 目录及独立 JSON 计划：`docs/REVIEW_E_TOOL_PROTOCOL_PLAN.json`。该 JSON 只是未授权设计，不可单独用于执行。
- 复用现有隔离 worker、完整扩展、生产 sidecar 检查、IPC 流、限额账、单次授权及恢复机制。普通 U/C/R profile 不自动获得新参数；其原计划 JSON 不变。
- `assets/inputs.json` 只含本诊断的公开输入、单阶段和无工具策略；worker / profile / 完整扩展、代码、两份计划、模型和目的地址 / 凭据引用指纹、已安装依赖及 Node 字节都被绑定。
- SDK 自动附加的当前日期、隔离项目 cwd、运行标识会随执行生成，不伪称 probe 与 live 的整个请求字节完全相同。固定用户提示和诊断处理代码被冻结，最终实际请求另以 SHA 留档。
- 专用报告保留原始和 SDK 工具调用观察、HTTP 状态、回复文本、同调用 usage 配对以及明确的 `ucrAcceptance: not_run` / `rootCauseEstablished: false`。非文本完整回复、失败及中止均退出非零；退出 0 也不是因果证明或人工验收。

## 离线验证

- **16 组 / 0 失败**：`artifacts/harness/review-e8/tool-none-tests-qvwqVd/summary.json`。包括单请求全生产 SDK 演练、payload 修改前后 SHA 对比、原生产扩展逐字一致，以及 7 个完整 SDK 合成响应分支：文本、工具调用、旧式工具调用、HTTP 400、缺少 usage、空回复、截断回复。
- 同套件还覆盖 8 种发送前拒绝、单次额度与 permit、授权 / 成本确认 / 到期 / 配置变化、清单复制 / profile 置换 / 资产与预算变化、凭据解析先后次序。所有授权和凭据测试只用公开虚构配置；不是用户批准。
- 原准备门禁 **33 组 / 0 失败**：`artifacts/harness/review-e8/gate-tests-qsMDJE/summary.json`；旧 U/C/R 仍为 14 次合成请求，空工具仍不偷偷增加 `tool_choice`。
- 原 SDK / 本机合成 HTTP **23 组 / 0 失败**：`artifacts/harness/review-e8/offline-5RrYAo/summary.json`。这些本机 HTTP 不等于外部模型调用。
- 首轮 16 组通过的 `tool-none-tests-Z3CsXP` 也保留；最终轮补充了 HTTP 状态码记录与隔离来源 v1 的写后核对。
- 以上离线准备轮次真实模型调用为 0；不改全局 Pi、真实小说、冻结评测实现或旧批次产物，不操作 Desktop、不提交 / 推送。不新增完整 Harness / Rust / 安装包 / 远程 CI 验收结论。后续批准后的单次真实请求另记于下方。

## 命令与批准

```powershell
npm run test:review-e8:tool-none
npm run eval:review-e8:prepare-tool-none -- C:\Users\Silence\.pi\agent\models.json
npm run eval:review-e8:verify -- <新清单绝对路径> C:\Users\Silence\.pi\agent\models.json
```

只有用户在看到新清单 SHA、模型、单次额度和未知费用边界后批准，才能使用既有 gated live 入口执行此新 profile。它不允许继续旧批次或追加 U/C/R。下面保留本次精确清单和执行记录，不能将历史命令视为重复执行许可。

### 精确清单（2026-09-25，准备时待批准，现已消耗）

- 新清单：`artifacts/harness/review-e8/tool-none-Z93R4B/manifest.json`。
- SHA-256：`5c77620d71b94c9d352e7ce72436c3fa725e29ae315be0f81d384fde43e69b02`。
- 创建：**2026-09-25 16:52:10.260 UTC+8**；到期：**2026-09-26 16:52:10.260 UTC+8**，单次使用。
- 已对用户现有选定配置完成无网络准备并独立 verify：169 项源文件、2,469 项选定依赖、8 项准备资产被绑定，授权未消耗、执行未启动，不存在 `live` 目录。
- 原生完整扩展演练仅 1 个预留 / 1 个终态 / 1 条 usage 配对；最终 payload 明确有 `tools: []`、`tool_choice: none`，参数调整记录只有 1 次。回复和 usage 都是合成数据，真实模型调用与网络请求为 0，未解析真实凭据。
- 两份 TypeScript 检查通过。旧真实批次 8 项证据 SHA 和原 U/C/R 计划 JSON SHA 均未变。沒有更新生产参数、全局配置或真实小说，没有提交推送。

上述未消耗 / 未启动是准备时的状态。随后用户批准此清单的 1 次请求及未知费用边界，执行结果如下；不重新授权旧批次或后续联合验收。

## 批准后的单次真实执行（2026-09-25）

用户在看到精确 SHA、模型、最多 1 次请求和费用可能未知的说明后回复“可以”。执行前单独核对 SHA、有效期、全部冻结文件以及尚无授权 / 启动回执，通过后于 **17:09:30.138 UTC+8** 消耗授权，再解析凭据进行唯一一次发送。

### 请求与结果

- 实际请求带 `tools: []` 和 `tool_choice: "none"`，输出参数 `max_completion_tokens: 2048`；最终请求 3,184 UTF-8 bytes，低于 8,192 字节上限。诊断 hook 前后 SHA 核对确认仅增加 `tool_choice`，完整生产扩展保留。
- **1 次预留 / 1 次远端派发 / 1 个完整响应，HTTP 200**；SSE 工具调用片段 0、SDK 工具调用 0、成功工具执行 0。生产账为 1 个普通 provider 入口、摘要 0、取消 0、错误 0、重发 0。
- `stopReason=stop`，返回文本确认只读边界，并附了较长的后续规划。这满足本次“文本回复且不调用工具”的协议观察，不表示完全满足“简短确认”的表达要求，更不代替小说内容验收。
- 执行进程退出 0，报告 `mechanicalStatus=completed` / `toolNone=text_without_tool_call`；U/C/R 仍为 `not_run`，原异常根因和上游身份仍为未确定。

### 用量与边界

原始 usage 为输入 **802**、completion **296**、reasoning **519**；固定 SDK 归一化输出为 **815**，与原生持久会话账逐调用配对一致，低于 2,048 上限。cache 字段仍缺失，**参考费用和实际费用均未知**，不把 SDK 的合成价格 0 当成免费。

本地输入估算 1,656，相对实际归一化输入 802 高估 854（约 106.5%）。本批只有 1 个样本，无追加锚点或压缩；不调整估算倍率或模型窗口。thinking 为 off 但仍返回 reasoning 用量，不能声称代理已经关闭上游 reasoning。

这说明本次携带显式禁止字段的请求没有被接口拒绝，且返回了文本；**不能证明代理一定执行了该字段，或缺少字段就是上次 `list_dir` 异常的唯一原因**。新旧请求的运行日期、隔离路径、任务标识等不同，又无随机对照，不能冒充严格单变量因果验证。

后续经用户批准，仅 U/C 测试（含原生摘要）启用显式禁用，R 和生产 Agent 保持原样。已完成独立 `joint-tool-none` profile 和新的无网络准备，详情见 [新版联合验收](REVIEW_E_JOINT_TOOL_NONE.md)。该新清单另行获批后已执行，第 3 次请求因输出超额停批，见 [联合实测结果](REVIEW_E_JOINT_TOOL_NONE_RESULT.md)；不能使用本节已消耗的单请求额度。

### 留档与收尾

- 原报告：`artifacts/harness/review-e8/tool-none-Z93R4B/live/report.json`；同目录保留 broker Journal、worker 结果和原生会话。
- 独立只读核对：`artifacts/harness/review-e8/readback-tool-none-Z93R4B/summary.json`，同目录 `audit.mjs` 保存过程；验证 broker 哈希链、原生各台账 SHA、同调用 pending→terminal 变化、SDK assistant usage、payload 修改前后 SHA，以及 Canon / 人工批准 sentinel / 来源 v1 字节不变。
- 本批原始产物不改写，旧失败批次的 8 项 SHA 也与先前审计一致。只读 recover 确认 1 预留、1 终态、0 未结、0 新请求、禁止重放；执行后独立 verify 通过，授权已消耗。
- 没有第二次真实请求、额外连通性测试或新的准备批次；没有生产代码 / 策略、真实小说、全局 Pi、Desktop、提交或推送操作。没有本轮新的完整 Harness / Rust / 远程 CI 结论。

下一步建议仅将显式禁止参数用于后续 **U/C 无工具测试 profile**，保留 R 及正常 Agent 的工具能力，再准备新的 U/C/R 清单并单独批准。本轮没有实施此改动，也没有把已消耗的单请求授权扩成联合验收。
