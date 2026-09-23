# S3 进程强杀与迟到结果离线测试

本增量只测试固定 Pi SDK 0.63.1 和冻结的 `sdk-b3-checkpoint-ops-v2` 接线。没有 live 入口、私人配置读取或真实模型请求，不修改历史任务、生产 runtime 或旧封存结果。

## 预登记范围

四种场景各三轮，共 12 项独立公开临时项目。合成提供器通过真实 SDK 调用写工具；父进程读回实际 SDK 会话，确认 issued/dispatched 意图已落盘，再仅对自己创建的测试子进程发送 SIGKILL。不使用工具抛错代替强杀。

| 场景 | 强杀位置 / 恢复后的合同 |
| --- | --- |
| before-effect | 意图已落盘，尚未写入：目标缺失仍保持未知，不允许重放 |
| partial-effect | 只写入部分字节：不能当作成功，也不允许重放 |
| after-effect | 已写成全部字节但未返回工具回执：独立重开后凭 post-hash 对账，阻止重复写入 |
| late-effect | 旧执行器仍是独立存活进程：第一次重开时目标缺失，禁止重放；随后放行旧执行器写入，再次独立重开后按文件事实对账，仍不重复派发 |

每次恢复均尝试两个不同 tool call ID 的相同写入意图，中间执行 refresh，证明 refresh 不清除未知或已满足意图的防重放门。模型决策和回复是合成脚本，不能据此推断真实模型行为。

另外用独立的 adapter 单元测试，在结果指纹读取之前 / await 期间分别触发 abort、generation/session/role/project 切换，共 10 项回调场景；检查迟到回执不写入新检查点，重复回执也不产生状态更新。这是事件适配层测试，不冒充完整 Desktop 会话切换验收。

## 运行与产物

```powershell
npm run test:sdk-recovery-races
npm run eval:sdk-recovery-races
npm run eval:sdk-recovery-races:rebuild -- artifacts/harness/sdk-recovery-races/<s3-races-batch>
```

单个子进程最多 30 秒，单项最多 90 秒；全部子进程使用网络守卫和隔离 Pi 设置。最终只保留白名单布尔值、计数、状态及 SHA，不保留原始会话、提供器正文或完整请求。manifest 冻结源码/依赖树、公开 fixture、场景顺序和扩展摘要。遇到非预期失败停止后续场景，已观察到的部分证据保留为 unknown，不改成 pass。

机械 pass 表示恢复规则成立，不代表写作任务完成：缺失与部分写入仍标为 `unknown-replay-blocked`；只有实际字节匹配才是 `satisfied-by-readback`。费用和 provider 用量为 null。

最终独立测试批次 `s3-races-ow4RXU`：125 项检查通过，12 项受控强杀合同全部 pass；实际强杀 12 次、独立重开 15 次，恢复端派发写入 0。最终 6 项按文件事实对账完成、6 项仍为未知并安全阻止重放；另有 3 项迟到写入的中间恢复阶段保持未知。15 个 JSON 产物只读重建一致，SHA 不变。manifest SHA-256 为 `92da2b35260ccb5002035c7f177fd212a44a958a9ba772bc9a016995e7d92823`；详细回归及证据见结果记录第二十增量。

## 证据边界

本轮是受控屏障处的实际进程强杀，不是任意 CPU 指令处崩溃、机器断电、文件系统 fsync 持久性、父 broker 被杀、外部系统幂等保证或 Rust/RPC/UI 验收。不调用压缩入口，不能将旧压缩测试与本轮强杀测试拼成完整端到端证据。外部执行器可能继续产生副作用；本合同保证恢复端不会再派发同一意图，不声称能撤销已经发出的外部动作。
