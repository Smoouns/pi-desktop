# Phase 0 验收清单：可复现基线与 Harness 测试底座

状态：**Phase 0 已实施并通过本地验证；提交后的干净检出、Linux/Windows 远端 CI 待验收，尚不标记阶段全部完成。**

2026-09-20 执行记录见 [HARNESS_PHASE0_RESULTS.md](HARNESS_PHASE0_RESULTS.md)：24 个合同/故障 case × 3 次确定性通过，五组公共回归通过，隔离未提交源码快照从零安装依赖后六项命令通过。以下保留原验收定义；未勾选的跨平台/提交相关总闸门不能由本地结果替代。

基线提交：`3b5f8b06131d46ee0b4b97dd646ba3d6f6bcd887`。

清单制定时只交付本文件；用户已另行授权开始 Phase 0，现已实施本阶段代码、fixture、测试与必要依赖。仍不执行自动提交/推送，不自动进入 Phase 1。

## 1. 依据与取舍

参考资料：仓库根目录的 `Pi Desktop Harness Codex Implementation Prompt.md`、`Prompt.md`、`deep-research-report.md`，以及当前 `docs/NOVEL_ARCHITECTURE.md`、`docs/NOVEL_MEMORY.md` 和源码。前者部分截断，研究报告使用 M0–M4 编号，补充大纲使用 Phase 0–5；本清单统一使用 **Phase 0**，不把不同编号直接视为同一工作范围。

资料是设计输入，不是已验证的接口或实现承诺：

- 采纳：文件权威性、来源版本、作用域隔离、确定性合同测试、故障注入、分层评测。
- 不照搬研究报告中的 `while (true) / pi.step()` 伪代码。当前 Pi 负责模型/工具循环；测试不得通过重新实现一个循环来宣称验证了真实 Pi。
- 不一次性创建 Observation、Checkpoint、Supervisor 等全部接口。只有本阶段真实调用的最小类型与 trace 可以进入生产源码。
- 报告中的外部项目维护状态、许可证、接口和工期未经本轮独立复核；报告含无法在本仓库直接解析的 `filecite/cite` 引用。不得将这些引用当作可追溯的源码证据或据此复制代码。后续需要复用时另核对固定版本、原始来源及许可证。
- 不把模拟器中的通过率、字符数或事件数表述为真实模型成功率、真实 token 节省或生产可靠性。

## 2. 范围与改动边界

### 本阶段必须交付

- [x] 完全原创、可公开的 `fixtures/harness-novel/`。
- [x] 最小 `src/harness/types.ts`、`src/harness/trace.ts`，有实际测试消费者。
- [x] 公共确定性测试入口、现有相关 smoke 的公共化迁移、故障注入 adapter。
- [x] serializer → extension、版本失效、权限/路径、RPC 消息代际、verifier 和现有预算行为的合同测试。
- [x] 经失败测试证明后的最小合同/安全缺陷修复。
- [x] 无私人数据、无真实模型、无需桌面人工操作的 CI 配置；远端运行仍待验收。
- [x] 可复现基线结果、限制清单、Phase 0 验收报告。

### 明确不做

- 自动重试/模型修参策略、operation ledger、未知写入结果自动恢复。
- Observation Store、聚合模型输入预算、required 文件读取强制门禁。
- Checkpoint、压缩摘要失效传播、断点自动恢复、RunSupervisor。
- 新的角色知情推理、完整故事时间模型、别名检索算法、向量库、embedding 或 reranker。
- 自动 world → plan → write 编排、第四个独立 review Agent、Pi agent loop 重写。
- 新 UI、桌面自动点击、真实模型/API 评测、原生 Tauri 文件集成验收。

现有小说语义仍由 `src/novel/` 负责；`src/extensions/` 是 Pi 适配层；`src/rpc/` 是传输/运行实例桥接。不得为创建 `src/harness/` 大规模迁移现有代码。

### 缺陷处理原则

1. **现有行为基线**：准确记录，不在 Phase 0 顺便升级。例如选择预算是软预算、缺 generation 的旧事件兼容行为。
2. **合同缺陷**：先用真实生产输出触发失败，再做最小修复。例如 serializer 与 parser 的格式不一致。
3. **安全底线**：越界读取、越权写入或跨项目资料泄漏不能通过修改预期、静默 skip 或永久 xfail 获得绿色验收。能复用现有路径检查做局部修复时处理；若需要超出本阶段的设计，记录阻塞并向用户确认范围，Phase 0 不标记完成。
4. **后续能力**：尚不存在的自动恢复、语义知情边界等只记录限制与后续测试建议，不虚构当前通过证据。

