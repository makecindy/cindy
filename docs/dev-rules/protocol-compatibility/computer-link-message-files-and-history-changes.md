# 电脑互联的消息文件与历史变更

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

跨电脑任务复制使用同账号业务通道 `maker:task-copy`，受信 Renderer 使用 `task-copy:request`。
不开放裸导入、数据库或路径写入；共享访客不准入。该通道与旧 `maker:task-migration` 交接协议
隔离，旧端拒绝时提示升级，不退回旧交接协议或控制端执行。新端也不接收旧协议的 activate。
源任务和文件保留可用，自动任务及消息渠道不转移。数据复用 peer 附件与 OSS；复制记录及目标回执
仅用于幂等重试，不管理源任务执行权。写请求不进入自动重试白名单，无需服务端变更。
`preflight` 检查目标实时资源；文件描述可为单附件或有序分段附件，每段复用已有协议和校验，
复制不设固定总量上限；`estimate` 超过 `TASK_MIGRATION_MAX_FILES`（50 万）个项目文件时返回
`MIGRATION_TOO_MANY_FILES`，控制端据此不开始复制，旧源端不返回该错误码。
整组 Orca 沿用可选 `teamMigration: true` 能力声明，缺省不支持；
`receive.files.additionalWorkspaces` 沿用同一文件描述，manifest 记录成员到目录的映射。
双方必须支持复制通道；收到整组能力声明才发送团队，不尝试部分导入。
运行中取消由源端状态的可选 `cancellable` / `cancelling` 声明，旧源端缺省时控制端不提供取消。
源端状态的可选 `skipped: { total, entries[{ path, code }] }` 列出本次复制跳过的条目，旧源端缺省、旧控制端忽略；
新源端会发送项目内链接链与断开链接，旧目标仍按旧规则拒收（`MIGRATION_EXTERNAL_LINK`），需更新目标。
manifest 的可选 `destination`（`{ kind: 'dialogue' }` 或 `{ kind: 'project', path }`，`path` 为相对用户目录的
文件夹名数组）只在未选目标项目时决定落点；旧目标忽略该字段，旧源端缺省时新目标仍用 `task-copies/projects`。
范围、恢复与源目录保护见 [同机移动与跨电脑复制任务](../../product-rules/task-device-migration.md)。

设备互联生成文件沿用远端文件服务的 stat 与修改时间，控制端按被控端消息时间窗校验命令产物；
仅有文件存在、缺失时间戳或读取失败不构成命令产物证据。不增加 relay 协议字段。
SSH 保持仅展示经过存在性复核的工具产物，不把 Desktop 消息时间与 SSH 主机文件时间比较。
历史变更在既有只读 `git-review:remote-op` 上追加 `turn-list` / `turn-get`，
按被控端任务 ID 读取已保存的摘要和精确差异，沿用 gzip 与 OVERSIZE 边界，不截断补丁。
`maker:turn-change-set:updated` 仅向同账号设备推摘要，归属 `session:<id>`，沿用账号和任务可见性复核。
共享任务访客不接收该推送（含离线补发），其既有读取与操作权限不变。
旧主机不认识新 op 时保留原无卡片行为，不回落读取控制端本机记录；完整历史变更展示需要两台
电脑升级。旧控制端忽略新增摘要推送，原行为不变。
撤销／重新应用追加独立写通道 `maker:turn-change-set:apply`，参数为任务 ID、变更 ID 和
`undo` / `reapply`；只读 remote-op 不接收写操作。被控端复用本机冲突、运行状态、路径和
快照状态校验，并在队列和 Git 预检后复核远程授权；本机 IPC 的受信窗口检查保持不变。
旧主机拒绝新通道时显示操作失败，不回退本机。写请求不加入自动重试或读取合并白名单；
摘要推送和重连后的重读恢复显示，超时不能证明操作未执行。
本次覆盖 Desktop 设备互联；SSH 任务没有本机历史变更快照，仍不显示该卡片；
Mobile 未新增卡片入口。服务端无需改动。
