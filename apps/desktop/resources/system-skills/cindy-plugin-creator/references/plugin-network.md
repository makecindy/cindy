## 4.7 网络代发(network 能力)

`cindy.fetch` 有两个清晰的运行边界：

- 当前 Agent tool-call 内：传 `callId: msg.callId`，可访问未预声明的普通
  HTTPS 地址，无需 `network` 字段。主机仍强制 URL、SSRF、超时、体积与
  重定向守门，但不会向未声明 host 注入任何 Host 托管凭证。
- 脱离当前 Agent 调用的自主联网：声明 `network` 详单(§2)，只能访问
  **白名单内的域名**。需要主机保险库凭证、OAuth 或动态连接时也必须
  显式声明，只有命中声明 host 才会注入。

沙箱本身两种情况都零直连，请求统一由主机代发。规则:

```js
const r = await cindy.fetch({
  url: 'https://api.example.com/v1/search?q=hello',  // 仅 https、默认端口
  method: 'GET',            // 可选:GET(缺省)/ POST / PUT / PATCH / DELETE
  headers: { Accept: 'application/json' },  // 可选;Host/Cookie/Authorization 等由主机管,写了也不生效
  body: '{"q":"hello"}',    // 可选:仅 POST / PUT / PATCH / DELETE,≤256KB 文本
  timeoutMs: 30000,         // 可选:文本模式 1s–60s 缺省 30s;媒体模式 1s–300s 缺省 120s
  as: 'text',               // 可选:'text'(缺省)/ 'media'(响应是媒体,主机落仓,见下)
  label: '',                // 可选:仅媒体模式,入账备注/画廊 caption(≤200 字符)
  callId: msg.callId        // Agent tool-call 内务必带上，同时作为严格在途授权绑定
});
// 文本成功:{ ok:true, status: 200, headers: { 'content-type': … }, body: '<响应文本>', truncated? }
//   注意 4xx/5xx 也是 ok:true(代发成功,对方说不行)——自己看 status 分支。
//   body 上限 50MB,超限截断并带 truncated:true;文本模式下二进制响应返回 ok:false。
//   超 1MB 的大文本响应与媒体取件共享全局通道(同时只读一单),通道忙时
//   返回 ok:false「大响应通道正忙」——稍后重试即可,小响应不受影响。
// 媒体成功(as:'media' 且响应是受支持媒体):
//   { ok:true, status, headers, media: { url: 'cindy-media://blobs/<指纹>.<后缀>', hash, ext, bytes } }
//   **字节不进你的沙箱**:主机直接落媒体总仓、记到你名下(与 cindy 代办产物同等待遇:
//   可当改图源图、可上画廊、交卷 xdt_image_urls 可渲染)。受支持类型 = 图片(png/jpg/
//   webp/gif)/ 视频(mp4/webm/mov)/ 音频(mp3/wav/m4a/ogg)/ 3D(glb);上限 256MB,
//   超限整单拒(不截断)。Content-Type 只作为线索,落仓前主机会按字节验证真实媒体类型;
//   对缺失、text/plain 或通用 octet-stream 这类常见误报/泛化声明,主机会按受支持
//   媒体的有限魔数尝试识别。识别成功仍走同一媒体总仓,并以字节识别出的 MIME 落仓;
//   识别失败的真实 UTF-8 文本继续回落文本形态,未知二进制拒绝。
//   媒体模式下 2xx 的文本响应(如轮询"生成中"JSON)自动
//   回落文本形态给你看;非 2xx 同样回落文本,方便诊断。
// 失败:{ ok:false, message: '原因', errorCode? }(白名单外 / 凭证未配置 / 超时 / 网络错误…)
//   请求已发出后的网络层失败带 errorCode,message 形如「请求失败:<原因>(<底层码>)」:
//   NETWORK_TIMEOUT(超时,含主机到点中断「请求失败:请求超时(30000ms)」)/
//   TLS_ERROR(证书过期、域名不匹配等,多为服务端问题)/ DNS_FAILED / CONNECTION_REFUSED /
//   CONNECTION_RESET(连接中途断开)/ NETWORK_UNREACHABLE / NETWORK_ERROR(其余网络错误)。
//   主机守门类失败(白名单外、凭证未配置等)不带 errorCode,message 自带处理指引。
//   旧版主机不带 errorCode:以 errorCode 优先,缺省时按 message 处理。
//   非幂等请求(POST 等)遇到 NETWORK_TIMEOUT / CONNECTION_RESET 时,服务端可能已执行,
//   不要自动重放,提示用户先确认结果。
```

