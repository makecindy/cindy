# IM 一轮任务：入口账本与状态模型

> **状态**：权威开发规则（authoritative），随「IM 一轮任务合并」分批迁移持续更新
> **读取时机**：修改个人 IM 渠道（`apps/desktop/src/main/im/**`）或官方 hook
> （`apps/desktop/src/main/hook-control/**`）的找/建任务、命令、排队与插话、输入拼装、
> 事件观察、表情、交互、收尾或停止逻辑之前

个人 IM 渠道（Telegram / 飞书 / 微信 / 钉钉 / Discord / 企业微信）与官方 hook（官方
Telegram / Slack / X / 飞书 / Lark）是同一件事的两套实现：把渠道里的一条消息变成 Cindy 任务里的一轮，
再把结果送回渠道。本文登记两套实现**今天各自在哪一步做了什么**、**持有哪些状态**、
**合并后归谁**，以及迁移中必须守住的不变量。用户可见的两侧差异另见
[`../product-rules/telegram-bot-parity.md`](../product-rules/telegram-bot-parity.md)；
台账里标「有意不同」的项以策略参数表达，合并时不抹平。

连接恢复由渠道 transport 持有，不重放任务或发送内容。Telegram、Discord 的启动网络失败与
钉钉的连接失败使用可取消的指数退避（约 1 秒起、30 秒封顶，带抖动）；Telegram 429 尊重
服务端完整等待时间。飞书保留 SDK 重连，仅在 SDK 耗尽重试或启动抛错后补重试；就绪日志须
与 SDK 真实连接状态一致。微信、企业微信保留已有重试循环。恢复成功立即更新状态，
不等待下一条消息；凭据失效保留明确错误，冲突沿用各渠道原策略。主动下线、解绑、换账号或退出
必须取消重试，旧连接结果不得复活。设置页的手动重连复用保存的凭据，不要求重新输入或解绑。

退避计算、默认间隔、抖动和可取消定时器统一放在 `@cindy/im/connection-retry`：飞书、
Telegram、Discord、钉钉和官方 hook 共用调度器，Telegram 长轮询复用同一退避策略。
官方 hook 的冲突等待间隔和抖动范围通过参数保留；鉴权、冲突及 SDK 回调仍由渠道适配层处理。
设置页共用 `ImConnectionRecovery.tsx` 的错误提示、重连按钮和已保存凭据恢复行，避免各渠道
重复维护文案、加载状态和错误详情展示。

机器人未单独选择模型时，空的模型配置表示自动选择意图。个人渠道、官方 hook 与设置页均经
`shared/imAutomaticModel.ts` 复用普通新任务的默认组合与目录回退规则，不读取输入框的最近选择。
解析结果包含来源、引擎、模型和思考强度，只用于执行和展示，不写回 override。自动模式的
跟随记录同时记下解析结果，下一条消息重新解析目录；结果未变不改任务，任务手动选择仍优先。
无可用来源时明确失败，不把空字符串或历史写死型号交给执行器。已有显式配置保留原值；恢复
自动选择只清模型路由覆盖，保留权限档。
自动候选同时遵守执行端的模型显示偏好；显式固定模型仍按原路由准入规则校验。官方目录指向
远程电脑时，只从那台电脑授权远程调用且可见的目录解析，失败不改成本机。继承本机默认时，
先解析默认模型，再按既有规则判断目录的残留来源；断开或停用的显式来源仍拒绝替换。
设置页在自动模式下随目录更新重读实际模型，加载、刷新与保存共用请求代次，迟到刷新不得
覆盖用户刚固定的模型或切换后的渠道。

## 1. 入口账本

每一行是一轮任务的一个步骤。「现状」列写真正干活的函数；「目标」列写合并后的归属：
**公共入口**（App 的既有入口，IM 不再另写）、**共用流程**（新的 IM 一轮任务模块，两侧
同一份）、**渠道适配**（只保留入站来源、出站载体、台账登记的有意差异）。

