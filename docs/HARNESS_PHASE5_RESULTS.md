# Phase 5：增量结果与历史证据

2026-09-22。以下各增量起点为 `d3018347761fa5007b98145a1795d9070318cc00`，执行时为未提交源码；准确版本由每批 manifest 的源码 SHA 清单冻结。**最新状态：离线模块矩阵、新版最小真实 pilot、S1/S2 同 SDK 读写切片、S3 上下文/手动压缩 v1 与自动压缩/未知写入恢复 v2 均已有各自的限定证据；正式全栈对照和整个 Phase 5 尚未完成。**

当前状态、复核入口与提交边界见 [交接索引](HARNESS_PHASE5_HANDOFF.md)，下一步见 [正式对照计划](HARNESS_PHASE5_ABLATION_PLAN.md)。下文按时间保留各增量的原始状态；“待授权”“未执行”等描述只对应所在增量结束时，不能覆盖后续记录。模块矩阵见第二增量，真实失败批次见第六增量，新版真实成功批次见第八增量。

## 首个增量：已实现（历史记录）

- `evals/core/`：严格 manifest / raw / result-index 校验、不可变运行计划、结果聚合及只读重建。拒绝重复、缺失、额外记录、哈希漂移、部分写入、越界路径、超预算与不完整 PASS；拒绝原因只记录安全枚举。
- `evals/context/`：完整请求预算分量守恒、正向允许、超限、无效载荷及不支持媒体的阻止行为。
- `evals/versioning/`：修改临时副本中的真实来源文件，检查旧检查点失效，刷新来源后恢复写入许可。测试的是机械门槛，不是语义事实判断。
- `evals/tool-recovery/`：真实临时文件写入后的丢失回执、取消及重试；从实际派发/写入次数计量重复副作用，而非只检查返回标签。
- `evals/isolation/`：观察记录的项目/会话/职能边界及预算代际隔离，含正向对照；不等于 OS 账户隔离。
- `evals/variants.ts`：只有 `current-full-contract` 可运行。B0/B1/B2/B3 及后续监管/维护变体的公平评测适配器明确未实施；代码历史不冒充消融结果。B4 延后。
- 运行时只读取公开合成 fixture、代码和依赖元数据；每项任务使用独立临时副本。子进程仅继承白名单环境，拦截网络和再次启动子进程，任务有 20 秒超时。此防护针对受信任评测代码，不声称 OS 安全沙箱。
- 编译时记录实际载入的源码哈希；运行前、每项任务前后核对源码与 fixture。manifest 预先写入且不回写，结果索引另行封存 raw 哈希；编译快照和运行时源码不一致会停止。
- 评测接入 TypeScript 检查、CI 与独立安装脚本，不改生产前端、小说正文、会话或 provider 配置。

## 首个增量实测（历史记录）

环境：Windows x64、Node `v24.19.0`、npm `11.17.0`、仓库固定 Pi SDK `0.63.1`。本增量直接调用生产合同模块，不启动 Pi 模型循环。

- `npm run check`、`npm run check:harness-tests`：通过。
- `npm run test:evals`：**23 项 schema/聚合测试 + 17 项 runner/完整性检查通过**，其中包括真实进程网络拒绝、子进程拒绝、超时、未知字段不落盘、篡改拒绝与只读重建。
- `npm run eval:offline`：**4 类任务 × 3 轮 = 12 次运行全部通过，结果确定性一致**。全部 provider usage 为 `null/unavailable`，真实模型调用为 0。
- `npm run eval:rebuild -- artifacts/harness/evals/offline-t8nxEV`：通过，从原始记录重建的结果与保存的 aggregate 一致。
- `npm run test:harness`：既有 **224 项 × 3 轮**通过，确定性一致。
- `npm run test:novel-domain`：既有五组领域回归通过。
- `npm run build:frontend`：通过，保留既有 chunk 大小与动态/静态导入警告。
- `npm run test:harness:isolated`：**332 个文件**的独立未提交源码快照，重新安装依赖后 **8 条命令全部通过**，包括新增 40 项评测框架检查、12 次最小评测运行、既有 224 项三轮 Harness、Phase 4 长程场景、领域回归和前端构建；未复制忽略的私人文件。之后仅整理本验收文档。这不是已提交 clean clone 或远端 CI。

可核对的批次：`artifacts/harness/evals/offline-t8nxEV/`，manifest SHA-256：`1ddf2fdbe8461986097050fecca9bb9536f0dc12f010d01361a4d98273076e7a`。原始记录、结果索引、人读报告与聚合位于该忽略目录，不随代码提交。批次有界输出经提交前检查，不包含私人小说正文或凭据；详细指标口径见 [使用说明](../evals/README.md)。

## 如何复跑

```powershell
npm run test:evals
npm run eval:offline
# 使用上一条输出的新目录，不复用旧批次写入
npm run eval:rebuild -- artifacts/harness/evals/<batch-id>
```

`eval:rebuild` 成功时只向标准输出打印聚合 JSON；失败时不会改动被审计 batch，只在外层 `evals/rejections/` 新建脱敏拒绝原因。现有产物不覆盖，原始记录无法重建时不产生成功结论。

## 首个增量结束时的边界（历史记录）

- 目前是 4 个最小合同任务；没有完整 CTX/VER/TOOL/ISO 任务矩阵，也没有 Phase 5 长程组合任务。
- 没有可比较的历史 baseline 适配器、真实模型 pilot、token/费用测量或改善百分比。合成故障恢复次数不能称为模型恢复率。
- 后续应先补公平变体适配与长程组合任务，再明确真实模型 pilot 的模型、任务和调用预算；需要另行授权后才调用真实 API。
- 本轮没有新建提交或推送，没有远端 CI、Linux 本机执行或原生发布包验收。只证明上述本地源码与离线场景，不改写 Phase 4 的有限实机证据。

## 第二增量：历史模块 / 当前组件矩阵与长程组合

2026-09-22。仍基于上述 HEAD 的未提交源码，不覆盖先前批次。历史模块轨道从以下已存在的提交取出原字节代码，保留 commit、Git blob、SHA-256 和仓库路径于 `evals/adapters/provenance.json`：

- `historical-b1`：`32131274be2964a61d0180088eeb51709ebdb86f`。
- `historical-b2`：`f21b2b46a53729ed5722f5b816fe9fd21a447dc9`。
- `historical-b3`：`828d36d9c0f3140c750616b97e7d7e92287e6444`。

共 8 个不同模块文件、16 个 profile/source 关联项，本机全部核对历史 Git blob 与字节 SHA。缺少历史 Git 对象的 checkout 仍强制校验快照 SHA，并明确记录 `metadata-hash-only`，不伪称完成 Git 历史验证。历史适配器不回退到当前模块。

本增量另提供 `c1-tool-contract`、`c2-observation-budget`、`c3-versioned-checkpoint` 的当前源码分层，以及 `current-full-contract`。这是两条**模块合同证据轨道**，不是公平全栈 B0→B3 消融。C3 与 current-full 在本套任务使用相同 factory；当前 profile 的生产能力声明不等于全部已被测到。

### 新增实现与边界

- manifest v2 预登记 variant × task × 3 轮完整矩阵；拒绝缺格、重复格、错位变体及未知能力。保留 v1 严格重建兼容，v1 aggregate 不增加 `taskGroups` 字段。
- 聚合和报告同时提供类别、单任务层级，历史 / 当前轨道分表。缺能力在调用任务前返回 `unsupported`，不计 pass。
- 增加 `TOOL-002-typed-recovery`：有限读重试、权限错误不重试、派发后超时为 unknown outcome、不盲目重放写入。
- 增加 `VER-002-long-horizon`：读取并记录来源 → 核验完整请求预算 → checkpoint 落盘并从新 store 解析 → 修改来源并阻断旧证据 → 重读刷新 → 真实文件写入丢失回执后对账 → 跨项目/会话拒绝。只是确定性的合成多步任务，**不经过 LLM 摘要或 Pi 原生 compaction，也不是整个进程重启**。
- 历史预算计量为 UTF-8 bytes，当前预算为 estimated tokens；每条 trace 保留自身单位，禁止把二者相除形成 token 节省结论。
- 将 provenance JSON 也纳入实际编译输入冻结；历史矩阵开始前校验快照 SHA。异常路径保留已观测到的重复副作用与陈旧证据放行计数，避免后续错误将其清零。使用真实文件读回与故障注入验证这两条停止指标。

### 最新本地矩阵结果

`npm run eval:matrix`：7 个变体 × 6 个任务 × 3 轮 = **126 次运行**，其中 **90 pass、36 unsupported、0 fail**；其余终态均为 0，同一变体/任务的三轮结果确定性一致。

历史模块轨道：

| 变体 | pass / planned | unsupported | fail |
| --- | ---: | ---: | ---: |
| historical-b1 | 6 / 18 | 12 | 0 |
| historical-b2 | 12 / 18 | 6 | 0 |
| historical-b3 | 18 / 18 | 0 | 0 |

当前源码轨道：

| 变体 | pass / planned | unsupported | fail |
| --- | ---: | ---: | ---: |
| c1-tool-contract | 6 / 18 | 12 | 0 |
| c2-observation-budget | 12 / 18 | 6 | 0 |
| c3-versioned-checkpoint | 18 / 18 | 0 | 0 |
| current-full-contract | 18 / 18 | 0 | 0 |

这两张表显示能力覆盖，**不表示模型成功率提升**。长程任务仅 historical-b3、c3、current-full 各 3 次通过，其余 4 个变体各 3 次明确 unsupported。矩阵实际观测的重复副作用和陈旧证据放行均为 0；所有 provider usage 均为 `null/unavailable`，模型调用为 0。

主矩阵批次：`artifacts/harness/evals/offline-eOyK60/`。

- manifest SHA-256：`e1e173c5246c24e578d6013d5a6c354f846a1838b566960fc5715e7a02992e68`。
- source manifest SHA-256：`a4df30cbfa22c556088e440917f2cf6ba502f8c06d8707eee6b52aaa35abe23b`。
- fixture manifest SHA-256：`60e52c1a3bfebda18b4ec99a9198a31be9082d6367199c57e7ac95cb672fdd55`。
- task-set SHA-256：`49cc9140f7b7560d291cf56d9c3f08b70fd9ca83252550abb21f1c50dbc1ad6d`。

`npm run eval:offline` 单独运行 current-full：**18 / 18 pass**，批次 `offline-JStASo`，manifest SHA-256 `589295f2e9b93d7b9ad34a644491df5905e1c65539e2e5c4dd9ce8409e0820a3`。

### 回归与重建

- `npm run check`、`npm run check:harness-tests`：通过。
- `npm run test:evals`：32 项 schema/aggregate + 61 项历史 provenance + 15 项长程 + 3 项故障计数 + 23 项 runner/integrity 检查通过（134 项），包含完整 126 次矩阵。
- 新矩阵只读重建与保存 aggregate 深度相等，manifest 字节不变；首批 v1 `offline-t8nxEV` 的 aggregate 也与原文件完全一致。
- `npm run test:harness`：既有 224 项 × 3 轮通过、确定性一致；`test:harness:long-horizon` 既有 1 个场景 × 3 轮通过。
- `npm run test:novel-domain` 与 `npm run build:frontend` 通过，既有构建警告保留。
- `npm run test:harness:isolated`：349 个文件的独立未提交源码快照，重新 `npm ci` 后 8 条命令全通过，包含上述 134 项自测及 126 次矩阵。快照 SHA-256 为 `24b473e41e803047b09f1c08b96906985e1deb341583732ced9efeb2531f9323`，结果位于 `artifacts/harness/isolated-summary.json`。随后仅完善阶段文档；这是本地未提交源码复验，不是远端 CI 或已提交 clean clone。

过程中存在因源码漂移中止的开发批次 `offline-Q8YH17`，保留 `stopped.json` 和已写 raw，不计入上述完成矩阵。后续任何源变更均另开批次；不将调试运行拼接成正式结果。

### 剩余工作

已补充 [最小真实模型 Pilot 方案](HARNESS_PHASE5_PILOT_PLAN.md)。这是任务、预算与工装实施前置清单，不是 API 调用授权或已执行结果。

- 完整 B0-raw / B0-safety-fixed 以及等价 SDK/scaffold 下 B1→B3 的全栈适配器未完成；Supervisor / maintenance 的独立消融未做。
- 真实模型 pilot、provider usage/费用、人工质量评审、作品集模型改善证据仍未做。下一步应先单独明确 pilot 的任务、模型、调用预算和停止条件，再获得授权；本次“继续”不视为真实 API 调用授权。
- 本次不改私人小说、会话、provider 配置或生产前端；未 commit/push，也未运行远端 CI、Linux 本机或原生发布包验收。Phase X 保持未实施。

## 第三增量：真实 Pilot 的离线前置工装

2026-09-22。第三增量交付独立 `evals/pilot/` 与 `test:pilot` / `eval:pilot:rehearse` / `eval:pilot:rebuild`，详见 [工装说明](HARNESS_PHASE5_PILOT_TOOLING.md)。以下为当时记录：仅有离线工装，没有真实 API 入口或凭据加载；后续入口进展见第四增量。

当前源码复验：

- `npm run test:pilot`：模型投影 9、传输护栏 26、usage 13、记录 8、worker 隔离 4、SDK 正向/错误路径 25，合计 **85 项检查通过**。记录校验独立重算用量，不只相信 `usage-consistency` 布尔结果。
- 随后两项公开合成 SDK 演练 **2 / 2 通过**，六次内存模拟 HTTP、真实 HTTP **0**。模拟脚本指定工具调用和答案，不据此评价模型质量。
- 最新批次 `artifacts/harness/pilot-rehearsals/rehearsal-8ZdeHT/`，manifest SHA-256 `7d2e70c5f403184c4f39e60a80b7dc954aefbb6c9cc72f2f776a1caaccfb39e7`；只读重建与保存结果一致。
- `npm run check`、`npm run check:harness-tests`、`npm run build:frontend` 通过；保留原有构建警告。既有 Harness 224 项 × 3 轮全部通过。
- 366 个文件的独立未提交源码快照，重新安装依赖后 **9 条命令全部通过**，包括 134 项旧 eval 自测与完整 126 次模块矩阵、84 项当时的 pilot 检查及两项 SDK 演练。快照 SHA `8e4d320197877b8b9a8f9cdf28556373d37119769b6d427d255c488e1c472712`。随后仅加强记录校验并新增一项用量一致性负例，本地重新通过 85 项及两项演练、类型检查、只读重建；没有把该最终小改声称为已重新跑完整隔离快照。不是远端 CI。
- 公开批次按严格 schema 落盘，且未发现 synthetic 凭据 canary、URL、认证 header 等文本。未读取真实凭据或私人小说。

开发中有协议/索引联调失败及并行编辑触发 `PILOT_SOURCE_DRIFT` 的中止批次，均保留在忽略产物目录，没有混入上述成功结果；旧模块矩阵测试的一次开发复跑也因源码变化中止，不能记作通过。

第三增量结束时仍待：正式 live 启动器、逐请求持久化计量与丢回执保守核算、授权与有效配置冻结。当时未提交或推送。

## 第四增量：受控 Live Broker 与逐请求持久化

2026-09-22。已补齐 `eval:pilot:prepare` / `eval:pilot:live` / `eval:pilot:recover`，以及走同一 broker 路径但只使用合成响应的 `eval:pilot:dry-run`。**本轮真实模型 API 调用为 0，没有执行真实 prepare/live，也没有读取用户模型配置或凭据。** 未改生产 UI、私人小说、全局 Pi 设置，未 commit/push。

### 实现与边界

- 精确 live manifest SHA + 明确接受费用未知后才允许 live；24 小时过期，dry-run 不可升级为 live。启动器先在无凭据的离线进程中验证批准，再读取选定认证引用；broker 再次验证。模型、源码、fixture、设置/提示指纹、兼容参数和限额均冻结。
- 实际有效兼容设置依据固定 SDK 解析后冻结，避免用隔离占位 URL 时触发不同自动探测；有效 system 指纹规范化临时项目路径和当前日期，每次 provider 调用前复核。实际安装 SDK 版本必须为 0.63.1。
- SDK worker 没有真实 key/endpoint，启动前加载网络与子进程阻断；单一 broker 负责固定 HTTPS 出站、跨任务 gate、SSE/usage 核验和 durable Journal。保留明确边界：受信代码纵深防护，不是 OS 沙箱或供应商内部调用审计。
- 派发前 `reserve + fsync`，响应核验后 `settle + fsync` 才交给 SDK。永久 claim、不可 reset、失败不退额；未结算的预留恢复为 unknown，缺失用量不填 0。两个任务最多 8 次客户端请求，每任务最多 4 次，未知费用始终 `null`。
- task 公共记录只保存固定检查项、数字与文件 SHA；Journal 哈希链 + result index 可只读重建。provider 原始 usage 与 SDK 标准化 usage 分栏，不把缓存/推理算术强行合并。只读 recover 不调用模型、不重试、不改记录。

### 最终本地检查

- `npm run test:pilot`：模型 15、transport 33、usage 13、旧 records 8、worker guard 4、SDK 27、manifest 15、Journal 7、私有配置纯函数 14、live records 8，合计 144；另有内存 HTTPS adapter 检查 20、broker 故障/恢复/授权检查 10，共 **174 项检查通过**。
- 旧 SDK rehearsal 2/2 通过；新 broker dry-run 2/2 通过。各成功路径分别有 6 次内存模拟请求；额外网络/缺失 usage 故障各仅 1 次模拟尝试，随后停止。**这些不是模型自主表现、真实 token 或费用数据。**
- 新 broker 批次：`artifacts/harness/live-pilots/dry-run-tYrnYR/`；manifest SHA-256：`5c4dc95d40855739c976521200388edd81ab012fd01c8881ad5d51bb55cea623`。
- 旧演练批次：`artifacts/harness/pilot-rehearsals/rehearsal-ziYnRU/`；manifest SHA-256：`9f6390dff820c93d06e9f4f7463b3ede7d9b3d0f9e99b1765e011aad0647c389`。
- 新批次 18 个公共 JSON 文件：只读恢复前后 SHA 清单一致，恢复结果仍为两任务通过、真实派发 0 / 模拟 6；未检出 URL、认证 header、合成凭据 canary 或原始错误 canary。
- `check` / `check:harness-tests` 通过，既有 Harness 224 项 × 3 轮通过，`git diff --check` 通过。
- 额外通过启动器负例：把 dry-run SHA 交给 live 命令时，先报 `LIVE_AUTHORIZATION_REJECTED`，不会访问作为占位参数的不存在的私有配置、更不会出网。
- 最终源码的独立未提交快照包含 **379 个文件**，全新 `npm ci` 后 **9 条命令全部通过**：类型检查、224 项 × 3 轮 Harness、长程、小说域、前端构建、旧 eval 矩阵及本轮 174 项 pilot 检查/模拟流程。快照 SHA-256：`0fccb915b1e1d3a5978499a96a81232bd92f378075fdb15aabafd257c8d29a9f`；日志与清单在 `artifacts/harness/isolated-summary.json` 和 `isolated-*.log`。随后仅写回本节证据记录；这不是远端 CI、Linux 实测或已提交 clean clone。构建保留已有动态导入/包体积警告。

开发中因并行编辑出现一次 `PILOT_SOURCE_DRIFT`，冻结源码后完整复跑通过；失败批次未计入通过结果。没有做真实断电或完整 OS 故障注入，durable reserve 恢复与网络/usage 故障测试不能替代这些证据。

下一步是核对真实配置并 prepare 当批清单，再确认 `gemini-proxy / gemini-3.8-flash-high`、两项公开任务、最多 8 次 HTTP、费用未知后执行。真实 provider 连通性/usage、真实模型质量、公平全栈消融、原生 Desktop 发布验收和 Phase X 均未完成，不能据此宣称整个 Phase 5 已完成。

## 第五增量：本机 HTTP 兼容与真实配置 prepare

2026-09-22。首次只读真实配置时发现选定代理使用本机 HTTP，旧 broker 的 HTTPS-only 检查使 prepare 在派发前拒绝，未生成 live 批次，也不是认证失败。经用户同意后补齐最小兼容；未改地址、key 或全局 Pi 设置，未修改私人小说，未 commit/push。

### 兼容与离线验证

- 保留 HTTPS，额外只允许字面 `localhost`、`127.0.0.1`、`[::1]` 的 HTTP。投影原始 URL 和 broker 两处校验，拒绝远程/局域网地址、IPv4 数字别名、百分号编码主机名、反斜线变体、URL 凭据/query/hash。`localhost` 固定解析到 `127.0.0.1`，不使用 DNS 或地址 fallback；冻结协议、主机、端口、路径，仍禁止重定向。
- `npm run check`、`npm run check:harness-tests`、`git diff --check` 通过。
- `npm run test:pilot`：模型 15、transport 33、usage 13、旧 records 8、worker guard 4、SDK 27、manifest 15、Journal 7、私有配置纯函数 35、live records 8，加上内存网络 adapter 61、broker 故障检查 10，合计 **236 项检查通过**。
- 旧 SDK rehearsal 2/2、新 broker dry-run 2/2 通过，各有 6 次内存模拟请求；真实请求为 0。broker 批次 `dry-run-mzttXb`，manifest SHA `e67ba1cb8147ff70a2d27e2848187dd328da8512154e167b1a767c347a82a272`；旧演练批次 `rehearsal-fjTof5`。
- 本次未重跑第四增量的 379 文件/全新依赖隔离回归，不将上节旧快照证据冒充本次代码已做的验证。以上网络 adapter 测试使用纯内存 fake，没有创建真实 socket。

