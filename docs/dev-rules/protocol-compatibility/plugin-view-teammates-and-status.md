# 插件查看伙伴和状态（未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

agent.companions 为可选独立能力，只有 Host 确认的 `companionsCapabilityApproved` 才授予；
历史未知字段、旧 tasks/targets/observe 批准不推断新授权；旧 receipt 缺少新可选字段照常读取，无需 schema migration。
新包严格校验布尔值；已安装快照中的非布尔历史值原样保留但不授予，不因新校验停用。
逻辑页管道新增 `companions-request`（capabilities / list / avatar / reply / history / open / interaction / answer / watch / unwatch）与下行 `companions-changed` 推送，只在本机 Desktop Main 消费，不进入 device-link 白名单。
`interaction` 的 permission / plan 带 `allowHere`；插件对 `allowHere` 为 false 的请求「允许」返回 `ALLOW_IN_CINDY`（需在 Cindy 里允许），拒绝不受影响。
`answer` 作答其他电脑上的伙伴时复用已在同账号远控白名单里的 `maker:get-pending-interactions` / `maker:resolve-interaction`，不新增 channel；旧版主力电脑不报告待处理请求，插件无从作答。
旧 Host 忽略声明且没有 `cindy.companions`，插件须探测入口后降级。作者契约见 plugin-agent-tasks.md §4.11.9。
跨电脑新增 device-link channel `maker:companion-live:read`（`COMPANION_LIVE_CHANNEL`，版本 1，只读，进同账号远控白名单、不进 sharedTask 访客白名单）：
主力电脑返回本机伙伴的插件视图。旧版主力电脑没有该 channel → `CHANNEL_NOT_ALLOWED`，新查看端退回已发布的 teammates 列表（只有状态与工作阶段），
不推断其他内容；请求带 `version`，未知版本返回 `INVALID_PARAMS`。返回字段只增不改，查看端逐字段校验后再交给插件。
请求 `kind` 为 `list` / `reply` / `history`；不认识 `history` 的主力电脑返回 `INVALID_PARAMS`，查看端把对话记录当作读不到（null），不影响列表与回复。
