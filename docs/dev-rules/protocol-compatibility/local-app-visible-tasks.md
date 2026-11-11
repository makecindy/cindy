# 本机应用的可见任务（2026-10-28）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

本机 Agent API v1 的 `session/open` 响应可选追加 `cindySessionId`。应用授权记录可选
保存 `createVisibleSessions: true`，缺省与旧授权均为关闭；旧客户端忽略新增响应字段，
不改变既有令牌、恢复句柄与工具策略。每次 open 创建新任务，调用方不能指定已有 Cindy 任务。
设置操作 `local-agent:set-create-visible-sessions` 只接受本机受信 Renderer，不进入
device-link 的 invoke 白名单。普通任务及消息沿用现有多端同步路径；本机应用来源使用
已有 `sourcePlugin` 元数据的 `local-app:` 前缀。旧查看端可能按插件显示来源，
不影响正文或执行授权；更新后显示本机应用。协议与验证入口见[本机 Agent API](../../local-agent-api.md)。
