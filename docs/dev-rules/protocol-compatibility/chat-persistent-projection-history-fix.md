# 聊天持久投影的历史修正（2026-10-26）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`BotGroupDetail` 可选追加 `historyRevision?: string` 与 `messageUpdates?: BotGroupMessageView[]`。
前者是不透明的本地投影重建代次，不是服务器房间 revision；新版 UI 发现它变化时丢弃已加载旧页，
再按需补历史。后者返回现有 `sourceMessageIds` 所列已展示消息的当前授权投影，包含删除 tombstone；
不把这些消息追加到最新页，按稳定 id 替换已有旧页。旧客户端忽略附加字段，新客户端连接旧 Host
时沿用原刷新行为。无新 IPC channel、无新的执行权限或服务端必需 capability。

HTTP 继续使用现有 snapshot、messages 与 `/changes`；游标为十进制字符串，计算使用 BigInt。
Desktop 推送帧串行提交本地事务后 ACK；Mobile 活动群先通过 changes 补齐并落盘，再 ACK 通知。
未加载范围不因推进 cursor 被标成已下载。收到 RESET_REQUIRED、成员历史边界变化或明确撤权后，
清除／重建旧覆盖，不能只换最新 100 条而保留未校验旧正文。无 hydrated message 的旧服务端事件
降级为重建投影；新增字段缺省时保留旧端行为。发送与执行上下文仍由现有服务端权限判断。