## 3. G0：固定基线与可复现环境

- [x] 记录基线提交、实现提交/工作树差异、Node/npm、操作系统、锁文件摘要、测试使用的 Pi SDK 和构建器版本。
- [x] 列出已有测试 → 新公共入口的映射，保留原有断言意图；私人样本回归可作为额外本地测试，但不能是公共测试的前置条件。
- [x] 记录当前 CI 为 Ubuntu + Node 22，部分 smoke 包装器依赖 `powershell`、`.cmd`、`$env:TEMP`；公共入口不依赖这些 Windows 专用写法。
- [x] 检查直接导入的 Pi loader、构建器等能否由 `npm ci` 稳定解析。不得依赖全局 Pi、旧 `node_modules`、用户目录扩展或隐式下载的 `npx --yes` 工具；若需显式测试依赖，限定为本阶段必要项并同步锁文件。
- [x] 从原始基线获得 B0-raw 结果；局部修复后单独记录 B0-fixed。原始失败证据保留，不能用修复后的数字替代原始基线。

“B0-raw”可由测试驱动调用原始提交的生产模块获得。新增 trace 可以由测试驱动记录，不要求旧提交原本就有 harness；驱动和适配差异必须注明，不伪称旧提交具有新 API。

## 4. G1：公开合成 fixture

使用一个小型原创故事，例如“潮汐观测站”。人物“林岚”和“林澜”具有不同身份；某份密钥只被其中一人知晓。人物、秘密、规则、正文和目录内容不得从私人小说复制、改名或抽样得到。

| 组成 | 必须具备的证据 |
| --- | --- |
| `.novel/project.json` | formatVersion、明确布局、Canon/候选映射、current-state/ledger 路径；无本机绝对路径 |
| Canon 世界规则、两个人物档案 | 至少一条可精确匹配规则；相似名称但事实不同；明确一条秘密及知情边界 |
| chapter architecture + 章节卡 | 同一 fenced YAML 合同、章节/输出路径/场景/字数一致，足以让真实 TS verifier 执行 |
| 正典正文 | 与故事时间及状态记录一致，作为稳定读取来源 |
| 已验收但未晋升的候选正文 | 与章节卡及 `.novel/acceptances/` 指纹记录匹配；与 Canon 身份区分 |
| 未验收候选正文、原始连续性提案 | 含便于断言的独有内容，不得自动进入事实检索来源 |
| current-state / ledger | 至少两个明确章节的状态以及一段未标注章节的当前状态 |
| future/planned 信息 | 显式未来标题及较晚章节，支持当前机械筛选规则；不据此宣称自然语言时间推理 |
| fixture README / oracle | 原创来源声明、人物身份/知情与时间预期、测试用途及字节/换行约定 |

- [ ] fixture 由 Git 跟踪，敏感私有样本的忽略规则不改变；无个人路径、凭据、真实聊天、私有正文。
- [x] 固定 UTF-8/LF 策略；验收指纹依据实际读到的文本验证，不因 Windows 自动换行造成无解释失败。测试要另覆盖 CRLF 输入兼容性。
- [x] 项目 A/B 从该 fixture 创建到各自临时根目录；相同相对路径保留，但注入不同内容标记，以检测串用。
- [x] 磁盘变更只发生在独立临时副本。每个 case 前后校验仓库 fixture 清单/哈希不变；禁止覆写项目根、真实小说目录或用户 `.pi` 配置。
- [x] 秘密/知情的 oracle 仅供测试与后续评测，不能直接把预期答案送给被测检索器。

## 5. G2：最小作用域与 Trace

`RunScope` 最小字段为 `projectId / sessionId / runId / generation / role`。具体类型由实现决定，但必须遵守：

- `generation` 表示已有运行实例的代际，不自动等同于任务内 attempt；先映射当前 bridge 语义，不另造竞争状态源。
- `runId` 是逻辑任务标识，不使用 RPC request ID 冒充；Phase 0 只供测试关联，不接管生产任务调度。
- `role` 在通用 harness 中不固化为小说枚举；领域适配复用现有 world/plan/write。review 兼容模式保留，但不新增独立角色会话。
- 项目 ID 的产生规则须记录；测试使用固定可注入值，不因本阶段要求给真实项目增写新元数据。

