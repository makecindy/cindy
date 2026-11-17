# 灵动岛群消息展示

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Desktop Main 向随包分发的原生灵动岛 helper 追加可选 `groupChat` 展示字段（成员头像与本地化 @ 标记），缺省时沿用原卡片。
群卡使用独立 UI 标识，点击仍走现有群消息深链；不签发任务 `completionToken`，不进入任务活动广播或 device-link relay。
服务端已读／关注／静音判据与系统通知共用，未新增服务端接口、数据库、Mobile 原生配置或远程 IPC。
旧 helper 忽略可选字段后仍可显示标题和摘要、点击进入群消息；旧 Main 配合新 helper 保持原样。
回归见 `agent-island/__tests__/{state,service,deviceSessions}.test.ts` 与 `maker-ipc/__tests__/chatServer.test.ts`。
