# 87b4ac8 审查整改清单

审查基线：`87b4ac8e009e36471a9530ce3918f2a2b360d1f1`。审查日期：2026-09-23。

首批范围：A 批次（Windows Pilot 路径诊断、测试环境修复及直接回归），以及 B1/B2 的复现用例。随后分别提交推送 A、B1、B2 并验证双平台 CI，再进入 C 稳定任务目标与完成合同。C 及其两项 CI 工装修正已提交推送，固定代码提交 `e9f7d69` 的双平台 CI 已通过。D 的完整生产 SDK 生命周期、冷恢复与隔离原生 Desktop 接线现已本地通过，并连同 Windows 控制台修复提交推送为 `d66a302`；该固定提交的四个双平台 CI 任务全部通过。E 优化未开展。不调用真实模型，不改真实小说、全局 Pi 配置或历史验收报告。

## 关闭标准

每项必须具备：复现或反证、最小修复、直接回归、剩余边界。`confirmed` 不等于 `fixed`；本地通过不等于远程 CI 或 Desktop 验收通过。冻结实验批次与版本化验收报告保持不变；新增审查复现 / SDK 评测使用独立输出。常规 Harness 的固定文件名汇总沿用原脚本机制，仅代表最近一次回归。

| ID | 状态 | 本轮动作 / 后续计划 | 证据与限制 |
| --- | --- | --- | --- |
| AUD-01 | fixed / CI_passed | 新增拒绝原因枚举；仅规范化隔离测试子进程的临时根；补路径正反例与 Windows 短路径回归 | `f472e8d` 双平台 CI 全绿；Windows 8.3 用例实际执行，journal=11、unsupported=[]。原失败 CI 未输出具体拒绝分支，仍不冒充已确认其唯一根因 |
| AUD-02 | fixed / CI_passed | B1：区分历史完成、当前后置状态和派发许可；终态不复活；完整扩展与三进程冷恢复回归 | `c67467e` 双平台 CI 全绿；新、旧 toolCallId 均核验当前 post-image；历史 A、当前 B 返回冲突且不重放 |
| AUD-03 | fixed / CI_passed | B2：按真实 SDK 返回内容映射行范围，并单独记录交付凭证；分页只累计已交付内容；旧凭证需重读 | `f1b19df` 双平台 CI 全绿；263 例 × 3 实际执行。没有本批 Desktop 验收 |
| AUD-04 | fixed / CI_passed | C：版本化 TaskContract 绑定稳定 taskId、原始目标、最新指令、预期产物及当前版本完成凭证 | C 的 `e9f7d69` 双平台 CI 全绿；D 的 `d66a302` 又通过完整 SDK 压缩 / 冷恢复及双平台 CI，隔离原生 Desktop 任务提交单独本地验收 |
| AUD-05 | partially_addressed | C 保留任务目标、约束、产物与验证凭证，E 再测量压缩质量 | 这是必需恢复信息，不是通用规划器或语义进度摘要；不将其当作 Canon |
| AUD-06 | fixed / CI_passed | D 补完整生产接线、冷恢复与来源版本定向突变回归；D-07 补隔离原生窗口验收 | `d66a302` 双平台实际通过 SDK 8 组 / 15 进程、Harness 285 例 × 3；隔离原生 UI → Rust RPC → 固定 CLI → 完整扩展另经本地验收。不是安装包或真实模型验收 |
| AUD-07 | deferred | E：分层计量预算估算、provider usage 和 HTTP 派发 | 不把 eval 单请求限制复制到生产重试策略 |
| AUD-08 | deferred | E：先测量物理读取和逻辑引用，再考虑请求内缓存 | 最终写入仍须核验版本 |
| AUD-09 | deferred | 需求出现后再决定是否持久化 Observation | 本轮不加数据库、向量检索或新 agent loop |
| AUD-10 | deferred | E：按任务相关证据判断有效进展 | 保留硬上限，不引入模型裁判 |

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
