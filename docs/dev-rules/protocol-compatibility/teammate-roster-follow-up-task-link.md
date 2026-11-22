# 伙伴名册的跟进任务链接

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`teammates` 伙伴行的 `links` 在原 `conversation` 链接之后追加 rel `following`，`target` 为
`{ kind: 'session', sessionId }`，表示该伙伴在跟进的本机任务（伙伴用 `send_to_session` 开的任务与
旧 V1 委派子任务，扣除解除记录；来源与桌面侧栏「在跟进」相同）。只列在用伙伴、未归档、本机、普通来源且非 Orca
worker 的任务，按最近更新取前 200 条；伙伴行 `revision` 追加这组 ID 的摘要，变化时照常失效重读。
责任记录、委派创建／状态变化都会广播伙伴远程资源变化。

旧控制端按未知 rel 忽略，`conversation` 仍是第一条链接，打开聊天不变；新控制端连接旧 Host
时没有该链接，任务行不显示标记。Mobile 读取的链接上限由 64 放宽到 256 以容纳这组链接。
不增加 IPC channel、请求参数、数据库字段、push 类型或 Mobile 原生配置。
