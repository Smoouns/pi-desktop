# E2：单次上下文的来源快照复用

日期：2026-09-24；基线 `cbc5862`，接续未提交的 E1 工作区。管理扩展 v20。本批仅优化来源核验读取，不开展完整 HTTP 账单、usage 校准或压缩质量评测。

## 行为与边界

- 每次 `context` hook 单独创建来源缓存，通过局部检查点 wrapper 和 Observation 校验参数显式传递；`finally` 销毁。不挂到 active run、会话、检查点或磁盘，也不跨模型请求保留。
- 只保留 SHA-256、总行数和来源字节数，不保留正文、人工验收结论、authority、temporal 或 memoryId。请求级上限为 128 项及 4 MiB **被表示的来源字节**，不是声称占用 4 MiB 常驻内存。超限回退实际读取，不能因此免除预算。
- 每次查缓存前仍检查安全相对路径、链接 / junction、常规文件类型、1.6 MB 文件上限和运行归属。文件标识、size、mtime、ctime 等 stat 字段仅用于当次失效检测；首次仍从完整字节计算 SHA。读取前后 stat 不一致时拒绝复用。
- Checkpoint 与 Observation 可以复用相同文件的指纹，但分别核对引用的 SHA；不同来源版本不能借用同路径的通过状态。人工验收及记忆 eligibility 仍由独立 memory snapshot 重新核对。
- `read_observation` 的主动分页、业务文件读取、`fileVersion`、写入前 gate、完成合同 / 验证报告核验、refresh 与对账不使用 Context 缓存。下一请求即使文件大小与 mtime 未变，也重新读取并计算 SHA。
- 这不是文件系统事务。没有声称消除所有并发改写、ABA 或最后一次检查之后的 TOCTOU；stat 不是内容真值，也没有持久化 Observation。

## 计量

`get_context_budget` 的 `metrics.reads` 及 `lastContext.reads` 新增 `sourceCache`：`hits`、`misses`、`invalidations`、`capacityBypasses`、`reusedSourceBytes`。逻辑来源引用数不因缓存命中减少；实际文件读取及原有累计读取预算只对真正的读取计费。

`reusedSourceBytes` 是复用的来源规模，不是磁盘流量、token 或通用节省量；原检查点内部本已有局部去重，不能将每次 hit 一律当作相对 E1 少一次读取。缺失 usage、HTTP 次数和费用仍未知。

相同 SDK 合成夹具的第二次 Context：

| 指标 | E1 冻结记录 | E2 当前记录 |
| --- | ---: | ---: |
| 来源大小 | 87 bytes | 87 bytes |
| 逻辑来源引用 | 2 | 2 |
| 扩展来源 readFile | 2 | 1 |
| 返回字节 | 174 | 87 |
| 缓存命中 | 未实现 | 1 |

这仅证明受控样本的重复读取减半，不是端到端延迟、真实小说吞吐或模型费用减半。E1 原始记录未改写：`artifacts/harness/production-lifecycle/d-XJiNOk/summary.json`。

## 本地证据

- `npm run test:request-source-cache`：7 项通过。涵盖容量、销毁、无正文 / 权威性保留、源码与压缩工厂加载、实际 IO 计数、跨请求重读、相同 size / 还原 mtime 的改写、写前重验、当次来源改写 / 超大文件、正文不变的验收撤回、旧 IO 取消与会话隔离。
- `npm run test:runtime-metrics`：原 5 项通过，主动读取 / 分页原预算断言未放宽。
- `npm run test:production-lifecycle`：10 组 / 19 个独立进程通过。完整当前生产扩展 + 实际 SDK AgentSession / 原生工具，只有 provider 为合成。报告 `artifacts/harness/production-lifecycle/d-stpncV/summary.json`。
- 新增 SDK 双进程场景：在 Context 已成功复用来源之后、provider 返回写入意图之前修改来源（保持 size 并还原 mtime）；原生写 gate 仍以 `stale_source` 拒绝，零写入派发、无提案文件。冷恢复保留失效状态，没有借缓存恢复权限或伪造上一进程计数。
- 完整 Harness **297 例 × 3**，deterministic=true、failures=false。独立快照：`artifacts/harness/review-e2/harness-passed-847d8331f39d4436a7ce9481b65dd4ea`；没有覆盖 E1 的成功 / 失败快照。
- 应用 / 测试 TypeScript、领域回归、长程 Harness **1 例 × 3** 与前端构建全部通过。构建保留既有动态 / 静态混合 import 和 bundle 大小提示；本批没有 Rust 改动或新的原生窗口验收。

没有改真实小说或全局 Pi 配置，没有实际模型请求或 Desktop 操作；本批未提交 / 推送，远程 CI 与原生窗口结果不外推至 v20。

## 下一步

E3 优先补齐 transport 层任务计量：普通、摘要及允许的重试请求共享归属与账目，用本地计数服务器测试发送前拒绝、取消、失败及未知结果。真实 usage 校准、压缩质量和任务相关进展仍分开验收，不用当前缓存结果替代。