Trace 至少包括 schemaVersion、caseId、scope、递增序号、event 类型和结构化结果摘要。时间/ID 源可注入；trace 不是 durable operation ledger，也不是模型已阅读证据的证明。

- [x] 同一输入与故障安排运行三次，语义结果和规范化 trace 一致。
- [x] 规范化仅处理墙钟时间、临时根等非语义差异，不能删除 generation、来源指纹、操作次数或事件顺序来掩盖不一致。
- [x] 记录被丢弃的迟到事件及原因，但不把它交给活动会话消费者。
- [x] 默认仅记录相对来源、版本摘要、结果码与计数；不存整篇正文、密钥、完整请求参数或原始环境变量。
- [x] trace 和测试产物有独立输出目录、清理策略和忽略规则；CI 仅上传合成数据产生的有限大小产物。
- [x] 不创建没有调用者的未来 store/policy/supervisor 接口。

## 6. G3：合同测试矩阵

以下是实施后的通过条件，**不是当前已通过的声明**。一行允许多个测试；报告逐 ID 给出结果，不以测试数量代替断言覆盖。

| ID | 输入/操作 | 通过条件与证据 |
| --- | --- | --- |
| CTX-01 | 真实 `buildNovelContext` → `serializeNovelContextManifest` → 会话封装 → 实际 Pi extension context hook | 保留选择元数据及 required/on-demand；正文未内联；模型侧只有最近一份索引；UI 显示映射不展示自动块；字符串与文本块消息均覆盖 |
| CTX-02 | 将 CTX-01 的真实文本交给 `get_current_document` | 正确返回活动文件；无索引、无活动文件、只有记忆引用时不错误猜测“当前文件”；说明前言、LF/CRLF、旧格式均有明确兼容规则。不能只用手写无前言消息测试 |
| CTX-03 | 同一会话普通追问、显式更新选择后的消息序列 | 普通追问不新增索引块；更新后仅最新块进入模型消息；历史工具正文不会因此被假装清除。若仅测消息序列而未驱动发送条件，必须注明并补测最小发送决策入口 |
| CTX-04 | 固定估算值的候选集合，含重复路径、排除项、超预算首项和固定项 | 按现有优先级、去重、authority 排除规则选择；首项/固定项可超软预算的行为明确断言。记录列表、估算总量、实际 manifest 字符数，绝不称为完整模型输入硬限额 |
| MEM-01 | 检索并读取 ID，然后原位修改、删除来源 | 旧 ID 无法读取，重检仅返回当前有效内容；删除不会回退到缓存旧文 |
| MEM-02 | 正文不变，删除正文验收记录；另分别修改正文/章节卡导致指纹不匹配 | 已验收候选不再作为 approved 来源；旧 ID 被拒绝。保留未变正文哈希以证明不是单纯文本更新测试 |
| MEM-03 | 不改正文，改变 authority 配置；以及精确恢复旧源文 | 查询资格服从当前配置；若来源不再合格，旧 ID 不得读取。精确恢复且依赖仍有效时允许恢复原来源 ID，不强制每次观察生成新 ID |
| MEM-04 | includePlanned 开/关、throughChapter 边界、无章节 current-state | 按现有规则过滤未来标题、晚章正文/连续性和无时间记录；Canon 世界设定不自动等于角色知情，不宣称已完成角色知识过滤 |
| MEM-05 | 同名文件分置 A/B；相似人名、相同路径不同内容 | A 的 ID 在 B 读取失败，返回路径/内容属于 B；相似名字 fixture/oracle 不混淆。词法召回不足记录为基线，不凭空实现语义消歧 |
| TOOL-01 | 实际 Pi loader 加载 managed extension，枚举并调用小说工具 | 扩展可发现、加载无错误；各工具的实际 result 形状被记录，不假定文本 Error 已是 typed error。至少一组测试覆盖压缩构建后的扩展字符串独立加载与记忆工具调用 |
| TOOL-02 | 正常文件读取、memory ID 失效、缺失路径、非法参数 | 返回值/异常可断言、调用可结束；错误不能被测试 adapter 当成成功空结果。记录现有 error flag 差异，统一分类策略留给 Phase 1 |
| SEC-01 | world/plan/write、review 兼容模式、未绑定角色，调用 write/edit 与 bash | 允许路径可通行；拒绝路径在底层副作用前被阻止；受保护 Canon/manuscript/.novel 及跨角色路径拒绝，写入计数为 0。不能只检查错误字符串 |
| SEC-02 | `../`、绝对外部路径、混合分隔符、前缀相似目录、Windows drive/UNC/ADS 特有形式 | 每个小说限制入口按其契约拒绝逃逸；合法项目内路径仍可用；不读取外部 sentinel 内容，不执行越界写入 |
| SEC-03 | 项目内文件/目录 symlink 指向临时根外的 sentinel；Windows 支持时含 junction | 记忆 IO、普通小说读取和受限 write/edit hook 均在访问/副作用前拒绝。Linux 必须真实创建链接测试；Windows 权限不足只允许将特定 OS 集成子用例标为 unsupported，通用 adapter 合同仍必跑；不得把 unsupported 计为 PASS |
| RPC-01 | 当前 generation N+1，注入 N 的 stdout/closed/stderr；另注入其他 instance | 旧代/其他实例的消息不进入当前消费者、不清除新请求、不关闭新实例；通过真实 bridge 的 mock transport 或最小生产共用过滤函数测试，不能复制一份算法自测 |
| RPC-02 | pendingGeneration 切换、缺 generation 的兼容消息、超时后响应 | 冻结并解释当前行为；至少覆盖 start 前后与重复/迟到响应。缺 generation 的 legacy 放行不宣称严格隔离；超时后未匹配 response 的行为如实记录，不顺便实现 operation recovery |
| VFY-01 | 合成 fixture 的完整合法章节，执行实际 TS verifier | 退出码 0、明确 PASS、报告章节与 source_text 对应；全套流程不需要模型输出 |
| VFY-02 | 分别破坏前置合同及正文约束 | 合同失败有 CONTRACT 证据；正文违规得到 FAIL/非零退出码与对应代码；原 fixture 不变；PASS 不创建验收或晋升记录 |
| REG-01 | 迁移现有 domain、verifier、extension、memory、世界观回滚 smoke | 原断言意图保留；包括现有 12 个世界观写入故障场景（6 个部分写入）；不靠删除断言获得公共化通过 |

