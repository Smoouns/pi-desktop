# Phase 1 原生桌面与真实 Agent 冒烟记录

日期：2026-09-20；补测：2026-09-21（北京时间）。状态：**真实模型 RPC 工具冒烟与原生 Desktop 的有限端到端冒烟均已通过；提交后的干净检出及远端 CI 仍待验证。** 桌面控制恢复后的 4 条提示/9 次只读调用见文末；此前配额、提供商和控制阻塞按时间保留，不把早期 RPC 结果改写为桌面证据。

## 环境与隔离

- 从当前工作树执行 `npm run tauri -- dev --no-watch`，重新编译并启动原生 Tauri 窗口；不是浏览器模拟界面。
- 当前实际 Pi CLI 为 `0.84.2`，不同于自动化测试锁定的 `pi-coding-agent@0.63.1`；本次仍不能据此宣布完整运行时兼容。
- 桌面启动已将受管小说扩展更新为 `pi-desktop-novel-tools-extension/v8`。
- 沿用现有模型选择：`minimax-cn / MiniMax-M3`。未读取或输出 API Key，未更换认证或模型配置。
- 新建桌面工作区“Phase 1 实机验收”，不覆盖原工作区。
- 使用 `prepare-novel-agent-test.ps1` 从公开合成 fixture 创建两个新副本：
  - `D:/PycharmProjects/novel_test/runtime/phase1-live-a`
  - `D:/PycharmProjects/novel_test/runtime/phase1-live-b`
- 两个副本都已复制当前 verifier，并保存 `.novel/agent-test-baseline.json`。随后仅为区分测试修改项目显示名称，新增 `notes/phase1-sentinel.md`。A 标记为 `PHASE1_PROJECT_A_BLUE_821`，B 为 `PHASE1_PROJECT_B_AMBER_493`。

## 已执行

| 检查 | 结果与证据边界 |
| --- | --- |
| 原生桌面构建/启动 | 成功，保留原有 Rust 告警 |
| 当前受管扩展同步 | 确认文件标记为 v8 |
| 新工作区/项目 A 会话启动 | 成功；会话存储路径指向 A，不复用原私人小说会话 |
| A 文档导航 | 从小说资源打开标记文件，正文显示 A 的标记 |
| 添加并切换项目 B | 小说资源显示 B 的项目名称，新会话显示 0 条消息，没有带入 A 的错误会话内容 |
| 跨项目同名文件读取 | 从 B 资源列表打开同名标记文件，正文显示 B 的标记；两个标签的完整路径分别属于 A/B |
| 会话列表 | A/B 各自显示在对应项目下；可重新选择 A 测试会话 |
| 文件安全 | A/B 对比复制基线均只有预期的项目名称修改和新增标记，未新增验证报告或改写章节、Canon、验收记录；公开源 fixture 指纹未变 |

桌面检查使用 computer-use 技能的原生窗口控制。A/B 导航与会话列表正确只证明上述 UI 场景，不等于已经证明模型运行期间的跨项目隔离或取消行为。

## 真实模型请求及阻塞

向 A 的全新会话发送一次只读测试：要求实际读取 `notes/phase1-sentinel.md`、`canon/world.md`，用 `search_story_memory` 查询“白潮栓”，不写文件、不读项目外内容或 oracle、不验收或晋升。

服务返回：

```text
HTTP 429
rate_limit_error
已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)
```

Pi 执行了其内置的 3 次重试后结束：1 次用户提交，记录到 4 条 assistant 错误响应。Harness 没有再重发 prompt。session JSONL 中没有任何工具调用，错误响应报告的 token usage 为 0。不能据此判断后续工具是否成功，也不将错误响应计为 Agent 验收通过。

没有继续发送新模型请求，没有尝试更换 key 或模型绕开限制，没有购买配额。错误来自模型服务的套餐用量提示；本轮并非之前的 401 invalid API key。

## 当时的待补验收（最新进展见文末）

需要用户恢复可用配额，或指定其他已配置且可用的模型后继续：

1. 实际 read/search 工具往返和项目标记核对。
2. 写文角色在测试副本上的连续 write/edit、修参后重试及 `verify_chapter`。
3. 执行途中的取消、会话/项目切换及迟到结果观察。

测试副本、基线和专用工作区保留，便于继续；本轮没有提交/推送，远端 CI 状态未变化。未修改生产代码来处理这一配额错误。

