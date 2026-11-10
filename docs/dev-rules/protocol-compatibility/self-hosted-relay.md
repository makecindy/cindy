# 自建中转服务（`packages/device-link-relay` 与客户端接入）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

方案见 [`docs/self-hosted-relay-plan.md`](../../self-hosted-relay-plan.md)。内核实现与官方 relay 相同的 v1 线协议
（`@cindy/device-link-protocol`），**不改 `PROTOCOL_VERSION`、帧格式或官方 relay / 服务端**。新增内容只存在于自建中转上：

- 认证方案 `Authorization: CindyRelay <设备凭证>`（WebSocket 升级与 REST 共用）。`DeviceLinkClient.authorizationScheme`
  增加可选值 `CindyRelay`，现有调用不传时仍为 `Bearer`。自建中转拒绝 `Bearer`；凭证无效时 REST 返回
  401 `RELAY_CREDENTIAL_INVALID`，刻意不用 Desktop `serverApiFetch` 会触发刷新/登出 Cindy 账号的三种错误码。
- hello-ack 的 `capabilities` 为空：客户端据此不发 `notify`、不发 `sharedTask` / `providerShare` 帧；
  中转收到带这两种范围的帧回 `BAD_REQUEST`，不转发。`userId` 为主人账号，`deviceId` 由凭证绑定，不信任自报。
- 跨账号帧不进自建中转：`RoutedDeviceLinkClient`（`packages/device-link/src/routedClient.ts`）在主连接走自建中转时另开一条
  `scopedPeersOnly` 的官方连接承载共享任务与供应商分享，同账号路由帧在这条连接的入站边界丢弃。两条连接的状态与恢复互不牵连，
  host 按 peer 取连接用 `connectionFor` / `crossAccountConnection`。官方线路不启动第二条连接，wire 不变；中转程序无需升级。
- 官方 REST 同形：`/devices`（GET/PATCH/DELETE）、`/media/presign-put`、`/media/presign-get`、`DELETE /media`。
  媒体地址指向中转自身（带签名、短期有效、一次性上传、支持单段 Range）；`/ice-servers` 返回 404（客户端退回公共 STUN）；
  `/push-token` 返回 204 不保存；`GET /provider-shares` 返回空列表。
- 自建中转独有：`/api/device-link/relay/info`、`/relay/pair`（加入）、`/relay/admin/*`（仅主人设备凭证）、
  `/relay/blob/*`（媒体签名地址）。官方 relay 没有这些路径，客户端只在自建模式下调用。

- 设备签名（[方案 §16](../../self-hosted-relay-plan.md)）：经自建中转转发的对端帧多一个顶层字段
  `auth: { t, b, r, c, s }`，中转原样转发、不解析（超过 512 字符或不是对象时回 `BAD_REQUEST`）。
  - `DeviceLinkClient` 的可选项 `frameAuth` 负责签名与核对，只在 `sendEnvelope` 和 `handleMessage` 两处生效。
  - 官方中转时它返回 null，wire 与旧版逐字节一致。
  - 签名覆盖的字段与序列化规则以 `packages/device-link/src/selfHostedRelayAuth.ts` 为准，改动它就是改协议，Desktop、Mobile、中转必须一起改。
  - 中转新增 `GET /api/device-link/relay/certs`（主人签发的设备证书）。
  - Desktop 与 Mobile 都在分发前核对入站帧，包含权限请求文案；证书未就绪时拒绝当前帧，
    未知设备或已知设备签名不符时有界刷新，不重连共享链路。Mobile 复用已有纯 JS 加密实现。
  - 签名上下文 `cindy-relay-frame/2` 包含接收端启动挑战 `r`，避免接收端重启后旧请求再次执行。
    共享客户端消费保留的 `device-link:relay-auth` push 请求/响应；仅认证请求允许空挑战，
    不进入业务分发、不建立控制链路、不改变远控开关。待发队列按稳定签名身份和设备隔离，超时/断线/换身份后不发送旧请求。
    接收端重启且证书迟到时仅发有界认证探测；验签通过的新挑战只可恢复本机仍有效的原 `link-open`，保持请求 ID、签名身份与期限，不能恢复任意旧业务写操作。
    中转已有 push 与 opaque auth 转发足够支持，无需新增协议 kind 或修改路由；互通同时覆盖关闭远控的手机接收插件同步与未建链查询。
    此自建功能尚未发布，开发期间旧的无 `r` 签名客户端需同步更新；官方客户端路径无此交换。
  - 加入申请必须带 `publicKey` / `proof`，同意必须带证书；`/relay/info` 的 `features` 声明 `device-signatures-v1`。
