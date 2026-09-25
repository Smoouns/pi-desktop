# E3：任务级请求计量

范围：管理扩展 v21；普通模型调用、Pi 原生压缩 / 分支摘要，以及同一客户端调用内部的再次发送，按项目 / 会话 / 职能 / taskId 归属。计量只读地观察模型流，不替换原生摘要、不修改生产重试策略、不授予写入或人工验收权限。

## 使用入口

- 运行中，`get_context_budget` 的 `taskTransport` 返回任务级快照；原有 `metrics` 仍是本进程当前 / 上一运行的读取及估算诊断，两者不能相加。
- 任务结束后可执行 `/novel-transport-status`，通过现有只读详情对话框查看。`/novel-transport-status json` 返回结构化诊断。命令不会调用模型、恢复任务、追加用户消息或改变验收。
- 原生运行需要重新启动以加载 v21 管理扩展。既有历史请求不会根据聊天消息补算；尚无明确任务的独立调用不冒充任务账。

## 三种不同计数

| 字段 | 含义及边界 |
| --- | --- |
| `ordinary` / `summary` / `branchSummary` | 已绑定的 provider 调用；一次调用可以发生多次客户端 fetch，也可能在发出前失败。被更早的 Context / payload 预检拒绝、尚未绑定的调用只记录在原运行预算诊断中。 |
| `fetchAttempts` / `dispatchAttempts` / `blockedBeforeDispatch` | 发送层尝试、已预记并交给 fetch 的尝试、发送前拒绝。预记不是服务器收到请求的证明。 |
| `redispatches` | 同一次 provider 调用内第 2 次及以后的 fetch 尝试。SDK agent 级重启调用仍算普通调用，不能可靠分类为 retry，故 `agentRetryClassification=unavailable`。 |
| `httpErrors` / `bodiesComplete` / `bodiesUnknown` | HTTP 错误响应、已完整消费的成功响应体、取消 / 中断等未完整消费的响应体。HTTP 错误体不计入已消费字节。 |
| `sdkUsage` | SDK 终态消息归一化后的用量；字段级记录已知小计及样本数。缺失 / 全零不算免费；未结、中断或缺失字段时总数为 null。 |

`httpRequests=null`、`taskTotalComplete=false` 始终保留。fetch 可能遇到底层重定向、网络中断或代理行为；不把它当作网络包数、服务器实收、计费次数或完整历史总账。`redirectedResponses` 只表示返回对象报告发生过重定向，不代表知道跳转次数。

当前发送层覆盖固定 Pi SDK 0.63.1 的 `openai-completions` 和 `google-generative-ai`：匹配所选模型 baseUrl 的 origin、POST 及对应 endpoint。其他 API、未接管的自定义 fetch / endpoint 用 `unsupportedCalls` 或 `missingFetchCalls` 表示覆盖缺口，不能补成零 HTTP。没有声称覆盖所有供应商。

## 发送前检查与流式行为

在异步调用作用域中显式绑定任务；压缩和分支摘要通过 SDK 提供的确切 AbortSignal 绑定。修改现有 provider 对象的 stream / streamSimple 包装，保留 registry identity 和 sourceId；同对象不重复包装，SDK 替换 registry 后重新接管。

支持的发送层在实际 fetch 前检查最终 JSON 字符串（包括客户端序列化后的变化）、已有上下文预算 / 输出预留 / 安全余量及取消状态。16 MiB 是额外的序列化资源上限，不是 token 上限。另一个 hook 在 payload 审计后膨胀输入也会被检查。

Pi 的 payload hook 可能吞掉扩展异常；Google 的晚到 abort 也不能单独证明零 HTTP。因此绑定计量记录失败时，当前发送作用域还会显式记下拒绝，不能以“未绑定”为由继续发出。没有放宽已有 Context / 来源版本 / 最终写入检查。

原始 assistant event stream 原样返回，只观察终态 promise。HTTP 响应体以背压逐块转交 SDK，不使用 tee、不攒满 SSE、不自行解析 token 字段。取消后未收到的 usage 保持未知。

## 持久化及恢复边界

实测发现，Pi `SessionManager._persist` 在第一条 assistant 消息出现前只缓冲自定义条目。因此仅 `pi.appendEntry` 不足以证明首次请求前记录已落盘。

新增会话目录下 `.pi-desktop-transport/<digest>.json`：key 由会话文件名和完整 owner 派生，数据只有标量计数、已知用量和有界未结 ID，不保存提示词、正文、响应、header、URL 或密钥。每次发送的记录先写旁路文件，再镜像到 Pi 自定义会话条目。独立文件每次最多 36,000 UTF-8 字节，最多 16 个未结调用、每调用 32 个未结 fetch。文件按用户创建的会话 / 任务增长，不自动淘汰旧任务账。

同步事务使用独占锁、已读版本比对、临时文件、文件 fsync 和 rename。路径目录、文件类型、链接及单文件大小均有检查。已有锁 / 临时文件、损坏记录、外部改写或缺失已镜像的旁路记录会拒绝继续发送，不静默回退旧成功或重置为零；不自动抢占 / 删除遗留锁。该机制不是对抗本机恶意进程的 OS 沙箱，也不保证所有文件系统的断电耐久性。

