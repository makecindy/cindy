# 灵动岛摘要的纯文本标记

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

既有 `local-db:sessions:activity` 可选追加 `summaryFormat: 'plain-text'`，仅标记
`compactDetail` 已经由所属 Host 转为显示文字。Desktop 控制端经活动 store、远端输入
投影与 Main IPC 校验保留标记；运行及完成卡片只折叠空白、限制长度，不再解析 Markdown。
缺省或未知值继续走旧摘要兼容转换：压平截断的组件块不显示源码，前置正文保留，
仍有围栏上下文时沿用共享 parser 保护代码引用。无法恢复正文时复用本地化“完成”。

旧控制端忽略可选字段，新控制端接受旧 Host 的无标记摘要；双方可独立升级。
旧 Host 已经压平的代码示例无法可靠还原格式，完整字面符号保留需双方更新。
不新增 channel、权限、连接恢复、持久化、服务端或 Mobile 原生配置；回滚时忽略标记，
保持旧摘要显示。回归见 `activityTextStream.test.ts`、`service.test.ts` 与
`agentIslandRemoteSessions.test.ts`。