**凭证语义(必读)**:你在详单里只声明"需要一条叫什么的凭证、注入到哪个请求头";
值由主机加密保管、只在代发请求时注入。**保险库里的明文你的代码永远读不回**——
不要试图让用户把 key 发进聊天,更不要把 key 硬编码在源码里。
这里说的是 `network.secrets` 的浏览器沙箱/HTTP 代发语义；确需本地协议时，
`node.secretBindings` 是唯一允许把对应凭证交给 Node Worker 的显式例外，
并会在插件详情的能力清单单独披露(见 §4.12.1)。

**调用前缺失的普通 user Secret 由主机统一 Setup 卡收单**：主机只根据你声明的
`label` / `hint` 生成密码输入，不把值交给 Agent 或你的代码；提交后直接写保险库并
重新检查 setup，全部满足才继续原工具调用。你不要声明表单字段 id、Action id 或聊天卡
回调，也不要让用户把 key 发进聊天。同一 `anyOf` 组声明了多种合法配置方式时，
主机会完整展示所有选项供用户选择，不会只取第一项；选项较多时统一卡片正文内部滚动。

**settingsHtml 仍负责详情页里的长期管理**(当前声明 user 凭证仍必须同时声明
settingsHtml,校验强制):你在 settingsHtml 里画输入框供用户主动添加、替换或清除，值经
`fetch('/secrets/<key>', { method:'PUT', body: JSON.stringify({ value }) })`
**一次性交给主机保险库**(204 即入库),`fetch('/secrets')` 只能查回
`[{key, saved, tail?}]` 状态、**永远拿不回值**(tail 是主机截存的**尾 4 位
指纹**,仅够用户回忆"填的是哪个 key";值不足 12 字符时不产——UI 要按没有
tail 也能画来写),DELETE 清除。红线:收单即交,不许把 key 落进 /kv、
BroadcastChannel、日志或任何自存路径(review 必查)。凭证只会注入到它
`inject.hosts` 声明的域名请求,重定向出域也不会跟着走。用户没填时 cindy.fetch
返回结构化错误,把 message 原样告诉用户即可(里面带了去哪填的指引)。
**可选的凭证校验**：普通 user secret 可声明 check：
`{ url, bodyFormat, validPath, validValue, expiresAtPath?, expiresAtFormat? }`。
url 必须是 HTTPS 默认端口且命中该凭证的 inject.hosts 与 network.hosts；bodyFormat
为 JSON 对象模板，恰含一个字符串内的 {value}。validPath 为响应 JSON 点路径，
validValue 为非空短字符串或布尔；有效期格式为 iso（默认）、unix-ms 或 unix-seconds。
GET /secrets 仅对支持的声明返回 checkSupported:true。设置页可 POST
`/secrets/<key>/check`，body 为 `{value}`，候选值只在 Host 此次请求内存中存在。
Host 复用声明的 exchange 与 inject 完成两段请求，不保存候选、不共享换得的 token 缓存，
不跟随重定向；只回 `{valid:boolean,expiresAt?:ISO日期}`，不回原响应或凭证。
这是校验而非保存；PUT 的结果与 check 的结果必须分别呈现。旧 Host 缺 checkSupported
时继续支持保存，明确说明未校验，不得退回 BC 发送凭证。服务端错误只回受控错误码。
例：`check:{url:"https://api.example.com/check",bodyFormat:'{"apiKey":"{value}"}',
validPath:"status",validValue:"active",expiresAtPath:"expiresAtMs",expiresAtFormat:"unix-ms"}`。

无论走 Setup 卡还是 settingsHtml，入库成功时主机会自动弹一条「凭证已保存」的系统提示(带你的身份头,
文案跟随用户语言;无需声明 notify)——设置页里画个就地的轻反馈即可,
不用自己想办法做全局提示。
(历史字段 `input` 已退役:遗留 `"input":"ghost"` 可被接受并忽略,
`"input":"host"` 直接拒——删掉该字段即可。)

