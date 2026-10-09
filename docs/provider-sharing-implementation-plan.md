# 供应商分享：实施计划

> 状态：P0–P3 客户端与服务端已实施（2026-10-07，见下方「实施记录」）；真实双账号联调与跨区合规确认待做。
> 跨仓契约正本：[`docs/provider-sharing-contract.md`](provider-sharing-contract.md)。
> 产品规则正本：[`docs/product-rules/provider-sharing.md`](product-rules/provider-sharing.md)；
> 交互设计稿（已确认）：[`docs/design-previews/provider-sharing/index.html`](design-previews/provider-sharing/index.html)。
> 本文按仓库拆分工作项：**客户端** = 本仓 `cindy`（Desktop、Mobile、共享 packages）；
> **服务端** = `cindy-server`（`device-link-server`、`auth-server` 及其 `packages/*-protocol`）。
> 代码位置基于本仓 `main` 与 `cindy-server` 的 `origin/main`（2026-09-30）调研，实施前以当时代码为准。

## 0. 实施记录（与下文计划的差异，以此为准）

- **C0-2 已撤回（对齐原则）**：受邀者的发送选项与同账号一致，保留主进程证明与自动审查上下文——它们只影响
  受邀者自己电脑上的权限判断与确认，不涉及分享者电脑的安全。
- **复核点**：`send` 前复核供应商授权；`steer` 与同账号一致不额外拦截(进行中的这一轮照常结束)；`open` 与
  每次 `setModel`(包括只换模型、不带来源)都把来源钉在分享的那个供应商上，并核对它为本 Agent 提供所选模型，
  否则 `REMOTE_AGENT_PROVIDER_NOT_ALLOWED`。没接 `providerAccess` 或出站登记(`bindGuestProviderRoute`)的宿主一律拒绝受邀者。
- **出站边界(按请求)**：受邀者任务启动前登记到 `maker-host/guest-provider-route-store`(会话来源写成分享的供应商，
  签发本机 proxy 路由令牌)，任务结束撤销。Claude Code 的请求经 `ANTHROPIC_CUSTOM_HEADERS` 带令牌(最高优先级设置层再写
  一次)，Claude proxy 只放行分享的供应商提供的模型，不走按模型的隐式推断，只有分享的就是网关时才落默认网关；
  Codex 受邀者独占的 proxy 只登记分享的那个供应商的自定义路由并过受邀者守门；Pi 的 proxy 令牌只为分享的供应商签发，
  proxy 再按登记复核。别的模型一律本地拒绝，不改道。
- **子代理**：受邀者不套用 B 的「Subagent 模型」设置(Claude 不注入 `CLAUDE_CODE_SUBAGENT_MODEL`，可选模型只列分享的
  供应商的，内部小模型钉到会话模型)；Codex 不开智能调配、不暴露 spawn 的模型覆写、不升格为带 B 订阅登录的超集进程；
  Pi 的 models.json、子代理模型路由与密钥 env 只留分享的供应商(分享的不是网关时不写网关模型)。
- **C1-8 用量**：不建表、不加 migration。分享者电脑上用 `userData/remote-agent/provider-share-usage.json`
  按（日期、分享、成员、Agent、供应商、模型）聚合，原子写入、保留 400 天；金额在查询时按本地单价估算
  (`getModelPriceQuote` + `computePriceQuoteTurnMoney`)，拿不到单价时用 Claude SDK 给的美元金额，再没有则不显示。
  删除成员后记录保留（交互稿「用量记录会保留」），管理页只显示当前成员。
- **C1-15 任务绑定**：不改 schema。受邀者任务的 `agent_device_id` 写成 `share:<shareId>`（≤128 字符，通过现有
  校验）；`remoteBackgroundInvoke` 与 Renderer 的 `device-link:invoke` 在边界换成分享者电脑的 peer key，maker-core 不变。
- **撤权**：分享快照里成员不再 active 时结束其任务、断开链路、丢弃待发结果；成员消失(删除、退出)时再清理影子
  工作区、附件、会话登记与本机会话记录。分享者电脑离线期间发生的删除在启动后第一次快照时补清。
- **受邀者隔离(P0b)**：三种 Agent 都已对受邀者开放(`GUEST_SUPPORTED_AGENTS`)。Codex 受邀者用独立的 CODEX_HOME
  (`<runs>/guest-homes/<控制端>/codex`，没有它就不启动；凭证只在内存，令牌经 `createCodexAuthTokenReader` 从 B 的登录读取，
  不复制进受邀者目录。受邀者拿到的令牌过期时触发的是 B 自己那条带锁的正常刷新，刷新结果照常写回 B 的 `auth.json`；
  受邀者不能主动发起刷新，也从不直接写 B 的 `auth.json`)，每个受邀者任务一个独立 app-server；Pi 受邀者不加载 B 的全局上下文、Skill、扩展与包，会话放在受邀者目录；
  受邀者的 `setVendorOptions` 只保留协同与定时任务的键，附加 / 可写目录只能落在虚拟工作区内，Codex 斜杠 Skill 只解析
  内置与会话目录内的。花名册与通讯录规则对受邀者不注入（已确认的系统提示词变更）。删除分享时清理受邀者目录与
  Claude / Codex / Pi 的会话记录。
