# 自动化的插件事件触发（2026-11-23）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 产品规则见[插件事件触发](../../product-rules/plugin-event-triggers.md)。

`webhookTrigger.source` 纯增预设 `{preset:"plugin", sources:[{plugin, events?, filters?}]}`，存在既有 JSON 列
`schedules.webhook_trigger` 里，不加 migration。沿用 `maker:schedule:create/update/get`：缺 key 表示不修改，
`null` 清空。旧执行端的 `normalizeScheduleWebhookSource` 拒绝未知预设，写入报错而不会静默改成普通 GitHub Webhook；
旧端读到未知预设时原样保留（`localDb/mapper.ts`）。旧控制端与手机编辑时省略 source，配置保留。

`maker:get-capabilities` 纯增 `supportsSchedulePluginEventTrigger: true`。跨电脑写入插件来源前，调用方
（`mcp-integrations/schedulerDevices.ts`）先确认此标记，缺失时在写入前返回 `REMOTE_UNSUPPORTED`；插件来源不检查目标的
`maker:schedule:webhook-receiver`（不需要账号或接收服务）。`maker:schedule:webhook-status` 的返回纯增可选
`plugins: [{plugin, state, reportedAt?, lastEventAt?}]`，旧控制端忽略。设置密钥、更换地址、重新连接对插件来源返回
`PLUGIN_EVENT_SOURCE`。

插件侧沿用既有 manifest `routineEvents` 与管子 `routine-request`（`packages/plugin-protocol/src/routineEvents.ts`、
`apps/desktop/src/shared/ghostPageBridge.ts`），请求与回执形状不变：`publish` 的 `accepted` 从固定 0 变为实际入队的自动化数，
新增可公开的拒绝文案 `Routine request rate limit reached; retry after 60 seconds`。2026-11-24 纯增 `action:"subscriptions"`
（回执纯增 `subscriptions:[{events?, filters?}]`）：旧宿主对它返回 `Unknown routine operation`，插件需按「没有订阅信息」
降级（例如 GitLab 插件不轮询，用户改用宿主定时检查）；旧插件不调用它，不受影响。manifest 与安装批准不变，已装插件无需重装或重新确认。

本机 Renderer 新增 `ghosts:event-sources`（只读，只信任本机应用窗口，不进 Device Link 白名单），Agent 工具新增
`schedule_list_event_sources`（只在本机）。服务端、官方与自建中转、手机原生层均无变化；插件事件不经过 webhook-server。
回归见 `packages/maker-scheduler` 的 `plugin-events.test.ts`、`webhook-queue.test.ts`、`scheduler.test.ts` 与 Desktop
`schedulerDevices.test.ts`、`routineSlot.test.ts`、`webhook/__tests__/host.test.ts`。
