# 自动化任务 Webhook 触发（2026-11-02）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

账号地址管理（2026-11-04）纯增同账号 invoke `maker:schedule:webhook-account`、
`maker:schedule:webhook-release`、`maker:schedule:webhook-restore`；共享任务和供应商访客不放行。
新控制端遇到旧宿主的未知通道按不可用处理，不伪造空清单。既有密钥与地址轮换接口仍仅本机。
官方和自建中转沿用通用 invoke，无帧或鉴权变化；白名单校验与同账号控制授权保持不变。

REST 纯增 `/account/endpoints` 清单及按 ID 释放、设备范围 `/endpoints/released` 和
`/endpoints/by-schedule/:scheduleId/restore`。设备清单可选增加名称，旧客户端忽略；旧服务返回
404 时新客户端沿用原接收行为、账号管理提示等待更新。`webhook-status.problem` 纯增 `released`，
WS 纯增 `endpoints-changed` 失效通知，旧客户端忽略。释放必须先部署服务端新增迁移与接口；
数据库插入触发器阻止旧服务副本自动重建，不能通过回滚历史迁移撤销。恢复使用最新 releaseId，
并发旧恢复不能撤销后一次释放。账号删除同时清理释放记录。

`Schedule` 新增可选字段 `webhookTrigger`，`ScheduleRun` 新增可选字段 `triggerSource`，对应追加列
`schedules.webhook_trigger` 与 `schedule_runs.trigger_source`（迁移
[`0148_schedule_webhook_trigger`](../../../apps/desktop/drizzle/scripts/0148_schedule_webhook_trigger.ts)）。沿用既有
`maker:schedule:create/update/get` 通道：缺 key 表示不修改，`null` 清空，旧客户端整表单保存不会清掉配置。
旧主机只保留已知列，会报告成功却丢掉配置，所以能力新增 `supportsScheduleWebhookTrigger`；Agent 工具的
跨设备设置／清空先检查此标记，不支持则不发送写入；开启时再通过目标电脑的
`maker:schedule:webhook-receiver` 确认有接收服务。清空不要求接收服务可用，省略字段仍表示不修改。
同账号 invoke 新增只读的 `maker:schedule:webhook-status`。
`maker:schedule:webhook-set-secret` 携带密钥明文，`maker:schedule:webhook-rotate-url` 更换接收地址，都不进 Device Link
白名单。官方及自建中转沿用通用 invoke 转发，没有帧、鉴权或重连协议变化，无需修改中转内核。

`webhookTrigger` 新增可选字段 `source`（发送方预设与是否签名，或自定义格式），存在既有 JSON 列里，不加 migration。
缺 key 表示不修改，旧客户端和手机的编辑不会把它改回 GitHub；本机认不出的预设原样保留，不按 GitHub 同步。服务器
REST 的地址保存请求新增必填 `format`，密钥改为客户端生成或粘贴后 `PUT /endpoints/:id/secret`，新增
`POST /endpoints/:id/rotate`；功能尚未发布，两端同批上线，没有存量调用方。

接收改走 webhook-server 后，端点清单纯增可选字段 `webhookApiBaseUrl`，不 bump schemaVersion：老客户端忽略，
缺失或留空时隐藏入口，也是灰度开关；该字段按区域锁定，不进 `CROSS_REGION_ENDPOINT_KEYS`。REST、长连接帧和
关闭码的合同正本是 cindy-server 的 `docs/webhook-server.md`，双方忽略不认识的帧 `type`。同账号 invoke 新增只读的
`maker:schedule:webhook-receiver`；`webhook-status` 的返回增加 `receiver`、`connected`、`problem`、`quotaLimit`、
`quotaResetAt`。长连接新增 `quota` 帧，只在接收次数用完时出现，没有恢复帧，客户端按 `resetAt` 自行解除。功能尚未发布，
没有存量客户端。服务端先部署并验证，再把清单字段填上。
