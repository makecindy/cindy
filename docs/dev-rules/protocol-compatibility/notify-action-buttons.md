# 通知按钮（2026-11-12，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`notify` 帧的 `NotifyPayload` 追加可选字段
`action?: { kind: 'permission' | 'reply' | 'question'; requestId?: string; options?: string[]; details?: string[]; question?: string }`。
`permission` 与 `question` 必须带 `requestId`（非空、不超过 `NOTIFY_ACTION_REQUEST_ID_MAX_LENGTH` = 128、无控制字符）：
前者表示通知正文描述的就是这一条等待中的工具权限请求，后者表示 Agent 问了一道题在等回答。`question` 可带
`options`（至多 8 个选项、每个至多 80 字、不含换行，顺序与正文编号一致）、`details`（与选项等长的说明，至多 160 字，
没有说明的位置为空串）和 `question`（正文被截断时的完整问题，至多 600 字）。`reply` 表示任务可以接收一条文字消息，
不带其它字段。字段只告诉
手机该给哪些按钮；答复本身仍是手机经既有 `maker:get-pending-interactions`、`maker:resolve-interaction`、
`local-db:sessions:get`、`maker:input:enqueue` 发给深链里的那台电脑，不新增 channel、relay kind 或协议版本。
产品规则见[通知上的按钮](../../product-rules/notification-actions.md)。

官方 Device Link 服务端（独立仓）：校验 `action`，畸形时与 `sender` 一样只丢掉这一项、照常下发通知；
合法时 APNs 负载增加 `aps.category`（`cindy.permission` / `cindy.reply` / `cindy.question.card`，系统据此显示 App
登记的按钮）和顶层 `action` 原值。`question` 的选项列表有一项不合格时只丢选项（仍可文字回复），说明条数对不上时
只丢说明；负载超过 4096 字节时先丢 `question` 与 `details`，仍超限则整组丢选项，保留文字回复；
动作元数据本身仍放不下时降级普通通知，最终校验 UTF-8 字节数。关闭了内容预览的 APNs 设备不下发
`permission` 与 `question`（没有正文就不能批准，选项按钮的文字就是被隐藏的内容），`reply` 保留。FCM 负载不变。
直连 SSE 的预览关闭过滤仍待用户确认，见服务端 [#1365](https://github.com/xindong/cindy-server/pull/1365)。
类别标识同时写在手机端 `notificationActionIds.ts`，是与已安装 App 的契约，不能改名。`cindy.question.card`
由通知内容扩展展开成提问卡片，见产品规则。

兼容：

- 旧服务端重建 payload 时丢弃未知字段，通知照旧、没有按钮；等权限的通知正文会从固定文案变成操作描述，
  旧手机同样显示，点击仍打开任务。
- 新服务端、旧手机 App：`aps.category` 指向未登记的类别，系统不显示按钮。
- 新手机、旧电脑：电脑不发 `action`，没有按钮。
- 手机作答用的 channel 早已存在（提问的答案同样经 `maker:resolve-interaction`）；电脑对已结束的请求返回 `accepted: false`，不会重复执行。

发布顺序：服务端先上线（对现有客户端无影响），再发电脑端与手机原生包。手机端包含原生扩展与新原生模块，
属于冷更。

自建中转不声明 notify 能力、不保存推送 token，本来就没有手机推送，因此没有按钮；`hub.ts` 对 `notify`
的静默丢弃不变，无需修改或升级已部署的自建中转。

实现与回归：协议 `packages/device-link-protocol/src/protocol.ts`；电脑端 `mobileNotify.test.ts`；
手机端 `notificationActions.test.ts`、`mobilePushRecovery.test.ts`；服务端 `notify.test.ts`、`pushSender.test.ts`。
