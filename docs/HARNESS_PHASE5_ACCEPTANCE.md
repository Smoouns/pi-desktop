# Phase 5 — Eval / Ablation / Portfolio Packaging 验收清单

本文件定义 Phase 5 的执行与验收边界。**截至 2026-09-23，已实现离线模块矩阵、合成长程任务与独立真实 pilot 工装；新版最小真实 pilot 的两项任务通过，同 SDK 读写切片已完成限定离线与首批真实运行，B2/B3 上下文及原生压缩恢复切片已完成限定离线及四项首批实测。正式全生命周期变体对照尚未实现，整个 Phase 5 未完成。** 当前入口见 [交接与证据索引](HARNESS_PHASE5_HANDOFF.md)，各次运行的历史记录见 [结果](HARNESS_PHASE5_RESULTS.md)，下一步范围与待批准预算见 [正式对照计划](HARNESS_PHASE5_ABLATION_PLAN.md)。每个实验批次另行冻结；未经实际运行、原始记录与聚合复核，不得宣称任何改善。

准备依据：Phase 4 及上下文/UI 修复已本地提交为 `a50e794e78466d77834c5d5a873e05fe113608ac`，证据见 [Phase 4 结果](HARNESS_PHASE4_RESULTS.md)。该提交是本清单的参考点，不替代后续每批实验的正式冻结记录。

## 1. 范围与停止线

- [ ] 仅建设 `evals/context/`、`evals/versioning/`、`evals/tool-recovery/`、`evals/isolation/`、`evals/long-horizon/` 所需的公开评测资产、runner、结果 schema、聚合与报告。
- [ ] 覆盖 CTX、VER、TOOL、ISO 四类核心任务；long-horizon 只组合这些能力，不另造无法归因的总分。
- [ ] Phase X 明确不做：Vector DB、Graphiti、Qdrant、Embedding、Reranker、复杂多 Agent delegation、自动 world→plan→write 工作流、完整 temporal knowledge graph、LLM no-progress judge、自动 Canon memory extraction。
- [ ] B4 dense retrieval 仅保留为可选、未实施变体；只有 lexical + authority + temporal + alias 的已运行结果证明不足，且另经批准，才制定独立验收。
- [ ] 不修改私人小说、私人会话、认证、provider URL、API key、全局模型配置或人工验收记录；公开产物不得包含这些内容。
- [ ] Phase 5 不把 `COMPLETED_CANDIDATE` 当作用户验收、语义正确、Canon 晋升或 release 完成。

## 2. 冻结与可复现输入

- [ ] 建立只含合成内容、许可明确、可公开提交的 fixtures；测试只修改临时副本，并在每次 case 前后核对仓库 fixture manifest。
- [ ] task 集固定且版本化；每项记录 `taskId`、类别、输入 fixture、预期机械 contract、允许动作、故障注入、人工 rubric（如有）和 unsupported 条件。
- [ ] 冻结被测代码 commit、dirty 状态、依赖 lock SHA、Pi SDK 版本、runner SHA、fixture manifest SHA、task-set SHA、操作系统/架构、Node/npm 版本。
- [ ] 真实模型实验另外冻结 provider、精确 model ID、有效 context window、max output、sampling/seed（若 provider 支持）、tool schema、system prompt、compaction/config 与并发设置；不记录 endpoint、凭据或私密 header。
- [ ] 同一比较批次使用相同 task 顺序、fixture 初态、故障计划、预算、超时、输出上限和终止规则；随机顺序或 seed 必须预先生成并进入 manifest。
- [ ] 若模型、SDK、代码、配置、task 或 fixture 任一冻结项变化，创建新 batch，不把结果直接并入旧 batch。
- [ ] 运行前保存机器可读实验 manifest；缺少冻结字段的运行标记为 `invalid`，不得补猜或计为 pass。

## 3. Baseline 与消融定义