| 步骤 | 个人 IM 现状 | 官方 hook 现状 | 目标归属 |
|---|---|---|---|
| 入站 | 各渠道 adapter → `im/shared/messageHandler.ts`（微信经 `WechatTaskStore` 持久队列） | `hook-control/manager.ts` 收 `task.dispatch` → `dispatcher.handleDispatch` | 渠道适配（入站来源各自保留） |
| 幂等与重投 | 无（个人连接无重投） | `ackHistory` / `inflightRequests` / `terminalLedger` | 渠道适配（服务端重投是 hook 的传输语义） |
| 找任务 | `turnRunner.resolveRouteTarget`：通知回复 → `/ctr` 绑定 → 确定性 id 通道行（`sessionRepo.findActiveSession` 复活归档行） | `dispatcher.resolveTarget`：接管 sessionId → 绑定复用（每条消息按工作目录映射现场重算）→ 失效则换任务并交接 | 共用流程的「定位」骨架 + 渠道策略（台账第三节「绑定的任务失效后怎么接续」有意不同） |
| 建任务 | `sessionRepo.createSession` 确定性 id upsert；`createFreshSession`（`/new` 轮换事务）；随后 `maker.createSession` —— 2026-10 起两处建行都经 `openChannelSession` → **`openSession`**（模型准入） | `session-runner` 新任务的 `maker.createSession`、`/new` 的 `desktopSessionStorage.create` —— 同样经 `openChannelSession` → **`openSession`** | **公共入口 `openSession`**（已完成，批次 2）；渠道专属建行在 commit 回调里。live session 仍各自 `maker.createSession`，未改用 register 内部的 `bootstrapSession`（会新增项目上下文 / Orca 指令注入等行为，见 §6） |
| 默认配置 | `resolveImSessionDefaults(channel)` + 跟随渠道默认（`channelDefaultRouteSync`） | `resolveNewSessionConfig`（目录偏好 > 全局 IM 默认 > 清单首项；权限档规则见 `defaults.ts`）+ 共用 `createDefaultRouteFollower` 跟随默认 | 渠道策略（台账第三节「新会话的默认…从哪读」有意不同） |
| 命令 | `messageHandler.processOne` → `slashCommands`（注册表 `botCommands.ts`） | 服务端分发命令，桌面只收 `query.*` | 渠道适配（官方命令分发在服务端） |
| 排队与插话 | `SessionState.sendQueue`（内存、无上限、重启丢失）；无插话 | `dispatcher.queues`（内存、上限 20）+ `drainPolls`；无插话 | **公共入口 `AgentInputCoordinator`**（见 §5 批次 3 与 §6 待决项） |
| 输入拼装 | `prepareAgentTurnText`（群上下文 / ambient 提示）+ `buildImChannelNote` + `buildImUserMessage`；派发时前置交接 / 计划对账 / Goal 提示 | `buildContextPrefix` + `composeXPrompt` + `buildHookPromptNote`；同样前置交接 / 计划对账（仅 IM 来源）/ Goal 提示 | 共用流程（前置层同一份；渠道说明文案有意不同，见台账「入站上下文」） |
| 用户消息落库 | 部分渠道提前落库（`persistInboundUserMessageEarly`），`onAccepted` 补 `imSource` | 只在 `onAccepted` 落库，`agentMeta.hookSource` | 共用流程（`onAccepted` 落库；提前落库保留为渠道能力） |
| 发送 | 发送前应用任务待切换选择，再 `makerSession.send`，`MAIN_OWNED_SEND_CONTEXT.origin.kind='im'` | 复用任务先经 `acquirePendingAgentSwitchForImSend` 跟随默认并应用任务选择，再读 meta、建会话、挂观察器和 `session.send`；发送后释放锁，origin `hook`（Telegram / X / 飞书）或 `im`（Slack） | 待切换选择共用既有直发流程；Pi 管理命令授权来源按渠道各自声明（hook 不得伪装成本机命令） |
| 观察事件 | `turnPresenter`（buffer-replace）+ 流式 handle | `turnObserver`（finalized-segments）+ 进度发射器 | 共用流程（presenter 已同源；两个正文累积引擎有意不同） |
| 后台轮次回传（非 IM 入站） | `orchestrator` 的 `onChannelTurn` → `turnRunner` 转播（Agent 自己唤醒的轮次只同步标记已接线的会话） | `backgroundResults` → `turn.end(background: true)` | 已同源判据：`maker-ipc/channelTurnSignal.ts` 的开始信号与 `isRelayedChannelTurnSource`（其它任务来信；后台唤醒继承当前 Session 最近实际派发的来源，Cindy 输入及内部协调不回传；scheduler 按 `turnOrigin`）；仍属原 IM 轮次的不另发 |
| 表情 | `TurnState` 的 ack 句柄 | `ackReactions`（msg.op react） | 渠道适配（出站载体不同，档位语义同源） |
| 交互 | `beginInteractionRoute` + `pendingInteractions` + 渠道卡片 | `beginInteractionRoute` + `interactions.ts`（30 分钟超时）+ 卡片发布器 | 共用流程（路由与语义层已同源；超时差异见台账缺口 2g） |
| 收尾 | `handleTurnDoneAsync` / `handleTurnErrorAsync` → 流式 handle finalize | `execute` 收口 → `turnCarrier.publishFinal` → `turn.end`（持久出箱） | 共用流程的收口骨架 + 渠道出站载体 |
| 停止 | `turnRunner.stopActiveTurn`：清 `sendQueue` + 撤自动续跑 + `abort()`；**不暂停 Goal、不停 coordinator** | `dispatcher.cancel` → `abortSession`：只 `abort()`；**不撤自动续跑、不暂停 Goal** | **公共入口：统一明确停止**（`stopSessionTurnExplicitly`，与桌面 Stop 同一套清理） |
| 重启恢复 | 无（微信例外：`WechatTaskStore`） | 终稿持久出箱（`requestLedger`，24h） | 渠道适配（终稿必达是 hook 的保障；台账缺口 3） |

## 2. 状态清单

只列跨轮持有、会影响正确性的状态。「去向」：**保留**（留在渠道适配）、**并入**（进共用流程，
两侧一份）、**替换**（由公共入口持有，删除本地副本）。

