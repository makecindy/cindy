# 手机推送注册与通道配置状态

`PUT /v1/push-token`（Chat Server）和 `PUT /api/device-link/push-token`（Device Link）
的成功响应增量携带 `deliveryConfigured: boolean`；`registered: true` 仍只表示 token 已保存。
配置状态针对该次注册的 provider / appVariant，不保证凭证有效、网络可达或通知送达。
Chat Server 未配置通道时仍保存 token 并返回 false；Device Link 沿用未配置则拒绝注册的行为，
成功时返回 true。请求字段、DELETE、账号归属、权限与补偿注销语义保持不变。

Mobile 将合法布尔值保存到已有的每服务注册诊断记录。Android 只有在两个接口均明确返回
true 后才将云通道标为 available；旧服务缺少字段、字段无效、false、404/405 或请求失败，
均保留现有「自动」后台直连。中国大陆地区判断、用户显式开关和 iOS 注册流程不变。
服务端可分阶段升级，旧客户端忽略新增字段；客户端先升级时保守保留直连。

自建中转和 Agent Net 沿用现有独立注册路径，不新增请求；自建中转模式本来就不向官方
Device Link 注册 token，仍不能以单独的 Chat 注册成功关闭共享后台服务。
没有 relay 帧、原生配置、数据库或环境变量变更，不要求中转同步升级。

验证入口：Mobile `pushNotificationsRealm.test.ts`、`chatBackground.test.ts`、
`chatBackgroundBridge.test.tsx`；服务端 `push-registration.integration.test.ts` 和
`deviceLinkRoutes.test.ts`。测试验证配置回报与回退选择，不代替 APNs/FCM 真机送达验证。
