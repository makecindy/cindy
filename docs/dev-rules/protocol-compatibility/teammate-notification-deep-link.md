# 伙伴通知深链

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

手机推送 `deepLink` 仍是 `/sessions/<sessionId>?deviceId=<hostDeviceId>`。会话属于伙伴的
canonical 主任务时，宿主额外追加 `resourceCollectionId=teammates&resourceId=<botId>&resourceKind=bot`，
与伙伴名册打开聊天时的路由参数相同：手机据此按伙伴聊天呈现（伙伴页头、导航与已读），并继续做既有的
会话来源与主机校验；这些参数不授予任何权限。已发布的手机版本本来就识别这组参数，不需要升级；
不识别它们的旧控制端仍按普通任务打开。拼接后超过 `NOTIFY_DEEP_LINK_MAX_LENGTH` 时回退为原深链。
委派的独立 Session 任务和普通任务不带这组参数。不修改 notify 帧结构、relay 或协议版本。