### 已准备、未调用的真实批次

- 命令：`npm run eval:pilot:prepare -- "C:\Users\Silence\.pi\agent\models.json"`，通过。过程受离线网络阻断器保护，只读配置和准备 SDK，不执行 prompt 或解析认证凭据。
- 目录：`artifacts/harness/live-pilots/live-CwHPbD/`；只有 `manifest.json`，没有 claim、Journal 或请求记录。
- manifest SHA-256：`932c097373b908e4bac720a47c5db666e2a10cd01eeefb95e6640b013abec3e5`。
- 冻结源码/依赖指纹共 55 项，源码摘要：`88247bc5b9d1373ec857638fae2409dab1152d568fd375ac1c244d4a067a6f93`。
- 精确模型 `gemini-proxy / gemini-3.8-flash-high`，API `openai-completions`，工作窗口 262,144；pilot 每请求最大输出 2,048，wire 字段 `max_completion_tokens`，`thinkingLevel: off`。
- 两项合成任务 `P5P-READ-001` / `P5P-WRITE-001`，每项最多 4 次、总共最多 8 次 HTTP；费用未知 `null`。不改私人小说或 Canon。
- 有效期至 `2026-09-23T04:27:08.464Z`，即北京时间 **2026-09-23 12:27:08**。代码/有效配置漂移或过期须另建清单。
- 模型配置原文件在 prepare 前后 SHA 完全一致；manifest 字节 SHA 已读回核对，未检出 URL、认证 header/key 字段或合成凭据 canary。未输出真实密钥或代理地址。

本批 **真实 HTTP 为 0**；prepare 成功不代表代理连通、密钥有效或真实 usage 格式已验证。下一步须由用户明确批准此清单的模型、两任务、最多 8 次 HTTP 与费用未知，才可执行 live。Phase 5 仍未全部完成。

## 第六增量：首批真实 Pilot，答案校验失败后停止

2026-09-22。用户明确回复“批准”，授权上节 `live-CwHPbD` 清单对应的精确模型、两项任务、最多 8 次 HTTP、每请求输出 2,048 和费用未知。运行前复核清单 SHA 一致、未过期且未被 claim；执行一次 `eval:pilot:live`，未重试、未更换模型、未重新 prepare 或创建其他真实批次。

### 真实结果

| 项目 | 结果 |
| --- | --- |
| 模型 | `gemini-proxy / gemini-3.8-flash-high`，`openai-completions` |
| 批次 | `live-CwHPbD`，原 manifest SHA `932c097373b908e4bac720a47c5db666e2a10cd01eeefb95e6640b013abec3e5` |
| 客户端真实请求 | **3 / 8**，全部属于 `P5P-READ-001` |
| 响应及记录 | 3 个 reserve + 3 个 complete settle；未知派发 0，模拟请求 0 |
| 读取任务 | `fail / MECHANICAL_CHECK_FAILED`；唯一失败的 SDK 检查为 `finalAnswer` |
| 写入任务 | `blocked / BATCH_ABORTED`；请求 0，未创建探针文件 |
| 批次状态 | `incomplete`，Journal `aborted`，结果索引已封存；不是通过 |

读取任务的角色绑定、隔离设置、扩展、工具白名单、文件证据、工具结果和正常停止检查均通过；`read_story_document` 与 `get_context_budget` 各成功一次。源码/fixture/文件边界/冻结指纹检查也都通过。唯一项目新增文件是隔离副本中的 `.pi/settings.json`，不是用户的全局配置。

当前答案检查在 `evals/pilot/sdk-session.ts` 中将 `JSON.parse(finalText)`、`canPredictStorm === false`、`signers` 必须严格按 `["记录员", "设备技师"]` 排列合为一个布尔值。因此本次只足以说明最终回答未满足该严格检查，**不能断定是事实错误、JSON 外包了 Markdown 代码块、签字数组顺序不同或其他格式问题**。原始最终回答没有写入公共记录，临时 SDK 会话已清理，不伪造其内容，也不事后放宽规则把此批改为通过。

### 用量及证据边界

- provider 原始累计：`promptTokens=3004`、`completionTokens=74`、`reasoningTokens=371`、`totalTokens=3449`；`cachedTokens=null`（未报告），`costUsd=null`（费用未知）。这些是代理返回的数值，不等同于核验上游账单。
- READ 任务 SDK 标准化累计：input 3,004、output 445、total 3,449；其中 SDK output 包含本次报告的推理用量。provider 原字段保留原样，不用 74 冒充全部输出。WRITE 未执行，故批次 SDK 汇总保守为 `null`，不是 READ 的用量丢失或为 0。
- `thinkingLevel: off` 并未使本次 provider 的 reasoning 计数归零；不将本地设置当作代理上游关闭推理的保证。
- 本地序列化输入估算累计 9,399，输出预留累计 6,144；它们不是实际 token 数或费用。三个响应的用量均在本次上限内，但不能据此保证供应商所有未来响应都会遵守上限。
- 模型配置及全局 settings 在执行前后 SHA 一致。未访问私人小说；原始合成 fixture 校验未变。结束后无 `.pilot-build-*` 临时目录遗留；临时会话/副本由启动器正常清理。
- `eval:pilot:recover` 只读重建得到相同结果；前后 **12 个公共 JSON 文件 SHA 全部一致**。公共产物未检出 URL、认证 header/key 字段及测试凭据 canary。Journal 哈希链和结果文件哈希由重建器复核。

下一步建议先补离线答案诊断：区分 JSON 解析、字段类型/取值、签字成员和顺序等固定原因，不保存完整回答或思考；同时对照预登记任务澄清纯 JSON/数组顺序要求。此批失败记录保持不变。任何代码/提示/验收规则修改后都须另建清单、重新批准真实调用；不能用尚余 5 次额度自动续跑。真实写入任务、整体 pilot、正式全栈消融和原生 Desktop 验收仍未完成。本轮未改生产代码、未 commit/push。

## 第七增量：答案细分诊断与新版零请求准备

2026-09-22。经用户同意补细分诊断和离线测试，**本轮新增真实请求为 0**。修改仅涉及 pilot 工装/测试/文档；未更改生产小说扩展、私人小说或全局 Pi 设置，未 commit/push。

- 新增纯函数 `evals/pilot/answer-diagnostics.ts`。区分空回答、Markdown 围栏、非法 JSON、非对象 JSON、字段缺失、类型错误、事实值错误、签字成员错误、签字顺序错误及 WRITE 的 `ready` 不匹配；未运行的任务明确 `ANSWER_NOT_EVALUATED`。只输出固定枚举，最多两个原因，不保存模型文本、解析出的字段值、未知字段名或解析异常原文。
- 保留原来的严格判定：不剥离围栏、不修复 JSON、不重新排序签字数组，不对原失败批次改判；READ 的额外 JSON 字段仍按旧规则容忍。用原实现作为离线对照，覆盖命名样例及 54 个字段组合，检查布尔判定一致。
- 仅澄清 READ 提示词：最终只返回 JSON 对象、不加 Markdown/说明，签字职能按源文件的出现顺序列出。不把答案值提前写入提示词。提示 SHA 已改变，因此不能使用旧清单或旧授权发请求。
- SDK summary、worker IPC、新版 broker task record V2、封存索引与 recover 输出贯通保存 `answerDiagnostic`。记录校验拒绝任意文本、跨任务/矛盾原因和与 `finalAnswer` 布尔不一致的诊断。历史 V1 记录保持可读，不凭空补诊断；旧 rehearsal 记录格式未改。

### 验证结果

- `npm run check`、`npm run check:harness-tests`、`git diff --check` 通过。
- `npm run test:pilot`：答案诊断 55、模型 15、transport 33、usage 13、旧 records 8、worker guard 4、SDK 33、manifest 15、Journal 7、私有配置 35、live records 15、网络 adapter 61、broker 故障 16，合计 **310 项检查通过**。
- 旧 SDK rehearsal 2/2、新 broker dry-run 2/2 通过，分别 6 次内存模拟请求，真实请求 0。批次分别为 `rehearsal-ZbDAH7`、`dry-run-IsteGj`；后者 manifest SHA `8b48a9d3fdd6507a5395d1c12ffa94c43d833a8db232ecf1b8a25fef4b7ff6ca`。
- 合成围栏故障 `dry-run-E6TzUt` 经真实 SDK 序列化/SSE parser、IPC、Journal、V2 记录与只读重建，准确得到 READ `ANSWER_MARKDOWN_FENCE`、WRITE `ANSWER_NOT_EVALUATED`，只派发 3 次模拟请求，无重试或写入。该合成案例不是旧真实批次失败原因的证据。
- 用新版读取器重建旧真实批次 `live-CwHPbD`，仍为 READ fail、WRITE blocked、3 次真实请求、整体 incomplete；前后 **12 个文件 SHA 全部一致**。旧 V1 成功 dry-run `dry-run-mzttXb` 也仍为 pass，不补充历史不存在的诊断。
- 本次成功 dry-run、围栏故障、新 manifest 共 31 个公共 JSON 文件扫描通过，未检出 URL、认证字段和私密文本测试 canary。未重跑全新依赖隔离快照，不将前面增量的隔离回归外推到本次代码。

### 新清单，等待新授权

- `eval:pilot:prepare` 已成功，目录 `artifacts/harness/live-pilots/live-mHOnDl/` 仅包含 `manifest.json`；没有 claim/Journal/请求记录。
- manifest SHA：`f131737c6669d12645e1936b39d75adf448c311316e00adb71b60afee381848d`。
- 57 项冻结源码/依赖指纹，摘要 `654ae789de1215cc10dcfd51264cb138fc9b7523fb92bd9bf7d57f8d35ef9131`。
- 模型仍为 `gemini-proxy / gemini-3.8-flash-high`，两项公开合成任务，每项最多 4 次、该新批总计最多 8 次 HTTP，每请求最大输出 2,048，费用未知。
- 有效至北京时间 **2026-09-23 12:47:16**（`2026-09-23T04:47:16.997Z`）。prepare 不解析认证、不发请求；前后模型配置和全局 settings SHA 一致。

旧批已经封存；此新批需用户重新批准，不能借用旧批剩余次数自动执行。真实写入能力、整个 pilot 与 Phase 5 仍未验收通过。

## 第八增量：新版最小真实 Pilot 通过

2026-09-22。用户明确批准 `live-mHOnDl` 清单对应的模型、两项任务、每项最多 4 次/新批最多 8 次 HTTP、每请求输出 2,048 和费用未知。运行前复核清单 SHA 一致、未过期且未被 claim，随后只执行该批一次；**两项任务通过，实际 6 次 HTTP，没有重试或追加请求**。

### 本批证据

- 批次目录：`artifacts/harness/live-pilots/live-mHOnDl/`。
- manifest SHA：`f131737c6669d12645e1936b39d75adf448c311316e00adb71b60afee381848d`；模型为 `gemini-proxy / gemini-3.8-flash-high`，API `openai-completions`。
- `P5P-READ-001`：**pass**。3 次真实请求；实际读取公开合成世界规则、获取会话预算，两次工具调用成功；最终 JSON 满足原来的严格事实值和签字顺序检查，诊断 `ANSWER_OK`。
- `P5P-WRITE-001`：**pass**。3 次真实请求；仅在隔离副本中新建并读回 `drafts/candidates/pilot-probe.md`，内容 SHA `55a310bce4e4873eba6afc57b2efd9175b540484b1aa450f5c678b64dc9d1b71` 与 `phase5-pilot: ready` 加一个换行完全一致；最终回答 `ready`，诊断 `ANSWER_OK`。
- 两项任务的 5 个 broker 检查及 8 个 SDK 检查全部为 true，包含源码、fixture、隔离设置、角色、工具白名单、文件变化、正常停止、冻结指纹与最终答案。预期基础设施写入仅为各隔离副本中的 `.pi/settings.json`；没有改 Canon 或私人小说。
- Journal：6 个 reserve、6 个 complete settle；每任务 3 次，未知派发 0、模拟请求 0，`outcome=complete`。完整哈希链与 result-index 中的任务文件 SHA 均读回一致。
- `eval:pilot:recover` 只读重建仍为 **pass**；前后 18 个公共 JSON 文件 SHA 完全一致。公开扫描未检出 URL、认证字段或私密文本测试 canary。模型配置与全局 settings 执行前后 SHA 一致；临时副本/会话正常清理，无 `.pilot-build-*` 遗留。

### 代理报告的用量（费用仍未知）

| 任务 | HTTP | prompt | completion | reasoning | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| READ | 3 | 3,687 | 54 | 900 | 4,641 |
| WRITE | 3 | 4,662 | 59 | 480 | 5,201 |
| 本批合计 | **6** | **8,349** | **113** | **1,380** | **9,842** |

以上保留 provider 原始字段。SDK 标准化累计为 input 8,349、output 1,493、total 9,842；本批 output 等于 provider completion + reasoning。provider 缓存字段未报告（`null`），不将 SDK 默认 cache=0 当作其真实缓存数据。`thinkingLevel: off` 下仍有 reasoning 用量；费用保持 `null`，没有核验代理价格或上游账单。

本地输入保守估算累计 25,264，单次最大 5,777；输出预留累计 12,288。这些是客户端预算量，不是供应商实际 token 或费用。

### 结论与下一步边界

可以报告“**当前固定 SDK/生产小说扩展的最小真实读取与受控写入 pilot 通过**”，不能扩展为原生 Desktop 验收、完整创作流程、长程稳定性、质量提升或整个 Phase 5 完成。

前一失败批次 `live-CwHPbD` 的记录保持原样，不能因本批通过反推它一定是围栏错误。两次独立授权批次累计实际请求为 3 + 6 = 9；失败批不混入本批，也不用于计算有意义的模型成功率或改善百分比。

后续建议先整理并冻结当前可复现证据，再确定公平全栈对照的实现范围、任务与预算；正式重复试验需要新的独立方案和授权。本轮仅执行试测并更新结果文档，未改代码、未 commit/push，未自动使用本批剩余 2 次额度。

## 第九增量：当前成果交接与全新依赖回归

2026-09-22。用户同意整理当前成果、准备正式对照范围；本次 **新增真实模型请求为 0**，未读取认证或更改全局 Pi 设置，未提交/推送，也未实现或运行新的全栈变体。

### 本次整理

- 新增 [交接与证据索引](HARNESS_PHASE5_HANDOFF.md)，统一当前状态、封存批次、只读复核命令、后续提交范围和未完成项。
- 新增 [正式对照计划](HARNESS_PHASE5_ABLATION_PLAN.md)：先实现固定 SDK 的 B0-safety-fixed / B1 离线适配与 safety diff 审计，再接 B2/B3。拟定首批成对真实比较为 2 profile × 2 task × 1 repetition、最多 24 次 HTTP；只是候选预算，当前授权次数为 0，必须先完成离线门并另获批准。
- 修正验收/结果入口中“尚未调用真实模型”等过时的全局描述，保留每个历史增量当时的状态；首批负结果不删除、不改判。
- 隔离回归改为每次创建独立 `isolated-run-*` 目录，独占保存逐命令日志、完整 source manifest 和成功 summary；不再覆盖根目录旧证据。失败运行保留日志但不产生成功 summary。新文档加入显式源码快照白名单，未加入用户私有规划/研究文件。

### 当前源码的隔离回归

`npm run test:harness:isolated` 从 **383 个显式文件**复制未提交源码快照，重新 `npm ci` 后 **9 条命令全部通过**：

- TypeScript 生产检查和 Harness 检查通过。
- 既有 Harness **224 cases × 3**，确定性一致；长程 **1 case × 3**，真实模型调用 0。
- 五组小说领域回归通过，包含世界观变更/回退的写入失败场景与公开记忆 fixture 4/4 检索。
- 前端构建通过；仍有既有大 chunk、动态/静态导入混用警告。安装保留 `node-domexception` 废弃及 allow-scripts 待审警告，不自动批准安装脚本或更新依赖。
- Eval 自测 **134 项**（32 schema/aggregate、61 historical、15 long-horizon、3 fault-metrics、23 runner/integrity）；完整 126 格模块矩阵执行，真实模型调用 0。
- Pilot **310 项**：55 answers、15 model、33 transport、13 usage、8 records、4 worker guard、33 SDK、15 manifest、7 Journal、35 config、15 live records、61 network、16 broker faults。SDK rehearsal 与 broker dry-run 各 2/2 pass、各 6 次模拟派发，真实模型请求 0。

可核对的持久记录：

- 目录 `artifacts/harness/isolated-run-sOtF4H/`；9 份命令日志、`source-manifest.json`、`isolated-summary.json`。
- 基点 `d3018347761fa5007b98145a1795d9070318cc00`，Windows / Node `v24.19.0`，依赖全新安装。
- source manifest 内容摘要 `97cd3ea774877aa2545513e200f6dfe3a7a09ca0de278f6b92cfc635b3fe6f3f`（排序路径→SHA 映射的紧凑 JSON 摘要）。
- 私人小说 fixture 和根目录三个用户规划/研究文件均未进入 383 文件快照。临时 checkout 及其中的合成子批次正常清理，仅持久保留本节列出的日志/源码指纹；不把已清理的子目录当作可再次访问的 raw 记录。
- 快照冻结之后只整理说明文档；可执行源码、测试与配置未再变更。仍然是本地未提交源码验收，不是远端 CI、Linux 或原生 Tauri 发布验收。

### 既有证据只读复核

本次重新执行三条 reader 命令并比较目录内全部文件前后 SHA：

| 批次 | 复核结果 | SHA 不变的文件数 |
| --- | --- | ---: |
| `offline-eOyK60` | 126 runs，90 pass、36 unsupported、0 fail，确定性一致；重建 aggregate 与存档一致 | 130 |
| `live-CwHPbD` | 仍为 incomplete；READ fail、WRITE blocked、3 次历史真实派发 | 12 |
| `live-mHOnDl` | 仍为 pass；READ/WRITE 均 ANSWER_OK、6 次历史真实派发、provider total 9,842 | 18 |

共 **160 个文件**未改变；表内 HTTP 数字来自旧 Journal，不是本次发生了请求。文档内部链接检查与 `git diff --check` 通过。下一项代码工作是正式计划 S1 的共用 SDK 适配层，不是立即启动 24 次真实比较。

## 第十增量：同 SDK 的基线/B1 读写切片

2026-09-22。用户同意执行 S1 离线适配；本轮 **新增真实模型请求为 0**，不读取用户模型/认证配置、不修改全局 Pi 设置、私人小说或生产 UI，未 commit/push。详细范围及安全差异见 [S1 说明](HARNESS_PHASE5_SDK_ABLATION.md)。

### 实现与证据边界

- 新增 `evals/sdk-ablation/`，用固定 Pi SDK `0.63.1` 的真正 AgentSession 加载 `sdk-b0-safety-fixed` / `sdk-b1-reliability`。这是 SDK 读写、调用生命周期与作用域对账切片；完整历史 `b0-safety-fixed` / `b1-tool-session` 仍为 `not_implemented`，不冒充 Desktop/Rust/RPC 全栈恢复。
- 原始基线固定到 `3b5f8b06131d46ee0b4b97dd646ba3d6f6bcd887`，两份源码逐字节保存，运行前核对本地 SHA、Git blob 与历史原对象。公共安全包装只补任务必需的工具白名单、元数据合同与路径/链接保护；active-document parser 的历史功能缺陷保留，并有负测试证明。
- B1 使用冻结的 Phase 1 tool runtime / operation ledger，适配只读瞬时重试、写入回执丢失后的文件对账、unknown 写入阻断，以及 project/session/role/generation 迟到结果隔离。共同安全限制不计为 B1 的增益；额外后期钩子/工具注册会被拒绝。
- 故障注入作用于 SDK 完成注册后的真实原生工具 execute。SDK 在当前版本仅按 `createAgentSession({ tools })` 的工具名选择内置实现；入口上未被调用的包装不能作为故障或写入次数证据。
- 回复由确定性脚本提供，完全替代 provider。主负例故意在首次写入成功但回执丢失后，用新 call ID 再写一次；另有直接读回的正向对照，两个 profile 都通过。**不据此推断真实模型必然重写，不报告模型恢复率、质量改善或 token 节省。**

### 最终源码的持久矩阵

`npm run eval:sdk-ablation` 完成固定 2 profile × 2 task × 3 轮，批次为 `artifacts/harness/sdk-ablations/sdk-s1-IRrezl/`，manifest 内容摘要 `d1af61d74e423abca0e548dec9fb92950d75a37138709a3cb413ab89299f9f92`。

