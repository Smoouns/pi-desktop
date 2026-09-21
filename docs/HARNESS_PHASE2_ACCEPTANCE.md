# Phase 2 — Observation Store 与请求预算验收清单

起点：`32131274be2964a61d0180088eeb51709ebdb86f`。2026-09-21 用户授权实施本阶段；随后另行授权了边界明确的原生 Desktop 公共合成 A/B 实测，并在确认最终请求闸门暂缓后授权提交、推送本阶段改动。实施与实测均未修改私人小说、Pi 凭据或模型配置。

Phase 1 已完成干净检出验证；[远端 CI](https://github.com/Smoouns/pi-desktop/actions/runs/35564335587) 的 Windows/Linux Harness 与 TypeScript/Rust 三项任务均成功。此前原生 UI 冒烟、后续修复自动化及本次 Phase 2 专项实测的证据分别记录；本次不替代 Phase 1 全量原生回归。

## 实施取舍

- `Prompt.md` 是范围大纲，源码决定接入方式。Pi 继续管理模型循环、重试、会话及 compaction；本阶段不实现 Checkpoint、Supervisor、自动三 Agent 编排、向量库。
- Observation 是有版本来源的工具观察，不是 Canon。原 Markdown、人工验收和角色写权限保持不变。
- 首版 Store 为扩展进程内、有容量上限的不可变记录；项目、会话及角色隔离。同一来源版本和范围只保存一份 payload，每次访问独立记账。重启后旧 ID 失效，必须重读文件，不声称持久恢复。
- 不使用未经验证的跨模型精确 tokenizer。请求以 UTF-8/序列化开销的保守估算和预留量记账，明确标示估算；不把候选文件的 token 数当成实际模型输入。
- Selection 保持现有选材软预算（用户固定资料可超限），Read 为单次运行累计读取/结果限额，Model Input 在每次模型调用边界检查 system/tools/history/observation/new evidence/output reserve/safety margin。Checkpoint 本阶段恒为 0。
- 超预算不得静默删用户指令、系统约束或拆断 toolCall/toolResult 配对。支持按行/标题段落缩小读取，长结果用有界预览和 observation ID，明确是否完整。
- Pi 的扩展事件可能吞掉异常；硬闸门必须测试真实 runner/provider 请求边界，不以孤立辅助函数或单纯 throw 作为阻止请求的证据。不能可靠处理的接口必须记录并保守停止。

## 验收项（先写测试，再修改行为）

- [x] P2-OBS：同 path/SHA/range/payload 去重，访问账本独立；版本/范围变化生成新记录；容量、对象不可变、跨项目/会话/角色和重启失效。
- [x] P2-READ：按行/标题段落/章节/记忆读取；文件过大、非法范围和歧义标题有明确错误；多文件累计预算，非单文件无限叠加。
- [x] P2-ADAPTER：实际 Pi loader（含 minified）长结果变为预览/引用；按 ID 分页读取回源验 SHA，拒绝过期证据，不把未验收内容提升权威。
- [x] P2-DEDUP：带来源的重复读取不反复进入模型全文，保留每次 tool result 与访问记录；历史或不认识的工具输出也不能绕过逻辑请求预算。
- [x] P2-BUDGET：每次逻辑模型请求有分项账本；全部用户/系统约束和工具 schema 计入；预留输出、余量、多字节文本、模型窗口改变、非法数值和非文本输入边界。
- [x] P2-GATE-PREFLIGHT：真实 Pi runner + OpenAI/Google provider + 本机 HTTP 计数证明，逻辑输入超限/接口缺失会在派发前停止（0 HTTP）；取消/项目切换后的旧结果不能占新运行预算。
- [ ] P2-GATE-FINAL（当前路径低优先级，暂缓）：所有 provider 最终序列化载荷的严格发送硬闸门。固定 SDK 的 Google late-abort 仍会发出一次 HTTP，已通过回环测试记录；需要可取消的上游 pre-send 接口，不以异常或畸形 payload 伪装解决。2026-09-21 按用户的条件性取舍，当前使用 openai-completions 代理且前置超额拦截已验证，故暂不修复、不阻塞后续阶段；不据此宣称 Google 通道日常触发概率已测得。转用原生 Google 接口、出现实际最终超额仍发包，或需要严格零发包保证时重新评估；保留现有回归。
- [x] P2-UI：上下文工作台明确标为“选材估算”；只读检查通过 get_context_budget/read_observation 工具提供，不新增可视化预算仪表板，不把 payload 写入 trace。
- [x] P2-NATIVE-SMOKE：在修复版 Desktop 中仅用两个源自公共 fixture 的合成项目完成有限 A/B 人工冒烟；成功覆盖行范围、唯一 ATX 标题段落、长结果外置、重复来源去重、Observation 分页、A 来源变化后旧 ID 过期、B 拒绝 A 的 ID，以及预算成功路径。该项不覆盖原生角色切换、重启恢复、最终 Google 载荷严格硬闸门、远端 Phase 2 CI 或上游模型身份核验；详见 [HARNESS_PHASE2_LIVE_SMOKE.md](HARNESS_PHASE2_LIVE_SMOKE.md)。
- [x] 回归：生产/测试 typecheck、三轮确定性 Harness（120 cases × 3）、五组公共领域回归、B0 探针、frontend build、隔离源码安装验证。
- [x] 交付：实际结果与未覆盖边界单独记录。无真实模型/原生 Desktop/远端 Phase 2 CI 的结果不冒称通过。

当前范围属于 **Observation + 保守请求预检的本地实现**，不等同于全部 provider 最终 payload 严格硬限额完成。详细取舍、验证及待验项见 [HARNESS_PHASE2_RESULTS.md](HARNESS_PHASE2_RESULTS.md)。
