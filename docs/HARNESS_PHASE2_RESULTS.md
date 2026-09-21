# Phase 2 本地实施与验证记录

日期：2026-09-21。基于 Phase 1 `32131274be2964a61d0180088eeb51709ebdb86f`，只改本仓库代码及公开合成测试，不改私人小说或用户的 Pi 凭据/模型配置。确定性自动化阶段未调用真实模型或操作原生 Desktop；随后经用户另行授权，以公共合成 A/B 项目完成了边界明确的原生 Desktop 实测。实施与实测结束时尚未提交；用户确认最终请求闸门暂缓后，另行授权提交与推送。

## 本次实现

- `src/harness/observation-store.ts`：不可变的进程内工具观察，payload 与 access receipt 分开；项目/会话/角色隔离。相同来源版本、范围与内容只保存一份，每次工具读取仍记访问。来源不等于 Canon。
- `src/harness/context-budget.ts`：选材软预算、单次运行累计读取/工具结果预算、每次请求分项预检。system、全部 active tools、history、checkpoint、observation preview、new evidence、序列化开销、输出预留与安全余量分别记账。
- `src/novel/read-range.ts`：保留原始换行的精确行范围、唯一 Markdown ATX 标题段落；识别代码围栏与子标题；非法范围/歧义标题明确拒绝。
- 生产扩展升级至 v9：document/chapter 支持 `startLine/endLine/section`，新增 `read_observation`、`get_context_budget`。长输出保留完整文本，模型收到预览与 ID；读取旧 ID 时核对原文件 SHA，记忆引用另核对当前人工验收资格。
- `context` 仅修改发送副本，保留用户指令与 tool-call/result 配对；同版本重复文件观察缩为引用。历史/第三方/错误大结果外置为无来源的运行观察，不捏造文件 SHA 或 Canon 权威。图片等暂不能可靠计量时停止，不静默丢弃。
- 界面将原 token 数改称“选材估算”，明确不等于实际请求 token。运行时账本通过只读工具检查；未新增预算仪表板。

## 当前参数与恢复方式

| 项目 | 当前值/行为 |
| --- | --- |
| UI 选材软上限 | 16,000 estimated tokens，固定资料仍可超过 |
| Read Budget | 每 run 16 MiB；受控小说读取、来源重验与记忆索引按文件字节记账 |
| Tool Output Budget | 每 run 64 KiB，重复工具返回仍收费 |
| 单文件上限 | 1,600,000 bytes，超限要求拆分；按行读取仍需读取完整文件以核对 SHA |
| 内联阈值 | 文本超过 6,000 UTF-8 bytes 外置，预览 500 UTF-16 字符 |
| Observation 分页 | 默认 1,200、最多 4,000 UTF-16 字符，不是行号 |
| Store | 每进程 8 MiB payload、512 records、4,096 accesses；每条至多 32 个来源 |
| Model Input 估算 | 完整 JSON 的 UTF-8 bytes 保守代理，不是精确 tokenizer |
| 输出预留/余量 | 模型 maxTokens（缺失时 4,096） + 4,096 safety units |

Read Budget 一旦不足，本轮后续读取保持阻断，避免记忆扫描吞掉错误后返回假“未找到”。`get_context_budget` 仍可查询。新一轮重置 run 额度，但不清空观察存储；Store 满时必须重启 Pi 运行时并重读来源，仅新建会话无效。重启后不提供旧观察的持久恢复。

文件普通读取的 authority 标为 `unclassified`；仅来源记忆保留既有 authority/temporal，且回读时重验资格。其他工具/历史结果无版本来源时只能代表那次运行，不能作为已重验的当前文件证据。

内置 `read` 的整文件预检也计费；Pi 内部的二次读取、`grep/find/ls` 扫描以及 verifier 子进程内部 I/O 并未全部拦截，因此不能把 Read Budget 宣称为整个进程的磁盘 I/O 硬配额。它们的返回内容仍受工具/请求预算约束。普通读取多次运行累积历史后可能较早触及保守预算；本阶段不自动压缩用户历史。

