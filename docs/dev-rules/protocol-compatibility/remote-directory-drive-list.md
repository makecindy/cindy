# 远端目录浏览盘符列表

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`fs:list-dir` 响应追加可选 `drives: { name, path, current }[]`，只由 Windows 被控端回传：
经 PowerShell 读取 `GetLogicalDrives` 盘符表，不访问磁盘，断线网络盘不会卡住探测。结果缓存
30 秒，过期先回旧值并在后台刷新；首次枚举最多等 1.5 秒，超时、失败或为空时省略 `drives`，目录列表
照常返回。超时额外回可选 `drivesPending: true`，新版手机据此在当前目录自动再拉，旧控制端忽略。
`path` 是 host-native 根路径，控制端直接用它再调 `fs:list-dir`，不自行拼路径；当前
位于未枚举到的盘或 UNC 共享时补为当前项。新版手机在至少两项时于「上级」下显示盘符切换；
旧被控端不回字段时保留原逐级浏览，旧控制端（含 Desktop 添加远程项目对话框）忽略该字段。
未新增 channel、relay 类型、allowlist、权限或持久化状态，服务端无需改动。
