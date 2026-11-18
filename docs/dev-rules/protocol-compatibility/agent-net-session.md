# Agent-Net 会话层 v1（2026-11-14；2026-11-16 起跟着「Agent-Net (Beta)」开关）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 方案见 [`agent-net-session-plan.md`](../../agent-net-session-plan.md) 第 10.1 节，压测见
> [`benchmarks/agent-net-session-2026-11-13`](../../benchmarks/agent-net-session-2026-11-13/README.md)。

两台新版节点之间，业务流量不再装成 Device Link 的帧、不再经过 Device Link 的可靠传输，而是走 Agent-Net 自己的会话层：
同一条端到端加密连接上的三条核心流。Device Link 不知道它存在，代码和行为都不变（2026-11-14 用户要求「完全解耦、不要相互影响」）。

- **开启方式（双方都要新，且上层都启用了会话）**：上层启用会话（`useSessions`）以后，节点在每条连接自己的控制流
  （类型字节 `C`，每行一个 JSON）上发一行 `{"session":["agent-net-session-v1"]}`，之后新建的连接也发；没启用的节点不发。
  不能一连上就发：对端没人读会话的话，这一端的建链请求要等到超时。旧节点只读这一流里的 `candidates`，忽略这一行。只有收到对端这一行以后，
  这一端才开会话流：旧节点遇到不认识的流类型会关掉整条连接，所以绝不能先开。所以新旧任意组合都照旧走 Device Link 的帧，
  不需要发布顺序。2026-11-16 起跨账号委托连接上也开（见下「跨账号」），之前的版本在委托连接上不宣告，和新版本组合时照旧走分享帧。
- **在线状态（2026-11-16）**（`portableSocket.ts` 的 `presenceRoute`）：同账号的节点在宣告那一行里多带一项 `presence-v1`
  （`{"session":["agent-net-session-v1","presence-v1"]}`；之前的会话节点只看版本那一项）。两端都带了，在线状态（`presence-changed` 的内容）
  只在会话的 `presence` 消息里来回，这条连接上就不再有任何 Device Link 的帧；收到的在线状态按连接身份交给本机，不信它自报的设备号。
  新连接上先等对端的宣告（最多 1.5 秒，通常一个往返），不先发帧：对端宣告了但没带 `presence-v1`、或到时没宣告（老版本），
  就和以前一样发 Device Link 的帧，这条连接之后也一直发帧；老版本对端看到这台上线最多晚 1.5 秒，别的不变。跨账号的委托会话不带在线状态（同分享帧）。
- **跨账号（2026-11-16）**（`packages/agent-net/src/portableSocket.ts` 的 `sessionScope`）：供应商分享（含供应商组的执行电脑）与共享任务的
  受邀者连接上也开会话。会话的键不是连接 id，而是委托决定的逻辑对端，和这条连接上的分享帧解出来的完全一样（`scopedRoutes.ts` 的
  `delegatedPeerKey`）：分享资源一端看到的是委托里的受邀者设备与成员，受邀者看到的是它连着的那台分享资源的电脑（拥有者或执行电脑）。
  会话是单向的（`SessionPeer` 的 `role`）：受邀者一端 `call`，只发 `open`、`invoke`、`cancel`、`close`；分享资源一端 `serve`，只发 `accept`、
  `reject`、`result`、`push`、`close`；对方发来不该它发的消息直接丢弃、不交给业务，本端越界的调用报 `FORBIDDEN`，与分享帧的边界一致。
  `presence` 两边都不发。每条消息收发前都复核委托仍有效、仍是同一资源与成员、仍在这条连接上；撤销、暂停、移出成员时连接被关，会话随之作废。
  `useSessions` 的 `delegatedOnly`：只开委托里的会话（只服务分享资源的连接不承载同账号控制）。线上不新增字段，消息形状同上；
  Desktop 给跨账号的载荷和 Device Link 给跨账号的一样：不带结果传输声明（`transfer`）、不用列表与历史增量、建链不声明推送压缩。
  旧的受邀者或分享资源一端不宣告会话，组合里任一方旧都照旧走分享帧。
