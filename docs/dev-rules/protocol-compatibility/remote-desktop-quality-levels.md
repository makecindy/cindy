# 远程桌面画质档位

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`offer.settings` 的画质由码率改为档位 `quality: "auto" | "saver" | "hd"`（自动／省流／高清）。
控制端只表达意图，具体的码率上限、降级取舍（`auto`/`saver` 先降分辨率保帧数，`hd` 锁分辨率
降帧数）、截屏分辨率与 JPEG 预算由被控端 `apps/desktop/src/shared/remoteDesktopQuality.ts`
决定，调整数值无需两端同时发版。控制端处于后台观看（`presentation` 已开启，如手机画中画）
期间，被控端临时按 `saver` 档的码率／帧率上限编码，回到前台即恢复所选档位；这是被控端本地
行为，控制端发送的档位不变，也不新增协议字段。

新控制端经 `remoteDesktopVideoSettingsWire` 同时发送档位与旧 `bitrate`（auto→0、saver→2M、
hd→20M）：旧被控端只校验 `bitrate` 并忽略 `quality`，无需新增能力声明。新被控端优先读取
已知档位；档位缺失或不认识时按旧 `bitrate` 换算（0→auto、2M→saver、8M／20M→hd），因此旧
控制端与未来新增档位都能降级连接。两者都无效时仍返回 `INVALID_REQUEST`。此变更不改 relay、
不新增 channel，服务端无需改动。Desktop 远程桌面窗口的主进程会先用 `parseRemoteDesktopRequest`
校验 renderer 请求（解析结果只保留档位），转发给被控端前必须再经 `remoteDesktopVideoSettingsWire`
补回旧 `bitrate`；否则旧被控端对每次 offer 都返回 `INVALID_REQUEST`，视频退回截图中转。

被控端在应用控制端 offer 前，仅为带 `settings` 的请求给视频编解码追加 `x-google-start-bitrate` /
`x-google-min-bitrate` / `x-google-max-bitrate`，避免近静止画面因发送量过低导致带宽估计塌到
百 kbps 级、分辨率被锁在低档。这些是 libwebrtc 对发送端生效的本地提示，不改变协商出的编解码；
不识别它们的控制端不受影响，旧控制端（无 `settings`）的 offer 原样使用。
