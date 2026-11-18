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
- **已知限制。** 开着「仅使用 Agent-Net」的设备被删以后再重新登录，因为不连 Device Link 中转，服务端不会恢复它的登记，其他电脑
  会一直不认它，要先关掉「仅使用 Agent-Net」连一次 Device Link。
- **手机（2026-11-18）。** 规则移到 `packages/agent-net/src/membership.ts`，手机在 `agentNetRuntime.ts` 用同一份：准入只认官方 Device Link 的原始
  名单，普通的混合目录请求只把其中的 Device Link 结果交给准入。补读同一时间只发起一次，只在开关开启且连着官方 Agent-Net 时周期刷新。
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