| Profile / 任务 | 通过 / 失败 | 合成回复调用 | 实际原生写入派发 | 其中重复派发 |
| --- | ---: | ---: | ---: | ---: |
| B0 safety-fixed / READ | 3 / 0 | 6 | 0 | 0 |
| B0 safety-fixed / TOOL | 0 / 3 | 12 | 6 | 3 |
| B1 reliability / READ | 3 / 0 | 6 | 0 | 0 |
| B1 reliability / TOOL | 3 / 0 | 12 | 3 | 0 |

共 **12 runs，9 pass、3 预登记负例 fail，36 次合成回复调用、0 次真实 HTTP**；四组均三轮确定性一致。B0 的三个 fail 保留原样：仅 `singleWrite` 失败，其他检查均通过，固定内容 SHA 正确；B1 阻止同一意图的额外写入。因为两次写入内容相同，这证明的是重复派发，不是重复正文、重复事实或文件损坏。

只有精确符合预登记条件的这一负例可以继续矩阵。其他失败或安全/角色/文件边界异常均停止后续任务；未执行项为 blocked。缺少 worker 回执时 metrics/usage 为 null，不以零写入或成功掩盖未知副作用；已观测计数不会因后续审计失败被清空。

### 全新依赖隔离回归与只读复核

- `npm run test:harness:isolated`：**397 文件**的未提交源码快照，全新安装依赖，**10 条命令全部通过**。目录为 `artifacts/harness/isolated-run-TRAxlc/`，source manifest 内容摘要 `1f8b4e8f264065584d643ab689b759b754e77360ceba645aeabdb0570e575ead`；基点仍为 `d3018347761fa5007b98145a1795d9070318cc00`，Windows / Node `v24.19.0`。
- 新增 SDK ablation **101 项检查通过**，包含基线 provenance、安全差异、禁止后期能力泄漏、真实 SDK 故障场景、四种迟到作用域、切换后的写入 tombstone、限额/取消/unknown、记录完整性和严格负例继续条件。隔离回归内部也跑完 12 格矩阵；其临时 raw 随 checkout 清理，不当作持久批次引用。
- 既有 Harness **224 cases × 3**、长程 **1 case × 3**、五组小说领域回归、前端构建、Eval **134 项**及 126 格模块矩阵、Pilot **310 项**全部通过；Pilot SDK rehearsal 与 broker dry-run 各 2/2、各 6 次模拟派发，未新增真实调用。
- 安装/构建仍有既有 `node-domexception`、allow-scripts、大 chunk 和动态/静态导入混用警告；没有为消除警告而升级依赖或自动批准安装脚本。远端 CI、Linux、原生 Desktop 和发布包均未在本轮验收。
- 对最终 `sdk-s1-IRrezl` 及两个中间离线批次 `sdk-s1-R2ACPa`、`sdk-s1-rkNf2E` 执行只读 rebuild：三个 aggregate 均与存档完全一致，共 **45 个文件 SHA 前后不变**。公共 JSON 扫描未检出 URL、认证字段和测试私密 canary；这些复核没有调用模型。
- 冻结后先确认 397 项源码 SHA 全部一致，随后仅回填验收/结果说明文档；没有改变已测试的可执行源码、测试或配置。CI 与隔离脚本均加入 `test:sdk-ablation`；这仍是本地未提交源码的验收，不是远端 CI 或 clean-clone 成功声明。

下一步是 S2：先为这个有限 SDK 切片实现独立的 live 计量、Journal 与批准入口，并完成离线故障测试。S2 尚未实现；候选 24 次真实请求仍未授权，不能复用旧 pilot 剩余额度。B2/B3、原生压缩与完整生命周期、Supervisor/maintenance 独立比较继续保留为未完成项，整个 Phase 5 不在本轮收口。

## 第十一增量：S2 独立实测工装与零请求验收

2026-09-22。用户同意继续实现同 SDK 切片的独立实测入口；**本轮新增真实模型请求为 0**，只运行合成 SSE 和公开 fixture。没有读取用户模型/认证配置、准备真实清单、修改全局 Pi 设置、生产 UI 或私人小说，未 commit/push。实现与命令见 [S2 说明](HARNESS_PHASE5_SDK_LIVE.md)。

### 已实现

- 新增 `evals/sdk-live/`，保留真正的 SDK provider 调用循环、序列化和 SSE parser；通过独立父进程 broker 计量 HTTP 派发。真实入口没有固定回复，合成回复只由 dry-run 显式选择。
- 独立任务版本 `sdk-read-write-v2`、driver `provider-selected-tools-v1` 和四项交错顺序；相同任务的模型、业务提示、有效系统提示、工具、故障和预算相同。临时项目路径和当前日期规范化后核对系统提示 SHA；每次实际请求另存序列化 body 的 SHA，不存原文。
- S1 原始基线、安全包装和 B1 工厂不变。旧 pilot 的 transport/Journal 抽到公共 `evals/core/request-*`，旧入口仍锁定原两个 task、4/8 次额度和原 Journal 身份；新入口另绑四个 run ID、每项 6 次/总计 24 次及独立 namespace。
- 新清单冻结源码/依赖指纹、Git HEAD、fixture、SDK/Node/平台、模型参数、prepared 指纹、任务/故障/评分/停止版本、预算与有效期。批准要求精确 SHA 和费用未知确认；dry-run、旧 pilot、过期、已 claim、来源/环境漂移均不能进入真实请求。
- worker 无真实 URL/密钥，只经 IPC 发送受限 body。父进程在派发前同步落盘 reserve，完整响应与有效 usage 同步落盘 settle 后才交回 SDK；失败不退还次数，崩溃后不自动续跑。
- 普通业务失败保留并继续冻结顺序；安全违规、用量缺失、未知结果、限额或来源漂移停止批次。缺失回执为 null/unknown；已观察到的计数不会在后续审计失败时被清零。答案和异常只转成固定诊断码。

### 最终源码的八个离线批次

这些是工装测试，不是模型试验；不计算模型成功率、恢复率或收益百分比。下表请求都是内存合成响应，经真正 SDK/parser、IPC、计量和 Journal 完成。

| 场景 / 批次 | 结果 | 模拟派发 | 关键证据 |
| --- | --- | ---: | --- |
| 读回 `s2-dry-mQwGip` | pass，4/4 | 10 | B0/B1 均读取；两次写入任务各派发一次并读回 |
| 重放 `s2-dry-ddGG9x` | completed-with-failures | 12 | B1 TOOL 一次派发；B0 TOOL 两次派发，保留 fail |
| 答案格式 `s2-dry-6kNpKm` | completed-with-failures | 10 | 首项 ANSWER_MARKDOWN_FENCE，后面三项按计划通过 |
| 网络失败 `s2-dry-Gtp2i9` | incomplete | 1 | 首项 unknown，剩余 blocked；usage/worker metrics 为 null |
| usage 缺失 `s2-dry-P4uKnP` | incomplete | 1 | 不交付未计量响应；保留一次未知派发 |
| 越界路径 `s2-dry-TXs4ea` | incomplete | 1 | SAFETY_STOP，原生写入 0，后续 blocked |
| 禁止工具 `s2-dry-ydNYkS` | incomplete | 1 | 不执行 bash；SAFETY_STOP，后续 blocked |
| 请求限额 `s2-dry-cUKwO7` | incomplete | 6 | 第七次不派发，保留已观察到的六次回复/读取计数 |

最终读回批次 manifest SHA：`1bc1f84e93b3758eb3bb896f4c9827a3240a1f4a007abe9d86165f1afbdd3f22`。重放批次 SHA：`af850fc2abc26085e2ec906c004d4ff6b72bcd13069165da4e3bbecb453dbd92`。其余 SHA 保存在各批不可变 manifest 与 aggregate 中。

八批共 42 次模拟派发、0 次真实 HTTP。usage 明确标 synthetic；示例的 provider cache/reasoning 未报告，保留 null，不把 SDK 默认 cache=0 当作供应商报告。费用全部为 null。

开发早期 `s2-dry-IIm9sa` 因 worker 引用迁移遗漏而 incomplete，模拟派发为 0，记录保留；修复后创建新批，不改判旧记录。它不是模型失败，不计入最终源码的八场景验收表。

### 回归与持久证据

- `npm run test:sdk-live`：**95 项检查通过**。除上表端到端场景，还覆盖分 run/24 次总额度、旧 pilot 上限不变、策略不可被修改、派发前/响应交付前 Journal 失败、在途取消、三级超时、输入/输出/model/endpoint 预检、崩溃 pending reserve、独占 claim、跨 namespace、批准/过期/漂移、未知字段/私密 canary、防伪 PASS 和记录缺失/重复/哈希链损坏。入口另运行原有网络适配器 61 项检查，不宣称是新增的不同场景。
- `npm run test:harness:isolated`：**411 文件**的未提交源码快照，全新依赖安装，**11 条命令全部通过**。目录 `artifacts/harness/isolated-run-cH7dYX/`，source manifest 内容摘要 `14c4bfe1d958be86cc81c9e16d6a6865cbbcb70db8f988cdb455157c887c2ae3`；基点 `d3018347761fa5007b98145a1795d9070318cc00`，Windows / Node `v24.19.0`。
- 生产/Harness TypeScript、Harness 224 cases × 3、长程 1 case × 3、五组小说领域回归、前端构建、Eval 134 项及 126 格矩阵、Pilot 310 项、S1 101 项和 S2 95 项均通过。隔离目录的子批次随临时 checkout 清理，持久 raw 引用使用上表工作区批次，不引用已删除的临时产物。
- 八个 S2 批次全部只读 recover，aggregate 与存档一致，共 **156 个 JSON 文件 SHA 不变**，扫描未检出 URL、认证字段或私密测试 canary。新 reader 还重建旧 `live-CwHPbD`（仍失败/阻塞、历史 3 HTTP）、`live-mHOnDl`（仍通过、历史 6 HTTP）和 `sdk-s1-IRrezl`（仍 9 pass、3 预登记 fail），共另 **45 个文件 SHA 不变**；复核没有重发请求。
- 411 项冻结源码在回归后逐项一致，随后仅回填验收/结果说明文档。没有升级依赖、自动批准安装脚本或改变全局配置；保留既有安装/构建警告。`git diff --check` 与文档链接核对通过。CI/隔离脚本已接入新入口，但尚无远端 CI、Linux、原生 Desktop 或发布包验收结论。

本增量交付为“**S2 实测工装已完成离线验收**”，不能称“S2 真实比较已通过”。下一步先核对模型配置、生成新批清单，展示精确 SHA、有效期、4 项运行/最多 24 次 HTTP、输出 2,048 和费用未知，再取得当批批准。没有可复用的旧额度，也没有自动创建待执行任务。S3/B2/B3、原生压缩与更大生命周期对照仍未实施，整个 Phase 5 未完成。

## 第十二增量：S2 真实批次清单已准备，等待批准

2026-09-22。用户同意核对配置并准备清单。通过 `eval:sdk-live:prepare` 只读投影本机模型配置、隔离加载四个 SDK profile/task 组合；**没有解析密钥或调用真实模型**，没有 claim、Journal 或请求记录，未 commit/push。

- 批次目录：`artifacts/harness/sdk-live/s2-live-RGcvnD/`，仅有 `manifest.json`。
- manifest SHA-256：`470d9fe6e553df8321362a8837923493aad6c8a9dc7a96a06c1224b47eba2d58`。
- 47 项冻结源码/依赖指纹，内容摘要 `7040423b274ec0868e5eebcf1991a5d09c8fb0691aeadf8dfe243d91976a6bf3`。准备前核对 411 文件隔离回归快照，差异仅为上轮回填文档，可执行文件未漂移。
- 精确模型：`gemini-proxy / gemini-3.8-flash-high`，API `openai-completions`，工作窗口 262,144，输出上限 2,048；当前有效输出字段为 `max_completion_tokens`，配置投影 `reasoning=false`，thinking 为 off。没有实际探测端点或验证凭据，不能据准备成功断言调用一定成功。
- 固定顺序：READ B0 → READ B1 → TOOL B1 → TOOL B0；4 项运行，每项最多 6 次、全批最多 24 次 HTTP，并发 1。只操作公开合成项目的临时副本，不触碰私人小说。
- 每请求完整输入估算上限 32,768、输出参数 2,048、安全余量 4,096；批次输入估算预留 786,432、输出预留 49,152。估算不是真实 token；费用未知，代理内部行为不可由客户端保证。
- 请求/任务/批次超时为 90/360/1,440 秒。自动重试、压缩和命名均关闭。普通任务失败保留并继续计划；安全、unknown、用量缺失、漂移或额度问题停止后续，不补跑。
- 创建时间 `2026-09-22T09:37:19.548Z`；有效至北京时间 **2026-09-23 17:37:19**（UTC `2026-09-23T09:37:19.548Z`）。过期或冻结项改变须重新准备、重新批准。

只读 recover 返回 `prepared`、`realHttpDispatches=0`、`indexed=false`，重建前后清单 SHA 一致，目录仍只有清单。公开 JSON 未检出 URL、认证字段或私密测试 canary；本机 `models.json` 和全局 `settings.json` 前后 SHA 一致，临时 SDK 构建目录已清理。只更新结果/交接说明，不改执行代码或清单。

**待用户明确批准此精确批次、最多 24 次 HTTP，并接受费用未知后才能运行。** 本次“可以准备”不视为实际派发授权；旧 pilot 额度也不能复用。

## 第十三增量：S2 首批真实 SDK 成对测试已执行，保留一项格式失败

2026-09-22。用户在确认本批清单与参考价格后明确批准：“可以，此费用仅作为参考，可以执行”。只执行已准备的 `s2-live-RGcvnD` 一次，顺序、模型、工具、评分和上限均未改变；**4 项运行完成，3 pass、1 fail，10 次真实 HTTP，0 次未知派发，没有重试或追加补跑**。进程正常退出仅表示工装完成，聚合状态为 `completed-with-failures`，不记为整批通过。

### 批次与逐项结果

- 批次：`artifacts/harness/sdk-live/s2-live-RGcvnD/`；manifest SHA-256 为 `470d9fe6e553df8321362a8837923493aad6c8a9dc7a96a06c1224b47eba2d58`。
- 模型：`gemini-proxy / gemini-3.8-flash-high`，API `openai-completions`，SDK `0.63.1`；Windows / Node `v24.19.0`。工作窗口 262,144，每请求输出参数 2,048，`thinkingLevel: off`。上游仍报告 reasoning，不推断上游实际关闭了思考。
- 运行前核对清单未过期、未 claim、HEAD 和 47 项源码/依赖指纹、17 个公开 fixture 文件、运行环境与模型投影；执行后全部冻结指纹再次一致。基点仍是 `d3018347761fa5007b98145a1795d9070318cc00`，未提交源码指纹摘要仍为 `7040423b274ec0868e5eebcf1991a5d09c8fb0691aeadf8dfe243d91976a6bf3`。

| run ID | 状态 | HTTP | 工具调用 | 原生写入 / 重复写入 | 丢回执 | 答案诊断 |
| --- | --- | ---: | ---: | --- | ---: | --- |
| `sdk-b0-safety-fixed-P5A-READ-001-r1` | pass | 2 | 1 | 0 / 0 | 0 | `ANSWER_OK` |
| `sdk-b1-reliability-P5A-READ-001-r1` | fail | 2 | 1 | 0 / 0 | 0 | `ANSWER_MARKDOWN_FENCE` |
| `sdk-b1-reliability-P5A-TOOL-001-r1` | pass | 3 | 2 | 1 / 0 | 1 | `ANSWER_OK` |
| `sdk-b0-safety-fixed-P5A-TOOL-001-r1` | pass | 3 | 2 | 1 / 0 | 1 | `ANSWER_OK` |

四项 broker 的 source/fixture/prepared/boundary 检查全为 true。失败的 B1 READ 已成功读取文件、正常结束、没有写入，SDK 检查仅 `answer=false`：返回内容带 Markdown 代码围栏，不符合冻结的“只返回 JSON”合同。公开记录只保存安全诊断，不保存原始答案；不据此补断围栏内事实已经通过，也不修改本批规则把失败改判成功。

两项 TOOL 都在首次写入成功但回执丢失后，通过普通读回完成验证；各只有一次原生写入、一次回执丢失、零重复写入。最终文件 SHA 均为 `45ba0c95280cf0f38dc3ce67a6d451c25885436c14234f0fcb1e5d2a0ac66379`。B1 的 `reconciledWrites=0`，本轮没有触发其重复写入拦截分支，不能把两项恢复成功解释成该分支带来的收益。

### 用量与参考价格

| 运行 | prompt | completion | reasoning | total |
| --- | ---: | ---: | ---: | ---: |
| READ B0 | 1,945 | 53 | 873 | 2,871 |
| READ B1 | 1,811 | 58 | 747 | 2,616 |
| TOOL B1 | 3,663 | 66 | 519 | 4,248 |
| TOOL B0 | 4,702 | 66 | 877 | 5,645 |
| 本批合计 | **12,121** | **243** | **3,016** | **15,380** |

以上是代理返回的原字段，不是上游账单核验。SDK 标准化 input 为 12,121、output 为 3,259、total 为 15,380；本批 SDK output 等于 provider completion + reasoning，不能仅用可见 completion 代替完整计费输出，也不能把 reasoning 重复累加。本地序列化输入估算累计 37,370、输出预留 20,480，与实际 usage 分列。

用户提供的参考费率为：普通输入 **$0.75 / 1M tokens**、输出 **$3.75 / 1M tokens**、Context Cache 输入 **$0.075 / 1M tokens**。执行前按全批预留量且全部输入不走缓存的假设得出 $0.774144，仅用于批准时预算参考，不是实际账单或硬性金额封顶。

**全部 10 个响应均未报告缓存用量，`cachedTokens=null`，实际 `costUsd=null`，保留“费用未知”。** 不把 SDK 默认的 cacheRead/cacheWrite=0 当作真实缓存用量，不按未知缓存强行生成实际费用；若未来获得可靠计费明细，另做可追溯说明，不改写封存的 provider 原字段。

### 只读复核与边界

- Journal 有 10 个 reserve、10 个 complete settle，`outcome=complete`；raw/result-index/aggregate 与完整哈希链一致。索引完整不等于任务全通过。
- `node scripts/run-sdk-live.mjs recover artifacts/harness/sdk-live/s2-live-RGcvnD` 返回与存档完全相同的聚合；前后 **29 个 JSON 文件 SHA 全部不变**，没有新的请求。
- 公共产物的 URL、认证/原始内容字段与私密 canary 模式扫描未检出命中。仅操作公开合成项目临时副本，没有访问私人小说；本机 `models.json` 和全局 `settings.json` 前后 SHA 一致，`.sdk-live-build-*` 临时目录已清理。
- 本轮未改执行代码、依赖、模型配置或评分规则，仅回填文档，未 commit/push。未重新运行全套离线回归；先前 411 文件 / 11 命令回归为上一增量证据，本轮补充真实运行、冻结指纹和只读恢复证据。

这是两个 SDK profile × 两个公开任务 × 一轮的有限样本；保留普通格式失败，不能据此得出 B0/B1 总体优劣、可靠性改善、token 节省或创作质量结论。批次已永久 claim/封存，剩余 14 次额度不能复用。下一步仍按 S3 分增量接入 B2/B3 与原生压缩的离线测试；新的真实样本或摘要请求须另建清单、另获批准。整个 Phase 5 和原生 Desktop 发布验收仍未完成。

## 第十四增量：S3 上下文与原生压缩恢复的限定离线 SDK 测试

本轮授权用于 S3 首个离线增量，没有发起新的真实模型请求、读取用户认证或改动私人小说。新增 `evals/sdk-context/`、`tests/sdk-context/`、独立 runner、npm/CI/隔离回归入口；未修改生产前端、Rust bridge 或生产扩展逻辑。设计与命令见 [S3 说明](HARNESS_PHASE5_SDK_CONTEXT.md)。

### 实现与证据边界

- B1 原样复用 S1 的可靠性扩展；B2 接冻结 Observation/完整请求预算工厂；B3 再接冻结检查点/来源版本/失效工厂。历史工厂按 Git 对象和字节 SHA 审计，新增接线为 eval-only adapter，不冒充原始完整历史 Desktop。
- `checkpoint-runtime.ts` 与 Phase 3 `828d36d9c0f3140c750616b97e7d7e92287e6444` 的源码 SHA 一致，固定为 `9117d598d4cf13fe473794610749e2437a30927c20340b0cb34d7cac7b36cb4e`；增加显式 LF 属性以保持 Windows 检出时的原字节。Supervisor/maintenance 未混入 B3。
- 真实启动固定 SDK `0.63.1` 的 AgentSession，由其分派工具、手动执行原生 `session.compact()`，`fromHook=false`。摘要来自同一 API registry 的本地固定提供器，分别计数普通请求和 native 摘要，不替换 SDK compaction，也不测试 LLM 摘要质量。
- 压缩前后是两个独立子进程，后者 `SessionManager.open()` 读取实际 SDK 会话文件。中间只修改临时合成来源；检查点从 custom entry 恢复，而旧 Observation 不跨进程持久化。B3 拒绝陈旧来源写入及“只 refresh 不重读”，重新读取当前来源并刷新后才放行。
- 请求预算检查完整合成 JSON（system/tools/messages/附加字段），单位为 UTF-8 字节估算，产品上限 16,384，输出预留 1,024、安全余量 512。外层每阶段另有 128 KiB、16 个请求、16 次工具、45 秒上限；外层安全不算作 B1 产品能力。原生摘要不走普通 Agent 的同一个预算 hook，但受同一本地提供器的外层计数和限额约束。
- worker 只继承白名单环境，Pi 设置、会话和假认证都在临时目录；自动重试、自动压缩和全局资源发现关闭。网络/子进程 guard 是纵深保护，不是操作系统沙箱。

