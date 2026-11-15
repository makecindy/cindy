# 分享历史任务恢复诊断（2026-11-05）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`remote-agent/allocate` 指定 `preferredExecutorDeviceId` 时，失败以既有错误包报告有界的
`SHARED_TASK_RECOVERY_*` 类别与 `SHARED_TASK_STAGE_*` 环节；外层仍使用既有
`REMOTE_AGENT_UNAVAILABLE`／`REMOTE_AGENT_PROVIDER_NOT_ALLOWED`／`REMOTE_AGENT_BUSY`／
`REMOTE_AGENT_PEER_TOO_OLD`，旧控制端继续按原通用错误处理。只公开白名单原因与少量
传输错误码，不转发上游私密消息。未指定原执行电脑的新任务仍用 `null` 回到旧中转路径。
新控制端收到旧 O 的 `null` 时显示“原因未确认”，不把它当作明确离线或用量耗尽。

本节诊断本身不新增帧、channel、请求字段、能力位或服务端 API；官方及自建 relay 沿用既有错误包
转发，不需要同步部署。原电脑上的建链／能力探测各最多补试一次，取消与代次检查不变，
不重放分配、open 或正文。Desktop 的原因说明与用户选择入口见
[分享直连合同](../../product-rules/provider-sharing-direct-execution.md)；旧端与 Mobile
仍保留原有错误界面，不宣称已交付新的恢复弹窗。
