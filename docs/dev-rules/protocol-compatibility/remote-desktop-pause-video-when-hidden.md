# 远程桌面查看窗口隐藏时暂停视频

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

被控端以可选能力 `viewerHidden` 声明支持 `{ op: "viewerHidden", lease, hidden }`：控制端窗口
隐藏、最小化、切换 macOS Space 或被完全遮挡时，被控端截屏页把当前视频发送端的
`encoding.active` 置为 `false`，原地停发视频；音频、输入、数据通道与 lease 不受影响，
`hidden: false` 原地恢复，不重新协商。被控端等截屏页确认编码器已应用才回复成功，未应用（含截屏页忙）
时返回错误，控制端据此重建视频。请求只要求当前 lease，不要求操作权；每次新 offer
从未暂停开始，控制端在视频重新播放后按当前可见性重发。显示切换期间同样接受该请求。

新版 Desktop 控制端仅在能力为真时发送，并在持续隐藏 1.5 秒后才暂停（macOS 原生全屏切换
会短暂报告 hide/show），显示时立即恢复；恢复失败时重建视频连接，不让画面停在旧帧。
截图中转模式在隐藏期间停止拉取，不涉及协议。旧被控端无该能力，控制端不发送、照旧完整推流；
旧控制端不发送，新被控端行为不变。只走既有 relay 业务请求，不加入媒体数据通道白名单，
不修改 relay、服务端或 IPC allowlist；Mobile 未接入。实现见
`apps/desktop/src/renderer/features/remote-desktop/viewerController.ts` 与 `captureHost.ts`。
