# iMessage 伙伴设置的可选投影（2026-11-07）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

伙伴设置 `channels.im.*` 调用参数新增可选 `supportedChannels`，连接列表与移除操作返回的
`connections` 仅向声明 `imessage` 的新客户端投影该渠道。新宿主向未声明能力的旧客户端省略新增类型，旧客户端原有
平台不受影响；新客户端调用旧宿主时新增参数被忽略，继续接收旧平台。连接状态新增可选 `health`
字段，缺失即不显示恢复计数。没有新增 relay 消息类型、服务器端点或自建中转要求，仍走既有
伙伴设置 RPC。旧参数、新能力声明与远程转发回归见 `botRemoteSettingsHost.test.ts` 与 `remoteBotSettingsTarget.test.ts`。
