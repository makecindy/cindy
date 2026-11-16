# 邮件阅读会话

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

只读 MailMessage 可选增加 conversation（threadId 和按时间排列的 messages 摘要）。
摘要包含 messageId、url、from、date、subject、snippet，不附带所有正文；当前 messageId 必须在摘要中。
Host 验证摘要唯一性、数量/长度及链接属于同一插件声明域名；展开时复用现有 mailReader，客户端核对返回的账号和邮件 ID。
conversationUnavailable 表示当前邮件可读但周边邮件未能读取，界面提供重试。
桌面右侧阅读器定位当前邮件，长会话折叠中间摘要。旧查看端（含现有手机）忽略新增字段，保留单封阅读；旧插件照常返回单封。
沿用现有 IPC 和 mail-messages 远程资源，无新 channel、数据库迁移、权限或原生变更。
