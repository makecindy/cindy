# Telegram 统一消息桥接设计

> 状态：设计稿，供客户端实现与跨仓协议评审使用。本文不是已上线能力清单。
>
> 目标：让官方 bot 与个人 bot 在用户能感知的消息过程、终稿收口和能力降级上遵守同一套
> 消息语义，同时保留两条入口在身份、绑定、权限、群触发和可靠性上的必要差异。
>
> 本文只设计客户端边界，不修改服务端、`cindy-protocol`、数据库 schema 或线上行为。
> 文中标为“目标”的内容不应被读成当前已经接线。

## 1. 先给结论

最终形态不是两份互相复制的 Telegram 消息系统，也不是把两个 bot 强行塞进一个带条件分支
的 adapter。应采用一份共享的消息内核，加上两个很薄的传输出口：

```text
                    ┌──────────────────────────┐
                    │  Telegram 消息内核        │
                    │  事件 → 呈现 → 生命周期   │
                    │  终稿栅栏 → 回执/重试      │
                    └────────────┬─────────────┘
                                 │ provider-neutral intents
                    ┌────────────┴─────────────┐
                    │                          │
       个人 bot adapter                    官方 bot adapter
       Telegram Bot API                    msg.op / legacy frames
       owner + local token                 binding + principal + server auth
```

共享内核拥有“这一轮消息应该经历什么状态”；adapter 只拥有“怎样把一个意图投递到对应
的 Telegram 连接”。官方 adapter 在新服务端支持时使用细粒度 `msg.op`，在旧服务端或能力
未协商时继续使用 `turn.progress` / `turn.end` 回退。个人 adapter 直接调用 Bot API。

这会解决“最后一个答案一直等、迟到的进度又把终稿改回去、两条代码越维护越不一样”这类
客户端问题，但不会假装客户端可以替服务端完成官方 bot 的授权和消息操作。官方真正的
`send` / `edit` / `delete` / `typing` / `media` 仍须等服务端提供并声明对应能力。

### 1.1 当前实现与目标设计的边界

| 范围              | 当前已经存在                                                                                      | 本设计要达到的目标                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 文本与过程合成    | `apps/desktop/src/main/im/shared/turnPresenter.ts`、`turnActivity.ts` 已共享                      | 由内核继续作为唯一过程视图来源；不把两种正文累积模式误合成一种       |
| 个人 bot 过程消息 | `sendMessage` 建首条真实消息，之后 `editMessageText` 节流更新；终稿有原位编辑失败后的 repost 兜底 | 统一为“过程载体”和“新鲜终稿”两个明确阶段；删除旧载体不阻塞答案       |
| 官方 bot 过程消息 | 主要由 `turn.progress` / `turn.end` 驱动；桌面端目前只真正消费 `msg.op` 的 `react`                | 用官方 adapter 兑现同一内核意图；未协商时保留旧帧回退                |
| 终稿              | 官方桌面已有本地 `requestLedger` 持久终稿账本；服务端不保存正文/outbox；个人主要是进程内尽力投递  | 终稿发送独立于过程更新，建立终稿栅栏、幂等键和不确定回执处理         |
| 草稿              | 个人曾试用原生草稿，因只能承载一行纯文本而撤回；当前个人 DM 也走消息流                            | 只有声明支持完整过程内容的 DM draft 能力时才启用；草稿永远不承载终稿 |
| 消息效果          | 官方服务端已有 DM 终稿 `messageEffectId`；个人能力契约为不支持                                    | 以可选装饰意图下发；失败只降级装饰，不影响正文送达                   |
| 数据库            | 群消息库与保留核心已共享，但 provider namespace 分开                                              | 保留 namespace 隔离和消息所有权；本设计不改 schema                   |

### 1.2 与已合并的 #2305 的关系

PR #2305（官方 Telegram 进度呈现与完成收口）已经合并。它补的是官方 `turn.end` 之前
的最后一次进度 flush，防止 observer 的尾沿节流在 teardown 时吞掉最后快照；它不是
`msg.op` 消息桥，也没有让官方 bot 具备个人 bot 的完整终稿生命周期。

本设计把 #2305 的 flush 保留为**旧帧 adapter 的兼容回退**，不回退、不重复实现。未来
官方 adapter 切到 `msg.op` 后，终稿栅栏仍要先阻止迟到的 `turn.progress`，而不是依赖
“再 flush 一次”来保证答案。

## 2. 术语与不可变身份

### 2.1 用户可见术语

面向用户仍使用“任务、对话、消息”的既有边界；`turn` 是内部“一轮”，不要在 UI 文案里
把一轮称为新的产品对象。过程载体、终稿和交互卡都是消息呈现阶段，不是额外的任务。

### 2.2 一轮的身份键

内核不直接接受裸 `chatId` 或裸消息 ID。每个事件和出站意图都带有以下逻辑身份（具体
wire 字段由未来协议另行裁定）：

