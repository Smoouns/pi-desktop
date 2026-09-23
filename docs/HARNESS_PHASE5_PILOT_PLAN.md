# Phase 5-B 最小真实模型 Pilot 方案与执行状态

2026-09-22。已增量实现离线工装、独立 live 执行路径与逐请求持久化 Journal；**本文件是预登记方案，不单独授予 API 调用权限**。首批 `live-CwHPbD` 在 3 次真实 HTTP 后答案校验失败，已封存。诊断升级与 READ 提示澄清后，新批 `live-mHOnDl` 另获明确批准，两任务均通过，共 6 次真实 HTTP，无重试。详见 [工装说明](HARNESS_PHASE5_PILOT_TOOLING.md)。历史矩阵、首批负结果和新版成功证据均以 [结果文档](HARNESS_PHASE5_RESULTS.md) 为准。

## 1. 首轮目标

先证明“当前生产小说扩展 + 固定 Pi SDK + 已配置代理”的真实请求能够被计数、限额、归因并从脱敏记录复核，而不是立即做七变体模型消融。

- 仅 1 个运行配置，命名 `harness-current-sdk-pilot`；不复用离线 `current-full-contract` 的结果身份。
- 2 个公开合成任务，各 1 次；串行运行，无失败补跑、无排名、无改善百分比。
- 用实际模型决定工具调用，外层只限制权限/预算并检查结果；不得通过 mock 工具选择代替真实往返。
- 不写小说章节，不跑 verifier、不人工验收、不晋升 Canon，不测试完整长程创作质量。
- 原生 Desktop / Rust bridge / 全局 Pi CLI 留到单独实机验收。此轮是固定 SDK 集成证据，不是原生桌面证据。

## 2. 已核对配置与差异

| 项目 | 当前本地检查 / 本轮选择 |
| --- | --- |
| provider / model | `gemini-proxy / gemini-3.8-flash-high`，选定项存在 |
| API 协议 | `openai-completions`；不等同于直接 Google 或 Gemini CLI 通道 |
| 当前配置工作窗口 | 262,144；不修改全局值 |
| 当前配置最大输出 | 16,384；pilot 每请求显式收紧至 2,048 |
| 固定 SDK | 仓库安装及 lock 固定 `@mariozechner/pi-coding-agent@0.63.1` |
| 生产扩展 | 从本次源码生成 `NOVEL_TOOLS_EXTENSION_CONTENT`，当前标记 v15；实际运行前再次核对并冻结 SHA |
| 桌面运行时 | 先前实机记录为全局 Pi 0.84.2；本次未重新探测，不将该旧记录当成本轮运行环境 |
| 凭据 | 最初预检只确认配置存在；两次获批 live 批次在专用运行中解析必要认证并完成 HTTP 往返。凭据不进入公开产物，不据此保证未来仍有效；本次证据整理不重新读取或测试认证 |
| 价格 | 选定模型没有声明可核验价格，费用未知，不能以 SDK 的零费用默认值声称免费 |

只使用这个精确的模型选择名；不鉴定代理背后的上游型号。若 model、API、必要兼容设置或端点改变，先停止、重新冻结方案，不自动选另一个 Gemini 型号。

本轮拟设置 `thinkingLevel: off`，不另加推理预算，温度和 seed 留为未设置并记录实际出站字段。模型选择名仍保留 `-high`；本地 thinking 设置不保证代理上游关闭推理，不将其作为低成本保证。

## 3. 两个预登记任务

每个任务从 `fixtures/harness-novel` 单独复制一个新项目，使用新会话、新观察记录和独立工作目录，不复用 runtime 中的私人小说或此前的实机项目。源 fixture、复制初态和最终文件树分别做 SHA 清单。

### P5P-READ-001：实际读取 + 请求预算

- 允许模型调用 `read_story_document` 读取 `canon/world.md`，再调用 `get_context_budget`；禁止其他工具。
- 要求最后用简短 JSON 返回 `canPredictStorm: false`、`signers: ["记录员", "设备技师"]`。
- 诊断增量澄清提示词：只返回 JSON 对象，不用 Markdown 围栏或额外说明，签字数组按源文件的出现顺序排列。以上事实值仍只保留在验收端，不内联进模型提示；严格通过规则不变。
- 机械通过条件：确实发生成功工具调用、读取路径/哈希正确、预算有当前会话来源、最终结果字段符合固定合成事实、模型正常停止；项目文件字节无业务变更。
- 通常预计 2–3 次模型 HTTP 请求，**最多 4 次**。预测不是成功承诺。

