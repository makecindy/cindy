# 远程桌面控制请求走媒体数据通道

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

被控端以可选能力 `channelRequests` 声明：媒体连接的 `input-v1` 数据通道还接受
`{ type: "request", id, request }`，并以 `{ type: "reply", id, ok, result | error }` 回复。
可走通道的请求限于 `REMOTE_DESKTOP_CHANNEL_OPS`（`control`、`heartbeat`、`presentation`、`hostMute`、
`privacyScreen`、`windowAction`（不含 `list`）、`displayModes`、`clipboardSync`、
`clipboardVersion`、`screenShape`），单条不超过 32 KiB（32768 字节），id 为 1–64 位 `[A-Za-z0-9_-]`。

旧被控端收到不认识的通道数据会结束会话，因此控制端只在能力为真、视频已在播放、请求
lease 与当前 lease 一致时才走通道，否则照旧走 relay。被控端主进程对通道请求做与 relay
相同的发送方、lease 与撤权校验；不在白名单内或并发超限时回错误码而不结束会话，控制端
改走 relay；回复超过上限时只有 `displayModes`、`clipboardVersion` 改走 relay。请求送达后
其余失败不自动改走 relay 重试，超时按结果未知处理。
旧控制端不发通道请求，新被控端行为不变。此扩展不修改 relay、服务端或 device-link 帧格式；
最初引入 iOS 原生接收器 `sendRequest` 时属于冷更新；下面的 `signalingContinuity` 扩展复用
已有发送接口，不修改原生模块或 runtime fingerprint。
Desktop 控制端由主进程决定并校验每个请求（lease、操作权记录、剪贴板权限都不变），白名单内的请求交给
远程桌面窗口经它的媒体数据通道发出，回复再交回主进程（`remote-desktop-viewer:channel-request` /
`channel-reply`，仅限该窗口）；窗口没有发出（无视频、能力缺失、lease 或代次不符、通道拒收）时主进程照旧
走 relay，已发出的请求不经 relay 重发，窗口退场时在途请求按结果未知结束。


## 信令重连期间的媒体心跳（2026-11-15）

可选能力 `signalingContinuity: true` 表示被控端支持媒体通道上的 `heartbeat`，并能在
信令重连时保留具有近期媒体存活证明的有效租约。它与 `channelRequests` 分别协商：
控制端只在被控端两个能力均为 `true`、视频已播放且请求 lease 匹配当前会话时，才通过
`input-v1` 发送 `heartbeat`；缺少或为假的任一能力均按原路径走 relay。
其它白名单请求继续按原 `channelRequests` 条件选择通道。

`heartbeat` 是小型租约请求，保留既有 `lease`、可选 `lockOnExit` 与 `idleTimeoutMinutes`
字段及其语义。主机仍校验实际 lease 拥有者、当前认证、撤权和权限；媒体来源由可信捕获
IPC 作为内部参数传递，不从 wire payload 的字段获取。通过校验的媒体业务心跳同时续期并
记录当前租约的媒体证明；中转心跳只续期，不能证明媒体可用。画中画挑战回应可记录证明，
但单独收到挑战回应不续期前台控制。

信令断开时，主机仅对最近 12 秒收到可信媒体证明的有效租约（或原有后台纯观看会话）
保留媒体；原 12 秒租约过期、空闲保护、撤权、明确停止和锁屏策略仍然适用。
手机只有协商上述能力且视频仍播放时才跨过信令离线继续会话；媒体失败后回到既有恢复流程。

`remoteDesktopChannelTimeoutMs` 为媒体 `heartbeat` 使用 5 秒回复等待预算，其它通道
请求为 8 秒。前台心跳维持每 3 秒检查、至多一个在途请求，5 秒等待结束后可在下一轮续期，
不延长主机租约。已发出但结果不明的请求不经 relay 自动重放；通道未接受请求或返回原有
可降级错误时仍按原规则走 relay。媒体尝试切换时结束旧请求等待，迟到发送或回复不进入新通道。

### 混合版本与发布顺序

- 新控制端 → 旧被控端：缺 `signalingContinuity` 或 `channelRequests` 时心跳继续走 relay，
  不向旧主机发送它不认识的媒体心跳，信令离线时沿用旧恢复路径。
- 旧控制端 → 新被控端：旧端继续发送中转心跳，不需要认识新能力位；未收到媒体证明时仍按
  原信令失联路径结束前台会话，不凭可选能力放宽授权。
- 新控制端 → 新被控端：两个能力均为真且已有视频时使用媒体心跳；成功续期与近期媒体证明
  允许信令重连期间保留当前会话。完整连续性改善需要两端更新。
- 兼容独立升级，无强制协调窗口。推荐先更新被控端，再更新控制端；反向更新也可通过上述
  可选能力安全降级。回滚任一端时恢复对应混合版本路径。
- 官方和自建中转均透传既有业务 payload；不新增 relay kind、顶层帧字段、服务端接口或
  严格枚举，无需升级服务器或调整自建中转版本。

### 实现与验证入口

- 协议、能力和等待预算：`packages/device-link/src/remoteDesktop.ts`；手机中转心跳预算共用
  `REMOTE_DESKTOP_HEARTBEAT_TIMEOUT_MS`（`invokePolicy.ts`）。
- 主机：`apps/desktop/src/main/remote-desktop/index.ts`、`controller.ts`；
  查看端：Mobile `RemoteDesktopScreen.tsx`、Desktop `remote-desktop-viewer/connection.ts`
  与 renderer `viewerController.ts`。
- 回归：Device Link `remoteDesktop.test.ts`、`invokePolicy.test.ts`；Desktop
  `captureBoundary.test.ts`、`controller.test.ts`、`connection.test.ts`；Mobile `screen.test.tsx`。
  覆盖能力缺失降级、真实媒体业务入口、10/40 秒信令中断、心跳回复丢失、撤权与旧请求隔离。
- 自建中转：本 PR 已执行 `pnpm --filter @cindy/device-link test`（1303 项）、
  `pnpm --filter @cindy/device-link-relay test`（50 项）及
  `pnpm --filter @cindy/device-link-relay run interop`（真实本地中转新旧 SDK 互通 2 项），均通过；
  本次协议记录同步未修改实现，无需制造服务端改动。
