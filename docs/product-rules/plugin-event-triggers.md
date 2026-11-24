# 插件事件触发自动化

> **读取时机**：让插件提供的事件触发自动化、修改插件事件声明或发布管子、插件事件来源的表单与详情、
> 把 GitHub App 等内置来源收进统一的事件来源前。
> **适用路径**：`packages/maker-scheduler/src/plugin-events.ts`、`packages/plugin-protocol/src/routineEvents.ts`、
> `apps/desktop/src/main/cindy-brain/routineSlot.ts`、`apps/desktop/src/main/cindy-brain/residentGhost.ts`、
> `apps/desktop/src/main/scheduler-host/webhook/pluginEvents.ts`、
> `apps/desktop/src/renderer/features/scheduler/components/PluginEventSourceFields.tsx`、
> `apps/desktop/src/renderer/features/scheduler/lib/pluginEventSelection.ts`、
> `packages/lizi-mcps/src/scheduler/eventSources.ts`
> **要点**：事件只是门铃；要不要处理由自动化自己决定，宿主和插件都不替用户过滤；存量插件声明照旧可用。

2026-11-23 用户确认方向和下文四项裁决，同日实现第一版（Desktop）。

## 要解决的问题

自动化原本只能被两类外部事件叫醒，都写死在宿主里：GitHub App（服务端验签后经设备长连接推送）
和普通 Webhook 地址（发送方预设由 `webhook-formats.ts` 描述）。两者共用后半段：本机复核范围，
进入 `ScheduleWebhookQueue` 持久队列，再由 runner 把元数据作为不可信块附在本轮消息后启动任务，
规则见 [Webhook 触发](schedule-webhook-trigger.md)。

