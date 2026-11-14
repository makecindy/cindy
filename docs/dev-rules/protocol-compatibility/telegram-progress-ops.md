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


## 统一普通提问（`telegram-question-ops-v1`）

另行双向协商并要求 `msg-op-v1`。`purpose=turn-notice` 必须带 requestId、interactionId 和 questionMode（blocking/async），
支持 `send` / `edit`，tier 为 html/plain，buttons 必填（关闭用空数组）。interactionClosed
只准用于 edit。禁止 delivery、replyToMessageId、effectId、silent、finalPart；位置由服务端
按原 lane 决定，客户端不可任意指定群或私聊。两仓 `protocol-notice.test.ts` 使用同一 fixture。
服务端每段最多 4096 字符、100 个按钮；客户端复用 Telegram 卡片布局与截断规则。

首次发卡需活跃任务，turn.end 与发送共用请求串行队列；结束后中断式卡片清理，异步卡片保留。questionMode 不允许在编辑时改变。
路由 requestId=null、terminal=false，externalKey 保留，避免最终片段/重跑回收。
路由保存失败重试一次，仍失败尝试撤回并返回 PERSIST_FAILED；删除未确认为 unknown。
初始发送确认后注册独立卡片，原群或 topic 不转 owner DM。按钮 token 绑定原 principal，
以及卡片、绑定、设备、键盘版本；回调复用 interaction.decision；仅异步卡片不要求原轮次仍在执行。
回调还核验当前 conversation generation；最长 24 小时，重启/解绑后安全失效。
已消费的旧按钮再次点按不会清掉同卡的新键盘；他人点按不消费提问者的 token。

客户端初始发送 drain 最多 10 秒，每次 op 回执最多 10 秒。未知发送/编辑均不自动重放，
避免重复问题或恢复旧键盘；已知回执幂等、指纹冲突与绑定撤销检查沿用网关。
账号切换清理客户端回调；App 题卡最终结束后更新卡片并清按钮。原提问者引用活卡的文字
以 interaction.decision 的可选 answerText 回传；只能配 buttonId=question:reply，非空且
≤4096 字符。旧按钮不允许附带文字；服务端验证卡片/提问者/绑定/generation 后发送。
客户端复用同一答题入口，避免中断式文字回复在运行任务后排队。关闭卡片回复走正常输入。

不改数据库、环境变量或 Mobile 原生。两端任意发布顺序安全，双方都升级且重新握手后启用。
旧端保持旧交互卡路径。本协议只处理普通问答，权限审批与敏感代输入继续使用原有流程。
