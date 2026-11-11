# 伙伴关联项目

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`teammates` 增加 `settings:<botId>/projects` 与其项目详情资源。使用既有 list/form/toggle 原语，
保存仍绑定账号、控制端、伙伴和资源 revision。远程不传目录绝对路径，项目 ID 为不透明摘要；
旧控制端可忽略新入口，新控制端连接旧 Host 时不显示入口。手机两端与远程桌面共用宿主投影。
本机新增 `local-db:bots:projects:list/set` 仅用于受信 renderer，不进入远程 IPC allowlist。
旧 `workbench.json` 目录及设备归属沿用原格式；关联不进入任务负责范围或扩大文件权限。
不改服务端、数据库 schema、Mobile 原生配置或指纹。
