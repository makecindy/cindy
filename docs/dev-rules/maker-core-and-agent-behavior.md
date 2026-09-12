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
自动 `/compact` 注入路径；未来若增加，仍须遵守同一评估和交接边界。Codex 订阅远端压缩若因
`invalid_encrypted_content` 硬失败（`Error running remote compact task`），视为官方 compact
确定性失败，走同一套 host-controlled rollover；单独的 `invalid_encrypted_content`（HTTP 静默剥
推理密文范围）不得当成换窗。手动压缩入口不受此规则影响，
手动 compact 失败不得锁存换窗。

Cindy 保底压缩是**一套**流程，不是剥图 / 换窗两套功能。装得进当前约束就不动；
字节预算破了（可剥的超大内联图）就剥图；token 预算破了或剥图失败，就交接重建。
决定函数见 `cindyContextCompression.ts`。字节预算目前只有 Codex 能测量。工具输出
不另开一档：官方 compact 会先清旧工具结果；官方失败后交接不带 tool_result 正文。
可剥图不足一半的混合大尾巴有意不救。打开会话不触发；只在终态错误或下次发送时
由 main 侧 claim。SSH 不承诺。不确定 fail closed。救援摘要不得依赖额外模型调用。
Codex 剥图保留原生历史后，普通用户任务可在同一任务内自动续接未完成工作，
不重放原用户请求或已完成的工具操作；每条用户输入最多自动续接一次。
停止／清空或新输入接管会取消待续接的恢复；已有排队输入时不抢先续接。
取消也覆盖剥图失败后的重建、提交与发送边界。interrupt／unsubscribe 等待期间到达的
权威成功结果优先于 oversized 错误；事件队列关闭前统一结算，不能再触发自动续接。
续接沿用原输入的插件能力选择，不把隐藏续接提示或历史授权当作新选择。
外部分发者仍拥有自己的重试；IM 原生任务、仍绑定 IM 的任务及尚未结束的外部分发 turn
不进入 Desktop 图片历史自动恢复，不以缺失消息 origin 推定桌面授权。成功仅展示上下文整理分隔条，
恢复或续接失败才显示错误与手动继续指引。发送前恢复不额外续接，避免与用户新输入重复。
切模型预检的数学仍在 `assessModelSwitchContext`。本机普通任务的用户选模只登记待应用意图，
不改当前 route 或原生线程；用户反复改选时覆盖意图，以实际发送时的最终选择为准。
沿用跨引擎的 pending registry 与发送入口，不能在 turn 结束或定时巡检时自动消费选模意图。
设备互联控制本机任务同样适用；SSH 与 Orca 保留各自的运行时边界。
同引擎切到更小窗口时，main 在实际 send 持有的 session 锁内按目标窗口评估；
用户发送即同意为最终选择执行必要的上下文整理，不再弹出二次确认。
仅选择或反复切换模型不构成整理授权；同窗或扩窗不因此触发摘要重建。
Claude Code／Codex／Pi 的强制换窗线
统一固定为目标窗口 90%，与各 harness 的日常 auto-compaction 百分比解耦；Claude Code
与 Pi 的日常默认值也设为 90%，对齐 Codex 口径，但用户已有显式 override 继续生效。命中
`danger`／`overflow` 的本机会话先走同一套 `context_rebuild` bounded handoff，再落目标
route，不能 resume 旧原生窗口。
Codex 跨凭证时先按目标来源 resume 同一个原生线程，不因 `ordinal` / `history_base` 或来源
变化而 fork、改写历史或交接。本地恢复与分叉必须同时固定该线程的原生历史根
（`CODEX_HOME`，含 `sessions` / `archived_sessions`）和数据库根（`sqlite_home`）；
仅固定 SQLite 不足以恢复分页祖先，原生按不可变 rollout ID 在历史根内查找祖先。
凭证、代理路由和模型目录仍按本轮选中账号准备，不能把历史根写回全局账号配置。
跨历史根的原生进程从启动参数要求 `cli_auth_credentials_store="ephemeral"`，清除继承的
原生身份环境变量；OAuth 通过独立的 external-auth adapter 在进程内安装目标账号 token，
网关与第三方 OAuth 继续使用既有代理认证。所有跨根进程在分发任务前检查生效的临时凭证
配置；每次重连重新认证，刷新必须匹配冻结的 owner、host 代次及账号，且不能复用刚被
拒绝的 token。owner 切换 pending 期间，即使 owner key 尚未提交变化，也必须在异步认证
读取前后拒绝提供 token。刷新有超时，失败走正常错误路径，不切回历史所属账号。
该 adapter 依赖 Codex 实验性的 `chatgptAuthTokens` 协议，0.145.0 已支持该协议且通过
真实登录及 401 刷新契约验证，不能把 0.153.4 当作协议最低版本。更换原生运行时前必须
用目标二进制运行 `CINDY_CODEX_TEST_BINARY=<绝对路径> pnpm --filter @cindy/maker-core exec
vitest run src/agents/codex/app-server/external-auth.native.test.ts`，覆盖分页祖先、归档、
分叉、重连、实际请求身份和 401 刷新。测试只用临时历史、假凭证和本地 HTTP 服务。
管理员 requirements 可能覆盖 CLI 临时凭证设置：客户端可阻止后续任务，但启动后的
配置检查不能证明原生初始化阶段从未读取历史根中的认证；不得声称具备这一保证，
也不得自行复制上游策略加载器或改写用户认证文件规避策略。
普通加密推理失败继续使用现有 HTTP 透明重试；只有上游明确
拒绝且请求里仅剩不可剥除的压缩块密文时，proxy 才标记
`CINDY_ENCRYPTED_COMPACTION_INCOMPATIBLE`，交给既有 compact 失败恢复流程。
裸 `invalid_encrypted_content`、网络错误和切换来源本身都不足以触发该恢复；保留同一用户消息
最多一次重放及已有产出／工具副作用禁止重放的边界。
跨来源恢复必须在共享、独立上下文和控制面代理中按同一 thread 身份查找并关闭连接，
关闭任务时也清理这些实例里的同 thread 保活状态；不能只查共享代理而漏掉实际承载连接。
分支优先使用已保存的原生 turn 锚点。Codex 0.153.4 起，旧消息或失败轮没有锚点时，
先用 `thread/turns/list(itemsView: notLoaded)` 查询终态边界，再 `thread/fork(lastTurnId)`，
不能对分页线程执行 rollback。界面软删重试不代表原生 turn 消失，有复制事件时间时据此
定位，不按可见 user 行数猜边界；复制事件时间缺失、原生时间缺失或秒级精度无法确定顺序时明确失败，不截错
历史。查询与 fork 使用同一隔离控制面 host，关闭其写入进程后才发布子线程身份。
HTTP 回退遇到缺失 `Content-Type` 的成功响应时，只允许从明文 SSE 前缀（可带注释心跳）
确认事件流并补齐响应头；显式非 SSE 类型、HTML／JSON、空响应与只有心跳的正文不能放行。
正在运行的 turn、SSH 远端缺少本地交接能力、或已有恢复动作在途时必须 fail closed，不能
先热切再发送。三个 harness 的同模型自动压缩所有权保持不变。token 破了只认：终态超限、
占用 ≥ 100%、官方 compact 确定性失败；普通 timeout 不算。

