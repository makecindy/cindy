# 插件原配置页移动端兼容：根因与统一方案

日期：2026-10-21。状态：代码已实施，部分真实授权闭环仍未验收。

以下调查与方案保留实施前事实；当前完成范围及验证限制以文末记录为准。

## 范围修正：配置页必须可用，不只是可显示

本方案现覆盖原配置页完整交互；下文授权调查是其中一个子问题。不能把支持 settingsHtml 等同于兼容原页面，也不能用新增一个 WebView 或少量合成表单测试证明完成。

### 已确认的不同故障

1. Outlook：原页标准 OAuth 在旧 Host 丢失远程上下文，落入电脑本机浏览器；现有能力协商不能识别该入口未接通。证据见下文。
2. Mivo 1.7.9 普通链接：settings.html 的“前往控制台获取”是 HTTPS anchor，指向 aigc.xindong.com。Mobile PluginSettingsCard 的 onShouldStartLoadWithRequest 只允许本地包内 HTML，外链直接返回 false；onOpenWindow 是空处理，没有本机浏览器接管。无需 OAuth，更新 Host 也不会修复这个手机容器缺口。
3. Mivo 凭证校验：原 settings.js 通过 BroadcastChannel('mivo') 发送 key-metadata-query，包含新输入值；手机 bootstrap 的 containsSensitiveInput 同步抛出 SecurityError。原脚本把“保存 → 元数据清理 → 回读 → 有效期查询”包在同一 try/catch，所以实际保存成功后也可能显示“保存失败”。这是兼容语义错误，不能靠删除错误文案或吞掉异常掩盖。

隔离复现：已安装 Mivo 原 HTML/JS + 当前生产生成的 bootstrap + 内存假 Host；未发起网络、未读写真实凭证。结果为 PUT 次数 1、Host saved=true、元数据查询转发次数 0、页面 savedBadge=on，同时 status=“保存失败,请重试”。这证明桥与原脚本不兼容，不是原生设备完整验收。

### 根因层次

- 产品契约缺失：承诺“原配置页”，实现只接通部分浏览器/Host 能力，没有列清原页面实际依赖。
- 交互归属缺失：外链应由当前控制设备打开、OAuth 应由原 Host 执行授权事务、电脑目录应留在目标电脑；现在部分动作直接丢弃，部分错误回落本机。
- 数据契约冲突：普通 BC 被保留，但原页使用的凭证校验消息被字符串检测阻断。传输加密不等于接收端隔离；不能直接解除检测并宣称问题解决。
- 失败不可见：全局 error/unhandledrejection 被 preventDefault，窗口事件空处理；页面可能不知道动作未执行，或把后续失败误当提交失败。
- 验收粒度错误：测试桥协议与合成状态，没有逐个走真实配置流程，且把测试 Host 成功外推到不同正式 Host。

### 已安装包静态盘点

只读扫描当前正式 profile 下 12 个带原 settingsHtml 的插件及入口直接引用的脚本。此为入口盘点，不是动态兼容判定，也不涵盖惰性加载和所有平台。

| 实际样本 | 已发现的交互 |
| --- | --- |
| Mivo | 获取 Key 外链、Secret 保存/清除、BC 有效期查询/缓存 |
| XD Sites、Web Search、同程诚信 | 外部链接 |
| Gmail、Google Calendar、Outlook | 标准 OAuth、账号回读/管理；Outlook bundle 的 clipboard 命中仍需区分库代码和实际入口 |
| TapTap Maker | 原表单、频道、target=_blank 控制台入口；与标准邮箱授权不同 |
| Remotion | 原表单与频道 |
| XD Feishu | 频道与 OAuth |
| GitLab、Baguette Simulator | 频道 |

### 整体实施顺序

**A. 先定义 Desktop/Mobile 共用的交互合同。** 以 PC 实际已支持的原设置页入口为准，逐项标明操作发起设备、执行设备、输入/返回、取消和恢复。对照 Desktop 本地与远程容器，区分 PC 已有缺口和手机新引入缺口。不要以“完整浏览器 API”作为无限范围承诺。

