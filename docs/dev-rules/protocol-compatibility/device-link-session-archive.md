# Device Link 任务归档与恢复

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)。

此能力供同账号已绑定的设备控制指定桌面任务，可用于外接硬件的归档与恢复操作。渠道走现有
`invoke` 和 `invoke-result`，不改变中转帧、移动端协议或此前的 `sessions:patch-meta` 行为。
共享任务访客和供应商分享访客无法调用；宿主在读前和写入前核验目标可见性、账号与设备授权。

| 渠道 | 参数 | 响应 |
| --- | --- | --- |
| `local-db:sessions:archive:get` | `[sessionId, { operationId? }?]` | `{ version: 1, sessionId, current: { instance, revision, archived }, receipt: Receipt / null }` |
| `local-db:sessions:archive:apply` | `[sessionId, { operationId, instance, revision, archived }]` | `{ version: 1, ...Receipt }` |

`Receipt` 包含 `sessionId`、`operationId`、`instance`、提交时的 `revision` 和 `archived`。
`instance` 是宿主分配的任务实例标识，升级前的存量行使用空字符串。控制端应原样回传
`get` 返回的实例和修订。每次原生状态变化推进修订，状态来回变化后旧修订仍然失效。
控制端为每次新意图生成独立操作 ID，并在发送前保存原目标、实例、修订与操作 ID。

宿主持会话路由锁检查正在运行、排队、待交互及受管任务。SQLite 事务再复核原生任务及队列、
自动化、目标、分享、IM 和工作树事实，与状态修订同步提交回执。只支持普通的本机桌面任务。
归档与恢复不会启动模型。每次确认状态变化沿用原生增量通知。读取和重复操作不会发送状态通知。恢复保留期与恢复状态一起提交。

丢回执、断线或重启时，控制端用原操作 ID 重新读 `get`。若查到回执，`receipt` 证明原操作；
`current` 仍表示当前归属，桌面后续变更可以使两者不同。空回执不能用当前归属代替。宿主对
同控制端、同参数的重复操作返回原回执，不再次变更状态。同一操作 ID 改参数被拒绝。任务 ID
重用后旧实例读不到新实例的回执。每个任务实例最多保留 256 条回执，达到上限拒绝新远控写入，原记录
仍可查询。

旧宿主返回 `CHANNEL_NOT_ALLOWED`，控制端保留只读目录和历史。明确不支持时停止该连接上的
能力探测，无需持续轮询。新宿主继续接受既有客户端的原生任务归档调用。

发送背压沿用有界回复队列。补发时重新核对当前实例和可见性，读取响应更新 `current`；原操作回执保持原值。
