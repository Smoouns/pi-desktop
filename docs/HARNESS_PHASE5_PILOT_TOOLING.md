# Phase 5-B 前置工装：SDK 演练与受控真实调用入口

本增量实现真实 pilot 前可独立验证的工装，**不授予 API 调用权限，也不是 Phase 5-B 真实模型实验完成**。生产前端、私人小说、全局 Pi 配置与登录信息均不属于本次修改目标。

## 入口

```powershell
npm run test:pilot
npm run eval:pilot:rehearse
npm run eval:pilot:rebuild -- artifacts/harness/pilot-rehearsals/<batch-id>
```

以上三个入口仍只运行离线测试、演练、只读重建，不解析真实凭据。`rehearse` 的数据源是代码内的固定合成 OpenAI SSE，**工具选择与最终答案由脚本指定，不用于评价模型推理或任务质量**。另行提供受控 live 入口，见下文；离线路径没有真实 fetch 回退。

与只替换 SDK stream 的单元测试不同，这条演练路径经过固定 Pi SDK 的请求序列化、OpenAI client、传输限额、SSE usage 提取、SDK parser、生产小说扩展和临时文件读写。`P5P-READ-001` 读取公开世界观与会话预算；`P5P-WRITE-001` 只写并读回一份固定探针文件。每项脚本响应产生三次模拟请求，真实 HTTP 为零。

## 已实现的边界

- worker 启动前固定独立 agentDir；只传环境变量白名单。生产扩展按精确路径加载，不发现用户 skills、AGENTS、其他扩展或历史会话。重试、压缩、自动命名关闭。
- 网络与子进程阻断作为离线纵深防护。SDK 的 fetch 仅替换为带 gate 的内存响应函数，不保留真实网络实现；这不是运行不可信代码的 OS 沙箱。
- 单任务最多 4 次、单批最多 8 次请求；精确目标、POST、唯一 2,048 输出字段、完整序列化请求字节估算、输入/响应体大小上限、超时、sticky stop 和隐藏 retry 拒绝。
- 使用 AsyncLocalStorage 区分模型 invocation，同一 invocation 第二次 fetch 即拒绝，不按提示词或正文相似度判断重试。
- usage 观察器只提取数字白名单，缺失不填零；传输层在完整有界响应和必需用量字段核验后才交给 SDK，因此缺失 usage 的响应不能先执行写工具。当前缓冲最多 256 KiB，不用于流式 UI 性能测试。
- 精确工具、参数、路径、次数与文件 SHA 检查；不验收章节、不生成 verifier PASS、不晋升 Canon。`.pi/settings.json` 是显式基础设施新增文件，不忽略整个 `.novel`。
- manifest 在模拟派发前独占写入，绑定源码、lockfile、实际安装 SDK/provider 字节树摘要、任务/工具指纹、fixture、限额与离线授权。准备阶段不 prompt；执行前后检查源码与原始 fixture 未变。
- 记录区分 `realHttpDispatches`、`simulatedHttpDispatches`、合成 SSE 原始 usage 与 SDK 标准化 usage；两者一致性单独检查。所有使用量均标注 synthetic / providerActual:false，不能做真实 token 或费用结论。
- 公开产物只有数字、状态、检查结果和 SHA，不含完整请求、回答、思考、认证 header、真实端点或私人正文。临时 SDK 会话仅在隔离工作目录中存在，结束后清理。

## 产物与失败

批次保存在忽略目录 `artifacts/harness/pilot-rehearsals/<unique-id>/`，包含 `manifest.json`、`runs/`、`result-index.json`、`aggregate.json`。每次运行新建目录，不覆盖失败批次。重建拒绝缺文件、额外记录、链接、哈希不符、无证据 PASS 和越界预算。

旧 `rehearse` 的 worker 异常时将任务记为 unknown，阻止后续任务并封存可用结果。若 worker 没能交回结果，模拟请求的确切数量不能恢复；旧记录不能移作 live 证据。新的 broker 路径使用下面的独立逐请求 Journal。

## 新入口：先准备，后授权，单批不可重跑

```powershell
# 零真实网络：走同一个 broker / IPC / SDK / Journal 路径
npm run eval:pilot:dry-run

# 仅在决定开始准备真实批次时执行；只读指定配置，不解析 key、不发请求
npm run eval:pilot:prepare -- "C:\Users\Silence\.pi\agent\models.json"

# 当次明确同意模型、两项任务、最多8次HTTP且费用未知后才执行
# <batch-dir> 和 <manifest-sha256> 必须来自刚才 prepare 的输出，不能复制 dry-run 的值
npm run eval:pilot:live -- <batch-dir> "C:\Users\Silence\.pi\agent\models.json" --approve <manifest-sha256> --accept-unknown-cost

# 任意中断后只读核查；不重发、不补写、不恢复执行
npm run eval:pilot:recover -- <batch-dir>
```

