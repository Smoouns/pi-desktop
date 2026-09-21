# Phase 2 原生 Desktop / 真实模型冒烟记录

日期：2026-09-21，Asia/Shanghai。用户确认继续实机复测后，在独立的“Phase 2 实机验收”工作区完成。实测过程没有提交、推送、修改私人小说、认证或模型配置；后续代码交付的提交、推送另经用户授权。

## 环境与证据边界

- Windows x64，Node `v24.19.0`，实际全局 Pi CLI `0.84.2`；固定自动化 SDK 仍为 `0.63.1`，两者证据分开。
- 操作实际 Tauri 开发窗口 `src-tauri/target/debug/pi-desktop.exe`，通过 computer-use 的原生 UI 创建工作区、添加 A/B 项目、填写及发送请求、观察完成状态；不是独立 RPC 脚本替代桌面操作。
- 基础提交 `32131274be2964a61d0180088eeb51709ebdb86f` 加未提交的 Phase 2 源码。受管小说扩展 v9 的生成文件 SHA-256：`ecdc5123d4ed7cd92d959e9c3b8dc42b65db6f9ff23f5566daa8023a9e90b56e`。
- 配置的提供商/模型名为 `gemini-proxy / gemini-3.8-flash-high`，不鉴定代理上游的真实模型身份。
- 共 **3 次 UI 用户提交、2 个项目会话、15 次工具调用、18 条 assistant 响应**。13 次工具成功，2 次为测试预期的 `stale_source / STALE_OBSERVATION`；各轮最终 assistant 均 `stop`，UI 显示 `Pending: 0`。这些计数不是实测 HTTP 请求数。
- 未发送超大输入来验证真实收费通道的超限取消。全局重试设置保持原样。

## 测试数据与隔离

只复制仓库公开合成 fixture `fixtures/harness-novel` 的 17 个文件，分别放在：

- `D:\PycharmProjects\novel_test\runtime\phase2-live-a`
- `D:\PycharmProjects\novel_test\runtime\phase2-live-b`

各自新增 `notes/phase2-large.md`，包含 A 或 B 标记、180 个非空行及末尾换行，标题位于第 1、61、121 行。读取器计入末尾空行，所以初始 `totalLines=181`。全文工具 payload 为 26,644 bytes，超过 6,000 bytes 内联阈值。

测试前后的 SHA-256 清单及离线证据放在被忽略的 `artifacts/harness/phase2-live/` 下，不作为公开小说素材提交。源 fixture 不改动；唯一获准修改是 A 探针末尾追加 `PHASE2_MUTATION_A_ONLY: deterministic audit probe`，用于验证旧观察失效。

## 三轮实际执行

所有请求明确只允许 `read_story_document`、`read_observation`、`get_context_budget`，不使用 bash、普通 read 或写入工具。离线审计核对实际工具名、参数、结果及调用 ID 配对，不只依赖模型自然语言汇报。

### A：范围、去重、分页和预算

1. 按 `startLine=60,endLine=63` 读取探针；返回 A LINE 060、第二标题、A LINE 062/063，来源范围准确。
2. 按 `section="A middle section"` 读取；来源范围为 61–120，payload 8,895 bytes，`offloaded=true`。
3. 完整读取两次；都返回相同来源 SHA、1–181 范围和同一个观察 ID，完整原文没有内联返回。
4. 依次用该 ID 读取 `start=0,limit=300` 和 `start=300,limit=300`；离线逐字符校验两页拼接恰好等于完整 payload 的前 600 个 UTF-16 字符，无重叠或缺失。下页提示分别是 300、600。
5. 查询预算；3 个不同观察、6 次成功访问，去重没有抹掉重复读取的访问记录。

第一轮共 7 次工具调用。全文旧 ID：

`obs_12e815b17fc52e68aa52a5b9f8a668b55bee9e791e54c3ccb15497bc359aed76`

### A：来源修改后的旧观察失效

测试程序只追加 A 的合成探针，然后通过同一个 Desktop 会话发送第二轮：

1. 读取旧 ID，被拒绝，错误为 `kind=stale_source, code=STALE_OBSERVATION`，明确说明来源内容已变化。
2. 完整重读得到新 SHA 和新 ID，来源范围变成 1–183。
3. 读取 181–183 行，确认追加标记存在。
4. 查询预算；观察累计为 5 个、成功访问累计为 8 次；run 已更换，读取/输出额度按本轮记账。

