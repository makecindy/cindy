# 伙伴跟进邀请（2026-10-21）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

（2026-11-08 起 V2 不再适用：自动跟进已移除，新 Host 对 `settings:<botId>/follow-up` 返回 `NOT_FOUND`，
不再显示邀请；以下记录旧版本之间的协议。）

总调度未设置 override 时默认关闭，已有明确选择保留。跨端沿用 `teammates` 远程资源：
`settings:<botId>/follow-up` 返回既有 form/toggle/confirmation、可选邀请标记和不透明动作票。
读资源不启用跟进；点击开启或暂不开启才保存。票据绑定账号、控制端、伙伴及当前设置 revision；
旧票、隐藏伙伴与账号切换沿用既有拒绝规则，不新增 invoke channel 或共享访客权限。
新 Host 对旧查看端仍执行默认关闭；旧端忽略新增入口/字段，已有聊天不变。新查看端连接旧 Host
时不显示邀请，不能声称旧 Host 已执行新默认。Desktop 本机与远程 Desktop 的对话内邀请是一行轻提示，
点「开始跟进」先弹与设置页同一确认框，完整显示范围及用量（远程时取 Host 下发的文字），确认后才保存；
「暂不开启」直接保存。Mobile iOS/Android 复用现有设置表单与按钮并显示范围及用量；
没有原生配置、依赖、指纹或数据库迁移变化。