- [ ] **B0-raw** 固定为原始 baseline commit/实现，不含后续 Harness 修复。
- [ ] **B0-safety-fixed** 仅加入为安全运行真实/合成任务所必需的最小修复，并逐项列出 diff；名称、图表和结论不得省略 `safety-fixed`。
- [ ] 当前 `contracts-b0-probe.ts` 的 manifest parser、malformed metadata write、symlink escape 三个 probe 只作为三项已知缺陷的 contract evidence；不得称为 B0 完整性能 baseline，也不得外推 token、质量、恢复或长程能力。
- [ ] B0-raw 若可能越权、路径逃逸或触碰真实项目，只在隔离合成沙箱运行相应 probe；不为追求“公平”而在真实项目禁用安全保护。
- [ ] **B1** = B0-safety-fixed + typed tool/session reliability；除该能力外保持 scaffold、Pi SDK、UI/adapter、任务和预算一致。
- [ ] **B2** = B1 + observation store + complete-request context budget；不得通过给 B2 更宽预算或不同 task 降低失败率。
- [ ] **B3** = B2 + version-aware checkpoint + compaction；resume、source invalidation 和 compaction 策略必须在运行前冻结。
- [ ] 当前 Phase 4 Supervisor 与其后 context-budget/maintenance 改进作为单独命名变体（例如 `B3+SUP`、`B3+SUP+MAINT`），不得偷算进 B3，也不得用其结果回填 B3。
- [ ] 如底层 SDK 无法同时支持全部 baseline，优先制作同一 SDK 的公平 scaffold；仍不兼容时记录差异并拆批，不将不等价结果做百分比比较。
- [ ] 每个变体输出 feature matrix；外层沙箱、凭据隔离、权限与禁止访问真实项目等安全保障始终启用。被评测的预算、隔离与 reconciliation 能力按变体明确差异，缺失能力只在合成沙箱测试，不能为 B0/B1 偷加后续能力，也不能为比较关闭真实环境保护。

## 4. 两条验收轨道

### A. 确定性 contract / fault-injection

- [ ] 不加载 provider 凭据、不进行真实模型调用；环境中清除常见 key/token/secret 变量。
- [ ] 复用现有公开 runner 的临时 fixture、结构化 trace、三轮确定性检查与 `unsupported` 语义；扩展而非伪造 provider usage。
- [ ] 验证 CTX 预算守恒与 fail-closed、VER 来源改版/压缩/恢复、TOOL timeout/unknown outcome/不重复副作用、ISO 项目/会话/角色/代际隔离。
- [ ] `partial`、`unsupported`、`unknown`、缺失能力、未执行 subcase 均不算 pass；聚合中分别计数并保留原因。
- [ ] 机械断言只证明 contract 成立，不声称真实模型任务质量、token 节省、真实 provider 恢复率或 Desktop release 可用。

### B. 真实模型实测（另行批准后执行）

最小试测方案见 [Phase 5-B Pilot 计划](HARNESS_PHASE5_PILOT_PLAN.md)：独立工装与离线限额测试已实现；两次分别批准的批次保留一失败、一通过的结果。每批原上限为 2 个任务、最多 8 次 HTTP，不可重用旧授权追加调用。价格未知，不把本地零费用默认值当作免费。

已交付的离线前置工装及其限制见 [说明](HARNESS_PHASE5_PILOT_TOOLING.md)，实测数字见 [结果](HARNESS_PHASE5_RESULTS.md)。模拟 SDK 演练不勾选下方任何真实模型执行门。

- [ ] 在任何 API 调用开始前，向用户展示并确认：provider/model、有效配置、task 数、每变体/每任务重复上限、最大输入/输出预算、预计最坏调用次数/成本、stop 条件、是否允许 compaction，以及需要用户批准的行为。
- [ ] 未获得当次明确确认时不得发起调用；确认后也不得突破已批准的调用、token、成本或时间上限，扩容需再次确认。
- [ ] 先执行最小 pilot，验证完整请求的预算覆盖、hash/provenance、usage 解析、停止、失败分类、清理与成本上限；不以此为由持久化完整私人 prompt。pilot 不自动并入正式统计。
- [ ] pilot 通过并由用户确认后才运行规模实验；重复数按成本从小到大扩展，并报告已完成重复数，不预设“足够显著”。
- [ ] 同一批次按冻结顺序或预登记随机顺序运行所有变体；provider 限流、服务异常或配置漂移导致的样本单列，不选择性重跑赢家。
- [ ] 每次请求前执行完整 payload budget preflight；超限、unsupported media、无效预算或压缩失败必须停止，不绕过安全门。
- [ ] 用户批准、确认输入或危险操作一律保持 `BLOCKED_USER`；不能为了跑 benchmark 自动同意或在真实项目关闭安全。
- [ ] 真实模型输出另做人工盲评/成对评审时，保存 rubric、评审顺序与分歧；人工质量分不得改写为机械 PASS。