第二轮共 4 次工具调用，其中 1 次为预期拒绝。新 ID：

`obs_127e963b574bb496dbc43f2af450e212e7eda49419388f3f3ff3424959d41b2f`

### B：通过桌面切换项目后的隔离

用 Desktop“添加项目”选择 B 并建立空白会话；仍使用同一配置模型。

1. 把 A 的新 ID 交给 B 的 `read_observation`，返回 `stale_source / STALE_OBSERVATION`，消息包含 `Observation is unavailable or belongs to another scope`，不交付 A payload。
2. 按 60–63 行读取 B 的同名文件，只出现 B 标记。
3. 完整读取 B，观察 ID 与 A 不同，来源路径仍为 B 内的相对路径。
4. 查询预算，2 个观察、2 次成功访问；项目 ID 和会话 ID 均与 A 不同。

第三轮共 4 次工具调用，其中 1 次为预期拒绝。B ID：

`obs_b88fede1f43a3496223f261a60d2131cab14085bc6acb289db030a5836ab1e47`

这证明经原生桌面切换后 A 记录不可由 B 读取，不区分底层“记录不在该进程”与“owner scope 不符”两个拒绝原因。同进程项目/会话/角色边界另由确定性 Harness 覆盖；本次没有原生角色切换验收。

## 预算快照

以下均为调用 `get_context_budget` 当时的快照；请求数字是保守 UTF-8 估算单位，不是实际 tokenizer 计数。读取/输出为累计 bytes，预算工具自身返回尚未计入该次快照。

| 轮次 | 请求估算 / 上限 | run 读取 | run 输出 | 观察 / 成功访问 |
| --- | --- | --- | --- | --- |
| A 第一轮 | 49,215 / 128,000 | 559,599 | 4,267 | 3 / 6 |
| A 第二轮 | 56,173 / 128,000 | 480,060 | 4,311 | 5 / 8 |
| B 第一轮 | 46,747 / 128,000 | 133,095 | 2,476 | 2 / 2 |

三轮均有允许发送的 preflight 和 provider audit；输出预留为 16,384，安全余量 4,096。read/output 上限分别为 16,777,216 / 65,536。原生 UI 的上下文按钮显示“选材估算”，与请求账本分开。

两个会话中 provider 上报的总 usage 累计分别为 101,617 和 31,511；这些是历史多条 assistant 消息之和，不是单次上下文长度、精确网络计费或本地估算准确度的证明。UI 的 `$0.000` 也不作为免费调用的证据。

## 离线复核与收尾

本次只审阅以下已明确定位的合成测试会话，没有扫描私人会话：

- A：`01a0c328-66c8-7351-9df7-25f5732925bb`，文件位于 Pi `sessions/--D--PycharmProjects-novel_test-runtime-phase2-live-a--/`。
- B：`01a0c32b-da61-7729-85eb-c692f9f315ee`，文件位于 Pi `sessions/--D--PycharmProjects-novel_test-runtime-phase2-live-b--/`。

可在仓库执行以下只读复核，不会再次调用模型：

```powershell
node artifacts/harness/audit-phase2-live.mjs
node artifacts/harness/phase2-live-files.mjs audit
```

审计结果：A/B 均 `passed`，全部 15 个 toolCall/toolResult 一一匹配，工具清单只有上述三种只读工具。哈希复核：源 fixture 17 个文件不变、B 18 个文件不变、A 18 个文件中仅指定探针有精确的预期追加。

准备脚本最初遇到 Node `fs.cp` 拒绝已创建的空目标目录，修正为向已核对的空目录逐项复制；当时尚未复制素材。收尾强化审计曾误以为错误结果也在 `details.harness` 中携带 scope，随后根据实际 `<tool-error>` 结构修正解析并离线重跑通过。这两次均是诊断工装问题，未重放模型请求或改动生产实现。

## 仍未覆盖

- **P2-GATE-FINAL 保持未完成**：固定 SDK 的 Google final-payload late-abort 仍可能发送一次 HTTP。本次正常路径冒烟不能证明此限制已解除。
- 没有原生重启恢复、角色切换、真实超限取消、全部 provider 兼容、远端 Phase 2 CI 或小说创作质量验收。
- Observation 仍是有界进程内存储；本次记录的 ID 不是持久引用。
- 本次新增验收记录与本地诊断工装，没有增加 Phase 3 Checkpoint、自动压缩、Supervisor 或自动三 Agent 编排。
