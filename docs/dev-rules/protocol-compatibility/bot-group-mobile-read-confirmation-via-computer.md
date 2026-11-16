# 手机经电脑确认群消息已读

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

群 Remote Resource 投影新增可选 `supportsReadReceipts`，仅云端群声明。
新手机通过现有 `maker:remote-resources:invoke` 的 `read` action 提交实际可见的
`messageId`；宿主复核群可见性及账号代次，再复用 `chatServer.manage` 的读位确认，
不信任客户端提供的序号、不读取或确认尚未显示的新消息。旧宿主没有能力标记时，
手机保留原本地未读缓存行为；旧手机忽略新字段。`send.quote` 转交既有发送验证与水合入口。
不增加 IPC 白名单、身份权限或原生依赖，不重置连接、不重放发送操作；单群读位失败
留待该群下次可见或重连刷新，不影响其它设备连接。
