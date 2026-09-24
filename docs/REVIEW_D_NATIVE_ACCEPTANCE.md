# D-07 隔离原生 Desktop 验收

日期：2026-09-24。代码基线：`7f4b68fc281a17dc262b81d5a5e4ea1b453cbb4a` 加本地 D 修改，尚未提交。用户重新允许 computer use 后执行。

后续状态：D 及下文的 Windows 控制台修复已提交推送为 `d66a302`，[CI 36001222669](https://github.com/Smoouns/pi-desktop/actions/runs/36001222669) 的四个双平台任务全部通过。以下保留首次原生验收时的环境和证据边界，不把后续 CI 改写为原生窗口测试。

## 范围与隔离

- 测试目录：`artifacts/harness/native-desktop/d7-lHJMED`；只复制公开的 `fixtures/harness-novel` 为 `project-a` 和 `project-b`，没有打开真实小说。
- 独立窗口 `Pi Desktop - D7 Offline`，应用标识 `com.pi.desktop.d7lhjmed`，数据目录 `%APPDATA%/com.pi.desktop.d7lhjmed`；原用户 Pi Desktop 窗口保持运行，没有替换其配置或关闭它。
- 前端为当前生产构建；Rust `lib.rs` / `session_file.rs` 与仓库一致。测试包仅改变包名、应用标识、窗口标题、fixture-only Tauri 文件权限，以及 `main.rs` 的隔离 agent / 网络保护启动环境。不是安装包验收，也不是重新实现 Rust RPC。
- `pi-offline.cmd` 经生产 Windows npm shim 解析分支启动固定 Pi SDK **0.63.1** CLI，加载完整当前生产扩展 v18（生成内容 SHA `78dc8e71c23ef13d151d187d8eb74b635fdc4880dd05268e5ff3e651c0f037d1`）。替换的只是 provider：确定性合成响应，仍执行真实 final-payload、SDK 文件工具、扩展 guard / supervisor 和 TS 验证器。
- 独立 agent 空 auth、强制 synthetic provider、禁用 home 扩展 / skills / shell / 额外会话命名调用；RPC 和验证器进程启用网络保护。原生进程继承环境，不冒充 D-01–06 的白名单环境或 OS 沙箱。Desktop 的 CLI 更新查询仍存在，不宣称整个应用完全无网络。

## 实际窗口观察

| 步骤 | 观察与交叉证据 |
| --- | --- |
| A 普通只读请求 | 原生输入框发送 `D7-READ`，显示 `read canon/world.md` 的 1–3 行工具结果及最终回复；状态为“回复已结束”，详情为 `UNBOUND_REPLY`，不冒充文件交付。 |
| A 停止 | `D7-CANCEL` 等待期间点停止，显示“已取消”。磁盘记录为 `CANCELLED / AGENT_ABORTED`，该轮工具调用 0。 |
| A 章节工作流 | 从第 002 章验收面板点“交给写作智能体重新验证”，自动切换写作会话并预填任务。追加离线测试限定后发送，实际读章节卡并调用 `verify_chapter`。 |
| A 验证与状态详情 | TS 验证器生成 PASS，章节面板刷新，聊天状态为“候选任务已完成”；详情明确 `STOP_VERIFIED` 仍需人工验收。合同角色 write，唯一交付目标为当前正文的 chapter-full 验证，没有提升 Canon。 |
| 会话状态缺陷 | 首次返回旧标签后状态栏消失，但磁盘 CANCELLED / STOP_VERIFIED 仍在。定位为共享投影清空后，缺少所属 runtime 的恢复来源。 |
| 修复后的冷恢复 | 关闭隔离窗口、重建当前前端及测试包、重开。已取消会话恢复“已取消”，写作会话恢复“候选任务已完成”；往返切换保持各自状态。 |
| 项目隔离 | 新开 B 时无 A 的状态；发送 B 只读请求后显示 project-b 的回复，合同 projectId / sessionId 与 A 不同。返回 A 写作 / 普通会话分别恢复完成 / 取消。 |
| 收尾 | 通过原生关闭按钮关闭隔离窗口，原用户 Pi Desktop 窗口仍在。没有删除任何测试副本或私有应用数据。 |

上述可见性是 computer-use 直接观察，不是由日志脚本推定。会话文件仍含模型需要的上下文索引；原生用户气泡未显示隐藏控制标签。并未以“模型真的理解上下文”作为验收结论。

## 回读证据

`setup.json` 保留首次构建与文件指纹，不覆盖。`native-audit.mjs` 在新的 `audits/check-*` 目录输出回读结果，核验生产扩展 / provider、Rust、最新前端与源码 SHA，以及会话和文件：

- 4 次用户发送，3 个磁盘会话，8 次离线合成 provider 调用，真实模型调用 **0**。
- 工具回执为 3 次原生 read、1 次真实 verify_chapter；没有 write/edit 调用。完整原生写入/冷恢复组合另由 D-01–06 SDK 套件覆盖，不把本次仅验证现有正文称为原生写稿验收。
- A 初始目标在取消追加指令后仍保持；写作合同固定正文路径、章节号和完整验证；三会话最新任务及终态与运行结束时一致，全部 `userAccepted=false`。
- `2026-09-24T12:13:00Z` 之后 A 的重新启动 / 切换进程仅有 boot 记录，没有新增 input / provider / tool / verifier；B 只有明确发送产生的两次合成响应。
- 仓库 fixture 与两份副本的 **17 个原有文件逐一 SHA-256 不变**，全局 `.pi/agent/extensions` 文件清单和 SHA 不变。
- 初始化时 A/B 各新增 `.novel/tools/verify-novel-chapter.ts`；运行只在 A 新增 `planning/verifications/002-verification.md`。正文、Canon、原人工验收记录没有改写。

首份回读：`audits/check-kNaH6W/summary.json`；增加合成 provider 字节核验后的最终回读：`audits/check-C1O5BV/summary.json`。两者均通过，旧证据不覆盖。

## 本轮修复与回归

`RuntimeStatusCache` 隶属 workspace/tab runtime，仅缓存有界的 setStatus 展示数据。后台事件仍更新原所有者；激活时重新投影；新进程、项目、角色、会话切换前清空。不缓存标题 / 预算控制消息，也不回放弹窗、通知、编辑器命令或 RPC 响应。

- 应用及 Harness TypeScript 检查通过。
- Harness **285 例 × 3**，结果一致、失败 0；新增 A/B 所有权、后台更新、重启清空、容量边界回归。
- `test-extension-status-ui.mjs` 实际浏览器 DOM 回归通过：窄面板 280 / 360 / 430 px，A/B 状态及详情恢复、空状态清除且不伪造 RPC 响应。
- 当前前端与隔离原生二进制构建通过；保留已有 bundle/import 和 Rust warning。
- 完整 SDK 生命周期再次通过 **8 组 / 15 进程**，报告 `artifacts/harness/production-lifecycle/d-DTjD9t/summary.json`。

## 未覆盖与待办

- 首次原生验收时未 commit / push；后续 D 固定代码提交与 CI 状态见本文开头及 `REVIEW_RESOLUTION.md`。E 优化和真实模型实验未启动。
- 启动部分 RPC 子进程会偶发空白控制台遮挡窗口；本次窗口验收仅记录，后续同日已按下面的独立进程证据修复。不改写首次验收的源码指纹。
- 为防止修改全局主题 / 扩展，隔离包拒绝访问 home 安装位置，主题表现与正常包不同；不声称主题、全局安装器、通知权限或更新流程通过。
- 没有对真实模型的语义规划、压缩质量或所有并发竞态作承诺；实际人工验收与 Canon 晋升仍是独立操作。

## 后续：Windows 空白控制台（2026-09-24）

用户同意后，补上 npm shim 解析成功早返回分支的 `CREATE_NO_WINDOW`。新增 `src-tauri/src/windows_process_tests.rs`，无控制台的父进程通过生产 command builder 启动本地 Node 夹具，在子进程内查询 `GetConsoleWindow`。修复前精确失败 `consoleAttached=true`；修复后 RPC / 普通 CLI 共 8 条路径无控制台，参数、环境和管道仍正确。Rust 11 项本地测试通过；CI 已要求 Windows 实际执行这 2 项测试。测试使用现有锁文件中的 Koffi，不引入新产品依赖。

这不是重复 D-07 窗口验收，也不重新运行上述旧目录的 SHA 审计。另发现非标准 batch 的含空格绝对入口路径引号问题，尚未修复；新 fallback 控制台测试使用相对入口，未将该引号问题算作通过。详见 `REVIEW_RESOLUTION.md` 的后续记录。