## 5. 指标与分类

- [ ] 所有指标先定义分子、分母、单位、排除规则和聚合层级（request / task / repetition / batch），再运行实验。
- [ ] 记录任务终态：pass、fail、blocked_user、blocked_prerequisite、no_progress、cancelled、invalid、unsupported、unknown；只有满足预登记 contract 的 `pass` 进入成功率分子。
- [ ] 记录请求/任务失败率，并按 model/provider、Harness、tool、verifier、budget、timeout、cancel、invalid/unsupported 分类；不得把未知原因并入成功。
- [ ] 记录过期证据误用：在依赖 SHA/authority/temporal scope 已失效后仍用于写入或完成判定的次数与受影响任务数。
- [ ] 记录重复副作用：同一逻辑 operation 导致重复外部变更的次数；同时记录被安全阻止的 duplicate dispatch，二者不得混为一项。
- [ ] 记录恢复：注入中断后在不重放未知写入、不绕过重验条件下恢复到预期机械终态；另列阻塞、失败与 unknown。
- [ ] token 至少拆为输入、输出、cache read、cache write、total（provider 有何字段就保存何字段）；cached token 不与普通输入混算。
- [ ] provider 返回的实际 usage 保留字段原貌、单位和 request 对应关系；缺失即 `null/unknown`，不能填 0。
- [ ] 本地估算 token 单独记录 estimator 名称/版本与估算值；绝不标为 provider actual。若有 exact count API，也与 completed-request usage 分栏。
- [ ] 报告实际 usage 与估算误差时仅比较同一完整请求；代理附加提示、图片、tokenizer 差异等无法复原时明确限制。
- [ ] 可选记录调用数、工具调用数、验证次数、wall time、停止原因与实际费用（仅 provider 可核验时）；未实际运行不得填写数字或改善百分比。
- [ ] 人工质量维度（例如来源忠实、任务完成度、可读性）与机械安全/contract 指标分表，不生成掩盖安全失败的单一综合分。

## 6. Runner 与数据产物

- [ ] 每个 batch 产生不可变 `manifest.json`，包含冻结项、批准预算摘要、variant matrix、task/repetition 清单和各文件 SHA-256。
- [ ] 每个 request/run 保存有界、脱敏的 raw JSONL/JSON：身份、变体、task、时间、状态、原因码、trace、usage、工具/验证摘要、artifact/source SHA；不保存密钥、认证 header、完整私人 prompt、私人正文或未脱敏异常。
- [ ] raw 产物写入后生成 hash；聚合只从 manifest 指向且 hash 匹配的 raw 数据重建，不能手工填写结果。
- [ ] 生成 aggregate JSON 与人读报告；至少按 variant × task category 给出样本数、状态分布、指标分子/分母、missing/unknown/unsupported 数及置信区间或明确“不足以推断”。
- [ ] 聚合器拒绝 schema 不匹配、重复 run ID、冻结项漂移、缺失 raw、hash 不符和超预算运行；被拒绝样本保留审计原因，不静默删除。
- [ ] 报告引用 manifest/batch ID 和代码 commit；任何表格数字都能追溯到 raw run ID。
- [ ] 发布前执行 secret/private-content scan；无法证明公开安全的原始 provider 内容不进入仓库，只发布脱敏摘要与 hash/provenance。
- [ ] runner 自身提供合成 fixture 单元测试：usage 缺失、cached usage、unknown、unsupported、重复 run、manifest 漂移、部分写入和聚合重建。

## 7. Pilot、规模实验与停止规则

