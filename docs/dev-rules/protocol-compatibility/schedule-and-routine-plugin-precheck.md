# 定时任务与例行任务的插件前置检查（2026-10-31）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:schedule:*` 读回的定时任务与写入参数、伙伴例行任务定义（含随伙伴上云的 routine 值）新增可选
`preRunPlugin: { pluginId, onFailure: 'allow' | 'skip' | 'block' }`，与 `preRunHook` 并列。旧端忽略该字段；
旧端写入不带该字段时 host 保留已存值，`null` 才清除。新 host 只在换了插件时校验插件可选（已启用、
声明了对应 `will-` 节点且用户已批准），并把插件 id 归一成实例 id。定时任务存两列
`pre_run_plugin_id` / `pre_run_plugin_on_failure`（0140，companion 幂等加列）；未知的出错处理按 `block` 读。
插件 id 只对插件所在的电脑有意义：`cindy_scheduler` 跨电脑修改拒绝设置该字段，伙伴搬家时带插件检查的
例行任务先关闭再到达；Mobile 与项目自动化配置不编辑、不保存它。不新增 device-link channel：插件下拉用
本机专用的 `ghosts:control-points:candidates`，不进 allowlist。
（2026-11-08 起 V2 不再适用于伙伴例行任务：例行任务已转为伙伴项目的自动化，带插件检查的例行任务转成已暂停的自动化并在
`CARRYOVER.md` 记一条说明；定时任务的 `preRunPlugin` 不变。）
