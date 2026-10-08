# IM 一轮任务：入口账本与状态模型

> **状态**：权威开发规则（authoritative），随「IM 一轮任务合并」分批迁移持续更新
> **读取时机**：修改个人 IM 渠道（`apps/desktop/src/main/im/**`）或官方 hook
> （`apps/desktop/src/main/hook-control/**`）的找/建任务、命令、排队与插话、输入拼装、
> 事件观察、表情、交互、收尾或停止逻辑之前

个人 IM 渠道（Telegram / 飞书 / 微信 / 钉钉 / Discord / 企业微信）与官方 hook（官方
Telegram / Slack / X）是同一件事的两套实现：把渠道里的一条消息变成 Cindy 任务里的一轮，
再把结果送回渠道。本文登记两套实现**今天各自在哪一步做了什么**、**持有哪些状态**、
**合并后归谁**，以及迁移中必须守住的不变量。用户可见的两侧差异另见
[`../product-rules/telegram-bot-parity.md`](../product-rules/telegram-bot-parity.md)；
台账里标「有意不同」的项以策略参数表达，合并时不抹平。

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
| 默认配置 | `resolveImSessionDefaults(channel)` + 跟随渠道默认（`channelDefaultRouteSync`） | `resolveNewSessionConfig`（目录偏好 > 全局 IM 默认 > 清单首项；权限档规则见 `defaults.ts`） | 渠道策略（台账第三节「新会话的默认…从哪读」有意不同） |
| 命令 | `messageHandler.processOne` → `slashCommands`（注册表 `botCommands.ts`） | 服务端分发命令，桌面只收 `query.*` | 渠道适配（官方命令分发在服务端） |
| 排队与插话 | `SessionState.sendQueue`（内存、无上限、重启丢失）；无插话 | `dispatcher.queues`（内存、上限 20）+ `drainPolls`；无插话 | **公共入口 `AgentInputCoordinator`**（见 §5 批次 3 与 §6 待决项） |
| 输入拼装 | `prepareAgentTurnText`（群上下文 / ambient 提示）+ `buildImChannelNote` + `buildImUserMessage`；派发时前置交接 / 计划对账 / Goal 提示 | `buildContextPrefix` + `composeXPrompt` + `buildHookPromptNote`；同样前置交接 / 计划对账（仅 IM 来源）/ Goal 提示 | 共用流程（前置层同一份；渠道说明文案有意不同，见台账「入站上下文」） |
| 用户消息落库 | 部分渠道提前落库（`persistInboundUserMessageEarly`），`onAccepted` 补 `imSource` | 只在 `onAccepted` 落库，`agentMeta.hookSource` | 共用流程（`onAccepted` 落库；提前落库保留为渠道能力） |
| 发送 | `makerSession.send`，`MAIN_OWNED_SEND_CONTEXT.origin.kind='im'` | `session.send`，origin `hook`（Telegram/X）或 `im`（Slack） | 共用流程；Pi 管理命令授权来源按渠道各自声明（hook 不得伪装成本机命令） |
| 观察事件 | `turnPresenter`（buffer-replace）+ 流式 handle | `turnObserver`（finalized-segments）+ 进度发射器 | 共用流程（presenter 已同源；两个正文累积引擎有意不同） |
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
| Telegram 传输层（`chatQueues` / `typingLoops` / 回挂目标） | `packages/lizi-im/src/telegram/index.ts` | chat | 保留（个人出站载体） |

**不为合并新增**全局状态机或持久化表：队列与停止交给已有公共入口持有的状态；合并只移动和
删除现有状态。

## 3. 不变量（迁移每一批都必须守住）

1. **同一 externalKey / 同一渠道行 → 同一任务**；建任务与复用的判据不因迁移改变（台账第三节）。
2. **已提前落库的用户消息不重复插入**：`onAccepted` 只补元数据（`existingClientId`）。
3. **来源标签与模型说明同源**（[`message-source.md`](../product-rules/message-source.md)）：
   IM 写 `agentMeta.imSource`，hook 写 `agentMeta.hookSource`；新数据不得塞进 `origin`
   （coordinator 把任何 `origin.kind` 当非人工输入）。
4. **Pi 管理命令授权来源**：个人 IM 用 `authenticated-im-command`；官方 hook 的 origin
   是 `hook`，**不得**伪装成 `local-desktop-command`；`MAIN_OWNED_SEND_CONTEXT` 是 Symbol，
   跨队列快照时必须由宿主在派发时重新盖章，不能指望它随队列项持久化。
5. **session-new-v1**：`/new` 成功时新任务已落库并出现在列表；**turn-reopen-v1**：续跑轮
   断连即终局、`turn.end` 直发不缓存。
6. **群历史租约**：`beginGroupHistoryAccess` 在 provider 真正开始这一轮前登记、终态释放；
   `sessionInstanceId` 挡住旧实例借用新权限。
7. **计划对账**只在真实用户轮次注入（官方仅 `source.im` 存在时）。
8. **终稿必达**（官方）：`turn.end` 先进持久出箱；客户端发布终稿时以 `clientFinal` 交回。
   带附件的轮次不由客户端发布（出箱只存文本）；兜底帧写不进出箱时也不由客户端发布；本进程
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
