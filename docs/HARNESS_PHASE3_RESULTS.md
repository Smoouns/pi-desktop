# Phase 3 — 版本感知检查点与压缩

本阶段在 `f21b2b46a53729ed5722f5b816fe9fd21a447dc9` 基础上实现，边界见 [验收清单](HARNESS_PHASE3_ACCEPTANCE.md)。只使用公开合成小说测试；没有修改私人小说、凭据、模型设置，也没有自动提交或推送。

## 实现

- `checkpoint-store.ts`：严格、有容量上限的 TaskCheckpoint，SHA-256 内容完整性检查；目标、用户原始约束、来源版本、观察引用、产物、未决问题、建议动作、待处理操作和预算分别保存。完整性摘要不是防恶意本机用户篡改的签名。
- `source-version.ts` / `invalidation.ts`：项目相对安全路径、SHA、范围、权威性、时态和 memory ID 核验。任何缺失、读取不可用或过期来源都会阻塞相应检查点；不从目录名推断额外写入权限。
- `checkpoint-runtime.ts`：活跃分支恢复、项目/会话/角色隔离、原始约束顺序保留、漂移锁定、显式刷新、持久化失败关闭写入、取消与晚到结果隔离。
- Managed extension **v10**：压缩前通过 Pi `appendEntry` 保存，保留原生压缩算法和用户 customInstructions。压缩准备阶段只将 tool result payload 换成引用，不改变用户消息、工具调用/结果配对或顺序。恢复时重新核验，原生自然语言摘要不再作为有效事实输入。
- `write` / `edit` 在放行前记录待操作及 may-have-dispatched 标记；已存在预期 post-image 时只核对并报告 satisfied，不重复执行。Verifier 也记录报告副作用意图；机械失败不等于人工拒绝，机械 PASS 不等于人工验收。
- 普通文件读取只赋予 `reference / unspecified`，不自动变成 Canon；通过记忆工具读到的来源保留原有 authority、temporal 和 memoryId，并重验人工验收。
- 检查点进入 Phase 2 的 `request.ledger.checkpoint` 字节估算分项。来源重验和目标指纹读取计入 Read Budget；未静默压缩/截断用户硬约束。

## 可用工具与日常操作

重启新版 Pi Desktop 的 Pi 运行时，使受管扩展更新后，可让 Agent 调用：

- `capture_task_checkpoint()`：手动保存；普通压缩及写入也会自动保存。
- `get_task_checkpoint()`：查看检查点、失效路径和未完成操作。只读小说文件；发现漂移时会在 Pi 会话记录中锁定失效状态。
- `refresh_task_checkpoint()`：在重新读取当前来源后显式刷新。不能通过传入模型编造的 SHA、事实或许可放行。

安全测试顺序（使用小说副本）：

1. 让 Agent 读取一份文档并保存检查点，确认目标、约束与 evidence 路径可见。
2. 使用现有 `/compact` 压缩，再查看检查点；关闭并重新打开同一会话，确认仍能恢复引用。旧 observation payload 进程重启后不可读，需回源。
3. 在编辑器中修改测试来源，再要求按旧任务写入。预期被阻塞并列出过期来源；即使改回旧内容也不自动放行。
4. 让 Agent 重新读取失效文件，再调用 `refresh_task_checkpoint()`，核对新 SHA 后继续。记忆来源应重新检索/读取，不用普通文件读取降低它的权威性要求。
5. 切换到另一项目或职能会话，确认不能恢复前一检查点。

## 验证记录

本地 Windows x64、Node `v24.19.0`、固定 Pi SDK `0.63.1` 验证通过：

- `npm run check`、`npm run check:harness-tests`：通过。
- `npm run test:harness`：152 项 × 3 轮全部通过，结果确定性一致；最终实现及测试文件 SHA 与测试记录一致。
- `npm run test:novel-domain`：五组小说领域回归全部通过。
- `npm run test:harness:baseline`：B0 三项既有缺陷复现，当前实现对应修复通过。
- `npm run build:frontend`：通过；不等同于 Rust 打包或原生窗口实测。
- `npm run test:harness:isolated`：278 个文件的未提交源码快照，重新 `npm ci` 后执行两组 typecheck、152 项三轮 Harness、五组领域回归及前端构建，六条命令全部通过。未复制忽略的私人文件；这不是已提交 clean clone 或远端 CI 结果。之后只补充本验收文档。