Codex 已选远端压缩的本地任务，在原生 `contextCompaction` 生命周期内收到终态失败时，
只有明确的 HTTP 400/404/405/422/500/501/502/503 拒绝或失败响应，才自动改用同一模型的
原生摘要压缩；包括远端压缩耗尽内部重试后的短时 429，使用同一账号
仅接替一次。明确的账号／任务额度耗尽、鉴权与已有密文硬失败交接分类保持原处理。
这不是换窗交接：native fork 保留完整历史，Cindy 业务任务不变，不改模型或全局压缩设置。
Codex 0.153 的 unsubscribe 会延迟卸载 30 分钟，不能靠立即 resume 假称 provider 已更新。
接替身份保存在原生任务的 modelProvider 中，重新打开继续沿用，无 UI 开关、无自动切回。
已有本轮模型/工具输出时以空输入续接，不重放用户请求；尚未进入生成的 pre-turn 失败才重投
冻结输入。本地摘要再失败即正常报错，不循环切换。尚未结算的原生 exec continuation 无法跨
线程迁移，不得重建后声称它仍可恢复。普通生成 502 与 stderr 文案不得触发此路径。

Codex 的 120 秒 reconnect watchdog 只是 fallback 收口，不是根因诊断。stderr 仍只作诊断日志，
不得用 `remote compaction v2` 文案驱动恢复动作。普通 timeout、纯文本大历史和网络失败
不得进入这套压缩，也不得进入自动续跑死循环。


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
  Codex 提问／计划审阅尚待用户确认时同样保留产品边界：底层可继续独立工作并结束
  SDK turn，但不能触发完成通知、队列收口或协作任务完成。人工等待使用独立 claim，
  复用 `turnContinuationId`，不能塞进 yield claim 造成回答续跑等待自身。计划审阅必须
  在发布边界前登记；回答／批准后沿原意图续跑，取消／Stop 单次结束且不重复结算 usage。
  起跑回执之前到达的终态先缓冲再核对归属；失败只能走失败终态，不能先以取消回调
  触发定时任务的成功收口。回归见 `agents/codex/index.test.ts` 的 pending confirmation
  与 human continuation 用例，以及 Desktop `sessionEventPipeline.test.ts`。
  Codex `functions.exec` yield 没有协议级 execution handle（cell / wait 活在
  `codex-rs` daemon），近期检测只能是 adapter 内、用真实 rollout fixture 锁死的启发式，
  用来铸造有界 claim，再由宿主确定性开续段让模型 wait 同一 cell。
  `commandExecution` 带数字 `exitCode` 时，结构化退出结果优先于正文：即使 stdout
  完整复刻 running 状态头，也不得铸造 claim；不能仅凭 `status: completed` 排除
  没有退出码的旧版 yield 包装。实现与回归见 `agents/codex/yielded-exec-cell.ts`
  及其测试（均位于 `packages/maker-core/src/`）。无 `id`／`call_id`
  的 item 只认 `itemCompleted` 快照：`itemUpdated` 不得入账，不得给匿名条目发明身份。
  无 yield marker 的 nameless 完成不得清匿名桶；匿名 `wait` 若按 `cell_id` 结算了其中一个
  cell，只从匿名桶拿掉该 cell，不得清空仍在跑的其它匿名 cell。同 turn 或续段里
  后续 `wait` 输出 `Script completed` / `Script terminated` 后视为该 cell 已结算，不得
  再铸 claim，也不得报 lost-handle。Plan Mode 审批只在执行段结算后跑：存在 awaiting
  yield claim 时不得把空计划当循环结束，也不得在 SDK `turn/completed` 上提前挂审批；
  origin 已产出的计划挂在 claim 上，续段结算后再审。禁止把 `last_agent_message == null` 或开场白当结算
  判据；空续段或重试耗尽只证明未取回结果，统一报 `yield-continuation-incomplete`，
  不得推断 cell 丢失或由跨 turn 导致。用户错误不带 cell 编号，原因和编号保留在诊断日志。
  真实 `not found` 也可能来自重复等待已消费的 cell，不等同于底层命令丢失；
  已结算 cell 不因后续重复等待失败而重新入账。不得 replay 原请求或重跑已执行命令。
  续段 claim 一旦挡住产品结束，所有非重试终态错误路径（不限
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