同一任务导航到旧分支时，已放弃分支的真实消耗仍计入账；新会话 / 新角色 / 新任务不借用该账。迟到旧作用域不能追加到新 owner。冷恢复时未结记录显示 `coldUnsettled`，后续新调用将它归为中断 / 未知，绝不重放模型请求。

第一条 assistant 前崩溃时，旁路计量仍可独立读取；如果 Pi 尚未创建会话文件，**不能据此宣称聊天内容或任务合同也可原生恢复**。复制 / 备份会话时应一并保留旁路目录；尚未开发账目修复 UI。

## 费用和后续边界

SDK 会把某些缺失 cache 字段归一化为 0，当前未直接核验供应商原始计费字段，故 `cacheBreakdownVerified=false`、`costUsd=null`，不套用参考价格猜费用。已知 SDK token 小计也不是 provider tokenizer 校准样本。

前置维护若发生在新任务合同正式准入前，归属于当时已生效的旧任务；无任务合同则不归账。本轮不把未准入提示词当成新授权，也不改变输入 / 自动压缩顺序。完整真实 usage 校准、自动压缩质量及任务相关进展仍是后续工作。

## 验收记录

- 定向入口：`npm run test:task-transport`。覆盖标量上限、调用与发送分层、未知 usage、跨 owner 迟到拒绝、旁路原子更新 / 冲突 / 损坏、第一条 assistant 前独立子进程读取及吞异常后的发送拒绝。
- 固定 SDK + 本机 HTTP：`npm run test:task-transport-sdk`。加载完整生产扩展和真实 OpenAI / Google 客户端；仅 SSE 内容和鉴权为公开合成 fixture，outlet 只允许当前 loopback origin，测试拒绝重定向到外网。每个入站 HTTP 在返回第一字节前核对磁盘上的发送预记，不能只看内存会话。
- 已通过报告 `artifacts/harness/task-transport/e3-xACstO/summary.json`：14 组、24 次本机 HTTP；两通道普通请求、压缩摘要、分支摘要、冷重载、late inflation / 摘要超限 / 损坏记录零新增 HTTP；另有客户端原生 500 重试、首段可见后取消、缺 usage 和失败摘要。`modelCalls=0`、`blockedExternal=0`、`serverFailures=0`。此处冷重载是同一 OS 进程内的新 SessionManager / 扩展，不冒充独立进程。
- 完整生产生命周期 `artifacts/harness/production-lifecycle/d-3vuewg/summary.json`：10 组 / 19 个独立进程通过。计量组额外核对普通 + 原生摘要统计在另一 PID 冷恢复时完全相同，只读查询没有 provider 调用。该套 provider 为合成、无 HTTP，不能替代上一项实际客户端 / loopback 验收。
- 本轮未调用真实模型、未控制桌面、未改真实小说或全局 Pi 配置。CI 已加入新增命令及报告上传，但本批尚未提交 / 推送，不能宣称远程 CI 或原生 UI 通过。

### 保留的失败证据

- `e3-hZE84R`：首次实测暴露 Pi 首条 assistant 前的会话写盘缓冲，以及测试误用停止后不允许执行的 `get_context_budget`。通过独立计量文件和只读状态命令解决，未放宽工具终态门禁。
- `e3-nnzhPw`：摘要超限工装误以为 turn-prefix 摘要会使用 customInstructions。核对固定 SDK 后，仅该测试选择 history-summary 路径，仍严格要求超限摘要零 HTTP。
- `e3-VsNIrq`：两条损坏记录的零 HTTP 断言已经通过，但工装读错 SDK 扩展错误的属性（`message` 而非 `error`）。改为严格核对 `{event, error}` 后两组通过，旧报告保留。
- `artifacts/harness/review-e3/harness-first-failure-329f3c970deb4bc296c1932dfc7a7012`：307 例 × 3 仅原有最终预算阶段诊断失败；计量存储检查抢先中断了没有会话文件的 hook 工装。将原 payload 预算检查放在绑定之前，保留阶段原因，并对真实发送作用域显式拒绝；没有修改原预算断言。另保留领域 smoke 的新命令清单缺项红灯，已补入明确新增的命令名称。

### 最终本地回归（2026-09-24）

- 定向 transport **10 项**、完整 Harness **307 例 × 3**，deterministic=true、失败 0。成功快照独立保存在 `artifacts/harness/review-e3/harness-passed-7faa69f05e4a4fb497ae37651d0b927e`，未覆盖失败报告。
- 应用 / 测试 TypeScript、小说领域 smoke、长程 **1 例 × 3** 和前端构建通过。预算阶段原断言未放宽；新增计量详情沿用只读弹层，只有关闭动作，Escape 不代表确认或验收。前端构建仍有既有大 bundle / 混合 import 提示。
- 14 组真实客户端 loopback 和 10 组 / 19 进程完整生命周期证据见上文。计量文件、合同、取消、来源版本及最终写入检查均在隔离合成副本测试。
- 当前 HEAD=`cbc5862dad7f302f647d96e5ed338abfd9f8d5ec` / dirty=true；源文件摘要在各份报告中独立记录。本地通过不等于真实模型质量、Windows 原生 UI、发布安装包或远程 CI 通过。本轮无新增 Rust 变更 / 验收，也未 commit / push。
