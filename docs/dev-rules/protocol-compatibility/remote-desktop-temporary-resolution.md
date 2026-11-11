# 远程桌面临时分辨率

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

被控端以可选能力 `resolutionRestore` 声明系统分辨率的连接级恢复支持。
新版控制端仅在该能力为真时发送 `resolution { temporary: true }`；响应为原 lease
及更新后的显示器尺寸、`controlling: false`，控制端刷新画面并重新取得操作权，不结束连接。
被控端在首次调整前保存原模式，多次调整不覆盖；结束、超时、撤权或接管后先恢复，
恢复失败保留原值，下次连接前重试。在途原生写入完成前不得开始恢复。

旧被控端缺少该能力时，新控制端只允许已有 `viewerDisplayRestore` 能力覆盖的临时调整，
不得退回会留下系统分辨率变化的旧路径；不支持的选择返回“不支持”。旧控制端的无
`temporary` 请求及响应保持兼容，其旧行为不代表新恢复能力已生效。此扩展不修改 relay。

## 切换显示时保留视频

被控端以可选能力 `liveDisplaySwitch` 声明：原生画布截屏（macOS、Windows 原生、Hyprland）
切换显示时可以保留同一条视频连接。新版控制端仅在该能力为真时，给 `resolution { temporary: true }`、
`viewerDisplay`、`restoreViewerDisplay` 附加 `keepVideo: true`（只接受布尔值）。被控端实际保留了
视频才在响应里附加 `videoKept: true`；控制端以这个回执为准，缺失时按原流程重建视频。
能力只说明显示器支持原生截屏，不代表本次连接在用它：切换前主进程通知截屏页暂停“5 秒无新帧即停流”，
切换后由截屏页确认当前确实是原生截屏且视频流仍在，才算保留；浏览器截屏、流已结束或确认超时一律
按原流程拆掉重建。
旧被控端丢弃不认识的 `keepVideo`，照旧拆掉重建；旧控制端不发 `keepVideo`，新被控端照旧拆掉重建。
切换失败仍只结束本次远程桌面 lease。不修改 relay、IPC allowlist 或协议版本；先发被控端。
Mobile 与 Desktop 远程桌面窗口都按上述规则发送 `keepVideo` 并以 `videoKept` 回执为准；两端还按电脑和
显示器记住上次的系统分辨率或「适配画面」尺寸（各自本地保存，不进协议），下次连接拿到操作权后重新套用，
选回电脑原分辨率或恢复原始比例时清除。
实现见 `apps/desktop/src/main/remote-desktop/controller.ts`，回归见同目录 `__tests__/controller.test.ts`
与 `packages/device-link/src/__tests__/viewerDisplay.test.ts`。
