# Agent-Net 发包上限与收包上限分开（2026-11-16）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项约定。
> 现象与测量见 [`benchmarks/agent-net-session-2026-11-13`](../../benchmarks/agent-net-session-2026-11-13/README.md)「核心修正后真实网络复测」，
> 核心验证记录见 [`sim/results/2026-11-16-jitter-window`](../../../packages/agent-net-core/sim/results/2026-11-16-jitter-window/README.md)。

传输核心原来每个包都按 `max_packet_size`（1400 字节 UDP 载荷）发，经 UDP 中转时中转再在包外加 33 字节。VPN、PPPoE、
运营商隧道会在包外再套一层，整包超过路径 MTU 时被拆成两片：2026-11-16 两台电脑之间的 VPN 上，每秒 12 MB 时 1400 字节的 UDP
丢 32%、往返从 10 毫秒涨到 184 毫秒，1372 字节以下不丢。TCP 由隧道按 MSS 截短，不受影响，所以 Agent-Net 的回传只跑到
Device Link 的一半。

- **两个上限**（`packages/agent-net-core/src/connection.rs` 的 `Config`）：
  - `max_packet_size`：**收包上限**，默认仍是 1400。比它长的包、比按它算出的分片长的数据或校验分片，接收方当坏包丢掉，
    所以两端必须一致——这条约定没有变，旧版也是 1400。
  - `send_packet_size`：**这一端发包的上限**（`Config::send_limit` 取它和 `max_packet_size` 里小的那个）。分片按它切，
    握手请求按它填满，握手回复取「自己的发包上限」和「请求长度」里小的那个，路径验证与回复也按它。核心默认同 `max_packet_size`，
    行为不变；调用方按路径上的外层开销调小。
- **Desktop 的取值**（`packages/agent-net/src/transport.ts`）：`1350 - UDP_RELAY_UP_OVERHEAD` = 1309 字节，经 UDP 中转时上行
  正好 1350、下行 1334（中转在包外加的字节数由 `packages/agent-net-relay/src/udpRelay.ts` 的 `UDP_RELAY_UP_OVERHEAD`、
  `UDP_RELAY_DOWN_OVERHEAD` 给出）。1350 是常见 QUIC 实现不做路径 MTU 探测时的默认值，常见隧道放得下。2026-11-16 定这个值时
  上行包头是 33 字节、取值 1317；2026-11-17 中转上行包加了 8 字节防重放计数器（[UDP 中转](agent-net-udp-relay.md)），取值随之变成 1309。
  WebAssembly 接口 `init` 多了一个参数（`max_packet_size, send_packet_size, recovery, share`），和 Node 驱动
  `packages/agent-net-core/wasm/node.mts` 在同一个构建里发布，没有别的调用方；`EndpointOptions.sendPacketSize` 不给时同 `maxPacketSize`。
- **新旧互通**：包格式、帧格式、握手消息都没变，只是新版发的包短一些。
  - 新版 → 旧版：包和分片都不超过 1400，旧版照收；握手请求更短，旧版按请求长度回复，新版照收。
  - 旧版 → 新版：旧版照样发 1400，新版的收包上限仍是 1400，照收；旧版发来 1400 字节的握手请求，新版回 1309 字节的回复（不长过请求）。
  - 不需要发布顺序，也不需要协商。`sim/tests/secure.rs` 的 `peers_with_different_send_sizes_interoperate`（谁发起都试，
    丢包时满长度分片靠校验包在对端算回来）和 `sim/tests/migration.rs` 的 `switching_networks_works_between_different_send_sizes`
    （换网时的路径验证）守着；把收包检查、分片检查、校验恢复、握手回复、路径验证或分片切法中任一处改成按另一个上限算都会失败。
- **手机原生库（2026-11-18）**：`packages/agent-net-native/src/engine.rs` 和 Desktop 一样收 1400、发 1309，窗口 8192、
  发送缓冲上限 24 MiB（实际按拥塞窗口放大）。随新安装包生效；旧安装包照旧按 1400 发，互通不受影响。
- **代价**：同样的数据多约 7% 的包（1309 字节时；1317 字节时约 6%），每个包的加密、发包等固定成本随之多约 7%。
