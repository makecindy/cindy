# 聊天通知内容与私聊落点（#7046）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

聊天推送增量携带 `conversationKind`，新原生端以此区分私聊/群通讯样式，旧端继续使用原通知。手机 `Accept-Language` 只控制服务端固定提示词，真实原文不翻译；云注册到两个服务都保留显式 preview 选择，旧请求缺省 true。完整任务通知预览关闭需要服务端先支持新列/字段；不添加隐私确认或更改默认预览。

Desktop 在通知点击事件携带可选 `conversationKind: direct`，落入现有时间线的明确私聊模式。`getBotGroup` options、`sendBotGroupMessage` input 与 `manage` 的 read action 的同名可选字段仅用于此模式，主进程读取实际 kind 后确认；普通群入口仍拒绝 direct/channel。私聊不提供群设置、邀请、分工或群话题操作，已读通过既有 read action、发送保留原幂等/引用/附件路径。手机由实际 snapshot.kind 决定私聊标题和单人头像；内部 groups 路径保持旧通知链接兼容，不改变服务器成员权限。此入口补齐通知的阅读/回应，不改伙伴主任务/接管编排。