## 2026-09-21：Gemini 补测与提供商核对

用户指定已在 Pi 中登录的 Gemini CLI，使用 `gemini3.8flash`。本轮没有读取认证文件或输出凭据，没有安装、升级或降级任何包。

### 原生桌面限制

computer-use 可以取得 Pi Desktop 截图，但只返回标题栏 accessibility；侧栏及原生最大化点击后画面均未变化。重新选择窗口、激活、重置控制会话后再次尝试仍无效，按技能恢复规则停止输入。本轮没有通过桌面发送消息，也没有证明桌面项目/会话切换或取消成功。该现象不直接归因为 Pi UI 缺陷。

转为正式 `pi --mode rpc` 进行隔离预检；这条路径不经过 Desktop/Rust bridge，不能代替原生端到端验收。会话放在忽略目录 `artifacts/harness/gemini-live/sessions/` 的独立子目录，不复用私人会话。唯一发出的模型请求以合成项目 A 为 cwd，限定只读。

### 实际证据

| 检查 | 结果 |
| --- | --- |
| 本机运行时 | 全局 `@earendil-works/pi-coding-agent@0.84.2` |
| 目录与 `get_available_models` | 有 `google/gemini-3.8-flash`，但它是 Google API Key 提供商，不是 Gemini CLI OAuth |
| 一次只读请求 | `google/gemini-3.8-flash` 返回 HTTP 400 / `API_KEY_INVALID`，`stopReason: error`；无工具调用，无重试，不能算通过 |
| 完成判定 | 等待本机 0.84.2 的 `agent_settled`，不把 `prompt success:true` 当作测试成功 |
| Gemini CLI 扩展 | 本地安装 `@qraxiss/pi-gemini-auth@0.5.1`，注册 `google-gemini-cli`（Google Cloud Code Assist） |
| 指定模型匹配 | 此扩展登记了 `gemini-3-flash-preview`、`gemini-3.1-pro-preview` 等七个模型，但没有 `gemini-3.8-flash` |
| 普通扩展发现复核 | 去掉 `--no-extensions` 后重新只读查询 available models，仍未返回 `google-gemini-cli`；未进一步推断登录状态或再次发起模型请求 |
| 文件核对 | A 每轮前后 SHA-256 清单无变化；公开源 fixture 无变化；B 未写入 |

初次模型选择仅按 ID 匹配到了 `google`，这是与用户指定 CLI 通道不同的路由；其 400 错误不能证明用户的 Gemini CLI OAuth 无效。另外，仅加载小说扩展的 `--no-extensions` 会屏蔽第三方 OAuth 扩展；后续 CLI 测试应正常发现扩展，或显式同时加载 OAuth 扩展和小说扩展。

本机包的 CHANGELOG 记载从 0.71.0 移除内置 Google Gemini CLI 支持，当前依赖上述第三方扩展恢复。只存在于 Google API Key 目录的模型不能直接视为 Cloud Code Assist 可用模型，也不应仅改 provider 名称猜测服务端支持。

需用户确认实际已登录的 Pi 版本与提供商，或授权选择 CLI 扩展中真实存在的 Flash 型号后继续。不擅自降级 Pi、改认证或把 `3.8` 替换成 `3-flash-preview`。本轮未执行 write/edit、verify 或取消补测，未修改生产代码、未提交/推送；保留 Phase 1 的真实 Agent/桌面及远端 CI 欠项。

本地证据：`artifacts/harness/gemini-live/*-result.json`（仅摘要与文件指纹）、独立合成测试 sessions；运行脚本 `artifacts/harness/gemini-live.mjs`。这些是忽略的诊断产物，不纳入生产代码。

## 2026-09-21：gemini-proxy / gemini-3.8-flash-high 真实工具冒烟

### 配置与隔离

用户自行将正式 `models.json` 更新为 `gemini-proxy/gemini-3.8-flash-high`，API 为 `openai-completions`，地址为本机 `http://127.0.0.1:8045/v1`，密钥引用进程环境变量。本轮只投影检查提供商、协议、模型 ID 和环境变量存在性，不打印配置原文、认证文件或密钥。此前普通 `gemini-3.8-flash` 返回 429；`-high` 的最小连通性测试已成功，本轮正式使用用户更新后的配置。

