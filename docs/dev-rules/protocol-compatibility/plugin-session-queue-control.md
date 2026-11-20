# 插件队列与共享运行控制

插件通过既有 hostTools/control 网关，以宿主 AsyncLocalStorage 核验的插件身份进入
原 sessionControlService 和队列事务；不自报任务 id，不新增权限组、receipt 或通道。
任务调用的原所有权规则保持。插件可查看、撤回、排序或插话本机所有来源的未消费条目。
插件编辑沿用任务界面允许的条目及宿主文字编辑事务，不可编辑的条目返回 `UNSUPPORTED_CAPABILITY`。
编辑保留编号、附件和生命周期，实际来源标为编辑插件，不携带原正文的用户授权。
`list_session_queue.queue[].source` 增量支持 `plugin`，`source_label` 为实例 id；旧字段原义不变。

`control_session` 为新增 helper/control 工具，提供 pause/resume/retry/compact，
只在执行 Host 注入处理器后登记。旧端不支持时明确报错，不回退成新发消息或数据库写入。
暂停使用现有执行锁；恢复、重试复用唯一队列。送达未知的消息不会自动重放；
显式恢复／重试沿用用户继续／重试入口，调用前须核实投递状态。
Claude 复用原 `/compact`，Codex/Pi 复用原生压缩及既有锁与临时恢复/释放。Pi 原生 RPC
发送前复核原派发授权。成功沿用原生估算值，`noop:true` 表示未压缩，实际 RPC 失败返回
`COMPACT_FAILED`。仅 Pi 接受非空压缩说明；现有 `retry` 按任务错误恢复事务执行。

存量插件影响：无，不更改原声明、批准和安装数据，无需迁移。
不增加 Device Link channel、relay kind 或跨电脑操作；自建中转仍透传原有 Host 请求，无需适配。
验证：sessionControlTools、sessionControlService、sessionQueueInspection、sessionQueueControl、
agent-input-coordinator 中的共享运行控制与送达未知场景，以及 Host host-tools 定向测试。
