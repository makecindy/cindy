## 插件事件：叫醒用户选定的自动化（routineEvents）

插件可以把自己观察到的事件（收到消息、新邮件、文档被评论……）交给 Cindy，叫醒用户在自动化里
选了这个插件的任务。插件负责接入（SDK 长连接、系统监听、本地 CLI 等，继续遵守 node/network
能力边界）；宿主负责接收、去重、合并、排队和运行。没有公网接收地址，也不需要 Cindy 账号。

> 历史：这套声明和管子原本为伙伴例行任务设计，2026-11-08 例行任务退役后一度是空操作；
> 2026-11-23 起改为叫醒普通自动化。已有插件不需要重装、改声明或重新确认权限。

在 schemaVersion 3 的清单里声明可发布的事件和可用于筛选的字段：

    "routineEvents": { "events": [{ "type": "message.received", "name": "收到消息", "fields": ["chatId", "senderId", "fromSelf"] }] }

这只授予发布事件的能力，不授予创建、修改自动化或指定模型的能力。用户在自动化的「事件」触发里选择
插件和事件（Agent 用 `schedule_list_event_sources` 查询后在 `webhookTrigger.source={preset:"plugin",...}` 里设置），
之后事件才会叫醒它。只要有启用中的自动化选了这个插件，宿主就在启动、启用和恢复时运行插件的浏览器
逻辑页并保持监听，即使 launch 省略或为 on-demand；没有自动化选它时，声明本身不让插件常驻。
停用插件仍会停止监听。Node 常驻仍独立要求 node.lifecycle: resident。

插件确认监听连接已建立后，调用：

    await cindy.send({ type: "routine-request", action: "status", status: "listening" });

连接断开/故障时提交 disconnected/error，连接重建后重新报告 listening。状态显示在自动化详情里。发送事件：

    await cindy.send({ type: "routine-request", action: "publish", event: {
      id: "upstream-delivery-id", type: "message.received", occurredAt: Date.now(),
      subject: "张三：明天的会改到下午", data: { chatId: "chat-1", senderId: "user-1", fromSelf: false }
    } });

也可使用 cindy.routines.request，参数省略 type。Host 从真实管子身份生成 `plugin:<id>` 来源，
不接受自报来源、任务或 prompt。

### 事件内容：多给判断信息，不替用户过滤

- **不要丢弃自己发出的消息。** 要不要处理由自动化自己决定（字段条件、前置检查或提示词），
  宿主和插件都不替用户过滤，包括这个自动化自己发出的回复。请尽量提供判断信息：
  `senderId`、`senderName`、`fromSelf`（是否用户本人发出）、`fromBot`、`chatId` / `threadId`，
  以及知道时的 `originScheduleId`（这条消息由哪个自动化发出）。
- `id` 必须使用上游稳定投递 ID；重投同一个 ID 得到 `duplicate:true`，不重复执行。没有上游 ID 时
  由插件生成并持久化后重投，不得每次重试重造 ID。
- `data` 只允许平坦的字符串、有限数字和布尔值，单个字符串至多 8000 字符、整体至多 32000 字符；
  宿主为队列和提示词只保留一份有界副本（单值 1000 字符、合计约 4000 字符，超出部分丢弃并标记
  `fieldsTruncated`），`subject` 保留前 200 字符。只提交处理所需的引用和筛选字段，不提交凭证；
  需要消息、邮件或文档全文时，由任务用插件的工具去读。
- 事件内容作为不可信元数据附在任务这一轮的消息后，不会成为指令或授权。

### 回执与限额

返回 `{ok:true,accepted,duplicate}` 表示事件已持久进入 `accepted` 个自动化的队列（0 表示当前没有自动化
选了它，或宿主未运行；不需要重试），不代表模型已运行或业务已成功。`duplicate:true` 表示所有匹配的自动化
都已收过这条投递。`ok:false` 时保留投递 ID，按退避重试；不可假报已处理。

宿主按自动化的规则合并：短时间内的多条事件合并成一轮，同一自动化同时只跑一轮，两轮之间有最小间隔；
运行期间的新事件进入下一轮。重启不自动重放已经开始、结果未知的执行。电脑休眠、关机或插件停用期间的
事件收不到，宿主不要求补拉。

宿主硬上限：单插件每 60 秒最多 60 次发布，全宿主最多 240 次；状态上报另有独立的同样额度，重复状态
同样计数（相同状态不触发界面刷新）。管子入口在等待前预留并发额度：状态与事件请求合计单插件最多 8 个、
整个宿主最多 32 个，超额立即返回可重试错误。整个请求（含未知字段、字段名和数组附加属性）受 128 KiB
UTF-8 保守预算、4096 个值和 16 层嵌套限制；循环引用、二进制对象等非普通 JSON 数据会被拒绝，超限返回
固定文案 Routine request is too large or invalid。超频返回 Routine request rate limit reached; retry after 60 seconds。
去重窗口为 24 小时。失败回执只包含固定公开文案；未知宿主错误统一返回 Routine request failed; please retry later，
底层路径和异常仅留在 Main 日志。保留原投递 ID，按退避重试，不要紧密循环。