缺的是“插件也能按门铃”。飞书、Slack、邮件这类来源要求回传握手值或只提供长连接，普通 Webhook 地址
接不了；它们的接入方式各不相同，按[核心产品原则](core-product-principles.md)的分工留在插件里，
宿主只提供稳定的事件原语。插件发布事件的契约（`routineEvents` 声明 + `routine-request` 管子）原本为
伙伴例行任务设计，2026-11-08 例行任务退役后成了空操作（见 [伙伴例行任务 V1 存档](bot-routines.md#插件本地协议)）；
本功能把它接到普通自动化上，回答了[伙伴专属能力台账](teammate-capability-ledger.md)里的待核实项。

## 定位：通用事件来源，不是 IM 机器人

IM 机器人是对话入口：有人找机器人，就开或续一个对话。插件事件是自动化的触发条件，范围更广：
用户自己的账号收到私信、群里有人 @ 我、来了新邮件、文档被评论、日程变化……只要插件能观察到，
就可以叫醒用户指定的自动化。例如“只要有人给我发消息就触发”可以同时选飞书、Slack、邮件几个插件的
“收到消息”。两者互不替代、不互斥：同一条消息既可能被机器人处理，也可能叫醒自动化，由用户配置决定。

## 用户裁决（2026-11-23）

1. **过滤规则属于自动化。** 插件和宿主都不替用户丢弃事件，包括自动化自己在群里发的回复。
   插件应尽量多提供判断信息（发送者是不是用户本人、是不是机器人、这条消息是否由某个自动化发出）；
   要不要处理由自动化的字段条件、前置检查或提示词决定。这取代 V1 的“带 `originRoutineId` 的事件不反向
   触发同一规则”和“接入端应过滤自己发出的消息”。
2. **接受离线限制。** 插件运行在本机，电脑休眠、关机或插件停用期间的事件收不到，宿主不要求插件补拉，
   也不做服务端暂存。需要不漏事件的，由用户在「事件」触发里勾选「同时定时检查」兜底。
3. **与 IM 机器人性质不同**，见上节。
4. **不为插件来源另设费用上限。** 触发多少次、花多少模型额度由用户负责。宿主为稳定性保留的发布频率、
   请求体量、并发和去重容量限制不属于费用上限，继续保留。

## 现行契约

### 插件侧：复用存量声明与管子

- 沿用 `routineEvents` 声明和 `routine-request`（`cindy.routines.request`）的 `status` / `publish`。
  已安装插件的这项能力已在安装批准里，升级后不重装、不重新确认，符合存量插件兼容红线。
- 校验与限额沿用 V1：来源由宿主从真实插件身份派生（`plugin:<安装身份>`，与前置检查的 pluginId 相同）、
  只接受声明过的事件类型、`data` 平坦且至多 32000 字符、128 KiB 请求预算、固定失败文案。频率限制
  （`RoutineEventAdmission`，单插件 60 次／分钟、全宿主 240 次）对发布与状态上报分开计数，在解析事件和落盘前执行；
  这一层在空操作期间缺失，本次补回。
- `publish` 返回 `{ok:true, accepted, duplicate}`：`accepted` 是实际持久入队的自动化数（0 表示没有自动化
  选了它或宿主未运行，插件无需重试）；`duplicate` 表示所有匹配的自动化都已收过这条投递。写入失败返回
  可重试的固定文案。
- **常驻只在有人订阅时。** 存在启用、未过期、选了某插件的自动化时，宿主在启动、启用、恢复和订阅变化时
  拉起该插件的浏览器逻辑页并保持监听（`spawnResidentGhost` 的 `eventSubscribed`）。最后一个订阅关闭后
  不主动停止正在运行的插件（用户可能也在用它），下次启动时不再拉起。没有声明事件的插件不会因订阅而启动。
- 监听状态（`listening` / `disconnected` / `error`）由插件上报，宿主同时探测插件是否在运行（`stopped`），
  显示在自动化详情。插件停止后，旧的“正在监听”不再显示。
- 建议插件提供的字段：`senderId`、`senderName`、`fromSelf`、`fromBot`、`chatId` / `threadId`，知道时提供
  `originScheduleId`。这些只是信息，宿主不据此丢弃事件。插件开发说明见 Skill 参考
  `cindy-plugin-creator/references/plugin-routine-events.md`。

### 自动化侧：作为事件来源接入现有触发

- 存储复用 `webhookTrigger.source`：`{preset:"plugin", sources:[{plugin, events?, filters?}]}`，至多 16 个插件。
  省略 `events` 表示该插件的全部事件（包括以后声明的）；多个插件之间“任一命中即触发”，同一插件内事件类型与
  字段条件同时满足（AND）。字段条件支持 `equals`、`contains`（不区分大小写）、`not-equals`；字段缺失时前两者
  不命中，`not-equals` 命中。顶层 `events` 必须为空，否则引擎拒绝（来源自己选事件）。
- 兼容：旧执行端拒绝未知来源，不会静默改成普通 Webhook；旧控制端编辑时省略来源会原样保留。
  跨电脑写入插件来源前检查目标的 `supportsSchedulePluginEventTrigger`，不检查目标的 Webhook 接收服务。
- 插件来源不需要接收地址、密钥、Cindy 账号或服务端；不占普通 Webhook 的地址名额和每天的接收次数。
  宿主运行时（`ScheduleWebhookHost`）在未登录时也接收插件事件；插件来源不参与服务器同步，设置密钥、
  更换地址、重新连接返回 `PLUGIN_EVENT_SOURCE`。
- 事件只投给**插件所在电脑**上的自动化，不跨电脑转发。项目文件自动化不支持（插件安装身份因电脑而异）。
- 改变插件、事件或条件的范围会更换本地队列身份，旧范围的待执行事件不进入新范围；仅重排、重复项不算变化。
- 进入队列后的合并（15 秒）、同一任务同时只跑一轮、忙时顺延、重启恢复、暂停时忽略，全部沿用
  `ScheduleWebhookQueue`。插件事件绝不会命中普通 Webhook 或 GitHub App 来源的自动化。
- 队列记录（`ScheduleWebhookEvent`）增加宿主派生的 `source`、`occurredAt`，以及插件提交的 `subject`（≤200 字符）
  和 `fields`（单值 ≤1000 字符、合计约 4000 字符，超出丢弃并标记 `fieldsTruncated`）。这份有界副本以
  `untrustedJsonBlock` 附在本轮消息后，不进 system 段，也不写进任务 prompt；前置检查脚本与脚本模式任务
  收到同样的元数据，可据此跳过（例如 `fromSelf`）。
- **两轮之间至少间隔 5 分钟这一条，对插件来源暂时保留。** 它原本是控制费用的主要手段，按裁决 4 费用由用户
  负责，但聊天类场景隔 5 分钟才响应可能太慢；是否对插件来源调整或取消，待用户决定后修改本条与
  `SCHEDULE_WEBHOOK_LIMITS`。

### 界面与 Agent

- 表单的触发方式「Webhook」改称「事件」。发送方下拉在原有选项之外增加「插件事件」，只在本机有声明了事件的
  已启用插件（或任务已保存插件来源）时出现；未登录或没有 Webhook 接收服务时，「事件」仍可选，只提供插件事件和
  「GitHub · 指定 PR」（2026-11-24 单条 PR 并入「事件」）。
- 所有事件来源（含插件事件）都可以勾选「同时定时检查」兜底离线期间的事件（2026-11-24），规则见
  [Webhook 触发](schedule-webhook-trigger.md#用户行为)。
- 选择插件事件时按插件分组列出声明的事件：勾选插件 = 全部事件，可只勾其中几种，取消最后一种即移除该插件；
  显示每个插件的监听状态。任务里保存的插件后来不可用时仍保留显示并可移除，不悄悄去掉。界面不编辑字段条件，
  但保存时原样保留 Agent 设置的 filters，并提示条件数量。
- 自动化详情的连接区域显示每个插件的名称、监听状态、所选事件、条件数量、最近接收时间和离线提示；没有地址、
  密钥与账号管理入口。插件详情页的权限行改称「自动化事件」。
- Agent 与用户同权：`schedule_create` / `schedule_update` 接受插件来源（未登录也可开启）；`schedule_list_event_sources`
  列出本机可选插件、事件、字段与监听状态，只在本机。`schedule_get` 的 `webhookStatus.plugins` 给出各插件状态。
- 插件只能发布事件，不能创建或修改自动化、指定模型或执行方式；声明了 `hostTools: ["scheduler"]` 的插件创建自动化，
  沿用已有调度工具权限。

### GitHub App 仍内置

GitHub App 依赖服务端的 App 私钥、PR 跟进的精确订阅和免计次投递，不搬进插件（2026-11-05 已决定）。本次把调度器、
队列和宿主里仅对 GitHub App 成立的“托管来源”判断收成 `isManagedWebhookSource` / `sameManagedWebhookScope`，
插件来源与 GitHub App 共用；各来源的投递健康判断仍分别实现，更彻底的来源接口整理留待后续。

## 尚未覆盖

- 手机和其它控制端不能新建插件来源；编辑时原样保留。
- `will-schedule-run` 控制节点的数据不含事件元数据。
- 宿主不会把“某个自动化运行中调用了插件工具”告诉插件，`originScheduleId` 目前只能由插件自己记录。

## 回归重点

`packages/maker-scheduler`：`plugin-events.test.ts`（来源命名、字段预算、订阅集合）、`webhook-queue.test.ts`
（只命中所选插件／事件／条件，不命中普通 Webhook 任务，自己发出的消息照常入队）、`scheduler.test.ts`（保存、
范围变化换队列身份、非法条件）。Desktop：`routineSlot.test.ts`（来源派生、限流、失败文案）、`residentGhost.test.ts`
（订阅时才拉起）、`webhook/__tests__/host.test.ts`（未登录时从发布到运行）、`schedulerDevices.test.ts`（跨电脑能力协商）、
`scheduleFormLogic.test.ts`（保存来源与勾选逻辑）。`lizi-mcps`：`cindy_schedulerMcpServer.test.ts`（未登录可开启）。
