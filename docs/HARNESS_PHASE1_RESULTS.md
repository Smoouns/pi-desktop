# Phase 1 本地实施与验收报告

日期：2026-09-20；真实运行补测：2026-09-21。

状态：Phase 1 本地实现与自动化验收完成。2026-09-21 使用 `gemini-proxy/gemini-3.8-flash-high` 补测，真实 Pi RPC 读取、连续写入/修参、机械验证、工具间取消和新会话恢复已通过（4 条测试提示、15 次工具调用）；随后原生 Desktop/Rust 路径的发送、工具展示、文本流、主动停止、运行中项目/会话切换与新会话恢复冒烟也通过（另外 4 条提示、9 次只读工具调用）。提交后的干净检出与远端 CI 仍待验证，不据此宣布完整发布验收。前期阻塞、实机观察与证据限制见 [实机冒烟记录](HARNESS_PHASE1_LIVE_SMOKE.md)。

依据：[HARNESS_PHASE1_ACCEPTANCE.md](HARNESS_PHASE1_ACCEPTANCE.md)。以下为本地实现及自动化测试记录：自动化不启动真实模型请求或修改私人小说。随后用户授权的真实请求及阻塞单独记录在实机冒烟报告中，不混入自动化结果。2026-09-21 用户进一步授权修复两项实机观察并提交、推送；本文先记录提交前证据，不将授权等同于推送成功。

## 1. 实现范围

### 工具结果与恢复策略

`src/harness/tool-policy.ts` 提供 `ToolResult<T>`、九种错误分类和有界策略：

| 类别 | 当前处理 |
| --- | --- |
| transient | 明确只读操作最多自动重试 2 次，默认退避 100/200 ms；总 deadline 不重置 |
| invalid_input / validation | 必须修正输入/内容；不重复原样执行；策略支持有界修参回调 |
| stale_source | 要求重新检索来源；策略不允许用相同参数刷新后重试 |
| permission / precondition | 阻塞并报告权限或前置条件 |
| cancelled / fatal | 停止 |
| unknown_outcome | 先核对目标状态，不盲目重放写入 |

非有限 deadline 在派发前拒绝；派发后的副作用取消或超时按结果未知处理。自动修参/来源刷新回调是通用策略的能力，当前小说适配器不自动编造修正参数或重检来源，而是向 Agent 返回明确的恢复要求。

Pi 继续负责 provider retry、Agent loop、模型上下文压缩及会话存储。Harness 不重发用户 prompt，不增加模型级重试循环。

### 接入真实小说扩展

`src/extensions/novel-tools-extension.ts` 中的小说工具已使用统一包装器：读取 deadline 为 30 秒，verifier 为 120 秒。保留原工具名、参数和正常可读输出。

兼容性审查发现：锁定的 Pi 0.63.1 不把 `execute()` 返回对象中的 `isError` 当作核心错误。因此自定义工具失败现在抛出异常，文本附带 `<tool-error>` 结构化信封，宿主本地异常保留 `toolResult`；成功结果仍使用 `details.harness`。测试通过真实 Pi core 的工具执行循环验证失败标记，而不只检查返回对象。

内置 `write/edit` 仍由 Pi 原实现执行，扩展只做调用前检查和结果后核对。Pi 对原生失败结果不采纳 `tool_result` 补丁，因此账本会记录已确认失败，但不声称把原生失败完全改写成新的结构化格式。

### 作用域与取消

- 项目 ID 来自规范项目根路径的 SHA-256；Windows 路径大小写归一化。
- 会话 ID 优先使用 Pi `sessionManager.getSessionId()`；旧环境缺失时使用扩展进程级 fallback，不伪称持久会话 ID。
- 每次 Agent 运行有独立 `runId` 和扩展生命周期 epoch。
- session switch/shutdown、运行结束及新运行会失效旧 scope，迟到结果不能被当作新 scope 的成功。
- RPC generation 是 Rust 进程代际，和扩展 epoch 分开管理；目前没有贯通所有 UI 流事件的统一 run ID。

verifier 接收 AbortSignal，取消后等待真实子进程 `close`，测试检查 PID 已不存在。因 verifier 可写验证报告，派发后被打断时保留 `unknown_outcome`，不能断言报告没有变动。机械通过仍不等于人工验收。

### 写入台账与结果核对

`src/harness/operation-ledger.ts` 保存 scope、operationId、参数摘要、目标及前后指纹，不存正文。operationId 关联 Pi toolCallId，也检测同 scope/目标下使用新工具 ID 的重放。

关键演示已接入锁定 SDK 的 `createWriteTool`：

