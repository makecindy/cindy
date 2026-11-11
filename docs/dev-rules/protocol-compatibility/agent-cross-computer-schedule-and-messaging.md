# Agent 跨电脑管理定时任务与发消息

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`../product-rules/agent-user-parity.md`](../../product-rules/agent-user-parity.md)。

**定时任务不新增 wire。** `cindy_scheduler` 的 `schedule_list` / `get` / `list_runs` 新增 `device`
（`local` 默认、`all`、设备 ID），`schedule_update` / `pause` / `resume` / `delete` / `run_now` 新增
`device`（`local` 默认或设备 ID）。非本机请求走用户远程控制定时任务时已有的
`maker:schedule:*` channel，参数形状不变，被控端仍由原 IPC 入口校验并执行。`schedule_list` 的
`query` 文本筛选在发起端对返回结果做，不改请求。`device` 缺省时返回形状与原来一致，三个读取工具
都只多出 `scope: "local"`。跨电脑读取按电脑分组，离线、未开启远程控制、撤权、超时、不支持的电脑逐台
列出，`partial` 表示覆盖不全。`schedule_update` 跨电脑时拒绝 `bindToCurrentSession`；除
`intervalMs` 与下文模型选择字段外，其它字段的 `null` 清空仍明确报 `INVALID_PARAMS`，
不写出与意图不符的任务。其它电脑返回的定时任务与运行记录里，`targetSessionId` / `sessionId` 加上 `deviceId::` 前缀（与历史
查询同一约定），跨电脑 `schedule_update` 收到同一台电脑前缀的 `targetSessionId` 先去掉再发送，指向
别的电脑的拒绝。被控端对 `preRunHook` 是整对象替换：跨电脑改它必须
显式带 `timeoutMs`（数值，或 `null` 表示不限时，后者发送为不带 `timeoutMs` 的整对象），否则报 `INVALID_PARAMS`（省略会清成不限时，发起端先读后写又会覆盖并发修改）。被控端不认识这些 channel（早于完整控制面的旧版本）时
返回 `CHANNEL_NOT_ALLOWED`，发起端报 `REMOTE_UNSUPPORTED`。

**发消息新增 `maker:session:handoff`。** `send_to_session` 的 `target_session_id` 传
`deviceId::sessionId` 时，发起端向目标电脑发一次请求
`{ sessionId, message, sender: { sessionId, title? } }`；目标电脑用本机 `send_to_session` 的同一条
通路投递到既有任务（恢复、繁忙排队、落库一致），返回
`{ ok, agentKind, wakeKind, targetTitle, targetLastUserSendAt }` 或 `{ ok: false, errorCode, message }`。
约束：只投递到既有任务，不新建；目标 id 带设备前缀时拒绝，不向第三台电脑转发；恢复不在运行的
任务时按它落库的权限档启动；来源任务 id 由被控端加上服务端认证的控制端设备 id 前缀，发送方自带
前缀被拒绝；隐藏的伙伴任务沿用远程可见性检查，返回 `NOT_FOUND`，可见性查询未就绪时 handler
直接拒绝。仅同账号已建链设备可用（含手机等同账号控制端，它们本来就能用 `maker:send`），不进
unlinked / shared-task 白名单，共享任务对端被 handler 再次拒绝。

**新旧版本。** 旧被控端没有 `maker:session:handoff`，返回 `CHANNEL_NOT_ALLOWED`；发起端报
`REMOTE_UNSUPPORTED` 并说明消息没有发出，不退回成 `maker:send` 或 `maker:input:enqueue`
（那两条通路会把消息标成用户在另一台电脑上输入）。旧发起端不会发这个 channel，行为不变。
allowlist 指纹随新增 channel 变化，两端版本不一致时沿用既有提示。不改服务端与数据库 schema。

**失败与重试。** 两类请求都经 `remoteInvoke` 发出，建链与连接恢复沿用它的既有策略：与目标电脑
没有链路时会先建链（与历史查询相同，`device="all"` 会与每台在线电脑建链），发送前的
`LINK_NOT_OPEN` 重开后重发一次，其余不重放；工具层不另加重试或缓存。`maker:session:handoff`
的隧道超时为 65s：被控端要等目标任务的发送锁并在需要时恢复 Agent 后才回执，默认 30s 会把已送达
的慢恢复报成结果未知。请求已发出但没有可信回执时，发消息报 `DELIVERY_UNKNOWN`，定时任务写操作报 `REMOTE_TIMEOUT`
或 `REMOTE_RESULT_UNKNOWN` 并说明可能已生效，由 Agent 先查询再决定。「没有可信回执」包括：
超时、在途断连、本机账号在回执前切换、目标电脑报内部错误或 Agent 未就绪、定时任务写操作
收到写入前拒绝（参数错误、不存在、scheduler 未就绪）以外的任何 IPC 错误，以及被控端 dispatch 在
handler 完成后复核可见性与账号失败（`[NOT_FOUND] Session does not exist`，定时任务 handler
自己的不存在是 `Schedule not found`，据文案区分；发消息的目标不存在由 handler 以数据返回，
隧道层 `NOT_FOUND` 一律按结果未知）。能证明没有进入目标任务的错误（离线、未开启、链路未建立、对方不支持、目标不存在或已归档）
才报「没有发出」。发消息的账号 owner 检查用同一份记录覆盖整次调用：读来源任务标题前记录，
发送前与收到回执后各核对一次；回执到达时账号已切换的按结果未知处理，不返回其中的任务信息。
发消息没有幂等键，结果未知后的重发可能重复，工具说明要求先读聊天记录确认。
定时任务仍用默认 30s，与被控端等待 scheduler 就绪的 30s 相同，对方刚启动时可能超时。

