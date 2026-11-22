# 插件转发 IM 消息的出处（`tasks.send` 的 `relay`）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

逻辑页管道的 `tasks-request` `send` 增量接受可选 `relay:{platform,chatType,chatName?,sender:{id,name,isOwner}}`，
`tasks.capabilities().messageRelay` 宣告支持；只在本机 Desktop Main 消费，`targets.send` 不接受。旧 Host 把它当未知键返回
`INVALID_REQUEST`，插件须先探测能力，缺失时不传。不带 `relay` 的请求、回执摘要与派发参数逐字节不变，旧 requestKey 照常重放。
宿主清洗后写进消息行的 `agentMeta.sourcePlugin.relay`（可选嵌套字段，无数据库迁移），随既有消息同步到手机与另一台电脑；
旧客户端的读取器只取 `pluginId` / `name`，照旧显示普通插件消息。共享任务访客投影删除整个 `sourcePlugin`。
不新增 channel、握手能力位或 relay 字段，自建中转透明转发，无需同步适配。
回归入口：`taskSlot.test.ts`、`pluginTaskService.test.ts`、`pluginTaskAuthorshipWiring.test.ts`、`messageSource.test.ts`、
`makerChatStoreTaskUpdates.test.ts`、`messageNormalize.test.ts`、`sharedTaskPush.test.ts`。产品规则见
[消息来源](../../product-rules/message-source.md)「插件转发的 IM 消息」，作者契约见 plugin-agent-tasks.md §4.11.3。
