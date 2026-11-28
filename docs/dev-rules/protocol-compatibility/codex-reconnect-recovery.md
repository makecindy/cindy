# Codex 重连超时后的续跑提示

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)。

执行端判定 `codex_reconnect_stalled` 需要人工接手时，输入投影和错误记录可带
`reconnectHandoff`。值 `disabled` 表示自动续跑已关闭，`exhausted` 表示达到了续跑次数上限。
Desktop 与 Mobile 忽略未知值。旧执行端省略该字段时，只说明连接超时；
旧控制端忽略新增字段，沿用已有的继续入口。

已安排的续跑仍由 `autoResumePending` 和历史记录的 `autoResumeInfo` 表达。
其中的 `attempt` 与 `maxAttempts` 统计 Cindy 续跑次数。错误详情里的最后一次重连序号来自 Codex，
两套次数各自计数。复用既有输入投影、消息记录和设备互联通道，中转服务无需同步升级。
