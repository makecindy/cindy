# 可靠层 ACK 编码（`transport-ack-v2`，2026-11-11）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

这是可靠层（`packages/device-link/src/transport.ts`、`client.ts`）的能力，同账号握手两个方向
都声明（link-open 的 `capabilities` 与 link-accept 合并的能力），按最近一次握手刷新；跨账号
peer 不声明也不使用。ACK 形式在每次发出时按对端当前声明决定，对端降级重连后不会再收到新形式。

- `transport-ack-v2`：对端（数据发送端）声明它能解析紧凑 ACK、容忍延后 ACK 时，接收端：
  - 普通累计 ACK 仍走原 channel，payload 改成 `{ s: streamId 前 12 位, a: ackSeq, l?: 链路确认
    request id 前 12 位, d?: 1 }`（控制端在整条链路存续期间都在普通 ACK 上附带确认 id，作为确认帧丢失
    时的兜底，所以 `l` 也缩短）。接收方按前缀匹配自己当前的 stream 与待确认的 link（含重复 open
    的缺口修复），旧代 stream 的迟到 ACK 照旧忽略。握手里显式的链路确认 ACK 及其有界重试保持
    原格式、立即发送。
  - 按 stream 累计自上次发出 ACK 以来的交付：只交付了推送时，累计到 2 条（与立即模式的批量相同）
    或 32 KiB 立即确认，否则零头在 200 ms 窗口末尾合并成一条；交付过请求或结果时照旧立即确认
    （对端的请求窗口、恢复期探测按 ACK 推进）；本轮没有新交付（缺口、handler 失败）时重申当前
    位置，自上次 ACK 以来只交付过推送的并入这个窗口，否则立即发。覆盖过被延后消息的 ACK 带
    `d: 1`（原格式时 `delayed: true`），发送端不拿它估 RTT 与交付速度；紧凑 ACK 只认声明过
    能力的对端。重发间隔不低于 2 s。重复帧、乱序与坏帧的即时 ACK 不变；ACK 发送失败时不结清
    延后状态，连接停止时清掉窗口与计数。

官方与自建中转只按 kind / dst 路由，不解析 payload，设备签名照常覆盖新形状；无需升级中转或
修改服务端。Mobile 的 WebView 直连运行时由 `node scripts/direct-link-runtime.mjs` 随 transport
重新生成。回归见 `client.test.ts`「可靠层 ACK 编码（ack-v2）」。
