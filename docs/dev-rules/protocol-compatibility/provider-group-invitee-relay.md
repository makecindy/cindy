# 供应商组：受邀者经组所在电脑中转(P2b)

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §4「分享的人(中转)」、§8、§9。受邀者 G 用组所在电脑 O
分享出去的供应商，而 O 把它建成了组：O 的远程 Agent 被控端按组选一台组内电脑 M，自己作为 M 的控制端中转。G 与 O 之间的
`maker:remote-agent:v1` 协议完全不变(中转对 G 透明)；O 与 M 之间沿用同一协议，新增下面三项可选内容：

- **open 载荷新增可选 `relay`**(`remote-agent/wire.ts`，`REMOTE_AGENT_RELAY_KEY_PATTERN`，16–64 位 `[A-Za-z0-9_-]`)：O 为受邀者取的
  不透明键(按受邀者派生，不含分享与成员信息)。M 收到带 `relay` 的 open 一律按受邀者隔离运行(即使控制端是同账号的 O)：
  受邀者目录、会话索引、续接校验按(控制端, relay)分开。数量上限按认证的直接连接设备合计，分享 peer 取其 deviceId，
  同一设备跨供应商、分享入口及 relay 共用额度；默认单设备 16、提供方整机 64（可配置），不会因 relay 获得额外额度。O 同时带
  `groupAssigned`，并把 `sessionId` 换成按(受邀者, 任务 id)派生的 id、`providerId` 换成 M 上的供应商。旧 M 丢弃这个字段，
  所以 O 只把受邀者任务交给 caps 声明了 `guestRelay` 的同账号 M；分享来的 M 本来就把 O 当受邀者隔离，不要求这个能力。
- **提供方远程任务数量设置**：沿用 `maker:remote-agent:v1`，不加必填字段；`caps.maxRuns` 返回当前单设备上限（1～1000，旧解析器可读）。
  超限仍回 `REMOTE_AGENT_BUSY`，message 用 `[DEVICE_LIMIT]` / `[TOTAL_LIMIT]` 区分原因，旧端继续按忙碌处理。
  本机 `provider-share:command` 与同账号管理通道增加 `get-run-limits` / `set-run-limits` / `reset-run-limits`；
  `set-run-limits.limits` 只包含用户编辑过的 `perDevice` / `total`，写入端在锁内合并当前值并验证大小关系；
  未编辑字段不落盘，继续跟随默认值或此前显式设置。两个字段同时提供仍兼容。
  不向受邀者开放。旧端不认识这些管理命令时显示需要更新，不回退伪造成功。设置只影响新增实例，不中断存量。
  大额度下控制端仍按每批最多 64 个任务轮转 poll，不提高 wire 上限。
- **caps 新增可选 `guestRelay: true`**(`RemoteAgentCaps`)：被控端能按受邀者隔离运行(供应商级授权与受邀者出站边界都已接上)。
- **新 op `forget { relay }`**(`parseRemoteAgentRequest`)：O 删除受邀者后请 M 清掉替它运行过的任务、受邀者目录与会话记录；
  只作用于调用方自己的 relay。旧 M 回 `REMOTE_AGENT_INVALID`(它从没接过被中转的任务)。
- O 不信任 G 带来的 `relay` / `groupAssigned`：受邀者的这两个字段只会让任务按普通受邀者在 O 本机隔离运行，不能借此逃出
  受邀者隔离；O 的组路由只用 O 自己的组设置与记录。
- `forget` 的通知名单从 O 发出 open 那一刻起记(含启动失败、还没有原生会话 id 的 M)；没通知到的 M 持久记在 O 的受邀者
  会话索引(`forgetPending`)里，之后自动重发。open 的结果不明(超时、断链)时 O 先用同一个 runId 发 `close` 再换下一台；
  这些都只用已有的 op。
- 中转不解码消息与附件、不落盘(载荷原样按同一 callId 转给 M)；推帧按任务串行；M 报出的路径类错误(分享暂停、远程调用
  关闭、连不上、太忙等)转给 G 时统一成 `REMOTE_AGENT_UNAVAILABLE`。
- **控制端拉取器修正**(与本节同批，`remote-agent/controller/poller.ts`)：一个 poll 带回数据后，若有任务没被仍在途的 poll
  覆盖就立刻再发一个。此前同一台电脑上已有空闲任务挂着长等待时，新打开的任务带回第一段数据后要等旧的长等待超时
  (最长 10s)才能拿到 `started`。只影响控制端本地调度，不改 wire。
- 不改 relay、服务器与数据库。实现：`remote-agent/host/runHost.ts`(中转与 M 端隔离)、`host/groupRelay.ts`、
  `provider-group/guestRelay.ts`(选电脑)；回归见 `remote-agent/__tests__/groupRelay.test.ts`(三端同进程)、
  `provider-group/__tests__/guestRelay.test.ts`、`remote-agent/__tests__/poll.test.ts`。