补充约束：

- CTX-02 的静态不一致已发现：serializer 有说明前言，现有 parser 紧接标记匹配 `###`。实施时仍先取得真实失败结果再认定修复效果。
- 对“没有 active document”的处理不能简单取索引第一项充当当前文件；如需最小标记或解析调整，说明新旧格式兼容性。
- SEC-01/03 的 hook 拦截证明仅覆盖当前接入的工具入口，不宣称已沙箱化任意第三方扩展或外部进程。
- OS 路径分支用对应平台测试；模拟 `C:/...` 字符串不等于完成 Windows 文件系统安全验收。
- 安全路径局部修复不等于 Phase 1 的完整统一 ToolPolicy，更不承诺抵御多进程竞态或所有 TOCTOU 情形。

## 7. G4：故障注入入口

最小 adapter 只包裹真正被测的 IO/transport/verifier 边界，故障按调用序号触发，禁止随机 sleep 决定成败。类型只定义当前执行的故障；后续扩展点写在文档，不创建空实现。

本阶段必跑四类：

| ID | 故障安排 | 验收断言 |
| --- | --- | --- |
| FI-01 | 指定读取第一次抛错，第二次恢复 | 两次调用按脚本显式触发；失败路径不伪造有效旧内容，第二次读到当前文本；调用次数与失败 trace 一致。**不声称已有自动 retry** |
| FI-02 | 检索后、按 ID 读取前改变来源 | 旧 ID 被拒绝；再次显式检索返回新版本，结果同 MEM-01 |
| FI-03 | 在 N+1 活动后投递 N 的迟到事件 | 丢弃记录、消费者调用数和当前状态均可断言，结果同 RPC-01 |
| FI-04 | 修改临时正文使 verifier 稳定失败 | 捕获实际进程退出码/报告；不创建验收或晋升；结果同 VFY-02 |

后续可在相同 adapter seam 扩展 permanent invalid input、commit-then-drop-response、cancellation 等场景。Phase 0 可记录永久非法参数现状，但不实现修参策略；不要求写入对账或真实 verifier 子进程取消行为已经完成。

## 8. G5：公共入口与 CI

计划提供以下命令语义；名称可在实现时小幅调整，但文档、package scripts 和 CI 必须一致：

```text
npm ci
npm run check
npm run check:harness-tests
npm run test:harness
npm run test:novel-domain
npm run build:frontend
```

