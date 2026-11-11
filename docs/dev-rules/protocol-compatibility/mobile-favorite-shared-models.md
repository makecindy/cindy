# 手机收藏分享来的模型（2026-11-10，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:provider-share:received-catalogs` 的每条分享可选附加 `favoriteSource`：
`{ shareId, memberId, providerId, owner: { region: 'cn' | 'global' } }`。它只用来把收藏写成被控电脑
现有 `maker:model-favorites` 里的来源键 `provider-share-favorite:` 加上这四段，与 Desktop 本机收藏同一身份。
不含凭证，也不授予运行权限。

旧手机忽略未知字段。旧电脑不带该字段时，新手机不收藏这条分享，也不用手机自己或别的电脑的成员身份代替。
字段不合法，或 `shareId` / `providerId` 与这一条分享不一致时，丢掉字段、保留目录。

收藏的读、增、改、删仍走原 `maker:model-favorites`。来源键长于该通道既有的 512 时，手机不提供星标；
被控电脑回复时继续滤掉超长来源，避免旧客户端整表解析失败。Desktop 本机存储上限仍是 2048。
不新增 channel、allowlist、帧、能力位或中转路由。官方与自建中转只透传原 invoke 正文，中转内核不解析该字段，
无需升级中转程序；已部署的中转转发未知 JSON 字段，新手机连接旧电脑时星标保持不可用。
