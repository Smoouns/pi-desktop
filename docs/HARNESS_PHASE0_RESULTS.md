# Phase 0 实施与本地验收报告

日期：2026-09-20。

状态：**代码与本地验证已完成，阶段总闸门待提交后的干净检出及远端 CI。未进入 Phase 1。**

验收依据：[HARNESS_PHASE0_ACCEPTANCE.md](HARNESS_PHASE0_ACCEPTANCE.md)。本报告不将模拟工具、固定检索样本或 trace 计数当作真实模型成功率。

## 1. 基线与执行环境

| 项目 | 本次结果 |
| --- | --- |
| B0 原始提交 | `3b5f8b06131d46ee0b4b97dd646ba3d6f6bcd887` |
| 实现版本 | 同一 HEAD 上的未提交工作树；没有提交、推送或修改用户 Git index |
| 本地环境 | Windows x64，系统版本 `10.0.26200` |
| Node / npm | `v24.19.0` / `11.17.0` |
| Pi loader / esbuild | `@mariozechner/pi-coding-agent@0.63.1` / `esbuild@0.27.3` |
| 测试类型依赖 | `@types/node@25.5.0`，代码使用的 Node API 均属 Node 22/24 范围；Linux 实跑待 CI |
| lock SHA-256 | `961796cae467d5f8f68262865363eb95c484007a5ff2ea76eb7a798fb54d1bf0` |
| fixture 清单 SHA-256 | `60e52c1a3bfebda18b4ec99a9198a31be9082d6367199c57e7ac95cb672fdd55` |
| 模型调用 / 实际模型输入 token | 未调用模型 / N/A |

`artifacts/harness/summary.json` 记录环境、逐文件 fixture 哈希、实现文件哈希、case 状态和三轮确定性结果。哈希读取当前文件字节，不把未提交工作树称为基线原始提交。

新增三个明确的测试依赖并更新 lock；现有 package 的锁定版本未升级。npm 补全了 WASI 可选依赖元数据，并重新标记此前经 peer 解析的依赖。安装时报告 21 项漏洞（1 low、4 moderate、15 high、1 critical）；本阶段没有执行可能带来破坏性升级的 `npm audit fix --force`，这仍是发布前需要单独处理的风险。

## 2. 交付文件

- `fixtures/harness-novel/`：17 个原创合成文件；世界规则、两个人物、001 正典、002 已验收候选、003 未验收候选、章节合同、当前状态、账本、未来条目、oracle 和验收记录。
- `.gitattributes`：fixture 固定 LF；验收指纹按真实读入文本验证。
- `src/harness/types.ts`、`trace.ts`：最小作用域与可注入时钟的结构化 trace；没有 store、supervisor、retry 或 operation ledger 占位接口。
- `tests/harness/`、`tests/support/`：合同测试、IO 故障、真实 RPC bridge 的 mock transport、真实 verifier 子进程、类型检查。
- `scripts/run-public-tests.mjs`：跨平台公共入口；`run-harness-baseline.mjs`：原始/修复后对比；`test-harness-isolated.mjs`：隔离源码快照验证。
- `src/extensions/novel-tools-extension.ts`、`src/novel/context.ts`：测试证明后的最小解析/权限修复。
- `src/novel/context-attachment.ts`、`src/components/chat-view.ts`：把原发送条件抽成生产共用纯函数，不改变正常发送语义。
- `src/rpc/bridge.ts`：仅增加可选诊断回调；旧代过滤、legacy、超时行为保留，诊断回调抛错不会改变桥接行为。
- `package.json`、lock、`tsconfig.harness.json`、`.github/workflows/ci.yml`、`.gitignore`：依赖、命令、测试类型检查、CI 与产物隔离。

没有访问私人小说来生成合成文本；私人 sample 的忽略规则保持不变。真实小说目录、人工验收、晋升和回滚授权逻辑未变。

## 3. B0-raw 与 B0-fixed

