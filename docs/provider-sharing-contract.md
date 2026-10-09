# 供应商分享：跨仓协议契约

> 状态：实现契约（2026-10-07）。客户端（本仓）与服务端（`cindy-server` 的 `device-link-server`、
> `auth-server`、`packages/device-link-protocol`）按本文同步实现；任何一侧要改字段语义，先改本文。
> 产品规则见 [`product-rules/provider-sharing.md`](product-rules/provider-sharing.md)，
> 工作拆分见 [`provider-sharing-implementation-plan.md`](provider-sharing-implementation-plan.md)。

## 1. 名词

- **分享（share）**：一个分享者账号在一台电脑（host device）上的一个供应商。`shareId` 由服务端生成。
- **成员（member）**：被同意的受邀者在某个分享里的身份。`memberId` 由服务端生成，全局唯一。
- **链接（link）**：一次性口令（43 位 base64url，`randomBytes(32)`），5 分钟过期，服务端只存 sha256。
- **申请（request）**：受邀者凭链接发出的申请，24 小时过期，带 4 位配对码。
- **受邀者键（guestKey）**：同区域为受邀者账号的 `membershipId`；跨区域为 `x:<region>:<sub>`（P3）。

## 2. relay 范围（`packages/device-link-protocol`，两仓同文件 `providerShare.ts`）

```ts
export const PROVIDER_SHARE_RELAY_CAPABILITY = 'provider-share-v1';
export type ProviderShareEndpoint = { role: 'host' } | { role: 'guest'; memberId: string };
export interface ProviderShareScope {
  shareId: string;
  target: ProviderShareEndpoint;
  /** 只由 relay 写入，永不信任发送方提供的值。 */
  source?: ProviderShareEndpoint;
}
export function providerShareIdentifier(value: unknown): string; // 规则同 sharedTaskIdentifier
export function parseProviderShareScope(value: unknown, withSource?: boolean): ProviderShareScope | null;
```

- `Envelope` 新增可选 `providerShare?: ProviderShareScope`。同一帧不得同时带 `sharedTask` 与 `providerShare`（relay 回 `BAD_REQUEST`）。
- 能力协商：客户端在 hello `capabilities` 声明 `provider-share-v1`；relay 在 hello-ack 声明同名能力。客户端只在 relay 声明后发送带范围的帧；relay 要求收发双方都声明，否则回 `VERSION_MISMATCH`。
- **受邀者 → 分享者**：只允许 `link-open / link-close / invoke / push`，其中 push 只允许 `__cindy/device-link/transport-ack`。条件：分享 `active`；成员 `active`（`paused / removed / left` 一律拒绝）；发送设备已登记到该成员（首次 `link-open` 自动登记同一受邀者账号的新设备，每个成员最多 64 台）；`dst` 等于分享的 `hostDeviceId`；分享者设备在线；`link-open` 与 `invoke` 还要求分享者设备 `remoteControlEnabled = true`（否则 `REMOTE_DISABLED`）。relay 把 `source` 改写为 `{ role: 'guest', memberId }`。
- **分享者 → 受邀者**：只允许 `link-accept / link-close / invoke-result / push`。发送方必须是分享者账号且设备等于 `hostDeviceId`；`target.memberId` 必须属于该分享，`dst` 必须是该成员已登记的设备。`source` 改写为 `{ role: 'host' }`。成员不再 active 时也允许 `link-close` 与 `invoke-result`（收尾）。
- 被拒绝的帧回 `relay-error`，code 用 `DEVICE_OFFLINE`（不暴露原因；受邀者原因看 REST），回带原范围。
- 分享不随分享者离线关闭（与共享任务不同，没有离线宽限与关闭扫描）。
- 跨实例 Redis bus 携带 `providerShareSource`，订阅端重新校验，跳数上限与共享任务相同。

### 客户端本地 peer key（只在客户端，不上 wire）

`packages/device-link/src/providerSharePeer.ts`：`JSON.stringify(['provider-share', shareId, role, memberId | null, deviceId]).padEnd(129, '~')`，
长度恒大于真实设备 ID 上限 128，不会与真实设备或共享任务 key 碰撞；只在 socket 边界编解码。

## 3. REST：`/api/device-link/provider-shares`

全部需要 auth-server Access Token，且必须绑定设备（`actor = { accountId: membershipId, deviceId }`）。
请求体拒绝多余字段；响应 `Cache-Control: no-store`；错误统一 `{ error: { code, message } }`；
写操作沿用按账号限流；口令只出现在请求体，不进 URL 与日志。