## 请求闸门的已知 SDK 边界

固定测试 SDK 为 `@mariozechner/pi-coding-agent@0.63.1`。其 ExtensionRunner 会捕获 `context` / `before_provider_request` handler 异常，因此单纯 throw 不是硬闸门。

已实现并用真实 runner/provider + 回环 HTTP 验证：在 **context preflight** 发现过额、媒体不能计量或系统/工具接口缺失时主动 abort，OpenAI 与 Google 都为 **0 HTTP**，用户原文不被裁剪。工具预算覆盖整个 run，不是只测单个 helper。

最终 provider payload 另经 `checkPayload` 审计，并在过额时请求停止。但 provider 转换可增加字段，早期估算加余量并非数学上保证最终大小。单独 late-abort 回归显示 OpenAI 为 0 HTTP，而 Google 为 1 HTTP，即使最终状态均为 aborted。此用例通过表示**成功捕获已知限制**，不是 Google 闸门已修好。严格最终载荷硬上限需要上游可取消的 pre-send 接口或后续受控适配；本轮不 monkeypatch SDK、不替换用户 provider、不发畸形请求冒充阻断。

后加载的其他扩展仍可改变上下文；当前不是任意恶意扩展的安全沙箱。真实全局 Pi、原生 Desktop 和真实模型已补充下述有限成功路径实测；其他 providers 及真实超限取消仍需分别复测。

最终 provider 事件没有可携带的 request ID；审计只允许当前已通过 context 预检且 scope 匹配的 run，不能在该钩子重新建立或切换 run。这不构成任意第三方 SDK 的逐请求事件归属证明。

### 2026-09-21 处理决定：当前使用路径暂缓修复

用户要求边界情况保留记录、常见问题才考虑修复。核对当前配置后，`gemini-proxy/gemini-3.8-flash-high` 继承 `openai-completions` API，不经过本缺陷所涉及的原生 `google-generative-ai` 适配器。结合前置超额拦截的回环证据，将 **P2-GATE-FINAL 列为当前路径低优先级、暂缓且不阻塞后续阶段**；保持未完成状态、现有预算检查和 late-abort 回归测试，不修改生产代码或 SDK。

这不是对日常发生概率的测量。“极端情况”更准确地应理解为最终构包/复核这一边界：普通上下文超额已由前置检查拦截；只有前置通过后最终检查才拒绝时，才依赖此处的取消能力。现有 late-abort 用例直接在正常小请求的最终回调中取消，证明的是取消时序缺口，不证明只有超大请求才会触发，也不证明问题罕见。三轮真实代理冒烟只证明正常路径成功，不证明所有长对话、SDK 版本或 provider 安全。

重新评估条件：

- 改用原生 `google-generative-ai`，先对实际 Pi/SDK 做针对性复测，再决定是否需要受控适配。
- 发现真实任务出现“前置通过、最终超额且仍发包”，或普通长对话反复触发最终拒绝，则提升优先级处理。
- 产品要求超预算后绝对不发请求（严格费用或数据发送控制），则该缺口成为阻塞项，不能依赖目前的尽力取消。
- 升级 SDK 时继续跑既有回归；若行为变化，重新核实记录，不仅为保持测试通过而修改预期 HTTP 次数。

## 验证

最终环境：Windows x64、Node `v24.19.0`、npm `11.17.0`、固定 Pi SDK `0.63.1`、esbuild `0.27.3`。

- `npm run check`、`npm run check:harness-tests`：通过。
- `npm test`：Harness **120 cases × 3**，`deterministic=true`，0 fail/partial；五组领域回归全部通过（novel domain / extension / verifier / world change / memory）。其中 memory 为公开 fixture 检索 4/4，非真实小说能力评分。
- `npm run test:harness:baseline`：保留 B0 三个已知缺陷的可复现证据；当前 manifest/parser、symlink escape、malformed metadata write 三项均不再复现。
- `npm run test:harness:isolated`：明确 allowlist 的未提交源码快照，fresh `npm ci`、两套 typecheck、120 × 3 Harness、五组 regression、frontend build 六条命令均退出 0；未复制被忽略的私人小说。不是已提交 clean clone，也不是远端 Phase 2 CI。
- `git diff --check`：通过。前端构建仍有既有混合 import / 大 bundle 提示，不把它们当作 Phase 2 新修复。

