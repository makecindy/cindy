# Device Link 供应商分享改走 Agent-Net（2026-11-26）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 产品规则见 [Agent 网络「分享」](../../product-rules/agent-net.md#分享) 与[供应商分享](../../product-rules/provider-sharing.md)。

## 背景与取舍

2026-11-26 用户要求：以前接受的 Device Link（V1）供应商分享，在分享者和受邀者都开着 Agent-Net 后无感改走 Agent-Net，
**不建新的成员资格、不出现新的申请或批准**，附件也一起走。做法是「授权不动，只换线路」：

- 成员关系、暂停、移除、额度和用量仍只有原来那一份 V1 分享（Cindy 服务器是成员权威，分享者电脑是使用范围权威）。
- Agent-Net 服务不保存这类分享的成员，只保存「这个分享在哪台电脑上」；每张放行证由分享者电脑按本机 V1 成员表决定签不签。
- 受邀者的 Agent-Net 钥匙只在已经由 Cindy 服务器认证的 V1 分享连接上报给分享者电脑；分享者电脑只给这把钥匙签。
  同一设备换账号、同账号另一把钥匙都拿不到放行证。
- 放行证最长 30 分钟，自动续签（与现有 Agent-Net 分享相同）。分享者电脑还对每次调用按成员表检查，与 V1 一致。

被否决的做法：后台替受邀者重新申请一份 V2 成员资格并自动批准。那样同一个人有两份资格，暂停、移除、额度、用量都要
两边同步，任何一次没同步上就会出现「旧的移除了新的还能用」。

## 线上格式（全部是新增，旧端不变）

**受邀者 → 分享者电脑（Device Link 分享连接上的调用）**：通道 `provider-share:agent-net-link:v1`
（`apps/desktop/src/shared/providerShareAgentNetLink.ts`），参数 `[{ version: 1, signingKey, transportKey }]`
（32 字节 base64url 公钥，受邀者为每个分享单独生成）。返回 `{ route: { server, networkId, rootPublicKey, hostDeviceId, region } }`
或 `{ unavailable: 'agent-net-off' | 'relay-unsupported' | 'link-failed' }`；未知原因按 `link-failed` 处理。
只有分享主人自己的受邀者能调用（`catalogGuestAccess`），委托执行电脑的短期授权进不来；登记中途失败一律回 `unavailable`，
不返回受邀者会当成「分享被撤」的错误码。通道列入 `PROVIDER_SHARE_CHANNELS` 与后台调用名单（`invokePolicy.ts`）。

**分享者电脑 → Agent-Net 账号分享服务**（`packages/agent-net-relay/src/sharing.ts`，只在账号分享服务上开放）：

- `GET /api/agent-net/info` 的 `features` 增加 `linked-provider-shares-v1`。客户端只在看到它时才发登记请求。
- `POST /api/agent-net/sharing/provider-shares/linked`，body `{ shareId }`：要求本网络已认证设备（`x-agent-net-authorization`）
  且与账号身份同一账号；按 `(networkId, shareId)` 隔离并幂等。已是服务自己的 V2 分享（或已有资源绑定）的 ID 回
  `409 PROVIDER_SHARE_LINK_CONFLICT`；同网络内已被别的账号登记回 `409`；不同网络之间互不阻塞，知道分享 ID 的访客
  在自己网络抢先登记不会阻止真实分享者迁移；每个网络最多 256 个，超出回 `429 LINKED_SHARE_LIMIT`。
- `POST /api/agent-net/sharing/provider-shares/linked/<shareId>/remove`，body `{}`：同样只认本网络本账号；删除或切主机后
  `changed`（含多副本 `sharingNetworks` 跨副本同步）立即关掉这个分享所有受邀者的会话。