### 3.1 分享者（只能在 hostDeviceId 那台设备上调用）

| 方法 | 请求体 | 响应 |
|---|---|---|
| `GET /` | — | `{ shares: OwnerShare[] }`（本账号、本设备的 active 分享） |
| `POST /links` | `{ providerId, providerLabel, deviceName, identityCard }` | `{ shareId, invitation, expiresAt }` |
| `POST /requests/:requestId/approve` | `{}` | `{ shareId, memberId }` |
| `POST /requests/:requestId/reject` | `{}` | `{ requestId, status: 'rejected' }` |
| `POST /members/:memberId/pause` | `{}` | `{ memberId, status: 'paused' }` |
| `POST /members/:memberId/resume` | `{}` | `{ memberId, status: 'active' }` |
| `POST /members/:memberId/remove` | `{}` | `{ memberId, status: 'removed' }` |

```ts
interface Person { displayName: string; avatarUrl: string | null; region: 'cn' | 'global' }
interface OwnerShare {
  shareId: string; providerId: string; providerLabel: string; hostDeviceId: string; createdAt: string;
  members: Array<Person & { memberId: string; status: 'active' | 'paused'; joinedAt: string }>;
  requests: Array<Person & { requestId: string; pairingCode: string; createdAt: string; expiresAt: string }>;
}
```

- `POST /links`：同一（分享者、设备、`providerId`）已有 active 分享则复用，否则新建；同时用名片刷新分享者快照与 `providerLabel`、`deviceName`。`identityCard.purpose = 'share-link'`，`nonce = sha256hex(hostDeviceId + ':' + providerId)`。
- 批准：申请必须 `pending` 且未过期；成员按（分享、guestKey）幂等：已有 `removed / left` 行时恢复为 `active`（新 memberId 不必变），链接置 `consumed`。
- 拒绝、撤回、过期：链接置为对应终态，不可再用。

### 3.2 受邀者

| 方法 | 请求体 | 响应 |
|---|---|---|
| `POST /preview` | `{ invitation }` | `LinkPreview` |
| `POST /requests` | `{ invitation, identityCard }` | `{ requestId, pairingCode, status: 'pending', expiresAt }` |
| `GET /requests/:requestId` | — | `{ requestId, status, pairingCode, expiresAt, shareId?, memberId? }` |
| `POST /requests/:requestId/withdraw` | `{}` | `{ requestId, status: 'withdrawn' }` |
| `GET /received` | — | `{ shares: ReceivedShare[] }` |
| `POST /received/:memberId/leave` | `{}` | `{ memberId, status: 'left' }` |

```ts
interface LinkPreview {
  shareId: string; providerId: string; providerLabel: string; deviceName: string; owner: Person;
  state: 'unused' | 'used' | 'expired'; expiresAt: string;
}
interface ReceivedShare {
  shareId: string; memberId: string; providerId: string; providerLabel: string;
  hostDeviceId: string; deviceName: string; owner: Person;
  status: 'active' | 'paused';
  hostOnline: boolean;   // relay presence
  hostCapable: boolean;  // 分享者设备声明了 provider-share-v1
}
```

- 申请：`identityCard.purpose = 'share-request'`，`nonce = sha256hex(invitation)`；同区域要求名片 `sub` 等于请求的 `accountId`。
- 申请状态：`pending | approved | rejected | withdrawn | expired`；`GET` 只对申请人可见。
- 配对码：`crypto.randomInt(0, 10000)` 补零 4 位，只出现在申请人的申请响应／状态查询与分享者的 `requests` 里。

### 3.3 错误码

| code | HTTP | 场景 |
|---|---|---|
| `NOT_FOUND` | 404 | 口令格式不对、不存在；申请／成员不存在或不属于调用方 |
| `PROVIDER_SHARE_LINK_USED` | 409 | 链接已被申请或已作废 |
| `PROVIDER_SHARE_LINK_EXPIRED` | 410 | 链接或申请已过期 |
| `PROVIDER_SHARE_SELF` | 409 | 分享者打开自己的链接 |
| `PROVIDER_SHARE_ALREADY_MEMBER` | 409 | 受邀者已是该分享的 active / paused 成员 |
| `PROVIDER_SHARE_IDENTITY_INVALID` | 400 | 名片验签失败、过期、用途或 nonce 不符、sub 不一致 |
| `PROVIDER_SHARE_NOT_HOST_DEVICE` | 403 | 分享者接口不是从分享所在设备调用 |
| `PROVIDER_SHARE_CROSS_REGION_DISABLED` | 403 | P3：跨区开关关闭 |
| `PERMISSION_DENIED` / `CONFLICT` / `BAD_REQUEST` | — | 沿用现有语义 |

