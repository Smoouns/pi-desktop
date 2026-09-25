# E8：U/C 显式禁止工具的新版联合验收

2026-09-25。本文记录测试工装、离线回归和新清单准备阶段；该阶段**不调用真实模型**。后续用户批准的新批次已执行：第 3 次请求输出用量超额，整批停止，授权已消耗。见 [真实执行与只读核对](REVIEW_E_JOINT_TOOL_NONE_RESULT.md)。旧失败批次和单请求诊断授权也不能续用。

## 改动范围

- 新 `joint-tool-none` profile、独立 `joint-tool-none-*` 目录和清单类型，设计见 [新计划 JSON](REVIEW_E_JOINT_TOOL_NONE_PLAN.json)。原 `joint` / 单请求 `tool-none` profile 和两份历史 JSON 不覆盖。
- U 两次普通请求，C 独立对照回答、原生双摘要和压缩后回答，均添加 `tool_choice: "none"`。普通请求仍为 `tools: []`，原生摘要仍省略 tools；只增加一个字段。
- 摘要不经过 `before_provider_request`。新 profile 在隔离 worker 中、生产计量包装之前，装饰已有 provider 的 `onPayload`，不替换 provider 注册身份、返回流、响应解析器、原生摘要算法或完整生产扩展。
- 普通审计和最终请求预算均能看到修改后的 payload；不能在预留之后偷偷改请求体。修改前后 SHA 和最终 body SHA 必须逐条对应，报告缺少证据时退出非零。
- R 不安装该装饰，保留六个只读 / 检查工具及原工具参数；正常生产 Agent 不改。U/C 的原始 SSE 若出现工具调用或旧 `function_call`，立即停批，不开放工具、不再追加发送。
- 原提示、独立 C seed、host-only oracle、R 的同长度 v1→v2 来源变更均保留。普通与摘要调用仍由完整生产扩展记账；合成答案只能验证管线，不证明真实摘要质量。

## 额度与安全边界

模型仍是 `gemini-proxy / gemini-3.8-flash-high / openai-completions`，窗口 262,144；不改用户配置。

- 全批最多 **24 次**，每个 U/C/R 任务最多 **8 次**。C 的独立对照与处理共用任务额度和时限；最多 2 次摘要也计入额度。
- 单请求输入最多 65,536 UTF-8 bytes，输出预留 2,048；累计输入上限 1,572,864，累计输出 49,152。字节预留不是供应商 tokenizer。
- 请求 90 秒、任务 8 分钟、批次 25 分钟；响应最多 256 KiB；R 最多 12 次工具执行。U/C 活动工具为零，这个共用数字上限不授予工具权限。
- 不重试、自动压缩、生成标题或调用模型裁判；任何运输、权限、必要用量未知、额度或冻结输入变化都停批。失败和未知请求不返还额度，不重放。
- 准备与核对不解析真实环境凭据、禁止联网；测试使用公开合成数据和隔离项目，不改全局 Pi、真实小说或生产预算。
- 新清单有效 24 小时，精确 SHA / 单次批准 / 独立费用未知确认；消费授权后才允许读取所选环境变量。

按用户参考价格，满额无缓存预留参考 **$1.363968**，不是实际账单或美元硬限额。缓存缺失或 positive reasoning 的计费口径不明时，费用继续未知；SDK 价格为 0 不能当免费。

## 离线回归

- 新 profile **16 组 / 0 失败**：`artifacts/harness/review-e8/joint-tool-none-tests-GxeVEw/summary.json`。完整扩展 14 次合成请求，4 普通 + 2 摘要明确禁用工具，8 次 R 工具能力不变；14 条 input/output 用量配对，来源新鲜度、独立 seed 和 Canon/验收哨兵通过。
- 包含 U 工具 / legacy 调用，C 对照工具调用，摘要工具 / legacy / HTTP 400，以及 C 最后回答工具调用等 7 个完整 SDK 停批分支；并发摘要中未派发的另一次预留不会变成额外发送，R 始终 `not_run`。
- 另覆盖装饰调用顺序和原生流身份，错误配置与 payload 拒绝、6 项 broker 发送前拒绝、8 项缺失 / 污染证据、清单复制 / 置换 / 漂移、费用与单次授权。授权测试仅用虚构配置，不是用户批准。
- 首轮 `joint-tool-none-tests-61DW2q` 为 **15/16**：HTTP 400 实际正确停批，但新测试把现有错误码 `http_or_content_type_error` 误写成 `http_error`。仅修正断言后重跑，首轮证据不覆盖。
- 原准备门禁 **33 组 / 0 失败**：`artifacts/harness/review-e8/gate-tests-uV1uVW/summary.json`；原单请求诊断 **16 组 / 0 失败**：`artifacts/harness/review-e8/tool-none-tests-fMVr9Q/summary.json`。原 joint 仍不添加 tool_choice。
- 原 SDK / 本机合成 HTTP **23 组 / 0 失败**：`artifacts/harness/review-e8/offline-5EYecv/summary.json`。本机合成 HTTP 不等于真实模型调用。`npm run check`、`npm run check:harness-tests` 和普通 `git diff --check` 均通过。
- 两个历史实测批次各 8 项证据 SHA 均未变化；与上一份已消耗清单逐文件对比，139 项生产源码 / 冻结评测输入未变。历史批次不会因本轮准备获得新授权；工装源码已变化，旧源码指纹不再适用于再次执行。

不新增 Desktop / Rust / 安装包 / 远程 CI 或真实模型质量结论，不提交推送。真实联合验收及人工摘要核对仍未完成。

## 准备与核对命令

```powershell
npm run test:review-e8:joint-tool-none
npm run eval:review-e8:prepare-joint-tool-none -- C:\Users\Silence\.pi\agent\models.json
npm run eval:review-e8:verify -- <新清单绝对路径> C:\Users\Silence\.pi\agent\models.json
```

当前 SDK 日期、隔离路径和会话标识会在运行时生成；不声称 probe/live 请求完整字节相同。代码、静态输入、预算和所选配置被冻结，最终实际 payload 另留 SHA。

只有用户看到下列信息及费用边界后另行批准，才进入 live。

## 新清单（以下为准备时状态；后续已执行并消耗授权）

- 路径：`artifacts/harness/review-e8/joint-tool-none-XbVP5l/manifest.json`。
- SHA-256：`1c77cdb7c7b4d3c068003e23e06dc32b0d0d7f634182f9f2d60fd47e1adf18fa`。
- 创建：**2026-09-25 17:33:59.271 UTC+8**；到期：**2026-09-26 17:33:59.271 UTC+8**，单次使用。
- 使用用户当前所选模型配置完成零网络准备，独立 `verify` 通过；冻结 173 项源文件、2,469 项选定依赖和 11 项准备资产，以及 Node 可执行文件与配置指纹。
- 14 个合成预留 / 14 条原生 input/output 配对，4 个普通请求及 2 个原生摘要明确禁用工具，R 的 8 次请求工具策略不变。四个阶段均完成，摘要质量仍 `pending_review`，不记为真实模型通过。
- 输出字段已核实为 `max_completion_tokens`；每次最高 2,048，24 / 8 次请求额度不变。cache 或计费口径不清时费用未知，满额无缓存参考 $1.363968 不是美元硬限额。
- 授权未消耗、执行未开始、无 `live` 目录；本轮真实模型请求 / 网络请求 / 真实凭据解析均为 0。未提交推送。