```ts
type TelegramRoundIdentity = {
  provider: "telegram-personal" | "telegram-official";
  accountId: string; // personal botId；official connection/account
  scope: {
    kind: "dm" | "group";
    chatId: string;
    deliveryThreadId: string | null; // Telegram 投递位置，可是 reply root
    topicId: string | null; // 仅 is_topic_message 才是归属 topic
    replyToMessageId: string | null; // 本轮受理时冻结的回挂锚点
  };
  principalId: string | null; // official 必须来自触发者；personal 可为空
  bindingId: string | null; // official 绑定代际
  bindingGeneration: number;
  connectionGeneration: number;
  roundId: string;
};
```

`deliveryThreadId` 与 `topicId` 不能互换。Telegram 普通群的 reply 链也可能带
`message_thread_id`；它决定消息投到哪里，但只有 `is_topic_message === true` 才能决定
它属于哪个 topic lane。

`replyToMessageId` 在本轮被受理时冻结。过程消息、交互卡和终稿都从这份 round identity
取回挂目标，不能在发送终稿时重新从“最近群消息”或可变队列领取；这是防止群友新发言把
最后答案挂错位置、看起来像被替换的关键不变量。

内核生成的每个意图还带 `sequence`（同一 `roundId` 单调递增）和 `phase`。adapter 必须
拒绝不匹配的 `bindingGeneration` / `connectionGeneration`，以及终稿栅栏之后的过程更新。

## 3. 身份、主人、群友和陌生人路由矩阵

下表描述**现有行为必须保留**的身份差异；统一的是消息内核，不是权限模型。

| 入口与来信                                     | lane / 身份                                                                        |                        是否创建任务 | 允许的执行范围                                                             | 用户可见响应                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------: | -------------------------------------------------------------------------- | ------------------------------------------------- |
| 个人 bot 私聊，bot owner                       | `telegram-personal:<botId>` + user chat                                            |                                  是 | 按个人 bot 的 owner 权限与本地设置                                         | 正常过程消息、终稿、交互卡                        |
| 个人 bot 私聊，非 owner 或未通过 auth          | 仍按该 bot 的 chat 隔离                                                            | 由个人 auth/policy 决定；不通过则否 | 不得越过 owner / channel policy                                            | 现有陌生人或权限提示；不把拒绝伪装成已执行        |
| 个人 bot 群内正确 `@`、回复 bot 或有效命令     | 一群（及 topic）共享 per-chat lane                                                 |                                  是 | 群轮次沿用个人 bot 的低权限/强制确认策略；不因统一内核改成 owner bypass    | 过程消息与终稿发回原群/原 reply 位置              |
| 个人 bot 群友/陌生人普通发言（`mention` 模式） | 写入共享群窗口，不取得 owner 身份                                                  |                                  否 | 仅作同群上下文；不能借 owner 轮次访问其它群或私聊                          | 无主动回复                                        |
| 个人 bot 群 `always` 的 ambient 消息           | 同一群 lane，`ambient=true`                                                        |                    是（若正文有效） | 同上                                                                       | 不 typing、不打过程表情；模型可用 `NO_REPLY` 静默 |
| 官方 bot 私聊，已绑定 principal                | `telegram:<principalId>`                                                           |                                  是 | 路由到该 principal 当前 `bindingId` 的 Cindy 桌面；使用官方既有权限口径    | 由绑定桌面驱动过程、交互和终稿                    |
| 官方 bot 私聊，未绑定 principal                | 无有效 binding                                                                     |                                  否 | 不创建任务、不猜测其他人的桌面                                             | 限频关联/绑定提示                                 |
| 官方 bot 群内，已绑定 principal 正确 `@`       | 主群 `telegram:group:…:<principal>`；topic `telegram:topic:…:<thread>:<principal>` |                                  是 | 只进入发言者自己的 binding；不把被 @ 的其他群友当主人                      | 回到该群；relay 的其他副本不等于该轮的回答        |
| 官方 bot 群内，未绑定发言者 `@`                | 无有效 binding                                                                     |                                  否 | 不创建任务，不替未绑定用户执行                                             | 限频关联提示；不得把提示当作任务结果              |
| 官方群友/陌生人普通发言（未触发）              | 可能成为 `group.message` relay 上下文                                              |                                  否 | 只能投给该群已登记且 recipient 代际匹配的桌面；不取得任何 binding 的执行权 | 无主动回复                                        |
| 官方群 relay 给同群其他已登记桌面              | `group.message` + 精确 `recipient{bindingId,principalId}`                          |  否（除非该桌面随后收到自己的触发） | 只作为本地群窗口/上下文；接收方代际必须精确匹配                            | 通常无 Telegram 出站；不会覆盖别人的终稿          |
| 任一 bot 的 topic/reply                        | `topicId` 由归属判据决定，裸 thread 只用于投递                                     |                      按上行触发规则 | topic lane 与主群 lane 隔离；普通 reply 不得凭空新建 topic lane            | 终稿沿用原 reply/topic 目标                       |
| 连接重连、换绑、解绑后迟到帧                   | 原 round 的旧 generation                                                           |                                  否 | fail-closed；不向新主人或新 binding 写消息                                 | 旧过程载体可留在原聊天，但新终稿不能被旧帧覆盖    |

### 3.1 “官方 bot 关联任何被 @ 的人”具体含义

