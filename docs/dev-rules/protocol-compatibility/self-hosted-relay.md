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