| 状态 | 位置 | 键 | 去向 |
|---|---|---|---|
| `userLocks` | `im/shared/messageHandler.ts` | `ctx:sender:scope` | 保留（入站串行化是渠道语义） |
| `sessionStates` / `SessionState.queue` | `im/shared/turnRunner.ts` | sessionId | 并入（「每会话当前一轮」的观察状态） |
| `SessionState.sendQueue` / `dispatchRetryTimer` | 同上 | sessionId | **替换**为 coordinator 队列 |
| `queues` / `running` / `drainPolls` | `hook-control/dispatcher.ts` | sessionId | **替换**为 coordinator 队列（`running` 只剩观察态） |
| `keyChains` / `sessionAdmissionChains` / `worktreeChain` | dispatcher | externalKey / sessionId | 保留（hook 的接活串行化） |
| `ackHistory` / `inflightRequests` / `pendingTurnEnds` / `pendingDeliveryTurnEnds` / `requestLedger` | dispatcher | requestId | 保留（hook 传输与终稿必达） |
| `runningByRequest` / `cancelRequested` / `pendingGroupAdmissions` | dispatcher | requestId | 保留（服务端 requestId → 任务的映射） |
| `pendingReopens` / `activeContinuations` / `pendingClaims` | dispatcher | sessionId | 保留（turn-reopen-v1 是官方能力） |
| `awaitingPersist` / `staleTakeoverReplacements` / `latestPromptBySession` | dispatcher | sessionId / key | 保留（hook 的定位策略） |
| `controlState.inProgress` / 绑定库 | `im/shared/controlState.ts` / `im/binding.ts` | bot:user | 保留（`/ctr` 是个人渠道能力） |
| `pendingInteractions.pending` / `interactions.ts pending` | 两侧 | requestId / interactionId | 并入（批次 5：交互挂起表合一，超时策略按渠道参数） |
| `groupHistoryAccess.activeBySession` | `im/shared` | sessionId | 已同源，不动 |
| 群消息本地窗口（`hook_group_messages`）与上下文游标（`hook_group_context_cursors`） | `im/shared/groupWindowCore.ts`；个人渠道经 `im/shared/channelGroupWindow.ts`（Telegram / 企业微信 / 钉钉各一份 provider 前缀，`<渠道>-personal:<botContextId>`），官方经 `hook-control/groupWindow.ts` | provider + chat / cursorKey | 已同源，不另建存储：新渠道接群上下文时复用 `createChannelGroupWindow`，在 `prepareAgentTurnText` 入窗并拼前缀、受理后 `commit`，终稿发出后把机器人回复入窗 |
| `channelToolScope.activeBySession`（`cindy_telegram_bot` / `cindy_feishu_bot` 轮次内工具的逐轮作用域） | `im/shared` | sessionId | 个人渠道能力；与群历史租约同一生命周期（`beforeProviderStart` 登记、`releaseTurnInteractionRoute` 释放）。Telegram、飞书 / Lark 各一种作用域，带着触发本轮那条连接自己的 transport；企业微信 / 钉钉 / Discord 没有渠道直通工具，伙伴专线轮次由 `messageHandler` 登记不带 transport 的 `LaneTurnScope`（只给触发者身份与当前对话）；`cindy_feishu_bot` 的 `send_*_to_user` 优先按它选出站 bot，无租约时按下述主人通知规则解析 |
| Telegram 传输层（`chatQueues` / `typingLoops` / 回挂目标） | `packages/lizi-im/src/telegram/index.ts` | chat | 保留（个人出站载体） |

**飞书主人通知的无租约路径**：`send_message_to_user` / `send_file_to_user` 在伙伴 canonical
主任务的后台回报、心跳或桌面轮次中可主动通知主人。无飞书逐轮作用域时，宿主异步查询当前账号的
`bot_session_links`（`role='canonical'`，关联 `sessions.source='bot'`），确认伙伴 Profile 为 `active`，
选择该伙伴已连接且已绑定主人的飞书连接；发送时校验连接的 owner 与已解析收件人一致。
已识别伙伴但没有匹配的可用连接、伙伴 Profile 非 active 或缺失、数据库查询失败、账号边界处于 pending
或 owner 代次变化，均拒绝发送，不回落个人 bot；查询前后
及实际调用发送前都复核账号边界、owner 代次与所用 DB 快照。没有 canonical 伙伴归属的普通
任务仍保留设置页个人 bot 的主人通知能力。使用个人 bot 发送时，已解析收件人必须匹配它当前的主人
或宿主任务记录的显式 `feishuChatId`；两阶段之间 canonical 关联消失时，不将伙伴的收件人交给个人
凭证发送。此路径不向主任务持久写入 `feishuChatId`，也不生成租约
或授予轮次内原生 API 权限；`cindyBotImChannels` 只控制工具挂载，不作为归属或授权依据。
实现见 [`feishuTransportRouting.ts`](../../apps/desktop/src/main/mcp-integrations/feishuTransportRouting.ts)
与 [`botImConnectionRuntime.ts`](../../apps/desktop/src/main/im/shared/botImConnectionRuntime.ts)，
真实 worker DB 路径回归见 [`feishuTransportRouting.test.ts`](../../apps/desktop/src/main/mcp-integrations/__tests__/feishuTransportRouting.test.ts)。

**不为合并新增**全局状态机或持久化表：队列与停止交给已有公共入口持有的状态；合并只移动和
删除现有状态。

## 3. 不变量（迁移每一批都必须守住）

1. **同一 externalKey / 同一渠道行 → 同一任务**；建任务与复用的判据不因迁移改变（台账第三节）。
2. **已提前落库的用户消息不重复插入**：`onAccepted` 只补元数据（`existingClientId`）。
3. **来源标签与模型说明同源**（[`message-source.md`](../product-rules/message-source.md)）：
   IM 写 `agentMeta.imSource`，hook 写 `agentMeta.hookSource`；新数据不得塞进 `origin`
   （coordinator 把任何 `origin.kind` 当非人工输入）。
4. **Pi 管理命令授权来源**：个人 IM 用 `authenticated-im-command`；官方 hook 的 origin
   是 `hook`，**不得**伪装成 `local-desktop-command`；官方 Telegram、官方飞书 / Lark 与对应个人 bot
   共用 `source.im`（`telegram` / `feishu`），hook 路径（`session-runner.ts` 的 `mainOwnedChannelOrigin`）
   必须显式映射成 `{ kind: 'hook' }`，**不得**落到个人 bot 的可信 `im` 来源（回归：`session-runner.test.ts`
   「线程来源」表）；`MAIN_OWNED_SEND_CONTEXT` 是 Symbol，
   跨队列快照时必须由宿主在派发时重新盖章，不能指望它随队列项持久化。
