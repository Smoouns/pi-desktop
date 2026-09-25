# E4：用量校准诊断与压缩保留边界

对应 AUD-05 / AUD-07、REV-08 / REV-14。本批是本地基础设施与确定性回归，不是已经完成真实模型校准或摘要语义质量评测。

## 本批验收合同

1. 将同一次 provider 调用的最终序列化输入估算与其终态 SDK usage 配对；普通调用、压缩、分支摘要分别观察。输入 token 包含 SDK 归一化的非缓存输入和缓存输入，不混入输出 token。
2. 仅完整、单次发送、未重定向、成功且有可用 usage 的样本可成为诊断锚点。重试、缺失 usage、失败、取消、作用域切换不借用旧锚点。未知不变成零，费用仍未知。
3. 锚点绑定项目 / 会话 / 职能 / 任务、模型 / API / endpoint、系统提示、工具 schema、投影及压缩代次；只对严格追加的历史给出增量估算。模型、静态请求或历史改写后失效。校准诊断不降低现有输入预算或授予权限。
4. 诊断有界且进程内：保存标量与摘要，不保留提示词、工具结果、URL、header 或 key；冷启动无锚点。只读状态查询不发起模型调用。
5. 工具裁剪的近期边界覆盖完整 assistant 调用批次；保护错误、未完成批次、待确认工具和非文本内容。保留原调用 / 结果顺序，不修改持久化历史。成功结果被裁剪时保留已有 Observation ID 以继续走来源核验；没有引用时明确要求回源，不伪造可恢复结果。
6. 通过失败复现、工厂回归、完整生产扩展和固定 SDK + loopback 检查这些合同。合成 usage 只验证接线和公式，不当作实际误差或节约收益。

## 尚不在本批关闭的事项

- 用真实模型、同一任务做预登记对照后，才能讨论调整预算估算器；本批不改变硬预算、自动压缩触发阈值或生产重试策略。
- 原生自然语言摘要仍不是当前事实或写入授权。机械保留测试不能证明摘要正确理解了进展、失败原因或被排除方案；有界非权威进展表达和真实长程质量评测仍待后续。
- 不调用真实模型、不控制桌面、不改私人小说或全局 Pi 配置；无新增持久化 schema，也不重写历史计量。

## 使用与实现

- 管理扩展 v22；重启 Desktop 的 Pi 运行时后加载。`/novel-transport-status` 显示最近样本的输入估算 / SDK 输入；`/novel-transport-status json` 的 `calibration` 给出配对诊断。运行中的 `get_context_budget` 也有独立 `calibration` 字段。只读命令不发请求、追加用户消息或恢复任务。
- E3 的持久化任务账仍原样保留；校准样本不是任务总账。校准最多保存 32 条样本、32 个 owner、16 个未结 ticket，每条历史最多 2048 个消息摘要；超出容量时丢弃诊断锚点，不猜测用量。冷进程、会话 / 模型切换会清空；压缩开始 / 完成都会失效，旧样本只供历史诊断。
- 发送出口在最终字符串被预算允许、计量预记成功后建立 ticket，直接观察该 provider 流的终态，避免拿会话累计量与另一份输入对比。每次调用中的再次发送单独计入 E3，但本批不将多次发送的终态用量用作校准。诊断异常不改变发送、重试、取消或预算行为。
- 当前只支持固定 Pi 0.63.1 的 OpenAI-compatible / Google Generative AI。核对本机 SDK `providers/openai-completions.js::parseChunkUsage` 与 `providers/google.js`：两者 `input` 都已扣除 `cacheRead`，因此上下文输入使用 `input + cacheRead + cacheWrite`，不使用包含输出的 `totalTokens`。这是 SDK 归一化口径，不是 provider tokenizer 或代理实际后端身份核验；cache 计费细分与费用仍未知。
- 下次请求只有模型、endpoint 路径、静态参数、系统提示、工具 schema、投影及完整历史前缀一致时才计算 `旧 SDK 输入 + 新旧输入估算差`，仅保存预测误差。没有用单个样本乘一个比例修正所有请求。`appliedToBudget=false`；保护性总输入检查不变。
- 裁剪保留最近结果所涉及的整个工具批次，保护错误批次、未完成 / 重复 ID / 无法配对批次、待确认工具和非文本批次。旧成功结果仅保留有界 Observation ID 和历史标识；引用继续交给现有生产 Context 核验。无 ID 则要求回源，不新增持久化观察库，也不声称整个成功结果仍可恢复。
- 保留错误可能增加压缩输入量、触发预算拒绝，这比抹掉错误原因更保守；本批没有证明延迟 / token 收益。自然语言摘要仍不作为当前事实，任务执行进展的有界恢复表达尚未实现。

## 验收记录

- 红灯：`artifacts/harness/review-e4/context-quality-before-fix.txt`。原有 6 例通过，新增两例分别复现近期并行批次被拆散、错误和未完成批次内容被裁剪；失败记录保留。
- 定向回归 `test:usage-calibration` **11 例**、`test:context-quality` **10 例**、原 `test:task-transport` **10 例**通过；应用 / 测试 TypeScript 通过。另在完整扩展（含 minified）中验证裁剪引用遇到文件改版仍返回 `stale_source`。
- `artifacts/harness/task-transport/e4-H3cTQ1/summary.json`：完整生产扩展 + 固定 SDK 真实客户端 **15 组 / 33 次本机 HTTP**，全部通过；真实模型调用 0、外网尝试 0、服务器断言失败 0。包括两通道的输入 / 缓存口径、普通 / 摘要匹配、重试拒绝校准、缺失 usage、发送前超限、冷重载、三次返回虚假批准文字的原生摘要。最后一组确认原文约束继续交付、虚假摘要不能充当 Canon 授权、Canon 文件字节不变；不把这当作真实语义质量。
- `artifacts/harness/production-lifecycle/d-sxOk6y/summary.json`：完整生产生命周期 **10 组 / 19 独立进程**通过；任务计量跨进程精确恢复，但新进程校准样本 / 锚点为空。此套 provider 没有 HTTP，不因其有合成 usage 就建立锚点；与上一项实际客户端测试分开。
- 完整 Harness **323 例 × 3**，deterministic=true、失败 0；固定副本 `artifacts/harness/review-e4/harness-passed-ac52ab554c6194a53f516050f93e74c5096ac58be4a2066c86a5d63736cb9feb` 包含三次 trace、汇总、领域与长程结果。新增回归没有放宽原有来源、写入、完成或预算断言。
- 小说领域 smoke、前端构建、长程 **1 例 × 3**通过。保留既有 bundle 大小 / 混合 import 提示。HEAD=`cbc5862dad7f302f647d96e5ed338abfd9f8d5ec` / dirty=true；本批没有新增 Rust 改动或测试、Desktop 点击、发布包、远程 CI 或 commit / push。E1–E3 已有改动保留。

测试代码变化单独说明：`CM-GUARD-05` 原 fixture 只有孤立结果，现在按生产协议补上每条结果对应的 assistant 工具调用；仍要求无额外模型压缩、原输入继续且历史不变，未放宽门槛。E3 的冷恢复断言仍严格比较全部持久化字段，只将新增的进程内 `calibration` 分开断言为空。