官方 bot 的 `principalId` 是**发言人的 Telegram user ID**。`@Cindy` 不是把消息发送给
被 @ 的任意群友，而是把这条触发路由到发言人自己绑定的 Cindy 桌面。群中其他已登记桌面
可能收到 relay 上下文，但它们不是这条任务的 owner，也不能借 relay 结果回写回答。

个人 bot 则是用户自持 token 的低权限入口；群里多人共用一条 per-chat lane 的既有行为
不能被官方 principal lane 的规则覆盖。

## 4. 共享消息内核与两个 adapter 的边界

### 4.1 内核负责什么

共享内核是纯客户端业务层，至少包含以下职责：

1. 把 thinking、工具调用、正文增量、交互请求和终态转换为统一的活动模型；
2. 使用 `turnPresenter` / `turnActivity` 的同一过程视图规格，保留
   `finalized-segments` 与 `buffer-replace` 两种明确正文模式；
3. 管理过程载体（draft 或过程消息）、终稿消息、交互卡和 typing 的生命周期；
4. 只生成 provider-neutral 的 `send`、`edit`、`delete`、`react`、`typing`、`media`、
   `effect`、`flush`、`reconcile` 意图；
5. 执行长度限制、分段、Markdown/HTML/Rich Message 分层和降级顺序；
6. 在终稿栅栏后丢弃迟到的过程帧，处理 `NO_REPLY`、取消、失败、断线和不确定回执；
7. 给每个意图分配稳定的 `roundId + phase + sequence`，保证幂等和所有权可追踪；
8. 把可测试的结果状态交给 adapter，不把“API 调用返回了”误当成“用户已经看到”。

内核不负责 Telegram token、服务端 binding、principal 授权、群成员证据、服务端 relay
扇出或消息数据库 schema。

### 4.2 过程区与工具调用的用户可见规则

两个 bot 的过程内容必须来自同一套 presenter 输出，不允许 adapter 自己拼另一份“更像
Telegram”的时间线：

- thinking、工具调用和正文按实际发生顺序进入同一轮；同一个 thinking block 原位更新，
  同一个 `toolUseId` 在 replay/重连后去重；
- 工具调用显示共享的人类可读摘要，不直接倾倒整段 JSON、命令参数或可能含凭证的原始输入；
- 默认展示最近五个可读步骤和总步骤数，正文继续显示在过程区下方；等待授权、等待回答、
  自动重试与“正在写”是明确状态，不伪装成一个新的工具步骤；
- 稠密事件按同一 trailing-edge 规格合帧；完全相同的快照不重复编辑，前缀相似不能被误判
  为相同，否则正文增量会看起来卡死；
- DM draft 若不能完整承载这些步骤，就必须降级为真实过程消息，不能只显示一行“思考中”；
- 成功终稿只包含正文；失败是否保留过程现场、ambient 是否静默继续按 parity 台账裁决，
  不在 presenter 里偷做统一。

adapter 只决定这些内容放进 draft、真实过程消息还是 legacy progress 帧，不得改变顺序、
文案摘要、去重和终态语义。

### 4.3 个人 bot adapter 负责什么

- 持有 Bot API client、token、owner 和本地 `configVersion`；
- 解析 Telegram 入站的 `is_topic_message`、reply、media 和群 activation；
- 把内核意图投到 `sendMessage` / `editMessageText` / `deleteMessage` /
  `sendChatAction` / media API；
- 维护本地 reply target、typing loop 和个人 bot 的 outbox/重试边界；
- 以 `telegram-personal:<botId>` 隔离群消息窗口和消息所有权；
- 在每个真实出站 await 前验证本轮 owner 与 connection generation 仍有效。

个人 adapter 不能因为共享内核而获得官方 bot 的 principal 绑定语义，也不能把群成员的
消息自动提升为 owner 权限。

### 4.4 官方 bot adapter 负责什么

- 把入站 `task.dispatch` / `group.message` 解释成官方 principal/binding 上下文；
- 在 `recipient{bindingId,principalId}`、当前 binding 和 generation 不一致时丢弃；
- 新能力可用时经 `msg.op` 请求服务端执行 Telegram 出站；
- 未协商或旧服务端时回退到现有 `turn.progress` / `turn.end`；
- 处理官方桌面本地 `requestLedger` 终稿账本、ACK、客户端重投和 24 小时终稿时效；服务端
  不取得正文 outbox 所有权；
- 保留官方 `/status`、`/unlink`、群 onboarding 和 per-principal lane；
- 不把客户端自带的 `chatId` 当授权依据，所有发送目标必须来自服务端授权上下文。

官方 adapter 不能把个人 bot 的本地 token、群低权限模型或 per-chat lane 带入官方出口。

### 4.5 内核意图的最小形状（设计，不是当前协议）

