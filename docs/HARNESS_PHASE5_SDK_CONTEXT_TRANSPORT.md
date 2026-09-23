# Phase 5 S3：普通请求与原生摘要的统一出口（离线预检）

这是 S3 真实测试工装的**传输核心**，不是已执行的真实模型批次，也不是新的 B1/B2/B3 效果矩阵。固定 Pi SDK 0.63.1；普通请求及 `completeSimple()` 发出的原生摘要都经过实际 OpenAI-compatible 序列化和 SSE parser，父进程只提供本地合成 SSE。旧 S3 的自定义合成 API 不替代本次 provider 路径。

当前仅开放 `test / run / recover`。没有 live、prepare、授权参数或 models.json 入口，不读取用户认证；后续仍须接入具体 S3 task/profile 清单、真实配置投影及新的逐批授权。这是有意保留的权限边界，不能复用旧 S2 的余额、清单或费用批准。

## 统一计量

普通 Agent 的 stream hook 不覆盖原生摘要。因此在实际 provider registry 包装入口标记每次调用，再于子进程 fetch 出口把完整序列化请求送到父进程。压缩事件提供 summary 阶段标记，不靠扫描提示词或模型回答猜测。

每次派发依次经过：

1. 校验调用 ID、阶段、endpoint、model、完整载荷大小及输出字段。
2. 从普通/摘要共享的额度中预留份额。
3. 持久化 Journal reserve 和请求类型/请求 SHA 绑定。
4. 实际执行本地模拟 fetch，完整解析 usage。
5. 持久化 settle 后才把响应交还 SDK。

SDK 的 split-turn compaction 可以同时产生两份摘要。本工装最多接收两个并发摘要 offer，实际出口串行派发，避免共享 Journal 并发落盘。等待队列不是已发生 HTTP，不虚报调用数；额度耗尽后队列不再派发。正在发送/响应不明的请求不退款，停止后不能继续普通请求。

普通请求声明的输出上限为 2,048；原生 history summary 为 1,638，turn-prefix summary 为 1,024。按**实际序列化字段**预留，不改写 SDK 的摘要 token 字段。共享 transport 新增显式 opt-in 的 `outputMode=bounded`；Pilot/S2 默认仍要求 exact output，其既有 policy 与调用上限不变。批次总输出预留增加直接检查。

每探针默认最多 6 次请求，完整请求 UTF-8 上限 32,768 字节，总输出预留上限 8,192；单次 5 秒、worker 20 秒。限额/超时探针使用清单中预登记的更低上限。8K 测试模型窗口和合成高 usage 仅用于触发真实 SDK 自动阈值分支，不是用户模型容量或真实 tokenizer 校准；该轨道不据此声称产品预算策略效果。

## 范围与故障

三条成功路径：手动单摘要、手动 split-turn 双摘要、自动阈值压缩，之后各继续一次普通请求。另测试摘要 HTTP 失败、缺失 usage、取消、请求耗尽、第二份摘要额度耗尽、超时及普通请求取消。

单元检查补充批次输出额度、每份摘要输出超额、缓存 null/0/非零、reserve/settle 落盘失败、调用 ID 重用、并发队列取消和 backlog 上限、崩溃后未结算 reserve 只读恢复，以及严格 schema/hash 篡改拒绝。实际 OpenAI 客户端可能试图隐式重试；同一 provider 调用的第二次 fetch 在子进程被拦截，不产生新的父进程请求/额度，单列 blocked retry 数。

Pi 设置与会话仅在隔离临时目录，关闭一般 retry、skills 和资源发现，工具清单为空；不读写私人小说，也不修改生产 UI、Rust 或扩展。父子进程都受网络 guard 保护，worker 环境为白名单。这是受信任测试代码的纵深保护，不是 OS 安全沙箱。

## 运行与证据

```powershell
npm run test:sdk-context-transport
npm run eval:sdk-context-transport -- split
npm run eval:sdk-context-transport:recover -- artifacts/harness/sdk-context-transport/<batch>
```

每探针创建独立不可变目录，包含源码/依赖/提示/设置/政策冻结 manifest、逐请求 reserve/settle Journal、请求类型及 SHA 绑定、脱敏 SDK 结果、hash index 和 aggregate。重建不写文件、不读认证、不补跑请求；缺失/变更的原始证据拒绝重建。hash 是误改/漂移检测，不是防御同机攻击者重新计算所有 hash 的签名。

`contractPassed=true` 表示预登记路径符合机械合同。故障探针的 `requestOutcome` 仍为 stopped 或 unknown，不能称为模型任务完成。`syntheticParsedUsage` 只展示 parser 收到的合成数字；`providerActualUsage` 和 `costUsd` 始终 null，缓存缺失不补零，不据此计算实际费用或节省率。原始请求/摘要文本、认证 header、私密异常均不写公开产物。

最终检查数量、批次及隔离回归见 [结果记录](HARNESS_PHASE5_RESULTS.md) 第十六增量。

## 尚未完成

这个预检入口本身不包含 task/profile 或 live 授权。后续的 [S3 限定任务/新批次工装](HARNESS_PHASE5_SDK_CONTEXT_LIVE.md) 已将 B2/B3 两项任务接入，并提供独立授权；仍只离线验证。真实摘要质量、provider 实际计费、生产 SDK 通道切换、Supervisor/maintenance 独立对照和原生 Desktop 仍未验收。执行任何真实请求前须新的清单及普通+摘要总预算批准，不能复用旧余额，不代表整个 Phase 5 完成。
