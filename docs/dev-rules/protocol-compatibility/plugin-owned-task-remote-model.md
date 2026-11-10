# 插件自有任务远程模型（2026-11-06，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

插件管子的 `tasks.create / setModel` 在原 route 上增加可选 `agentDeviceId`；
`tasks.capabilities()` 追加 `remoteRoutes:true`。同账号电脑和 `share:<shareId>` 的语义
与统一模型选择器一致，缺省保持插件宿主。旧 Host 缺标记时只提供本机选模，不能剥掉来源后重试。
新 Host 保持所有旧 route、批准记录、幂等摘要及任务回执兼容；位置只在选择远程时出现。
任务 resolvedConfig、run.acceptedConfig 和改模 pending profile 保留位置；无 DB schema 迁移。
仅复用既有远程 Agent 的目录、open/send/poll/stop 通道，任务和历史仍归插件电脑，
不添加 device-link allowlist、帧、relay 能力或服务端请求。官方与自建中转继续透传既有协议，无需升级。
同账号与跨账号授权仍由原通道及执行电脑核验，来源不可用不回落本机、不重放付费输入。