- **P2 Mobile**：手机经被控电脑的同账号 channel `maker:provider-share:received-catalogs` 读取「分享给这台电脑的供应商」
  并接入模型列表(标题带「来自 X 的分享」)；暂停或分享者离线的分享与同账号电脑一致不列出(任务当前所在的保留)；
  分享链接在手机上只显示「请在电脑上打开」，口令不进路由状态与日志。只改 JS，运行时指纹不变。
  2026-10-08 起手机新建任务的模型列表也列出自己其他电脑的远程供应商与分享来的供应商(此前只在已建任务里能选)。
- **已知与交互稿的差异(待补)**：已暂停或分享者离线的分享在模型选择器里不显示(与同账号离线电脑一致)，没有交互稿
  第 6 屏的置灰分组与说明条；发送时由主进程给出「已暂停 / 已不可用 / 暂时不可用」的具体原因，用户可换模型。
  受邀者草稿选中的分享不会因已收到列表暂时不完整而被自动改回本机。
- **身份不外泄**：分享出去的模型目录与 `providerLabel` 去掉分享者的账号身份(订阅 / ChatGPT 登录名与名称里的邮箱)，
  分享者电脑、受邀者电脑与手机各过一遍(`@cindy/device-link` 的 `scrubSharedProvider` / `scrubProviderShareLabel`)；
  自动命名截断后的半个登录名、大小写不同的写法与邮箱用户名也去掉，目录里地址带的用户名密码与查询参数一并去掉，
  本机的数据归属(`dataOwnerId` / `ownerGeneration`)不下发。
- **只经分享的供应商(复审补)**：受邀者的请求不走视觉桥(视觉后端是 B 的其它供应商；Pi 的 vision 工具还会直接读本机
  文件)，Claude Code 的工具循环复核也不对受邀者开(复核用 B 的辅助模型)，疑似循环按缺省中断。Pi 受邀者的 env 只留
  分享的供应商引用到的变量(api key 与请求头)。同一任务重新打开时，迟到的旧实例不再登记出站边界。
- **受邀者选模型(真机反馈补)**：模型列表与发送前检查还要读分享者电脑的 Agent 能力、可用 Agent 与 Agent 就绪；
  分享者电脑对受邀者放行这三项只读请求并按分享的供应商收窄(能力只留它的模型、可用 Agent 只留它支持的、就绪只回
  `binaryReady`，不带分享者自己的登录状态)。此前只放行模型目录，受邀者点了分享来的模型也选不上。两边都要更新到含此修复的版本。
- **供应商设置**：「分享给我的供应商」从页面底部移进左栏，与自己的供应商同列、单独成组；右栏显示来源、状态、对方
  开放的模型与「退出」。管理分享的入口图标改为分享图标。
- **供应商设置(真机反馈二补)**：「输入分享链接…」移到页面右上角(点开弹窗)，左栏组末的粘贴行与空态说明去掉；
  没有分享时「分享给我的供应商」整组不显示；自己其他电脑上能用的远程供应商也列进左栏(远程角标，悬停提示写所在电脑；只读详情)。
  分享者电脑版本太旧、答不了 Agent 能力时，受邀者的模型列表直接提示「请让对方更新 Cindy」，不再只报读取失败。
  加入页「唤起失败」的指引文案(服务端)需改成新入口名。
- **受邀者读分享的模型目录(真机反馈三补)**：设置页详情与模型选择器读分享者电脑时，先建到那台的后台链路再请求，与远程 Agent、
  手机代读同一条路。relay 只在 link-open 时把受邀者的这台电脑登记进成员，没建过链的电脑(新装、换了设备 id 的开发版)直接
  invoke 会被回 `DEVICE_OFFLINE` / `providerShare peer unavailable`，此前表现为「状态正常却一个模型都读不到」。
- **待产品决定**：受邀者能看到分享者电脑的设备名(macOS 默认是「<全名>的 MacBook」，可能含真实姓名)。
  任务运行中途被拒绝、或轮询放弃时，个别错误仍是同账号文案(「到那台电脑上打开…」)。
- **P3 客户端**：凭证只在内存，不落盘；本机只记不含凭证的区域标记，没有标记的账号从不联系对方区域；对方区域请求
  不带本区域 Access Token、不因对方 401 登出。详见契约 §6.4。

