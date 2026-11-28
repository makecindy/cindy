# 远程连接与手机版适配

> **读取时机**：新增或修改涉及 workdir 文件、agent 进程、会话数据的功能，新增 IPC channel／推送事件，
> 或修改 device-link 的重试／超时／断链恢复逻辑之前；功能不在下列路径内时同样适用
> **适用路径**：`packages/{device-link,remote-file-service,maker-remote-ssh}/**`、
> `apps/desktop/src/main/device-link/**`、`apps/mobile/src/device-link/**`、
> `apps/desktop/src/main/{remote-agent,remote-ssh}/**`、`apps/desktop/src/main/remote-desktop*/**`、
> `apps/mobile/src/remote-desktop/**`、`apps/desktop/src/preload/preload.ts`

## 被移除的设备：开着时关掉 Agent-Net，打开时先重新加入（2026-11-26）

被删后重新登录的手机 Device Link 照常，但不在账号设备列表里，同账号电脑在 Agent-Net 上都拦它；它打开 Agent-Net 后把这些电脑
当成在线、请求发出去等不到回应，一台都连不上、干等十几秒。现在手机与电脑打开 Agent-Net 连接时，若成功读到的设备列表里没有
本机，或官方服务回 `DEVICE_REVOKED`，就不打开这条连接、这次按「被拒」走 Device Link，并把开关关掉、写明重新打开即可重新加入；
打开开关时同样判断，是就先按「重新加入」接回来。约定与回归见
[设备移除协议记录](protocol-compatibility/agent-net-device-removal.md)。

故障半径三问：① 证据是官方服务对本机身份的明确回答（`DEVICE_REVOKED`）或一次成功读到、里面没有本机的账号设备列表，只说明
本机被移除；读不到、超时、断网都不算，不涉及其它设备或连接；② 只关本机的 Agent-Net 开关并让本机主连接改走 Device Link（与人关掉
开关同一条路），别的账号分享来的连接、其它对端不动；重新加入只在本机的人打开开关时发一轮请求，不重试、不轮询，远程切换不触发；
「仅使用加密连接」时不关，不会因此改走未加密连接；③ 手机 `agentNetRuntime.test.ts`「turns Agent-Net off as removed …」按列表里没有
自己／身份被撤销／列表读不到／在列表里／仅加密五格驱动真实 `openMobileAgentNetSocket`，电脑 `agentNetRuntime.test.ts`「reports a
removal …」与 `selfHostedRelayRuntime.test.ts`「turns Agent-Net off with the removed note …」驱动真实主连接工厂与设置 IPC，修复前前两格
照样打开连接、开关不变。

## 建连限流的服务端重试期限（2026-11-26，#13041）

分享传输建连（`agentNetSharing.ts` 的 scoped 连接工厂申请租约）收到 429 时，`AgentNetSharingError`
已把有效 `Retry-After` 解析为 `retryAt`，但 `DeviceLinkClient` 工厂失败后只走普通退避（1 秒起、30 秒封顶），
期限内照样反复请求被限流的接口。现在工厂抛出的错误带 `retryAt`（Unix 毫秒）时，client 记下期限：
退避等满期限再追加本档抖动；期限前的网络变化／前台恢复（含 `overrideCongestionCooldown`）、唤醒重建与
stop/start 都在 `connect()` 入口统一推迟，不调用工厂，并同样交给 `scheduleReconnect` 排期、期限后追加本档抖动，
同一期限的各端不会在期限那一刻齐步回来。期限按 `SERVER_RETRY_MAX_WAIT_MS`（10 分钟）封顶，防止异常的远期日期
把连接永久挂起；收到时换算成墙钟与单调钟两个到期时刻，任一到点即解除，系统睡眠不会多等，系统时间回拨也不能把
等待拉长到收到时的期限之外。没有 `retryAt` 的失败（含现场那次空 `retryAt` 的 429）保持原退避不变。

故障半径三问：① 证据是这一条连接的工厂被服务端明确限流并给出期限，不涉及其它连接或对端；② 只推迟这一个
`DeviceLinkClient` 的建连，主连接、其它 scoped 连接、已建立的会话与可靠层状态都不动，不新增重试或重放；期限只在
没有 socket 时产生，推迟不会丢弃在线连接；③ `client.test.ts`「does not call the socket factory before a server
retry deadline」按无期限／60 秒／超过上限／60 秒后系统时间回拨一小时四格驱动真实 client，期限内触发
connectNow、restartConnection 与 stop/start 均不建连，期限刚过仍先等抖动，回拨后按收到时的期限建连；修复前
三格有期限的用例失败。只改客户端，不改 wire、中继或服务端契约。

## 可靠窗口防积压：列表读单飞、增量基准保留与过期只读回包退役（2026-11-25）

慢网或对端暂停确认时，单条对端的 64 帧可靠发送窗口不再被高频自动化推送与重复大列表回包联手堵死：

- **控制端列表读单飞与每位调用者剩余预算续读**：`DeviceLinkClient` 与 `AgentNetSessionLinks` 共用
  `RemoteListingReadCoalescer`（`packages/device-link/src/listingReadCoalescer.ts`），对同连接代次、
  同对端、规范化参数相同的 `local-db:sessions:list` 与 `maker:schedule:list-sidebar-index-runs`
  合并单飞；在途期间涌入的多笔 `fresh: true` 刷新折叠为最多一笔紧随其后的串行读取（直接复用前序读取刚落库的
  `ifNoneMatch` 标签换 `notModified` 或小增量）。每位调用者始终持有自身 `callDeadlineAt = enqueuedAt + timeoutMs`：
  若前序较短预算读取先超时，仍有剩余预算的同乘调用者按精确剩余时长（`callDeadlineAt - now`，无加入时差启发式、
  无延长调用期限的下限）自动续读；不同 `limit`、`status`、`includePinned`、跨账号 scoped 对端与各调用方的
  `preSend`／`beforeDispatch` 严格隔离。排队期间无法共享已有准入期限的调用方独立排队；备用会话可用与无备用会话的调用分槽隔离，底层传输在零分片写出前让路（`DeviceLinkUnsentInvokeError`，`inFlight=false`）时按每位调用者克隆保留该类型以切到备用 Agent-Net 会话，无备用会话的发送前拥塞与已写出（`inFlight=true`）失败则保留原 `DeviceLinkError` 与错误实例隔离、不重放已发请求。Agent-Net 的共享预算调用者由会话层按正文流
  进展决定超时；需要更早截止的调用者单独结算。合并层放弃最后一位调用者时，通过会话层已有的取消帧停止底层请求。
- **弱网滞后期的列表增量基准保留**：`InvokeDeltaBases` 按 `(src, requestKey)` 同时保留控制端已确认持有的
  基准（`confirmed`）与最新发出的快照（`latest`），且 `local-db:sessions:list` 的缓存键与基准键忽略布尔型
  `fresh` 标记（保留 `tagCatalog` 等改变 wire 形状的标志），避免中间回包仍在慢队列排队时后续读取退回连续发送
  200+ KiB 全量快照。
- **已放弃或协商到期只读大回包原位退役**：控制端因超时或 `PEER_RESET` 放弃幂等只读请求后，随下一笔同对端请求捎带
  `transfer.retired`（最多 8 个请求 ID）；双方均声明 `read-deadline-v1` 且本次调用超时预算在 wire 可表示范围内
  （`1..3_600_000ms`）时，控制端在可靠请求帧元数据上附带真实剩余等待期限（`ReliableTransportMeta.deadlineMs`；超出 wire
  上限的超长自定义调用自动省略 `deadlineMs`，仅凭明确 `transfer.retired` 退役）。被控端在收到携带 `meta.deadlineMs`
  的帧（单帧或分片第 0 片）时按**该帧自身到达本机的单调时刻**立即折算为单调不减的绝对截止上界（重复重传第 0 片或后片先到、
  第 0 片后到的乱序重组绝不叠加到更早分片的接收时刻），且**仅**在请求被 `transfer.retired` 明确放弃或超过该可信协商上界时
  退役只读回包——旧控制端、未携带 `deadlineMs` 的请求与一切写操作永不按默认猜测上限提前退役。
  明确 `transfer.retired` 的请求在入队前直接跳过编码并清理同对端 `remoteInvokeResultOutbox` 中的对应只读条目；已在可靠队列
  `peer.pending` 中积压的只读大回包在命中 `transfer.retired` 或超过协商 `deadlineMs` 时原位替换为同 `seq` 的 `transport-skip`
  占位，释放数百 KiB 缓冲而不制造可靠序号空洞；写操作与其它对端条目永不退役。
- **调度事件拥塞期有界保序、权威状态补读与停滞退避**：远程端不消费的 `silenced`／`notified` 提醒事件归入 `LatestStatePushStage`
  按 `scheduleId` 覆盖；驱动刷新的 `maker:schedule:event` 在对端窗口健康（`< SESSION_ACTIVITY_WINDOW_SOFT_CAP`）
  时保持 0ms 直发，越过软上限时进入有界的 `ScheduleEventPushStage`（上限 64 条／16 KiB）：未超限时按到达因果顺序折叠投影等价
  中间运行态，超限时绝不静默删终态，而是以 `O(1)` 汇总折叠为 `{ type: 'resync' }` 权威全量补读事件 + 最新会话绑定／已读槽位，
  让控制端重拉权威调度列表、运行索引和未读汇总。新版手机首页收到 `resync` 时直接请求补齐会话列表，
  旧版首页仍可借保留的会话绑定或后续全量同步补齐。两个暂存队列（`ScheduleEventPushStage` 与 `LatestStatePushStage`）的
  可写唤醒（`nudge()`）只提前、绝不延后已排期的 drain，避免持续 ACK 令已可写队列饥饿；`routeSessionPeers` 合并转发
  `DeviceLinkClient` 与 `AgentNetSessionLinks` 的 `onPeerSendProgress`：对确定性 ACK 通知的 Device Link 对端在无进展达上限后
  0 定时器挂起，对队列深度来自 `bufferedAmount`（静默排空未必触发 `onDrain`）的 Agent-Net 会话对端保留 5s 低频兜底并在清空后停表，
  保证最后一项必达且退订 `sessions` 或断链离线时同步清空。

故障半径三问：① 证据是单个控制端对端的可靠窗口积压或单笔幂等只读请求已明确超时，不代表共享中转连接或其它对端失效；
② 仅折叠该拥塞对端尚未发出的调度推送（超限转权威全量补读）、合并同参数列表读并将该对端明确已放弃或协商期限已到的只读回包
原位换成同 `seq` 的 `transport-skip`，不重置共享连接、不跳过可靠流序号、不提前退役旧端或超长自定义超时请求、不丢弃或重放任何
写操作结果；③ 健康的其它控制端仍保持 0ms 即时推送与独立缓冲，不同过滤参数、跨账号分享对端与写请求互不影响。

自建中转兼容：全部改动复用既有 `invoke`／`invoke-result`／`push` 信封与 `transport-skip` 占位帧；`transfer.retired`
与能力门控的 `read-deadline-v1`（`meta.deadlineMs`）均位于端到端载荷内，新旧控制端与被控端混合连接时自动降级互通，
`packages/device-link-relay` 透传无感知，已部署自建中转无需修改或升级。

## 桌面后台只读通道的缺失回执

桌面控制端按窗口、对端和通道记住只读接口的明确缺失，不记业务结果，不用版本号猜能力。
资源列表、历史查询、调度列表及侧栏运行索引在正常桌面上必须注册；调度服务未就绪要等已有
readiness，不能因为尚未过启动画面而向控制端报“没有 handler”。只认解开 Electron 包装后
与本次通道完全匹配的 `[NOT_FOUND] no local IPC handler for channel '<channel>'`（仅限线性注册通道），
以及对端 `REMOTE_INVOKE_ALLOWLIST` 明确拒绝本次通道的 `[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel '<channel>' not allowed remotely`。
对象不存在、本机加密／信任传输策略拦截、非 owner 或共享任务作用域拒绝、Host 模式不支持、权限拒绝、背压及超时均原样返回，下次读取仍发送。
延迟在启动画面后注册的插件引擎列表与 `maker:model-context-limit:get` 不记缺 handler，以便同一连接在启动完成后读取。对端重连、版本或已协商能力变化后可再次探测，
不增加定时器、不重开其它设备连接。旧端无需升级；手机版不走 Electron 后台刷新入口。
回归：Desktop preload 的 `remoteReadBridge.test.ts`、renderer 的 `useCodexContextWindow.test.tsx` 与 `remoteModelGroups.test.tsx`。

## 远程模型目录统一读取口径（2026-11-23）

同一台电脑、同一份分享的模型目录在各入口给出一致结论，不再因各自的缓存与等待时长而一处有、一处无：

- **一次读取供所有读者**：Main 的目录读取器（`packages/device-link/src/metadataContinuity.ts`）对
  `maker:provider:list`、`maker:get-capabilities`、`maker:list-available-agents` 设 15 秒新鲜窗口
  （`REMOTE_CATALOG_FRESH_MS`）：窗口内选择器、机器人、Orca、名单轮询等读者共用上一次实际读取，不再各自
  发起。来源推送的变化通知与权限变化改变缓存键，立即失效；实时读取（发送前探测、执行）不经过它；
  `maker:agent:status` 与供应商组视图保持实时。供应商组目录自带 15 秒缓存，且撤下路由需要对方当下的答复，
  它的读取以 `ownFreshness` 跳过共享窗口（仍有既有的有界回退）。
- **嵌套读取期限分层**：远控任务经任务电脑代读来源时，代读最多 20 秒，短于控制端默认 30 秒；来源的临时失败
  保持临时错误码（见协议记录 `remote-agent.md`），控制端保留有界显示并可重试。
- **分享在线状态一条规则**：`providerSharePickerState`（`packages/device-link/src/providerShareCatalog.ts`）
  供 Desktop 选择器、收藏与 Mobile 选择器共用。分享者电脑暂时离线时照常列出并标「暂时离线」，不随在线状态
  来回出现、消失；已暂停的分享仍只在任务正用着时保留。
- **信任期到期后补读**：Desktop 供应商目录与 Agent 能力的有界快照到期时，若仍有界面在用，补读一次（同一来源
  5 秒内最多一次），与 Mobile 一致；能力读取遇临时失败保留上一份有界快照，与供应商目录一致。
- **临时失败不报红**：任务电脑的目录或能力读取遇到临时失败（超时、断链、繁忙、无响应）时，只要上一份有界快照
  还在界面上，模型药丸与选择器不再显示「读取失败」红色提示（此前一次抖动就亮红，要打开选择器重读才消失）。
  快照到期、拒绝、不支持等非临时错误照常提示。同一判断（`renderer/lib/temporaryCatalogFailure.ts`）也用于：
  选择器左侧其他电脑的条目（刷新期间与临时失败时保留，不再整段消失、收藏不再变灰），以及远控任务里被控电脑上
  的分享名单（临时失败保留上一次确认的名单；断链、在线状态与控制开关变化仍立即清空）。恢复仍按既有设计在回到
  前台、连接恢复或来源推送变化时重读，不增加定时重试（避免多窗口放大请求与后台轮询）。
- **手机恢复重试有界**：目录读取失败后的后台恢复最多 8 轮（约 2 分钟退避），之后等回到前台、打开选择器、
  重连或目录变化再读，不在电脑长期离线时每 30 秒一直读下去。
- **手机来源页保留分享行**：分享者电脑离线、或刚上线还在连接供应商时，分享来的供应商读成未连接、没有模型。
  Mobile 来源页仍在原位置列出这条分享（`RemoteAgentCatalog.shareSource`），离线时打开后显示「对方电脑不在线」
  说明，与 Desktop 选择器保留分享条目一致。
- **清单变化推送不清空显示**：分享者上线/离线时被控电脑推一次分享清单变化。Mobile 仍立即作废缓存并重读，但屏幕
  上已有的分享行留到这次重读有结果（最多 12 秒，`SHARE_CHANGE_DISPLAY_HOLD_MS`）；重读失败或超时退回作废后的
  状态，不留无界旧清单。此前这一来回（Android 实测约 2 秒）会让分享消失再出现。

故障半径三问：① 证据是单个来源目录读取的慢、超时或在线状态变化，只影响这一来源的显示新鲜度，不等于链路或账号
失效；② 只复用、补读或保留这一来源的目录快照，不重建链路、不重放创建或发送，不延长任何信任期（补读拿到的仍是
主机转发的剩余预算）；③ 其他电脑、其他分享与同一电脑的其他目录各自按自己的缓存键与预算处理，互不失效。
不改 wire 形状、channel 或字段，旧端行为不变，自建中转无需修改。

实现与回归：`metadataContinuity.ts`、`providerMetadataContinuity.ts`、`controlledModelCatalog.ts`、
`useDeviceProviders.ts`、`useAgentCapabilities.ts`、`useProviderShareAgentDevices.ts`、`providerShareFavorites.ts`，
Mobile `remoteAgentCatalogs.ts`、`useRemoteAgentCatalogs.ts`、`UnifiedModelPickerSheet.tsx`、`useDeviceProviders.ts`；
`metadataContinuity.test.ts`、`providerMetadataContinuity.test.ts`（「shared catalog fresh window」）、
`controlledModelCatalog.test.ts`，Mobile `remoteAgentCatalogs.test.ts`、`remoteAgentCatalogsProviderShare.test.tsx`、
`unifiedMobilePicker.test.tsx`。

## 手机 Agent-Net 冷启动并行与前台直连快恢复（2026-11-22）

手机 `openMobileAgentNetSocket` 在官方网络下将 `/api/device-link/devices` 准入列表预取（3 秒上限）
与本机 IP 读取提前到与 Keystore 身份准备并行启动，仍在 `AgentNetSocket.openWithBindings` 接收或
拨出任何连接前收口 `peerRule`，不放宽已移除设备的拒绝边界。后台挂起再回前台时，仅在本进程内存保留
上一条已通过加密握手验证的对端 UDP 直连地址；当本机局域网 IP 未变且存在缓存目录时，先以
`deferRelay: true` 和 350 毫秒短预算直拨该候选，中转 WebSocket 与中转 UDP 注册在后台并行完成。
私网记忆地址不落盘，物理切网（`routeChanged`）、本机 IP 变化、退出账号、切换自建中转或修改偏好时立即清空。

`AgentNetSocket` 在对端首拨或初始 `openingRelay` 尚未结算前，不再提前投递 `presence-changed { online: false }`
污染 `peerOfflineGate`；确认目录离线或首拨失败后才发出离线事件。`canConnectSession` 供手机会话层识别
正在首拨／等待初始中转握手的 V2 对端，既有 `supports()` 语义保持不变。`PortableUplink` 对齐桌面端发送队列：
仅在运行时提供数值型 `ws.bufferedAmount` 时启用排空监测（React Native 自带 `WebSocket` 该字段为 `undefined`，按 `0` 处理避免误拦截发包），
持续 1 秒未排空时丢弃新中转封装包，持续 45 秒未排空且无入站排空时主动关闭半开连接交由 `AgentNetSocket` 重连，
不向旧版中转发送非 `presence` 文本心跳帧（旧中转会以 `1008 invalid control` 断开）。手机初始中转握手失败且未开「仅使用加密连接」时，
通过一次 `/directory` 校验是否属 401/403 身份撤销（`mobileAgentNetIdentityRefused`），被拒时关闭缓存虚活连接回退到 Device Link，
纯网络离线（`status: 0`）仍保留缓存直连模式。

故障半径：① 失效记忆候选（对端重启换端口）或单条半开中转 WebSocket 属于单路径传输层陈旧状态，不等于账号或对端离线；
② 失效记忆候选仅在 350 毫秒后退役该对端候选并回退当前中转重拨，半开 WebSocket 仅替换中转上行连接，不关闭已建立的直连加密通道、不重放业务写操作；
③ 多对端拓扑下 `c-stale` 回退中转与 `e-fail` 首拨失败互不波及已直连的 `b-live`，未启用 Agent-Net、旧版 Device Link 与未升级自建中转行为完全不变。

实现与回归：`packages/agent-net/src/{portableSocket,portableClient,nativeTransport}.ts`、
`apps/mobile/src/device-link/agentNetRuntime.ts`，以及 `portableSocket.test.ts`、`portableClient.test.ts`、
`nativeTransport.test.ts`、`agentNetRuntime.test.ts`。

## 手机首次建链失败与中继累计确认滞后（2026-11-21）

Agent-Net 名册报告同账号设备在线时，负责先拨号的一端如果首次握手失败，复用该对端已有的退避重拨。
计时到期再检查在线与授权状态；收到新的在线名册时仍立即尝试连接。测试从首次失败和已连接后断开两种入口验证。
Device Link 的网络提示在防抖期间收到有效帧，就已取得该提示之后的中继可达证据，后台读取可以继续。
中继可靠流队头尚未确认时，后面的已发送推送最多提前重传一次；累计确认推进后，新的队头恢复正常重传。
积压只影响这一个目标流，业务结果仍按原期限和预算发送；不重置共享连接，不引入应用操作重放，不改 wire。

自建中转兼容：本次仅调整客户端拨号、发送侧重传调度与后台请求准入，沿用已有帧、累计确认、
设备签名和能力协商；`packages/device-link-relay` 的通用转发无需识别这些本地时序，
已部署中转可继续使用，无需服务端同步修改或版本升级。
2026-11-22 在本 PR 分支实测：共享客户端 `pnpm --filter @cindy/device-link test` 1347 项、
自建中转 `pnpm --filter @cindy/device-link-relay test` 61 项及
`pnpm --filter @cindy/device-link-relay run interop` 2 项均通过；
互通覆盖真实自建中转的加入、设备签名通信、自动重连与 SDK 版本矩阵。

## 远程 Agent 控制请求与发送取消（2026-11-18）

正文派发与连接准备分别判定：`proxyHandle.sendLike` 的普通 `send` 分支在 `link.ensure()`（能力握手、原生重开、
设置恢复）遇到既有 `isRetryableLinkError` 判定的链路失败时，当前输入尚未进入 `callWithId`，
即使该准备 RPC 带 `inFlight=true`，也返回
既有的未派发结果，保留 Session 供显式重试，不因它启动正文的未知尾部排空。已确认的启动错误
保留原错误对象，继续由原有 stopped-open offer 交接判定；没有 offer 不授予换机或重放权限。
正文调用发出后的超时仍保留原始错误和接受未知语义。能力读取沿用原来最多六次的有界重试，
没有新增重试、后台恢复器或正文重放。回归见 `connectionPool.test.ts` 的六次 caps 超时与
显式原线程重试，以及 `proxyHandleClose.test.ts` 的已发出正文超时。Goal 来源保留原始准备错误，
继续由既有 Goal 失败路径置为 blocked，避免被当成供应商拒绝后自动重试整轮握手；
`connectionPool.test.ts` 经真实 GoalController → Session → 远程 starter 验证六次超时后没有下一轮 caps。
非链路准备失败保持原错误合同：组配额的 `ProviderGroupUsageLimitError.limit.resetAtMs`、
授权拒绝、版本不兼容等交给原有处理者；不把这些业务拒绝吞成无结构的未派发结果。
同文件经真实重连 open 验证已知／未知配额重置时间仍保留类型和元数据，正文没有派发。

Device Link 的请求与执行诊断使用固定的远程 Agent 操作类别（如 `caps`、`open`、`call:send`），
未知操作／方法不记录原值，不解码载荷或采集正文、凭证。超时日志与 INFO 诊断共用短请求号，
分享目标先解析出物理设备引用再截短，避免统一显示成分享前缀。诊断不参与权限、重试或路由判定。
无 wire 变化，旧端及自建中转继续透明传输既有请求。

`maker:remote-agent:v1` 按请求内容区分优先级：发送、插话、停止、关闭以及内联交互／回调／错误回复
复用已有交互名额；上传、执行环境帧、HTTP 回复与长轮询仍走普通名额。不扩大并发、排队、字节或
超时上限。普通等待队列满时，空闲的交互名额仍可立即使用；接收端准入与结果 outbox 使用同一判据。
不解压或读取上传载荷来决定优先级；不认识的请求保持普通优先级，实际授权与校验仍由原处理器负责。
Agent-Net 会话入口同样按载荷做准入分类，并把这些请求放进控制通道，不能仅修改 Device Link 入口。
模型目录、Agent 能力、可用 Agent 与安装状态读取使用已有后台配额（活动 4、等待 96），避免预读
占满普通请求名额；两种传输使用同一判据。实际目录响应与权限检查不变，前台模型／上下文操作和
导航读取仍走原有普通名额，不因目录预读借用交互预留容量。

供应商组的显式 `view.display` 设置展示、`manage-share/quota-account` 和分享专用
`provider-share:insights:v1` 同样使用上述后台配额；实时选机视图、`pick`、租约与授权写入保持原优先级。
同一物理电脑的同账号、共享任务和供应商分享 peer 共用既有调度容量；任务仍按真实 run 生命周期计数，
RPC 准入不计模型任务席位。调度中保留完整 peer 身份，取消只移除该作用域的未派发请求，在途请求结算前不释放容量，
不跨分享合并结果或权限。传统 Device Link 和 Agent-Net 共用此判据，无 wire 或 relay 行为变化。
分享展示收到背压、无响应、断连和超时时分别保留对应错误，不将这些故障改报权限拒绝；明确拒绝仍按原授权边界处理。
回归见 `client.test.ts`、`invokeScheduler.test.ts` 与 `providerShareManagement.test.ts`。

远程发送在 Device Link 真正派发前复核任务生命周期、取消信号和 Stop 代次，取消后不迟到投递旧消息。
此检查使用本地 `beforeDispatch` 回调，两种传输均在出队后、创建请求前执行；同区和跨区分享都透传。
它不在回包后执行，已发送的输入保留真实结果，不能因随后取消而误报未发送。账号／授权的 `preSend`
和回包归属检查继续独立执行。以上回调不进入 wire payload。
发送锁的等待者可由原输入取消信号结束；它的占位仍等待前驱结算，避免后继越过尚未结束的持有者。
已取得锁的操作必须完成真实清理再释放，不用超时竞速放行仍在运行的写操作。原重启栅栏与 watchdog 保留。

故障半径：① 只处理当前目标的准入和当前输入取消；② 不重建共享连接、不新增写入重试或重放、不恢复
已结束任务；③ 同设备其它输入继续按原 FIFO／优先级与容量运行。未取得对方原始日志时，不能据截图
把任何一次 300 秒锁告警认定为这些缺陷。这里只证明可控复现，不代替现场事故归因。

实现与回归：`invokePolicy.ts`、`invokeScheduler.test.ts`、`client.test.ts`、Desktop
`deviceLinkDispatch.test.ts`、`runClientReply.test.ts`、`sendToSessionLock.test.ts` 与
`orcaModelSelectionIntent.test.ts`，以及 `agentNetSessionLinks.test.ts`、`remoteInvokeSendGuard.test.ts`、
`providerShareCrossRegion.test.ts`。沿用原业务载荷与 relay 帧，自建中转仅透传，无需升级服务端。
混合版本保持通信兼容；单端升级只改善该端调度，旧端继续原有准入行为。

## 远程慢请求的两端诊断（2026-11-18）

`maker:create-session` 在被控端要等 Agent 真正起来才回结果。Codex 的 `thread/start` 会先等
一次上游预热请求，实测两次各约 40 秒，同机当天 Codex 建会话中位数 8 秒、14 次超过 30 秒、
最长 71 秒；控制端等待预算已放宽到 2 分钟（见协议契约表 `INVOKE_TIMEOUT_OVERRIDES_MS`）。
当时两端日志对不上：被控端结果被丢弃时不留记录，控制端也不记晚到的结果。

被控端对超过慢阈值的请求追加记录结果去向：`slow result handed off`（已交给链路或离线队列，
带 `accepted`）或 `slow result dropped reason=link-reset`（执行期间链路被重置，结果按既有语义
丢弃）。控制端对已结束等待后才到的结果记录 `late invoke-result`。Codex 的 `thread/start ok`
带上 `elapsedMs`，把上游预热与 app-server 启动分开。

故障半径：① 只追加 debug／info 日志，不改变结果发送、丢弃、重试或断链恢复；② 日志只含
截短的请求 id 与设备引用，不含参数或结果内容；③ 慢阈值沿用既有 `slow execution`，不新增高频
日志。自建中转只转发原消息，不需升级。验证入口：Device Link `invokePolicy.test.ts`。

### 手机新建任务首条消息的分段计时（2026-11-26）

用户反馈手机新任务点发送后二三十秒才发出去，现有日志只有 `maker:create-session` 的总时长，
分不清卡在建链、查模型、电脑建会话还是交出首条消息。两端各补一条分段计时，只记录、不改行为：

- 手机：`new-session` 的 `creation timing`（`session/newSessionCreationTiming.ts`），
  每次管线收口写一条，含点发送到管线开始的 `prepareMs`、各阶段 `stagesMs`、失败那一步的
  `restMs` 与首条消息 clientId 末 8 位。发件箱路径交出后，送达电脑的耗时看同一 clientId 的
  `send accepted`。只进用户开启的本机诊断录制。
- 电脑：`session-start-timing` 的 `session start timing`（`maker-ipc/sessionStartTiming.ts`），
  `bootstrapSession` 每次结束写一条，分供应商组选电脑、等账号模型目录、目录授权、Agent 启动等
  阶段。该 scope 已精确加入上传白名单，只有固定阶段名、Agent 种类枚举与毫秒数。Codex 内部
  app-server 启动与 `thread/start` 的拆分仍看本机任务日志的 `startSession` 与 `thread/start ok`。

## 弱网下的备用截图与视频恢复（2026-11-15）

备用截图仍走原有远程桌面请求，发送端将 JPEG 压到 64 KiB 以内；base64 与回复包装
留有余量，避免一张截图跨过可靠层 128 KiB 分片边界、等待剩余片段时拖住后续消息。
原生截图和 Electron 缩略图使用同一发送预算，超预算时按大小缩小，无法达标则丢弃该帧。
这是发送端的预算，不收紧既有接收上限，不修改实时视频画质或线协议。