```ts
type BridgeIntent = {
  round: TelegramRoundIdentity;
  phase: "process" | "final" | "cleanup" | "interaction" | "decoration";
  sequence: number;
  deliveryKey: string; // roundId + phase + logical part；重试不变
  op:
    | { kind: "send-process"; content: RenderedContent }
    | { kind: "update-process"; carrier: CarrierRef; content: RenderedContent }
    | { kind: "send-final"; content: RenderedContent; effect?: string }
    | { kind: "clear-process"; carrier: CarrierRef }
    | { kind: "delete-process"; carrier: CarrierRef }
    | { kind: "typing"; active: boolean }
    | { kind: "react"; target: InboundMessageRef; emoji: string }
    | { kind: "media"; content: MediaContent }
    | { kind: "reconcile"; deliveryKey: string };
};
```

`BridgeIntent` 不是本 PR 要加入的 wire 类型；它是未来客户端内核和 adapter 之间的内部
边界。协议字段、版本和服务端授权要在后续跨仓 PR 中单独定义。

## 5. 消息状态机

```text
                  ┌──────────────┐
                  │   CREATED    │
                  └──────┬───────┘
                         │ activity / first content
                  ┌──────▼───────┐
                  │    RUNNING   │
                  └──────┬───────┘
                         │ send/update process carrier
                  ┌──────▼───────┐
                  │ CARRIER_LIVE │──────┐
                  └──────┬───────┘      │ cancel / fail / NO_REPLY
                         │ terminal     │
                  ┌──────▼───────┐      │
                  │ FINAL_INTENT │      │
                  └──────┬───────┘      │
                         │ fresh send  │
                  ┌──────▼───────┐      │
                  │ FINAL_PENDING │      │
                  └──────┬───────┘      │
                         │ accepted    │
                  ┌──────▼───────┐      │
                  │  FINAL_SENT  │      │
                  └──────┬───────┘      │
                         │ cleanup     │
                  ┌──────▼───────┐      │
                  │   SETTLED    │      │
                  └──────────────┘      │
                                         ▼
                              NO_REPLY / CANCELLED / FAILED
```

### 5.1 状态不变量

- `FINAL_INTENT` 一旦创建，任何 `update-process`、typing 续命和过程表情都失效；它们
  可以被记录为 stale，但不能再触达 Telegram。
- 一个 `roundId` 只能有一个逻辑终稿。长文本的多个 Telegram 分段属于同一个终稿，使用
  固定的 part index 和稳定 `deliveryKey`。
- 终稿默认是**新鲜普通消息**，不把 draft 转存成终稿，也不依赖旧过程消息编辑成功。
  这样群 relay、迟到帧和消息替换都不会把最终答案重新变成过程态。
- `FINAL_SENT` 以 adapter 的成功回执为准；清理过程载体失败不能把状态倒退成失败，也不能
  删除已经确认的终稿。
- `UNKNOWN` 回执不能直接当失败重发。adapter 必须先 reconcile；无法核实时保留终稿出箱
  记录，使用同一 `deliveryKey` 做有界重试或人工可见的待投递状态。
- 长终稿只送达部分分段时进入 `FINAL_PARTIAL`：已经确认的 part 不重发，只重试未确认
  part；所有 part 都确认后才进入 `FINAL_SENT`。不能因为末段失败而复制前面已经看到的内容。
- 删除失败允许“旧过程消息 + 新终稿”并存，答案优先；不能为了视觉整洁而再次删除终稿。
- 所有状态变更都检查 round identity。换绑、解绑、owner 变化和连接切换不能让旧回调写入
  新聊天。

## 6. Cindy 的“过程载体 → 新鲜终稿 → 清理”算法

Hermes 的可借鉴点是同轮 draft 身份、草稿与持久消息的区分、终稿编辑失败后的立即补送、
FloodWait/分段测试和 Rich 能力降级，不是逐字照搬它当前的终稿算法。对 2026-08-10 最新
`upstream/main` 的复核显示：Hermes 对流式 Rich 消息优先用 `editMessageText + rich_message`
原地定稿，只有最终编辑失败时才新发终稿，目的是避免清理竞态期间短暂出现两份答案。

Cindy 这里仍选择“新鲜普通终稿先送达，旧过程载体后清理”，因为产品目标明确要求终稿不再
被群 relay、迟到过程帧或旧载体更新替换。这是 Cindy 的一致性取舍，不应在实现说明里写成
“Hermes 当前就是这样”。共享的原则仍是：同一轮只复用自己的过程载体；草稿不等于持久
送达；终稿失败不长时间卡在等待；清理永远排在答案之后。

### 6.1 过程载体选择

1. DM 且 adapter 声明 `draft.rich-process-v1`：为本轮生成唯一 `draftId`，过程更新始终
   使用它；同一轮内不换 `draftId`，下一轮绝不复用。
2. DM 不支持完整 draft，或是群/topic：使用真实过程消息。第一次有可显示内容时
   `send-process`，之后 `update-process`；空过程不创建消息。
3. 不能把旧的“单行纯文本 draft”重新打开。工具步骤、thinking 和正文无法在那条通道
   完整呈现时，必须退回过程消息；宁可多一条可编辑消息，也不能给用户一个看似在思考、
   实际没有内容的输入框动画。

### 6.2 正常终稿

