# Phase 1 — Reliable Tool & Session Runtime

起点：`314120c2b3c9eb9d373b4c1b9a5942f4dbf45edf`。用户先授权本地实施，随后于 2026-09-21 授权修复两项实机观察并提交、推送；不自动发布安装包。

Phase 0 本地测试已通过，远端 CI 尚无完成证据，仍保留为阶段总验收欠项。原始 Implementation Prompt 在 `cancel` 处截断；本阶段按 `Prompt.md` 的完整 Phase 1 范围及现有代码决定最小兼容实现。

## 责任与边界

- Pi 继续负责 provider retry、agent loop、上下文压缩和会话存储；Harness 不重发 prompt、不叠加模型重试。
- 通用策略只自动重试明确的只读 transient 故障；invalid_input/validation 要求修参，stale_source 要求重新检索，permission/precondition 阻塞，cancelled/fatal 停止，unknown_outcome 先对账。
- 小说扩展在真实工具入口接入结构化结果、作用域和取消；人类验收、Canon 晋升/回滚权限不改变。
- `RunScope.generation` 是扩展生命周期 epoch；RPC generation 是 Rust 传输进程 epoch，分开命名和测试，不把二者伪称一个已贯通的 ID。
- 写操作台账先限定为同一扩展进程内的受控 `write/edit`。只存 ID、指纹和状态，不持久化正文。进程崩溃后不能声称可恢复或 exactly-once；匹配目标只能证明当前目标已满足，不能证明唯一写入者。
- 不做 Observation Store、Checkpoint、Supervisor、向量库或自动三 Agent 调度。

## 测试先行的验收项

- [x] P1-POL：九种错误分类、有限 backoff、只读恢复、修参必须变化、stale 不重试旧 ID、取消/总 deadline、写超时为 unknown 且不重放。
- [x] P1-EXT：实际 Pi loader + minified 独立扩展的结构化错误与成功；保留可读说明、原有工具名/参数及正常输出。
- [x] P1-SCOPE：真实 session ID + 项目 ID + run ID + 生命周期 epoch；会话/项目切换或运行结束后旧调用不可返回当前成功。
- [x] P1-VFY：verifier 收到 AbortSignal、deadline；结束子进程并区分 CONTRACT / 内容验证失败 / 启动失败 / 取消；不产生人工验收。
- [x] P1-PATH：统一小说读取/写入路径检查；普通读取、内置 read、memory、verifier、write/edit 不绕过链接/穿越/角色权限；文件白名单为精确匹配，目录才允许前缀。
- [x] P1-OP：写入已完成但结果丢失→读取当前指纹→目标满足→不重复写；冲突、跨作用域、相同 ID 不同参数、容量耗尽均 fail closed；未知 edit 变换不猜测。
- [x] P1-RPC：超时/取消/重启清理 pending；迟到 response 不进入普通事件；已知 epoch 拒绝无 epoch；停止重启不复用 Rust generation。
- [x] UI-THINKING：完成后显示“思考过程”，不再保留“正在思考…”；思考内容及展开能力保留，覆盖实际工作流模板渲染。
- [x] SESSION-RESTORE：恢复前检查文件头；只重建明确为空的临时会话，缺失或损坏的历史保守报错；已有文件以 header ID 为准且不改写。覆盖真实 SDK 的持久化及跨代恢复边界。
- [x] 回归：生产与测试 typecheck、三轮 deterministic harness、既有公共领域回归、B0 探针及 frontend build；新增核心能力必须有实际 adapter 测试，不能仅测试孤立辅助函数。
- [x] 交付：记录本地证据及未验证项；原生桌面/真实模型/远端 CI 不以 mock 测试冒充。

勾选表示已获得本地自动化证据，不表示真实模型或原生桌面已经验收。结果与边界见 [HARNESS_PHASE1_RESULTS.md](HARNESS_PHASE1_RESULTS.md)。

## 发布前的独立欠项

- [ ] 提交后的干净检出与远端 Windows/Linux CI（继承 Phase 0；本文为提交前记录，推送后按实际执行结果补证）。
- [x] 复制 runtime 项目上的真实模型 RPC 冒烟：读取、连续 write/edit、修参、机械验证、工具间停止、新会话恢复和 A/B 项目作用域（2026-09-21，4 条提示/15 次工具调用；见实机记录）。
- [x] 原生 Desktop 端到端冒烟：发送、真实工具条目与文本流展示、停止、运行中项目/会话切换及停止后新会话恢复（2026-09-21，4 条提示/9 次只读工具调用，经 Desktop/Rust bridge；见实机记录）。不扩大为写入/verifier 执行中取消、所有流事件竞态或模型语义质量均已验证。

桌面控制阻塞已在以普通权限重启 Pi Desktop 后解除；此前 RPC 与本次原生 UI 的证据仍分别保留。两项实机观察的后续代码修复与自动化验证单独记录在实机报告末尾，不改写原始观察。加载本次新增 Rust 检查需要重新启动新版 Desktop；没有将修复前的原生冒烟冒充修复后的复测。

写操作跨进程崩溃恢复不在 Phase 1 验收范围；不能把当前内存台账当作持久事务日志。
