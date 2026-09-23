# Phase 5 封存证据报告

2026-09-23。第三十一增量已将新旧 S4 live 实测接入统一只读报告：**15/15 批复核通过，199 项报告检查，新增模型请求 0**。不改变生产 runtime，也不表示整个 Phase 5 完成。

第三十二增量进一步完成当前版本的全新依赖回归：`isolated-run-RqGXwI`，496 文件、19/19 条命令通过，其中报告仍为 199 项；现有报告包复核 15/15、699 个原证据及 40 个报告文件不变。只回填说明，不改变 builder 指纹或生成新包。

## 使用

```powershell
npm run test:evidence-report
npm run eval:report
npm run eval:report:verify -- artifacts/harness/reports/report-实际生成的目录后缀
```

生成命令会输出一个全新的报告目录，不覆盖旧报告。目录含：

- `report.md`：中文人读报告，先说明范围，再列逐批及 profile × task 状态、真实用量和限制。
- `report.json`：完整重建 aggregate、run ID、状态分类、操作结局、原文件 SHA 与来源指纹。
- `selection.json`：显式选定批次、manifest SHA、整棵证据目录 SHA。
- `builder-sources.json`：这次报告工具和依赖的源码指纹。
- `manifest.json`：报告包自身的文件索引，最后写入，作为封存标记。

verify 会检查报告包、当前报告工具指纹，再从原始批次重新生成并比较 JSON/Markdown。它不是只比较已保存的两个汇总文件。更改工具后请生成新报告，不把新工具重建冒充旧工具复现。

## 选择与计量口径

当前目录是 `evals/report/catalog.ts` 中显式冻结的 **15 批**：保留原 13 批，新增旧未完成的 `s4-live-orlzII` 和新 8/72 合同的 `s4-live-FJMrVf`。来自交接索引，包含旧失败 pilot、真实 S2 格式失败、S4 unknown/未运行格和压力负例。既不自动寻找“最新通过”批次，也不在发现无效批次时跳过。S4 独立故障与其他 dry run 保持在报告分母之外。

这是封存索引的报告，不是全量 artifact 目录的统计抽样。S2/S3 dry run 和统一出口分别选取已登记的代表性批次，**不代表其全部故障探针**；开发期、其他测试探针、临时隔离批次不自动进入报告。若要扩展范围，需要显式审查并更新 catalog，而非复用旧模型额度。

各原验证器仍负责 schema、清单、原记录、Journal 和机械合同重建。module/S1 的清单使用 canonical JSON SHA，其余使用原文件字节 SHA；两种值不混淆。报告额外冻结整个证据目录的文件映射摘要，拒绝一起篡改 raw/index/aggregate 后重新计算的自洽记录。

- `integrity: verified` 仅指证据核验通过，不把任务 fail 改成 pass。
- 没有文件为 unavailable；内容无效为 invalid。仍保留这批及原因码，任务统计留空，命令以非零退出。
- 缺失 aggregate 的旧 pilot 直接重建，不向历史目录补写；已有 aggregate 必须一致。
- 恢复竞态的安全合同 pass 与 `unknown-replay-blocked` 分栏保留；未知副作用不能算写作完成。
- S4 的机械 pass 与 `businessOutcomes` 分栏保留：27 个机械 pass 中，9 项公开候选已验证、6 项只读答复、6 项无进展停止、6 项等待验证；不等于 27 项正文完成。另有 18 个预登记缺能力负例，全部保留；没有人工验收或 Canon 晋升。
- S4 live 另按原 6/54 与新 8/72 合同显示机械状态、业务结局、预留/实际 HTTP、原生压缩及 NO_PROGRESS 分支。旧批 1 pass / 1 unknown / 7 blocked，新批 7 pass / 2 fail 全部保留；七个 pass 不是七项正文完成。
- S4 live 的用量汇总仅覆盖有请求预留的任务，同时显示覆盖项数、零预留及未运行项数；任何有预留任务的某字段缺失时，该字段总量仍未知。零请求任务的原始用量保留 null，不伪造“provider 报告 0”。旧批 SDK 汇总缺失和逐项传输诊断缺失不补造；批次实际 HTTP 仍由原 Journal 重建。
- provider completion/reasoning/total 与 SDK output 分开。cache 缺失保持 null，实际费用未知。
- 用户提供的 $0.75/$3.75/$0.075 每百万 input/output/cache token 单价只作参考，不计算不可靠的实付费用。
- 不合并不同合同的成功率，不排名，不写 token/费用改善百分比。

## 历史打包兼容与安全边界

S3 live 与 S4 live 的验证器以 `Function.toString()` 生成 profile 指纹；合并进另一个 esbuild 入口会改变名称消歧，从而拒绝原合法清单。报告工具将两者分别按**各自原 CLI 的入口图独立打包**，在隔离 Worker 中硬编码只执行 recover，保留原检查，不允许选择 live/prepare、传认证配置或跳过 profile SHA。S4 的 v1/v2/v3 均使用原版本化预算校验，不迁移旧证据。

其余读取直接使用原聚合器。启动器只允许 run/test/verify，清理继承环境，采用隔离的 Pi 目录，并启用离线网络/子进程拒绝保护。Legacy Worker 同样启用保护、限制输出和时间；不启动 SDK 会话、不读取 provider 认证。这里是可信离线代码的纵深保护，不是敌对插件的操作系统沙箱。