执行 `npm run test:harness:baseline`，驱动从 `git show <固定提交>:<生产模块>` 提取旧代码，使用锁定的真实 Pi loader 运行同一组最小探针，再对当前生产模块执行。旧提交没有新 trace API；这是一套新增的外部驱动，不是伪称旧版本原本已有 Harness。

| 探针 | B0-raw | B0-fixed |
| --- | --- | --- |
| serializer 带说明前言，`get_current_document` 读取活动文件 | 失败 | 正确返回活动文件 |
| 项目内文件链接指向项目外 sentinel | 读取到外部内容 | 拒绝读取 |
| `.novel/project.json` 损坏，调用写入 hook | 意外放行 | 写入前拒绝 |

本机真实文件 symlink 与目录 junction 均可创建，未将 unsupported 计为通过。探针 JSON 保存 `sourceHashes`，输出分别为 `b0-raw.json` 与 `b0-fixed.json`。

修复细节：

1. manifest 明确 `active_document`；parser 支持前言、CRLF、字符串/文本块、旧版 `reason: active`。最新 manifest 无活动文件时返回无活动文件，不回退旧请求，也不取第一条记忆冒充当前文件。
2. 普通小说读取和角色写入 hook 检查相对路径、Windows ADS/混合分隔符及逐段链接。保留合法项目内绝对路径的 write/edit；不扩大允许写入的目录。
3. 元数据损坏或经过链接时 fail-closed；普通非小说目录缺少 `.novel/project.json` 的历史行为保留。

**B0-raw 是针对修复的三项失败探针，不是全部新用例的原始性能对照。** B0-fixed 的 24 项测试覆盖范围更大，不能拿二者用例数计算“成功率提升”。

## 4. 合同矩阵与结果

本地 `test:harness`：**24 个执行 case × 3 次，全通过，三轮语义结果和 trace 完全一致，unsupported 子项为 0。** 同一 ID 可以含多个执行场景；REG-01 在单独公共回归入口执行。

| 验收 ID | 证据 / 实际结果 |
| --- | --- |
| CTX-01 | `buildNovelContext → serializer → Pi context hook`；只有最新索引；正文不内联；保留 required/on-demand；UI 隐藏自动块；字符串/文本块均通过 |
| CTX-02 | 活动文件不要求是第一项；前言、LF/CRLF、legacy 通过；无索引/仅记忆/最新无活动文件均不猜测 |
| CTX-03 | 生产发送共用决策函数：首次附加、普通追问不附加、显式 reset 后附加、slash 不附加；非完整 DOM 端到端测试 |
| CTX-04 | 去重、优先级、排除 authority 与路径；首项/固定项允许超软预算；不是模型输入硬限额 |
| MEM-01 | 来源原位修改/删除后旧 ID 拒绝，重检只返回当前版本 |
| MEM-02 | 正文不变撤销验收，以及正文/章节卡指纹变化，均撤销 approved 来源；旧 ID 拒绝 |
| MEM-03 | authority 配置撤销立即生效；配置与文本精确恢复、依赖仍有效时可恢复原 ID |
| MEM-04 | 先证明晚章和无章节当前状态能无界召回，再验证 throughChapter 排除；planned 开关和世界设定例外均明确 |
| MEM-05 | A/B 相同相对路径、不同内容；A 的 ID 在 B 拒绝；两个人的不同身份事实各自可检索，不声称已完成角色知识过滤 |
| TOOL-01 | 真实 Pi loader 发现扩展；生产模块 minify 后取生成的独立扩展，再独立加载并执行记忆往返 |
| TOOL-02 | 正常读取、缺失路径、真实 stale ID、非法参数；冻结现有文本 Error 与 `isError` 差异 |
| SEC-01 | world/plan/write/review、未绑定角色、跨角色路径、Canon/manuscript/.novel、bash；6 次允许、21 次拒绝，拒绝调用的底层模拟副作用为 0 |
| SEC-02 | traversal、外部绝对路径、相似前缀、混合分隔符、drive/UNC/ADS；普通读取和 write/edit hook 拒绝，合法读取仍可用 |
| SEC-03 | 真实文件链接、目录 junction、metadata junction；普通读取、记忆检索与 write/edit 拦截，不返回 sentinel、不写外部路径 |
| RPC-01 | 真实 bridge 拒绝旧代 stdout/stderr/closed 与其他 instance；当前请求正常解决，连接保持；诊断观察者异常隔离 |
| RPC-02 | pending generation、legacy 无 generation、假时钟超时与迟到 response；冻结原行为而非引入恢复 |
| VFY-01 | 真实 TS verifier，002 PASS，报告 chapter/source_text 正确；写报告只改变报告文件，不改变验收/正文或晋升 Canon |
| VFY-02 | 合同失配退出 1/CONTRACT，正文列表污染退出 1/MARKDOWN_LIST；原 fixture 不变 |
| REG-01 | domain / extension / verifier / world-change / memory 五组公共 smoke 全过；保留 12 个写入失败场景，其中 6 个部分写入 |
| FI-01 | 第一次指定读取失败，第二次由测试显式调用后恢复；读取 2 次、故障 1 次、自动重试 0 次 |
| FI-02 | 检索后读取前改变来源，旧 ID 拒绝；重新检索得到新 SHA |
| FI-03 | 与 RPC-01 共用真实旧代投递场景，记录 channel、reason、event/current generation 及操作顺序 |
| FI-04 | 固定正文违禁内容导致实际 verifier 非零/FORBIDDEN_REVEAL；不创建验收/晋升 |
| TRACE-01 | 顺序/时钟可注入、作用域和 snapshot 独立、拒绝嵌套对象/非有限数；三轮一致 |

