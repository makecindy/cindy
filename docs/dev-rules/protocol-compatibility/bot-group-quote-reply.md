# 伙伴群聊引用回复（`cindy.quote` v1）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

主时间线的引用回复不使用服务器 `replyToId`：现行服务端要求它与 `threadRootId` 指向同一 Thread，
主时间线会返回 `REPLY_THREAD_MISMATCH`。客户端在现有 `postMessage.content` 的 `card` 块里写入
`namespace: "cindy.quote"`、`schemaRevision: 1`，`data` 为 `messageId`、`authorName`、`authorKind`
（`user`/`bot`）、`excerpt`（≤280 字）、`attachmentCount`、`attachmentName`、`seq`，`fallback` 为
语言中立的 `> 作者: 摘要`。服务端 schema、migration 与权限不变；`plainText` 收录 fallback 以便搜索。
构造与严格解析只在 `packages/maker-shared/src/botGroupQuote.ts` 一处，Desktop main 与 Mobile 直连共用。

- 发送：渲染进程 IPC `maker:bot-group:send` 的 `BotGroupSendInput` 追加可选 `quote: { messageId }`；
  main 按当前账号 `GET /conversations/:room/messages/:id` 读取同群原消息后构造卡片，不信任调用方摘要。
  不可用时返回新增错误码 `QUOTE_UNAVAILABLE`（旧渲染层按未知错误显示通用失败）。设备互联 `send`
  动作本次不追加 `quote`，手机暂不发起引用；如需开放，须先加 Host 能力位，避免旧电脑静默丢引用。
- 读取：`BotGroupMessageView` 追加可选 `quote`（含仅手机直连使用的 `originalDeleted`）。手机解析电脑投影时用
  共享 `parseBotGroupQuoteView` 逐字段校验并保留 `quote`，同时保留原有的 `deleted` 墓碑供删除降级。识别出的卡片
  不再拼进 `content`；其它 revision 或字段不合规时整块按普通文本显示 fallback。旧手机经电脑读取时
  忽略新字段、只见正文；旧客户端直连或旧电脑看到 fallback 加正文。
- 伙伴上下文：群消息数据块里的消息追加 `quote`，仍在 `untrustedJsonBlock` 内；不改变 `mentions`。
- 后续：若服务端放开主时间线 `replyToId`（能力协商后），客户端可同时写 `replyToId` 获得外键约束与
  删除感知，卡片继续承担快照与旧端兼容；两者并存时以 `replyToId` 为准。