**登录邮箱派生凭证(source:"login-email",可选)**:适用于"服务端按登录邮箱派生
鉴权"的第一方服务(如 pages_<邮箱> 形态的 token)。凭证声明 `"source": "login-email"`
后,值不再由用户填——主机在每次请求时现读当前登录账号的邮箱,按 `inject.format`
模板派生(如 `"format": "pages_{value}"` 得到 `pages_<邮箱>`)注入请求头;它没有
任何输入动作,插件详情会如实告知"将使用你的登录邮箱"。
未登录 / 登录态没有邮箱时 cindy.fetch 返回带重登指引的结构化错误,把 message 原样
告诉用户即可。注意:声明了 login-email 就不要再写 `url`(没有"前往控制台"可去)
也不要配 `exchange`(登录邮箱不外送交换端点),两者校验都会拒。你的 settingsHtml
可经 `fetch('/secrets')` 查回该凭证的 `{ key, saved, identity }`(identity =
当前登录邮箱,拿来只读展示"用的是哪个身份";未登录时 saved:false 无 identity,
照"请重新登录"画)——详情页已如实披露,除展示外别拿它做别的;对该 key 的
PUT/DELETE 一律 405(派生身份不可配置)。

**GitHub CLI 优先凭证(source:"gh-cli",保留能力)**:仅官方 `cindy-github`
插件可声明。主机每次 GitHub API 请求时优先复用本机 `gh auth token` 的登录态；
本机没装 gh、未登录或读取超时时,再回落到同一 key 经 `/secrets` 保存的备用 PAT。
两种 token 都只在 Main 的 networkSlot 内存中进入请求头,插件沙箱、settings 页面、
Renderer、Agent、KV 和日志都拿不到。设置页 GET `/secrets` 对这条 key 额外返回
`hostSource:"gh-cli"` 与 `hostAvailable:boolean`,其中 `saved/tail` 仍只描述备用
PAT。支持宿主管理连接入口时还返回可选的 `hostManagedSetup:true`：此时宿主统一
展示账号状态、安装与登录入口，settingsHtml 不再重复渲染这些内容，只保留备用 PAT
配置（可折叠到“其他连接方式”）。字段缺失或为 false 时保留旧版设置页的连接提示，
可根据 `hostAvailable` 展示“已检测到 gh，可直接使用”；不能读取 gh 的账号或 token。
此来源的注入形态固定为 `api.github.com` 的
`Authorization: Bearer {value}`,不允许 exchange,也不要放进 `setup.requires`。

**Cindy 企业身份断言(source:"oidc-token",可选)**:适用于接入 Cindy Connection
Auth 的企业服务。主机只在当前登录账号属于组织 Membership，且满足以下任一安装基座时
按需向 auth-server 换取短时 Connection JWT：①当前组织的 Plugin Market organization
安装记录(source 必须是服务端 `market`)，且 namespace 属于当前组织、已批准整包 sha256 与记录一致；②企业作者
显式调用 `ghost_forge_install` 安装到当前组织 namespace，且批准 receipt
保有本次包的完整 sha256。两路都要求清单声明目标服务域名。
audience 与组织身份由主机推导,插件清单和运行时代码都不能选择、读取或保存
audience/token；audience 固定为 `${orgSlug}:${ghostId}`,总长不得超过 64 字符。
个人身份与手动导入不签发。临时例外，只对 root 实例生效：`ghostId` 精确等于 `mivo-canvas`、namespace 为 null 或尚未确认的旧 root 安装，且已装清单声明的精确 oidc-token host 仅为 `mivo-canvas.dsworks.cn` 时可解析 audience；企业 namespace 下的同名插件、其它本地插件、其它精确 host 仍不签发。已有市场
organization 记录（含 installed:false）时必须仍走 digest，不得借例外跳过。市场账本损坏、schema 不认或该 ghostId 记录校验失败时 fail-closed，不得当成无记录。企业身份的 Forge 安装前会展示插件名、id 与精确域名，并要求手输相同 id
确认。市场与 Forge 两条组织基座都只给 Broker 与 oidc-token、不给宿主原语。
该凭证必须固定声明
`"inject": { "header": "Authorization", "format": "Bearer {value}", "hosts": [...] }`,
且 `hosts` 必须是非空的显式子集,只允许把断言发给列出的企业服务域名。
`oidc-token` 的 `inject.hosts` 只接受精确域名,不允许 `*.example.com` 通配；Host
会从已批准的安装事实读取这些声明,目标请求必须精确命中声明域名才会签发并注入。
它没有用户输入、`url`、`exchange` 或 `oauth` 详单,也不要放进 `setup.requires`;没有企业
身份时 cindy.fetch 会 fail-closed 并返回结构化错误。企业服务应使用 Connection JWT
中的 `sub`、`email` 或 `identities` 等声明自行选择业务身份,不要要求 Cindy 客户端先把
令牌交给插件代码。上游返回 401 时,Host 只对 GET / HEAD / OPTIONS 自动换令牌重试一次；
POST / PUT / PATCH / DELETE 和上传请求只作废令牌缓存、不自动重放,避免重复业务写入。