1. 调用前记录写入意图。
2. 原生工具确实写入临时项目文件。
3. 测试故意不投递结果回调。
4. 新工具 ID 再次请求相同写入。
5. 读取现有文件 SHA，与预期 SHA 相同，返回目标已满足并阻止再次写入。

同一文件的正常 write → edit → edit 也使用真实 SDK 验证。原生 edit 明确失败且文件未变时，相同参数被阻止，修正参数后可继续。Windows 文件名大小写别名不能绕开目标核对。

只有可精确预测的单一 LF 文本 edit 预计算结果；涉及 fuzzy/EOL/BOM 等转换时依赖成功结果后的实际指纹。丢失结果又不能预测最终指纹时保持阻塞，不猜测。台账上限 2048 项，不自动驱逐旧 operation ID 使其能被重放；满容量时保守拒绝新写入。

### 路径与角色边界

新增 `src/novel/tool-path-policy.ts`，共享标准相对路径与角色许可规则，精确文件授权不再作为任意前缀放行。普通小说读取、memory、内置文件工具和受控写入检查项目边界及链接路径段；角色权限、Canon/人工验收权限保持不变。

独立可复制的 verifier 脚本保留自包含路径检查，不依赖仓库外部模块；新增合同、正文、报告目录的链接防护测试。路径检查不等于 OS 沙箱，不能防御任意第三方扩展、恶意项目脚本、硬链接、跨进程文件替换或完整 TOCTOU 攻击。

### RPC

`src/rpc/bridge.ts` 对请求增加取消/相对 deadline，清理重启、停止、会话切换后的 pending。超时后迟到 response 只产生诊断，不再进入普通事件；已完成带 generation 握手的连接拒绝无 generation 事件。

变更命令一旦派发，断连、取消、发送失败或超时均返回 `unknown_outcome`；只读请求按情况返回 `cancelled/transient`。桥接层没有自动重发 RPC。显式 `success:false` 不再被 prompt 静默当成成功。

Rust 将 generation 计数独立于 live process map，停止后重启不会复用旧 ID。并发启动使用前端 ticket 与 Rust generation 复核，旧启动不能覆盖新实例。启动登记、停止旧句柄和最终插入使用一致的锁顺序；stop/stopAll 会失效尚未插入句柄的启动，被失效的子进程会被终止并回收。停止不额外消耗 generation，保留下次启动的计数约定。

## 2. 证据

| 项目 | 本地结果 |
| --- | --- |
| Phase 1 起点 | `314120c2b3c9eb9d373b4c1b9a5942f4dbf45edf` |
| 原始 B0 | `3b5f8b06131d46ee0b4b97dd646ba3d6f6bcd887` |
| 环境 | Windows x64，Node v24.19.0，npm 11.17.0，Pi SDK 0.63.1 |
| 初始 Phase 1 Harness | 81 项 × 3 轮，全通过、确定性一致、无 unsupported 子项；后续修复回归见第 4 节 |
| 公共领域回归 | domain、extension、verifier、world-change、memory 五组通过；原 12 项写失败测试（含 6 项部分写入）保留 |
| 检查与构建 | 生产及测试 TypeScript、frontend build、Cargo check 通过 |
| Rust 回归 | 4 项通过：generation 不复用、stop-before-insert、scoped stop、session 文件头非破坏性检查 |
| B0 探针 | 原始版本的 manifest、链接逃逸、损坏 metadata 三个问题可复现；当前版本阻止 |
| 隔离依赖安装 | 本地临时源码快照中重新 npm ci，随后五项检查/测试/构建通过 |
| 模型 API / 真实输入 token | 0 次 / 未测量 |

测试新增的重点入口：`tests/harness/tool-policy.ts`、`operations.ts`、`tool-path-policy.ts`、`extension-runtime.ts`、`builtin-writes.ts`、`rpc.ts`、`verifier.ts`、`workflow-ui.ts`、`session-restore.ts`。

真实 Pi loader、minified 独立扩展、真实内置 write/edit、真实 verifier 子进程已测试。RPC transport 仍使用测试适配器，真实 Pi core 测试使用脚本化模型响应；这些都不等于真实桌面或 provider API 端到端测试。

产物位于被忽略的 `artifacts/harness/`：`summary.json`、三轮 trace、`regression.json`、B0 探针、`isolated-summary.json` 和安装/构建日志。summary 保存锁文件、fixture 及实现逐文件指纹。合成 fixture 每项测试前后校验，不依赖私人小说。

