# 插件任务的已完成进展消息（2026-11-24，未发布）

桌面宿主通过 `tasks.capabilities().runProgress` 声明支持。插件可调用
`tasks.readMessages({taskId, progressForRun: runId, after?, limit?})`，读取已保存的进展。
宿主校验任务和运行的插件归属、两者的 taskId 和账号，按这次输入筛选消息后分页。
返回值包含 `progressForRun`、`items` 和 `nextCursor`。接收方要求返回的 runId 与请求一致，
按消息 ID 去重，以 `getRun.outputMessageId` 读取最终答复。

进展只取前台主助手的完整正文，Codex 提供 commentary 标记，Claude 和 Pi 提供工具调用的
结束原因。数据库使用可选的助手消息元数据记录输入归属。旧行无需迁移。旧客户端照常读取
最终答复；新插件遇到缺少能力标记的宿主时跳过进展。原有未筛选的消息 API 保持兼容。
本次扩展沿用插件任务权限和本机历史，不增加全局历史权限、服务端请求或中转协议字段。
