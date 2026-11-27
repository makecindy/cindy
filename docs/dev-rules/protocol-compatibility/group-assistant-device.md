# 每位群成员的群 Cindy 执行电脑

Chat Server 的 `GET /me` 以 `capabilities.groupAssistantDevice: 1` 声明支持。桌面端建群或加群携带 `X-Chat-Desktop: 1`，服务端只从已认证身份取设备 ID。桌面端沿用已有的工作探测报告电脑名；没有此能力的服务端仍收到原格式。手机直连加群与升级前的成员关系由本人手动选电脑。

本人的群快照含 `room.assistant_device_id` 和 `assistantComputers`。桌面、手机直连及手机通过桌面查看群时均复用这份数据。群设置提交 `POST /conversations/:roomId/assistant-device`，参数为 `operationId`、`deviceId`。手机通过桌面时，使用既有群资源操作传输，旧桌面没有设备列表，手机隐藏入口。自建中转透传该操作，无需新增通道。

先在全部 Chat Server 副本应用迁移 048 和设备领取校验，再发布客户端。部署完成后，旧桌面也只能领取本账号在该群绑定给它的任务。已领取的任务沿用原租约。没有绑定或绑定电脑离线时群助手就地提示。其他群成员和其他群的设置各自独立。首次执行尚未指定电脑时，服务端保留当前请求，发出原因是 unbound 的提示；选择在线电脑后原请求继续。离线时使用 offline 原因。客户端只在服务端声明绑定能力时探测、领取群 Cindy 执行。