手机与电脑查看端在视频已恢复后，忽略同一会话此前截图请求的超时；显式撤权、
会话失效等错误仍走原流程。截图回复成功后的旧会话和视频状态检查继续保留。
故障半径：① 一张备用截图超时不代表已恢复的视频失效；② 只放弃过时截图的超时，
继续现有会话／心跳，不重建共享连接；③ 不修改锁屏策略、12 秒租约、其它请求的重试或权限。
真实断网期间无法保证远控持续可用，也不能以本修复绕过主机到期或锁屏后的授权检查。

自建中转仍转发原有请求与回复，旧端可直接接收较小截图，不需服务端升级或能力协商。
验证入口：Desktop `frame.test.ts`、`viewerTransport.test.ts`，Mobile `screen.test.tsx`，
共享 Device Link 与自建中转测试及 `@cindy/device-link-relay interop`。

## 信令重连与独立视频通道（2026-11-15）

主机通过可选能力 `signalingContinuity` 声明支持媒体通道上的 `heartbeat`；调用方还须检查
`channelRequests`。缺少任一能力时继续旧路径，不向旧主机发送它不认识的通道请求。
手机在已有视频正常播放时可跨过共享信令的重连，续期请求走同一媒体通道；主机只有在
最近 12 秒内收到可信捕获窗口转交且通过校验的媒体心跳或挑战回应后，才保留前台会话。
前台浏览器与 iOS 通过既有 `input-v1` 业务心跳证明媒体存活，不能依赖仅在画中画回复的 `viewPing`。
挑战回应本身不续期控制，
前台仍须发送经过原权限、拥有者和租约校验的心跳请求；原 12 秒过期、撤权、退出和锁屏策略不变。
媒体心跳请求等待沿用手机中转心跳的共享 5 秒预算，为下一轮 3 秒续期留出时间；其它通道请求仍为 8 秒。
主机日志中的 `request-accepted` 表示业务心跳被接受，可能来自中转或媒体通道，不能据此判定信令健康。

媒体失败且信令未恢复时，手机回到现有重连流程。媒体尝试切换即结束旧通道请求的等待，
迟到的原生发送结果不能转发到新通道，迟到回复不能改变新会话。已发送且结果不明的控制操作不自动重放。
故障半径：共享信令故障不连带关闭已证明可用的视频；保留仅限当前有效授权与租约，真实媒体失效仍结束会话。

恢复不变量：只有主机 Controller 写入当前租约的媒体证明；来源由可信捕获 IPC 指定，不能读取请求 payload 中的来源声明。

| 收到的事件 | 有效当前租约 | 已过期、撤权、错误拥有者或旧租约 |
| --- | --- | --- |
| 媒体通道心跳 | 原权限校验后续期并记录媒体证明 | 拒绝，不写证明、不恢复租约 |
| 中转心跳 | 原路径续期，不记录媒体证明 | 原路径拒绝 |
| 画中画挑战回应 | 记录证明；仅原有后台纯观看规则续期 | 丢弃 |
| 信令断开 | 有近期媒体证明时保留，否则停止 | 原到期／撤权清理 |
| 明确停止 | 结束当前租约并清理证明 | 不影响新租约 |

验收需从实际媒体业务入口覆盖到来源标记与 Controller，而非仅手动注入挑战回调。

这只扩展客户端业务能力与既有媒体通道白名单，自建中转仍透传原消息，不需升级服务端。
验证入口：Desktop `controller.test.ts`、`connection.test.ts`，Mobile `screen.test.tsx`，
Device Link 协议及超时测试、自建中转和 `@cindy/device-link-relay interop`。

## 手机远程画面的心跳回复等待（2026-11-08）

手机的设备画面和远程桌面共用续期逻辑。中转心跳回复只等 5 秒，该时限由共享的
`resolveRemoteInvokeTimeoutMs`（packages/device-link `invokePolicy.ts`）按请求解析，
`DeviceLinkContext.invoke` 并不接收调用方传入的 timeout，页面也不应再传。心跳每 3 秒检查一次，
在途请求会阻止下一次发送，而电脑的租约只有 12 秒；回复丢失后由现有定时器继续续期，
不新增定时器、不并发堆积心跳、不延长电脑的安全过期时限。

故障半径：① 单次心跳回复延迟，不等于设备离线；② 只释放当前心跳的等待，保留原会话和
现有续期节奏；③ 不重建共享 link、不影响其它任务，明确撤权和退出仍按原流程终止。
本条只补回归测试：Mobile `remote-desktop/__tests__/screen.test.tsx` 的缺失心跳回复用例按
真实的 `resolveMobileInvokeTimeoutMs` 结算，若策略退回默认长等待则失败。

## 供应商目录与已有许可的故障边界（2026-11-03）

故障半径三问：① 目录 REST/信令暂时不可用，影响的是信息新鲜度，不等于所有执行机都失效；
② 只在同 owner、区域、权限代次下回退最多 30 分钟的只读快照，不重放写操作、不刷新旧执行许可；
③ 一个目标的拒绝或显式关闭不得清掉另一目标的目录，恢复 probe 必须走实时路径。
转发剩余有效期并在 Main、Desktop、Mobile 各自以双时钟收口，不能只给 Main 加 TTL 而让界面永久保留旧结果。
缓存的组负载或额度不能作为自动切走正在运行任务的依据。