最终运行的扩展源码 SHA-256 为 `3f2a40d75fbb7618c49d6276fd2fd84bb027bc55b87e369c86ef66cdebbc4053`。隔离测试源码快照（收尾文档勾选前）的 manifest SHA-256 为 `06e549f1102d0faaaccdb4228224a4b37e132166eda8dbfa1740e4f2e0cb0eaa`。

公开 fixture 在每个确定性测试前后核对指纹。自动化阶段真实模型调用数为 **0**、`actualModelInputTokens=null`；provider 测试确实调用固定 SDK 的 provider，但网络仅到本机模拟端点。120 项通过包含“已知 Google late-abort 限制仍可复现”，不能据总通过数宣称限制消失。

主要证据输出（不提交的合成 artifacts）：`artifacts/harness/summary.json`、`run-1.json` 至 `run-3.json`、`regression.json`、`b0-raw.json`、`b0-fixed.json`、`isolated-summary.json`。

## 原生 Desktop 公共 A/B 冒烟

后续用户授权了有限原生实测。环境为 Pi CLI `0.84.2`、managed extension v9（源码 SHA-256 仍为 `3f2a40d75fbb7618c49d6276fd2fd84bb027bc55b87e369c86ef66cdebbc4053`），界面配置显示模型 `gemini-proxy/gemini-3.8-flash-high`。测试只使用两个从公共 fixture 准备的合成项目；没有修改私人小说、Pi 凭据或模型配置。

本次共发生 3 次 UI 用户提交、2 个合成项目会话、15 次工具调用（13 次成功、2 次预期的过期/隔离拒绝）和 18 条 assistant 响应。这些由界面操作及对应会话日志核对，**不是 HTTP 请求数**，也不能用于证明上游实际模型身份。

成功路径覆盖：精确行范围、唯一 ATX 标题段落、超过阈值的整文件结果外置、相同来源版本的 payload 去重但访问/工具预算继续记账、Observation 连续分页、A 文件改变后旧 ID 返回过期错误、B 项目拒绝 A 的 Observation ID，以及运行预算查询。最终审计确认公共 fixture 的 17 个文件未变、B 的 18 个文件未变；A 只有合成 `notes/phase2-large.md` 被追加了预先批准的确定性探针。

该实测不证明原生角色切换、运行时重启后的恢复、所有 provider 最终载荷严格硬闸门、远端 Phase 2 CI 或上游模型身份。详细步骤、结果和边界见 [HARNESS_PHASE2_LIVE_SMOKE.md](HARNESS_PHASE2_LIVE_SMOKE.md)。

## 手工测试建议

重启新版 Desktop 的 Pi 运行时，在复制的测试小说中：

1. 要求 Agent 按 `startLine/endLine` 或 `section` 读取文件；核对返回范围。
2. 读一个超过 6 KB 的文件，确认先见 observation ID；让 Agent 用 `read_observation` 分页读取。
3. 要求同一文件连续读取两次，再调用 `get_context_budget`：同来源不重复存 payload，但访问及读取/工具输出仍累计。
4. 在外部编辑器改动该测试文件后，再读旧 ID，应提示 `stale_source`；重新读取文件可得到新版记录。
5. 切到另一小说/另一职能会话，旧 ID 不应可用；切回同会话仍需来源重验。

不要求为了测试刻意让真实模型发送超大或收费请求；预算超限与取消边界已在本机无模型自动化中验证，原生实测只覆盖上述成功路径与预期拒绝。Phase 3 的 Checkpoint、压缩/恢复、Supervisor 和自动三 Agent 编排均未实施。