| 类别 | 目标行为与实现落点 |
| --- | --- |
| 普通链接 / 新窗口 | anchor、target=_blank、window.open、用户触发 location 导航共用一个导航处理器，按 PC 既有 URL/确认规则交当前手机原生浏览器；禁止用开放任意 WebView 导航代替。包内页面/锚点仍在原文档。拒绝必须有可理解的即时反馈。 |
| 表单 / fetch / XHR | 原 submit 监听器、按钮、返回码和异步回调保持语义；明确 Host API 与包内资源。不把所有 HTML form 都认定失败：JS preventDefault 后 fetch 与原生 form navigation 分开验证。 |
| OAuth / 设备码 / CLI | 共用受信授权事务；手机负责用户交互，目标保管凭证并产生最终完成回执；旧能力不静默回落 PC。详见原授权方案。 |
| BC / 原页与插件逻辑通信 | 保留原请求与响应关联、订阅顺序、错误和结束语义。凭证校验单独解决受信传递边界，不能把某个插件的消息名写进通用容器。 |
| Host confirm / directory | 复用已接通的原生回调；目录明确选择目标电脑目录，取消不会误报成功；异步回复固定旧页面身份。 |
| 剪贴板 / 文件 / 下载 | 先核对 PC 已支持和真实插件实际用法，按当前设备与目标电脑区分责任。现有 clipboard 禁用、下载拒绝不是完成适配；不能用关键词静态命中当成功或失败证据。 |
| 浏览器往返 / 后台 | 普通外链与授权分别收口，回到页面重新核对 Host 事实；不得意外重放提交或把资源服务停止变成无声空白。未提交敏感输入按既定生命周期清理，不写磁盘来保草稿。 |
| 出错与诊断 | 保留原页可观察错误/HTTP 结果；缺能力时给当前操作反馈，不增加常驻状态面板。诊断仅记录动作类别、阶段和受控错误码，不记录输入、完整 URL、频道内容或凭证。 |

**B. 先补普通交互，再接通授权版本差异，统一验证生命周期。** 导航处理器放在配置容器与平台适配层；OAuth 修复落在共享 executor/能力协商；原页数据留在原协议。不是为每个插件增加按钮或重造表单。

**C. 凭证频道冲突必须在编码前解决。** 当前任务限定例外明确“新输入凭证不入 BC”，而 Mivo 的实际原页正依赖该行为。当前实现无法同时保证“不改所有旧页、禁止这种原行为、完全兼容”三件事。不能把这个冲突交给用户点重试。

优先研究复用 Host 的受控凭证校验能力，让原插件按声明引用或一次性保密请求完成校验、频道只返回结果。需核对 PC 与存量兼容，必要的作者 API/插件升级应明确列出；若不能在现有契约内无损兼容，就单独提交具体边界设计，而不是直接开放通用 BC 明文。该项尚未定稿，不声称 Mivo 完整兼容已经有可实施结论。

**D. 以真实原包的完整用户流程验收。** Mivo 要完成“打开控制台 → 返回 → 输入 → 保存 → 有效期结果 → 重开回读 → 清除”；TapTap Maker 覆盖控制台新窗口、原表单与频道回执；邮箱覆盖授权；其余样本覆盖实际用到的能力。合成测试只用于制造取消、断链、失败时序，不替代原包操作。

新增完成条件：手机可见的每个配置操作都有真实作用或准确的操作级失败；没有静默 no-op；没有 Host 已提交而容器造成页面假失败；PC 本机行为与旧数据不退化。执行矩阵记录 iOS/Android、实际 Host 构建与原生包，未验证项单列。

本轮仅扩大诊断和方案，未放宽任何权限、未修改 Mivo 原包或运行代码。后续实现不得用“未知动作一律禁用”作为兼容交付。

## 授权子问题的目标

用户从手机插件原配置页点击授权，浏览器在当前手机打开；安装插件的目标电脑负责令牌交换、保存和账号事实。控制端不因目标缺能力而悄悄改为在目标电脑打开网页。

沿用原 settingsHtml、原 HTTP 结果和现有 v3 加密事务；不按 Gmail / Outlook 名字分支，不重新制作配置表单，不要求存量用户重装插件或重新配置。

## 本次实查

