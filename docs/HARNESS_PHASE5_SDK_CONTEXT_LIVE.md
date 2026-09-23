# S3 限定任务与逐批真实授权工装

状态：工装离线验收完成后，2026-09-23 首批真实小样本另获批准并执行，四项机械合同均通过。生产 UI、Rust、私人小说和用户 Pi 全局配置不变。完整 Phase 5、自动压缩效果及通用摘要质量仍未验收。

批次为 `artifacts/harness/sdk-context-live/s3-live-t6GSPA/`，manifest SHA-256 `4afa54958f6ba24454a49453da40a8c40a014951f2a966e1a1b70ce04a159d86`。用户在查看清单及费用未知边界后批准执行；27 次真实请求（普通 25、摘要 2），0 unknown/pending，2 次原生手动压缩与 2 次跨进程恢复。只读重建为 `pass`、`sealed=true`，90 个产物 SHA 不变。清单已使用，不能复用剩余额度或重复执行；详见结果第十九增量。

## 固定范围

固定 Pi SDK `0.63.1`，同一 SDK provider 序列化/parser，两个公开合成任务、两个显式版本化 profile，各一次，第二任务反转 profile 顺序：

| 任务 | 机械合同 |
| --- | --- |
| `bounded-read` | 读取公开长文件，利用 Observation 读取末尾页面，核对末尾标记；不写文件 |
| `compact-source-write` | 读取来源 v1，实际原生手动压缩；父进程只修改临时副本为 v2；独立进程打开同一会话，重读来源并写 v2 一次；B3 额外要求 checkpoint refresh 与落盘的写入意图 |

`sdk-b2-context-s3live-v1` 与 `sdk-b3-checkpoint-ops-s3live-v1` 使用既有冻结 factory；后者复用 v2 durable operation 接线。原 Phase 3 runtime 的字节及 Git 对象仍校验。不引入 Supervisor/maintenance，不冒充旧 S3 profile：本切片明确将 context budget 设为 65,536，output reserve 2,048，margin 4,096。

此处 `compact()` 是真实 SDK 的手动原生入口，没有替换 summary hook；恢复是另一个 Node 进程中的 `SessionManager.open()`。不是自动压缩、Rust/RPC/Desktop 或强杀竞态验收。`stale-first` 等故障仅在离线轨道注入；真实模型自行选择工具，不使用脚本伪造决策。

## 逐批授权和预算

- 独立 namespace `sdk-context-live-v1`；4 项任务共最多 **32 次 HTTP**，每项最多 12 次，普通请求和单/双原生摘要共享计数。
- 每项最多 12 次工具调用，seed/resume 合计；只有公开 fixture 的指定草稿目标可写，Canon 不可改。
- 每个请求最多 65,536 UTF-8 字节，同时作为保守输入估算；输出声明上限 2,048，摘要按实际较小声明预留。整批输入预留最多 2,097,152，输出预留最多 65,536。响应若报告超出该次预留的 completion + 单独 reasoning，将停止且不交给 SDK；该保守求和不作为账单口径，不能事后撤销 provider 已发生的计费。
- 90 秒单请求 / 480 秒单任务 / 1,800 秒批次；SDK retry 关闭，底层客户端同一调用的重复 fetch 也拒绝。未知结果不退款、不自动续跑。
- 采用用户参考费率：输入/输出/cache 输入每百万 **$0.75 / $3.75 / $0.075**。完全按无缓存最大预留计算约 **$1.818624**，只是参考，不是实际账单或美元硬限额。cache 缺失保持未知；当前实际费用为 null。
- 新 manifest 冻结 task/profile、源码和依赖树、公共 fixture、SDK 设置、工具/system/prompt 摘要、模型配置投影及 endpoint hash；有效期 24 小时。必须批准精确 SHA 并接受费用可能未知。旧 Pilot/S2 授权与剩余额度不能复用。
- 验证授权后才解析选定 provider 的凭据；子进程只见占位认证和 sentinel 地址，无继承的用户密钥/全局 agent 配置。每次预留前重新核对源码与到期时间。claim 原子排他，不重复使用清单。

模型固定为既有 `gemini-proxy / gemini-3.8-flash-high` 的受限配置投影；此切片预算不改变 Desktop 的上下文容量。只支持已验证的 openai-completions 配置，不能推断其他通道行为。

## 命令

离线，不读取个人模型配置、不请求真实模型：

```powershell
npm run test:sdk-context-live
npm run eval:sdk-context-live:dry-run
npm run eval:sdk-context-live:dry-run -- stale-first
npm run eval:sdk-context-live:recover -- artifacts/harness/sdk-context-live/<batch>
```

用户另行确认测试范围后，先生成新清单（只读取配置投影、不调用模型）：

```powershell
npm run eval:sdk-context-live:prepare -- C:/Users/Silence/.pi/agent/models.json
```

查看该命令打印的 SHA、预算、模型和到期时间，再单独批准。下面是**模板，不代表已授权或执行**：

```powershell
npm run eval:sdk-context-live:run -- artifacts/harness/sdk-context-live/<new-live-batch> C:/Users/Silence/.pi/agent/models.json --approve <exact-manifest-sha256> --accept-unknown-cost
```

源文件有变化或清单过期时必须重新 prepare，不能修改旧清单延长授权。`recover` 永远只读，不访问认证、不恢复网络、不退还未知请求额度。

## 证据边界

只保留摘要布尔值/计数、文件 hash、prepared hash、request hash/type/stage 绑定、durable Journal 和严格索引；不保留原始模型正文、摘要、URL、认证或私人文档。SDK 归一化用量和 provider 原始用量分开，不把 SDK 缺省 cache=0 当成 provider 报告。

离线正常路径可以证明接线和机械判定。故障路径可证明在列明条件下停止或安全阻断；不能证明真实摘要质量、模型通用可靠性、成本节省或整个创作流程完成。

首批真实样本只证明这四项公开任务的模型/工具/摘要/恢复集成按机械合同完成。每格一次，未触发 stale-write 阻断、重复写入对账或未知恢复分支，不据此推断 B3 相对 B2 更优。provider 原始 prompt/completion/reasoning/total 为 71,676 / 979 / 7,201 / 79,856；SDK output 8,180 包含 reasoning。cache 未报告，费用仍为 null，不按满额预算或 SDK 默认 cache=0 填实际花费。