- [ ] Stage 0：只跑 schema/runner 的离线合成自测，确认零模型调用。
- [ ] Stage 1：经批准后用极小 task × variant × repetition pilot，确认真实 usage、预算上限、停止和脱敏产物。
- [ ] Stage 2：复核 pilot 后再确定正式重复数；按成本分批执行，每批可独立停止并保持可审计。
- [ ] 出现预算超限、私密内容泄漏、冻结项漂移、重复副作用、安全门绕过、聚合不可重建或异常费用时立即停止该 batch。
- [ ] provider 不报告 usage 或 cache 语义不清时，相关用量指标为 `unknown`，不得用于 token 节省结论；任务是否通过仍由独立 contract 判定。请求结果本身未知则不能计为任务 pass，不用本地估算冒充实际用量。
- [ ] 正式结果不足以支持比较时结论写“证据不足”，不得用 pilot、contract tests 或挑选样例补齐宣传数字。

### 首个实施增量：P5-A（离线）

- [x] 先建立 manifest / raw / aggregate schema、最小 runner 与聚合重建测试，不接真实 API。
- [x] 先覆盖 CTX、VER、TOOL、ISO 各 1 个最小公开任务，使用合成响应和故障注入，三轮复跑检查确定性。
- [x] 先审计变体能力矩阵与实际开关；未实现或未能公平复现的 baseline 明确标记未运行，不借用当前实现结果。
- [x] 交付可复现命令、原始结果引用及限制说明。该增量只完成离线基础设施，当时尚未授权真实 pilot；后续独立批准的 pilot 见第 9 节，不代表正式消融已完成。

### P5-A 第二增量：模块对照与长程组合（范围限定）

- [x] `historical-b1/b2/b3` 仅调用对应历史提交的原字节模块；按 commit、Git blob、SHA-256 核对 provenance，不以当前实现冒充历史代码。
- [x] `c1/c2/c3` 是当前源码的能力分层，和历史模块分轨报告；缺失能力返回 `unsupported`，不调用任务、不注入后期 factory。
- [x] manifest v2 冻结 variant × task × 3 轮完整矩阵，同时保留 v1 结果重建；类别与单任务分别聚合。
- [x] 新增 typed retry/unknown outcome 合同与长程组合任务，后者包括磁盘 checkpoint 恢复、来源变更阻断、刷新、写入对账及跨项目/会话拒绝。
- [x] 长程“压缩边界”仅为合成序列化，不称为 LLM 摘要、原生 Pi compaction 或完整进程重启。
- [ ] 完整 B0-raw、B0-safety-fixed 及相同 SDK 下 B1→B3 的 Desktop/扩展生命周期消融适配层；本增量未完成，不能由模块矩阵替代。
- [ ] 完整 Supervisor、context maintenance 独立消融；不属于本次模块矩阵的覆盖范围。限定 SDK 离线配置已由 S4 补齐，见第 9 节；真实模型/完整 Desktop 对照仍未完成。

## 8. 报告与作品集验收

- [ ] 报告先陈述比较范围、安全不变量和已知差异，再展示 B0-raw、B0-safety-fixed、B1、B2、B3 及单列后续变体。
- [ ] 所有“降低/提高/节省”只引用同批公平对照的已运行数据，附绝对数量、分母与不确定性；不将三个 bug probes、确定性长程 fixture 或未运行设计写成性能提升。
- [ ] 明确区分：离线 contract evidence、合成 fault eval、真实 provider 实测、人工质量评审、Desktop 实机验收。
- [ ] 失败、unsupported、unknown 与负结果同样进入报告；不因作品集叙事删除。
- [ ] 真实 Desktop / Tauri 人工验收为可选、独立 release gate：记录版本、窗口流程、截图/观察与 tester，但不并入模型消融机械 PASS。
- [ ] Portfolio 文案保留证据边界：说明具体场景、版本和样本，不宣称通用 Agent 可靠性、完整长篇质量或生产部署能力。

## 9. 分阶段完成定义

### Phase 5-A：离线评测基础设施

- [ ] 公开 task/fixture、variant 定义、manifest/raw/aggregate schema、runner 与重建命令均可从干净隔离 checkout 执行。
- [ ] 离线轨道可证明结果确定性、fixture 不变、零模型调用、unsupported/unknown 不计 pass、聚合可从 raw 重建。
- [ ] B0-raw、B0-safety-fixed、B1、B2、B3 公平边界清晰；Supervisor/后续预算维护是独立变体，B4 明确未实施。
- [ ] 报告不含未经运行数字，人工判断不冒充机械 PASS，所有结论可追溯到冻结 manifest 与原始记录。

### Phase 5-B：真实模型消融与证据包装