## 1. 架构总览

```
受邀者电脑 A（任务、文件、命令）                    分享者电脑 B（Agent、登录、供应商）
  模型列表：分享来的供应商 ──┐                        ┌── 管理页 / 审批弹窗
  remote-agent controller ──┼── relay（providerShare 范围）──┼── remote-agent host（按分享核对）
  REST：申请 / 已收到的分享 ─┘         │                    └── REST：链接 / 审批 / 成员
                               device-link-server
                     ProviderShare* 表 · 链接与申请 · 成员状态 · 路由授权
```

关键设计决定：

| # | 决定 | 原因 |
|---|---|---|
| D1 | 新增独立的 relay 范围 `providerShare`（与 `sharedTask` 并列），能力名 `provider-share-v1` | 两者授权对象不同；B 上共享任务访客的白名单不能因此放宽。复用 sharedTask 的实现模式：relay 按已验证账号改写来源、超长本地 peer key、能力协商 |
| D2 | 服务端是成员关系权威（成员、暂停、删除）；B 是使用范围与用量权威，每次 `open / send / steer / setModel` 都核对 | 与产品规则 §9.3 一致。暂停放在服务端成员状态，受邀者不连 B 也能看到「已暂停」，relay 可直接拦截 |
| D3 | 待审批申请存在服务端新表，B 在线时定时拉取（与共享任务一致约 5 秒），上线时立即拉一次 | 服务端目前没有存起来、等对方上线再送达的机制，也没有服务端主动推送的业务事件；不为此新增推送通道 |
| D4 | 分享不随 B 离线关闭（不同于共享任务离线 60 秒后关闭） | 分享是长期关系；B 离线时受邀者只看到「不在线」 |
| D5 | relay 看不到 invoke 的 channel（对 relay 不透明），channel 限制完全由 B 执行：只放行 `maker:remote-agent:v1` 与按分享过滤（并去掉分享者账号身份）的 `maker:provider:list`，订阅与 push 全部拒绝（实施时去掉了 `maker:get-capabilities`，远程 Agent 用自己的 `caps` 操作） | 远程 Agent 只用 poll，不需要 push |
| D6 | ~~A 上任务绑定新增 `agent_provider_share_id`~~ 实施改为不改 schema：`agent_device_id` 记 `share:<shareId>`（≤128 字符，见 §0） | 现有列有 128 字符正则校验；旧版本读到它按连不上的电脑处理 |
| D7 | **身份名片**：auth-server 新增接口，只用调用者自己的登录凭证签发自己的短期签名名片（**只含昵称和头像**，另有验签用的账号标识与绑定信息，不展示），绑定用途与本次链接；分享者生成链接、受邀者发送申请时各自附上，device-link-server 验签后存快照，只给这次分享的另一方看 | 没有、也不新增「查别人资料」的接口；邮箱、手机号（含脱敏）、组织、区域都不进名片、不进 device-link-server（2026-10-07 裁决：只展示昵称和头像）；签名防伪造，短期加绑定防挪用；同区域、跨区域同一种名片 |
| D8 | 跨区复用 D7 的名片：分享者区域 device-link-server 额外信任对方区域 auth-server 的公钥，只用于验名片；分享建立后签发只限该分享的连接凭证 | 同区域、跨区域只差验签用哪个区域的公钥，逻辑只有一套 |
| D9 | 链接 5 分钟过期、不限次数生成、分享人数不限；不做未使用链接的列表与撤回 | 有效期越短，链接泄露的窗口越小；口令 256 位随机且只存摘要，猜不中；生成次数只受服务端已有的写操作限流约束 |

## 2. 分期

| 期 | 内容 | 依赖 | 可独立上线 |
|---|---|---|---|
| **P0 安全加固** | B 对受邀者的输入与托管运行做隔离（只对跨账号受邀者生效） | 无 | 是，先于一切跨账号开放 |
| **P1 同区域 MVP** | 链接、申请、审批、成员管理、用量、受邀者使用（Desktop） | P0 | 是（服务端先于客户端） |
| **P2 Mobile 补齐** | 手机端模型列表显示分享来的供应商与来源后缀、错误提示 | P1 | 是 |
| **P3 跨区域** | 身份名片跨区验签、跨区连接凭证、双区域链接、合规开关 | P1 + 合规确认 | 由服务端开关控制 |

## 3. P0 安全加固（客户端）

现状：远程 Agent 把发起方当作已认证的同账号设备，很多过滤只在发起方电脑上做。开放给其他账号前必须
在 B 上补齐。**全部只对 providerShare 受邀者生效，同账号远程 Agent 行为不变**（尤其 Pi，受
`docs/dev-rules/pi-harness.md` 原生能力非退化红线约束）。

