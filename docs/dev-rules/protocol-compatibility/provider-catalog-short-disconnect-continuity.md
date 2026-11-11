# 供应商目录的短断连续性（2026-11-03）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:provider:list`、对象形式的模型能力查询和同账号组 `view` 回包可附带
`providerContinuity: { stale, remainingMs }`。它只描述目录信息的新鲜度，不是授权、预算或执行成功证明。
转发者必须继承剩余期，并扣除本次读取花费的时间；不可在每一跳重新起算 30 分钟。
Main、Desktop 与 Mobile 的视图缓存均以墙钟或单调时钟任一先到期为准，重复读取和失败不续期。

没有此字段的旧端保留原有视图生命周期；不能在保持旧数组/标量回包形状的同时可靠转交剩余期，
因此这些回包不进入新的 Main 连续性缓存。授权查询、远程 Agent `caps`、组分配与写操作不缓存。
明确拒绝、账号/区域/权限代次变化或显式断开作废对应快照；网络、限流和服务暂时不可用才允许回退。
恢复探测使用实时调用：分享 peer 走其已授权的 Agent 服务，不查询它无权读取的主人任务数据库。
当前实际对象形式的 maker:agent:status 回包（binaryReady / authReady / identity 等执行机 Agent
安装与登录来源发现信息）也按同一 providerContinuity 预算处理：各跳继承剩余期、双时钟，
重复读取、失败或重开界面不会延长同一快照的剩余期；明确拒绝、账号/区域/权限代次变化或
显式断开作废对应快照。它只说明目录信息的最近可用性，不证明恢复、设备授权、M 的任务 grant、
额度或执行成功；真正的 M 任务准入与执行仍由 M 实时核验。maker:list-available-agents 仍是
数组回包，不进入新的 Main 连续性缓存；旧端形状不变。

只新增可忽略的业务结果字段，不新增帧类型、relay 权限或服务端依赖；旧客户端仍按原字段读取。
回归入口为 `metadataContinuity.test.ts`、Main `providerMetadataContinuity.test.ts`、
`deviceLinkIpc.test.ts`、`responsivenessTracker.test.ts` 与两端模型目录缓存测试。

## 同账号组的新任务连续性

`RemoteAgentCaps.groupContinuity: true` 是可选严格能力位，只对同账号控制端提供。
O 在原 Fast 策略绑定之后，通过既有 `provider-group:remote` 发送 `continuity-prepare`，
M 保存限定 O/C/组/供应商/Agent/模型的内存上下文并回 `{id, remainingMs}`；O 再把可选
`continuity: {id, remainingMs, config}` 附在原 `pick` 成功结果。各跳从请求开始扣时，双时钟收口，
重读/失败/业务流量不能续期。组设置和供应商权限变化发送精确 `continuity-revoke`，迟到 prepare 不得覆盖 revoke。

O 再次交付已确认的上下文前，可用既有 `continuity-inspect` 核验 M 是否仍持有它；
仅原签发者 O 可做这项只读核验，`continuity-admit` 仍只允许绑定的 C。健康上下文保留原 id
与原双时钟期限，包括剩余不足 10 分钟时。M 重启丢失上下文时，只向 O 回 `{id, remainingMs: 0}`
表示不存在；零值不是给 C 的正向 ACK，C 的现有解析继续拒绝。已记下的撤销或关闭仍返回拒绝，
不能当成重启重新签发。只有明确不存在时 O 才重新 prepare 并取得 M ACK，继承旧剩余预算并扣传输预算；
收到不存在回执后，旧行只保留原期限供重试，不再交付给 C；重新 prepare 超时或临时失败时，
须等新 M ACK 才能再次交付连续性上下文。迟到的不存在回执也终止旧行的再次交付。
临时失败不续期，迟到的明确拒绝也清理对应上下文，不影响邻居。不新增帧、通道或协议字段。

O 不可达时，C 只向已预备 M 发 `continuity-inspect` 读实时可用性/负载，并对选中 M 发
`continuity-admit {id, ownerDeviceId, sessionId}`。M 校验真实来源 C、自身权限/模型和原期限，
将既收 O 的 Fast 策略绑定到新任务，之后仍走现有 Agent open。C 不传策略值或修订号。
旧 M 缺此位时 O 不发新动作；旧 C 忽略 pick 可选字段，保持原路径。所有新动作仍受现有
同账号 dispatch 边界保护，不进入供应商分享/共享任务访客授权；不扩大旧 task-specific 分享许可。
候选、在途和回执数量有界；软并发保留原语义，准入临时计数只避免同时选择时低估负载。

Desktop 本地 `STATUS_CHANGED/getState` 可附 `directDataDeviceIds`；路径事件再附单目标
`dataPathChangedDeviceId`。它们由 Main 当前认证/就绪路径生成，界面不能据缓存伪造。
一台目标失效只失效它的就绪状态、镜像和重试；全局信令状态仍单独用于诊断。Mobile 新前台客户端
沿用 SDK 的最长 30 分钟保留，后台仍释放，旧端生命周期不变。无新增 wire 帧或服务端要求。
回归入口：`continuityRouting.test.ts`、`continuityRuntime.test.ts`、`remoteHandler.test.ts`、
`hostLifecycle.test.ts`、`remoteConnectionStatus.test.ts`、`remoteProjectsStartup.test.tsx` 和 Mobile `historyViewProvider.test.tsx`。