按故障半径三问：触发条件是单个请求失败；本改动不新增恢复动作，不重建 link、不断开 relay；
多台电脑的读取每批最多 3 台并发，一台失败不影响其它组。已知外溢：这些请求的 `INVOKE_TIMEOUT`
与用户远程控制同一台电脑的请求共用设备级熔断计数，连续超时会让那台电脑被判为暂无响应
（既有行为，未改动）。「两台控制端共享同一被控端」的回归未新增，沿用 `remoteInvoke` 既有覆盖。

**审批。** `cindy_scheduler` 与 `cindy_helper` 是整体静默的可信 server；跨电脑写操作
（`schedule_update` / `pause` / `resume` / `delete` / `run_now` 带非本机 `device`，以及
`send_to_session` 的 `deviceId::sessionId` 目标，以及 `archive_sessions` / `unarchive_sessions`
含非本机设备前缀的 ID）在 `mcp-tool-approval-policy.ts` 里按内层动作
判为逐次审批，交给任务权限档；本机调用与跨电脑读取仍静默。

手机与 IM 通过所在电脑的 Agent 使用这些能力，无新增界面。实现与回归见
`packages/lizi-mcps/src/scheduler/_devices.ts`、`mcp-integrations/schedulerDevices.ts`、
`mcp-integrations/sessionHandoffRemote.ts`、`maker-ipc/sessionHandoffIpc.ts` 及各自的测试。

## Agent 跨电脑归档与取消归档

`archive_sessions` / `unarchive_sessions` 原位接受 `deviceId::sessionId`。本机批次仍调用
`setSessionsStatusInDb`，保持原子性；`local::sessionId` 是本机别名，先规范化再检查重复和当前任务保护，
不允许嵌套设备前缀。远程复用已有 `local-db:sessions:patch-meta(id, { status })`
与目标电脑的 `patchSessionMetaInDb` 生命周期服务，状态仅为 `archived` / `active`。没有新 channel、
allowlist、数据库 migration 或第三台电脑转发。复合 ID 不交给本机服务，无本机回退。

最小批次合同：一次只能指定同一台电脑，混合本机/远程或多设备批次写入前返回 `INVALID_ARGS`。
远程按输入顺序执行，首次失败停止，无回滚、无自动重放。失败 `data` 中 `changed` 为已确认完成项，
`failed_session_id` 为失败或结果未知项，`remaining_session_ids` 为未执行项；各 ID 保留设备前缀。
`partial` 表示已有确认完成项或失败项结果未知，不能把整个远程批次当作事务。

沿用同账号远控、双方允许控制、owner 检查与目标可见性。跨电脑写入进入当前任务权限档，
本机操作保持原样。离线、禁用、撤权、不支持分别明确返回；旧宿主拒绝 `patch-meta` 时返回
`REMOTE_UNSUPPORTED`。已支持这个 channel 和生命周期保护的旧宿主无需新增协议即可执行。
目标服务的不存在与已删除/专属生命周期限制返回 `NOT_FOUND` / `PRECONDITION_FAILED`；
隧道在处理后复核账号/可见性的 NOT_FOUND、超时、在途断连、错误回执与内部错误均按
`REMOTE_RESULT_UNKNOWN`，说明该项可能已生效，调用方先查状态再决定是否重试。
本机发送前的 `BACKPRESSURE` 返回 `REMOTE_UNAVAILABLE`；目标返回的 `BACKPRESSURE` 或
无法确认为写入前拒绝的 `PRECONDITION_FAILED` 也返回 `REMOTE_RESULT_UNKNOWN`，因为写入后的
回执查询可能失败（后者可能由 worktree mutation 包装查询错误）。即使 `changed` 为空也标记 `partial: true`。
同一账号快照覆盖整个远程批次，切账号后停止并不返回旧账号的标题/目录。

取消归档不发送旧消息、不启动任务执行、不恢复暂停自动化。成功后另调既有 `send_to_session`
继续投递；该通道仍按目标当前状态与已保存权限执行。手机/IM 经执行电脑的 Agent 使用同一工具，
没有新增 UI；SSH 工作目录任务仍由其所属 Desktop 管理状态，不将 SSH 主机视为 device-link 设备。
不改变共享连接的重试、超时或恢复策略。回归见 `archiveSessionsTool.test.ts`、
`sessionStatusRemote.test.ts`、`sessionsUpdate.test.ts` 和 `mcpToolApprovalPolicy.test.ts`。
