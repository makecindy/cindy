# 本机听写静音租约（2026-11-10，未发布）

既有 `voice-input:start`、`mute-system-audio`、`restore-system-audio` 可选增加
`recordingId`（非空字符串，最多 128 字符）。Renderer 在采集前生成每轮随机 ID，
Main 将它限定于实际 sender 窗口，再映射为进程内静音 owner；pending start 不依赖尚未返回的 runId。
停止／取消与异常清理只释放该轮租约，窗口退出释放该窗口所有租约。
旧调用缺省继续使用原窗口 owner，新字段对旧 Host 可忽略；不增加 channel、device-link
allowlist、relay 或服务端协议。该 ID 不用于账号授权，不记录输入内容或账号标识。
