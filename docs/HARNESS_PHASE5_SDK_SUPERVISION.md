# S4：Supervisor / 上下文维护独立离线对照

本增量在同一 Pi SDK 0.63.1 下比较三个能力配置。它只运行公开临时 fixture 和本地合成回复；真实 SDK 负责消息、工具、持久化和原生压缩。**不是新模型实测，也不代表整个 Phase 5 或 Desktop 发布验收完成。**

## 配置边界

| profile | 共同 B3 底座 | Supervisor | 上下文维护 |
| --- | --- | --- | --- |
| `sdk-b3-s4-control` | Observation / 预算 / Checkpoint / durable operations | 无 | 无 |
| `sdk-b3-s4-supervisor` | 相同 | 有 | 无 |
| `sdk-b3-s4-supervisor-maintenance` | 相同 | 有 | 有 |

三个配置都由 `sdk-b3-checkpoint-ops-v2` 生成，共用工具 schema、system prompt、任务输入、种子历史、SDK 设置和外层边界。新增能力通过独立 event adapter 接线，不加载当前全量小说扩展后只改名称。注册的工具、命令和 handler 数量逐项审计；工厂缺省时不将其注入相应配置。

Supervisor 的状态机、持久化 adapter 及上下文重建/裁剪工厂来自生产源码，运行前核对当前字节与 `a50e794e78466d77834c5d5a873e05fe113608ac` 的 Git 字节 SHA；清单见 `evals/sdk-supervision/provenance.json`。原 B3 继续使用原有历史 provenance。三个新增生产文件加入 LF 属性，但**没有修改生产 TypeScript 逻辑**。

`verify_public_probe` 是各组共同的最小公开文件字节验证器，读取固定候选文件，不等于完整 `verify_chapter`、章节验收或人工批准。准备完成的标记也只能成为 `COMPLETED_CANDIDATE`，不能晋升 Canon。

## 五个任务

每项按三个配置、三轮运行，共 45 格；相邻任务轮换配置顺序，顺序预先冻结。

| 任务 | 共同驱动 | 机械预期 |
| --- | --- | --- |
| `verified-stop` | 读公开世界观，写 ready 标记，验证，结束 | 三组都通过；候选已验证但用户未批准 |
| `unchanged-verification` | 写 incomplete 标记，脚本最多发起六次相同验证 | 无 Supervisor 继续六次，记缺能力 fail；有 Supervisor 第三次即停，业务仍未完成 |
| `unverified-stop` | 写 ready 标记，不验证就输出 ready | 无 Supervisor 记缺能力 fail；有 Supervisor 阻止将其计为完成 |
| `trim-fit` | 历史中一个旧长工具结果，后有四个短工具结果 | 仅维护组裁剪旧结果并发送当前输入一次；其余被预算阻断 |
| `compact-fallback` | 历史中旧长讨论及近期短轮次，没有可裁剪的大工具结果 | 仅维护组调用一次原生压缩后发送当前输入一次；其余被预算阻断 |

这不是模型自主选择行为的实验：普通回复、工具计划及摘要都是固定合成数据，种子工具记录并非真实历史执行记录。次数差异只能解释为该确定性探针的控制行为，不能宣称模型整体效果或 token/费用节省。

SDK 的事件通知存在排队：NO_PROGRESS 后可以有一次已经排队的 provider 入口，但其 signal 必须已经 aborted，不得交付合成回复或再次派发工具。日志分开记入口、dispatched 与 aborted，不把这个入口隐去或误算成新模型调用。

## 维护与预算口径

- 延用 B3 的 16,384 **字节合同**，另含 1,024 输出预留与 512 安全余量；这不是模型 token 容量，也不改应用的 256K 工作窗口。
- 预检高于 85% 时尝试裁剪旧工具文本，保留最近四项、pending 工具与非文本结果；只改发送副本，保存历史不变。
- 裁剪仍不足时，在 idle 且无 pending operation、允许 compaction 的设置下调用一次 `ctx.compact()`。真实 SDK 生成并保存 compaction entry；摘要来自本地 provider，`fromHook=false`。
- 这是**输入维护策略自动触发的 SDK manual compaction API**。SDK 阈值自动压缩虽启用，但合成 usage 很小，本矩阵明确断言自动阈值压缩次数为 0。不要与 S3 v2 的阈值/overflow 对照混为一项。
- 失败、取消或压缩后仍超限时恢复未发送输入，停止，不悄悄重复发送；正式 payload 仍经过 B3 最终预算检查。
- 普通/摘要共用最多 16 次本地 API 入口、每入口 128 KiB 外层边界，每任务最多 12 次工具派发和 45 秒。没有 HTTP/真实认证入口；合成 usage 不导出为实际用量，usage 与费用为 null。

设置从独立 agentDir 与临时项目 `.pi` 读取，关闭 retry，不改用户全局 Pi 设置。网络 guard 是可信测试代码的防误调用措施，不宣称 OS 沙箱。

## 命令与证据

```powershell
npm run test:sdk-supervision
npm run eval:sdk-supervision
npm run eval:sdk-supervision:rebuild -- <batch-dir>
```

`run` 创建唯一 `artifacts/harness/sdk-supervision/s4-offline-*/`，记录冻结 manifest、45 个有界 raw、index 与 aggregate。原始未知结果不算 pass；只有预登记的缺能力负例可以继续运行，其他异常停止后续格并记 blocked。命令遇到非预期对照非零退出。

`rebuild` 只读取清单和 hash 匹配的 raw；核对严格 schema、顺序、工具集一致性、工厂清单、记录完整性及机械判断。不重新运行 Agent，也不覆写旧 aggregate。导出扩展的 SHA 冻结在 manifest，再与每格实际加载值比对，避免新 bundle 的函数名称消歧影响旧批次。

测试另有五个故障：摘要报错、摘要取消、摘要仍过大、关闭压缩设置、Supervisor 状态写入失败。它们放在 `s4-fault-tests-*` 中，保留源指纹、五份证据及成功后才写出的哈希 summary，不混入 45 格分母。没有成功 summary 的开发目录不是通过证据。

结果路径、检查数量和各次开发失败保留在 [结果记录](HARNESS_PHASE5_RESULTS.md) 第二十二增量。第二十三增量显式将最终矩阵加入报告，当前选择 13 批；S4 仍保留独立任务分母，五项故障不混入。生成新包 `report-wAl4It`，旧 12 批报告不覆盖。

## 未覆盖

完整小说验证、真实摘要质量、生产上下文估算器的效果、checkpoint 提示投影、完整 Desktop/Rust/RPC、任意崩溃、父 broker 恢复、真实模型自主返工及正式公平效果对照。已有相关单元/历史切片不能拼接成上述全流程保证。B4/Phase X 未实施；新真实调用必须另建清单、预算并获批准。

第二十五增量新增了独立 [S4 真实工装](HARNESS_PHASE5_SDK_SUPERVISION_LIVE_PLAN.md)，使用新的 task/profile/授权入口，不改变本文离线合同。本轮仅做工装离线验收，没有正式模型调用；新演练不混入本文 45 格或统一报告的 13 批分母。