- [x] `test:harness` 执行本清单新合同与 fault cases；公共 `test:novel-domain` 不再默认依赖私人 fixture。若保留私人集成回归，用单独显式入口，不在 CI 静默降级。
- [x] 当前 tsconfig 只包含 `src`；新增测试代码须有独立类型检查或等效检查，不能仅通过 strip-types/bundle 就宣称测试代码 typecheck 通过。
- [x] 公共 Node runner 不依赖 PowerShell、`.cmd` 或固定临时文件名；构建器使用锁定本地依赖。
- [x] 无真实模型、外部模型 endpoint、API key、全局 Pi 配置和已登录账号；Pi loader 测试只使用临时项目与 stub context，不启动真实 provider。
- [x] 安装依赖允许正常访问包源；**安装后的确定性测试**不需要网络。不得把 `npm ci` 也描述为完全离线。
- [ ] 至少覆盖 Linux/Node 22 与 Windows/Node 24 两个 CI 组合，记录具体版本。保留现有 Rust/Tauri 编译检查；公共 harness 测试本身不需要桌面窗口或 Tauri 运行实例。
- [ ] Linux 真 symlink 测试是必需项；Windows 平台不支持项逐项报告原因，不允许整个安全测试组 skip。
- [x] 任一必需断言失败，命令返回非零且 CI 失败；无 `continue-on-error`、无只打印错误后返回成功的包装器。
- [ ] 干净检出/隔离克隆只使用 Git 已跟踪内容运行全部公共入口，证明没有从原工作区偷读被忽略样本、缓存或未跟踪文件。
- [ ] CI 配置已修改不等于 CI 已通过：验收报告附执行日志/实际 run 证据。未经用户授权，不为验收自行推送；缺远端验证时标注“待 CI”，不得宣称阶段全部通过。

## 9. 基线指标与证据格式

每次报告至少保存：

- baseline/implementation commit、dirty 状态、fixture 清单摘要、Node/npm/OS/Pi SDK 版本。
- 各 case 的 ID、输入配置、预期、actual、pass/fail/unsupported、失败断言及关联 trace 路径。
- 检索命中来源、有效来源数、旧 ID 拒绝结果、越界访问/副作用计数、迟到事件消费者计数、verifier 状态和退出码。
- context 所选文件顺序、估算阅读 token 总量、manifest 字符数；未知的实际模型 token/成本明确为 N/A，不填 0。
- 故障触发次数、实际 IO/工具调用次数；显式脚本第二次调用与系统自动 retry 区分。
- 三次重复执行的语义结果/规范化 trace 比较；耗时作为环境相关观测，不设脆弱的绝对速度门槛。

固定合成样本的命中断言仅说明该样本行为；不使用其直接推出通用 Recall、角色知情准确率或真实写作成功率。完整长程 24 场景及真实模型消融属于后续阶段，不纳入 Phase 0 完成率分母。

## 10. 完成闸门与后续提案

只有以下全部满足，才标记 Phase 0 完成：

- [ ] G0–G5 所有必需项有证据，测试矩阵无未解决的必需失败；unsupported 项符合已声明的平台边界。
- [ ] typecheck（含测试）、相关现有公共回归、新 baseline suite、frontend build 均通过；公共 CI 与干净检出验证完成。
- [ ] 每个修复都有 B0-raw 失败 → 最小改动 → B0-fixed 通过的证据；没有为了“baseline”接受安全漏洞。
- [x] 无私人文件进入版本控制、CI 日志或上传产物；无真实项目结构/内容变化。
- [x] 没有提前实现 Phase 1–5，也没有改变人工验收、Canon 晋升和回滚的授权边界。
- [x] 交付 `docs/HARNESS_PHASE0_RESULTS.md`，包含修改文件、新增测试、原有合同缺陷、基线指标、限制、未完成的原生 UI/Tauri 验收项和下一阶段提案。

Phase 1 提案必须回答但本阶段不实现：

1. 哪一层负责 provider retry、工具重试、修参以及取消，如何避免与 Pi 叠加。
2. runtime generation / run / attempt / operation 的关系及现有事件中的可观测信息。
3. 哪些受控写入可以记录意图与对账；哪些结果仍必须标为 unknown，而不是凭当前哈希宣称恰好执行一次。
4. source、验收、配置、story-time/knowledge scope 的依赖如何表达；未来摘要失效如何处理。
5. 后续 storage/trace 的本地隐私、容量、清理和引用生命周期。

阶段完成报告仅提出下一步。**启动 Phase 1 需要用户另行确认。**
