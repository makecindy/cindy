# 当前错误的历史行关联（2026-11-09）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`AgentInputProjection` 可选返回 `errorPersistId`，指向当前错误横幅承接的持久化错误行。
新 Desktop 在重载、重连仅收到状态快照时恢复该 ID，沿用现有精确 ID 去重，不按文案合并
不同失败。旧 Host 缺字段时保留同一错误已知的事件关联；错误替换或清除时不继承旧 ID。
旧客户端忽略此可选字段；Mobile 原有终态事件关联保持兼容。沿用既有 invoke／push 与
授权，官方和自建中转均只透传既有 payload，无需服务端或 relay 升级。