5. **session-new-v1**：`/new` 成功时新任务已落库并出现在列表；**turn-reopen-v1**：续跑轮
   断连即终局、`turn.end` 直发不缓存。
6. **群历史租约与渠道工具租约**：`beginGroupHistoryAccess` / `beginChannelToolScope` 都在 provider 真正
   开始这一轮前登记、终态释放；`sessionInstanceId` 挡住旧实例借用新权限。轮次内原生 API 的目标 chat 与
   触发者身份只来自租约，不来自模型参数，无租约时 fail closed；飞书 `send_*_to_user` 的主人通知
   例外见上节，不扩大原生 API 的作用域。每个可绑定渠道的 `channelNoteSourceFor` 都要在 `[渠道说明]`
   末尾给 `toolsHint` 点名本轮可用的渠道工具（Telegram：`TELEGRAM_TOOLS_HINT`；飞书：`feishuToolsHint`），
   Agent 不该靠摸瞎试工具才知道自己在哪个渠道；新增可绑定渠道时四件事一起补——渠道说明提示、
   `channelToolScopeFor` 作用域、轮次内直通工具、以及该渠道工具在**三个 Harness** 的挂载门禁
   （`shared/botImConnection.ts` 的 `hasImChannelVendorOptions`：专线带 `<channel>ChatId`，伙伴主任务带
   `cindyBotImChannels` 标记；Codex / Pi 的共享 bridge 用空 ctx 建清单，provider `isEnabled` 必须在空
   workdir 快照放行，再由 `codexEnvironment.buildSessionMcpConfig` / `piEnvironment` 逐会话收可见性）。
   渠道工具租约还被 `botSkillService` 复用来判定专线上「是不是主人触发的轮次」；没有 `channelToolScopeFor`
   的可绑定渠道靠 `LaneTurnScope` 兜住这一判定，否则主人在专线上也只能只读技能。
   `onAccepted` 成功落库后把本轮输入的 `clientId` 绑定到同一租约；事件持久化在租约释放前
   将它写为 `replyToClientId`，用于保留回复与本轮输入的确切关联；这不是后台学习的触发约定，
   回复后不再启动辅助模型复盘。显式技能工具的写权限仍按当前轮租约 / `LaneTurnScope` 的
   主人身份判定，不把持久回复关联当作新授权，也不借用后续轮次的租约或最近一条消息。
   受保护内容未落库时不绑定，复用作用域前清除旧输入。
   6b. **发送前上下文体检同源**：个人 IM 的 `dispatchQueuedSend` 在伙伴守卫（`companion.prepareSend`）
   之后、拿发送锁（`acquirePendingAgentSwitch`）之前调用 `deps.prepareUnhealthySession`（orchestrator 接
   `register.prepareUnhealthySessionForSend`），与桌面直发、官方 hook 走同一个
   `contextOverflowRollover.prepareUnhealthySession`：伙伴对话（主任务 + channel / group 专线）沿用
   普通 Session 的真实满窗、明确压缩失败和坏历史恢复；健康上下文交给原生压缩，不按空闲时长
   或 70%/90% 伙伴阈值提前换窗，正常压缩也不重启伙伴实例。IM 不另设换窗 / 换任务规则
   （[`cindy-bots-runtime.md` §3.2](../product-rules/cindy-bots-runtime.md)）。体检关闭 live handle 的原因是
   `runtime-refresh`，close 监听在有 `acquirePendingAgentSwitch` 时保住任务，新 handle 由
   `refreshSessionAfterPendingAgentSwitch` 按最新 DB 行重建；体检抛错按直发口径让这条消息失败。
   6c. **全响应（ambient）前置判定不留痕迹**：`messageHandler.processOne` 只对 `event.ambient === true` 的消息、
   且 adapter 实现了 `ambientTurnGate` 时，在 ack / 提前落库 / 群上下文拼装**之前**问一次该不该插话；
   `'skip'` 直接 return（不落库、不起轮次、不推进群窗口游标），钩子抛错或判不出来按 `'proceed'` 走原路径。
   被召唤的消息永远不经过判定。判定走共享辅助模型链（`im/shared/ambientReplyJudge.ts`），不得在这里起主模型。
