# Telegram 群历史按消息号取图（2026-10-29）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`GroupMessagePayload.imageRefs` 为可选字段，最多 4 个 `{fileId, name, mimeType,
downloadToken?}`；无此字段的旧包继续接受，旧客户端忽略新增字段。客户端与服务端
`@cindy/slack-hook-protocol` 同步边界校验（ID 1024、名称 256、证明 8192 字符；图片类型白名单）。
官方 relay 对每个接收设备绑定签发 HMAC 图片证明，绑定群、话题、消息与文件身份。
新增只读 `POST /telegram/group-image` 使用正常桌面登录 JWT 验签，不接受调用者提供设备 ID；
下载前后核对当前绑定。证明不能单独访问接口，不新增 env、WS envelope 或 capability。

先部署 telegram-hook-server，再更新客户端（用户确认更新，不能强更）。旧端保持文字
历史，旧服务不发送证明时新端明确不可取回。客户端新增 nullable `image_refs` 数据库列，
通过追加 Drizzle migration 升级；服务端不持久化群图片或消息正文，无服务端数据库迁移。
验收入口为 groupHistoryMcpServer / groupHistorySearch / groupHistoryImages、个人 TelegramIM、
两端 protocol-group-relay 和服务端 telegramController / groupImageHttp 测试；正式 Telegram
跨进程收发需部署后另验。

同一取图工具覆盖飞书/Lark、企业微信、钉钉、Discord 私聊与个人微信。前三方无历史
接口的路径仅保存已收到的托管媒体引用，不接受模型提供的路径/URL，不补抓全量群图。
飞书/Lark 通过该 bot 的消息接口校验精确 chat/topic 后下载；企业微信/钉钉仍只看到
渠道实际投递的消息，Discord/微信当前只支持私聊。微信排队 payload 追加 optional
`platformMessageId`，旧队列无此字段时正常执行，但不把内部 task ID 冒充平台消息号。

Slack 复用既有 user-token 工具网关，在 `listTools` 增加 `cindy_get_message_images`；
参数为 channel_id/message_ts/可选 thread_ts，返回标准 MCP image blocks。客户端网关
透传图片，不再将 base64 当成文字 JSON 泄洪；旧端仍按原方式交付 JSON，需升级客户端
才能直接看图。Slack 权限继续由原绑定用户的 Slack 授权决定，无新增 scope/env。

X 属于公开帖子接入，本轮不新增付费历史抓取；其已有推文上下文自动带图路径不变。
