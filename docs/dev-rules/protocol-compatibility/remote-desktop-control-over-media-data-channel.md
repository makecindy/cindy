# 远程桌面控制请求走媒体数据通道

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

被控端以可选能力 `channelRequests` 声明：媒体连接的 `input-v1` 数据通道还接受
`{ type: "request", id, request }`，并以 `{ type: "reply", id, ok, result | error }` 回复。
可走通道的请求限于 `REMOTE_DESKTOP_CHANNEL_OPS`（`control`、`presentation`、`hostMute`、
`privacyScreen`、`windowAction`（不含 `list`）、`displayModes`、`clipboardSync`、
`clipboardVersion`），单条不超过 32 KB，id 为 1–64 位 `[A-Za-z0-9_-]`。

旧被控端收到不认识的通道数据会结束会话，因此控制端只在能力为真、视频已在播放、请求
lease 与当前 lease 一致时才走通道，否则照旧走 relay。被控端主进程对通道请求做与 relay
相同的发送方、lease 与撤权校验；不在白名单内或并发超限时回错误码而不结束会话，控制端
改走 relay；回复超过上限时只有 `displayModes`、`clipboardVersion` 改走 relay。请求送达后
其余失败不自动改走 relay 重试，超时按结果未知处理。
旧控制端不发通道请求，新被控端行为不变。此扩展不修改 relay、服务端或 device-link 帧格式；
iOS 原生接收器新增 `sendRequest`，属于冷更新。
Desktop 控制端由主进程决定并校验每个请求（lease、操作权记录、剪贴板权限都不变），白名单内的请求交给
远程桌面窗口经它的媒体数据通道发出，回复再交回主进程（`remote-desktop-viewer:channel-request` /
`channel-reply`，仅限该窗口）；窗口没有发出（无视频、能力缺失、lease 或代次不符、通道拒收）时主进程照旧
走 relay，已发出的请求不经 relay 重发，窗口退场时在途请求按结果未知结束。