### 冻结矩阵与机械结果

产物目录：`artifacts/harness/sdk-context/s3-offline-L8cMsW/`。

- manifest SHA-256：`fd1459faa1363d169954ba7c6549e69bdd51fb556758cbbfcb0e7e13a6fab8c7`。
- 可执行源码/依赖映射摘要：`b9a2188dec2c9ff276953c825942afea73dbe7b81e16f633a6d48ea4ceaeb00f`，共 36 个文件或依赖树指纹；与下方 421 文件隔离快照不是同一个摘要口径。
- 3 profiles × 3 tasks × 3 repetitions，按预登记交错顺序完成 27 格，**15 pass、12 缺能力负例 fail、0 unknown、0 blocked**。负例保留为 fail，不改成 pass 或从分母删除。

| Profile | 大工具结果（3 轮） | 完整请求预算（3 轮） | 原生压缩/跨进程/来源变更（3 轮） |
| --- | --- | --- | --- |
| `sdk-b1-reliability` | 3 fail：内联结果超产品预算 | 3 fail：缺少产品预算门 | 3 fail：缺少陈旧来源写入门 |
| `sdk-b2-context` | 3 pass：短引用与按需分页 | 3 pass：拒绝超限请求 | 3 fail：缺少陈旧来源写入门 |
| `sdk-b3-checkpoint` | 3 pass | 3 pass | 3 pass：先阻止、重读/刷新后恢复 |

矩阵共派发 **108 个本地合成普通请求、9 个本地合成摘要请求**；另有 **6 个请求被产品预算阻止、9 次实际 SDK 原生压缩、9 次实际跨进程重开**。这不是 117 次真实 HTTP；真实模型/HTTP 派发均为 **0**。各结果的 provider usage/cache/费用均为 null，内部合成 usage 常量不用于成本、节省率或模型效果结论。工具接口不同会改变固定脚本所需请求数，不能直接比较为效率收益。

### 回归、负例与封存检查

`npm run test:sdk-context` **103 项检查通过**：历史来源、工具/事件能力泄漏、分页边界、跨项目/会话/角色观察拒绝、来源失效、新进程旧观察 ID 拒绝、完整载荷预算、网络/子进程隔离、来源不变/丢失、损坏检查点、摘要错误/真实取消/限额、三轮矩阵及严格重建。损坏/漂移记录不能伪造 PASS；后续失败保留已观测的前阶段计量，不用 null 或零擦除。

首轮全新依赖隔离回归 `artifacts/harness/isolated-run-WctBlp/`：421 文件，12 条命令（含 `npm ci`）全部通过，source manifest 内容摘要 `5841bd72ecdae81a83589e96f8c6889d47ef0a038e39a6ce3af6da971edf4371`。该快照早于最终新增的 LF 属性；原始证据保留，不冒充最终配置快照。

最终配置重新执行 `npm run test:harness:isolated`，证据位于 **`artifacts/harness/isolated-run-fGnALF/`**：421 文件、全新依赖、12 条命令全部通过，source manifest 内容摘要 **`77f94e2cf871b02f6f131a6c64b1c53506bad852c6c5eae0539d412f2884f694`**。包括生产/Harness TypeScript 检查、Harness 224 项 × 3 轮、独立 long-horizon、5 组小说域回归、前端构建、模块 eval、Pilot 310 项、S1 101 项、S2 95 项与 S3 103 项检查。此后仅回填结果与交接文档；执行代码、测试、依赖和配置与最终快照一致。证据是本地未提交源码的独立快照，不是远端 CI 或已提交 clean clone。

S3 的 manifest/raw/index/aggregate 可只读重建；30 个 JSON 产物重建前后 SHA 一致，未改写已封存结果。URL、认证/原始内容字段及私密 canary 模式扫描未检出命中。旧 `s2-live-RGcvnD` 只读恢复仍为 3 pass、1 fail、历史 10 HTTP，29 个 JSON 产物 SHA 不变，没有新增真实调用或重用剩余额度。

本轮未 commit/push。这里只完成 S3 的**首个限定离线增量**：SDK 自动压缩触发、多轮自动恢复、完整 unknown-write 跨压缩生命周期、真实摘要/模型、Supervisor/maintenance 独立对照、Rust/RPC/原生 UI 及人工创作质量仍未验收。下一步可先补这些离线边界，或建设同时计量普通请求与摘要的独立真实工装；新真实批次仍需冻结新清单并另获批准，不能从合成结果推导模型收益。整个 Phase 5 未完成。

## 第十五增量：S3 自动压缩与未知写入恢复的离线 SDK 补充

本轮延续用户批准的两类离线补测，**真实模型/HTTP 调用为 0**；未更改生产前端、扩展、Rust bridge、私人小说、全局 Pi 设置或认证，未 commit/push。实现见 [生命周期说明](HARNESS_PHASE5_SDK_LIFECYCLE.md)。旧 v1/S2 策略和封存产物不改写。

### 新增能力与测试边界

- `lifecycle-*.ts` 使用固定 SDK 0.63.1 自动压缩入口：由 `session.prompt()` 收到合成高 usage 或 overflow，SDK 自行触发 native compaction。没有手动调用 `compact()`、替代 summary hook 或私有压缩入口；`fromHook=false`。普通回答与摘要均来自本地固定提供器，合成 usage 只用于触发，不能当真实用量。
- 真实 SDK 阈值压缩连续两轮后能继续低用量对话，不自动重发；overflow 路径自动压缩后只 continuation 一次，再 overflow 时停止。摘要请求与普通请求共同受本地外层上限约束、分别计数；并发摘要先预留额度再 await。
- `sdk-b1-reliability` / `sdk-b2-context` 扩展源码原样复用。新 `sdk-b3-checkpoint-ops-v2` 明确增加 eval-only durable operation 接线，使用原字节 Phase 3 checkpoint runtime，不混入 Supervisor/maintenance，也不冒充原 v1 profile。
- 每次实际派发写工具前，读回 SDK 会话文件中的 issued/dispatched 意图。工具错误保持错误，unknown 随 checkpoint 跨压缩和进程退出。新进程按 expected post-hash 对账：写成则 completed 并拒绝重放；部分或无目标文件则保持 unknown，refresh 后仍拒绝重放。
- 意图持久化失败时零写入；结果持久化失败时保留已落盘的 issued/dispatched 状态，重开后仍对账/阻止。故障注入只修改公开合成 fixture 的临时副本，不访问私人小说。

### 最终冻结矩阵

目录：`artifacts/harness/sdk-context/s3-lifecycle-b8USvY/`。

- schema v2，manifest SHA-256：`00a8069c47b5c6fada72279acac0a67de4097bfb13a5eb54c2cfcb8cadfd958a`。
- 可执行源码/依赖映射摘要：`9fd60e6ca88e768ce168f0cfe94e9b4884fe14b01cc06023be9c777d3a5d951d`，43 个源码或依赖树指纹。
- 3 profiles × 6 tasks × 3 轮，**54 格：30 pass、24 预登记缺持久化能力负例 fail、0 unknown、0 blocked**。

| 任务（每 profile 3 轮） | B1 | B2 | B3 checkpoint-ops-v2 |
| --- | --- | --- | --- |
| 自动阈值压缩（两次） | 3 pass | 3 pass | 3 pass |
| overflow 自动压缩/一次续跑 | 3 pass | 3 pass | 3 pass |
| 写成但回执丢失 | 3 fail：进程重开后重复派发 | 3 fail：同左 | 3 pass：对账，零重复派发 |
| 部分写入且回执丢失 | 3 fail：盲目重写 | 3 fail：同左 | 3 pass：保留未知并阻止 |
| 无落盘结果且回执丢失 | 3 fail：盲目重写 | 3 fail：同左 | 3 pass：保留未知并阻止 |
| 先压缩，再写入/丢回执，再压缩 | 3 fail：重复派发 | 3 fail：同左 | 3 pass：多边界后仍去重 |

固定矩阵记录 **363 个本地合成普通请求、72 个本地合成摘要请求、72 次自动 native compaction、36 次独立进程重开**。未知/失败非预登记时停止；上述负例只有完整压缩/重开/派发条件成立时才允许继续，任意其他失败不能套用缺能力标签。

矩阵共 60 次受控写工具派发、39 次目标字节变化。B1/B2 的已完成同字节重写是重复派发，但没有第二次字节变化；部分/无文件的重写会发生额外变化，二者分开记录。B3 的所有四类任务跨进程后均零重复派发，部分/无文件仍是 unresolved 状态，**测试 pass 只表示正确安全阻塞，不是小说任务完成**。

全部 provider usage/cache/费用字段为 null。不能从固定脚本调用数推出模型成本、成功率或 token 改善。三轮是固定机械合同重复，不是独立真实模型样本。

### 回归与只读审计

`npm run check:harness-tests` 通过；`npm run test:sdk-lifecycle` **175 项检查通过**。包括能力清单/源码漂移拒绝、并发摘要总限额、完整载荷大小、AbortSignal、零网络/子进程隔离、阈值/overflow 摘要失败与取消/上限、重复 overflow 停机、意图/结果持久化故障、三轮矩阵、部分阶段计量保留、严格负例分类和篡改/伪造 PASS 拒绝。

最终批次保留 57 个 JSON 产物。开发首轮 `s3-lifecycle-w9t2VX` 保留为旧校验器/167 项检查的开发证据，后续强化负例条件和类型检查后才生成上述最终批次，不把两批合并或覆盖旧记录。

全新依赖隔离回归 `artifacts/harness/isolated-run-sJZkbi/`：**429 文件、13 条命令全部通过**，source manifest 内容摘要 `63d13c8c92ba1eb750e136d5f5fdca184c3ca694fe7d59d6d57d7750ce2f5ca5`。包括 `npm ci`、生产/Harness TypeScript、Harness 224 项 × 3 轮、独立 long-horizon、5 组小说域回归、前端构建、模块评测、Pilot 310 项、S1 101 项、S2 95 项、S3 v1 103 项与新增生命周期 175 项。隔离回归后的执行代码、依赖、测试和配置与快照一致，仅回填说明文档；不是远端 CI 或已提交 clean clone。

最终 v2 聚合只读重建一致，57 个 JSON 的 SHA 全部不变；URL、认证/原始内容字段和私密 canary 模式扫描未命中。旧 S2 `s2-live-RGcvnD` 与 S3 v1 `s3-offline-L8cMsW` 同样只读重建，合计 59 个产物 SHA 全部不变；S2 的 10 次 HTTP 是历史记录，不是本轮调用。源码快照未复制三个用户规划/研究文件或私人小说 fixture。`git diff --check` 通过，测试临时目录已清理，公开结果目录保留。

### 尚未覆盖与下一步

这里不是完整历史 Desktop 比较或生产发布验收。任意时刻强杀/断电、后台写入迟到竞态、完整跨项目/角色迁移、真实摘要质量和 provider 隐式计费仍未验收；原生 UI/Rust/RPC、Supervisor/maintenance 独立对照亦未完成。

下一步建议先实现 **同时计量普通请求和原生摘要的 S3 真实工装**，仍先用合成响应检查限额、失败和取消；完成后再冻结最小真实批次及预算，请用户另行批准。当前不产生真实调用授权，旧 S2 剩余额度不可复用，整个 Phase 5 尚未完成。


## 第十六增量：S3 普通请求与原生摘要的统一出口离线预检

本轮实现 S3 真实工装的传输核心，并仅用本地 SSE 验证。**没有 live/prepare/认证入口，没有真实模型请求**；新的 task/profile 接线和逐批真实授权仍需后续实现。本轮不是新的 B1/B2/B3 效果矩阵，不修改生产 UI、Rust、全局 Pi 配置或私人小说，未 commit/push。详见 [传输预检说明](HARNESS_PHASE5_SDK_CONTEXT_TRANSPORT.md)。

### 接线与计量

固定 SDK 0.63.1 的实际 provider registry 包装同时覆盖普通 Agent stream 与原生 compaction 的 `completeSimple()`。真实序列化请求通过 IPC 送父进程，普通/摘要共用额度及 durable reserve/settle Journal；本地模拟响应仍由真实 SDK SSE parser 读取。并发双摘要按 offer 接收、串行派发，输出按请求实际声明的上限预留。共享 transport 的 bounded output 为显式 opt-in，旧 Pilot/S2 的 exact 默认值及 policy 不变。

取消/超时/HTTP 错误/缺失 usage 时停止，已预留额度不退款，等待请求不再派发。该 SDK 的 HTTP 客户端确实会尝试隐式 fetch 重试；测试将它们阻断于 worker 出口，同一调用不能新增父进程请求。SDK 重试尝试与实际模拟派发分开报告。

### 当前冻结证据

以下十个独立探针都通过各自预登记机械合同。目录前缀为 `artifacts/harness/sdk-context-transport/`，不把故障探针的 unknown/stopped 改成模型任务 pass。

| 探针 | 批次 | 本地模拟派发 | 请求结果 |
| --- | --- | ---: | --- |
| `manual` | `s3-transport-Wu2sFH` | 3 | complete |
| `split` | `s3-transport-sYv5iO` | 4 | complete |
| `threshold` | `s3-transport-dyj2YI` | 3 | complete |
| `summary-http-error` | `s3-transport-4Dd1da` | 2 | unknown |
| `summary-missing-usage` | `s3-transport-WNdRS1` | 2 | unknown |
| `summary-cancel` | `s3-transport-aa6KxZ` | 2 | unknown |
| `summary-limit` | `s3-transport-nULWsA` | 1 | stopped |
| `split-limit` | `s3-transport-Y3xWV0` | 2 | stopped |
| `summary-timeout` | `s3-transport-EozVEE` | 2 | unknown |
| `ordinary-cancel` | `s3-transport-aC2Ww8` | 1 | unknown |

这些批次的源码/依赖映射摘要相同：`dc4e7713abbf25769673e9f57e9f9e913a09b3866a92c61ceb97475177cdf311`，39 个源码或依赖树指纹。三个成功路径的 manifest SHA 为：

- manual：`9d96eebfc02bbd0c4e8a618d2ea5379ec024e865c91ff0d87ce7cf1e4fe75fad`。
- split：`169880a67c40ed40b6eb0614eecef0be20e6c741f4318edf97b6fe22f396b09a`。
- threshold：`77d88a1b5f94d726963cf6b669ac18da3c41bffd567182c6f7c109c93074f76a`。

共 22 个本地模拟派发（普通 13、摘要 9），3 次实际 SDK 原生压缩，5 个已派发但未知的响应，10 次被 worker 拒绝的 SDK fetch 重试。双摘要成功探针有 2 个并发 offer，但实际同时派发最多 1 个；两次普通请求预留 4,096，原生 history/prefix 摘要分别 1,638/1,024，总预留输出 6,758。

`syntheticParsedUsage` 只表示 parser 读到的合成值；全部 `providerActualUsage/costUsd=null`，没有实际费用或 token 节省结论。缺失 cache 不补零。开发早期探针目录保留，但不与本次结果合并。

### 回归与边界

`npm run test:sdk-context-transport` **96 项检查通过**；独立 S2 **95 项**回归通过，TypeScript/Harness 类型检查通过。十个批次合计 126 个 JSON 产物逐批只读重建一致，原始请求/摘要/认证信息和私密 canary 模式扫描无命中。历史 S2、S3 v1/v2 的 116 个产物只读重建后 SHA 全部不变，未复用旧额度。

全新依赖隔离回归为 `artifacts/harness/isolated-run-klefWL/`：**439 文件，14 条命令全部通过**，source manifest 内容摘要 `5e87058de2d504c0523bb36515d51eabe46f14ce0d3b26cdf0c16e49a073a09f`。包括 `npm ci`、生产/Harness TypeScript、Harness 224 项 × 3 轮、long-horizon、小说域、前端构建、模块评测、Pilot 310 项、S1 101 项、S2 95 项、S3 v1 103 项、生命周期 175 项与本次传输 96 项。执行代码/测试/配置与隔离快照一致，之后仅回填结果和交接文档；不是远端 CI 或已提交 clean clone。临时构建目录已清理，公开批次保留，`git diff --check` 通过。

该轨道仅证明传输/计量合同；B2/B3 与真实出口的完整组合、真实模型摘要质量、provider 实际账单、生产端点/SDK 通道、Supervisor/maintenance 和原生 Desktop 仍未验收。下一步接入具体任务与新批次授权入口，仍先离线验收，再另行批准真实普通+摘要总预算；整个 Phase 5 尚未完成。


## 第十七增量：S3 限定任务与新批次授权工装（仍仅离线）

本轮按批准继续接线，未调用真实模型，未读取用户 models.json，未生成针对用户配置的 live 清单，未 commit/push。新入口见 [工装说明](HARNESS_PHASE5_SDK_CONTEXT_LIVE.md)。生产 UI/Rust、私人小说及全局 Pi 设置不变。

### 接线与边界

- 新 profile 为 `sdk-b2-context-s3live-v1` / `sdk-b3-checkpoint-ops-s3live-v1`，保留冻结 factory 与 Phase 3 runtime 字节校验；显式版本化测试预算，不改旧 profile、任务或授权额度。
- 各执行两个公开任务：长文件末页读取；来源 v1 读取、SDK 原生手动压缩、父进程修改临时来源为 v2、独立进程恢复并重读后写入。B3 还要求 refresh 和写前 durable intent。读错页但回复正确标记仍失败；不把普通 read 调用次数代替实际末页证据。
- 普通请求和实际 native summary 共用 broker / Journal，按 task 与 seed/resume 绑定 hash；摘要走真实 SDK serializer/parser，不依赖只覆盖普通请求的 hook。模型自由选工具仅在 live 入口；本轮全部使用本地合成 SSE。
- 新 namespace 与 24 小时清单，精确 SHA 和费用未知确认在凭据解析前校验，atomic claim 防重复执行。每次派发前重查源码/到期时间；每任务的 480 秒时限覆盖整个 seed/压缩/重启/resume。
- 32 次批次 HTTP / 12 次单任务 HTTP（含摘要），12 次工具（跨进程合计），65,536 字节单次输入估算 / 最多 2,048 声明输出。已预留未知请求不退款，不自动补跑。
- SDK 标准化 output 包含 separately-reported reasoning；标准化 total 也由 SDK 重算，与 provider 原始 completion/total 分开记录。bounded 输出轨道保守检查 completion + reasoning，旧 exact 轨道不变；不把该保守求和当成实际账单算法。

### 最终离线工装批次

以下 11 批使用相同源码/依赖映射摘要 `f7c478e0dd7ab6b84e07d4e175683acc38e0469fa05b9b5e4197c3d1039bed70`，58 个文件或依赖树指纹。目录前缀为 `artifacts/harness/sdk-context-live/`。

| 注入场景 | 批次 | 本地模拟派发 | 任务批次状态 |
| --- | --- | ---: | --- |
| `readback` | `s3-dry-0jsA0Z` | 19 | pass |
| `stale-first` | `s3-dry-iMTOXY` | 21 | completed-with-failures |
| `summary-error` | `s3-dry-PX768Y` | 9 | incomplete |
| `summary-cancel` | `s3-dry-I3CgMZ` | 9 | incomplete |
| `missing-usage` | `s3-dry-wldUeu` | 1 | incomplete |
| `request-limit` | `s3-dry-yhSBJi` | 12 | incomplete |
| `forbidden-tool` | `s3-dry-navOEf` | 1 | incomplete |
| `forbidden-path` | `s3-dry-b96HIX` | 1 | incomplete |
| `answer-format` | `s3-dry-ldEkuc` | 19 | completed-with-failures |
| `wrong-page` | `s3-dry-rINbwf` | 19 | completed-with-failures |
| `reasoning-cache` | `s3-dry-eVwM5Q` | 19 | pass |

正常批次 manifest SHA 为 `9b0f999e162472930b41e03bdae35218900a7a7b187c3fd97e5b419114f776ef`，四项均机械 pass，17 次普通与 2 次摘要模拟请求、2 次原生压缩和 2 次独立进程重开。该 pass 不代表真实模型行为通过。

