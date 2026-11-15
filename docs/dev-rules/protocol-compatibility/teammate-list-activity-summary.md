# 伙伴列表的可选活动摘要

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

RemoteResourceDisplay 与 BotGroupSummary 可选携带 `teammateActivity: { phase }`。宿主从现有运行、待确认、完成、错误状态投影，Desktop/iOS/Android 共用状态优先级。生成文案、确认权限、已读回执均保持原有路径。旧控制端忽略字段；新控制端连接旧宿主时回退已有 generation、确认快照及普通未读，不把缺失状态推断成完成。

字段位于现有 Remote Resource 的业务 payload 内，不改握手、签名、顶层帧、relay 路由或重连逻辑；官方与自建中转都沿用通用加密转发，无需中转升级。群直连复用现有 executions/plans 只读接口，不修改服务端；旧服务器缺少接口时保留普通列表。