- **会话流**（`packages/agent-net/src/transport.ts`）：每个方向三条单向核心流，首字节是类型：`0x30` 控制与交互（核心交互级），
  `0x31` 普通（普通级），`0x32` 后台（后台级）。之后是一条条消息：`[长度 4 字节，大端][UTF-8 JSON]`，单条最大 16 MiB。
  收到的一方在本端会话还没准备好时最多先存 16 MiB，超过就关连接。
- **跨线程**（`packages/agent-net/src/session/workerSessions.ts`）：Desktop 的核心在 worker 里，会话（分帧、跨流先后、JSON）也在 worker 里，
  Main 拿到解好的消息，业务处理完一条才回执，这条流才交下一条，和同一线程时一样；每个请求走哪条流由 Main 决定。只在同一进程的线程之间，不上线。
- **消息外层**（`packages/agent-net/src/session/lanes.ts`）：`{ m: 消息, c: "control"|"request"|"result"|"push", p?: [3 个数], r?: 数, b?: 数, o?: 1 }`。
  `p` 只在结果上：发出这条结果时三条流上各已发出多少条推送，接收端等这些推送都交给业务以后才交出这条结果；
  `r` 只在控制流上的请求：之前在普通流上发出的请求条数，接收端等那么多普通请求交出以后才交出它。
  每条流内按收到的顺序逐条交给业务、等上一条处理完再交下一条；只等发送方更早发出的消息，所以不会互相卡死。
  编码后超过 256 KiB 的请求一律走后台流。2026-11-17 起它保住自己在请求里的位置（审查：一次很大的排队消息编辑可能晚于之后的「发送」执行）：
  它带 `r`（等之前的普通请求）和 `o: 1`；之后的普通、交互请求带 `b`（之前发出的 `o` 请求条数），接收端等那么多 `o` 请求交出以后才交出它们。
  幂等读（调用方标 `unordered`）不带 `b`、自己也不算 `o`，照旧越过大请求；故意走后台流的（文件块、迁移）不算 `o`。
  `close` 也带 `p`、`r`、`b`：等之前的推送和请求都交出以后才交出（原来走控制流越过最后几条推送，对方随后丢掉它们；关链之前的订阅在关链之后才处理）。
  接收端积压超过 64 MiB 视为会话损坏。旧的会话端不认 `b`、`o`，只是不按它们等。
- **消息**（`packages/agent-net/src/session/peer.ts`，字段 `t`）：
  `open {id, payload}` / `accept {id, payload}` / `reject {id, code, message}`：对应今天 `link-open`/`link-accept`，载荷原样；
  `close {reason}`；`invoke {id, channel, args, x?, at?, ms?}`（`x` 放 channel、args 以外的请求字段，Desktop 用它带 Device Link 的 `transfer` 声明；
  `at` 是发送方写出时自己的单调时钟毫秒数，`ms` 是调用方的时限，见下「超时」）：按通道选流（交互→控制流，前台→普通流，后台→后台流，同 `invokePolicy`），
  结果 `result {id, result: {ok, result} | {ok:false, error:{code, message}}}` 走请求来的那条流；`push {channel, payload}` 在 v1 里一律走普通流
  （同一方向的推送共用一个顺序，保住「任务列表补丁是任务事件的分界」这类跨主题先后）；`presence {payload}`；
  `cancel {id}`（2026-11-16）：走控制流，调用方超时了，这条请求还没交给业务的话就不再交。
- **Desktop 的控制链路**（`packages/agent-net/src/session/sessionLinks.ts`）：`open`/`accept` 的载荷就是 Device Link 的
  `LinkOpenPayload`/`LinkAcceptPayload`，控制端只加推送压缩的字典能力；结果一律包一层 `{ok: true, result: InvokeResultPayload}`，
  外层只表示送达，业务的成功与失败原样在里面，不和会话层自己的失败码混；推送的 `payload` 是整个 `PushPayload`
  （含 `ownerStamp`，可能按建链时声明的字典压缩过）。结果压缩与增量、正文复用、历史页增量、标签目录、模型速度编码和 Device Link
  用同一批模块、同一套请求字段。