初始工装开发只执行离线命令。首批获批真实测试 `live-CwHPbD` 在 3 次请求后因答案校验失败停止。细分诊断与提示澄清完成后，用户再次明确批准 `live-mHOnDl`；**新版两项任务均通过，共 6 次真实请求，无重试**。两批分别保留原记录，见 [结果记录](HARNESS_PHASE5_RESULTS.md#第八增量新版最小真实-pilot-通过)。此处的操作说明不是对后续新批次的授权。

- live manifest 有效期 24 小时，冻结精确模型/API/兼容设置、工作窗口、2,048 输出参数、8/4 次限额、源码与安装依赖摘要、fixture、工具/角色/有效 system 指纹、关闭重试/压缩等设置。只持有 endpoint/config SHA，不公开 URL 或 key。实际 SDK 增强后的 system 指纹会规范化临时项目绝对路径和当前日期，每次 provider 调用前复核；不是完整原始 system 字节不变的声明。
- 批准必须匹配 live manifest 的完整 SHA，且显式接受未知费用。dry-run 清单、过期/漂移清单、缺少批准均拒绝。代码或有效配置变化需重新 prepare。没有真实费率时 `costUsd` 始终为 `null`，不能声称免费或保证金额上限。
- 只读解析选定 provider；环境变量和字面量认证仅供 broker 私有内存使用。不执行 `!command`，不加载 OAuth/自定义认证 headers，不改全局设置。启动器仅向 broker 转交选定环境变量，绝不向 SDK 子进程传真实 URL/key。
- broker 是唯一可出站组件：固定 HTTPS 或本机回环 HTTP、POST 和完整 endpoint（协议、主机、端口、路径），禁止重定向、其他目标、通用网络回退。HTTP 仅接受原始字面主机 `localhost`、`127.0.0.1`、`[::1]`，拒绝远程/局域网 HTTP、数字别名、编码主机名及反斜线变体。`localhost` 固定解析至 `127.0.0.1`，不查询 DNS 或尝试其他目标；仅监听 IPv6 的服务须明确配置 `[::1]`。子进程先加载离线网络/子进程阻断器，再初始化 SDK；仅通过 IPC 提交有界 request body。broker 忽略 SDK 的认证 header，用自己的固定凭据出站。这些是受信代码的纵深防护，不是 OS 沙箱。
- 两任务共用同一 gate 和 Journal；每次请求先独占写入并 `fsync` 预留事件，才可派发；完整有界 SSE/usage 核验及完成事件持久化后才交给 SDK，因此缺 usage 时不能先执行工具写入。
- `claim.json` 永久占用该批次；成功、失败、崩溃都不能重跑或并行抢占。request quota 无 reset。reserve 后丢回执记 unknown，仍保留整个输出预留；中断后只能 recover。若要再次实验，另获确认并创建新批次。
- task 记录只含固定状态/检查项、用量数字与文件 SHA。provider 原始数字与 SDK 标准化数字分栏，cache/reasoning 不强行重算成同一口径。Journal 哈希链与结果索引可只读重建，缺失/未知不会成为通过。

新产物在忽略目录 `artifacts/harness/live-pilots/live-*/` 或 `dry-run-*/` 下，包含 `manifest.json`、`journal/claim.json`、独占事件文件及结束索引、`runs/`、`result-index.json`。临时 SDK 会话及项目副本由启动器在结束时清理；强制杀进程可能留下 `.pilot-build-*` 临时目录，不能公开其中原始会话。清理只针对经 realpath 核验的本次临时目录。

## 尚未验证

- 当前代理在新版最小 pilot 的 READ/WRITE 两任务均已通过；认证、连通、该批 SSE/usage 解析、最终答案和精确文件读写已有实测。缓存/推理计费语义和上游账单仍未核验，不能外推所有模型与代理版本。
- 代理是否遵守输出上限、代理内部重试、实际价格/账户限额。客户端最多 8 次派发不等于供应商内部恰好 8 次处理，也不能撤销已派发费用。
- 真实模型质量、全栈公平 baseline 消融和原生 Desktop / Rust bridge 发布验收。当前没有做完整 OS 进程/电源故障测试；已有 durable reserve 恢复及 SDK/网络故障注入。

## 答案诊断（新 broker task record V2）

`answerDiagnostic` 从 SDK 检查经 IPC 写入任务记录，并由 `recover` 展示；只包含版本、任务 ID 与固定原因枚举，没有原始回答、思考或解析异常文本。原因组合最多两项（事实字段与签字字段可同时不符），schema 会检查任务对应关系及与 `finalAnswer` 的一致性。

| 原因码 | 含义 |
| --- | --- |
| `ANSWER_OK` / `ANSWER_NOT_EVALUATED` | 通过 / 未执行到答案检查 |
| `ANSWER_EMPTY` / `ANSWER_MARKDOWN_FENCE` | 空回答 / 完整 Markdown 围栏包裹 |
| `ANSWER_JSON_INVALID` / `ANSWER_JSON_NOT_OBJECT` | 不能直接解析为 JSON / 根节点不是对象 |
| `ANSWER_STORM_MISSING` / `TYPE` / `VALUE` | `canPredictStorm` 缺失 / 不是布尔值 / 事实值不符 |
| `ANSWER_SIGNERS_MISSING` / `TYPE` / `MEMBERS` / `ORDER` | `signers` 缺失 / 非字符串数组 / 成员不符 / 成员相同但顺序不符 |
| `ANSWER_READY_MISMATCH` | WRITE 最终回答不是 `ready` |

保留严格规则：不自动去围栏、修复 JSON 或调整数组顺序。READ 提示现明确要求纯 JSON，签字数组遵循源文件的出现顺序；不内联预期答案。V1 历史记录和旧 rehearsal 格式保留，不能事后为缺失的原始回答补原因或改判。

`live-CwHPbD` 失败后封存；诊断升级后的 `live-mHOnDl` 另获批准并以两任务通过结束。两批均只能 recover，不能重跑，也不自动消费剩余额度。后续正式全栈对照需要另定范围、冻结清单并获得授权；本次最小 pilot 不等于整个 Phase 5 完成。