实际运行时仍为全局 Pi 0.84.2，使用 `pi --mode rpc`，仅显式加载受管小说工具 v8；禁用 skills、prompt templates、全局/项目 AGENTS 与 CLAUDE 上下文自动加载、主题和启动网络操作。保留正常的模型配置和小说角色权限，设置写作角色。所有数据来自公开合成 A/B 项目；独立测试会话保存在忽略目录，不复用私人小说会话。模型 ID 是代理选择名，本测试不鉴定代理上游模型身份。

### 通过项目

共提交 **4 条测试提示，观察到 15 次真实工具调用**：A 只读 4 次，A 写入/验证 8 次，B 取消前 1 次，B 新会话恢复 2 次。不是 mock 模型响应。

| 场景 | 实际结果 |
| --- | --- |
| A 读取与记忆 | `read` 读取 A 标记、世界观，随后 `search_story_memory` 与 `read_story_memory` 成功；记忆来源为 A 的 `canon/world.md` |
| 连续受控写入 | 新建 `drafts/candidates/phase1-probe.md`，`seed → stage-one → stage-two`，最终字节内容为 `phase1-probe: stage-two\n` |
| edit 失败后修参 | 一次不存在的 `oldText` 按预期失败；随后改成正确的 `stage-one` 并成功，没有重放错误参数 |
| verifier 参数错误 | `chapter=bad-id` 返回结构化 `invalid_input / INVALID_CHAPTER`，尝试次数为 1 |
| verifier 正常运行 | 更正为 `002`，真实子进程生成 `planning/verifications/002-verification.md`，状态 `PASS`，正文计数 563，两个场景 301/262 |
| 取消 | B 的首次读取完成后发送 abort，后续预定读取没有执行；收到 `aborted`、`agent_settled` 和 abort ack，`isStreaming=false`、待处理消息 0 |
| 新会话恢复 | `new_session` 得到不同 session ID、消息数 0；观察 2 秒没有迟到工具结果，然后在新会话成功读取 B 标记与记忆，工具 scope 绑定新 session ID |
| A/B 作用域 | A/B 的 project ID、记忆 ID 和返回 project 路径不同，各自读到正确标记；这是两个真实 Pi 进程的项目作用域证据，不是 Desktop 运行中切换证据 |
| 文件安全 | A 仅新增探针文件和 002 机械报告；B 无变化；其余正文、Canon、人工验收文件和公开源 fixture 的 SHA-256 均保持不变 |

失败测试是有意注入的错误输入，不计为产品故障。报告 `PASS` 只表示机械验证，不等于章节人工验收或 Canon 晋升。工具参数中未出现 oracle、项目外或私人小说路径。未调用 bash。

### 测试脚本修正与证据复核

本机 Pi 0.84.2 的内置 `edit` 使用 `edits[0].oldText/newText`。初版测试断言误按旧版顶层 `oldText` 检查，导致写入运行在所有工具完成、正常 `stop/agent_settled` 后出现一次断言假阴性。保留原始错误记录；只修正诊断脚本，不重放写入。离线复核脚本重新检查原始 8 次调用、修参值、结构化错误、scope、最终哈希和报告，10 组证据检查全部通过；另经独立只读审计确认。

另发现用于测试的 RPC `set_auto_retry(false)` 会持久化 Pi 全局设置。已恢复为此前观察到的启用状态 `retry.enabled=true` 并读回确认；从后续测试脚本删除此设置命令，改成在出现重试事件时只中止当前重试。本轮成功工具运行没有 provider retry 事件。没有更改模型配置或认证数据。诊断脚本不是生产 Harness 实现。

### 该轮 RPC 未覆盖（后续桌面补测见下节）

- computer-use 重新选择、激活并尝试原生最大化，恢复重试后画面仍不响应；按技能规则停止继续点击，不能把这批 RPC 测试写成原生 UI 通过。
- 本轮取消发生在工具之间、下一段模型生成期间，不是写入或 verifier 子进程执行中。后两者仍只有已有确定性自动化测试证据。
- 本轮不经过 Desktop/Rust RPC bridge，不覆盖桌面按钮、流式思考显示、运行中切换项目/会话或 UI 迟到事件。
- 未提交、推送或运行远端 CI；未升级依赖，未改生产代码。版本漂移的完整兼容性仍不能由这 15 次调用推断。

### 证据文件

忽略目录中保留：

