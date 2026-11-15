# Agent 跨设备历史发现与搜索

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

历史查询的可选 `teammate_id`、`source` 由源端在召回、排名、分页前过滤，仍与原调用方权限
及远程可见范围取交集。`list_sessions` 的 `time_field=activity` 同时控制时间窗、排序和游标，
活动时间取创建、更新、用户发送时间的最大值；省略时保持创建时间语义。新增输出
`lastActivityAt`、`companion`（持久伙伴关联及可证明的渠道），搜索元数据补充 `source`。
跨设备转发不丢筛选字段；旧端若拒绝新参数，保留失败设备组与 `partial`，不能重试成无归属
筛选的查询，也不能把失败当作无聊天。没有这些参数的旧调用保持兼容。

`cindy_helper` 的 `list_history_devices` 使用现有同账号设备目录；`list_sessions` 和
`search_chat_history` 新增 `device` 参数，默认 `local` 保留原行为，`all` 查询本机和在线且
允许访问的电脑，也可指定目录返回的设备 ID。跨设备响应按设备分组；`limit`、排序、
`nextCursor` 和搜索相关性均属于单台设备，翻页使用该组设备 ID 和游标，不能把一个游标
用于所有设备。离线、禁用、撤权、超时或不支持的设备明确列入结果，`partial` 表示覆盖不全；
目录失败仍可返回本机结果，但不能声称已搜索全部设备。搜索候选池上限仍以每组的
`pool_capped` 表示，不保证无限召回。

新增只读 `local-db:history:query` channel，仅接受 `list_sessions` 或
`search_chat_history`，复用原工具的参数校验、本机查询和输出格式。远端不允许继续转发，
不加入 unlinked/shared-task 白名单，不增加自动重试、缓存或聊天同步。沿用同账号
device-link 授权、撤权与 owner fence；仅有归属范围权限的调用方不能扩展历史范围。远端任务
列表及搜索两路召回在排名、限量和分页前应用同一条伙伴可见性条件，隐藏任务不占分页名额，
游标和候选池信息只基于可见结果。指定 `session_ids` 时也由源端 SQL 统一过滤，隐藏、归档、
失去伙伴关联及不存在的 ID 均不产生命中；不通过请求前的存在性检查返回不同错误，混合查询
仍返回其中可见任务的结果。普通回复、缓存回复与离线重发仍重新核验；页内任务若已
变为隐藏，整页返回 `NOT_FOUND`，不发送该页的内容或过期分页信息，调用方可重新查询。
列表中的 `parentSessionId` 与页内任务共用一次源端可见性查询，不可见或已不存在的父任务
引用省略；缓存与排队回复也重新投影。向量可用性探针与 KNN 使用同一可见范围和查询过滤，
仅有隐藏向量与没有向量时返回相同诊断；只存在于隐藏任务的目录与不存在的目录也不可区分。

远程结果中的任务 ID 为 `deviceId::sessionId`，可直接供现有 `get_chat_history` 读取。
搜索上下文每条最多 2000 字符，省略时带 `remoteContentTruncated`；完整阅读继续使用历史
读取接口。超出传输预算返回明确错误，调用方缩小 `limit` 或 `context_radius`，不能静默
当作未命中。旧被控端返回 `CHANNEL_NOT_ALLOWED` 时标为 `REMOTE_UNSUPPORTED`，其他设备
仍正常返回；完整跨机发现和搜索需要两端均支持此 channel，旧工具调用默认本机不变。
本次不改服务端和数据库 schema；手机与 IM 通过所在电脑的 Agent 使用能力，无新增界面。
SSH 主机不自动成为设备目录成员。实现与回归见 `mcp-integrations/historyDevices.ts`、
`localDb/ipc/historyQuery.ts` 和 `packages/lizi-mcps/src/__tests__/historyDevices.test.ts`。
