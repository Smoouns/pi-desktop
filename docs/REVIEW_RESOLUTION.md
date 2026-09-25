# 87b4ac8 审查整改清单

审查基线：`87b4ac8e009e36471a9530ce3918f2a2b360d1f1`。审查日期：2026-09-23。

最新进度（2026-09-25）：会话切换时旧状态短暂显示已修复并提交推送为 `b253286`，固定提交的 [CI 36148840138](https://github.com/Smoouns/pi-desktop/actions/runs/36148840138) 四个 Windows/Ubuntu 任务全部通过。目标 runtime 的项目/会话/职能确认前不恢复旧缓存，历史加载期间隐藏状态条，后台状态继续保留。旧代码 8 个定向场景中 6 个失败，修复后 8/8、真实聊天组件加载态检查均通过；两平台 CI 都实际完成 Harness 366 例 × 3，新增 8 项各执行三次。隔离原生批次 `d7-wBZ41o` 的加载中间态、冷恢复和 A/B 切换是另行完成的本地证据，真实模型调用 0。详见 [会话状态投影验收](REVIEW_SESSION_STATUS_ACCEPTANCE.md)。

上一批记录（2026-09-25）：E1–E8 实现、测试及证据说明已提交推送为 `684769f`，另以 `c974480` 修正原生合成工装的输入识别、`9eace1f` 调整扩容后三轮 Harness 的外层时限、`5f92cd3` 将旧 S4 接回原始冻结工厂。固定代码 `5f92cd3` 的四个双平台 CI 任务全部通过；隔离原生 Desktop 的读取/停止/验证/冷恢复/项目隔离回读也已通过，当时加载过渡的旧状态短暂显示单独保留为后续 UI 修复。详见 [E 固定版本验收](REVIEW_E_FIXED_ACCEPTANCE.md)。E8 已有真实 U/C 观察和独立 R 补测通过，但不是同版本一次全套联合通过。摘要逐项审读为 9/10 明确保留、关键 5/6；“正文尚未验证”仍靠结构化检查点保留。真实兼容锚点、通用语义进展和真实小说长程质量仍未验证，不能将这些局部证据等同整个 E 完成。

首批范围：A 批次（Windows Pilot 路径诊断、测试环境修复及直接回归），以及 B1/B2 的复现用例。随后分别提交推送 A、B1、B2 并验证双平台 CI，再进入 C 稳定任务目标与完成合同。C 及其两项 CI 工装修正已提交推送，固定代码提交 `e9f7d69` 的双平台 CI 已通过。D 的完整生产 SDK 生命周期、冷恢复与隔离原生 Desktop 接线已本地通过，并连同 Windows 控制台修复提交推送为 `d66a302`；该固定提交的四个双平台 CI 任务全部通过。文末 E 记录保留当时版本与证据归属，最新提交和验收以开头链接为准。本次提交/CI/隔离桌面验收不新增真实模型调用，不改真实小说、全局 Pi 配置或历史验收报告。

## 关闭标准

每项必须具备：复现或反证、最小修复、直接回归、剩余边界。`confirmed` 不等于 `fixed`；本地通过不等于远程 CI 或 Desktop 验收通过。冻结实验批次与版本化验收报告保持不变；新增审查复现 / SDK 评测使用独立输出。常规 Harness 的固定文件名汇总沿用原脚本机制，仅代表最近一次回归。表中 E 的 `regression_CI_passed` 仅指机械回归，不关闭同一行的语义质量或真实环境证据缺口。

| ID | 状态 | 本轮动作 / 后续计划 | 证据与限制 |
| --- | --- | --- | --- |
| AUD-01 | fixed / CI_passed | 新增拒绝原因枚举；仅规范化隔离测试子进程的临时根；补路径正反例与 Windows 短路径回归 | `f472e8d` 双平台 CI 全绿；Windows 8.3 用例实际执行，journal=11、unsupported=[]。原失败 CI 未输出具体拒绝分支，仍不冒充已确认其唯一根因 |
| AUD-02 | fixed / CI_passed | B1：区分历史完成、当前后置状态和派发许可；终态不复活；完整扩展与三进程冷恢复回归 | `c67467e` 双平台 CI 全绿；新、旧 toolCallId 均核验当前 post-image；历史 A、当前 B 返回冲突且不重放 |
| AUD-03 | fixed / CI_passed | B2：按真实 SDK 返回内容映射行范围，并单独记录交付凭证；分页只累计已交付内容；旧凭证需重读 | `f1b19df` 双平台 CI 全绿；263 例 × 3 实际执行。没有本批 Desktop 验收 |
| AUD-04 | fixed / CI_passed | C：版本化 TaskContract 绑定稳定 taskId、原始目标、最新指令、预期产物及当前版本完成凭证 | C 的 `e9f7d69` 双平台 CI 全绿；D 的 `d66a302` 又通过完整 SDK 压缩 / 冷恢复及双平台 CI，隔离原生 Desktop 任务提交单独本地验收 |
| AUD-05 | partially_addressed / regression_CI_passed | C 保留任务合同；E4 保护工具批次；E5 提供有界非权威历史；E8 补局部真实摘要审读 | 单样本摘要 9/10 明确保留、关键 5/6；正文未验证状态只由检查点明确保留。恢复答案 10/10 不证明摘要独立有效；不授予 Canon 或关闭通用语义质量，见 REVIEW_E_SUMMARY_CONTENT_REVIEW.md |
| AUD-06 | fixed / CI_passed | D 补完整生产接线、冷恢复与来源版本定向突变回归；D-07 补隔离原生窗口验收 | `d66a302` 双平台实际通过 SDK 8 组 / 15 进程、Harness 285 例 × 3；隔离原生 UI → Rust RPC → 固定 CLI → 完整扩展另经本地验收。不是安装包或真实模型验收 |
| AUD-07 | partially_addressed / regression_CI_passed | E1 分层计量、E3 发送出口与任务账；E4 配对诊断；E8 补真实用量配对和重复输出计量修复 | 原上游批次 14 配对、独立 R 9 配对；兼容增量锚点未命中，不据此降低预算或猜费用。见 REVIEW_E_UPSTREAM_RESULT.md / REVIEW_E_READ_RETEST_RESULT.md |
| AUD-08 | partially_addressed / regression_CI_passed | E2 单次 Context 复用来源指纹；E8 R 独立实测确认复用、跨请求重验及 v2 重读 | 五项 R 证据通过；只代表扩展计量的 readFile 行为，不是 OS IO、真实小说延迟或费用节省。见 REVIEW_E_SOURCE_CACHE.md / REVIEW_E_READ_RETEST_RESULT.md |
| AUD-09 | deferred | 需求出现后再决定是否持久化 Observation | 本轮不加数据库、向量检索或新 agent loop |
| AUD-10 | mechanically_addressed / regression_CI_passed | E6：按验证对象、模式、已核对依赖及规范化诊断跟踪修复；无关读写不重置验证停滞 | 同类失败三次未改善停止；实际差额改善及完整修复正例通过。保留硬上限与独立的通用工具重试启发式，不引入模型裁判，不宣称语义进展，见 REVIEW_E_EFFECTIVE_PROGRESS.md |

## 执行记录

- 原始本地基线：`npm run test:pilot` 通过（journal=7；rehearsal=2/2；broker dry-run=pass；真实模型请求=0）。这不是对原 Windows CI 根因的动态确认。
- 首批修复已提交并推送：`f472e8d36252f527ba6d69774dcc4657ef312d5c`。远程 [CI 35866381033](https://github.com/Smoouns/pi-desktop/actions/runs/35866381033) 的 Windows/Node 24、Ubuntu/Node 22、TypeScript + Rust 三个任务全部通过。
- Windows 日志确认 `PASS journal.windows-short-temp`，两次 Pilot journal 均为 passed=11、unsupported=[]，后续全部 SDK 检查实际执行。Ubuntu 唯一的平台条件跳过为 Windows 专属短路径步骤；不是必需测试被意外跳过。
- B1 已独立提交推送：`c67467ec4f812a722df5398033bc2858ad8507bd`。[CI 35871188658](https://github.com/Smoouns/pi-desktop/actions/runs/35871188658) 的 Windows/Node 24、Ubuntu/Node 22、TypeScript + Rust 三个任务全部通过。两平台均实际执行 Harness 235 例 × 3，以及新增三进程冷恢复用例。
- B1 Windows 日志确认 journal=11、unsupported=[]、真实 8.3 TEMP 用例通过，全部后续 SDK 检查和前端构建实际执行。Ubuntu 仅按条件跳过 Windows 专属短路径步骤。冻结评测中的既定负例 / unsupported 仍不冒充生产通过。
- B2 已独立提交推送：`f1b19df4005d74ecbad76bb242eff0a98c8a6d17`。[CI 35877882145](https://github.com/Smoouns/pi-desktop/actions/runs/35877882145) 的 Windows/Node 24、Ubuntu/Node 22、TypeScript + Rust 三个任务全部通过。两平台日志均确认 Harness 263 例 × 3、deterministic=true、失败 0，新增 B2 场景实际执行；后续全部 SDK 检查、长程回归及前端构建也实际执行。Windows journal=11、unsupported=[]、8.3 TEMP 用例通过；Ubuntu journal=10、unsupported=[]，仅按条件跳过 Windows 专属短路径步骤。
- C 及 CI 工装修正的固定代码提交：`e9f7d69a21ffdbed85087dd31f4f2346a9009cd5`。[CI 35952265937](https://github.com/Smoouns/pi-desktop/actions/runs/35952265937) 的 Windows/Node 24、Ubuntu/Node 22、TypeScript + Rust 三个任务全部通过，详见下方验收记录。之前的两轮失败保留为独立历史，不替换或改写。
- 远程验收门槛：固定修复提交上的 Windows/Node 24 与 Ubuntu/Node 22 必需检查实际执行并通过，未经说明的 skipped 不算通过。

后续记录将在实际执行后追加，不预填通过结果。

## A 批次：路径修正

- 受控复现：`scripts/test-pilot-journal-windows.ps1` 使用 Win32 `GetShortPathName` 获取新建临时目录的真实 8.3 别名，只在该脚本进程内设置 TEMP/TMP。原代码退出 1，错误为 `JOURNAL_DIRECTORY_UNSAFE`；修复后完整 Pilot 测试退出 0。
- 修复位置：`scripts/run-pilot-evals.mjs` 在 **test 模式**为隔离子进程设置经过 realpath/lstat 核验的临时根。未更改父进程、用户或系统环境变量；未修改全局 Pi 设置。
- 生产边界：journal 创建仍要求严格 canonical path，不以转小写或删除检查放行别名 / 链接。新增 `NOT_DIRECTORY`、`LINK`、`NON_CANONICAL_PATH` 枚举；错误码和 journal 文件 schema 不变，诊断不打印原始路径。
- 直接回归：普通 journal 持久化 / 排他 claim / 预算 / 篡改 / 写入失败测试保留；新增中文空格目录、非目录以及 symlink/junction 叶子和父路径负例。本机 journal=11，unsupported=[]。不支持链接或 8.3 的平台必须明确显示 unsupported，不计作通过。
- `.github/workflows/ci.yml` 已加入 Windows 短 TEMP 回归；已在上述固定提交的远程 Windows runner 上实际通过。
- 剩余边界：不是任意并发文件系统替换 / reparse point 类型的安全审计；本轮没有扩展 journal 恢复端的原有路径策略。

## B1/B2：首批独立红灯复现（修复前）

运行：`npm run test:review-repros`。

这不是正常回归套件中的“已知失败算通过”：仍有合同违反时退出 **1**，工装或对照出错时退出 **2**，只有合同全部满足才退出 **0**。下一批修复应使这些合同转绿，并将相应场景纳入常规回归。

首批证据：`artifacts/harness/review-repros/review-gKTJNL/summary.json`。共 10 例：7 个确认违反合同，3 个对照通过，工装错误 0。证据保存当前源码 SHA-256、HEAD/dirty、SDK/Node 版本和逐例观察；每次运行新建目录。

| 类别 | 实际观察 |
| --- | --- |
| AUD-02 / 新与旧调用 ID | 当前文件为 B，但再次请求 A 得到 satisfied；复现没有派发第二次写入 |
| AUD-03 / LF 与 CRLF | 原生 read 只交付第 2 行，checkpoint 却登记第 1–4 行 |
| AUD-03 / 单行超长 | SDK 只返回大小超限提示，仍登记来源已读凭证 |
| AUD-03 / 截断 + 预览 | SDK 截断至 2000 行，扩展预览本次仅交付 38 个完整行，凭证仍覆盖完整 2300 行 |
| AUD-03 / 无关重读 | 第 8–9 行依赖变化后，只读第 1 行再 refresh，状态错误恢复 ready |
| 对照 | 当前字节确实满足时防重复写有效；相关范围重读可刷新；读取与交付之间版本变化仍拒绝记录凭证 |

覆盖边界：完整生产扩展、真实 SDK 原生 read/write、ExtensionRunner 和真实临时文件；session manager 为工装替身。未调用模型、未进行 Desktop 或冷重启组合验收，也未完成 AUD-06 的突变测试。仓库 fixture 的前后哈希一致，真实小说未触碰。

## 首批本地回归（Windows / Node 24.19.0）

- `npm run check`、`npm run check:harness-tests`：通过。
- `npm run build:frontend`：通过；保留既有动态/静态混合 import 与 bundle 大小提示。
- `npm run test:harness`：224 例 × 3，deterministic=true，失败 0，unsupported 0。
- `npm run test:harness:long-horizon`：通过，3 次结果一致。
- `npm run test:novel-domain`、`npm run test:evals`、`npm run test:chat-panel-resize`：通过。
- `npm run test:pilot` 及 Windows 8.3 TEMP 包装运行：通过，journal=11，unsupported=[]。
- SDK ablation / live tooling / context / lifecycle：分别通过 101 / 95 / 103 / 175 项检查。
- SDK context transport：源码不再改动后完整重跑 96 项通过。前一次在源码仍有编辑时返回 `S3T_REJECTED`，不计作通过；日志未细分异常分支，不能把这一拒绝冒充确认的产品缺陷或已定位根因。
- SDK context live tooling / recovery races / supervision：分别通过 83 / 125 / 188 项检查。
- SDK supervision live tooling / evidence report：分别通过 150 / 199 项检查。

所有上述 `live tooling` 命令均为 **test 模式**，只用合成响应，没有真实模型 / HTTP 派发。历史能力对照矩阵中的预设负例由套件显式核验，不等于生产功能通过；新增审查红灯也不并入常规通过数。

## B1：写入历史与当前状态（后续本地修复）

- `completed` 只保留历史记录；只有当前文件 SHA 与该操作的预期 / 已确认后置指纹一致，才反馈 `currently_satisfied`。不能用已经刷新为 B 的 artifact，替代写入 A 时记录的 post-image。
- 历史完成但当前不一致返回 `post_state_conflict`；缺少可信后置指纹或当前不可核验返回 `post_state_unverifiable`。两个分支都不派发写入，不删除完成记录，也不改为“执行结果未知”。
- failed、cancelled、ID 冲突分别反馈，不再复用 satisfied 文案。失败允许修正参数的新调用；已取消的旧 ID 不可复活，确定从未派发的取消可由新调用取代。issued / unknown 且未派发的记录不能靠外部碰巧匹配的文件字节变成完成。
- Operation Ledger 的迟到成功 / 失败 / 取消回调不能改写终态或已确认 post-image；新 toolCallId 本身不足以自动重放一个已完成但当前冲突的同参数意图。
- 完成内容冲突会按原 Supervisor 策略暂停本轮，后续工具不会自动继续。测试明确发送新的用户请求后才派发修正后的 C。单纯调用失败走有界参数修正路径，不误判为不可恢复的前置条件。
- schemaVersion=1 保持不变；没有迁移、清空旧会话或增加自动重放入口。相同内容的“强制重新应用”没有新增专用授权 UI / 合同；需要人工核对并建立独立的新逻辑任务，不能只换 transport ID 绕过。

### 直接证据与边界

- `tests/harness/operations.ts` 与 `tests/harness/checkpoint-runtime.ts`：历史 A / 当前 B、同与新 ID、未知后置指纹、failed/cancelled、终态回调、未派发记录与恢复后的 gate。
- `tests/harness/write-state-extension.ts`：完整生产扩展、SDK 原生 read/write/edit、真实磁盘 SessionManager；核对模型可见反馈、目标字节、派发计数与持久化操作状态。冲突后仍是 B、只派发一次 A；明确新请求 C 后总派发为 2，原 A 记录仍为 completed。
- `tests/harness/write-state-worker.ts`：三个新 Node 进程依次写入并丢弃结果回调、重开真实会话对账、再次重开后将 A 外部改为 B 并重读刷新。总计仅一次原生写入，冷恢复不重放，最终 B 不被覆盖。子进程使用空 agent 目录、白名单环境与网络保护。
- 最新独立复现：`artifacts/harness/review-repros/review-Ijn7E0/summary.json`。AUD-02 两例与三个对照通过；AUD-03 五例继续确认失败，工装错误 0；命令仍退出 1，**不**宣称审查缺陷全部修完。
- 当前 Harness 最终回归：235 例 × 3，deterministic=true，失败 0，unsupported 0。另已通过应用与测试 TypeScript 检查、长程 Harness、小说领域回归、离线 eval 与前端构建（保留原有 bundle/import 提示）。
- 未进行 Desktop 人工点击或真实模型验收；这不是通用 exactly-once 承诺，也未覆盖任意外部并发替换或所有文件系统竞态。B2 范围凭证与 C 完成合同不由本修复关闭。

### 历史评测保护

旧 S3 评测曾直接导入生产 checkpoint runtime 并把其 SHA 固定为历史 B3，阻止了正常生产修复。本次新增独立快照 `evals/adapters/snapshots/checkpoint-runtime.ts`，只重定位四个会擦除的类型 import；重建原 import 后仍要求完全匹配原 `9117d598…` SHA 与历史 Git 提交。原 provenance、既有快照、已生成验收批次不改写；构建白名单不再允许导入当前生产 runtime。

- 拆分后 SDK context 103、lifecycle 175、recovery-races 125、supervision 188 项检查通过，真实模型调用 0。
- `s3-offline-BNwpT8` 的三个生成扩展 SHA 与本轮前的 `s3-offline-Ec6DG2` 完全相同；`s3-lifecycle-vNNqTu` 亦保持旧 lifecycle 生成扩展 SHA。不是把新生产行为冒充旧实验版本。
- 上述冻结矩阵的能力负例仍按原合同验证，不当作新的生产 B1 验收；生产 B1 的证据来自新增完整扩展与冷恢复回归。

## B2：读取捕获与实际交付（已提交并通过 CI）

- 管理扩展升级到 v16。原生 `read` 保留原始字节 SHA，但将 `offset`、`limit` 和固定 SDK 的真实 truncation 回执映射到返回正文；返回内容必须与捕获版本逐字相符。仅返回超限提示时没有正文凭证；前后 SHA 一样、实际却读到另一版的 ABA 场景也拒绝交付。
- `observation.sourceRefs` / `sources` 只表示捕获来源；`readDelivery.schemaVersion=1` 单独记录交付。`deliveredSourceRefs` 是本次完整交付的行，`sourceRefs` 是同一观察、运行及失效代次内累计交付完整的行。二者均不等于“模型理解了内容”。`start/end/totalChars/hasMore` 使用 UTF-16 坐标；`truncated` 保留截断信息。
- 预览、分页、标题前缀和 SDK 续读提示有独立边界。缺一个字符的行不能当作读完；相邻分页补齐后可累计，出现失效锁存后旧覆盖范围不能借回。跨版本 / 不同权威性 / 不连续区间不拼接；记忆条目必须完整交付对应正文，保留原 memoryId / 人工验收 / 权威性校验，不由普通文本读取升级权威性。
- 自定义文档、章节、当前文件、多文件、搜索与记忆工具走同一边界。搜索中裁掉的长行、尚在 Observation 里的隐藏尾部、仅出现路径的其他文档都不算已读。offload 时移除 SDK truncation 中的正文副本，内部跨度映射不进入持久化 details。
- 输出预算批准后才登记交付，拒绝输出不产生读取凭证。版本指纹核验、角色路径限制、写入后置状态与机械验证版本依赖保留；机械验证依赖及 artifact 指纹不是模型阅读凭证。
- `refresh_task_checkpoint` 可以合并当前同版本、同权威性的连续读取区间，不要求用户先调用一次状态查询。已过期的 exact receipt 不能遮住足够的新分页凭证；未被覆盖的旧依赖仍阻塞。

### 旧会话与容量边界

- Checkpoint 的 `schemaVersion=1` 保留，新增可选且严格校验的 `evidenceFormat: "delivered-v1"` 子合同。旧数据原有 digest 仍可校验；缺少新标记的旧依赖及旧 capture-only 工具结果保留为待重验，不直接恢复为已读。仅保存一次新检查点不能绕过重读要求；不清空历史，也不重放写入。
- 旧版本程序不认识新字段时会拒绝该检查点，不静默降级使用；本次没有增加向旧程序回写会话的降级迁移。
- 新增进程内覆盖索引有记录数、行单元数与不连续分页数上限，超限须缩小读取范围；没有新增数据库或跨进程 Observation 存储。跨进程仍需回源，A/B1 已冻结的快照和历史报告不改写。
- B1 Windows Harness 已实际耗时约 166 秒，新增读取定向测试本机约 9 秒/轮；常规三轮 Harness 的子进程总期限从 180 秒调整到 240 秒，保留硬上限。产品工具期限、预算与失败断言未放宽。

### 本地直接证据

- `npm run test:read-delivery`：47 例通过，含完整生产扩展、固定 SDK 原生工具、源码 / minified 变体、Checkpoint 单元合同与原审查复现；真实模型调用 0。旧会话恢复 80 条依赖时不会重复计数误触容量上限。
- `artifacts/harness/review-repros/review-AUaHQ1/summary.json`：10/10 合同通过、剩余违反 0、工装错误 0、fixture 前后不变；含本批新增交付模块的源码 SHA，未覆盖旧红灯报告。
- 真实 SessionManager 磁盘会话重开：只恢复实际交付的第 8–9 行；变更后无关重读不解锁，相关两行分别重读后恢复 ready，原生写入数 0。本项在同一 Node 进程内重新加载完整扩展；不冒充独立 OS 进程的 B2 读取验收。
- 最终完整回归：263 例 × 3，deterministic=true、失败 0、unsupported 0、真实模型调用 0；最终本机总耗时 154.5 秒。此前 262 例运行在并行构建 / SDK 检查时耗时 175.4 秒，因此仍保留有界的 240 秒工装总期限，不据本机一次较快运行推断远端耗时。
- 最终应用 / 测试 TypeScript 检查、前端构建、长程 Harness、小说领域回归、离线 eval 通过；构建仅保留原有 bundle/import 提示。v16 标记已同步到安装冒烟断言，没有跳过测试。冻结 SDK context / lifecycle 分别通过 103 / 175 项检查，保留声明过的历史能力负例；不当作当前生产 B2 的直接验收。
- 未做真实模型调用、Desktop 人工点击或任意并发文件系统替换审计。工具结果边界的交付不证明 provider 实际消费 / 模型理解，B2 不关闭 C 的任务完成合同。

## C：稳定任务目标与完成合同（已提交，双平台 CI 通过）

### 任务身份与输入边界

- 管理扩展升级到 v17。新增独立 `pi-desktop-task-contract/v1` 会话记录，包含 `schemaVersion=1`、`taskId`、递增 revision、完整性摘要、project/session/role 所有者、原始 objective、latestUserInstruction、按序 constraintRefs、任务类型、预期产物及非权威执行进度。普通“继续”只追加指令；不同 taskId 显式替换当前任务并记录 supersedesTaskId，旧记录不删除。
- 工作流按钮从用户选择和章节卡的唯一 `file` 字段确定明确目标，不让模型从自然语言猜测完成类型，也不根据提示词授予角色或写入权限。声明只在真正发送时随 RPC input 附带版本化控制元数据；宿主 input hook 在 Pi 保存 / 展开 skill 前移除它。模型或 extension follow-up 不可声明任务；控制元数据不渲染为聊天内容。
- 新声明不得在当前运行中插入；输入框保留待发送文本。项目 / 会话 runtime 不匹配时不沿用预填绑定；合同路径仍须经过既有角色写入策略。候选正文目标必须要求完整章节验证，其他角色不能借声明跨权限写入。
- `/novel-task reply 目标`、`/novel-task inspect 目标` 可显式声明新的回复 / 检查任务并预填输入，不自动调用模型。文件交付任务使用工作流入口。普通自由文本和没有新合同的旧会话为 `unbound`；不靠旧 prose summary 或最近一句“继续”反推出文件交付目标。

### 完成条件与恢复

- `candidate_write` 要求所有声明产物同时满足。新建 / 更新产物需有本任务记录的当前 SHA；仅已有同名文件不能充当写入凭证。B1 的当前 post-image 对账可在确实满足同一写入意图时记为已满足，但不能借历史完成状态或重放写入。
- 候选正文还必须有真实 `verify_chapter` 返回的同章、full、PASS / PASS_WITH_WARNINGS 凭证，并在结束时复核正文与所有验证依赖 SHA。错章共用路径、局部场景验证、写错文件、缺文件、验证后外部修改均不能完成；调用模型生成“已完成”文本无效。
- 普通规划任务绑定章节卡的生成 / 更新，章节架构作为须非空存在的前置文件；这不宣称已经机械验证架构登记与章节卡的语义一致性。世界观变更只绑定提案，不写 Canon；写作同时绑定正文和连续性提案，单独“重新验证”只绑定正文验证。
- 回复 / 检查的结束码为 `REPLY_ONLY` / `INSPECTION_COMPLETE`，旧会话为 `UNBOUND_REPLY`，界面显示“回复已结束”；不冒充文件交付、人工验收或 Canon 晋升。运行状态 schemaVersion=1 保留；旧终态、取消、错误、pending operation 和失效检查点仍会阻断成功。
- TaskCheckpoint schemaVersion=1 新增可选且严格校验的 `taskRef` 与 `latestUserInstruction`，旧字段缺省时原摘要仍可解析，不自动迁移成有权威的任务声明。旧程序不能理解新增 checkpoint 字段时拒绝该记录；没有清空历史或增加自动重放。
- TaskContract 最多 16 个目标、256 条指令、每条验证 128 个来源、单记录 128 KiB、最多 10,000 条分支记录；超限或最新记录损坏时拒绝，不回退借用更早成功。append 失败后该所有者在当前扩展实例中禁止继续宣告交付。Observation 仍不跨进程保存；恢复的产物 / 验证凭证要重新检查当前文件。

### 直接回归与边界

- 最初 AUD-04 复现中，原实现将“继续”作为 objective，且缺少声明目标的候选任务也能完成；显式只读对照可正常结束。修复后的相同生产接线断言已纳入常规套件。
- `npm run test:task-contract`：20 例通过，真实模型调用 0。包含严格 schema / 路径 / 容量、追加指令与新任务、UI 提交元数据、source / minified 完整扩展、真实机械验证、局部验证与错章负例、相关文件改版失效、角色 / 分支隔离、旧会话、损坏与持久化失败。
- 真实 SessionManager 写盘、重新加载完整扩展并重开会话后，taskId、原目标及当前验证凭证保留；新一轮重新核验，不重放写入。此项为同一 Node 进程内重开和 compaction 事件接线测试，**不是** C 的独立 OS 进程冷启动 / 真实模型压缩验收。
- 定向突变仅改临时生成扩展副本，将完成检查强制返回 true；相同“缺目标产物不能完成”断言确实失败。生产源码未被突变修改。它证明该回归能抓住这一错误，不能外推为所有 guard 都有突变覆盖。
- 本地完整 Harness：283 例 × 3，deterministic=true、失败 0、unsupported 0；应用 / 测试 TypeScript 检查、长程 Harness（1 例 × 3）、小说领域回归、离线 eval、前端构建、evidence-report 199 项检查通过。领域冒烟首次发现新增 `/novel-task` 尚未加入精确命令清单；补齐清单后重跑通过，没有删除断言。构建仅保留原有 bundle/import 提示。
- 最终完整重跑耗时 186.6 秒；仍保留 240 秒工装硬上限，不据本机通过推断本批远程 CI 已通过。`artifacts/harness/summary.json` 记录 HEAD=`f1b19df`、dirty=true 和本次实现源码 SHA，运行后逐文件复核无漂移。
- 不调用真实模型，不进行 Desktop 人工点击，不修改真实小说或全局 Pi 配置。人工接受与 Canon 晋升逻辑未改；机械满足不等于内容质量或用户满意。

### 冻结评测保护

旧 S4 曾直接导入生产 Supervisor 并冻结其 SHA。本次新增 `evals/adapters/snapshots/run-supervisor.ts` 与 `supervisor-runtime.ts`，只重定位类型 import；恢复原 import 后仍核验原 SHA（`cc1f9078…` / `2f698122…`）及原 Git 提交。S4 / S4 live tooling 改为使用这些快照，原 provenance、历史报告、历史实验结果不改写。

- 冻结 SDK supervision / supervision-live tooling 分别通过 188 / 150 项检查，真实模型调用 0。后者运行的是 **test 模式**，并非新的真实模型实验；冻结矩阵原有负例继续按原合同验证，不计作 C 生产能力通过。
- `s4-offline-FMMsLw` 的三个生成扩展 SHA 与改造前 `s4-offline-JbTn8j` 完全相同（control `6c16573f…`、supervisor `97869300…`、supervisor-maintenance `ef66d25b…`），未将 C 的新完成合同混入冻结矩阵。

### C 提交与 CI 工装时间修正（2026-09-24）

- C 已提交推送：`d622b5978ab5f14e1ccf96511cd091f5e758a56d`。[首次 CI 35893378425](https://github.com/Smoouns/pi-desktop/actions/runs/35893378425) 的 TypeScript + Rust 任务通过；Windows Harness 失败，未执行后续步骤，因此本次不能算双平台验收通过。
- Windows 固定提交日志：17:07:47 启动 Harness，前两轮分别约 83 秒和 89 秒，第三轮仍有正常 PASS 输出，17:11:47 被 `spawnSync ... ETIMEDOUT` 中止。没有用例断言失败，20 项 C 用例均实际执行三轮，但整套回归没有跑完。
- `scripts/run-public-tests.mjs` 仅将完整三轮 Harness 子进程总时限从 240 秒改为 360 秒，为按上述单轮耗时估计的约 260 秒提供有界余量；其他测试模式仍为 180 秒，产品工具期限、上下文预算、断言和负例均未改动。原超时日志保留，不以未执行步骤冒充通过。修正后的固定提交仍须重新验证。

### S4 超时用例阶段隔离（2026-09-24）

- 有界 360 秒工装提交 `65b9ffa8bdd71bd4fb25b40f39dbddb7ca52b5f4` 的 [CI 35894251821](https://github.com/Smoouns/pi-desktop/actions/runs/35894251821)：Windows/Node 24 全部必需步骤通过，含 Harness 283 例 × 3、S4 live tooling 150 项、evidence-report 199 项及真实 8.3 TEMP 回归；TypeScript + Rust 任务也通过。Ubuntu/Node 22 通过 Harness 及此前 SDK 套件后，在 S4 live tooling 的 `timeout, no refund, no second dispatch` 中得到 `JOURNAL_FAILURE` 而非预期 `REQUEST_TIMEOUT`，后续 evidence-report、resize 与构建被跳过。本轮不是双平台通过。
- 两处超时单元用例把 `requestTimeoutMs` 设为真实 20 毫秒，但该期限同时约束日志落盘阶段与网络阶段。日志预留和请求绑定均真实写盘、fsync；只想断言网络超时的测试可能先触发日志期限。原 CI 未保留底层 I/O 错误细节，因此不将慢写盘冒充已确定的唯一环境根因。
- 评测 broker 透传底层已有的时钟注入接口，仅允许 `dry-run`；真实请求在任何建目录、journal claim 或派发前拒绝测试时钟。默认真实时钟、产品代码、策略版本、额度和历史 manifest 均未改动。
- 两处测试等待实际 mock fetch 派发，再手动触发网络阶段的 20 毫秒计时器，不用睡眠或加大期限决定预期错误码。保留真实 journal I/O，并断言前一阶段计时器已清除。新增反例单独卡住日志预留阶段，触发同样的 20 毫秒期限，确认 `JOURNAL_FAILURE`、零派发；另验证 live 模式拒绝测试时钟且没有落盘副作用。
- 网络超时用例补齐超时前 journal / binding 已存在、一次预留不退还、再次提交不能派发的直接检查。测试辅助器单独使用真实 30 秒 watchdog，只用于让错误接线及时失败，不将该 watchdog 当成产品超时或成功依据。
- 本地回归：应用 / 测试 TypeScript 检查通过，SDK context transport 96 项及 S4 live tooling 152 项通过；网络保护用例 61 项通过，真实模型调用 0。S3 的默认真实时钟取消 / 网络期限负例保留，未依赖测试时钟放宽它们；新固定提交的远程结果仍须单独核验。

### C 固定代码提交验收（2026-09-24）

- 被验收提交为 `e9f7d69a21ffdbed85087dd31f4f2346a9009cd5`；[CI 35952265937](https://github.com/Smoouns/pi-desktop/actions/runs/35952265937) 第 1 次执行整体 `success`。已逐步核对任务状态及完整日志，不只读取总状态。
- Windows/Node 24 与 Ubuntu/Node 22：Harness 均为 283 例 × 3、deterministic=true、failures=false；20 项 C 用例在各平台日志中均有 60 条 PASS。长程 Harness 均为 1 例 × 3、deterministic=true、modelCalls=0。应用 / 测试 TypeScript 检查、领域回归、离线 eval、Pilot 均实际执行并通过。
- 两平台 SDK ablation / S2 / S3 / lifecycle / transport / context live tooling / recovery races / supervision / supervision live tooling 分别通过 101 / 95 / 103 / 175 / 96 / 83 / 125 / 188 / 152 项检查；evidence-report 均为 199 项，聊天面板回归及前端构建通过。冻结矩阵中按原合同核验的历史负例不是 C 生产能力的通过证据。
- Windows 普通与短 TEMP 两次 journal 均为 passed=11、unsupported=[]，日志有 `PASS journal.windows-short-temp`；Ubuntu journal=10、unsupported=[]。Ubuntu 仅按条件跳过 Windows 专属短路径步骤，Windows 没有跳过步骤，没有必需检查因前置失败而未执行。
- 独立 TypeScript + Rust 任务通过：前端构建、`cargo check`、RPC generation 3 项、session file safety 1 项、role branch isolation 5 项均实际执行。此 CI 不包含 Desktop 人工点击、C 独立 OS 进程冷恢复或真实模型测试；真实模型调用仍为 0。
- 此结果在后续纯文档提交中登记，该文档提交跳过重复 CI，未修改任何源码、测试或工作流；CI 通过声明绑定上述固定代码 SHA，不将未执行的检查记为通过。

上述 C 验收未包含 D/E；D 的后续本地证据及独立固定提交 CI 见下文。E 的压缩质量、预算计量及读取成本优化另行推进。

## D：完整生产生命周期验收清单

范围：直接加载当前 `NOVEL_TOOLS_EXTENSION_CONTENT`，由固定版本 SDK 的真实 `AgentSession` 驱动 input / context / provider / tool / compaction / agent_end 接线，不手动 emit 产品生命周期。模型响应使用确定性的本地脚本；不调用真实模型，也不复刻另一套任务准入、压缩维护或完成判定逻辑。

| 验收项 | 要求 | 当前状态 |
| --- | --- | --- |
| D-01 组合交付 | 原生读取与受控写入、真正的章节验证脚本、缺少产物反例、全部产物满足后才完成；核对实际派发数与当前 SHA | 本地通过 |
| D-02 原生压缩与冷恢复 | 真实 `session.compact()` 写入 SDK compaction 记录，关闭进程后以另一 PID 重开磁盘会话；保留 taskId / objective / 约束顺序 / 当前凭证，不重放已完成写入 | 本地通过 |
| D-03 来源失效与精确重读 | 冷恢复后来源改版；无关行重读不能解锁，依赖行完整交付并显式 refresh 后恢复；旧验证不可借用 | 本地通过 |
| D-04 取消与中断 | 派发前取消无文件副作用；派发后、回执前终止进程，冷恢复只核对 post-image，不自动重放 | 本地通过 |
| D-05 隔离与损坏 | 同一项目不同会话 / 职能不借用合同，最新损坏记录不回退为旧成功；操作与终态不因恢复复活 | 本地通过 |
| D-06 定向突变 | 仅在临时生成扩展副本禁用来源 SHA 比对，同一个来源改版拒绝断言必须失败；生产文件和冻结评测不改 | 本地通过：准确检测指定断言失败 |
| D-07 Desktop | 任务提交、状态展示与实际 UI / Rust / RPC 链路单独验收，不用 SDK 或组件测试冒充 | 本地通过：独立标识的隔离原生包；详见 `REVIEW_D_NATIVE_ACCEPTANCE.md` |

证据与边界：D-01–06 只使用公开 fixture 的临时复制、白名单子进程环境、独立 agent 配置及网络防护；记录源码 SHA、SDK / Node、PID、原生工具派发、验证器执行、SDK compaction 与文件哈希。每次运行创建新证据目录；前后核对仓库 fixture。观察记录仍不跨进程持久化，恢复时按现有协议回源。自动化通过不代表真实模型的语义质量、Desktop 点击验收或远程 CI 通过；D-07 的原生点击及不同隔离边界另行记录。未获得新的真实模型实验授权，不更改真实小说、全局 Pi 配置或历史报告。

### D 首轮红灯（修复前）

- `artifacts/harness/production-lifecycle/d-0wYYHp/summary.json`：六组中两组通过、四组失败，未计作验收通过。真实 SDK 已完成读、写、真实验证与跨进程丢回执对账；继续下一轮时，`context` 在 `agent_start` 异步初始化结束前持有旧 run，后续 `chargeRead` 抛出 `The tool belongs to an ended run.`。SDK 的普通事件走异步事件队列，context transform 可与其并行；此前手工顺序 emit 不会复现此接线竞态。
- 最新合同损坏负例在真正派发前被后一个 input hook 拦截，但更早的预算预检仍抛出未处理的合同完整性异常；严格工装拒绝将该异常视为正常成功。取消与来源 SHA 定向突变两组通过。失败报告保留，不覆盖或改写。

### D 最小修复与本地验收（2026-09-24）

- 管理扩展升级为 v18。`context` 等待当前 `agent_start` 初始化完成后再获取 run，避免持有被初始化替换的旧 run；未放宽来源核验、预算、写入准入或完成合同。预算预检发现损坏任务记录时，明确拒绝发送、恢复输入并通知用户，不把异常交给 SDK 吞掉后继续。
- 新增 `npm run test:production-lifecycle`；说明见 `tests/harness/production-lifecycle/README.md`。真实 SDK `AgentSession` 驱动完整当前扩展，不手动 emit 生命周期；仅模型响应、UI 回调与前端→SDK 的传输边界使用替身。原生读写计数在生产 guard 通过后、真正调用 SDK 文件工具的位置；验证器实际启动仓库 TS 脚本，并检查写入前意图已落盘。
- 最终两次完整新增回归：`artifacts/harness/production-lifecycle/d-vdZ8L3/summary.json`、`artifacts/harness/production-lifecycle/d-VHbAU2/summary.json`，均为 **8 组通过 / 15 个独立进程**。每次汇总均记录源码与工装 SHA、当前 HEAD=`7f4b68f` / dirty=true、Windows / Node 24.19.0 / Pi SDK 0.63.1；真实模型调用 0、网络防护无触发、仓库 fixture 不变。
- 组合交付：正文写入并通过真正的完整验证，但缺连续性提案时不能完成；补齐后才 `STOP_VERIFIED`，`userAccepted=false`。原生手动 compaction、进程退出与新进程重开后，taskId、objective、约束顺序和凭证保留；零重复写入 / 验证。章节卡改版并重读 refresh 后，旧 PASS 仍不能完成，显式对新版本重新验证才完成。
- 丢回执：在真实文件写入完成、SDK `tool_result` 之前退出子进程（预期退出码 86），持久化意图仍为 dispatched / issued。另两进程分别对账并检查外部 B 冲突，三进程合计 **一次原生写入**；不会仅换调用 ID 就重放 A。父进程在故意中断时也核对文件边界。
- 读取与隔离：跨进程恢复只保留已交付的第 8–9 行，改版后读第 1 行不能解锁，分别读 8、9 行并显式 refresh 才 ready；旧 Observation ID 必须回源。真实 SDK A(write)→B(plan)→A 切换保留各自任务，切换期间迟到的 A 响应不派发到 B。独立 `abort()` 的 CANCELLED 冷恢复保持取消；SDK `switchSession()` 会先断开事件订阅再 abort，返回旧会话时以 `BLOCKED_PREREQUISITE / INTERRUPTED_RUN` 封住未结束记录，不自动续跑。
- 来源版本突变仅发生在临时扩展，禁用 SHA 比对后，同一个 `SOURCE_VERSION_ORACLE` 确实抛出预期 AssertionError；工装只接受这个具体失败且要求前置对照通过，不把任意子进程错误当作突变检测成功。
- 扩展验收工装期间保留两轮非产品红灯：`d-v2gyJg` 的上下文 fixture 没有采用产品实际的换行封装，且断言辅助函数将显式 undefined 当成默认 true；已按真实封装和空合同断言修正。`d-DnkLpF` 把 SDK 切换中断误期望为显式 abort 的 CANCELLED；核对 SDK 代码后改为严格断言上述 INTERRUPTED_RUN 终态并保留零自动派发断言，没有取消负例。
- 原有回归：应用 / 测试 TypeScript 检查、Harness **283 例 × 3**（deterministic=true、失败 0）、长程 Harness **1 例 × 3**、小说领域回归、前端构建全部通过。构建仍仅有既有 bundle 大小及动态 / 静态混合 import 提示。冻结 SDK context / lifecycle 分别 **103 / 175** 项检查通过，原声明的历史负例保留，不能算新的生产通过。
- 已加入双平台 CI 命令与独立 JSON artifact 上传，但**本批尚未提交推送，远程检查未执行**。非可视前端发送测试核对真实发送函数→SDK 输入合同→状态摘要，未覆盖 DOM、Tauri/Rust RPC 或原生 Desktop 点击；按用户要求本轮不使用 computer use，D-07 保持待验收。没有开展 E、真实模型实验或自动压缩质量评测。

### D-07 原生 Desktop 追加验收（2026-09-24）

用户允许恢复 computer use 后，使用独立应用标识、公开 A/B 副本、固定 CLI 和离线合成 provider 完成实际窗口验收，详情见 [原生验收记录](REVIEW_D_NATIVE_ACCEPTANCE.md)。此前暂缓记录保留为历史，不将 SDK 测试改称原生验收。

- 原生读取、停止取消、章节工作流→写作角色→完整机械验证→状态详情、关闭重开、会话 A→B→A 及跨项目切换均已实际观察；总计 8 次合成响应，真实模型调用 0。
- 发现并修复状态栏切换丢失：每个 runtime 保存有界只读状态快照；后台状态更新归属原 runtime，切回时恢复，不重放通知、弹窗、编辑命令或 RPC 响应。更换进程 / 项目 / 角色 / 会话前清空旧快照。重建测试包后冷恢复与往返切换通过。
- 本轮新增回归后 Harness **285 例 × 3**，deterministic=true，失败 0；应用 / 测试 TypeScript、窄面板浏览器 DOM 回归、前端构建、隔离原生构建通过。完整 SDK 8 组 / 15 进程再次通过：`artifacts/harness/production-lifecycle/d-DTjD9t/summary.json`。
- 此次点击时独立记录了偶发空白控制台窗口；随后修复与直接回归见下节。D 本地验收不等于发布包、主题、更新安装或真实模型验收。此条记录时尚未 commit / push / 远程 CI，E 未启动。

### D Windows 控制台修复（2026-09-24）

- Windows npm `.cmd` 成功解析为 Node 入口后，`build_command` 早返回漏掉 `CREATE_NO_WINDOW`。在无控制台父进程下，修复前的实际 Node 子进程报告 `consoleAttached=true`，直接断言失败；仅补上这个分支的标志后，同一断言通过。没有改变参数、环境合并、工作目录、代次或 RPC 协议。
- 新增 `windows_process_tests`：2 项测试各启动 4 种实际子进程，涵盖 npm path / npm sidecar、相对路径的非标准 batch fallback、DevNode，以及 RPC / 普通 CLI 两类命令。通过进程内 `GetConsoleWindow` 核验无控制台，另外核对 stdin / stdout / stderr、provider / model / session、中文空格参数与工作目录；不加载 Pi 或调用模型。
- 本地 Rust 11 项测试全部通过，含 RPC generation 3 项、session-file safety 1 项、角色分支隔离 5 项和新控制台 2 项。原有未使用变量 warning 保留。CI Rust 校验扩展到 Windows / Ubuntu，Windows 必须实际运行新控制台回归，Linux 仅跳过该平台专属项。
- 回归工装首次暴露匿名管道读取顺序导致的 30 秒超时；改为同时读取 stdout / stderr 后出现上述精确产品断言。另确认非标准 `.cmd` 的绝对路径含空格时，原有 `cmd /S /C` 引号处理失败；与 npm 解析成功分支不同，本次未修复。fallback 控制台用例明确使用 cwd 相对入口，不声称覆盖绝对路径引号问题。
- 没有重写上一节 D-07 的原生截图观察、源码指纹或历史回读报告。此次修复证据是独立的真实进程测试，不称为再次完成整套原生窗口验收。
- 提交前最终回归：应用 / 测试 TypeScript、前端构建、状态栏浏览器 DOM 检查、Harness **285 例 × 3**（deterministic=true、failures=false）通过；完整生产生命周期 **8 组 / 15 进程** 再次通过，独立报告 `artifacts/harness/production-lifecycle/d-MpVke3/summary.json`。真实模型调用为 0。远程 CI 结果在固定提交实际执行后追加，不预填。

### D 固定提交远程验收（2026-09-24）

- 已提交推送代码：`d66a302aad3ad189ae27805f13fe9a5adfbe4473`。[CI 36001222669](https://github.com/Smoouns/pi-desktop/actions/runs/36001222669) 第 1 次执行整体 `success`。Windows/Node 24 与 Ubuntu/Node 22 的 Public Harness、TypeScript + Rust 共四个任务全部通过；已核对每一步及完整日志。
- 两平台 Rust 校验任务已完成并逐项核对日志：RPC generation **3** 项、session file safety **1** 项、role branch isolation **5** 项均实际通过；Windows 另实际通过 console regression **2** 项，不是条件跳过。
- 两平台 Harness 均为 **285 例 × 3**、deterministic=true、failures=false；新增 SESSION-UI-05 / 06 各执行三次。长程回归 **1 例 × 3**。完整生产生命周期 **8 组 / 15 进程** 全部通过，含指定来源突变断言；独立报告为 Ubuntu `d-wCbvDl`、Windows `d-EsxaWx`（上传的 `artifacts/harness/production-lifecycle` 目录）。
- 两平台应用 / 测试 TypeScript、领域回归、离线 eval、Pilot、前端构建全部实际执行。SDK ablation / S2 / S3 / lifecycle / transport / context live tooling / recovery races / supervision / supervision live tooling 分别为 **101 / 95 / 103 / 175 / 96 / 83 / 125 / 188 / 152** 项检查；evidence-report **199** 项，聊天宽度 **15** 项。所有模型通道均为 test / synthetic，真实模型请求 0。冻结矩阵中的既定负例与 unsupported 仍按原合同验证，不将其改称生产能力通过。
- Windows 普通及短 TEMP 两轮 journal 均为 **11**、unsupported=[]，真实 `PASS journal.windows-short-temp` 出现在日志中；Ubuntu journal **10**、unsupported=[]。
- 平台条件跳过仅三处：Ubuntu 的 Windows 短 TEMP、Windows 控制台用例；Windows 的 Linux 系统依赖安装。没有必需检查因失败而未执行。逐步状态与关键日志摘录留存在本机 `artifacts/harness/ci-d66a302-36001222669/verification.json`。
- 本次远程结果绑定上述固定代码 SHA，后续登记结果的纯文档提交标记 `[skip ci]`，不将未运行的文档提交算作重新验收。原生窗口验收仍以 D-07 的独立本地记录为准，CI 不自动驾驶桌面；E 与真实模型实验未启动。三份原始规划文档保持未跟踪，没有纳入提交。

## E1：启动边缘修复与计量基线（2026-09-24，本地）

此节保留 E1 当时的结果；后续请求内缓存 E2 的独立验收见下一节。

- Windows 非标准 `.cmd` / `.bat` 不再通过普通 `cmd.exe /C` 参数编码；使用 Rust 的批处理专用转义，并按请求 cwd 解析相对入口。先复现含空格绝对路径失败和元字符误解析，再通过 RPC / CLI 各 7 条真实子进程路径。保留无控制台标志、标准 npm → Node 快捷分支和所有管道。
- 管理扩展 v19 新增诊断专用 `runtime-metrics`，`get_context_budget` 返回本次运行及同项目 / 会话 / 职能上一运行的有界计量。估算、SDK usage、HTTP 计数互不冒充；缺失 / 全零 usage 不当作免费；无法核实 cache 和费用时仍未知。
- 区分业务文档、指纹、检查点、Observation、记忆索引及验证报告读取；只数纳入预算的扩展 `readFile` 调用，不声称是全部 OS 磁盘 IO。来源引用和 Observation 分页字节另计，不改变既有收费 / 安全限制。
- 完整 SDK 新增计量 + 冷恢复两进程验收；最新源码独立报告 `artifacts/harness/production-lifecycle/d-XJiNOk/summary.json`，共 9 组 / 17 进程通过，真实模型和网络请求为 0。此前初轮报告 `d-UzJB0p`、`d-OMc5ee` 保留，不覆盖。
- 合成样本一次 Context 的同一 87 字节来源被检查点和 Observation 各读取一次：2 次 / 174 字节；只支持“存在单次请求内复用机会”，不代表真实小说收益或允许省略最后写入版本检查。
- 新增 5 项计量定向用例通过，覆盖生成 / 压缩后的扩展、未知 usage、读取 / 引用分层、容量及会话隔离；Rust 全部 11 项、应用 / 测试 TypeScript、领域测试、长程 1 例 × 3、前端构建通过。最终源码完整 Harness **290 例 × 3**，deterministic=true、failures=false。
- 首轮完整 Harness 的 290 例 × 3 只有同一项失败：预算工具的新说明遗漏既有“累计”提示；实际字节预算断言均已通过。补回“读取及输出预算仍按运行累计”，不改原测试或预算行为；随后三轮全部通过。失败快照保存在 `artifacts/harness/review-e1/harness-first-failure-365683597f504acdad95ba1ecbd5b5e7`，未用成功结果覆盖。
- E1 尚未 commit / push，未进行本批远程 CI、原生窗口或真实模型验收。完整任务级 HTTP / 摘要 / 重试总账、usage 校准、请求内缓存、压缩质量与任务相关进展仍待后续；Observation 持久化继续按需预留。

## E2：单次上下文来源快照（2026-09-24，本地）

- 管理扩展 v20：Checkpoint 与 Observation 在一次 Context hook 内复用文件 SHA / 行数；局部传递并在 finally 销毁，不保留正文或人工验收结果。每次命中仍核验路径、链接、类型、文件大小与 stat 变化；SHA 仍来自实际字节。
- 下一请求、主动分页读取、工具刷新 / 对账、最终写入及完成核验不沿用该缓存。128 项 / 4 MiB 来源规模上限只限制缓存，超限回退读取，原累计预算继续执行。验收撤回、同大小 / 还原 mtime 的改写、取消后旧 IO 均有定向负例。
- 相同 SDK 受控样本的来源引用仍为 2 次，实际读取从 E1 的 2 次 / 174 字节降为 1 次 / 87 字节。`sourceCache` 统计命中、未命中、失效与容量回退；不把命中量当作普遍省钱 / 磁盘 / 端到端加速结论。
- 定向缓存 **7 项**、原计量 **5 项**、完整 Harness **297 例 × 3**（deterministic=true、failures=false）、长程 **1 例 × 3**、应用 / 测试 TypeScript、领域回归及前端构建通过。Harness 冻结副本：`artifacts/harness/review-e2/harness-passed-847d8331f39d4436a7ce9481b65dd4ea`。
- 完整生产 SDK 生命周期 **10 组 / 19 个独立进程** 通过，报告 `artifacts/harness/production-lifecycle/d-stpncV/summary.json`。Context 结束后改写来源，原生写入仍被拒绝；冷启动不继承缓存，也不自动恢复失效证据的权限。真实模型调用与网络防护触发均为 0。
- 详情见 [E2 验收记录](REVIEW_E_SOURCE_CACHE.md)。E1 历史证据未改写。本批没有改真实小说 / 全局 Pi，没有新 Desktop / Rust 验收、提交推送或远程 CI；E3 的 transport 任务总账、真实 usage 校准、压缩质量与任务相关进展仍待后续。

## E3：任务级请求计量（2026-09-24，本地）

- 管理扩展 v21：普通 provider 调用、Pi 原生压缩 / 分支摘要、同一次客户端调用内的 fetch 再次尝试按项目 / 会话 / 职能 / taskId 归属。支持固定 SDK 的 OpenAI 兼容与 Google 发送层；其余通道覆盖缺口明确标记，发送预记不冒充服务器实收，`httpRequests` / 费用仍可未知、`taskTotalComplete=false`。
- 新增 `/novel-transport-status` 只读详情，结束后的任务仍可查询；`get_context_budget.taskTransport` 提供结构化快照，原运行级 metrics 不变。SDK 归一化 usage 不视为已核实 cache，不根据参考价格补猜费用。
- 支持通道在最终序列化后的 fetch 前检查预算、取消及记录归属；journal 绑定失败时显式拒绝，不能因 SDK 吞掉 payload hook 错误而继续发送。保留原重试策略；直接转交 assistant stream，HTTP body 背压转交，不缓冲完整 SSE。
- 实测 Pi 首条 assistant 前只缓冲自定义记录，因而增加有界、同步提交的会话 / 任务计量旁路文件。先落盘再发出；损坏、并发版本冲突、遗留锁均拒绝而不重置。冷恢复的未结请求为未知，不重放。该计量恢复不代表尚未落盘的 Pi 聊天 / 合同也能恢复；同一任务已放弃分支的消耗不回滚。
- 定向 **10 项**、完整 Harness **307 例 × 3**（deterministic=true、失败 0）、长程 **1 例 × 3**、应用 / 测试 TypeScript、领域 smoke 与前端构建通过。完整 SDK 生命周期 **10 组 / 19 个独立进程** 通过：`artifacts/harness/production-lifecycle/d-3vuewg/summary.json`，包括任务普通 / 摘要计量跨 PID 精确恢复及零重放。
- 实际 OpenAI / Google SDK 客户端连接本机计数服务器：**14 组 / 24 次 loopback HTTP** 通过，`artifacts/harness/task-transport/e3-xACstO/summary.json`。服务器在应答前核对磁盘发送记录；覆盖原生摘要、分支、默认客户端重试、超限与损坏零新增 HTTP、首段流式可见后取消、未知 usage 和失败摘要。真实模型调用 0、外网阻断触发 0、测试服务器失败 0。
- 首轮完整 Harness 的原预算诊断失败已保留：`artifacts/harness/review-e3/harness-first-failure-329f3c970deb4bc296c1932dfc7a7012`。调整预算检查 / 计量绑定顺序后原断言通过，成功副本为 `artifacts/harness/review-e3/harness-passed-7faa69f05e4a4fb497ae37651d0b927e`。其余 SDK 初轮失败与修复边界详见 [E3 验收记录](REVIEW_E_TRANSPORT.md)。
- 本批没有真实模型、Desktop 点击、Rust、发布包或远程 CI 验收，没有提交 / 推送，没有修改真实小说 / 全局 Pi。下一步仍为同模型 / 同投影 usage 校准、压缩质量与任务相关进展；Observation 持久化继续按需预留，不因计量通过而宣告整个 E 完成。

## E4：配对用量诊断与工具裁剪保护（2026-09-24，本地）

- 管理扩展 v22：在 E3 的同一发送作用域内将最终序列化输入与终态 SDK usage 配对。仅完整单次发送、无重定向、成功且 usage 有效的响应形成进程内诊断锚点；按固定 SDK 将缓存输入加回上下文输入，不混入输出 token，不计算未知费用。
- 只有模型 / endpoint / 静态参数 / system prompt / 工具 schema / 投影相同且历史严格追加时才记录增量预测误差。模型、会话、任务、压缩边界、历史改写、缺失 usage、重试及迟到响应不会借用旧锚点。诊断有界、不保存原文或密钥、不持久化、不修改预算。
- 修复已复现的按结果条数拆散近期并行批次、裁剪旧错误及未完成批次问题。裁剪成功结果保留 Observation ID；完整生产扩展中来源改版仍返回 `stale_source`。自然语言摘要仍不得授予 Canon 权限；不是已实现通用进度摘要。
- `test:usage-calibration` **11**、`test:context-quality` **10**、原 `test:task-transport` **10** 项通过；完整 Harness **323 例 × 3**，deterministic=true、失败 0，另有类型检查、领域 smoke、长程 **1 例 × 3**及前端构建通过。初始两项红灯与固定成功副本均保留在 `artifacts/harness/review-e4`。
- 完整生产 SDK + 真正客户端 / 本机服务器 **15 组 / 33 HTTP**通过（`task-transport/e4-H3cTQ1`）；完整生命周期 **10 组 / 19 PID**通过（`production-lifecycle/d-sxOk6y`）。三次有意返回错误批准文字的原生摘要仍不能替代原文约束和权威检查；冷进程恢复任务账但没有校准锚点。两类工装的替身、边界与路径见 [E4 验收](REVIEW_E_CALIBRATION.md)。
- 真实模型调用 0，无桌面控制 / 真实小说 / 全局配置改动，未提交推送。下一步可补有界非权威的任务执行进展与相关性回归；真实 usage 误差和语义质量需另行授权、预登记同任务对照后测试。不能据合成数据宣称 token 节省、摘要质量或所有 E 项目已经完成。

## E5：有界非权威任务进展（2026-09-25，本地）

- 管理扩展 v23：宿主实际读取、确认写入、机械验证和结构化失败生成独立历史记录，绑定活动分支及项目 / 会话 / 职能 / taskId。每份最多 24 条 / 24 KiB；模型投影最多 12 条 / 12 KiB，纳入既有预算。没有原始正文或自由文本记忆，不从模型“已完成”推断事实。
- `/novel-run-status` 显示最近进展，Agent 检查点 / 运行状态结果包含 `progress`。全部标为历史、非权威且未人工验收；旧 PASS 遇到来源变化必须重验。可选记录失败不改变写入、检查点或完成门槛，不自动重放；缺失和淘汰明确标注。
- 定向 **12 项**通过；完整生产 SDK 生命周期 **11 组 / 21 独立进程**通过（`production-lifecycle/d-FdcT4x`），覆盖三次压缩、冷恢复、失败诊断、作用域隔离、损坏记录与零重放。实际 SDK / 本机服务器 **15 组 / 33 HTTP**通过（`task-transport/e4-yuuj84`），不是实际模型质量证据。
- 应用 / 测试 TypeScript、领域 smoke、长程 **1 例 × 3**、前端构建通过。完整 Harness 复跑 **335 例 × 3**通过，deterministic=true、失败 0；成功副本保存在 `artifacts/harness/review-e5/harness-passed-344e67e25785b7ceb608aef352bb667e1e09d2f6ea968d138155293596d9fa83`。
- 首次完整 Harness 第二轮的两个既有 Google HTTP 数断言失败单独冻结；第一、三轮通过且 trace 一致。补测试诊断后固定 8 轮定向 **32/32**与完整复跑通过，但原因仍未定位，不标记为已修复。初始缺口与首版接线失败也保留。路径、故障注入边界及证据见 [E5 验收](REVIEW_E_PROGRESS.md)。
- 未提交 / 推送，无新增 Desktop / Rust / 远程 CI / 真实模型验收，不改真实小说或全局 Pi。下一步可处理 AUD-10 的任务相关有效进展判定；保留硬预算，不让该历史记录本身重置无进展计数。真实 usage 校准与摘要语义质量继续单列。

## E6：验证对象级机械进展（2026-09-25，本地）

- 管理扩展 v24：不再将全局新读取或文件 SHA 改变视为验证修复；按对象 / 具体验证模式 / 已核对依赖版本 / 诊断形态独立计数。字数等可解析差额严格改善可继续；同值、变差、无关读写、正文空白及返回旧错误 / 依赖不冲掉原计数。机械长度改善不等于写作质量，未知诊断不猜测严重性。
- schema 2 运行快照有界并校验完整性，旧 schema 1 原样可读；冷恢复不自动运行，明确新输入才能重启。任务完成仍须当前来源的完整 PASS，用户验收和 Canon 权限不变。通用工具修复错误继续使用既有独立启发式，不冒充通用语义进展。
- 先补 5 项有效红灯，再实现并扩展到 **13 项**定向验收。完整 Harness **348 例 × 3**通过，deterministic=true、失败 0；146 项实现文件哈希与当前代码一致。固定副本：`artifacts/harness/review-e6/harness-passed-0479457e93394627ba38bfe0472e555b7b654539f03c0b7ff1f19f35cb515925`。
- 完整 SDK 生命周期 **13 组 / 24 独立进程**通过（`production-lifecycle/d-gy4UB6`）。真实验证器在无关活动间重复失败 3 次后准确 NO_PROGRESS；冷恢复零重放，明确修复后可候选完成。另一正例 4 次同形态字数差额改善不误停，第 5 次完整验证通过。
- 如实区分 SDK provider 入口与请求：停滞负例 10 个工具、10 次生成回复，另有 1 次已取消的 provider 入口，不生成回复或派发工具；不是 HTTP 计数。初轮并行写入触发旧门禁、入口计数假设错误等失败证据保留，详见 [E6 验收](REVIEW_E_EFFECTIVE_PROGRESS.md)。
- 实际固定 OpenAI / Google 客户端连接本机服务器 **15 组 / 33 HTTP**通过（`task-transport/e4-dDsrSz`）；应用 / 测试 TypeScript、领域 smoke、长程 **1 例 × 3**、前端构建通过。真实模型调用 0，无新增 Desktop / Rust / 远程 CI 验收，未提交 / 推送；不改真实小说、全局 Pi 或冻结评测实现。
- 下一步：定位 E5 的两个 Google 偶发测试问题；再另行授权并预登记真实模型 usage / 压缩质量 / 读成本联合验收，最后提交推送、跨平台 CI 与更新后的原生 Desktop 验收。AUD-09 Observation 持久化仍按需求预留，不在本批扩展。

## E7：Google 测试端口问题（2026-09-25，本地）

- 此 Windows 的随机端口范围与 Fetch 受限端口重叠。固定 6667 确定重现两个原失败（SDK `fetch failed`，底层 `bad port`，HTTP 实收 0），固定允许端口后原断言通过。原 E5 失败缺少端口 / cause，历史归因仍未证实；未修改其冻结记录。
- 仅修当前公共 HTTP 测试的 loopback 选址：最多 32 次空绑定，排除受限端口，普通绑定错误不重试；SDK 请求不重试、不放宽任何预算或 late-abort HTTP 数量断言。完整记录见 [E7 端口调查](REVIEW_E_PROVIDER_TEST_STABILITY.md)。
- 受控真实端口注入确认两个受限绑定均在调用 provider 前被替换；定向 **8 项 × 3**通过。实际固定 SDK 本机测试 **15 组 / 33 HTTP**通过（`task-transport/e4-lY1745`），外网阻断触发与服务器失败均为 0。应用 / 测试 TypeScript 通过；完整 Harness **352 例 × 3**通过，deterministic=true、失败 0，149 项实现文件哈希核对相同。固定副本 `artifacts/harness/review-e7/harness-passed-a88fe5dbaa174ac968ffc03db002caaf378cdea860e6fe0ec8c0fef25c4d49c6`。
- 本批生产代码和运行策略未改，无真实模型、系统网络配置、全局 Pi、原生 Desktop 或远程 CI 操作，未提交 / 推送。下一步是另行授权并预登记真实模型 usage / 压缩质量 / 读成本联合验收；不是继续猜测历史端口或反复重跑直到通过。

## E8：真实模型联合验收准备（2026-09-25，仅方案）

- 已拟定 [E8 方案 v1](REVIEW_E_LIVE_VALIDATION_PLAN.md) 及不可执行的 JSON 草案：3 个公开合成场景分别观察同请求用量配对、独立会话的压缩对照、实际读取与来源新鲜度。
- 拟定每场景 8 / 全批 24 次 HTTP，普通与原生摘要共享；每请求最多 65,536 输入字节、2,048 输出参数。用户参考价的满额无缓存预留约 $1.36，不是美元硬限额；cache 不明仍记费用未知。
- 当前只读核对选定模型配置存在，未解析凭据、探测端点、生成已授权 manifest 或发送模型请求。旧 live 工装是独立 profile，下一步先实现完整当前扩展的新驱动并离线验证，再 prepare 精确清单、单独请求真实批次批准。不改旧冻结实验、生产运行策略、真实小说或全局 Pi，不提交 / 推送。
- 不可执行方案通过 7 组静态检查及既有 `freezeRequestPolicy` 校验，E7 的 149 项实现文件字节不变。结果在 `artifacts/harness/review-e8/plan-check-1dzvFE/summary.json`；此检查不是新驱动验收或 live prepare。

### E8 离线驱动（2026-09-25）

- 新增 `test:review-e8` 与只读 `test:review-e8:recover`。完整 v24 扩展一次生成后逐字复制到隔离 worker；固定 SDK、原生工具与单 / 双摘要、真实序列化 / 解析和串流均运行，对端仅为本机合成 broker，不替换 provider 或另写 Agent 循环。
- U 逐次对应请求与 usage，cache 缺失保持 null；C 同 seed 的独立压缩对照、摘要 / 结构化记录 / 最近消息 / 最终投影分别留档；R 实际 992 字节来源在单上下文复用读取、下一上下文重读，同大小 v2 改写后重新读取并刷新。正确合成答案不等于真实摘要质量，未命中锚点不造命中。
- **23 组 / 35 次本机 HTTP**通过（U/C/R 正例 14 次），覆盖缺失用量、超限、认证 / 限流 / 服务器错误、重定向、超时、取消、崩溃、未启用工具及越界路径、日志改写 / 损坏、终态相关性与冷恢复零重放。结果 `artifacts/harness/review-e8/offline-fbGy8H/summary.json`；首轮接线失败与未启用工具未及时停批的失败也保留，详见 [E8 离线验收](REVIEW_E_OFFLINE_DRIVER.md)。
- 完整 Harness **352 例 × 3**通过，deterministic=true、失败 0，157 项实现 SHA 核对一致。固定副本 `artifacts/harness/review-e8/harness-passed-849578b4cb51642db7fdc6cb597fd04cc8c6740281e4eb1c236b405ca95d872d`。原有 SDK 发送层 **15 组 / 33 HTTP**通过（`task-transport/e4-d8JGhB`），应用 / 测试类型检查及 diff 检查通过。
- 本批没有生产代码 / 运行策略、真实小说、全局 Pi、冻结 eval 实现改动，无真实模型、Desktop、Rust、远程 CI 或提交推送。`livePrepareReady=false`；下一步补真实批次的无网络 prepare / 配置投影与授权门禁，冻结精确清单后另行批准。不能沿用旧 allowance，也不能把本次离线批准当成付费请求授权。

### E8 准备与授权门禁（2026-09-25，配置待确认）

- 新增独立 prepare / verify / 单次授权 / 只读 recover；受控 live 出口已接线但本轮不运行。准备不解析真实凭据，SDK 原始 / 占位 URL 序列化需一致，完整扩展 U/C/R 通过零网络 IPC 合成 SSE 演练，普通及双摘要均按生产调用 ID 配对。
- 冻结代码、资产、选定已安装依赖和编译器 / Node 字节、模型 / endpoint / 凭据引用指纹、fixture / 工具 / 提示 / 预算。授权先以独立无凭据进程同步落盘消耗，再允许解析所选环境变量；配置漂移、过期、复制目录、重复启动拒绝。中止及迟到结果不恢复请求，C 的独立两会话共享场景额度与期限；cache 未知继续保留费用未知。
- 最终门禁 **20 组**通过（`review-e8/gate-tests-F4xs5G`），原 E8 本机 HTTP **23 组**通过（`review-e8/offline-8U6zWG`），固定目的地址适配器 **61 项模拟断言**通过；完整 Harness **352 × 3**通过，deterministic=true，固定副本 `review-e8/harness-prepare-passed-410d85703ce65d09f026febc24877e906a3218c5b4102b5850c87b5d5702ec5d`。166 项实现清单中仅 README 文档在报告后更新，其余 165 项字节一致；应用 / 测试类型及 diff 检查通过。
- 用户实际配置的 prepare 在前置格式检查失败：所选 provider 的 `apiKey` 不是支持的环境变量名引用；模型、窗口与显式本机 HTTP 地址符合已检查要求。失败目录 `review-e8/prepared-RqccKG` 保留；没有生成实际 manifest、读取环境变量 key、发送请求或改全局配置。需要用户提供变量名 / 确认配置调整，再生成新清单并单独批准，不能拿虚构配置测试的 manifest 代替。
- 详见 [准备记录](REVIEW_E_PREPARATION.md)。本轮真实模型调用 0，未操作 Desktop、真实小说、全局 Pi 或冻结评测实现，未提交 / 推送；仍不宣称真实模型用量校准、摘要语义质量、读取节省或整个 E 已完成。

### E8 精确清单冻结（2026-09-25，等待真实批次批准）

- 用户指定 `GEMINI_API_KEY` 后，仅将 `models.json` 中所选 provider 的 `apiKey` 改为该引用，其余配置语义不变；只确认变量名存在，不读取值或进行鉴权。历史失败 `prepared-RqccKG` 保留。
- 收紧启动环境传递为先筛名称、后取白名单值；两条实际表达式的合成 getter 检查通过，凭据访问 0。准备门禁复跑 **20 组**通过（`review-e8/gate-tests-FbE9pc`），测试类型检查通过；没有新增完整 Harness / Desktop / Rust / 远程 CI 结果。
- 当前选定配置成功完成无网络 SDK 序列化对比及 14 次完整扩展合成调用，独立 verify 通过。清单 `review-e8/prepared-q4sDJ2/manifest.json`，SHA `21a0caa94d17f6fc8c158ebb76a7261a9504081b35f7b052853e06219b7f7d47`，到期 **2026-09-26 15:57:15.777 UTC+8**；授权未消耗、执行未启动、真实模型调用 0。
- 下一步仅在用户明确批准这份清单及未知费用边界后执行 U/C/R。全批 24 / 单场景 8 次上限不变，参考满额无缓存预留约 $1.36，不是硬金额上限。没有提交推送，没有沿用旧授权或拿合成结果证明真实模型质量。

### E8 首次真实执行（2026-09-25，权限异常停批）

- 用户明确批准 `prepared-q4sDJ2` 后消费单次授权并执行；首个实际请求 `tools: []`，响应却要求 `list_dir({})`。固定 SDK 拒绝未启用工具，外围 `tool_permission` 停止后续发送。成功工具执行 0，1 次真实派发 / 1 个完整响应；另一个被取消的 provider 入口不是第二次 HTTP。
- U 未完成第二次固定提示，C 的两个分支及 R 均 `not_run`，不能算联合验收通过。模型行为 / 代理转换 / 上游注入的具体根因尚不能由单条响应判定，没有另发探测或自动重试；授权已消耗，不续用余量。
- 原始用量为输入 798、completion 6、reasoning 708；固定 SDK 归一化输出 714，cache 缺失，实际 / 参考费用均未知。输入估算 1,642 相对同调用 798 高估 844；只有一条诊断样本，未调整生产估算器，不证明真实校准或摘要质量完成。
- 原报告失败路径漏导出 ledger，自动配对为 0；只读审计校验 broker 链和持久会话生产账 SHA 后恢复 1 条配对，原报告不改写。新证据：`review-e8/readback-q4sDJ2/summary.json`，原报告：`review-e8/prepared-q4sDJ2/live/report.json`；详见 [真实执行记录](REVIEW_E_LIVE_RESULT.md)。
- 已确认 Canon / 验收 sentinel 与来源 v1 未变，执行后 verify 通过；recover 1 预留 / 1 终态 / 0 未结 / 0 新请求、禁止重放。建议下一步离线完善失败收尾导出和 reasoning 计量，并诊断无工具请求的兼容性；本轮不实施这些修复、不改全局配置、不提交推送，也不新增 Desktop / Rust / 远程 CI 验收结论。

### E8 失败收尾与工具协议离线回归（2026-09-25）

- 经用户批准，仅修 E8 工装：失败路径保留消息 / 会话路径 / 通知 / 生产台账，清理错误不掩盖首错；未运行场景不记失败分数，停批或业务观察失败退出非零。显式含 reasoning 的输出按固定 SDK 归一化口径检查，不猜供应商账单，未知费用继续保留。
- 先复现 2 项红灯（`review-e8/gate-tests-iSIYO3`），修复后准备门禁 **33 组**通过（`review-e8/gate-tests-XGbEGG`），原 SDK / loopback 回归 **23 组**通过（`review-e8/offline-88d7g3`）。模拟未启用 `list_dir` 响应时自动报告能保留 1 条用量配对，后续请求仍被拒绝；不冒充新的真实样本。
- 固定 SDK 四种工具策略的零网络 payload 核对确认：空数组不自动生成 `tool_choice: none`，显式选项可被序列化。但代理是否遵守、为何返回未声明工具仍未验证；没有开放工具、删减生产扩展或偷偷改变真实请求来获得通过。
- 原真实批次 8 项证据 SHA 未改变，无真实模型请求、全局 Pi / 真实小说 / Desktop 操作或提交推送。旧授权已消耗且源码已变化，再次实测需新清单及批准。详见 [离线修复记录](REVIEW_E_FAILURE_RECOVERY.md)；没有新增完整 Harness / Rust / 远程 CI 结论。

### E8 单请求工具协议诊断准备（2026-09-25，待批准）

- 新建独立 `tool-none` profile，保留完整生产扩展、原只读提示及空工具集合；仅在诊断专用 hook 添加 `tool_choice: none`，位于生产审计之前。最多 1 次请求，输入 8,192 bytes、输出 2,048，禁止追加、工具执行、重试和摘要。普通 U/C/R 及生产运行策略不自动改变。
- 新诊断 **16 组**、原准备门禁 **33 组**、原 SDK / loopback **23 组**均通过；覆盖纯文本、未声明 / 旧式工具调用、HTTP 400、用量缺失、空 / 截断回复、参数和授权漂移及零第二次派发。证据分别为 `tool-none-tests-qvwqVd`、`gate-tests-qsMDJE`、`offline-5RrYAo`。应用 / 测试类型检查通过，真实模型调用 0。
- 用户当前配置的无网络准备与独立 verify 已完成。新清单 `review-e8/tool-none-Z93R4B/manifest.json`，SHA `5c77620d71b94c9d352e7ce72436c3fa725e29ae315be0f81d384fde43e69b02`，到期 **2026-09-26 16:52:10.260 UTC+8**；授权未消耗、执行未启动。满额无缓存预留参考 $0.013824，不是账单或硬金额上限，未知费用保留未知。
- 只得到一次协议观察也不能确定原异常根因或上游身份，U/C/R 仍未实测。旧真实批次 / 旧计划保持原样；不读真实 key、不改全局配置或真实小说、不操作 Desktop、不提交推送。详见 [单请求诊断记录](REVIEW_E_TOOL_PROTOCOL_DIAGNOSTIC.md)。下一步仅在用户批准这份新清单后执行一次。

### E8 单请求工具协议真实诊断（2026-09-25，已完成并消耗授权）

- 用户批准精确清单 `tool-none-Z93R4B` 及未知费用边界后，执行前 verify 和未消耗检查通过，17:09:30.138 UTC+8 消耗单次授权。只发送 1 次，HTTP 200，显式 `tools: []` / `tool_choice: none`；原始 SSE 和 SDK 均无工具调用，成功工具执行 0，退出 0。没有重试、摘要或追加请求。
- 原始输入 802、completion 296、reasoning 519，SDK 输出 815；1 条同调用 usage 配对，缓存缺失，费用未知。输入估算 1,656，误差 +854；仅一条本批观察，不调整生产估算，也不能由 HTTP 200 和文本回复证明旧异常的唯一根因或上游身份。回复偏长，不能当成已满足全部表达要求。
- 原报告 `review-e8/tool-none-Z93R4B/live/report.json`，只读审计 `review-e8/readback-tool-none-Z93R4B/summary.json`。broker 链、持久会话台账与用量相符，测试文件不变，旧失败批次 8 项证据 SHA 未变；recover 无未结 / 无新请求 / 禁止重放，执行后 verify 通过且授权已消耗。
- 不改生产策略、真实小说或全局 Pi，不操作 Desktop，不提交推送；U/C/R 仍未完成。下一步建议仅对 U/C 无工具测试启用显式禁止，再另行准备新联合验收清单及批准，不能挪用本次已用尽额度。详见 [单次真实诊断](REVIEW_E_TOOL_PROTOCOL_DIAGNOSTIC.md)。

### E8 U/C 显式禁止工具的联合准备（2026-09-25，待批准）

- 用户批准后新增隔离 `joint-tool-none` profile：U/C 普通请求及 2 个原生摘要均在生产审计 / 最终请求计量之前加入 `tool_choice: none`；原 provider、摘要、流解析和完整生产扩展保留，R 和正常生产工具不变。原 joint、单请求 profile、旧计划和旧批次不覆盖。
- 新 **16 组**、原准备 **33 组**、原单请求 **16 组**、原 SDK / loopback **23 组**通过；证据为 `joint-tool-none-tests-GxeVEw`、`gate-tests-uV1uVW`、`tool-none-tests-fMVr9Q`、`offline-5EYecv`。新首轮误写 HTTP 错误码断言的 15/16 记录保留在 `joint-tool-none-tests-61DW2q`，未修改生产错误码来迎合测试。
- 新清单 `review-e8/joint-tool-none-XbVP5l/manifest.json`，SHA `1c77cdb7c7b4d3c068003e23e06dc32b0d0d7f634182f9f2d60fd47e1adf18fa`，到期 **2026-09-26 17:33:59.271 UTC+8**；独立 verify 通过，授权未消耗、未启动。14 次零网络完整扩展演练：U/C 6 次有明确禁用，R 8 次不变，14 条 input/output 配对。真实模型调用和凭据解析为 0。
- 上限仍全批 24 / 每任务 8，单次 65,536 输入字节与 2,048 输出；满额无缓存参考 $1.363968 不是硬金额上限，未知缓存 / 计费继续保留费用未知。人工摘要核对仍未做，不能将合成结果或单次诊断写成联合实测通过。
- 两个旧实测批次各 8 项证据 SHA 和 139 项生产 / 冻结评测文件未变。类型检查与 diff 检查通过；不改全局 Pi、真实小说，不操作 Desktop，不提交推送。详见 [新版联合验收准备](REVIEW_E_JOINT_TOOL_NONE.md)；下一步需用户批准新清单后再发送请求。

### E8 新版联合真实执行（2026-09-25，输出用量超额停批）

- 用户批准 `joint-tool-none-XbVP5l` 精确清单和未知费用后，执行前 verify / 未消耗检查通过，18:20:16.403 UTC+8 消耗授权。共 3 次真实派发，均 HTTP 200，工具调用 0；前两次成功，C 未压缩对照的第三次按 `usage_exceeded_reservation` 停批，无第 4 次或重试。
- 第三次实际发送 `max_completion_tokens: 2048` / `tool_choice: none`，返回 completion 93、reasoning 9,016，SDK 与持久台账均为输出 9,109，超过单次预留。原生 SDK 被中止，不能把有 HTTP 200 和 usage 回执当成正常完成。上游参数 / 思考预算映射语义尚未确认，不直接提高额度或忽略 reasoning。
- U 两条完整校准配对；C `not_completed`，处理组与 R `not_run`，摘要请求 0。第三条虽可核对用量，但不合格于完整响应校准，原报告 paired=2 保留。总输入 5,701、SDK 输出 10,379，cache 缺失，参考 / 实际费用未知。
- 另记录严格字符串评分与自由 snake_case 题目的歧义：对照残留 JSON 为 6/10、关键 4/6，goal/card/unresolved 有同义表达风险，next 缺少按需 refresh。仅诊断、不修改分数，不把此失败归因于未发生的压缩。
- 原报告 `review-e8/joint-tool-none-XbVP5l/live/report.json`；独立只读审计 `review-e8/readback-joint-tool-none-XbVP5l/summary.json`。本批 10 项及两个历史批次各 8 项原始证据 SHA 不变，Canon / 验收哨兵 / 来源 v1 不变；recover 0 未结 / 0 新请求 / 禁止重放，执行后 verify 通过且授权已消耗。
- 没有改代码、全局 Pi 或真实小说，没有 Desktop / commit/push。后续先离线核实输出预算和评分契约，再决定是否新清单；不沿用已消耗授权。详见 [真实执行记录](REVIEW_E_JOINT_TOOL_NONE_RESULT.md)。

### E8 代理预算映射与评分契约 v2（2026-09-25，仅离线）

- 已定位到本机 Antigravity Tools 4.7.8 保存的转发参数差异。三条原请求除 `max_completion_tokens`、`store`、`stream_options` 被移除外均匹配；客户端上限 2,048，而保存的上游输出上限为 65,536、思考预算为 16,384。这是代理日志证据，不是抓包或供应商执行语义证明；未直接提高额度。
- 固定 Agent / SDK 捕获验证：off 是省略参数；未声明 reasoning 的模型即使选 low / high 也不发普通 effort；SDK 可以序列化 `max_tokens`，但代理是否接受和约束总输出尚未验证。当前网关控制模式和 Flash high=16,384 只读核对，无全局配置变更或凭据解析。
- 新增独立 `E8-STATE-ENUM-V2` 与 `joint-enum-v2` 离线 profile。题目提供全部备选状态、严格 10 字段 JSON / 枚举 / 布尔 / 重复键检查，保留重读后按需刷新要求；不回填旧分数。授权、启动和 broker 三层拒绝真实模式，原有预算不变。
- 新测试 **16**、原联合 **16**、准备门禁 **33**、单请求 **16**、原离线 **23**，共 **104 组**通过；应用 / 测试类型检查和 diff 检查通过。初轮因题目定位错误的 15/16 证据保留，修正测试而不改生产投影。
- 只读脱敏证据 `review-e8/proxy-budget-audit-20260925/summary.json`；三个历史批次 **8 + 8 + 10** 项证据及 140 项生产 / 既有评测 / 历史题目 SHA 不变。新增真实请求 0，无 Desktop / Rust / 远程 CI / commit/push；联合实测仍未完成。
- 下一步先核实代理版本实现并设计隔离兼容方案，必要时另行准备单请求清单、取得批准后验证，不沿用已消耗授权。详见 [离线核查与回归](REVIEW_E_PROXY_BUDGET_AND_CONTRACT.md)。

### E8 按用户决定沿用上游预算（2026-09-25）

- 用户要求不再研究代理兼容，直接使用现有上游设置。新增隔离 `joint-upstream`：按输出 65,536 + 思考 16,384 保守预留 81,920，保留 24 / 8 次请求、超时、工具与未知用量保护，不改全局配置 / 生产代码。使用枚举契约 v2，旧批次原样保留。
- 新 **9**、旧参数 / 契约 **16**、旧联合 **16**，共 **41 组**和两类类型检查通过。准备与执行前 verify 通过后执行新批次 `joint-upstream-gYx27t`，授权已消耗，执行后 verify / recover 通过，无未结或重放。
- 14 次真实派发全部有完整 usage，14 条配对；U 完成，C 未压缩 / 压缩后各 **10/10、关键 6/6**，2 次原生摘要。摘要审读仍 pending_review，不将恢复答案归因于摘要单独作用。
- R 已观察复用、重验及 v2 重读，但最终答复前被生产扩展的累计工具结果预算阻断。整体 `worker_failed` / 退出 1，不写成全套通过；没有追加请求或放宽这项不同的本地保护。
- 总输入 82,973、SDK 输出 9,207，缓存未知、费用未知。旧证据 26 项与受保护源码 140 项 SHA 不变，真实小说 / 全局配置 / Desktop 未动，未提交推送。下一步仅诊断工具结果预算与体积，再另开批次补测 R。详见 [本轮执行记录](REVIEW_E_UPSTREAM_RESULT.md)。

### E8 工具结果重复计量修复与 R 单独实测（2026-09-25）

- 已复现：预算 / 检查点工具结果返回时计入额度，下一次上下文又将其当历史结果计入一次。生产扩展 v25 用仅当前 run、工具名称 / 调用 ID / 内容绑定的有界宿主回执避免重复计量；新输出仍计入额度，64 KiB 上限、来源校验和完整模型输入估算不变。
- 定向计量 **6**、新 R profile **6**、来源缓存 **7**、读取交付 **47** 通过；完整 Harness **358 × 3**、deterministic=true、失败 0，180 项实现 SHA 核对一致；领域 smoke、两类类型检查通过。见 [修复与验收记录](REVIEW_E_READ_RETEST_RESULT.md)。
- 独立新批 `read-upstream-FuDfJM` 沿用用户接受的上游预算，只运行 R。因旧轨迹 8 次后还需最终答复，新批最多 12 次；实际 **9 请求 / 9 完成 / 9 用量配对**，8 工具无错误，五项读取 / 新鲜度证据通过，退出 0。未重跑 U/C 或摘要，未放宽生产工具结果额度。
- 执行前后 verify / 只读 recover 通过，授权已消耗，0 未结 / 0 重放。输入 101,809、SDK 输出 4,681；缓存未知，费用未知。旧证据 26 项 SHA 不变，没有改真实小说或全局配置，没有 Desktop / Rust / 远程 CI / commit/push。
- 本次修复和 R 补测完成；之前 U/C 与当前 R 是分批、不同源码版本的证据，不能宣称同版本一次联合通过。摘要人工审读仍 pending，兼容校准锚点未命中；不再自动追加付费测试。

### E8 原生摘要本地审读（2026-09-25）

- 助手对既有 C 样本完成十项逐项审读，独立结论为 `completed_with_gap`：摘要 9/10、关键 5/6 明确保留；“正文当前尚未验证”仅被泛化为需要人工检查，不能当成完整状态保留。不是用户验收，也不修改旧报告运行时 pending 状态。
- 核对持久会话、原始请求和最终投影后确认：原生摘要正文在实际 `e8-6` 被固定归档提示替换；三个原始用户约束由 checkpoint 逐字提供，包含缺失状态。因此原对照 / 恢复各 10/10 是完整系统答案，不是自然摘要独立有效的证据。
- 纯本地核对脚本及 [审读报告](REVIEW_E_SUMMARY_CONTENT_REVIEW.md) 已加入；证据 `review-e8/summary-content-review-VVOdpr`，10 项历史文件 SHA、11 项冻结资产和 broker 哈希链通过。新增模型 / HTTP 请求 0，未解析凭据，未改生产策略、真实小说或全局配置，未提交推送。
- 本次局部审读完成；保留缺口和样本限制，不继续为归档摘要追加付费测试。下一步建议先确认提交范围、整理提交，再做固定版本 CI 与更新后的隔离 Desktop 验收；用户批准和通用语义质量不得预填。
