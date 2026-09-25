# E 批次提交与固定版本验收

日期：2026-09-25。生产代码提交 `684769f69280df18990d209bb77526c0c7b58eb7`；原生验收工装修正 `c974480d5cfb29f9f55ddd70adc55251009144c7`；三轮 Harness 总时限修正 `9eace1fb8ab4b1bd6916f1f0d08ce9de78454625`；冻结 S4 工厂接线修正 `5f92cd341fb51efe21bb3ab257fe05c1969d92fc`。后三次只改测试工具，不改生产前端、Rust 或扩展。

本次提交 E1–E8 的实现、测试与证据说明，不提交根目录三份用户规划/研究原稿、`artifacts/`、本机认证或真实小说。原失败批次不删除、不改成通过；旧文档的本地/未提交表述是当时记录，最新版本状态以本页为准。

## 本地直接检查

- 应用 TypeScript、Harness TypeScript、前端构建通过，保留已有 bundle/import 警告。
- Rust `--lib` 11 项通过；Windows 两项命令构造回归各执行 7 条子进程路径。保留已有 unused-variable 警告。
- 完整生产 SDK 生命周期 13 组 / 24 个子进程阶段通过：`artifacts/harness/production-lifecycle/d-PKGOd6/summary.json`。
- 固定 SDK 发送层 15 例 / 33 次受控 loopback HTTP 通过，serverFailures=0：`artifacts/harness/task-transport/e4-vWuAZF/summary.json`。
- 上述两个检查在提交前执行，原始报告中的 HEAD/dirty 不改写为提交后状态；固定提交的双平台 CI 单独记录。
- S4 冻结工厂修正后，Harness TypeScript、S4 离线 190 项、S4 live 工装 153 项、只读证据报告 199 项 / 11 族投影、聊天面板 15 例通过。S4 live 在此指合成测试，不是付费模型试验；全部新增检查真实模型调用 0。离线实验的 27 个 pass / 18 个预期 fail 对照保持原样，不能写成 45 个产品通过。

## 原生 Desktop：实际观察与独立回读

使用 computer-use 技能，只操作单独的 `Pi Desktop - D7 Offline` 窗口。当前前端、Rust bridge、固定 Pi 0.63.1 CLI 和完整生产扩展不替换；合成 provider、独立 app identifier/bootstrap、fixture-only 文件权限及隔离 agent 目录属于测试配置，不是生产安装包。

成功批次：`artifacts/harness/native-desktop/d7-Unlg0T`。冷重启时间 `2026-09-25T13:06:31.127Z`。只读回核：`audits/check-o1Yko1/summary.json`，`passed=true`，HEAD=`9eace1f`。`dirty=true` 来自三份未跟踪的用户原稿；当时 tracked 工作树无改动。报告保留生产源码、扩展、前端和样本文件的 SHA-256。

| 检查 | 实际观察 / 回读 |
| --- | --- |
| A 普通读取 | 原生 `read` 返回世界观第 1–3 行；界面显示“回复已结束”，持久化 `UNBOUND_REPLY`，不绑定文件交付 |
| A 停止 | 等待阶段点击桌面停止按钮，界面显示“已取消”；持久化 `CANCELLED / AGENT_ABORTED`，本轮工具数 0 |
| A 工作流验证 | 从章节 002 的“交给写作智能体重新验证”按钮进入写作会话；保留预填合同，补充受控只读指令；实际读取章节卡并执行 `verify_chapter` 完整验证 |
| 候选与人工边界 | 报告 `PASS`，界面“候选任务已完成”；详情 `STOP_VERIFIED` 明确不是人工验收或正典晋升；全部 `userAccepted=false` |
| E 请求计量弹窗 | `/novel-transport-status` 打开只读弹窗，正常换行、可用 Esc 关闭；普通请求 3、摘要 0、SDK 合成 tokens 360、未结 0、费用未知。合成 provider 不走 HTTP，所以发送层记录缺少 3 条，未冒充服务器计费 |
| 冷恢复 | 重开后写作会话恢复候选完成，普通会话恢复取消；A 重启后 6 次进程 boot，没有新的 input、provider 或工具事件 |
| 项目隔离 | B 就绪时没有 A 的终态；B 独立读取后显示回复结束；返回 A 的两个会话，各自恢复原状态 |

回核总计：4 个明确用户请求、3 个会话、8 次合成 provider 调用、1 次取消、3 次原生 read + 1 次 verify_chapter，工具错误 0，真实模型调用 0，受保护 RPC 网络尝试 0。计量查询命令不增加模型输入或调用。A/B 各 17 个原样本文件字节不变；新增各自验证器及 A 的机械报告。全局 Pi 扩展哈希未变；没有人工验收、Canon 晋升或正文改写。结束时测试窗口已关闭，数据保留供回看。

### 未通过尝试及显示边界

- 旧工装批次 `d7-OpjM5E` 保留：只读成功，但 CANCEL 直接回复。原因是工装把最后一条 LLM `user` 消息当成当前输入；Pi 会将新增的 custom 历史进展也投影为 `user`。`c974480` 改为从真实 `input` 事件选择合成剧本，并检查触发词确实进入模型上下文。生产请求处理未改变，未放宽最终精确计数审计。
- **加载过渡仍有显示瑕疵**：切换到 B 的 `Loading session…` 期间短暂显示 A 的“已取消”；从 B 返回 A 普通会话时也曾暂显“回复已结束”。就绪后均恢复正确，持久化合同与终态没有串用、没有重放。本轮不将过渡 UI 算作完美通过；后续应清空或遮蔽绑定切换期间的旧状态，并补切换中间态 UI 回归。
- 隔离包禁止写入全局主题/扩展，左栏与聊天区主题不一致；这不是生产主题、安装器、更新或通知权限的验收。Desktop 辅助版本查询不声称网络隔离。
- 原生回读脚本不能证明 UI 可见性，上表窗口观察与脚本证据分列；不是对所有并发时序、真实模型质量或真实小说长程创作的保证。

