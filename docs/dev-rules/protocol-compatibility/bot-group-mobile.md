# 伙伴群聊手机端（Remote Resource 与群推送深链）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

群聊以新的 Remote Resource collection `bot-groups`（`resourceKind: bot-group`，无 placement）接入控制端，
列表项的 `links` 以 rel `member` 指向 `teammates` 中的成员。新增可移植原语 `bot-group-chat`：主机只对声明它的
控制端在 `get` 中输出该块，`data` 为 `@cindy/maker-shared/botGroupChat` 的 `BotGroupRemoteChatData`
（主机路径置空，只给文件夹名）；未声明的控制端只拿到 `markdown` 块的可读摘要。动作 id 见同文件
`BotGroupRemoteActionId`，被拒时以群聊错误码作为 registry 错误 message。变化沿用
`maker:remote-resources:changed`（collection + 该群 ref）。

分工停下时的手机推送沿用 notify 帧与 `session-needs-reply` 类别，深链为
`/companions/groups/<groupId>?deviceId=<hostDeviceId>`，`collapseId` 为 `(设备, 群)` 摘要。旧手机不识别该深链，
点开只进入 App；旧主机没有该 collection，新手机不显示群聊入口。未新增 channel、allowlist、relay 类型、
notify 类别或协议版本，服务端无需升级；Mobile 无原生 fingerprint 变更。

群附件按字段追加演进：`send` 动作的 input 可选携带 `attachments`（与会话消息相同的上传引用形状，
`cindy-peer-attach://` / `cindy-oss-attach://`，最多 20 个）；主机只接受该手机自己的上传，不接受主机路径。
消息追加 `attachments`（图片给 `cindy-media://` 地址，`path` 一律为 null）。`BotGroupRemoteChatData` 追加
`supportsAttachments: true`，新手机只在看到它时提供附件入口；旧主机不回这个字段，新手机不会把附件发给会丢掉
它们的旧主机。旧手机忽略新字段，Markdown 摘要里列出附件名。图片缩略图沿用既有 `device-link:media:fetch`。
未新增 channel、allowlist、relay 类型或协议版本。
