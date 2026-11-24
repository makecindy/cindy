# 官方 Agent-Net 上不认 Device Link 里删掉的设备（2026-11-17）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项约定。
> 会话层见 [Agent-Net 会话层](agent-net-session.md)。

**问题。** Device Link 删设备后，服务端留一条删除记录、把那台设备踢下线，它要在那台电脑上重新登录（登录时间晚于删除）
才能再登记。官方 Agent-Net 不看这条记录：被删设备的证书照样有效、照样能续签（注册只核对账号令牌），同账号的电脑照样
和它建会话、收它的请求。开着 Agent-Net 时设备列表还会从 Agent-Net 名册里把它补回来，看起来像没删成。官方 Agent-Net 的
撤销又是永久的（`DEVICE_REENROLLMENT_REQUIRES_APPROVAL`，之后只能靠加入码加别的电脑批准才能回来），和「重新登录就恢复」
不一致，所以这里原先选择删除不去撤销 Agent-Net 证书。

**和主干的撤销并存（2026-11-17 rebase）。** 主干同日合入的 `deviceLinkApi.ts` 在官方网络上删除时，Device Link 接受删除后会撤销这台
设备的 Agent-Net 身份（它不在 Device Link 里时按 404 直接撤销）。两者现在都在：撤销全网立即生效；下面的列表规则另外覆盖别处的删除
（手机、网页、旧版不撤销）和撤销请求没发出去的情况。两者都保留（用户定）。

**被撤销的设备重新登录后照常走 Device Link。** 撤销是永久的，重新登录后它的 Agent-Net 回不来。原来它开着 Agent-Net 时：中继拒绝它
（握手 401/403，之后重新注册报 `DEVICE_REENROLLMENT_REQUIRES_APPROVAL`），连接层把这当成「设备已被移除」（4410），Device Link
也跟着停，整台电脑连不上；认得它的电脑名册里已没有它的证书，验不了它的签名声明，也拒收它的 Device Link 链路。现在：
- 它自己（Desktop `agentNetRuntime.ts` 的 `agentNetIdentityRefused`，Node Host `agentNetNode.ts` 的 `refusedFor`）：Agent-Net 拒绝它的身份时，
  这个账号与选择这次运行按「Agent-Net 关着」处理，主连接下一次尝试改走 Device Link，由 Device Link 自己决定（还被删着的 Device Link
  自己会报「已移除」，重新登录过的照常连上）；连着时被拒（4410）就按关着重建一次连接。签名声明说「没开」。「仅使用 Agent-Net」时不退回。
- 认得它的电脑：它已不在签名名册里时，用这条连接上它最后的证书（`lastKnownCertificateFor`）核对它自己签的「没开」，只认这一句，
  它还要在 Device Link 设备列表里（`agentNetTransportStatement.ts` 的 `offOnly`）。中继藏起一台在线设备也骗不出这句：签名要它自己的私钥。
回归：`agentNetRuntime.test.ts`「runs on Device Link once Agent-Net refuses this identity」、`agentNetNode.test.ts`「runs on the relay once
Agent-Net refuses this identity」（被拒后改走中转、签「没开」；对端只认它的「没开」，不认「开着」、不认被删的；别的错误不算被拒）。

**被移除的设备可以自己「重新加入」（2026-11-23）。** 原来官方 Agent-Net 的撤销是永久的，只走 Agent-Net 的设备（「仅使用 Agent-Net」）
重新登录也回不来。用户决定：被移除的设备不需要重新登录、也不需要别的设备批准，在这台设备上点「重新加入」就回来；代价是丢失的
设备也能自己回来，移除只起到踢下线的作用。只能让自己这台回来，不能替别的设备恢复。只用于官方网络。
- **线上格式（全部是新增，旧端不变）。** Device Link REST 新增 `POST /api/device-link/rejoin`（body `{}`，只认账号令牌里的设备号，清掉这台
  的删除记录，幂等，回 `{ deviceId, rejoined: true }`）；官方 Agent-Net 入网 `POST /api/agent-net/enroll` 的 body 可带 `rejoin: true`，
  这台已被撤销时用这次的钥匙重新发证书并以 `notBefore` 作废移除前的证书，自定义名不变；新证书不比移除前的晚（副本时钟偏差）
  时回 `409 CERTIFICATE_NOT_NEWER`，客户端按 Agent-Net 暂未恢复处理，再点一次即可。没带 `rejoin` 的入网照旧
  `403 DEVICE_REENROLLMENT_REQUIRES_APPROVAL`，所以被移除的设备不会在后台续签时自己回来，旧客户端认的错误码也不变。服务端实现在
  服务端仓 `device-link-server`（路由与 `db.ts` 的 `rejoinDevice`）和 `packages/agent-net-relay`；本仓 `packages/agent-net-relay/src/server.ts`
  的官方入网分支同步了同一规则。