- [x] 前置工装已补独立 live 执行路径、批次授权摘要校验、SDK 子进程网络隔离、共享限额、逐请求 durable Journal 与只读恢复。首批 3 次请求后答案校验失败并封存；后续补细分诊断、310 项离线检查通过。不代表下面的正式模型消融条目已通过。
- [x] 最小真实 pilot：新版 `live-mHOnDl` 另获批准，两项公开合成任务均通过，6 次真实 HTTP、无未知派发或重试，文件/用量/Journal 可只读复核。仅为固定 SDK 的最小集成证据，不能替代正式变体消融或原生 Desktop 验收。
- [x] S1 限定 SDK 读写适配：原始 B0 快照 + 共同安全包装，B1 另接冻结可靠性工厂；固定 SDK 下三轮合成对照、能力泄漏负测试与严格重建。采用独立 `sdk-*` 名称；完整 Desktop/Rust/RPC 生命周期及真实效果对照仍未完成，见 [S1 说明](HARNESS_PHASE5_SDK_ABLATION.md)。
- [x] S2 独立实测工装：四项清单、实际 SDK provider 路径、父进程计量/Journal/批准/只读恢复已接通，95 项离线检查及全新依赖 11 命令回归通过。首批 `s2-live-RGcvnD` 另获明确批准执行，3 pass、1 格式 fail，10 次真实 HTTP、0 unknown；29 个产物只读重建 SHA 不变。缓存未报告，费用未知；不把单轮 SDK 切片视为完整消融通过，旧 pilot 4/8 次上限未放宽，见 [S2 说明](HARNESS_PHASE5_SDK_LIVE.md) 与结果第十三增量。
- [x] S3 首个限定离线增量：大结果 Observation 分页、完整合成载荷预算、SDK 原生压缩及独立进程恢复接通；103 项检查通过，固定三轮 27 格矩阵为 15 pass、12 预登记缺能力负例 fail，9 次原生压缩和 9 次跨进程重开。摘要为本地固定响应、自动压缩关闭，真实 HTTP/模型调用为 0；不等于摘要质量、自动恢复或完整 B2/B3 验收。见 [S3 说明](HARNESS_PHASE5_SDK_CONTEXT.md) 与结果第十四增量。
- [x] S3 第二限定离线增量：SDK 自动阈值压缩、溢出后一次 continuation、持久化写入意图及丢回执跨压缩/跨进程恢复；175 项检查通过，独立 v2 三轮 54 格为 30 pass、24 预登记缺持久化能力负例 fail。72 次自动 native compaction、36 次进程重开，真实 HTTP 为 0；部分/无落盘写入保持未知并阻止重放，不等于创作任务成功。任意断电/迟到竞态、真实摘要、Rust/RPC/UI 仍未覆盖，见 [生命周期说明](HARNESS_PHASE5_SDK_LIFECYCLE.md) 与结果第十五增量。
- [x] S3 真实工装传输核心离线预检：实际 SDK provider 序列化/parser 下，普通请求和原生单/双摘要共享外层额度与 durable Journal；并发摘要串行派发，取消/超时/缺失 usage/额度耗尽均停止，隐式 fetch 重试被拒绝。真实 HTTP 为 0，实际 usage/费用为 null；该预检本身不含具体 task/profile 或真实授权，见 [传输预检](HARNESS_PHASE5_SDK_CONTEXT_TRANSPORT.md)。
- [x] S3 限定任务/新批次工装：B2/B3 各接长文件分页、压缩后来源更新并跨进程续写，共四项；独立版本化预算、24 小时清单及精确 SHA 批准、普通/摘要总限额、严格记录/只读恢复。83 项离线检查通过，含读错页面、旧版本误写、reasoning/cache 口径、取消/未知和授权拒绝。工装离线测试真实请求为 0；后续单独准备并批准的真实批次另列，见 [S3 新工装](HARNESS_PHASE5_SDK_CONTEXT_LIVE.md) 与结果第十七至十九增量。
- [x] S3 限定任务首批实测：`s3-live-t6GSPA` 四项均 pass，27 次真实 HTTP（普通 25、摘要 2），0 unknown/pending，2 次实际原生手动压缩及 2 次跨进程恢复。90 个产物只读重建 SHA 不变，provider cache 未报告、费用未知。每格仅一次，不等于 B3 优势、自动压缩/任意强杀恢复、摘要质量或完整 Desktop release 验收；不复用剩余 5 次额度。
- [x] S3 受控强杀/迟到结果离线增量：125 项检查，四种固定屏障各三轮，共 12 项恢复合同通过，12 次真实子进程强杀、15 次独立重开，恢复写入派发 0；最终 6 项字节对账完成、6 项保持未知并阻止重放。10 项 adapter 迟到回调场景单列；不是任意指令崩溃、断电/fsync、父 broker、压缩联动或 Desktop 验收。见 [恢复竞态说明](HARNESS_PHASE5_SDK_RECOVERY_RACES.md) 与结果第二十增量。
- [x] 可重建封存证据报告：显式选择含负结果的 12 批，原验证器只读重建、509 个原文件 SHA 不变；70 项报告工装检查通过。生成逐批/profile/task Markdown 与 JSON，区分证据核验、机械 pass 和业务未知结局，保留 usage/cache 缺失。报告包只含脱敏摘要与哈希索引，不代表全量 probe 统计、完整 raw 归档或正式对照完成。见 [报告说明](HARNESS_PHASE5_EVIDENCE_REPORT.md) 与结果第二十一增量。
- [x] S4 Supervisor / context maintenance 限定 SDK 离线对照：三配置 × 五任务 × 三轮，27 机械 pass、18 预登记缺能力 fail，0 unknown/blocked；188 项检查通过。第三次无变化验证停止、未验证完成拦截、只裁剪旧工具结果、裁剪不足后一次 native compaction 均有真实 SDK 证据；五项故障另计。正常矩阵含 3 次原生手动 API 压缩，无真实模型调用。不是完整小说验证、摘要质量、生产预算估算器、模型自主行为或 Desktop 发布验收。见 [S4 说明](HARNESS_PHASE5_SDK_SUPERVISION.md) 与结果第二十二增量。
- [x] S4 封存报告集成：显式保留原 12 批并增加 S4，13/13 证据重建一致、557 个原文件 SHA 不变，105 项报告检查覆盖 10 种 family。新报告 `report-wAl4It` 将机械 pass 与候选验证、只读答复、停止、待验证等业务结局分开，拒绝合成人工批准，不覆盖旧报告或混入独立故障分母；见结果第二十三增量。此项不等于真实模型对照或整阶段完成。
- [x] 第二十三增量完整本地隔离回归：`isolated-run-LZyZ3O` 480 文件快照、全新依赖、18 条命令全部通过，含 S4 188 项和报告 105 项；原 Harness 224 项 × 3 轮确定性通过。当轮只回填说明文档，代码/测试/配置与快照一致；临时 checkout 已清理，全局 Pi 配置哈希不变。没有真实模型请求，不等于远端 CI、已提交 clean clone 或原生 Desktop 发布验收；本轮新增工装的 19 命令回归另记第二十五增量。
- [x] S4 最小真实首批方案：九格顺序、三个共同业务任务、机械/业务结局边界、普通/摘要共用的拟定 6/54 次预算及参考金额已静态核验；见 [方案](HARNESS_PHASE5_SDK_SUPERVISION_LIVE_PLAN.md) 与结果第二十四增量。方案不是可执行 manifest，也不是当批真实调用批准。
- [x] S4 独立真实工装：provider 自主工具选择路径、公共验证器与新完成判定、共享出口/清单/授权/重建已实现；112 项离线检查通过。`isolated-run-E1kRln` 为 493 文件快照、全新依赖 19 条命令全部通过，包含旧 S4 188 项和报告 105 项；生产源码及全局 Pi 配置不变。正常演练九格为 7 机械 pass、2 预算阻断 fail，真实请求 0，不是七项创作完成。见结果第二十五增量；后续正式准备与批准执行单列。
- [x] S4 首批授权执行与封存：`s4-live-orlzII` 在精确清单获批准后执行，12 次真实普通 HTTP、0 摘要；1 pass、1 unknown、7 未运行，批次 incomplete。第二格用完单项六次限额后停止全批，未借用剩余额度或补跑；50 个产物只读重建一致，网络 unknown/pending 均 0，cache 未报告、费用未知。此项仅确认执行/封存纪律，不代表九格完成、Supervisor/维护效果或正式消融通过；见结果第二十七增量。
- [x] S4 停止诊断 v2：入口、HTTP 预留/派发及首个有界停止码分栏，诊断与 SDK/Journal 交叉核验；v1 原聚合只读兼容、不补写未知原因、禁止重新授权。最终 134 项检查通过，`isolated-run-doqNzV` 495 文件、全新依赖 19 命令通过；首次旧本地 HTTP 测试失败保留在 `isolated-run-QIW451`，复跑未复现但根因未定位。新旧四批 236 文件只读 SHA 不变，生产代码及 6/54 额度未改、真实请求 0。8/72 是待确认建议，不是新清单或调用批准；见结果第二十八增量。
- [x] S4 8/72 版本化预算与新清单准备：schema v3 / namespace v2 的普通/原生摘要共享限额已实现，旧 v1/v2 按 6/54 只读核验且禁止重新授权。150 项离线检查与两项类型检查通过，launcher 网络子测试 61 项另计；旧四批 236 文件、新两批 115 文件只读 SHA 不变。该增量结束时，正式清单 `s4-live-FJMrVf` 仅 prepared、真实请求 0，执行需另获精确 SHA 批准；后续实测单列下一项。该轮未重跑全新依赖 19 命令链，不改变生产 runtime 或全局 Pi 配置；见结果第二十九增量。
- [x] S4 8/72 新清单获准实测与封存：`s4-live-FJMrVf` 在精确 SHA 单独批准后运行，九格均执行；26 次真实 HTTP（普通 25、摘要 1），7 pass / 2 预登记压力 fail，0 unknown/blocked，网络 unknown/pending 0。三项候选已验证、三项前提缺失时停止、一项维护压力恢复完成只读答复；无维护的两格预算阻断保留 fail。92 个产物只读核验一致，旧六批 351 文件及全局 Pi 配置不变，cache 未报告、费用未知，剩余 46 次不复用。每格一次且未触发 NO_PROGRESS，不代表总体优势、完整正式对照或 Desktop 验收；见结果第三十增量。
- [x] 新旧 S4 live 统一只读报告：原 13 批加旧未完成批、新 8/72 批，共 15/15 原记录核验，699 个文件与旧报告不变；新报告 `report-CPUudb` 保留不同预算、机械/业务结局、零请求/缺失用量、未观测分支、旧 SDK null 和费用未知。报告 199 项检查覆盖 11 种 family、v1/v2/v3 原校验器兼容、伪造批准/重签 raw/错误指纹/未封存拒绝；两项类型检查通过，新增模型请求 0。本轮未重跑全新依赖 19 命令链，不代表完整 Phase 5 或发布验收；见结果第三十一增量。
- [x] 当前交付完整本地隔离回归：`isolated-run-RqGXwI`，496 文件、全新依赖、19/19 条命令通过；Harness 224 项 × 3 轮、S4 live 150 项、报告 199 项均通过。187 个待交付候选均纳入快照，699 个原证据、40 个报告文件及全局 Pi 配置不变；收尾仅回填六份说明，新增模型请求 0。保留安装/构建警告与历史偶发失败，不代表远端 CI、已提交 clean clone、原生 Desktop 或完整 Phase 5 验收；见结果第三十二增量。
- [ ] 真实模型轨道另获明确批准：先有 pilot，再有预算内正式 batch；所有调用、usage、失败和停止均可审计，且无私密内容进入公开产物。
- [ ] 实测报告包含各变体的真实任务结果、可核验 usage、缺失项和不确定性；证据不足的比较保持无结论，不能预设正向改善。
- [ ] 完成作品集证据包装，明确区分离线规则验证与真实模型实测。当前已完成选定封存批次的可重建报告工具，正式比较和相应作品集结论仍未完成。
- [ ] Phase X 保持未实施；真实 Desktop release gate 若未执行，明确写为未验证，而不是完成。

尚未完成正式 5-B 时，应逐项报告已运行的离线模块评测和最小真实 pilot，**不能宣称整个 Phase 5 或正式模型消融已经完成**。整个 Phase 5 的完成要求 5-A 与 5-B 均满足各自清单，发布级原生验收另算。