1. 收到终态后先停止新的过程事件进入发送队列，设置 `FINAL_INTENT` 栅栏。
2. 立即从 presenter 取得完整正文，按 adapter 能力选择 Rich → HTML/Markdown → plain，
   分段并为每段生成稳定 `deliveryKey`。
3. **发送新的普通终稿消息**，并沿用 round identity 中冻结的 `replyToMessageId`。不要先编辑
   旧过程消息，不要把 draft 当成已送达消息，也不要从此刻最新的群消息重新选回挂目标。
4. 所有终稿分段都获得成功/可确认回执后，标记 `FINAL_SENT`。
5. 如果使用 draft，发送一个空内容清理请求；如果使用过程消息，尽力删除旧载体。两者
   都是 cleanup，不得阻塞第 3 步，也不得覆盖第 4 步的结果。
6. 清理失败记录为 `CLEANUP_PENDING`，在同一 round 的安全重试窗口中处理；重试时只操作
   本轮拥有的 carrier。

### 6.3 失败、超时和不确定回执

- 已知永久失败：保留过程载体，发送可见错误（若该轮不是 ambient）；不声称终稿已送达。
- 临时失败：终稿 intent 进入 outbox，重试使用相同 `deliveryKey`；终稿栅栏仍然生效，
  不能让新的过程帧插入。
- 请求超时但服务端可能已受理：状态为 `UNKNOWN`，先调用 `reconcile` 或等待服务端
  `msg.op.result`；没有确认前不盲目再发一条，避免重复答案。
- 断线：过程更新可以丢弃或降级，终稿必须进入相应 adapter 的持久/内存出箱；恢复后先
  清理过期项，再按 delivery key 重放。官方沿用桌面本地 `requestLedger` 约 24 小时的发布
  边界；服务端不新增正文 outbox。个人是否引入等价落盘属于后续产品决策，不在本设计中
  偷偷改变。
- 取消在终稿受理前生效：停止过程与终稿发送，清理 carrier，回写“已取消”；取消在终稿
  已受理后到达：不删除终稿，只记录“取消晚于完成”，避免用户看不到答案。
- `NO_REPLY`：不发送终稿；清理 draft/过程消息尽力而为。若删不掉，允许留下过程痕迹，
  但不能发一条“空答案”或错误消息。

## 7. 能力协商与降级

当前 `HOOK_FEATURE_MESSAGE_OPS` 是一个较粗的总开关。服务端 PR #366 把它落实为一个
**reaction 专用**的安全网关：桌面侧实际也只用它发送带 `requestId` 的 ack / 结果 reaction。
它不是“服务端已经可以替客户端发送消息”的信号。目标是保持这个总开关兼容，同时增加
逐操作声明；本 PR 不修改协议，只规定客户端应如何消费。

建议的能力粒度（名称仅为设计候选）：

| 能力                             | 用途                                                                    | 未声明时的降级                                                       |
| -------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `msg-op-v1`                      | 当前仅为 request-scoped reaction 与其回执；未来操作 envelope 的共同底座 | reaction 不发；正文、过程与终稿仍走 `turn.progress` / `turn.end`     |
| `msg-op.send`                    | 发送新消息                                                              | 旧终稿帧路径；不能假设服务端可代发                                   |
| `msg-op.edit`                    | 编辑指定 bot 消息                                                       | 过程快照走旧 progress；终稿仍新发                                    |
| `msg-op.delete`                  | 删除 bot 自己的过程消息                                                 | 留两条并存，答案不丢                                                 |
| `msg-op.typing`                  | typing 生命周期                                                         | 不显示 typing，不影响任务                                            |
| `msg-op.media`                   | 图片/文件出站                                                           | 文字终稿先送，媒体单独降级/重试                                      |
| `msg-op.result-v1`               | 每个操作的成功、失败或未知回执                                          | 只允许可确认的旧帧路径                                               |
| `msg-op.recipient-v1`            | binding/principal 精确接收者                                            | 未协商时沿用旧 relay 安全路径；新客户端不接受无 recipient 的新 relay |
| `telegram.rich-message-v1`       | Rich Message 内容                                                       | HTML/Markdown，再退 plain                                            |
| `telegram.draft.rich-process-v1` | 完整 DM 过程 draft                                                      | 真实过程消息 + edit                                                  |
| `telegram.message-effect-v1`     | 终稿 `messageEffectId`                                                  | 不带效果重发/继续正文，不重复发送正文                                |
| `telegram.custom-emoji-v1`       | 自定义 emoji 内容或 reaction                                            | 标准 emoji 或纯文本语义                                              |

能力必须按当前连接和 binding 快照使用。连接重建后重新协商；旧快照不能跨 generation
继续发操作。未知能力一律按未声明处理，不通过“尝试一下再看报错”探测。

特别地，客户端在只看见 `msg-op-v1` 时，**只能**发 `react`；不得把服务端会返回
“not supported”的 `send`、`edit`、`delete`、`typing` 或 `media` 当作可用的降级路径。
启用任一非 reaction 操作前，必须先有该操作的显式能力声明，并在同一连接上同时确认
`msg.op.result` 回执。这样 PR #366 可以单独上线，客户端共享内核和官方 legacy adapter
也可以同时开发，而不会把正文投递押在尚未发布的服务端功能上。