同账号组的离线新任务必须持有 O/M 已确认的限定路由上下文，再实时询问 M 准入，不能仅凭目录快照发起。
故障半径补充：① O/云端目录失联不能扩大为所有 M 离线；② 每个 M 使用原期限、实时负载和已收到的 O Fast 策略，
不缓存新任务授权或伪造第三方分享权限；③ 某台 M 的超时、拒绝、数据路径失效只影响它，其他已确认 M 可按原策略选择。
新动作先协商可选能力位，旧端沿用原授权路径。Agent Net 跨账号新任务可使用
[已准备的同账号组执行机](../product-rules/provider-sharing-direct-execution.md#agent-net-备用执行)。
使用 O 的离线状态、建链失败或未发出任务启动前的临时授权故障判断何时进入备用路径。备用路径只在这份
分享内尝试已有签名的 M，由 M 实时核验名额及原期限。满载和失败只影响对应执行机，任务位置和权限代次
继续绑定原分配。明确撤权或确认启动后的故障按原执行机收尾。手机通过桌面原来的目录和任务入口使用。
模型变化、受限预算与第三方转分享继续要求原授权方。

Desktop 的任务发送、镜像、订阅与 Mobile 目录读取使用逐目标实际数据通道状态；全局信令离线仅用于诊断。
订阅补发/退避也使用当前 SDK 的保留路径证明；已失效的路径、明确权限拒绝、熔断和停服仍终止重放。
Mobile 前台已有可靠直连可保留，进入后台仍释放；中继重连不以变化的连接 epoch 重挂数据 WebView。
目录 REST 暂时失败沿用原 30 分钟有界快照，但旧 online 字段不能安装成权威 presence。

历史任务可复用本进程记录的原任务/模型/执行机有效许可，M 仍实时核验；内存许可丢失、到期、
明确权限变化或显式断开后重新取得授权。不能用持久化的位置记录代替授权，也不能把任务放回组电脑运行原生历史。
验证入口：Main `deviceLinkIpc.test.ts`、`providerMetadataContinuity.test.ts`、`responsivenessTracker.test.ts`，
远程 Agent `roundtrip.test.ts`，以及 Desktop/Mobile 模型目录缓存与就绪状态回归。

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改涉及 workdir 文件、agent 进程或会话数据的功能，新增／修改 IPC
> channel 或推送事件，修改 device-link 的重试／超时／断链恢复逻辑，或设计功能入口之前

Cindy 的产品形态不止本地桌面单机。同一个功能可能运行在三种场景里，而这三种缺口都
**不报错、typecheck／单测拦不住**，只在对应场景的用户实际使用时才暴露成“功能在远程／
手机上不工作”。多端的产品语义见
[`../product-rules/core-product-principles.md`](../product-rules/core-product-principles.md)
的「多端连接与任务连续性」；插件在这三种场景的约束见
[`plugin-security-and-authoring.md`](plugin-security-and-authoring.md)。

> **增量适用原则**：约束新增和正在修改的功能；默认期望在同一 PR 内一并适配，适配量大
> 时才拆 issue 跟踪。

## 三种形态

- **SSH 远程工作区**：workdir、agent 进程、文件都在远程主机上，经
  `packages/maker-remote-ssh`、`packages/remote-file-service` 与 cc-manager 驱动。
- **设备互联远程控制**：手机或另一台桌面通过 `packages/device-link` 隧道驱动被控桌面端，
  IPC channel 走白名单准入。
- **手机版**：`apps/mobile` 独立客户端，作为纯控制端复用 device-link。

## 事实来源

| 内容 | 权威来源 |
|---|---|
| SSH 远程工作区 | `packages/maker-remote-ssh`、`packages/remote-file-service`、cc-manager |
| 设备互联／手机准入白名单 | `packages/device-link/src/allowlist.ts` |
| 手机版客户端 | `apps/mobile` |

## 设计阶段先回答三个问题

1. 功能涉及 workdir 文件／agent 进程／会话数据时，在 SSH 远程工作区下能否正常工作？路径
   与执行位置在远端，直接 `fs` 读 workdir 会读到本机——必须走 remote-file-service／
   cc-manager／exec 等现有远程通道。
2. 新增／修改的 IPC channel 与推送事件，手机／远程控制场景需不需要用？需要就按
   `packages/device-link/src/allowlist.ts` 顶部注释的准入判据登记 invoke／push 白名单并
   同步 topic 路由；不登记，手机／远程控制端就永远调不通。
3. 手机版需不需要对应的入口／UI／交互？

## 远程新建 SSH 项目的目录归属（#7117）

`maker:create-session` 的路径守卫先按执行端点识别目录：显式 `remoteHostId` 经既有
SSH 就绪与目录探测后，将主机和规范化路径一同交给创建处理器，不用本机文件系统探测
SSH 路径。旧控制端省略主机时，按当前账号的 session 记录查找唯一 SSH 归属；本地目录
与 SSH 同时命中、或多个 SSH 主机命中时拒绝猜测。记录只能解析归属，不能替代实时探测。
显式 `remoteHostId: null` 选择本地；`agentDeviceId` 指定另一电脑运行 Agent 时，文件仍属
被控电脑，不反查 SSH。探测失败不降级到本机创建，探测期间撤权或切账号也不能继续创建。

`worktree:create` 等其它入口保留本地目录与网络盘超时检查。此修复不改变 wire 字段、
allowlist、重试或 relay 生命周期；手机端完整保留“主机 + 路径”的选择与记忆仍需单独适配。
实现与回归：`device-link/remote-workdir-guard.ts`、`device-link/dispatch.ts`、
`maker-ipc/register.ts` 与 `__tests__/deviceLinkHostDispatch.test.ts`（均相对 Desktop main）。

## 远程供应商任务导出

远程供应商任务的消息保存在发起任务的电脑，允许从任务菜单导出 `.cshare`，
保留对话记录与本机可用媒体，沿用 `db-only` 提示说明导入后无法无缝续聊。
原生转录在运行 Agent 的电脑上，不查找本机同名文件，也不保留不可恢复的原生会话 ID，
包括历史 Agent 切换记录里的停泊 ID；切换记录的展示与交接内容仍保留。
协同包包含这类 Worker 时同样不能标为完整。完整任务迁移仍要求原生历史。

此路径复用本机导出 IPC 与文件选择，不新增跨设备协议。SSH 工作区与设备互联镜像任务
仍不提供本机导出，手机端没有该本机文件导出入口；不能把它们当成远程供应商任务。
实现见 [sessionShareExport.ts](../../apps/desktop/src/main/session-share/sessionShareExport.ts)，
回归见 [导出测试](../../apps/desktop/src/main/session-share/__tests__/sessionShareExport.test.ts)
与 [菜单测试](../../apps/desktop/src/renderer/features/cc-agent/sidebar/__tests__/SessionCard.visual.test.ts)。

## 远程任务存档的即时反馈

桌面与手机的远程任务列表在点击存档后立即乐观移走任务行，不能等待远程预检或写入
返回才更新。既有的运行态、接管、worktree 与自动化确认仍在真正写入前执行；取消、
拦截或失败恢复列表，迟到的预检不能覆盖用户后续的恢复操作。展示必要确认框时仍保持
任务行隐藏，不能把“已经打开确认框”当成取消；桌面归档入口等待同一个异步确认结果。
预检期间保留任务内容，
不提前清理消息或草稿；手机只从列表投影隐藏行，保留详情元数据和此前重命名、置顶的
在途写入，确认后才取代这些写入并真正移除行。取消时解除隐藏，不拿旧快照覆盖期间
已经保存的元数据。详情页在确认通过后再退出。手机详情菜单先收起，关闭动画结束后
再查询并弹确认，避免远程等待卡住菜单或原生弹窗被关闭动画吞掉。
手机详情将确认回调交给 `useSessionListActions.patchSession`，与列表共用同一个预览、
写序和失败回滚入口；确认仍有效并开始提交时才退出详情。离页或后续状态操作使旧确认
失效，结算时只解除该次预览，不写回旧状态。

实现与回归：Desktop `useSessionLifecycleActions`、`sharedTaskArchiveGuard.test.ts`；
Mobile `useSessionListActions`、`SessionMenuSheet`、`orphanSessionActions.test.ts` 与
`remoteSessionStore.test.ts`。

## 代输入的多端适配（2026-10-13）

产品规则见 [`../product-rules/input-handoff.md`](../product-rules/input-handoff.md)。三种形态的落点：

- **SSH 远程工作区**：不支持。目标窗口必须在执行代输入的这台电脑上；带 `remoteHostId` 的任务里
  `request_input_handoff` 不提供远程窗口交接，调用返回 `CAPABILITY_NOT_AVAILABLE`，
  由 Agent 改为直接告诉主人需要什么。
- **设备互联远程控制**：卡片快照随既有交互推送（`kind: "input_handoff"`）到所有控制端；交还、取消、
  停留、刷新、接手、看画面等**不带值**的决定走既有 `resolveInteraction`；**带值**的提交与截图只走插件
  授权 v3 加密交换（`plugin-oauth:submit-input` / `plugin-oauth:open-input-picture` /
  `plugin-oauth:answer-input-picture`），不新增明文 invoke。对端不支持 v3 时卡片显示「请更新」，不降级。
- **手机版**：同一张卡（`src/inputHandoff/`），系统保密输入与 AutoFill 类型、截图点按、设备码
  （`expo-clipboard` + `Linking`，无新原生依赖）与单窗口实时画面（远程桌面路由带 `handoff` 参数）。
  推送深链回到所属任务。
- 单窗口实时画面复用远程桌面通道：控制端只在 `start` 里带 `handoff: requestId`，由被控端按请求选窗口；
  被控端以 `handoffWindow` 能力位声明支持，旧被控端不声明时控制端不展示入口。协议细节见
  [`protocol-compatibility/input-handoff.md`](protocol-compatibility/input-handoff.md)「代输入」。

## 恢复动作先回答故障半径（device-link 共享链路）

### 远程与分享任务恢复的测试矩阵（2026-11-21）

改远程 Agent、分享供应商或供应商组的恢复路径（换号、换电脑、续跑、交接）时，测试矩阵按**控制端本地会话的状态**
列，不能只按执行端看到的失败类型（冷启动失败、运行中撞限）列。至少覆盖四格，每格断言执行端是否发出切换凭证、
控制端是否接管、原输入是否只落库一次且只执行一次、新会话是否收到交接上下文：

1. 本地会话已关闭：下一次发送走 fresh open；
2. 本地会话开着，执行端的 run 还在且空闲；
3. 本地会话开着，执行端的 run 已被闲置回收或断开：下一次发送先 reconnect；
4. 本地会话开着，正在运行一轮。

第 3 格最容易漏：控制端的任务常常开着几个小时，执行端闲置一阵就会回收 run。测试如果先关掉控制端会话再重开，
跑的是第 1 格，覆盖不到第 3 格。#11081 只覆盖了第 1、4 格，第 3 格的凭证到了控制端却没有被接管，
直到 #11751 才修复。手动发送之外的入口（定时、IM、Orca、自动续跑）要逐个说明是否适用；不适用的，写明
原行为保持不变。

断链恢复的边界参照正常流程，例如交接里的路径和附件与正常发送用同一套换算规则，不另起一套更严或更松的规则。

### 供应商组的跨区分享恢复

2026-10-26：① 故障是任务所在电脑没有加载同账号组已能用的跨区分享；② 仅恢复当前账号在另一
官方区域的分享列表与专用连接，不重启本区 relay、不重放任务、不扩大分享权限。首次请求合并，失败
沿用现有退避，重复的组查询不绕过退避；本区名单的额外核验也限为每 30 秒最多一次，本区已加载的
目标不等待无关的跨区恢复。组视图先返回，成员目录仍受原有 3 秒读取上限约束；③ 回归
通过真实组 `view` / `pick`、设置页 `remote-manage` IPC 与分享路由入口验证恢复，同时核对本区分享仍可用、暂停与撤销仍拒绝、
换账号后的迟到组回包和服务端回包不能激活新账号。手机及桌面远控共用任务所在电脑的这条路径，
SSH 与跨账号组中转不变。实现见 `provider-group/remoteClient.ts`、`device-link/providerShareGuest.ts`
与 `providerShareCrossRegion.ts`。

### 文件通道慢速回退

Desktop 与 Mobile 的整文件 peer 下载共用 `fileTransferPolicy.ts`。数字按职责分开：
网络帧／信用窗口是协议约束；连接空闲与命令／接收超时是资源和等待预算；缓存容量
沿用已有存储预算，不作为文件有效期或“最佳网络速度”的依据。
双方协商支持后，文件连接跟随远程会话生命周期，首次传文件时才建立，不用任意空闲
时长决定关闭；旧端继续按已有空闲预算兼容。手机退后台释放原文件 WebView 和电脑端
连接，回前台不立即重建。手机 relay 离开 online 时同样立即卸载文件 WebView，
不等重新上线后的 connectionEpoch 才清理；取消在途、排队及建连中的请求，
迟到消息不得恢复旧会话。重新在线且新 WebView 就绪后按需建连，不主动重放文件请求。

连续一个命令预算（15 秒）没有写入进展（含等待 EOF）时回退。只要仍有写入进展，
不按预计剩余时间、文件大小或速度放弃传输：接收超时约束的是无进度等待，不是整个
文件的完成时间。没有备用路径的实测速度，就不能以“预计还需超过 60 秒”为由丢弃
已收字节；这会让 806 MB 等大文件在正常传输 15 秒后被中断，再撞上旧媒体上传接口
的 30 秒请求超时。直接、TURN 和未知路径使用同一停滞判断，路径变化不影响它。
每次取件旁路采样实际路径用于诊断，不阻塞握手或文件首字节；进度检查不依赖 Debug 开关。

共享文件 runtime 遇到 ICE `disconnected` 保留连接最多 15 秒，恢复则取消计时；
`failed`、`closed`、显式取消和撤权仍立即清理。重复断连事件不延长窗口，计时只作用于
该连接。Desktop 对已完成且持续至少 15 秒、平均低于 128 KiB/s 的中继下载，在下一次
取件前最多每 60 秒试建一个候选连接；保留旧连接，只有候选确认直连且旧连接没有在途
RPC 时才替换。候选失败或仍走中继继续用旧连接；受现有四连接上限、账号与 peer 代次
约束，不改变 wire 协议或旧端能力协商。升级后停止探路，除非后来再次出现慢中继样本。
诊断记录断连原因和最多八个 ICE 检查结果，不记录地址、候选 ID、SDP 或凭证。

故障仅影响该 peer 的文件通道；复用已有按设备冷却（30 秒起、最多 5 分钟）避免
紧接着的文件重新走同一慢链路，不重连共享 WSS、不影响另一控制端的文件或请求。
取消、退后台、切账号依然是取消，不触发 OSS；不并行竞速或预先上传用户文件。
回归包含两台控制端一台停滞、另一台持续写入并完成，以及旧端缺能力字段的兼容。

### 输入推荐的请求级恢复

Desktop 远控输入推荐使用任务执行电脑 B 的完成轮次；控制电脑 A 的时钟和两条推送流的
到达先后不决定该轮次是否有效。缓冲先到的完成通知，临时水合、排队或输入框忙碌不消费推荐；
实际开始新轮次、用户采用/关闭推荐和账号切换仍使旧请求失效。

故障半径三问：① 证据仅是这一笔预测请求超时、背压，或 B 明确尚未完成终末交付；
② 只对原 B、原任务、原完成轮次做有限退避重试，复用 B 的在途 Promise/缓存，不重置 peer、
共享 relay 或其它任务；下层原有建链/熔断策略不变。③ `predictPromptUntilDisabled.test.ts`
以两个控制端调用同一 B 的路由替身验证一端超时退避期间另一端完成，`predictPromptIpcBoundary.test.ts`
验证同轮并发只调用一次模型以及重试等待中新轮/换账号隔离；未做真实双电脑断网演练。
`promptRecommendationStore.test.ts` 覆盖时钟差和乱序推送，输入框 DOM 回归覆盖忙碌投影恢复后
显示与 Tab 采用。响应兼容说明见 [`protocol-compatibility.md`](protocol-compatibility.md)
「远程输入推荐的完成轮次与重试」。

### Agent-Net 中继连接保活

2026-11-13：开启 Agent-Net 后，device-link 的 ping 由 worker 就地应答、不经过中继，察觉不到
「还能收、发不出去」的中继连接（实测一台电脑到中继的上行重传约 20%，对端互判离线 9 分钟和
15 分钟，重连后 1 秒内恢复）。Desktop Main 在实际持有的中继 WebSocket 上每 15 秒发一次标准
WebSocket ping，45 秒收不到 pong 就关闭这条连接，交给 worker 既有的中继重连（0.5 秒起，最长
15 秒）。计时器本身迟到（Main 繁忙、系统唤醒）时重新计时，不算作 pong 丢失。

故障半径三问：① 证据是本机到中继这一条连接的往返失败（pong 由中继直接回，不经任何对端），
单个对端静默或休眠不会触发；② 只重建本机这一条中继连接，已建立的对端通道（直连和经中继的
加密连接）保留，device-link 链路不复位、不重放；在持续丢包的线路上最坏约每分钟重连一次，不会
形成紧循环；③ `packages/agent-net/src/__tests__/workerSocket.test.ts` 用本机真实 WebSocket
中继验证：不回 pong 时断开，正常回 pong 时超过时限也不断开。用的是标准控制帧，官方中继和自建
中继的 WebSocket 都默认自动回复标准 pong。手机端的 React Native WebSocket 没有标准 ping
接口，改用中继通过 hello 声明支持的 `relay-probe`，在拨号或业务失败后按需验证本机与中继的往返。
见本文件「同一台电脑的旧可靠连接与新会话同时存在」及
[Agent-Net 会话兼容说明](protocol-compatibility/agent-net-session.md#手机按需验证中继上行)。

### Agent-Net 中继连接断开后必须重连

2026-11-25 04:26：一台 Mac 的 Agent-Net 中继连接断开后再没有重连，只经中继能到的电脑和手机全部离线，
直到 08:53 重启 App；同一台电脑另一条中继连接照常每 29 分钟断开重连。原因是 worker 里代替 WebSocket 的对象：
上传连接拒收中继发来的一帧、自己关掉连接时，它 `terminate()` 后不发 `close`，Main 随后报的关闭又因为它已被删掉而被丢弃，
`AgentNetSocket` 一直把这条死连接当成中继连接，网络变化时也因此跳过重连。日志特征：`relay connection closed` 前后都没有
`duplicate hello-ack`，此后没有任何 `opened` / `failed`。

现在三层都要保证重连：

- **worker**：代替对象 `terminate()` 后和 `ws` 一样在下一轮发 `close`（1006），上传连接自己关掉的连接也走正常的断开重连
  （`packages/agent-net/src/worker.ts`）。
- **原因进日志**：上传连接自己关掉已建立的连接时带上原因码，Main 记
  `agent-net relay connection was ended by this device (<CODE>); reconnecting`，原因码只收大写字母、数字与下划线。
- **Main 兜底**：没有打开的中继连接、worker 又 `AGENT_NET_RELAY_STUCK_MS`（90 秒，从中继断开或 worker 最后一次请求连接算起，取较晚的）
  没请求过连接时，Main 让 worker
  `restartRelay`：丢掉它仍当作中继连接的那条、不再等一直没结果的连接尝试，按当前退避重连，并记一条警告。90 秒高于正常重连
  两次尝试之间最长的间隔（退避最长 15 秒加握手 10 秒，身份冲突冷却最长 60 秒），不打断正常重连；之后仍不通则每 90 秒最多再催一次。
  计时器迟到超过一个周期（系统睡眠、Main 卡住）时只重新计时，不算证据。
- **退避**：中继连接撑过 10 秒才把重连间隔重置为 0.5 秒；连上就断的继续翻倍到 15 秒。原来每次连上都重置，若中继每次连上都发来
  同一帧被拒收，修好以后会变成每半秒重连一次。

故障半径三问：① 证据只是本机到中继这一条连接已断（Main 手里没有打开的中继 WebSocket）且 worker 长时间没有重连，与对端是否在线
无关；② 只重建本机这一条中继连接，直连与经中继的加密对端连接、device-link 链路和会话都保留，不复位、不重放；兜底最多每 90 秒
一次，连上即断的连接按退避最长 15 秒一次，不形成紧循环；③ `socket.integration.test.ts`「reconnects its relay after ending that
relay connection itself over a frame it refused」用真实 worker、真实中继和本机回环转发注入一帧拒收消息，验证重新连上并记下原因；
`workerSocket.test.ts`「tells a worker whose relay reconnect is stuck to start over」验证 Main 兜底；`portableSocket.test.ts`
「backs off a relay connection that keeps ending as it opens …」验证退避与 `restartRelay`；三条去掉对应修复时都失败。
只改客户端，不改 wire、中继与协议；手机用的 `PortableUplink` 原本就会在自己关掉连接后报关闭，只多了退避这一条变化。

### Agent-Net 中继发送排队上限

2026-11-13 17:23–17:35：一台对端的中继路径变慢，中继 WebSocket（TCP）只排队、不丢包。发往它的
确认从 1 秒涨到 156 秒，device-link 队列只有 16 条约 7 KB，消息卡在下层；同一条消息被重发到第
5 次，结果迟到几分钟才送达，读请求在发出 95 秒后才执行。原来唯一的限制是 1 MiB 字节上限，
流量小时 1 MiB 就是几分钟的数据。

经中继转发的是传输核心的数据报，本来就允许丢，丢了由核心重发。两个方向共用
`packages/agent-net-relay/src/datagramQueue.ts`：记录每条连接上还没交给系统的写入，最早一笔等待
超过 1 秒时，不再写入新的数据报，直到队列重新流动；控制消息（在线状态、名册）照常写入，原有
1 MiB 上限保留。排队超过几个往返只增加延迟、不增加吞吐，丢包让核心按丢包处理，不会再看到越来
越长的往返。开始丢和恢复时各记一条日志，同一连接 30 秒内最多记一次开始。

- **本机 → 中继**：Desktop Main 实际持有的中继 WebSocket（`packages/agent-net/src/workerSocket.ts`）。
- **中继 → 设备**：中继内核按目标设备的会话转发（`packages/agent-net-relay/src/server.ts`），自建中转
  与「这台电脑当中转」直接使用；中继日志不带设备号。官方服务端仓库有独立的内核副本，需同步同一
  改动后才在官方中继生效。

自建服务器的 V1、V2 程序共用部署版本标记 `packages/device-link-relay/src/version.ts`，本次随
V2 内核修复递增到 `0.5.1`，让已部署 `0.5.0` 的主人能看到升级入口；不改变 V1 协议。
`selfHostedRelayRuntime.test.ts` 经状态 IPC 验证旧版出现升级提示、升级完成后提示消失。

故障半径三问：① 证据是这一条连接上的写入本身停在进程里超过 1 秒（本机方向是本机到中继，中继
方向是中继到这一台设备），与其它连接无关；② 只对这条连接上新的数据报不写入，不关闭连接、不
复位对端、不清 device-link 队列，核心照常重发；中继上一台设备变慢不影响发往其它设备的数据；
进程长时间卡顿后可能多丢几个数据报，代价是一次重发；在仍有吞吐的慢线路上，丢弃只发生在队列
已经积压超过 1 秒的时段，排队数据比原来少，不会更多；③ `packages/agent-net/src/__tests__/workerSocket.test.ts`
用本机真实 WebSocket 中继验证本机方向，`packages/agent-net-relay/src/__tests__/relay.integration.test.ts`
用真实中继和两台设备验证中继方向：接收方停止读取后新数据报不再写入（去掉修复时测试失败），
恢复后继续转发且这台设备不被断开，停顿前正常写入的数据报一个不少。不改协议，新旧客户端与新旧
中继任意组合都兼容。

未处理：手机端发往中继的方向（React Native 拿不到写入完成回调；`DatagramSendQueue` 也不能用于
Desktop worker 里的代理 socket，那里没有完成回调）、device-link 在 Agent-Net 上的重复可靠层
（每次重发都把整条消息再写进本来就可靠的加密流，见 `agent-net-plan.md` 第 2 阶段）。

### 离线对端的出站调用闸门

2026-11-14：一台笔记本整夜休眠，另一台电脑的侧栏、Git 状态、子代理、资源列表等轮询仍对它
逐笔 invoke，每笔先发 link-open、relay 回 DEVICE_OFFLINE，每小时一百多轮；打开着的任务复制
对话框每秒读一次复制状态，每次等满 10–30 秒失败，11 小时里报错 140 多次。

`packages/device-link/src/peerOfflineGate.ts`：relay 明确判定离线（DEVICE_OFFLINE 路由信号，或
presence `online=false` 且没有保留的直连）后，控制端对该同账号对端的 `invoke()` 在本地以同一个
`DEVICE_OFFLINE` 错误结束，不触网；每个窗口只放行一笔真实请求作探测，窗口 15 秒起倍增、最长
120 秒。presence 上线、收到该对端任何路由帧、已有直连、relay 重连都立即开闸。共享任务与供应商
分享对端不经过这道闸。Desktop 复制对话框的状态读取失败后同样退避（1 秒起倍增、最长 30 秒），
来源电脑上线的 presence 立即恢复。迁移 IPC 保留已知的离线错误码，避免通用
`MIGRATION_FAILED` 转换吞掉等待原因；超时仍沿用 `MIGRATION_TIMEOUT`。
同一 WebSocket 内旧 link 代次的迟到离线信号不得关闭当前代次的调用闸门。

故障半径三问：① 证据只认 relay 的明确离线判定；单次超时、背压、无响应、ACK 超时都不关闸；
② 只作用于这一个对端的新出站调用，已建立的直连、其它对端、入站方向、可靠 pending 与重放都不变，
调用方拿到的错误码与原来 relay 回绝完全一致；presence 推送丢失时最坏 120 秒内由探测恢复；
③ `client.test.ts`「DEVICE_OFFLINE 之后本地回绝同一对端的调用」验证窗口内不写帧、其它对端照常、
探测只放行一笔、presence 上线立即触网；`TaskMigrationDialog.test.tsx` 验证读取退避与上线恢复。
只改控制端本地行为，不改 wire 协议，旧版对端与自建中转无需同步。
### Agent-Net 上单个对端的确认超时

2026-11-14：开启 Agent-Net 后，Desktop 控制端对一台对端可靠重试耗尽时，仍按旧规则重建整条连接，而这条连接是整个
Agent-Net 节点（独立线程、核心端点、中继上行和所有对端的加密连接）。慢线路上，对端对请求的确认排在它自己回传的大结果
后面，30 秒没回来就触发；重建后对端还拿着旧连接，按「同时拨号只留首选拨号方」的规则拒收新连接，要等旧连接约 30 秒后
超时，其间请求名额被旧请求占满（基线：每秒 64 KB 的线路上回传 1 MiB，5 轮卡死 3 轮，3 分钟内不恢复，见
[`会话层基线`](../benchmarks/agent-net-session-2026-11-13/README.md)）。

- Device Link 新增本地选项 `reliablePeerTransport`，Desktop 只在主连接实际走 Agent-Net 时为真。重试耗尽时，这条消息
  首发后对端一直有帧送到、最近 10 秒内仍有，就继续等确认，不复位、不重发（上限 120 秒）；否则只复位这一个对端（与 Mobile
  的 `isolate-peer` 相同），由下一次请求经既有 link-open 重建、按原 seq 重放，不拆连接。所有对端同时静默的连接级判定照旧。
  旧中转连接与跨账号连接不传这个选项，行为不变；Node Host 和 Desktop 一样，只在主连接实际走 Agent-Net 时为真。
- Agent-Net 选连接（`packages/agent-net/src/portableSocket.ts`，Desktop 与手机共用）：对端只在没有到本机的连接时才拨号；
  本机已有连接建立超过 10 秒仍收到它的新拨号，说明对端换了端点，立即换用新连接，不再等旧连接超时。10 秒内的同时拨号
  仍只留首选拨号方那一条。

故障半径三问：① 证据是单个对端：它的确认超时，并看它自己是否仍在送达；② 只作用于这一个对端的链路或这一条加密连接，
不拆节点，其它对端和中继上行不受影响；对端仍在送达时什么也不做，安静时只复位它；换用新连接时旧连接里没送达的数据由
Device Link 按原 seq 重放，重放沿用原有预算；③ `packages/device-link/src/__tests__/client.test.ts` 用两台出站对端（一台持续
送达、一台静默）验证只复位静默的那台、共享连接不拆、送达那台的请求在原链路完成；
`packages/agent-net/src/__tests__/portableSocket.test.ts` 验证旧连接超过窗口后对端再拨入立即换用，同时拨号仍只留一条。
两条用例去掉修复时都失败。不改 wire 值，新旧版本任意组合兼容：只更新一端时，更新的一端不再拆节点、更快认新连接，另一端
行为不变。中继只转发数据报，自建中转与官方中转都无需改动。

### 中继转发的数据报走 UDP

2026-11-14：打不通直连时，Agent-Net 数据报原来只能经中继的 443 WebSocket 转发，可靠 UDP 叠在 TCP 上，一个包慢了后面
都要等。现在中继在原有 UDP 端口上也转发，WebSocket 仍负责认证、名册与在线状态；协议与新旧互通见
[协议记录](protocol-compatibility/agent-net-udp-relay.md)。设备侧 `packages/agent-net/src/relayUdp.ts`，中继侧
`packages/agent-net-relay/src/server.ts`。

故障半径三问：① 证据是这条中继会话自己的 UDP 登记与满尺寸第 1 跳探针（`0xE5`/`0xE6`，支持 `udp-relay-probe-v1` 时直测本机 ↔ 中转
1350B 双向可达；无探针的旧中继下仅当所有经中转对端均无健康确认推进时才触发），与其它会话、以及单个抖动或离线对端无关；
② 只切换这条会话上数据报走哪条路：设备不再经 UDP 发，下一次登记告诉中继「收不到」，中继对这台设备退回 WebSocket；
不关 WebSocket、不复位对端、不清队列，切换期间丢的数据报由传输核心重发；登记一直不通时每秒一次、10 秒后每 5 秒一次，每次几十字节；
探针停用期间按 15s → 30s → 60s → 120s 在 WebSocket 保护下主动发单包探针（换网时立即清冷却重探），通了才切回 UDP；
设备的 UDP 上行也断了、发不出「收不到」时，中继 30 秒没收到登记自行退回；
③ `packages/agent-net/src/__tests__/relayUdp.test.ts` 验证确认中断 4 秒内退回 WebSocket、满尺寸探针准入/复核/换网恢复、以及旧中继下的
单对端隔离与间歇流量退避清零，`packages/agent-net-relay/src/__tests__/relay.integration.test.ts` 用真实中继套接字验证报「收不到」退回
WebSocket 及满尺寸探针防放大/防重放，`packages/agent-net-native/src/udp_paths.rs` 验证手机原生同一探针状态机；去掉修复时对应回归均失败。

### Agent-Net 关闭时告诉直连的对端

2026-11-16：两台电脑反方向验收时，Windows 那台正常退出，打洞直连的 macOS 测试机 过了 30.0 秒才判断它离线，期间的建链还选了已经断掉的会话。
端点关闭时本来就给每条连接发关闭包，但发完立刻关了套接字：UDP 发送是异步的，套接字一关，还没发出的包全被取消
（Windows、macOS 上发完立刻关都是 0/50）。经中转连接时中转会通知对端，所以之前没碰到。现在端点等这些发送交给系统后再关套接字
（最多 250 毫秒，`packages/agent-net-core/wasm/node.mts` 的 `CLOSE_DRAIN_MS`），`transport.ts` 先关端点再关中转，
`portableSocket.ts` 等端点关完才报告关闭，worker 线程之后才被结束。修复后同一场景里 macOS 测试机 4 毫秒就判断断开。
同日关掉「Agent-Net (Beta)」时又碰到同一个问题的另一条路：设置一变，worker 的下一条消息被拒，`workerSocket.ts` 直接结束线程（code=1006）。
现在 `terminate()`（这一处，以及 Device Link 判定连接坏了时）马上停止把 worker 的消息交给 Main、马上报告关闭，
但先让 worker 正常关闭、把关闭包发出去，它报告关完再结束线程，最多 500 毫秒。worker 发来的地址不对这类协议错误照旧立即结束。

故障半径三问：① 证据是本端自己正常关闭（退出、换账号、重建节点），不是对网络状态的猜测；② 只影响关闭的这一刻：关闭包的内容和数量
不变，不新增重试；等待期间端点不再收发，核心出错导致的关闭照旧立即关；端点端口是随机的，等待中的旧套接字挡不住新端点；
③ `packages/agent-net/src/__tests__/socket.integration.test.ts` 的 `tells a directly connected peer right away when the transport closes`
用两端经 127.0.0.1 直连验证一端关闭后另一端 2 秒内收到关闭，`tells a directly connected peer right away when its worker socket is terminated`
用真实 worker 验证直连后关掉中转、再结束一端的 worker 连接，另一端 2 秒内看不到这条路径；两条去掉对应修复时都失败。不改 wire，新旧版本任意组合兼容：更新了的一端退出时
对端马上知道，另一端不用改；中继不涉及。

### Agent-Net 传输时的 CPU 与路径日志

2026-11-21：对比 Device Link 时查到三处和线路无关的开销，都在 Desktop 与 Node Host 用的 Node 驱动和中转内核里，不改 wire。

- **经 UDP 中转的每个包重建一次密钥对象。** `packages/agent-net-relay/src/udpRelay.ts` 的 `mac` 把会话密钥的原始字节直接交给
  `createHmac`，Node 每次调用都新建一个密钥对象，比算 HMAC 本身还贵：设备上每个上行包算一次、每个下行包验一次，中转上每个转发的包
  验一次再算一次。现在每把密钥只建一次（按密钥数组本身记在 `WeakMap` 里，随中转会话回收）。Electron 42 里一次 3.4 → 1.3 微秒，
  独立 Node 24.19 里 13 → 2 微秒。官方中转用的是服务端仓里同一份内核的副本，要在那边同步才受益；不同步也照常互通。
- **有连接在快速发送时，驱动线程整段时间占满一个 CPU 核。** `packages/agent-net-core/wasm/node.mts` 对短于计时器精度的等待
  每轮事件循环看一次时间（Windows 的计时器要 15.6 毫秒，见 `TIMER_GRANULARITY_US`）。数据稳定在传时，对端每两个包回一个确认，
  每个到达的包本来就带着核心走一轮、把到点的包发出去；现在最近 2 毫秒收到过包就不看时间，只设 1 毫秒的计时器兜底
  （`wakePlan`、`INBOUND_CLOCK_US`）。每一阵开头、第一个确认回来之前的那一个往返没有到达可依靠，照旧看时间。
  2026-11-22 又查到计时器准的系统上仍然空转：Linux、macOS 的计时器精度是 1 毫秒，`needsFineTimer` 原来不问核心，把这些系统上所有
  短于一毫秒的等待都当成等不起，确认包成批到达、两批之间超过 2 毫秒时就一轮一轮看时间。现在和 Windows 一样由核心的 `fine_timer`
  判断（每毫秒要发 64 KB 以上才看时间）。容器弱网（Linux、Electron 42）：每 MiB 的 CPU 4G 线路 224–460 → 145–228 毫秒，跨国线路
  410–580 → 140–250 毫秒，速度不变。回归：`socket.integration.test.ts`「leaves the driver thread mostly idle…」（改前 Linux 上事件循环
  利用率 0.43–0.47，改后 0.11）。
- **日志看不出对端走直连还是中转。** 连接都是先经中转建立、再换到直连，而 `agent-net peer … connected via …` 只在建立和断开时记。
  现在已连上的对端换路径时再记一行 `agent-net peer … moved from relay to direct`（或反过来），来回跳动时每台对端 30 秒最多一行，
  之后记下最后停在哪条路（`workerSocket.ts` 的 `logPath`）。只写缩短的设备号和路径，不写地址。

实测（Windows，Electron 42 作 Node 跑压测，20 MiB、512 KiB 一块、4 块在途，同一时段先后各两轮；括号里是 Device Link）。
跨地区档边传边发小请求、上传方向有三轮只到 55–59%，改前改后一样，是会话 v1 跨通道先后的结果，没有算进下表：

| 线路 | 改前 Agent-Net | 改后 Agent-Net |
|---|---|---|
| 不限速，纯传 | 21–22 MB/s，每 MiB CPU 49–50 毫秒（35–37 MB/s，29–32 毫秒） | 25–27 MB/s，47 毫秒 |
| 不限速，边传边发小请求 | 33 MB/s，52–63 毫秒；小请求往返 7–9 / 46–56 毫秒（34–36 MB/s；57–73 毫秒） | 36–40 MB/s，46–50 毫秒；4–7 / 22–25 毫秒 |
| 家宽 12.5 MB/s | 线路的 90–91%，145–156 毫秒（92–96%，31–38 毫秒） | 86–91%，84–101 毫秒 |
| 跨地区 6.25 MB/s、往返 200 毫秒（各 4 轮） | 71–79%，230–275 毫秒（83%，31–40 毫秒） | 71–79%，109–141 毫秒 |

不限速这一档压测自己的中转进程先跑满一个核，量到的是它的上限。压测要用 Electron 跑：同一个 Node 版本，独立 Node（OpenSSL）里
用原始字节作密钥的 HMAC 慢四倍，2026-11-20 的对比报告因此把 Agent-Net 的 CPU 写成了 Device Link 的 3–4 倍、不限速线路只有一半速度
（`packages/agent-net/bench/harness.ts` 开头；不在 Electron 里时启动会提示）。

还没解决的：限速线路上每 MiB 的 CPU 仍是 Device Link 的约 3 倍。一半是每一阵开头那一个往返里看时间，另一半是每个包都要在 JS 里
走一轮（加密、发包、核心的十几次调用）。前者在 Windows 上要有比系统节拍细的计时器，后者要把收发包放到原生线程里，JS 只读写流，
和手机的原生循环（[会话层方案](../agent-net-session-plan.md) 10.2 节 v2-4）是同一件事。2026-11-23 起两者都由下一节的原生引擎解决。

### 电脑端 Agent-Net 跑在原生引擎上（2026-11-23）

Desktop 的 Agent-Net worker 有原生模块时，传输跑在手机同一个 Rust 引擎上（`packages/agent-net-native/node`，Node-API 模块）：
收包、回确认、重传、按节奏发包都在引擎自己的线程里，不经 Main，也不经 worker 的 JS；引擎有东西给 JS 读时往 worker 监听的本机回环
UDP 端口发一个字节叫醒它（最多一个在路上），数据连续进来时 JS 读完后 1 毫秒内到的合成一次读，空闲后的第一个包照旧马上叫醒。
`NativeTransport`（手机在用的同一个传输层）在 worker 里驱动它（`socket.ts` 的 `native`），会话层、Device Link 帧和 Main 侧都不变。
模块由打包时按目标平台从源码构建、放在 worker 包旁边（`forge.config.ts` 的 `stageAgentNetNative`；Windows 打包本来就要 Cargo，
构建失败即打包失败，其它平台没有 Rust 时不带它）；开发时用 `node packages/agent-net-native/node/build.mjs` 生成。
没有模块、加载失败、或引擎给出的传输公钥和这台设备的不一致（`AGENT_NET_NATIVE_IDENTITY_MISMATCH`）时照旧用 WASM，
日志记 `agent-net native engine unavailable (<原因>); the transport runs on WASM`，正常时记 `agent-net transport runs on the native engine`。
线上协议、中转与对端都不变：新旧版本、原生与 WASM 两端任意组合互通（`nodeNative.integration.test.ts` 直连与只经中转各一遍）。
Node Host 仍用 WASM。

切换前补上了原生路径比 WASM 路径少的几项，否则电脑端会退步：
- **中转 UDP「只通登记、不通数据」时退回 WebSocket**、走 UDP 时的往返与停用原因（[协议记录](protocol-compatibility/agent-net-udp-relay.md)末段，
  引擎能力位 `relay-udp-health`）；UDP 收发字节照旧进 UDP 流量表（`udpTraffic`）。
- 名册上限 512 → 4096：超过时原生传输整个关掉，WASM 没有这个上限。
- 引擎收走排队字节就告诉 socket（`onDrain`），和 WASM 一样；原来只在单条连接从 128 KB 以上落下时才报，几条连接加起来超过
  128 KB 时 Main 要等每秒一次的状态才发下一大帧。
- **Windows 上的短等待。** `WSAPoll` 的超时跟系统节拍走，1 毫秒的等待实际 15.5 毫秒，按节奏发包的引擎在 12.5 MB/s、往返 32 毫秒的
  线路上比 WASM 慢 15–20%。现在套接字到包时置一个事件，再配一个高精度计时器，两个一起等（`packages/agent-net-native/src/wait.rs`），
  1 毫秒的等待 1.57 毫秒，不改整个进程的计时器精度。只影响 Windows，手机不受影响。
- 身份：电脑端有的身份是存下来的私钥、不是从种子派生的，引擎可以直接收这两把私钥（`create` 的 `keys`），worker 本来就持有它们。
- **直连与中转的选路**（#12175：自动／直连／中转、双路往返）。选路的判断从 `transport.ts` 搬进不依赖 Node 的 `pathRouter.ts`，
  WASM 与原生两种传输共用；引擎加了只测速不换路的 `measure`、`preferRelay` 和 `poll` 里的 `probeRtts`（能力位 `path-routing`）。
  两端的偏好照旧经控制流同步（`{"pathPreference":…,"autoRelay":…}`），原生与 WASM 两端互相跟随（`nodeNative.integration.test.ts`
  「switches a live peer between direct and relay from either side …」）。手机随新安装包同样跟随电脑端设的偏好、自动模式同样生效；
  旧安装包不报 `path-routing`，照旧每 10 秒探测候选地址，不读这条消息，和以前一样。
- **透明代理的 Fake-IP 避让**（#12175）：引擎自己用系统 DNS 解析 STUN 与中转 UDP 的主机名，开着 Clash／Surge 这类代理时会拿到
  198.18.0.0/15。电脑端先用 `resolveUdpHost` 解析好再把地址交给引擎（`TransportOptions.resolveUdpServer`），每 5 分钟和每次换网
  重新解析，变了就让引擎改到新地址；解析不出来时把主机名照旧交给引擎。手机不传它，行为不变。

查到并修掉的两个崩溃：Node 在最后一个加载原生模块的 worker 结束时卸载模块，而模块起的线程（收发线程最多再等 250 毫秒、中转与 STUN
的域名解析要等 DNS）还会回到已卸载的代码，整个进程崩溃（Electron 42，退出码 139，压测两轮之间必现）；模块现在把自己钉在进程里
（`pin_module`）。原来用 Node-API 的 thread-safe function 叫醒 JS，Electron 结束 worker 时它被释放、收发线程再调用就崩，
所以改成上面的回环 UDP：收发线程从不调用 Node。

故障半径三问（中转 UDP 退回）：① 证据是这条中转会话上本机自己的收发——经 UDP 发出数据后 4 秒没有任何经中转的数据报进来且一直在重发、
发往走中转对端的请求 60 秒内超时两次、中转连接上 5 秒里重传占发出的四分之一以上——与其它会话、其它对端无关；② 只切换这条会话的
数据报走哪条路，不关 WebSocket、不复位对端、不清队列，冷却 30 秒、5 分钟、30 分钟后再试，停用期间登记每 15 秒一次；③ `udp_paths.rs`
的 `tests` 逐条覆盖（含单个纯确认不触发、两次超时隔一分钟不算、连接关闭计数变小时从头算），`nativeTransport.test.ts` 覆盖 JS 怎么读、
怎么报，`nodeNative.integration.test.ts` 用真实中转确认路由报 UDP 与往返；这些用例去掉对应实现时都失败。
引擎启动失败只影响这一次打开：退回 WASM，账号、名册与重连节奏不变。

实测（Windows，Electron 42 跑 `bulk-transfer.ts --modes worker-session --runs 2`，20 MiB、512 KiB 一块、4 块在途、边传边发小请求；
每 MiB 的 CPU 是两台设备、Main 与两个 worker 合计；`--native <模块>` 跑原生引擎）：

| 线路 | WASM | 原生引擎 |
|---|---|---|
| 不限速 | 40–46 MB/s，37–49 毫秒，小请求 6–14 毫秒 | 54–58 MB/s，12–26 毫秒，2–5 毫秒 |
| 家宽 12.5 MB/s、往返 32 毫秒 | 11.9–12.4 MB/s，70–82 毫秒 | 13.9 MB/s，45–50 毫秒 |
| 跨地区 6.25 MB/s、往返 200 毫秒 | 3.2–4.1 MB/s，89–134 毫秒 | 3.3–4.3 MB/s，51–61 毫秒 |

只看引擎（两端各一个线程、回环 UDP、不经 JS）：每 MiB 7.5 毫秒对 WASM 的 15–21 毫秒，回环 260 MB/s 对 70–88 MB/s。
每到一个包都把所有连接的状态拼成 JSON 一度吃掉了这些节省：引擎现在先用核心的 `has_unread` / `has_accepted` 和状态摘要判断有没有
东西给 JS，没有就不拼（家宽 43–49 → 27–43 毫秒，跨地区 47–54 → 29–34 毫秒，只看引擎）。

### Agent-Net 会话层上的控制链路（跟着「Agent-Net (Beta)」开关）

2026-11-14：两台都启用会话层的同账号 Desktop 之间，建链、调用、结果与推送改走 Agent-Net 自己的会话
（[方案](../agent-net-session-plan.md) 第 10.1 节、[协议记录](protocol-compatibility/agent-net-session.md)），不经 Device Link。
2026-11-16 起没有单独的开关（用户确认）：`apps/desktop/src/main/device-link/index.ts` 一直包着这一层，会话只在 Agent-Net 的主连接上，
所以「Agent-Net (Beta)」关着（默认）时没有会话，每个调用原样交给 Device Link，行为不变；打开以后两台都宣告了会话能力的同账号 Desktop 走会话。
调用方超时后，被控端不再执行还没交给业务的这条请求（取消先到，或请求比时限晚到，见[协议记录](protocol-compatibility/agent-net-session.md)「超时」）。
接口翻译在 `packages/agent-net/src/session/sessionLinks.ts`，按对端选路在 `packages/agent-net/src/session/sessionRouting.ts`。一个对端只走一条路：本机控制对端时，会话可用、
Device Link 上这个对端的链路没就绪、不等恢复、没有待发消息，建链和所有调用（包括不需要建链的列表、探测）都走会话，直到关链或会话断掉；
Device Link 上有活着的链路时照旧走 Device Link，那上面已确认的请求要等它重建后补回结果。对端控制本机时跟着对端选的路，结果按请求来的那条路回去。
2026-11-15 两台电脑隔离验收时发现并修正：只按「在途请求」挡会话时几乎从不走会话；列表与探测先经 Device Link 发出时，
对端把结果放进本机已经没有的旧可靠链路，59 秒后超时、再引发重开。包这一层后，原客户端返回它自己的方法（`connectionFor`、
`crossAccountConnection`）改为返回这一层，入口里「`connectionFor(peer) === client`」这类身份比较仍然成立。
和对端的连接刚建好（或换了一条）时，双方的会话宣告还要一来一回：这段时间里 Device Link 上又没有这个对端的链路状态，
建链和调用先等会话，直连最多到连接建好后 250 毫秒 + 4 个往返（往返未知时 1.5 秒，上限 1.5 秒），经 Agent-Net 中转的路径上限放宽到 4 秒
（2026-11-24 实测中转路径从连接建好到会话宣告就绪常需 2.8～3.4 秒，1.5 秒上限会导致提前回落 Device Link），会话一到就放行；
到时还没有（对端没启用会话）就走 Device Link，之后不再等。即使首轮建链早于会话到达落在了 Device Link 上：若控制端发包小但被控端回程大包堵住导致
`INVOKE_TIMEOUT`，后续同账号幂等只读请求（含 `maker:remote-agent:v1` 的 `poll` / `caps` 与列表探测）立即改走已就绪的会话，写操作仍保序留在原流；
一旦旧 Device Link 流无待发帧与在途请求，下一次 `openLink` 重开即把控制链路平滑切到会话（用户显式断开时同步关闭两条出站状态）。
连接建好的时刻取自 Agent-Net 主连接的路径通知（`agentNetRuntime.ts`）。
还没有连接时（2026-11-17 真机发现，同账号所有开着 Agent-Net 的设备都有）：
- 对方此刻在 Agent-Net 目录里在线（本机刚启动，或连接刚断）：先拨它（`PortableSocket.connectSession`），会话一到就放行，最多 1.5 秒，不等拨号结束；
  到时还没好就走 Device Link，它的帧搭同一次拨号，连不上的对端不比原来晚失败。拨不了（对方刚下线）立即放行。真机：刚启动时 Desktop 22 毫秒就向
  Host 建链、连接 0.3 秒后才好，修复后启动时的建链和调用等 134～217 毫秒后全走会话。
- 对方不在 Agent-Net 上在线：不等，交给 Device Link，离线失败照旧立即返回。它正在重启时先连上 Device Link 中转、晚 0.7 秒才上 Agent-Net，
  控制端这段时间里的重试经中转探测，拿到它签名的「开着 Agent-Net」回答后，Device Link 原本在主连接上重开（会话出现前的 Device Link 帧，之后不换路）；
  现在这一步经 `RoutedDeviceLinkClient` 的可选钩子 `openOnPrimary` 交给 `AgentNetSessionLinks.openAttested`：等它的会话最多 3 秒，到了在会话上开，
  连上了却没有会话的旧版、等不到的照旧在主连接上开。关了 Agent-Net 的对端回答「没开」，不走这一步。真机：Host 重启时控制端每 200 毫秒重试一次，
  Host 回来后主连接上的 Device Link 链路 0 条、会话链路 145 条。
- 本机关着 Agent-Net、对方不是 Agent-Net 设备：和原来一样同步选路，不多一次异步。
已知代价：对方刚断开、目录还没更新的那一下，第一次调用可能多等最多 1.5 秒才报离线（真机见过一次 1.5 秒，原来立即报）。

**开着 Agent-Net 时和 Device Link 对齐（2026-11-17 排查后补齐）。** 下面这些原来开着 Agent-Net 反而比只用 Device Link 差，Agent-Net 关着时都不变：
- **手机推送**：主连接是 Agent-Net 时只推给在 Agent-Net 上登记了推送的设备。现在 Agent-Net 送不到的手机经 Device Link 中转连接补发
  （`notifyFallback.ts`，同一台手机不收两份；「仅使用 Agent-Net」时不补发）。
- **在线状态**：中转连接收到的在线状态原来在 Device Link 包里就被吞了，没开 Agent-Net 的手机、旧版电脑的在线与「允许被控」不实时更新。
  现在两条连接合并，任一条在线即在线（`RoutedDeviceLinkClient.onPresenceChanged`）。
- **改设备名**：官方中转上设备也在 Agent-Net 目录里时先在 Agent-Net 上改（列表合并时那边的名字优先）。
- **删设备**：各台电脑按本账号 Device Link 设备列表不认、不列出被删的设备，本机删完马上不认，别处（手机、网页、旧版）删的最晚
  5 分钟内不认（`packages/agent-net/src/membership.ts`，[协议记录](protocol-compatibility/agent-net-device-removal.md)）。主干 2026-11-17 起官方网络上删除时
  还会在 Device Link 接受删除后撤销它的 Agent-Net 身份（`deviceLinkApi.ts`）；官方撤销之后那台设备重新登录也回不到 Agent-Net
  （`DEVICE_REENROLLMENT_REQUIRES_APPROVAL`），Device Link 照常恢复。
- **共享任务重启后的推送**：会话上的建链原来总报同一个流标识，主人电脑重启后来源代次不前进；现在每个会话一个标识。
- **断开时的离线事件**：会话断开时先清链路状态，按对端取的代次落回 Device Link 的，可能把离线事件当过期丢掉；现在最近一次链路在会话上时
  代次一直以会话为准（`AgentNetSessionLinks.ownsGeneration`）。
- **Agent-Net 重连期间**：主连接没了时，原来一律答「不是旧版设备」，只走 Device Link 的设备在中转好好的时候也连不上；现在沿用上一条连接记下的
  目录（`agentNetRuntime.ts` 的 `previousSocket`）。故障半径：证据只是 Agent-Net 主连接断了；只影响「这台设备走不走中转连接」的判断，
  新连接连上后立即用新目录；不改中转连接本身。
- **会话断后重开落到 Device Link**（2026-11-17 review）：会话上那条「断了待恢复」「被本机关过」原来一直留着，这个对端永远「待恢复」，
  每次调用和订阅都先再建一次链、接受后的补订阅又触发重建；断开发不到 Device Link 那条链路上；用户关过一次以后 Device Link 上的链路断了
  也不自动重建。现在本机在 Device Link 上建链时这两项作废，控制方向的恢复与关链状态只看出站（`AgentNetSessionLinks.knowsOutbound`），
  对端经会话控制本机、本机经 Device Link 控制对端时由 Device Link 自己报。按对端取连接在最近一次链路在会话上时一直给这一层，
  离线事件按会话的代次与同一条连接的代次比；跨账号连接断开、重连时按原客户端找承载它的分享连接（分路层给的是视图，和原连接比不相等）。
- **在线状态合并时连接掉线**：一条连接离线后它说过的不再算数：它决定的设备改用另一条连接最近一次的说法，只有中转连接认得的设备
  （手机、旧版电脑）显示离线；只有主连接认得的设备照旧不发（主连接自己的状态已经说明）。原来掉线那条的「在线」一直占着，另一条之后的更新全被挡住。
- **下层逐对端可靠时等入站链路确认**：确认计时器到时对端仍在送数据，原来直接返回、再没有计时器，这个对端一直停在等确认；现在再等一轮，
  总共不超过 120 秒，安静下来就只复位它自己。
- **Node Host 的 Agent-Net 掉线**：原来连中转连接上的手机、旧版电脑与跨账号对端一起下线；现在和 Desktop 一样只下线主连接承载的。
  同时开两次 Agent-Net 连接时（连接中途重启），慢的那次不再替换掉快的那次正在用的连接；凭证库一次打不开（钥匙串还锁着）下次再试，不再一直记着失败。
- **第二轮对齐（2026-11-17 rebase 后逐项对比 Device Link）**：
  - 手机推送：上一条还在逐台发时来的下一条排队按序发（`portableSocket.ts` 的 `NOTIFY_QUEUE_LIMIT`），原来报 BACKPRESSURE、没人重发；
    补发的手机名单加上账号设备列表里的手机（`agentNetListedPhones`），在后台、重连后还没上线过的手机也收得到。
  - 建链被拒：对方 presence 说关了远程控制时当场报 `REMOTE_DISABLED`；等建链时对方关链（撤权报 `ACCESS_REVOKED`）当场结束，和 Device Link 一样，
    原来要等满建链超时。
  - 积压读数：worker 的通道还有积压时每 `SESSION_BACKLOG_REPORT_MS`（50 毫秒）再报一次直到清空；原来只在本机发消息时更新，推送因「队列满」被拦下以后
    读数一直是满的，对方的任务文字停住。核心发送缓冲里的字节仍不算进去（慢线路上交互回复可能排在约 1 MiB 推送后面），记在待办。
  - `noResultCache` 传到会话上的结果缓存（MCP App 的 open／poll）。
  - 换网：Desktop 的网络监听同时告诉 Agent-Net（`agentNetNetworkChanged`）；原来只有 Device Link 的探测，它在 Agent-Net 连接里由本机回答、到不了中转。
  - 唤醒、换网后取不到中转信息时沿用这个服务上次的 UDP 地址；服务明确回答没有 UDP 时清掉。
  - 连接断了、目录里对方还在线：拨号一端自己按退避重拨（`portableSocket.ts` 的 `REDIAL_FIRST_MS`）；原来只等下一次调用或目录更新，这期间对方显示离线。
  - 刚打开的一方不等对方先拨：socket 打开后第一份实时目录里在线的设备，不论设备号大小立刻拨（`portableSocket.ts` 的 `arriving`），
    这一轮之后才是「设备号小的先拨、大的等 `LATE_DIAL_MS`」（2026-11-21）。刚打开的一方（进程启动、手机回前台重建连接）是唯一确定自己
    没有连接的一方，已经在线的对方多半还抱着上一个进程的连接而不拨。真机（Redmi K40，设备号比账号下七台电脑都大）：冷启动、
    后台超过 10 秒回前台，每次都等满 0.8–1.2 秒才自己拨，期间七台电脑没有一台拨进来；改后从点开到拿到第一份数据，冷启动 5.8–6.2 秒降到
    5.1–5.6 秒，后台 20／90 秒回来 1.4–1.65 秒降到 0.60–0.71 秒（同机 Device Link 分别是 4.7–5.0 秒、0.35–0.65 秒）。
    同时把传输层建好之前中转送来的包留到建好再交给它（`receive`，最多 `EARLY_DATAGRAMS` 个）：中转在本机连上那一刻就向其它设备
    通告本机上线，按通告拨过来的第一个握手包这时已经到了（手机上传输层晚约 50 毫秒建好），原来被丢掉，对方要等核心 200 毫秒后重发；
    本机现在也立刻拨，留下这个包两边才在第一个来回落到同一条连接上。两边同时拨时照旧由 `adopt` 留一条。
    故障半径：① 触发条件是本机 socket 刚打开、目录里某台已准入的设备在线而没有连上；② 每台只多拨一次（失败后按原有退避），
    不动中转连接与其它对端，对方的旧连接不足 `REDIAL_TAKEOVER_MS` 时这次拨号被它丢掉、按退避再拨；③ `portableSocket.test.ts`
    「dials every online device at once after opening …」与「hands the transport the datagrams that arrived before it existed」。
  - 该对方拨、对方的拨号却迟迟不来：不拨号的一方（设备号大的）等 `LATE_DIAL_MS` 后自己拨过去，之后按同样的退避（2026-11-21）。
    对方不拨是因为它还抱着一条本机已经没有的连接：本机被强杀或重建时关闭通知没送到，而当时的核心不判空闲的连接死
    （只在有数据发不出去满 `dead_after_us` 时判）。它收到这次拨号后，旧连接超过 `REDIAL_TAKEOVER_MS` 就换用新的，
    没超过就丢掉，本机按退避再拨。同日核心补上了空闲判死（`secure.rs` 的 `silent_past_deadline`）：探测满 `dead_after_us`
    没有回音就断，对方 30 秒内自己发现、照常重拨；自己停了很久刚醒来的一端先接连探测几次再下结论。
    对方是旧版本时仍然靠这次后拨。真机：手机被强杀后重启，设备号比手机小、只能经中转的电脑原来在手机上离线 20 秒到 15 分钟，
    改后约 1.2 秒；设备号比手机大的电脑由手机拨，一直不受影响。
  - 目录里同账号两张证书带同一把传输密钥（同一台设备换了设备号重新登记，密钥没换，旧证书还在）：一把传输密钥只认一台设备，
    只留签发晚的那张（`portableSocket.ts` 的 `supersedes`；带本机自己密钥的别的设备号一律不算对端），其余当作不在目录里：
    不准入、不拨号、显示离线，但仍记作见过的 Agent-Net 设备，不因此改走 Device Link（2026-11-21）。Desktop 与 Node Host 的
    worker 外层另有一份「见过的设备」，只从收到的目录和路径事件里填，所以 worker 每次报状态时把里层的那份一并带上（`knownPeers`）。原来用这把密钥建的连接记在排在前面的设备号名下；手机的原生引擎按密钥准入，
    遇到重复就拒收整份名单（`DUPLICATE_PEER`），一对重复让这个账号下的手机全都打不开 Agent-Net。真机：一台 iPhone 换了设备号
    重新登记后，另一台安卓手机每次打开都失败，改后照常连上其余电脑。故障半径：① 证据是两张都由本账号根密钥签发、传输密钥相同的证书；
    ② 只是不认被顶替的那一张，别的设备的准入、连接、重试与时限都不变；③ `portableSocket.test.ts`
    「keeps only the latest certificate of a transport key …」，`socket.integration.test.ts`
    「keeps a device id superseded for sharing a transport key known through the worker …」。
  - Node Host 回复「支持后台链路」、连接前等读本机身份（最多 2 秒）改成只在开着 Agent-Net 时生效，关着时和主干一样。
  - 主干的部分目录（只读到一条腿时并回上次完整目录）也按 Device Link 设备列表过滤；Agent-Net 后台读设备列表走主干的共享限流账（`officialDeviceListFetch`）。
- **第三轮（2026-11-17 补齐兼容与恢复能力）**：断线续传（在途的写在重开的链路上用原请求号找结果；代次改变或双端未协商结果恢复则不发，记录已淘汰则报告可能已执行）；
  会话回来时自动重开断在上一条会话上的控制链路（`reopenLink` → `transportTimeoutReopen`）；中转断开超过 10 秒时连接问题 `agent-net-relay-down`
  （设置页即使状态是已连接也显示）；关链、大请求的先后；积压读数含核心缓冲；词典同步走会话。协议见
  [会话层记录](protocol-compatibility/agent-net-session.md)。故障半径（断线续传）：① 证据是这个对端的会话断了、请求已写出；② 只等这条请求自己的时限，
  只在本机还在控制、链路在新会话上重开、对方去重记忆没变时再发一次，重开走原有循环（退避、去重、每次尝试前复查授权），不碰其它对端与 Device Link；
  ③ `agentNetSessionLinks.test.ts`「sends a write that was in flight when the session broke again」与「does not send a write again once the re-opened
  link says the peer no longer remembers it」，`deviceLinkDispatch.test.ts`「keeps the invoke memory marker across a disconnect」。
- **第四轮（2026-11-18 桌面与 Host 收尾）**：会话请求与建链的诊断日志；拓扑页随 Agent-Net 路径（`onAgentNetPathChange`）
  与中转连接变化马上刷新，中转往返时间取中转连接的 ping（`AgentNetWorkerSocket.relayRttMs`）；Node Host 的名册缓存（`directoryCacheFile`，
  与 Desktop 共用 `agentNetDirectoryCache.ts`）；Host 兼容连接的连接问题（`RoutedDeviceLinkClient.onLegacyConnectionIssue`）：401 刷新令牌、
  状态里显示 `agentNet.compatibilityIssue`。Host 主线路断开时，MCP 应用视图和 OAuth 调用者也按线路归属清理，保留兼容线路上的调用者；
  关闭远程控制仍清理两条线路。见 `apps/host/src/device-link.test.mjs` 的双线路回归。跨账号断线续传（会话断时有请求在等就请业务重开，故障半径同上一轮：只等请求自己的时限、
  对方去重记忆变了就不再发、走原有重开循环）。回归：`agentNetNode.test.ts`「starts from the device list it saved last time」、
  `routedClient.test.ts`「reports a problem of the compatibility connection on its own」、`agentNetSessionLinks.test.ts`「sends a guest write again
  on the re-dialed share connection」与「fails calls in flight」里的日志断言、`workerSocket.test.ts` 的中转往返。
  故障半径（重拨与换网探测）：① 证据分别是「这一台的连接关了、目录里它在线」与「系统报告换了网络」；② 重拨只拨这一台，对方离线、被拦、本机关闭时不拨，
  失败加倍到 30 秒，连接活过 30 秒才重新从 1 秒算；换网时每条中转连接只 ping 一次，15 秒（和 Device Link 的换网探测同一预算）没回才换，探测期间照常收发；
  不动 Device Link 连接；③ `packages/agent-net/src/__tests__/portableSocket.test.ts`「dials a device of the account again when its connection drops」、
  `workerSocket.test.ts`「replaces a relay connection that does not answer right after a network change」。
回归：`packages/device-link/src/__tests__/routedClient.test.ts`「marks a legacy-only phone offline when its connection drops」（兼容连接掉线时，已由该连接报告在线的设备会显示离线，主连接的设备正常），
`apps/desktop/src/main/device-link/__tests__/notifyFallback.test.ts`，`agentNetSessionLinks.test.ts`「reports a new stream per session and keeps
the session generation for its offline event」与「hands the control direction back to Device Link once a re-open lands there」，
`packages/device-link/src/__tests__/client.test.ts`「Agent-Net 下层可靠：等入站链路确认时对端仍在送数据就再等，安静后复位这个对端」。

故障半径三问：① 证据是这一个对端的会话：它的连接断了、对端重建了节点、授权变了，或对端关了链；不等于中继离线，
也不影响走 Device Link 的其它对端；② 只作废这个对端的会话链路：按 Device Link 的离线事件（同一连接代次与链路代次）通知业务，
由业务按原有恢复路径重开；在途调用里没写出去的报 `LINK_NOT_OPEN`（可重开再发），写出去以后丢了的，幂等读报 `PEER_RESET`
（重开后重读一次），其余报 `DEVICE_OFFLINE`（不重试，避免重复执行）；不重建主连接、不清其它对端的状态，会话层自己不重发；
③ `apps/desktop/src/main/device-link/__tests__/agentNetSessionLinks.test.ts` 用两个真实会话验证断开时读与写各自的错误码与离线事件、
Device Link 链路等恢复时不改走会话、空闲时建链前的调用也走会话、结果按来路回去、身份比较仍成立、刚连上时等会话且只在宽限期内等、
还没连接时先拨在线的对端（不在线的不拨、拨不了的不等满）、对方签名开着 Agent-Net 时的重开等它的会话（没有会话层的旧版不等满）；去掉对应处理时失败。
`packages/device-link/src/__tests__/routedClient.test.ts`「lets the host re-open a peer that prefers the main connection on its own channel」验证钩子接手与退回主连接，
不提供钩子时原有用例不变。新旧版本、没打开 Agent-Net 的电脑不宣告会话能力，照旧走 Device Link；手机见下文「手机」，跨账号见下。
Node Host 打开 Agent-Net 后用同一套会话层与选路（`apps/host/src/device-link.ts`，身份与节点在 Electron 无关的
`apps/desktop/src/main/device-link/agentNetNode.ts`）。它加入过 Agent-Net 以后，同账号的电脑认得它、要求旧版链路带它签的
传输方式声明，所以 Host 关着 Agent-Net 时也用存下的身份签「现在没开」（和 Desktop 一样）；从没加入过的 Host 不签，对端也不要求。
证书只在开着时续期，关着超过有效期后 Desktop 与 Host 仍用自己的私钥签「没开」，对端只对这一句接受过期但仍在签名名册里（没被撤销）、
也没在 Device Link 里删掉的证书（`agentNetTransportStatement.ts`，2026-11-17 用户选「放宽校验」；原来两周后连 Device Link 都被拒收）。
回归：`agentNetNode.test.ts`「signs relay links with its stored identity while Agent-Net is off」与「still says "off" after its certificate expired
while off」（过期后仍签「没开」；对端不收过期证书的「开着」、删掉的设备、别的请求或接收方、别的网络根）。
超时不再执行：`packages/agent-net/src/__tests__/sessionLanes.test.ts` 用假时钟验证断网后请求比取消先到、会话第一条请求取消先到两种情况都不交给业务，
去掉晚到判断、取消的记录或发送任一项时失败；只作用于这一条已经超时的请求，不关会话、不影响其它请求。

**跨账号（2026-11-16，方案第三步）。** 供应商分享（含供应商组的执行电脑）与共享任务的受邀者也走会话：会话开在委托里的连接上
（受邀者凭证的连接，或本机分享资源所在的那条连接），键是 Device Link 分享帧解出来的同一个逻辑对端，由委托决定、不由消息决定；
会话是单向的（受邀者只能建链、调用、关闭，分享资源一端只能接受、回结果、推送、关闭），对方越界的消息不交给业务，本端越界的调用报
`FORBIDDEN`；每条消息收发前都复核委托仍有效、仍是同一资源与成员。会话只认这个资源在 Device Link 那边登记的那条连接
（`agentNetSharing.ts` 的 `installRoute`，和路由客户端的 `acceptsScopedEvent` 同一条规则：停用、已退出、登记被收回的资源没有会话；本机还没登记的
只认主连接，执行电脑和拥有者是从受邀者第一次建链才知道这个分享、再登记的），线上编码和 Device Link 给跨账号的一样：
不用结果缓存、列表与历史增量、推送压缩。资源专用连接只开委托里的会话（`delegatedOnly`），同账号控制不会经它进来。
按对端取连接（`connectionFor`）拿到的是那条分享连接，状态、代次、等上线都看它，只有链路状态换成会话上的；离线事件带它的代次。
受邀者的分享连接用到时才拨，所以第一次建链前先连上对方电脑（`connectSession`，最多 8 秒，Device Link 那条路本来也要等这次拨号），
连上后会话没到再等上面的宽限期；对方是旧版（连上了不宣告会话）、连不上，到时都照旧走 Device Link。
同样跟着「Agent-Net (Beta)」开关：资源专用连接打开时开关开着才启用会话（开关一变，分享连接整批重建）。
故障半径同上：只影响这一个受邀者成员与这一个资源的会话；撤销、暂停、移出成员时连接被关，会话随之作废，业务收到离线事件后按原路径处理。
回归：`packages/agent-net/src/__tests__/socket.integration.test.ts`「carries %s requests with host-signed member scope」在真实核心、中转与分享授权上
验证两种资源的会话键、建链、调用、推送、反向调用被拒、同账号设备在资源连接上没有会话、撤销后两端会话都没了；
`sessionLanes.test.ts`「keeps a session inside a delegation one-way」验证两个方向各自越界的消息不交给业务；
`agentNetSessionLinks.test.ts`「carries a guest link to a shared provider」验证第一次建链先连上再等会话、线上不压缩、按对端取到的连接与离线代次；
`agentNetSharing.test.ts`「lets a cross-account session through only where the routed client accepts that resource」验证停用、已退出、
登记被收回的资源没有会话，没登记的只认主连接，去掉任一处登记时失败。2026-11-16 两个账号的两台电脑隔离验收共享任务：受邀者第一次建链等了 91 毫秒拿到会话，
打开、读历史、发消息、回复实时推回都走会话；主人移出成员的同一秒两端会话作废。

**手机（2026-11-18）。** 手机在 `apps/mobile/src/device-link/DeviceLinkContext.tsx` 用同一套会话层与选路，但只在这台手机能用
Agent-Net 时（开关开着，或路由只走 Agent-Net）：这时业务拿到的是 `routeSessionPeers` 的 `PeerLinks`，原来的 `RoutedDeviceLinkClient`
留作 `routed`。没开 Agent-Net 时业务直接拿 `routed`，不经会话层，和原来一样；开关一变客户端整个重建（偏好代次在 effect 依赖里）。按身份比连接的地方（各连接的代次、补回未完成回复、
按连接列对端、跨账号与分享连接的上线）用 `routed`，因为对会话上的跨账号对端选路层给的是那条分享连接的视图。分享连接绑在 `routed` 上。
会话断了又回来（`reopenLink`）时，按 Device Link 单个对端传输重置的同一流程恢复这个对端。故障半径三问：① 会话断开不是这台电脑离线
的证据，只作废这个对端的建链缓存与订阅确认；② 只排这一个对端的恢复，不重连共享连接，不动别的对端与在线状态；③ 一个对端的会话
出错不关别的对端的会话，也不关主连接与分享连接。

### 共享连接静默与请求隔离

正常状态的共享 WebSocket 同样按物理数据帧限制突发：`DeviceLinkClient` 的首发、ACK 后排空、
定时 drain／重传、直连回退和裸回包逃生共用每 25ms 滚动区间最多 64 帧的预算，按活跃 relay peer
公平分配。同一轮同步执行也最多写出 64 帧；同步生产者即使运行超过 25ms，也须先让出事件循环
才恢复这一轮额度，预算复位与连接停止时清理唯一的让出计时器。原子分片可超过单 peer 份额，
但不能借未来信用突破连接预算；计量保守延续至最后一片
真实写入后，失败未写出的片退回预算。等待继续使用原有有界 pending 和 retry timer，只有尚未写出的
突发等待项才临时加快 drain，不增加重试次数或延长已写请求的截止时间。没有可靠 pending 的旧版
数据路径达到预算时返回既有 `BACKPRESSURE`；已保留可靠副本的裸回包仍保留原副本。
认证完成后因数据预算尚未写出的旧版帧保留在原认证队列，由原有计时器继续排空；仍复核原请求
期限、取消与签名身份，队列后方的控制帧可以继续写出。ACK、认证、建链、心跳和直连协商信令
不受数据预算阻塞，直连数据及 Agent-Net 的逐 peer 可靠虚拟 socket 不占该物理 relay 信用。
1013／重启后的低速恢复预算继续独立生效，不把正常吞吐永久限制在 8 帧／250ms。

这是本机写出节奏，理论数据帧上限为每秒 2,560 帧，不是服务端确认或端到端 credit：网络缓冲仍可
合并多个短区间，控制帧也占服务端队列，持续慢授权仍可能触发 1013。不得据此承诺消除任意服务端
积压。wire、能力和签名不变，自建中转既有 kind／dst 转发直接兼容，无需升级。
回归见 `packages/device-link/src/__tests__/client.test.ts` 与
`scripts/device-link/reconnect.test.ts`：9 peer ×16 条小消息在修前一次写出 144 帧，真实回环
合包触及 128 帧入口硬边界；修后分段交付、原连接保留，另覆盖原子大包、小 peer、直连及取消。

2026-10-30：Desktop 在业务超时时先检查共享 relay 最近是否仍有入站活动；整条连接
静默时复用现有有界网络探测，不直接累加某台电脑的熔断失败。任一 peer 的有效回包
都能结束探测；只有共享探测本身超时才恢复整条连接。探测期间后台刷新以未发送的
背压结果退出，前台操作继续按原预算执行。Desktop/Mobile（含跨区分享连接）的
`waitUntilOnline` 只订阅状态，所有请求共享当前退避与在途握手，不能因新请求到达而
提前建连或清零退避次数。2026-11-14 假时钟复现：4429/1012 关闭后，80 个请求分五波
在 250ms 内把 socket 数从 1 放大到 6；此前仅 1013 冷却挡住了这一入口。
超时或 stop 仍以 `NOT_CONNECTED` 结束等待；显式前台恢复的 `connectNow` 与系统唤醒的
`restartConnection` 保留原语义，等待请求不会解除睡眠保持期。

这次故障发生在本机到 relay 的整条连接；恢复仅复用该连接已有计时器，不增加请求重放、
不按调用方各建 socket，也不重置其它连接或改变 peer 的权限与恢复策略。
`packages/device-link/src/__tests__/client.test.ts` 的 80 等待者用例覆盖 4429/1012/1013/1006、
下一次失败继续加深退避及恢复上线，另验证等待超时和 stop；已有多 peer 回归覆盖一端静默时
另一端继续工作。无需新增 wire 字段或自建中转适配：握手、设备签名和转发均沿用原协议，
仅客户端发起下一次连接的时机改变，互通由 `@cindy/device-link-relay interop` 验证。

相同的列表读取沿用独立请求和发送前取消／账号检查，一个调用方取消不能拖累另一个。
本次恢复不新增请求合并或应用层重试。回归覆盖两台 peer，一台静默时另一台仍能完成
前台请求且共享连接不被拆除。

设备互联是 1:N 拓扑：被控端与 relay 之间只有一条连接，同账号的全部控制端共用它。
故障域从小到大分四层——单个请求、单个 peer 的 link、整条 relay 连接、**relay 聚合
背压**（第四层：故障原因不是任何单个请求或 peer，而是本机对 relay 的**聚合出站速率**；
relay 以 close 1013 `inbound backpressure` 主动断连，此时任何「立即重连 + 全量重放」
的恢复动作都会立刻复现故障，形成「重连 → 洪峰 → 再被踢」的自放大循环，2026-08-08
线上：两次 1013 间隔 15s，第二条连接只活了 7s，期间控制端全部超时熔断）。修改
`packages/device-link` 或 Desktop dispatch 层的重试／超时／teardown／重连逻辑前，
先回答三个问题：

1. **触发条件是哪一层的故障？** 单个请求失败、单个 peer 停止 ACK、整条连接断开，
   还是 relay 对聚合速率的背压？对第四层，恢复动作除了同半径（连接级冷却/降速）
   外还要问一句：**重连成功后的重放会不会立刻重造触发条件？**
2. **恢复动作作用在哪一层？** 默认选择与故障同半径的最小动作。动作半径大于故障半径
   （如「单 peer 可靠重试耗尽 → 强拆整条 relay 连接」）就是把一台设备的故障放大成
   所有设备同时掉线；确需扩大半径的，必须在 PR 描述里写明理由，且理由要经得起
   「一台手机退后台休眠时会发生什么」的追问。
3. **多 peer 拓扑下测过吗？** 恢复路径改动必须带「≥2 个控制端共享同一被控端，其中
   一个 peer 静默／停止 ACK，断言其它 peer 的 link 与在途请求零感知」的用例。单
   peer 对连的用例验证不了故障放大——单测全绿只说明实现忠实于设计，设计本身选错
   半径时测试不会报警。

可靠发送窗口被不可丢弃帧占满、链路仍 ready 时，只有队头已经实际重发却未获 ACK，才允许
新完成的 `invoke-result` 走既有裸回包格式，由调用端按 requestId 配对。旧 pending、序号与
其它 peer 的链路保持不变，不重发业务操作。绕行仍消耗现有共享 relay 拥塞与 socket 字节预算，
保留签名、路由范围和物理写入检查；可分片但无法单帧发送的结果继续返回 `BACKPRESSURE`，由上层 outbox
等可靠分片容量恢复。绕行不新建可靠副本或重试器，因此不保证断网期间交付，也不代替 1013
拥塞恢复。自建中转原有 kind / dst 转发及设备签名已支持该格式，无需升级中转。

官方中转以 `1012 / service restart` 关闭时，Desktop 与 Mobile 首次重连错开至 1–5 秒，
并沿用更长的既有退避。握手成功后 10 秒内，可靠 relay 帧共用已有的按 peer 发送预算，
握手、ACK 和可用的直连通道照常推进。仅处理被关闭的连接，重发沿用原序号和有效期。
路由修复的其他 `1012` 原因和自建中转现有的 `1001` 停机沿用普通退避。
分享主机重新上线时，桌面额度条错开空视图的首轮重试，同一分享仍合并在途读取。已通过直连读到额度时继续每五秒复核权限。
客户端以已有脱敏标签汇总 relay 首发帧、重放帧和发送前超时，出现重放或未发送超时才输出汇总。

1013 后的共享帧预算不能仅因在线满 15 分钟而解除：在线可能只是节流正在生效。
`CongestionSendBudget` 保留最近一次预算拒绝的单调时刻；既有稳定计时器到点时，须同时满足
过去一个稳定窗口没有预算拒绝、可发送 peer 无待确认／待发送的 relay 可靠消息、socket 已降到低水位。
仍有积压或 socket 压力时延续原窗口，队列已空但近期曾被限速时只等剩余安静时间；满足后
清除拥塞连击与预算，恢复普通吞吐。断链 peer 的暂存结果及直连已写出的 pending 不计入当前 relay 积压，ACK 与控制帧
继续绕过数据预算。不新增业务轮询、请求重放或超时预算。
故障半径：① 证据是共享 relay 的聚合背压；② 只延续该连接的现有发送节流，不重建连接或
重置单个 peer；③ `client.test.ts` 用默认 15 分钟和假时间覆盖积压／刚排空两种边界，
一端静默时另一端仍能完成前台请求，并验证压力消退后恢复普通吞吐。旧端帧格式、能力位和
自建中转转发、签名均不变，自建中转无需升级；互通仍由 `@cindy/device-link-relay interop` 验证。

Desktop 的供应商组原生 Codex 配额卡片与任务配额投影虽然使用不同镜像，仍须共享同一账号的
在途 `maker:usage:codex-rate-limits` RPC，直到底层读取真正结束；不把每个视图的 pending 当成全局去重。
共享键包含持有者代次、设备、供应商与后台优先级，身份清空推送立即退休该键，迟到结果由各镜像的
既有身份／版本栅栏丢弃。只共享在途读取，不增加缓存、定时器、重试或写操作重放；旧端快照回退保持原契约。
`useRemoteDeviceUsage.test.ts` 经真实 Hook 验证跨视图一次读取、慢 peer 隔离及身份清空／A→B→A 边界。

组成员账号列表的变化通知、轮询和重连同样不能各自堆一条新查询。`useGroupMemberAccounts` 将
真实在途 RPC 保留到结束，同一观察范围最多标记一次最新补读；重连／可见性导致 effect 重建时，
同身份仍先等原 RPC，再补读最新列表。变化通知已经取代的旧回包不显示，暂停／移除账号不被短暂恢复。
持有者代次、目标电脑或供应商变化不复用旧读取；隐藏、收起／卸载及身份变化取消旧观察者的补读。
`GroupMemberQuota.test.tsx` 覆盖变化突发与轮询叠加、多个恢复事件、慢 peer 隔离和上述停止边界。

远程 Agent 的 push／工具回包遇到 `BACKPRESSURE` 时，同一执行端的各 run 不能各按自己的
固定退避时间整批重发。每个共享 peer poller 持有一个交付 gate：正常首发保持并发；明确背压后，
仅一个在途 RPC 探测可用容量，失败沿原 500ms～5s 范围共同退避，实际成功回包后逐项排空等待交付，
队列清空再恢复普通并发。退避使用单调时钟，不因校时回退延长。不同 peer 各自恢复，open／call／
停止等业务入口不经过此 gate；原 seq、requestId、uploadId、30 次交付上限和单次 RPC 超时不变。
反向请求的取消资格保留到回包交付结束，取消或任务关闭移除尚未放行的交付，不丢掉其它 run 的队列。
`runClientReply.test.ts` 经真实客户端验证共享探测、工具回包／push 协调、独立 peer、正常吞吐、
取消、原载荷复用与重试上限；此机制不证明最初的共享连接过载只有一个来源。

判例：#1187（2026-07-31）引入「可靠重试耗尽 → 强拆整条 relay 连接」，wire 向后兼容、
单测全绿、多轮 review 通过，上线后一台休眠手机反复把同账号所有设备（含桌面↔桌面）
一起打掉线，由 #1405 收窄止损半径修复。协议兼容、allowlist、单测三层防线对这类问题
全部免疫，只有 review 时点名问「半径」才拦得住。

Desktop 的纯出站链路同样遵守该边界（2026-11-14）：使用 `isolate-outbound` 本地策略，
单台执行电脑不回可靠 ACK 时，仅复位它的 link；Main 将 reset 接入已有的
`transportTimeoutReopen`，每次重开仍复核出站意图、持有者与授权。该策略只用于 Main 已接入恢复的
连接；独立的跨区分享客户端尚未接入此循环，继续保留默认恢复策略。请求沿原可靠 stream/seq
续传，不另行重放业务操作。
故障半径三问：① 证据仅是一个出站 peer 不回 ACK；② 只重开该 peer，不使共享 relay 上的
受邀者和其它执行电脑掉线；③ `client.test.ts` 覆盖 80 个出站 peer 超时后逐一续传，两个健康入站
控制端保持 ready，其中一个的在途请求正常完成。全连接静默仍要求每个就绪 peer 的卡死证据；
未声明瞬时重置能力的旧入站控制端（含互控）继续依赖原整连接重连，不能丢掉它唯一的恢复入口。
本地策略不改变 wire 格式，旧执行端与自建中转沿用既有 link-open/accept 和签名转发，无需升级。

### 账号级状态快照的出站整流（2026-11-14）

2026-11-10~14 被控端日志：手机网络一卡，调度运行诊断（`maker:schedule:event` 的
`runtime-state`，每帧约 1 KB、零点多条自动化同时认领时一次几十帧）和同账号用量快照
（`usage:*-changed`，同内容最多 13 帧）逐帧占满对端的可靠窗口，控制端在等的
invoke-result 被拒为 `reliable transport buffer is full`（iPhone 345 次）。

Desktop dispatch 对这类「整帧替换、无副作用、控制端可重读自愈」的快照按
channel + 键（运行诊断单键；带 `providerId` 的用量按账号）做 latest-wins 暂存，
窗口占用达到会话活动同一软上限时停止灌入并退避，见
`apps/desktop/src/main/device-link/latestStatePushStage.ts`。驱动刷新与未读的调度事件
（fired、completed、read 等）、增量补丁和通知类推送不进暂存，保持逐帧与顺序。
新增条目须论证上述三点；只在发送侧调度，不改 wire 格式，旧端与自建中转无感。

故障半径三问：① 证据是单个控制端的可靠窗口占用；② 动作只作用于该控制端的暂存，
同键新值替换旧值、终态保留到写出或该端退订／离线，不重置 peer 或连接；
③ `dispatchWeakNetwork.test.ts`「账号级状态快照」用两个控制端验证一端窗口占满时
另一端在 250 ms 合并窗口后照常收到最新快照，恢复后每键只补发最新一帧。

### 直连优先、中继兜底(同账号设备)

产品要求：Device Link 的设备间功能(含手机)在两端已授权、网络实际可达时优先直连，
直连失败、超时或中途断开时自动改走 relay，不能让功能卡住，也不能重复执行命令。
选路与兜底在 `packages/device-link` 统一实现(`directPath.ts` 与 `DeviceLinkClient`)，
`directNegotiation.ts` 在双方可靠链路确认后自动协商，平台提供数据专用 WebRTC runtime，
由统一协商层调用 `attachDirectPath`，不要求用户手工建立通道。

- **分工**：relay 仍是控制面——登录、在线状态、账号归属、link-open/accept/close、
  链路确认 ACK 都只走 relay。直连只承载已建立可靠链路上的 reliable-transport 帧
  (invoke / invoke-result / push)及普通累计 ACK。可靠层按 seq 去重、按序交付，
  同一条消息经两条路径各到一次也只执行一次。
- **授权**：直连帧的来源取自通道绑定的设备，不信任帧内 `src`；被控端照常逐条复验
  被控开关、撤权名单与 allowlist。共享任务不走本段同账号直连；供应商分享遵循其
  独立短期许可合同，不能混用本段保留窗口。Desktop 对已完成认证与可靠握手的同账号数据通道，遇到本端
  relay 断线或对端离线通知时保留最多 30 分钟；不以信令离线认定数据通道死亡。
  此窗口同时受墙钟与单调时钟约束，重复离线通知、重连失败和业务流量均不续期。
  不能离线建链或扩大权限；本地逐请求授权照常核验，显式关闭、撤权、停止、设备移除、
  鉴权拒绝和数据通道故障立即清理。仅服务端掌握的撤销在信令不可达时可能延迟获知，
  最迟按窗口到期结束。ACK 原路返回，单向失效时发送端不会被困在直连上。
- **故障半径三问**：① 故障层级是单个 peer 的直连通道(通道关闭、写入失败、发送缓冲
  在一个可靠重试基准期内没有下降，或已发出的帧过了自适应 ACK 基准期仍未确认)；直连
  判活不乘 relay 的大消息字节退避，单条大结果也能及时回退；缓冲仍有进展时
  继续等待排空，不误判正常背压；② 动作只撤下这一台设备的直连，把它仍未确认的帧
  恢复为未发送、按 relay 既有恢复预算(先探测一批、收到 ACK 再继续)重发，不重连
  relay、不重建链路，直连的失败不消耗 relay 的重试次数；③ 回归见
  `packages/device-link/src/__tests__/client.test.ts`「直连优先、中继兜底」：两个控制端
  共用同一被控端，其中一个的直连静默，断言命令只执行一次、结果经 relay 送达，另一个
  控制端仍走直连、在途请求与 relay 连接不受影响。
- **接上时接管 relay 上的未确认帧**（2026-11-04）：累计 ACK 只能按序推进。直连接上时
  relay 上若还有未确认的旧帧，经直连送达的新帧在接收端只能缓存、拿不到确认，过了直连
  ACK 基准期就被误判 `ack-timeout` 撤下。实测两台局域网电脑在持续的远程 Agent 流量下，
  直连每次接上 8–10 秒即撤下(一小时 34 次)，流量全压回慢的 relay，最终整轮工具超时。
  故障半径三问：① 单个 peer 直连接上的时刻，relay 上已写出、仍未确认的可靠帧；② 只把
  这一台设备的这些帧恢复为未发送，按既有单趟预算改经直连重发，接收端按 seq 去重、
  只执行一次；不重连 relay、不重建链路、不改 wire，直连随后真的失效仍按上一条撤下并经
  relay 补发；③ 回归见 `client.test.ts`「keeps a new direct path when older relay frames
  hold back the ACK」，覆盖单条及超过单趟预算的多条旧帧，断言每条只执行一次、直连不撤下。
- **接入**：Desktop 复用 `DesktopCaptureWindow` 的隔离数据进程(`mode=direct`)，Mobile
  使用 `DirectLinkTransport.tsx` 的隔离 WebView；二者共用 `directRtcRuntime.ts` 与
  `directRuntimeBridge.ts`。只收集 host ICE candidates（不请求 STUN/TURN），局域网不可达
  继续走现有 relay；协商不阻塞正在进行的业务请求。同账号远程供应商的控制、结果和推送
  复用同一条数据路径。手机退后台、WebView 崩溃、账号/区域切换立即释放旧通道。
- **兼容**：双方都声明 `direct-link-v1` 才尝试。信令以既有 relay push 承载，绑定两端
  当前 stream；旧端、平台尚未就绪或协商失败均继续使用 relay。每对设备只有字典序较小的
  deviceId 发起 offer，失败按 5–60 秒退避；单次协商 15 秒。桌面共享数据进程预算 64，
  同账号设备与分享各预留 8；手机维持 16。满额继续 relay、释放后按公平队列补建；
  候选、等待 offer、失败重试与压力下空闲回收的边界见
  [`protocol-compatibility/device-link-lan-first-direct.md`](protocol-compatibility/device-link-lan-first-direct.md)。
  两端均支持并启用保留、已完成认证与可靠握手且数据通道健康时，才可跨信令断线维持原有路径。
  新版 Mobile 仅在前台保留，退后台释放；未支持或未启用保留的旧端沿用原有断线复位。
  仅保留 RPC 数据通道，不承诺独立文件或远程桌面通道存活。
  不新增服务端依赖、wire 字段或 Mobile 原生依赖/配置。
- **容量恢复的故障半径三问**：① 单 peer 的直连准入满额／协商失败；② 仅该 peer 排队、
  释放直连资源并改用既有 relay，不重开控制 link、不重连共享 socket、不改任务分配或授权；
  只有无在途工作且长期无活动的通道才可在容量压力下让位；③ `directRuntimeBridge.test.ts`
  覆盖共享预算、分类公平、迟到 offer、撤权与回收，`client.test.ts` 验证满额期间请求仍只执行
  一次、名额释放后自动升级且不新建 socket。真实浏览器 `--capacity` 同时验证第 65 个等待者
  补建时其余 63 条通道不被替换；自建 relay 互通验证签名、加入与重连不受影响。
- **验证**：`client.test.ts` 的自动协商矩阵覆盖新旧端、平台不可用、远程 Agent 调用和两个
  控制端隔离回退；`directRuntimeBridge.test.ts` 覆盖桥接背压、迟到事件与流代次；
  `scripts/direct-link-smoke.mjs <Chrome路径>` 运行真实 WebRTC 与手机静态 runtime，验证
  UTF-8 大结果不经中继、断线回退只执行一次、另一控制端继续直连。该浏览器验证不能替代
  iOS/Android 和两台真实电脑的跨设备验收。
  `node scripts/direct-link-electron-smoke.mjs` 另外启动两个临时 Electron 进程，验证生产
  Main/preload/隔离 renderer 的真实 IPC、WebRTC 与中继回退；账号和 userData 均为独立 fixture。

### 各通道的局域网地址与系统权限（2026-11-16）

控制消息、文件、远程桌面各自建立 WebRTC 连接、各自选路，控制通道直连不代表另外两条也直连。
局域网能否直连，先看双方能否拿到对方的局域网地址。Chromium 对没有捕获权限的页面只公布
mDNS 名，解析要靠双方都能收发组播；跨网段、组播被过滤或任一端系统不给局域网权限时，对端
拿不到地址，只能走公网或 TURN。各端公布的 host 候选如下，新增通道时对照补齐：

| 通道 | 运行位置 | 公布的局域网地址 |
| --- | --- | --- |
| 控制消息 | Desktop 隐藏数据窗口 `direct` | 默认路由的真实地址（`default_public_and_private_interfaces`） |
| 文件、附件、远程视频读取 | Desktop 隐藏数据窗口 `files` | 同上；此前只有 mDNS 名 |
| 远程桌面被控端 | Desktop 捕获窗口 `desktop` | 全部网卡的真实地址（含 VPN 网卡与 TCP 候选），由捕获权限带来 |
| 远程桌面查看端 | Desktop 主窗口 | 同上，由受信任页面的媒体权限检查带来 |
| 手机的控制消息与文件 | Mobile WebView | 只有 mDNS 名；iOS 原生视频接收端为真实地址 |

- **数据窗口显式设置策略。** `direct` 与 `files` 不授予任何捕获权限，由
  [`captureWindow.ts`](../../apps/desktop/src/main/remote-desktop/captureWindow.ts) 在加载页面前
  设置地址策略，只公布默认路由的地址、不枚举其他网卡。`desktop` 保持 Chromium 默认：套用同一
  策略会把它收窄到一块网卡，丢掉 VPN 路径。文件信令只对同账号、已开启被控且未撤权的设备开放
  （不在共享任务访客和供应商分享的通道清单里），地址随既有 `device-link:file-peer` RPC 送达，
  与控制通道信令的可见范围一致。
- **一端公布真实地址即可。** 对端只有 mDNS 名时，由它主动连过来，本端按来源地址建立路径
  （ICE 的 prflx 候选）。手机因此依赖电脑端公布真实地址。新旧端混用不需要协商：不改 wire
  协议、能力位和信令格式，自建中转继续透传原 RPC，无需适配。
- **macOS「本地网络」权限。** 没拿到许可的 App（连同它启动的 Agent、SSH 等子进程）向局域网
  地址发起的 TCP 与 UDP 一律报 `EHOSTUNREACH`，连网关也不通；公网与 VPN 网卡不受影响。它仍能
  收到局域网对端先发来的单播 UDP，并在同一个 socket 上回复。所以对端有许可、又知道本机真实
  地址时，ICE 仍能由对端打通：控制通道一直能直连，只公布 mDNS 名的文件通道不能。Info.plist
  缺 `NSLocalNetworkUsageDescription` 时系统不弹授权、直接拒绝；正式包由 `forge.config.ts`
  声明，个人版由 `scripts/personal-build/native-capabilities.mjs` 写入运行时，改动后要用
  更新过的构建工具重新生成运行时才生效。此外，同版本 Electron 主二进制原厂共享同一个 Mach-O
  `LC_UUID`，macOS 27.3 实测（2026-11-26）与开发态 `Electron.app` 或其他 Electron 应用撞
  `LC_UUID` 时，`nehelper` 会静默继承拒绝、不弹系统授权框也不把 Cindy 列进系统设置；两处
  构建入口都在签名前通过 [`scripts/macos-macho-uuid.mjs`](../../scripts/macos-macho-uuid.mjs)
  按 `(bundleId, electronVersion)` 为主二进制写入确定且唯一的 `LC_UUID`。
- **应用内检测与提醒（2026-11-22，2026-11-26 改进）。** Apple 没有本地网络许可的查询接口，也区分不了「未询问」
  与「已拒绝」。Main 的 [`local-network/access.ts`](../../apps/desktop/src/main/local-network/access.ts)
  向物理网卡的默认网关（默认路由在 VPN 上时取 `route -n get -ifscope <en*> default`）发一次
  TCP/53 连接：立即 `EHOSTUNREACH` 判为 `denied`，连通、拒绝或超时判为 `granted`，没有局域网网关
  判为 `unknown`，界面在 `unknown` 时什么都不显示。这次探测在 App 处于前台时也是未决定的 App 触发
  系统询问的方式（后台时 `nehelper` 会跳过弹窗）；为避免把刚弹出的原生授权框顶掉，点击「开启」先将
  窗口拉回前台触发探测并在 3 分钟内每 2 秒复查，不再在 1.2 秒后强跳系统设置。若系统已有决定（不会再弹
  原框），界面给出「打开系统设置」（二次点击支持「在新窗口打开」避开卡页）与「在访达中显示当前 App」
  入口，便于在「隐私与安全性 › 本地网络」打开或通过 `+` 添加。由拒绝变为允许时，Device Link 调用与
  网卡变化相同的 `notifyNetworkChanged()` /
  `agentNetNetworkChanged()`，立即重试直连，不需要重启。缺许可时 LAN 信标收发都被拦住，「对端是否
  在同一局域网」无从观察，所以侧边栏只在两种可观察的代价出现时提醒
  （[`local-network/reminder.ts`](../../apps/desktop/src/main/local-network/reminder.ts)）：用户刚打开
  「允许同账号设备控制本机」（10 分钟内），或 Agent-Net 显示同账号设备已连上却只走中转。关闭提醒
  后，只有再次打开被控开关或出现新的只走中转的设备才会重新出现。设置页「本机」卡片常驻显示该
  许可的状态。IPC `local-network:*` 只给本机窗口，不在远程调用白名单里。Host 客户端模式下 Device
  Link 跑在 Host 进程，本次只接了桌面 Main 的提醒与重试，设置页状态仍可用。
- **故障记录。** 2026-11 两台同一局域网的电脑，控制通道直连，文件却走 TURN（往返 430–580 ms，
  每秒 5–8 KB）。文件连接的统计里本端有 4 个 host 候选，对端一个也没有；其中一台的 App 没有
  本地网络许可，既发不出组播，也不能主动连对端。两处都要修：文件窗口公布真实地址，该 App
  取得本地网络许可。
- **排查顺序。** ① 文件日志 `device-link:filePeer` 的 `stats.candidates`：`remote` 里没有
  `host`，说明对端地址没送到或解析不了；② 在 App 启动的子进程里连网关（`nc -z <网关> 80`），
  报 `No route to host` 而公网可达，说明这个 App 没有本地网络许可，到「系统设置 › 隐私与
  安全性 › 本地网络」核对；③ 控制通道看 `direct transport reason=`，长期只有
  `negotiation-timeout` 而没有 `connected`，说明两端都无法主动连到对方。
- **验证。** [`captureWindow.test.ts`](../../apps/desktop/src/main/remote-desktop/__tests__/captureWindow.test.ts)
  断言两个数据窗口在导航前设置策略、`desktop` 不设置。`node scripts/provider-share-direct-smoke.mjs
  --electron-mdns` 用两个真实 Electron 进程验证：双方都只有 mDNS 名时连不上，任一端公布真实地址
  即可接通并逐字节收发，生产 `files` 窗口的候选为字面地址。Electron 42 / Chromium 148 实测三种
  配置的候选：无捕获权限的默认策略 2 个 mDNS 名；数据窗口策略为默认路由的 IPv4 与 IPv6 各 1 个；
  有捕获权限的默认策略为全部网卡的 UDP 与 TCP 地址。真实两台电脑、手机与电脑、跨网段和 VPN 下的
  文件速度与远程桌面延迟未在本次验证。

### 系统睡眠前主动离线（2026-11-14）

2026-11-10～14 日志：一台合盖笔记本的直连约 300 次「接上就断」，其中 93% 在 3 分钟内伴随对端离线——
是 macOS DarkWake 约 15 分钟一次的短暂唤醒，不是直连本身抖动(其余约 20 次仍由 `directNegotiation.ts`
既有 5s→60s 退避处理)。睡眠中的设备对对端仍显示在线约 1.5 分钟：直连 ACK 超时、回落中继再 ACK 超时、
重置链路、60 秒后弃帧，期间推送和请求全部白等。

Desktop 收到 `powerMonitor` 的 `suspend` 即调用 `suspendConnectionsForSystemSleep`：以 1001 正常关闭本机
各条 relay 连接，relay 随即广播离线；保持期内不排重连，`resume` 的 `restartConnections`、`connectNow`
解除，进程清醒满 `SYSTEM_SUSPEND_RECONNECT_HOLD_MS`(60s，计时器睡眠中暂停)仍未解除时自行重连。

故障半径：① 平台 suspend 只说明本机即将不可达，不推断任何对端状态；② 只关本机自己的 relay 连接，
可靠层 pending 按普通断线保留、唤醒后重放，不改 wire 协议(官方与自建中转对正常关闭都立即广播离线，
自建中转无需修改，`device-link-relay` interop 通过)；③ 不碰对端链路、不影响其他设备，睡眠被取消或
缺少唤醒事件时由清醒时间兜底恢复，不会把本机永久留在离线。验证：`client.test.ts`
「suspendConnectionsForSystemSleep …」。

### 唤醒后远程设备列表的恢复（Desktop，2026-11-17）

现场：MacBook 合盖睡眠一夜，唤醒后 Mac Studio 的请求 1–3 秒成功、手机正常，界面却 40 多分钟显示
「远程设备已离线」，打开任务只有缓存，协同面板「找不到这条任务」。当时走兼容连接的同账号设备，其在线
状态不会交给 host(见下文「在线状态的来源」)，界面判定它可控主要靠一次设备目录读取；唤醒时这次读取失败，
main 退回有界的过期快照，数据通道还没就绪的设备在快照里是 `online:false`，界面据此把它移出合格集，
而所有恢复途径都只看合格集、设备一直在线不会再来上线通知，周期对账又受「5 分钟内有键鼠操作」限制。

`useDeviceLinkRemoteProjects` 的恢复约定：
- 过期目录不降级当前合格的设备、目录读取失败后的有界重读(5s 起翻倍封顶 60s，让过 429 期限，终态失败
  与权威作废后停读)沿用 #9360(#9342)的实现；恢复入口与重读计时器只复用在途的那一次目录读取，不叠加请求。
- 「可达」的正面证据——`PEER_LINK_REOPENED`、该设备数据通道就绪、重复的上线通知、在线 presence——对
  合格但分片未确认在线的设备补一次首拉(复用在途任务)；对已被移出合格集但仍留分片的设备重读目录
  (同一设备至少间隔 30 秒)，不凭证据伪造在线。
- 恢复巡检只对合格、可读、未熔断、分片未确认在线的设备按设备退避(10s→120s)跑完整首拉，不看用户是否
  在操作；没有待恢复设备时计时器停止，首拉未能确认在线或窗口重新可见时再起。周期 anti-entropy 只管
  已确认在线的设备，两条路径不重复拉同一台。
- 远程 Lead 的同机 worker 在协同面板读取前钉到 Lead 的设备(`OrcaWorkerPanel`)，不回落本机。
- 历史视图读取失败上报 `source:'failed'` 诊断(只带错误码)，两端日志都能看出读取是否发出及失败原因。

故障半径：① 故障在单台设备的界面列表状态，链路与中转正常；② 恢复只作用于该设备(重读目录 / 重跑
该设备首拉)，不重连中转、不碰其它设备；③ `deviceLinkRemoteRecovery.test.tsx`「wake-from-sleep
recovery」覆盖过期目录、离线报告后的目录补读、无用户操作的首拉补齐，并断言健康设备请求数不变。
不改 wire 协议与中转行为，自建中转无需同步修改。

在线状态的来源(`RoutedDeviceLinkClient.onPresenceChanged`)：同账号设备的 presence 只取承载它的那条
连接——走兼容连接的设备用兼容连接上的 presence，主连接对它的看法(如新协议连接重建时对尚未建立通道的
设备报的离线)不作数，反之亦然；共享任务 / 供应商分享等范围化 peer 仍只看主连接，兼容连接未运行时
行为不变。此前兼容连接上的真实 presence 被整体丢弃，host 对这类设备只能靠目录读取判断在线，这正是
上面目录读取一失败就卡住的前提。Desktop 与 Mobile 共用该入口；每条连接内部的离线闸门本来就按各自
presence 运作，这里只修正交给 host 的那份。回归：`routedClient.test.ts`「reports each peer's presence
from the connection that carries it」；`device-link-relay` interop 通过，中转无需改动。

## 远程 Agent 的拉取与恢复(`maker:remote-agent:v1`)

控制端载荷交付（2026-11-10）：512KiB 上传块经 base64 后约 683KiB，慢中转链路收齐分片可能超过
单次 invoke 的 30 秒期限；大内联 JSON 也有相同问题。`RemoteAgentRunClient.payload` 按 UTF-8 字节
控制内联大小，超过 64KiB 先 gzip，普通载荷以 64KiB 压缩数据为一块上传。不延长通道超时、不自动重放 `open` 或 `call`。
2026-11-19 起上传块同时在途（取代原来的「每块确认后再发下一块」）：2026-11-18 启动资料 26 块逐块等回执，回程变慢后
每块约 1.6 秒，启动等了 41 秒。被控端从第一版起就按 `(uploadId, index)` 存块、重复的块忽略、引用时才检查是否收齐，
所以不需要新字段或能力位，旧被控端照样收。一份载荷起步 2 块在途，回执快就加一，单块超过 10 秒就减半、最少 1 块；
同一台被控端上所有任务共用 4 个上传名额（不超过 Device Link 每台对端的后台名额，给拉取与交互请求留出调度名额）。
一块遇到链路类错误按同一块号重发，最多 2 次、500 毫秒起倍增退避（被控端去重，重发不多占暂存）；失败、取消或任务
结束后不再发新块，等在途的块结束后报错。全部块收到回执后才发引用它的 `open` / `call` / `reply`，不依赖链路保序。
实现见 `runClient.ts` 的 `uploadChunks`，回归见 `runClientReply.test.ts`「pipelined upload」。
在 Agent-Net 会话上，上传块走后台通道（`sessionLinks.ts` 按 `isRemoteAgentUploadChunk` 判断，只换通道、排队名额不变）：
会话的跨通道顺序让交互请求等普通通道上更早的请求，块放普通通道时停止要排在在途的块后面。Device Link 上照旧按普通
优先级发：它的后台优先级在检查中转连通时直接拒收，块会失败。2026-11-19 经 xdt-server 中转的对照（26 块、每块 64KiB）：
每秒 250 KB 档上传 16.3 秒 → 10.0 秒，期间停止往返中位 0.40～0.42 → 0.24 秒（空闲 0.22 秒；块放普通通道时 1.27 秒）；
每秒 64 KB 档 51.7 → 39.2 秒，停止往返 1.76 → 0.47 秒（空闲 0.44 秒；块放普通通道时 5.6 秒）。回归见
`agentNetSessionLinks.test.ts`「remote-agent upload chunks on the background lane」。
为保留原容量，大载荷会增大块大小以符合旧接收端最多 128 块、每块 512KiB、总共 64MiB 的合同；
这些数值仍是接收上限，不能因发送偏好变小而拒收旧端的大块。既有取消检查继续覆盖压缩与各块之间。
`abort` / `requestGracefulStop` 还会使此前尚在准备或上传的 `send` / `steer` 失效；
压缩后、块间及最终调用前检查同一发送代次，以 `AbortError` 收口，不让停止之后再启动旧消息。
停止请求不排在上传之后，也不关闭连接；停止之后的新消息仍可正常发送。
Session 准备期柔性停止的 `SendOptions.signal` 由本机代理传到同一守卫，不序列化进协议；
已经发出的业务调用保留原结果语义，不能把远端已接收的消息事后改报为未发送。
故障半径：仅改变当前载荷的编码与分块，不重建 link、不重连共享 relay、不改授权或其它 peer 的状态。
回归为 `runClientReply.test.ts` 的有界慢链路完整交付，以及 `roundtrip.test.ts` 的上传中取消。
协议兼容与中转边界见 [远程 Agent 协议](protocol-compatibility/remote-agent.md)。

供应商进程重启（2026-10-29）：已打开的 run 收到 `missing`、`provider-restarting` 或旧端的
`aborted` 时只释放这条远程连接，保留本机执行器和 MCP 身份。空闲任务下次发送再接回；进行中的
一轮通过现有供应商组恢复租约、五次有界探测和输入队列自动续跑一次，未归组的供应商也适用。
原生会话 ID 必须接回，设置必须重放完成，才能发送续跑；不重发原消息或结果不明的方法调用。
权限、Plan 和自动动作来源沿用原轮次；Stop、新输入、归档／删除使恢复失效。持续不可达、撤权或
接不回原生会话保留原错误与人工恢复入口。伙伴、目标模式与共享任务沿用既有自动恢复归属检查。

`remote_agent_restarted` 是以上三类关闭的恢复分类，不证明操作系统进程退出。未完成轮次的合成
错误保留收到的 `remoteCloseReason` 与原 `remoteRunId`，并经现有持久化字段 `sdkError` 保存同一关联；
合成错误只说明远端运行不可用，不把关闭详情放进参与恢复判定的 `message` / `sdkError`，避免上下文
重建、工具或账号错误判定抢占原线程恢复。此前已收到的真实业务错误仍由原终态归属保留，不从这些
关闭信号推断崩溃、OOM 或退出时刻。
仅修改当前 run 的本地错误投影，不增加请求、恢复次数或副作用重放，不影响其他 peer；沿用已有
wire 字段，旧执行端和官方／自建中转无需升级。回归见 `connectionPool.test.ts` 的 first-turn restart 场景。

托管 Claude Code 的工具连接（2026-11-04）：设备托管时 Cindy 工具都是经隧道回到任务所在电脑的
HTTP MCP，每次握手都要跨机往返。Claude Code 默认 `MCP_TIMEOUT` 只等 30s，到点即判连接失败，
这一轮没有任何工具（实测中转变慢时 91 个工具全部被判断开，Agent 只能回复连不上）。托管会话启动时
把它设为 `DEVICE_HOSTED_MCP_TIMEOUT_MS`（120s，与下文拉取的 2 分钟不可达窗口一致），用户自己
设过的值优先。故障半径：只作用于这一个任务的 Claude Code 进程；不重试、不重放工具调用，不动 link
与其它任务，本机任务保持 Claude Code 默认值。回归见 `claude-code/__tests__/device-hosted-guest.test.ts`。

正常退出先经 device-link 同步 quit 回调走 `dropAllControllers('shutdown') → abortAll('app-quit')`；
`host.dispose()` 来自 Maker 重置，不是常规退出必经路径。两条入口共用闲置／忙碌判断，重叠时等待
首次收尾再回收。`dispose()` 返回同一份清理完成 Promise，包含正在启动的任务与巡检已开始的删除；
服务重建后先等待前一 host 的清理，再派发新请求，等待期间再次重建的旧入口不再接单。
启动途中关闭的任务仍计入单设备与整机额度，直到启动完成并关闭晚到的原生句柄／隧道，不能因
收尾事件已发出就提前让出名额。晚到的 loopback 隧道由启动路径关闭；不等待启动来发送收尾事件，
避免启动还在等待控制端回包时互相卡住。回归见 `limits.test.ts` 与 `hostLifecycle.test.ts`。
这只约束本进程 Maker 重置后的 host 交接，不重连共享链路、不改变线上协议。
新版主动断开（`user` / `toggle-off`）发 `controller-disconnected`，控制端映射为
既有 `user-revoked`，不自动续跑或让供应商组换电脑；中转也不发换电脑凭证。旧版 `aborted` 无法
区分退出和主动断开：兼容旧版退出意味着旧版一键断开可能连回一次，关闭远程控制则被权限门拒绝。

分享名单未确认等临时故障可能首先报 `REMOTE_AGENT_SHARE_UNAVAILABLE`，此时也进入已有两分钟
拉取恢复窗口，沿原游标重拉，不重发正文；错误仍携带明确撤权或关闭远控的底层 code 时，不按
临时不可用启动恢复。已经发生链路不可达后临时报 `ACCESS_REVOKED` / `REMOTE_AGENT_SHARE_UNAVAILABLE`，
只保留原窗口，不重置截止时间；首次即撤权、明确暂停／移除与远端撤权终态仍立即失败。恢复只作用于当前 run 的连接与
当前电脑的拉取器，不重连共享 relay、不绕过授权。两控制端共用一个 host 的回归中，一个 run 消失并
重新打开，另一控制端仍能发送、原生会话不变。实现及回归：`remote-agent/controller/`、
`remote-agent/__tests__/connectionPool.test.ts`、`poll.test.ts` 与 `provider-group/service.ts`。

远程 Agent 分享调用层保留拒绝的原始底层 code，供应商策略拒绝保留固定的
`REMOTE_AGENT_PROVIDER_NOT_ALLOWED` 标记；分享专属展示前缀不替代拒绝证据。
首次明确撤权、关闭远控或供应商策略拒绝不会被 `IPC_ERROR + SHARE_UNAVAILABLE` 翻译成临时重试。
回归经 `remoteInvokeSendGuard.test.ts` 的真实分享调用适配器、invoker 与 poller 串联验证。

直连分享任务持久位置仍为 `share:<id>`，该位置代表 O，不等于实际执行电脑 M。重启恢复通过
现有直连句柄向 O 为原 M 申请新许可并探测 M，空闲 run 重开也先完成相同授权，不改选电脑。
断链窗口内的临时拒绝可触发同一授权流程；授权请求不阻塞两分钟截止时间，也不能延长已到期的
本机租约。授权、关停与启动代次复核在异步返回后再次执行，失效请求只释放本次授权代次。
M 仍保存但已撤权的 run 明确收尾为 `access-revoked`，不以 `missing` 触发续跑。
回归见 `roundtrip.test.ts`、`groupRelay.test.ts`、`poll.test.ts` 与供应商组 `service.test.ts`。

离线期间 Stop 仍走 Session 既有的有界中止复核（15 秒）。远程 close 通知失败只记日志，不能把已
清理的本机代理留在运行状态；本机资源清理失败仍须上抛。代理 dispose 同时清空 turnRunning /
preparing，本机 Session 可正常关闭，下一条显式消息按原生会话 ID 重建；不依赖离线电脑确认才能
解除队列占用。回归同时覆盖远程通知失败与本机清理失败，不能把两者混为一谈。

协议见 [`protocol-compatibility/remote-agent.md`](protocol-compatibility/remote-agent.md)「远程 Agent」。恢复策略按故障半径三问：

1. **故障层级**：只处理同一台被控端的事件拉取。`poll` 遇到 peer reset、超时、背压或链路暂断时，
   用同样的游标重拉(0.5s 起指数退避，上限 5s；另一个在途 poll 成功即提前恢复)；连续 2 分钟拉不到
   才结束这台被控端上的任务并提示对方不可达。若该被控端此刻仍在持续向本机送达业务分片或推送（`DeviceLinkClient`
   分片重组期同步更新 `lastBusinessReceivedAt`，慢中转上单个数百 KB 回包堵住队头时对端并非失联），`responsivenessTracker`
   在 90 秒耐心上限内不把并发超时计入 `DEVICE_UNRESPONSIVE` 熔断，`RemoteAgentPoller` 也暂缓推进 2 分钟失联计时（总上限
   `REMOTE_AGENT_CONGESTED_GIVE_UP_MS = 5 分钟`，防止单向刷推送而 `poll` 永久卡死时无限挂起）。本机「目标设备无响应」熔断打开后的快速失败
   (`DEVICE_UNRESPONSIVE`)同样按链路暂断重拉：它不发网络请求，熔断按自己的单飞探测恢复，
   不能绕过两分钟窗口直接结束任务（2026-11-04：一次 1–2 分钟的出口抖动让后台 PR 跟进轮次
   当场失败）。单个任务的流数据与游标对不上时只结束那一个任务。
   重拉时回包大小跟着回程速度走（2026-11-19，`poll.maxBytes`）：超时一次就把下一次要的字节减半，最少 64KiB；
   回包超过 64KiB 时按「字节 ÷ 用时 × 10 秒」定下一次要多少，最多 1.5MB。原来每次都要满 1.5MB，慢线路上一次回包
   在 30 秒请求时限内传不完，超时后按同一游标重拉同样大小，会一直卡到两分钟窗口结束任务（按代码推出，日志里还没见到）。
   旧被控端忽略这个字段，照旧按 1.5MB 回，行为与原来相同。回归见 `poll.test.ts`「asks for smaller polls」、
   `hostLifecycle.test.ts`「poll size」。
   打开或连回 Agent 前的只读 `caps` 查询复用共享瞬态重试策略（最多 6 次），等待启动建连或拥堵冷却
   结束；授权拒绝、旧端不支持等非瞬态错误立即结束。只重读这台电脑的能力，不重建 link、不重启 relay，
   不重放 `open`、上传或发送。回归见 `remote-agent/__tests__/connectionPool.test.ts`。其余 op 不自动重放。
   已发送的 `call` 有两条独立的回传路径：请求回执和现有轮询里的 `result(callId)`。请求回执超时时，
   控制端采用同一 run、同一 callId 已收到的执行结果；结果尚未到达时再等最多 30 秒。到期仍无结果就保留
   原超时错误。整个核对过程复用现有轮询，其他任务的游标与重试预算照常。回归见
   [runClientReply.test.ts](../../apps/desktop/src/main/remote-agent/__tests__/runClientReply.test.ts)。
   设备熔断的 `DEVICE_UNRESPONSIVE` 也属于瞬态错误：`poll` 保留原游标与原两分钟窗口，
   等底层既有单飞探测恢复；注销 run 取消后续重试。共享判据同时让 `reply` / `push` 在原有
   交付次数上限内重试，复用原 requestId／载荷或 seq／帧，不重新执行工具或重放 `open` / `call`。
   首次授权拒绝仍立即结束，断链后分享临时拒绝沿用上文既有窗口。回归见 `poll.test.ts`
   （两控制端共用被控端，一侧熔断、另一侧继续拉取）及 `runClientReply.test.ts`。
   此分类不改变帧、授权、选路或中转实现，官方与自建中转都沿用既有 `poll` / `reply` / `push` 转发。
2. **动作层级**：与故障同半径——只影响这台被控端的拉取器，不重建 link、不断开 relay、不影响其它
   被控端和普通远控请求。被控端侧对无人拉取的任务按任务超时(3 分钟)收尾，不波及其它任务。
3. **多 peer**：被控端按 `(控制端, runId)` 隔离任务；默认每台控制设备最多 16 个任务、整机最多 64 个，
   主人可在「远程与分享」调整（最多 1000）。控制端每台被控端一个拉取器，每次 `poll` 最多带 64 个任务，
   按整批轮转，挂起最多 10s，长等待同时在途最多两个；另留一个补位名额给没有被在途 poll 覆盖的任务，直到
   普通 poll 接手(未覆盖任务排在最前并继续轮转)。补位 poll 最多等 1s，让后续新增任务也及时入列；合计不超过 3 个，
   不占满共享的 12 个在途配额。
   补位名额解决的是：两个长等待都只含空闲的旧任务时，新任务的第一个事件及后续事件要等旧长等待超时 10s 才有人拉，
   正好撞上 Codex 执行环境 initialize 握手的 10s 上限(2026-10-22 调查)。
   `poll.test.ts` 用 130 / 1000 个空闲任务验证拉取间隔始终短于 3 分钟的回收期限，并复现上述新任务等待。
   被控端连续立即返回空结果时控制端放慢到 1s 一次，防止空转。2 台控制端共享被控端、
   其中一台静默的回归仍需在双实例实机验证中补测。

账号边界关闭远程 Agent 句柄时，通知对方关闭与释放本机资源独立进行。关闭通知失败只记录日志，
不能作为本机 PI 进程残留阻断换号；本机执行器、MCP 身份与执行环境中继的清理必须等待完成，
失败仍向上传递，并让重复关闭共享同一清理结果。通知失败后，成功关闭本机句柄不代表远端进程已退出：
运行端无人拉取超时使用 `navigation` 收尾父会话与隧道，PI 的此类关闭可能为持久子代理保留代理租约，
不能作为子代理全部停止或模型用量已停止的保证。控制端换号不替换运行端的供应商凭证；运行端自身
换号仍须执行其账号边界保护。本次不新增跨账号重试，也不重建 link 或 relay。
普通关闭和连接池让出仍报告远端关闭失败；
本机与 SSH PI 的账号边界保护不变。实现见 `remote-agent/controller/{proxyHandle,startRemote}.ts`，
不改变 wire、授权检查或跨端版本要求（#6921）。

**控制端连接池的让出与连回**(2026-10-17，协议见 [`protocol-compatibility/remote-agent.md`](protocol-compatibility/remote-agent.md)「控制端连接池」)：

1. **故障层级**：B 的单设备名额(`caps.maxRuns`)快满或已满，或 B 以名额类 `REMOTE_AGENT_BUSY` 拒绝一次 open；只涉及这台 A 在
   这台 B 上的连接。
2. **动作层级**：与故障同半径——只结束这台 B 上一个不忙且闲置满设置时长的 run(`close`)，本机部分与对话记录不动，不碰 link、
   relay、拉取器与其它 B；被拒后只重试一次，没有能让的就按原错误返回，不排队、不循环。连回只在这个任务下一次要 Agent 干活时发生，
   连不回(B 离线、仍满等)保持已让出、按原错误报给用户，下次发送再试，不自动重放；发送路径上 Maker 会按通用发送失败关闭句柄，
   本机后台命令随之结束，对话由下次发送重建时接回(已知限制，见协议文档同节)。
3. **多 peer**：B 按 `(控制端, runId)` 计数，A 的计数只算自己的连接；多实例、别的设备的占用与 B 刚改的上限都可能让 A 的计数不准，
   因此 A 不据此拒绝打开，只据此决定要不要先让，最终以 B 的裁决为准。闲置时长按 B 主人在「远程与分享」设置的
   `caps.idleReclaimMinutes` 判断（默认 30 分钟）；旧版 B 没声明或主人设为 0 时三条路径都不让，与没有连接池时一致。

**托管 Codex 的关键线程 RPC**(#5764)：Agent 所在电脑上的 Codex 经 exec-server 逐个读任务所在电脑的
项目说明与 Skill，`thread/start` 实测约 35 轮串行往返，耗时 ≈ 轮数 × 链路往返，慢链路下合法地超过
`CRITICAL_THREAD_RPC_TIMEOUT_MS`(60s)。`thread/start`、`thread/resume`、`turn/start` 因此在任务隧道
还有往来(Agent 发出的 exec-server 消息、执行环境的回复或 Cindy 工具请求；执行环境主动推的后台命令
输出不算，Agent 卡住时它照样会来)时顺延，隧道连续 30s 没有往来或从发出起满 5 分钟仍按超时收口；
没有往来记录的会话(非托管、旧接线)保持固定 60s。只作用于这一个任务的这一次等待，不重试、不重放、
不动 link 与其它任务。诊断：超时错误末尾带 exec-server 请求/回复数、最早未回复请求与等待时长、
往返均值与峰值、最近一次往来距今多久(Agent 所在电脑的隧道记录，`host/linkActivity.ts`)；任务所在
电脑的中继在首次回推超过 2s 时记一条日志，任务结束时有慢回推或闸门拒绝再记汇总
(`controller/execServerRelay.ts`)。回归见 `codex/app-server/client.test.ts`、
`codex/__tests__/device-hosted-guest.test.ts` 与 `remote-agent/__tests__/linkActivity.test.ts`。

**托管 Codex 启动的跨机往返与执行环境恢复**(2026-10-22 远程供应商调查：启动 277 次串行文件操作、每次跨机
0.5–3s，启动几分钟、撞 5 分钟上限；握手失败后「能聊天但没有 Shell 与文件工具」)：

- **POSIX Agent → Windows 执行端的沙箱实现**（2026-10-28 真机）：固定 Codex 0.159.2
  从 macOS 发出受限权限时携带 `windowsSandboxLevel=disabled`，Windows 原生 exec-server
  因无法落实沙箱意图拒绝所有命令。控制端只把这种跨平台、`permissions.type=managed` 的
  disabled 选择映射为 Windows 原生 `restricted-token`；权限条目、网络设置、Cindy 本机授权
  闸门均保持原值，显式 Windows 选择和非受限请求不改。原生实现不能落实 deny-read 等规则时
  仍拒绝整个请求，不删规则、不转无沙箱、不重放命令，不安装 MXC、创建系统账号或改防火墙。
  这是 Windows 原生受限令牌的边界，不声称其网络隔离等同 macOS：网络约束沿用该原生实现。
  故障只影响这个任务的执行请求，不重启 device-link、不撤下其它 peer。回归见
  `remote-agent/__tests__/execServerProjection.e2e.test.ts` 的真实原生进程及
  `executor/__tests__/virtualWorkspace.test.ts`；临时文件和权限验证均限制在测试目录。
  Windows 的 Store/MSIX PowerShell 无法在受限令牌下启动（真机 `CreateProcessAsUserW`
  错误 `-1073283067`）。同一跨平台适配只在原生声明此类 Shell 时，优先宣告现存的
  非 Store PowerShell 7，否则使用现存的系统 Windows PowerShell；先解析真实路径排除
  指回 Store 的别名。没有替代时保留原声明并明确失败，不改系统 PATH、不下载或安装 Shell，
  不改用户显式命令及其它 Agent 的 Shell。原生回归必须按 initialize 宣告的 Shell 真正执行。

- **不可能存在的路径在 Agent 所在电脑直接回答**(`host/execServerShortcut.ts`)：Codex 沿工作目录逐级向上找
  `.git`、Skill 目录与插件清单。镜像根内的虚拟垫层(真实根目录以上的 `workspace/p/…`)及镜像根本身在任务电脑没有
  对应目录(已映射的工作区及真实上级、`home`、`tmp`、`additional` 除外，见 `controller/startRemote.ts` 的
  `shadowAliases`)。镜像根外的绝对路径会原样转发，可能在任务电脑真实存在；只能按任务电脑明确报告的原始绝对路径
  标记缺失来回答，不能凭点前缀判断不存在，两端路径格式不同时不套用原始路径。可确认不存在的 `fs/getMetadata`、`fs/canonicalize`、`fs/readFile`、
  `fs/readDirectory` 由隧道直接回 exec-server 原生的不存在错误(`-32004`，Codex 按 NotFound 处理，固定 0.159.2
  源码与实测)，不进事件流；其余照常转发。
  工作区的**真实上级目录**在任务所在电脑上存在，Codex 在每一级查 `.git` 与三种插件清单(实测每级 6 次，项目在
  9 层深处时 54 次)。任务所在电脑打开任务时报来各级有没有 `ANCESTOR_MARKER_NAMES` 里的名字(`open` 的可选字段
  `ancestorMarkers`，`controller/projectFiles.ts` 的 `collectAncestorMarkers`，只看名字在不在、查不准按「有」)，
  报了「没有」的同样在本机直接回答；报了「有」、没报的级别、工作区本身照常转发。名单以这次打开时为准，任务连回
  时重新报一次；任务进行中有人在上级目录新建 `.git` 等，要等连回后 Codex 才看得到(上级目录很少在任务中变化)。
  故障半径：只改这一个任务隧道上的只读查询，不动 link 与其它任务；`ancestorMarkers` 是可选字段，旧被控端解码时
  丢弃、旧控制端不带，都退回逐个转发。回归：`mirror.test.ts` 用真实隧道、控制端映射与磁盘核对「本机回答的路径
  在任务所在电脑上确实不存在，存在的照常转发」；`plumbing.test.ts` 核对格式不对整段丢弃。升级 Codex 时核对
  `-32004`、查询方法名与上级目录查找的名字。实测(2026-10-22，Windows 本机真实 Codex 0.159.2，临时项目含
  3 个 Skill，poll 与 push 各加 100/400ms 延迟模拟链路)：启动转发消息 173 → 105(只回答镜像内垫层)→ 41
  (再加已确认缺失的上级标记，含 1 条 initialized 通知)。模拟约 200ms 往返时启动 16.1s → 9.7s → 4.5s，
  约 800ms 时 56.8s → 34.9s → 15.5s；每组单次，计时到启动句柄返回，不含首个模型回复。先前 244 → 82 → 28
  的样本使用了镜像外点前缀推断，审查修复后不再作为最终代码数据。剩余包括工作区、真实 Skill 与未确认的外部查询。
- **执行环境断开后自动重新登记**(`codex/index.ts` 的 `repairHostedEnvironmentIfDisconnected`)：首次握手失败的
  环境，Codex 只记一次结果、之后每轮都跳过，链路恢复也不会自己重连。每轮 `turn/start` 前，隧道上已没有开着的
  WebSocket 连接(`linkActivity` 的 `wsConnectionsOpen` 为 0)时问一次 `environment/status`；`disconnected` 或
  `unknown` 就按同一个 id 再 `environment/add`，这一轮带上的环境选择换成新连接(Codex 的
  `failed_resolution_is_replaced_from_the_environment_manager` 同一路径)。连接开着时不发任何请求，正常发送不多一次
  往返；查询或重新登记失败只记日志，照常发送。回归：`device-hosted-guest.test.ts`。
- **第一次启动期间删除或归档任务就让对方停下**(`controller/startRemote.ts` 的 `cancelPendingRemoteStart`，由
  任务的运行期清理调用)：在第一处异步准备前登记取消状态；MCP 准备期间被取消的，准备完成后释放资源、不发 `open`。
  已开始连接时控制端把连接标成已关闭，已发出的打开立即 `close`；被控端收到后不再换电脑、不再启动，
  迟到完成的 Agent 立刻关闭。此前启动阶段没有取消入口，对方会在几分钟后仍启动并跑完这一轮。回归：`roundtrip.test.ts`。
- **诊断**：任务所在电脑的本机 exec-server 首次输出超过 2s、或进程自己退出时记一条(退出码、信号、stderr 字节数、
  运行时长，不记内容)；供应商组中转的一批帧排队加推送超过 2s 时每个任务记第一次(排队与推送两段耗时)。

## 协同远端 Worker 的轮询与恢复

协议见 [`protocol-compatibility/orca-remote-worker.md`](protocol-compatibility/orca-remote-worker.md)「协同远端 Worker」，实现见
`apps/desktop/src/main/maker-ipc/orcaRemoteWorkerRuntime.ts`。按故障半径三问：

1. **故障层级**：单台运行设备的单个请求。轮询或派活失败只把这台设备标为「暂时无法获取状态」，
   Worker 不判失败、不重派；下一轮成功即恢复，并按消息 id 补报缺失的回报。派活时设备不可达直接失败，
   不排队、不重试；`enqueue` 前保存派活身份，回执丢失时先核对投递回执，不盲重发。
   重启后恢复待回报身份；unknown 回执须核对历史，有限轮次仍找不到时明确报告执行未确认。
   Lead 的 accepted 权限／状态复核在未冻结身份落盘后、远端持久入队前完成；复核后再次核对
   owner 与派发代次。拒绝不发送，并恢复旧等待身份；明确投递失败回滚 accepted 暂存，结果
   未知沿用投递对账，不按未发送回滚。回滚落盘失败记日志并保留原始拒绝原因。
2. **动作层级**：只影响这台设备上的远端 Worker；不重建 link、不断开 relay，不影响其它设备与普通远控。
   结束时先确认停止并落盘，再发 release；重连或 5 分钟补发只继续未完成的阶段。
   清理共用单 Worker 入口并读最新阶段，不能因迟到快照重复停止用户后续的普通任务。
   open 丢回执时用相同 sessionId 核对一次；无法确认的创建身份落盘，恢复后只解除未关联任务的标记。
   同 ID 核对要求来源匹配且任务仍为 active；归档或软删除返回 PRECONDITION_FAILED，不复活或
   关联任务，保留创建收据供只解除标记的孤儿清理。该检查不改变其它设备与普通任务的生命周期。
   普通启动错误也可能发生在任务落库之后，不能据此删除 open 收据；只有通道拒绝或明确 ID 冲突
   且没有先前在途 open 时直接清理。其余错误沿用单任务核对，不停止任务、不拆链路。
   清理与 Worker 关联共用任务锁，锁内复查归属；公开写操作和迟到回调均核对数据库 owner。
   本机代理任务行只在关联时创建，与 Worker、运行设备路由和 open 收据同事务提交。
   未关联即退出时没有本机半成品代理，恢复只按 open 身份解除远端标记，不派活也不复制任务。
   派发、恢复与本机启动检查等待当前 owner 的路由恢复；数据库读取失败不得回退到本机。
   创建回滚归档代理并释放名称与名额，但保留未释放路由；重启后继续 stop/release，确认后清理。
3. **多 peer 与负载**：每台设备每轮只发一次 `maker:list-active`，有待回报时 2s 一轮，否则 15s 一轮；
   按派活输入 clientId 读取对应回复（user / assistant 历史分页）与投递回执，只针对仍在等待回报的 Worker；
   每轮最多扫描 2000 行，预算用尽保留游标下轮续读，不累计“缺少回复”次数。后续插话的回复与 terminal
   状态不归给此前派活。宿主 accepted 生命周期完成后冻结回报身份，保存结果期间的新派活不被旧收尾消费；
   accepted 回调失败则恢复上一代等待状态并继续上抛原错误。同一 Worker 的派发及 accepted 生命周期复用
   现成 session 发送锁串行执行；其它 Worker 不受阻塞。多台控制端共享同一运行设备的回归仍需实机补测。
   已有多设备单测覆盖一台离线时另一台仍能回报；同 owner 的启动恢复幂等，不清空现有派活。

   运行设备的 `INPUT_ENQUEUE` 也承载远端 Orca 自动派活，不能一律当作用户显式输入。
   规范化远控载荷的自动来源意图只用于保留崩溃恢复队列的暂停，不授予来源身份或权限；
   本机、手机和另一台桌面的普通用户输入
   仍可解除恢复暂停，用户 Stop 暂停保持不变。只影响该任务，不重建 link 或 relay；
   内存回归运行实际 IPC handler 与 coordinator，覆盖持久队列、clientId 去重以及另一控制端的其它任务。

   **已知未修复缺口**：远端 queued 派活仍提前执行 accepted/commit，并把旧、新输入合并为同一待回报身份，可能阻塞或覆盖旧轮次回报，也会提前清除手动中断标记。
   修复需要将 active report 与未消费投递分别持久化，并覆盖连续轮次、撤回、未知回执、accepted 回滚与重启恢复；仅延迟两个回调不能补齐这个缺口。

   **收尾未修复缺口**：abort 不清除持久队列，release 后的未消费 Lead 派活仍可能执行。
   当前远控入队剥离 Orca 语义来源，来源设备不足以区分自动派活与同设备用户输入；本轮不清空
   整队列或只删最后一个 clientId。后续须补可持久核对的投递归属及释放边界，取消只作用于该
   Lead 的未消费派活，保留用户消息；覆盖混排、消费竞态、丢回执、重启及其它控制端。

## 共享恢复与请求策略

Desktop 同账号互控的双向请求共用一个 peer 链路。对端 relay 重连清掉订阅登记后，
可能由任一端先发起建链；仅监听本端出站 accept 会遗漏“对端先开链”的恢复。
出站握手确认，以及同账号入站 link-open 通过权限检查并成功发送 accept 后，都按
目标 peer 请求重放本端仍持有的订阅。复用现有订阅调度器的串行、合并与退避，
实际发送前继续复验当前引用、目标权限和关闭代次；无订阅快照的 peer 不发请求。
入站触发沿用 ordinary peer 通知，不扩大供应商分享或共享任务访客的权限方向；
不重启共享 relay、不重放其他 peer。入站 accept 尚待确认时，发送路径仍可复用
既有单飞建链完成恢复，不把 accept 已发出误当成双向业务已经就绪。
接线与注册恢复回归见 Desktop `deviceLinkVoiceCredentialBootstrap.test.ts`，
入站准入边界见 `deviceLinkDispatch.test.ts`。

Desktop 向曾协商可靠传输、当前发送链路未就绪的设备发起新 invoke、订阅或响应性探测时，
先复用该设备既有的单飞建链入口，再发送请求。轻量列表也适用，避免请求尚未写出就反复
耗尽排队预算；从未建链或显式关闭后回退到 legacy 的设备继续使用原路径。等待前后复验
取消与禁用状态，自动探测另查撤权和 owner；建链成功本身不算业务恢复。故障与动作都限于
单 peer，不重启共享 relay、不重放已发出的写操作；回归覆盖另一 peer 与 legacy 请求继续工作。
Mobile 的 invoke 与订阅发送遵守同一规则，复用该设备的建链单飞缓存；跨过用户断开或换账号的
请求不发送。Desktop 订阅在等待中遇到用户断开时直接按断开失败，不再复验控制权限、二次拆链。
协议影响与故障半径见 [`protocol-compatibility/device-link-pre-send-link-recovery.md`](protocol-compatibility/device-link-pre-send-link-recovery.md)。

普通出站 invoke 在共享 `InvokeScheduler` 中按目标设备排队：每台最多 12 个在途，
其中 PR 引用／状态、定时任务侧栏、用量同步和轮后提示预测等后台查询最多 4 个。
发送、插话、停止、回答交互这类用户正在等的写入（`invokePolicy.ts` 的
`isInteractiveInvoke`）另有 2 个专用名额，排队时先于普通前台请求出队，不与历史和列表读取
竞争；被控端 dispatch 的 per-controller 16 / 全局 64 消息准入对它们同样各多 2 / 4 个，
字节准入不放宽。这只是本地准入顺序，不改变授权、超时与重试。
同一真实设备的普通远控与多个共享任务共用并发和等待配额；取消仍按各自 scoped peer
隔离，关闭一个任务不会取消其他任务或普通远控请求，transport 的任务范围保持不变。
任务列表首拉与恢复探测走前台配额（仍受总并发 12 限制）；Desktop 的周期弱刷新与归档
列表通过本地 scheduling 提示走后台配额，提示不进入 wire，也不改变授权。
Mobile 首页自动资源发现同样通过本地 `background` 提示进入既有后台配额，
排队后再次核验本轮发现及账号是否仍有效；失效调用不发送。用户主动打开资源保留原优先级，
不按资源通道统一降级，不改变心跳、订阅、其它设备或共享 relay 的恢复行为。
socket 缓冲或目标 peer 可靠队列超过 128 KiB、或该 peer 积压至少半个接收窗口时，
后台准入收敛到一路；已发送请求正常结算，压力消退后按原上限推进。
前台请求优先于尚未发送的后台请求；不同设备独立推进。PR 的重复聚焦／注册沿用
`PrRefsContext` 的单任务在途合并，不额外重试或保存结果。握手、订阅控制与远控心跳
不占业务队列，避免业务拥堵阻断连接或 lease 维护。
每设备最多等待 128 条，后台最多占前 96 个等待位置；排队预算不超过 30 秒，
排队过期返回 BACKPRESSURE，发送后仍保留原通道执行预算。断连／停止时取消未发送项，
在途项仍由既有 transport 结算，不能把取消或超时当成远端操作未执行。
进入 transport 后，invoke 首次写入 socket 前另有最多 `min(通道超时, 10s)` 的发送等待，
到期返回本地 `BACKPRESSURE`，不累计设备无响应次数、不触发 peer 重开。首次成功写入后才
开始原通道响应预算；分片续发和重传不续期，transport 总等待最多为发送等待加响应预算，
业务准入队列的最多 30 秒等待另计。单调时间或墙钟任一到期，恢复重放前均先淘汰请求，
避免睡眠期间计时器停跑后补发过期写操作。断线时，完全未写入的可靠请求立即结束并以 skip
替换，已经写入（含部分分片）的可靠请求保留原回执等待；`inFlight` 不把排队误报为已发送。
建链确认使用 `max(2 × handshakeTimeoutMs, peer 自适应重传基准 × 重试次数)` 的有界等待，
默认冷启动 30 秒、有 RTT 样本时最多 50 秒；重复确认不延长当前确认对象的期限，成功／撤销
取消原计时器。只调整等待预算，不扩大既有故障恢复半径，不改变 wire 协议。
调用方的 `preSend` 同步检查在出队后、创建请求前再次执行；排队期间失效的写入
必须拒绝发送并释放配额，本地检查失败不作为远端无响应的证据。
Desktop 将 BACKPRESSURE 映射为 DEVICE_LINK_BUSY；桌面和手机标签入口显示繁忙与手动重试。
可靠大回包按体积及该 peer 首次发送后 ACK 的交付速度估算重传等待，超过 512 KiB 再按
次数退避，传输等待封顶 120 秒；小消息保持原 RTT 退避，调用方响应截止时间不延长。
速度估计不从 socket 排空推断，慢 peer 不修改其它 peer 的计时或重置共享连接。

Desktop 远程 HTML 预览仅对只读 stat 的连接类错误做最多四次尝试，间隔 1/2/4 秒，
总预算 60 秒；找不到文件、权限和旧端不支持等错误立即返回。重复点击共享同一次准备，
等待提示可取消；取消按发起窗口和 requestId 隔离，在出队前再次阻止失效 stat，
已发出的 stat 迟到后不得打开页面。窗口关闭、主框架导航或账号代次变化也不得发布旧结果。
下载继续复用已有缓存与取消通路，不整次重跑下载或重试写操作；错误区分拥堵、超时与断线。
故障半径：证据限于目标 peer 的排队/交付及本次预览读取；恢复只调整本机准入和该 peer
重传、重试该预览 stat；第二个健康 peer 不被重置，旧端 wire 格式与权限边界保持不变。
被控端拒收时 Debug 日志记录在途数、待回包数、配额范围和前八个通道计数，
不记录参数／标签／消息内容。原被控端准入上限及 wire 格式不变，可独立升级控制端。

Desktop 和 Mobile 的按设备排队、并发上限、退避、取消代次由
`packages/device-link/src/peerRecoveryScheduler.ts` 统一维护。Desktop 的订阅快照与
在线判断、Mobile 的后台生命周期与页面恢复仍由各端适配器负责。同一设备取消后重新
请求恢复，须等待旧请求结算；旧结果不能取消新请求，也不能恢复已取消的重试。

Mobile 重连时，若熔断设备仍有在途业务请求，先在调度器外恢复该设备的回包链路，
避免旧探测等待回包、新建链又等待旧探测的循环依赖。此例外只发送单飞的 `link-open`，
不占用或结算业务探测席位，不增加业务请求，也不缩短原请求预算；建链成功不能解除熔断。
连接代次、前后台、撤权、显式关闭、设备可用性和在途请求在发送前再次核验。
后台新连接暂不恢复，回前台再复用同一建链入口；其它设备及被控端共享连接不受影响。

Mobile 熔断只把前台期间完整经历的超时算作「电脑端未响应」证据。发出时 App 已不在
前台，或发出后经历过前后台切换的请求，超时按不定论处理：iOS 挂起 JS 会冻结超时
计时器，回前台时它们会在 `active` 事件之前集中到点，不能证明被控端无响应。

可靠 ACK 重试耗尽默认只复位该 peer。重建连接会打断每个已就绪 peer，所以只有本 peer
与**所有**其它已就绪 peer（至少一个）的队头都在首发后没有收到任何对端转发帧（含 ACK），
且其它 peer 已重发多轮时，才视为 relay 连接转发方向卡死并重建连接。任一已就绪 peer
空闲无待确认帧或仍在正常 ACK 时，只复位沉默 peer：多台手机同时休眠不得连带断开健康 peer。
入站方向仍活动的旧版（未协商可靠传输）控制端无从取证，同样按缺少证据处理。
已知边界：本机经 `openLink` 主动控制的旧版目标不留活动标记，不参与该判定；仅在
它与多个可靠对端同时沉默时才可能多一次重连，由既有重连路径恢复，不为此新增状态。

Desktop 清理某设备的熔断状态不等于该设备已恢复。停用、离线和重置时只清理 UI
状态，不触发订阅重放或内容刷新；响应性事件只有携带真实业务回包证据才立即触发恢复。
清理事件本身不启动恢复，但不能永久关闭后续读取：聚焦、手动重试或在线通知再次触发时，
按当前 relay、设备可用性和响应状态重新判断；内部定时重试及旧请求收尾不能自行解除清理。
排队中的订阅与列表刷新同样受设备生命周期代次约束，迟到的失败不得重启已取消的恢复。周期对账复用在途
读取，新增内容等事件仍可合并成一次后续刷新；不得为了限制整轮等待而缩短弱网请求预算。

Mobile 历史读取在 relay 已在线且目标 presence 不是明确不可用时，可以沿既有建链和订阅
流程尝试恢复。新连接会清空 presence，设备列表读取失败后的「未知」不等于离线，不能阻断
历史控制器与页面同步；也不能为了放行读取伪造在线快照。明确离线／停用或 relay 未在线时
仍只展示缓存，授权、撤权和旧代结果拦截继续由原链路处理。

Mobile 项目标题的电脑图标只使用针对这台电脑的证据：当前 presence、无响应与撤权，
不从页面局部设备清单的缺失、旧快照或列表读取失败推导断连。首页、任务抽屉与宽屏常驻列表
共用此判据；重建列表与普通同步不会重置连接图标，真实断连与恢复仍随 presence 更新。
实现与回归见 `homeProjectMachineIdentity.ts`、`HomeSurface.tsx` 与 `homeProjectMachineIdentity.test.ts`。

**手机自己的连接问题不是电脑离线的证据**（2026-11-16）。每次回到 App 手机都要重连中继，
期间电脑图标曾全部显示为已断开；手机中继断线后保留的直连也断开时，还会给电脑合成一条离线
presence，请求随即按 `DEVICE_OFFLINE` 失败、首页把电脑标成离线并排入镜像清理，重连后才恢复。
现在手机中继未在线只由连接横幅说明，电脑状态保持上一次已知结果；直连断开只有在中继此前已
明确通知该电脑离线（保留期内被直连顶住的判定）时才落成离线，否则与中继断线时的其它对端
同样处理：失效该对端的建链缓存与订阅 ACK、取消它的恢复排队，请求按瞬时 `NOT_CONNECTED`
等待手机重连。故障半径三问：① 证据是手机本机的中继连接与这一条直连，都不涉及电脑是否在线；
② 只失效这一台电脑的建链缓存、订阅 ACK 与恢复排队，不改 presence、不清镜像、不重建连接，
其它电脑不受影响，电脑真的离线时由重连后的中继判定、名单读取或建链回绝给出；③ 回归见
`historyViewProvider.test.tsx`「does not declare the computer offline when the phone loses its
relay and then the direct path」，修复前该用例得到 presence=false。

Mobile 返回任务或恢复网络时，历史视图只恢复展示，由页面既有同步协调器发起快照，
不再由视图激活另读一页。已有缓存且订阅尚未确认时，最多等待 2 秒合并本次列表／详情
订阅确认；以当前 ACK 表为准，不复用前一次聚焦／连接已完成的 Promise。等待期间只
每 50 毫秒检查本地 ACK 状态，不发送网络请求；确认、明确失败或预算到期即继续，
首次无缓存立即读取。这个预算只限制等待订阅的时间，
不缩短业务请求超时，也不取消原订阅重试。读取开始之后才确认的订阅仍需补齐空档；
读取期间的内容变化仍由历史控制器合并补读，失败保留画面、不推进同步成功标记。
只影响当前手机页面，不重启共享 relay、不改变其它 peer。Desktop 保持原激活读取行为。
实现与回归见 `remoteSyncTask.ts`、`remoteHistoryViews.ts`、`remoteSyncTask.test.ts`、
`remoteHistoryReentry.test.ts` 与共享 `historyView.test.ts`。

Mobile 明确观察到断网后恢复，或已连接网络类型切换（如蜂窝 → Wi-Fi）时，
替换本机仍显示 online 的旧连接，避免旧路径上的半开连接额外等待探测超时。
相同类型的能力通知、仅 Internet reachability 变化和未知网络仍走原探测预算；
不打断在途握手、不绕过拥塞退避。后台只记录路径变化，回前台再处理；
期间若新连接已完成握手，则不重复替换。此动作只影响该手机的 relay 连接，
不由单 peer 超时触发，也不重启被控端与其它控制端的共享连接。
实现与回归见 Mobile `DeviceLinkContext.tsx`、`historyViewProvider.test.tsx`。

主连接是 Agent-Net 时不替换它（`restartConnections(…, { keepPrimary })`），只替换它的中转连接
（`portableSocket.ts` 的 `replaceRelayConnection`）：加密连接从新地址继续发、在途的包重发；旧网络上的中转
WebSocket 可能半开、永远不报错（React Native 的 WebSocket 不能 ping，Device Link 的心跳由这个 socket 本地回答），
所以关掉它、立即连新的；中转本来已断、正有一次连接在进行时保留那次尝试。中转回来后再让在途的包重发一次。
Desktop 的网络监听仍只调 `networkChanged`（中转连接由 Main 先 ping，15 秒不回才换）；它在中转断着、正在等
重连间隔时也立即重连一次，和 Device Link 收到网络提示时一样。其余经 Device Link 中转的连接（跨账号、兼容、分享）
照旧替换。2026-11-20 真机：替换主连接会关掉所有会话从头连，Wi-Fi ↔ 5G 一次约 12 秒；Device Link 约 1.8 秒。

故障半径：① 证据是手机自己的物理网络变了（同上），不由任何对端超时触发；② 不重建 Agent-Net 主连接、不重放，
只换本机这一个 socket 的中转连接（每次换网一次，和 Device Link 替换自己的连接同频），对端通道和会话不动；
③ `historyViewProvider.test.tsx`「keeps an Agent-Net main connection on a physical route change」、`routedClient.test.ts`
「restarts the compatibility connection after a network change and the main one only without keepPrimary」、
`portableSocket.test.ts`「replaces only the relay connection when the phone changes networks」与「reconnects the relay
at once when the network changes during its backoff」。
同日查到的另两处卡顿在 JS 线程上，不属于恢复动作：每收到一次设备目录都用纯 JS 把全部证书重新验签（换网时约 180 次，
占满 JS 线程约 8 秒），改为记住验证通过的签名（`relayAuthCrypto.ts`）；传输层轮询每次两两比对全部设备密钥，
改为按密钥建索引（`portableSocket.ts` 的 `keys`），空闲时放慢轮询（`nativeTransport.ts`）。三处一起后真机换网
1.5–1.9 秒恢复。

2026-11-21 又查到手机每个请求比 Device Link 慢 30–60 毫秒的两处原因，都在 `nativeTransport.ts` 的轮询里，都是 JS：

- 每次轮询都把准入名册重算一遍再和上次比。账号里 28 台设备时这一步约占 JS 线程 8 毫秒，比过桥向原生引擎取状态
  （约 2 毫秒）还多；每 8 毫秒轮询一次时 JS 线程接近占满。现在 socket 的准入版本（`admissionVersion`）变了才重算，
  另外每秒重算一次，覆盖证书、授权这类随时间到期的情况。名册或准入规则一变，`portableSocket.ts` 当场告诉传输层
  （`Transport.admissionChanged`），撤销一台设备不再等到下一次轮询才镜像给引擎。
- 要发数据时用零延时计时器触发轮询。React Native 的计时器按屏幕帧走，真机上零延时计时器晚 7–20 毫秒才到，
  请求在 JS 里白等这么久。现在当场轮询；8 毫秒内连续的写入仍合并到原来的节奏里，不会每写一次轮询一次。

真机（Android，办公室 Wi-Fi，同一个安装包同一时段，各 20 次的中位数；括号里是 Device Link）：读任务列表到两台直连电脑
80 / 130 → 54 / 75 毫秒（53 / 80），到经中转的电脑 146 → 80 毫秒（74）；打开任务 121 / 128 → 56 / 92 毫秒（75 / 76）；
空闲时 JS 线程 12% → 4.9%（1.5%）。不改 wire，也不动原生层，旧安装包热更新后生效。剩下的差距是收包这一侧：
引擎收到应答后要等 JS 下一次轮询才交出来。

同日做了收包这一侧（[会话层方案](../agent-net-session-plan.md) 10.2 节 v2-4 的原生循环，要新安装包）。原生库报告 `native-wait`
的安装包上，每个引擎有一条自己的原生线程（`CindyAgentNetModule` 的 `Pump`，Android、iOS 各一份）：等套接字上来包或核心的
下一个计时器，让引擎走一轮（`cindy_agent_net_pump`：收包、回确认、重传、保活），引擎有东西要给 JS 时才叫醒 JS 去 `poll`。
JS 不再用计时器轮询（`nativeTransport.ts` 的 `rest`）：要发数据时当场 `poll`，引擎写完立刻发出去（`send_now`）；
其余时间等原生线程叫。引擎空手回来时 JS 只看它镜像给引擎的东西（准入版本、中转的 UDP 凭据）变没变，每秒完整 `poll` 一次。

- 这条线程不依赖 JS 线程：JS 忙或卡住时确认、重传和保活照常，连接不会因为 JS 卡住而被对端判断断开。
- 引擎替 JS 收下的数据先放着（`stash`），`poll` 一次交出、不重不漏；JS 没来取之前引擎不再从核心读新的流数据，
  核心的接收窗口照常顶住对端。经中转 WebSocket 发的包攒在引擎里等 JS 取（最多 1024 个，超出丢最早的，由传输层重发）。
- `poll` 交出的连接列表永远是当下的，先收下的数据和事件接在前面（`engine.rs` 的 `merge`）。JS 把列表里没有的连接当成
  已经没了：只交出先前收下的那份列表时，之后才拨出的连接不在里面，会被当场判成拨号失败。
- 每次 `wait` 开始前引擎先走一轮（`waitForWork`）：JS 刚写进去的数据如果要经中转 WebSocket 发，包在引擎里等 JS 来取，
  套接字上不会有包来提醒；不先走这一轮，要等原生线程下一个计时器（最长 250 毫秒）才交给 JS。
- 旧安装包（原生库没有 `native-wait`）照旧用计时器；等待失败一次也退回计时器。新安装包配旧 JS 时没人调用 `wait`，
  原生线程不启动，行为和原来一样。不改 wire。

同日换了一台手机（Redmi K40，连着 7 台电脑）量每个请求在手机 JS 里的开销。页面打开后头一秒（系统给大核提速）请求只要 15–25 毫秒，
之后稳定在 40–55 毫秒，Device Link 整批平稳：CPU 采样显示约 1 秒后大核回到最低频，App 的线程落在小核上，Agent-Net 每个请求在
JS 线程上要做的事比 Device Link 多，CPU 一慢就显出来。沿一个请求打时间点量到两处，都在 `nativeTransport.ts`，都是 JS：

- **写入排在一次轮询之后。** 引擎收到写入就发包（`send_now`），但 JS 是先 `poll`、把每条连接过一遍、最后才 `write`：
  一次过桥往返 2.6–4 毫秒，加上过一遍 7 条连接约 6 毫秒（空闲的连接也各走一遍 `flush`，十几次 promise 往返；每条连接每次都重算
  对端密钥的十六进制）。现在有字节要交时先写再轮询（`writeFirst`），空闲的连接不再走 `flush`，对端密钥的十六进制按连接记住（`remoteKey`）。
- **写入等每秒一次的准入复查。** 按时间复查准入（`ADMISSION_RECHECK_MS`）到期时，下一次写入要等名册重算完，账号里 26 台设备时
  8–17 毫秒。现在这次复查不拦写入：`admit` 每次都按当下的时间判断，写之前照旧问它。

「准入变化先于任何写入交给引擎」没有变：socket 报告准入版本或中转凭据变了（`mirrorChanged`），仍然先轮询、把新名单交给引擎再写；
此刻不被准入的对端一个字节也不写，随后的轮询把连接关掉。

真机同一次运行里用开关交替切换新旧顺序（各 40 次，取后三分之二的中位数，三轮；毫秒）：打开任务（直连）32.5 / 37.3 / 39.6 →
31.3 / 29.6 / 29.3；读任务列表（直连）50.3 / 52.3 / 50.8 → 42.1 / 37.9 / 42.4；打开任务（经中转）97.9 / 100.3 / 102.2 →
94.1 / 90.4 / 93.6。从 JS 交出请求到引擎写完 8.3–10.5 → 3.8–4.5。对端应答时间本身在 8–24 毫秒之间波动，单看总数的中位数会被它搅乱，
要看同一次运行里交替的结果。不改 wire，不动原生层，热更新后生效。

量到、还没做的（都在手机 JS 与原生层之间，CPU 低频时）：过桥本身，写入和轮询各 3–4 毫秒（异步调用来回各切一次线程）；应答到了以后
还要再过一次桥去取；字节以 base64 文本过桥，2 KB 的回包在 JS 里解码 3.8 毫秒，随大小线性增长（会话层方案 v2-4 的二进制桥）。
三项都要改原生模块。

2026-11-22 做了这三项（要新安装包）。原生库报告 `binary-io` 时，JS 和引擎之间多一个 `io` 调用（`cindy_agent_net_io`；Android、iOS 的
`CindyAgentNetModule.io` 各一份），`nativeTransport.ts` 的 `exchange` 与 `restBinary` 用它：

- 字节不转 base64、不进 JSON。一帧是「4 字节头长＋小 JSON 头＋原始字节」，头里只写每段多长；读回的结果也一样，流数据和要经中转
  WebSocket 发的包原样跟在头后面（`engine.rs` 的 `io`、`take_blobs`）。
- 一轮的写入、中转转来的包和读取合成一次调用：要发数据时过一次桥写完并读回。
- 等待的那次调用把引擎随后读到的东西一并带回：应答到了只过一次桥，原来是等待返回、再 `poll` 一来一回，共三次。
- 同一时刻只有一次调用在读。等待的调用在外时，写入走另一次不读的 `io`；写完引擎若有东西要给 JS（比如要经中转 WebSocket 发的包），
  叫醒等待的那次（`kick`）。JS 还有没写完的字节或拨号在等时，同步的 `kick` 让等待的调用立刻回来，不等它的 250 毫秒。
  等待的调用回来时若正有一轮在跑，它读到的东西先放着，那一轮在自己的调用之后、处理自己读到的东西之前先交出，顺序不乱。
- 引擎只收下一部分时，剩下的从断点接着发；这条流之后每轮只给一块，收下一整块才恢复，满了的流不会每轮带半兆字节过桥再被拒。
- 等待的调用失败时，引擎可能已经交出了读到的东西而 JS 没拿到：传输层直接关掉、由 socket 重连，不带着缺口继续。
- 旧安装包（原生库没有 `binary-io`）、新安装包配旧 JS、原生库报告了 `binary-io` 而 App 模块没有 `io`，都照旧走 `command`。不改 wire。

真机（Redmi K40，办公室 Wi-Fi，同一安装包同一进程里交替用新旧两种桥，4 轮，每轮每档 20 次的中位数；毫秒）：
直连电脑 1 KB 18.7 / 21.9 / 17.6 / 18.8 → 14.6 / 15.5 / 16.7 / 16.6，16 KB 44.5 / 45.1 / 29.1 / 36.9 → 17.0 / 17.5 / 17.1 / 15.6，
128 KB 60.5 / 69.3 / 69.6 / 65.7 → 29.2 / 33.5 / 42.9 / 31.2；经中转 1 KB 20.2 / 16.1 / 17.5 / 19.6 → 13.1 / 12.8 / 20.2 / 17.9，
16 KB 43.1 / 32.4 / 27.7 / 36.0 → 19.1 / 17.6 / 17.2 / 18.6，128 KB 67.1 / 60.0 / 66.2 / 64.3 → 56.5 / 52.4 / 51.2 / 34.1。
回包越大差得越多：16 KB 以上直连快一倍多，经中转的 128 KB 受中转本身限制。

手机每次建立 Agent-Net 连接（冷启动、在后台超过 10 秒后回到前台）的两处等待（2026-11-21，带计时日志的真机时间线）：

- **名册缓存不再逐张验签。** `readMobileAgentNetDirectory` 先核对整条记录的 MAC，再接受其中的证书。MAC 的密钥是本机身份的种子，
  覆盖全部证书，而写入前每张证书都验过签名（`writeMobileAgentNetDirectory`）：记录完好就说明里面正是本机当时验过的那批证书，
  只把它们记成「验过」（`relayAuthCrypto.ts` 的 `rememberVerifiedSignature`），形状、有效期、网络与账号的核对照旧。
  原来每次冷启动把 24 张证书用纯 JS 的 Ed25519 重验一遍，每张约 28 毫秒，共约 0.7 秒；改后读缓存约 20 毫秒。
  这条捷径只用于本机自己写入、又用本机密钥证明完好的记录，从对端或服务器收到的任何东西都照常验签。
- **经中转拨号等中转的 UDP 通道就绪。** 中转发了 UDP 凭据、通道还没就绪时，`NativeTransport.connect` 先等它，最多
  `RELAY_UDP_DIAL_WAIT_MS`（从通道最近一次建立算起）。这段时间里经 WebSocket 发出的握手收不到回应，要等核心 200 毫秒后重发：
  第一批拨号原来每次 230–240 毫秒，改后 30–45 毫秒。中转没发凭据、安装包不支持中转 UDP 时不等；UDP 不通的网络等满时限后照旧走 WebSocket。
  `configureUdpServer` 拿到中转地址后立刻轮询一次，把凭据交给引擎，不等引擎下一次叫醒。

同一台手机、同一个 Wi-Fi，从开始建连接到拿到第一份数据：冷启动 2.0–2.3 秒 → 1.4 秒（其中读本机身份 0.5–0.7 秒是系统安全存储的耗时，
登录令牌刷新完才能读设备列表）；在后台超过 10 秒后回来 0.5 秒 → 0.35–0.4 秒；10 秒以内回来连接还在，约 15 毫秒。

真机同一安装包切换两种方式（各 20 次的中位数，括号里是 Device Link）：读任务列表 54 / 75 / 80 → 32–36 / 35–40 / 61–73 毫秒
（53 / 80 / 74），打开任务 56 / 92 → 36–44 / 63–76 毫秒（75 / 76），空闲时 JS 线程 4.9% → 1.2–2.2%（1.5%）、整个进程 13.6% → 8–10%（8.0%）。

无响应设备的列表、PR 状态和模型目录后台读取应让位给连接层探测。目录失效在暂不可读时
保留待刷新意图，复用已有调度退避，只检查可读性、不发送请求；取消和销毁仍清除待办。
前台、重连和单设备恢复通过同一入口唤醒尚未完成的目录读取，不等待旧退避到期，
也不使已完成缓存再次失效；唤醒与旧轮结算交错时仍由已有调度器合并。
Desktop 周期列表按设备合并在途读取和退避，健康设备不等待其它设备的慢请求；
能力预取仅在列表恢复成功后逐项进行。共享恢复调度沿用已有通知唤醒语义，真实恢复
不能被旧退避计时器挡住。
Mobile 重连先恢复已订阅任务的快照，再请求首页列表；某一步传输失败即退出该设备
本轮恢复，交回按设备退避，不能继续扇出剩余读取或重置其它设备的连接。

Mobile 首页被任务页、设置页等盖住时仍持有可见设备的 `sessions` 订阅，增量补丁照常进镜像；
回到首页不再整份重拉所有电脑，只补拉可能漏过推送的设备：离开期间收到 reseed
（新建任务、未知任务补丁，以及 peer reset／重连／回前台后 device-link 恢复回放发出的重拉）、
拉取失败或离线、离开时已不在同步范围；列表被分页上限截断的设备离开期间收到任何列表推送也重拉（截断窗口的成员变化本地补不全）。离开期间 App 退过后台、relay 重连过、离开超过
10 分钟或尚未完成首轮同步时，仍走整轮设备清单 + 列表重拉，且这次整轮成功提交前一直保持整轮（失败不降级为只补拉）；不可见设备照旧 release 退订。
判据见 Mobile `homeListFreshness.ts`，不新增 wire 字段或持久化状态。
自动化角标（scheduleIndex）同理：自动化事件随 `sessions` 订阅到达，首页被盖住时只记下收到事件的
设备，因失焦被跳过或结果被丢弃的刷新同样留待补刷（成功应用后才清除），回首页只刷新这些设备，整轮返回时才全量刷新。任务页打开普通任务时，若该设备当前索引表明
它未绑定任何自动化，就跳过标记已读的索引读取；运行事件会把新绑定的任务补进记录，自动化定义变化、
重连或离线后记录失效、照常读取（`scheduleIndex.ts` 的 `sessionMayHaveScheduleRuns`）。

远程桌面的输入不是可持久重放的工作：本地未发送输入等待达到两秒时丢弃并退出
控制，复用控制释放路径；重新取得控制时清除旧批次等待，以递增序号隔离迟到 ACK。
Mobile 父层同时退役旧输入批次；旧 native 发送的迟到失败不得回落 relay，旧请求的
错误或收尾不得释放新控制、清除新批次等待或向新控制周期发送 ACK。
已拥塞的数据通道不应被 relay 输入旁路超车。视频发送端
允许 WebRTC 同时调整分辨率与帧率，保留原有帧率／显式码率上限。以上策略不新增
wire 字段，也不自动重试已发送但结果不明的写操作。

`packages/device-link/src/invokePolicy.ts` 集中维护请求策略，三个边界独立判断：

- 通道执行预算：保留 Desktop / Mobile 的超时差异，超时不代表主机操作未执行。
- peer reset 后可重试的读取：显式列举，不按名字推断写操作可以重试。
- 可共享在途结果的 listing：不能从“可重试”推导。`sessions:get` 与要求 `fresh` 的
  `sessions:list` 必须重新读取，避免复用写入之前开始的快照。

主机数据库后台准入是独立的资源分配策略，不能直接复用上述 listing 集合作为分类依据。
这些策略不改变 wire 格式或通道权限；权限仍以 allowlist 为准。

Mobile 的模型目录变化通知由 `deviceCatalogRefresh.ts` 按设备合并，失效立即推进代次，
在途读取结算后再补拉最新快照；页面与后台共享能力读取，通知不得清掉物理在途槽后重复发包。
可靠传输在本地 WebSocket 出现积压时提前暂停数据写入，复用公平预算与短间隔 drain，
为 ACK／握手保留硬上限之前的余量；不等待 relay 的 1013 才降速，也不对已排空的健康
socket 固定限速。最大逻辑消息仍可在排空后原子发送，不改变可靠序号和跨版本协议。

控制端单独重连可能仍使用原可靠流，被控端因自身 relay 未重连而将建链判为重复 open。
新版确认 ACK 若匹配本次 accept，且明确停在已发送队头的前一序号，可额外补发这个队头；
该队头被累计 ACK 确认后，才能继续补发下一队头，边界固定为本次 accept 时连续已发送的
积压前缀。重复 open 不延长已启动的补发范围，新入队或当时未发出的消息不纳入。
每个序号最多补发一次；新一轮补发仍受原重试基础间隔限制，轮内仅由真实 ACK 前进驱动，
且受原恢复帧预算、socket 背压和聚合公平预算约束。慢速在途消息也可能得到一次副本，
因此不能对每次 open 重放整队。普通 ACK 不能启动补发；旧端无确认能力、已确认数据、
过大的队头及本地背压仍沿用原重试策略，断链和换流取消本轮补发。
此修复只作用于该 peer，不重启共享 relay、不缩短业务超时，也不改变 wire 格式；
多控制端故障隔离用例见 `packages/device-link/src/__tests__/client.test.ts`。

可靠请求已确认接收后，若异步结果在控制端断线期间才完成，回包必须保留在该 peer
原有的有界可靠队列中。链路未就绪时的裸帧直发仍用于避免等待建链的死锁，但直发成功
不等于对端已收到，不能据此删除可靠副本；重连补发同 requestId 的结果，不重新执行
原操作。副本沿用容量、过期、撤权清理与恢复预算，不缩短业务超时或重启共享 relay。
队列被不可丢弃的在途帧占满时，保留失败仍须尝试原有裸帧直发，不扩容或驱逐在途帧。
若结果可可靠分片、但超过裸帧上限，仍返回原 `BACKPRESSURE` 供上层 outbox 重试，
不能误报 `PAYLOAD_TOO_LARGE` 并将原结果压缩或替换成错误。
实现见 `packages/device-link/src/client.ts` 的 `sendInvokeResult`，多控制端回归见同包
`src/__tests__/client.test.ts`。

收到明确的对端离线信号时，Host 和 Desktop 使用共享 dispatch 的全量回包 outbox 门禁。
门禁依据该对端承载连接的当代离线证据，保留原 TTL 和定向建链补发。有可用直连、对端重新建链或
承载连接换代后，旧证据不再挡住发送。可靠队列入队时先按协商的读截止时间把过期结果改成 skip。
发送尚未就绪且队头滞留超过 60 秒时，只移除可丢弃前缀。确已断链时，余下帧都已滞留超过阈值且
没有仍需交付的回包，才允许兜底清空。等待确认的链路保留在途结果，仍靠原确认 ACK 推进。有
未协商截止时间的回包时，队头年龄不能用来判断它已经过期。裸回包防死锁路径照常可用。
故障和恢复均限于该 peer，共享 relay 沿用原定时器、预算、帧格式和签名规则。
Host 的双控制端与全量 outbox 回归见 `apps/host/src/device-link.test.mjs`。

## 模块通过 Remote Resource 接入移动端

面向移动端新增独立产品入口时，默认通过 `@cindy/device-link` 的 Remote Resource
协议接入，不为每个业务模块复制 DTO、store、channel 与 push reason。稳定 wire 入口只有：

- `maker:remote-resources:manifest`：主机声明 collection、placement 与客户端可展示的有限原语；
- `maker:remote-resources:list` / `maker:remote-resources:get`：读取资源投影；
- `maker:remote-resources:invoke`：调用主机已注册、已校验的 opaque action；
- `maker:remote-resources:changed`：只表达 collection/ref 失效，控制端据此重拉。

Desktop 功能模块通过 `RemoteResourceRegistry` 注册 provider；主机保留业务权威和安全边界，
provider 只投影用户可见信息。密钥、Token、渠道凭证、系统路径、内部 prompt 与运行时对象不得
进入资源响应。Mobile shell 只理解有限的展示/交互原语，不按 Bot、Schedule 或 Plugin 的内部
enum 编译分支，也不接受任意 HTML、React 或无限 UI DSL。

资源身份必须包含 `deviceId + collectionId + kind + id`。资源路由打开时应重新调用 `resource:get`
解析 `conversation` 等 link，不能把可能 rollover 的 Session id 当成永久资源身份。已有对话继续
复用 canonical Session 的消息、输入、确认与恢复链路，不复制一套模块专属聊天协议。
列表已有 conversation link 时，可直接展示聊天框架和同账号缓存，在聊天页内重读资源，
复用该页的 Session 元数据查询校验 ID、类型与设备归属；校验完成前不允许远端投递、控制和已读。
列表返回与后台刷新应保留已有内容，仅首次无数据时显示整页加载，不用固定延迟掩盖切换。

手机伙伴列表的同步新鲜度不决定已缓存伙伴能否打开：连接圆点只消费实际连接与 presence，
列表失败保留之前成功的同连接代次证据，各电脑的成功分片立即更新。暂时读取失败复用既有
错误分类、读取重试与恢复退避；只在前台可见时补读，离开、后台、账号变更与永久错误不续读。
缓存仅供同账号展示，撤权设备仍过滤；无 conversation link 时仍由原资源路由解析，不猜身份。

已有 canonical link 的伙伴在断网时可读本机已缓存历史、编辑持久草稿；未缓存历史明确提示
连接电脑后同步。用户点发送才写入现有 durable outbox，纯草稿不自动发送。新伙伴待发送记录
额外保存资源身份，应用级队列在首次远端 enqueue 前重读资源、准备状态、canonical link 与
Session 类型，不能借页面关闭绕过校验。队列仍按原 clientId 对账和去重：接收不等于送达，
旧主机结果未知时不盲重放，已获宿主持久接收的记录只对账。恢复范围是单 host/read/outbox，
不拆共享 relay，不增加云端执行或 wire 协议；现有历史、草稿和 outbox 的账号清理规则不变。

协议按字段追加演进。未知字段、未知 collection 和未知 action 不得导致整个首页或会话崩溃；
结构化 Session 内容必须携带可读 `fallbackMarkdown`，旧客户端至少能阅读并继续任务。只有新增
移动端此前无法表达的内容或交互原语时，才要求客户端发版。

任务内状态卡使用 collection placement `session:<source>`，资源 id 为任务 id。
Mobile 根据 manifest 发现卡片，不写死具体业务状态；`session-controls` 原语仅声明
输入是否可用与是否忙碌，详情保留可读 fallback，动作 id 为不透明标识。
动作的 disabled 是呈现提示，主机仍须按最新状态、账号与任务身份复核。重连只重读，
不得重放写操作；旧客户端不识别此 placement 时继续原有消息流程。

Desktop 的同账号远程 Cindy Make 任务同样消费该投影：准备与测试交接卡接管输入区，
继续修改后的恢复动作放在输入区顶部，实时状态与动作均来自任务所属电脑。控制端沿用
既有 sessions topic，不新增业务 IPC 或本地构建回退；离线、切账号和切任务后禁用旧卡片
动作，重连与操作超时后只重读状态。旧主机不提供该 placement 时保留只读历史卡片。
实现与回归见 Desktop Renderer 的 `features/device-link/useSessionResourceCards.ts`、
`SessionResourceCards.tsx` 及同目录测试；SSH 工作区不由此获得 Make 执行能力。

## 桌面远程控制的伙伴设置（`management:settings`，2026-10-22）

产品规则见 [`../product-rules/cindy-bots-runtime.md`](../product-rules/cindy-bots-runtime.md)「伙伴设置」。落点：

- **走 Remote Resource，不新增通道**：`teammates` 集合声明集合动作 `management:settings`，`input.op` 选固定操作，结果放在
  `RemoteActionInvokeResponse.result`（`{ ok, value | code, message }`）。`allowlist.ts` 不变；伙伴 `settings-*` 等原始 IPC 仍不放行。
- **主机沿用本机服务**：每个操作调用本机 IPC 同一份服务，凭证、本机路径、运行时快照不进结果；写入口白名单（`BOT_SETTINGS_PATCH_FIELDS`），
  拒绝 `permissions`；消息平台操作只触达该伙伴自己的连接，没有接收凭证的操作。
- **控制端兼容**：用集合动作 + `caps` 探测，主机不支持（旧版）整页回退到通用表单页；手机与旧桌面不变。
- **故障半径三问**：① 故障层级：单个请求（读取 / 写入某个设置）；对方离线只标记页面状态，不判定设置失败。
  ② 动作层级：仅该 peer 上该伙伴的请求，不重建 link、不断 relay、不重放写操作；写入失败沿用自动保存的回滚与重试，读取只在
  推送 / 重连 / 聚焦后 400ms 合并重读，消息平台状态每 5 秒读取一次（仅页面打开且可见）。
  ③ 多 peer：主机按请求内的控制端校验授权与撤权，一个控制端的写入不影响另一个的在途读取；回归见
  `botRemoteSettingsHost.test.ts`（授权、可见性、owner 切换后丢弃结果、冲突形状、凭证 / 路径不出主机）与
  `remoteBotSettingsTarget.test.ts`、`remoteTeammateSettings.test.tsx`。

## 本机与远程共用查询策略

本机独立使用、远程操作、两端同时使用应共享数据语义与通用查询策略；远程连接状态
不得改变本机的业务规则。数据库优化落在共享数据访问层，远程边界只承担授权、协议
兼容和传输约束，不另建一套查询、缓存或调度策略。

`localDb/sessionQueries.ts` 统一单条、批量、列表的字段选择、消息计数、预览与结果整理；
单条读取委托批量读取，列表保留同一语句内先限量再取详情的查询形状。Renderer 的
`sessionBatchRead.ts` 统一按所属设备路由、去重、分批、结果验证与缺失判定；本机分屏
补读与远程列表补读都复用它。现有列表在途合并和数据库 Worker 调度继续由本机与远程
共用；不增加已完成结果缓存。远程权限结论仍只在授权边界处理。

### 远程边界与延迟诊断

Desktop 远程发送的附件授权作用域绑定账号与发起文档，不绑定当前任务路由。
HashRouter 的同文档导航（切换任务或新任务进入任务页）不得取消在途发送，也不得把
原始传输超时覆盖成附件授权失效；主文档替换、窗口销毁与账号失效仍立即取消，文件读取
和最终派发仍复核原 frame 与账号。实现与回归见 `device-link/ipc.ts`、
`device-link/__tests__/mirrorCacheIpcBoundary.test.ts`。此边界只在本机 IPC adapter 生效，
不改变远端或自建中转的协议、授权与重试策略。

远程列表复用本地查询，返回前额外执行伙伴可见性过滤。过滤按本次授权阶段批量查询，
每条 SQL 最多 200 个 ID；不跨请求缓存授权结论。缓存回复与离线重放仍重新检查，账号
变化时丢弃旧结果。控制端补齐列表外任务时优先使用 `local-db:sessions:get-many`
（最多 32 个 ID，当前每轮补读最多 8 个），保留单条 GET 的元数据、预览和计数语义。
旧被控端不支持或批量回复超帧预算时回退到原有有界 GET；超时、撤权、损坏回复不触发
成倍重试，迟到回复不能覆盖更新的 push。

Mobile 伙伴任务卡的列表外补读由 `companionTaskReads.ts` 按账号、连接代次和电脑聚合，
每批最多 8 个、批次串行；同组共享刷新时钟，旧端单条回退同样串行。焦点或账号切换后
不发送已失效的排队读取，不缓存已完成批次；卡片优先使用普通任务列表中的更新结果。

远程卡顿的默认 INFO 证据使用 `device-link diagnostic`，不要求用户先开 Debug 再复现。
记录只观察，不改变并发、超时、重试、选路、授权或 wire：

- `admission`：本机准入满额、过期或等待超过 1 秒时，记录运行中与排队中的数量、
  最老请求的通道／来源／优先级／年龄，以及可靠传输现场。两组各保留前三类，
  `omittedGroups` 明示省略数量；队列满不等于网络慢。
- `request`：请求超时、往返超过 1 秒或回复至少 256 KiB 时，记录同一个 request 前八位、
  准入等待、首次写出前等待、写出后等待、回复字节数。`firstWriteWaitMs=null` 表示尚未写出。
  `elapsedMs` 用本机单调时钟，`wallElapsedMs` 用墙钟；不能相减两台设备的时间戳当网络耗时。
- `execution`（`device-link:execution-diagnostics`）：被控端执行超过 1 秒时记录授权、handler、
  持久化和投影耗时；5 秒仍未结束时先记当前执行阶段，不等请求完成才留证。
- `send`：大帧入队及大帧／慢帧收到 ACK 时记录字节数、序号、路径与等待。
  `queueToAckMs` 覆盖全部排队／重传，`currentAttemptToAckMs` 仅覆盖当前重传轮。
  `encode` / `decode` / `receive` 补充至少 250 毫秒的编码、解码、分片组装及按序等待。
- `path` / `ack`：直连因 ACK、缓冲或写出故障撤下、或可靠层超时时，**在清理现场之前**记录
  ACK 位置、前三个队头的 request／seq／字节／路径／年龄／发送闸门、接收缺口，以及共享
  socket 上其它 peer 的积压（前三名及省略数）。少量大帧和旧 relay 前缀也能留下证据，
  不依赖队列达到 48 条才触发。直连接上、把仍未确认的中继帧改走直连之前也记录一次同样的
  队头现场（`send` / `moved-to-direct`，独立分桶，不占撤链证据的采样名额）；否则撤链时
  只能看到「已搬走、还没写出」，无法判断原本哪条中继帧挡住了后续直连帧的累计 ACK。

按 request 前八位关联两端；同一现场拆行时用 `instance + event + part` 拼回，`parts` 用于检查是否缺片。
各阶段（准入原因、请求／执行／发送结果分桶）每 30 秒保留前四次，随后汇总 `suppressed`；
直连故障不会被普通慢请求耗尽采样名额。单行小于上传器的 2,000 字符上限。
只有固定通道／操作枚举、短标识、数量、字节和时长，不记录参数、回复、路径、SQL、凭证或错误正文。
Desktop 的 `device-link`、`device-link:ipc-diagnostics`、`device-link:execution-diagnostics`、
`device-link-transfer` 精确 scope 可经现有采集与脱敏导出；不开放其它子 scope。

判断时要区分证据：运行槽被慢 handler 占满、发送闸门挡住大回复、以及旧 relay 队头阻止
后续 direct 帧的累计 ACK，是不同原因。单端日志缺少对端阶段时只能定位等待区间，不能
把“写出后等待”断言成网络慢；采样缺失、上报裁剪及旧版对端同样必须明确。
共享传输层的记录仍使用各平台注入的 logger，本项不改变 Mobile 的日志持久化／上报策略。
`node scripts/remote-stall-diagnostics-smoke.mjs` 用隔离 Electron、真实回环 WebSocket、正式
INFO writer 与收集器验证上述四类故障，并保留 `collected.json`，不向云端上传。

Debug 仍可追加两层细节：

- `remote invoke slow execution`（至少 300 毫秒）包含 `stagesMs`：调用前授权、业务 handler、
  调用后授权、设置持久化、返回投影。总耗时还包含调度和序列化，不等于 SQL 执行时间。
- `db-rpc` 的 `rpc.slow`（至少 250 毫秒）包含 `queueMs`（主线程待发送队列）、
  `workerWaitMs`（投递到 Worker 开始处理）、`workerExecutionMs`（整个 Worker 操作）、
  `deliveryMs`（结果传输及主线程调度）。事务操作的执行时间覆盖整个事务；结果传输时间
  也不能直接称为主线程阻塞。旧 Worker 未附计时信息时只记录可测部分。

诊断只记录本地 RPC 序号、操作类别、数量与耗时，不记录 SQL、参数、消息内容或结果。
性能复测应同时包含前台发送、另一控制端刷新与补读、本地读取；分别报告请求数量和延迟，
不能把内存数据库基准当成真机网络端到端改善。

自动 Git 保存点的发送前基线和轮末保存各有一份 **8 秒整体预算**，包括元数据、目录探测、
空项目初始化、仓库队列等待、文件过滤、暂存、标签和隐藏 ref 写入。嵌套操作共享同一单调
时钟 deadline；Git 超时或主动取消后另留最多 3 秒进程树清理预算。超时继续发送；Stop
通过发送 reservation / 输入队列 / 目标续跑的取消信号终止准备，不能迟到派发。原生文件系统
请求无法强杀，停止等待后丢弃结果，并在后续写入前检查取消；临时文件由原操作清理。

故障限于当前保存点；不能因此重建设备连接或重试发送。Git 清理无法确认时，本进程暂停该
仓库后续保存点与文件回退写入，其它仓库照常工作。回退不仅看缺口标记，还要求范围内每条
用户消息有完成证据、已记录的 shadow 基线均有对应完成点；未变化的自动轮次也写完成点，
被过滤路径发生变化时不发布完成点。旧历史缺少证据时保守降级为仅回退消息。
同一消息的每次执行在 Git 操作之前写入独立、不可覆盖的派发意图，保存点以可选的
`X-Cindy-Attempt` trailer 绑定该标识。回退逐个核对所选消息的全部意图，基线与缺口标记均
写入失败也能识别，后续成功不能抹掉中间失败。意图落盘也占用上述 8 秒预算；意图无法
写入失败或超时时拒绝本次派发，不在保存点内部立即重试。只有本机预算产生的 typed 超时
（`SnapshotOperationDeadlineError`，不按报错文字判断）才可由尚未接受的调度输入交给
定时任务自动续跑：沿用原 run 与 accepted 回调，经共享恢复守卫批准并退避后创建新的
隐藏恢复输入。恢复输入使用新 clientId，通过 retrySourceClientId 关联原消息；原可见
用户行保留，恢复输入另存带 autoResume 标记的隐藏用户行。若恢复输入的准备再次失败，
本轮即收口，不循环重试；通用恢复守卫的 5 次上限不代表快照准备会重试 5 次。
退避沿用共享守卫（首档基准 3 秒、±25% 抖动、封顶 20 秒），期间受聊天 Stop 与定时
任务暂停／删除约束；暂停／删除
会以取消而不是超时结束仍在等待的保存点。权限或存储错误、已接受或发送结果不明的输入
不走此恢复；最终失败时把真实原因交回本轮 runner。派发前失败复用 scheduler bridge 的
`onPersistedFailure` 回执；其它已被自动恢复接管的失败保留原运行回调，不按丢弃提前结束。
迟到写入只能留下保守缺口，不能重新发送。意图写成之后的
Git 故障仍按原约定继续发送。这是安全降级与无法确认派发记录两类失败的区别。

意图仅存 UUID 和消息锚点，位于当前账号的
`owners/<owner-key>/git-snapshot-attempts/<sha256(sessionId)>/<attempt-uuid>.json`，
用独占新建与 flush 写入，不依赖内存、不改用户仓库或数据库 schema。账号和目录在异步
操作前捕获，切账号后不放行发送。记录作为回退安全证据随账号数据保留，不按成功轮次
清除失败意图。读取限 8 秒、每条 4 KiB、每个任务 10000 条；损坏、读取失败或超限一律
降级为仅回退消息，不能当成空历史。旧版本忽略新增 trailer，但不具备这一逐次核对保障。
实现见 `gitSnapshotCoordinator.ts`、`utils/operationBudget.ts`、`worktree/gitExec.ts`；回归见
`gitSnapshotCoordinator.test.ts`、`gitExec.test.ts`、`gitSnapshotShadow.git-integration.test.ts`、
`codexFileRewindPlanner.test.ts` 与 maker-core `session-control.test.ts`。

远程发送的端到端耗时按同一 clientId（只记前 8 位）在三端分别记 debug 日志，各端只用本机时钟：

- 被控端 `remote enqueue timing`：enqueue handler 内 `gate`（准入与清除边界）、`restore`、
  `prepare`（附件物化与引用水合）、`recheck`、`dedupe`、`coordinator`、`snapshot` 各阶段耗时；
  `remote send pushed`：coordinator 收下到用户行 `messages:created` 推出的耗时（含 Agent 冷启动）。
- Desktop 控制端 `remote send accepted`（点击到被控端收下、最后一次派发耗时、尝试次数）与
  `remote send echoed`（点击到回显）。
- Mobile 控制端（调试记录开启时）`send accepted`：`policy` / `projection` / `prepare` / `enqueue`
  各阶段、是否跳过发送前 projection、点击到收下；`send history confirmed`：点击到落库确认。
- Desktop 控制端在 debug 级别每 30 秒输出 `transport bytes`：按 channel 统计 invoke 回包数与字节数
  （只在 debug 开启时为统计再序列化一次回包）。

这些日志不改变 wire、ACK、重试或授权语义。

远程 Agent 创建慢时，开启 `LOG_LEVEL=debug`，在 main 日志里查
`remote agent startup timing`（发起端 scope `remote-agent:startup`，运行端
`remote-agent:host`；独立于 Agent 日志的突发限流）。
Dev 默认已包含 debug，日志在启动 checkout 的 `apps/desktop/logs/`；安装版在本机
userData 的 `logs/`。按 `sessionRef`（任务 ID 前 8 位）与 `runRef`（run ID 前 8 位）
关联两端；同一任务重连会创建新的 run，控制端另标 `reconnect: true`。

- `side=controller`：`mcp-prepare`、`capability-handshake`、`connection-slot`，以及
  `project-files` / `ancestor-files` / `ancestor-markers` / `personal-config` /
  `instruction-imports` / `git-probe` / `image-epoch`，最后是 `remote-open`。
- `side=transport`：`payload-upload`（序列化、压缩与必要的分段上传）、`open-request`
  （打开请求往返）、`session-ready`（请求收下到收到 started 事件）。旧版运行端也能从
  控制端记录这些阶段；打开请求返回不代表 Agent 已经就绪。
- `side=host`：`resume-workspaces`、`guest-registration`、`shadow-workspace`、
  `tunnel-prepare`、`provider-route`、`agent-session`（原生 Agent 启动与会话建立）、
  `session-registration`。仅实际经过的阶段输出。

每阶段先输出 `status=started`，结束输出 `ok` / `failed`、`durationMs` 和 `elapsedMs`；
`stage=total` 汇总本端总耗时与 `stagesMs`。使用各端自己的单调时钟，不相减不同电脑的
墙钟；`remote-open` 包含 transport 与 host 的等待，不能把三侧耗时相加。配置收集仍为
best-effort，因此某项失败而总启动成功是合法结果。只记录固定阶段名、关联标识、结果、
耗时及下列固定诊断计数，不记录配置正文、路径、消息、凭证或错误正文，不改变日志上报白名单。
控制端 `side=transport` 的 `stage=total` 可带 `payload`。其中 `uploadBytes` 和 `chunks` 是
计划上传的 gzip 字节数与分段数，分段准备完成后，即使上传失败也会记录。内联载荷两项均为
零，分段准备失败时省略未知的值。`fieldBytes` 记录固定载荷字段各自序列化后的 UTF-8 字节数。
运行端 `stage=total` 另带 `execServer`：`shortcutEnabled`、`ancestorLevels`（收到的祖先快照层数）、
`connections`（识别到的执行环境连接数）、`answered`（本地回答数）、`forwarded`（转发消息数）。
计数仅覆盖创建至 started/失败，不含首轮消息及后续工具调用；只含布尔值和计数，无路径与 RPC 内容。
没有此字段不能推断优化已启用；`shortcutEnabled=false` 需核对虚拟工作区或更早的启动失败，
`ancestorLevels=0` 需核对快照传递，`connections=0` 需核对执行环境接线。已启用且连接存在却
`answered=0`、转发很多时，再核对查询是否属于已确认不存在的路径；不能仅凭零命中扩大短路范围。
Codex 的 `session-ready` 还包括原生会话启动时经执行环境读取项目说明与 Skill 的多轮往返，
不能直接称为模型推理耗时；同一供应商的项目任务与空任务对照可帮助区分项目初始化开销。
若带 Skill 的项目显著更慢，可在同一临时项目里用「无 Skill → 一个最小 Skill → 撤回 Skill」
对照。2026-10-26 实测为 5.3s → 37.4s → 6.0s；一个 Skill 就触发沿 36 层目录逐个检查
三种插件清单的 108 次查询，全部不存在，扫描阶段占 32.3s。原项目同类扫描占 59.4s / 73.6s。
Git 元数据查询可以成批并发，不能仅按总查询数推断耗时；应区分串行目录探测与本机处理时间。
`host/execServerShortcut.ts` 在实际运行 Agent 的电脑上减少已确认不存在的目录查询；供应商组
中转时还需核对最终运行端。控制端更新不能证明该短路已经生效，仍收到虚拟垫层的查询时应先
核对运行端版本和路径。镜像外未知路径必须保留转发，不能为省往返一律回答不存在。

2026-10-26 本机隔离对照（Windows，真实 Codex/exec-server 与生产 Controller/Host，模型回复和
插件业务为 loopback mock，不调用分享供应商）：同一 Skill 项目，只替换短路返回值，分别不加延迟与
在每次 poll/push 返回前增加 100ms。创建到 handle 返回的单次样本为：

| 模拟链路 | 关闭短路 | 开启短路 | 启动阶段本地回答 |
| --- | ---: | ---: | ---: |
| 无附加延迟 | 615ms | 399ms | 128 次 |
| poll/push 各附加 100ms | 14,649ms | 4,150ms | 128 次 |

有延迟组创建耗时下降 71.7%；启动阶段元数据转发 157 → 29，总执行环境转发 164 → 36。
这是模拟链路的样本，不是线上 SLA，也不等同于普通本地供应商的直接启动路径。
四组均验证 Skill 描述进入模型、真实命令读回 Skill 正文，以及通过真实 Cindy MCP 网关完成
`ghost_list` / `ghost_info` / `ghost_call` 并收到 mock 插件业务结果。运行端原生插件按 guest 隔离关闭，
不包含第三方插件安装、原生插件运行时或 UI 验收。`mirror.test.ts` 另验证三种真实存在的插件清单
在映射路径和原始绝对路径下仍转发，不会被判为不存在。

当前源码本机能够命中；尚未证明原分享运行端未命中的具体原因，不应把控制端加日志或本机通过
写成线上已修复。现场查询格式、方法和消息长度符合短路入口，最终运行端版本及接线路径仍待核验。
本次补齐命中统计与可重复对照；测试还修正了 mock 调用方式，并阻止测试引擎后台同步原生插件目录，
避免 Windows 遗留 Git 子进程影响收尾。

2026-10-29 补充：已有短路仍会留下插件清单的串行检查。`host/execServerStartupBatch.ts`
在启动阶段第一次遇到未短路的插件清单 `fs/getMetadata` 时，沿该目录向上最多 64 层，
为三种清单提前发送普通原生查询（最多 192 条，已知不存在的虚拟路径仍由旧短路排除）。
复用既有 poll/push 批次、路径投影和原生 sandbox，不添加协议字段、方法或能力。
只有原生 `-32004` 才能缓存并回答同连接、同参数／sandbox 的后续元数据查询；已在等待该次
查询的原请求直接消费原生成功或错误回包，避免丢弃后再发相同 RPC。成功元数据与权限错误不缓存，
后续请求、未知路径及超出预算的路径继续按原查询处理。不缓存文件内容。
启动结束、出现写操作／启动进程时停止复用并释放等待中的原查询；连接关闭时清理。
内部查询 ID 与原生 ID 隔离，迟到的内部回复不能送给 Codex。每条连接只提前查询一次。
请求的 16 KiB 优化预算不用于回复解析，否则较大错误回复会漏消费内部 ID，并使原查询继续等待。
对端关闭及超限分片主动关连接时显式清理批处理状态，不能依赖不会触发的 `wsClose` 回调。

同日 Windows 隔离基准：真实 Codex 0.159.2、原生 exec-server、生产 Controller/Host，
同一项目 8 个合成 Skill（`.agents` 与 `.claude` 各一份），每次 poll/push 返回增加 400ms。
两侧实际均为 Windows，仅移除原始绝对路径缺失快照，模拟跨系统时不能复用该快照的分支；
不读取真实项目 Skill 或分享者数据，不请求线上模型。仅开关新增批量实现，按关／开／关／开运行：

| 样本 | 批量关闭 | 批量开启 | 回传批次（关闭 → 开启） |
| --- | ---: | ---: | ---: |
| 1 | 24,282ms | 7,469ms | 56 → 15 |
| 2 | 24,214ms | 7,434ms | 56 → 15 |
| 均值 | 24,248ms | 7,451.5ms | 56 → 15 |

启动耗时下降 **69.3%**。真实转发查询仍为 78 条，优化的是串行往返；全部提前查询的实际
处理和回传成本已计入（此前直接复用已知缺失结果的 6.2s 只是因果实验，不是实现后的数字）。
启动本地回答 100 → 142；`forwarded` 包括提前查询，`answered` 包括复用结果，两者相加不再
代表原生 Agent 发起的原始请求总数。完整基准命令：
`pnpm --dir apps/desktop exec vitest run src/main/remote-agent/__tests__/startupProbe.e2e.test.ts -t 'batches eight-Skill' --maxWorkers=1`。
实测测试体 67.02s、含模块加载 107.45s；默认 unit 不运行此手动 e2e。
这证明受控慢链路的因果收益，不承诺现场 95s 变成 7.5s；真实 Windows/macOS 跨设备及原分享供应商仍未验收。
优化需实际运行 Agent 的电脑更新，任务所在电脑和中转可保持旧版。

复跑：`pnpm --dir apps/desktop exec vitest run src/main/remote-agent/__tests__/startupProbe.e2e.test.ts --maxWorkers=1`。
该文件登记在手动 e2e tier，真实进程与延迟不进入默认 unit。单文件两组对照实测 56.11s（含加载）；
最终四组测试体 31.14s，与 roundtrip 合跑共 71.68s。其余相关定向回归 77 通过、1 跳过。

实现：`remote-agent/startupTiming.ts`、`controller/startRemote.ts`、
`controller/runClient.ts` 与 `host/runHost.ts`；回归：`__tests__/roundtrip.test.ts`
以及 `__tests__/startupProbe.e2e.test.ts`、`__tests__/mirror.test.ts`
（上述路径均相对 Desktop main 的 `remote-agent/`，首项相对 Desktop main）。

`device-link request slow/failed/timeout` 另记录 `firstWriteWaitMs`（请求建立到首次
WebSocket 写入成功）与 `afterFirstWriteMs`（首次写入到结束）；从未写出时记录
`firstWrite=none`。写入成功不是送达回执，后半段仍包含 socket/relay/网络、对端处理和
接收端调度。可靠层在至少 250ms 的等待或重发时记录发送 `queueMs`（首次写出）／
`ageMs`（重发时消息年龄），以及接收 `assemblyMs`（首分片到重组完成）／
`orderedWaitMs`（重组完成到按序交付）。新增阶段时长使用各端单调时钟，以 requestId 关联，
不相减不同设备的墙钟，也不改变 wire、ACK、重试或授权语义。

本地目录联合刷新和远程目录变化推送共用 `coalescedRefresh.ts`：同轮通知合并，
在途期间只保留最新一次补读；失效立即推进已有代次，旧结果不提交。整组读取结束
（包括失败后的其它成员）才释放刷新位置。账号切换或远程断连后的新代次独立刷新，
不等待旧请求超时；已经取消的补读不重新打开连接。该合并不引入结果缓存或定时重试。
同账号桌面远控的目录刷新须同时处理 `maker:provider:changed`、`maker:agents:changed`
和 `provider-group:changed`：Main 对三者都会作废目标的在途元数据读取，Renderer 若漏接
其中一种，迟到的 `Metadata scope changed` 就可能让模型选择器停在失败状态。收到这些
事件时沿用上述合并刷新，只推进对应设备的代次；剩余信任时间为零的通知仍只清除目录，
不发起补读。保护账号／撤权边界的 Main 校验不变，也不重建共享链路或 relay。
回归见 Desktop `deviceLinkRemoteRecovery.test.tsx` 与 `remoteCatalogSnapshot.test.ts`。
宿主的只读元数据入口也区分来源刷新与权限代次：请求返回前来源刷新使旧结果作废时，
仅在原账号、区域、权限代次及准入条件仍有效时补读一次，第二次仍作废则正常报错。
这样没有 Renderer 订阅的读取也能恢复；不把普通 scope 错误归类为网络瞬态，
不跨撤权、断连、账号切换或零预算退休通知补读，不复活旧快照。
回归见 Desktop `providerMetadataContinuity.test.ts`。


## PR 门禁

功能类 PR 的 Description 必须写明上述每一项的结论，三选一：

1. 本 PR 已一并适配；或
2. 已开跟踪 issue 并贴链接；或
3. 说明为什么不涉及（给出理由，不能只写「不涉及」）。

review 按此检查：功能类 PR 缺这段说明 = P1。

触及 device-link 重试／超时／断链恢复路径的 PR，Description 还必须写明「故障半径
三问」的结论（故障层级、动作层级、多 peer 用例）。缺失同样 = P1。

## 桌面远程文件获取的进度

- 直传进度来自接收端每次成功写入的字节数，经 `device-link/fileAccess.ts` 的
  `onProgress` 交给调用方；工作目录内的大文件与目录外的媒体取件都必须接入。
  日志采样不是 UI 进度源，不能等整份文件返回后才上报 100%。
- 聊天打开／定位／复制、下载到本地和侧栏大文件预览，共用
  `file-browser/transfer-progress.ts` 推送到发起窗口。用本机 IPC 的 `requestId`
  关联消费者，不按路径判断归属；它不进入跨设备协议，旧调用可省略。
- 提示、文本预览与侧栏预览共用 `renderer/lib/fileTransferProgress.ts` 的订阅或采样。
  订阅先于请求，完成、失败、卸载时释放；同一路径跨设备、并发获取与下载互不影响。
  阶段切换、回退重置和完成不被限频丢弃；字节回退重置速度，总量未知不显示百分比。
- 文件夹下载仍使用既有打包／发送／下载／解包进度。SSH 使用分片字节或 tar 流字节；
  不将播放中的 Range 缓冲当作整文件下载，也不为媒体协议后台预取弹出下载 Toast。
- 目录外媒体回退旧 `media:fetch` 上传接口时，该接口没有上传字节回调；准备期间不编造
  上传百分比，开始本机下载后再显示真实进度。手机版有独立接收与播放器缓冲链路，
  不消费桌面本机 IPC；相关界面进度由 [PR #5542](https://github.com/makecindy/cindy/pull/5542)
  跟进，桌面修复不代表手机已覆盖。

回归入口：`device-link/__tests__/filePeer.test.ts`（分块、观察者异常、取消与账号失效）、
`device-link/__tests__/fileAccess.test.ts`（两类入口及回退）、
`file-browser/__tests__/chatFile.test.ts`、`file-browser/__tests__/transferProgress.test.ts`，
以及 `renderer/__tests__/remoteFileProgress.test.ts`
（并发隔离、释放、百分比和速度）。源码路径均相对 `apps/desktop/src/main/`，
最后一项相对 `apps/desktop/src/`。

## Review 清单

1. 涉及 workdir／agent／会话数据的功能，在 SSH 远程下是否走远程通道而非本机 `fs`？
2. 新 IPC／推送是否按 allowlist 判据登记 invoke／push 白名单并同步 topic 路由？
3. 手机版入口／UI 是否已适配或明确跟踪？
4. PR Description 是否给出了三选一结论，而不是留空或只写「不涉及」？
5. 触及重试／超时／断链恢复路径的改动：恢复动作是否与故障同半径？扩大半径是否给出
   明确理由？是否有多 peer 拓扑用例证明其它 peer 零感知？

### 同一台电脑的旧可靠连接与新会话同时存在

同账号 Device Link 等待恢复时，新的任务列表、单条及批量会话读取、待恢复会话和运行中任务查询可以在已认证的 Agent-Net 会话上发出，回包按请求来路交付。旧连接上尚待确认的写入和回执继续在原处恢复。等旧连接没有待发帧、也没有业务请求等结果时，下次控制握手可以交给新会话，再按原订阅流程建订阅。跨账号连接仍按分享资源绑定。对同一台电脑的同一轮拨号共用等待；同会话、相同握手内容和超时预算的并发建链共享一次握手。

即使 Device Link 显示就绪，同账号设备的可靠窗口、发送缓冲或发送配额也可能阻塞。只在发送端确认本次调用一片都没写出时，任务快照、资源目录（manifest、list、get）与新远程桌面连接的能力、认证协商和启动请求可以交给同一设备当前已认证的 Agent-Net 会话。能在入队前判断就不占序号；已占序号的先撤下原业务帧，同序号保留 skip。只切这一次调用，已发出的分片、结果未知的请求、旧订阅和其他设备继续走原路。新桌面连接在备用会话上取得的租约，其信令、输入和停止跟随同一会话；等待发送时复核取消、显式断开和会话身份。故障证据与动作限于这台设备的一个请求，沿用现有协议和被控端权限检查。

单台电脑的业务超时或拨号失败只触发路径验证。手机对目录中在线的设备首次拨号失败时，也验证当时使用的中继连接。桌面和 Host 对 WebSocket 中继发协议 ping；手机在同账号中继 hello 声明 `relayProbe: true` 时才发送 `relay-probe`，中继在当前已认证连接上回答 `relay-pong`。手机每 15 秒最多一次探测，有应答就保留连接；正常调度下探测满 15 秒仍无应答才触发这条上行的重连。中继不向访客声明这个能力。旧客户端忽略新增 hello 字段，新客户端连旧中继时不发新帧；官方和自建中继共用实现。中继连接恢复不重建其它设备的直连，也不重发已经送达的业务操作。

回归入口为 `agentNetSessionLinks.test.ts`（64 帧积压、读写分流、订阅接手、并发建链，以及真实回环 WebSocket 上单向阻塞 27 帧时的资源查询和远程桌面建连）、`portableClient.test.ts`（应答、静默、旧版握手）、`workerSocket.test.ts` 和中继 `relay.integration.test.ts`（真实 WebSocket 往返）。
