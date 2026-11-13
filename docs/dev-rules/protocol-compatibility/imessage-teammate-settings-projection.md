# iMessage 伙伴设置的可选投影（2026-11-07）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

伙伴设置 `channels.im.*` 调用参数新增可选 `supportedChannels`，连接列表与移除操作返回的
`connections` 仅向声明 `imessage` 的新客户端投影该渠道。新宿主向未声明能力的旧客户端省略新增类型，旧客户端原有
平台不受影响；新客户端调用旧宿主时新增参数被忽略，继续接收旧平台。连接状态新增可选 `health`
字段，缺失即不显示恢复计数。没有新增 relay 消息类型、服务器端点或自建中转要求，仍走既有
伙伴设置 RPC。旧参数、新能力声明与远程转发回归见 `botRemoteSettingsHost.test.ts` 与 `remoteBotSettingsTarget.test.ts`。

本机伙伴消息平台页支持读取非秘密配置并原位编辑 iMessage 连接（
`botImConnection:get-imessage-config` / `botImConnection:update-imessage-config`）。密码只写不读，
空值沿用原密码；保存后重连，失败恢复旧配置。连接 ID、已保存的路由身份、伙伴绑定与回执日志保留。
这两个凭证配置入口仅限可信本机 Renderer，不加入远程设置 RPC 或 device-link allowlist；
远程页继续遵守凭证在保存它的电脑上输入的约定，旧 preload 缺接口时不显示编辑入口。
模型继续由伙伴设置控制，不增加渠道独立覆盖。

新建 iMessage 连接在建连前持久化独立于服务器地址的路由身份（`imessage-<connectionId>`），
存量连接继续使用已保存的身份，不迁移专线。编辑地址后重新添加原地址会分配新的身份，
移除时仅归档对应连接的专线，不与存量地址哈希身份重叠。

本机回执账本可选保存 `chatActivatedAt` 聊天启用时间映射；旧账本缺字段时沿用连接
首次启用时间，已有游标和去重记录不重置。编辑时新加入或重新加入的聊天从本次启用时间
接收消息，历史回补和延迟 webhook 都应用该边界。字段只随既有原子 checkpoint 保存，
不增加 journal 操作类型或跨端协议。
