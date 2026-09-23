# Phase 5 S1：同 SDK 读写对照适配

实现入口为 `evals/sdk-ablation/`；固定仓库 Pi SDK `0.63.1`，只接受公开合成 fixture。**没有 live 入口，不读取用户模型/认证设置，不调用真实模型。** 当前适配的是 SDK 工具分派、开始/结束和写入对账边界，不是完整历史 Desktop、Rust/RPC 会话恢复或正式模型效果对照。

## 1. 两个可运行 profile

| Profile | 固定实现 | 不包含 |
| --- | --- | --- |
| `sdk-b0-safety-fixed` | 原始基线扩展 + 公共安全包装 + 同一 SDK 的原生 read/write | 工具重试、operation ledger、Observation、请求预算产品策略、Checkpoint、压缩、Supervisor、maintenance |
| `sdk-b1-reliability` | 同上 + 冻结 Phase 1 的 `createToolRuntime` / `createOperationLedger` + 显式 SDK 生命周期适配 | B2/B3 及后期钩子；也不声称覆盖完整 Phase 1 Rust/RPC 恢复 |

两者通过隔离 ResourceLoader 加载同一基线，不加载当前全量生产扩展或全局扩展/skills。共同的有效工具为 `read_story_document`、SDK `read`、SDK `write`；角色通过会话自定义条目绑定为 write。两任务的业务提示、有效系统提示和工具 schema 在 prepare 后冻结；对应任务跨 profile 必须相同，否则拒绝 manifest。

`evals/variants.ts` 的完整 `b0-safety-fixed` / `b1-tool-session` 仍为 `not_implemented`：本增量使用显式 `sdk-*` 身份，不将这个有限切片改名成完整历史桌面版本。B2/B3 和更大生命周期对照仍待独立实现。

## 2. 原始基线与安全补丁审计

原始代码固定到 `3b5f8b06131d46ee0b4b97dd646ba3d6f6bcd887`；两份快照逐字节保存于 `evals/sdk-ablation/baseline/src/`。`baseline/provenance.json` 保存 commit、Git blob、原字节 SHA 与本地 SHA。当前两份原始文件本来就是 LF，两种 SHA 相同，没有把当前文件替换成“旧版”。运行前核对文件 SHA 和本地 Git 原对象；缺历史对象时停止，不偷用当前实现。

原始基线扩展的普通 active-document parser 缺陷**保留**，有负测试证明；没有顺便加入 Phase 0 的解析功能修复，也未修改全局扩展。生产 `src/` 没有变化。

安全差异全部集中在 `extensions.ts` / `safety.ts`，对两 profile 相同：

| 改动 | 必要性及行为变化 | 验证 |
| --- | --- | --- |
| 将生成源码的导出入口改为内部 `registerRawBaseline`，再显式导出公共包装 | 只用于插入可审计的包装，不改磁盘中的原始快照 | 源码入口计数和生成内容 SHA |
| 活跃工具限于上述三项；原始扩展其他工具不注册 | 本轮不运行 verifier、shell、检索或任意路径任务，防止借未纳入预算的工具触发外部动作 | 实际注册表、SDK 工具集、未知工具拒绝 |
| 元数据必须存在、有效、formatVersion=1，并拒绝链接 | 原始基线在元数据损坏时可能放行写入；本轮限定为 Novel Project，不回退普通代码项目 | 原始 handler 放行、包装后 read/write 均阻止的成对测试 |
| 规范相对路径、拒绝越界、混合分隔符、盘符/ADS、链接与 junction | 原始 read_story_document 可沿项目内链接读到外部文件；内置 read 也需要相同底线 | 临时沙箱外哨兵的 raw 正向复现与 fixed 拒绝；多类路径负例 |
| 相同的外层精确任务路径/工具数/调用数上限 | 保护评测环境，不归功于 B0/B1 产品能力，也不代替 B1 对账 | 越限、未知工具/路径、调用前取消测试 |

这是受信任代码的隔离测试，不是 OS 安全沙箱，也不声称解决敌对并发文件系统的 TOCTOU。所谓“外部哨兵”仍在本次专用临时目录内，绝不读取用户文件。路径限制比通用 SDK 更窄，例如本轮不接受绝对文件路径；这是共同边界，不作为可靠性收益。

## 3. B1 增量与能力泄漏检查

B1 工厂来自已核验的 Phase 1 模块快照，provenance 沿用 `evals/adapters/provenance.json`。适配层负责把 SDK tool_call/tool_result、agent_start/agent_end、session_switch/session_shutdown 连接到这些工厂：

- 只读瞬时错误最多重试两次；权限/合同错误不盲目重试，不修参数或刷新来源。
- 写入记录前指纹、目标后指纹及作用域；回执丢失后从实际文件对账。相同意图的新 call ID 可以识别已满足目标，阻止再次派发。
- 内容与前/后指纹均不一致时保留 unknown，不把部分写入当成功。
- 结束/切换取消在途运行，保留 operation tombstone；来自旧 project、session、role 或 generation 的结果不能完成当前操作。
- SDK 0.63.1 不把 tool_result 对原生错误的修改当作成功：适配器不伪装改写成功回执，而由后续工具调用进行对账。