- **送达与失败**：只靠核心送达，不确认、不计时重发、不因慢重置。请求没写出去报 `NOT_SENT`（可安全重试）；写出后超时报
  `INVOKE_TIMEOUT`。连接换了（断开重连、对端重建节点），旧会话随旧连接作废，新连接重新声明、重新建会话。
- **断线续传（2026-11-17）**：写出去以后会话断了，控制端不马上报 `DEVICE_OFFLINE`：会话回来时请业务按 Device Link 传输重置时的同一个重开循环
  （`transportTimeoutReopen`）重开链路，重开后在新会话上用**原请求号**再发（`invoke.id` 由调用方给，`SessionRequestOptions.id`）。被控端的
  dispatch 按「控制端 + 请求号」去重：结果记着就回记着的，还在跑就等那一次的结果，不会再执行。被控端在会话的 `accept` 载荷里多带
  `agentNetInvokeEpoch`（进程、整体清空次数、对这个控制端的清空次数，`dispatch.remoteInvokeEpoch`）。双端须在建链时确认
  `agentNetResumeOnly`；旧端或重开后的代次不同就不再发。重发请求也带 `agentNetResumeOnly`，被控端只找已有结果、待发回复或同一个
  在途调用；没有记录（例如结果被有界缓存淘汰，或原请求未到达）时报「可能已执行」，不重新执行写操作。
  幂等读照旧报 `PEER_RESET` 让业务重读；文件块不续。跨账号（2026-11-18）同样续：分享连接用到时才拨，会话断时有请求在等就马上请业务重开
  （重开循环先拨通对方电脑），被控端同样在会话的 `accept` 里带 `agentNetInvokeEpoch`。只在会话上，Device Link 的 `link-accept` 不带这一项。
- **诊断日志（2026-11-18）**：会话上的请求和 Device Link 一样记日志：超时 warn，失败、超过 1 秒（加上通道本来要挂起的时长）debug；建链失败 debug。
  只写通道名（不在远程调用名单里的写 `unknown`）、缩短的设备号、通道、次数与耗时，不写参数和结果。
- **积压读数（2026-11-17）**：会话的 `bufferedAmount` 是控制、普通两条流在 JS 这边还没交给核心的字节，加上核心里还没发出、还没确认的
  （核心导出 `conn_stream_buffered`，`SendStream.coreBufferedBytes`），后台流只算 JS 这边的。worker 在积压清空前每 50 毫秒报一次。
  Desktop 把它当 Device Link 的可靠队列深度用（慢线路上推送改发快照，交互回复不排在大批推送后面）。
- **超时**（2026-11-16，方案第 5.4 节「调用方已判定失败的请求之后也不执行」）：请求超时后调用方在控制流发 `cancel`；
  接收端还没把这条请求交给业务就记下，请求到了也不交，已经在处理的不打断（结果照常回去，调用方忽略）。只靠取消不够：断网后核心
  先重传更早写出的请求，取消可能后到，所以请求自己带 `at` 和 `ms`。新版建链回复带被控端发回复时的单调时钟。控制端以收到回复的时刻保守估计时钟差，把时限换成被控端时钟的 `deadline`；
  被控端据此检查首条请求，在控制端超时后不再启动。无此字段时，接收端记下该会话上「本端收到时刻 − 发送方写出时刻」的最小值
  （两端时钟之差加最快的一趟），一条请求比它晚了 `ms` 以上才交到业务（路上卡住、重传、在本端排队），说明调用方已经放弃，就不交。
  两端时钟不需要一致。不带 `at`、`ms` 的请求从不按晚到处理；不认识 `cancel` 的会话忽略它。被丢掉的请求不回结果：调用方已经报了
  `INVOKE_TIMEOUT`（可能已执行），读请求按原有名单重试一次时用新请求号。Device Link 在同样情况下把超时的请求从待发队列撤掉。
- **安全**：会话只跑在双方证书都通过验证的加密连接里；每条入站消息交给业务前都重新核对对端仍在授权名册里，
  不在了就作废会话并关连接。来源取自连接身份，消息里不带来源字段。跨流计数须为非负安全整数，非法帧只终止所属会话。推送的内外通道须一致，再按该通道检查链路权限。