7. **计划对账**只在真实用户轮次注入（官方仅 `source.im` 存在时）。
8. **终稿必达**（官方）：`turn.end` 先进持久出箱；客户端发布终稿时以 `clientFinal` 交回。
   带附件的轮次不由客户端发布。Telegram / Slack 的持久出箱只存文本；X 的出箱保留
   `cindy-media` 地址、引用 ID、名称、MIME 与大小，Base64 只存在传输帧和内存中。
   Agent 在远程供应商上运行时，`[名称](xdt-file:///影子路径)` 由远程事件投影先还原成本机路径，
   收集器再按工作目录校验；漏掉这一步，文件会被当作目录外附件跳过。
   X 仅收 JPEG / PNG / WebP / GIF / MP4 / MOV；单图片 5 MiB、GIF 15 MiB、视频 10 MiB，
   一轮最多 8 项、总计 30 MiB（持久出箱仍按 32 MB 总预算计入媒体的传输大小）。
   server 声明 `x-media-relay-v1` 时，视频不内联：客户端在回帖前把文件分块转传给 X（`hook-control/xMediaRelay.ts`），
   拿到 media id 后随 `turn.end.xMediaIds` 回传，大小只受 X 限制，不做压缩；失败时正文照发并提示未发出。一条回帖最多四张图片，或一个 GIF／视频：客户端发送前先选定，回复里引用的优先，工具结果旁路带来的
   媒体最先让位且不算发送失败；服务端再核验，组合不合规时整条回帖（含正文）都发不出去。托管媒体通过 `ingestMedia`
   作为非缓存入库；待发 pin 使用 `message` 引用、出生任务与 `hook-outbox` 来源，沿用
   任务删除清理。恢复时核对当前账号、任务与引用，失效不重放附件；仍待发的结果保留 24 小时。
   收到 `turn.delivery`（未协商回执时为 transport 接受）后清除出箱媒体地址并释放 pin；
   定时及读路径清理过期出箱，媒体仓同时回收崩溃遗留 pin，
   物理字节仅由既有媒体回收器处置，不删除仍被聊天／画廊引用的媒体。
   媒体入仓或出箱失败时保留原有完整内存发送兜底，并记录持久化失败；不得将丢附件记作持久化成功。
   兜底帧写不进出箱时也不由客户端发布；本进程
   仍在发布、正式 `turn.end` 还没进入发送 / 缓冲路径时，重连扫描与服务端重投 `task.dispatch` 都不重放出箱里的兜底帧（重投只回放 ack）；终稿段
   回执未知先同 opId 有界重发对账，仍未知才交回。
9. **明确停止 = 与桌面 Stop 同一语义**：撤自动续跑与退避簿记、取消上下文溢出恢复、暂停
   Goal、停 coordinator（中止当前一轮、清 coordinator 队列、清理待决交互）。用户喊停后不得有
   任何自动续跑原地复活；hook 自有队列（`queues`）不在此列，并入 coordinator 前的语义见 §6；
   Goal 落盘失败只能在中止之后报错，不能挡住停止。
10. **hook 的续跑观察不把自己的轮次当成桌面轮次**：hook 轮次一旦经 coordinator 派发，
    `subscribeUiTurnDispatching` 必须能按 clientId 认出它（否则会误撤续跑）。
11. **一轮绑定入口时的账号**：新建任务从**读取**旧任务 / 默认配置之前捕获账号
    （`captureChannelAccount`，先 prepare 再建的沿用 prepare 时捕获的），经
    `openChannelSession` 带进 `openSession`，准入前后与写库前都复核，建行之后的补写（来源、发送时间、worktree）也不例外；账号变了就终止这次派发（官方 hook 在 `session.send` 前复核），不只是跳过补写；一轮的出站 msg.op
    （进度、终稿、卡片、旧卡片帧）只经所属账号代次的连接发出，换账号后视同离线。
    **边界**：`Maker.createSession` 内部「先异步启动 Agent、再取当前库写行」的窗口不在本条范围——
    它是桌面、IM、目标恢复等所有建任务入口共有的既有问题，要堵需让账号守卫穿过 maker-core
    启动 / 持久化边界或新增回滚机制，另行处理。

12. **飞书回复跟随提问位置**：群主聊天的消息用群 lane，带 `thread_id` 的消息用原话题 lane；
    普通引用的 `parent_id` / `root_id` 不等于话题，不自动开新话题。个人和伙伴复用同一渠道实现。
    工作中编辑进度卡；完成后在同一位置新发终稿，确认发送成功再撤回进度卡，避免失败时丢掉已有内容。
    终稿和附件不领取下一轮排队消息的锚点。空结果撤回进度卡且不发占位，图片／文件仍正常投递；
    新消息发送失败时保留进度卡并尝试就地展示终稿，撤回失败不得重复发送已成功的终稿。

13. **飞书终稿完整送达、过程可回看**：终稿不截断。一张卡片装不下（请求体 30 KB，或单个富文本组件
    超过 4 个表格）时，`@cindy/im` 的 `feishu/cardSplit.ts` 按内容边界分段：优先段落之间，其次行之间
    （切在代码块里就补收尾围栏并在下一段重开，切在表格里就给下一段补表头），最后才按字符；第一段更新
    原进度卡，其余按顺序在本轮回复位置另发，每张底部带页码；正文之外的图片挂不下时同样另起卡片。
    后续某一张发不出去就停下并说明，不跳过它继续发；第一段都没送达时不再发后面的。写作中的中间帧只有
    一张卡片，装不下时展示装得下的开头并说明写完后分条发送。
    正常完成的轮次，`turnRunner` 把过程记录（`turnActivity.buildActivityRecord`：本轮全部工作项，最多
    列 50 项，更早的只计数）经 `StreamingTextHandle.finalize(text, { process })` 交给渠道；飞书把它收成
    正文上方一个默认折叠的面板，正文保持干净。没有工作项的快答不带记录，终稿与以前一致。失败收口仍把
    过程区留在正文里（用户要看到停在哪一步）。其它卡片渠道的 handle 忽略这份记录，行为不变；
    Telegram 的「成功终稿只含正文」裁决不受影响。
    飞书卡片的排版只有 `@cindy/im` 的 `feishu/streamingText.ts` 这一份：它对外只依赖一条发送通道
    （`FeishuStreamingDeps`：建卡、更新、放终稿第一张、发后续卡片）。个人 bot 与伙伴连接的通道直接调
    飞书接口；官方飞书 / Lark 的通道经 `msg.op` 交给服务端执行（`hook-control/feishuTurnCarrier.ts`）。
    改飞书回复长什么样只改这一处，不在服务端或 hook-control 里另写排版。

