# 远程连接拓扑的本机链路快照（2026-11-06）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Desktop 新增本机 IPC `device-link:get-peer-links`（invoke）与 `device-link:peer-links-changed`（push，结构变化时 250ms 合并后全量广播，往返抖动和业务收发时刻变化不广播）。快照里每条链路的 `sentAgoMs` / `receivedAgoMs` 是 `DeviceLinkClient` 在本机记的「最近一次业务消息」时刻（发 / 收 invoke、invoke-result、push 时打点，ACK 与直连协商不算），不新增任何帧字段。
它只在同一台电脑的 main 与 renderer 之间传递，不经中转、不进 wire protocol；内容来自客户端已有的对端传输状态（直连 / 中转路径、平滑往返）与心跳 pong 的往返。
`@cindy/device-link` 的 `DeviceLinkClient` 为此记录心跳发出时刻，协议帧不变，对端与中转无需升级；旧版 renderer 不调用这条 IPC 也不受影响。