- 加入链接 `<cindy|cindycn|cindydev>://relay/join?u=<中转地址>&c=<一次性加入码>&o=<主人公钥>&s=<配对秘密>` 由 `@cindy/device-link` 的
  `buildRelayJoinLink` / `parseRelayJoinLink` 生成与解析，Desktop 与 Mobile 共用 `fetchRelayInfo` /
  `submitRelayPairRequest` / `waitForRelayApproval`。`DeviceLinkClient.authorizationScheme` 也可传函数，每次建连前取值。
- 客户端：Desktop 的地址与凭证经 `device-link/selfHostedRelayRouting.ts`（零依赖）读取，REST 统一走
  `deviceLinkApi.ts`（自建中转时带 `CindyRelay`、跳过账号刷新与会话失效；官方请求刷新后的重试只重读官方区域端点，
  不随中转选择切到自建地址）；Mobile 见 `apps/mobile/src/device-link/selfHostedRelay*.ts`。

兼容：未选择自建中转时，客户端与官方 relay 的行为不变（没有登记中转来源或使用官方中转时一律回到原路径）。
旧客户端没有入口；旧版手机无法加入自建中转。互通验证：`pnpm --filter @cindy/device-link-relay run interop`
（本机起中转、走加入流程，再跑 `scripts/device-link/interop.test.ts`，认证方案由 `CINDY_TEST_AUTH_SCHEME` 指定；
`CINDY_TEST_FRAME_AUTH` 提供测试签名密钥时全程开启设备签名，两端核对每一条对端消息）。

### agent-net 数据报转发（实验，默认关闭）

