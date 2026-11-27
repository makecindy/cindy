# 插件任务的后续轮次（`tasks.send` 的 `followUps`，2026-11-25，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

桌面宿主通过 `tasks.capabilities().followUps` 声明支持。逻辑页管道的 `tasks-request` `send` 增量接受可选
`followUps: true`（只接受 `true`），只在本机 Desktop Main 消费，`targets.send` 不接受。旧 Host 把它当未知键返回
`INVALID_REQUEST`，插件须先探测能力，缺失时不传。不带 `followUps` 的请求、回执摘要与派发参数逐字节不变，旧
requestKey 照常重放。

- 这一轮用 `send_to_session` 新开的本机任务记成 `plugin_task_requests` 里 `operation = 'followUp'` 的回执
  （`targetId` 为新开的任务，`requestKey` 为开它的 runId；只是 TypeScript 枚举的新值，无数据库迁移）。开它的 run 多出
  `followUps: { tasks, until }`。
- 那件任务之后发回本任务的消息由宿主强制排队（`clientId = plugin-task:<runId>`），并以 `operation = 'send'` 记一条插件
  run：多出 `followUpOf`（开它的 runId），`getRun`、`listRuns`、`readMessages({progressForRun})` 照常读取。
  `cancel` 对它返回 `INVALID_REQUEST`；`accept` 不因插件的派发检查拦下这条消息。
- 消息行的 `origin`（session）多一个可选的 `pluginReply`（`pluginId`、`name`、`relay`），随既有消息同步到手机与另一台电脑；
  旧客户端的读取器不认识它，照旧显示「由任务「X」发送」。共享任务访客的 session 来源整体脱敏为 `{ kind: 'session' }`。
- 只在 `send_to_session` 的本机投递里生效：发送方或接收方经 device-link、SSH 或另一台电脑时不产生后续轮次，照旧是普通来信。
  不新增 channel、握手能力位或 relay 字段，自建中转透明转发，无需同步适配。

回归入口：`taskSlot.test.ts`、`pluginTaskService.test.ts`、`messageSource.test.ts`。产品规则见
[消息来源](../../product-rules/message-source.md)「插件跟随的任务回信」，作者契约见 plugin-agent-tasks.md「后续轮次」。