P0 拆成两部分。受邀者身份由 `RemoteAgentHostDeps.controllerTrust` 判定（P1 接入 providerShare
范围前，生产接线不提供它，全部按同账号处理），受邀者路径目前只经单测覆盖。

**P0a（已实现，2026-10-07，未提交）**

| ID | 工作项 | 实现 |
|---|---|---|
| C0-1 | B 上按白名单复核受邀者的打开载荷 | `remote-agent/host/guestIsolation.ts`：只接受说明文件、Skill / 子代理 / 命令 / 提示词模板与 Claude Code 项目设置；设置只留 allow / deny / ask（hooks、`env`、`apiKeyHelper`、状态栏命令一律丢弃，后两者可把本机请求转走、偷 Key）；frontmatter 声明 hooks 的 Markdown 丢弃；`!` 预执行语法断开。白名单常量移到 `wire.ts`，与控制端收集共用 |
| C0-1b | 说明文件里的 `@` 引用 | 指向会话目录之外的 `@路径` 改成代码样式（否则 Claude Code 会在本机读文件拼进上下文），代码块与行内代码不动 |
| C0-1c | 会话目录之外的 CLAUDE.md | Claude 受邀者会话的 flag settings 加 `claudeMdExcludes`，排除会话目录以上每一级的 CLAUDE.md、CLAUDE.local.md 与 `.claude/rules`（如本机家目录里的 CLAUDE.md） |
| C0-1d | hooks 兜底 | Claude 受邀者会话的 flag settings 加 `disableAllHooks: true` |
| C0-2 | ~~受邀者不带可信标记~~（已撤回） | 按对齐原则保留与同账号一致的发送选项，见 §0 |
| C0-3 | 本机托管技能 | Claude 受邀者会话不加载本机安装的托管技能，不读本机的技能停用偏好 |
| C0-4 | 只开放已隔离的 Agent | 由 `GUEST_SUPPORTED_AGENTS` 控制；P0b 完成后三种 Agent 都已开放（见 §0） |
| C0-5 | 附件目录按发起方隔离 | `attachments/<控制端目录>/<runId>`（同账号同样适用，纯内部路径） |
| C0-6 | 恢复只能接回自己的会话 | 受邀者建立过的本机会话 id 落盘登记（`<runsRoot>/guest-sessions.json`），恢复别的 id 回 `REMOTE_AGENT_INVALID`；重启后仍有效 |
| C0-7 | 清理受邀者留下的数据 | `host.purgeController`：结束任务，删除影子工作区、附件、会话登记，并删除 Claude Code 项目目录里对应的会话记录（`host/transcripts.ts`）；`host.abortController` 立即结束任务。P1 在暂停／删除成员时调用 |
| C0-8 | 测试 | `__tests__/guestIsolation.test.ts`、`guestHost.test.ts`、`transcripts.test.ts`；maker-core `device-hosted.test.ts`、`claude-code/__tests__/device-hosted-guest.test.ts`；每项都有「受邀者被拦、同账号不变」的成对用例 |

**P0b（已完成，见 §0）**

| ID | 工作项 | 说明 |
|---|---|---|
| C0-9 | Codex 受邀者隔离 | 关闭本机插件 MCP、hooks、apps、remote_plugin、技能与用户 AGENTS.md（可复用 review 模式的关闭逻辑，但要保留经隧道的 MCP），会话记录清理；需用真实 Codex 端到端验证后再放开 C0-4 |
| C0-10 | Pi 受邀者隔离 | 不加载本机原生包、扩展、托管技能与全局说明，不加载项目扩展；会话记录清理；同样需真实 Pi 端到端验证 |
| C0-11 | 插件清单与通讯录说明 | Claude 托管会话目前仍把本机的插件清单（ghost roster）和通讯录说明拼进 system prompt。受邀者会话应去掉；这属于 system prompt 拼接改动，按 `maker-core-and-agent-behavior.md` §4 需先经维护者确认 |
| C0-12 | 真实验证 | 用真实 Claude Code 验证：受邀者项目里的 hooks、`env`、`apiKeyHelper`、`!` 命令、`@` 外部引用、家目录 CLAUDE.md 都不生效（Windows 上 `claudeMdExcludes` 的路径写法需实测） |

WebFetch、WebSearch 等联网工具不单独处理，与同账号远程供应商的现行逻辑一致（2026-10-07 裁决）。

## 4. P1 同区域 MVP

### 4.1 服务端（cindy-server）