**key 换令牌二段式(exchange,可选)**:有些服务的 API key 不直接当请求凭证,要先
POST 一个交换端点换临时令牌(令牌才进 Authorization)。在凭证上声明 `exchange`
(字段见 §2),主机就照单代办整个流程:换取 → 按 ttlSeconds 缓存 → `inject.format`
的 {value} 注入**换来的令牌**而非原始 key → 上游 401 时自动作废缓存重换重试一次。
你的代码完全无感——照常 cindy.fetch 就行,key 和令牌都不进沙箱。注意:交换端点
域名必须命中 hosts 白名单;交换端点返回重定向会被阻断;tokenPath 只支持点分对象
路径(不支持数组下标);交换失败(端点非 2xx / 响应缺令牌字段)时 cindy.fetch 返回
结构化错误,message 带状态码与摘录,原样转告用户即可。

**主机托管 OAuth 授权(source:"oauth",可选)**:对接 Google / Atlassian 这类
"标准 OAuth 授权、令牌会过期要刷新"的服务时用。你在凭证上声明 `"source": "oauth"`
+ `oauth` 详单(字段见 §2:去哪授权、要什么 scopes、服务商特有参数),整个授权
流程由主机可信代码执行:拉系统浏览器、本机回调、code 换 token、到期刷新、
refresh token 保管——**你的代码全程无感也无从插手**,照常 cindy.fetch,主机出网时
现取新鲜 access token 按 `inject.format` 注入(上游 401 自动作废重刷、整链重试
一次)。client 凭证(clientId / clientSecret)两种给法:**内置在 oauth 详单里**
(用户零配置,点连接就走——桌面应用的 client 凭证按服务商官方口径本非机密,
写进包里不引入泄露面;授权仍需用户在浏览器亲自同意),或**留空让用户在你的
settingsHtml 里自填**(用户用自己注册的 OAuth 应用,配额风控归用户)。两者可
并存:用户自填的**覆盖**内置值(成对生效),清除自填即回落内置。注意换 client
后旧账号的令牌刷不动(令牌与 client 绑定),会自动标过期引导重连,设置页文案
要如实提示。settingsHtml 里经 `/oauth` 协议通道完成收单与连接:

