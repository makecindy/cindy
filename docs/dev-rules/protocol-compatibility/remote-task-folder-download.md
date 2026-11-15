# 远程任务文件夹下载

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

聊天里的「下载到本地」把远程文件或文件夹存进控制端的系统下载文件夹。既有
`file-browser:remote-op` 的 `caps` 追加可选 `dirExport: true`，并新增两段式 op：
`exportDirStart { workdir, relPath }` 校验目录在工作目录内（含 realpath）后立即返回
`transferId`，被控端在后台把目录打成 tar（保留符号链接与可执行位），按 2GB 分段推给
**发起调用的控制端**（目标取自 invoke 上下文的 `controllerDeviceId`，共享任务访客拒绝）：
每段先试直连附件，失败回落 OSS，与跨电脑复制任务同一套分段描述（`MigrationFile`）。
`exportDirStatus { transferId }` 幂等返回 `state`（packing / sending / done / error）、
进度字节、跳过条目数，`done` 时附分段引用；终态保留 10 分钟，控制端 2 分钟不来轮询即视为
放弃并中止。控制端取件后从直连收件箱移出（不在收件箱滞留）或下载并删除 OSS 对象，再解包。

旧被控端不声明 `dirExport`（或回 `unknown op: caps`），控制端提示更新远程电脑，不退回逐个
文件拷贝；嵌套 SSH 工作目录回 `REMOTE_UNSUPPORTED`。旧控制端不调用新 op，行为不变。
SSH 远程不经 file-service，直接在 SSH exec 通道上流式传回远端 `tar` 输出。未新增 channel、
relay 类型、allowlist 或持久化 schema，服务端无需改动；Mobile 未接入。实现见
`apps/desktop/src/main/file-browser/chat-download.ts`、`dir-export.ts` 与 `dir-archive.ts`。