目录限制在工作区 artifacts 下；拒绝链接/junction、特殊文件、目录逃逸、额外报告字段、超过大小/文件数上限的输入。错误仅输出固定原因码，不转储未知异常中的输入。

报告包只复制脱敏重建摘要与哈希，**不包含原始会话、认证配置或私人小说，也不是带齐 raw 的独立归档**。原批次缺失时不能完成复核。哈希不是第三方签名；本地检查不是远端 CI。

## 测试与后续

当前测试使用公开合成报告记录，覆盖 **11 种 family、199 项检查**。保留原 105 项投影、缓存 null/0/非零、reasoning、负例/unsupported/unknown、重复 ID、路径逃逸、缺失文件、篡改、链接、旧 aggregate 缺省与确定性重建检查。新增 S4 live 的 v1/v2/v3 原校验器读回、6/54 与 8/72 分离、零请求/缺失用量/旧 SDK null、未知业务与未观测分支、禁止伪造批准，以及重算索引后仍拒绝非法 raw、错误 profile 指纹、伪造 aggregate 和未封存批次。合成报告 fixture 不冒充新 SDK/强杀或真实模型实验。

第三十一增量通过 `check`、`check:harness-tests`、`test:evidence-report` 及真实封存数据的 `eval:report` / `eval:report:verify`。本轮未重跑全新依赖 19 命令链；历史完整回归与当前报告定向检查分别记载，不宣称原生 Desktop 或远端 CI 验收。

## 当前报告包

- 目录：`artifacts/harness/reports/report-CPUudb/`，Markdown/JSON 均包含 15 批，新增模型请求 0。
- 包 manifest 字节 SHA：`aa15c784d12958ca6b1aab02adc5bdfa8915b7a4399fe5f510705ffb219b274d`。
- 选择清单 canonical SHA：`bb6133df71a5b5206347183efe123c2d055b3b2f5a52338628d374a0b97cf47c`。
- 93 个 builder 源码/依赖项映射 SHA：`c4d9c323fcc30e9ab30d20832f0c6e6bb57094339ca8d2debccb955fe000931a`。
- 15/15 从原记录重建核验通过，699 个原文件 SHA 不变；原来 13 批的完整报告项与 `report-UpnFP4` 逐字段相同，旧报告未覆盖。

旧 S4 的 provider total 为 29,531，SDK output 汇总仍未知；新 S4 的 provider total 为 66,166，SDK output 为 6,716。两批 cache 均未知、费用均 null，不合并不同预算合同的成功率或成本，也不将未触发的 NO_PROGRESS 分支当作效果证据。所有请求均是历史计数，不是生成报告时的调用。

## 历史报告与后续边界

CI 与本地隔离脚本已加入 `test:evidence-report`；报告增量时完整隔离链为 17 条，后续 S4 加入后为 18 条。第二十三增量已经完整执行当时的链：`isolated-run-LZyZ3O` 480 文件快照、全新依赖、18 条命令全部通过，含 S4 188 项和报告 105 项；随后只回填文档，代码/测试/配置一致。此前未重跑整链的历史边界保留在 [结果记录](HARNESS_PHASE5_RESULTS.md) 第二十一、二十二增量，不将新结果回填到旧快照，也不宣称远端 CI 或 Desktop 验收通过。

Supervisor / context maintenance 的限定离线对照已由 [S4](HARNESS_PHASE5_SDK_SUPERVISION.md) 交付并纳入报告。第二十五增量因新增 S4 live 脚本改变 builder 指纹，生成 `report-Wsh9Yt`；第二十八增量新增诊断脚本后生成当时的包 **`report-UpnFP4`**，manifest 字节 SHA `3cfd811da7f5e2b783f26d9635a16a34cfa3f03ac419d34e75e10548a22a3b57`。13/13 复核一致，逐批 `files` 映射与上一包相同，557 个原文件不变，新增模型请求 0。旧包均保留，需使用其冻结工具复核，不能以当前 builder 冒充旧指纹。

第二十九增量只修改 S4 live 的版本化预算与兼容读取，不影响报告 builder 指纹或选择清单；现有 `report-UpnFP4` 再次验证为 13/13，未创建新报告包、未扩充报告分母，也没有新增模型请求。

第三十增量在单独获准后执行并封存新的 8/72 批次 `s4-live-FJMrVf`：26 HTTP（25 普通、1 摘要），7 pass / 2 压力负例 fail，0 unknown，92 个文件只读核验不变。其执行记录仍由 S4 live 自身的 recover/diagnose 复核，本轮未修改报告 builder/catalog、未生成新报告或重跑报告测试。

第三十一增量才将两批真实 S4 同时加入显式选择，演练/其他故障批仍不自动进入分母。第三十二增量已完成当前版本的全新依赖回归与交付审查，source manifest 内容 SHA `2bf37508878e513a71a794431a974da141d7291c11d6b7e04712526bad65d263`；本轮不追加模型样本，不提交/推送。历史回归与本次检查分别见 [结果记录](HARNESS_PHASE5_RESULTS.md) 第二十三、二十五、二十八至三十二增量。完整历史 Desktop/RPC、公平大样本比较、人工质量评审和发布验收仍各自独立。
