# 伙伴个人聊天全文搜索

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

既有 `local-db:conversations:search` 的结果 `session` 增加可选
`companion: { id, name, role: 'canonical' | 'history', readOnly }`。
归属由 Host 的 `bot_session_links` 关联确认；群聊与渠道专线不下发。
本机搜索另允许渠道专线，并在 Desktop 本机结果中使用 `companion.role: 'channel'` 与 `readOnly: true`，
沿用现有历史只读页及消息锚点。远程查询仍排除渠道专线，远程回包与 Mobile 消费的角色范围不变；
不增加 IPC channel、请求参数或数据库字段。
`local-db:bots:get` 的远程精简资料增加个人 `sessions: [{ id, role, status }]`，
供控制端复核历史归属，不传提示词、工作目录或渠道配置。
搜索前按远程伙伴可见性筛选，缓存／排队回复投递时再次核查，保持原账号与隐藏边界。
新控制端连接旧 Host 时缺少 `companion` 就沿用普通搜索结果；旧控制端忽略新增字段。
历史定位需要更新查看端，旧端可能按普通任务打开；不更改既有请求参数、
IPC allowlist、relay、数据库 schema 或 Mobile 原生指纹。