## 8. 新旧客户端与新旧服务端兼容矩阵

|              | 旧服务端                                                                                                    | 新服务端                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **旧客户端** | 当前行为：官方 `turn.progress` / `turn.end`，个人 Bot API；无新操作                                         | 新服务端继续发送旧帧；旧客户端忽略未知可选字段/操作，不接收 `msg.op`，行为与左格相同                                                                        |
| **新客户端** | 连接能力为空；官方使用 legacy adapter（含 #2305 的末帧 flush），个人仍可使用共享内核；不发送未协商 `msg.op` | 仅有 PR #366 的 `msg-op-v1` 时只通过网关发送 reaction，正文仍走 legacy；以后协商到逐操作能力才启用对应 adapter 意图，缺能力的单项按上一列降级，不能整轮卡住 |

兼容要求是“可独立发布”：任何一端单独升级都不能出现石沉大海、最后终稿永久等待或把
迟到过程帧写回终稿。新客户端不能要求新服务端先上线；新服务端也不能假定所有客户端都
会消费 `msg.op`。

## 9. 绑定、换绑、代际和 fail-closed

### 9.1 官方

- `recipient.bindingId` 与 `recipient.principalId` 必须同时精确匹配当前 confirmed binding；
  缺一、错一或成员证据过期都丢弃。
- 官方 task dispatch 的 `principalId` 来自入站发言者，不从客户端传来的 `chatId` 推主人。
- 解绑、换绑、退群、账号退出和 binding 状态不确定时，停止新出站；保留旧 binding 的状态
  只用于完成幂等 ACK/清理，不得把答案写给新主人。
- relay 只做上下文投影，不取得任务执行权；旧 relay 帧不能覆盖新 principal 的终稿。
- 服务端授权失效代际必须按 binding/principal 隔离；无关 Telegram 用户的绑定、解绑或换绑
  不能让当前操作误报失效。
- 同一目标消息的 mutation（至少 `react` / `edit` / `delete`）必须按
  `(botId, chatId, messageId)` 串行；只按 `opId` 合并不能阻止较老操作延迟完成后覆盖新状态。
- 撤销与外部 Bot API 副作用必须有明确线性化边界。建议以 per-binding 队列/租约覆盖授权复核
  到 Bot API 请求受理：先在线性化点取得执行权的操作可以完成，先完成撤销的操作必须拒绝。
  仅在 API 返回后再比较全局 epoch，既撤不回已经发生的副作用，也会误伤无关 binding。

### 9.2 个人

- 每轮拍下 `ownerUserId`、Bot API client 和 `configVersion`；每次真实出站（包括 repost、
  edit、delete、图片分组中的每一张）前重新验证。
- 换 token、换 owner、dispose、轮询重启或 API client 替换都使旧 round 的出站失效。
- 失效后不把暂时读不到配置当成新授权；保守地停止该轮并保留可恢复的终稿记录。

### 9.3 统一规则

generation 是安全边界，不是 UI 状态。任何“旧消息刚好能编辑成功”都不能证明它仍属于
当前 round；所有 adapter 都必须先验证身份，再调用 API。

## 10. 数据库命名空间与消息所有权

消息数据库已经共享实现，但命名空间不能合并：

- 官方：`telegram:<principalId>`；
- 个人：`telegram-personal:<botId>`。

群窗口的字节上限、回收低水位和 SQL lane 条件继续来自共享 `groupWindowCore` /
`groupHistorySearch`。保留策略按字节，不改成按条数，也不在本设计里增加 migration。

每个出站记录的逻辑 owner 至少是：

```text
provider + accountId + bindingId/principalId + chatId + topicId + roundId + carrier/final role
```

过程载体只能由创建它的 adapter、同一 round 和同一 generation 编辑/删除；终稿消息与过程
消息是两种不同 role，不能以“同一 chat”互相替代。入站消息上的 reaction 是另一种 owner
关系，必须通过当前 bot/provider 的授权判据。

## 11. Rich Message、reaction、message effect 与 custom emoji

这四类能力不能混为一谈：

| 能力           | 语义                                                                | 当前状态                                                       | 目标降级顺序                            |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| Rich Message   | 正文的结构化排版（标题、列表、表格、代码、公式、details、媒体引用） | 个人已有 `rich_message` 定稿尝试；官方桌面尚未通过 msg.op 接线 | Rich → HTML/Markdown → plain            |
| reaction       | 给入站触发消息打 ack/结果表情，是装饰/反馈                          | 个人已有；官方目前通过 `msg.op` 接入                           | 变体 emoji → 基础 emoji → 不打表情      |
| message effect | Telegram 终稿的动画/夸张效果                                        | 官方 DM 服务端已有 `messageEffectId`；个人能力为 false         | 带 effect 发送 → 不带 effect 的同一终稿 |
| custom emoji   | 消息正文或 reaction 中的自定义 emoji                                | 依赖具体 Bot API / 服务端能力协商                              | 自定义 emoji → 标准 emoji → 文本语义    |