- `artifacts/harness/gemini-live/phase1-live-a-read-1789924216621-result.json`
- `artifacts/harness/gemini-live/phase1-live-a-write-1789924279012-result.json`（保留旧字段断言错误）
- `artifacts/harness/gemini-live/phase1-live-b-cancel-1789924408176-result.json`
- `artifacts/harness/audit-gemini-live.mjs` 与 `artifacts/harness/gemini-high-phase1-summary.json`

可离线执行 `node artifacts/harness/audit-gemini-live.mjs` 复核现有证据，不会请求模型或再次写入项目。A 的探针和报告保留，后续测试不得无检查覆盖。

## 2026-09-21：原生 Desktop/Rust 端到端补测

### 控制恢复与测试边界

此前 Pi Desktop 以提升权限运行，而控制端为普通权限。用户从普通权限终端重新启动后，原生最大化/还原、文档 Raw/Rendered 和应用内点击恢复响应；本轮通过 computer-use 技能操作实际 Tauri 窗口。没有提升 Codex 权限、关闭 UAC 或更改安全配置来绕过限制。

使用已配置的 `gemini-proxy/gemini-3.8-flash-high`，只操作“Phase 1 实机验收”工作区及公开合成 A/B 副本。所有请求在桌面输入框填写并发送，经过 Desktop/Rust bridge；没有用独立 RPC 脚本代发。未读取认证文件、改模型配置或全局 retry 设置，未修改生产代码、私人小说，也未提交或推送。

本轮所有模型请求均限定只读。测试开始前重新记录 A/B/公开 fixture 指纹，包含前次 RPC 留下的 A 探针和机械报告；这些不是本轮新增文件。

### 实际执行结果

共 **4 条用户提示、9 次成功工具调用**，分布于 3 个实际有消息的会话；3 次自然 `stop`，1 次主动 `aborted`。

| 场景 / 请求标记 | UI 观察及日志复核 |
| --- | --- |
| B 只读 `UI-B-READ-0921` | 真实调用 `read` 两次（标记、世界观）、`search_story_memory`、`read_story_memory`，共 4 次；可展开工具组查看条目，回复正确 B 标记和白潮栓边界。结束后 Pending 为 0。 |
| 生成中跨项目切换 `UI-A-SWITCH-0921` | A 调用一次 `read` 得到 A 标记并开始长文本流。在仍生成时点击 B 会话，B 显示原有 B 对话，没有混入 A 流文本；返回 A 后可查看 A 内容。该轮最终输出 200 条并自然结束，**不计为停止成功**。 |
| 生成中同项目切换、主动停止 `UI-A-STOP-0921` | 旧 A 的第二条请求只调用一次 `read`。生成中打开同项目新会话，Messages/Pending 均为 0，没有旧 A 文本；回到旧 A 后点击停止。UI 显示 `Operation aborted`，发送控件恢复；JSONL 末条 `stopReason:aborted`，占位文本在第 166 条中途截断。后续复查没有继续追加。 |
| 停止后新会话恢复 `UI-A-RECOVER-0921` | 另开 A 会话，先确认 Messages/Pending 均为 0，再发送只读请求。`read`、`search_story_memory`、`read_story_memory` 共 3 次成功，来源为 A 的 `canon/world.md`，自然结束、Pending 为 0。新会话内容没有旧 A 流标记、B 标记或 B 路径。 |

200 条占位文本只是为了制造可观察的生成窗口，正文中列举的各种“测试项”不是已经执行的测试或通过证据。恢复请求最终回答将“能力边界”理解为系统只读权限，而不是白潮栓设定，因此该项只确认真实读取/检索及会话恢复，不计为设定语义回答正确。

切换时中心文件编辑器保留 B 标记页是独立文件标签的状态，不等于 A 对话取得 B 上下文；恢复会话 JSONL 中没有 B 路径/标记。`<novel-context>` 索引含公开 fixture 的 oracle 文件元数据，但未内联正文、也没有工具读取 oracle。9 次调用中没有 write/edit、bash、verify、验收或晋升操作，没有项目外/私人路径读取。

### 会话与文件证据

日志位于用户 Pi 的 `sessions/--D--PycharmProjects-novel_test-runtime-phase1-live-{a,b}--/` 下。仅审阅本次已明确定位的测试日志，不读取其他私人会话：

- B：`2026-09-21T04-17-09-421Z_01a0c22e-9b2d-7d6c-9f9b-9376b3cdc623.jsonl`。
- A 切换/停止：`2026-09-21T04-37-39-537Z_01a0c241-6051-7803-a864-4ad3af012075.jsonl`。
- A 恢复：`2026-09-21T04-46-44-894Z_01a0c249-b29e-7589-addd-0a6d5c9156f9.jsonl`。