- **冷启动。** 官方入网可带 `reportRevocation: true`，区分已撤销（`403 DEVICE_REVOKED`）与钥匙不匹配。仅加密设备的明确撤销进入现有「已移除」恢复入口。手机首次握手错误时仍只做一次目录验证，普通网络错误不标记为移除。仅走 Agent-Net、从未通过 Device Link 登记的设备，在显式恢复时按账号令牌的本机设备号补齐名单。官方证书的签名序列号记录每次重新加入后的新成员代次，正常续签沿用，旧证书与旧委托不因副本时钟先后而重新有效。
- **顺序。** 先恢复 Device Link 登记（其他电脑只认列表里的设备），再带 `rejoin` 入网，最后重连本机自己的连接
  （`deviceRejoin.ts`；Desktop `agentNetOfficial.ts` 在 `rejoin` 时不论本地证书是否过期都重新入网，临时失败也不退回被撤销的旧证书）。
  一次点击各发一次请求，不自动重试、不轮询；只动本机的连接，不影响其他设备（范围见下面「重连的范围」）。
- **界面。** Desktop 设置页本机卡片在官方网络的「已移除」旁给「重新加入」（main 给连接问题带 `rejoinable`，自建中转不带）；
  删除确认框改为说明那台设备点「重新加入」即可回来。手机在横幅与首页连接行给同样的按钮（`apps/mobile/src/device-link/deviceRejoin.ts`）。
- **重连的范围。** 4410 只停了主连接。手机、Node Host 与 Desktop 都用 `start()` 只拉起这条主连接，别的账号分享来的任务与
  供应商连接照常运行（2026-11-23 review）。如果桌面主连接仍在运行，但需由 Device Link 切回 Agent-Net，则单独重启主连接。点击时的
  账号与中转在每个等待点之后核对，中途切号就整个停下，不替新账号入网或重连。
- **Node Host。** `cindy-host remote rejoin` 走同一流程（`apps/host/src/device-link.ts` 的 `rejoin` 复用 `rejoinRemovedDevice`；
  `agentNetNode.ts` 的 `rejoin` 不论本地证书是否过期都带 `rejoin: true` 重新入网）。Host 没有自建中转和「仅使用 Agent-Net」，Agent-Net
  回不来时照常走 Device Link。控制通道不传错误原文，结果和提示放在返回的 `rejoin` 里：旧服务端提示用 `cindy-host login` 重新登录；
  `cindy-host remote status` 在「已移除」时提示可以重新加入。
- **新客户端连旧服务端。** 没有 rejoin 接口时回 404，界面提示「服务端暂不支持，请在本设备退出后重新登录」；旧中转忽略 `rejoin`
  仍回 403，此时 Device Link 已经回来，不是「仅使用 Agent-Net」时照常走 Device Link，是的话提示先关掉它。发布顺序：先部署服务端。
- **自建中转。** 不涉及：自建中转的移除走它自己的配对与撤销，本机卡片不给「重新加入」，`deviceRejoin.ts` 在选了自建中转时直接拒绝；
  自建中转内核没有官方入网分支，不需要递增 `RELAY_VERSION`。
回归：本仓 `relay.integration.test.ts`「lets a removed device rejoin only when it asks to …」、`agentNetOfficial.test.ts`「enrolls again on
rejoin …」、`deviceRejoin.test.ts`、`deviceLinkIpc.test.ts`「rejoin:…」、`myDevicesPanel.test.ts`「MyDevicesPanel removed device」、
`agentNetNode.test.ts`「rejoins whatever the certificate expiry …」、`apps/host/src/device-link.test.mjs`「cindy-host remote rejoin …」、
手机 `deviceRejoin.test.ts`、`agentNetIdentity.test.ts`、`connectionBannerRecovery.test.tsx`；服务端仓
`deviceLinkRoutes.test.ts`、`db.test.ts`、`integration/deviceRemoval.test.ts` 与 `relay.integration.test.ts`。

**做法（只改客户端，服务端与线上格式不变）。**

- **列表是权威。** 官方网络上，每台电脑（Desktop 与 Node Host）只认本账号 Device Link 设备列表里的设备
  （`packages/agent-net/src/membership.ts`）。名册里有、列表里没有的，不拨、不收、不列出；那台设备重新登录、
  回到列表里以后自动放行。本机刚删掉的设备马上不认，删除之后开始读的列表才能把它放回来。
- **连接层当场判断。** 规则（允许的设备号，以及本机刚删的）交给 Agent-Net 连接（`AgentNetSocket.restrictPeers`，打开时用
  `peerRule` 带上），由它在每份名册到达时、每个数据包的授权检查里当场判断，被删的设备连一瞬间也连不上。规则变了会更新准入版本，
  核心记住的「拒过的握手」随之作废，放回来的设备马上连得上。跨账号的委托对端不受影响。
- **读列表的次数。** 同一时间只读一次，两次之间至少 10 秒，没到间隔的请求排到间隔一到再读一次；名册里出现列表里没有的设备
  （新加入、刚重新登录）时才读；被拦的设备又上线时最多每分钟确认一次（一台一直掉线重连的被删设备不会让各台电脑一直读）。
  设备列表界面、上线补名字等已有的读取顺带交给这里，不另外读。这台账号还没读过列表时（刚启动），打开 Agent-Net 连接前先读一次，
  和取中转信息并行，最多等 3 秒。
