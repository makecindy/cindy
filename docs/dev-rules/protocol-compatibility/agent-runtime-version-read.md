# Agent 运行时版本读取

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:agent:binary-version` 已在 device-link 只读白名单内。可选第二参数
`{ checkLatest: true }` 让被控端再比较当前更新通道的线上清单，响应追加 `latestVersion`、
`updateAvailable` 与 `latestCheckFailed`（没读到清单时为真，此时“无更新”无法确认）。
不传参数时只读本地版本，三个字段为 `null` / `false` / `false`。旧被控端忽略参数且不返回
新字段，控制端按无更新、未失败处理；旧控制端忽略新增字段。关于页的重启更新入口
`update-harness-relaunch` 不在白名单内，远程端不能重启被控 Desktop。实现见
`apps/desktop/src/main/maker-ipc/binary-version.ts`。
