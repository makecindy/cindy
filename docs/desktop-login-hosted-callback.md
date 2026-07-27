# Desktop 登录托管回调（跨仓契约）

> **状态**：两端均已实现，等待端点清单开启
> **读取时机**：改动 auth-server 侧托管回调路由、结果展示页模板，或调整 desktop
> 系统浏览器登录链路之前

本文是客户端仓与 auth-server 仓之间的接口契约，描述**已实现**的形态。

- 客户端：本仓，默认走旧的 loopback 链路（端点清单 `authDesktopCallbackUrl` 为空）
- 服务端：`xindong/cindy-server` 的 `auth-server`

两端合入后行为不变，填上端点清单字段才切换。

## 1. 要解决的问题

Desktop 今天走 RFC 8252 loopback 登录：本机起随机端口 HTTP server，把
`http://127.0.0.1:<port>/auth/callback` 作为 `redirect_uri`。用户因此会看到两处裸 IP：

1. 浏览器地址栏 `127.0.0.1:52871/auth/callback?code=...`——**授权码同时暴露在地址栏
   和浏览历史里**；
2. 点「回到 Cindy」唤起 `cindy://focus/desktop-login` 时，系统弹框写着
   「http://127.0.0.1:52871 想打开此应用」——这里的来源就是回调页自己的 origin。

托管回调把 `redirect_uri` 换成 auth-server 自有域名下的固定地址，浏览器全程停在
自有域名上，授权码不再进入地址栏与浏览历史。

### 为什么不是「回调页 fetch 投递回本地端口」