| ID | 工作项 | 位置 | 说明 |
|---|---|---|---|
| S1-1 | 协议包新增 providerShare 范围 | `packages/device-link-protocol/src/providerShare.ts`、`protocol.ts` | `PROVIDER_SHARE_RELAY_CAPABILITY = 'provider-share-v1'`；`ProviderShareScope { shareId, target, source? }`，`source` 只由 relay 写入；`Envelope.providerShare?`；校验函数与 sharedTask 同一套 fixture 风格 |
| S1-2 | 数据表与 migration | `device-link-server/prisma/schema.prisma`、新 migration、`src/lib/migrationGate.ts`（硬编码 migration 名单需追加） | 见 §4.3 数据模型 |
| S1-3 | REST `/api/device-link/provider-shares` | 新建 `src/provider-shares/{router,service,repository}.ts`，挂载在 `app.ts` | 复用 `requireAuth`、设备绑定的 `actor()`、拒绝多余字段、`no-store`、advisory lock 事务（先分享者后受邀者）、写操作限流。接口见 §4.4 |
| S1-4 | auth-server 身份名片接口 | `auth-server/src/routes/me.ts` 新增如 `POST /api/me/identity-card`；`src/lib/jwt.ts` 新令牌类型 | 只用调用者自己的凭证签发：`typ: 'identity-card'`、`sub`、昵称、头像 URL、`aud`（目标区域的 provider-share）、`purpose`（`share-link` / `share-request`）、`nonce`（绑定本次链接）、有效期约 5 分钟；不放邮箱、手机号（含脱敏）、组织、区域；RS256，沿用现有 JWKS；按账号限流 |
| S1-5 | device-link-server 验名片 | provider-shares service | 验签（本区域 issuer 的 JWKS）、`aud`、`purpose`、`nonce`、有效期；同区域时要求名片 `sub` 等于请求凭证的 `sub`；验过后存为快照。不接受客户端自报的任何身份字段 |
| S1-5a | 配对码 | provider-shares service | 发送申请时用 `crypto.randomInt(0, 10000)` 生成 4 位数字（补零）存入申请行；只在申请人的申请响应、申请状态查询与分享者的待审批列表里返回；不进日志、通知或加入页；不参与任何鉴权 |
| S1-6 | relay 路由 | `src/device-link/wsServer.ts`、新建 `src/provider-shares/routing.ts` | 仿 `resolveSharedTaskRoute`：受邀者→分享者只允许 link-open / link-close / invoke / push（仅 transport-ack），要求成员为 active、设备已绑定（首次 link-open 自动登记受邀者的新设备，设备数设上限）；分享者→受邀者只允许 link-accept / link-close / invoke-result / push；来源改写为 `{role, memberId}`；双方都须声明能力，缺失回 `VERSION_MISMATCH`；跨实例 Redis bus 携带并复验授权；hello-ack 声明能力 |
| S1-7 | 分享者在线状态 | provider-shares service | 「已收到的分享」列表附带分享者设备在线状态（读 presence），供受邀者显示「不在线」 |
| S1-8 | 过期处理 | 复用 30 秒扫描；接口内也按 `expiresAt` 即时判定 | 链接 5 分钟、申请 24 小时到期置为 expired；不做 B 离线关闭 |
| S1-9 | 公开加入页 `/provider-share/join` | 仿 `src/routes/sharedTaskInvitation.ts` | 口令在 `#` 后；电脑上唤起 `cindy://provider-share/join?invitation=…&server=…`；手机浏览器不唤起 App，只提示「请在电脑上打开这个链接」并提供复制链接；五种语言、深浅色、严格 CSP |
| S1-10 | 文档与测试 | `docs/device-link-server.md` 新增章节；仿 `sharedTask{Routes,Service,Routing,Invitation}.test.ts` 与 integration 测试 | 包括链接只能用一次的并发用例（两人同时申请只有一人成功） |

### 4.2 客户端（cindy）

**共享 packages**

| ID | 工作项 | 位置 | 说明 |
|---|---|---|---|
| C1-1 | 协议包镜像 S1-1 | `packages/device-link-protocol` | 与服务端同 fixture |
| C1-2 | 范围编解码与 peer key | `packages/device-link/src/providerShare{Envelope,Peer}.ts`，接入 `client.ts`（约 2140、3248、2400 行） | 本地 peer key 超过 128 字符，不会与真实设备 ID 碰撞；只在 socket 边界编解码 |
| C1-3 | 链接解析与 REST 客户端 | `packages/device-link/src/providerShareInvitation.ts`、`providerShareApi.ts` | 从 `sharedTaskInvitation.ts`、`sharedTaskApi.ts` 抽出通用部分（路径、参数名、可接受的服务地址做成参数） |
| C1-4 | 统一「范围连接」判断 | `apps/desktop/src/main/device-link/dispatch.ts` 等 | **风险点**：现在所有 `!isSharedTaskPeer(src)` 分支都把其他调用方当同账号。先引入 `isScopedPeer`（共享任务 + 供应商分享），逐处替换并补测试，再接入新范围 |