`stale-first` 先注入旧来源写入：B3 拒绝第一次派发，重读/刷新后只写一次；B2 实际派发旧版本一次、再写新版本一次，保留为 fail。`answer-format` 保留一项格式失败；`wrong-page` 保留两项末页未读取失败。摘要失败/取消/缺失 usage/请求超额/越界工具或路径都会停止后续任务，unknown/blocked 不改写成 pass。

11 批共 **489 个 JSON、130 次本地模拟派发（普通 118、摘要 12）、10 次实际 SDK 原生压缩、3 个未知请求**，真实 HTTP 为 0。这些是不同故障条件的工装测试，不能合并成模型成功率。模拟 usage/cache 仅用于校验 parser；providerActualUsage 与实际费用均 null。开发早期批次保留，但不替代本表最终源码快照。

### 回归、授权与下一步

`npm run test:sdk-context-live` **83 项检查通过**，含共享总额/单任务限额、独立恢复、严格记录、unknown crash 只读重建、过期/错误 SHA/旧授权/已 claim/源漂移拒绝、11 种正常或故障路径和私密字段扫描。独立网络守卫 61 项、既有统一出口 96 项亦通过。

旧 S2、S3 v1/v2 与十个传输探针合计 **242 个产物**只读核对后 SHA 不变；前三批 aggregate 与保存结果一致，十个传输探针仍满足各自预登记合同。新批次均在离线套件中完成只读重建一致性与 hash 检查，不复用任何旧额度。

建议下一步只读准备新的 4 项真实小批次，展示精确清单后再单独批准。按用户参考输入/输出/cache 费率 $0.75/$3.75/$0.075 每百万 token，最大预留不扣缓存的参考值 **$1.818624**；不是 provider 实际费用或美元硬限额。cache 未报告仍保留费用未知。当前没有新真实授权，不能自动运行。

全新依赖隔离回归保留为 `artifacts/harness/isolated-run-DZohiL/`：451 文件，source manifest 内容摘要 `751d6089695177cc43757ef5690b9ac23f45216b761b1339c21796d715051e9b`。原运行的前 14 条命令通过，在最后一项 S3 新工装套件中断，**原进程没有生成完整成功 summary**。2026-09-23 校验保留 checkout 的全部 451 个源文件与快照完全一致后，只补跑最后一条 `npm run test:sdk-context-live`，83 项通过、退出码 0；完成后再次逐文件核验，源码/依赖摘要与本节冻结批次相同。

合计 15 条检查命令已验证，但不是一次不中断全跑成功。独立记录在 `isolated-continuation-summary.json` 与 `isolated-test-sdk-context-live-continuation.log`；前 14 项日志不覆盖，也不补造原 `isolated-summary.json`。`continued-sdk-context-live/` 按字节核对保留 13 批、560 个产物，包括旧中断尝试的两批及补跑新生成的 11 批；未封存的旧批仍为不完整，不续跑或计入补跑结果。

复制后的 13 批均可只读重建，已有 aggregate 与重建值一致。临时 checkout `pi-harness-isolated-Qyc6oL` 的清理被本机策略拦截，因此保留，没有尝试绕过；证据已另存于上述仓库产物目录。

覆盖全新依赖、生产/Harness 类型检查、Harness 224 项 × 3 轮、long-horizon、小说域、前端构建、模块评测、Pilot 310 项、S1 101 项、S2 95 项、S3 v1 103 项、生命周期 175 项、统一出口 96 项及新工装 83 项。当前执行代码/测试/配置与隔离快照一致，之后仅回填四份验收/结果/交接文档；不是远端 CI 或已提交 clean clone。

本增量不等于整个 Phase 5 完成，不覆盖自动压缩效果、强杀/迟到竞态、真实摘要质量或生产 Desktop release 验收。

## 第十八增量：准备 S3 真实小批次清单（未执行）

2026-09-23 用户同意准备实测清单后，仅执行 `eval:sdk-context-live:prepare` 与只读 `recover`。读取用户 models.json 的受限公共配置投影，不解析实际凭据、不发模型请求，不改变生产代码、私人小说或全局 Pi 设置；未 commit/push。

- 目录：`artifacts/harness/sdk-context-live/s3-live-t6GSPA/`，仅有 `manifest.json`，无 claim、Journal 或请求记录。
- manifest SHA-256：`4afa54958f6ba24454a49453da40a8c40a014951f2a966e1a1b70ce04a159d86`；只读重建前后相同。
- 58 个源码/依赖指纹的映射摘要：`f7c478e0dd7ab6b84e07d4e175683acc38e0469fa05b9b5e4197c3d1039bed70`，与第十七增量最终离线验收一致。
- 模型：`gemini-proxy / gemini-3.8-flash-high`，`openai-completions`，配置上下文容量 262,144；本次单请求测试限制仍为输入 65,536 字节和声明输出 2,048。
- B2/B3 两个 profile 各执行长文件末页读取、原生手动压缩后跨进程恢复写入，共 4 项；批次最多 32 次 HTTP（含摘要），每项最多 12 次。
- 无缓存满额预留参考 $1.818624，不是实际账单或美元硬限额。实际费用为 null；cache 缺失仍保持未知。
- 有效期至 `2026-09-23T16:24:18.316Z`，即北京时间 **2026-09-24 00:24:18**。

只读 recover 返回 `status=prepared`、`sealed=false`，真实与模拟 HTTP 派发均 0，全部预留均 0，未知/待处理请求均 0。四项任务尚无执行证据，不能把默认 unknown 行当成实测失败或通过。

**当前只批准了准备清单，未批准真实执行。** 展示精确清单、范围及参考费用后，等待用户另行批准；不能复用旧 S2 授权。源码、配置变化或清单过期需要重新 prepare 和批准，不续期或改写本批次。

## 第十九增量：S3 限定任务首批真实执行

2026-09-23 用户在看到上一增量的精确清单、32 次总请求上限和费用可能未知的边界后明确要求执行。仅执行该批一次，未重新 prepare、未修改冻结代码、预算或任务，未选择性补跑，未 commit/push。

### 冻结信息与四项结果

- 批次：`artifacts/harness/sdk-context-live/s3-live-t6GSPA/`。
- manifest SHA-256：`4afa54958f6ba24454a49453da40a8c40a014951f2a966e1a1b70ce04a159d86`。
- 源码/依赖摘要：`f7c478e0dd7ab6b84e07d4e175683acc38e0469fa05b9b5e4197c3d1039bed70`，与工装最终离线验收相同。
- 模型：`gemini-proxy / gemini-3.8-flash-high`，固定 Pi SDK `0.63.1` 的 `openai-completions` 路径。

| Profile | 任务 | 机械结果 | 普通 HTTP | 摘要 HTTP | 工具调用 | 正文写入 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `sdk-b2-context-s3live-v1` | `bounded-read` | pass | 5 | 0 | 4 | 0 |
| `sdk-b3-checkpoint-ops-s3live-v1` | `bounded-read` | pass | 8 | 0 | 7 | 0 |
| `sdk-b3-checkpoint-ops-s3live-v1` | `compact-source-write` | pass | 7 | 1 | 5 | 1 |
| `sdk-b2-context-s3live-v1` | `compact-source-write` | pass | 5 | 1 | 3 | 1 |

批次聚合为 `pass`、`sealed=true`，**27 次真实 HTTP，25 次普通请求 + 2 次摘要请求**，模拟派发 0，unknown/pending 均 0。未超过批次 32 次或每任务 12 次上限，未触发隐式 retry block。输入预留 148,761、输出预留 54,476 是安全计量，不是 provider 实际 token 或费用。

两项读取均有长文件末页及标记的实际 Observation 证据。两项恢复任务各完成一次真实 SDK 原生手动压缩，再由独立进程重开，继承压缩记录、重读更新后的 v2 来源，且各只写入 v2 一次；旧版本写入 0。B3 额外完成 checkpoint refresh 和一次 durable intent/result。所有六个 stage 的设置、工具范围、临时文件边界、子进程网络隔离与正常结束标记均符合机械合同。

### 用量、费用及审计

provider 原始合计：prompt **71,676**、completion **979**、reasoning **7,201**、total **79,856**。SDK 标准化 output **8,180** 包含 reasoning；不将其当成 provider completion。cache 未报告，`cached=null`、`actualCostUsd=null`，符合用户“无法计算 cache 大小就保留费用未知”的要求。不以 SDK 默认 cacheRead=0 或满额预留参考 $1.818624 填写实际花费。

执行后独立运行只读 recover，重建 aggregate 与已保存结果完全一致。全部 **90 个 JSON 产物**在重建前后逐文件 SHA 不变，manifest 仍是用户批准的精确 SHA。严格 schema/索引/Journal 校验通过；另做字段与常见认证/URL 模式扫描，无禁存字段或模式命中。`manifest.version.summary` 是固定版本枚举，不是模型摘要正文。产物不保存原始模型正文、真实摘要、完整请求、endpoint 或凭据。

全局 Pi 配置和生产代码未修改，测试写入仅落在临时公开 fixture；本次临时构建目录由 runner 清理。历史隔离回归留下的 `pi-harness-isolated-Qyc6oL` 保留状态未动。没有把本次实测当作重新执行完整隔离回归或 Desktop 实机验收。

### 结论边界与后续

本轮验证了真实模型下的四项限定集成合同，不代表通用摘要质量、自动压缩效果、任意强杀/迟到结果恢复或完整 Phase 5 完成。每个 profile/task 仅一次；两种配置都通过，未触发旧版本误写阻断、重复副作用对账或未知写入恢复，不能据此宣称 B3 相对 B2 更可靠或更省 token。

批次已封存，**剩余 5 次请求额度不能复用**。下一步宜优先补齐强杀/迟到结果竞态等离线生命周期证据，再另行确定真实扩展任务与预算；不自动追加模型调用。

## 第二十增量：受控进程强杀与迟到结果（仅离线）

2026-09-23 按用户批准实施独立离线增量，未调用真实模型、未读取个人 provider 配置、未修改生产 runtime，未 commit/push。新增 `sdk-recovery-races`，复用原样冻结的 `sdk-b3-checkpoint-ops-v2`；旧 S3 v1/v2/live 任务与封存产物保持不变。命令与范围见 [恢复竞态说明](HARNESS_PHASE5_SDK_RECOVERY_RACES.md)。

### 机制与固定矩阵

真实 SDK 调用写工具，在工具回执返回前停在受控屏障。父进程独立读回 SDK 会话，确认操作 ID、issued/dispatched 状态和 expected post-hash 已落盘，再仅对自己创建的测试子进程执行 SIGKILL，观察退出且没有执行 graceful finally。不是抛出合成工具错误代替进程死亡。

每场景三轮，共 12 项；每次恢复都通过独立进程 `SessionManager.open()`，尝试两个不同 tool call ID 的相同写入意图，中间执行 refresh：

| 场景 | 三轮机械结果 | 最终业务状态 | 恢复端实际写入派发 |
| --- | --- | --- | ---: |
| 写入前强杀 | 3 pass | 缺失文件仍未知，禁止重放 | 0 |
| 部分写入后强杀 | 3 pass | 部分字节仍未知，禁止重放 | 0 |
| 完整写入但未回执时强杀 | 3 pass | post-hash 对账完成，禁止重复派发 | 0 |
| 旧执行器迟到写入 | 3 pass | 首次恢复未知；后台完成后再次重开，按字节对账 | 0 |

迟到场景使用父进程另行拥有的执行器进程，不随 Agent 进程一起终止。只有第一次恢复已确认缺失且未重放后，才放行旧执行器产生一次文件写入；它随后退出，第二次恢复仍不重复派发。该合同不声称能撤销已经发出的外部副作用。

### 结果与验证

最终独立批次 `artifacts/harness/sdk-recovery-races/s3-races-ow4RXU/`，manifest SHA-256 `92da2b35260ccb5002035c7f177fd212a44a958a9ba772bc9a016995e7d92823`。40 个源码/依赖指纹映射摘要 `4d160c38eb129afd98db9d2d290ea21317ca2ac019605d0c98cde4debad8bf6f`。开发期批次 `s3-races-E64gO4` 保留，但不替代最终修正类型后的代码证据。

`npm run test:sdk-recovery-races` **125 项检查通过**。矩阵实际强杀 12 次、独立重开 15 次、后台迟到效果 3 次、恢复端写入派发 0。最终 6 项对账完成，6 项 `unknown-replay-blocked`；另有 3 项迟到写入的中间恢复阶段也正确保留未知。unknown 的安全阻断计为机械合同通过，不算业务完成。

额外 10 项 adapter 回调场景，在结果指纹读取前 / await 期间切换 abort、generation/session/role/project；旧回执及重复回执都不更新新状态。该测试直接驱动既有 `installDurableOperations` 适配函数，**不是完整 SDK/Desktop 会话切换端到端证据**。另覆盖伪造强杀、缺失落盘证明、重复派发、部分字节误判、提前释放后台执行器、unknown 冒充 pass、越界记录字段和产物篡改拒绝。

新批次 15 个 JSON 产物只读重建与保存 aggregate 一致，前后 SHA 不变；上一真实批次 `s3-live-t6GSPA` 的 90 个产物也只读重建一致且 SHA 不变。常见认证/URL/禁存字段扫描无命中。provider usage 和费用均 null，真实模型请求 0。类型检查通过，独立 runner、CI 与隔离回归白名单已接入。

离线启动器额外核对 3 种禁止参数形式（live、额外 run 参数、test 附带认证参数），均在创建批次前拒绝；这是独立启动器检查，不计入上述 125 项。全新依赖回归记录在 `artifacts/harness/isolated-run-juyMAy/`：**459 文件、16 条命令连续全部通过**，source manifest 内容摘要 `cffeea48db53e5d18c053662e875f001d7dcd1ff82a810a4b59d715b91f92347`，与文件字节 SHA 口径不同。

覆盖 npm ci、生产/Harness 类型检查、Harness 224 项 × 3 轮、long-horizon、小说域、前端构建、模块评测、Pilot、S1、S2、S3 上下文、生命周期 175 项、统一出口、S3 live 工装 83 项与恢复竞态 125 项。执行代码、测试与配置同隔离快照一致，之后只更新 7 份文档。完整成功 summary 和每项日志已保留，临时 checkout `pi-harness-isolated-H9wRW9` 已清理；旧中断回归留下的 `pi-harness-isolated-Qyc6oL` 未动。隔离运行内产生的临时批次随 checkout 清理，长期可重建的新矩阵证据仍是上方仓库内 `s3-races-ow4RXU`，不把日志中临时路径冒充保留产物。未执行远端 CI 或原生 Desktop release 验收。

### 边界

本轮仅覆盖固定屏障处的强杀，未证明任意 CPU 指令处崩溃、机器断电/fsync、父 broker 被杀、外部事务幂等或 Rust/RPC/UI。新矩阵不调用压缩，不把旧原生压缩测试与本轮进程测试拼成完整端到端保证。没有新的真实调用授权或费用；整个 Phase 5 仍未完成。

## 21. 第二十一增量：封存证据的统一只读报告

2026-09-23。新增 `evals/report/`、`tests/report/` 与 `scripts/run-evidence-report.mjs`，并接入 npm、CI、本地隔离白名单。没有改变生产 runtime、历史 validator 的判断规则或旧批次。此次不调用真实模型、不 commit/push。

### 产物与重建

最终报告包：`artifacts/harness/reports/report-fDqAvf/`。

- 包 manifest **字节** SHA-256：`8a6512cc98ca7b68d963162d1e824e8f9545670116c36f19509de31120692099`。
- 包内四个载荷文件映射摘要：`c60cfba1f7bf2b885d52f854805f16770476af91e4c0bc7e3739676e5532e98f`。
- 12 批选择清单的 canonical 摘要：`d7861d25ba12cb5c0ad6b224561d4cc23736949bbef219faa24abe9784c62134`。
- 报告工具 69 个源码/依赖文件映射摘要：`2e789990c55b4c49601508b174373220ed5f6b622d215ef510b49ca5f7a823f8`。

`npm run eval:report` 重新验证交接索引中显式选定的 12 批，**12/12 证据核验一致**，509 个原始文件在读取前后 SHA 不变。其中 10 批已有 aggregate，重建后逐字段一致；两批早期 pilot 没有 aggregate，直接从原记录/Journal 重建，不向旧目录补写。

`npm run eval:report:verify -- artifacts/harness/reports/report-fDqAvf` 再次从原批次重建，核对报告包文件 SHA、选择清单、当前工具指纹、JSON 和 Markdown，12 批一致，新增模型请求 0。包只包含脱敏摘要和哈希索引，不复制原始 provider 内容、私人小说或认证配置；常见认证/URL/禁存字段扫描无命中。它不是附带全部 raw 的可独立归档，复核仍需原批次，也不是第三方签名。

### 不隐去失败与未知

人读报告先声明范围和已知差异，再列每批、profile × task 的分母与状态；机器报告保留 run ID、原 aggregate、状态细分、文件 SHA 和来源 commit/dirty/源码映射。不会自动筛选最新/通过批次，也没有跨合同总成功率或改善百分比。

旧 pilot 的 READ fail / WRITE blocked、S2 的格式 fail、模块的 unsupported、S1/S3 的预登记负例均原样保留。恢复竞态的 12 个机械 pass 与业务结局分开：6 项对账完成、6 项仍未知并阻止重放，不能称为 12 项任务完成。provider cache 缺省保持 null；SDK output 含 reasoning 的语义差异保留，实际费用未知，参考单价不冒充账单。

清单选取的是 12 个已登记批次，不是全量开发/故障 artifact 的统计样本；代表性 dry run 和单个传输探针不替代其整个套件。无效/缺失批次保留 invalid/unavailable 及固定原因码，不输出伪造的任务数字，命令非零退出。

### 兼容问题与回归

首轮报告 `report-0VvPkS` 有 10 批核验成功，S3 dry/live 两批被拒绝；旧数据未变。定位为旧 S3 validator 通过 `Function.toString()` 生成 profile 指纹，新合并 bundle 的名称消歧改变了文本。没有跳过 profile SHA：改为按原 CLI 入口图单独打包，并在限制环境/网络/子进程的 Worker 中硬编码仅执行 recover。随后开发快照 `report-lDyPfg` 达到 12/12；最终代码和补充测试对应上方 `report-fDqAvf`。旧开发报告保留，不当作最终工具指纹证据。

实际执行：

- `npm run test:evidence-report`：**70 项检查通过**，覆盖 9 种 family 的统计投影、缺失/篡改、未知/负例、cache null/0/非零、reasoning 口径、目录越界/junction、旧 aggregate 缺省、工具漂移、报告与包索引一起篡改、确定性重建和 Legacy recover 拒绝。fixture 是合成报告记录，不冒充新的 SDK/强杀测试。
- `npm run check`、`npm run check:harness-tests`：通过。
- `npm run test:evals`：32 schema/aggregate + 61 historical + 15 long-horizon + 3 fault-metrics + 23 runner/integrity 检查通过，真实模型调用 0。
- `npm run test:harness`：224 项 × 3 轮，通过且 deterministic=true、failures=false。
- 启动器另行拒绝 live、run 额外参数、test 附带认证参数三种调用；这些不计入 70 项。
- `git diff --check`：通过；仅有已有 CRLF 转换提示。

完整隔离链已加入报告测试，共 17 条命令；**本轮未重跑全新依赖的完整 17 命令链，也未执行远端 CI 或原生 Desktop 验收**。上一轮 16 命令成功快照仍为历史证据，不回填成新代码全链通过。之后仅回填说明文档，报告工具指纹保持不变。

### 下一项

Supervisor / context maintenance 的独立离线对照仍待实施，B4/Phase X 未实施。后续正式模型调用须新清单及预算批准；完整历史 Desktop/RPC、人工创作质量和发布验收继续分轨管理。选定证据的报告工具已交付，整个 Phase 5 尚未完成。

## 22. 第二十二增量：Supervisor / 上下文维护独立离线对照

2026-09-23。新增 `evals/sdk-supervision/`、对应测试、独立启动器及文档，接入 npm、CI 和隔离白名单。三个配置使用同一 B3 durable-operation 底座，仅分开开启 Supervisor / maintenance，未修改生产 TypeScript 逻辑、私人项目或全局 Pi 设置，未调用真实模型，未 commit/push。

### 冻结结果

最终矩阵 `artifacts/harness/sdk-supervision/s4-offline-zg1l2J/`：

- manifest 字节 SHA-256：`1ba6406ce608e4d1241689d943dc08726330e900cf1c882142578f5914be1151`。
- 45 个源码/依赖指纹映射摘要：`f8d59d4466cb4152e769bfa412e311c77960bba6fc888455b6a6bab5ec4f597f`。
- 三配置 × 五任务 × 三轮：**27 机械 pass、18 预登记缺能力 fail、0 unknown、0 blocked**。每个预登记格均保留，不筛除基线失败。