- **自建中转与官方中转**：中转只转发核心的密文数据报，看不到会话流，无需改动，也不需要递增 `RELAY_VERSION`。
- **Desktop 接入**：2026-11-16 用户确认，会话层跟着「Agent-Net (Beta)」开关走，不再有单独的开关：打开 Agent-Net 的 Desktop 都宣告会话能力，
  两台都宣告了才走会话；Agent-Net 关着时没有 Agent-Net 连接，所有业务照旧走 Device Link（开关默认关）。之前的开发期环境变量
  `CINDY_AGENT_NET_SESSIONS` 去掉了。选路规则见[远程适配](../remote-and-mobile-adaptation.md)「Agent-Net 会话层上的控制链路」。
- **Desktop 跨账号接入**：资源专用连接（`openScopedAgentNetAppSocket`）打开时开关开着才启用会话，且只开委托里的会话；会话只认这个资源
  在 Device Link 那边登记的那条连接（`agentNetSharing.ts`），停用、已退出、登记被收回的资源没有会话，还没登记的只认主连接（同路由客户端的
  `acceptsScopedEvent`）。受邀者第一次建链前先连上对方电脑
  （`connectSession`）再等会话。细节见[远程适配](../remote-and-mobile-adaptation.md)「跨账号」。
- **覆盖情况**：同账号两台电脑隔离验收两个方向都走过（[对比报告](../../benchmarks/agent-net-vs-device-link-2026-11-16/README.md)「稳定性」）；
  取消与超时见上。跨账号在真实核心、中转与分享授权的集成测试里走过两种资源；2026-11-16 又在两个账号的两台真实电脑上验收了共享任务
  （经官方 Agent-Net）：受邀者第一次建链先连上再等了 91 毫秒拿到会话、建链 151 毫秒，读历史、发消息、回复实时推回都走会话；
  主人移出成员的同一秒两端会话都作废，受邀者的共享任务列表随之变空。2026-11-17 供应商分享也在真机上走过（个人账号的 Desktop 把
  「Cindy AI · 个人」分享给 XD 账号的 Desktop，经官方 Agent-Net）：批准后两端马上建好会话，受邀者经分享读主人的供应商列表每次
  30–59 毫秒、只看得到分享出来的那一个；主人移出成员后会话两端作废，受邀者真正的调用被拒（连接已停）。同一台受邀者电脑上的
  供应商列表缓存在移出后还会回一次旧结果，这一层在传输之上，走 Device Link 时一样。
  2026-11-17 Node Host 接入（Windows 上的 Host ↔ macOS 上打开 Agent-Net 的 Desktop，同一个个人账号，官方 Agent-Net）：Host 加入后
  0.1 秒会话就绪，Desktop 经会话调用 Host 每次 13–15 毫秒（直连）；Host 关掉 Agent-Net 后经 Device Link 中转每次约 300 毫秒，
  再打开不用重启就回到 Agent-Net（已开着的链路按「中途不换路」用到关链）。真机里发现 Host 关着时不签传输方式声明、开着 Agent-Net
  的 Desktop 拒收（`Untrusted transport mode`），已改成和 Desktop 一样关着也签。
  2026-11-18 手机接入：会话对接（`AgentNetSessionLinks`、选路 `routeSessionPeers`、`PeerLinks`）从 Desktop 移到
  `packages/agent-net/src/session/`，Desktop、Node Host 与手机共用一份；手机在 `apps/mobile/src/device-link/DeviceLinkContext.tsx`
  与 `agentNetRuntime.ts` 装配，只在手机能用 Agent-Net 时挂上（没开时客户端和原来完全一样，不经会话层）。手机的原生连接（`packages/agent-net/src/nativeTransport.ts`）有了同样的三条会话通道、宣告与积压读数
  （核心缓冲按流读回，原生库的 `stream-buffered`）；同账号走会话（含 `presence-v1`），共享任务的受邀者在它的分享连接上走单向会话。
  手机只控制：不接受链路，`invokeEpoch` 不提供。会话断了又回来时按 Device Link 传输重置的同一流程恢复这个对端（只这一个）。
  旧安装包的原生库也能走会话（只需要流）；它的 `identity()` 没有 `features` 时不用中转 UDP、STUN 与按流积压，也不调用新操作。
  回归：`packages/agent-net/src/__tests__/native.integration.test.ts`「carries sessions on the real native engine, relays them over UDP,
  and keeps working on an older native build」（真实原生库的 C 接口、真实 V2 中转与 Node 节点；去掉原生的会话宣告时会话一直不出现）。
  真机还没测。
  同日真机里还发现 Host 的 `link-accept` 一直不带 `background-link-v1`（和 Agent-Net 无关，主干上也一样）：电脑的后台读取每次新开链路、
  发现不支持就关（`backgroundLink.ts`），调用方再读又开，一秒几次。Host 的入站处理和 Desktop 是同一套，本来就按后台链路处理，
  现在 Host 开着 Agent-Net 时 `sameAccountCapabilities` 带上这一项（会话上每次后台读都重建一条会话链路）。按用户定的原则「改动只影响
  Agent-Net」（2026-11-17 复审），关着时和主干一样不带，主干上 Device Link 的这个问题另行处理。
  文件字节、无链路推送与远程桌面的通道见[文件直传走会话](agent-net-file-stream.md)。