### 3.4 过期与清理

链接 5 分钟、申请 24 小时；接口内按 `expiresAt` 即时判定，后台扫描把过期行置为 `expired` 并定期删除已过期超过 7 天的链接与终态申请。成员行保留为墓碑。

### 3.5 公开加入页 `/provider-share/join`

仿 `/shared-task/join`：口令在 `#` 之后（`#<token>[?app=cindy|cindycn|cindydev]`），页面不访问数据库。
桌面浏览器一律唤起 `cindy://provider-share/join?invitation=<token>&server=<origin+prefix>`（与共享任务一致：各区域与 dev 的桌面版
都注册 `cindy://`；`app` 提示只给手机网页用）。唤起失败时提示把链接粘贴到 Cindy（设置 → 模型供应商 → 右上角「输入分享链接…」；2026-10-08 起入口从左栏组末移到这里，加入页文案需同步）。
手机浏览器不唤起 App，显示「请在电脑上打开这个链接」并提供复制链接。五种语言、深浅色、严格 CSP。

## 4. 身份名片（auth-server）

`POST /api/me/identity-card`，普通用户 Access Token，按账号限流。

- 请求：`{ audience: 'cindy-provider-share', purpose: 'share-link' | 'share-request' | 'share-session', nonce: string(1..128) }`（`share-session` 只用于 P3 跨区，见 §6.2）
- 响应：`{ card: string, expiresAt: string }`
- `card` 为 RS256 JWT，沿用现有签名 key 与 JWKS（`kid`）。claims：
  `{ typ: 'identity-card', iss, aud: 'cindy-provider-share', sub: <membershipId>, name: <displayName>, picture: <avatarUrl|null>, region: 'cn'|'global', purpose, nonce, iat, exp: iat + 300 }`。
- **只放昵称与头像**；不放邮箱、手机号（含脱敏）、组织。
- device-link-server 用 issuer 的 JWKS 验签并核对 `typ / aud / purpose / nonce / exp`；同区域只信任本区域 issuer；P3 才额外信任对方区域 issuer（且只用于名片）。

## 5. 分享者电脑本地（客户端）

- 受邀者对端由 peer key 判定（`controllerTrust` 返回 guest）；准入要求：允许远程控制、该分享供应商的「允许被远程调用」、本机缓存里分享与成员 active。
- 只放行 invoke channel：`maker:remote-agent:v1`、`maker:provider:list`（只返回该分享的供应商），以及模型列表与发送前检查要读的
  `maker:get-capabilities`（只留该供应商的模型）、`maker:list-available-agents`（只留它支持的 Agent）、`maker:agent:status`
  （只回该供应商支持的 Agent 是否装好 `binaryReady`，不带本机路径、登录身份与分享者自己的登录状态）；订阅与其他 channel 全拒，迟到的结果在撤权后改写为拒绝。
- 远程 Agent 运行按受邀者设备隔离（peer key 含分享、成员与设备）：运行数上限沿用每个控制端的上限；暂停或删除时立即结束任务，删除时清理本机会话数据（影子工作区、附件、会话记录）；用量记录保留。

## 6. P3 跨区域（服务端开关 `PROVIDER_SHARE_CROSS_REGION_ENABLED`，默认关）

分享属于分享者区域。受邀者在另一个区域时，**不使用**本区域 Access Token 访问对方区域，而是用本区域 auth-server
签发的身份名片换取只限分享的凭证。开关关闭时下列 `/x/*` 接口一律 `403 PROVIDER_SHARE_CROSS_REGION_DISABLED`，
WebSocket 拒绝 `ProviderShareGuest` 认证；同区域分享不受影响。

### 6.1 配置（分享者区域的 device-link-server）

| 变量 | 说明 |
|---|---|
| `PROVIDER_SHARE_CROSS_REGION_ENABLED` | `true` 才开放；默认关 |
| `PROVIDER_SHARE_PEER_REGION` | 对方区域：`cn` 或 `global` |
| `PROVIDER_SHARE_PEER_ISSUER` | 对方区域 auth-server 的 issuer（名片 `iss` 必须精确等于它） |
| `PROVIDER_SHARE_PEER_JWKS_URL` | 对方区域 auth-server 的 JWKS 地址（只用于验证名片） |

