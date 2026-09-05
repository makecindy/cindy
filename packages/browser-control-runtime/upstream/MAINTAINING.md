# 浏览器自动化 — 维护者指南

> **这是改动浏览器自动化功能前的唯一必读文档。** 它串起三层代码、记录所有踩过的坑与不变量、说明如何跟随上游更新。
> 以源码实现为准:本文与代码冲突时信代码,但请在同一改动里同步修正本文。

## 1. 这是什么

给 agent(Claude Code / Codex)用的浏览器自动化能力,对外是 `cindy_browser` MCP 工具。核心运行时是**vendored 上游(代号见 `sync.mjs`)的浏览器内核**——不是重写,以便跟随上游更新。产品可见的任何地方都**不出现上游名 / 🦞**(见 §6)。

默认行为:启动**一个专属、持久、headed 的自动化浏览器**(profile 名 "Cindy"),登录态长期保留,与用户日常 Chrome 互不影响。

用户可在设置 → 自动操作打开「使用我的浏览器登录态」(默认关)。打开后,host 在 `start` 前把系统 Chrome / Edge / Brave **当前 `profile.last_used`** 的 Cookies / Login Data 等 SQLite 库拷进 `browser-runtime/browser/Cindy-real/user-data/Default`(vendored `--user-data-dir` 是 `…/Cindy-real/user-data`),并把 dest `Local State` 的 `last_used` / `last_active_profiles` / `profiles_order` **改写成 Default**(原样拷贝会让 Chrome 打开空的 `Profile N`,窗口看起来已登出)。Chrome 右上角 chip **始终显示 `Cindy`**:磁盘目录必须叫 `Cindy-real`(不能叠到隔离身份 `Cindy` 上),host 通过 `displayName: "Cindy"` 传给 runtime,`launchOpenClawChrome` 用它 decorate,而不是用 map key。再用**同一只浏览器二进制**启动该目录。不 attach 日常 Chrome(Chrome 136+ 会拒绝调试默认 user-data-dir)。关掉开关即删除 `Cindy-real`,`Cindy` 隔离身份不动。失败必须 fail-closed,禁止启动一个看起来在浏览、其实全是登出的窗口。快照当凭证:不要写进日志正文、backup、device-link 或 worktree;`status` 只暴露 `{ enabled, applied, source }`,不暴露路径。快照实现在 `apps/desktop/src/main/mcp-integrations/browser-real-profile/`;chip 名例外见 `sync.mjs` 对 `chrome.ts` 的 LOCAL_PATCH。

## 2. 三层架构 + 文件清单

```
agent 调 browser 工具
  │  Claude Code: 进程内 SDK MCP server 直连
  │  Codex(本地): codex HTTP bridge → 同一个进程内 server   ← 远端 Codex 拿不到, 见 §7
  ▼
[Layer 2] cindy_browser MCP 面   packages/lizi-mcps/src/browser/
  │  createBrowserMcpServer(deps).deps.getRuntime()
  ▼
[Layer 3] desktop host          apps/desktop/src/main/mcp-integrations/browser.ts
  │  ExternalChromeBackend 串行化 start/stop + 每次 launch 的不可变 route config
  ▼
[Layer 1] vendored runtime      packages/browser-control-runtime/
  │  runtime.call(request) → _generated/ 里的 vendored dispatcher
  ▼
playwright-core → 托管 Chrome(Cindy profile, 持久 user-data-dir)
```

