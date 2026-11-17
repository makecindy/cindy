# 官方 Telegram 进度消息由客户端渲染（`telegram-progress-ops-v1`）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

双向能力，只在 telegram 连接上声明，且必须与 `msg-op-v1` 同时协商。协商后桌面端用与个人
bot 同一份过程载体与渲染（见 `docs/product-rules/telegram-bot-parity.md` 第一节）经
`msg.op` 驱动进度消息；服务端只执行，`turn.progress` 照发但只用于续 lease（私聊草稿模式
例外，仍由服务端按 `turn.progress` 出草稿）。全部为可选字段增量：

- `MessageOpPayload.purpose?: 'turn-progress'`：有它时 `requestId` 必填，只用于
  `send` / `edit`（parse 强制）。服务端据 requestId 核验设备归属，把新消息登记为该轮进度
  消息，终稿后照旧清理；本轮不归客户端承载或已收口时回 `PROGRESS_UNAVAILABLE`。
- `MessageOpResultPayload.errorCode?: string | null`：服务端自判拒绝码（开放集合，常量
  `MESSAGE_OP_ERROR_*`）；`channelErrorCode?: number | null`：Telegram 原生 error_code
  原样透传，`error` 放渠道原文。
- 幂等：服务端按 opId + 内容指纹去重；回执未知（含 `OUTCOME_UNKNOWN`）时客户端原样重发
  同 opId 同正文，不换号、不换正文。服务端有应答时只回显原结果；也没有应答时每个 opId
  只重新执行一次，之后回显缓存的 `OUTCOME_UNKNOWN`。卡片与终稿段最多原样重发 2 次，仍未知
  就放弃（终稿以 `clientFinal.complete=false` 交回）；进度首帧每个节流窗口重发一次。

任一侧缺席时行为与本能力出现前逐字相同；无数据库迁移、Mobile 冷更或部署顺序要求。实现见
`hook-control/telegramTurnCarrier.ts`、`telegramMsgOp.ts` 与
`packages/lizi-im/src/telegram/outboundPolicy.ts`。

同一轴上另有三个独立协商的能力（都要求同时协商 `msg-op-v1`，任一缺席该段照旧由服务端
渲染）：

- `telegram-final-ops-v1`：普通成功轮次的终稿经 `purpose: 'turn-final'`（`send` 带
  `finalPart`；协议形状仍允许 `media`，但服务端一律拒收，桌面端也不发：带附件的轮次整轮随 `turn.end`
  交给服务端，因为持久出箱只存终态文本，本端上传附件中途退出会丢附件）发布；
  `TurnEndPayload.clientFinal?: { complete }` 告诉服务端是否全部确认。complete 时服务端
  不再渲染、提升续跑锚点并做收口副作用；否则删掉已落地的客户端终稿段并照旧自己发布。
  私聊草稿模式下服务端对终稿 op 回 `TURN_UNAVAILABLE`（终稿随草稿通道由服务端发布），
  桌面端按停手码交回。桌面端发布前先把不带 `clientFinal` 的 `turn.end` 写进持久出箱，
  崩溃重放走「交回服务端」那一版，终稿必达不降级；本进程仍在发布时重连不重放这份兜底帧。
- `telegram-card-ops-v1`：执行中交互卡经 `purpose: 'interaction-card'`（带
  `interactionId`；收口 `edit` 带 `interactionClosed` 并清空按钮）发布；按钮 token 即
  buttonId，回调仍由服务端转成 `interaction.decision`。协商后桌面端不再为这类卡发
  `interaction.request` / `interaction.cancel`，op 被明确拒绝时才回落旧帧。
- `telegram-commands-v1`：新增 `provider.commands.set` 帧（默认菜单有且仅有一份，
  command / description 遵守 Telegram 限制），服务端执行 `setMyCommands`；只管理默认菜单与
  `zh` / `ja` / `ko`，每次全量重写，其它语言码（含显式 `en`）忽略。菜单只存服务端
  内存、不落库：desktop 每次握手重发，服务端重启后到桌面重连前用服务端默认菜单。

新增拒绝码 `TURN_UNAVAILABLE`（终稿 / 卡片 op 时这一轮已收口或不属于该设备）。`msg.op`
各 purpose 允许的动作与附属字段由 parse 强制联动，放错位置一律拒收。
