# 87b4ac8 审查整改清单

审查基线：`87b4ac8e009e36471a9530ce3918f2a2b360d1f1`。审查日期：2026-09-23。

首批范围：A 批次（Windows Pilot 路径诊断、测试环境修复及直接回归），以及 B1/B2 的复现用例。随后分别提交推送 A、B1 并验证双平台 CI，再进入 B2 读取交付凭证修复。B2 当前为本地改动，C 任务完成合同仍未实施；不调用真实模型，不改真实小说、全局 Pi 配置或历史验收报告。

## 关闭标准

每项必须具备：复现或反证、最小修复、直接回归、剩余边界。`confirmed` 不等于 `fixed`；本地通过不等于远程 CI 或 Desktop 验收通过。冻结实验批次与版本化验收报告保持不变；新增审查复现 / SDK 评测使用独立输出。常规 Harness 的固定文件名汇总沿用原脚本机制，仅代表最近一次回归。

| ID | 状态 | 本轮动作 / 后续计划 | 证据与限制 |
| --- | --- | --- | --- |
| AUD-01 | fixed / CI_passed | 新增拒绝原因枚举；仅规范化隔离测试子进程的临时根；补路径正反例与 Windows 短路径回归 | `f472e8d` 双平台 CI 全绿；Windows 8.3 用例实际执行，journal=11、unsupported=[]。原失败 CI 未输出具体拒绝分支，仍不冒充已确认其唯一根因 |
| AUD-02 | fixed / CI_passed | B1：区分历史完成、当前后置状态和派发许可；终态不复活；完整扩展与三进程冷恢复回归 | `c67467e` 双平台 CI 全绿；新、旧 toolCallId 均核验当前 post-image；历史 A、当前 B 返回冲突且不重放 |
| AUD-03 | fixed_locally / not_committed | B2：按真实 SDK 返回内容映射行范围，并单独记录交付凭证；分页只累计已交付内容；旧凭证需重读 | 原 5 个 B2 红灯全部转绿，独立审查合同 10/10；新增局部页、旧会话、预算拒绝、ABA 改版等回归。尚无本批远程 CI / Desktop 验收 |
| AUD-04 | deferred | C：工作流绑定稳定 taskId、任务类型、目标产物及完成条件 | 需显式版本化持久化 schema 与旧会话兼容策略 |
| AUD-05 | deferred | C 中保留必需任务恢复信息，E 中测量压缩质量 | 不将进度摘要当作 Canon |
| AUD-06 | in_progress | D 随 B/C 补完整生产接线回归 | 复现优先复用完整扩展、固定 SDK 与隔离 fixture；不声称已有完整 Desktop/冷恢复验收 |
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

## B2：读取捕获与实际交付（本地修复）

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

下一步：提交 B2 并验证其固定提交的双平台 CI，再进入 C 稳定 TaskContract。
