# 插件只读查看项目任务（未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

agent.observe 为可选独立能力，不依赖 tasks/targets，只有 Host 确认的 observeCapabilityApproved 才授予；
历史未知字段、旧 tasks/targets 批准不推断新授权。旧 receipt 缺少新可选字段照常读取，无需 schema migration。
新包严格校验布尔值；已安装快照中的非布尔历史值原样保留但不授予，不因新校验停用。
逻辑页管道 `observe-request` 由本机 Desktop Main 消费。`project-tasks`、`open-task` 仍限已登记的本机项目。`open-session` 和 `session-status` 复用 observe 与 history 工具组批准，设备 ID 指向记录所属电脑。

`session-status` 按已知 ID 请求，每台电脑每批 1–200 个。远程沿用同账号后台 Device Link 以及 `local-db:sessions:get-many` 的既有准入。Desktop 和无界面 Host 均可作为源端，对首参 `{projection:'sidebar-status',ids}` 返回 `{sessions:[{id,status}]}`。无界面 Host 按 ID 读取原生侧栏的活动、未读终态和仍待用户处理的确认。缺少实时记录时，运行状态取自仍在执行或恢复的轮次。普通任务的未读完成显示 `done`，已读后回到 `idle`，历史写入收尾不延长运行状态。每次投递状态回包时，源端按首次读取的可见性条件批量复查 ID，省略排队期间删除、隐藏或移出普通任务范围的记录。普通数组首参保持各端原有行为。旧端在读取预览前拒绝对象首参，调用端返回 `UNSUPPORTED_CAPABILITY`。账号、插件授权或设备链路变更时丢弃在途成功结果。

插件须逐方法探测入口，设备不可达或不支持时隐藏状态点。存量 manifest、批准记录与安装布局沿用原格式。作者契约见 plugin-agent-tasks.md §4.11.8。
