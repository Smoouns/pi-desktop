# E8：无网络准备与单次授权检查

日期：2026-09-25。范围：为 E8 的 U / C / R 实测准备独立执行清单；不调用真实模型，不读取环境变量中的真实 key，不改生产运行策略或真实小说，不操作 Desktop，不提交推送。初始实现批没有改全局 Pi；后续用户指定变量名后，仅调整了所选 provider 的凭据引用，见下方记录。

## 已实现的边界

1. 仅投影 `gemini-proxy / gemini-3.8-flash-high / openai-completions`。接受环境变量名引用，不执行凭据命令、不接受直接 key / 自定义认证 header。公开产物只保存 endpoint 和引用名的 SHA，真实 URL / 引用名 / key 不进入 worker 或 Journal。
2. 实际固定 Pi SDK 0.63.1 在 payload hook 捕获并立即中止，比较真实配置 URL 与受限占位 URL 的两组序列化结果（普通消息、包含工具历史和 schema 的消息）。输出字段与 compat 必须完全一致；这不是请求远端或证明模型能力。
3. 加载完整当前 v24 扩展与实际 Agent 循环，对 U / C / R 进行无网络演练。worker 的 Fetch 经生产任务账再转 IPC，由父进程逐块返回合成 SSE，SDK 正常解析。14 次捕获不等于 14 次 HTTP：该准备过程网络请求为 0。
4. 新 `prepared-*` 目录中的清单绑定代码、fixture、prompt、oracle、阶段表、工具、设置、生成扩展、worker、Node 可执行文件、锁文件及选定已安装运行 / 编译依赖、模型投影、endpoint 和原始设计预算。准备回执、worker 结果和 Journal 也被哈希绑定；不修改旧 `evals/`、旧授权或封存结果。
5. 24 小时有效、单次使用；`live` 必须提供精确清单 SHA 和接受未知费用的参数。独立无凭据子进程先验证并以 `wx + fsync` 消耗授权，之后才允许发送进程读取所选环境变量。启动还需要第二个不可重复领取的执行凭证。复制目录、改清单、重复启动、过期或源码 / 配置 / 依赖 / 资产漂移均拒绝。
6. 凭据仅交给固定地址的 broker；不重定向、自动重试、命名、模型裁判或自动压缩。普通和原生摘要共用预留账；两个 C 会话共享 8 分钟场景期限。输出原始字节经有界 IPC pull 流交给 SDK，不另写 Agent Loop、不替换 provider 或摘要流程。
7. 必要 usage 缺失、请求异常、越权、超限、取消、日志 / 清单异常均停止整批；迟到的响应头和数据不能恢复请求。只缺 cache 时不重试，也不猜成零，费用仍未知。恢复只读、未知请求不重放、预留不返还。
8. 结果保留机械状态、业务结果、配对覆盖、全部有效估算误差、摘要原文与结构化 / 近期消息 / 最终投影、来源读取证据。摘要质量仍待本地人工审读，不用正确答案替代摘要质量证明；范围仅为扩展纳入预算的 readFile，不是全进程 IO 或省钱率。

这些是对可信测试代码的纵深限制，不是操作系统沙箱；不防止用户手工篡改运行主机。没有验证远端可用性、计费、代理内部重试或上游 reasoning 是否关闭。

## 验收记录

- 首轮准备门禁 9 组通过：`artifacts/harness/review-e8/gate-tests-inRS9y/summary.json`。其中授权领取使用公开虚构配置和合成凭据，不是用户真实批次授权。
- 补充排队取消、迟到响应、缺失 / 重复 usage、输出超额、超大响应、格式错误及单次 permit 检查后的 20 组通过：`artifacts/harness/review-e8/gate-tests-htOgq7/summary.json`。再补共用 C 场景期限及 esbuild 已安装字节指纹后，最终回归 **20 组 / 0 失败**：`artifacts/harness/review-e8/gate-tests-F4xs5G/summary.json`；真实模型、网络请求和宿主环境 key 解析均为 0。
- 现有 E8 SDK / 本机 HTTP 回归 23 组通过：`artifacts/harness/review-e8/offline-8U6zWG/summary.json`。真实模型请求为 0；新准备通道不是把该 loopback 结果改标签为远端结果。
- 原固定目的地址适配器的 **61 项模拟网络断言**通过；没有真实 HTTP。`npm run check`、最终 `npm run check:harness-tests` 及 `git diff --check` 通过（Git 只有已有 LF/CRLF 提示）。
- 完整 Harness **352 例 × 3**通过，`deterministic=true`、失败 0。固定副本：`artifacts/harness/review-e8/harness-prepare-passed-410d85703ce65d09f026febc24877e906a3218c5b4102b5850c87b5d5702ec5d`，保存 summary 和三轮 trace。166 项文件中，165 项字节与当前一致；唯一后续变动是 E8 README 文档，不能写成所有文件均相同。没有新的 Desktop / Rust / 远程 CI 验收。

## 精确清单与批准

### 首次准备的配置阻塞（历史记录，已解除）

首次对用户配置执行 `eval:review-e8:prepare` 时，**在配置投影阶段被拒绝，未生成实际批次 manifest，也未消耗授权**。失败目录 `artifacts/harness/review-e8/prepared-RqccKG` 原样保留，另附不含敏感值的 `configuration-check.json`。