```js
// 状态回查(哪些 oauth 凭证项、client 配没配、连了哪些账号;零令牌字节):
const list = await (await fetch('/oauth')).json();
// → [{ key:'acct', clientConfigured:true, clientCustom:false, accounts:[{ id, label, status:'connected'|'expired', isDefault, createdAt, avatarDataUrl, scopeStale }] }]
// avatarDataUrl = 头像 data URL(声明了 identity.avatarPath 且主机下载成功才有,否则 null;<img src> 直接用)
// scopeStale = true 表示该账号有真实权限错误证据,或其全量授权快照未包含插件后来新增的 scope;账号仍可用,设置页应显示非阻塞提示并复用现有重新连接动作
// clientConfigured = 自填或内置任一在场;clientCustom = 用户自填过(UI 显示"内置应用身份/已自定义")
// client 凭证只写入库(和 /secrets 同纪律,存入后拿不回;clientSecret 可省略 = 纯 PKCE):
await fetch('/oauth/acct/client', { method:'PUT', body: JSON.stringify({ clientId, clientSecret }) });  // 204 即入库
// 「连接账号」按钮 → 主机拉浏览器跑授权(等待时间可能数分钟,给用户 loading 提示):
const connectInit = { method:'POST' };
// broker 模式可选:必须等于 oauth.clientId 或 clientIdAlternatives 中一项;
// 典型用法是先读 /app-context,由插件按 region 选择公开 App ID。
if (selectedClientId) connectInit.body = JSON.stringify({ clientId: selectedClientId });
const r = await (await fetch('/oauth/acct/connect', connectInit)).json();
// → { ok:true, account } 或 { ok:false, error: 'NO_CLIENT_CONFIG'|'ACCOUNT_LIMIT'|'VAULT_WRITE_FAILED'|'INVALID_CONFIG'|'LISTEN_FAILED'|'TIMEOUT'|'CANCELLED'|'CALLBACK_INVALID'|'EXCHANGE_FAILED'|'SERVICE_UNAVAILABLE'|'NETWORK', detail? }
// NETWORK = 客户端无法连接授权服务,提示用户检查网络后重试;
// SERVICE_UNAVAILABLE = broker 路由缺失或服务端 5xx,提示用户稍后重试。
// 授权成功时主机会自动弹「授权成功,已连接 xxx」的系统提示(带你的身份头,
// 无需声明 notify);设置页只管刷新自己的账号列表。
// 断开账号 / 设默认账号:
await fetch('/oauth/acct/accounts/<accountId>', { method:'DELETE' });          // 204(幂等)
await fetch('/oauth/acct/default', { method:'POST', body: JSON.stringify({ accountId }) });  // 204
// 真实 API 返回缺失 scope 时可 fire-and-forget 上报；只接受清单 oauth.scopes 内的值,
// 任一越界整包 400 拒绝。主机会据此在对话流与详情页非阻塞引导用户重新连接。
// 证据只记默认账号:带 authAccount 指定非默认账号的调用报错时不要上报,
// 否则会引导用户重连错账号:
await fetch('/oauth/acct/insufficient-scopes', { method:'POST', body: JSON.stringify({ scopes:['write.b'] }) });  // 204
```

昵称等自定义账号元数据由插件通过 `/kv` 保存(§4.8)，按账号 id 与上述清单合并；
Host OAuth 不提供昵称字段或重命名接口。昵称只供展示和匹配用户意图，存在歧义时询问，
执行仍传账号 id，不把昵称当作指令或授权。

多账号:每个 oauth 凭证项最多 8 个账号;cindy.fetch 可带 `authAccount: '<账号id>'`
指定用哪个账号的令牌(缺省 = 默认账号)。同一身份重复授权 = 重连:授权回来的
身份标签(identity.labelPath 的值)与已连账号相同时,主机覆盖那条的令牌并复活状态,不新增
占位——账号 id 稳定,你缓存的 authAccount 不会因用户重连而失效。声明了
identity.displayTemplate 时,`/oauth` 回查与连接结果里 account.label 给的是
渲染后的展示名(合并判定仍按 labelPath 的稳定值,展示名变了不会堆出新账号行)。规则:authorizeUrl / tokenUrl / identity.url
的域名都必须命中 hosts 白名单(插件详情会展示"将引导你在 <授权域名> 完成授权"
+ scopes 全量清单,用户知情放行);oauth 与 exchange 互斥;声明 oauth 凭证必须同时
声明 settingsHtml(没人收 client 凭证就没人能连接)。账号授权失效(AUTH_EXPIRED)
时 cindy.fetch 返回带指引的结构化错误,原样转告用户去设置页重新连接即可。

两个可选的授权细节字段(见 §2 样例):
- `redirectPort`:回调固定端口。服务商要求回调 URI 与其后台注册值**精确匹配**
  (含端口,如 Atlassian)时声明,主机回调恒为 `http://127.0.0.1:<端口>/callback`;
  端口被占用时连接返回 LISTEN_FAILED(detail 带人话提示,settingsHtml 原样展示
  即可;第一方官方内置插件会先自动结束占用进程并重试,第三方插件不享受此回收
  ——请选一个不易撞车的端口)。声明 `tokenBroker` 时必须提供；非 broker 模式下，
  Google 这类允许任意 loopback 端口的服务商不用声明。