- 模拟器当前 Outlook 页面显示目标「公司电脑-new」，并非之前 Gmail 验收使用的「插件测试 B · 目标端」。截图取自同一已启动模拟器，未发起第二次授权。
- 当前运行正式进程为 /Applications/Cindy.app/Contents/MacOS/Cindy，包版本 0.1.112。
- 只读检查该安装包 app.asar：原 OAuth HTTP handler 调用 connectAccount 的 options 含 assertCurrent、scopes、clientId、deliveryHosts，没有 remote。同包另一个 setup action 入口已有 remote，说明不是完全没有授权桥，而是入口接线不一致。
- 当前 owner worktree 的 ghostOauthEndpoint.ts 已新增捕获并传递 RemoteOauthContext。这是通用 endpoint 修复，没有 Gmail 特判；但它尚不在正在运行的正式包中。
- 已安装 Outlook 2.1.8 的 settings.js：添加邮箱 / 重连调用 POST /oauth/<key>/connect；没有 window.open 或 BroadcastChannel 发起此动作。
- Outlook 声明两个提供方：global 使用 login.microsoftonline.com，china 使用 login.chinacloudapi.cn；都启用 PKCE，回调端口分别为 53687、53688。没有发现该按钮需要专用 Outlook 路由。
- 目前 Host 的 capabilities 只有通用 encrypted / callback / authorizationV1 等能力，没有证明“原设置页 OAuth 入口完整转交控制端”的能力。手机据此不能识别上述半接通的旧版本。

证据足以定位当前包的路由缺口，但本轮未复现 Microsoft 登录完成、未读用户令牌、未重启正式客户端。不能把静态定位写成 Outlook 修复验收通过。

## 真实调用链与责任

原 HTML fetch
→ Mobile pluginSettingsClient 将 connect 转为 settings authorize
→ MobilePluginPages 建立一次性 settings-oauth action
→ v3 transaction 绑定 owner / controller / 安装实例 / approval
→ runSettingsAuthorization 在受信远程上下文执行原 endpoint
→ fetchGhostSettings → handleGhostOauthRequest
→ GhostOauthAccountManager.connectAccount
→ startGhostOauthFlow
→ 控制端浏览器 / 回调接收器
→ 加密 callback 回 Host
→ 原令牌交换与持久化
→ 原 HTTP 结果及 /oauth 事实回读。

当前底层以 remote 是否存在决定打开位置：有 remote 请求控制端；缺失则调用 Host openExternal。旧 endpoint 漏传时，“远程请求”被误解释为“本地请求”。

## 按机制盘点，不按插件名字补丁

| 入口 / 机制 | 当前事实 | 统一处理 |
| --- | --- | --- |
| 原页 POST /oauth/<key>/connect | Gmail 与 Outlook 同类；旧包此入口漏传 remote | 由原 settings-oauth action 贯穿原 executor，复用共同引擎 |
| 原生 setup / 授权卡 | 已有独立 action 与远程上下文接线 | 与原页共同验证控制端、回调和完成判据；不另建事务 |
| OAuth code + PKCE / broker 回跳 | 目标持有交换信息；手机已有 loopback 原生接收模块 | 保持提供方登记的 redirect URI；回调回原 Host，不能把打开网页当成功 |
| Device code / browser confirmation | 已有 typed authorization 与 Node 授权桥 | 控制端展示或打开，执行端继续实际轮询/finish；明确设备码与 callback 不是同一流程 |
| 原页 BroadcastChannel → 插件逻辑 → Node/CLI | 普通 relay 转发不等于授权上下文透传；Node bridge 绑定 live RPC / callId | 逐入口核对真实绑定；不能把任意频道消息猜成授权，也不能把远程来源丢掉后当本机请求 |
| 插件自行启动浏览器的外部 CLI / OS 操作 | 不能由手机 WebView 拦截来保证重定向 | 查是否使用现有受控 authorization API；未接入的标明边界，不能宣称任意旧 CLI 已适配 |
| API Key / PAT / connection | 原表单专用加密 fetch，不是浏览器 OAuth | 保留现有读写与回显；不为这类增加外部授权状态 |
| 普通外链导航 | 与授权不同；现有手机原页默认不允许任意跳转 | 不用放开 window.open / WebView 导航来掩盖 OAuth 缺口 |

TapTap Maker 的 Runtime/频道路径与邮箱标准 OAuth 不能互相替代验收。需要逐条检查实际动作是否进入受控授权 API；本方案不假定其所有按钮都已支持。

## 实施设计

### 1. 保留共用引擎，明确动作来源

在 Host settings 授权执行边界捕获受信的控制端上下文，显式送至原 OAuth executor。
本地操作与远程操作在该边界明确区分；已知远程来源而缺失上下文时终止该动作，不能选择本地浏览器。
来源只能由已验证的 Host action 建立，插件 HTML 或普通请求参数不能自行指定 controller。