agent-net 第 7 步（[`agent-net-plan.md`](../../agent-net-plan.md) §0）在自建中转内核里加了一条可选的数据报转发通道，
实现见 `packages/device-link-relay/src/agentNet.ts`。**默认关闭**：`startRelayServer` 不传 `agentNet` 时不注册路径、
`/relay/info` 的 `features` 不变、升级请求照旧 404，内核行为与 bundle `0.3.1` 逐字节相同，所以没有改 `RELAY_VERSION`、
CLI 和分发构建；产品里开始用它时再升版本、加开关，并按[跨端协议兼容 · 自建中转同步维护](../protocol-compatibility.md#自建中转同步维护)的要求补互通验证。

- 入口 `/api/device-link/agent-net`，WebSocket 升级时用 `CindyRelay` 凭证认证（和设备连接共用端口、证书与 Nginx）。打开后 `features` 声明 `agent-net-relay-v1`。
- 只收发二进制帧 `[类型 1][设备号长度 1][设备号][长度 2，大端][数据报]…`：设备发出时设备号是收件设备，中转转发时换成凭证绑定的发件设备。
  内容是两端 agent-net 核心加密过的数据报，中转不解析；不在线、积压超过 1 MiB、帧不合格时直接丢，不回错误。
- 每台设备只保留最新的一条（旧的 4409），设备被移除时立即断开（4410），之后凭证升级返回 401；不交换在线状态，在线仍由 `/api/device-link/ws` 负责。
- 没有自建中转、或自建中转没开这项功能时，agent-net 的数据报夹带在现有 `push` 帧里（channel `agent-net:datagrams`，内容 base64），
  官方中转与已部署的自建中转都按不透明 push 转发，不需要改服务端，旧客户端收不到也不会处理这个 channel。
  这条路尚未接入产品，只在 `prototypes/agent-net-spike` 验证。
- 验证（2026-11-05）：`relay.test.ts` 的 agent-net 用例覆盖默认关闭、认证、发件设备改写、丢弃规则、顶替和移除；
  `pnpm --filter @cindy/device-link-relay test` 50 项与 `run interop` 通过；EdgeHub 原型在本机起的内核上
  用专用通道和 push 夹带两种方式各跑真实 `DeviceLinkClient` 的 12 项检查，UDP 关闭时全部通过。

### agent-net 连接号轮换（2026-11-07，实验、未接入产品）

`packages/agent-net-core` 增加加密的交号快照（帧 10）和确认（帧 11）：线上目的号按路径轮换，
`Endpoint` 给驱动和 WASM/Node 的连接句柄仍稳定。普通数据报包头仍是 3 字节包头 + 4 字节目的号；
尚无与旧实验核心的能力协商，两端须一起更新。本次不改 V1 Device Link 客户端或帧。

专用中继与 push 夹带仍只转发原有的不透明加密数据报，不解析目的号或帧，内核、分发版本与部署不变。
验证使用本机真实自建中转原型：`poc-edgehub.ts relay`、`push`、`punch` 各 12/12，直连 `core` 12/12，
Node 驱动 6/6（含真实 UDP 换端口与两端换号计数）。本次没有部署 V2 服务，也没有真实公网或手机换网复测。
记录见 [`连接号轮换`](../../../packages/agent-net-core/sim/results/2026-11-07-id-rotation/README.md)。

### 独立 Agent-Net V2 与 Desktop 兼容接线（2026-11-07）

V2 是独立 `/api/agent-net` 路由与 `AgentNet` 设备持钥认证，不接受 V1 凭据或账号 token 回退。
V1 内核的 server/hub 和 v1 线格式不变；部署 bundle `0.4.0` 新增的只是 CLI 入口/TLS 托管方式与
Nginx 的独立 V2 路径。公共前端只代理两个固定回环内核，不解析或转换业务与认证。

- 原加入链接增加可选 `a=<V2 加入码>`，原 `u/c/o/s` 保留。旧 Desktop/Mobile 忽略 `a`，仍执行 V1 配对；
  新 Desktop 还提交 V2 CSR。主人分别核对两个配对证明、公钥和设备绑定，一次 UI 批准两份证书。
  V1 成员未持有 V2 证书时继续使用原路径，不自动制造新身份或强制打开开关。
- `link-open` / `link-accept` 现有可扩展 capabilities 增加可选 `agent-net-node-v2`，属于对端签名内容。
  新 RoutedDeviceLinkClient 在未知 V2 当前模式时，只先发有界的 V1 link 握手，收到已签名能力后再选业务路径。
  已知 V2 对端掉线不能仅凭中转不可达明文降级；声明 V2 的对端发来 V1 invoke/push 时拒绝业务分发。
  未配置此适配器的客户端保持原行为，旧中转仍只需现有不透明签名/能力转发，不需要改内核。
- 同账号 V2 消息走 Rust 加密流；旧/关闭 V2 的对端继续走所选 V1 自建线路。
  2026-11-08 起，明确的 V2 分享/共享任务邀请与后续 API、按资源路由、媒体、续期/撤销均固定到邀请中的服务和根。
  旧 V1 资源只在允许兼容时沿原路径工作；私有资源不能因为未登记官方证书或中转不可达而回落官方线路。
  官方普通 V1 与跨账号 V1 兼容流共用同一设备 socket，避免重复注册同一身份互踢。
  V2 scoped grant 可增量携带精确执行电脑背书；紧凑 Guest PoP 额外绑定 network/委托 ID，旧完整委托仍校验当前主体和授权。
  各账号网络只同步设备签名的公开来源，跨区专用名片使用显式 issuer/region allowlist，不改普通登录 token 的准入范围。
- V2 设备移除/改名与 V1 管理同步处理，账号切换前后的异步结果不能跨作用域落地。
  私有配对关系持久至撤销，缓存名册的离线信任仍最多 14 天；不改变官方账号证书期限。
- 中转恢复时 V2 本地 socket 重发已有 `hello-ack` 刷新通知能力，不重建应用 socket 或健康 peer。
  手机通知私有存储格式 3 追加 `peerExpiresAt`，按实际发送者校验证书期限；全局期限只约束名册和本机证书。
  新原生模块兼容已有格式 2 的全局短期限，旧模块拒绝写入格式 3，不静默忽略逐设备期限。
  这是本机 JS/原生存储合同；通知密文格式仍为 2、服务端及中转无变化，必须随匹配指纹的新原生包发布。

共享客户端/中转测试、签名加入与重连 `run interop`、真实 V1/V2 公共入口和 V2 socket 集成通过；
部署控制器与 Renderer 开关验证通过；Mobile iOS/Android 原生构建和探针通过，实际 SSH/systemd/ACME、真实账号全业务和物理手机锁屏推送仍待验收。
记录与剩余项见 [`Desktop 接线记录`](../../../prototypes/agent-net-spike/results/2026-11-07-desktop-runtime/README.md)。

## 自建中转同步维护

服务器部署的 Nginx 自动接入使用中转 bundle `0.3.0`（`nginx` 为 SSH 部署内部 CLI）。公网仍使用
原有 HTTPS/WSS 地址、`CindyRelay` 认证、媒体签名地址及 v1 设备协议；不新增跨端帧、能力位或权限。
已部署 `0.2.0` 的通信行为继续兼容，需要自动配置 Nginx 时由现有升级入口上传新 bundle。
证书请求的网络重试与临时失败状态随 bundle `0.3.1` 提供；已部署 `0.3.0` 的服务器通过现有升级入口更新程序。
新增的证书状态 `transient` 为可选字段，旧客户端忽略；新客户端连接旧中转仍沿用原失败处理，线协议与主人身份不变。
Nginx 后端的 `--trust-proxy` 只对回环连接的单个有效 `X-Forwarded-For` IP 启用配对来源识别，
部署生成的代理配置必须覆盖该头；直连及默认未信任模式继续按 socket 来源限流，协议不变。
Desktop/Mobile 继续共用原客户端，无须更改服务端；验证入口见
[`self-hosted-relay-plan.md §15.3`](../../self-hosted-relay-plan.md#153-第-3-步设备签名一键部署到服务器远程管理2026-10-28)。

同步维护的硬性要求（触发范围、一起适配、一起验证、照顾已部署版本、交付说明）见[跨端协议兼容 · 自建中转同步维护](../protocol-compatibility.md#自建中转同步维护)。
