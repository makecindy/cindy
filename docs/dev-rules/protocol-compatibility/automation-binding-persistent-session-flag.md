# 自动化绑定投影的持续会话标记（归档确认）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:schedule:list` 在 `sessionBindings: true` 的投影里新增可选 `persistentSession`（仅为 `true` 时携带，
`false` 或缺省都不下发），继续保留运行模式与旧控制端兼容。当前控制端的归档提醒按 `active` 绑定筛选，
包含持续会话，不再用该字段排除提醒；普通自动任务下次触发会恢复原任务，不因归档换绑。
实际执行生命周期由被控端版本决定：旧被控端仍可能暂停普通自动化或为持续会话换绑，
新被控端按恢复原普通任务的语义执行。混合版本的提示可能与实际执行不同，以被控端版本为准；
不新增协议字段或版本协商。旧控制端可能仍按该字段省略持续会话提醒，或展示旧暂停文案。
`parseScheduleBindings` 对未知字段继续忽略，旧被控端缺省该字段不影响新控制端的提醒筛选。

产品语义与托管任务边界见 [`archive-pauses-automations.md`](../../product-rules/archive-pauses-automations.md)。

不新增 channel、能力、服务端 schema、数据库或 Mobile 原生指纹，`maker:schedule:list` 沿用既有白名单。
桌面远程任务归档时，每台设备总是直取一次带 `sessionBindings: true` 的 `maker:schedule:list`（最多等
1.5 秒；失败或超时回退本地镜像里已有的快照，没有则按无绑定处理，离线设备因此每次最多多等 1.5 秒）；
手机归档确认同样只发一次带该投影参数的 `maker:schedule:list`，同样有界。两端都只请求绑定投影，不拉完整列表。
