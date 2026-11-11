# 协同远端 Worker：Worker 在另一台电脑运行

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:input:get-projection` 的既有输入投影可选增加 `turnInProgress`，由输入协调器按
当前派发、运行、交互及终态持久化边界生成；它不表示 vendor 的 `isTurnRunning`。
Lead 的自动回报同时识别既有 `autoResumePending`、`usageLimitWait` 和隐藏续跑队列，
读取历史后再次核对投影，恢复期间保留原派活身份，不推进回报去重游标。旧查看端忽略新字段；
新 Lead 连接旧运行端时仍使用既有恢复字段，完整的进行中边界核对需要运行端同时更新。
只调整单个 Worker 的回报收尾，不改变通道、权限、relay、服务端或 Mobile 原生配置。

主动回报可选追加 `maker:orca:remote-worker:bridge`，仅同账号 allowlist；不进入共享任务、
供应商分享清单。运行设备从本机持久来源标记选定 Lead 电脑，传真实任务 ID、Lead ID、
四个既有 Worker 工具名之一与其原参数。Lead 从 server 盖章的来源设备 ID 反查 active team
内的 Worker，核对真实任务和 `worker_id`，再调用与本机 MCP 相同的 handler／schema；
请求不能自报本机 role 或指定任意目标。根 Agent 回报限制在运行设备转发前执行。
桥接请求可选增加 `reportedInputClientIds`（最多 64 个安全 ID），由运行宿主在工具调用入口
同步捕获本轮已消费输入，不接受模型参数指定。Lead 仅结清相交的等待输入；仍在排队的新
输入保持持久等待记录和运行状态。旧端缺少此字段时不清除等待记录，保留自动回报兜底；
新字段不改变四个 MCP 工具 schema，也不改变本机 Worker 的回报路径。
`caps` 可选增加 `workerBridge: true`，协议版本仍为 1，既有 open/release 载荷不变；
桥接沿既有同账号远控授权，Lead 电脑未开放反向远控时也保留自动回报，不扩大授权。
旧端忽略可选字段或返回 `CHANNEL_NOT_ALLOWED`，保留原有完成后自动回报，不降级为通用 handoff，
不自动重试结果不明的写操作。完整主动往返需要 Lead 与运行设备均更新，服务端无需变化。
`get_current_session_id` 和 `list_sessions` 可选投影既有远端来源标记；普通任务不增加空字段。
桌面及手机的控制端继续通过任务所属电脑使用协同，不新增 UI、push 或 Mobile 原生输入。
故障动作只影响当前 Worker 的一次桥接请求，不重启 peer 或共享 relay；另一设备的自动回报
继续由既有运行时处理。权限隔离、旧端、账号切换与真实 handler 往返见
`apps/desktop/src/main/maker-ipc/__tests__/orcaRemoteWorkerBridge.test.ts`。

Orca 原地 Agent 切换补充边界：执行设备任务按既有 `orca_remote_lead` 判定，
与 `orca_role` 一样拒绝用户换 Agent 位置，不新增 wire 字段或版本要求。
Mobile 对已在另一台电脑运行的 Orca Agent，按所展示的模型目录所在电脑查询
`maker:get-capabilities`；登记切换仍发给任务所在电脑。旧端保持原能力校验，
不会因目标电脑未注册该 Harness 而回退到别的电脑执行。

Desktop 本机 `maker:switch-session-agent` 的可选第 7 参增加
`confirmedContextWindow`（正整数），仅供同 Agent 选模保留已核对的窗口。
Renderer 与本机 Host 同包升级；不向 device-link 发送该字段，Host 对远程传入
显式拒绝，沿用 SET_MODEL 的本机确认边界。无此字段仍可登记选择，但 Orca
发送时若需要未确认的窗口重建，会保留意图并拒绝发送，用户可重新选择后确认。

与[「远程 Agent」](remote-agent.md)方向相反：协同的 Lead 与团队留在 A，单个 Worker 的任务、目录、命令与文件都在 B(运行设备)。
B 上的 Worker 是一条普通任务，`sessions.orca_remote_lead`(migration 0124，JSON 见
`apps/desktop/src/shared/orcaRemoteWorker.ts`)记录派活电脑与 Lead；派活、停止与回报复用现有会话通道。
方案与产品决策见 [`../orca-cross-device-worker-plan.md`](../../orca-cross-device-worker-plan.md)。

- **新增 channel**(`packages/device-link/src/orcaRemoteWorker.ts`，只进同账号 allowlist，不进共享任务清单)：
  `maker:orca:remote-worker:caps`(能力探测，回 `{ version, agentDevice? }`)、`…:models`(查询工作电脑的模型与 Agent 位置)、`…:open`(按 A 给定的任务 id 新建 Worker 任务，
  幂等；超时 60s)、`…:release`(结束协同，任务与文件保留，幂等)。B 侧实现见
  `apps/desktop/src/main/maker-ipc/orcaRemoteWorkerHost.ts`。
- **幂等 open 的终态检查**：同来源、同 Lead 且未 release 的已有任务也必须仍为 `active`；
  已归档／软删除时拒绝并返回既有 `PRECONDITION_FAILED`，不新建、不复活。A 保留未确认创建
  收据，恢复仅解除未关联标记。该检查使用 B 的现有 status 列，不新增 wire 字段或改变版本；
  旧 B 仍保留原行为，B 更新后生效。
- **实际档位**：`open` 回包可选 `effort` 是 B 已保存的解析结果，同 ID 重试也从已有任务读取。
  空字符串保留无档位状态；旧 B 不返回该字段时，A 保留原来的请求值降级规则。字段增量不改协议版本，
  旧 A 忽略它，新 A 不向旧 B 要求新增请求字段。
- **实际 Fast 状态**：`open` 回包可选 `fastMode` 是 B 已保存的布尔值，新建和同 ID 重试均取真实任务，
  A 的代理任务和创建结果沿用它，显式 `false` 不被请求中的 `true` 覆盖。旧 B 缺省时，A 保留请求值的
  降级规则；旧 A 忽略新增字段，版本与请求不变。完整状态一致性需要 A/B 均更新，服务端无需改动。
  此字段不改变 B 的模型准入：当前显式开启不支持的 Fast 仍在创建前拒绝，不新增静默降级。
- **来源身份**：派活电脑取 server 盖章的 `src`(`DeviceLinkInvokeContext.controllerDeviceId`)，不采信载荷自报；
  非 device-link 调用与共享任务访客一律拒绝。`open` 指定的 `workingDir` 与 `maker:create-session` 同口径经
  B 的目录守卫(`device-link/dispatch.ts` 的 `PATH_GUARDED_CHANNELS`)；不指定则由 B 分配任务目录。
- **旧端降级**：旧版 B 没有这三个 channel，回 `CHANNEL_NOT_ALLOWED`；A 据此把该电脑显示为「需要更新」，
  **不回退**到普通 `maker:create-session`(普通任务没有防嵌套与来源标记)。B 新、A 旧时 B 不受影响。
- **可选运行设备**：`maker:orca:execution-devices`(只读)由 A 本机界面与控制端共用，返回
  `{ devices: [{ deviceId, name, platform, supported }] }`；逐台探测 caps，旧版标 `supported:false`，
  探测失败的不列出。共享任务访客拒绝。
  Mobile 使用同一只读通道获取 A 视角的设备，模型与 Agent 从所选运行设备读取。
  新手机连接旧 A 收到 `CHANNEL_NOT_ALLOWED` 时隐藏设备选择，原来的 A 本机 Worker 创建不变。
  首个与追加 Worker 都沿用既有可选 `executionDeviceId` / `workingDir` 字段；「对话」不传目录，
  「指定目录」传 B 上的绝对路径，由 B 校验；失败不回退 A。
- **A 驱动 B 的其余通道**全部是已有同账号 channel：`maker:input:enqueue`(按 `clientId` 幂等，
  `durableDelivery`)、`maker:input:get-projection`(投递回执)、`maker:list-active`、`local-db:sessions:get`、
  `local-db:history:messages`、`maker:abort-session`；B 不需要知道「这是协同派活」，只认来源标签。
- **恢复暂停**：B 的 `INPUT_ENQUEUE` 按已有自动消息来源判据处理 `origin.kind`，Orca 派活不解除
  崩溃恢复后的队列暂停；普通手机／桌面用户输入仍可解除恢复暂停，用户 Stop 暂停不受影响。
  不新增 wire 字段或改变版本，A 的既有派活载荷不变；旧 B 保持其原有行为，需更新 B 才有此修复。
- **收尾限制**：当前 abort/release 不取消未消费的远端派活，结束协同后队列仍可能继续执行。
  远控入队后的来源不足以可靠区分 Lead 派活与用户输入，本轮不通过清空队列规避；待专门设计
  持久投递归属、取消回执与释放边界后修复，详见 `orca-team-architecture.md` 的已知限制。
- **B 侧约束**：带标记的任务不能再开启协同(`assertLeadCollabProjectEnabled` 统一拒绝 Worker 与远端 Worker，
  覆盖 IPC、远程与 Agent 工具入口)，不能复制到其他电脑(`task-migration/service.ts`)；侧栏照常显示，
  任务头标注「来自 X 的协同」，结束后显示「协同已结束」。
