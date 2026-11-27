# 群聊话题预览回复者

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`BotGroupThreadPreview` 可选增加 `responders`（回复 ID、作者类别、成员 ID、名字），
与最近两条 `replies` 摘要分开。Desktop 从已读取的窗口按服务端作者 ID 去重后取最多三位，
不增加网络读取预算。新查看端遇到旧宿主没有此字段时沿用 replies 去重回退；旧查看端忽略
新字段，继续读取原有两条摘要。Mobile 现有消费路径不渲染该预览字段；无新 channel、
服务端接口、权限、数据库或原生配置变更。