### P5P-WRITE-001：单次受控写入 + 实际读回

- 写作职能通过可信会话自定义条目绑定，不依赖提示词授权。
- 只允许 `write` 创建不存在的 `drafts/candidates/pilot-probe.md`，内容为 `phase5-pilot: ready\n`，随后 `read` 同一文件。
- 路径必须既通过生产角色权限，又通过 pilot 的精确文件白名单；最多一次写派发，不允许 edit、bash、额外路径或外部副作用。
- 机械通过条件：写入和读回均真实发生且配对；最终文件字节与哈希完全匹配，写派发只有一次；其他业务文件未改动，模型正常停止。
- 若写结果未知，停止，不自动重试写入或从头重跑；先只读核查产物，仍不可判定则记录 `unknown`。
- 通常预计 3 次模型 HTTP 请求，**最多 4 次**。

两个任务均不要求 `COMPLETED_CANDIDATE`：没有章节验收，不能为了拿该状态伪造 verifier PASS。任务通过由独立机械检查得出；监管器状态原样分类记录。

会话、扩展诊断、检查点等预期基础设施写入须提前列为独立白名单，不能在文件核对时笼统忽略整个 `.novel`。评分所需预期值保留在 runner，禁止模型读取 `oracle.md`，不把答案内联为工具结果。

## 4. 历次最小 Pilot 使用的预算（不授予新调用权限）

| 资源 | 上限 |
| --- | ---: |
| 配置 × 任务 × 重复 | 1 × 2 × 1 |
| 并发 | 1 |
| 实际客户端 HTTP 派发 | 每任务 4 次，总共 8 次 |
| 每请求完整输入本地估算 | 32,768 estimated tokens，含 system、工具 schema、完整历史、工具结果和序列化开销 |
| 每请求最大输出参数 | 2,048 tokens |
| 每请求额外安全余量 | 4,096 estimated tokens |
| 单请求输入原始载荷 | 262,144 UTF-8 bytes；超限拒绝，不截断请求 |
| 批次累计输入预留 | 262,144 estimated tokens（8 × 32,768） |
| 批次累计输出预留 | 16,384 tokens（8 × 2,048） |
| 每任务工具派发 | 最多 2 次；各任务允许的两个工具分别最多 1 次 |
| 时间 | 每请求 90 秒、每任务 240 秒、批次 480 秒，取先到者停止 |
| 响应流大小 | 每请求 256 KiB；超限中止并记录，不能继续累积无界文本 |
| 自动压缩 / 手动模型摘要 / 自动命名 | 全部关闭或不加载，不为它们另发请求 |
| 自动重试 / prompt 重发 | 全部禁止；隐藏 HTTP 重试也不得到达代理 |

每次真正派发前原子扣除一次调用额度，同时预留该请求输入估算和完整输出额度；失败、超时、无 usage 或丢回执均不退还已派发额度。第 9 次请求必须在进入网络前拒绝。未派发预检和纯本地工具不算 HTTP 调用，但分别计数。

估算单位不是供应商实际 token；输出参数也只能约束发送请求，不能保证代理或上游一定遵守。代理内部重试/转发次数无法由客户端审计。若服务忽略限额、返回计量超界或发生未知出站行为，停止后续请求，不声称已撤销当前请求费用。

### 费用确认

本地未提供可核验代理价格，因此不承诺金额上限，也不使用官方某型号价格替代代理账单。

用户可明确接受以上 **8 次 HTTP / 输入输出额度上限且费用未知** 的试测；若要求硬金额上限，须先提供代理的真实费率、缓存/推理计费口径和服务端账户限额，再冻结金额预算。只有在 token 定义一致且价格已知时，粗略费用式才是 `0.262144 × 每百万输入价格 + 0.016384 × 每百万输出价格`；这不是当前的费用报价或保证。

## 5. 工装原设计（实际拓扑见第 8 节）

`eval:offline` / `eval:matrix` 禁止网络且只接收零模型调用，**不能直接打开网络拿它们跑真实模型**。下列保留最初工装设计；实际实现已将真实认证与出站迁至父进程 broker，不能把原先 worker 内认证/网络的设想当作当前拓扑。实现与验证以第 8 节、[工装说明](HARNESS_PHASE5_PILOT_TOOLING.md) 和各次结果为准；设计本身不是执行证据。正式对照需独立 task/profile 适配，不能放宽现有两任务 pilot 清单来代替。

