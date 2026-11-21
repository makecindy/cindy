# 伙伴主对话的稍后处理

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

收件箱把每个伙伴的主对话列成一行（产品规则见[任务收件箱](../../product-rules/task-inbox.md#伙伴主对话2026-11-20)）。
分区由控制端用已有字段算出：`teammateActivity`、`generation`、`lastReplyAt` 与读位决定状态，本文件只新增
延期信息。

`teammates` 伙伴行的 `display` 可选携带 `inboxSnooze: { snoozedUntil, snoozedAt, userSendAt }`（ISO 时间，
未设置为 `null`）。`snoozedUntil`、`snoozedAt` 是主对话任务记录上的同名字段；`userSendAt` 是主对话最近一次
输入的时间，取任务记录的 `userSendAt` 与主对话最新一条可见消息时间的较晚者。其他任务用工具发给伙伴的消息
不推进任务记录的 `userSendAt`，只看它会让被延期的伙伴收到来信、要用户拍板时仍留在稍后处理里。伙伴有主对话
时宿主总是下发它（未延期时前两个值为 `null`），因此它同时表示「这台电脑可以延期这段对话」；没有主对话时
不下发。行的 `revision` 计入这三个值。

写入不新增通道或动作：控制端对伙伴行 `conversation` 链接指向的任务调用既有的
`local-db:sessions:patch-meta`，参数 `{ snoozedUntil: <ISO> | null }`，与任务的稍后处理相同（时间校验、
`snoozedAt` 由宿主写入）。宿主在任务的延期变化或轮次结束时间落库后，对它所属的伙伴发出既有的远程资源变更推送，各端重读名册；
本机窗口经既有的 `local-db:sessions:patched` 刷新伙伴资料。消息落库时已有的名册失效随之带出新的
`userSendAt`，控制端按与任务相同的规则（输入晚于 `snoozedAt`）提前唤回。流式回复保留文本块开始时间，
因此当最新可见消息属于最近一轮的助手回复时，也把该轮 `lastTurnEndedAt` 计入投影，覆盖先开始回复、
再延期、最后回复完成的时序。

兼容：

- 旧控制端忽略 `inboxSnooze`，伙伴行与聊天不变。
- 新控制端连旧宿主：没有 `inboxSnooze`，该行不提供稍后处理，也不按延期归类；其余分区照常。旧宿主本就接受
  对任意任务的 `patch-meta` 延期，但不投影结果，控制端不得在读不回来的情况下写入。
- 控制端写入后以回包的 `snoozedUntil` 为准，未返回所写的值即显示失败，不把它当成已延期。
- 「完成」沿用[伙伴已读跨设备同步](teammate-read-state-cross-device-sync.md)的 `read` 动作与本地读位，不新增协议。手机在宿主确认后再推进本地读位；请求失败保留未读并提示，可重试。

字段位于 Remote Resource 的业务 payload 内，不改握手、签名、顶层帧、relay 路由或重连逻辑；官方与自建中转
都按通用加密转发透传，无需中转升级。不增加 IPC channel、allowlist 项、权限、数据库字段或迁移。Node Host
（`apps/host`）未提供伙伴名册，不受影响。

实现与回归入口：宿主 `localDb/ipc/bots.ts`（`botInboxSnooze`）、`botRemoteResourceProjection.ts`、
`localDb/ipc/sessions.ts`（`setSessionSnoozePatchedListener`）；共享 `packages/maker-shared/src/liveTaskPriority.ts`
（`teammateInboxSection`）；Desktop `features/bots/remoteBotRoster.ts`（`parseTeammateInboxSnooze`）、
`teammateInbox.ts`；Mobile `device-link/remoteResources.ts`（`normalizeRemoteInboxSnooze`，畸形值整体丢弃）、
`session/InboxTeammates.tsx`。测试：`botRemoteResourceProjection.test.ts`、`botCanonicalSession.test.ts`、
`liveTaskPriority.test.ts`、`teammateInbox.test.ts`、`TaskInbox.test.tsx`，Mobile `remoteResources.test.ts`、
`homeSections.test.ts`。