**分享者（B，Desktop main）**

| ID | 工作项 | 位置 | 说明 |
|---|---|---|---|
| C1-5 | 分享运行时 | 新建 `main/device-link/providerShare{Runtime,Host,Access}.ts`，仿 `sharedTaskRuntime.ts` / `sharedTaskHost.ts` | 定时拉取成员与待审批申请；维护代次；成员被暂停或删除时立即撤权 |
| C1-6 | dispatch 准入 | `dispatch.ts`（link-open 约 2488 行、invoke 约 3816-3892 行） | 新增 `runProviderShareInvoke`：只放行 D5 的三个 channel；`maker:provider:list` 只返回该成员被分享的供应商；push 全拒；三级能力（允许远程控制、允许被远程调用、分享）任一未开启即拒绝 |
| C1-7 | remote-agent host 按分享授权 | `remote-agent/host/runHost.ts`、`service.ts`、`providerAccess.ts`、`remote-provider-access-store.ts` | 发起方 key 解析为（账号、成员、设备）；`isControllerAuthorized(key)` 核对成员状态与三级能力；`providerAccess` 按 key 只允许该分享的供应商，不再「没指定就任选」；`send / steer / setModel` 都复核；新增按分享的运行数上限；新增 `host.revoke(predicate)`，暂停或删除时立即 `finishRun(..., 'access-revoked')` 并清理上传 |
| C1-8 | 按受邀者、按模型记录用量 | `runHost.ts` `pumpEvents`（约 609 行）；新表（Desktop migration 0124） | 托管运行在 B 上不建任务、目前不记用量。从 `done` 事件取用量：Claude 的 `modelUsage` 是累计值，需用 `computeModelUsageDeltas` 算增量；Codex、Pi 按轮。金额用 `turnCostCalculator`，订阅类标注估算。按（分享、受邀者、模型、日期）聚合 |
| C1-9 | 审批弹窗与系统通知 | renderer 新弹窗（复用 `confirm-dialog.tsx` 结构）；`notificationService.ts` 增加通用的导出方法 | 应用在后台时发系统通知，点击打开审批弹窗；弹窗显示配对码与「同意前可以问对方一句他看到的配对码」；系统通知不含配对码 |
| C1-10 | 设置入口 | `ProvidersSection.tsx`（`RemoteProviderAccessRow` 约 146-186 行、隐藏逻辑约 3114-3123 行） | 这一行始终显示；开关左侧加「管理分享」图标（Tip + 无障碍名称，待处理时带提示点）；能力未开启时不可点并提示；`useRemoteControlEnabled` 改为订阅变化；说明文字改为覆盖分享的人 |
| C1-11 | 分享管理页 | 设置子页面，参照 `?openPanel=` 的返回式子面板 | 生成链接（弹窗显示 5 分钟倒计时与重新生成）、待处理（只有待审批申请）、已分享的人、按模型用量（近 7 天、本月、全部）、关闭、恢复、删除（二次确认）；按交互稿实现浅色与深色 |

**受邀者（A，Desktop）**

| ID | 工作项 | 位置 | 说明 |
|---|---|---|---|
| C1-12 | 深链与申请弹窗 | `main/deepLink.ts`（解析、日志脱敏、argv 正则）、preload、`MainLayout.tsx` | 新增 `provider-share/join`；先用身份名片调 preview，弹窗四态：确认申请（含「你的昵称和头像会展示给对方」）、等待同意（显示配对码）、已同意、链接已失效（已被使用或已过期）；发送申请时附上自己的身份名片；未登录时登录后继续 |
| C1-13 | 已收到的分享接入模型列表 | `useDevicesProviders.ts`、`ModelSelector.tsx`（`remoteAgentLabelOf` 约 1551 行、分组标题约 3227 行）、`UnifiedModelPanel.tsx`、`UnifiedModelRail.tsx` | 分享来的供应商作为额外「设备」、以 scoped key 标识进入现有远程区域；标题用新 i18n key `{{provider}} · {{device}} · 来自 {{sharer}} 的分享`；暂停、离线时置灰并显示原因 |
| C1-14 | controller 连接分享者 | `remote-agent/controller/{service,deviceCatalog,deviceRouteCheck}.ts`、`main/device-link/index.ts`（约 720、1654、1807 行） | poller 以 scoped key 区分；不走 p2p 加速；新增分享者探测；目录读取改为经分享范围的 `maker:provider:list` |
| C1-15 | 任务绑定 | Desktop migration 0124（与 C1-8 同一次或相邻）；`localDb/schema.ts`、`ipc/sessions.ts`、`mapper.ts`、`session-storage.ts`、`register.ts`（`readSessionAgentDeviceId`、`assertAgentDeviceRouteUsable`）、`sessionAgentSwitchHandler.ts`（第 7 参增加 `providerShareId`）、maker-core `SessionMeta` | 同时检查任务迁移（`task-migration/service.ts`）与分享导出（`sessionShareExport.ts`）对新列的处理 |
| C1-16 | 错误提示与换模型 | `packages/device-link/src/remoteAgent.ts`（错误码）、`shared/ipc-errors.ts`、`lib/makerChatStore.ts`、`ErrorBanner.tsx`、`CCAgentSessionView.tsx` | 新增分享已暂停、已删除、分享者不在线、暂时不可用四种原因；横幅加「换成其他模型」，需要新增从外部打开模型选择器的方法 |
| C1-17 | 退出分享 | 受邀者侧入口 + REST | 退出后需重新获得链接 |

