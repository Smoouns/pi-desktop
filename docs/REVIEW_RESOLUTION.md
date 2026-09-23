# 87b4ac8 审查整改清单

审查基线：`87b4ac8e009e36471a9530ce3918f2a2b360d1f1`。审查日期：2026-09-23。

本轮授权范围：A 批次（Windows Pilot 路径诊断、测试环境修复及直接回归），以及 B1/B2 的复现用例。暂不修改生产写入状态、读取凭证或任务完成合同；不调用真实模型，不改真实小说、全局 Pi 配置或历史验收报告。

## 关闭标准

每项必须具备：复现或反证、最小修复、直接回归、剩余边界。`confirmed` 不等于 `fixed`；本地通过不等于远程 CI 或 Desktop 验收通过。冻结实验批次与版本化验收报告保持不变；新增审查复现 / SDK 评测使用独立输出。常规 Harness 的固定文件名汇总沿用原脚本机制，仅代表最近一次回归。

| ID | 状态 | 本轮动作 / 后续计划 | 证据与限制 |
| --- | --- | --- | --- |
| AUD-01 | fixed_locally / CI_pending | 新增拒绝原因枚举；仅规范化隔离测试子进程的临时根；补路径正反例与 Windows 短路径回归 | 本机短路径条件下修复前失败、修复后通过；原 CI 的具体拒绝分支及修复提交双平台 CI 仍待确认 |
| AUD-02 | confirmed / not_fixed | B1：完整扩展 + 原生 write/read，复现历史完成 A → 外部改为 B → 重读刷新 → 再请求 A | 新、旧 toolCallId 两例均错误声称 satisfied；目标仍为 B。本轮生产写入逻辑保持不变 |
| AUD-03 | confirmed / not_fixed | B2：固定 SDK 原生 read 的范围、截断、预览与刷新复现 | LF/CRLF、无正文交付、隐藏尾部、无关片段刷新共五例违反合同；生产读取凭证逻辑保持不变 |
| AUD-04 | deferred | C：工作流绑定稳定 taskId、任务类型、目标产物及完成条件 | 需显式版本化持久化 schema 与旧会话兼容策略 |
| AUD-05 | deferred | C 中保留必需任务恢复信息，E 中测量压缩质量 | 不将进度摘要当作 Canon |
| AUD-06 | in_progress | D 随 B/C 补完整生产接线回归 | 复现优先复用完整扩展、固定 SDK 与隔离 fixture；不声称已有完整 Desktop/冷恢复验收 |
| AUD-07 | deferred | E：分层计量预算估算、provider usage 和 HTTP 派发 | 不把 eval 单请求限制复制到生产重试策略 |
| AUD-08 | deferred | E：先测量物理读取和逻辑引用，再考虑请求内缓存 | 最终写入仍须核验版本 |
| AUD-09 | deferred | 需求出现后再决定是否持久化 Observation | 本轮不加数据库、向量检索或新 agent loop |
| AUD-10 | deferred | E：按任务相关证据判断有效进展 | 保留硬上限，不引入模型裁判 |

## 执行记录

- 原始本地基线：`npm run test:pilot` 通过（journal=7；rehearsal=2/2；broker dry-run=pass；真实模型请求=0）。这不是对原 Windows CI 根因的动态确认。
- 修复提交 / 新 CI：尚未提交、推送或触发远程 CI。
- 远程验收门槛：固定修复提交上的 Windows/Node 24 与 Ubuntu/Node 22 必需检查实际执行并通过，未经说明的 skipped 不算通过。

后续记录将在实际执行后追加，不预填通过结果。

## A 批次：路径修正

- 受控复现：`scripts/test-pilot-journal-windows.ps1` 使用 Win32 `GetShortPathName` 获取新建临时目录的真实 8.3 别名，只在该脚本进程内设置 TEMP/TMP。原代码退出 1，错误为 `JOURNAL_DIRECTORY_UNSAFE`；修复后完整 Pilot 测试退出 0。
- 修复位置：`scripts/run-pilot-evals.mjs` 在 **test 模式**为隔离子进程设置经过 realpath/lstat 核验的临时根。未更改父进程、用户或系统环境变量；未修改全局 Pi 设置。
- 生产边界：journal 创建仍要求严格 canonical path，不以转小写或删除检查放行别名 / 链接。新增 `NOT_DIRECTORY`、`LINK`、`NON_CANONICAL_PATH` 枚举；错误码和 journal 文件 schema 不变，诊断不打印原始路径。
- 直接回归：普通 journal 持久化 / 排他 claim / 预算 / 篡改 / 写入失败测试保留；新增中文空格目录、非目录以及 symlink/junction 叶子和父路径负例。本机 journal=11，unsupported=[]。不支持链接或 8.3 的平台必须明确显示 unsupported，不计作通过。
- `.github/workflows/ci.yml` 已加入 Windows 短 TEMP 回归；未触发远程运行，不能宣布原 CI 已转绿。
- 剩余边界：不是任意并发文件系统替换 / reparse point 类型的安全审计；本轮没有扩展 journal 恢复端的原有路径策略。

## B1/B2：独立红灯复现

运行：`npm run test:review-repros`。

这不是正常回归套件中的“已知失败算通过”：仍有合同违反时退出 **1**，工装或对照出错时退出 **2**，只有合同全部满足才退出 **0**。下一批修复应使这些合同转绿，并将相应场景纳入常规回归。

本机最新证据：`artifacts/harness/review-repros/review-gKTJNL/summary.json`。共 10 例：7 个确认违反合同，3 个对照通过，工装错误 0。证据保存当前源码 SHA-256、HEAD/dirty、SDK/Node 版本和逐例观察；每次运行新建目录。

| 类别 | 实际观察 |
| --- | --- |
| AUD-02 / 新与旧调用 ID | 当前文件为 B，但再次请求 A 得到 satisfied；复现没有派发第二次写入 |
| AUD-03 / LF 与 CRLF | 原生 read 只交付第 2 行，checkpoint 却登记第 1–4 行 |
| AUD-03 / 单行超长 | SDK 只返回大小超限提示，仍登记来源已读凭证 |
| AUD-03 / 截断 + 预览 | SDK 截断至 2000 行，扩展预览本次仅交付 38 个完整行，凭证仍覆盖完整 2300 行 |
| AUD-03 / 无关重读 | 第 8–9 行依赖变化后，只读第 1 行再 refresh，状态错误恢复 ready |
| 对照 | 当前字节确实满足时防重复写有效；相关范围重读可刷新；读取与交付之间版本变化仍拒绝记录凭证 |

覆盖边界：完整生产扩展、真实 SDK 原生 read/write、ExtensionRunner 和真实临时文件；session manager 为工装替身。未调用模型、未进行 Desktop 或冷重启组合验收，也未完成 AUD-06 的突变测试。仓库 fixture 的前后哈希一致，真实小说未触碰。

## 本地回归（Windows / Node 24.19.0）

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
