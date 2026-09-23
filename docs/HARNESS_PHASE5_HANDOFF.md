# Phase 5 当前交接与证据索引

2026-09-23。回归快照的代码基点为 `d3018347761fa5007b98145a1795d9070318cc00`；用户现已批准按第 4 节范围提交并推送 Phase 5 交付。这里是当前状态入口，详细历史保留在 [结果记录](HARNESS_PHASE5_RESULTS.md)。**不宣称整个 Phase 5 完成；各真实批次均另获明确批准，本次源码交付不追加模型调用。**

最新第三十二增量已完成全新依赖的本地隔离回归：`isolated-run-RqGXwI`，496 文件、**19/19 条命令通过**，含 S4 live 150 项和报告 199 项；新增模型请求 0。当轮交付范围复核未见新增阻塞，收尾只回填说明，原始证据、报告、全局 Pi 配置和 Git index 均未改变。后续用户已批准提交/推送；提交身份与远端同步状态以 Git 记录为准，不能将提交前回归改写为提交后 clean-clone 验收。

## 1. 已交付与尚缺项

| 层级 | 当前证据 | 能说明什么 / 不能说明什么 |
| --- | --- | --- |
| 离线模块合同 | 7 个可运行 profile × 6 个任务 × 3 轮；90 pass、36 unsupported、0 fail | 模块合同与缺失能力分类；不是完整历史 SDK/Desktop 对照 |
| Pilot 工装 | 限额、隔离、usage、Journal、V1/V2 重建与安全答案诊断；310 项离线检查 | 工装在列明的合成故障下工作；模拟 usage 不算真实计量 |
| 旧真实批次 | READ fail，WRITE blocked，3 HTTP | 保留负结果；原始答案未留存，具体失败原因未知 |
| 新真实批次 | READ/WRITE 均 pass，6 HTTP，provider total 9,842 | 固定 SDK 的最小读取/受控写入集成；不是创作质量或长程稳定性 |
| 同 SDK 读写切片 | 101 项检查通过；固定 12 格矩阵为 9 pass、3 预登记基线负例 fail，真实调用 0 | 见 [S1 说明](HARNESS_PHASE5_SDK_ABLATION.md)；不是完整历史版本或真实模型比较 |
| SDK 切片首批实测 | S2 工装离线验收后另获批准；四项真实运行 3 pass、1 格式 fail，10 HTTP、0 unknown | 见 [S2 说明](HARNESS_PHASE5_SDK_LIVE.md)；每格仅一次，两项 TOOL 均普通读回成功，不能推断总体优势 |
| SDK 上下文与压缩离线切片 | S3 103 项检查；27 格为 15 pass、12 预登记负例 fail，9 次原生压缩/跨进程重开，真实请求 0 | 见 [S3 说明](HARNESS_PHASE5_SDK_CONTEXT.md)；摘要为固定文本，自动压缩关闭，不是模型效果或完整恢复生命周期 |
| SDK 自动压缩/未知写入离线切片 | S3 v2 175 项检查；54 格为 30 pass、24 预登记负例 fail，72 次自动压缩、36 次进程重开，真实请求 0 | 见 [生命周期说明](HARNESS_PHASE5_SDK_LIFECYCLE.md)；合成 usage/overflow 触发，结果未知时的安全阻塞不等于任务完成 |
| SDK 普通/摘要统一出口预检 | 96 项检查；10 个预登记离线探针，真实请求 0；实际 SDK 序列化/parser 与原生双摘要均共享额度/Journal | 见 [传输预检](HARNESS_PHASE5_SDK_CONTEXT_TRANSPORT.md)；预检自身只覆盖传输核心 |
| S3 限定任务/新批次工装 | 83 项检查；B2/B3 各两项任务接入同一出口，11 个离线正常/故障批次，工装离线测试真实请求 0 | 见 [新工装](HARNESS_PHASE5_SDK_CONTEXT_LIVE.md)；另获批准后的真实批次单列如下 |
| S3 限定任务首批实测 | `s3-live-t6GSPA` 四项均 pass，27 次真实 HTTP（普通 25、摘要 2），0 unknown | 2 次真实原生手动压缩、2 次跨进程恢复；每格仅一次，不推断 B3 优势、自动压缩效果或摘要通用质量 |
| S3 受控强杀/迟到结果 | 125 项检查；12 次实际子进程强杀、15 次独立重开，恢复端写入派发 0；10 项 adapter 回调场景单列 | 6 项对账完成，6 项仍未知并安全阻止；仅固定屏障，不代表任意断电、父 broker 或完整 Desktop 恢复 |
| 可重建证据报告 | 199 项工装检查、11 种 family；15 个选定封存批次核验通过，699 个原文件不变 | 已同时纳入旧未完成与新 8/72 S4 live；机械/业务、预算、未观测分支、用量覆盖与费用缺失分开，不是全量统计或正式消融完成 |
| S4 Supervisor / 上下文维护 | 188 项检查；三个配置 × 五任务 × 三轮，27 机械 pass、18 预登记负例 fail，真实请求 0 | 验证停止门、旧工具裁剪及一次原生压缩；安全停止不等于业务完成，摘要与工具选择是合成数据 |
| S4 最小真实首批 | `s4-live-orlzII` 另获批准执行；12 次真实 HTTP，1 pass、1 unknown、7 未运行，已封存 | [精确清单及结果](HARNESS_PHASE5_SDK_SUPERVISION_LIVE_PLAN.md#7-已执行封存的精确清单)；第二格触及单项限额，全批 incomplete；不比较 Supervisor/维护效果、不复用余额 |
| S4 停止诊断 v2 | 134 项检查、19 命令隔离回归通过；停止枚举、入口/HTTP 分离及 v1 只读兼容 | 见结果第二十八增量；首次旧测试失败保留、根因未定位；该增量未改生产 runtime 或当时的 6/54 额度，真实请求 0 |
| S4 版本化预算与新清单 | schema v3 / namespace v2，8/72 次普通/摘要共享；150 项离线检查通过，旧 v1/v2 按 6/54 只读兼容 | 见结果第二十九增量；准备与实际执行分别获准，新批执行结果单列；未冒充全新依赖 19 命令回归 |
| S4 新 8/72 实测 | `s4-live-FJMrVf` 九格均运行并封存；26 HTTP（25 普通、1 摘要），7 pass、2 预登记压力 fail，0 unknown/blocked | 见结果第三十增量；维护配置真实压缩后完成只读答复，无维护的两格在 HTTP 前被预算门阻断；每格一次，未触发 NO_PROGRESS，不推断总体优势 |
| 正式全生命周期对照 | 完整 B0-safety-fixed → B3 仍未完成 | SDK 切片不能替代 Rust/RPC 恢复、真实摘要质量、任意时刻崩溃或更大任务范围 |
| Supervisor / maintenance 真实对照与 B4 | 已有限定离线及九格各一次的真实样本，旧提前停止批保留；完整比较未完成，B4 未实施 | 不出改善百分比，不把安全停止当写作完成，不引入向量库或自动多 Agent 编排 |
| 原生 Desktop / 发布 | 本次未验收 Rust bridge、窗口交互或发布包 | 不把 SDK 测试写成 Windows 桌面 release 验收 |

`current-full-contract` 的 feature flag 描述生产能力存在，不代表任务触达了 native compaction、Supervisor 或 maintenance。C3 与 current-full 在现有模块任务中使用相同 factory，不能当成独立的效果对照。

## 2. 封存批次

所有目录均相对仓库根；原始产物位于已忽略的 `artifacts/harness/`，不会默认随源码提交。

| 批次 | 目录 | manifest SHA-256 |
| --- | --- | --- |
| 离线模块矩阵 | `artifacts/harness/evals/offline-eOyK60/` | `e1e173c5246c24e578d6013d5a6c354f846a1838b566960fc5715e7a02992e68` |
| 旧真实失败批 | `artifacts/harness/live-pilots/live-CwHPbD/` | `932c097373b908e4bac720a47c5db666e2a10cd01eeefb95e6640b013abec3e5` |
| 新真实通过批 | `artifacts/harness/live-pilots/live-mHOnDl/` | `f131737c6669d12645e1936b39d75adf448c311316e00adb71b60afee381848d` |
| 同 SDK 离线读写矩阵 | `artifacts/harness/sdk-ablations/sdk-s1-IRrezl/` | `d1af61d74e423abca0e548dec9fb92950d75a37138709a3cb413ab89299f9f92` |
| S2 离线 broker 读回 | `artifacts/harness/sdk-live/s2-dry-mQwGip/` | `1bc1f84e93b3758eb3bb896f4c9827a3240a1f4a007abe9d86165f1afbdd3f22` |
| S2 首批真实成对测试 | `artifacts/harness/sdk-live/s2-live-RGcvnD/` | `470d9fe6e553df8321362a8837923493aad6c8a9dc7a96a06c1224b47eba2d58` |
| S3 上下文/压缩离线矩阵 | `artifacts/harness/sdk-context/s3-offline-L8cMsW/` | `fd1459faa1363d169954ba7c6549e69bdd51fb556758cbbfcb0e7e13a6fab8c7` |
| S3 自动压缩/未知写入 v2 离线矩阵 | `artifacts/harness/sdk-context/s3-lifecycle-b8USvY/` | `00a8069c47b5c6fada72279acac0a67de4097bfb13a5eb54c2cfcb8cadfd958a` |
| S3 统一出口双摘要离线预检 | `artifacts/harness/sdk-context-transport/s3-transport-sYv5iO/` | `169880a67c40ed40b6eb0614eecef0be20e6c741f4318edf97b6fe22f396b09a` |
| S3 限定任务工装离线正常路径 | `artifacts/harness/sdk-context-live/s3-dry-0jsA0Z/` | `9b0f999e162472930b41e03bdae35218900a7a7b187c3fd97e5b419114f776ef` |
| S3 限定任务首批真实运行 | `artifacts/harness/sdk-context-live/s3-live-t6GSPA/` | `4afa54958f6ba24454a49453da40a8c40a014951f2a966e1a1b70ce04a159d86` |
| S3 受控强杀/迟到结果离线矩阵 | `artifacts/harness/sdk-recovery-races/s3-races-ow4RXU/` | `92da2b35260ccb5002035c7f177fd212a44a958a9ba772bc9a016995e7d92823` |
| S4 Supervisor / maintenance 离线矩阵 | `artifacts/harness/sdk-supervision/s4-offline-zg1l2J/` | `1ba6406ce608e4d1241689d943dc08726330e900cf1c882142578f5914be1151` |
| S4 首批真实运行（提前停止） | `artifacts/harness/sdk-supervision-live/s4-live-orlzII/` | `b0c02af70815e17a5e75e9e915b2893d45366b8ba04cc6ed3814f5800d34aa5c` |
| S4 新 8/72 真实运行 | `artifacts/harness/sdk-supervision-live/s4-live-FJMrVf/` | `963c576f10a383cfe3e489a99dd2cf6070a88714fea2c60d1d85a3d76fc317c1` |

这些批次都已经执行并封存，不可再次使用原清单运行。两次旧 pilot 分别 3、6 次 HTTP，S2 为 10 次，S3 为 27 次；不能把不同任务合同的数据合并为成功率，也不能使用旧批剩余额度。

S4 首批为 12 次普通 HTTP、0 摘要，1 pass / 1 unknown / 7 blocked，网络请求 unknown/pending 均为 0。provider prompt/completion/reasoning/total 为 26,910 / 239 / 2,382 / 29,531，cache 缺失、费用未知。50 个产物只读重建一致；第三十一增量已将它与新 8/72 批同时接入统一报告，旧失败和缺失信息不改写。

S2 最新真实批次 provider 原始用量为 prompt 12,121、completion 243、reasoning 3,016、total 15,380；cache 未报告、费用未知。SDK 标准化 output 3,259 与 provider completion 不是同一字段。参考费率已按用户提供的输入/输出/cache 每百万 $0.75/$3.75/$0.075 记录；缓存缺失不按零补算。当前没有成本节省结论。

S3 首批实测 provider 原始用量为 prompt 71,676、completion 979、reasoning 7,201、total 79,856；SDK 标准化 output 为 8,180。cache 仍未报告，实际费用为 null。满额预留参考 $1.818624 不是本轮花费；不以 SDK 的缺省 cacheRead=0 补算实际费用。

### 最新 S4 封存结果

第二十九增量准备的 `s4-live-FJMrVf` 已在用户单独批准后于第三十增量执行、封存。模型为 `gemini-proxy / gemini-3.8-flash-high`；只有独立公开合成 fixture，没有真实小说。26/72 次真实 HTTP（普通 25、摘要 1），7 pass / 2 fail / 0 unknown / 0 blocked，批次 `completed-with-failures`，网络 unknown/pending 均 0。

三项候选均验证通过，三项缺前提均安全停止，压力 M 真实压缩后重读成功；压力 C/S 在产品预算门阻断，保留 fail、实际 HTTP 0。未触发 NO_PROGRESS，不把安全停止或 SDK 入口当作完成/HTTP。provider prompt/completion/reasoning/total 合计 59,450 / 597 / 6,119 / 66,166，cache 未报告、费用未知；满额参考 $4.09 不是实际费用。

92 个产物只读重建与保存 aggregate 一致，文件映射 SHA `a5f302c1de356320b33f0041584e07846d35b3b5b09879964b7ff4ea3f072e9f`；旧六批 351 文件和全局 Pi 配置不变。清单即使未到期也不能复用，剩余 46 次额度不构成新授权。当前没有待执行清单或自动后续调用。

### 当前统一报告包

第三十一增量生成 `artifacts/harness/reports/report-CPUudb/`，包 manifest 字节 SHA 为 `aa15c784d12958ca6b1aab02adc5bdfa8915b7a4399fe5f510705ffb219b274d`。15/15 原记录重建通过，699 个原文件不变；原 13 批报告项与旧 `report-UpnFP4` 完全相同，旧报告五个文件也未变化。报告工具 199 项检查覆盖 11 种 family，新增真实请求 0。S4 live 按原 CLI 独立打包只执行 recover，不改旧预算、诊断或 SDK 用量；详情见 [报告说明](HARNESS_PHASE5_EVIDENCE_REPORT.md)。

## 3. 安全复核与重跑

以下只读重建不读取 provider 认证、不发模型请求、不修改被审计批次：

```powershell
npm run eval:rebuild -- artifacts/harness/evals/offline-eOyK60
npm run eval:pilot:recover -- artifacts/harness/live-pilots/live-CwHPbD
npm run eval:pilot:recover -- artifacts/harness/live-pilots/live-mHOnDl
npm run eval:sdk-ablation:rebuild -- artifacts/harness/sdk-ablations/sdk-s1-IRrezl
npm run eval:sdk-live:recover -- artifacts/harness/sdk-live/s2-dry-mQwGip
npm run eval:sdk-live:recover -- artifacts/harness/sdk-live/s2-live-RGcvnD
npm run eval:sdk-context:rebuild -- artifacts/harness/sdk-context/s3-offline-L8cMsW
npm run eval:sdk-lifecycle:rebuild -- artifacts/harness/sdk-context/s3-lifecycle-b8USvY
npm run eval:sdk-context-transport:recover -- artifacts/harness/sdk-context-transport/s3-transport-sYv5iO
npm run eval:sdk-context-live:recover -- artifacts/harness/sdk-context-live/s3-dry-0jsA0Z
npm run eval:sdk-context-live:recover -- artifacts/harness/sdk-context-live/s3-live-t6GSPA
npm run eval:sdk-recovery-races:rebuild -- artifacts/harness/sdk-recovery-races/s3-races-ow4RXU
npm run eval:sdk-supervision:rebuild -- artifacts/harness/sdk-supervision/s4-offline-zg1l2J
npm run eval:sdk-supervision-live:recover -- artifacts/harness/sdk-supervision-live/s4-live-orlzII
npm run eval:sdk-supervision-live:diagnose -- artifacts/harness/sdk-supervision-live/s4-live-orlzII
npm run eval:sdk-supervision-live:recover -- artifacts/harness/sdk-supervision-live/s4-live-FJMrVf
npm run eval:sdk-supervision-live:diagnose -- artifacts/harness/sdk-supervision-live/s4-live-FJMrVf
npm run eval:report
npm run eval:report:verify -- artifacts/harness/reports/report-CPUudb
```

全新依赖的本地隔离回归：

```powershell
npm run test:harness:isolated
git diff --check
```

隔离脚本只复制 Git 跟踪文件与显式白名单中的新交付物，拒绝私人小说 fixture；不复制任意未跟踪提示文件。第二十三增量的完整链是 18 条命令，已通过；第二十五增量加入 S4 独立真实工装后为 19 条，结果另记该增量。脚本在临时 checkout 安装依赖、执行检查后清理自建目录。`npm ci` 需要依赖下载网络；测试本身不请求真实模型。

从本次整理起，日志、完整 `source-manifest.json` 和成功 `isolated-summary.json` 写入唯一的 `artifacts/harness/isolated-run-*/`。历史根目录 `isolated-*.log` / `isolated-summary.json` 保留原样，不再被新运行覆盖。失败目录保留已有日志，但没有成功 summary 不能当作通过。源码摘要是排序路径到文件 SHA 映射的紧凑 JSON 的 SHA，不是美化后清单文件的字节 SHA。

第二十八增量回归为 **`isolated-run-doqNzV/`**：495 文件、全新依赖、19 条命令全部通过，含 Harness 224 项 × 3 轮、S4 live 134 项、旧 S4 188 项和报告 105 项。source manifest 内容摘要 `d82f2b301986873daf4a642d2f5f2d7ba964aefff6271200efe6a5c20e72b032`。该轮收尾只有七个说明文件变化，代码/测试/配置与快照一致，全局 Pi 配置未变。第一次 `isolated-run-QIW451` 在既有 P2 本地 HTTP 测试第三轮失败，保留日志；复跑未复现，未定位根因，没有改断言或宣称已修复。两次自建 checkout 均已清理，详细证据见结果第二十八增量。

第二十九增量只修改七个 S4 工装/测试源码及说明文档。`check`、`check:harness-tests`、S4 live **150 项**均通过，launcher 网络子测试 **61 项**另计；新旧 8/72 与 6/54 预算、授权隔离、普通/摘要共用限额、旧记录只读兼容均有离线检查。旧四批 236 文件和新正常/限额故障两批 115 文件只读 SHA 不变；现有报告 `report-UpnFP4` 再次验证 13/13。生产源码、依赖、启动脚本不变，未重跑全新依赖 19 命令链，不能把历史回归算作当前全量通过；真实请求 0。

第三十一增量定向检查为 `check`、`check:harness-tests`、报告 199 项，以及新报告生成/verify 15/15。原 S4 工装、生产源码、package/lock 与全局 Pi 配置未改；本轮没有重跑全新依赖 19 命令链或 S4 150 项，不将历史回归当成当前全量验证。

第三十二增量现已补齐当前版本的完整回归：**`isolated-run-RqGXwI/`**，496 文件、全新依赖、19 条命令全部通过；Harness 224 项 × 3 轮无 partial/fail，S4 live 150 项、旧 S4 188 项、报告 199 项通过。source manifest 内容 SHA `2bf37508878e513a71a794431a974da141d7291c11d6b7e04712526bad65d263`。187 个待交付候选均进入快照，三个用户规划文件未复制；回归期间 499 个工作区文件不变，收尾只回填六份说明。699 个原证据和 40 个报告文件未变，临时 checkout 已清理、历史临时目录保留。安装/构建警告及历史偶发失败记录保留；完整记录与边界见结果第三十二增量，不等于远端 CI、已提交 clean clone 或原生 Desktop 验收。

此前完整隔离回归 `isolated-run-LZyZ3O/`：480 文件快照、全新依赖，**18 条命令全部通过**，包括原 Harness 224 项 × 3 轮、此前各套件、S4 188 项和报告 105 项检查。source manifest 内容摘要 `a93dd68de33e985bc26565aeb9a8c83a7bd71dfe6bf86dc341bc0c58b94b54b1`，见该目录的 `isolated-summary.json` 与第二十三增量。第二十三增量结束时只回填七个说明文档，代码/测试/配置保持一致；临时 checkout 已清理，全局 Pi 设置和模型配置哈希不变。后续第二十四增量仍只更新方案/索引文档，新增 S4 live 方案不在该快照中，也没有可执行的新 live 工装。前端原有导入/chunk 体积警告保留；本地快照不等于远端 CI、已提交 clean clone 或原生 Desktop 验收。

此前完整隔离回归 `isolated-run-juyMAy/`：459 文件快照、全新依赖，16 条命令全部通过，包括原 Harness 224 项 × 3 轮、SDK 各套件和恢复竞态 125 项检查。source manifest 内容摘要 `cffeea48db53e5d18c053662e875f001d7dcd1ff82a810a4b59d715b91f92347`，见该目录的 `isolated-summary.json` 与第二十增量。该轮结束时源码与隔离快照一致；后续新增报告工具不在此快照中，不能沿用为当前完整回归证明。临时 checkout 已清理，不是远端 CI 或已提交 clean clone。

上一轮 `isolated-run-DZohiL/` 是明确标记的中断续跑例外：451 文件快照，前 14 条命令通过，最后一项中断；核验同一隔离源码前后均未变动后，单独补跑 S3 新工装 83 项通过。合计 15 条命令已验证，不宣称原完整进程成功；见 `isolated-continuation-summary.json`。source manifest 内容摘要 `751d6089695177cc43757ef5690b9ac23f45216b761b1339c21796d715051e9b`，完整经过及保留的中断证据见结果第十七增量。

S2 独立回归目录保留为 `artifacts/harness/isolated-run-cH7dYX/`：411 文件快照、全新依赖、11 条命令全部通过，包含 Pilot 310 项、S1 101 项与 S2 95 项检查。source manifest 内容摘要 `14c4bfe1d958be86cc81c9e16d6a6865cbbcb70db8f988cdb455157c887c2ae3`；S1 的 `isolated-run-TRAxlc` 等旧目录保留。新增 S3 后的 12 命令回归另列于 [结果记录](HARNESS_PHASE5_RESULTS.md) 第十四增量，不覆盖历史快照。

S3 v1 最终配置回归保留为 `artifacts/harness/isolated-run-fGnALF/`：421 文件、全新依赖、12 条命令全部通过，含 S3 103 项检查。source manifest 内容摘要 `77f94e2cf871b02f6f131a6c64b1c53506bad852c6c5eae0539d412f2884f694`；回归后仅回填结果/交接文档。初次 S3 回归 `isolated-run-WctBlp` 亦保留，但不替代包含最终 LF 属性的这一快照。v2 回归另见结果第十五增量。

v2 回归为 `artifacts/harness/isolated-run-sJZkbi/`：429 文件、全新依赖、13 条命令全部通过，含新增生命周期 175 项检查。source manifest 内容摘要 `63d13c8c92ba1eb750e136d5f5fdca184c3ca694fe7d59d6d57d7750ce2f5ca5`；随后只有说明文档回填，代码/测试/配置保持一致。新 v2 的 57 个产物与旧 S2/v1 的 59 个产物均只读重建、SHA 不变。

统一出口预检阶段的回归为 `artifacts/harness/isolated-run-klefWL/`：439 文件、全新依赖、14 条命令全部通过，含传输预检 96 项。source manifest 内容摘要 `5e87058de2d504c0523bb36515d51eabe46f14ce0d3b26cdf0c16e49a073a09f`。十个探针的完整批次表及边界见结果第十六增量，不合并为模型效果成功率；新工装回归另列第十七增量。

## 4. 已批准提交范围与排除项

- Phase 5 代码：`evals/`、`tests/evals/`、`tests/pilot/`、`tests/sdk-ablation/`、`tests/sdk-live/`、`tests/sdk-context/`、`tests/sdk-context-transport/`、`tests/sdk-context-live/`、`tests/sdk-recovery-races/`、对应 runner / network guard 脚本。
- 报告工具：`evals/report/`、`tests/report/`、`scripts/run-evidence-report.mjs`、`docs/HARNESS_PHASE5_EVIDENCE_REPORT.md`；生成报告仍位于忽略的 artifacts，不默认随源码提交。
- S4 真实工装：`evals/sdk-supervision-live/`、`tests/sdk-supervision-live/`、`scripts/run-sdk-supervision-live.mjs`、`docs/HARNESS_PHASE5_SDK_SUPERVISION_LIVE_PLAN.md`；演练和正式清单分别管理，本轮没有真实调用。
- S4 对照：`evals/sdk-supervision/`、`tests/sdk-supervision/`、`scripts/run-sdk-supervision.mjs`、`docs/HARNESS_PHASE5_SDK_SUPERVISION.md`；只改评测与配置，不改生产 runtime。
- 集成配置：`package.json`、`tsconfig.harness.json`、`.gitattributes`、`.github/workflows/ci.yml`、`scripts/test-harness-isolated.mjs`。
- 交付文档：本文件、Phase 5 验收/结果/pilot 工装与方案、正式对照计划、`evals/README.md`。
- 默认不纳入：根目录用户提供的三个规划/研究文件、`artifacts/`、私人小说、会话与 `.pi` 配置。今后提交前仍须重新审查 diff、敏感内容与实际暂存清单，不能直接 `git add .`。

提交前暂存检查覆盖 187 个交付文件；默认 `git diff --cached --check` 仅报告 `scripts/run-sdk-context-live.mjs:86` 的末尾空行。该文件字节已绑定 S3 实测清单及本轮回归快照，故保留原样，不为格式清理改变来源指纹。使用单次 `git -c core.whitespace=-blank-at-eof diff --cached --check` 复核其余空白问题通过，未更改全局 Git 配置。提交准备仅更新本交接页的授权状态与该已知告警，不修改通过回归的代码、测试或依赖。

当前回归证据基于提交前源码的逐文件指纹；后续提交不把该证据升级成已提交 clean clone 或远端 CI。正式模型实验前需要新的源码/依赖/task/profile 冻结，不能继承旧 pilot 的有效期或授权。

## 5. 下一步

`s2-live-RGcvnD` 已获批准并执行封存，不能复用剩余额度。B1 READ 的 `ANSWER_MARKDOWN_FENCE` 保留为失败，不为通过而放宽规则或选择性补跑；两项 TOOL 都成功，但 B1 重复写入对账分支本轮未触发，不能宣称其效果已被真实样本证明。只读重建一致，29 个产物 SHA 不变，详见 [结果记录](HARNESS_PHASE5_RESULTS.md) 第十三增量。

S3 v1/v2 的限定离线切片已完成：大结果/预算、来源变更、手动与自动 native compaction、未知写入意图持久化及独立进程恢复，记录见第十四/十五增量。统一普通/摘要出口的离线预检亦完成，见第十六增量；旧三批 116 个产物 SHA 保持不变。

具体 B2/B3 task/profile 与新逐批授权入口已完成离线验收，见第十七增量；第十八增量准备精确清单后，用户另行批准执行。2026-09-23 `s3-live-t6GSPA` 首批实测已封存：模型为 `gemini-proxy / gemini-3.8-flash-high`，四项均 pass，27/32 次真实 HTTP（普通 25、原生摘要 2），0 unknown/pending。2 次原生手动压缩和独立进程恢复均完成，恢复后各重读 v2 并仅写一次；B3 在恢复阶段另有一次 refresh 和 durable intent。只读重建与保存结果完全一致，90 个产物 SHA 不变，详见第十九增量。

本批 manifest SHA-256 为 `4afa54958f6ba24454a49453da40a8c40a014951f2a966e1a1b70ce04a159d86`，源码/依赖摘要与离线验收相同。**批次已使用并封存，即使原有效期尚未到，也不能复用剩余 5 次额度。** cache 未报告，费用保持未知；未做选择性补跑或追加请求。后续如需真实调用，必须准备新清单并单独批准。

受控强杀/迟到结果增量已完成独立测试，见第二十增量与 [说明](HARNESS_PHASE5_SDK_RECOVERY_RACES.md)：真正终止写入回执尚未返回的子进程，在独立进程重开后对账或继续阻止；旧执行器在后台完成时仍不重复写入。最终矩阵 12 项机械通过，其中 6 项最终状态仍为未知，不能称为 12 项写作任务完成。没有调用真实模型、修改生产 runtime 或旧封存结果。

任意时刻断电/父 broker 恢复、真实摘要质量、完整 Desktop/RPC、Supervisor/maintenance 真实对照仍是独立后续范围，不混作同一任务/分母；整个 Phase 5 尚未完成。本轮不 commit/push。

第二十一增量已将前 12 个封存批次（不含 S4）统一重建为 `artifacts/harness/reports/report-fDqAvf/`，报告包 manifest 字节 SHA-256 为 `8a6512cc98ca7b68d963162d1e824e8f9545670116c36f19509de31120692099`。70 项报告工装检查通过，509 个原文件前后 SHA 不变，旧失败、unsupported、未知操作结局与 cache null 均保留。该包是摘要与哈希索引，verify 仍需原批次；不是完整 raw 归档或公开签名证明。详见 [报告说明](HARNESS_PHASE5_EVIDENCE_REPORT.md) 和结果第二十一增量。

第二十二增量完成了 **Supervisor / context maintenance 独立离线对照**，见 [S4 说明](HARNESS_PHASE5_SDK_SUPERVISION.md)：最终批次 `s4-offline-zg1l2J`，五种故障另存 `s4-fault-tests-304nzZ`。188 项检查通过，45 格结果符合预登记对照；无进展/待验证状态没有算作业务完成。48 个正常批次产物只读重建一致、SHA 不变。

第二十二增量的 package 脚本变化改变了报告 builder 指纹，因此没有覆写旧报告，而生成 `artifacts/harness/reports/report-diKqPS/`；包 manifest 字节 SHA 为 `5355c16906e54969a7b507fb8a16e4c62d2bd9b58958adeac8d939e0fc274124`。该历史包与原 12 批再次核验一致，当时仍不含 S4。旧包应使用其冻结工具复核，不能要求变化后的 builder 冒充旧指纹。

第二十三增量已完成 S4 报告集成与完整 18 命令隔离回归。当时新包 `artifacts/harness/reports/report-wAl4It/` 的 manifest 字节 SHA 为 `60a48c0317084f5157fe093ffeee2d0de3b0f06f3e0391729c8294d7a3acb057`；13/13 批重建核验一致，557 个原文件不变，105 项报告检查通过。S4 的 27 个机械 pass 不等于正文完成，候选验证、只读答复、无进展停止与等待验证明确分栏；没有人工批准或 Canon 晋升。

第二十四增量已准备 [S4 真实首批方案](HARNESS_PHASE5_SDK_SUPERVISION_LIVE_PLAN.md)：九项共同任务，拟定 6/54 次普通/摘要共享上限，满额非缓存预留参考约 $3.07，实际 cache 不可核实时费用未知。方案静态核验通过，不等于工装演练或真实清单批准。旧离线 S4 的固定工具计划、标准答案写入断言及仅遍历已写产物的完成判定不能直接用作真实评测。

第二十五增量已实现独立 S4 live 工装，三配置、九格清单与 6/54 共享限额保持不变；新增离线故障/授权/只读重建检查，完整全新依赖回归记录见结果第二十五节。没有准备正式 live 清单、读取凭据值或调用模型，生产 runtime 不变。`sdk-supervision-live` 演练批次独立保留，目前不加入统一报告的 13 批分母。

第二十五增量完整回归是 `isolated-run-E1kRln/`：493 文件快照、19 条命令全部通过，source manifest 内容 SHA `90388294ff46256f3b94d3bb5b2933d88cbda6e7c1fbf44dc1a64b4d79d7716b`，当时新工装 112 项检查通过。该轮仅回填文档，代码/测试/配置与快照一致；自建临时 checkout 已清理，全局 Pi settings/models 哈希不变。正常演练 `s4-dry-lOgRtm` 为 7 pass / 2 预算阻断 fail，21 次合成派发、0 真实请求；77 个产物已只读重建。当时报告 `report-Wsh9Yt` 为原 13 批、557 文件不变，不覆盖旧包；不将这轮历史回归冒充第二十八增量的新检查。

第二十六增量已无网络准备 `artifacts/harness/sdk-supervision-live/s4-live-orlzII/`，manifest 字节 SHA 为 `b0c02af70815e17a5e75e9e915b2893d45366b8ba04cc6ed3814f5800d34aa5c`。有效期至北京时间 **2026-09-24 16:04:54.767**。当前模型投影为 `gemini-proxy / gemini-3.8-flash-high`、262,144 工作窗口、每请求输出参数 2,048；未解析凭据值或测试远端可用性。

只读恢复为 `prepared`，九格均未观测、真实/模拟派发和预留均为 0；目录只有 manifest，没有 claim 或结果。代码/依赖/fixture/runtime 与最终离线演练一致，全局 settings/models 哈希不变，临时构建目录已清理。三配置共九格、每格 6 次/全批 54 次普通与摘要共享，参考预留约 $3.07，不是实际费用或金额硬上限，cache 不明时费用未知。

上述第二十六增量为历史准备状态。第二十七增量在用户明确批准后已执行并封存：12/54 次真实 HTTP，1 pass、1 unknown、7 blocked，批次 incomplete。C 正常完成候选验证；S 已验证候选但第七请求入口被拒绝，按每格六次硬限额及全批停止策略结束，后七格未运行；没有额外补跑或额度重置。

50 个产物只读重建与保存 aggregate 一致，SHA 前后不变；manifest 字节 SHA 保持批准值，aggregate SHA `4aec58fb0498fd16488d007bfb19d78f56fbc7104b88d43bcb11404319ad23e9`，完整文件映射 SHA `91c230c8dc573c1c956bba8908b6a399c115e4d469655467cc073084be3ad84b`。当前候选写入可对账不代表 S 的任务已正常完成，也不代表 Supervisor 较差；压力维护与前提缺失尚无本批实测结果。

第二十八增量已实现 v2 停止诊断，`diagnose` 只读显示入口、实际 HTTP 与细分原因；旧 v1 保留原聚合和细分原因缺失状态，禁止再次授权，不改写历史证据。正常 v2 演练 `s4-dry-5KJN9s` 为 7 pass / 2 预算阻断 fail；独立 `s4-dry-noCvcW` 限额故障明确记录 7 入口、6 合成 HTTP、1 次预留前拒绝及 `TASK_REQUEST_LIMIT`。两批加上旧正常/真实批共 236 文件只读复核不变，真实模型请求 0。报告另生成 `report-UpnFP4`，仍是原 13 批、557 文件不变。

第二十九增量的 **8/72 次版本化预算合同**已离线验收；第三十增量又单独获准执行 `s4-live-FJMrVf`，26 次真实 HTTP、7 pass / 2 压力负例 fail，九格全部运行并封存。旧 6/54 的 v1/v2 记录保持只读，两批余额均不能复用。本轮只执行和只读核验，收尾仅更新六份说明，生产/评测源码及全局 Pi 配置不变，没有 commit/push，也未重跑离线套件或 19 命令链；首次旧测试失败记录继续保留。

第三十一增量已完成 **S4 live family 的统一只读报告适配**，新旧两批同时纳入，保持旧 unknown、未运行格、新压力 fail、费用 null 和未观测分支。15/15 批复核与 199 项报告检查通过，新增模型请求 0；没有覆盖旧报告或改变实验分母内的结果。

第三十二增量已完成上述全新依赖完整回归与交付范围审查，19/19 条命令通过，报告仍为 15/15 原记录核验。用户现已批准按第 4 节白名单审查暂存并提交/推送，不纳入三个用户规划文件、原始 artifacts 或私人数据。该交付不自动增加模型样本或复用预算；更大样本、长篇创作、强杀与完整 Desktop 仍各自另定范围，完整 Phase 5 未完成。