| 任务（三轮） | B3 control | 加 Supervisor | 再加 maintenance |
| --- | --- | --- | --- |
| 验证后正常结束 | 3 pass | 3 pass | 3 pass |
| 无变化反复验证 | 3 fail：六次后仍给最终答案 | 3 pass：第三次停止 | 3 pass：第三次停止 |
| 不验证直接结束 | 3 fail：未受监督的最终答案 | 3 pass：待验证，不算完成 | 3 pass：待验证，不算完成 |
| 旧工具文本可裁剪 | 3 fail：预算阻断 | 3 fail：预算阻断 | 3 pass：只裁剪旧结果 |
| 裁剪不足需压缩 | 3 fail：预算阻断 | 3 fail：预算阻断 | 3 pass：一次原生压缩 |

正常矩阵实际派发 99 次 SDK 工具，其中 27 次临时候选写入、45 次公开标记验证；3 次 native compaction，`fromHook=false`。147 个本地 API 入口中 129 个交付合成响应、12 个在预算门被阻止、6 个以已取消 signal 进入后立即拒绝。这 6 个是 SDK 排队的终态续轮，不产生新回复或工具调用，不能隐藏，也不是 HTTP 请求。真实 HTTP 为 **0**，provider usage 与费用均 null。

使用同一 prompt、system、工具 schema 与种子历史。维护组旧工具裁剪不改磁盘历史，只裁剪发送副本并保留最近四项；压缩是输入策略调用 SDK manual API，不是 SDK usage 阈值触发。当前输入仅发送一次，不进入提前生成的摘要。16 KiB 是离线完整载荷字节合同，不改变应用 256K 窗口或冒充实际 token。

### 五项故障与回归

`npm run test:sdk-supervision`：**188 项检查通过**。独立故障目录 `artifacts/harness/sdk-supervision/s4-fault-tests-304nzZ/` 保存源指纹、五份有界证据、成功 summary 与文件 SHA：

1. 摘要报错：不保存 compaction，不发送当前输入，恢复输入。
2. 摘要取消：同样停止，不重试、不重放。
3. 摘要仍过大：保留已发生的一次 compaction，但阻止后续请求、恢复输入。
4. 压缩设置关闭：不调用压缩，由最终预算门阻止请求。
5. Supervisor 状态持久化失败：零工具派发，状态 FAILED，明确 `persisted=false`，不冒充成功落盘。

另包含严格 schema、能力清单、hash/顺序/重复/缺失/越界记录拒绝、原历史副本保全、unknown 不晋升 pass、native compaction 不能伪造及当前输入不可重复等检查。故障的安全通过不并入 45 格业务分母。

最终批次 **48 个 JSON 文件**经独立只读 rebuild，与保存 aggregate 完全一致，前后 SHA 不变。正常与故障证据共扫描 6,326 个字段，未命中禁存的认证/完整 prompt/正文/raw output 字段；唯一模型 URL 是固定 `sdk-s4.invalid`，不是用户 endpoint。

其他已实际执行：生产与 Harness 类型检查通过；`test:harness` 224 项 × 3 轮 deterministic=true、failures=false；`test:evals` 的 32 + 61 + 15 + 3 + 23 项通过；`test:evidence-report` 70 项通过。另检查启动器拒绝 live、额外 run 参数、test 携带认证参数三种形式，均在创建批次前退出，不计入 188 项。`git diff --check` 通过，仅有已有 CRLF 转换提示。隔离完整链已接到 18 条命令，**本轮未重新安装依赖跑完 18 条链，也未执行远端 CI 或 Desktop 实机验收**。

### 开发期发现与旧证据

开发批次保留，不替代最终矩阵：`s4-offline-S2v4Mh` 初始判断把 SDK 排队的 aborted provider 入口误认为额外派发，后续格停止；核对 SDK 事件实现后将“入口”和“真正交付响应”分开，未允许终态继续调用工具。`s4-offline-sAxVP3` 的原生压缩保留窗口包含过短近期历史及旧长文本，因此仍超预算并安全停止；调整公开种子历史使正常压缩确实覆盖旧长文本，同时用独立 summary-too-large 故障保留超限后停止测试。`s4-fault-tests-7crFUg` 暴露评测 adapter 对已失败状态重复落盘的异常，已改为终态不再执行 turn 更新；生产状态机未改。

中间完整开发快照 `s4-offline-khf8w4` / `s4-fault-tests-nNCqY7` 也保留。最后补上验证前历史深拷贝、明确 S4 synthetic model 身份和判据整理，重跑全部 188 项，形成上述最终目录；不只挑选通过格补跑。

因 npm 脚本变化，报告 builder 指纹更新，旧 `report-fDqAvf` 不覆写。新包 `artifacts/harness/reports/report-diKqPS/` 的 manifest 字节 SHA 为 `5355c16906e54969a7b507fb8a16e4c62d2bd9b58958adeac8d939e0fc274124`，载荷文件映射摘要 `cb3aee5ac97258ede33c8096d0189afc0cc27ad3cf0cf9ad5bdd0f5dfa9729d4`。原 12 批重新生成及 verify 均 12/12，509 个旧文件不变；报告清单暂未纳入 S4，不宣称它已经汇总本轮新矩阵。

### 结论与下一步

本增量完成的是限定 SDK 下独立控制机制对照。停止无进展、拦住未验证结束不等于完成正文；公开字节验证器不是小说验收器；脚本响应与固定摘要不代表真实模型能力或成本节省。完整历史 Desktop/RPC、真实摘要质量、正式模型自主对照和发布验收仍未完成，B4/Phase X 未实施。

接下来把 S4 纳入报告并执行当前完整隔离回归，再准备最小真实 S4 任务、共用请求预算和新的精确批准清单，不复用旧授权或自动调用模型。

## 23. 第二十三增量：S4 报告集成与完整隔离回归

2026-09-23。本增量只扩展报告选择、投影、测试与交付文档，不改变生产 runtime 或 S4 原验证器，不调用真实模型，不 commit/push。原 12 批选择不变，显式增加 `s4-offline-zg1l2J`；五项独立故障仍不并入 45 格矩阵，也不自动搜寻最新通过批次。

### 新报告与证据保全

最终报告包：`artifacts/harness/reports/report-wAl4It/`。

- 包 manifest **字节** SHA-256：`60a48c0317084f5157fe093ffeee2d0de3b0f06f3e0391729c8294d7a3acb057`。
- 包内四个载荷文件映射摘要：`841537d6847176b10ff46e99632d37c7fc2c00156bb21ff80ee5e252885669b3`。
- 13 批选择清单的 canonical 摘要：`9a4556348114862e40249a92de46fe5b93bb6a396583cc62ba2251e16caf1947`。
- 报告工具 79 个源码/依赖文件映射摘要：`06daecba0b065e344bcd8f9651680fa092337ca4f5d12376c6936b46b5f56776`。

`npm run eval:report` 与 `npm run eval:report:verify -- artifacts/harness/reports/report-wAl4It` 均 **13/13 证据核验一致**。原 509 个文件加 S4 的 48 个 JSON，共 **557 个原文件 SHA 不变**。旧 `report-fDqAvf`、`report-diKqPS` 保留原样；新工具不冒充旧 builder 指纹。

S4 仍调用原验证器重建，报告新增独立 `businessOutcomes`。45 格中 27 个机械 pass 分为：9 项公开候选已验证、6 项只读答复、6 项无进展停止、6 项等待验证；18 个预登记负例分为 12 项预算阻断和 6 项未验证最终答案。没有人工验收或 Canon 晋升，不把停止/等待算作正文完成。旧 pilot 失败、S2 格式失败、unsupported、未知恢复与 cache null 均保留，不合并跨合同成功率或计算费用节省。

报告 JSON 的有界字段扫描检查 8,906 个字段，未命中禁存的认证、完整提示词、正文或 raw output 字段；四处 `providerActualUsage.prompt` 为合法数值用量，不是提示词文本。该扫描只说明列明字段检查，不是完整安全审计，也不改变报告依赖原始批次才能复核的边界。

### 报告回归与隔离快照

`npm run test:evidence-report`：**105 项检查通过、10 种 family、真实请求 0**。新加 35 项覆盖 S4 业务/机械结果分栏、拒绝伪造人工批准、unknown 加后续 blocked 的完整记录重建、包复核及业务结局篡改拒绝；合成报告 fixture 不冒充新 SDK 或真实模型实验。Harness 测试类型检查通过。

`npm run test:harness:isolated` 完整执行并以 0 退出，成功证据在 `artifacts/harness/isolated-run-LZyZ3O/isolated-summary.json`：**全新依赖、18 条命令全部通过**。该轮复制 480 个显式允许文件，source manifest 内容摘要为 `a93dd68de33e985bc26565aeb9a8c83a7bd71dfe6bf86dc341bc0c58b94b54b1`。不复制私人小说 fixture、`.pi`、旧 artifacts 或根目录三个未跟踪规划文件。

该完整链包含：

- `npm ci`、生产/Harness 类型检查、小说域回归及前端构建通过。
- 原 Harness **224 项 × 3 轮**，`deterministic=true`、`failures=false`；长程 1 项 × 3 轮，真实请求 0。
- 模块评测 32 + 61 + 15 + 3 + 23 项、Pilot 310 项、S1 101 项、S2 95 项通过。
- S3 上下文 103 项、生命周期 175 项、统一出口 96 项、限定任务工装 83 项及恢复竞态 125 项通过。
- S4 **188 项**、报告 **105 项 / 10 种 family** 通过。预登记缺能力负例按原合同保留，不把所有任务状态改为 pass。

所有测试均为离线/合成路径，未新增真实模型请求；`npm ci` 的依赖下载不属于模型调用。构建仍有已有的静态/动态导入与大于 500 kB chunk 警告，安装仍有弃用/安装脚本待审批提示；不影响命令成功，本轮未扩大范围修改依赖或打包策略。

本次运行自建临时 checkout 已由脚本清理并确认不存在；没有清理其他历史目录。用户全局 `settings.json`、`models.json` 的前后 SHA 一致，仅检查哈希，没有输出配置内容。回填后与 480 文件快照相比只改了七个说明文档（验收、结果、交接、正式对照计划、报告说明、S4 说明、`evals/README.md`）；代码/测试/配置与已测试快照一致。`git diff --check` 通过，生产 `src/` 与 `src-tauri/` 没有改动。

这是本地未提交源码快照的完整回归，不是远端 CI、已提交 clean clone 或 Desktop 实机验收；被清理的临时测试批次不加入统一封存报告，持久保留该轮源码清单、命令日志和成功 summary。

### 下一步边界

报告集成和完整隔离回归已经完成。下一项是准备真实模型自主执行的最小 S4 共同任务、普通/摘要共享预算及新的精确批准清单，不继续扩展本轮离线故障范围，不自动调用模型或复用旧额度。完整历史 Desktop/RPC、正式公平效果比较、人工创作质量与原生发布验收仍未完成；整个 Phase 5 不标为完成。

## 24. 第二十四增量：最小真实 S4 任务与共享预算准备

2026-09-23。本轮交付 [S4 真实首批方案](HARNESS_PHASE5_SDK_SUPERVISION_LIVE_PLAN.md)，并更新验收、对照计划、交接和入口索引。**只改文档，没有实现新 live 工装，没有生成可执行 manifest，没有读取个人模型配置或调用真实模型，未 commit/push。**

### 核对后的决定

- 保持三配置，只取候选修正与验证、不可修改的前置条件缺失、上下文压力恢复三个公共任务，每格一次，共九格，任务间轮换配置顺序。
- 不强迫模型固定顺序调用工具或循环失败；监督分支未触发就如实保留。前置条件阻塞/监督停止不等于候选完成，不设必须观察到改善的通过要求。
- 代码检查发现真实适配不能照搬离线脚本：写入内容不应由隐藏标准答案拦截；完成判定需检查预登记必需产物，不能因为未追踪到写入而视为已验证。这些是下一工装的必改合同，不声称本轮已修复或生产路径有相同问题。
- 复用通用 request policy/transport/journal 与普通/摘要 broker；S3 的固定 task IDs、namespace、32 次 ACK 和旧授权保持原样。S4 当前仍是离线-only 入口。

### 静态核验结果与预算边界

方案内 `executable=false` 的 JSON 使用现有纯函数 `freezeRequestPolicy` 做了无网络静态核验：profile/task 各三项，九格唯一且每个位置轮换平衡；`maxTaskHttpRequests=6`、总上限 `54=9×6`；输入/输出总预留分别为 `3,538,944` / `110,592`。单次输入估算、输出与安全余量之和小于 262,144 工作窗口。单次 manual compaction 最多两条摘要请求，与普通请求共享每格六次额度。

按用户参考单价、输入均以非缓存预留计算为 $3.068928；只是约 $3.07 的满额预留参考，不是已发生花费、可靠实际费用估计或金额硬限额。provider cache 缺失仍为 null。任一传输硬限额、超时、未知派发、计量缺失或安全问题停止全批，未执行格保留；产品压力门的可判定阻断另列，不重置 broker。

静态核验包括纯 policy schema、顺序、预算关系、参考金额及当前不存在真实入口；**不是九项 SDK 演练、授权门测试或 provider 实测**。32 KiB 人工压力合同与 64 KiB 外层载荷边界不改变应用 256K token 工作窗口，也不代表生产预算估算器效果。当前个人模型配置未重新核实，需在新 prepare 时检查。

本轮没有重新执行完整 18 命令隔离链；代码/测试/配置仍以第二十三增量快照为依据，新增方案文档不在旧快照内。统一报告旧包与原批次保留，不将本轮方案当成第十四个实验批次。

收尾核对：与上一轮 480 文件源码清单相比，已有文件仅有说明文档差异，代码/测试/配置一致；六个本轮说明文档的 73 处相对链接及尾随空白检查通过。再次执行 `eval:report:verify`，`report-wAl4It` 仍为 13/13 批一致，包文件映射摘要不变，新增模型请求 0。`git diff --check` 通过，仅保留既有 CRLF 转换提示。

### 下一实施项

实现独立 S4 live 工装，完成方案列出的七类离线门及完整隔离回归；之后生成新的精确 manifest、展示九格顺序/模型/额度/费用未知边界，并单独确认当批执行。本文的 54 次拟定预算不授予真实调用，也不复用任何旧批余额。完整 Phase 5 仍未完成。

## 25. 第二十五增量：S4 独立执行工装与离线验收

2026-09-23。新增 `evals/sdk-supervision-live/`、独立 launcher 和测试入口，复用固定 SDK `0.63.1`、原字节生产工厂及既有普通/摘要 broker/journal。**没有请求真实模型，没有准备正式 live 清单，没有读取凭据值，没有改生产 `src/` / `src-tauri/`，未 commit/push。**

### 实现边界

- 三个新 `sdk-b3-s4live-*-v1` profile、三个公共任务，九格轮换顺序；旧 S3/S4 的 ID、额度、授权和封存结果不改。
- 模型自主选择工具和修改内容。共同门只限制工具、路径、参数和大小，错误但合法的候选可实际写入；验证器失败不误报权限违规。
- 候选完成必须有预登记目标、当前字节匹配的验证回执和唯一当前输入。没写、没验证、只说完成都不能算候选通过；`userAccepted=false`，没有人工批准或 Canon 晋升。
- 第一次发现前提不足即主动停止，与第三次相同失败被 Supervisor 停止分开记录。未触发分支不冒充真实覆盖，安全合同通过不等于业务完成。
- 32 KiB 产品压力合同及 64 KiB 外层载荷上限只用于本工装。M 保留磁盘历史、最近四项及 pending 结果，裁剪不足后最多一次原生手动压缩；失败/取消/仍超限恢复未发送输入。普通/单或双摘要共用每格 6 / 全批 54 次，传输故障停止全批、预留不退款。
- 新清单冻结代码/依赖/fixture/种子历史/工具/system/prompt/模型配置指纹，精确 SHA + 24 小时有效期 + 费用未知确认；检查授权与已使用状态后才解析所选凭据。只读恢复独立核对业务结局、SDK/Journal 用量和 aggregate，拒绝缺失、篡改、额外字段与假批准。

### 已运行的合成证据

第一轮工装测试 111 项通过；收尾增加“当前输入为零不得判 pass”的负测试，**最终 112 项已在全新依赖隔离链通过**。launcher 另有三种错误模式/参数/批准的手动拒绝检查通过，未产生执行或读取凭据。正常最终演练目录 `artifacts/harness/sdk-supervision-live/s4-dry-lOgRtm/`，manifest 字节 SHA-256 为 `109bc82a3794393b9df24327895c39d1d4c4dd9607f3af2c4d724330e1e24af1`；77 个产物已由 `recover` 只读重建并核对保存汇总。

九格为 **7 个机械 pass / 2 个 fail / 0 unknown / 0 blocked**，不是七章创作完成：3 项公开候选验证、3 项前提不足的安全停止、1 项维护后只读答复；两个无维护对照因预算门停止而保留 fail。合成普通请求 20、摘要 1，共 21 次模拟派发，真实请求 0。原生压缩一次、历史保留、当前输入只发送一次；cache 未报告，费用 null。

准备探针记录实际 SDK 序列化载荷：原始普通 43,909 字节，裁剪旧工具后 32,057 字节；加输出预留及安全余量共 38,201，仍高于 32,768 产品上限。原生摘要载荷 29,381 字节，本地成功摘要校准后的普通载荷 5,854 字节，均在外层边界内。此处是合成校准，不是实际模型 token 或真实摘要质量。

独立故障演练覆盖错误合法内容、无写入、无验证、三次无进展、摘要错误/取消/仍过大、维护关闭、Supervisor 持久化故障、越权路径/工具、必要 usage 缺失、六次硬限额及 reasoning/cache 口径。所有失败和未执行格保留。双摘要使用真正 SDK `compact` 的 split-turn 单元路径；共享 6/54 预留及超时另由真实 broker/journal 测试，不把单元组合称为真实双摘要实测。

### 完整回归与旧证据

`npm run test:harness:isolated` 完整执行且以 0 退出：**493 文件源码快照、全新依赖、19 条命令全部通过**。证据目录 `artifacts/harness/isolated-run-E1kRln/`，source manifest 内容摘要 `90388294ff46256f3b94d3bb5b2933d88cbda6e7c1fbf44dc1a64b4d79d7716b`。包括原 Harness 224 项 × 3 轮 deterministic=true、failures=false，既有全部 SDK 套件、S4 188 项、新工装 112 项及报告 105 项。CI 配置亦接入新入口，但没有运行远端 CI、原生 Desktop 或真实模型。

自建临时 checkout 已由脚本清理；没有清理其他历史目录。只复制跟踪文件及显式白名单，未复制私人小说或根目录未跟踪规划文件。用户全局 settings/models 的前后 SHA 一致，仅检查哈希；安装的弃用/脚本审批提示和前端既有导入/chunk 警告保留。最终仅回填说明文档，代码/测试/配置仍与已通过的 493 文件快照一致。

package 脚本变化导致报告 builder 指纹改变，因此在新目录 `artifacts/harness/reports/report-Wsh9Yt/` 重建并只读复核：13/13 批一致，557 个原证据文件的哈希映射与旧包相同。包 manifest 字节 SHA 为 `da56c1efc96836a207b3ea74cca4b887ef2ddabc7ae01000561f41d795e63159`，payload 映射 SHA 为 `f537deab630e8201d302407939508de7a1a1d2db53a46e2f14aaff1fddb088d2`，79 文件 builder SHA 为 `d189c8fca4489c787042e408b7f44b355c4956c6b2490b35081461011ecdff1b`。旧包未覆盖，新 S4 工装演练尚未加入统一报告分母。

### 下一步

离线验收已经结束。下一步单独 prepare 当前模型配置下的新精确清单，再请用户确认当批调用；本轮的实现授权和既有 54 次方案不等于真实调用批准。费用沿用用户参考单价，满额非缓存预留参考约 $3.07，不是账单或金额硬上限，实际 cache 不可核实时费用未知。完整 Phase 5、长篇创作质量、完整 Desktop/RPC 和发布验收仍未完成。

## 26. 第二十六增量：S4 正式清单准备，等待批准

2026-09-23。本轮只按当前个人模型配置生成新清单并只读复核，**没有 live 调用、没有解析凭据值、没有修改生产代码或全局 Pi 配置，没有 commit/push**。执行批准留到展示当批精确模型、指纹、预算与有效期之后。

### 精确批次与有效模型

- 目录：`artifacts/harness/sdk-supervision-live/s4-live-orlzII/`。
- manifest **字节** SHA-256：`b0c02af70815e17a5e75e9e915b2893d45366b8ba04cc6ed3814f5800d34aa5c`。
- 创建 `2026-09-23T08:04:54.767Z`，到期 `2026-09-24T08:04:54.767Z`（北京时间 **2026-09-24 16:04:54.767**），有效期 24 小时。
- 有效模型投影 `gemini-proxy / gemini-3.8-flash-high`、`openai-completions`、工作窗口 `262144`、单请求输出参数 `2048`、`outputField=max_completion_tokens`、`reasoning=false`；会话 `thinkingLevel: off`。仅确认本地配置与固定 SDK 合同匹配，不代表认证/远端可用性或上游不生成 reasoning。
- 固定 SDK `0.63.1`，Node `v24.19.0` / Windows x64；lock SHA `961796cae467d5f8f68262865363eb95c484007a5ff2ea76eb7a798fb54d1bf0`。
- 64 个源码/依赖条目的映射 SHA `8f47eb8fe9245f1a00f5477f5a72c08c079f8627b06678f2b0702b27c93be3eb`；fixture 映射 SHA `6d61780ee7d7f9cb2c2f261ebf92507fe8e34cdf8ec45fb5eaa89f9b2d0ebdd1`。这两个指纹和 runtime 与最终 `s4-dry-lOgRtm` 一致。

