# Phase 5 S3：上下文与原生压缩的离线 SDK 切片

本页记录首个 v1 增量：**B2/B3 的限定离线适配和故障探针**。使用固定 Pi SDK 0.63.1、公开合成文件及本地固定响应，没有真实模型入口、认证配置参数或费用数据。不代表整个 Phase 5、完整历史 Desktop/Rust/RPC、模型摘要质量或长篇创作验收。后续自动压缩/未知写入 v2 补充见 [生命周期测试](HARNESS_PHASE5_SDK_LIFECYCLE.md)，它使用独立任务和批次，不改本页 v1 合同。

## 1. 实现边界

| Profile | 本增量实际加载的能力 | 不包含的能力 |
| --- | --- | --- |
| `sdk-b1-reliability` | 原 S1 B1 扩展原样复用，共同安全包装及冻结可靠性工厂 | Observation、产品请求预算、检查点 |
| `sdk-b2-context` | B1 + 冻结 Observation/预算工厂，新增分页和最终合成载荷预算 hook | 检查点、Supervisor、maintenance |
| `sdk-b3-checkpoint` | B2 + 冻结检查点/来源版本/失效工厂，原生压缩前后及写入前检查 | Supervisor、maintenance、完整 unknown-write 跨压缩恢复 |

工厂沿用 `evals/adapters/provenance.json` 指定的历史 Git 字节。`src/extensions/checkpoint-runtime.ts` 当前字节与 Phase 3 的 `828d36d9c0f3140c750616b97e7d7e92287e6444` 相同；加载前核对 SHA `9117d598d4cf13fe473794610749e2437a30927c20340b0cb34d7cac7b36cb4e` 及 Git 对象，不静默使用后期实现。新增事件接线是 **eval-only adapter**，不是原样加载某个历史完整扩展。工具/事件清单有白名单审计和能力串入负测试。

各 profile 共用任务业务提示、模型/SDK、公开 fixture 和安全边界。B2 增加 `read_observation`，B3 另有两个 checkpoint 工具；工具接口和所需请求数不同，不能仅按接口丰富程度或合成调用数推断模型收益。B1/B2/B3 三轮固定交错顺序，不能选择性补跑。

## 2. 三个任务

1. **大工具结果**：读取临时生成的约 24 KB 文档，找到末尾标记。B1 原样内联，超过预登记产品预算，保留为负例 fail；B2/B3 将结果变成带来源 SHA 的短预览与引用，由 SDK 调用分页工具读末尾。检查标记确实进入工具结果，而不是只看脚本的最终固定回答。
2. **完整请求预算**：超长用户指令不丢弃、不改写。B2/B3 的 `before_provider_request` 检查完整合成 JSON 载荷并取消请求；本地响应提供器尊重 AbortSignal，记录为 product-blocked。B1 缺少该能力，保留为负例 fail。全部 profile 仍有独立的外层测试限额，外层安全不算 B1 的产品能力。
3. **原生压缩、进程重开与来源变化**：第一进程真实启动 AgentSession、读取来源、调用 `session.compact()`；SDK 自行准备和发起摘要，`fromHook=false`，不返回替代 compaction。进程退出后，测试驱动只修改临时来源文件，第二个独立进程通过 `SessionManager.open()` 恢复会话。B3 应拒绝旧来源写入、拒绝只 refresh 不重读的恢复，重读并 refresh 后才允许一次写入。B1/B2 没有版本写入门，保留为负例 fail；不把这类临时、预登记写入当作生产安全事故。

原生压缩是**手动调用真实 SDK 压缩路径**，自动压缩保持关闭。摘要是本地固定文本，不是 LLM 摘要质量证据；新进程中观察载荷不持久化，旧 observation ID 必须拒绝，并要求重新读来源。检查点从 SDK 会话 custom entry 恢复，与摘要文本分开，不把摘要当成写入授权。

## 3. 计量、隔离与失败

- 普通请求和原生摘要都经同一个本地 API registry 提供器计数；摘要不经过普通 Agent 的同一个 hook，另列 `syntheticSummaryRequests`。不能把摘要藏在工具计数中。
- 每进程阶段最多 16 个合成请求，单次外层上限 128 KiB（完整 JSON + 输出预留 + 余量），最多 16 次工具调用、45 秒。产品普通请求预算为 16,384 UTF-8 估算单位，输出预留 1,024、余量 512；native 摘要沿用 SDK 参数并计入外层上限。这里没有真实 provider 序列化或 Google 最终发送硬门结论。
- 载荷只保存 SHA、字节数、请求种类及处置；真实 usage/cache/费用全部为 null，不能将 synthetic token 常量用于成本或节省比例。
- worker 环境只含白名单系统变量与临时 Pi 目录；使用内存假认证，不读取用户 `.pi` 配置，不发现全局 skills。网络和子进程 guard 为纵深保护，不是 OS 沙箱。
- 未知/来源漂移/非预登记失败停止矩阵，后续 blocked；缺失回执保持 unknown/null。已观测的早期阶段数据不能因后续进程失败或源码审计失败被清空。只有满足严格条件的缺能力负例允许继续。
- 批次冻结代码、依赖运行树、fixture、扩展生成源码、提示和策略；raw/index/aggregate 可只读重建，拒绝额外字段、私密附加字段、缺失/多余记录、重复身份、哈希漂移和伪造 PASS。

## 4. 运行方法与验收

```powershell
npm run test:sdk-context
npm run eval:sdk-context
npm run eval:sdk-context:rebuild -- artifacts/harness/sdk-context/<batch-id>
```

开发诊断可用 `node scripts/run-sdk-context.mjs probe <profile> <task> [scenario]`；仍为离线模式，没有 live 开关。全部临时副本都在受校验目录中生成并清理，公开矩阵结果另行保留。

首轮本地检查覆盖三条主路径、来源不变/丢失、损坏检查点、摘要失败/取消/上限、观察分页/跨角色/跨项目/跨会话/来源失效、新进程旧 ID 拒绝、预算 system/tools/messages/附加字段覆盖、事件能力泄漏和严格产物重建。最终冻结矩阵、检查数量和全新依赖回归结果以 [结果记录](HARNESS_PHASE5_RESULTS.md) 最新增量为准。

预登记矩阵为 3 profiles × 3 tasks × 3 轮，共 27 格：期望 **15 pass、12 缺能力负例 fail**，不是 27 个任务全通过。这是限定能力合同验证，不是总体可靠性、token 节省、真实模型成功率或公平的端到端生产效果比较。

## 5. 尚未覆盖

本页 v1 不覆盖自动压缩或未知写入跨压缩；这些已有独立的 [v2 限定离线补充](HARNESS_PHASE5_SDK_LIFECYCLE.md)。真实摘要/真实模型、Supervisor/maintenance 独立对照、完整 unknown-write/迟到竞态生命周期、Rust/RPC/原生 UI、人工小说质量评审仍未完成。新的真实普通请求或摘要请求均须独立冻结清单并另获批准；旧 S2 剩余额度不可复用。
