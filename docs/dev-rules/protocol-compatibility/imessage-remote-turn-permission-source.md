# iMessage 远程轮次权限来源（2026-11-08）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

远程 Agent 的 `started.handle` 新增可选 `imessageSendContext: true`，由实际执行电脑声明支持
`turnPolicy.origin` 与 `cindy.mainOwned.origin` 的 `imessage` 来源。控制端在每次 `send` / `steer`
完成连接或重连后核对该声明；缺省、false 或非布尔值均视为不支持，带 iMessage 来源的输入在发送前
以 `REMOTE_AGENT_PEER_TOO_OLD` 拒绝，不允许旧执行端丢掉权限后继续。Desktop 和其他既有来源照常互通。
新执行端还会拒绝无法解码的显式权限或身份来源，不再静默省略；未携带这些可选上下文的旧请求不变。

能力随实际执行端的启动描述刷新，不借用控制端或中转电脑的版本；供应商组的中转保持原样转发最终
执行端的 `started.handle`。既有 device-link `started` 记录保留 handle 的可选字段，官方和自建中转
只转发既有 invoke/poll envelope，无新增 channel、顶层帧、allowlist 或服务器接口，无需升级中转。
兼容验证覆盖新控制端与旧执行端的拒绝、旧格式 Desktop 请求、新执行端的 iMessage 双上下文还原，
以及重连到旧执行端后的再次拒绝；真实自建中转互通继续使用既有加入、签名与重连脚本。