1. 在专用 worker 启动前设隔离的 agentDir 和 cwd，使用仓库固定 SDK 加载由当前源码生成的小说扩展。ResourceLoader 禁止全局/项目 skills、AGENTS/CLAUDE、prompt templates、自动命名和第三方扩展；原始 system prompt、tool schema、角色绑定与生成扩展均冻结哈希。主进程只读投影已确认的单个模型定义（API、ID、兼容选项、容量等），注入隔离的 ModelRegistry，不默认加载用户全局 registry，不回退其他 provider。公共投影去除 key、headers、resolver 和端点并冻结哈希；端点只存在私有内存配置，认证独立处理。
2. `AuthStorage` 只在内存中放入选定 provider 的必要认证，设置只写隔离目录。不能执行会持久化用户全局设置的 RPC `set_auto_retry`。worker 启动前唯一指定 `PI_CODING_AGENT_DIR`，SDK 和扩展都从同一 agentDir/cwd 读取 settings；隔离 global/project settings 均显式设 `compaction.enabled=false`、`retry.enabled=false`，flush 后读回，并在离线测试中验证扩展实际行为。小说扩展自身会 `SettingsManager.create(ctx.cwd, getAgentDir())`，因此仅给 SDK 传入内存 settings 不够；主进程不改自己的环境变量，worker 结束即释放隔离环境。
3. 保留生产 context preflight 与工具权限钩子，再加 pilot 外层白名单和限额。使用仅驻留 worker 内存的模型副本，将 `maxTokens` 和每次 stream 选项均设为 2,048，避免扩展仍按 16,384 预留却实际发送另一上限；不写回全局 models.json。按最终兼容配置冻结唯一 wire 字段（`max_tokens` 或 `max_completion_tokens`）与值 2,048；两个同时出现、缺失、值不符或被兼容逻辑忽略均在发送前拒绝，不降级为无限输出。
4. **HTTP 传输层必须计数，而不是数用户提示或 assistant 消息。** 当前 SDK 的 OpenAI provider 没有覆盖客户端默认的 2 次 retry；关闭 Pi 自动重试仍不够。专用 worker 在 SDK 网络客户端初始化前安装单出站 gate：每次 provider stream/complete 调用分配独立 invocationId，用 AsyncLocalStorage 关联 fetch，在调用原始 fetch 前原子占用任务/批次 permit，核验预算、来源、目标、方法和正文摘要。同一 invocation 的第二次 fetch 无论正文是否相同均视为 retry 拒绝；新 invocation 才能占用下一 permit。不得以 body 相似度猜测请求身份，无法关联时 fail-closed；失败即终止，不消耗新的任务请求额度去偷偷重发。
5. 外层 gate 仅允许配置目标的模型 POST，禁止重定向和未登记网络通道。不能仅使用 `before_provider_request` 回调的抛错/late abort 作为硬门：生产扩展与旧 SDK 已记录其边界。具体 transport 实现先用本地假端点检验，不 patch node_modules，不改生产行为。
6. 所有同步/流式异常只保存安全 reason code；URL、认证 header、配置原文、凭据、完整请求/响应、推理内容不写公开产物。没有 blanket network forwarding，更没有读取私人会话的回退路径。

证据指针：`src/extensions/novel-tools-extension.ts` 的 `context` / `before_provider_request` / `tool_call`、`tests/harness/context-maintenance-extension.ts` 的真实 SDK 隔离加载、`node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js` 的 client/payload/usage 路径，以及 `node_modules/openai/client.mjs` 的 retry 默认值。本方案基于当前安装版本的代码，不外推所有未来 SDK。

## 6. Usage 与产物

