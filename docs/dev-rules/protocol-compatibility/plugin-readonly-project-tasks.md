# 插件只读查看项目任务（未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

agent.observe 为可选独立能力，不依赖 tasks/targets，只有 Host 确认的 observeCapabilityApproved 才授予；
历史未知字段、旧 tasks/targets 批准不推断新授权。旧 receipt 缺少新可选字段照常读取，无需 schema migration。
新包严格校验布尔值；已安装快照中的非布尔历史值原样保留但不授予，不因新校验停用。
逻辑页管道新增 `observe-request`（`project-tasks` / `open-task`），只在本机 Desktop Main 消费，不进入 device-link 白名单。
旧 Host 忽略声明且没有 `cindy.observe`，插件须探测入口后降级。作者契约见 plugin-agent-tasks.md §4.11.8。
