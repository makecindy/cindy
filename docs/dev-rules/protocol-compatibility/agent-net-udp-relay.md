# Agent-Net 中继转发走 UDP（2026-11-14，2026-11-17 第 2 版包格式）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 方案见 [`agent-net-session-plan.md`](../../agent-net-session-plan.md) 第 8 节，压测见
> [`benchmarks/agent-net-session-2026-11-13`](../../benchmarks/agent-net-session-2026-11-13/README.md)。

打不通直连时，两台设备之间的 Agent-Net 数据报原来只能经中继的 443 WebSocket 转发：传输核心本身是可靠 UDP，
叠在 TCP 上就成了 TCP-in-TCP，一个包慢了后面的都要等。现在中继在原有的 UDP 端口（与查公网地址的 STUN 同一端口）
上也转发数据报；WebSocket 仍负责认证、名册和在线状态，UDP 不通时数据报照旧走 WebSocket。

- **开启方式（双方都要新）**：设备连中继 WebSocket 时带请求头 `x-agent-net-udp: 2`（`UDP_RELAY_VERSION`）。中继开着 UDP 端口时，
  在 hello 里多给可选字段 `udp: { session, key }`（base64url，8 字节会话号、32 字节密钥，每条 WebSocket 会话随机生成）。
  旧中继忽略请求头、不给这个字段；旧客户端不带请求头、拿不到它；新客户端解析失败只当没有，不影响握手。
  所以新旧任意组合都照旧走 WebSocket，不需要发布顺序。中继在 `/info` 的 `features` 里多声明 `udp-relay-v2`，
  客户端不依赖它判断，以 hello 是否带凭据为准。2026-11-17 包格式改为第 2 版（下面的地址凭证与上行计数器）：只认第 1 版
  （请求头值 `1`）的中继和客户端与第 2 版之间拿不到凭据或登记不上，都退回 WebSocket，不会互相发错格式的包。
- **凭据只走加密连接**（2026-11-17 审查：用户自己指定的私有中转可以是明文 http，密钥原来明文经过网络，同一 Wi-Fi 上旁听就能拿到）。
  密钥可以反复使用，所以：
  - 客户端只在中继地址是 `wss://`、或 `ws://` 指向本机（`127.0.0.1`、`localhost`、`[::1]`）时才带请求头，没带请求头时
    hello 里即使有凭据也不用（`packages/agent-net-relay/src/client.ts` 的 `udpCredentialsAllowed`）。
  - 中继只在看得出这条升级请求是加密的时给凭据（`server.ts` 的 `confidentialUpgrade`）：有 `X-Forwarded-Proto` 时以它为准
    （`https`/`wss` 才给；Desktop「这台电脑当中转」的网关和一键部署的 nginx 都会带上），没有时看中继自己是否终结了 TLS，
    都不是时只给本机来的连接。客户端伪造这个头只会暴露它自己的密钥。
  - 所以局域网明文的私有中转（`ownerPinnedHttp`）只走 WebSocket；`--remote-network` 的跨机压测若中转是明文 http，也不再测到 UDP 中转。
- **包格式**（`packages/agent-net-relay/src/udpRelay.ts`，大端）。类型字节用 `111` 开头的 0xE1–0xE4：
  中继端口上还有 STUN（首字节高两位为 0），设备端口上还有核心的握手（`100`）和数据包（`101`），都不能重叠。
  MAC 是 HMAC-SHA256 取前 16 字节，用 hello 里的密钥；对端用设备号摘要 `SHA-256("cindy-agent-net/udp-relay/1\0" + 设备号)` 的前 8 字节表示。
  - 登记 0xE1：`[类型][会话号 8][计数器 8][收得到 1][地址凭证 16][MAC 16]`，共 50 字节，MAC 覆盖前面全部。计数器只增，
    中继不接受不大于上次的值。还没有凭证时凭证填 0。
  - 登记确认 0xE2：`[类型][计数器 8][已认定 1][地址凭证 16][MAC 16]`，共 42 字节，比登记短；MAC 覆盖前面全部和会话号（换了会话的旧确认无效）。
  - 上行 0xE3：`[类型][会话号 8][计数器 8][目标摘要 8][MAC 16][数据报]`，MAC 覆盖包头和数据报。计数器每个上行包加一，
    和登记的计数器分开。
  - 下行 0xE4：`[类型][来源摘要 8][MAC 16][数据报]`。