| 层 | 路径 | 职责 / 关键文件 |
|---|---|---|
| **L1 vendored runtime** | `packages/browser-control-runtime/` | `src/types.ts`(中性契约 `BrowserControlRuntime` / `BrowserRuntimeConfig` / Request / Result)、`src/runtime.ts`(`createBrowserControlRuntime` 把 vendored dispatcher 包到契约后面)、`src/unavailable.ts`(未配置时的安全 stub)、`src/shim/**`(手写替换上游 plugin-sdk 面,见 `shim-spec.md`)、`_generated/**`(**生成物,禁止手改**) |
| **L2 MCP 面** | `packages/lizi-mcps/src/browser/` | `tools.ts`(唯一一个 `browser` 工具,17 个 action,`rules:['browser-workflow']`)、`server.ts`(`list_tools`/`call_tool` + 把 rules 打进响应)、`tool-registry.ts`、`index.ts`(`createBrowserMcpServer`)、`prompts/rules/browser-workflow.md`(**喂给 agent 的用法规则**)。在 `packages/lizi-mcps/src/providers.ts` 注册成 `cindy_browser` provider |
| **L3 desktop host** | `apps/desktop/src/main/mcp-integrations/` | `browser-runtime-env.ts`(**import 前置副作用**,见坑 #2)、`browser-managed-config.ts`(托管 config)、`browser.ts`(runtime 单例 + `getBrowserMcpDeps`/`getBrowserAvailability`/`openBrowserForLogin`)、`browser-availability.ts`(status → UI 数据)。IPC:`maker-ipc/{channels,register}.ts` 的 `BROWSER_STATUS` + `BROWSER_OPEN_FOR_LOGIN`。UI:`renderer/components/settings/ComputerUseSection.tsx`(设置 →「自动操作」)+ 4 语言 i18n。开关 gate:`maker-host/plugins/plugin-registry.ts`(plugin id `browser`) |

## 3. 配置流(以及那个静默 bug)

host 在 `browser-managed-config.ts` 用 `buildManagedConfig({proxyServer?})` 造出 `{ browser: { enabled, defaultProfile:'Cindy', headless:false, extraArgs?, ssrfPolicy:{ allowRfc2544BenchmarkRange:true, allowIpv6UniqueLocalRange:true }, profiles:{ Cindy:{ driver:'openclaw', color, cdpPort } } } }`。`ExternalChromeBackend` 把 direct/proxied route 当作浏览器进程 launch state:所有外置浏览器调用进入同一串行队列,route 变化时先停旧进程,再用不可变 base config + 新 route 创建 runtime;绝不在无关调用执行中修改共享 config。启动不带 `proxyServer` 是显式 direct,配置不含 proxy flag,生成 launcher 因而保留 `--no-proxy-server`。这两个窄 SSRF 开关只豁免 Surge/Clash/sing-box 等代理使用的 fake-IP DNS(`198.18.0.0/15` 与 IPv6 ULA),避免普通公网域名被误拦;localhost、RFC1918、cloud metadata、link-local 与其它 special-use 地址继续由 SSRF guard 阻断。上游 SSRF 层已经支持这两个字段,但 config resolver 尚未透传,所以 `sync.mjs` 用 fail-loud `LOCAL_PATCHES` 保留它们。runtime 内部把 config 存进 in-memory 配置快照;vendored dispatcher 每次请求经
`getRuntimeConfigSourceSnapshot() ?? getRuntimeConfig()` 再取 `.browser` 拿到它。

> ⚠️ **不变量(踩过的最大的坑):** `src/shim/runtime-config-snapshot.ts` 的 `getRuntimeConfigSourceSnapshot()` **必须返回 `OpenClawConfig | null`**(默认 `return null`)。它一旦返回 `{config, source}` 这种 wrapper,上面的 `?? getRuntimeConfig()` 永远短路、`.browser` 取到 `undefined`,**host 注入的整份 config 被静默丢弃、runtime 跑纯 vendored 默认值**(于是 profile 显示成上游默认名、颜色/目录全不对)。由 `src/__tests__/runtime-config-application.test.ts` 守护——别删那条测试。

## 4. 踩坑清单(症状 → 根因 → 铁律)

| # | 症状 | 根因 | 铁律 |
|---|---|---|---|
| 1 | config 不生效 / profile 显示上游默认名 | 见 §3,`getRuntimeConfigSourceSnapshot` 返回了 wrapper | 该 shim 必须返回 `OpenClawConfig \| null` |
| 2 | 数据目录落到 `~/.xdt-maker` 而非 Electron `userData` | Vite 把 `@cindy/browser-control-runtime` `require()` 进 main 入口 chunk 顶部,`CONFIG_DIR` 在 `index.ts` 设置 `XDT_BROWSER_RUNTIME_DIR` **之前**就求值成 `~/.xdt-maker`。从包入口 barrel 引入刷新函数还会提前求值 `paths.ts`,`DEFAULT_INBOUND_MEDIA_DIR` 冻在旧根,随后 `saveMediaBuffer` 写到刷新后的目录、上传校验按旧 inbound root 拒绝 | `index.ts` 在最后一次 `app.setPath('userData')` 之后 pin env,并从 **`@cindy/browser-control-runtime/config-dir`** 调用 `refreshBrowserRuntimeConfigDir()`(不要从包入口 barrel 引入,那会把 generated `paths.ts` 拉进入口 chunk)。单测 `browserRuntimeDirStartup.test.ts` 锁顺序与 import 路径。`browser.ts` 顶部 `import './browser-runtime-env.js'` 仍是 vitest/非打包路径的兜底,别重排 |
| 3 | `profile must define cdpPort or cdpUrl` | vendored 只给"名叫上游默认名"的 profile 自动分配 CDP 端口;自定义名的托管 profile 不会 | 自定义托管 profile 必须显式给 `cdpPort`(现用 18800,vendored 端口段起点) |
| 4 | 明明给了中性/白色,Chrome 工具栏却是浑浊蓝绿 | Chrome 把 profile `color` 当 **Material-You 种子色**生成色板,不是字面色;中性/近黑种子被它和成灰蓝 | 用**高饱和**色做种子(现 `#00D9C5` TapTap teal);想要纯灰度做不到(灰度开关在不可改的 vendored decorate 里) |
| 5 | 「打开 Agent 专用浏览器」每次开两个标签页 | `start` 本身已带初始标签页;冷启动 `GET /tabs` 在 CDP 未就绪时返回 empty,再 `open` 就会和 Chrome 自己的第一页抢 | `openBrowserForLogin` 只 `start` + 尽力 `focus`,**绝不** `open`。空 tabs 是「还没连上 CDP」,不是缺窗口 |
| 6 | profile 没有自定义头像 | Chrome 只认内置头像 / Google 账号头像,不能塞本地图 | 已知限制,接受;别为它改 vendored decorate |
| 7 | 改了 `browser-workflow.md` 但 agent 还按旧文案 | 这份 md 经 `?raw` 静态打进**进程内** MCP server;且 agent 只在调 `list_tools` 时读 rules | 改完要 **(a) 重启桌面端**(main/package 改动不热更)+ **(b) 开新 agent 会话**(老会话 context 里是旧 rules) |
| 8 | 远端 Codex 会话里浏览器不可用 | lizi MCP 桥接只对**本地** Codex 生效(见 §7) | 不是 bug;所有 `lizi_*` 工具对远端 Codex 都一样 |
| 9 | 代理切换后仍走旧出口 / 并发 start-stop 互相踩配置 | route 被当成普通请求参数、或运行中改共享 config | route 是进程 launch state;所有 external call 串行;不同/未知 route 必须 stop→recreate→start,失败后不得继续服务旧 route |
| 10 | 认证代理凭据出现在进程参数、日志、结果或数据库 | 曾接受带 userinfo 的 proxy URL | **不支持认证代理**:`parseBrowserProxyServer` 见到 userinfo 直接抛错,凭据因此根本进不来。tool input 跨持久化/UI 边界前仍走同一 parser 验证,不能解析(含带凭据)的整值替换为 `[REDACTED]`。想恢复支持前先读 §4.1 的那条不变量 |
| 11 | 开了「使用我的浏览器登录态」但窗口仍是登出 | 快照把 `last_used` 的 cookie 放进 dest `Default`,却原样拷了 `Local State`;Chrome 按 `last_used` 打开空的 `Profile N` | 写入 dest `Local State` 时必须把 `last_used` / `last_active_profiles` / `profiles_order` 改成 `Default`,`info_cache` 只留 Default(元数据从源 last_used 挪过来),并删掉 dest 里其它 `Profile N` |
| 12 | Chrome 右上角 chip 显示 `Cindy-real` / 源 profile 名 | 磁盘 key 必须是 `Cindy-real`;vendored decorate 默认用 `profile.name`(map key)。host 只改 Local State 不够,下次 launch 会盖回去 | `profiles[Cindy-real].displayName = "Cindy"`;`launchOpenClawChrome` 用 `displayName ?? name` decorate。快照写入时也把 `info_cache.Default.name` 写成 `Cindy` |
| 13 | 已有完全磁盘访问仍弹「需要完全磁盘访问权限」 | 第一次 enable 在 macOS 无条件跑 `guideFullDiskAccessAfterReadDenied` | 同意拷贝之后先 `probeSourceRead`(只 open 源 Local State / Cookies,不拷贝、不回路径);`readable: true` 就跳过。真正快照 `REAL_PROFILE_READ_DENIED` 仍弹。不自动打开系统设置 |

### 4.1 per-start 代理不变量

- `proxyServer` 只允许 `action=start`;MCP 与 neutral runtime 边界都会拒绝其它 action。
- 支持 Chromium URI 形式的 `http`、`https`、`socks`/`socks5`、`socks4`;禁止 proxy list、`DIRECT` fallback、路径、query、fragment 与命令行注入字符。SOCKS 认证不受 Chromium 支持,带凭据直接拒绝。
- direct→direct、proxy A→proxy A 幂等;direct↔proxy、proxy A→proxy B 必须停旧进程后重建。无法证明已运行进程 route 时按 unknown 处理并安全重启。
- proxied 启动**只下发 `--proxy-pac-url`**,代理地址写在 PAC 的 `PROXY`/`SOCKS5` 指令里;PAC 对非 allowlist host 返回 `PROXY 0.0.0.0:0`,没有 `DIRECT` 回退,代理不可达时 Chrome 请求失败,不得回退直连。新 route 启动或认证协调器失败时立即 stop,并保持 route unknown/stopped。
- status/start 只暴露 `{proxy:{mode,server?}}`;server 无 userinfo/query。任何异常文本进入日志或 tool result 前再走中央 redaction。
- **认证代理不支持,且这是实测后的有意决定。** 两条路都走不通(Chrome 151 实测):
  1. **host 侧 CDP 协调器**:Chrome 对同一 target 只把 `Fetch.authRequired` 投给**一个**
     client;vendored 会话用 `connectOverCDP` 连接并在导航守卫里 `page.route("**")`,
     必然赢得拦截权,协调器永远收不到挑战(双 client 实测:事件只投给后连接的那个)。
  2. **Playwright `context.setHTTPCredentials`**:能应答代理挑战,但它是 **context 级、
     不区分挑战来源**——页面从**自身 origin** 返回 `WWW-Authenticate: Basic` 时 origin 会
     拿到同一份凭据(实测 origin 收到 `PROXYUSER:PROXYSECRET`)。allowlist 内页面内容不可信,
     等于把用户的代理凭据交给被访问站点。加 `httpCredentials.origin` 也救不了:该限制对代理
     挑战同样生效——scope 到代理等于没 scope,scope 到别处则代理 407 无人应答(实测 0 认证)。
  因此 `parseBrowserProxyServer` **在解析边界直接拒绝带 userinfo 的 URL**:宁可响亮报错,
  也不要启动一个"看起来配了认证代理、实际认证根本不工作"的浏览器。要恢复支持必须先找到
  **只对代理挑战生效**的凭据通道(例如让 runtime 自己 launch 浏览器而非 `connectOverCDP`,
  用 launch 期的 `proxy:{username,password}`),并重新做 origin 泄漏验证。
- 调用方的原生 Agent transcript 是 host 边界之前的上游记录:Claude/Codex 可能在 Cindy 收到 MCP 请求前已持久化模型生成的原始 tool input。由于本接口现在直接拒绝带 userinfo 的 URL,正常路径下不存在可被上游 transcript 保留的代理凭据;但调用方若**尝试**传入凭据,那次尝试仍可能留在其自身 transcript 里。
- 自动附加的新 page 只有在 `Fetch.enable(handleAuthRequests:true)` 成功后才恢复执行;后续 target 安装认证处理器失败时关闭整个受管浏览器,不得继续报告一条可用的认证代理路由。
- 后续 target 的认证安装失败要先把 host route 标成 blocked,再尝试 `Browser.close`;即使 CDP 关闭命令失败,普通调用与 `start` 仍须拒绝,直到 `stop` 被验证成功。
- 认证协调器初始化期间的异步 target 失败不得被最终成功赋值覆盖;认证 CDP WebSocket 意外断开也必须立即把 route 标成 blocked。只有显式 dispose/stop 的主动断开可以忽略。
- 认证启动返回前必须用 CDP 命令响应作为消息屏障,等待屏障前收到的 auto-attach 认证任务全部完成;屏障内失败时 `start` 必须失败,不能先报告代理可用再异步改成 unknown。
- app 退出先关闭 `ExternalChromeBackend` 的新调用准入,再通过同一串行队列排空已准入调用并停止浏览器;退出清理开始后到达的 `start` 不得在 stop 后重新拉起 Chrome。
- backend 切换/退出时只有验证 stop 成功后才能清 route、释放认证协调器并把 runtime 标成未使用;stop 失败或抛错必须保留清理所有权并进入 blocked 状态。
- 已验证停止的 proxied runtime 不能留给 `open` 等普通动作隐式重启;清理 route 时同步换回 immutable direct runtime。路由幂等 key 必须用无碰撞 tuple 编码,不能用未转义分隔符拼接。
- 关闭未知继承进程前不能只信任固定 loopback CDP 端口;必须通过 CDP `SystemInfo.getInfo` 同时核对受管 profile 的 `--user-data-dir` 与 `--remote-debugging-port`,身份不符或无法建立时拒绝关闭和重启。
- **CDP 守卫身份必须跟本次 launch**:`ExternalChromeBackend` 不得把 `cdpHttpUrl` / `managedUserDataDir` 钉死成 `18800` + `browser/Cindy`。「使用我的浏览器登录态」走 `Cindy-real`,18800 被占时还会迁到 18801+。Fetch 门、liveness、adopted-close 与 fail-closed 杀进程必须在 **start 当下** 读取当前 profile 与 `cdpPort`(与 `applyManagedConfig` / `pickManagedCdpPort` 同一份);对不上就 fail closed,不要贴到残留 Chrome。
- 继承的 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` 清理仍由 vendored launcher 保持;CDP loopback 控制连接不经页面代理。
- **`running` 是 `cdpReady`,不是进程存活。** vendored status 的 `running` 字段等于 CDP
  readiness(`routes/basic.ts`),忙碌但活着的 Chrome 会报 `running:false`。因此
  **`'stopped'` 永远不等于「没有进程」**。所有会拆路由、归因隐式启动、或收养陌生进程的判断
  必须走 `external-chrome-backend.ts` 的 `resolveLiveness()`,它只返回三态:
  `running` / `gone`(经非破坏性探针独立验证缺席)/ `unproven`。**`unproven` 一律 fail
  closed**——保留路由并 block,直到一次已验证的 stop;对 direct 路由同样适用(清掉一条还活着的
  direct 路由,会让下一次 start 把我们自己的浏览器当陌生进程关掉,毁掉用户标签页)。
  passive 路径(`status`)只能用非破坏性探针,绝不能发 `Browser.close`。
- 因 `unproven` 设的 block 是**暂时的**,浏览器恢复应答后必须清除(否则除 status/stop 外
  永久不可用);而认证失败、stop 无法验证、restart 失败设的 block **不是**暂时的——那表示
  路由本身不可信,只有已验证的 stop 能解除。用 `routeBlockedByUnprovenLiveness` 区分,别把
  两者混成一个布尔。
- 代理启动必须带 `--webrtc-ip-handling-policy=disable_non_proxied_udp`:WebRTC 走 UDP,
  既不经 PAC 也不进 CDP `Fetch`,页面可以在「已代理」状态下用 `RTCPeerConnection` 暴露本机真实
  IP(Chrome 151 实测:不带该 flag 会吐出 LAN IP host candidate,带上则无 candidate)。
  注意**没有 `--force-` 前缀**——`--force-webrtc-ip-handling-policy` 会被静默忽略。
- 代理不改变导航 SSRF 判定;fake-IP 两个既有窄豁免之外的 private/metadata/link-local 阻断不得放宽。
- `navigate` 与 `click`/`type`/`press`/`select`/`fill`/`evaluate`/`hover`/`drag`/`scrollIntoView`/`wait` 等交互触发的主框架、子框架和延迟导航必须使用同一份 profile proxy mode + SSRF policy;不能只保护显式导航入口——凡可能触发脚本导航的交互（含 `setInputFiles` 直接上传后的 input/change 事件与 `resize` 视口变化，及交互期间经 window.open / target=_blank 打开的新 tab）都要走同一导航守卫。
- **启动瞬间的下限由 PAC 兜底**:CDP 守卫要等 DevTools 端点起来才能 attach,持久 profile 恢复标签页/拉起 service worker 可能在这个窗口内出网。因此 proxied 启动同时下发 `--proxy-pac-url`(data: URL,base64),PAC 把 allowlist 内的 host 指向代理、其余一律返回不可达指令(**没有 DIRECT 回退**,否则会绕过代理直出);host 模式串必须 JSON 编码后再进 PAC 源码,不能字符串拼接。**不要再叠加 `--proxy-server`**:Chromium 从命令行只取一种代理模式,优先级固定为 `--no-proxy-server` > `--proxy-pac-url` > `--proxy-auto-detect` > `--proxy-server`(`ChromeCommandLinePrefStore::ApplyProxyMode`,Chrome 152 实测同 PAC 生效、fixed 代理不收任何 CONNECT),叠上去只是一条会误导读者的死配置;上游 `browser-proxy-mode.ts` 把 `--proxy-pac-url` 本身就当显式代理路由,导航守卫的 proxied 判定不依赖 `--proxy-server`。PAC 是下限不是上限,attach 之后仍由下面的 CDP 守卫逐请求执行 HTTPS + allowlist。
- **请求级的终局判据是宿主的 lifetime CDP 守卫**(`apps/desktop/.../proxy-auth.ts`):proxied 启动一律安装,对**每个具备网络能力的** target(page / iframe / service_worker / shared_worker / worker / worklet,含启动时已存在的与 auto-attach 新建的)开 `Fetch`——拦截是 target/session 级的,漏装的 worker 会绕过闸门直出;非网络 target 只 resume 不开闸,并对每条 paused 请求执行 fail-closed 判据——仅 HTTPS 且 hostname 命中本次启动 allowlist 才 `continueRequest`,否则 `failRequest(BlockedByClient)`;无 allowlist 的 proxied 启动一律全拦。判据实现在 `proxy.ts` 的 `isBrowserProxyRequestUrlAllowedAsync`,与导航守卫共用同一套 normalize / 通配语义,两层必须同判。上面的交互级守卫是纵深防御(给调用方同步失败与 quarantine 语义),**不得**因为有请求级守卫就删掉,反之亦然。
  - **allowlist 只是名字,必须再验 DNS 应答**:命中 allowlist 不等于目标是公网。`isBrowserProxyRequestUrlAllowedAsync` 先跑同步的名字判据(HTTPS + allowlist + 字面私网/内网名),再对通过者跑 `resolvePinnedHostnameWithPolicy`,拦掉「名字公网、解析结果指向内网」这一类(`127.0.0.1.nip.io`、rebinding 应答);解析不出来也一律 fail closed。调用这个解析时**不要**把本次 allowlist 当 `hostnameAllowlist` 传进去——那个字段是精确主机豁免,会跳过这里唯一要做的私网应答检查。判定按 hostname 缓存 30s(无缓存则每条 paused 请求都要查一次 DNS;无上限则 rebinding 应答会被永久钉住),TTL 到期必须重查。
  - 残留信任:以上验的是**本机**的解析结果。explicit proxy 自己还会再解析一次,所以带 split-horizon DNS 的代理仍可把 allowlist 内的公网名映射到只有它够得到的地址。这是把出网委托给运营者选定代理的固有代价——也正是导航守卫在 proxied 模式下坚持要求显式 allowlist、而不肯只靠解析结果的原因。
  - 已知边界:CDP `Fetch` **不拦截 WebSocket 握手**,故 WS 出网不由请求级守卫判定,而是由启动 PAC 兜底——Chrome 把 `ws:`/`wss:` 原样交给 PAC(已对 Chrome 151 实测),因此 PAC 必须显式放行 `wss://`(否则 allowlist 内站点的实时功能全断,且没有任何后续层能救回),并继续拦掉明文 `ws://`。改动 PAC 的 scheme 判据时**必须同时想清楚 WS**:这是唯一在管它的地方。
  - **PAC 必须自己验 DNS 应答**:pre-attach 窗口和 WSS 都看不见 CDP 闸门,所以 PAC 在 hostname 命中 allowlist 之后还要 `dnsResolve` + `isInNet`(Netscape PAC / Chromium 实现,IPv4-only;解析失败 fail closed)。私网/特殊用途 IPv4 与 IPv6 loopback/link-local 字面量一律不可达指令;198.18.0.0/15 豁免以对齐 `allowRfc2544BenchmarkRange`。残留信任与 CDP 层相同:验的是本机解析,explicit proxy 自己还会再解析一次。
- Settings 的“打开 Agent 专用浏览器”必须先读 `status`:已运行时只聚焦现有标签页,不能用无 `proxyServer` 的 `start` 把调用方选择的代理路由误切成直连;仅在确认 stopped 后才启动直连浏览器。**例外是 `proxy.mode === 'unknown'`**(Cindy 重启后继承了上次启动的 Chrome):此时没有任何已知路由可保护,而 backend 的 unknown-route 闸门会拒掉 `tabs`/`focus`,跳过 `start` 只会让这个按钮"成功返回但什么都没发生"。`start` 是唯一能收养/替换该进程并重装请求守卫的路径,这种情况必须执行。判据只认 `unknown`——`direct` 与 `proxied` 都是已知路由,照旧不得被直连 `start` 顶掉。

## 5. UI 开关模型(设置 →「自动操作」)

浏览器是个 builtin plugin(id `browser`),走 `plugin-registry.ts` 的三层判定:essential → 项目级 override → 内置默认。**内置默认是开**,所以浏览器在所有项目里默认可用;设置里的开关写的是"当前项目的 override"。无项目上下文时开关变灰(`workingDir` 来自最近本地会话的内存单例,见 `renderer/state/lastWorkingDir.ts`)。

> ⚠️ **已知限制 — 项目级开关只对 Claude Code 生效,本地 Codex 不生效:** Claude Code 每个会话用真实 `workingDir` 重新求一次 `provider.isEnabled(ctx)`,所以"在 A 项目关掉浏览器"对它有效。本地 Codex 不行——`codexEnvironment.ts` 在**首次 codex spawn** 时就用 `workingDir: ''` 的全局空 ctx 求值一次 `provider.isEnabled(ctx)`(见 `doStart` 里 `serverFactories` 那段),空 `workingDir` 命中不到任何项目级 override、回落到"内置默认开"那一档,并且**冻结**、之后不再 per-session 重判。`ctx.getSessionContext` 虽然在 tool-call 时能拿到真实 `workingDir`,但 gate 不消费它。所以本地 Codex 永远把浏览器当"开",项目级关闭被无视。**TODO:** 在 codex tool-call 时按真实 `workingDir` 重新 gate(而非进程级一次性求值),才能让本地 Codex 也尊重项目级开关。修这块属于敏感的 codex bridge,改前先确认。

## 6. 产品中性(硬约束)

"OpenClaw" / 🦞 **不得出现在任何产品可见处**:Chrome profile UI、日志、报错文案、喂 agent 的 rules、Settings、i18n。
- `browser-managed-config.ts` 里 `MANAGED_DRIVER = 'openclaw'` 是 vendored 要求的**内部 enum 值**,从不进入用户可见面,保留即可。
- 上游名**只允许**出现在:`_generated/**`、`upstream/**` 元数据、`scripts/browser-runtime/sync.mjs`、以及 shim 内部实现细节。改动后用 `grep -ri "openclaw\|🦞" <产品可见路径>` 自查。

## 7. agent 暴露面(Claude / Codex)

- **Claude Code**:`cindy_browser` provider 经 `toClaudeSdkConfig` 直接以进程内 SDK McpServer 暴露。
- **本地 Codex**:`apps/desktop/src/main/mcp-integrations/codexEnvironment.ts` 把所有 lizi provider(含 browser)架到一个 HTTP bridge,`-c mcp_servers.cindy_browser.url=...` 注入。调同一个进程内 server / 同一个 runtime / **同一份持久 profile**——Claude 登录过的站,Codex 也是登录态。⚠️ 但 provider 的 `isEnabled` gate 在首次 spawn 时用空 `workingDir` 一次性求值并冻结,所以**项目级浏览器开关对本地 Codex 不生效**(见 §5 的已知限制)。
- **远端 Codex**:`packages/maker-core/src/agents/codex/index.ts` 明确不支持 lizi MCP 桥接,远端只用 codex 自带 + 远端用户配置的 MCP。浏览器(及所有 `lizi_*`)拿不到。

## 8. 跟随上游更新

```bash
pnpm sync:browser-runtime                 # = node scripts/browser-runtime/sync.mjs
pnpm --filter @cindy/browser-control-runtime build   # tsc --noEmit, 暴露 shim 缺口
pnpm --filter @cindy/browser-control-runtime test    # 契约 + SSRF guard
```

- 版本锁:`upstream/browser-runtime.lock.json`(pinned commit + fs-safe 版本 + content hash)。
- `_generated/**` 整体重生成,**永不手改**;要改行为改 `src/shim/*` 或 `sync.mjs`(vendor 集合 / import 重写 / `LOCAL_PATCHES`)。chip `displayName` 就是这种 LOCAL_PATCH,下次 sync 会按 `sync.mjs` 重新打上。
- shim 导出契约在 `upstream/shim-spec.md`;sync 后若多出新的 `openclaw/plugin-sdk/*` import,补对应 shim。
- 安全:SSRF / 路径包含的**决策逻辑是 vendored 的**,`src/shim/ssrf-runtime.ts` 只重写了组合这些原语的 fetch 外壳;`ssrf-guard.test.ts` 断言拦截 cloud-metadata / 私网 IP 的"牙齿"还在,削弱会挂 CI。
- 同步后回归一遍 §4 的坑(尤其 #1 配置应用、#3 cdpPort),再跑 `runtime-config-application.test.ts` + @cindy/mcps browser 测试 + desktop `browserAvailability` 测试。

## 9. 提效能力(network / extract / recipe / sitemap)

在"自启动 Chrome + CDP"之上加的一层"高效原语 + 站点知识",目标是把盲探的 token/步数打下来。全部增量、不改 `_generated/`。

- **`requests` / `responseBody`(L1 runtime)**:接的是 vendored **已存在但原先没接线**的两条路由(`GET /requests`、`POST /response/body`,见 `_generated/.../pw-tools-core.activity.ts` / `pw-tools-core.responses.ts`)。runtime 复用 per-page 自动捕获缓冲(上限 500、page 关闭自动清),`runtime.ts` 的 `planDispatch` 加两个 case 即可,无新监听、无泄漏。语义:很多页面背后是 JSON API,读接口比扒 DOM 又稳又省。`responseBody` 在 chrome-mcp 接管态返 501,但默认 managed profile 不触发。
- **`extract`(L2 MCP,`extract.ts`)**:纯组合现有 `act:evaluate`。`buildExtractFnSource(spec)` 是**纯函数**,把字段 schema 编译成注入 JS(选择器一律 `JSON.stringify` 注入,防注入),handler 改写成 `act:{kind:'evaluate',fn}`。不碰 runtime 包。**报错教模型(对齐上游 `SELECTOR_UNSUPPORTED_MESSAGE` 范式)**:生成的 fn 给 `querySelector` 包 try/catch,非法选择器 → 返回 `{ok:false, error, hint}`(`EXTRACT_FIELD_HINT` 教正确字段格式);handler 跑前用 `collectSelectors` 预检 selector 含 `@`(观察到模型爱写 `h3 a@title`)→ 直接返回教学报错,不空跑。**不加 `@attr` 语法糖**(上游无此约定)。
- **`recipe` / `siteguide`(L2 MCP)**:`recipe-loader.ts`(`parseRecipes`/`parseSiteGuides` 纯函数 + `loadRecipes`/`loadSiteGuides` 用 `import.meta.glob('./recipes/*/{recipe,siteguide}.json',{query:'?raw',eager:true})` 打包)+ `recipe-runner.ts`(`runRecipe(recipe,inputs,{call})` 纯执行器,注入 `call` 可单测)。数据在 `packages/lizi-mcps/src/browser/recipes/<site>/`。**交互步(click/type/select)直接用稳定 CSS `selector`**——vendored `act` 对 `SELECTOR_ALLOWED_KINDS`(click/type/select/hover/wait)支持 selector 直传,**无需 snapshot→ref**,所以配方不写死 ref、跨会话不腐烂(`fill` 是 ref-only,配方用 `type` 输入文本)。registry 懒加载(首次 recipe/siteguide 调用才解析,坏配方不拖垮整个工具)。`siteguide` **按需 action 拉取**,不进常驻 rules,保持缓存前缀小。**命名 `siteguide` 而非 `sitemap`**:避免和网站自己的 `/sitemap.xml` 撞概念(实测中模型会把 `sitemap` 误解成去抓 sitemap.xml)。
- **配方分层 + 自我成长(L1 内置 + L2 用户,rule 20)**:配方/指南是"可成长"的——内置 L1(随 app 版本发布)+ 用户本地 L2(`userData/browser-recipes/<site>/`)按 **recipe id / siteguide site 整条覆盖**合并,provenance 三态 `builtin`/`user`/`overridden`(`recipe-loader.ts` 的纯函数 `mergeRecipes`/`mergeSiteGuides`)。**恢复默认 = 删 L2 该站文件**(回落 L1,不写快照)。
  - **解耦**:`@cindy/mcps` 不碰 fs/electron;host 经 `BrowserMcpDeps.getUserRecipes?`(读)/`saveUserRecipe?`(写)注入。host 侧在 `apps/desktop/src/main/browser-recipes/{loader,writer}.ts`(蓝本 `local-themes/{loader,writer}`),loader 扫盘 + 调 @cindy/mcps `parseRecipes` + 算 `version` 内容指纹。
  - **缓存失效靠 version**:`tools.ts` 的 registry 按 L2 `version`(内容指纹)缓存;`saveRecipe` 写盘后内容变 → version 变 → 下次任意会话重新 merge(跨 per-session server 实例也一致)。
  - **`saveRecipe` action**:agent/用户把配方写进 L2(先 `RecipeSchema` 代码校验 draft,坏的 teach-via-error)。配套 **`recipe-author.md`**(按需 rule)教 agent 用我们 schema 写配方(recon→选策略→发现接口→鉴权→snapshot 验选择器→跑一遍验证→saveRecipe)。
  - **`evaluate` 配方步(取数策略)**:`RecipeStepSchema` 的 `evaluate` 跑一段页面内函数表达式源码(可 async,Playwright 路径会 await,见 `pw-tools-core.interactions.ts` 的 `result.then` 分支),映射到 `act:evaluate`、返回值在 `result.data.result`。这是 agent 本就能用 `act:evaluate` 直接做的事,配方只是能表达它了——**无新增能力面/风险**。两类取数:**public** = `navigate` 到接口 URL + `extract {body}`(公开 GET,如 HN/SO/devto/arxiv/wikipedia);**cookie/反爬** = `navigate` 到主域 + `evaluate` 内同源 `fetch(path,{credentials:'include'})`(带登录 cookie、不被反爬挡,如 Reddit)。
  - **license/原创 + 交叉验证**:配方与 author 指引均**原创**(我们 schema)。端点/参数/选择器/登录策略这类**不可版权化的站点客观事实**,以 `@jackwener/opencli`(npm,Apache-2.0,本机 `~/.opencli` → 全局包 `dist/`)的 adapter 为事实参照做**交叉验证**(它的 `Strategy` PUBLIC/COOKIE/HEADER/INTERCEPT/UI 与 YAML pipeline 给出了各站的权威端点),但**绝不转录它的代码/数据结构**,只把核对过的事实用我们 schema 重写。产品可见面不出现上游/OpenCLI 名。
  - **配方现状(~54 站,三类)**:**① 公开 API/feed**(navigate+extract,无登录,live-verify 21/22 PASS):hn/npm/pypi/mdn/crates/wikipedia/arxiv/stackoverflow/hf/coingecko/devto/pubmed/lobsters/v2ex/steam/yahoo-finance/bbc/producthunt/bluesky/36kr/sinafinance + 交互 demo(books/scrapethissite)。**② cookie/内部 API**(navigate 主域 + `evaluate` 同源 fetch、交叉验证 opencli 端点、**无法 headless 验证、需登录态**):reddit/bilibili/weibo/zhihu/xueqiu/zsxq/jike/tieba/linux-do/weread/douyin/smzdm/sinablog/twitter(x.com)/instagram/medium/substack/reuters/youtube/pixiv/barchart/imdb/jd/coupang/ctrip/xiaoyuzhou/**linkedin(Voyager,csrf 取自 JSESSIONID,仅职位搜索、封号风险)**。**③ 纯 DOM 扒取**(无内部 API,`evaluate` 轮询/滚动后扒渲染 DOM,选择器易随改版烂、需登录态、无法 headless 验证):**douban / xiaohongshu(API 要 x-s 签名,绕开走 DOM)/ facebook**。fix 范例:**lobsters** 用 feed 端点(opencli 证明无 search.json);**reddit** navigate 主域 + `evaluate` cookie fetch。第 ③ 类是最脆的一档——能登录态访问时优先让 agent 现场 snapshot+extract,配方失效会快速失败并回退。
  - **已 SKIP(浏览器原语真表达不了,故意不收)**:spotify(OAuth bearer token,要建开发者 app + 回调)、grok(AI 对话 UI、无读接口)、**apple-podcasts(iTunes Search API 带 `content-disposition: attachment` 强制下载 + 无 CORS + 根域跨域重定向,server-side fetch 才行)**。教训:有些公开 API 在浏览器里取不到(下载头 / CORS / 跨域重定向)——opencli 靠 Node fetch(`browser:false`)绕过,我们是 browser-only;若未来要覆盖这类,需加一个 host 侧 server-fetch step(目前不做)。**「纯 DOM 站(douban/facebook 等)做不做配方」是质量取舍,不是能力边界**:浏览器永远能访问它们(渲染后读 DOM),配方只是把高频流程固化的加速器。
  - **live 集成检查**:`scripts/browser-live-verify.mjs` 跑交互配方 + network + 公开波(headless)+ reddit(期望 REVIEW)。登录波只能 app 内登录后人测。
- **rules**:`browser-workflow.md` 的「Token 效率」给出选路阶梯(配方 → 接口 → extract → snapshot → screenshot)+ action 速查表新增这些 action。固定文本、不随站点增减,经 `list_tools` 下发、不进 system 段(规则 11),缓存安全。
- **评测**:`scripts/browser-capability-benchmark.mjs`(`pnpm benchmark:browser`)像 `smoke.mjs` 一样**独立 headless** 驱动 runtime,在 demo 站量化 snapshot vs extract 的 payload 字符数(≈token)下降。完整 agent 会话 cache-hit-rate 改前/改后对比仍是 app 内手测(规则 10)。
- **live 集成检查**:`scripts/browser-live-verify.mjs`(`node --import tsx`)实跑交互配方(scrapethissite type+submit+extract)+ network(requests→responseBody)。`loadRecipes()` 的 `import.meta.glob` 只在 vite 下有效,脚本里用 `fs` 读配方喂纯函数 `parseRecipes` 绕开。
- ⚠️ **`responseBody` 是"等待下一个匹配响应"语义**(`pw-tools-core.responses.ts`:`page.on("response")` + 20s 超时),**不读历史**。顺序工具调用的 agent 很难"先 arm 再触发",所以读 GET JSON 接口的可靠姿势是**直接 navigate 到该 URL + extract/evaluate 读 body**;`requests` 才是读已发生请求清单的那个(buffered)。rules 已据此修正(实测踩过:navigate 后再 responseBody 会"not found")。

> 加新 action 改了 `browser` 工具 schema → 会话启动一次性注册(`maker-core/.../claude-code/index.ts:713`),一次性失效缓存前缀、稳态不降;按规则 10 实测。新增 action 要两端同步:runtime `types.ts` 的 `BrowserControlAction` ⇄ `tools.ts` 的 `ACTIONS`(exhaustive switch 会强制对齐)。

## 10. 相关文档

- `README.md` — runtime 包速览 + 安全说明(本目录上一级)。
- `shim-spec.md` — 每个 shim 必须提供的具名导出。
- `STATUS.md` — 交付现状。
- `BUILD-PLAN.md` — 历史设计笔记(vendoring 引擎的最初规划,仅供溯源)。
