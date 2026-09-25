# 会话切换状态投影修复与验收

日期：2026-09-25。基线 `ac4f942a88e34060eec3adf6022c83bcc41e5e79`；本页记录其后的本地工作树修复，尚未提交、推送或执行本批远程 CI。上一批记录见 [E 固定版本验收](REVIEW_E_FIXED_ACCEPTANCE.md)，其中旧状态闪现的失败观察保留不改写。

范围仅为切换项目、会话或职能时的状态展示；不修改任务合同、权限、预算、机械验证、人工验收、Canon 晋升或持久化格式。

## 根因与最小修复

`src/main.ts` 的 runtime 按 workspace/tab 缓存，但一个 tab 会被复用到另一个项目、会话或职能。导航先更新 tab 的目标，再排队执行后台切换；原 `syncActiveChatRuntimeBinding` 只凭 tab key 就重新绑定旧 bridge 并恢复旧状态缓存。即使先清空，后续 restore 和旧 bridge 的迟到事件仍可再次显示旧终态。聊天组件也没有在历史加载期间隐藏状态条。

- 新增就绪归属检查：runtime 必须 ready、bridge 已连接，且规范化后的项目路径、会话路径和职能均匹配当前 tab，才允许绑定和恢复缓存。
- 身份未确认时只断开当前界面的 bridge 订阅，不停止后台进程、不删除其状态缓存；后台状态仍由原 runtime 保存。
- `ChatView` 在 `bindingStatusText` 非空时不渲染扩展状态条。已确认目标的状态可以先缓存，历史加载结束后再展示，避免丢掉启动早期的合法状态事件。

生产文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `src/main.ts` | `f40c84f4f9638b16ba4959f37de7459fcae4920b8f73fc16adcab8b1eaf5347e` |
| `src/components/chat-view.ts` | `26421cb527a5b0dca8e93693192d71501fc2bcbb484f799ea1577ab69050733c` |

## 复现与自动回归

`tests/harness/session-status-binding.ts` 从实际 `main.ts` 提取函数声明并编译执行，不在测试内重写导航分支；外围 UI/bridge 是记录器，因此它是受控时序回归，不冒充原生桌面测试。

- 旧代码：8 个场景中 6 个失败，证据 `artifacts/harness/session-status-binding/check-TVO1Xk/summary.json`；原 main SHA 为 `04459bc9177bfae300973bac5d3589db83377d3375bf3f9a4992b02d61b2c52a`。
- 修复后：`npm run test:session-status-binding`，8/8 通过，RPC 与模型请求均为 0；证据 `artifacts/harness/session-status-binding/check-ld9kBp/summary.json`。
- 场景覆盖：同 tab 跨项目、同项目跨会话、职能改变、冷启动/未就绪、A/B/A 后台状态、空白草稿/断线、快速 A→B→C、Windows 路径规范化与正确缓存恢复。迟到状态保留在原 runtime，不能重投影到新目标。
- `npm run test:extension-status-ui` 导入真实 `ChatView`，新增 5 项加载期检查，在两个浏览器窗口通过；实际 viewport 为 682/982 px，原有聊天面板 280/360/430 px 布局与弹窗关闭检查仍通过。证据 `artifacts/harness/extension-status-ui/check-Kphoms/summary.json`。
- 旧聊天组件在“目标状态到达但历史仍在加载”断言失败，证据目录 `check-KW3A4w` 保留。首次修复后 UI 工装另因 IIFE 下 `import.meta.url` 无效而失败（`check-pX7Uaf`）；采用既有 UI 工装的 URL 定义方式修正测试入口，再完整重跑，不修改产品资产逻辑或放宽断言。
- `npm run test:harness`：366 例 × 3，`deterministic=true`，失败 0、unsupported 0、真实模型调用 0。`artifacts/harness/summary.json` 保留本次生产与测试源码 SHA；该常规汇总路径沿用既有机制，后续运行会更新。
- 应用与 Harness TypeScript 检查通过；前端构建通过，保留既有 bundle/import 警告。隔离 Tauri 离线构建通过，Rust 生产代码未改。

定向测试与 UI 测试使用新的 `check-*` 目录，不覆盖此前失败结果；新增导航用例已并入常规三轮 Harness。

## 原生 Desktop 观察

使用 computer-use 技能，仅操作隔离的 `Pi Desktop - D7 Offline` 窗口。批次 `artifacts/harness/native-desktop/d7-wBZ41o` 使用当前生产前端、Rust bridge、固定 Pi 0.63.1 与完整生产扩展；合成 provider、独立 app identifier/agent 目录和 fixture-only 权限属于测试配置。

| 实际操作 | 加载阶段观察 | 就绪后观察 |
| --- | --- | --- |
| A 普通会话读取后停止下一轮 | 不涉及切换 | 显示“已取消” |
| 从章节 002 重新验证入口进入写作会话 | `Starting new session…`，无普通会话“已取消”状态条 | 保留预填合同；只运行 read + verify_chapter，PASS 后显示“候选任务已完成” |
| 关闭并冷启动，再从写作切普通 | `Loading session…`，无写作的候选完成状态条 | 普通会话恢复“已取消” |
| A 普通会话打开新项目 B | `Starting new session…`，无 A 的状态条 | B 空白会话无终态；明确发送 D7-READ 后显示自己的“回复已结束” |
| B 返回 A 普通会话 | `Loading session…`，无 B 的回复结束状态条 | 恢复 A 的“已取消” |
| A 普通切回 A 写作会话 | `Loading session…`，无普通会话的取消状态条 | 恢复写作会话“候选任务已完成” |

加载中间态和终态都实际观察；不只以最后画面或持久化记录替代加载阶段检查。原生自动化的 accessibility 快照部分滞后，画面与回读分别核对；没有把未提交的输入计作请求。结束时已关闭隔离测试窗口。

## 独立回读与边界

冷启动时间 `2026-09-25T14:25:17.120Z`。`native-audit.mjs` 结果：`artifacts/harness/native-desktop/d7-wBZ41o/audits/check-HNrort/summary.json`，`passed=true`。

- 精确 4 个用户输入、3 个会话、8 次本地合成 provider 调用、1 次取消、3 次原生 read + 1 次 verify_chapter；工具错误 0，真实模型调用 0，受保护 RPC 网络尝试 0。
- A 重启后记录 7 次 boot，没有新的 input、provider 或工具事件；任务合同与各自终态未被恢复操作改写，也没有重放任务。
- A/B 各 17 个原样本文件的字节不变；仅新增各自的验证器及 A 的机械报告。公开源 fixture 和全局 Pi 扩展哈希不变，未操作真实小说、人工验收或 Canon 晋升。
- 回读脚本不能证明 UI 可见性，上节是另行记录的窗口观察。合成 provider 不证明真实模型质量；隔离包不证明生产安装、主题、更新功能。Desktop 辅助版本查询不声称网络隔离。
- 本批没有新的远程 CI 或提交结论，也不关闭 E 中仍保留的真实模型摘要质量、兼容计量与真实小说长程质量边界。