- `POST /api/agent-net/sharing/transport`：资源是已登记的旧分享时，不查成员库，按账号身份与申请者持钥证明生成
  `scope: { memberId, guestSubject: <账号>, memberVersion: <登记代次> }` 的申请交给分享者电脑；同一分享同时**等待签名**
  （当前登记的主机与代次下、还没拿到签名）的不同受邀者最多 64 个（受邀者按「设备 + 账号」区分：设备号只在账号内唯一，
  别的账号用同一设备号的申请不会替换已有受邀者的申请）（`429 TOO_MANY_REQUESTS`），在写入事务里复核，并发申请也不会超出；
  已签发的不占名额，旧登记留下的申请不计；同一把钥匙续签已签发的申请、或替换本设备自己的待签申请不占新名额，已签发的设备换新钥匙重新申请同样受限。
  登记代次按时间生成且只增不减：取消登记时保留一条带代次的取消标记（两个放行证有效期后清理），之后再登记、或改由
  同账号另一台电脑登记，都在其上递增，同一毫秒或时钟回拨也不会重复，之前签发的放行证不会因此复活；
  复用申请编号时同时核对分享者设备与代次，换了分享者设备的申请拿新编号。删除租户网络时同时清掉它的登记。`/transport/status`、`/grants`、受邀者 WebSocket 与附件
  沿用现有校验；`check` 对已登记分享只认登记的网络与分享者设备。
- 持久化：`SharingState.linkedShares?: { shareId, networkId, hostDeviceId, ownerAccountId, linkedAt }[]`
  （`packages/device-link-sharing/src/repositories.ts`，含 `generation`），可选字段，旧文档照常读取；单进程存储校验它若存在必须是数组。

**分享者电脑撤销**：成员被暂停、移除或分享被删除时（`providerShareRuntime.ts` 的 `revoke` / `reconcile`），本机忘掉对应钥匙，
用现有 `GET /api/agent-net/grants` 与 `DELETE /api/agent-net/grants/<id>` 撤掉已签的放行证，服务端随即以 4410 断开受邀者；
分享已不在本机快照里时再调用 `.../linked/<id>/remove`：本机记录先标为待取消（不放行任何人、不收发附件），服务端确认后
才删除；没确认的（本机不在 Agent-Net 上、断网、服务出错）随之后的快照重试，每条最多 10 分钟一次，遗留登记不会占满名额。分享者此刻不在 Agent-Net 上时，已签的放行证最多 30 分钟后失效，
期间每次调用仍按成员表拒绝。

## 本机记录

`agentNetLinkedShares.ts` 在账号作用域内的加密文件 `agent-net/linked-shares-v1.enc` 保存：本机托管分享的登记钥匙
（每个分享最多 64 台设备），以及本机作为受邀者已换线路的分享（线路与钥匙种子）。旧版本不读它；降级后受邀者照旧走
Device Link，分享者不再签新的放行证，旧的 30 分钟内失效。

## 什么时候换、什么时候退回

- 受邀者每次拉到收到的分享列表（约每分钟）时只做本机判断；对同区域、分享者在线、仍是 V1、两边条件满足的分享，
  一次只问一个分享者。不发起的情况：本机 Agent-Net 关着、走自建中转、开了「仅使用 Agent-Net」（V1 分享本来就不可用）、
  分享是 V2、跨区域。冷却：分享者是旧版本（`CHANNEL_NOT_ALLOWED`）、服务不支持或给出本机不接受的线路时 12 小时；
  分享者没开 Agent-Net 或临时失败时 30 分钟。冷却只在内存，重启后最多再问一次。
- 受邀者只接受与自己同一个官方 Agent-Net 服务、同一区域、`account:` 网络、就是这个分享那台电脑的线路。第一版不支持
  自建中转与私有网络，那些分享照旧走 Device Link。
- 换线路后，这个分享的会话（建链、调用、推送）经 `agentNetSharing.ts` 的会话选路使用它自己的 Agent-Net 连接，附件经
  `agentNetMedia.ts` 走 Agent-Net 加密附件。附件跟着控制链路实际走的那条路（受邀者看 `outboundOnSession`，分享者看
  `ownsInbound`，`index.ts` 装上）：会话层规定链路中途不换路，正在使用、已经开在 Device Link 上的链路要等它结束，下一次
  建链才到会话上，在那之前消息和附件都留在 Device Link；连接没起来或断开时两者一起回 Device Link，不会出现一半走一边。分享被暂停、退出、成员变化时丢掉记录；服务端拒绝（400/403/404）立即退回并冷却 12 小时，
  连续 3 次拿不到放行证退回并冷却 30 分钟。