**通用**

| ID | 工作项 | 说明 |
|---|---|---|
| C1-18 | i18n 与术语 | Desktop 五种语言 `common.json`；在 `i18n/glossary.json` 登记「供应商分享」等 `proposed` 条目；跑 `pnpm check:i18n-glossary` |
| C1-19 | 规则文档同步 | 修订 `docs/dev-rules/protocol-compatibility.md`「远程 Agent」中「只进同账号 allowlist」的表述，补充 providerShare 范围的协议说明 |

### 4.3 数据模型（服务端草案）

- **ProviderShare**：`shareId`、`ownerAccountId`、`hostDeviceId`、`providerId`、供应商与设备名称快照、
  `status (active | deleted)`、时间戳。同一（分享者、设备、供应商）最多一个 active。
- **ProviderShareMember**：`shareId`、`guestAccountId`、`memberId`（唯一）、身份快照（只有昵称、头像），
  `status (active | paused | removed | left)`、`version`、`deviceIds[]`、
  `approvedAt`。行保留为墓碑，不物理删除。
- **ProviderShareLink**：`digest`（主键，口令 sha256）、分享者、设备、供应商、分享者身份名片快照、
  `expiresAt`（生成后 5 分钟）、`state (unused | requested | consumed | rejected | withdrawn | expired)`。
- **ProviderShareRequest**：`requestId`、`linkDigest`（唯一，保证一个链接只有一个申请）、申请人身份名片快照、`pairingCode`（4 位数字）、
  `status (pending | approved | rejected | withdrawn | expired)`、`expiresAt`（提交后 24 小时）、`decidedAt`。

不设人数与链接数上限。防刷只靠服务端已有的写操作限流（按账号）；preview 与申请接口另按账号限流，
防止撞库式试口令（口令 256 位，实际猜不中）。过期链接与申请定期清理。

### 4.4 REST 接口（草案）

| 调用方 | 方法与路径 | 作用 |
|---|---|---|
| 分享者 | `GET /provider-shares` | 本设备的分享、成员、待审批申请（含配对码） |
| 分享者 | `POST /provider-shares/links` | 附自己的身份名片，生成链接，返回口令与到期时间 |
| 分享者 | `POST /provider-shares/requests/:id/approve` · `/reject` | 同意或拒绝；拒绝后链接作废 |
| 分享者 | `POST /provider-shares/members/:memberId/pause` · `/resume` · `/remove` | 关闭、恢复、删除 |
| 受邀者 | `POST /provider-shares/preview` | 凭口令查看分享者身份名片快照与供应商，不锁定链接 |
| 受邀者 | `POST /provider-shares/requests` | 附自己的身份名片发送申请，锁定链接，返回 `requestId` 与配对码 |
| 受邀者 | `GET /provider-shares/requests/:id` · `POST …/withdraw` | 查看状态、撤回申请（链接作废） |
| 受邀者 | `GET /provider-shares/received` · `POST /provider-shares/received/:memberId/leave` | 已收到的分享（含分享者在线状态）、退出 |

口令只放请求体，不进 URL 与日志。错误码：`PROVIDER_SHARE_LINK_USED`、`_LINK_EXPIRED`、
`_SELF`、`_ALREADY_MEMBER`、`_IDENTITY_INVALID`（名片无效或过期）、`_NOT_FOUND`，P3 增加
`_CROSS_REGION_DISABLED`。

## 5. P2 Mobile 补齐（客户端）

手机不直接运行远程 Agent，只请它控制的电脑换 Agent 位置；手机目前直接读其他同账号电脑的目录，
但读不到其他账号的分享。

