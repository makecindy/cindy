# 群内等待领取超时原因（2026-11-09，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Chat Server 的 `/executions` 与 `/execution-failures` 保留 `failure_code: RUNTIME_TIMEOUT`，
仅对服务端确认的当前尝试等待领取超时追加可选 `failure_reason: unclaimed_timeout`。
这只说明请求在就绪等待期限内未被领取，不证明所属电脑离线、关机或模型服务异常。
细分原因随当前执行代次收尾，显式重试后不沿用旧原因；不改变原排队、租约或断线取消语义。

客户端共享解析仅接受与 `RUNTIME_TIMEOUT` 匹配的已知原因，派生消息视图可选携带
`runtimeFailureReason`；桌面、手机直连与手机经电脑读取的群视图使用同一判据。
字段缺失、未知或不匹配时保持原通用错误展示，不读取或显示私有 detail。
旧客户端忽略新增字段；新客户端连接旧服务端／旧电脑时使用通用提示。
服务端可先发布，客户端随后发布。Device Link、IPC channel、allowlist、权限、数据库 Schema
与 Mobile 原生配置均不变。