## 4. 状态模型（一轮）

```
inbound ──► admitted ──► queued? ──► dispatching ──► running ──► finalizing ──► terminal
  (渠道)     (定位/建任务)  (coordinator)  (前置层+send)   (观察事件)   (渠道出站收口)   ok|error|cancelled
                │                │               │              │
                └── rejected ────┴── discarded ──┴── stopped ───┘
```

- **admitted → queued**：会话忙（`isTurnRunning` 或 coordinator 有积压）时入 coordinator，
  带 `onAccepted` / `onAcceptedRollback` / `onDiscarded`；空闲时直接进入 dispatching。
- **dispatching**：前置层（交接 / 计划对账 / Goal 提示 / 渠道说明）只在这一步加，**不进
  持久化文本与队列文本**；`onAccepted` 是用户消息落库与「已受理」副作用（群上下文游标提交、
  ack 表情转处理中）的唯一边界。
- **running**：一轮只有一个观察者；终态只由 `done`（非 silent-stop / 非续跑中间边界）、
  终态 error、会话 closed/error 三个出口给出（`turnObserver` 的收口规则）。
- **stopped**：任何来源的明确停止都走 `stopSessionTurnExplicitly`；队列中的项经 coordinator
  `onDiscarded` 收口（hook 回 `turn.end(cancelled)`，IM 撤排队表情）。
- **terminal**：渠道出站收口（个人：流式 handle finalize；官方：`turn.end` 与客户端终稿）。
  每个 settle 路径（resolve / reject / 超时 / 取消 / 乱序 / 迟到 / 重复）只有一个判据。

## 5. 迁移批次

每批独立可验证：跑 `pnpm test:unit:related` 与相关 package typecheck，本地 commit。

1. **统一明确停止**（已完成）：`register.ts` 里重复的内联停止序列抽成导出的
   `stopSessionTurnExplicitly`（伙伴群聊 lane 与伙伴委派原来各抄一份，改调它）；IM
   `/stop`（含微信）与 hook `task.cancel` 改调它，账号边界中止仍是普通 abort。
2. **新建任务走 `openSession`**（已完成）：`im/shared/openChannelSession.ts` 是两侧共用的
   薄包装 —— 准入前的路由送进 `openSession`，建行回调拿准入后的路由；IM `createSession` /
   `createFreshSession`、hook 新任务与 `/new` 的只建行都经它。复用 / 接管 / 复活既有任务
   不经过准入。准入拒绝时抛出，调用方走各自既有的渠道失败提示。
3. **排队走 `AgentInputCoordinator`**（2026-10-06 Dash 决定另开 PR，先出设计说明）：删 IM
   `sendQueue` 与 hook `queues`；coordinator 队列项补 `imSource` / `hookSource` 字段（不进
   `origin`），派发时由宿主补渠道说明并重盖 `MAIN_OWNED_SEND_CONTEXT`；hook dispatcher 按
   clientId 认出自己的轮次。**已查明的前提**：coordinator 派发一项时接管的是整轮生命周期
   （发送事务里落库用户消息、绑定 vendor turn、出错时套用中断自动续跑 / 错误横幅 / 上下文
   恢复），所以「只当候车室、轮到时转回渠道自己发」做不干净 —— 迁移后渠道轮次就是
   coordinator 轮次，§6 前四行的可见变化要逐条定下来再动手。
4. **共用一轮流程骨架**（随批次 3 另开 PR）：把「定位 → 拼装 → 发送 → 观察 → 收口」抽成共用模块，两侧只注入
   渠道适配（入站来源、出站载体、§1 标注的策略参数）。
5. **交互挂起表合一**、**台账缺口收敛**（随批次 3 另开 PR）：缺口的最终取向逐项写回台账，用户可见变化按 §6 处理。

## 6. 待 Dash 决定（默认保持各自现状）

| 项 | 个人 IM 现状 | 官方 hook 现状 | 合并后若不决定 |
|---|---|---|---|
| 重启后排队消息 | 丢失 | 已 ack 为 queued 的任务丢失，服务端靠 lease 超时收口 | coordinator 快照会恢复为**暂停**队列，等用户再发消息才继续 |
| 渠道轮次的中断自动续跑 / 错误横幅 / 上下文恢复 | 无 | 无 | 迁到 coordinator 后自然覆盖（与桌面同语义）；与 `maker-core-and-agent-behavior.md` 「IM 绑定任务不进图片历史自动恢复」那条要一并核对 |
| 排队消息在桌面端可见 / 可删 | 不可见 | 不可见 | 迁到 coordinator 后自然可见、可删（删除即视同撤回：IM 撤排队表情，hook 回 `turn.end(cancelled)`） |
| 排队上限 | 无上限 | 每会话 20 | 各自保留：IM 不限，hook 仍按 20 拒收 |
| 停止时同任务已排队的消息 | `/stop` 一并清掉 `sendQueue` | 服务端 `/stop` 只对正在跑的那一个 requestId 发 `task.cancel`；desktop hook 队列里同任务已排队的请求照常接着跑（本 PR 前即如此） | 未改：一并清掉等于替用户丢弃没被取消的请求、并以 cancelled 收口，属产品语义；随批次 3（hook 队列并入 coordinator）一起定 |
| 插话（steer） | 无 | 无 | 不新增 |
| 模型准入（`openSession`） | 只做凭证检查 | 新任务做路由检查 | 已按 Dash 指定改走 `openSession` 准入：新任务的模型 / 来源 / 推理强度 / Fast 不被支持时直接拒绝（文案「不会自动更换模型或供应商」），准入还会规范化来源与推理强度；渠道默认配置若指向已停用的模型，新任务会建不出来（以前会照建） |
| live session 改走 `bootstrapSession` | 不注入项目上下文 / Orca 指令 | 同左 | 未改：改了等于给 IM / hook 任务新增项目上下文与 Orca 指令注入、目录授权准备等行为，属产品决定 |
| 缺口 2b / 2e / 2f / 默认配置取值链 | 见台账 | 见台账 | 各自保留，合并只共享实现骨架 |