一个自然的想法是：回调页留在自有域名，用 `fetch('http://127.0.0.1:PORT/...')` 把授权码
静默投递回本地 loopback server。**这条路在 Safari 上必然失效**——WebKit 至今不把
loopback 视为 potentially trustworthy origin（[WebKit #171934](https://bugs.webkit.org/show_bug.cgi?id=171934)
长期未修），https 页面 fetch `http://127.0.0.1` 被当作 mixed content 拦掉。Chrome /
Firefox 早已按规范放行，只有 Safari 没跟，而 Safari 是 macOS 默认浏览器。

所以方向翻转成**客户端主动轮询取回**：不需要本地端口、不需要 CORS、不受浏览器差异
影响。

## 2. 目标链路

```
① 客户端生成 codeVerifier(PKCE) 与 pollSecret(256 bit 随机，仅存在于进程内存)，
   client_state = base64url(sha256(pollSecret)) —— 只有哈希值会经过浏览器
② 打开系统浏览器 → GET <auth>/api/auth/social/<provider>/authorize
     ?redirect_uri=<托管回调地址>&code_challenge=...&client_state=...&ui_locale=...
③ 用户在 provider 处授权，provider 回调到 auth-server 既有的 provider 回调路由
④ auth-server 照常签发一次性授权码，302 到 redirect_uri —— 也就是托管回调路由
⑤ 托管回调按 client_state 把授权码寄存进 Redis，302 到结果展示页（URL 不含 code）
⑥ 客户端自②起持续轮询 poll 接口，取到 code 后照常 POST /api/auth/token 完成 PKCE 兑换
⑦ 用户在展示页点「回到 Cindy」→ cindy://focus/desktop-login
```

关键点：`redirect_uri` 是「auth-server 完事后往哪跳」，**不是 provider 的回调地址**。
provider 回调路由（`googleCallbackUrl()` 等）与 `callbackShared.ts` 的收尾逻辑一行未改，
托管回调只是多了一个接住自己回跳的新路由。`redirect_uri` 与 `client_state` 参数客户端
本来就在传（`buildAuthorizeUrl`），authorize 接口也不需要改。

## 3. 服务端实现

对应实现在 `auth-server/src/services/desktopCallback.ts` 与
`auth-server/src/routes/desktopCallback.ts`。

### 3.1 redirect_uri 放行

**不需要新增环境变量、不需要运维配 `REDIRECT_URI_ALLOWLIST`。**
`isAllowedRedirectUri`（`src/services/sso/transaction.ts`）比照既有的
`${publicBaseUrl}/console/callback` 先例，对 `${publicBaseUrl}/api/auth/desktop/callback`
同源恒放行。地址由 `publicBaseUrl` 派生而非取自请求，配错或被构造都不可能命中。

判定抽成了纯函数 `isDesktopHostedCallbackUri(uri, publicBaseUrl)` 并单独测。
**这一步不是形式主义**：测试环境的 `PUBLIC_BASE_URL` 是 `http://localhost:3344`，
任何以它为前缀的地址都会先命中 RFC 8252 的 loopback 例外，所以哪怕把同源放行整条删掉，
集成测试也照样全绿（已用变异验证确认）。生产是 https 域名，只有这条规则能放行它。

### 3.2 `GET /api/auth/desktop/callback`

接住 auth-server 自己 302 过来的回跳（`?code=…&state=<clientState>` 或 `?error=…`）：

- 按 `clientState` 把结果寄存进 Redis（key `deskcb:<clientState>`，TTL 5 分钟）；
- 302 到 `/desktop/login-callback?status=ok|error[&detail=<错误码>]`，**URL 不带 code**；
- 既无 `code` 也无 `error` 时寄存 `INVALID_AUTH_CODE`——什么都不寄存的话，客户端只能
  一路轮询到 5 分钟预算耗尽；
- `state` 缺失或超长直接 400，不写任何寄存。

### 3.3 `POST /api/auth/desktop/callback/poll`

请求体：

```jsonc
{ "pollSecret": "<只在客户端进程内的取回凭据>", "deviceId": "<设备 id>" }
```

**取回凭据是 `pollSecret`,不是 `client_state`。** 两者的关系是
`client_state = base64url(sha256(pollSecret))`:走浏览器的只有哈希值。若直接拿
`client_state` 取回,任何能读到浏览器导航历史的扩展或同机进程都能抢先调用这个未鉴权接口
把一次性结果消费掉——授权码本身受 PKCE 保护换不到 token,但真实客户端会拿到 `expired`,
登录被打断。两端推导算法必须逐字节一致(客户端
`apps/desktop/src/main/authHostedCallback.ts`,服务端 `services/desktopCallback.ts`)。

响应体（HTTP 200）：

```jsonc
{ "status": "pending" }                       // 尚未完成，客户端继续轮询
{ "status": "ok", "code": "<授权码>" }          // 同一 pollSecret 可重复取到（见下）
{ "status": "error", "error": "<错误码>" }     // provider / 服务端侧失败
{ "status": "expired" }                       // 暂存已过 TTL 或已被取走
```

**关键约束：未知 `pollSecret` 必须返回 `pending`，不能返回 `expired` 或 4xx。**
客户端从打开浏览器的那一刻就开始轮询，此时用户还没授权完，服务端多半还没有这条记录；
这时若返回终态，第一次轮询就会把登录判死。

**读取是幂等的，不做 GETDEL。** 服务端已删、响应却在网络上丢了的情形必须可恢复——
否则用户明明在浏览器里授权完成，却因为一次丢包被要求重新登录。同一个 `pollSecret`
在授权码存活期内可以重复取到同一个 code；真正的一次性发生在 `/api/auth/token`
（authCode 侧的 GETDEL），所以重复取回不会让授权码被用两次。

`expired` 只用于一种情形：授权码已过它自己的 60s TTL（寄存记录带 `codeExpiresAt`，见 §4）。

其它约定：

- 非 2xx 响应按现有错误格式返回（`{ "error": { "code", "message" } }` 或
  `{ "code", "message" }`），客户端会把 `code` 直接用作可展示的错误码；
- **限流按 IP**（`rateLimitPerIp`，60s / 300 次），不按 `pollSecret`：后者是请求体里的
  客户端可控值，仓库规则明确禁止参与限流 key。阈值放宽是因为客户端每秒轮询、单次登录
  最多 5 分钟，还要容得下同一出口 IP 后的多个用户；防爆破由 `pollSecret` 的随机量承担；
- `deviceId` 客户端会带上，但服务端**不校验**：托管回调那一步只拿得到 code 与 state
  （登录事务在 provider 回调阶段已消费），服务端无从取得同一次尝试的 deviceId 来比对。
  保留字段只为兼容客户端现有请求体，不构成授权判断；
- 客户端单次请求超时 30s，**允许长轮询**（hold 住请求直到有结果或 ~20s 返回
  `pending`）。当前实现是短轮询：客户端间隔 1s，30s 后退避到 2s。

### 3.4 结果展示页

页面模板由客户端仓导出，**不要在服务端手写一份**：

```bash
pnpm --filter desktop run export:login-callback-template
# → apps/desktop/dist/login-callback-template/{zh,en,ja,ko}/{success,error}.html + manifest.json
```

产物原样放进 `auth-server/assets/login-callback/`（已标 `linguist-generated`，GitHub 折叠 diff）。

- 每份 HTML 自带 light / dark（`prefers-color-scheme`），不按主题拆分；
- 失败页含 `{{ERROR_DETAIL}}` 一个占位符，替换错误码前按 HTML 文本节点转义；无错误码
  时连同它所在的 `<p class="detail">` 一并删除；
- 页面自包含（立绘是构建期内嵌的 webp data URI），无外链依赖；
- 客户端改文案后需重新导出同步，**不要在服务端侧手改 HTML**。

**语言跟随浏览器的 `Accept-Language`，而不是 app 的 UI 语言。** app 语言在 authorize
时以 `ui_locale` 传入并冻结进登录事务，但事务在 provider 回调阶段就被消费掉了，到托管
回调这一步已经拿不到；要把它带过来就得改 `callbackShared.ts` 的 302 参数，那会动到
loopback 与 mobile 共用的回调路径。两者不一致（如 app 设日语、浏览器为中文）只影响这张
结果页的文案，不影响登录本身，故选择不动共用路径。缺省回落 `en`。

**CSP 与内联脚本**：模板里有一段**布局必需**的内联脚本（整卡等比缩放 + 水平居中）。
CSP 用 `script-src 'sha256-…'` 精确放行它，而不是放 `'unsafe-inline'`。

**hash 由导出方算好写进 `manifest.json` 的 `pages[].scriptHashes`，服务端直接读取拼进
CSP，不解析 HTML。** 边界由拼出 HTML 的那一方掌握最可靠；早先服务端用正则去抠 script
标签，既容易与浏览器真实的 HTML 解析行为出入（结束标签的空白与垃圾属性等变体），也会被
CodeQL 的 `js/bad-tag-filter` 判为不完整的标签过滤。

这条不是可选项：更早的版本用 `default-src 'none'` 把脚本一并禁掉，结果卡片贴左不缩放、
窄窗口会把 CTA 裁出视口——**HTTP 层完全看不出异常，只有真的截图才发现**。模板里另有
`<img onerror>` 内联事件（hash 模式管不到），有意继续拦截：立绘是 data URI 不会加载失败，
那段降级本就是冗余保险。

## 4. 安全说明（供评审）

- **服务端暂存授权码不构成新增信任面**：这个 code 本来就由 auth-server 自己签发、
  自己持有，短期暂存自己签发的凭据没有引入新的信任方。
- **PKCE 仍是兑换的唯一凭证**：`code_verifier` 只存在于 Desktop main 进程内存中，
  从不出网。单独拿到 code 换不到 token。
- **相比现状更安全**：授权码不再出现在浏览器地址栏与浏览历史里。
- **取回凭据与浏览器可见值分离**：托管链路用 `pollSecret`（256 bit 随机）作取回凭据，
  只把 `base64url(sha256(pollSecret))` 当作 `client_state` 交给 authorize。浏览器地址栏与
  导航历史里只有哈希值，读得到历史也无法抢先消费掉一次性结果。loopback 链路的 `state`
  生成方式未改（仍是 `randomUUID()`），存量路径行为不变。服务端侧请勿把 `pollSecret`
  写进可被检索的日志。
- **不会交出注定失败的授权码**：授权码自身 TTL 60s，且从跳转到托管回调**之前**就开始
  计时。寄存记录活得更久（5 分钟）是为了在码过期后返回终态 `expired`，让用户立刻看到
  「授权已过期，请重新登录」，而不是拿一个在 `/api/auth/token` 必然撞 `INVALID_AUTH_CODE`
  的码。
- **仍然只有一条 wire 变化面**：token 兑换、账号选择、SSO 等其余链路完全未动。

## 5. 上线与回滚

开关是端点清单字段 `authDesktopCallbackUrl`（`config/endpoint.json` /
`config/endpoint.global.json`，人肉上传各自 region 的 CDN）：

- **空串或缺失** → 客户端走 RFC 8252 loopback，行为与今天完全一致（当前即此状态）；
- **填入托管回调地址** → 客户端走本文链路。

清单在应用启动第一步解析，改动**重启客户端后生效**。服务端侧出任何问题，把该字段清空
即可回退到 loopback，**客户端不需要发版**。

## 6. 验收状态

合入前已完成（本地全栈：临时 PostgreSQL 5433 + Redis 6380 + auth-server 3344）：

- [x] 服务端全链路集成测试：authorize → mock IdP → provider 回调 → 托管寄存 → poll →
      `/api/auth/token` 兑换成功（`desktopHostedCallback.test.ts`）
- [x] **两端 wire 对齐**：用客户端真实的 `CindyAuthClient` 打本地 auth-server，覆盖
      pending / ok / 一次性 / error / AbortSignal 取消
- [x] 结果页 URL 不含授权码（curl 与集成测试双重确认）
- [x] 未知 `clientState` 返回 `pending`
- [x] 展示页 light / dark 双模式目检（`docs/design-rules/DESIGN.md` 双模式交付门槛）
- [x] 内联布局脚本在真实浏览器中执行、卡片正确居中缩放（CSP hash 生效）
- [x] `detail` HTML 转义，不能注入标签

部署后仍需人工确认：

- [ ] Safari 与 Chrome 各跑一次**真实 provider** 登录：地址栏全程
      `https://auth.<域名>/...`，唤起弹框显示的是域名而非 IP
- [ ] 四种语言各看一次（zh / en / ja / ko）
- [ ] 用户中途关闭浏览器：客户端 5 分钟后按取消收场，不报错
- [ ] 清空清单字段后回退 loopback 仍正常