- **地址证明**（2026-11-17 审查 P0：原来一个 MAC 正确的登记就能把会话的下行改到包的来源地址，伪造来源 IP 就能让中继
  往任意地址灌包，一个满载 1 字节数据报的 WebSocket 帧能变成两万多个 UDP 包）：中继回的每个确认都带这个来源地址的凭证
  `HMAC-SHA256(中继进程密钥, "cindy-agent-net/udp-relay/cookie/2\0" ‖ 会话号 ‖ "分钟数|地址|端口")` 的前 16 字节。中继进程密钥
  启动时随机生成、不外传，设备算不出别的地址的凭证。只有带回的凭证对得上来源地址（当前或上一分钟）的登记才算「已认定」，
  中继才改记这条会话的下行地址、「收得到」和登记时间；没认定的登记只确认（确认回给来源地址，比登记短，放大不了），
  最多把「收得到」改成假（只会让会话退回自己的 WebSocket）。设备收到「没认定」且凭证和这次登记带的不同（刚换了地址、凭证过期）时
  马上带上新凭证再登记一次，所以 NAT 换端口只多一个来回；凭证相同仍没认定时不重发，等下一次定时登记，不会来回空转。
- **登记与下行（设备 `packages/agent-net/src/relayUdp.ts`，中继 `server.ts`）**：设备拿到凭据后向中继 UDP 端口登记，
  确认到了说明两个方向都通，设备之后的数据报走 UDP，并在登记里带「收得到」。中继只在设备最近一次已认定的登记带「收得到」、
  且 30 秒内登记过时，把发给它的数据报改走 UDP；否则仍走 WebSocket（原有的发送排队与 1 MiB 积压上限照旧）。设备空闲时每
  15 秒登记一次，正在发数据时每 2–3 秒一次；一次登记 4 秒没确认，设备两个方向都退回 WebSocket，下一次登记带「收不到」，中继随即退回；
  之后每秒重试，不通 10 秒后放慢到每 5 秒，确认恢复就马上带「收得到」重新登记。WebSocket 重连会换会话号和密钥，旧登记作废。
  - 设备只认还在等、发出不到 4 秒的登记的确认，每个确认只认一次：重放的确认、被扣下来晚放的旧确认都不能让它以为 UDP 还通。
  - 中继地址解析失败（离线启动、DNS 暂时不通）时先走 WebSocket，从 2 秒起按倍数退避重试到每分钟一次；解析成功后每 5 分钟重新解析，
    UDP 连续 30 秒不通时可提前重新解析，失败后仍遵守 DNS 退避。地址变了就清理旧地址证明并重新登记；凭据未变时，两种计数器都继续递增。
- **转发限额**（2026-11-17 审查 P1：每个数据报一次 MAC、一次发送都在 WebSocket 消息回调里同步做，一台设备上传每秒约 1.3 MB
  的小数据报就能占满中继的事件循环）。限额只决定走不走 UDP，超出的照旧走 WebSocket：
  - 只有长度在 24（核心最短的包）到 1325 字节之间的数据报走 UDP。更短的不是核心的包；更长的是旧版（含旧安装包里的手机原生库）按 1400 字节发的包，
    经 UDP 下行会变成 1425 字节、在隧道里被拆片（见[发包上限](agent-net-send-packet-size.md)），所以留在 WebSocket。
  - 一个 WebSocket 帧最多 128 个数据报走 UDP。
  - 每台设备一个令牌桶：中继替它校验的 UDP 包和替它经 UDP 发出的数据报都从里面扣，每秒补 25,000（约 260 Mbit/s 的满长包）、
    最多攒 5,000；扣完后它的帧走 WebSocket，它的 UDP 上行包按丢包处理（核心重发、降速）。
  - 中继 UDP 套接字自己积压超过 4 MiB 时，新的下行改走 WebSocket。
- **安全**：只认 hello 里随机给的密钥算出的 MAC；伪造、篡改、用别的会话密钥签的包和重放的旧登记一律丢弃，不回任何字节。
  上行计数器按 1024 宽的窗口只收一次（UDP 会乱序，窗口内没收过的旧计数器照收），截获的上行包重放不会再被转发。
  设备发给自己的数据报（WebSocket 和 UDP 两条路）中继直接丢掉。上行按发包会话的设备身份查目标，沿用 WebSocket 转发的同一授权判断
  （`permitted`）：共享访客经 UDP 往授权范围外发包，和经 WebSocket 一样断开它的会话（1008）；成员发给刚被撤销的对端只丢包。
  数据报本身仍是两端传输核心的密文，中继只转发。中继记的「设备号摘要 → 设备号」随设备最后一条会话关闭而删除（访客号每次分享一个，
  不删会一直增长）。下行包不带计数器：重放的下行包由传输核心按包号认出、丢掉。
