# 远程桌面虚拟显示尺寸回执

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`viewerDisplay` 成功响应可附加 `viewerDisplayRequest: { width, height }`，回显本次请求。
`display.width/height` 始终是系统实际逻辑尺寸，用于画面与输入坐标；macOS 可能选择同一比例的较小逻辑模式。
客户端仅在回执匹配请求、实际尺寸为有效整数且比例一致时接受这种差异，仍校验 lease 与控制状态。
缺少回执的旧服务端保持原来的精确尺寸判断；显式 `resolution` 模式不放宽。
旧客户端仍可处理原来成功的精确尺寸响应；系统调整后的尺寸需要控制端和被控端同时更新。
不修改请求格式、relay、IPC allowlist 或协议版本。
