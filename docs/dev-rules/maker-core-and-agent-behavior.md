# maker-core 与 Agent 行为可控性

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 `packages/maker-core` 中的 Agent 编排、prompt 组装、
> tool／MCP 暴露、translator、event loop、model 映射、usage／token 计量，或任何会进入
> 模型 system 段的提示词之前

本文治理 Cindy 连接 Claude／Codex 等 Agent 的编排核心 `packages/maker-core`。它是所有
Agent 会话的事件流与 prompt 组装中枢，这里的改动会在用户无感知的情况下影响线上行为与
质量。进程边界与 IPC 另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)，
Orca 多 Agent 协同另见 [`orca-team-architecture.md`](orca-team-architecture.md)。

## 上下文已满时的引擎边界

Claude Code 在同一模型上达到设置页自动压缩阈值且尚未满窗时，由 host 注入 `/compact`；
Pi 读取独立的设置页百分比，在每次启动或恢复任务时冻结并写成原生 `compaction.reserveTokens`，由 Pi 按
`contextWindow - reserveTokens` 处理 threshold 压缩，并在 provider 报 context overflow 时按原生
`Agent.continue()` 语义压缩续接。Cindy 只消费 Pi 的 `compaction_start`／`compaction_end` 事件做
UI、usage 与 digest 投影，不再向 Pi 注入 host 自动 compact RPC。

本机占用 ≥ 100%，或 host／bridge 自动 compact 已确定性失败（空摘要、compact 路径上的
invalid-request 400）时，走
`host-controlled rollover + model-controlled bounded retrieval`：host 关闭旧原生窗口、写交接并
在下一次发送前 fresh bootstrap，不再继续 compact。Pi 原生 threshold／overflow compact 出现同类
确定性失败时也锁存 `needsRollover`；手动 compact 失败不锁存。Claude Code 普通用户轮次结束后的静默
`/compact` 与 rewind／cancellation 桥接 `/compact` 必须共用同一套失败分类：确定性失败锁存
`needsRollover`，瞬时失败 `onCompactCanceled` 等下一轮再压。Stop、graceful-stop 或
upstream idle watchdog 打断静默 `/compact` 时只清 fired，不得在本次 compact 收尾立刻再注入。
该锁存只活在当前 live
controller／进程内；重启后没有 live handle 时不凭估算换窗。Orca 空闲 live 直发必须先走与
`sendToSessionInternal` 相同的 `prepareUnhealthySession`，不能把消息打进应被关闭的旧窗口。切到更小窗口模型的 `danger`／`overflow`
预检仍按 `assessModelSwitchContext`，与同模型 compact 解耦。不要关闭 Claude Code SDK 或 Pi 原生
自动压缩。远端 Pi 同样依赖原生 auto-compaction；远端没有本地换窗，确定性失败不得伪装成已交接。
明确 `context-overflow` 且本轮没有助手输出或
工具副作用时，host 才会对失败的 user 消息做一次 wire-only replay；有副作用或分类不确定时必须
fail closed。compact 失败触发的换窗同样 fail closed，不得自动 replay 已有副作用的用户消息。
PI 的 `pi-prompt-timeout` 是唯一保留的 timeout 交接入口；Claude Code／Codex 的普通
timeout 不得触发自动换窗或 replay。Codex 当前没有与 Claude `AutoCompactController` 对等的 host
自动 `/compact` 注入路径；未来若增加，仍须遵守同一评估和交接边界。手动压缩入口不受此规则影响，
手动 compact 失败不得锁存换窗。

> **适用范围与增量原则**：Agent 能力归属（下节 1）与代码优先确定性（下节 2）按增量
> 适用——约束新增和正在修改的代码，不要求为统一形式专项重构存量。但**核心指标不变量
> （下节 3）与 system prompt 改动门禁（下节 4）对所有触及相关路径的改动都生效，不分
> 新旧代码，也不因“只是小改”豁免**。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| Claude system prompt 拼接与 model 路由 | `packages/maker-core/src/agents/claude-code/index.ts` |
| Codex 侧对应实现 | `packages/maker-core/src/agents/codex/`（对应 index／translator） |
| vendor 事件到 `AgentEvent` 的映射 | `packages/maker-core/src/agents/*/translator.ts` |
| 缓存率／token 计量 | `packages/maker-core/src/agents/shared/usage-tracker.ts` |
| Agent 抽象与共用逻辑 | `packages/maker-core` 的 `BaseAgent` 及子类 |

文档与实现冲突时以代码为准，但必须在同一改动内同步修正本文。

## 1. Agent 能力归属 maker-core

- Claude／Codex 等 Agent 的具体逻辑放在 `packages/maker-core`，不在 Main 或 Renderer 里
  重新实现 Agent Loop。Main 通过 maker 调用和访问 Agent 能力与信息。
- 共用逻辑尽量下沉到 `BaseAgent` 抽象方法，子类只实现各自差异部分，避免多 Agent 实现
  各写一套编排。
