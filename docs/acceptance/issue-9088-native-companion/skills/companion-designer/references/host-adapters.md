# 原生宿主适配与候选范围

本方法通过 Cindy 的能力发现使用当前实际注册的工具。普通任务与伙伴都可以设计另一位伙伴；工具可用性与任务权限由宿主决定。方法包本身不增加宿主工具。

1. `cindy_helper.list_tools({category:"bots"})` 查当前入口；`create_teammate` 沿原生创建与开场机制，`list_teammates` 返回本机可管理目标的稳定 id，包含自己及暂停伙伴；消息对象仍查 `list_agents`。创建后原生开场异步准备主任务，配置读取暂报 `PRECONDITION_FAILED` 时保留返回的 id，稍后重读，不重复创建。
2. #9088 候选提供 `inspect_teammate_configuration`、`update_teammate_configuration` 与 `set_target_teammate_avatar`。读取默认只有已保存配置与运行状态；需要能力目录时传 `catalog:"skill"|"mcp"|"toolset"`。可用模型另查 `get_app_default_model`。
3. 配置写入需要刚读取的 `expectedVersion` 和本次 patch。省略保留；MCP/工具集的 null 恢复继承，[] 显式清空。头像还需要当前 `expectedAvatar`，只接受当前任务可读的受管图片。`crop` 使用原图经 EXIF 定向后的像素坐标；不按 HDR 转换后的缩小尺寸计算。模型配置与运行中的模型不是同一事实。
4. `savedVersion` / `profileVersion` 是已知提交回执。`effective:"unconfirmed"` 或 `synchronization:"unconfirmed"` 表示后续同步或读取未完成；先重读，不能将它当作未提交而重放。`runtime.matchesSavedVersion` 也不是某条具体输出的版本证明。
5. 远程控制端可以在伙伴主力电脑上的任务使用这些入口；直接给另一执行电脑指定目标 id、SSH 工作区和被迁走的本机影子副本暂未支持。目标 id 不授予跨账号访问。

自身修改沿既有 `get_teammate_state` / `update_teammate_profile`。#8576 的自身头像工具与本候选的目标头像工具合同不同，应按当前 schema 调用。

旧版没有目标写入口时，继续完成设计、命名和头像作品，并说明待应用的内容。不能直接改宿主数据库，也不能把发消息让目标自改冒充确定性保存。选择性历史恢复和精确执行版本关联不属于本候选。

公开讨论：[Issue #9088](https://github.com/makecindy/cindy/issues/9088)。Core 候选基于 `5c81ec6d7ee47d07677ac1ff762915e8421e3d13`；未发布版本的代码存在不代表当前安装具有接口。
