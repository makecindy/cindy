# Chat Server 只读工作发现与定向通知（2026-10-29）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`/me.capabilities` 新增 `workAvailabilityVersion:1`、`workNotificationsVersion:1`。
`POST /executions/availability {botIds}` 每批 1–128 个本人伙伴，返回 `{items:[{botId,enabled,pending}]}`。
它只检查普通和成员加入队列，不写执行/回执，不获取租约。pending 只是提示，实际领取仍使用原单伙伴 `/executions/claim`，
其请求体、鉴权、epoch、幂等、60 秒租约及失联后的显式重试行为不变。

主人 actor 流新增 `work.available {work:[{botId,conversationId}]}`，覆盖未打开群及普通、计划、真实入群、重试和前序结束。
通知可重放且不构成执行授权。Desktop 只唤醒对应伙伴，批量只用于无副作用的发现；真实响应逐伙伴处理，不等待聚合租约结果。
同一伙伴最多一项领取或忙碌扫描；探测不占用该位置，新工作可以越过慢探测。旧探测的空结果不能覆盖期间到达的提示。
完整空队列证明且可靠通知在线时最长 60 秒空闲退避；其余空领取/旧服务端/断线上限 15 秒，含抖动和调度误差。
普通错误按伙伴退避；401 续期期间暂停新后台请求，成功后沿用原重发，失败进入退避；429 立即更新共享截止时间。
主力登记子请求和认证后的重发均在发送前检查门禁，成功不清除已有 Retry-After。已在途结果仍接收，已有心跳继续原规则。
云端伙伴运行时以独立的后台身份 API 接入安装归属 GET/POST `/preferences`、自动主力确认和删除登记重试；
同路径的资料同步、消息镜像以及用户明确操作继续原通道，不按 URL 一刀切限流。

新端在能力缺失或只读探测 404 时回退原 claim。服务端同时声明 `personalMask:1` 时也不使用探测：
AI 代答与私人汇总只能由空闲的 `/mask/executions/claim` 发现，探测与 `work.available` 均不覆盖它们。
旧客户端忽略新能力与事件；Mobile 无执行器协议变化。手机不运行伙伴：本人 actor scope 中只含 `work.available`
的批次直接 ACK，不重读列表或历史，混合批次照常刷新（[`chatServerSubscription.ts`](../../../apps/mobile/src/chat/chatServerSubscription.ts)）。
推荐先部署全部服务端，再发客户端；旧 dispatcher 混合窗口依靠兜底，不承诺即时唤醒。没有环境变量或 Schema 变化。
actor 游标只保存在当前账号运行时，重连续读、重启从零；RESET_REQUIRED 与 CURSOR_AHEAD 都有恢复入口。
RESET_REQUIRED 跳过的通知可能含主力迁移的 `actor.changed`，因此先重读伙伴与主力电脑，再从新游标续订和领取。

设计与验收不变量见 [工作轮询设计](../chat-work-polling.md)。新增能力只优化发现，不引入批量领取或自动恢复执行协议。