- 必须把 provider 原始 usage 与 Pi 标准化 usage 分开。当前 Pi parser 会把缺失字段填零，并重算 reasoning/output/total；仅看 assistant usage 不足以证明供应商确实报告了这些值。
- 专用响应观察器只提取有界的 usage 数字白名单，流缺失该字段记 `null/unavailable`；不保存原始 SSE 内容，不将 cache 或 reasoning 额外相加后冒充原始总量。响应分流必须限制缓冲并背压，解析失败也不能回退成记录原文。
- 记录每次 HTTP 派发、结束/未知状态、request ID（若可安全提供）、模型选择名、预算快照与估算版本、max output、工具派发摘要、文件 SHA、provider usage 原字段和另列的 SDK usage。
- 若某次请求结束却缺失 usage，立即禁止后续模型请求和工具写入，只允许 runner 本地只读核查已经产生的文件并保留机械检查结果；pilot 的用量计量前置未通过，停止批次，不写“花费为 0”。
- 使用独立 `artifacts/harness/live-pilots/<unique-id>/`，执行前写不可变 manifest；请求结果与 run 结果分别独占写入，完成/中止后均封存索引。只从索引内且哈希匹配的记录重建；不覆盖任何既有 batch。
- manifest 冻结代码/dirty 清单、lock/SDK/provider 客户端版本、任务和 fixture、有效 model 参数、设置、工具/提示哈希、预算、停止策略和用户确认摘要。端点/认证不进入公开 manifest，进程内核对端点一致性。
- 外层测试数据/会话只在隔离位置保存并在报告列出；公开交付前做 secret/private-content 扫描。响应自由文本不作为公开 raw；只保存本任务需评分的有界字段、状态和哈希。

## 7. 停止条件

任何 401/403/429、5xx、连接失败、超时、用户取消、来源/配置漂移、缺失 usage、预算耗尽、未知写入、重复副作用、未授权工具/路径、输出越界或脱敏失败，均保留原因并停止批次。不会换 key/模型、增额、自动确认、修改 Canon 或重复执行已成功写入的任务。

只有该批两项任务都完成机械检查、usage 可归因、预算/文件清单正确且结果可只读重建，才报告“最小 pilot 通过”。未满足项为 fail/blocked/unknown，不把基础连通成功当全部通过，不把 pilot 拼入后续正式消融统计。

## 8. 执行门与后续

本节保留完整 live pilot 的执行门，不把离线工装等同于真实请求通过。新增 `eval:pilot:prepare` / `eval:pilot:live` / `eval:pilot:recover` 与不访问用户配置的 `eval:pilot:dry-run`。实现采用唯一父进程 broker 负责 HTTPS 或严格本机回环 HTTP、限额与 Journal，SDK 子进程只有脱敏模型副本及 IPC，没有真实 key/endpoint；这更新了第 5 节最初设想的 worker 内出站位置，其余安全边界不变。HTTP 只允许字面 `localhost`、`127.0.0.1`、`[::1]`，禁止域名/数字别名和重定向；`localhost` 固定解析到 `127.0.0.1`，无 DNS fallback，端口与路径也必须精确匹配冻结目标。

- [x] 本地非敏感模型元数据和固定 SDK 关键路径检查；未调用 API。
- [x] 任务、调用/资源预算、费用未知与证据边界写入本方案。
- [x] 实现独立 live 执行路径 / schema / usage 观察器 / transport gate / Journal，不修改离线 runner 的零模型约束。
- [x] 离线验证：请求上限、隐藏 retry、redirect、输出字段、超时/预留恢复、缺 usage、权限/路径、只读重建与同批重跑拒绝，以及本机 HTTP 白名单/地址固定。离线测试本身不访问用户配置。
- [x] 单独的零请求真实配置 prepare：批次 `live-CwHPbD`；模型配置前后 SHA 一致，仅生成 manifest，没有 claim/Journal，不解析认证凭据。
- [x] 用户已明确批准首批精确模型、两任务、8 次 HTTP 上限、费用未知；绑定 `live-CwHPbD` 的 manifest SHA，不沿用旧实机授权。
- [x] 获批后在 broker 私有内存中解析必要认证，未执行 shell resolver，未输出认证值；配置原文件 SHA 未变。
- [x] 仅执行该批一次，3 次请求后因最终答案检查失败停止，未改任务或规则、未消费剩余额度、未重试。代码/任务等变化必须另行冻结。
- [x] 首批调用、usage、失败和证据限制已写入结果文档；首批结束时 pilot 未通过，未进入正式重复试验。
- [x] 后续诊断增量：310 项离线检查通过，保留首批失败记录；新清单 `live-mHOnDl` 另获明确批准并执行，两任务 pass、真实请求 6/8、未知派发 0，文件/Journal/只读重建均通过。最小 pilot 已通过，正式消融仍未实施。

**新版最小 pilot 已通过并封存：`live-mHOnDl`，SHA `f131737c6669d12645e1936b39d75adf448c311316e00adb71b60afee381848d`。下一步建议整理冻结证据，再确定公平全栈对照方案和预算；任何新真实批次另行授权。旧失败批次不改判、不与新版拼接，不自动消费剩余额度。**
