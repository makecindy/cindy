# Codex 鉴权适配器差异分析（m1-cp19 裁定）

2026-11-14。首次采集以 [#10469](https://github.com/makecindy/cindy/pull/10469) 的 `4f95780546` 为准（下文“比较口径”到“共用方式的建议”保留首次采集的分析，供追溯）；m1-cp19 按审核方裁定换成完整装配的对照、加入口枚举、重新采集，并对齐两处，结果见下一节。

## m1-cp19：裁定、重新采集与对齐

**入口枚举**（`packages/maker-core/src/agents/codex/__tests__/authAdapterEntryInputs.ts`，由 maker-core `index.test.ts` 走真实 `CodexAgent` 核对）：会话（各类来源）、模型刷新（按宿主的调用方式）、账号额度、无凭据 Skill 发现交给适配器的输入只有五种：不指定来源 × {未指定、gateway-key、oauth-bearer、provider-oauth}，以及独立账号 × oauth-bearer。具名来源（xd、cindy、openai、自定义）在 maker-core 里先归一成模式，不会原样传给适配器。

**完整装配的对照**（`hostCodexAuthAdapterParity.test.ts`）：Host 侧按 `createHostAgentGraph` 的装配建适配器，带账号服务与系统登录对账；安装态（桌面 isPackaged，Host 的系统登录为夹具 HOME 里的 `~/.codex/auth.json`）与源码态（桌面未打包，Host 不对账）各一组。事实在原来 24 组上加“系统登录有无”，共 48 组；2 组装配 × 48 × 5 个来源 × 4 种模式 = **1920 格**。

重新采集（对齐之前 → 之后）：

| 范围 | 对齐前不同 | 对齐后不同 | 剩下的类别 |
|---|---:|---:|---|
| 安装态，可达输入 | 106 | **58** | 只有 API key 的 auth.json 且无网关 key（3）；两边都拒绝时的 errorReason（2）；identity 文案（29）；OAuth 原始环境里的网关 key（24，最终环境相同） |
| 安装态，不可达输入 | 653 | 653 | 具名来源，随 M2 |
| 源码态，可达输入 | 192 | 192 | 全部带桌面开发版专有的 `oauthWritesBlocked`；另有桌面开发版对系统登录的对账（Host 源码运行不对账，放行表“与系统 Codex 登录对账”） |
| 源码态，不可达输入 | 768 | 768 | 同上加具名来源 |
| 可达且两边都放行的格子，最终进程环境不同 | 9 | **0** | — |

原来的 D、E 两组里“未绑定但桌面可认领”的差别，在完整装配的安装态下不再出现：Host 的系统登录对账同样认领，矩阵简化工厂（不注入账号服务与系统登录）造成了那部分差别。

**对齐（m1-cp19，先红后绿）**：

1. 不指定来源的 provider-oauth：Host 的 getState 按模式放行（`Provider OAuth · Proxy`，api-key），getAuthEnv 给网关 key、没有时给占位 key，与桌面相同；默认 Codex 登录被作废不再拦住第三方任务。供应商的真实凭据仍由 Host 的 Codex 回环代理按路由注入，代理的入站条件、模型与路由准入、代理就绪检查都不变；占位 key 本身不是凭据。具名来源的 provider-oauth 不可达，仍随 M2。
2. 独立 Codex 账号的目录：getAuthEnv 先识别独立账号（`openai` 除外），返回账号目录，再处理 nativeSubscriptionAccount 与 oauth-bearer；两种参数形式都返回账号目录。真实 Codex 在 Host 上以独立账号起任务可达，`codex-runtime.e2e.mjs` 断言线程历史与 SQLite 在账号目录；改之前它们落在 profile 的 codex-home。账号目录里的 Skill 投影（`prepareCodexAccountHome`）属于第 25 行，这次不接。

**归属（审核方裁定）**：上面两处为 M1，已对齐；具名来源的连接态（B）、xd/cindy 来源优先（C）、控制入口与账号视图（D 的相应部分）、identity 与连接诊断随 M2 供应商视图；只有 API key 的 auth.json 且无网关 key、OAuth 原始环境里的网关 key 两项长期保留（放行表各一行）；401 恢复仍未定，见最后一节。

## Windows（2026-11-14）

对照测试第一次在 Windows 上跑到断言时（#10506 的 CI），桌面与 Host 的差别比 macOS/Linux 多。没有新的差别类别，Host 也没有缺少桌面的哪一支：

- **原因**：profile 里已经有一个普通的 `auth.json`、本机又有系统 Codex 登录时，Windows 上两边都保留这个文件，不改成指向系统登录的链接（桌面 `auth-adapters.ts` 与 Host `codex-system-login.ts` 都是 `process.platform === 'win32' && topology.linkType === 'file'` 这一支）。macOS/Linux 在同样情形下会改成链接，两边一起用系统登录。
- **受影响的事实**：只有“profile 里有自己的 auth.json（OAuth 或只有 API key）、有系统登录、没有 openai 绑定、没有作废标记”这一种，网关 key 有无都算。
- **落进的已有类别**：
  - 安装态可达输入多出 2 格。“只有 API key 的 auth.json 且无网关 key”由 3 格变 4 格：两边都起不了任务，Host 更早失败，见放行表同名一行。identity 文案多 1 格（M2）。
  - 安装态不可达输入：具名来源（M2）。
  - 源码态：桌面开发版的写保护与它对系统登录的对账（Host 源码运行不对账）。
- **诊断数**：桌面设置页的诊断在 Windows 上是 720 格（macOS/Linux 760），Host 仍为 0。
- **测试的分法**：对照测试开头用桌面建链接的同一个函数（`relinkSharedCodexAuth`）在临时目录里试一次，按结果选表，结果写进用例名：
  - 非 Windows 且能建链接：原表；
  - Windows 且能建链接：原表加 Windows 的格数（`WINDOWS_COUNTS`），诊断 720；
  - 建不了链接（Windows 未开开发者模式）：没有记录表，显式跳过表的比较；Host 不产生诊断、总格数、可达格子的最终进程环境相等照常断言。
- **来源与局限**：Windows 的格数来自 CI 日志（vitest 对报错相同的用例只打印一份差异，10 组里看得到 6 组），以及本机把 `process.platform` 设为 win32 跑这个测试（10 组都有，看得到的 6 组与 CI 逐键相同；让 symlink 抛 EPERM 则 0/6 相同，所以 CI 的 Windows runner 能建链接）。本机模拟里桌面建链接走的是兜底重建（PowerShell 移动文件只在真实 Windows 上有），结果同样是链接。可达格子的最终进程环境在模拟中全等，真实 Windows 上以 CI 为准。

## 比较口径（首次采集，m1-cp18e 矩阵）

对象是 `DesktopCodexAuthAdapter` 与 `createCodexLocalCliAuth` 的 `getState` / `getAuthEnv`，起点为 `hostCodexAuthAdapterParity.test.ts` 的原有矩阵。网关 key 有/无 × auth.json 为 OAuth/API-key/不存在 × OpenAI 绑定有/无 × 作废标记有/无，共 24 组事实；再乘 5 个 providerId、4 个 credentialMode，共 **480 格，389 格不同，91 格相同**。

这里的“不同”是适配器返回值不同，不等于 389 个任务失败：

- 172 格的 `authenticated` 不同；168 格的环境字段不同；77 格只有 `identity` 不同。这些统计交叠，不能相加。
- 适配器矩阵在 state 为 false 时仍继续调用 getAuthEnv。真实 `CodexAgent.createHost` 会先检查 state，失败时不会走到 env/spawn。
- Desktop 的 `credentialDiagnostics` 已从逐格比较中去掉。Desktop 160 格带此字段、Host 0 格，不能把它再加进 389。
- Host 矩阵工厂没有传 `accounts`、`config`、`native.systemLogin`；自定义路由端口恒抛“未连接”。这不能证明实际 Host 所有自定义供应商都未连接，也不能替代完整运行时装配的系统登录对照。
- 两边 getState/getAuthEnv 使用独立的相同文件夹具，不消费真实账号；矩阵没有覆盖独立 Codex 账号 ID、nativeSubscriptionAccount、已连接自定义供应商、安装态/源码态的全部组合。

389 格按以下优先级分组，互不重复：先取 provider-oauth，再按其余 providerId 分组。

| 组 | 范围 | 不同格数 | 含 state 差异 | 含 env 差异 |
|---|---|---:|---:|---:|
| A | 所有 providerId，mode=provider-oauth | 120 | 120 | 60 |
| B | cprov-custom，其余三种 mode | 72 | 72 | 36 |
| C | xd/cindy，其余三种 mode | 120 | 120 | 24 |
| D | openai，其余三种 mode | 42 | 24 | 36 |
| E | providerId 未指定，其余三种 mode | 35 | 24 | 12 |
| 合计 | | **389** | **360** | **168** |

## 先对应真实调用路径

`credential-mode.ts:31` 按来源推导模式：Codex 的 openai 为 oauth-bearer，xd 为 gateway-key，其余显式来源为 provider-oauth；未指定来源时再按模型前缀推导或保留 fallback。

普通任务在 `codex/index.ts:5159` 得到 requestedCredentialMode；`getSessionHost`（约 5272）**只把独立 Codex 账号的 accountProviderId 传进 getHost 的 providerId**。普通 xd、openai、xAI、自定义供应商的原始 providerId 不会按这条路径原样传给适配器。其来源仍影响模式与代理路由。

因此，普通第三方任务常到达的适配器输入是“providerId 未指定、mode=provider-oauth”，不能用矩阵里具名 cprov-custom 那个“未连接”端口结果替代它。该输入的 24 格全部不同，其中 17 格 Desktop 放行而 Host 拒绝、12 格 env 不同，两种差异有交叠。

另有 `withStartedAccountHost`（约 2853）、模型刷新等控制路径可能显式传 providerId；不能反过来把矩阵 B/C/D 全宣布不可达。需要按这些入口确定合同，不根据矩阵的任意笛卡尔积组合扩展凭据接受范围。

## 按机制分类与建议归属

下表引用的文件简称：Desktop=`apps/desktop/src/main/maker-host/auth-adapters.ts`；Host=`apps/host/src/agent/runtime.ts`。编号定位当前版本，后续搬移时应同步更新。

| 类别及涉及组 | Desktop / Host 的实际分支 | 对用户的表现与凭据 | 建议归属、理由与实现方向 |
|---|---|---|---|
| **通用 provider-oauth 分支缺失**（A；普通任务重点是其中 providerId 未指定的24格） | Desktop:1428、1467 按模式直接返回 authenticated=true、authSource=api-key；2478 给网关 key 或供应商占位 key。Host:383–424 没有对应模式分支，可能读本机 Codex 登录、作废标记或退到网关 key；478 只在有网关 key 时给环境键。 | 第三方来源已连接，但没有 Cindy 网关 key、没有默认 Codex OAuth 时，Desktop 能过适配器门禁并带占位 key，Host 在未指定ID时可先报 no_key，或被默认登录的作废标记拦截；有默认 OAuth 但无网关 key时，Host 即使过门禁也可能没有 env_key 所需的键。无关的 Codex 作废标记还可能拦住第三方任务。这里 authSource=api-key 描述 CLI 的凭据形态，不代表上游 OAuth 变成 API key；真正的供应商凭据由现有路由注入，不能把占位 key 当成供应商凭据。 | **迁移前必须对齐，建议 M1**。先拆出模式判定和环境映射的共用主体，再由 Host/桌面绑定读取端口；不复制 Desktop 分支。保留现有模型/路由准入及代理就绪检查，不能仅为了消除差异把所有 Host 来源改成无条件授权。是否改变凭据边界，由复核后决定。 |
| **按 providerId 额外检查连接态**（B，及 A 中具名自定义来源） | Desktop:1429–1431 仅识别独立 Codex 账号，其余主要按 mode 读默认登录。Host:383–392 对具名非内建来源先查 publicViews 的 connected/routing.codex 或 resolveRoute，失败为 not_connected。 | 矩阵的 cprov-custom 恒未连接，故 B 的72格都不同；Desktop 的“通过”只表示默认适配器门禁通过，不证明自定义上游能用。实际 Host 具名来源在视图连接且支持 Codex 时已有放行路径，不能写成“Host完全不支持第三方 OAuth”。拒绝时原始 getAuthEnv 即使返回占位，也没有真的启动子进程。 | **随 M2 供应商视图及来源合同对齐**。普通任务的模式缺口仍按上一行在 M1 处理；具名连接态、路由/历史绑定视图用 M2 的同源服务。先确定哪层负责连接与模型准入，再决定共用主体端口，不能把矩阵的固定未连接桩改成生产结论。 |
| **xd/cindy 来源优先于 mode**（C） | Desktop 的通用 readState 主要按 mode；Host:397 对 xd/cindy 提前返回网关状态，即使 opts.mode 是 oauth-bearer。Host:getAuthEnv 又会在468先按 oauth-bearer返回默认目录。 | 原始混合参数可出现 Desktop 依 OAuth/作废状态而 Host 依网关 key 的结果。规范的 gateway-key 格中，两边 key 与授权结论相同；C 里这类有 key 的24格仅身份文案不同。普通任务通常在上游归一模式，不能把 C 的所有差异都说成真实的来源切换故障。 | **M2 的来源/旧别名合同与视图对齐**；M1 要固定并覆盖普通任务的模式输入。先沿用共用 mode resolver，再决定控制入口如何处理矛盾参数。不要为匹配原始混合组合改变当前凭据选择。最终若证明某组合无生产调用，可保留其低层差异并明确限制，当前不作这种豁免。 |
| **openai 的严格原生分支**（D） | Desktop:1431 把 mode 交给 readState；Host:414 在原生登录无效后，对 providerId=openai 禁止退到网关。env:468 也按 openai 提前仅返 CODEX_HOME。 | `openai + 未指定mode + 只有网关key` 的原始调用，Desktop 可退网关而 Host 拒绝。但普通 openai 任务先归一为 oauth-bearer，不能把它当成正常订阅任务的退化。规范 OAuth 分支中大量 env 差异会被后续共用 spawn 覆盖；未绑定的两格还受矩阵未传 systemLogin 影响。 | **M2 控制入口/账号视图合同**，其中真正的原生授权与 owner 判定属于 **M1 必须核实**。对照应补完整运行时的安装态/源码态端口，先分清能力缺省与策略差异。不能给明确的订阅任务擅自增加网关 fallback。 |
| **默认 fallback 与 API-key 文件**（E 的未指定mode10格） | Desktop:1518–1530 接受能解析的本地 auth.json；没有 OAuth token 时可能 authenticated=true 而不标 authSource。Host:404、408–424 仅把绑定的 OAuth 当作原生授权，随后依赖网关 key。 | 只有 auth.json 的 API key、没有网关 key 时，Desktop 适配器放行而 Host 先报 no_key。受控原生探针使用同一 env-key spawn 配置，原生回合失败为 `Missing environment variable: XDT_CODEX_API_KEY`，模型请求数为0；不是 Desktop 任务成功、Host失败。已有 API key 文件没有自动成为该网关 provider 的 env_key。 | **建议可长期保留更早失败的差异**，但要明确连接展示与错误阶段；需复核认可，不在本轮改代码。不要为了字面 parity 给 Host 新增 API-key 文件取密钥通道。若要改变 Desktop 的连接判定，是另一个可见行为修正。其余默认 fallback 的真实 OAuth 分支按下一行。 |
| **认领、scope、作废/恢复原因**（D/E，A中误走原生的部分） | Desktop:getAccessToken:2562 在认领协调后检查绑定，并给 scope/recovery；Host:399–420 用同源本地状态及自己的 systemLogin。矩阵的 Host 默认 systemAuthPath=null，reconcile 不执行；完整 Host 在 codex-runtime:95 注入实际服务，源码运行仍不探系统登录。 | 未绑定但可被 Desktop 认领的 OAuth 文件，在简化 Host 工厂上可能被拒；scope/reason 还影响“重新连接”提示。不能靠补读真实 HOME 让测试相等，也不能把未知 scope 当作可用登录。M1 已有系统登录/作废对照不等于此矩阵已经覆盖完整装配。 | **迁移前必须核实，M1**。共用已读取事实的判定及必要端口，保持每次读取前后的 owner/代次边界；先补完整装配对照再决定确有差异的格。安装态与源码态的凭据发现边界保持，不复制整个 Desktop 类，不新增全局开关、缓存或轮询。 |
| **网关 key 出现在 OAuth 的原始 env 中**（跨 A–E，168格 env 差异中有60格显式 oauth-bearer） | Desktop:2475 默认把现有网关 key 放入 XDT_CODEX_API_KEY；Host:468 在 OAuth/openai 分支不返回该键。共同 env-builder 继承父环境，再合 authEnv；codex/index:3212 随后合 cfg.extraEnv。`buildCodexCustomProviderArgs:342` 在 oauth-bearer 下提供占位键，覆盖前面的值。 | 在正常完成共用 spawn 准备的 OAuth 路径，两边最终的这个字段都成为供应商占位键；原生 OAuth 的 Authorization 仍来自其选定登录/外部令牌，网关真实 key 由现有代理读取器获取。原始字段缺省不等于从最终进程环境剥除了该键。 | **这部分原始 env 差异可长期保留**，前提是最终产物与路由相同。已用真实 env-builder 和共享补充函数做合成输入观察：OAuth 两边最终相同；gateway-key 两边仍是网关 key；provider-oauth无key的缺口仍存在。不能把168格 env 差异整体豁免，也不为消除测试差异重新给 OAuth CLI 注入真实网关 key。 |
| **identity 与连接诊断**（77格仅identity；160个 diagnostics 另计） | Desktop 给 API Key / Provider OAuth 标签或真实登录身份并附连接拓扑；Host 给 Cindy AI、providerId，或不带身份/诊断。`Maker.getAgentStatus:1983` 透传 identity；`useCodexAuth:98` 还消费 scope/恢复原因/诊断。 | 77格的子进程凭据与布尔门禁不变，但同一客户端可能显示不同身份，不能称“Host没有设置页，所以无影响”。诊断缺省会减少可解释的信息。 | **M2 供应商视图对齐**，实际文件关系由 Host 自己的 profile 产生，不把桌面路径投影到 Host。Desktop 开发模式专有的写保护/诊断可长期不同，但不把影响恢复决定的 scope/reason 一并当作显示差异。无需为这些标签搬整个 Desktop 类。 |

## 共用方式的建议

优先从 Desktop 提炼“模式分支优先级、fallback结果、环境字段映射”的共用主体。端口在需要的分支才读取，尤其 provider-oauth 不应为做一次判定顺带认领或读取默认 Codex 登录。底层本地文件读取 `readCodexLocalAuthState` 已经共用，不再复制一份。

平台保留：Desktop 的资源准备、登录界面/进程与开发模式策略；Host 的 profile、账号服务、owner 寿命检查和读取前后围栏。供应商连接态与具体路由仍用各自装配的同源服务，并按 M2 统一视图。需要改变任何拒绝/接受类别时，先裁定合同，不能把“提取共用代码”当成扩大凭据边界的理由。

普通任务下 provider-oauth 的缺口是优先项；B/C/D 的原始参数组合、显示字段、环境冗余不应与它混为一个“389格全部改相等”的实施目标。

## 矩阵之外，须单列的目录顺序风险

独立 Codex 账号不在这5个providerId里。Desktop:getAuthEnv:2456 先检查 isCodexAccountProvider，取账号自己的目录；Host:getAuthEnv:468 的 oauth-bearer 提前返回在独立账号分支之前，旧参数形式下会返回默认 codex-home。另一方面，传 nativeSubscriptionAccount 描述符时两边都有正确的早返回。

core（约5159）会为独立账号选择 oauth-bearer，并在约5276传 accountProviderId，所以不能仅因普通来源不传 providerId 就忽略它。不过当前尚未用完整 Host 账号准入/描述符组合复现，外部令牌与规范历史目录也可能由其它端口提供；这里不宣称已经发生凭据串用。

首次分析建议归到 M2；审核方裁定为 **M1**（凭据隔离问题，修法是按桌面的顺序），m1-cp19 已对齐，见上文“对齐”第 2 条。它不计入 389。已有跨账号存储 e2e 证明历史与 SQLite 保持原目录，账号令牌的来源仍随 M2 的账号接入核实。

## 可选原生401恢复：仍未定

原用例 `codexAuthTokenReaderBoundary.test.ts:171` 显式设置 CINDY_CODEX_TEST_BINARY 才运行，默认与CI跳过。主干和候选两种池均同样失败；被截取的桌面读取回调逐字相同，不是历史存储共用化回归。

限时调查得到的完整顺序：

1. 当前原生0.166.0向本机模拟服务依次请求 accounts/check、models、ps/mcp、analytics、ps/mcp、settings/user；原夹具均回200与models空对象。
2. 第一次responses带旧合成令牌，得到401/token_expired。
3. 原生发起 account/chatgptAuthTokens/refresh，Cindy成功返回新令牌。外部会话契约会拒绝“刷新后仍是旧令牌”，所以不是原样返回旧值。
4. 从成功返回到失败通知之间，没有再收到任何HTTP请求，也没有第二个responses；原生报 `Fatal error: application network policy is unavailable`。

关闭apps、仅补accounts/check路由响应都仍失败；本机现存0.159.2用相同原用例也在相同位置失败，不能归因0.166升级。第一条请求能到达不证明某个HTTP响应发布了策略；[0.166.0的策略加载代码](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/application_network.rs) 也有本地配置与空cloud组合路径。[拒绝类型](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/http-client/src/network_policy.rs) 与失效/未发布策略相符，但具体遗漏尚未定位。

涉及代码：桌面的createCodexAuthTokenReader；maker-core的external-auth.ts与host.ts刷新handler。相关提交：628dc029b4（2026-09-23，同账号修复后的读取围栏），384db2112c（2026-10-30，内置0.166.0）。旧版本对照不支持“由后一次升级引入”的结论。

**仍不能在夹具不完整与原生策略状态问题之间定性。** 当前版本下这条401后同线程完成路径没有可用的自动验证，也没有核实过的线上成功记录；reader单测和普通跨账号e2e不能替代该验证。建议仍列M1鉴权待查，不修改运行逻辑，不把它计入389，不阻挡已发布PR。

## 下一步所需证据

- M1：完整Host装配下的 provider-oauth（无网关key/无默认OAuth、已有OAuth、原生作废标记）与默认OAuth认领对照；同时核对实际spawn模式、最终env与路由结果。
- M2：具名来源/旧别名/独立账号的控制入口、连接态与目录合同；显示身份及Host自身诊断。
- 保留项：在最终产物相同的条件下，原始env的冗余键差异；只有API-key文件而无网关key时的较早失败，须复核接受。
- 401：需要能观察策略失效与再发布的受控证据；不通过删除断言、关掉生产保护、碰运气重跑来归为夹具问题。