### 官方飞书 / Lark（第一里程碑，2026-11-04）

官方飞书与 Lark 是同一个 provider `feishu`（品牌跟随组织配置的应用，不随 Cindy 版本区域切换），
由独立部署的 feishu-hook-server 经 provider-neutral 状态机接入（`manager.ts` 的 `feishuConfig`）：

- lane：私聊 `feishu:dm:…`，群消息一律在话题里回复 `feishu:topic:…`；`deriveLaneKind` 把话题 lane 视为群轮次，
  与官方 Telegram 群一样在 send 后持有 session turn lease（不改权限档）。
- 出站（2026-11-10 起电脑排版）：客户端 hello 在 provider-bind / provider-prefs / `provider:feishu` 之外声明
  `msg-op-v1`、`feishu-progress-ops-v1`、`feishu-final-ops-v1`；服务端 welcome 同时宣告才生效，逐项独立。生效后
  进度卡与**不带附件的成功终稿**由本端用个人飞书 bot 同一份排版经 `msg.op` 发布（`dispatcher` 里与官方 Telegram
  共用的轮次载体流程，飞书的实现是 `feishuTurnCarrier.ts`）：`turn.progress` 照发（续期），终稿全部确认后
  `turn.end` 带 `clientFinal.complete=true`，否则交回服务端发布完整终稿。发布前照旧先把不带 `clientFinal` 的
  `turn.end` 写进持久出箱。失败 / 取消 / 带附件的终稿、确认卡仍由服务端排版（`turn.end` / `interaction.request`）；
  任一侧没有声明时全部照旧由服务端排版。不声明 `session-picker-v1`（查询不带收件身份，不交出本机任务列表）与任何
  `telegram-*` 能力。后台轮次回传（`backgroundResults`）暂不覆盖飞书。
- 会话：`sessions.source` 复用 `feishu`（个人飞书会话靠 `feishu_bot_app_id` 区分）；`vendorOptions.source`
  用 `feishu-hook`，让 `cindy_feishu_bot` 追加官方会话提示而不把它当个人渠道；模型说明为
  `buildHookPromptNote('feishu')`。
- 绑定链接只接受飞书 / Lark 网页授权页与打开机器人的 AppLink（`feishuDeepLink.ts`），关联码只随 pending 快照出现。

### 官方 X 的伙伴路由

`hook-control/xCompanion.ts` 通过既有 `ensureBotChannelLaneSession` 创建 X 公开专线。
绑定正本为账号隔离的 hook store `x.companionBotId`，不修改跨端 wire 或数据库 schema。
Dispatcher 只接受宿主解析的专线 ID 和精确工作目录，忽略入站指定的任务 ID；执行与排队恢复时
重新核对绑定。Runner 在获取切模锁前执行伙伴模型/能力刷新，provider 启动前登记 X 的
`LaneTurnScope`，终态释放；source 仍保留 `bot`，渠道说明逐轮追加。普通未绑定 X 路由保持原样。

## Discord 服务器频道（一期）

个人 Discord bot 在私聊之外支持白名单内的服务器文字频道与其中已存在的文字 thread。要点（实现见
`packages/lizi-im/src/discord/{lane,gateway,inbound,index}.ts` 与 `apps/desktop/src/main/im/discord/**`）：

- **召唤**：网关只多请求标准 `GuildMessages` intent，不请求 `MessageContent`。只有直接 @ 机器人的消息会被处理
  （@everyone / 角色提及不算）；机器人、webhook、系统消息一律忽略。没有被 @ 的频道正文既收不到也不假装收集，
  上下文只来自主人实际 @ 过的往来。
- **lane**：userId = `g/{guild}/{channel}[/{thread}]`，同频道共享一个会话，thread 独立一个会话，白名单只认父频道。
  私聊 userId / session id 不变，不迁移存量。出站按 lane 解析到对应频道 / thread，每次发送复核白名单与 guild 归属。
- **白名单（服务器级准入）**：owner-scoped `discord-channel-access.json`，默认空 = 不开放；设置页「服务器频道」每个服务器一行
  （名称 + 摘要 + 开关 + 「更多」），首次开启 = 该服务器全部文字频道（含之后新增的，运行时按 guildId 判定，不是 UI 批量勾选），
  「更多」里可改成仅指定频道。形状 `{ channels, guilds? }`：`channels` 只放当前生效的显式选择（存量配置含义不变：有频道
  而没有服务器条目 = 已开启 + 仅指定频道，升级零点击不变成全服）；`guilds[]` 记 `enabled / mode(all|selected) / allowMembers /
  savedChannels`，服务器关闭或切到全部频道时原选择收进 `savedChannels`，重新开启 / 切回仅指定恢复；设置过「仅指定 + 零选择」
  的条目保留，再次开启仍是零选择，只有完全没有记录的服务器才是首次开启。`normalizeDiscordChannelAccess`（lane.ts）统一规范化，
  不信任 UI；旧版本只认 `channels`，读到新配置只会少开、不会多开。thread 随父频道准入、独立上下文。设置页读取到的白名单版本
  不是 2（`accessVersion`，更旧的电脑）时整段拒绝编辑并提示升级。配置读是实时的：撤销 / 关闭后进行中的下载丢弃、出站拒绝、旧卡片失效。