只读诊断确认：选定模型及 API 存在，窗口 262,144、配置最大输出 16,384；地址符合显式本机 HTTP 回环规则，无 URL 内认证 / query / fragment 或自定义认证 header。阻塞项是 `providers.gemini-proxy.apiKey` **不是支持的环境变量名引用**，也不是普通变量标识符或已识别的环境变量插值形式。没有打印其值，没有尝试把它当 key 发送，没有解析环境变量值或执行命令。

当时要求用户提供已设置的环境变量**名称**，不是 key 值。没有猜测或自行修改配置，也没有绕过准备门禁。

门禁测试中的 `prepared-*` 使用公开虚构地址和合成凭据；即使其测试领取了授权，也不能用于真实模型。不能沿用它们或复用历史批次余额。

### 用户指定引用后的新清单（2026-09-25，准备时待批准，现已消耗）

- 用户明确指定 `GEMINI_API_KEY`。已将 `C:\Users\Silence\.pi\agent\models.json` 的 `providers.gemini-proxy.apiKey` 设为该引用；配置语义回读确认只有此字段改变。仅枚举变量名确认当前进程存在该名称，没有读取其值或测试鉴权。
- 准备器 / worker 的环境白名单改为先筛选变量名再读取白名单值，避免在筛选前遍历所有变量值。两条实际源码表达式使用带抛错凭据 getter 的合成环境验证通过，凭据 getter 访问为 0；不使用真实 key 做此检查。
- 小改后测试类型检查通过，门禁 **20 组 / 0 失败**：`artifacts/harness/review-e8/gate-tests-FbE9pc/summary.json`。没有重跑完整 Harness 或声称上一批全部文件仍与当前一致；生产实现未改。
- 实际配置的无网络 prepare 成功；两组原始 / 映射 endpoint 的 SDK 序列化一致，输出字段为 `max_completion_tokens`。U / C / R 完整 SDK 演练 **14 个预留 / 14 个终态 / 14 次同调用配对**，网络请求和真实模型调用为 0；所有应答及 usage 都是合成数据。摘要原文质量仍为 `pending_review`，远端可用性未验证。
- 清单：`artifacts/harness/review-e8/prepared-q4sDJ2/manifest.json`。
- 精确 SHA-256：`21a0caa94d17f6fc8c158ebb76a7261a9504081b35f7b052853e06219b7f7d47`。
- 创建：**2026-09-25 15:57:15.777 UTC+8**；到期：**2026-09-26 15:57:15.777 UTC+8**，单次使用。
- 模型：`gemini-proxy / gemini-3.8-flash-high / openai-completions`；工作窗口 262,144，配置输出上限仍为 16,384，但本批发送参数收紧到最多 2,048，thinking 为 off（不证明代理上游 reasoning 已禁用）。
- 清单绑定 **163 项源文件 / 2,469 项选定依赖文件 / 11 项准备资产**。独立 `eval:review-e8:verify` 通过，SHA 相同，授权未消耗、执行未启动、无 `live` 目录。不得把用户提供变量名当成这份真实批次的批准。

额度：全批最多 24 次、单场景最多 8 次派发；每次最多 65,536 输入字节和 2,048 输出参数，摘要也占额度。按照用户参考价，满额无缓存预留参考 $1.363968（约 $1.36），**不是账单、实际预计花费或美元硬上限**；实际费用保留未知。

本批使用方式见 [工装 README](../tests/harness/review-e-live/README.md)。原设计 JSON 保持 `executable=false` / `authorization.granted=false`，其 SHA 不能用于实际批次授权。代码、模型或有效期变化需重新 prepare 并重新批准，不能沿用旧余额。

### 批准后的首次执行（2026-09-25）

用户回复“允许”后按精确 SHA 单次执行。首个请求 `tools: []`，但响应调用未开放的 `list_dir`；本地未执行该工具，整批在 1 次真实派发 / 1 个完整响应后以 `tool_permission` 停止。U 的第二次提示未发出，C/R 未运行。费用未知，没有自动重试或消费剩余额度。

清单及原报告保持原样；独立 verify 仍通过且授权已消耗，recover 仅只读。原报告在失败收尾时漏导出会话账，补充只读审计从原始持久会话恢复 1 条输入用量配对；不覆盖原报告或把未测项目写成通过。详见 [首次真实结果](REVIEW_E_LIVE_RESULT.md)。

### 首次停批后的离线修复（2026-09-25）

已将失败证据采集移入可容错收尾，并补充非零退出码、明确 `not_run`、reasoning 归一化输出限额及费用未知处理。新门禁 33 组通过；SDK payload 探针同时覆盖空工具、省略工具、带工具历史、显式 `tool_choice: none`。只是本地序列化验证，没有将显式禁止参数应用到当前生产/worker 请求，也不证明代理能力。详见 [离线修复报告](REVIEW_E_FAILURE_RECOVERY.md)。

上述旧清单 verify 通过是执行当时的历史证据；现在代码已经变化，旧授权也已消耗，必须新建清单、重新批准才能再实测。本轮只有公开虚构配置的门禁测试，没有准备用户实际配置的新批次。