| ID | 工作项 | 说明 |
|---|---|---|
| C2-1 | 电脑向手机提供「已收到的分享」目录 | 新增经同账号设备互联读取的 channel（进同账号 allowlist），由被控电脑代读 |
| C2-2 | 手机模型列表 | `useRemoteAgentCatalogs.ts`、`remoteAgentCatalogs.ts`、`UnifiedModelPickerSheet.tsx` 接入分享目录与来源后缀；`models.json` 各语言 |
| C2-3 | 错误文案 | `agentErrorI18n.ts`、`session.json`，与 Desktop key 一致（`AgentErrorLocalization.test.tsx` 守护） |
| C2-4 | 手机打开分享链接 | `+native-intent.ts` 识别 `provider-share`，只提示「请在电脑上打开这个链接」，不提供申请；只改 JS，不触发冷更 |

手机审批与管理属于产品规则 §12 的后续可选项，不在本期。

## 6. P3 跨区域

| ID | 仓库 | 工作项 | 说明 |
|---|---|---|---|
| S3-1 | 服务端 auth-server | 身份名片支持对方区域 | S1-4 的名片允许 `aud` 为对方区域的 provider-share，其余不变 |
| S3-2 | 服务端 device-link-server | 信任对方区域签发者 | 配置对方区域 issuer 与 JWKS；只用于验身份名片（preview 与发送申请），不接受对方区域的普通登录凭证 |
| S3-3 | 服务端 device-link-server | 分享连接凭证 | 同意后为受邀者签发只限该分享的凭证；WebSocket 升级接受这种凭证，带它的连接只能发 providerShare 范围的帧，不能访问任何其他接口 |
| S3-4 | 服务端 | 合规开关 | 如 `PROVIDER_SHARE_CROSS_REGION_ENABLED`，关闭时回 `PROVIDER_SHARE_CROSS_REGION_DISABLED` |
| S3-5 | 服务端 | 网络评估 | 中国大陆访问 Global 服务的连通性；必要时区域间转发 |
| C3-1 | 客户端 | 接受两个官方区域的链接 | 链接解析返回匹配的区域；地址只从内置的两区域官方地址表取（`clientEndpointsService.ts` 的 `getClientEndpointForRealm`），不接受链接携带的任意地址 |
| C3-2 | 客户端 | 第二条设备互联连接 | 对分享者区域另建 `DeviceLinkClient`（用分享连接凭证与对方区域地址）；凭证只放主进程内存或凭证存储，遵守 `credentials-and-local-storage.md` |
| C3-3 | 客户端 | 跨区身份名片 | 向本区域 auth-server 申请 `aud` 为对方区域的名片，用于 preview 与申请 |

开工前置：**公司合规确认**跨境内容流动与跨区模型使用。

## 7. 上线顺序与兼容

1. 服务端：数据库 migration → relay 与 REST（hello-ack 声明 `provider-share-v1`）→ 加入页。
2. 客户端：只有 relay 声明能力后才显示分享入口；B 未声明能力时，A 提示对方需要更新 Cindy。
3. 旧客户端不受影响：没有 providerShare 范围的帧仍按同账号路由。
4. relay 新增范围属于协议变更，按 `protocol-compatibility.md` 声明升级窗口，两仓同一套有效／无效 fixture。
5. Desktop migration 0124 只追加新表和新列；实施前读 `database-and-migrations.md` 与
   `multi-account-database-architecture.md`，基于最新 `origin/main` 生成序号。

## 8. 验证

- 单测：服务端照搬共享任务的测试套件结构；客户端每个准入点都有「受邀者被拦、同账号不变」的成对用例。
- P0 专项：构造恶意 open 载荷（带 hooks 的项目设置、Pi 扩展、`resumeSessionId`、伪造的可信标记），
  确认 B 上不执行。
- 身份名片专项：篡改名片字段、过期名片、用途或 nonce 不符、同区域 `sub` 不一致，均被拒绝。
- 配对码专项：受邀者与分享者看到的配对码一致；通知、日志、加入页中不出现；不同申请互不相同的概率符合 4 位随机数预期。
- 真实双账号联调（参照共享任务的做法）：两个 Electron 开发客户端、不同账号、隔离的 auth、device-link、
  PostgreSQL、Redis；走完生成链接、预览、申请、离线审批、同意、使用、暂停、恢复、删除、退出、
  链接重复使用被拒全流程，每步保存截图。
- 跨区联调需要两个区域的测试环境，P3 再做。
- 提交前：`pnpm test:unit:related`，相关 package 类型检查；服务端按其仓库规则。

## 9. 已确认（2026-10-07）

1. 不限分享人数；链接 5 分钟过期、不限次数生成，不做未使用链接管理；申请提交后 24 小时内有效。
2. 申请只能在电脑上完成，手机打开链接只提示到电脑上打开。
3. WebFetch、WebSearch 等联网工具与同账号远程供应商一致，不单独处理。
4. 身份只展示昵称和头像，用 auth-server 签发的身份名片（D7）；不展示也不收集邮箱、手机号（含脱敏）、组织、区域；不新增、也不使用任何查看他人资料的能力。
