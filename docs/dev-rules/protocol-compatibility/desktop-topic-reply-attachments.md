# Desktop 话题回复附件

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

本机 `ChatServerApi.reply` 增量接受可选 `attachments`，沿用群聊的附件输入、校验、上传与引用结算；
旧调用不带此字段仍按文字回复处理。此 IPC 未加入 device-link 白名单，手机和远程调用合同不变。
Chat Server 请求复用既有消息 `content` 的 media 块及 `threadRootId`，不新增服务端字段或消息类型。
无数据库迁移、权限扩大或服务端改动；回退客户端只收起电脑话题的附件输入，已有媒体消息仍可读取。
回归入口：`ChatServerControls.test.tsx`、`chatServer.test.ts`。
