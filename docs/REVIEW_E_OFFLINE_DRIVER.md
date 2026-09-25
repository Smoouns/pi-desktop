# E8 离线联合验收驱动

本批只实现离线工装，不修改生产运行策略。完整当前 v24 扩展、固定 Pi SDK 0.63.1 的 Agent 循环、原生压缩、工具执行、请求序列化与响应解析均实际运行；HTTP 对端为本机合成服务器，答案及 usage 为测试数据。

没有真实模型调用、凭据解析、真实小说 / 全局 Pi 修改、Desktop 操作、提交或推送。离线通过不是模型质量、计费精度、256K 自动压缩或原生桌面验收。

## 实现

入口为 `npm run test:review-e8`；代码及边界说明在 `tests/harness/review-e-live/README.md`。

1. U：两次普通答复，将最终请求体、生产估算、原始 usage 字段存在性及 SDK 归一化输入逐次对应。缓存字段缺失保留 null；费用未知。未命中严格追加历史锚点时记 `not_observed`，不移除生产上下文合同来制造命中。
2. C：两个独立会话使用同一份公开合成历史。A 不压缩，B 只进行一次原生压缩再回答同题；控制组答案不进入 B。单摘要和双摘要分别覆盖，双摘要分别计数并在本机 broker 串行应答。自然语言摘要质量与完整系统恢复分开报告，正确脚本答案不构成模型语义质量证据。
3. R：实际 SDK 读取 992 字节来源，预算工具获取既有生产计量。相同上下文中的 Checkpoint / Observation 两个引用只有一次纳入预算的来源读取；下一个上下文重新读取。宿主仅将隔离来源由 v1 改成同大小的 v2，模型工具重新读取并刷新检查点。不是总 IO、磁盘性能或普遍省钱结论。

外层先检查生产发送账，再将一次性预留同步落盘。普通、摘要共用设计中的 24 次全批 / 8 次场景上限和输入输出上限。父子进程分离，worker 环境使用白名单，没有提供私有模型配置或凭据；仅允许连接父进程拥有的 loopback 端口。

主动权限错误、缺失 input/output usage、超额 usage、401/429/500、重定向、响应过大、超时及串流取消均停止后续发送。只缺 cache 不停批，仍是未知费用。未知结果只读恢复零重放；损坏 / 改写日志、重复或无归属终态都拒绝。守卫是可信测试代码的纵深保护，不冒充操作系统安全沙箱。

## 证据边界与失败保留

- 第一轮构建失败：worker 函数缺少闭合括号，未发请求，工作目录 `offline-1xf5Jn` 保留。
- `offline-KrgQN3`：SDK 方法名接错、父子 bundle 分别生成扩展导致内容哈希不同，均是新工装接线失败。修正为固定 SDK 的 `setActiveToolsByName`，并将生成扩展一次冻结后逐字复制；不是放宽哈希断言。
- `offline-yGsJBP`：R 报告读取了错误的 metrics 层级；另一个负例暴露 SDK 对未启用工具不会经过 `tool_call`。测试外层补 SDK 工具开始事件的失败停批，不改生产权限；原记录显示该负例 8 次本机请求，不能写成一开始就只发送 1 次。
- `offline-6NLU5s`：上述修复后 23 组通过。后续补充运行中日志改写、重复 / 错序终态和完整源码哈希留存，使用新的验收目录，不覆盖此记录。

这几批全部是合成 HTTP，没有真实请求或收费。每个 worker 的原生会话、最终请求、工具结果及失败原因都保留在对应批次。

## 最终本地验收（2026-09-25）

- 最新驱动：`artifacts/harness/review-e8/offline-fbGy8H/summary.json`，**23 组通过、0 失败**；全套 35 次本机 HTTP，其中 U/C/R 正例共 14 次。源码 / fixture / 冻结 eval 文件树保持不变，驱动代码指纹与当前文件核对一致。
- C 公开 seed 为 14,062 字节；U 第二次请求没有观察到可用的严格追加锚点，记录 `not_observed`。没有根据合成 usage 调整生产估算，没有声称真实 token 误差已经校准。
- 完整 Harness **352 例 × 3**，`deterministic=true`、失败 0。157 项实现文件 SHA 核对一致，固定副本：`artifacts/harness/review-e8/harness-passed-849578b4cb51642db7fdc6cb597fd04cc8c6740281e4eb1c236b405ca95d872d`。
- 原有完整 SDK 发送层 **15 组 / 33 HTTP**通过：`artifacts/harness/task-transport/e4-d8JGhB/summary.json`。包含生产日志损坏、原生 summary、内部 retry、压缩预算、取消及失真摘要；属于原有回归，不冒充新 E8 profile 的真实模型结果。
- `npm run check`、`npm run check:harness-tests`、`git diff --check` 通过。公开 `test:review-e8:recover` 命令确认未结请求保持未知、只读恢复、0 新 HTTP。没有新 Desktop / Rust / 远程 CI 验收。

## 离线驱动交付时未进入本批的事项

真实模型 endpoint / compat 投影、无网络 prepare、授权 manifest、单次授权与失效 / 漂移门禁、携带凭据的远端 broker 尚未接入本工装，`livePrepareReady=false`。现有不可执行方案仍为 `authorization.granted=false`，不能把“可以实现离线驱动”当成真实批次授权。

后续进度：这部分无外网准备与门禁已在独立步骤实现，见 [E8 准备与授权检查](REVIEW_E_PREPARATION.md)。上面的离线记录保持为当时证据，不能当作真实模型结果。冻结清单仍需单独批准；24 小时有效期、24 次全批 / 8 次场景额度不变。参考价满额无缓存预留约 $1.36 仍不是硬金额上限；cache 不明时费用未知。