当前协议的 `send` 已能承载正文、reply、tier、silent 和按钮，`media` 能承载附件，`react.big`
能承载夸张 reaction；但它没有显式 `messageEffectId`，也没有完整过程 draft 动词。阶段 5 若仍以
“客户端决定消息形态、服务端只执行”为目标，就必须补协议字段/动作，不能让服务端从 `tier`
或正文内容猜效果，也不能继续把 legacy 服务端渲染误称为共享内核已经接管。

装饰失败不能让正文重发一遍。若正文发送回执不确定，先 reconcile；只有确认正文尚未送达
且 adapter 能保证相同 `deliveryKey` 幂等时才允许重试。

## 12. 取消、失败、重连和清理矩阵

| 情况                   | 过程载体                                       | 终稿                                      | 清理与可见结果                                                             |
| ---------------------- | ---------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| 正常成功               | 停止更新                                       | 新鲜普通消息，全部分段确认后 `FINAL_SENT` | 清 draft/删旧过程；失败可两条并存                                          |
| 模型失败（普通轮次）   | 保留现场                                       | 不伪造成功终稿；按 adapter 发错误         | 记录错误，必要时保留过程区                                                 |
| ambient 失败           | 官方按既有静默策略；个人当前行为需另立 PR 判定 | 不发错误终稿                              | 至少保留日志/任务记录，不能因静默而丢诊断                                  |
| 用户取消，终稿尚未受理 | 尽力清理                                       | 不发送                                    | 卡片/typing 一并结束，状态 `CANCELLED`                                     |
| 取消晚于终稿受理       | 不再更新                                       | 保留已确认终稿                            | 只记录竞态，不删除答案                                                     |
| 连接断开               | 可以丢过程帧                                   | 进入 adapter outbox                       | 官方沿用桌面本地 `requestLedger` TTL，服务端不存正文；个人落盘策略后续裁决 |
| 终稿发送超时，回执未知 | 冻结，不再更新                                 | `UNKNOWN`，先 reconcile                   | 不盲目重复，恢复后用同一 key 处理                                          |
| 删除旧过程失败         | 不再更新旧载体                                 | 已送达终稿不受影响                        | 允许旧过程 + 新终稿并存，记录 cleanup pending                              |
| `NO_REPLY`             | 停止过程更新                                   | 不发送                                    | 清 draft/删过程尽力而为，不能发空消息                                      |
| 交互卡在终稿边界       | 卡片决策先入内核                               | 决策完成后才可发终稿                      | 卡片回调必须带 round/generation，迟到点击 fail-closed                      |
| 迟到 progress / relay  | 丢弃                                           | 不得覆盖                                  | 以终稿栅栏和 recipient/generation 作为双重门                               |

## 13. 分阶段迁移计划

每一阶段都必须能单独发布和回滚；后续阶段永远不能成为前一阶段的运行前置。

### 阶段 0：本设计（当前 PR）

- 写入本设计、补 parity 台账引用；
- 只读核对当前客户端、Hermes 参考和官方身份边界；
- 不改服务端、协议、schema、线上行为；
- 产出双出口 golden test 规格，作为实现验收清单。

### 阶段 1：客户端共享内核（客户端可独立发布）

- 把过程视图、终稿栅栏、delivery key、取消/失败/清理状态机抽成共享纯逻辑；
- 先让个人 adapter 和官方 legacy adapter 使用它，但输出保持当前形态；
- 增加状态机、generation、迟到帧和双出口 golden tests；
- 回滚只移除内核接线，不改变数据库和协议。

### 阶段 2：个人 bot 先切换

- 个人 adapter 采用“过程载体 → 新鲜终稿 → 清理”语义；
- 继续在不支持完整 draft 时使用真实过程消息；不重新启用旧单行 draft；
- 终稿发送成功后再清理，补齐未知回执与本地可恢复边界；
- 官方行为不受影响，便于先在用户自持 bot 上验证。

### 阶段 3：官方 legacy adapter 加固（无需等待 msg.op）

- 在 `turn.progress` / `turn.end` 回退路径中启用终稿栅栏，收到终态后拒绝迟到 progress；
- 保留 #2305 的末帧 flush，但不让 flush 参与终稿正确性；
- 让官方桌面本地 `requestLedger`、ACK 重放和客户端清理都经过同一生命周期模型；服务端
  继续只做授权执行，不新增正文 outbox；
- 这阶段仍不能让服务端执行任意 client-driven `send/edit/delete`，因此消息载体能力有限。

### 阶段 4：从 reaction 网关扩展细粒度 msg.op（跨仓独立 PR）

- 以 PR #366 的 reaction 网关为起点，逐项增加 `send/edit/delete/typing/media` 的显式能力，
  不能仅复用 `msg-op-v1` 这个粗开关来暗示它们可用；
- 每个新操作先实现授权、recipient、message owner、op result 与幂等/未知回执，再向客户端宣告；
- 新客户端仅在对应 capability 出现时启用 `send/edit/delete/typing/media`；
- 新旧四格矩阵逐格验收，旧客户端继续收到 legacy frames；
- 不把服务端未合并的操作预先假定为可用。