- **个人 bot 成员准入暂不开放**：传输层支持 `allowMembers`（有测试），个人 bot 的桌面 store 读写一律丢弃它。原因：个人 bot 没有对非主人
  轮次的硬性读 / 检索 / MCP 边界（Auto 审阅对 guest 的口径是「可做范围内读取」，`forceConfirmToolCall` 只管破坏性与不透明写）。
  开放成员需要伙伴 chat-only lane（`isChatOnlyGroupLane`）那类真正的工具 / 目录 / 记忆边界。
- **隔离**：每个 lane 独立托管目录 `discord-{appId}-g-{guild}-{channel}[-{thread}]`（`ensureWorkingDir(botContextId, userId?)`），
  与私聊目录并列；目录隔离不等于文件权限隔离。群历史检索只给本 lane（`access: 'lane'`），不跨 lane / 私聊。
  `adapter.blocksLocalTaskAccess` 让 `/ctr /exctr /session /project` 及 `control:*` / `project:*` 卡片在 lane 里不执行。
- **伙伴连接**：白名单按连接各一份（连接记录 `discordChannelAccess`，`createBotDiscordIM` 的 getter 每次现读，删除 / 撤销即时生效、
  不同 connectionId 互不串）；`companionLane` 把 lane 映射为 `group`（不落主人私聊主任务）。逐频道 `allowMembers` 只有伙伴连接可开，
  语义沿用 `cindy-bots-runtime.md`（权限档唯一开关、共享 Bot 记忆、成员轮次只确认破坏性动作、命令只认主人）；
  个人 bot 的 store 仍丢弃各层级的 `allowMembers`（逐频道、服务器级、保留的选择）。全部频道模式的「允许成员」是服务器级开关。目录隔离不等于权限隔离，不能据此宣称沙箱。
- **出站复核**：lane 的每次 send / edit / 补传图片都复核「发起时的 bot 身份 + 当前白名单」，await 之后再复核；换 bot 或撤销后
  不再发出内容（只放行删除机器人自己的占位消息）；终稿编辑失败的兜底改发也经同一复核。
- **流式回复**：发到频道的 Message 对象放进有界缓存，机器人没有「读取消息历史」时仍可编辑；编辑失败终稿改发新消息。

## 入站历史窗口与附件（2026-11-07）

历史选择不调用辅助模型：不做相关性二分类，也不扫描正文后删除消息或跳过附件。历史与引用仍是低信任数据；现有权限、平台受保护内容、账号/群/话题隔离保持不变。

共享上限在 `packages/slack-hook-protocol/src/channelHistory.ts`：最近至多 50 条历史，正文每条至多 4000 字符、窗口至多 16000 字符（含署名与时间），超限明确标注。当前请求不计入历史；精确引用优先、按消息 ID 去重并占一个名额及文本预算。附件说明/文件节选另限 4000 字符；原件仍走媒体/文件通道及既有数量、大小限制。当前附件先处理，再处理引用和最近历史；不能下载、格式不支持、没有原件或超过容量均说明，不能把 `[图片]` 当成已提供图片。

| 渠道 | 自动上下文来源 | 历史附件边界 |
| --- | --- | --- |
| 个人飞书/Lark | 本群或本话题最近一页，另取精确引用；无模型预筛选 | 下载所选消息附件，保留来源、原件与有界文本节选 |
| 官方飞书/Lark | 服务端最近一页，同 lane 按游标补增量，精确引用去重 | 服务端投递前下载当前、引用和所选历史附件；旧服务端需升级 |
| 个人 Telegram | 已收到并存入本地的本群/topic 增量，加精确引用 | 可用缓存中的所选历史媒体；重启/过期缺失须可见；全响应模式不额外下载 |
| 官方 Telegram | 桌面本地群窗口，加服务端提供的精确引用 | 现有签名图片读取链路与引用附件；不声称所有历史文件都有原件 |
| 企业微信、钉钉 | 已收到的同群本地窗口；企业微信另保留平台提供的精确引用，钉钉目前无引用入口 | 历史池只有文件名时明确只提供记录，当前附件维持原链路 |
| 微信 | 现有私聊连续对话；平台提供的引用按统一单条上限 | 不伪造群历史或无法读取的附件；本改动不扩展渠道接收范围 |
| Discord | 私聊为现有连续对话；服务器频道 / thread 是各自的 lane 会话，只含主人 @ 机器人的消息，不收集未 @ 的频道正文，不做群窗口 | 只收到被 @ 的消息（无 MessageContent intent）；原件按统一附件通道，不伪造历史 |
| Slack | 当前 thread 内按用户游标补增量 | 所选历史文件下载状态同时写入模型上下文与展示记录 |
| X | 只沿当前帖的祖先回复链，近祖先优先；仍受原有付费读取预算约束 | 保留现有媒体读取能力，不扩大月度读取额度 |

本上限只管每次注入，不修改历史存储保留策略或显式历史检索。模型输入与展示复用同一截断结果；展示可去掉内部身份标记，不能另取一批消息。游标仍只在实际受理后提交，拒绝/失败不吞掉下一轮历史。
