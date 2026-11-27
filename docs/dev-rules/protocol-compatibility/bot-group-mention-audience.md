# 群广播对象（2026-10-30）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Chat Server `/me` 新增可选能力 `groupMentionAudiences: 1`，群快照新增 `allow_mention_all_bots`（默认 false）。
仅群主可 PATCH `allowMentionAllBots`；旧客户端忽略新字段，管理员原有资料编辑权限不变。
消息可选 `mentionAudience: humans|bots|everyone` 表示真人、伙伴或两者广播，与明确的 `mentions` 合并；
伙伴广播须开关开启。消息读回保留同名字段，服务端持久化后延迟派发仍保留目标。
客户端无能力时不发送新字段，真人广播只展开真人；空目标以本人 actor 保持定向，不触发旧服务端的无点名兜底。
`BotGroupMention.all` 只指真人，新增可选 `allBots` 独立表示伙伴，手机远程资源保留二者；
只有已声明支持的新电脑/服务端才提供伙伴入口。原样重试已提交待发消息，不重算目标或更换操作标识。
先部署数据库增量迁移和服务端，再发布客户端。旧客户端此前已展开的 actor 列表无法可靠区分广播与逐个点名，
因此修复旧客户端行为须升级客户端。批量开关不授权工具，不改变个人代答配置。

Chat Server `/me` 另增可选能力 `groupMemberMentionAll: 1`，群快照新增 `allow_member_mention_all`（默认 `false`）。
群主和管理员均可 PATCH `allowMemberMentionAll`（仅 `kind=group`）；关闭时普通成员发送 `mentionAudience: humans|everyone`
由服务端返回 `403 ALL_HUMANS_MENTION_FORBIDDEN`，客户端 `@` 候选隐藏「所有人」并在手动输入时提示仅群主和管理员可用。
旧服务端不返回该能力时客户端保留默认放行，不展示开关；旧客户端忽略新字段，受服务端硬拦保护。