九格串行顺序冻结为：

| 位置 | 任务 | 配置顺序 |
| --- | --- | --- |
| 1–3 | `verify-revise` 候选修正与验证 | C → S → M |
| 4–6 | `missing-prerequisite` 缺少只读前提 | S → M → C |
| 7–9 | `pressure-recover` 上下文压力恢复 | M → C → S |

C 为 B3 底座，S 加 Supervisor，M 再加上下文维护。每格一次、独立公共 fixture；不读写真实小说，不注入人工批准，`userAccepted=false`。前提阻塞和预算阻断不算业务完成，Supervisor 未实际触发时保留未触发，不按结果补跑。

### 无网络准备与只读复核

以下命令均成功：

```powershell
npm run eval:sdk-supervision-live:prepare -- C:\Users\Silence\.pi\agent\models.json
npm run eval:sdk-supervision-live:recover -- artifacts/harness/sdk-supervision-live/s4-live-orlzII
```

prepare 完成九项实际 SDK 序列化预检、三个配置公平性指纹和本地固定摘要校准。当前配置的压力请求为 43,920 字节，裁剪旧工具后 32,068 字节；加 6,144 输出预留与安全余量为 38,212，仍超过 32,768 产品压力合同。原生摘要载荷 29,392 字节，合成摘要后普通载荷 5,865 字节；历史保留。比上一轮合成配置多 11 字节，对应 `max_completion_tokens` 与 `max_tokens` 字段长度差异，没有修改 fixture 或额度；这些不是实际模型 token 或真实摘要质量。

只读恢复为 `status=prepared`、`sealed=false`，九格均未观测；真实派发 0、模拟派发 0、共享预留 0、pending/unknown 请求 0、actualCostUsd=null。准备探针的本地摘要校准不是 broker 派发或真实调用。目录只有一个 `manifest.json`，没有 claim、Journal、requests、raw 或 aggregate；复核前后 manifest SHA 一致，不能把未观测的九格写为通过或失败。

全局 `settings.json` / `models.json` 只核对前后 SHA，均不变；没有输出实际 endpoint、认证或其他 provider 配置。launcher 自建临时构建目录已清理，没有删除任何历史证据。与上一轮 493 文件验收快照相比，只有七个说明文档差异，代码/测试/配置无变化；本轮不重复执行 19 命令链，不把历史回归写作本轮重跑。三个本轮文档只回填准备事实与批准边界，不改变执行指纹。

### 批次预算与待确认边界

普通与原生摘要共用**每格最多 6 次、全批最多 54 次 HTTP**；单请求输出上限参数 2,048，最终请求最多 65,536 字节。单请求 90 秒、单格 480 秒、全批 2,700 秒；到硬限额、超时、未知派发、必要 usage 缺失或安全故障时停止全批，失败预留不退还，不增加隐式重试、命名或评判模型调用。

用户参考单价仍为输入/输出/cache 每百万 $0.75/$3.75/$0.075。满额输入估算/输出预留为 3,538,944 / 110,592，以全部输入按非缓存计算得到 **$3.068928（约 $3.07）**；不是账单、实际预计花费或金额硬上限。cache 无法核实时实际费用保持未知，不用 SDK 缺省零补算。

下一步需用户明确批准 **`s4-live-orlzII` / 上述精确 SHA 的执行，并接受缓存不明时费用未知**。若过期或源码/依赖/配置发生漂移，重新 prepare 并重新确认；不改写旧 manifest，不沿用旧 S2/S3 或 dry-run 的授权。完整 Phase 5、长篇创作、原生 Desktop 与发布验收仍未完成。

## 27. 第二十七增量：S4 首批实测，单项限额停止并封存

2026-09-23。用户在第二十六增量展示精确批次、模型、6/54 次额度、有效期和费用未知边界后明确确认。本轮只执行已批准的 `s4-live-orlzII`，没有追加调用、补跑、放宽规则、修改生产代码或全局 Pi 配置，未 commit/push。

### 执行与九格结果

执行前重新核对 SHA、未使用状态、有效期、HEAD、源码/依赖/runtime 和有效配置。模型仍为 `gemini-proxy / gemini-3.8-flash-high`，固定 SDK `0.63.1`，262,144 工作窗口、2,048 输出参数、thinking off；未改清单或旧预算。

```powershell
# 已执行并封存的历史命令，不得再次运行此批次。
npm run eval:sdk-supervision-live:run -- artifacts/harness/sdk-supervision-live/s4-live-orlzII C:\Users\Silence\.pi\agent\models.json --approve b0c02af70815e17a5e75e9e915b2893d45366b8ba04cc6ed3814f5800d34aa5c --accept-unknown-cost
```

入口正常退出并写入封存产物，但汇总为 **`incomplete`，不是全部测试通过**：1 pass、0 fail、1 unknown、7 blocked。实际 **12/54 次真实 HTTP，全部为普通请求，摘要 0**；共享预留 12，网络请求 unknown/pending 均为 0。

| 格 | 任务 / 配置 | HTTP | 机械状态 / 业务结局 |
| --- | --- | --- | --- |
| 1 | 候选修正 / C | 6 | pass / `verified_candidate`；当前候选验证匹配且正常结束 |
| 2 | 候选修正 / S | 6 | unknown / `SAFETY_STOP`；候选已验证，但第七次请求入口被拒绝，流程未正常结束 |
| 3 | 候选修正 / M | 0 | blocked / `BATCH_STOPPED`，未运行 |
| 4–6 | 缺少只读前提 / S、M、C | 0 | 三格 blocked / `BATCH_STOPPED`，未运行 |
| 7–9 | 压力恢复 / M、C、S | 0 | 三格 blocked / `BATCH_STOPPED`，未运行 |

两项已执行任务均只有 1 次写入、1 个 durable intent/result，当前公开候选 SHA 同为 `a68aafd1e21ace2133622b7ef0e1583d42b2f48b5583cc09d47aca1e414e9477`，验证回执与最终字节一致。C 为 5 次工具调用，S 为 6 次，两者各 2 次验证；S 没有正常最终答复，不能因文件已正确就把该格提升为 pass。所有九格 `userAccepted=false`，没有人工验收或 Canon 晋升。

### 停止原因与诊断边界

S 的六条请求均有完成用量；随后出现第七条 SDK 入口错误回执，载荷 6,836 字节，没有对应 HTTP 预留、请求绑定或 Journal 事件。对照固定传输门 `maxTaskHttpRequests=6` 及派发前拒绝代码，符合 `TASK_REQUEST_LIMIT` 路径；总批次 54 次上限没有耗尽，也不是上下文容量不足。工装按预登记策略停止整个批次，不能从剩余总额度给该格借用额度或继续后七格。

原始保留的终态码为 `SAFETY_STOP`、Supervisor `FAILED / AGENT_ERROR`，未单独持久化传输层的细分拒绝码；上述限额归因来自六条已完成请求、第七入口未派发及固定代码的交叉核对，不冒充落盘的细分错误记录。SDK bridge 另记 2 次本地 fetch 拒绝，均被拦在真实网络之前；`fetchAttempts=9` 不等于 9 次 HTTP。不声称上游代理内部是否重试。

两项任务的来源稳定、路径边界、历史完整、当前输入恰好一次、durable 写入对账均通过；没有记录越权写入或来源漂移。S 的 `unknown` 指整个任务没有正常结束，**不等于未知网络派发或未知写入**。无进展停止分支没有触发，维护与前提缺失任务尚未运行，不能据此判断 Supervisor 优劣、上下文维护效果或真实摘要质量。

### 用量、证据与只读复核

12 条真实请求均有 provider 必需用量：prompt **26,910**、completion **239**、reasoning **2,382**、total **29,531**。thinking off 仍返回 reasoning，继续分栏保留。cache 未报告，实际费用 **null / 未知**；$3.068928 是原满额预留参考，不是本次花费。

C 的 SDK 标准化 output 为 1,299（115 completion + 1,184 reasoning）；S 的六条已完成 SDK 回执 output 合计 1,322（124 + 1,198），但保存的 S `sdkUsage` 汇总按原规则为 null：七条 SDK 入口回执包含一条未派发错误，不能与六条实际 HTTP 绑定数直接等同。provider 原始用量仍可核验，没有把 SDK null 或缺省 cacheRead=0 当作 provider 缺失/零缓存来补算费用。

- 批次：`artifacts/harness/sdk-supervision-live/s4-live-orlzII/`。
- manifest 字节 SHA：`b0c02af70815e17a5e75e9e915b2893d45366b8ba04cc6ed3814f5800d34aa5c`，与批准时一致。
- aggregate 字节 SHA：`4aec58fb0498fd16488d007bfb19d78f56fbc7104b88d43bcb11404319ad23e9`。
- index 字节 SHA：`4146ef47f3443a883c4e779fd10f517f13b543d06569332e6ef6e5f609bca3b7`。
- 全部 50 文件排序路径到 SHA 映射的紧凑 JSON 摘要：`91c230c8dc573c1c956bba8908b6a399c115e4d469655467cc073084be3ad84b`。

`npm run eval:sdk-supervision-live:recover -- artifacts/harness/sdk-supervision-live/s4-live-orlzII` 在独立进程中只读复算，与保存 aggregate 完全一致；50 个文件 SHA 前后不变。Journal 为 `aborted` 并已 finalize，24 个事件对应 12 次预留及 12 次完整结算，批次 `sealed=true`。即使原有效期尚未到，**该清单已使用，剩余 42 次不是可再次使用的授权**。

全局 settings/models SHA 与执行前相同；自建临时构建/任务目录由 launcher 清理，没有删除历史证据。493 文件验收快照核对仍只有七个说明文档差异，代码/测试/配置无漂移。本轮未重跑完整 19 命令链，也没有扩充统一报告工具的 13 批目录；新真实结果独立封存，不覆盖已有报告。

### 后续范围

先补充有界传输停止码和请求入口/实际派发的诊断呈现，再审议每格及全批额度是否需要调整；这是下一项改进建议，本轮没有实施或追加授权。任何修改后的真实测试必须有新 manifest、新批准，保留此次不完整批次，不通过放宽旧判据或选择性补跑将它改为通过。完整 Phase 5、长篇创作质量、完整 Desktop/RPC 与发布验收仍未完成。

## 28. 第二十八增量：S4 停止诊断与下一批额度评估

2026-09-23。用户同意先补诊断，再评估额度。本轮仅修改 S4 评测工具、测试、命令和说明；**零新增真实模型请求，没有补跑旧批，没有新的正式 live manifest，没有变更生产源码、全局 Pi 配置或当前 6/54 限额，未 commit/push**。授权测试中的临时合成清单不属于真实调用批准。

### 实现与记录口径

- 新 manifest/raw/aggregate 为 v2。父 broker 保留传输层首个停止枚举及有界 offer 元数据：局部序号、普通/摘要类型、字节数、SHA、预留序号、派发/返回标记。保留精确原因，不写入载荷、异常原文、URL、认证、思考或摘要文本。
- `npm run eval:sdk-supervision-live:diagnose -- <batch-dir>` 先严格只读重建，再生成中文表格。分别显示 SDK 入口回执、broker 提交、HTTP 预留/派发、预留前拒绝、预留后未派发、派发后失败与本地 fetch 拦截，不把排队或被拒入口计为实际请求。
- v2 SDK 用量仅汇总与 HTTP 预留及绑定匹配的完整回执；额外的未派发错误回执不再将前六条完整 SDK 用量一起变成 null。provider/cache/费用口径不变，未知缓存不能用 SDK 默认零补算费用。
- 原 Journal 仍是请求持久化依据。诊断在单格结束时随 raw/index 封存，不承诺任意时刻强杀或断电都留下新的 offer 诊断；没有扩展恢复/replay 权限。
- v1 继续使用原字段和聚合规则，只读显示“历史未记录细分原因”。原打包生成的 profile 指纹显式冻结并继续校验，避免新增导入导致 bundle 标识符变化而误拒旧记录；v1 禁止再授权执行，旧批次不迁移或回写。
- 测试覆盖停止码保留、限额、超时、网络/Journal 故障、取消、usage 缺失、入口/派发分离、私密字段拒绝、诊断与 SDK/Journal 交叉校验及旧版只读兼容。重新计算 index 不能掩盖被修改的请求 SHA、序号或派发标记。

### 独立演练与历史只读复核

正常 v2 演练为 `artifacts/harness/sdk-supervision-live/s4-dry-5KJN9s/`，manifest 字节 SHA `b8483063a18e7e6472e0c8b42ce43c95696420ccebf047e86a3d088df9a041d4`。九格 **7 机械 pass、2 预登记预算阻断 fail**，21 次合成 HTTP（普通 20、摘要 1），真实请求 0。三个候选、三个前提受阻安全合同和一个只读恢复通过，不等于七章创作完成；77 个文件经 recover/diagnose 后 SHA 不变，映射摘要 `fb25f4bb480f9d9c72a4aed8b66a93be87c93840b88eab407049a282f06b1688`。

限额故障演练为 `artifacts/harness/sdk-supervision-live/s4-dry-noCvcW/`，manifest 字节 SHA `92fa498f332559f412b63f2c4ef8708773a252d2d1adce9435564714c2d56e0a`。第一格 unknown、后八格未运行，批次 incomplete；下方均为合成数据，不是重跑真实 S 格：

| 观测 | 数值 |
| --- | --- |
| SDK 入口回执 / broker 提交 | 7 / 7 |
| HTTP 预留 / 合成实际派发 | 6 / 6 |
| 预留前拒绝 / 预留后未派发 / 派发后失败 | 1 / 0 / 0 |
| 本地 fetch 拦截 | 2（非额外 HTTP） |
| 明确保留的传输停止码 | `TASK_REQUEST_LIMIT` |
| 六条完整 SDK input / output / total | 600 / 60 / 660 |
| 真实模型请求 / 实际费用 | 0 / null |

该故障批 32 个文件只读核验不变，映射摘要 `689a628086306c28393dffbfae1596990c96c99f96f9657272a14be1cd09910b`。provider 原始合成缓存未报告，SDK cacheRead=0 不使费用变为已知。

当前代码还对旧 v1 `s4-live-orlzII`（50 文件）及 `s4-dry-lOgRtm`（77 文件）分别执行 recover/diagnose，并逐文件比较前后 SHA。前者仍是原 incomplete、12 HTTP、S 格 SDK 汇总 null，完整映射仍为 `91c230c8dc573c1c956bba8908b6a399c115e4d469655467cc073084be3ad84b`；后者仍是原正常合成对照。没有向旧记录补写 `TASK_REQUEST_LIMIT`，历史交叉推断与持久化细分码严格区分。

package 命令变化使报告 builder 指纹改变，因此生成新包 `artifacts/harness/reports/report-UpnFP4/`，不覆盖 `report-Wsh9Yt`。manifest 字节 SHA `3cfd811da7f5e2b783f26d9635a16a34cfa3f03ac419d34e75e10548a22a3b57`，payload 映射摘要 `c65cdf75db1d0b694cb24a1e9632323068be610c29ed51ff62b82324f5b852c3`，builder 摘要 `00acbc187ed61403a7605287d0dd77e1f30b5a199f38340c201e8e0ae82eeb0f`。生成/verify 均成功，13/13 批核验一致；逐批 `selection` / `files` 与旧包相同，557 个原文件不变，新增模型请求 0。S4 live family 尚未加入这 13 批目录，不扩大分母。

### 额度建议与授权边界

建议后续先将每格/全批改为 **8/72 次**：给实际 S 所需的第七入口与一轮余量，而不是直接升到 10/90。只有两个真实格可供观察，不保证第七请求一定完成，也不宣称可靠性改善。仍保留九格各一次、相同任务与工具、普通/摘要共享、输出 2,048、原超时及安全故障停止全批规则，不为用满额度而请求。