- 这与产品原则一致：Cindy 负责**连接**而非重造智能，连接层应忠实传递底层能力、工具、
  事件、上下文和结果，不在中间造成无意损失（见
  [`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)）。

## 2. 优先用代码保证确定性，而非依赖 prompt

能用代码保证的行为都写在代码里，让结果可预测、可测试、可调试；prompt 只承担真正需要
语言理解／生成的那部分。

- 判断、分支、校验、状态机、数据结构转换、流程编排、权限控制、错误处理、重试与兜底
  一律用代码实现，不甩给 prompt“自己判断”。
- 打算用 prompt 解决某个问题前先自问：这件事用代码能不能做？能就用代码。
- 把本应由代码保证的确定性逻辑（格式校验、字段抽取、流程跳转、是否调用某个工具等）
  交给模型自由发挥，会引入不可复现的行为漂移，属于本规则明确禁止的做法。
- **产品 turn 未结算不得结束。** provider `turn/completed` 可以立刻给 SDK turn 落墓碑并
  结算 usage；只有原子挂在该终态边界上的显式 continuation claim 才能挡住产品结束。
  Codex `functions.exec` yield 没有协议级 execution handle（cell / wait 活在
  `codex-rs` daemon），近期检测只能是 adapter 内、用真实 rollout fixture 锁死的启发式，
  用来铸造有界 claim，再由宿主确定性开续段让模型 wait 同一 cell。无 `id`／`call_id`
  的 item 只认 `itemCompleted` 快照：`itemUpdated` 不得入账，不得给匿名条目发明身份。
  无 yield marker 的 nameless 完成不得清匿名桶；匿名 `wait` 若按 `cell_id` 结算了其中一个
  cell，只从匿名桶拿掉该 cell，不得清空仍在跑的其它匿名 cell。同 turn 或续段里
  后续 `wait` 输出 `Script completed` / `Script terminated` 后视为该 cell 已结算，不得
  再铸 claim，也不得报 lost-handle。Plan Mode 审批只在产品终态跑：存在 awaiting
  yield claim 时不得把空计划当循环结束，也不得在 SDK `turn/completed` 上提前挂审批；
  origin 已产出的计划挂在 claim 上，续段结算后再审。禁止把 `last_agent_message == null` 或开场白当结算
  判据；cell 跨 turn 存活性未证实前，续段失败必须诚实报 lost-handle，不得 replay 原请求
  或重跑已执行命令。续段 claim 一旦挡住产品结束，所有非重试终态错误路径（不限
  transport）都必须同步结算它，不能只推 Done 而让 `isTurnRunning()` 仍为 true。
  续段 `turn/start` 已被服务端接受后若本地取消，必须先凭响应里的 turn id 落墓碑并
  best-effort interrupt，再抛/返回取消；`wait` 仍输出 running marker 视为 cell
  存活证据，重试预算内继续等，不得当空续段报 lost-handle。
  claim 只归属于铸造它的 origin turn 及其续段 turn；迟到的外族终态（含成功
  `completed`）不得结算、取消、lost-handle 当前 claim，不得发出未认领的
  产品 `done`，也不得结算当前续段的 generation／usage。同一产品 turn 上的
  ask_user／plan 内部续段必须等 yield 空闲后再 `turn/start`，不得并发；Stop／
  close 取消 yield 时，排队中的内部续段必须退出而不是被当成正常空闲继续发送。
  只有 cell 真正结算的成功空闲才能唤醒排队续段；lost-handle、重试耗尽、
  续段 `turn/start` 失败等产品失败必须以 cancelled 释放 waiter，并闩住后续
  `waitForYieldContinuationIdle()`，同时收掉未完成的 ask_user／plan 卡，不得在用户
  已看到失败后再开 ask_user／plan turn。续段启动失败的产品终态只由续段层
  发送一次（`yield-continuation-start-failed`），`handle.send` 不得再发一组
  通用终态。continuation 的 `turn/start` 已被服务端接受、但 RPC 仍 pending 时若
  本地 Stop，墓碑会吞掉随后的 `interrupted`，必须补一条未认领 cancelled `done`，
  避免 Session 仍握着 `currentTurnAttemptToken`。RPC 已返回后由 provider
  `interrupted` 发唯一产品 Done，abort 不得再合成一条。
  续段必须继承铸造 claim 时的 origin 上下文：`turnPermissionPolicy`、
  capability selection 与 auto-review intent。不得把无人值守只读边界重置成普通
  Auto，也不得用固定 wait 提示覆盖原请求的能力选择或审查意图。
  Claude wake continuation 与 Codex yield continuation 先分账，不抽公共模块。

## 3. 守住四项核心数据指标

`maker-core` 的每一行改动都可能拖垮线上指标，而这类回退**不会被 typecheck／lint／单测
发现**，只能靠改动者在 review 前主动评估并实测。落在 prompt 组装、tool／MCP 暴露、
translator、event loop、model 映射、usage 计量这些路径上的改动，必须守住以下四项：

### 3.1 缓存率（Anthropic prompt cache）

命中依赖**请求前缀逐字节稳定**。system prompt 由多段按固定顺序拼接（SDK preset →
`MAKER_SYSTEM_PROMPT_APPEND` → makerMemoryRules → contactsRules（智能通讯录两态段，
与同一次 build 的 MCP 注册同点求值、单次 build 内恒定；remote 会话缺省）→ host `runtimeConfig.systemPrompt` →
per-workdir MEMORY.md index 快照 → per-call userPrompt，见 `claude-code/index.ts`）。禁止：

- 往稳定前缀里塞每轮都变的内容（时间戳、随机文案、易变计数器）；随机／易变内容只能
  进 per-call userPrompt 段。
- 调整各段拼接顺序。
- 在会话中途增删或重排 tool 定义、MCP server 注册。
- 破坏 MEMORY.md「会话启动时快照、rewind 不刷新」的语义。

### 3.2 性能／返回速度

event loop（`AsyncQueue`）与 translator 是**每事件／每 token 都过一遍的热路径**。禁止在
热路径塞同步阻塞调用（同步 IO、大对象深拷贝、灾难性正则回溯、每事件大量临时对象），
禁止在 `handle.send` 路径加额外网络往返或串行 await；保持“先入队、消费端 async 流式吐”
的非阻塞模型。耗时操作走缓存 + 超时 + fallback，不让单次慢操作卡住整个 turn。

### 3.3 返回内容准确性

- translator 必须把 vendor SDK 事件**无丢失、无错序**地映射进已有 `AgentEvent` union，
  不吞掉、不错误合并、不错配 `text`／`thinking`／`tool_use`／`tool_result` 等事件。
- model 路由只走显式版本号，**禁止 `'opus'`／`'sonnet'` 一类裸别名**——二进制升级后
  别名指针会漂到下一代模型，让用户选的版本与实际命中的不一致。
- 任何改变送进模型的 prompt 内容、tool 可用性或权限分支的改动都可能让模型行为漂移，
  必须是有意为之并在 PR 中说清原因。

### 3.4 review 前硬性要求

改动落在上述任一路径时，PR／自测说明必须显式写明：(a) 可能影响哪几个指标；(b) 用什么
方法实测（缓存率改动前后对比、热路径耗时、典型 turn 事件流抽查等，缓存率可用
`usage-tracker.ts` 的 per-turn／session 命中率或 `/context` 对比）；(c) 实测结论。
不许用“看着没问题／应该不影响”代替实测。

## 4. system prompt 改动门禁

**任何人都不得擅自修改 Cindy 的 system prompt；需要改动必须先与仓库维护者讨论
确认后才能动手。** 未经确认的 system prompt 改动一律不许提 PR 或直推。

- **范围**：随每个 Agent 会话下发给模型、决定其全局行为的那部分文本，包括
  `MAKER_SYSTEM_PROMPT_APPEND`、`makerMemoryRules`、host 注入的 `runtimeConfig.systemPrompt`
  等参与拼接 Claude／Codex system 段的各段（见 `claude-code/index.ts` 及 Codex 对应实现），
  以及任何固化在代码／模板／常量里、会进入模型 system 段的提示词内容。
- **原因**：system prompt 是产品行为与质量的“宪法层”，一处改动无差别影响所有用户的所有
  会话，既可能整体拉偏模型行为（LLM 侧改动不可复现、静态检查发现不了），也会破坏
  prompt cache 的前缀稳定性拖垮缓存率（见上节 3.1）。
- **怎么做**：(a) 收到“改 system prompt／调整 Agent 人设／加一条全局指令／删改某段
  system 文本”的诉求时先停下，不要直接动代码；(b) 把“改哪段、改成什么、为什么、预期
  影响（行为 + 缓存率）”整理清楚，主动找 owner 讨论并取得明确确认；(c) 确认通过后再
  实现，并在 PR 说明里写明“system prompt 改动已确认”，附上按上节 3 的实测评估。

## Review 清单

1. Agent 逻辑是否留在了 maker-core，而不是散进 Main／Renderer 重造 Agent Loop？
2. 本可由代码保证的确定性逻辑，是否被错误地甩给了 prompt？
3. 改动是否落在 prompt 组装／tool·MCP 暴露／translator／event loop／model 映射／usage
   计量路径上？落在就必须按第 3 节评估 + 实测四项指标，PR 说明不得留空。
4. 前缀稳定性是否被破坏（易变内容进前缀、拼接顺序变化、会话中途增删 tool／MCP）？
5. translator 是否可能丢事件、错序或错配事件类型？model 路由是否残留裸别名？
6. 是否触及 system prompt？触及就必须先取得 owner 确认，PR 说明写明已确认。

命中 system prompt 未确认、或核心指标路径改动缺实测的 PR 必须阻断。验证命令按
[`desktop-development.md`](desktop-development.md) 选择；指标类回退无法靠静态检查发现，
必须以运行时实测数据为准。
