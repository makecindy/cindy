## 本地例行任务事件

插件通过 schemaVersion 3 的 routineEvents 声明事件来源：
声明后，宿主在启动、启用和恢复时自动运行插件的浏览器逻辑页并保持监听，即使 launch 省略或为 on-demand；停用插件仍会停止监听。Node 常驻仍独立要求 node.lifecycle: resident。

    "routineEvents": { "events": [{ "type": "message.received", "name": "新消息", "fields": ["chatId", "senderId"] }] }

这只授予提交事件的能力，不授予创建、修改例行任务或指定伙伴的能力。用户在伙伴的例行任务界面选择来源、事件和条件后才能触发执行。插件自行选择 SDK 长连接、系统监听或本地 CLI 等接入方式，继续遵守原有 node/network 能力边界；来源与连接器不绑定。第一阶段没有公网 webhook 接收服务。

插件确认监听连接已建立后，调用：

    await cindy.send({ type: "routine-request", action: "status", status: "listening" });

连接断开/故障时提交 disconnected/error。连接重建后重新报告 listening。发送事件：

    await cindy.send({ type: "routine-request", action: "publish", event: {
      id: "upstream-delivery-id", type: "message.received", occurredAt: Date.now(),
      subject: "thread-id", data: { chatId: "chat-1", senderId: "user-1" }
    } });

也可使用 cindy.routines.request，参数省略 type。Host 从真实管子身份生成 plugin:<id> 来源，不接受自报 sourceId、botId 或 prompt。id 必须使用上游稳定投递 ID；重投同一个 ID 得到 duplicate:true，不重复执行。没有上游 ID 时由插件生成并持久化后重投，不得每次重试重造 ID。data 只允许字符串、有限数字和布尔值，总计至多 32000 字符；只提交处理所需的事件引用和筛选字段，不提交凭证。需要邮件/文档全文时由伙伴通过已配置工具读取。知道由哪条例行任务造成的回声时，填写 originRoutineId；接入端也应过滤自己发出的消息。

返回 {ok:true,accepted,duplicate} 表示事件已持久接收（accepted 是匹配例行任务数），不代表模型已运行或业务已成功。ok:false 时保留投递 ID，按退避重试；不可假报已处理。多条件 OR 命中只入队一次；运行期间的新事件可合并进下一轮。重启不自动重放已经开始、结果未知的执行，以免重复外部副作用。时间与事件共用运行历史。去重针对投递身份，业务对象已完成与否仍由任务指令和工具记录判断。

宿主硬上限：单插件每 60 秒最多 60 次发布，全账号最多 240 次；待处理发布请求分别最多 8 和 32。
管子入口在等待引擎或数据库就绪前预留并发额度：状态与事件请求合计单插件最多 8 个、整个宿主最多 32 个，跨引擎重建保留计数，直到请求完成或失败才归还。无效操作、状态和超大事件在等待前拒绝；超额请求立即返回可重试错误，不进入等待队列。
整个请求（含未知字段、字段名和数组附加属性）在等待前受 128 KiB UTF-8 保守预算、4096 个值和 16 层嵌套限制；循环引用、二进制对象等非普通 JSON 数据会被拒绝。小型未知字段仍忽略，data 的 32000 字符限制保持不变。超限返回固定文案 Routine request is too large or invalid，应精简请求后再投递。
去重窗口为 24 小时，回执按 UTF-8 JSON 限制为单插件 256 KiB、账号 2 MiB；超限返回 ok:false，
应保留原 event.id 稍后重试，不要改 ID 或紧密循环重试。容量满时不会驱逐窗口内回执；旧版过量
回执在启动时保留最新的有界部分。事件运行历史不受回执清理影响。
状态上报另有独立的每插件 60 次/分钟、全账号 240 次/分钟额度，重复状态同样计数；相同状态和声明不会触发界面刷新，也不会清空最近事件时间。请只在状态变化或重连后上报，超限时退避重试。
失败回执只包含固定公开文案；未知宿主错误统一返回 Routine request failed; please retry later，底层路径和异常仅留在 Main 日志。保留原投递 ID，按退避重试。