按用户参考单价与每次 65,536 输入估算预留计算，8/72 的最大输入/输出预留为 **4,718,592 / 147,456**，满额非缓存参考 **$4.091904（约 $4.09）**；现行 6/54 为约 $3.07，10/90 为约 $5.11。不是实际 token、预计账单或金额硬上限，cache 无法核实时费用保持未知。完整比较见 [方案第 9 节](HARNESS_PHASE5_SDK_SUPERVISION_LIVE_PLAN.md#9-下一批额度评估建议未执行)。

本轮只评估，不改 `LIMITS` / ACK / namespace。获准后应实现新的版本化预算合同，保持旧 6/54 的 v1/v2 记录可读；离线检查后准备新清单，再单独确认精确 SHA 执行。不能复用旧批剩余 42 次，不能选择性补跑原七格，也不改变已封存 unknown。

### 验证与已保留的失败

开发期类型检查通过，首轮 S4 检查 130 项通过；随后又补旧生成式指纹兼容与重新封存后的诊断交叉核验，不将 130 项结果当作最终版本全验收。

第一次全新依赖回归 `artifacts/harness/isolated-run-QIW451/` 在第 4 条命令 `test:harness` 失败：既有 `P2-BUDGET real providers enforce pre-dispatch hard budget` 的 OpenAI-compatible **本地 loopback** 测试前两轮收到预期请求，第三轮为 0 而预期 1。此时还未执行新增 S4 套件。保留完整日志与 495 文件快照，没有成功 summary，不算 19 命令通过。

该旧测试未保留此次 SDK 错误详情，现有证据不足以定位根因；不将其宣称为已修复，也没有改测试、放宽断言、跳过它或调整生产代码。只做一次新的完整离线复跑，旧失败不覆盖、不删除；首次自建临时 checkout 已清理，不触碰历史遗留目录。

最终复跑 `artifacts/harness/isolated-run-doqNzV/` 成功：**495 文件快照、全新依赖、19 条命令全部通过**。source manifest 内容摘要 `d82f2b301986873daf4a642d2f5f2d7ba964aefff6271200efe6a5c20e72b032`；原 Harness 224 项 × 3 轮确定性通过，S4 live 工装最终 **134 项**、旧 S4 **188 项**、报告 **105 项**通过。之前的本地 HTTP 失败此次未复现；单次复跑通过不是已经找到或修复其根因的证据。

收尾只回填七个说明文件，代码/测试/配置与成功快照一致；生产 `src/`、`src-tauri/`、旧 Harness 测试和 lockfile 均未变更。全局 settings/models SHA 与本轮前相同。成功与失败两次自建临时 checkout 均已清理，旧证据和历史遗留目录未删除。原依赖 deprecation/allow-scripts 提示及前端 chunk 警告保留，不为本任务升级依赖或自动放行安装脚本。

这是本地未提交源码的隔离回归，不是远端 CI、已提交 clean clone、真实摘要质量或 Windows 原生 Desktop 发布验收；完整 Phase 5 仍未完成。

## 29. 第二十九增量：8/72 版本化预算、离线验收与新清单准备

2026-09-23。用户同意第二十八增量的下一步：实现 8/72 合同、验证并准备新清单，**实际执行仍需单独确认**。本轮真实模型请求 0，不补跑旧批，不改生产源码、全局 Pi 配置或依赖，不 commit/push。

### 新旧合同分离

新 manifest/raw/aggregate schema 为 **v3**，预算 namespace 为 `sdk-supervision-live-v2`，普通/原生摘要共用每格 8 次、全批 72 次。最大输入估算/输出预留为 4,718,592 / 147,456；单次 65,536 输入字节、2,048 输出参数、4,096 安全余量、12 次工具上限及 90/480/2,700 秒超时均不变，仍无隐式重试、命名或评判模型预算。

旧 v1/v2 继续绑定 `sdk-supervision-live-v1` 与 6/54 限额。清单、Journal、SDK 回执及诊断数量界限按该批 schema 核验，不能用新版常量误判旧第七入口拒绝。旧 v2 的生成式 profile 指纹单独冻结；v1/v2 均拒绝重新授权，不回写旧 stopCode/SDK 用量。新 ACK 明确 72 次，旧 54 次 ACK 即使搭配新清单 SHA 也会被拒绝；schema、policy、limits 与参考金额必须相互匹配。

三配置、三任务、九格顺序及各一次重复、公共 fixture、prompt/system、工具 schema 和权限不变，原人工压力合同仍为 32 KiB。没有选择性补跑旧七格，也不声称两次额外请求必然足够。

### 本轮检查与可复核演练

`npm run check`、`npm run check:harness-tests` 和 `npm run test:sdk-supervision-live` 均通过，S4 最终 **150 项**，launcher 网络隔离子测试 **61 项**另计。覆盖新旧普通/摘要共享限额、新第 9/73 次请求发送前拒绝、旧授权/旧 schema 执行拒绝、预算字段混用拒绝、8 次 Journal 重算哈希后仍不能降级成旧 6 次合同，以及 v1/v2 正常与失败只读兼容。其余验证、取消、故障、隐私字段和未知状态检查仍执行。

| 证据 | 正常演练 | 单项限额故障 |
| --- | --- | --- |
| 目录后缀 | `s4-dry-VTOLO8` | `s4-dry-LgU6xa` |
| manifest 字节 SHA | `be28f804960b320b03cb5e07a8ed4214b69cb5f45597e296a9da3951e23db503` | `e73ddf189d1f02de495dfb13e802aedaad5e698520d94f2f07698de99b1a543d` |
| 状态 | 7 机械 pass / 2 预登记预算阻断 fail | 首格 unknown / 后八格 blocked，incomplete |
| 合成 HTTP / 真实 HTTP | 21 / 0 | 8 / 0 |
| 停止诊断 | 无传输故障 | 9 次入口/提交，8 次派发，1 次预留前拒绝，`TASK_REQUEST_LIMIT`；2 次本地 fetch 拦截不算 HTTP |
| 文件数 | 77 | 38 |
| 文件映射 SHA | `f7f420366ce0f98961a83820f25044390ddd09720b7c2a5d4ee77b02a1162361` | `841199dec831ed993cc0dca6291b5deef1f057aea7bdaadb7340c066dd7fe373` |

两批位于 `artifacts/harness/sdk-supervision-live/`，共 115 文件 recover/diagnose 前后 SHA 不变。故障格的 8 条完整 SDK 回执汇总 input 800 / output 80，额外被拒入口不抹掉完整用量；缓存与实际费用仍未知。正常演练的前提阻塞安全合同不等于写作完成，合成摘要不等于模型质量。

另只读重建旧 `s4-live-orlzII`、`s4-dry-lOgRtm`、`s4-dry-5KJN9s`、`s4-dry-noCvcW`，236 个文件与修改前逐目录映射 SHA 完全相同；旧真实 S 格 SDK 汇总仍为 null，旧 v2 故障仍是 7 次入口、6 次合成 HTTP。旧报告 `report-UpnFP4` 原 builder 未变，verify 为 13/13、新增模型请求 0，未生成重复报告或扩充 catalog。

本轮只改七个 S4 工装/测试源码文件及说明文档，生产 `src/`、`src-tauri/`、旧 Harness、package/lockfile 和启动脚本与上一轮快照一致。**本轮未重跑全新依赖 19 命令链**；第二十八增量的 `isolated-run-doqNzV` 是历史基线，不冒充当前全量回归。其首次 P2 本地 HTTP 测试失败记录继续保留，不宣称本轮修复了它。

### 正式清单：准备完成，等待执行批准

- 目录：`artifacts/harness/sdk-supervision-live/s4-live-FJMrVf/`。
- manifest **字节** SHA-256：`963c576f10a383cfe3e489a99dd2cf6070a88714fea2c60d1d85a3d76fc317c1`。
- 创建 `2026-09-23T09:32:12.585Z`，到期 `2026-09-24T09:32:12.585Z`，即北京时间 **2026-09-24 17:32:12.585**。
- 配置投影：`gemini-proxy / gemini-3.8-flash-high`，`openai-completions`，262,144 工作窗口、每次输出参数 2,048、`max_completion_tokens`、thinking off。没有解析凭据值、调用认证命令或验证远端可用性；off 不保证上游不生成 reasoning。
- 66 项源码/依赖映射 SHA `dff4b460fd5d119844da41781adcd7bcb42c69a406444d4f5f59a19881cdc961`，fixture 映射 `6d61780ee7d7f9cb2c2f261ebf92507fe8e34cdf8ec45fb5eaa89f9b2d0ebdd1`；与本轮正常演练完全一致。固定 SDK `0.63.1`，lock SHA `961796cae467d5f8f68262865363eb95c484007a5ff2ea76eb7a798fb54d1bf0`。

prepare 的九项无网络 SDK 预检通过，压力载荷/裁剪后为 43,920 / 32,068 字节；加 6,144 预留与余量后仍需压缩。固定摘要校准为 29,392 字节，重建普通请求 5,865 字节，历史保留；不是 provider 实际 token。recover 为 `prepared`、`sealed=false`，九格均未观测，真实/模拟 HTTP、共享预留、unknown/pending 请求均为 0。目录仅一个 manifest，无 claim 或结果，复核前后 SHA 不变。

满额非缓存预留参考为 **$4.091904（约 $4.09）**，不是预计账单或金额硬上限；cache 不可核实时实际费用为 null。用户下一次确认须针对本批精确 SHA、8/72 普通/摘要共用额度及费用未知边界。没有执行 live，也不复用旧 42 次余额；到期或源码/依赖/配置漂移则重新 prepare、重新确认。全局 settings/models SHA 保持本轮前值，原小说不在工装范围。完整 Phase 5、长篇质量和 Desktop 发布验收仍未完成。

## 30. 第三十增量：8/72 清单获准实测并封存

2026-09-23。用户在看到第二十九增量的精确 SHA、模型、九项公开任务、普通/摘要共享 8/72 次额度、有效期和费用未知边界后明确要求“执行”。本轮只执行 **`s4-live-FJMrVf`** 一次，不准备替代清单、不补跑旧批、不追加请求，也不修改实现、提示词、评分标准或生产配置。

### 执行前核对与封存身份

- manifest 字节 SHA 保持批准值：`963c576f10a383cfe3e489a99dd2cf6070a88714fea2c60d1d85a3d76fc317c1`。执行前只有 manifest，仍在 24 小时有效期内；HEAD、66 项源码/依赖及模型配置未漂移。
- 目录：`artifacts/harness/sdk-supervision-live/s4-live-FJMrVf/`；模型 `gemini-proxy / gemini-3.8-flash-high`，SDK `0.63.1`，schema v3 / `sdk-supervision-live-v2`。
- 完整九格已运行，**`sealed=true`、`status=completed-with-failures`，7 pass / 2 fail / 0 unknown / 0 blocked**。两项 fail 是预登记的无上下文维护压力负例，原样保留，不改标为 pass。
- 共 **26 次真实 HTTP（普通 25、原生摘要 1）**，模拟请求 0、网络 unknown/pending 0；没有额外命名、评判或隐式重试调用。实际共享预留 26，输入估算预留 173,976、输出预留 52,838；这些预留不是 provider 实际 token。
- 92 个封存文件，aggregate 字节 SHA `e5d4f06043d29b7de6fad382e0be7cdc74e4c1e7e84f0f25a6c162ddf6f629a4`，index 字节 SHA `24dca9eda21c09a542ad1ae6af2239c9f0536a9d37e87a6b2f6b50f0a294fcc2`；完整文件映射的 canonical SHA 为 `a5f302c1de356320b33f0041584e07846d35b3b5b09879964b7ff4ea3f072e9f`。

### 九项结果（按批准顺序）

C 为共同 B3 底座对照，S 增加 Supervisor，M 再增加上下文维护；每格仅一次。

| 任务 / 配置 | 机械结果 | 业务结局 | 普通 / 摘要 HTTP | 写入次数 |
| --- | --- | --- | --- | --- |
| 候选修正 / C | pass | 当前候选已验证 | 4 / 0 | 1 |
| 候选修正 / S | pass | 当前候选已验证 | 5 / 0 | 1 |
| 候选修正 / M | pass | 当前候选已验证 | 8 / 0 | 1 |
| 缺少前提 / S | pass | 停止并报告前提缺失 | 2 / 0 | 0 |
| 缺少前提 / M | pass | 停止并报告前提缺失 | 2 / 0 | 0 |
| 缺少前提 / C | pass | 停止并报告前提缺失 | 2 / 0 | 0 |
| 压力恢复 / M | pass | 压缩后重读来源并给出只读答复 | 2 / 1 | 0 |
| 压力恢复 / C | fail | 产品预算门阻断，任务未完成 | 0 / 0 | 0 |
| 压力恢复 / S | fail | 产品预算门阻断，任务未完成 | 0 / 0 | 0 |

三项候选各有一次写入和一次 durable intent，最终文件 SHA 相同且当前版本验证通过；S/M 最终为 `COMPLETED_CANDIDATE`。三项缺前提任务没有写入或伪造批准。因此七项机械 pass 是“三项已验证候选、三项安全前提阻塞、一项只读答复”，不是七项正文完成。所有 `userAccepted=false`，没有 Canon 晋升。

M 压力任务先裁剪一个旧工具结果：原载荷 43,920 字节，裁剪后 32,068，加 6,144 字节预留/余量仍超过 32,768 人工压力合同，随后调用一次真实原生手动压缩。摘要请求 29,392 字节，压缩后首个普通请求 6,331 字节，加预留/余量为 12,475；原始历史保留，before/after checkpoint 均记录。随后读取一次当前来源、正确返回 marker，写入 0。`automaticCompactions=0`，这不是自动阈值压缩、任意历史质量或完整 256K 工作窗口的实测。

C/S 压力任务各有一个被产品预算门终止的 SDK 入口，**broker 提交与实际 HTTP 都为 0**，不能把入口计作调用或把零用量当作效率收益。诊断显示无传输停止，是因为阻断发生在传输之前；结合 `budgetBlocks=1` 与 `businessOutcome=budget_blocked` 才能解释该 fail。九格均没有触发 `NO_PROGRESS`，本批不证明重复失败停止分支的模型效果。

### 用量、只读复核与后续边界

26 个完整 HTTP 回执的 provider 原字段合计：**prompt 59,450 / completion 597 / reasoning 6,119 / total 66,166**。SDK 标准化为 input 59,450 / output 6,716 / total 66,166；SDK output 已包含 reasoning，不能再次叠加。两项零 HTTP 任务保持用量 null，不补造 provider 回执。

provider 未报告 cache，**actualCostUsd 仍为 null**；SDK 缺省 cacheRead=0 不能代替缓存证据。原先 $4.091904 是满额非缓存预留参考，不是本批花费，也不是承诺的金额上限。

`recover` 和 `diagnose` 均成功，重建结果与保存 aggregate 完全一致；92 个产物在复核前后逐文件 SHA 不变。此前六个选定 S4 批次共 351 文件也与执行前相同。收尾文档更新前，498 项工作区源码/文档基线全部不变；收尾仅更新六份阶段说明，不改代码、依赖、用户根目录规划文件或全局 Pi settings/models。运行器自建临时构建目录已清理，未删除历史证据或小说文件。

本轮不重跑离线 150 项或全新依赖 19 命令链；前者以第二十九增量的相同实现为证，后者仍是第二十八增量历史结果。本次没有原生 Desktop/RPC 发布验收，也未 commit/push。

**剩余 46 次额度不能复用，已封存清单不能再次执行。** 候选修正 M 本次恰用八次完成，并不证明八次总是足够；不同批次中 C/S 调用数也发生变化，不能把本轮结果简单归因于加额度或推导总体优劣。本批仅支持固定模型、固定合成任务、每格一次的集成事实，不推导 token/成本改善百分比或长篇创作质量。

下一步建议先把 S4 live family 接入统一只读证据报告，同时纳入旧失败批与本批，继续分开显示机械状态、业务结局、未观测分支和缺失费用；该报告适配本轮尚未实施，不新增模型调用。完整 Phase 5、公平大样本比较和原生 Desktop 发布验收仍未完成。

## 31. 第三十一增量：新旧 S4 live 接入统一只读报告

2026-09-23。用户同意第三十增量提出的下一步。本轮只修改报告适配、投影、显示、测试及说明，**新增模型请求 0**；不修改 S4 执行工装、原实验合同、原始证据、生产代码或全局 Pi 配置，不 commit/push。

### 读取与展示合同

`sdk-supervision-live` 成为第 11 种报告 family。catalog 保留原 13 项，显式增加 `s4-live-first-incomplete`（`s4-live-orlzII`）和 `s4-live-8x72`（`s4-live-FJMrVf`），不按状态选择通过格，也不将其他演练/故障批自动混入分母。

S4 live 与 S3 live 一样，分别保持各自原 CLI 的独立 bundle，在隔离 Worker 中只执行 recover。入口动作、bundle 和 guard 固定，没有 live/prepare 或凭据参数；原 v1/v2/v3 的 schema、profile 指纹、Journal、封存索引与 aggregate 检查仍执行。未封存批次拒绝进入已核验报告，原目录不补写任何字段。

报告将机械状态、独立业务结局、6/54 或 8/72 预算、请求预留、实际 HTTP 诊断、SDK 入口、原生压缩及 NO_PROGRESS 分支分栏。旧 v1 没有逐项细分传输诊断，保留缺失；不据后来的推断补写 stopCode 或 SDK 用量。批次历史 HTTP 仍由原 Journal 核验。没有一项 pass 被当作人工验收或 Canon 晋升。

S4 live 用量只汇总有 HTTP 预留的任务，并给出任务覆盖数、零预留数和未运行数。零请求任务没有 provider 回执，其原始 null 不改为 0，也不应抹掉其他任务的有效用量；但任一**有预留任务**缺失某个字段时，该字段总量仍为 null。SDK output 与 provider completion/reasoning 分开，cache 未报告不按标准化零值补算费用。

### 新包及实际读回结果

- 目录：`artifacts/harness/reports/report-CPUudb/`；包含独立的 `report.md`、`report.json`、选择清单、builder 源码映射和包 manifest，旧包不覆盖。
- 包 manifest 字节 SHA：`aa15c784d12958ca6b1aab02adc5bdfa8915b7a4399fe5f510705ffb219b274d`。
- 15 项选择清单 canonical SHA：`bb6133df71a5b5206347183efe123c2d055b3b2f5a52338628d374a0b97cf47c`。
- 93 个 builder 源码/依赖项映射 SHA：`c4d9c323fcc30e9ab30d20832f0c6e6bb57094339ca8d2debccb955fe000931a`。
- report.json 字节 SHA：`87b7707d809c92fc95befee2ce895c5b0c9b48c5dc8825623219821edf081208`；report.md 字节 SHA：`a3f4d2dd183cb61e0d3e0b026484dedac0c40569ac626bb6610980b9018196ec`。

| S4 批次 | 原预算 | 机械结果 | 历史 HTTP | 有预留任务 / 九项 | provider total / SDK output |
| --- | --- | --- | --- | --- | --- |
| `s4-live-orlzII` | 6 / 54 | 1 pass、1 unknown、7 blocked | 12 | 2 / 9，另七项未运行 | 29,531 / null |
| `s4-live-FJMrVf` | 8 / 72 | 7 pass、2 fail | 26（25 普通、1 摘要） | 7 / 9，另两项预算阻断、0 HTTP | 66,166 / 6,716 |

两批 cache 和实际费用均为 null，旧 SDK 缺失保持原样。新批业务为三项候选已验证、三项前提缺失时停止、一项只读答复及两项预算阻断；旧批的 unknown 与未运行项不补成完成。两批 NO_PROGRESS 均未触发，未观测项另列，不推断总体可靠性或成本收益。

### 验证与范围

- `npm run check`、`npm run check:harness-tests` 通过。
- `npm run test:evidence-report`：**199 项，11 种 family，真实模型请求 0**。新增 v1/v2/v3 原校验器只读兼容、缺失/零请求/缓存计数、人工批准拒绝、分支显示、用量覆盖、确定性重建、重新签索引后的非法 raw、伪造 aggregate、错误 profile 指纹及未封存拒绝测试；测试 fixture 是合成报告记录，不是新增 SDK 或模型实测。
- `npm run eval:report` 与 `npm run eval:report:verify -- artifacts/harness/reports/report-CPUudb` 均 **15/15**；verify 从原始证据重建，不只比较保存的汇总。
- 15 批共 **699 个原文件**与本轮前 SHA 完全一致；旧 `report-UpnFP4` 五个文件也未变。新报告前 13 批完整报告项与旧包逐字段相同，仅增加两批 S4。
- 新 S4 清单绑定的 66 项源码/依赖仍与原冻结值一致；新报告 93 项 builder 指纹与当前代码一致。全局 settings/models、用户根目录规划文件、原小说与生产源码不变。

本轮修改七个既有报告/测试/启动器源码文件，新增 `tests/report/supervision-live.ts`，并同步七份说明；没有改 package/lock 或原 S4 代码。临时构建和合成测试目录由运行器清理，历史报告及批次全部保留。

**本轮未重跑全新依赖 19 命令链或 S4 执行工装 150 项**；二者分别仍是第二十八、二十九增量的历史证据，不能冒充当前全量回归。当前交付是只读报告集成及其定向验收，不是远端 CI、clean clone 或原生 Desktop 发布验收。

下一步可先完成一次全新依赖回归和交付范围审查，再按用户要求提交/推送；不自动扩大模型样本或复用旧预算。完整 Phase 5、完整历史 Desktop/RPC 对照、长篇人工质量评审和发布验收仍未完成。

## 32. 第三十二增量：完整隔离回归与交付范围复核

2026-09-23。用户同意第三十一增量的后续建议。本轮执行当前完整的本地隔离链与只读交付检查，**19/19 条命令全部通过，新增模型请求 0**。不修改实现、依赖、评测合同或旧实测，不暂存、commit 或 push；收尾只更新六份说明文档。

### 全新依赖快照

- 证据目录：`artifacts/harness/isolated-run-RqGXwI/`，包含 `source-manifest.json`、19 份命令日志和成功的 `isolated-summary.json`。
- Windows / Node `v24.19.0`，代码基点 `d3018347761fa5007b98145a1795d9070318cc00`。这是未提交工作树的显式白名单快照，不是已提交 clean clone 或远端 CI。
- **496 个源文件**，在新建临时 checkout 中执行 `npm ci --no-audit --no-fund`，安装 327 个包；没有复用工作区 node_modules。
- source manifest 内容 SHA：`2bf37508878e513a71a794431a974da141d7291c11d6b7e04712526bad65d263`，按排序路径到文件 SHA 的紧凑 JSON 计算，不是美化文件的字节 SHA。
- 19 条命令覆盖两项类型检查、Harness、长程合同、小说领域、前端构建、模块评测、Pilot、S1/S2、S3 上下文/生命周期/传输/独立工装/恢复竞态、S4 离线/独立工装及统一报告；精确命令与退出码见 summary。

| 关键检查 | 本轮结果 |
| --- | --- |
| Harness | 224 项 × 3 轮，672 个 PASS，0 partial/fail，确定性一致 |
| 长程合同 / 小说领域 | 长程 1 项 × 3 轮；领域、扩展、验证器、世界观回退与记忆 smoke 均通过 |
| S1 / S2 | 101 / 95 项通过 |
| S3 上下文 / 生命周期 / 传输 / 工装 / 恢复竞态 | 103 / 175 / 96 / 83 / 125 项通过 |
| S4 离线 / 独立工装 | 188 / 150 项通过；网络 launcher 的 61 项子测试另计 |
| 统一报告 | 199 项、11 种 family，通过；合成报告记录不是新增模型实测 |

预登记负例仍保留为任务 fail；套件通过只说明预期合同成立，不把缺能力、预算阻断或未知写入当作业务成功。第二十八增量的本地 HTTP 偶发失败本轮未复现，原 `isolated-run-QIW451` 仍保留，未定位其根因或宣称已修复。

### 交付范围与证据保持

开始时记录 499 个工作区文件、15 个选定批次和报告目录的哈希。回归结束、文档回填前，**499 个工作区文件全部不变**；快照只排除了三个用户根目录规划/研究文件，没有遗漏当前 187 个待交付候选文件。候选范围限于既定 Phase 5 源码、测试、配置与说明，不使用 `git add .`。未发现禁入的私人 fixture、Pi 配置、产物目录或常见固定格式凭据；该有限扫描不是全面安全审计。

现有 `report-CPUudb` 再次从原记录核验 **15/15**，报告指纹仍为原 93 个 builder 项，不生成替代报告或扩大分母。**699 个原证据文件、40 个历史/当前报告文件、全局 Pi settings/models、Git HEAD 和 index 均不变**；旧失败、unknown、费用 null 与不能复用的预算继续保留。

本轮自建临时 checkout 已由脚本清理，仅保留上述独立日志目录；历史临时目录 `pi-harness-isolated-Qyc6oL` 未触碰。文档回填不改变测试过的代码、测试或配置，也不重写本轮冻结的 source manifest。

### 保留的警告与验收边界

- `npm ci` 的 `node-domexception` 弃用及 esbuild/koffi/protobufjs 的 allow-scripts 提示保留；本轮未改变全局脚本批准策略，也未执行依赖升级或 `npm audit`。
- 前端构建成功，既有动态/静态混合导入及超过 500 kB 的 chunk 警告保留，不称为无警告构建。
- 本轮没有新增真实样本，没有 Rust 编译/原生窗口/发布包验收，也没有运行远端 CI；整个 Phase 5、正式大样本比较和人工创作质量评审仍未完成。

当前本地回归和交付范围复核没有新增阻塞项。下一步可在用户要求后按白名单审查暂存内容并提交/推送；提交不自动发布原始 artifacts，也不构成新模型调用或旧预算复用授权。