- **自建中转**：中继内核是同一份代码（自建部署与「这台电脑当中转」共用），一键部署本来就放行了 UDP 3479。
  `packages/device-link-relay/src/version.ts` 递增到 `0.5.4`（2026-11-17 两次 rebase：主干先为 App 元数据用掉 `0.5.2`，又为证书监听与部署重试用掉 `0.5.3`），已部署的服务器在中转设置里
  出现升级提示；`selfHostedRelayRuntime.test.ts` 经状态 IPC 验证 0.5.0～0.5.3 都出现升级提示、升级完成后提示消失。升级前的中转对新客户端只走 WebSocket。
- **官方中继**：服务端仓库有独立的内核副本，需要同步本文件的协议与 `server.ts` 的改动后才在官方中继生效；
  同步之前官方中继不给凭据，客户端照旧走 WebSocket。官方中继的 UDP 若经独立的负载均衡（`stunHost`），
  同一设备的 UDP 包必须落到持有它 WebSocket 会话的那台中继实例上，否则登记查不到会话、一直走 WebSocket；
  地址凭证的中继进程密钥每个实例各自生成，所以一台设备的登记也必须一直落到同一实例。
- **手机**：显式开启 Agent-Net 且支持 UDP 转发的原生库可以使用中转 UDP。存量原生包仍走 WebSocket。
- **包长**：上行、下行在核心的包外分别加 41、25 字节（`UDP_RELAY_UP_OVERHEAD`、`UDP_RELAY_DOWN_OVERHEAD`；第 1 版上行是 33）。
  Desktop 按这个余量把核心的发包上限算成 `1350 - 41` = 1309 字节，经中转的 UDP 载荷不超过 1350，隧道里不再被拆片；
  见 [Agent-Net 发包上限与收包上限分开](agent-net-send-packet-size.md)。
- **本机可见（2026-11-18，不改协议）**：Desktop 的 worker 每秒随状态快照报告经中转的数据报现在走 UDP 还是 WebSocket，
  以及 UDP 的往返（已有登记从发出到确认，不另发包）。远程连接页的中转点据此在协议下面写「UDP · 延迟」或「WS · 延迟」，
  延迟取实际在走的那条路；每次切换在本机日志记一行 `agent-net relayed datagrams now go over the relay UDP port / WebSocket`。
  入口：`RelayUdpPath.rttMs`、`Transport.relayRoute`、`AgentNetWorkerSocket.relayRoute`（事件 `relay-route`）。

回归：`packages/agent-net-relay/src/__tests__/relay.integration.test.ts`
「forwards over UDP only to devices that proved their address and confirmed receiving it, and keeps the WebSocket otherwise」
（真实中继套接字：未登记、未认定地址、报「收不到」都走 WebSocket；另一个地址带着设备的凭证也拿不走它的下行；伪造、篡改、错密钥、
重放的登记与重放的上行无效，乱序的旧计数器照收；过短和 1400 字节的数据报走 WebSocket）、
「hands out UDP credentials only over an encrypted or local connection」（`X-Forwarded-Proto: http` 和第 1 版请求头拿不到凭据，
明文 http 的私有中转客户端不带请求头）与「rejects malformed datagrams before forwarding and limits guests on the WebSocket and the
UDP port as well」（访客经 UDP 越权被断开）；`packages/agent-net/src/__tests__/relayUdp.test.ts`（核心与 STUN 的首字节不被截走；
确认中断后几秒内退回 WebSocket 并告诉中继、恢复后切回，重放和晚到的确认不算数；中转没认定新地址时马上带新凭证再登记；
地址解析失败后继续重试）。地址证明、上行重放窗口、两侧的加密连接门槛、晚到确认与解析重试各自去掉后都有用例失败（2026-11-17 变异验证）。
端到端对比用 `packages/agent-net/bench/session-latency.ts --modes v1,worker,udp-relay`。

**手机（2026-11-18）。** 原生库在 `packages/agent-net-native/src/udp_paths.rs` 实现同一套登记、确认、上下行与退回（时间与 `relayUdp.ts`
一致，中转地址在单独的线程里解析、不卡住收发），上行包也带防重放计数器、超过 1350 字节的照旧走 WebSocket。凭据由
`PortableAgentNetClient` 和 Node 客户端一样只在 TLS（或本机）上要，`agentNetRuntime.ts` 连接启动后异步读中转的 `/api/agent-net/info` 拿 UDP 地址
（同一中转复用在途请求，成功结果保留 10 分钟，失败后 1 分钟内沿用已有结果）。旧安装包的原生库没有这项，照旧全走 WebSocket。中转协议没变，不递增 `RELAY_VERSION`。
回归：`native.integration.test.ts`「carries sessions on the real native engine, relays them over UDP, ...」（1 MB 结果经 WebSocket 的不到
256 KB；不下发凭据时失败）。