上述隔离结果是最初 81 项用例对应的未提交候选源码白名单快照，不是提交后的干净检出，也不是远端 CI。新增 Rust 回归已接入 CI 配置，远端执行仍待本轮提交/推送后验证。

Vite 保留动态/静态导入混用及大 chunk 告警；Rust 保留已有未使用变量告警。没有借此升级依赖或改造打包。

## 3. 明确限制与使用说明

- 写入台账只在同一扩展进程内有效，不能在进程崩溃/重启后恢复，也不能证明 exactly-once。目标指纹相同只证明当前内容满足意图，不证明唯一写入者。
- 账本不是持久事务日志，不能将未知写操作自动标成人工验收或 Canon 晋升。
- RPC bridge 隔离实例和传输进程 generation；同一 Pi 进程的普通流事件没有 run ID，因此不声称已完整消除跨逻辑运行的 UI 流事件竞态。
- 本次不实施 Observation Store、真正的上下文硬预算、Checkpoint、Supervisor、向量检索或自动三 Agent 调度。
- 既有 runtime 项目里的 `.novel/tools/verify-novel-chapter.ts` 是独立副本，本次没有覆盖私人项目脚本。要测试本轮 verifier 路径加固，需要在复制项目中同步新版脚本；不要误把旧副本当作新版验证器。
- 启动新版桌面时，现有安装流程会同步带管理标记的小说扩展；已运行的 Pi 会话需重新启动才能加载新扩展。用户自行维护的同名扩展不会被覆盖。

RPC 补测已覆盖复制 runtime 项目的读取、连续受控 write/edit、机械验证、工具间停止与新会话恢复，且人工验收/Canon 未变。随后独立的原生 Desktop 补测补齐上述有限 UI 场景：A 生成时切到 B，B 对话保持独立；同项目新会话保持空白；返回旧 A 点击停止后日志为 `aborted`，新会话可继续读取与检索。A/B 及公开 fixture 在本轮 UI 测试前后逐文件 SHA-256 完全一致。这不是写入/verifier 执行中停止、所有竞态或代理上游模型身份的证明。

实机另观察到完成面板残留“正在思考…”静态标签，以及 B 会话文件名 ID 与内部 session ID 不同；当时工具 scope 与实际 JSONL header 一致。这两项已按后续授权修复，根因与修复验证见下节；原始实机观察仍保留。恢复请求的最终两句将“能力边界”理解为系统权限，不能计作小说设定语义回答通过。

## 4. 实机观察后的修复（2026-09-21）

- 思考状态：工作流与独立思考块共用明确的运行状态映射；仅在思考流仍活动时显示“正在思考…”，完成或已转入工具运行时显示“思考过程”。直接渲染中文 UI 标签，避免受保护的消息区域绕过全局汉化；不删除思考内容或改变展开能力。
- 会话身份：定位到可复现机制：Pi 为尚无 assistant 消息的会话预留路径但不落盘，将该缺失路径传入 `switch_session` 会产生新 header ID、却沿用旧路径。这与 B 的记录时序一致，不视为证明历史异常的唯一原因。Desktop 现在先由 Rust 只读检查文件头；只有明确空白的临时标签可以新建，历史缺失、空文件、损坏文件及未知结果都不会自动新建或重放变更。
- 恢复校验：重新启动 runtime 后必须重新检查目标路径；恢复后核对实际 session ID。已有文件名与 header 不同的历史仍按 header 读取，原文件名和内容都不改写。身份检查与停止操作按进程 generation 绑定，旧恢复操作不能停止或接管新一代实例。
- 验证边界：`tests/harness/workflow-ui.ts` 调用实际 Lit 工作流渲染器；`session-restore.ts` 接入生产 bridge、恢复策略及锁定 Pi SDK 的真实会话持久化。Tauri 调用用测试适配器替代，文件头检查另有 Rust 单元测试，因此这些不是新的原生 Desktop 冒烟。

最终候选自动化结果：Harness **91 项 × 3 轮，共 273/273 通过**，`deterministic=true`、`failures=false`；生产与测试 TypeScript 检查通过。Rust `cargo test --lib` **4/4 通过**；五组公开领域回归、B0 对照探针、前端构建通过。新增会话回归还精确覆盖 missing 异常产生后换代，以及 scoped stop 请求未返回时重启，不仅覆盖初次检查阶段。

本轮没有新增模型请求、修改私人小说或历史会话日志。新增 Rust 命令需要重新启动新版 Desktop。提交后的干净检出与远端 Windows/Linux CI 仍按真实结果补证；后续 Phase 2 才处理 Observation Store 与真实上下文预算，另行确认范围。
