# 分享历史任务恢复诊断（2026-11-05）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`remote-agent/allocate` 指定 `preferredExecutorDeviceId` 时，失败以既有错误包报告有界的
`SHARED_TASK_RECOVERY_*` 类别与 `SHARED_TASK_STAGE_*` 环节；外层仍使用既有
`REMOTE_AGENT_UNAVAILABLE`／`REMOTE_AGENT_PROVIDER_NOT_ALLOWED`／`REMOTE_AGENT_BUSY`／
`REMOTE_AGENT_PEER_TOO_OLD`，旧控制端继续按原通用错误处理。只公开白名单原因与少量
传输错误码，不转发上游私密消息。未指定原执行电脑的新任务仍用 `null` 回到旧中转路径。
新控制端收到旧 O 的 `null` 时显示“原因未确认”，不把它当作明确离线或用量耗尽。

本节诊断本身不新增帧、channel、请求字段、能力位或服务端 API；官方及自建 relay 沿用既有错误包
转发，不需要同步部署。原电脑上的建链／能力探测各最多补试十六次：第一次立即重试，
随后按 1／2／4／8／16／20 秒退避，之后保持 20 秒基数；各次加 ±25% 抖动（单次最多 20 秒）。
每层累计重试预算为共享熔断冷却上限加 60 秒（当前共 180 秒），覆盖其最长 120 秒冷却、
30 秒探测 RPC 与 5 秒 tick；不绕过熔断席位。现有 RPC 保留自己的超时，不以超时竞速丢弃真实结果；预算耗尽后
不再发新探测。取消立即结束退避等待；账号、权限、显式断链代次及原授权期限在每次
探测前后复核。仅补试同一幂等探测，不重放分配、open 或正文，不启动持久队列的第二轮
自动重放。宿主本身重启后，普通待发输入仍保留并沿用既有暂停／显式继续语义。
故障半径只覆盖当前任务的原执行机，不重启共享连接、换模型或换账号。
实现与回归见 `sharedTaskRecovery.ts`、`providerShareTaskLocation.ts`、`sharedTaskRecovery.test.ts`
及 `roundtrip.test.ts`；既有官方与自建中转透明传输原请求，无需改变服务端。
Desktop 的原因说明与用户选择入口见
[分享直连合同](../../product-rules/provider-sharing-direct-execution.md)；旧端与 Mobile
仍保留原有错误界面，不宣称已交付新的恢复弹窗。