- `tokenBroker`:资格有三路:①随包官方种子或受信任公开市场的官方插件,名称本身不构成资格；②当前组织的服务端
  organization market 包已安装、source 为 `market`、organizationId 与当前组织一致,
  namespace 与当前组织的可信身份一致，且 release sha256 与批准 receipt 的 packageSha256 相等。
  ③企业作者通过 `ghost_forge_install` 明确安装，Host 绑定当前组织 namespace；只有真实
  存量待迁移安装仍使用本组织已登记前缀核对。是否已有同 id 市场记录不影响这条自测路径。
  后两路不接受个人身份或别的组织身份；Forge 只给 Broker 与 oidc-token，不给宿主原语，
  可信 XD 企业市场安装的宿主能力另按可信组织身份核验，不依赖名称前缀。手动导入不属于 Forge 路径。
  code/refresh 交换改经 Cindy 服务端 broker 完成,client secret 由服务端持有、不随包
  分发,且要求用户已登录 Cindy。声明它时必须同时声明 redirectPort,并与 clientSecret
  互斥;PKCE 缺省开(verifier
  经 broker exchange 透传服务端),不吃 PKCE 的服务商显式 `"pkce": false`;
  设置页的 `/oauth/<key>/client` 自填通道返回 405(settingsHtml 不要再画
  client 输入区)。
  `"tokenBroker": "feishu"` 的企业应用由服务端按企业配置:主机每次连接开始时向服务端
  取企业当前的 App ID 与一次性授权事务,不用清单里的 `clientId`(可省略;旧版主机
  仍按清单 `clientId` 连接)。
- `brokerBounce`:双地址弹跳回调(随 tokenBroker,资格与 tokenBroker 相同)。部分
  服务商后台只收 https redirect、不收 http loopback——声明后报给服务商的
  redirect_uri 是「broker 服务的 https 弹跳路由」(主机用 broker 基地址 + `path`
  运行时拼出),浏览器授权后弹跳路由 302 回本机
  `http://127.0.0.1:<redirectPort><callbackPath>`。必须与 tokenBroker、
  redirectPort 同时声明(302 目标端口/路径在 broker 服务端写死,三者一套约定)。

连接时还可以降面授权:`POST /oauth/<key>/connect` 支持可选 body
`{"scopes":[...]}`——本次授权只申请清单 scopes 的**非空子集**(如"只读连接"
按钮只带读 scope);越界或不在清单里的条目 400。不带 body = 申请全量声明面。

**媒体上传(upload,媒体模式的镜像)**:要把媒体文件传给你的服务(改图源图、
参考图等),在 fetch 请求里报总仓指纹,主机验归属、读字节、代组 multipart——
字节同样不进你的沙箱:

```js
const r = await cindy.fetch({
  url: 'https://api.example.com/v1/file/',
  method: 'POST',                                   // upload 仅 POST;与 body 互斥;与 as:'media' 互斥
  upload: { hashes: ['<64位指纹>'], field: 'file' }, // 1–4 条;field 缺省 'file'
  // 可选 fields ≤8 条:随行普通表单字段,在文件段之前;值里的字面量 "{bytes}"
  // 由主机替换成全部上传文件的总字节数(要求 size 字段的服务用):
  // upload: { hashes: [...], field: 'file', fields: { parent_type: 'docx_image', size: '{bytes}' } }
  callId: msg.callId,
});
// 响应按文本形态返回(服务端的入库回执 JSON 你自己解析)。
```

只能上传**自己名下**的总仓媒体:出生自你(cindy 代办产物 / as:'media' 取件)、
挂你画廊、或用户随消息把图交给你(附件过户,指纹在 args.attachments)。别人的
指纹统一"不存在或不属于本插件"。Content-Type(boundary)由主机独占,你写了也
会被覆盖;单文件 ≤64MB、单次总量 ≤128MB,超限整单拒。

**目录上传(uploadDir,目录过户票据)**:要把用户的一个本地目录整体传给你的
服务(静态站点部署等),流程是"主 agent 过户 → 你凭票上传"——主 agent 调
ghost_call 时把目录**绝对路径**放在顶层 `dir` 参数(会话工作目录内直接放行,
工作目录外若主 agent 是本地 Full Access 会话则自动过户、不弹卡;Auto 交当前会话统一审阅,
Ask 及远程会话仍由用户确认;自动排除 node_modules/.git/.env 等),主机收集文件后把一次性限时票据注入你的
`args.dir_deposit`(含 token / file_count / total_bytes / rel_paths 相对路径清单);
你在工具描述里写清"目录经 ghost_call 顶层 dir 交付",然后:

