# 任务汇总与 ActivityKit Push（2026-11-10，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

官方 Device Link 新增同账号、设备绑定 Bearer 路由：`PUT /api/device-link/task-activity`
接受本机完整执行摘要，`GET` 返回 `{schemaVersion:1, accountId, version, waitingCount,
unreadCount, runningCount, badgeCount, complete}`。`accountId` 来自已验签 membership，
`version` 为数据库持久单调十进制字符串，`badgeCount=waitingCount+unreadCount`。
`complete=false` 代表部分电脑缺失／离线／摘要过期，不得作为全局角标绝对值；不按通知次数加减。
PUT 的 selected 只含任务 ID、截断标题和状态，优先等待操作→未读结果→运行中，不上传消息或工具参数。

`PUT /api/device-link/live-activity` 接收原生 ActivityKit 的 start/update token、activityId、
系统启用／移除状态、本地化状态文字、构建线、APNs 环境和「服务端地址＋账号」scope。
`supportsInputPushToken` 表示 iOS 18+ 支持；`DELETE` 只注销本账号本设备的活动，不触碰普通推送。
APNs 采用 `CindyAgentActivityAttributes`，`attributes.accountId` 存 scope，ContentState 的既有
必填 JSON 字段保持不变。`confirmedAt` 是可选的 Unix 秒：新原生包本地更新时写入，旧
APNs 内容缺省仍可解码，界面用“等待更新”代替未知时间。旧消费端忽略新增字段。手机仍不以
不完整 Home 列表覆盖已接管的服务端活动；前台恢复只重发既有注册以请求服务端同步，
不引入客户端自行编造的服务端版本或更改 APNs 的排序规则。
`getPushRegistration.isStale` 是原生内部观测字段，JS 序列化 HTTP 注册前剥离，兼容旧接口。
官方后台期限、推送内容时间和 APNs 送达仍由 server 仓负责；本次客户端改动不表示服务端已
增加 `confirmedAt`，也不表示重新注册必然引发即时推送。已只读核对 server PR #1318（4ddf9601a）：注册成功
会 queueTaskActivity，仍受发送去重／节流；同内容 2 分钟续期、5 分钟过期。该 PR 未合并，
运行环境与 APNs 送达须另行验收，不能用源码核对代替部署证据。

服务端先执行追加 migration，再启动兼容旧客户端的接口，随后更新 Desktop 与原生手机包。
旧服务端 404/405 或无新原生方法时保留既有本地活动；普通 push-token 可选能力
`taskBadgeVersion:1` 缺省不支持，只有支持的安装收到无弹窗角标推送。iOS 用 `aps.badge`；
Android 保持 FCM data-only，`data.badge` 与 `data.notification_count` 是字符串，不能增加
notification 对象绕过账号过滤。角标分支独立挂载，不放进 iOS ActivityKit 条件中。

自建中转不配置官方 APNs 凭证，也不接收上述云端请求；两端在自建模式跳过上报／注册，继续
透传既有任务活动。既有 WS 协议和 allowlist 不变，无需升级已部署的自建中转。手机 token 同步
测试覆盖不向自建地址发送账号凭证，原有连接与本地展示保持回归覆盖。
服务端改动在独立 server 仓维护；上线和真实系统 Push 验收分别记录，不以本地测试代替已部署。
