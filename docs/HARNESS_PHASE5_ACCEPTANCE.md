# Phase 5 — Eval / Ablation / Portfolio Packaging 验收清单

本文件只定义后续 Phase 5 的执行与验收边界，当前不实施实验、不调用模型、不填写成功数字。实验开始点必须另行冻结；未经实际运行、原始记录与聚合复核，不得宣称任何改善。

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

- [ ] 先建立 manifest / raw / aggregate schema、最小 runner 与聚合重建测试，不接真实 API。
- [ ] 先覆盖 CTX、VER、TOOL、ISO 各 1 个最小公开任务，使用合成响应和故障注入，三轮复跑检查确定性。
- [ ] 先审计变体能力矩阵与实际开关；未实现或未能公平复现的 baseline 明确标记未运行，不借用当前实现结果。
- [ ] 交付可复现命令、原始结果引用及限制说明。P5-A 只完成离线基础设施，不代表整个 Phase 5 或真实模型效果评测完成；真实 pilot 待后续单独确认。

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

- [ ] 真实模型轨道另获明确批准：先有 pilot，再有预算内正式 batch；所有调用、usage、失败和停止均可审计，且无私密内容进入公开产物。
- [ ] 实测报告包含各变体的真实任务结果、可核验 usage、缺失项和不确定性；证据不足的比较保持无结论，不能预设正向改善。
- [ ] 完成作品集证据包装，明确区分离线规则验证与真实模型实测。
- [ ] Phase X 保持未实施；真实 Desktop release gate 若未执行，明确写为未验证，而不是完成。

未获真实模型授权或尚未完成 5-B 时，只能报告 Phase 5-A 或其中的首个 P5-A 增量已完成；**不能宣称整个 Phase 5 或真实模型作品集证据已经完成**。整个 Phase 5 的完成要求 5-A 与 5-B 均满足各自清单，发布级原生验收另算。
