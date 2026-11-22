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
不完整 Home 列表覆盖已接管的服务端活动。前台可另从各执行电脑取得完整摘要（见下节）；
后台和缺少可信摘要时沿用 APNs。
`getPushRegistration.isStale` 是原生内部观测字段，JS 序列化 HTTP 注册前剥离，兼容旧接口。
注册 PUT 可带 `staleAt?: number | null`（2026-11-19，Unix 秒）：手机上当前内容的过期时刻，
来自原生已有的观测值，只在有 update token 时发送；它不进去重键，内容更新不触发重新注册。
旧服务端忽略该字段；新服务端对不带它的旧客户端按 4 小时上限估计。服务端据此在内容到期且
没有在线新鲜的电脑可续期时结束活动，`refreshStale` 且 `staleAt` 已过时当场结束。
`dismissed` 的语义收窄为只拦重新创建：带 update token 的注册不再被它压住更新。
注册 PUT 可带 `refreshStale?: boolean`，缺省 false。该字段是当前设备的恢复提示，不存储为
注册身份，不扩大推送目标。服务端对相同内容的恢复使用既有发送记录／条件更新限频：上次
发送不足 30 秒不补发；普通更新保留 2 分钟同内容去重与 2 秒变化合并，结束不受阻。
旧服务端忽略该可选字段；新服务端仍接受旧注册。手机注册成功不表示推送已提交或送达。

配套服务端使用在线且 150 秒内更新的电脑摘要，为推送写入可选 `confirmedAt` Unix 秒，
有效期对齐本地：运行中（含混合状态）15 分钟、仅等待 1 小时、仅未读结果 4 小时。
确认时间不进入内容哈希，避免同内容心跳变成每次都发送。没有可信任务来源时不续期；
部分离线时仍只投影可信电脑，不用不完整总角标清空活动。发布先部署兼容服务端，再交付
手机；部署与真实 APNs 送达需单独核验。

原生 `getPushRegistration` 增量返回可选 `confirmedAt` / `staleAt`，内容到达触发既有事件。
`confirmedAt` 和 `isStale` 在 HTTP 序列化与去重前剥离，仅用于无内容的本地诊断；`staleAt`
按上文随注册发送，但同样不进去重键。
账号／活动范围的恢复预算跨同步器保留，账号切换或活动更换重置；无持久缓存或新轮询。


服务端先执行追加 migration，再启动兼容旧客户端的接口，随后更新 Desktop 与原生手机包。
旧服务端 404/405 或无新原生方法时保留既有本地活动；普通 push-token 可选能力
`taskBadgeVersion:1` 缺省不支持，只有支持的安装收到无弹窗角标推送。iOS 用 `aps.badge`；
Android 保持 FCM data-only，`data.badge` 与 `data.notification_count` 是字符串，不能增加
notification 对象绕过账号过滤。角标分支独立挂载，不放进 iOS ActivityKit 条件中。

自建中转不配置官方 APNs 凭证，也不接收上述云端请求；两端在自建模式跳过上报／注册，继续
透传既有任务活动。既有 WS 协议和 allowlist 不变，无需升级已部署的自建中转。手机 token 同步
测试覆盖不向自建地址发送账号凭证，原有连接与本地展示保持回归覆盖。
服务端改动在独立 server 仓维护；上线和真实系统 Push 验收分别记录，不以本地测试代替已部署。

## 前台通过执行电脑更新（2026-11-22）

iPhone 在现有 `sessions` 订阅声明 `task-activity-snapshot-v1`。新版 Desktop 将本机上传
APNs 服务所用的完整投影附加 `revision`，在 `agent-island:task-activity` 通道按变化推送，
订阅时定向重放。该通道也支持只读 invoke，供前台初次核对。标题只给有权限的同账号设备。
版本只在本台电脑的连接生命周期内比较。共享任务和供应商分享不参与；中转继续传输原有
invoke/push 信封，无需变更服务端、凭证或自建中转协议。

新版 iOS 客户端在已有活动成功注册且处于前台时读取设备目录，收到全部在线电脑的摘要后才
写入实时活动。缺少任一在线电脑的能力、授权或摘要时保留服务器内容，存在离线电脑时不以
空汇总结束。退后台释放本次订阅和在途结果。ActivityKit 在 iOS 17.2 及以上用采样时间排序；
服务端时间戳仍是发送时间。较晚的推送覆盖刚确认的前台内容，或使正在读取的摘要无法写入时，
App 使用已有订阅重新读取执行电脑。对同一活动，每个冲突时间戳在一次前台停留期间最多触发一次核对。
后台继续由 APNs 更新。旧桌面、旧手机、自建中转降级路径不变。桌面和 iOS 可以分别升级，
两者均支持后启用前台更新。iOS 需要包含新原生方法的安装包。
