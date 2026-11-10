# 原生宿主适配与候选范围

本方法通过 Cindy 的能力发现使用当前实际注册的工具。普通任务与伙伴都可以设计另一位伙伴；工具可用性与任务权限由宿主决定。方法包本身不增加宿主工具。

1. `cindy_helper.list_tools({category:"bots"})` 查当前入口；`create_teammate` 沿原生创建与开场机制，`list_teammates` 返回本机可管理目标的稳定 id，包含自己及暂停伙伴；消息对象仍查 `list_agents`。创建后原生开场异步准备主任务；`runtime.status=not-prepared` 时仍可读已保存资料和修正该伙伴模型，能力目录暂不可用。身份编辑仍遵守原生准备状态限制；沿同一 id 继续，不重复创建。
2. #9088 候选提供 `inspect_teammate_configuration`、`update_teammate_configuration` 与 `set_target_teammate_avatar`。读取默认只有已保存配置与运行状态；需要能力目录时传 `catalog:"skill"|"mcp"|"toolset"`。可用模型另查 `get_app_default_model`。`project` 非 null 表示 V2；`project.workingDir` 为已准备的主任务目录，准备中可为 null，此时先等待同一原生对象就绪，不猜路径。
3. 配置写入需要刚读取的 `expectedVersion` 和本次 patch。省略保留。V2 拒绝 `references` 修改，避免保存无效的个人名单；仅旧版非项目伙伴支持该字段，MCP/工具集的 null 恢复继承，[] 显式清空。头像还需要当前 `expectedAvatar`，只接受当前任务可读的受管图片。`crop` 使用原图经 EXIF 定向后的像素坐标；不按 HDR 转换后的缩小尺寸计算。模型配置与运行中的模型不是同一事实。
4. `savedVersion` / `profileVersion` 是已知提交回执。`effective=deferred` 表示等待安全运行边界；在途或后台工作可能使下一条输入仍采用旧配置，不能据此承诺立即生效。`effective:"unconfirmed"` 或 `synchronization:"unconfirmed"` 表示后续同步或读取未完成；先重读，不能将它当作未提交而重放。`runtime.matchesSavedVersion` 也不是某条具体输出的版本证明。
5. 远程控制端可以在伙伴主力电脑上的任务使用这些入口；直接给另一执行电脑指定目标 id、SSH 工作区和被迁走的本机影子副本暂未支持。目标 id 不授予跨账号访问。

当前主线已合入 #9314 V2 与 #9666 官方 Skill 继承。目标项目规则放 `AGENTS.md`，方法放 `.agents/skills`；使用核实过的 `project.workingDir` 和现有文件/Skill 工具。项目文件不在 profile patch 内，也不与资料版本构成原子提交；分别读回并检查实际采用。不同版本的资源装配规则仍须按当前宿主核实。目录中的已加入标记不单独证明正在运行的模型已装载；本机官方 Skill 已继承时，其启停属于本机设置，不伪装成目标个人选择。V2 伙伴以普通项目加载资源时，使用已核实的项目配置与文件入口，不能沿旧白名单写入后宣称启停成功；项目规则和 Skill 文件的采用也不能由 Profile 版本匹配代替。最终在同一原聊天实际读取或调用新方法，分别记录保存、发现与采用结果。

自身修改沿既有 `get_teammate_state` / `update_teammate_profile`。#8576 的自身头像工具与本候选的目标头像工具合同不同，应按当前 schema 调用。

旧版没有目标写入口时，继续完成设计、命名和头像作品，并说明待应用的内容。不能直接改宿主数据库，也不能把发消息让目标自改冒充确定性保存。选择性历史恢复和精确执行版本关联不属于本候选。

公开讨论：[Issue #9088](https://github.com/makecindy/cindy/issues/9088)。当前整合基线见随包源码旁的验收 README；未发布版本的代码存在不代表当前安装具有接口。