### 阶段 5：Rich、draft、effect 和 custom emoji

- 逐项启用，不以一个总开关捆绑所有 Telegram 新 API；
- 先在 DM 验证 draft 和 message effect，再扩展可安全的群/ topic 能力；
- 每项能力都要有失败只降级装饰/排版、不丢正文的测试。

### 阶段 6：清理 legacy（最后做）

- 只有新客户端和新服务端覆盖率、回执可观测性和回滚路径稳定后，才删除旧 progress/end
  adapter；
- 删除前至少保留一个版本周期的能力缺失回退，避免旧桌面或降级 relay 被黑洞吞掉。

## 14. 双出口 golden tests

### 14.1 共享内核测试

每个 fixture 输入同一组 thinking、tool、正文增量、交互卡、终态和故障注入，断言：

- 过程视图顺序和文本完全一致；
- 同一 round 的过程更新在终稿栅栏后全部被丢弃；
- 正常终稿一定先 `send-final`，后 `clear/delete-process`；
- `NO_REPLY`、取消、失败、未知回执和删除失败符合第 12 节；
- 重试使用相同 delivery key，迟到/重复回执不会生成第二个逻辑终稿；
- binding 或 generation 改变后不再产生有效出站意图。

### 14.2 个人 adapter fixtures

至少覆盖：

1. DM 首次真实内容、多个工具步骤、长终稿分段；
2. 无 draft 能力时过程消息编辑；有完整 draft 能力时同轮 draft id 复用、跨轮 id 隔离；
3. 原位编辑失败 → 新发终稿 → 删除失败，断言答案仍在；
4. `NO_REPLY` 在“尚未建消息”和“已经流出正文”两种时序；
5. 换 token/owner、重连、图片多组上传中的 generation 失效；
6. message effect/custom emoji 不支持时正文只发送一次。

### 14.3 官方 adapter fixtures

至少覆盖：

1. 新旧服务端四格能力协商；
2. `msg.op` send/edit/delete/result 的成功、永久失败、临时失败和未知回执；
3. legacy `turn.progress` / `turn.end` 末帧 flush 与终稿栅栏竞态；
4. binding/principal/recipient 不匹配、换绑和 relay 迟到帧；
5. 群友正确 `@`、未绑定陌生人 `@`、ambient、topic/reply；
6. 官方桌面本地 `requestLedger` 重连、24 小时过期和服务端重复 dispatch；
7. 官方 DM effect、Rich、media 能力单项缺失时的降级。

同一 fixture 的“用户可见事件序列”应能被两个 adapter 各自解释；不要求 Telegram API
调用字面相同，只要求阶段、所有权、终态和失败语义一致。

## 15. 当前可做与当前不能做

### 客户端现在可以直接做

- 抽取并接入共享消息内核与 golden tests；
- 先统一个人 bot 和官方 legacy 路径的终稿栅栏、迟到帧丢弃、清理非阻塞和状态可观测性；
- 在个人 bot 上验证 Cindy 的“新终稿再清旧载体”，并复用 Hermes 已验证的失败补送、
  回执与能力降级经验；
- 把 reaction、Rich、effect、custom emoji 作为可选能力，不支持时安全降级；
- 保持官方/个人身份和群权限差异，不需要等待服务端 PR。

### 必须与服务端/协议配合后才能做

- 官方 bot 真正的 client-driven `send/edit/delete/typing/media`；
- 官方端的完整 DM draft、Rich Message、message effect 和 custom emoji 出站；
- 服务端授权、recipient 和逐操作回执的 wire 契约；
- 删除旧 `turn.progress` / `turn.end` 的兼容路径。

因此本设计不会承诺“现在就把两边完全变成同一份 Telegram 代码”。正确的收敛目标是：
内核一份、adapter 两份、身份与权限差异显式保留、旧新能力可协商回退。

## 16. 参考实现与审计依据

- 现有共享呈现：`apps/desktop/src/main/im/shared/turnPresenter.ts`、`turnActivity.ts`。
- 个人 Telegram：`packages/lizi-im/src/telegram/streamingText.ts`、`index.ts`、
  `presentationCapabilities.ts` 及其测试。
- 官方 Telegram：`apps/desktop/src/main/hook-control/dispatcher.ts`、`manager.ts`、
  `session-runner.ts`、`requestLedger.ts`、`ackReactions.ts`。
- 官方身份与群中继：`hook-control/groupHistoryScope.ts`、`groupWindow.ts`、
  `manager.ts` 的 recipient/generation 校验。
- Hermes 本地审计的 `telegram-rich-bot-api`、`messaging-response-design` skill、
  native draft patch，以及 2026-08-10 的最新 `upstream/main` Telegram adapter/tests：
  借鉴 draft 生命周期、最终编辑失败补送、分段、FloodWait、回执测试和 Rich Message
  降级；Cindy 的“新终稿再清旧载体”是本项目自己的产品选择，没有把 Hermes 的当前实现
  误写成 Cindy 已有能力或一模一样的算法。
- 能力差异台账：[`telegram-bot-parity.md`](telegram-bot-parity.md)。