对方区域名片的 `region` claim 必须等于 `PROVIDER_SHARE_PEER_REGION`。跨区 guestKey = `x:<peerRegion>:<sub>`，
跨区设备 id = `x:<peerRegion>:<sha256hex(guest 设备 id) 前 32 位>`（不与本区域设备 id 冲突）。

### 6.2 REST：`/api/device-link/provider-shares/x`（不需要 Access Token）

| 方法 | 认证 | 请求体 | 响应 |
|---|---|---|---|
| `POST /x/preview` | 名片 | `{ invitation, identityCard }` | `LinkPreview` |
| `POST /x/requests` | 名片 | `{ invitation, identityCard }` | `{ requestId, pairingCode, status: 'pending', expiresAt, requestToken }` |
| `POST /x/requests/:requestId` | requestToken | `{ requestToken }` | 申请状态（同 `GET /requests/:id`） |
| `POST /x/requests/:requestId/withdraw` | requestToken | `{ requestToken }` | `{ requestId, status: 'withdrawn' }` |
| `POST /x/session` | 名片 | `{ identityCard, deviceId, deviceName, platform }` | `{ credential, expiresAt, deviceId, shares: ReceivedShare[] }` |
| `POST /x/received/:memberId/leave` | 凭证 | `{}` | `{ memberId, status: 'left' }` |

- 名片：`preview`、`requests` 用 `purpose = 'share-request'`、`nonce = sha256hex(invitation)`（同一张名片可先预览再申请）；
  `session` 用 `purpose = 'share-session'`、`nonce = sha256hex(deviceId)`，`deviceId` 是受邀者在本区域的设备 id。
- `requestToken`：43 位 base64url，只存摘要，只能查询与撤回这一条申请。
- `session`：为该 guestKey 的全部 active / paused 成员登记这台设备（每个成员最多 64 台），签发一个连接凭证
  `credential`（43 位 base64url，只存摘要，24 小时过期，同一设备再次调用即轮换、旧凭证失效）；
  `shares` 只含这个 guestKey 的分享（字段同同区域 `ReceivedShare`）。没有任何成员时返回空 `shares` 且不签发凭证
  （`credential: null`）。受邀者的电脑定期（≤ 12 小时）或凭证失效时重新调用。
- `leave` 用 `Authorization: ProviderShareGuest <credential>`；只能退出该凭证所属 guestKey 的成员。
- 限流：按 guestKey（名片 `sub`）与来源 IP 限流，口径同同区域写操作。

### 6.3 relay

- WebSocket 升级接受 `Authorization: ProviderShareGuest <credential>`（同区域连接仍用 Access Token）。该连接的身份是
  跨区设备 id，hello 必须声明 `provider-share-v1`；只能收发带 `providerShare` 范围的帧（规则同 §2 受邀者 → 分享者），
  不加入任何账号的 presence，不能订阅、不能访问共享任务或其他 relay 能力。
- 凭证过期、被轮换，或者它关联的成员全部不再 active 时，relay 断开该连接（close code 4401）。
- 分享者 → 跨区受邀者的帧按 §2 投递到该跨区设备。

### 6.4 客户端（受邀者）

- 链接的服务地址属于另一个官方区域（按内置的对方区域清单判定）时走跨区流程；其他地址一律拒绝。
- 名片向自己区域的 auth-server 换取（同 §4）；对方区域的 REST 地址与 relay 地址取自内置的对方区域清单。
- 对方区域的请求一律不带本区域 Access Token，对方区域的 401 也不会刷新或登出本区域账号。
- 凭证只在内存里：启动、过期前与申请被同意后，用新名片调用 `/x/session` 重新换取；本机只记一个不含凭证的标记
  （`userData/remote-agent/provider-share-regions.json`：账号摘要 → 区域），表示「这个账号在对方区域发过申请或加入过
  分享」。没有标记的账号从不联系对方区域；`/x/session` 返回没有分享时清除标记。
- 远程 Agent 经第二条 relay 连接（对方区域，`ProviderShareGuest` 认证，hello 声明 `remoteControlEnabled: false`）访问
  分享者电脑，任务绑定与同区域相同（`share:<shareId>`）。