- **别的电脑上删的设备。** 这台收不到任何通知、名册也不变，所以连着 Agent-Net 时在后台定期再读：每 5 分钟（±20% 错开，
  免得各台电脑同一刻读）。还没读到过列表、上次没读到、或有被拦的设备在线（可能刚重新登录）时改成退避重试，从 10 秒起每次翻倍、
  最慢回到 5 分钟。Agent-Net 关着、换了账号时一次也不读（2026-11-17 review：原来名册不变就永远不再读，别处删掉的设备一直被认）。
- **读不到列表时。** 沿用上一次的结论；从没读到过就不拦，免得 Device Link 服务出问题时连 Agent-Net 一起不能用。
- **代价。** 一台全新的设备第一次出现在名册里时，要等下一次读到列表（最多约 10 秒）才连得上；安全优先，不给被删的设备留空窗。
- **范围。** 只用于官方 Agent-Net。自建中转上删设备时直接在 Agent-Net 上撤销（可以重新配对加回来），不走这里。
- **已知限制。** 开着「仅使用 Agent-Net」的设备被删以后只重新登录，因为不连 Device Link 中转，服务端不会恢复它的登记，其他电脑
  会一直不认它。它会显示「已移除」，点「重新加入」即可（经 REST 恢复登记，不需要连 Device Link 中转，见上文 2026-11-23）。
- **手机（2026-11-18，2026-11-21 补齐身份被拒回退）。** 规则移到 `packages/agent-net/src/membership.ts`，手机在 `agentNetRuntime.ts` 用同一份：准入只认官方 Device Link 的原始
  名单，普通的混合目录请求只把其中的 Device Link 结果交给准入。补读同一时间只发起一次，只在开关开启且连着官方 Agent-Net 时周期刷新。
  当手机自身的 Agent-Net 身份已被撤销（注册或首次中转握手失败后 `/directory` 探针确认 401/403 或 `DEVICE_REENROLLMENT_REQUIRES_APPROVAL`，
  且未开启「仅使用加密连接」），手机与 Desktop 一样将该账号与路由选择标为已拒（`mobileAgentNetIdentityRefused`），关闭因缓存目录保持虚活的
  `AgentNetSocket` 并回退到 Device Link，避免被删手机误显示「Relay 已连接」或重登后因永久撤销卡死。
- **自建中转。** 不涉及中转协议，不需要递增 `RELAY_VERSION`。
- **Node Host 重新登录。** `serve` 每次启动都从刷新出来的令牌开始，刷新令牌不带登录方式，服务端不会凭它恢复登记，所以一台被删的
  Host 原来重新登录了也回不来（Device Link 一直回 4410「设备已移除，请重新登录」，和 Agent-Net 无关，主干上一样）。现在
  `cindy-host login` 拿到刚登录的令牌后用它连一次 Device Link、说一次 hello 就关（`apps/host/src/auth/device-link-registration.mjs`），
  令牌只在内存里，不落盘、不进日志；失败只是照旧保持被删，登录本身照样成功。

**真机（2026-11-17，个人账号：XDMini 上的 Desktop 与 Windows 上的 Node Host，官方 Agent-Net）**：在 Desktop 上删掉 Host，同一刻日志记下
不认它，删完马上向它发请求 48 毫秒就回「设备离线」，设备列表里没有它；Host 的会话被断开、Device Link 被服务端以 4410 踢下线，
之后一分钟两边都没有新的连接尝试。Host 重新登录时报到成功，Desktop 随即放行，Host 启动后会话自动重建，请求 15–16 毫秒。
两个 XD 账号设备之间整个过程没有误拦。

回归：`packages/agent-net/src/__tests__/socket.integration.test.ts`「refuses a member outside the host rule from the start, admits
its waiting dial once allowed and drops it again at once」（真实核心与中转：规则外的设备拨不出去、拨进来挂着，放开后挂着的拨号连上，
再收紧马上断开；不换准入版本时挂着的拨号会被核心记住的拒绝挡掉）；`apps/desktop/src/main/device-link/__tests__/agentNetMembership.test.ts`
（规则怎么来、读列表的次数、连着时后台定期读到别处的删除、断开后不读、第一次读失败按退避重试）；
`socket.integration.test.ts`「fails frames waiting for a member the host rule then refuses, and never sends them once it is let back in」（拨号时排着的帧，
这台设备被拦后立即失败，放回来以后也不会再送出去）；`agentNetRuntime.test.ts`「neither lists nor accepts an official Agent-Net member missing from the Device Link
list until the list has it again」（设备列表与是否认它）；`deviceLinkApi.test.ts`「reports an official removal to Agent-Net only after the
server accepted it」；`apps/host/src/auth/device-link-registration.test.mjs`（用刚登录的令牌报到）与 `login.loopback.test.mjs`
（令牌在会话保存之后才交出）。