审核既检查生成源码 SHA，也检查实际工具/命令/事件注册数量。测试主动加入 `session_before_compact`、`session_compact`、`before_provider_request`、`turn_end`、额外 context 回调或 `get_context_budget`，必须拒绝；不只相信 feature flag。作用域迟到结果测试直接驱动 SDK 载入的 handler；主矩阵则通过真正 AgentSession 的调用循环触达工具与开始/结束事件，两者证据分开解释。

## 4. 固定任务与负结果含义

`P5A-READ-001` 读取合成 `canon/world.md`，检查真实读取、无业务写入和最终 JSON。`P5A-TOOL-001` 将固定标记写入 `drafts/candidates/sdk-ablation-probe.md`，首次原生写入成功后丢弃回执，再读回确认。

S1 模型回复由确定性脚本产生：TOOL 主矩阵故意在丢回执后使用新 call ID 重放同一写入，之后读回。**这不是模型选择，不能外推真实模型必然重写，也不能用它计算真实恢复率。** 另有正向对照改为丢回执后直接读回，基线也应能通过；瞬时只读错误另作故障测试。

SDK 的 `createAgentSession({ tools })` 在该固定版本中只用工具名选择内置实现。故障注入与计数因此放在 SDK 完成注册后的实际 `execute` 上，不能给入口传一个未被使用的包装函数后宣称测到了写入。

`writeDispatches` 是实际进入原生写函数的次数，`duplicateWriteDispatches` 是同一预登记逻辑写入的额外派发。本案例覆盖写入内容相同，因此**不声称有重复正文或额外事实**，也不把重复派发与字节内容重复混为一谈。

主矩阵固定 2 profile × 2 task × 3 轮，共 12 次；每轮 READ 顺序 B0/B1，TOOL 顺序 B1/B0。无失败补跑。预登记的、只写临时标记文件的基线重放失败会保留为 fail 并继续固定矩阵；非预期结果停止后续运行，剩余项记录 blocked。这条合成负例规则不授予正式真实批次在出现安全失败后继续的权限。

## 5. 产物与复核

```powershell
npm run check:harness-tests
npm run test:sdk-ablation
npm run eval:sdk-ablation
npm run eval:sdk-ablation:rebuild -- artifacts/harness/sdk-ablations/<batch-id>
```

`test:sdk-ablation` 包含完整 12 格矩阵并保存新批次；`eval:sdk-ablation` 是只跑矩阵的离线入口。每次运行创建唯一目录，包含不可变 `manifest.json`、12 个 raw、`result-index.json` 与 `aggregate.json`。manifest 在矩阵开始前落盘，冻结源码/依赖运行树、fixture、profile、提示/工具哈希、顺序、预算与脚本驱动版本。

父/子进程均禁网，子进程禁止再启动进程；环境是白名单，不继承认证路径和 key。每次任务使用独立 fixture/agentDir/session，禁止自动压缩、自动重试、自动命名，子进程有 30 秒上限。子进程清理只针对验证过的专用临时目录。

只读重建不加载用户配置、不发请求、不改批次。拒绝缺格、重复、额外记录、错误 profile/顺序、源码摘要/记录 SHA 漂移、不完整 PASS、超限、未知字段和越界路径。原始文本、异常详情与凭据不进入公开记录，答案只保存固定诊断码。

实际 provider usage 没有发生；`syntheticUsage` 只来自合成流，不能用于费用或 token 节省。缺失合成 usage 为 null。子进程回执丢失时 metrics 也为 null，聚合列出 missingMetrics，绝不填零冒充“没有写入”；已观测到的写入次数不会因后续审计失败被清零。

已完成的最终源码批次为 `sdk-s1-IRrezl`：12 runs，9 pass、3 预登记基线负例 fail，36 次合成回复调用，真实 HTTP 为 0。全新依赖隔离回归 `isolated-run-TRAxlc` 的 10 条命令全部通过，包含 101 项 SDK ablation 检查；详细数字与 SHA 见 [结果记录](HARNESS_PHASE5_RESULTS.md) 第十增量。CI 与隔离脚本已纳入独立入口，但本地回归不代表远端 CI、Linux 或原生 Desktop 已验收。

## 6. 仍待实施

S1 本身不包含真实比较入口；后续新增的独立计量/Journal/批准工装见 [S2 说明](HARNESS_PHASE5_SDK_LIVE.md)，两者记录和 driver 身份分开。候选 24 次真实请求仍未授权，不使用之前的 pilot 额度。B2/B3、原生摘要/compaction、Supervisor/maintenance 独立对照、真实 Desktop 会话恢复和 UI 验收仍未覆盖；完整 B0/B1 的名称与总清单保持未完成。