新增测试未重写 Pi loop；使用的 Pi loader 只加载临时显式扩展路径和 stub context，不启动 provider/session runtime，不读取用户全局扩展。

### 固定样本指标

- 公开 memory smoke：4/4 个固定问题命中预期来源，7 个有效来源、17 个片段。这是样例命中，不是通用 Recall 或人物知情准确率。
- CTX-04：预算 10，选择 `canon/huge.md → canon/pinned.md`，估算阅读 token 合计 210，manifest 528 字符。超预算是现有软预算合同，不当作异常修复。
- 002 verifier：563 个正文字符；两个场景分别 301 / 262；PASS 仅为机械验证。
- RPC 旧代/其他实例丢弃 4 次；每条原因与代际进入上传 trace，未删除代际信息来制造确定性。

## 5. 公共命令与原测试迁移

```text
npm ci
npm run check
npm run check:harness-tests
npm run test:harness:baseline
npm run test:harness
npm run test:novel-domain
npm run build:frontend
npm run test:harness:isolated
```

`npm test` 顺序执行新 harness 与五组公共回归。公共入口不依赖 PowerShell、`.cmd`、全局 Pi 或临时下载 npx 工具；旧 PS 包装器保留兼容，但不再作为公共 npm/CI 前置条件。测试执行器使用锁定本地 esbuild，子进程使用当前 Node。

| 旧入口/断言 | 公共迁移 |
| --- | --- |
| `test-novel-domain.ps1` | Node runner bundle `novel-domain-smoke.ts` |
| `test-novel-tools-extension.ps1` | 原 loader/角色/verify 等断言保留，来源改为公开 fixture |
| `test-novel-verifier.ps1` | 原 PASS/FAIL/合同/路径/警告断言保留，来源改为 002 |
| `test-world-change.ps1` | Node runner 使用原内存 FS adapter；12/6 故障断言不删减 |
| `test:novel-memory` | 原内存合同不变；私人四条 recall 改为原创公开四条，额外断言候选/提案/未来排除 |

### 已执行与待执行

