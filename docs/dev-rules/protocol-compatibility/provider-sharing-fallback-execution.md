# 分享供应商备用执行（2026-11-08）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`provider-share-availability-v1` 是设备能力声明。服务端 `/provider-shares/availability/:shareId/:action`
新增注册、目录、分配、任务准入、状态与无内容用量接口；跨区域只开放 guest 目录/分配/查询/状态，
沿用该分享的 guest credential，不接受本区域 Access Token 替代。服务端收到的身份全部来自认证上下文。
`received` 增加可选 `standbyOnline`，原 `hostOnline` 继续表示 O 的物理在线状态；新版客户端另存
`hostDeviceOnline` 并将有效可用状态投影到本地 `hostOnline`。旧客户端忽略新字段、保持旧行为。
没有新能力的 M 不被选择；没有新接口的服务端不获得备用权限。既有 device-link 帧与协议版本不变。
新增 PostgreSQL 表须先迁移再部署。发布顺序为服务端后 Desktop；新能力只在 O 在线成功登记后生效。
备用 M 每轮发送前以独立 `executionId` 调用 `accept` 占用容量，完成后以原分配 generation 和本轮
executionId 调用 `complete`；打开任务的无 executionId `accept` 只确认归属。G 的状态遥测不能释放
已接受任务的容量。完成回执在准入请求发出前捕获，响应丢失时也会尝试释放原轮次，失败沿原任务收尾路径重试；
撤权后仍可释放原轮次，旧回执不能释放后续轮次。服务端记录取消标识，先到的释放回执可阻止迟到准入。
这是本次备用执行能力的配套接口，需使用包含上述接线的 Desktop；不改变既有在线 O 的委派路径。

## Agent Net 的已准备执行机

在支持 `directGuestStandby` 的两端，`delegate` 可随具体任务授权附带备用范围和并发上限。
新版 G 在 `allocate` 声明可以准备备用机，O 返回 `canPrepareStandby` 时才会异步发送 `standby-prepare`。
仅准备的许可用于 `standby-admit`，本身不允许打开任务；O 保留隔离清理和用量回执所需的元数据。
M 从已验证的 Agent Net 名册确认原 O、分享、成员、G 和精确的 M 密钥，打开或分叉任务时再次核验授权的 Agent 类型。
G 为每次准入生成 `admissionId`，作为子任务许可的 generation；已确认没有启动的请求通过 `direct-release`
清理对应未使用的子许可。启动结果未明时保留原执行机位置及本进程内尚有效的许可，可继续向原执行机重试。
分享者恢复后，已获换机凭证且完成历史交接的任务走原有组分配。支持 `directGuestStandby` 的 O
收到 `requireGroupSwitchToken` 时先确认旧分配已交接，再打开任务。G 等到启动成功才清理旧备用位置；
清理失败时关闭尚未交付的任务，并保留凭证供原交接重试。
有相符证明时授予或检查执行许可无需再读旧 Device Link 准入接口。取得许可的回复使用剩余时间，G 和 M
皆取原许可时钟窗口的较小值。派发前确认任务位置，从原 M 重开；明确拒绝、关闭、过期和账号变化终止备用。
`delegate/disarm-standby` 按原 generation 撤掉备用范围，保留有效的普通任务许可。

新版 O 在正常分配返回 `directStatusBatch`。收到该能力位的 G 将同一份分享的忙闲状态合并，
每批最多 64 条，按任务及授权 generation 核验。旧 O 继续接收单任务 `direct-status`。
分享业务动作仍沿用原来的加密会话，自建及官方中继处理相同的帧。升级不需要新中继接口或协议版本。
