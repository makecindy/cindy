# 任务复制的外置会话记录与超限大小

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:task-copy` 的 `caps` 追加 `externalTranscripts: true`。源端在每次准备时询问；目标声明后，
32 MiB 以上的原生会话记录不放进任务包，`receive` 的 `files` 追加可选 `transcripts: MigrationFile[]`
（至多 256 个，逐项校验大小与分段之和；源端准备时超出即报 `MIGRATION_NO_MEMORY`，不先上传），顺序与对应关系记在随包的 `workspace.json`
`transcripts[{path, file, bytes}]`；`path` 是包内会话记录引用的路径，目标只把它当映射键，
落盘文件名由目标按序号生成。`preflight` 的 `resources` 追加可选 `transcriptBytes`，目标据此预检
暂存与用户目录所在磁盘。旧目标不声明能力，源端继续随包携带；旧源端不发新字段。

状态追加可选 `errorSize: {needed, limit}`：源端判定内存超限时的字节数，与 `errorPath` 同样只随
`error` 下发并一并清除。目标端失败只回传错误码，原始报错与数字记在目标日志。