- 已执行：生产与测试独立 TypeScript 检查、新三轮 suite、五组公共回归、B0 对照、Vite production build、`git diff --check`。
- 已执行：隔离本地副本中从零 `npm ci`，再运行 check、测试 check、harness、五组回归、frontend build，全部通过。没有复用原工作区 `node_modules` 或被忽略的私人文件。
- 隔离验证使用“Git 已跟踪文件 + 明确允许的新 Phase 0 文件”快照，保留原提交 Git 对象供版本记录。**它是未提交候选源码快照，不冒充已提交版本的干净检出。** `isolated-summary.json` 明确记录该限制；未提交新文件需要一起提交后由 CI 检验。
- CI 已配置 `ubuntu-22.04 / Node 22`、`windows-latest / Node 24`，执行公共检查并上传 JSON；保留现有 Rust/Tauri job。**尚未推送，没有远端 CI run，因此 Linux 实跑、提交后的干净检出、Rust/Tauri CI 均待确认。**
- Vite 成功，但保留现有动态/静态导入混用与 >500 kB chunk 告警；没有顺便重构打包。

依赖安装需要正常包源或缓存；安装后的确定性测试不需要模型 API/网络。`test:harness` 子进程清除常见 provider key 环境变量，并将 agent 配置目录隔离到临时目录；这是减小接触面，不宣称整个宿主进程具备网络沙箱。

## 6. 产物、隐私与清理

`artifacts/harness/` 被 Git 忽略：

- `summary.json`：环境、哈希、case 汇总。
- `run-1.json`～`run-3.json`：仅元数据、来源版本、计数、结果码与事件顺序。
- `b0-raw.json`、`b0-fixed.json`：原始/修复后的失败探针。
- `regression.json`：REG-01 五组执行状态。
- `isolated-summary.json`、`isolated-*.log`：隔离源码快照的结果及本地安装/构建日志。

每轮同名 JSON 覆盖；临时测试项目、build 目录与隔离 checkout 在 finally 中清理。CI 仅上传目录顶层 `*.json`，不上传临时小说、依赖、安装日志或完整请求；保留 7 天。本机本次 JSON 为几十 KB/轮量级。fixture 每个 case 前后逐文件 SHA-256 对比，测试变更只在临时副本。

作用域 ID 是测试注入的固定逻辑 ID；未向真实项目写 ID。RPC case 的 scope generation 对齐受测代际终点，启动过程中的旧/新代际变化保留在事件 summary。trace 不是生产持久账本，也不证明模型真正理解或阅读了文件。

## 7. 限制与 Phase 1 建议

本次没有实现：统一 typed tool errors、自动 retry/repair、取消传播、未知写入对账、硬上下文预算、Observation Store、Checkpoint、Supervisor、角色知识推理或向量检索。

明确保留的现有行为：

- 选择预算是软预算；required 是提示合同而非已读门禁；历史工具正文仍在历史中。
- 无 generation 的 legacy 事件继续放行，legacy closed 可断开当前实例；超时后的 unmatched response 仍可作为普通事件出现。不能宣称严格代际隔离或未知写入已恢复。
- 世界设定可见不代表角色知情；planned/章节筛选是机械规则，不是完整故事时间模型。
- 受限路径检查覆盖当前小说读取/记忆与 write/edit hook。未沙箱化任意第三方扩展、外部进程或多进程 TOCTOU；未做原生 Tauri FS/桌面交互/真实模型验收。

Phase 1 建议按以下顺序另行立项：

1. 先梳理 Pi 已有 provider retry、工具 loop、abort 的职责，定义 adapter 的 typed result；仅 UI/领域侧需要的策略进入 Harness，避免双重重试。
2. 明确 session / logical run / runtime generation / attempt / operation 关系；首先区分“工具失败”和“写入结果未知”，迟到结果不能变成当前成功。
3. 对受控写入记录意图、目标/来源指纹和 operationId；断连后先对账。没有充分证据时保持 `unknown_outcome`，不凭相同哈希宣称 exactly-once。
4. 将 source SHA、验收依赖、authority 配置和 story-time/knowledge scope 作为有效性依赖；为未来 observation/checkpoint 失效传播服务，不提前引入存储大框架。
5. 为将来的本地 trace/store 明确容量、引用生命周期、清理与敏感 payload 分离；生产持久化另行设计。

**当前停在 Phase 0。需要授权提交/推送并完成公共 CI 后，才能关闭本阶段总闸门；Phase 1 仍需用户另行确认。**
