# 每位群成员的群 Cindy 执行电脑

Chat Server 的 `GET /me` 以 `capabilities.groupAssistantDevice: 1` 声明支持。桌面端建群或加群携带 `X-Chat-Desktop: 1`，服务端只从已认证身份取设备 ID。桌面端沿用已有的工作探测报告电脑名；没有此能力的服务端仍收到原格式。手机直连加群与升级前的成员关系由本人手动选电脑。

本人的群快照含 `room.assistant_device_id` 和 `assistantComputers`。桌面、手机直连及手机通过桌面查看群时均复用这份数据。群设置提交 `POST /conversations/:roomId/assistant-device`，参数为 `operationId`、`deviceId`。手机通过桌面时，使用既有群资源操作传输，旧桌面没有设备列表，手机隐藏入口。自建中转透传该操作，无需新增通道。

先在全部 Chat Server 副本应用迁移 048 和设备领取校验，再发布客户端。部署完成后，旧桌面也只能领取本账号在该群绑定给它的任务。已领取的任务沿用原租约。没有绑定或绑定电脑离线时群助手就地提示。其他群成员和其他群的设置各自独立。首次执行尚未指定电脑时，服务端保留当前请求，发出原因是 unbound 的提示；选择在线电脑后原请求继续。离线时使用 offline 原因。客户端只在服务端声明绑定能力时探测、领取群 Cindy 执行。

## 等选电脑只给本人看（2026-11-28，客户端先行）

服务端协议不变，客户端只换展示。服务端把等选电脑的请求存成 `needs_input`。本人在本群没有执行电脑，这条执行也没有任何电脑领取（本机没在跑、列表里没有 `executor`），据此认定它在等选电脑，不需要新字段。群 Cindy 的 `needs_input` 执行凡不是本人发起的，一律不算群里的进行中。`executor_unavailable` 提示卡只对 `requesterId` 本人显示，其中 unbound 一类对本人也隐藏，改由卡片承接。

- 群视图追加可选字段 `assistantDeviceWaits: [{ executionId, sourceMessageId, requestText }]`（`BotGroupSummary`），只列本账号自己等电脑的请求。手机经电脑查看时，由 `bot-group-chat` 原语透传。旧手机忽略该字段；旧电脑不发该字段，新手机就不显示卡片。
- 取消沿用既有动作通道：桌面 `chatServer.manage` 新增 `{ type: 'cancelAssistantDeviceWait', executionId }`，手机经电脑用 Remote Resource 动作 `cancelAssistantDeviceWait`（`{ executionId }`，只接受该电脑列出的等待项）。手机直连则直接对该执行调用 `POST executions/:id/control` 的 `stop`。三条路径都只结束本人发起、尚未开始的群 Cindy 执行。旧电脑不认识该动作时会拒绝，不会退化成停止全部。
- 「继续」沿用 `assistantDevice` 动作，服务端在首次绑定时放行所有等待中的请求。
- 未新增 channel、allowlist、relay 类型、通知类别或协议版本；自建中转透传既有群资源动作，无需修改。
- 服务端遗留：等选电脑的执行没有超时（`unclaimed_timeout` 只处理 `queued`）；提示仍作为群消息写入，旧客户端可见。待服务端补期限，并改为只推送给本人。
