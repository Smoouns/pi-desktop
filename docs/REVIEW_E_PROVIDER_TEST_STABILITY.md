# E7：Google 测试波动的端口复现与测试设施修复（2026-09-25）

## 结论与证据边界

已确认并修复一个能同时重现 E5 两个失败的测试设施缺陷：`http.Server.listen(0)` 在此 Windows 主机可能分配到 Fetch 禁止访问的端口。服务器可以正常绑定，原生 `node:http` 也可访问，但 SDK 使用的 Node Fetch 会在联网前拒绝，返回 `TypeError: fetch failed`，其 cause 为 `bad port`。服务器实收为 0，因而错误地触发预算 / late-abort 测试的 HTTP 数量断言。

这不是通过反复重跑直到绿灯得到的结论。修复前固定端口 6667，两个原测试均失败；同一套生产代码、测试逻辑和断言改用端口 55137 后均通过。修复后再次人为向两个 Google 测试分配 6667，新选址器在调用 provider 前释放受限绑定、改选允许端口，两个原断言均通过。

**不能反向确定 E5 历史两次失败的唯一根因。** 原记录只有 `0 !== 1`，没有端口及 SDK 错误。它们保持冻结并列为“历史归因未证实”；本批关闭的是确定复现的端口选址缺陷，不将历史失败改写为通过，也不声称所有潜在波动均已排除。

## 调查依据

- 本机只读 `netsh int ipv4 show dynamicport tcp` 返回 Start Port `1024`、Number of Ports `13977`，即 1024–15000；与 6000、6665–6669、10080 等 Fetch 受限端口重叠。没有修改系统网络设置。
- Node `v24.19.0` / 内置 Undici `7.29.0` 的运行时实现包含这些 bad ports。
- 固定 Pi SDK `0.63.1` 的 `pi-ai/dist/providers/google.js` 在 `onPayload` 后调用 Google `generateContentStream`；固定 `@google/genai 1.46.0` 最终调用 Fetch，外层仅保留错误 message，因此之前常规断言看不到 `bad port` cause。
- Google late-abort 的既有限制与此问题分开：`buildParams` 先检查 signal，之后 `onPayload` 才取消；Google 客户端随后仅注册 abort listener，没有检查已经取消的 signal，导致仍可能发送。本次允许端口的实测保留 **Google 1 次 / OpenAI 0 次**原断言，未改成“0 或 1 均算通过”。E3 生产发送出口的保护不变。

## 最小修改

- `tests/support/loopback-http.ts`：共享的 Fetch-compatible loopback 选址器，仅绑定 `127.0.0.1`，排除固定运行时的受限端口；最多 32 次空服务器绑定，释放每个拒绝的绑定；普通绑定错误仍抛出。不重试 SDK 请求、不绕过 Fetch 安全策略、不改变系统端口范围。
- 两个当前公共 SDK HTTP 测试入口使用它：`tests/harness/provider-budget.ts` 与 `tests/harness/task-transport-sdk.ts`。冻结 `evals/`、历史评测实现及原证据未改。
- 预算测试增加请求开始 / 完整收到 / 中途取消的区分，防止仅统计 body 完成而忽略不完整请求；失败时输出本机端口和这些计数。SDK message 继续有界，不记录密钥或真实内容。
- 新增 4 项回归：受限与无效端口、连续受限分配后重新选址、32 次上限及绑定错误、真实 Fetch 单次本机请求。原 4 项 provider 预算测试保留；`npm run test:provider-budget` 固定跑三轮，保存每次结果，而非失败后重试到通过。
- 本批没有修改生产 `src/`、Rust、模型配置、预算上限或取消行为，也没有升级依赖。

## 验收记录

- 修复前受控复现：`artifacts/harness/review-e7/port-repro-2KM7vM/summary.json`。同一 6667 服务器原生 HTTP 可达、Fetch 被 `bad port` 阻断；原两个用例在受限端口失败、允许端口通过。保留 SDK 底层错误链、服务器收到的请求及旧测试 bundle；真实模型 0、外网阻断触发 0。
- 修复后真实绑定注入：`artifacts/harness/review-e7/selection-wGe9zt/summary.json`。两个 Google 服务器各先被分配 6667，均在 provider 调用前释放，改用 55137；原两个测试通过，5 个 Fetch 调用全部只对允许端口发生。不是伪造 SDK 响应或放宽断言。
- 定向 **8 项 × 3 = 24 项检查**通过：`artifacts/harness/review-e7/focused-FCCet8/summary.json`。fixture 字节不变，保存相关源码及固定 SDK 文件哈希。
- 完整生产扩展 + 固定 OpenAI / Google SDK 客户端本机回归 **15 组 / 33 HTTP**通过：`artifacts/harness/task-transport/e4-lY1745/summary.json`。真实模型调用 0、外网阻断触发 0、服务器断言失败 0；含两通道超限零新增 HTTP、原生摘要、取消和冷恢复。
- 应用 / Harness TypeScript 检查、`git diff --check` 通过。完整 Harness **352 例 × 3**通过，deterministic=true、失败 0；149 项实现文件哈希逐一核对与测试时相同。固定副本：`artifacts/harness/review-e7/harness-passed-a88fe5dbaa174ac968ffc03db002caaf378cdea860e6fe0ec8c0fef25c4d49c6`，包含三轮 trace 与汇总，没有将 E6 的领域 / 长程报告复制冒充新结果。
- 对照 E6 冻结的实现清单核验，所列 `src/` 与 `src-tauri/` 文件全部字节不变。HEAD 仍为 `cbc5862dad7f302f647d96e5ed338abfd9f8d5ec`，已有 E1–E6 工作树改动保留。

本批未 commit / push，没有新增远程 CI、Rust / 原生 Desktop、真实模型或发布包验收；不把本机合成请求当作真实 usage / 摘要语义质量证据。下一步仍需单独授权、预登记真实模型 usage / 压缩质量 / 读成本的联合验收。