```js
const r = await cindy.fetch({
  url: 'https://api.example.com/deploy',
  method: 'POST',                                   // uploadDir 仅 POST;与 body / upload / as:'media' 互斥
  uploadDir: {
    token: args.dir_deposit.token,                  // 一次性票据:用一次即废,失败重试要主 agent 重新过户
    fields: { name: 'my-site' },                    // 可选 ≤8 条:随行普通表单字段(值里的 "{bytes}" 由主机替换成文件总字节数)
    fileFieldPrefix: 'file-',                       // 可选:文件字段名前缀(第 N 个文件字段名 file-N,filename=相对路径)
    // fileField: 'file',                           // 可选(与 fileFieldPrefix 互斥):单文件精确字段名——票据必须恰含
    //                                              // 1 个文件,filename 只取文件名;"字段名钉死 file"的服务(飞书传文件)用
  },
  callId: msg.callId,
});
```

你从头到尾拿不到绝对路径与文件字节(rel_paths 只是相对路径清单,可用来做
preset 判定等纯逻辑);伪造/过期/别人的票据统一"票据无效"。单目录 ≤500 个
文件、单文件 ≤50MB、总量 ≤500MB,超限在过户期就拒。`dir` 也接受**单个
文件**的绝对路径(传附件等场景):按单文件票据处理,rel_paths 就一条文件名。

**文件下载落盘(as:'file' + save 票据,uploadDir 的镜像)**:要把下载的文件
(邮件附件、云盘文档等任意类型)存到用户本地时,流程同样是"主 agent 过户 →
你凭票下载"——主 agent 调 ghost_call 时把**目标目录绝对路径**放在顶层
`save_dir` 参数(目录必须已存在;会话工作目录内直接放行,工作目录外主机会
在本地 Full Access 下自动过户、不弹卡;Auto 交当前会话统一审阅,Ask 及远程会话仍弹确认卡),主机把限时
票据注入你的 `args.save_deposit`(含 token / dir_name 目录名);你在工具
描述里写清"下载目录经 ghost_call 顶层 save_dir 交付",然后:

```js
const r = await cindy.fetch({
  url: 'https://api.example.com/files/123/download',
  as: 'file',                                       // 任意类型字节直接落盘,不进你的沙箱也不进媒体总仓
  saveTo: {
    token: args.save_deposit.token,                 // 限时票据(10 分钟内最多写 16 个文件 / 共 512MB)
    filename: 'report.docx',                        // 可选建议名;缺省从 Content-Disposition / URL 派生
  },
  callId: msg.callId,
});
// 成功:{ ok:true, status, headers, file: { file_name, bytes, mime_type } }
//   file_name 是主机消毒去重后的最终文件名(不覆盖已有文件),交卷时拼
//   args.save_deposit.dir_name 告诉用户"已存到 <目录名>/<文件名>"。
// 非 2xx 自动回落文本形态(错误 JSON 你看得到);单文件上限 256MB 超限整单拒。
```

文件名由主机消毒(只留文件名本体、剥路径与控制字符),你从头到尾拿不到
绝对路径与文件字节;伪造/过期/写满的票据统一"票据无效"。

**多连接(connections,可选)**:对接**自建实例**类服务(GitLab 私服、自托管
API 等"每个用户地址都不一样"的场景)时用——静态 hosts 白名单写不出用户的
域名,改声明"连接类型",地址与凭证由用户在你的 settingsHtml 里**成对多条**
添加。声明形态见 §2 样例(`network.connections`,0–2 条声明;每条 1–64 字
label + inject 注入形态 + 可选 maxConnections);声明了 connections 时 hosts
可缺省(静态域名与动态连接至少有其一),声明 connections 必须同时声明
settingsHtml。语义要点:

- **动态白名单**:用户添加的每条地址并入本插件的放行域(精确匹配裸域,
  不吃通配;https + 默认端口限制照旧)。**每次新增地址,主机都会弹一个
  受信确认弹窗**(系统模态,不是你的页面)向用户摊牌"该插件请求添加连接
  地址 xxx"——用户拒绝则添加失败(CONFIRM_DENIED),你的设置页如实提示即可;
  同一地址更新 token/label 不再弹(放行面没变)。
- **凭证只注入对应地址**:每条连接的 token 只会注入到那条连接自己的域名
  请求(按声明的 inject.header/format);跳转到另一个连接地址时注入的是
  那个地址自己的 token。inject 不允许声明 hosts(校验拒装)。
