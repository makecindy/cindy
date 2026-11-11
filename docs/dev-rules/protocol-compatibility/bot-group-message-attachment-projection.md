# 群消息附件的结构化投影

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Chat Server 群消息投影（Desktop IPC 与 `bot-group-chat` 远程资源共用 `BotGroupMessageView`）的
`content` 不再包含 `[附件: 文件名]` 占位行，附件只在 `attachments` 里。尚未取到电脑的服务器附件也
保留一项，`url`、`path` 为 null，并带可选 `state: 'loading' | 'unavailable'`；取到后同一 `id` 换成
完整附件、`state` 缺省。新版手机解析该字段，在原位置显示「加载中」/「暂时无法加载」，点开说明状态而不当作
可打开的文件；旧手机忽略该字段，把这一项显示为带文件名的文件条，旧版 Markdown 回退仍为 `📎 文件名`。手机直连同样只从 media 块投影附件，正文不再拼 caption。给伙伴的上下文文本不变。
不改 channel、能力、服务端 schema、数据库或 Mobile 原生指纹。
