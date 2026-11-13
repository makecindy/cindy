# X 回复链的结构化输入

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

服务端负责 X 事件、账号绑定、真实回复链读取与预算、可靠派发和回传；Desktop 的
`hook-control/xPrompt.ts` 负责模型提示词格式。可选 `source.xContext` 提供
`requesterId`、`requesterName?`、`truncated`，`threadContext` 沿回复顺序排列并包含
链尾当前消息；各条可选 `messageId / replyToMessageId / authorId` 记录平台事实。
`triggerMessageId` 对应末条，`userText` 为完整请求正文，不含模板说明。

新客户端在展示元数据截短前校验当前消息身份及相邻回复关系，并组装一次模型 prompt：
顶部请求者、按序历史、链尾当前请求。沿用历史随机栅栏、逐行作者与缺失提示；排队及恢复
直接复用已组装结果，不重复拼接。展示沿用原有有界快照，不拿其截短正文重建模型输入。
X 快照有请求正文时，按原始 triggerMessageId 排除引用列表中的当前请求，避免与卡片正文
重复显示；模型组装仍读取完整 wire 回复链。旧条目缺少消息 ID 时保留，不按正文猜测去重。
这里只改变每条消息的文本组装与展示元数据，不修改主 Agent system prompt、权限或 UI 结构。

新服务端继续发送兼容 `prompt` 给旧客户端；新客户端遇到旧服务端、旧持久任务或不完整
结构化字段时原样使用该 prompt。两仓可独立升级，无数据库迁移、Mobile 冷更或部署顺序要求。
服务端兼容模板不再是新客户端格式的正本。