### 下一步：只处理切换期间的状态投影

先复现 `src/main.ts` 的 `syncActiveChatRuntimeBinding` / runtime 缓存恢复与 `chat-view.ts` 的加载投影时序，再实施最小 UI 修复；当前仅有现象和检查入口，尚未确认唯一根因。本批没有提前更改这些生产代码。

- 为普通会话、写作会话、项目 A/B、冷启动与快速连续切换建立可控延迟场景；检查加载中间态，而不只检查最终画面。
- 目标会话身份确认前，不展示属于上一绑定的任务终态；迟到回调不能把旧状态重新投影到新页面，同时保留已确认目标会话的正确缓存和后台任务。
- 就绪后准确恢复目标会话自己的终态；核对不新增模型请求、不重放工具、不改任务合同、验收状态或持久化记录。用回归与隔离原生窗口观察分别提供证据。

## 固定提交 CI

`c974480` 的 [CI 36138151516](https://github.com/Smoouns/pi-desktop/actions/runs/36138151516) Windows Harness 在 `360,000 ms` 外层截止时被终止，之前输出 1,073 条 PASS，无 AssertionError。后续步骤被跳过，因此该运行不算通过。只把三轮套件外层期限提高到有界 `600,000 ms`；所有逐项断言、工具期限、三轮重复和其他模式期限保持不变，不加入自动重试。

首轮 `684769f` 的 [CI 36137445209](https://github.com/Smoouns/pi-desktop/actions/runs/36137445209) 两平台均在冻结 S4 阶段报 `S4_FACTORY_DRIFT`。同一失败已在本地复现：旧评测本应使用原版本，却仍直接导入当前生产 `context-maintenance`。`5f92cd3` 将其改为原提交 `a50e794e78466d77834c5d5a873e05fe113608ac` 的完整快照；规范化 LF 后 SHA-256 保持原登记值 `2d3c44d2fbc46cd2a85bb45682b76bbc4d8f917f862b5f7585147ec463597492`，并逐字节比对原 Git blob。原 provenance、期望指纹和历史结果不改写。新增构建图断言拒绝偷偷引用生产裁剪实现，离线构建仅允许 `evals/` 和 `tests/` 输入。

修正总时限但尚未包含 S4 快照修复的 [CI 36139078264](https://github.com/Smoouns/pi-desktop/actions/runs/36139078264) 两平台都已实际完成 358 例 × 3、`deterministic=true / failures=false`，随后在同一 `S4_FACTORY_DRIFT` 拒绝；该失败仍单独保留，不将中间版本当作最终通过。

最终固定代码 `5f92cd341fb51efe21bb3ab257fe05c1969d92fc` 的 [CI 36140866214](https://github.com/Smoouns/pi-desktop/actions/runs/36140866214) 已于 `2026-09-25T13:55:17Z` 完成，四个任务全部 `success`。回读 run 的 `head_sha`、四个 job 的全部步骤及最终日志，不依赖仅绿色图标的判断。

| 任务 | Job ID | 结果 |
| --- | --- | --- |
| Public harness：Ubuntu 22.04 / Node 22 | `108090080229` | 通过 |
| Public harness：Windows / Node 24 | `108090080919` | 通过 |
| TypeScript + Rust：Ubuntu 22.04 | `108090080572` | 通过 |
| TypeScript + Rust：Windows | `108090080562` | 通过 |

- 两平台日志均确认 Harness 358 例 × 3、`deterministic=true / failures=false`；长程回归 1 例 × 3、真实模型调用 0；完整生产生命周期 13 组 / 24 个子进程阶段；发送层 15 例，全部实际执行通过。
- 后续小说域、评测自检和完整 SDK 链均实际执行；冻结 S4 离线 190 项、S4 live 工装 153 项、证据报告 199 项、聊天面板 15 例及前端构建通过。冻结实验的预期负例仍保留，不把其数量并入生产成功数。
- Windows 两次 Pilot journal 均为 11 项、`unsupported=[]`，`journal.windows-short-temp` 实际通过；Ubuntu journal 为 10 项、`unsupported=[]`。Windows Rust 控制台两项回归实际执行通过。
- 所有 skipped 均为平台条件：Ubuntu 的 Windows 短路径及 Windows 控制台步骤、Windows 的 Linux 系统依赖安装。没有必需检查被意外跳过。
- CI 未重新进行原生窗口观察；该证据来自上面的本机隔离批次。`git diff 9eace1f 5f92cd3 -- src src-tauri` 为空，原生验收后的修正仅属测试工具。后续验收文档为单独 `[skip ci]` 提交，CI 结论绑定此处代码 SHA，不冒充文档提交重新运行了测试。

## E 的剩余证据边界

提交和机械回归通过不代表整个 E 语义目标完成。既有真实 U/C 与独立 R 补测属于不同版本/批次；摘要显式保留 9/10、关键 5/6，“正文尚未验证”仍靠结构化检查点保留。兼容计量锚点未命中，cache 大小未知时费用仍未知；通用语义进展和真实小说长程质量未验证。用户已决定继续使用上游参数，本轮不再花真实模型请求调预算。