压缩验证覆盖真实 loader / ExtensionRunner、原生压缩准备对象与三次模拟压缩周期；持久化验证使用真实 SessionManager 写盘、重开及损坏记录。**模型调用为 0**，不将以上结果等同于真实 LLM 压缩质量或原生 Desktop 端到端验证。

结构化自动化证据输出在忽略目录 `artifacts/harness/`：`summary.json`、`run-1.json` 至 `run-3.json`、`regression.json`、`isolated-summary.json`。这些包含公共合成输入，不包含私人小说或凭据。

## 后续实机验收（2026-09-21）

此节与上面的无模型自动化记录分开：使用公开 fixture 的独立 A/B 副本、全局 Pi 0.84.2、`gemini-proxy/gemini-3.8-flash-high` 和受管扩展 v10 完成了实机验收。

- 结构化审计 `artifacts/harness/phase3-live/audit.json` 为通过：5 次 RPC 提示、14 次工具调用/结果、1 次原生 SDK 压缩、1 次过期来源写入阻塞、1 次刷新后成功写入；覆盖 capture / native_compact / reopen / stale / refresh / isolation。
- A 副本的变更限定在测试来源、候选结果及测试专用 `.pi/settings.json`；B 副本与原 fixture 未变。没有修改私人小说或认证配置。
- Desktop 内完成 B 项目的读取、捕获、查询检查点；关闭/重开操作的自动控制未顺利完成，用户按 Esc 中止。用户随后明确反馈「重开后核对通过」，记为**用户人工复核通过**，不伪称由自动化完成了窗口生命周期验证。
- 一次合成样本的压缩与恢复不能代表长篇小说的全面压缩质量。UI 后续反馈的会话切换、文字溢出与命名改动另见 [会话体验修复](SESSION_UX_FIXES.md)。

## 明确限制

- 不声称已完成全面的真实模型压缩质量评估、无人干预的 Desktop 端到端验收、远端 CI 或 Linux 本机执行。上面的定向实机冒烟、用户人工复核、固定 SDK loader/runner 与 SessionManager 文件重开测试分别记录。
- 不替代 Pi 的 LLM compactor；before-compact 返回接口不能修改 customInstructions。当前准备对象适配基于仓库固定 SDK 源码及真实 loader 测试；不同全局 Pi 版本仍应做原生冒烟。
- Observation payload 仍仅在内存；检查点保存引用，不持久化全文。来源变更后会要求重读，而非假装旧观察仍可恢复。
- 检查点上限 128 KiB、证据/产物各 128 项、操作记录 64 项、用户约束 256 条。不会为了继续运行而悄悄删除约束/操作墓碑；达到上限会明确停止，需要建立范围更小的新任务。
- 无法推算预期 post-image 的编辑、进程崩溃或切换会话中的中断验证器，可能仍为未决操作。无法证明结果时保持阻塞，不能自动重放；尚无人工 reconcile UI。工具级取消且原运行仍有效时，验证器确认子进程退出后可核对报告并记账，但中断绝不是 PASS。
- 验收撤回、语义来源变成不适用或原引用范围消失时，不会自动降低证据等级；可能需要人工重新确定任务边界或新会话，不能强行刷新成 Canon。
- 版本检测是读取时指纹核验，不提供操作系统文件锁或文件系统事务。对外部进程在最后一次检查后并发改写的情形，不声称具备事务级隔离。
- Phase 2 固定 SDK Google 最终载荷严格零发包硬闸门仍按既定决定暂缓；本阶段不改变该结论。不实现 Supervisor、自动三 Agent 编排、向量库或自动 Canon 提取。
