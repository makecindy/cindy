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