- 与「已知对端支持 Agent-Net 就不明文降级」的关系：这里退回的是这个分享原本就合法的 V1 线路（与跨账号会话层
  「对方是旧版或连不上时照旧走 Device Link」的先例一致），不是把 V2 资源降到兼容线路。

## 混版本与发布

| 受邀者 | 分享者 | Agent-Net 服务 | 结果 |
| --- | --- | --- | --- |
| 新 | 新 | 新（声明 `linked-provider-shares-v1`） | 换到 Agent-Net |
| 新 | 新 | 旧（未声明） | 分享者回 `relay-unsupported`，照旧 Device Link，12 小时后再问 |
| 新 | 旧 | 任意 | 分享者回 `CHANNEL_NOT_ALLOWED`，照旧 Device Link，12 小时后再问 |
| 旧 | 任意 | 任意 | 不发请求，照旧 Device Link |
| 任意 | 任意 | 新，但一方关 Agent-Net | 不换线路；已换的随开关重建后退回 Device Link |

发布顺序：先部署支持 `linked-provider-shares-v1` 的官方 Agent-Net 服务，再发客户端；客户端先发也没有副作用。

## 中转与服务端仓

- 共享状态文档多了可选的 `linkedShares`，按[多副本规则](agent-net-relay-cluster.md)的例外**不提升** `RELAY_CLUSTER_COMPAT`，
  可以照常滚动发布：旧副本写分享文档时原样带过这个字段；混跑期间由旧副本负责的网络不声明能力、不认已登记分享
  （登记回 404、放行证不被认可），这些分享照旧走 Device Link，全部换成新副本后自动生效，不会误授权或丢数据。
- 官方 Agent-Net 服务在服务端仓的同名 `packages/agent-net-relay` / `packages/device-link-sharing`，需要同步本次的
  `sharing.ts`、`server.ts`、`store.ts`、`repositories.ts` 改动与 fixture（服务端仓同步 PR 见客户端 PR 说明）。
- 自建中转：这项能力只在账号分享服务上开放，私有分享服务（`/private-sharing/*`）不接受登记（测试覆盖），客户端在
  走自建中转时也不发起，因此不提升 `RELAY_VERSION`；已部署的自建中转不受影响。

## 实现入口与回归测试

- 服务：`packages/agent-net-relay/src/sharing.ts`（`linkedShare`、`linkShare`、`unlinkShare`、`/transport` 分支、`check`）、
  `server.ts`（开关与 `/info`）、`store.ts`；混跑保留字段由 `cluster.integration.test.ts` 的「keeps sharing-document fields another build added…」覆盖。
- Desktop：`agentNetLinkedShares.ts`（分享者登记、放行判断、撤销与清理；受邀者发起、连接、会话与附件选路）、
  `agentNetSharing.ts`（`sessionRoute` 与绑定生命周期）、`agentNetMedia.ts`、`agentNetRuntime.ts`（记录 `/info` 能力）、
  `index.ts`（放行策略）、`dispatch.ts`（通道闸门）、`providerShareRuntime.ts`（挂接）。
- 回归测试：
  - `packages/agent-net/src/__tests__/socket.integration.test.ts` 的
    「carries a linked Device Link provider share only for the key its host registered, until the host unlinks it」：
    真实服务、内核、worker 与会话，覆盖登记前 404、非认证设备不能登记、只给登记钥匙签、会话与双向附件、中转无明文、
    取消登记后断开与 404、同账号设备不受影响。
  - `packages/agent-net-relay/src/__tests__/relay.integration.test.ts` 的
    「fences linked Device Link provider shares: native IDs, other accounts, the private book, restarts and waiting guests」。
  - `apps/desktop/src/main/device-link/__tests__/agentNetLinkedShares.test.ts`：分享者只认登记钥匙、重启保留、撤销只撤
    对应放行证、删除后取消登记；受邀者只问一次、会话与附件只在连上时走 Agent-Net、断开退回 Device Link、各种冷却与不发起条件。
  - `apps/desktop/src/main/device-link/__tests__/providerShareDispatch.test.ts` 的通道闸门用例。
- 未验证：两个真实账号在官方服务上的端到端（官方服务尚未同步部署）。