- **Node Host 接入**：`cindy-host remote agent-net-on|agent-net-off` 控制，默认关；关着时主连接就是原来的中转，行为不变。
  身份按「区域服务 + 账号」各存一条在 Host 的凭证库里（不进日志与配置），注册只用账号令牌一次，到期前一天续签、续签失败而
  证书未到期时继续用旧的。Host 只加入本账号的官方网络；跨账号分享与自建中转在 Host 上照旧走 Device Link。线上格式与 Desktop 完全一样，
  不新增协议字段。

回归：`packages/agent-net/src/__tests__/sessionLanes.test.ts`（结果等之前的推送、不等后台大数据；交互请求等之前的普通请求、
越过后台上传；超过 256 KiB 的请求改走后台；超时后的请求不交给业务，晚到的、取消先到的都试）；`packages/agent-net/src/__tests__/socket.integration.test.ts`
「carries an independent session between two new nodes alongside Device Link frames」（真实核心与中转上协商、建链、请求、推送，
同一个 socket 上的 Device Link 帧照旧送达；只有一端启用时不出现会话）、
「runs sessions in the worker and hands a result over only after the business handled the earlier push」（真实 worker 里的会话，
业务没处理完之前的推送，之后的结果不交出）、「carries %s requests with host-signed member scope and revokes only that guest」
（跨账号：会话键、单向、`delegatedOnly`、撤销后两端会话作废）；`packages/agent-net/src/__tests__/portableSocket.test.ts`
「keeps presence on the session with a new peer and still sends the frame to an older one」（在线状态只在会话上、连接上没有 Device Link 帧，
老版本对端等过以后收到帧，自报的设备号不算数）。端到端对比用 `packages/agent-net/bench/session-latency.ts --modes v1,session`。

### 自建中继上的新分享

自建中继在 `/info` 广告 `private-sharing-v1` 后，新版桌面端创建的分享使用版本 3 的邀请。新邀请需要支持该版本的客户端。版本 2 的邀请继续使用原身份服务；官方网络及历史成员记录沿用原有权限。

`/private-sharing/` 使用独立的资源和权限记录。创建者提交本网络签发的成员证书和请求签名；访客用设备保存的密钥签名，请求绑定中继根公钥、网络、路径、正文、时间和一次性随机数。供应商分享仍需主人批准；获得业务成员身份后，连接还需要对应资源的委托签名。附件继续经原有端到端加密传输。旧附件按原引用读取，只存于官方服务器的历史附件需要该服务器可达。

桌面和手机分别保存版本 2 与版本 3 的分享路由，回退客户端后版本 2 的路由仍可读取。同一私有网络的已配对设备以主人身份读取自有任务，远程取消共享仍由原房主设备执行。自建中继移除租户时，随网络撤销该租户的分享与邀请。