保留本机 PC 自己点击设置时的现有本机流程；不修改第三方 scope、clientId、redirect URI，也不增加服务商白名单或名称特判。
应评估最小的内部参数传递方式，避免同时叠加第二套授权状态机。

### 2. 协商整条入口的能力

在既有 settings:open 文档追加可选 controllerAuthorization: true，由完整接通原设置页 OAuth 入口的 Host 声明。settings-page 加密会话仅允许 settings 命令，不在该会话调用通用 capabilities。
手机在创建会触发外部副作用的授权动作前检查该能力及本机回调能力。

缺失时：原表单保留，读取和其他已支持配置照常；这次授权返回原表单可显示的受控失败，准确说明需要更新哪台设备。不新增常驻 Banner，不自动重试，不转去 PC。
通用 authorizationV1 或 settingsPage=true 不可当作这项能力的替代。
这是客户端协议追加字段，无需因为此修复新增服务端；老客户端忽略字段，原本 PC 本地使用不退化。

### 3. 浏览器与回调归属保持一致

复用 CindyPluginOauth 和现有授权 controller。
手机打开 → 手机接收 callback → v3 密封交原 Host → Host 交换/保存 → 原页回读。
端口冲突、用户取消、后台、超时、断链、切目标与账号失效沿既有事务收口，不能将浏览器 dismiss 当成功。
原始 state / code / token 不进入日志、普通 BroadcastChannel、通知或任务内容。

### 4. 核对其它授权入口，修正能力承诺

枚举原表单 HTTP、setup action、Node typed authorization、device authorization、BC/CLI 自定义授权路径的实际调用点与来源绑定。
能够复用现有桥的只补缺失接线；真正缺少受控 API 的另列明确兼容边界，不通过嗅探页面 URL 或全局拦截 shell.openExternal 伪装支持。
同时修正文档里“手机 loopback 尚不支持”等与已实现原生模块矛盾的旧表述，区分实现、安装包、验收三层事实。

## 验证与交付

| 验证 | 必须观察的结果 |
| --- | --- |
| 新手机 + 旧正式 Host 等价环境 | 授权前识别能力不足，目标电脑 openExternal 调用为零；表单读取不受影响 |
| 新手机 + 配套 Host，Outlook global | 真正点击原页添加邮箱，手机显示 Microsoft 登录，PC 不打开；完成后同一目标实例回读账号 |
| Outlook china | 独立覆盖其声明、端口及路由；无相应租户账号时标明登录完成未验证，不能借 global 代替 |
| Gmail | 原页添加/重连仍在手机；Host 成功保存后回读，避免 Outlook 修复造成 Gmail 回归 |
| PC 本机点击 | 原本 PC 浏览器流程仍可用，存量账号与配置不被清空 |
| 配置页与 setup 卡 | 两种入口都经过生产接线验证，不只 mock connectAccount 或只测最终 controller |
| 生命周期 | 双控制端互不串号；同名不同 namespace 不串实例；取消/断链后晚到结果不写入 |
| 非标准入口 | 至少取真实 Runtime/CLI 插件核实是否使用授权桥，按已确认范围给结果 |

测试顺序：生产入口级回归证明旧接线失败；新旧能力组合；隔离 Host + 同一模拟器的真实 Outlook/Gmail；再验证 PC 本机与移动端平台差异。
旧 Host 的验证使用隔离环境，正式客户端仅只读核对，不为测试重启、替换或注入。
登录由用户在浏览器完成，不索取密码/验证码；无需重复 Gmail 已授权操作，除非验证路径确实需要。
验收证据记录目标设备、Host 构建、手机构建、插件版本、入口、打开浏览器所在端、Host 保存与回读。设备渲染截图和合成状态用例不得代替授权闭环。

## 本轮交付边界

2026-10-21 用户批准“改掉”后的实现：

