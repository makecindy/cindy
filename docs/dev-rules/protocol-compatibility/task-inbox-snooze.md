# 任务收件箱与稍后处理（2026-11-12）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)。

沿用 `local-db:sessions:patch-meta` 与 sessions 列表/推送，新增可选 `snoozedUntil`
（ISO 时间或 null）写字段；宿主同时保存并返回可选 `snoozedAt`，调用方不可写设置时间。
迁移 0150 为 sessions 新增两个可空毫秒列。旧数据为空，不改变现有列表。

新控制端/手机请求旧宿主会收到字段不允许，或通过返回字段检查发现未应用，显示错误并回滚。
旧控制端/手机忽略新字段，继续显示原列表；不会因缺失字段禁用其他任务操作。
延期与设置时间作为一对同步；手机对乐观写、推送遮蔽和回滚均保护整对字段。
归档和显式状态恢复清除延期；新输入时间晚于设置时间时各端直接忽略旧延期。

「无限期」复用 ISO 字段的保留值 `9999-12-31T23:59:59.999Z`。宿主仅对此值豁免一年期限。
新查看端显示「无限期」且不设到期计时器；已有定时延期功能的旧查看端会显示远期日期，仍可手动取回。
旧宿主拒绝该值时走现有的保存失败提示。

字段只控制列表分类，不调度执行；到期只在客户端本地重算，无服务端轮询或新推送。
没有新增 channel、topic、relay 能力、账号授权或 SSH 文件访问。中继透传现有请求即可，
托管 relay 和用户自建 relay 都无需升级。任务所在电脑需升级才能保存，查看端需升级才能
显示收件箱。各端模式偏好独立保留；任务字段由所属电脑提供权威值。

验证入口：`sessionsUpdate.test.ts` 的真实本机/远程处理器持久化，迁移回放，
共享 `liveTaskPriority.test.ts`，手机 `homeSections.test.ts` 与 `mobileHomeListCache.test.ts`。

## 自动跟进判断（2026-11-18）

收件箱的进行中改为认任何启用中的绑定自动化，不再只认 PR 跟进，`sessionBindings: true` 投影里的
`status` 与 `targetSessionId` 已足够，不需要额外字段。此前为 PR 跟进加的可选 `followsPr` 已撤掉：
宿主不再发送；本 PR 之前的宿主若仍发送，控制端解析时忽略该字段（不再校验类型，也不会因此拒收整份
列表）。手机读取完整定时任务列表自行判断。仍走现有 channel，无新增 topic、relay 能力或授权。验证入口：
`providerListProjection.test.ts`、`remoteScheduleBindings.test.tsx`。
