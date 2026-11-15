# Claude 自动续跑开始标记（2026-11-11）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

既有 Agent `status` 事件的 data 可选增加 `providerInitiatedTurn: true`，仅在适配层确认顶层
自动续跑开始时与 `isRunning: true` 一起发送。旧消费端忽略附加字段；新消费端缺字段时仍使用
原正文／工具进度判据，因此旧执行端的零输出续跑失败须升级执行端才能修复。SSH SDK 消息在
任务宿主翻译，远程 Agent 沿用既有事件 data 透传；手机使用任务宿主的错误和等待投影。
不增加帧、channel、allowlist 或网络请求，官方与自建中转均无需改动；恢复只针对本任务，
不重启共享连接或重放其它任务。