- **cindy.fetch 无新参数**:照常发请求即可,URL 命中哪个连接就注入哪个
  连接的凭证;地址没添加过 → 结构化"白名单外"错误(message 带"去设置页
  添加连接"指引),token 缺失 → 结构化"凭证未配置"错误,原样转告用户。

settingsHtml 里经 `/connections` 协议通道完成收单(token 只写不读,与
/secrets 同纪律;tail = 主机截存的尾 4 位指纹,仅够用户回忆):

```js
// 状态回查(每条声明:上限 + 已添加的连接;零 token 字节):
const list = await (await fetch('/connections')).json();
// → [{ key:'gitlab', label:'GitLab 实例', maxConnections:4,
//      connections:[{ id, host:'gitlab.example.com', label, isDefault, tail }] }]
// 添加/更新一条连接(host = 小写裸域;新地址会触发主机受信确认弹窗,给用户等待提示):
const r = await (await fetch('/connections/gitlab', {
  method: 'POST',
  body: JSON.stringify({ host: 'gitlab.example.com', token: 'glpat-xxx', label: '公司主库' }),
})).json();
// → { ok:true, connection } 或 { ok:false, error:
//    'INVALID_HOST'|'INVALID_TOKEN'|'CONFIRM_DENIED'|'LIMIT'|'VAULT_WRITE_FAILED' }
// 同 host 再 POST = 更新语义:只换 token/label,连接 id 稳定不变。
// 删除 / 设默认连接:
await fetch('/connections/gitlab/<connectionId>', { method: 'DELETE' });      // 204(幂等)
await fetch('/connections/gitlab/default', { method: 'POST', body: JSON.stringify({ connectionId }) });  // 204
```

上限:connections 声明 ≤2 条;每条声明下用户可添加 ≤8 条连接(作者可用
maxConnections 收紧到 1–8);token ≤4096 字符。新连接添加成功时主机会自动
弹「连接地址已添加」的系统提示(带你的身份头,无需声明 notify)。

其它硬边界:每个插件同时在途 4 个请求;媒体取件/上传共用全局串行闸,同时只
处理一单(忙时返回结构化"正忙",稍后重试即可);重定向最多 3 跳且逐跳重验
白名单;不支持流式/WebSocket。长任务用"提交 + 轮询"两个工具拆开做;在一次
tool-call 内轮询时记得定期发 tool-progress 心跳续命(见 §4"长任务续命")。

### Library 下载与上传

下载到本插件 Library 用 as:'library' 和库内 path；上传用 upload.library 相对路径数组。
两者需要 library:true，域名和凭证按本章声明；检查 ok、HTTP status 和 truncated。

```js
const downloaded = await cindy.fetch({
  url: 'https://api.example.com/report', as: 'library', path: 'downloads/report.pdf',
  callId: msg.callId
});
const uploaded = await cindy.fetch({
  url: 'https://api.example.com/upload', method: 'POST',
  upload: { library: ['exports/result.pdf'], field: 'file' }, callId: msg.callId
});
```

下载成功时从 downloaded.library 取 path、bytes、sha256 和 ref，失败不提供半个文件。
upload.library 与 upload.hashes 二选一，最多 4 个文件，单件 64 MiB、总量 128 MiB。
对话交接的副本用 `upload.handoff:['handoff:<uuid>']`，与两者三选一，见 4.10.3。
超限返回 TOO_LARGE；下载到 Library 单件上限 8 GiB，仍受磁盘空间约束。
401 时的令牌重试按本章各凭证规则（exchange / OAuth 对写请求也会重试一次）；插件代码不要再自行重试
有副作用的调用，后端仍按请求编号去重。页面调用及文件预览见[§4.23](plugin-interactive-pages.md)。

### MCP Apps 页面生成手册头

主机给 `cindy.fetch` 自动加 `Cindy-MCP-Apps-Manual`（手册 CDN 地址，
`mcp-apps/manual/<客户端版本号>/<sha256>.md`）与 `Cindy-MCP-Apps-Manual-Sha256`，供后端生成页面的模型使用。
缺省仅当 `callId` 对应工具在 `mcpApps.ui.tools` 中对模型可见（`visibility` 含 `"model"` 或省略）时带；
`mcpAppsManual: true` 强制带（如 `load_view` 要片段），`false` 不带。只发往已声明主机，跳到其它主机即删；
自带的同名头被剥除。开发版（0.0.0）、Node 工作进程与旧版 Cindy 不带：后端缺头时用缓存手册，按 sha256 缓存与校验。
