# 任务收件箱与稍后处理（2026-11-12）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)。

沿用 `local-db:sessions:patch-meta` 与 sessions 列表/推送，新增可选 `snoozedUntil`
（ISO 时间或 null）写字段；宿主同时保存并返回可选 `snoozedAt`，调用方不可写设置时间。
迁移 0150 为 sessions 新增两个可空毫秒列。旧数据为空，不改变现有列表。

新控制端/手机请求旧宿主会收到字段不允许，或通过返回字段检查发现未应用，显示错误并回滚。
旧控制端/手机忽略新字段，继续显示原列表；不会因缺失字段禁用其他任务操作。
延期与设置时间作为一对同步；手机对乐观写、推送遮蔽和回滚均保护整对字段。
归档和显式状态恢复清除延期；新输入时间晚于设置时间时各端直接忽略旧延期。

字段只控制列表分类，不调度执行；到期只在客户端本地重算，无服务端轮询或新推送。
没有新增 channel、topic、relay 能力、账号授权或 SSH 文件访问。中继透传现有请求即可，
托管 relay 和用户自建 relay 都无需升级。任务所在电脑需升级才能保存，查看端需升级才能
显示收件箱。各端模式偏好独立保留；任务字段由所属电脑提供权威值。

验证入口：`sessionsUpdate.test.ts` 的真实本机/远程处理器持久化，迁移回放，
共享 `liveTaskPriority.test.ts`，手机 `homeSections.test.ts` 与 `mobileHomeListCache.test.ts`。