- 原配置页普通 HTTP(S) 链接和新窗口复用手机原生确认与浏览器入口；保留当前页面/账号/目标校验，覆盖时不接受新表单操作。包内 HTML/锚点继续留在容器，原生 `/__cindy/<token>` 初始入口仍可重定向到包内 HTML。
- `settings:open` 增加可选 `controllerAuthorization: true`，只由包含原 OAuth endpoint remote context 接线的 Host 返回。手机在创建授权动作前检查它，旧 Host 缺字段时提示更新所选电脑，普通读写不受影响。不以通用 OAuth 能力代替原页路由能力。
- iOS 26.5 专用模拟器 + 正式 Host 的真实 Mivo 1.7.9 原页：点击“前往控制台获取” → 原生确认 → 手机系统浏览器进入 Mivo SSO → 关闭返回原表单，已验证；未提交密钥。
- 同一模拟器 + 公司电脑-new（旧正式 Host）的 Outlook 2.1.8：点击原页“添加邮箱”后显示更新目标电脑提示，未进入授权。无正式客户端替换/重启。
- 同一模拟器 + 配套测试 B：刷新电脑目录后，真实 Gmail 已连接账号正常回读；点击原页 Connect another account → 手机原生确认 → 手机系统浏览器进入 Google 账号选择页。未选择账号或重新提交授权，本轮不重复声称登录回调验收。
- 定向自动验证 52 项 Mobile、75 项 Host；Mobile/Desktop 类型检查、Mobile scope、术语检查通过。Bootstrap URL 回归先复现失败，再修复通过。以上不代表 Outlook 登录回调或 Android 真机已验收。

该阶段尚未完成 Mivo 凭证校验 API；其后已完成实现及候选补丁，见下文。仍未完成新 Host 的 Outlook 双环境真实授权闭环、Android 外链验收。BC 凭证阻拦未放宽、未吞掉 Mivo 原错误，也未把新窗口单测算作全部插件的原生验收。未提交/推送。

源码导航（相对仓库根）：
- apps/mobile/src/plugins/pluginSettingsClient.ts
- apps/mobile/src/plugins/pluginAuthorizationController.ts
- apps/mobile/modules/cindy-plugin-oauth/
- apps/desktop/src/main/cindy-brain/mobilePageService.ts
- apps/desktop/src/main/cindy-brain/runtime/electronSandboxAdapter.ts
- apps/desktop/src/main/cindy-brain/runtime/ghostOauthEndpoint.ts
- apps/desktop/src/main/cindy-brain/ghostOauthAccounts.ts
- apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts
- apps/desktop/src/main/plugin-oauth/transactions.ts
- apps/desktop/src/main/cindy-brain/nodeRuntimeBroker.ts


## 后续实现与再次复核（2026-10-21）

- 通用凭证校验已实现：Host 接收一次性候选值，按批准清单请求并只返回有效性/有效期。Mivo 候选补丁区分保存和校验结果；旧 Host 保留保存能力并明确未校验。补丁保存在仓库外验收目录，未替换已安装插件；隔离原页测试不等于真实账号校验闭环。
- 配置加载覆盖资源下载至 WebView 完成，包内资源最多四个并发读取，取消后禁止迟到写盘。正式目标 XD Sites 的原配置页已在 iOS 模拟器显示。开发热更新曾使手机内存身份为空；完整重开专用模拟器 App 后恢复，临时诊断钩子已全部移除，没有修改生产身份校验。
- 再次复核修复包内导航的回包串页：同一租约下，新 HTML 文档会从头分配请求编号；按文档加载代次丢弃旧响应和旧错误。成功/失败两条回归均先失败、后通过。授权返回的资源重建合并到统一收尾路径，仍不重放提交。
- 再次复核修复 Android 回调连接清理：取消同时关闭已接入连接；过期任务不再排在阻塞读取后，每次请求还有总读取期限。生产 Kotlin listener 的真实 loopback 测试先复现取消后连接残留，修复后取消、慢速请求过期、一次性回调均通过。测试仅替代 Expo Promise 桥，不复制 listener 实现。
- 清理保留可复现预览、生成的 bootstrap 与回归夹具；它们有实际用途，不属于临时诊断代码。原生模块仍须冷更审核，插件基座仍须白名单放行；本轮未提交、推送、发布或替换正式客户端。

本轮检查：14 个 Mobile 测试文件 361 项、7 个 Host 测试文件 198 项、协议包 11 个测试文件 168 项通过；Mobile/Desktop 类型检查、Mobile scope、bootstrap 生成一致性和 diff 空白检查通过。Swift 生产 listener 17 个场景及 Kotlin 生产 listener 的取消/过期/一次性回调通过；Android 原生模块 `:cindy-plugin-oauth:compileDebugKotlin` 编译通过。未运行整仓全量门禁，未把 loopback 测试或模块编译等同于 Android 设备上的第三方授权验收。