B 的 JSONL header 与 memory 工具使用实际 session ID `01a0c237-afee-7251-83de-9f3710ecaf47`，不同于文件名后缀及 UI 路径提示；实机观察时尚未定位原因，后续调查见下节。B memory scope 的 projectId 为 `04f7f1d5947c5125e269ede37dd7690794fc5a30bcdad64d9056f4e3f7ee2c08`、runId 为 `b8137aa0-a034-483c-a746-e9d74448e0f7`、扩展 generation 为 6。

A 恢复会话 header 与文件名 ID 相同；memory scope 的 sessionId 为 `01a0c249-b29e-7589-addd-0a6d5c9156f9`、projectId 为 `8dc4c31fd82133354c7427d6f4b6665135e4162b1cae28393cd2213f94d3981c`、runId 为 `4f979fc0-b28a-480a-9b1f-b96badddc3ae`、扩展 generation 为 3。内置 `read` 没有该结构化 scope，其证据只限于 session cwd、相对读取路径及实际正确标记，不冒称每个工具都返回了贯通作用域。

停止后的旧 A 日志保持 11 行、53,217 bytes，末条仍为 `aborted`，最后写入时间 `2026-09-21T04:45:37Z`；恢复请求完成后的复查没有迟到追加。

独立只读审计逐文件比较本轮开始/结束 SHA-256：

| 对象 | 前后文件数 | 新增/修改/删除 |
| --- | --- | --- |
| `phase1-live-a` | 22 → 22 | 0 / 0 / 0 |
| `phase1-live-b` | 20 → 20 | 0 / 0 / 0 |
| `fixtures/harness-novel` | 17 → 17 | 0 / 0 / 0 |

### 剩余限制与待跟进观察

- 本轮证明的是上述原生桌面冒烟场景，不是所有交错时序的竞态穷举。UI 画面/按钮恢复来自实际窗口观察，JSONL 只能补证内容、工具和结束状态，不能单独证明视觉效果。
- 主动停止发生在 `read` 完成后的模型文本生成中，不是 write/edit 或 verifier 子进程执行中；后者仍使用既有确定性测试证据。
- 观察到完成后的展开工具面板仍有“正在思考…”静态标签；原生测试当时未处理，没有因此把正常完成误判为仍在运行。后续修复单独记录如下。
- B 会话文件名 ID 与内部 header/scope ID 不一致；原生测试当时尚未定位，但实际工具项目、内部 scope 与内容隔离一致。保留此历史证据，不改名或重写测试日志。
- 不据本轮测试证明代理上游模型身份、全部模型语义能力或 Pi 版本间完整兼容性。
- 提交后的干净检出与远端 Windows/Linux CI 仍未执行；本轮只更新验收记录，不开始 Phase 2。

## 两项观察的后续修复（2026-09-21）

用户随后授权“修复这两个问题，然后提交并推送”。本节是代码调查与自动化回归，不是再次原生桌面操作或真实模型请求。

1. **完成后的思考标签**：原先模板始终输出 `Thinking…`，所以完成后即使动画结束仍显示进行时。工作流和独立思考块现在根据活动状态显示“正在思考…”或“思考过程”，完成的思考正文与展开功能继续保留。实际 Lit 模板回归覆盖完成与流式两种标签及正文保留。
2. **未落盘草稿被当作历史恢复**：检查本地 Pi 0.84.2 源码及锁定 0.63.1 SDK，二者对不存在的显式 session 路径都会新建 header ID，同时保留传入文件名；新会话通常直到首条 assistant 消息才落盘。该机制与 B 记录时序一致，并已用真实 SDK 在独立临时目录复现。Desktop 新增只读文件头检查，仅对明确空白的临时标签重新创建会话，禁止缺失/损坏历史静默新建，并在恢复后核对 header ID。跨 generation 的旧结果不得影响新 runtime。

已有 B 文件的 header ID 继续作为实际身份，文件名和内容保持不变；不为统一显示而改写历史。回归还覆盖取消、未知结果不重放、恢复期间身份变化、旧代检查迟到。Rust 文件头与进程代际测试、TypeScript 检查、公开领域回归和前端构建分别验证，不把适配器结果当作 Desktop/Rust/UI 端到端证明。使用新增 Rust 检查需要重启新版 Desktop。
