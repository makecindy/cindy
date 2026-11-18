# 群聊远程任务限额原因（#6835）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

既有 `cindy-runtime-error:<code>` detail 与可选 `runtimeFailureCode` 新增安全类别
`REMOTE_DEVICE_LIMIT` / `REMOTE_TOTAL_LIMIT`，不传远程错误正文、设备身份或凭证。
旧客户端不认识新类别时沿用通用失败提示；新客户端消费旧服务器的通用 `RUNTIME_ERROR`
或缺失类别时，仅在本执行端保留同一执行 ID / epoch 的已知具体原因，服务器的其他明确类别优先。
普通回复、话题和分工共用分类与终态提交，不改变重试、租约或权限边界。

跨设备与重启后的具体原因需要 Chat Server 的 detail 解析和 `failure_code` 白名单支持这两个类别；
客户端改动不证明服务端已支持或已部署。未支持时其他查看端保持通用失败，执行端缓存不持久化。
本次不改服务端、数据库、device-link channel 或 Mobile 原生配置。
