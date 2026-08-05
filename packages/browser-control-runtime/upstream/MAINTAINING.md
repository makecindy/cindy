# 浏览器自动化 — 维护者指南

> **这是改动浏览器自动化功能前的唯一必读文档。** 它串起三层代码、记录所有踩过的坑与不变量、说明如何跟随上游更新。
> 以源码实现为准:本文与代码冲突时信代码,但请在同一改动里同步修正本文。

## 1. 这是什么

给 agent(Claude Code / Codex)用的浏览器自动化能力,对外是 `cindy_browser` MCP 工具。核心运行时是**vendored 上游(代号见 `sync.mjs`)的浏览器内核**——不是重写,以便跟随上游更新。产品可见的任何地方都**不出现上游名 / 🦞**(见 §6)。

默认行为:启动**一个专属、持久、headed 的自动化浏览器**(profile 名 "Cindy"),登录态长期保留,与用户日常 Chrome 互不影响。

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
  │  单例 runtime = createBrowserControlRuntime({ config: buildManagedConfig() })
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
| **L3 desktop host** | `apps/desktop/src/main/mcp-integrations/` | `browser-runtime-env.ts`(**import 前置副作用**,见坑 #2)、`browser.ts`(托管 config + runtime 单例 + `getBrowserMcpDeps`/`getBrowserAvailability`/`openBrowserForLogin`)、`browser-availability.ts`(status → UI 数据)。IPC:`maker-ipc/{channels,register}.ts` 的 `BROWSER_STATUS` + `BROWSER_OPEN_FOR_LOGIN`。UI:`renderer/components/settings/ComputerUseSection.tsx`(设置 →「自动操作」)+ 4 语言 i18n。开关 gate:`maker-host/plugins/plugin-registry.ts`(plugin id `browser`) |

## 3. 配置流(以及那个静默 bug)

host 在 `browser.ts` 用 `buildManagedConfig()` 造出 `{ browser: { enabled, defaultProfile:'Cindy', headless:false, profiles:{ Cindy:{ driver:'openclaw', color, cdpPort } } } }`,在模块求值时 `createBrowserControlRuntime({ config })` 注入。runtime 内部把它存进 in-memory 配置快照;vendored dispatcher 每次请求经
`getRuntimeConfigSourceSnapshot() ?? getRuntimeConfig()` 再取 `.browser` 拿到它。

> ⚠️ **不变量(踩过的最大的坑):** `src/shim/runtime-config-snapshot.ts` 的 `getRuntimeConfigSourceSnapshot()` **必须返回 `OpenClawConfig | null`**(默认 `return null`)。它一旦返回 `{config, source}` 这种 wrapper,上面的 `?? getRuntimeConfig()` 永远短路、`.browser` 取到 `undefined`,**host 注入的整份 config 被静默丢弃、runtime 跑纯 vendored 默认值**(于是 profile 显示成上游默认名、颜色/目录全不对)。由 `src/__tests__/runtime-config-application.test.ts` 守护——别删那条测试。

## 4. 踩坑清单(症状 → 根因 → 铁律)

| # | 症状 | 根因 | 铁律 |
|---|---|---|---|
| 1 | config 不生效 / profile 显示上游默认名 | 见 §3,`getRuntimeConfigSourceSnapshot` 返回了 wrapper | 该 shim 必须返回 `OpenClawConfig \| null` |
| 2 | 数据目录落到 `~/.xdt-maker` 而非 Electron `userData` | `CONFIG_DIR` 是 `shim/_local/text-utils.ts` 里**模块加载即求值**的 const,读 `XDT_BROWSER_RUNTIME_DIR` | 必须在 **import runtime 之前**设好 env——靠 `browser.ts` 顶部 `import './browser-runtime-env.js'` 保持**第一行**,别重排 import(无 import-order autofix) |
| 3 | `profile must define cdpPort or cdpUrl` | vendored 只给"名叫上游默认名"的 profile 自动分配 CDP 端口;自定义名的托管 profile 不会 | 自定义托管 profile 必须显式给 `cdpPort`(现用 18800,vendored 端口段起点) |
| 4 | 明明给了中性/白色,Chrome 工具栏却是浑浊蓝绿 | Chrome 把 profile `color` 当 **Material-You 种子色**生成色板,不是字面色;中性/近黑种子被它和成灰蓝 | 用**高饱和**色做种子(现 `#00D9C5` TapTap teal);想要纯灰度做不到(灰度开关在不可改的 vendored decorate 里) |
| 5 | 「打开 Agent 专用浏览器」每次开两个标签页 | `start` 本身已带初始标签页,再 `open` 在冷启动时会和它抢 | `openBrowserForLogin` 只 `start` + 尽力 `focus`,**绝不** `open` |
| 6 | profile 没有自定义头像 | Chrome 只认内置头像 / Google 账号头像,不能塞本地图 | 已知限制,接受;别为它改 vendored decorate |
| 7 | 改了 `browser-workflow.md` 但 agent 还按旧文案 | 这份 md 经 `?raw` 静态打进**进程内** MCP server;且 agent 只在调 `list_tools` 时读 rules | 改完要 **(a) 重启桌面端**(main/package 改动不热更)+ **(b) 开新 agent 会话**(老会话 context 里是旧 rules) |
| 8 | 远端 Codex 会话里浏览器不可用 | lizi MCP 桥接只对**本地** Codex 生效(见 §7) | 不是 bug;所有 `lizi_*` 工具对远端 Codex 都一样 |

## 5. UI 开关模型(设置 →「自动操作」)

浏览器是个 builtin plugin(id `browser`),走 `plugin-registry.ts` 的三层判定:essential → 项目级 override → 内置默认。**内置默认是开**,所以浏览器在所有项目里默认可用;设置里的开关写的是"当前项目的 override"。无项目上下文时开关变灰(`workingDir` 来自最近本地会话的内存单例,见 `renderer/state/lastWorkingDir.ts`)。

> ⚠️ **已知限制 — 项目级开关只对 Claude Code 生效,本地 Codex 不生效:** Claude Code 每个会话用真实 `workingDir` 重新求一次 `provider.isEnabled(ctx)`,所以"在 A 项目关掉浏览器"对它有效。本地 Codex 不行——`codexEnvironment.ts` 在**首次 codex spawn** 时就用 `workingDir: ''` 的全局空 ctx 求值一次 `provider.isEnabled(ctx)`(见 `doStart` 里 `serverFactories` 那段),空 `workingDir` 命中不到任何项目级 override、回落到"内置默认开"那一档,并且**冻结**、之后不再 per-session 重判。`ctx.getSessionContext` 虽然在 tool-call 时能拿到真实 `workingDir`,但 gate 不消费它。所以本地 Codex 永远把浏览器当"开",项目级关闭被无视。**TODO:** 在 codex tool-call 时按真实 `workingDir` 重新 gate(而非进程级一次性求值),才能让本地 Codex 也尊重项目级开关。修这块属于敏感的 codex bridge,改前先确认。

## 6. 产品中性(硬约束)

"OpenClaw" / 🦞 **不得出现在任何产品可见处**:Chrome profile UI、日志、报错文案、喂 agent 的 rules、Settings、i18n。
- `browser.ts` 里 `MANAGED_DRIVER = 'openclaw'` 是 vendored 要求的**内部 enum 值**,从不进入用户可见面,保留即可。
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
- `_generated/**` 整体重生成,**永不手改**;要改行为改 `src/shim/*` 或 `sync.mjs`(vendor 集合 / import 重写)。
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
