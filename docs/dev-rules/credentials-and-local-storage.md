# 凭证与本地存储安全

> **状态**：权威开发规则（authoritative）
> **读取时机**：修改凭证或授权信息处理、文件落盘位置、用户持久数据、临时文件、
> 测试目录或运行时生成物之前

本文约束 Desktop、Mobile、共享 package、脚本和测试中的本地文件写入。数据库 migration
另见 [`database-and-migrations.md`](database-and-migrations.md)，Renderer 与 IPC 边界另见
[`electron-security-and-process-boundaries.md`](electron-security-and-process-boundaries.md)。

> **增量适用原则**：本规则约束新增和正在修改的代码，不要求为统一目录结构专项迁移
> 存量数据。存量凭证或用户数据迁移必须单独设计兼容、回滚和验证方案。

## 凭证不入仓

- 用户凭证、OAuth 授权、API key、访问令牌、刷新令牌、私钥和 Agent 授权文件不得以
  复制、链接、fixture、日志或生成物等形式进入仓库工作区或任何可能被 Git 跟踪的路径。
- `.gitignore` 只是误操作兜底，不是凭证存储方案。发现凭证曾进入 Git 历史时，应立即
  停止传播并通知用户作废凭证；删除工作区文件不能撤销泄露。
- 运行时需要持久化秘密时，复用现有 Main／宿主管理的 credential store 或 Electron
  `safeStorage` 边界。不要新增自定义明文凭证文件，也不要把秘密下放给 Renderer、插件
  或不受信任页面。
- 可信 Node Worker 的显式例外：`node.secretBindings[].oauthSecret` 只能引用本插件
  已声明的 OAuth key；这是调用时的凭证解析边界，不是发布或安装的能力支持门禁。
  引用尚不可用时保留声明，在调用时返回不支持／配置错误，不读取其他插件凭证。
  Host 根据本次 `authAccount` 刷新并注入
  短期 access token；不得注入 refresh token、返回 Renderer/Agent、写日志或落盘。
  Worker 启动第三方 CLI 时仅用该次子进程环境传递，不修改全局环境或复用他账号配置。
  这是高权限 Node 的受审查信任边界，不是系统沙箱或对恶意 Worker 的隔离保证。
  实现与回归见 [nodeRuntimeBroker.ts](../../apps/desktop/src/main/cindy-brain/nodeRuntimeBroker.ts)
  和 [nodeRuntimeBroker.test.ts](../../apps/desktop/src/main/cindy-brain/__tests__/nodeRuntimeBroker.test.ts)。
- 插件自定义的账号昵称、展示偏好和业务配置属于插件数据，使用现有隔离 `/kv`，
  不扩充 Host OAuth 账号模型、凭证库或专用接口。插件按账号 ID 合并这些数据用于展示
  和选择账号；传给 Host 的授权身份仍是账号 ID，不能用昵称替代。
- 远程声明式 API Key/PAT 可通过 [签名输入桥](../remote-plugin-oauth.md) 的密码卡一次性
  提交；专用本机 IPC 验证设备、插件、卡片、完整字段展示后加密交给目标 Host 原 executor。
  只写已声明的单个 user Secret，不读回、不批量同步、不开放账号 vault。值只短暂存在于
  输入组件/Main 调用中，不进入 Renderer store、Agent、普通远控、日志或历史。CLI PKCE
  的私有回调也只交给发起的可信 Node RPC，不能返回沙箱 main.js 或业务 stdout。
- 代输入（[产品规则](../product-rules/input-handoff.md)）复用同一签名输入桥：每一步按
  (requestId, revision) 绑定，主人填写的**所有**值（不只密码）只在 Main 执行输入那一下存在，
  提交对象用后逐键删除；不进 Renderer store、续接消息、任务记录、数据库、日志、IM 或推送。
  卡片快照只含界面结构与界面上显示的文字；截图像素只走本地受信 IPC 或加密 offer。
  宿主注入任务 shell 的 askpass（`SUDO_ASKPASS` / `SSH_ASKPASS` / `GIT_ASKPASS`，经
  `taskShellEnv`）只携带本机一次性路由，不携带秘密；口令只写回发起的那个进程。
  设备码「复制代码」写入的是界面上本就显示的短期代码，不属于主人填写的值。
- access token 等只需短期使用的秘密优先保留在内存中。日志、错误、遥测和调试输出不得
  包含凭证明文、完整鉴权头或可直接复用的授权材料。
- 测试只使用明显无效的假凭证，不读取或复制开发者真实的 `HOME`、Agent home、
  Electron userData 或系统凭证目录。

## Claude 订阅只经 Claude Code 自己的登录

Anthropic 只允许用户用自己的订阅登录**未修改的 Claude Code**；第三方应用不得提供
Claude.ai 登录，也不得收集、存储或中转订阅凭证。Cindy 因此只做内置 CLI 的外壳：

- 登录只拉起内置 CLI 的 `claude auth login --claudeai`，登录态只读
  `claude auth status --json`。凭证留在 CLI 默认凭证库（macOS 钥匙串 / `~/.claude`），
  Cindy 不读取、不复制、不刷新它。CLI 按配置目录区分凭证库，所以本机 CLI 的会话（任何来源）
  与登录检查都不得设 `CLAUDE_CONFIG_DIR`（dev 多实例也用默认目录），否则会看不到本机已有的
  Claude Code 登录；SSH 远端的配置目录由远端 cc-manager 自己管理，不在此列。
  只有 Claude.ai 订阅账号的 OAuth 登录算「Claude 订阅」；CLI 用 Console 账号、API Key、
  apiKeyHelper、中转 token 或第三方云登录时按 `not_a_subscription` 处理，也不替用户改 CLI 的登录。
- 登录态读取不得阻塞与订阅无关的路径：启动只在已连接时等待，列表类读取用缓存并后台刷新，
  读失败有退避。
- 订阅会话由 SDK 拉起同一个 CLI，自己读凭证、直连 Anthropic：不设 `ANTHROPIC_BASE_URL`、
  不设 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`、不注入任何 token；认证 env 中的凭证键在
  合并后一律剥除（maker-core env-builder `nativeCliAuth`）。Host 只可补代理 env：代理 env
  给的 HTTP 代理原样继承；系统代理或 SOCKS5 时 `HTTPS_PROXY` 指向本机只接受 CONNECT 的回环
  端口，它对每个目标重新按系统代理 / PAC 决定直连或走代理（env 作用于整棵进程树，含 Bash
  工具里的 git / npm，内网例外必须照旧直连），明文 HTTP 不下发代理。都是 TCP 隧道，TLS
  端到端，代理、转发端口与 Cindy 都看不到凭证。
- 订阅会话不设 host 接管标记；Cindy 的所有 Claude 会话统一使用 `claude-desktop` 入口，
  CLI 会启用 Desktop 宿主的项目级上游 / 鉴权环境过滤。入口身份不改变凭证来源，普通项目
  设置、权限与 hooks 仍由 CLI 加载。SDK 模式仍没有终端的工作区信任确认，因此继续对
  CLI 实际加载的项目级设置（工作目录的两份文件，加上主仓库根目录的 `settings.local.json`）
  设闸作为纵深防御（maker-core `workspace-settings-guard`），不依赖上游过滤替代宿主检查：
  - 每次拉起 CLI 进程前（含会话中途重建）命中就拒绝启动；
  - 会话运行中，任何设置变更（ConfigChange hook）与 Cindy 触发的 flag settings 应用（切模型 /
    effort / fast）前都整体复查；命中即判会话已污染，阻止这次变更并结束当前 CLI 进程——被拒
    的文件还在磁盘上，CLI 之后任何一次全量重读都会读到它，不能只拦一次；
  - 订阅会话禁用 EnterWorktree（它会把项目根挪到未检查、也不被 watcher 监视的目录）；
  - 解析不了的文件按命中处理（读不懂不等于 CLI 不应用）。
    命中范围是改写上游、鉴权或 TLS 信任的键，代理、模型、权限与 hooks 不拦。
- 未指定来源的会话：有网关 key 走网关；没有时只有 Anthropic 一方模型交给本机登录，其它模型
  仍经 loopback proxy 按模型路由。loopback proxy 从不转发订阅流量：显式订阅会话或无 Cindy
  凭证的 claude-* 请求到了 proxy 一律本地拒绝。
- 订阅只对本机 `claude-code` 开放：Codex / Pi 不列订阅模型，Codex 显式选中时本地拒绝；
  SSH 远端、辅助 one-shot（标题、自动复核等）不使用订阅。订阅会话的子代理请求同样由 CLI
  直连，只注入 Anthropic 一方的子代理模型覆写。
- 「断开」只撤销 Cindy 的使用许可（`nativeProviderAuthBinding`），不登出 CLI。
  旧版独立 Claude 账号已停用，但不删除其已存凭证。
- 套餐余量由内置 CLI 的 `get_usage` 控制请求查询（CLI 用自己的登录发请求，拉起时不读
  项目级设置、不起 MCP、不落会话记录），会话内的 SDK `rate_limit_event` 做增量刷新；
  模型列表来自 SDK `supportedModels` 与 Registry；
  不得为此恢复用订阅 token 直接调用 Anthropic API。
- 实现见 [claude-native-cli.ts](../../apps/desktop/src/main/maker-host/claude-native-cli.ts)、
  [env-builder.ts](../../packages/maker-core/src/agents/claude-code/env-builder.ts)；回归见
  [claudeAuthAdapterOAuthEnv.test.ts](../../apps/desktop/src/main/maker-host/__tests__/claudeAuthAdapterOAuthEnv.test.ts)
  与 [env-builder.test.ts](../../packages/maker-core/src/agents/claude-code/__tests__/env-builder.test.ts)；
  真实 CLI 的入口、项目设置、原生 / SDK hooks 与权限回归见
  [smoke-claude-sdk.mjs](../../scripts/smoke-claude-sdk.mjs)。

## Linux 凭证后端

- Desktop 在 Electron `ready` 之前为 Hyprland、labwc，以及没有桌面身份的会话默认选择
  `gnome-libsecret`。Chromium 不认识这些会话时会落到 `basic_text`，打包版会把它当成
  加密不可用，即使 Secret Service 已经解锁。桌面身份依次取非空的
  `XDG_CURRENT_DESKTOP`、`XDG_SESSION_DESKTOP`、`DESKTOP_SESSION`。GNOME、KDE、XFCE
  等 Chromium 已能识别的桌面，以及 sway、niri 等未证实的命名桌面，保持 Electron 原有选择。
  实现见 [linuxPasswordStore.ts](../../apps/desktop/src/main/linuxPasswordStore.ts)，回归见
  [linuxPasswordStore.test.ts](../../apps/desktop/src/main/__tests__/linuxPasswordStore.test.ts)。
- 显式 `--password-store` 优先于此默认值。系统仍需提供可用且已解锁的 Secret Service
  （例如 GNOME Keyring）；此修复不安装或解锁钥匙串，也不新增明文降级。libsecret 缺失时
  Chromium 仍会回退，Cindy 继续拒绝明文。现有仅限开发版的
  `XDT_DEV_SAFE_STORAGE_BASIC=1` 调试行为保持不变。
- 不把空的桌面环境变量本身当成禁止登录的条件，也不在启动时探测钥匙串。用户发起验证码
  请求、验证码提交或浏览器登录时，才检查当前加密后端是否可用；不可用则返回既有的
  `CREDENTIAL_STORE_UNAVAILABLE`，不发送验证码、不打开浏览器、不交换授权码。凭证读取
  失败时记录后端名称、`password-store` 开关类别，以及是否有桌面身份、是否有会话总线
  两个布尔值，不记录桌面名、总线地址、令牌或完整环境变量。加密不可用且 vault 或退出
  标记文件确实不存在时，日志说明记录缺席且后端不可用，仍抛出
  `CREDENTIAL_STORE_UNAVAILABLE`，不把已有但暂时读不出的记录当成已删除。
- 旧版临时处理：完全退出 Cindy 后运行 `cindy --password-store=gnome-libsecret`。
  实机验收需覆盖登录、退出应用后正常启动仍保持登录，以及 `cindy://` 回调启动路径。

## macOS safeStorage 钥匙串条目

- macOS 上 Electron `safeStorage` 的钥匙串条目名由 `app.name` 派生
  （service = `<app.name> Safe Storage`）。当前语义（#871）：packaged cn / global 与
  **共享 userData** 的 dev 共用 `Cindy Safe Storage`；**显式隔离**的 dev 沙箱
  （`--isolated` / `XDT_ISOLATED=1`）在首启（profile 为空）时选定独立的
  `CindyDev Safe Storage`，并把身份写入 profile 根的 `keychain-identity` 标记文件、
  跨重启粘住（见 `apps/desktop/src/main/devKeychainName.ts`；身份不能用「目录是否
  为空」做持续判据）。隔离沙箱默认目录随之升纪元为 `<userData>-dev2[-<名字>]`：旧
  `-dev` 目录属 `Cindy` 身份纪元、留给旧 checkout，同名目录被两种身份轮流打开会互毁
  密文。无标记且已有数据的旧沙箱永久保持默认条目名（存量密文绑定旧
  条目主密钥，零迁移只对新沙箱成立）；裸设 `XDT_USER_DATA_DIR` 只是目录覆写、不表达
  隔离意图（devCliFlags 契约），**绝不认领 `CindyDev`**——但打开的目录已带标记时依
  标记运行（观察模式：身份是 profile 的属性，不随启动旗标切换），标记不可读或内容
  不可识别同样拒绝启动。空 profile 的身份在两种模式下都经标记文件**原子落定**
  （隔离启动认领 `CindyDev`，覆写启动认领默认身份 `Cindy`，输家依胜者标记），
  防并发启动对同一 profile 以两种身份写密文。
- 钥匙串条目名与 userData profile 的存量密文一一绑定：**不得**在共享既有 profile 的
  进程里改 `app.name`——换名后新写入的密文对共用该 profile 的其它身份不可解，双向串坏。
  改动条目名属存量凭证迁移，按上方增量适用原则必须单独设计兼容/回滚/验证方案。
- Cindy Make 的托管个人版按已验证的本机启动交接继承原版的 profile、设备身份与钥匙串
  名称；Dev 和安装版同属原版。它只能沿用现有身份，不能认领另一套钥匙串或复制凭证。
  已有 `keychain-identity` 必须与交接身份一致；无标记只接受默认身份。原版入口和普通
  packaged 启动的原规则不变，不开放任意环境变量的 packaged profile 覆写。
  见 [versionStartup](../../apps/desktop/src/main/cindy-make/versionStartup.ts)。
- 同机装过 cn 与 global 双版的机器上，后启动的版本首次访问 `safeStorage` 会触发系统
  钥匙串授权弹窗，属 macOS 按预期征求同意；应引导用户点「始终允许」。点「拒绝」后
  加解密降级失败，authManager 的 safeStorage helpers 会按原因落一次 warn 日志。
- 不要在启动路径主动调用 `safeStorage.isEncryptionAvailable()` 做探测——macOS 上探测
  本身可能触发钥匙串授权弹窗，把弹窗时机提前到与用户动作无关的启动期。

### 登录凭证存储异常的恢复

- `CREDENTIAL_STORE_UNAVAILABLE` 不能作为验证码错误继续展示原表单；登录页进入恢复说明，
  保留凭证与私有票据，允许用户查看解决方法或重新尝试登录。
- macOS 正式版复用 `authCredentialRecovery.ts` 的单次进程恢复：启动和登录动作结束后均可
  请求检查，但只针对真实凭证操作已观察到的加密后端不可用；仍须未登录、屏幕解锁、无工作
  在运行且不是共享数据的被动实例。单个密文损坏或文件访问错误不得因此触发自动重启。
- 后端故障资格只消费 main 现有的 `credentialEncryptionUnavailable` 观察值，不依赖登录页
  当前步骤。返回或重置表单不清除已观察故障；后续真实凭证操作观察到后端可用时清除。
  不增加探针、独立故障标记或恢复次数，实际重启仍经过原恢复器全部门禁。
- 登录页与已登录警示条共用 `CredentialStoreHelpDialog`。提示说明本机存储问题、按系统给出
  解锁与完整退出步骤，持续异常时提供错误码、日志目录和私下支持渠道；不承诺重启一定恢复，
  不建议删除钥匙串、清空凭证或反复获取验证码。打开日志目录不等于上传日志。

### 登录限流指引

- HTTP 429 与本机凭证存储异常分别显示；限流不请求凭证恢复或自动重启。
- 限流发生在已有登录步骤时，提示页的返回操作仅清除提示，保留原步骤、票据及输入，
  不派发 reset 或重新取码；初始化失败、没有可返回步骤时才重新初始化登录。
- auth-client 将有效 `Retry-After`（秒数或 HTTP 日期）转成可选 `retryAt`，经登录 IPC
  返回并显示本机时间；HTTP 日期有有效 `Date` 头时按服务器时间差换算。缺失或非法时
  明确提示未提供等待时间，不猜冷却周期。不自动重试、不新增限流持久状态。
- 主进程现有登录错误步骤保存可选 retryAt，renderer 重载后重放该步骤时仍返回原时间，
  不重新请求或重新起算。它仅存于当前进程内存，重置流程和退出进程不保留。
- AuthContext 镜像当前步骤及其等待时间，普通初始化、添加账号及登录操作共用同一投影；
  useLogin 不另存一份。进入新步骤、其他错误及取消不能沿用上次的等待时间；读取已有
  错误步骤的成功 IPC 回包不等于登录成功，不清除该步骤的等待时间。
- 限流帮助不建议重启、重装或切换网络，持续异常时引导用户将日志、版本和出错时间私下
  提供给支持人员。复用本机日志目录入口，不自动上传。旧响应适配器可省略 headers，
  旧 IPC 消费者可忽略 retryAt；Mobile 暂不增加等待时间界面。

### 运行时会话续期退避

Desktop 冷启动恢复已保存的登录时，DNS／断网、服务端临时错误及区域端点清单暂不可用
不会清除凭证，也不在有限次数失败后放弃。启动画面仍只等待原有的 20 秒，恢复流程在
后台持续按下述随机退避策略重试；直到恢复成功、凭证明确
失效，或用户开始新的登录／退出／切换账号／进入未登录模式。人工操作使旧流程失效，
迟到响应不能覆盖新界面身份；不通过中断正在轮换凭证的网络请求来实现取消。
已发出的刷新若成功，先在既有凭证事务中核对仍保存着请求所消费的凭证，再保存轮换结果；
即使用户正在手动登录，也不能丢掉这一结果。旧账号仍保存时仅更新它的凭证，不重新激活，
不覆盖较新的凭证，也不复活已退出的账号。
登录页「重试」优先恢复已保存的登录，复用正在进行的请求，并可提前结束普通网络失败
的等待，但不能绕过服务端冷却时间。运行时续期也不与冷启动流程并发轮换同一凭证。
实现与回归见 `authManager.ts`、`authColdStartRecovery.test.ts`。

Desktop 冷启动恢复与运行时 refresh 共用随机指数退避策略：连续失败后的等待区间依次为
1–2 分钟、2–4 分钟、4–8 分钟，之后持续在 5–10 分钟内重新随机取值，不设次数上限。
429／503 的有效 `Retry-After` 更长时先遵守服务器期限，再追加当前退避档位的随机间隔，
防止所有客户端在同一个服务器恢复时间一起重试。等待期间的主动调用不发请求、不延长
原期限，也不清除凭证。成功续期／登录清除等待，登录代次改变后旧等待不约束新账号；
冷启动画面超时转后台不能重置失败次数。冷启动的等待期限和失败次数归属于当前保存的
凭证，返回／取消再恢复沿用原期限，取消后的迟到限流响应也必须保留期限；手动重试释放
纯网络错误的等待时不清零失败次数。恢复停止期间的启动超时不能清除手动登录进度。
网络变化、resume 或 relay 恢复信号均不能跳过等待或清零失败次数；在途请求仍复用同一个
promise，恢复信号不能在旧请求结束后追加立即续期。只有用户主动点击登录页重试，且
此前失败没有服务端响应、没有服务端等待期限时，才能提前结束冷启动等待。
续期完成后的立即重连须复验 client、owner 与持有权，不能唤醒旧实例。
确定性失效和同机 token 替换恢复继续沿用原有判定。状态只留在进程内存中。
实现见 `main/authRefreshBackoff.ts`、`main/authManager.ts`；回归见
`main/__tests__/authRefreshBackoff.test.ts`。

## 路径与生命周期

| 数据性质                            | 正确位置                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 引擎二进制后台下载缓存 | `userData/agent-binary-downloads/<vendor>/<归档 SHA-256>/`，只有归档、续传碎片和绑定来源/平台/版本/哈希的就绪记录，不含凭证。每种引擎保留一个候选，切换候选时回收旧候选，超过 7 天的碎片在后续检查时重建。下载与消费共用跨进程缓存锁；启动前复验哈希，复制交给原安装器后回收缓存，解压后的中间包与旧版本仍由原安装器清理。回退旧客户端时这些缓存不会被识别成已安装引擎。见 `agent-binaries/download-cache.ts` |
| Codex 包内 shell 入口 | `<userData>/codex-package/<版本>/codex-path/codex`，打包版 macOS/Linux 在 `getMaker()` 选定实际运行的 Codex 后由主进程原子写入，转发到同包的 `bin/codex`；只更新带 Cindy 标记的旧脚本，不覆盖外来文件。随旧版本目录整体删除，不含凭证。实现见 `agent-binaries/codex-cli-launcher.ts` |
| Cindy 管理的持久数据                | Desktop 使用 `app.getPath('userData')`，共享 package 由宿主注入等价根目录                                                                                                                                                                                                                                                                                                                                       |
| 浏览器用户配方与经验 | `userData/browser-recipes/<site>/recipes/<id 的 SHA-256>.json`，每站多个流程，原子替换；兼容旧 `recipe.json`，新文件优先。只保存参数化定义及 candidate/active/suspended 状态、浏览器 profile 范围，不保存试跑 inputs/页面返回值；禁止写入凭据，业务变动值用 inputs。同站 `experience.json` 最多保存 32 种操作形状（动作枚举、次数、时间），不保存 URL 路径/查询、选择器、脚本或输入输出；删除站点目录一并重置。重复形状仅提示当前 Agent 判断，不触发后台模型。试跑凭证与单轮修复预算只在 MCP 会话内存，暂停状态跨重启保留。 |
| 浏览器大结果补读 | MCP 工具会话内存中保留最近四份原始 JSON，每份最多 200 万字符；不落盘、不上传，关闭会话后释放。`readResult` 只能读当前会话生成的引用，沿用原页面实际 profile 的代输入读取限制；切换后端、stop 或读取受保护页面时清除。工具复用宿主现有生命周期与后端对象引用，在下一次访问及异步预检后核对，包括设置/其它任务切换、切走再切回和嵌入后端恢复；切换中的动作仍报告真实结果，但不缓存原文或保存试跑凭证。超过上限明确截断，不能声称完整原文已保存。 |
| 自建中转服务（Desktop） | `owners/<owner-key>/device-link-relay/`：`config.json` 只存选择、本机中转设置与服务器部署记录（地址、中转 ID、主人公钥，不含秘密）；`secrets/<中转ID>.enc` 是本机在该中转上的设备凭证与 Ed25519 签名私钥（本机当主人时即主人密钥），经 safeStorage 加密，Linux 只有 basic_text 时拒绝保存；第 1 版的 `credential.enc` / `owner-credential.enc` 读到旧配置时删除；`host/` 是本机运行中转时的数据（`relay-state.json` 只存各设备凭证的 SHA-256 与档案，0600 原子写入；`media/` 为设备间中转的文件，创建 24 小时后清理）。全部按账号隔离，账号作用域未提交时不读写。见 `device-link/selfHostedRelayConfig.ts`、`packages/device-link-relay` 与 [方案](../self-hosted-relay-plan.md) |
| 自建中转服务（Mobile） | AsyncStorage `cindy.mobile.self-hosted-relay.v2.<账号>` 只存选择（中转地址、名称、主人公钥、本机设备 ID），不含秘密；设备凭证与 Ed25519 签名私钥合存为 `expo-secure-store` 的 `cindy.selfHostedRelay.credential.v2.<账号哈希>`，仅本机、解锁后可读。没有签名私钥的 v1 记录不再使用，读到时尽力删除。见 `apps/mobile/src/device-link/selfHostedRelay.ts` |
| 自建中转服务（用户服务器） | 「部署到我的服务器」经 SSH 写入用户自己的服务器：`/opt/cindy-relay`（Node 运行环境与 `relay.mjs`）、`/var/lib/cindy-relay`（属 `cindy-relay` 系统用户、0700：设备凭证哈希与证书档案、Let's Encrypt 账户密钥、0600 原子发布的 `tls/material.json` 证书与 TLS 私钥、`status.json`）、`/etc/systemd/system/cindy-relay.service`。旧分立 PEM 文件仅在密钥配对且未过期时兼容读取；续期提交失败保留上一完整代次。主人凭证明文与主人私钥从不离开主人电脑；卸载前核对中转 ID 和主人公钥，匹配才删除。见 `device-link/selfHostedRelayDeploy.ts` |
| 本机应用 Agent 授权 | `owners/<owner-key>/local-agent/grants.json`，仅含令牌 SHA-256、自报应用资料、账号范围和按授权归属的原生恢复绑定，不存令牌明文、供应商凭据或消息。复用原子写入与恢复 helper；profile 根 `local-agent/host.lock` 复用跨进程锁，保证一个发现端点和写入者。开发连接码从当前服务内存按需生成，不新增公共实例登记或短码映射文件。临时输入与新授权的 Codex 运行历史在同一 owner 下的 `local-agent/clients/<grant-hash>/`；撤权同时关闭执行及工具入口，不允许跨授权恢复。协议与旧版兼容见 [本机应用接入](../local-agent-api.md) |
| 预创建 worktree 的取消标记          | `userData/worktree-cancelled-creations/<sessionId 的 SHA-256>`，空文件原子排他创建；不含路径、草稿或关联密钥。保留以拒绝重启后迟到的创建请求，不按超时删除。只在核实未被任务认领后写入。同路径加 `.lock` 是可释放的跨进程操作锁，复用既有锁协议；同一 profile、同一任务的创建登记与取消回收串行，拿不到锁不得确认回收完成。异步创建完成后、登记前再次核对取消标记                                               |
| Mobile 已取消创建的草稿             | 复用账号隔离的 durable outbox；持久创建流程先保存草稿、原项目目录和附件，再登记 reservation 和发送远端 worktree 创建；创建回包前暂停发件箱投递。回收确认后，`creation.cancelled` 与原项目目录先持久写入，再忘记回收账本。重建使用新远端 ID，`storageSessionId` 保持原 AsyncStorage 键和附件目录，通过单次记录写入提交；写入失败时原草稿仍可读。编辑页恢复目录时重新探测资格，不沿用旧 worktree 的资格或分支偏好 |
| 可丢弃的临时数据                    | `app.getPath('temp')` 或 `os.tmpdir()` 下的任务专属目录                                                                                                                                                                                                                                                                                                                                                         |
| 测试生成物                          | `os.tmpdir()` 下通过 `mkdtemp` 创建的独立目录，并在测试结束时清理                                                                                                                                                                                                                                                                                                                                               |
| Skill 卸载清理回执                  | `app.getPath('userData')/skillhub/uninstall-cleanups/<token>.json`，记录操作 owner、旧文件/注册/偏好身份与完成阶段；跨窗口和重启保留，当前 owner 重试完成后删除，不作为授权凭据                                                                                                                                                                                                                                 |
| 跨 profile 的 Cindy 内置 Skill 副本 | `app.getPath('appData')/Cindy/shared-system-skills`，只保存随应用发布、可由 bundle 重建的官方 Skill；Global、China、dev 与 isolated profile 共用稳定物理路径，更新和共享发现链接必须持有下述互斥锁                                                                                                                                                                                                              |
| 跨 profile 的共享 Skill 文件互斥    | `app.getPath('appData')/Cindy/shared-skill-mutation-locks`，仅存文件锁及未完成操作的 token/名称哈希，保证正式版/dev/isolated 共用；短期锁复用既有崩溃回收，持久屏障必须等对应清理完成后删除，读取损坏只阻止相关名称                                                                                                                                                                                             |
| 旧跨 profile 的 worktree 借用租约   | `app.getPath('appData')/Cindy/shared-worktree-runtime-leases`，内置模拟器下线后不再创建共享租约；回收器仍读取旧证据并重试已有 `.release` 回执。普通 Agent 的当前 profile 租约（`userData/worktree-runtime-leases`）照常创建与释放；持有它的主进程每 5 分钟刷新一次修改时间作为心跳（租约带 `heartbeatMs`）。租约只在显式释放后，或下列条件同时满足时不再保护：持有进程与记录的子进程都已不在（进程已退出，或该进程号已被启动更晚的进程复用：租约带持有进程自己的系统身份 `processIdentity` 时比对系统记录的启动时间，不受事后校时影响，旧租约与子进程比对租约最后修改时间；租约只由写入进程自己持有、不会被接管，因此不按进程名豁免；身份查询失败按仍在处理）；并且租约写于本次开机之前（留 10 分钟时钟余量），或最后一次心跳距今超过 1 小时（无心跳的旧客户端租约为 24 小时）。当前进程持有的租约、兼容的存活实例的租约始终保护。`.dev-instances` 里不支持租约协议的旧实例登记，在进程身份证明进程号被复用时不再一票否决；身份查询失败时，开机前登记的也按复用处理，POSIX 的 SingletonLock 仍要先核对进程身份。见 `worktree/runtimeLeases.ts` |
| worktree 回收记录与恢复内容 | `userData/worktree-recycle/<资源 id>.json` 与 `history/`，记录删除意图、Git 快照引用与重试状态。归档／删除时只把已跟踪改动和未被 `.gitignore` 排除的新文件存进 Git 快照（`refs/cindy/worktree-recovery/...`；被 `assume-unchanged`／`skip-worktree` 隐藏的已跟踪改动也会存入，只在临时索引里清除标记，稀疏检出中不在盘上的文件除外），被忽略的依赖、构建产物、缓存，以及 worktree 内未跟踪的嵌套 Git 仓库（`git clone`／`git init` 产生）不保存，恢复后需重装、重建或重新克隆。快照对象写进基础仓库的本地对象库：普通 push 不会带上，`push --mirror` 或整体复制 `.git` 会；恢复内容经 Git 的换行与符号链接转换（与 `git checkout` 一致），不保证逐字节相同。快照引用在恢复成功、被新快照取代时立即删除；任务删除后只在启动对账时删除（常规回收路径不读任务库），归档任务的快照保留；对象由仓库自身 gc 回收。删除前对整棵树做最后一次核对，核对通过后才写入 `phase=removing` 与删除起点；此后不再重拍快照。续删只删除同时满足两点的文件：修改与创建时间都不晚于删除起点；路径在快照里，或在开始删除时记下的可丢弃路径（被忽略的文件、嵌套仓库）之下。可丢弃目录内部不再逐个检查时间：其中的内容本来就不保存，删除开始后新写入的同样不保存，也避免遍历依赖目录。可丢弃路径超过 2000 条时只按时间判断。保留原时间戳替换进已保存路径的内容无法识别。其余情况暂停删除。新客户端不再生成加密归档 `*.tar.gz.enc`；旧客户端记录里的归档照旧用于恢复；续删旧客户端的 `removing` 记录前要先验证归档能解密且完整，验证失败时保留目录，新客户端为仍完整的目录重拍快照后也会放弃旧归档；没有任何记录引用、超过 2 小时的归档在启动时删除，有记录读不出时整次跳过。旧客户端因失败暂停的请求（目录被替换、路径不受管等安全原因除外）升级后自动重试一次。见 `worktree/managedRecycle.ts`、`restoreRecovery.ts`、`recycleJournal.ts` 与 `recycleMaintenance.ts` |
| 旧版 worktree 回收器兼容锁          | 不再创建新的跨 profile Git 锁；保留旧回执对 `<commonGitDir>/worktrees/<id>/locked` 及更早 `.worktree-keep` 的清理。仅当最后一个共享借用结束且自建文件身份和内容仍匹配时删除，不覆盖用户锁；失败沿用 `.release` 重试。支持精确的 `bigint:dev:ino:birthtimeNs` 身份；旧数字编号为 0 或超过安全整数范围时无法证明归属，保留锁但仍释放已结束的租约，避免 Windows 编号精度丢失误删用户替换文件 |
| 跨 profile 的 worktree 回收日志位置 | `app.getPath('appData')/Cindy/shared-worktree-recycle-journals`，仍按日志目录哈希发布原 profile 日志位置，兼容可能同时运行的旧客户端；新客户端不再读取其他 profile 的日志来借用工程。不复制恢复状态、不代替 owner 执行恢复                                                                                                                                                                                      |
| 供应商分享：分享者电脑上的受邀者用量 | `userData/remote-agent/provider-share-usage.json`，按（日期、分享、成员、Agent、供应商、模型）聚合 token 与轮次，行内 `byMember` 按组内电脑的键再分（2026-10-11 加；行键与合计不变，旧版本照常累计并原样写回，合计多出各台之和的部分算没区分电脑），原子替换写入，保留 400 天；只含服务端生成的分享与成员 id，不含昵称、对话或凭证。成员删除后保留（管理页不再显示），同一人重新加入时接续 |
| 供应商分享：额度/用量可见性 | `userData/owners/<账号>/provider-share-visibility.json`，按供应商记录独立 quota/usage 开关覆盖与撤销代次；默认关闭。复用 override settings 跨进程锁、原子写和损坏保留，读写核对当前账号。只存布尔设置及代次，不存额度、身份或凭证；见 `device-link/providerShareVisibility.ts` 及同名单测 |
| 供应商分享：分享者的用户备注 | `userData/owners/<账号>/provider-share-member-notes.json`，`notes` 按服务端成员 id 保存非空单行备注（最多 80 个 UTF-16 单元），空白保存删除对应 override；复用设置文件跨进程锁、现读与原子替换，写入前后核对账号。仅管理页及同账号管理的 `owned` 投影读取，不进入服务端、受邀者目录或日志；未显示的成员记录保留，按原成员 id 接续。损坏文件保留并拒绝覆写。实现与回归见 `device-link/providerShareMemberNotes.ts` 及其同名单测 |
| 供应商分享：转分享的同意 | `userData/owners/<账号>/provider-share-reshare.json`，分享者电脑上记下受邀者的组所在电脑报来的、请求经组使用的人（`provider-sharing.md` §4.3）：服务端生成的分享与成员 id、那台组所在电脑的设备 id、组所在电脑给的不透明键、主人的决定与时间，以及组所在电脑转述的昵称与头像地址（只用于管理页认人，不进日志）。不含对话或凭证。原子替换写入；成员被删除或退出、启动后核对已不在这台的分享与成员时删除对应记录 |
| 供应商分享：短期审批弹窗归属 | `userData/owners/<账号>/provider-share-approval-windows.json`，只记供应商 id、生成端关注的供应商所在电脑 id、非秘密链接标识 `linkId`（随机邀请口令的 SHA-256 摘要）与七分钟截止时刻，不含链接口令、申请、配对码或身份。复用设置文件跨进程锁与原子替换；生成链接返回前完成保存，静默与关注均按链接区分。本机新链接仅清除旧版按供应商静默的窗口，不影响其它链接的精确归属。旧记录仍可读，无标识的旧关注只接无标识申请。完整应用重启的第一轮快照前恢复；远端读取使用新运行时的同账号只读管理通道，不恢复旧回调或重放写操作。过期记录读时忽略、下次写入清理；账号切换隔离，损坏文件保留且拒绝覆写。见 `device-link/providerShareApprovalWindows.ts`、`providerShareHost.ts` 与 `__tests__/providerShareApprovalWindows.test.ts` |
| 供应商组：本机组绑定待清理记录 | 复用 `userData/owners/<账号>/provider-group-prefs.json` 的可选 `bindingCleanups`，只记供应商 id、保留的组员键（整组删除为 null）、时间与不透明代次，不含消息、凭证或用户身份。与组修改共用文件锁和原子替换；组修改、清理回放与新绑定写入另共用同账号目录的 `provider-group-mutation.lock`（先取该锁，再取各文件锁），防止迟到清理误删新分配。账号切换或重启后仍使旧绑定失效；重新加入不撤销清理，多次移出的保留键取交集。新写绑定前先将旧绑定删除与解除记录原子提交，再按代次确认；写盘失败或确认中断保留意图重试，迟到确认不删除新一代记录。旧文件缺字段视为空，旧版写组设置保留未知根字段。见 `provider-group/store.ts`、`bindings.ts`、`managementScope.ts` 与 `__tests__/stores.test.ts` |
| 供应商组：本机组的绑定解除记录 | 复用 `userData/owners/<账号>/provider-group-bindings.json` 的可选 `released`，按任务 id 只记供应商 id 与解除时间，不含消息、凭证或用户身份。删组或移出组员时，与对应绑定删除共用文件锁和原子替换；账号切换前已提交的两部分一同保留。旧文件缺字段视为空，旧版写绑定保留未知根字段，升级后解除记录优先于旧版恢复的绑定；显式重新分配给同一个组时原子清除记录。其他解除路径仍读写 `provider-group-released.json`，读方合并两处记录；损坏绑定文件保留并拒绝覆写。见 `provider-group/bindings.ts` 与 `__tests__/stores.test.ts` |
| 供应商组：任务里选过「以后自动换号」 | `userData/owners/<账号>/provider-group-session-prefs.json` 的 `autoRebalance`，按任务 id 只记打开时间，不含消息、凭证或用户身份（provider-groups.md §6.2）。存在任务所在的电脑上，跨重启保留，不同步、不外发；最多 4000 条，超出丢最早的，上限 512 KB。原子替换写入；读不出或超限时保留原文件、按都没选过处理。降级旧版忽略这个文件。见 `provider-group/sessionPrefs.ts` |
| 供应商组：转分享待清空记录 | 复用 `userData/owners/<账号>/provider-group-prefs.json` 的可选 `reshareCleanups`，只含分享来的电脑逻辑 id 与随机清理代次，不含昵称、头像、对话或凭证。最后一个组引用移出时，与组设置在同一跨进程锁内原子写入；对端确认空名单后按代次删除，失败每分钟重试，重启继续，重新加入先清空旧同意。旧文件缺字段视为空，旧版改写组设置仍保留未知字段；损坏文件保留并拒绝覆写。见 `provider-group/store.ts` 与 `__tests__/stores.test.ts` |
| 供应商按使用方的用量 | `userData/owners/<账号>/provider-usage-by-party.json`，按（日期、供应商、使用方、设备 id、组内电脑的键、Agent、模型）聚合 token 与轮次。使用方：本机、同账号另一台电脑、经同账号组所在电脑转来的受邀者任务、本机经另一台电脑的组在别的组内电脑上运行的（只用来报告给那台组所在电脑）、同账号电脑报告来的（每次报告整体替换那台从某天起的行）；没有使用方字段的旧行按设备 id 推出。原子替换写入，保留 400 天；只含供应商 id、设备 id、组内电脑的键与模型名，不含对话或凭证。按账号存放（供应商 id 在不同账号下会重复），从开始记录起不补历史 |
| macOS 菜单栏余量设置 | `userData/menubar-settings.json`，本机偏好：是否显示、来源顺序与显隐、菜单栏文字、快见底通知、隐藏个人信息、统计范围；只含供应商 id，不含凭证或用量数值 |
| macOS 菜单栏 Cindy 余额样本 | `userData/owners/<账号>/menubar-credit-samples.json`，只记录观测到的余额数值与时间（按区域与币种分组），用于估算日均消耗；保留 30 天、原子替换写入，不含凭证或账号标识 |
| 云端伙伴同步状态 | `userData/owners/<账号>/companion-cloud/<sha256(端点\n主人 actor id)>.json`，只记伙伴的云端 actor id、1:1 房间 id、对话导入游标（本机消息时间与 id）、已上传资料的内容哈希与版本号、是否已交出主力电脑（本机副本隐藏、不跑例行任务）、接管后待重建上下文的标记；原子替换写入，读不出时从空开始并向服务器重新核对，不含凭证、消息正文或资料正文。见 `main/companion-cloud/state.ts` |
| macOS 菜单栏 helper（开发构建） | `userData/menubar/`，开发时由 `swiftc` 编译的 helper 及其 wordmark 图片和源码哈希；打包版改用 `resources/tools/menubar/`，不在 userData 落盘 |
| 供应商分享：受邀者会话登记 | `userData/remote-agent/guest-sessions.json`（控制端摘要 → 本机侧任务与原生会话 id），只用来限制受邀者只能恢复自己的会话，并在分享删除时精确清理影子工作区、附件与会话记录 |
| 供应商分享：跨区域标记 | `userData/remote-agent/provider-share-regions.json`，账号摘要 → 对方区域；**不含凭证**。跨区连接凭证只在内存里，用新身份名片重新换取；没有标记的账号从不联系对方区域 |
| 供应商分享：受邀者对分享的本机偏好 | `userData/owners/<账号>/provider-share-guest-prefs.json`，分享 id → 分享所属区域与「信任 {分享者}」（凭证操作不再确认）；只存显式打开的项，在同路径 `.lock` 跨进程安全锁内重读、修改和原子替换，拿不到锁不保存。持有权切换使排队和在途写入失效；已进入文件系统的替换在新持有者保存前完成，不能覆盖其撤销。不含昵称、对话或凭证。退出分享或分享从已确认区域的权威名单里消失时立即在内存撤销，并取消对应的在途启用；清理落盘失败也不恢复信任。实现与回归见 `providerShareGuestPrefs.ts` 及其同名单测 |
| 语音输入声纹（生物特征） | `userData/owners/<账号>/voice-speaker-profile.json`，「识别我的声音」录入的声纹向量与录入时间，经 `safeStorage` 加密后整体落盘（钥匙串不可用时拒绝写入，不降级明文）；记录生成它的模型哈希，换模型后视为未录入。只在本机，不同步、不上传、不进日志（日志只记分数与次数）；用户删除即删文件。录入用的朗读音频只在内存中处理，不落盘 |
| 语音输入声纹识别模型 | `userData/voice-models/<哈希前缀>-<文件名>.onnx`，按内容哈希从区域 CDN 下载并在可见前校验 SHA-256；不含个人数据，本机所有账号共用。新版本模型下载完成后删除旧版本文件 |
| Mobile 语音输入声纹（生物特征） | SecureStore（iOS 钥匙串 / Android Keystore）键 `xdt.voiceSpeakerProfile.v1.<账号 key 的 SHA-256 前 32 位>`，内容同 Desktop：声纹向量、录入时间与模型哈希；开关与灵敏度 override 在 AsyncStorage `cindy.mobile.voice-speaker-filter.v1.<账号 key>`。只在本机，不同步、不上传、不进日志；退出登录时随该账号的其他本机数据一起删除（模型文件保留）。删除前写 AsyncStorage `cindy.mobile.voice-speaker-filter.cleanup.v1.<账号 key>` 重试标记，不含声纹；失败时保留标记，启动、回到前台及该账号下次读写前重试，全部删除成功后才移除。标记落盘也失败时保留进程内重试，无法保证进程终止后的恢复；不因声纹删除失败阻止退出凭证清除。朗读音频只在内存中处理 |
| Mobile 语音输入声纹识别模型 | `cacheDirectory/voice-models/`，与 Desktop 同一组按内容哈希下载、校验 SHA-256 后才可见的文件；放缓存目录以免进入 iCloud / Android 备份。系统清理缓存后，下次语音输入发现缺失会在后台重新下载，本次不过滤 |
| Windows 锁屏控制的系统服务程序 | `%ProgramFiles%\Cindy Remote Desktop\<安装目录哈希>\`,由「授权开启」的管理员提权步骤写入:两个原生 helper 与记录所属安装目录的 `install.txt`。目录与文件的所有者是 Administrators,只有 Administrators 与 SYSTEM 可写——SYSTEM 服务不能从用户可写的安装目录启动,否则本机任何普通进程都能换掉它。不含凭证、账号或对话。源码运行的开发版另将构建缓存放在 `userData/remote-desktop/development/<安装身份哈希>/`，只含本机编译产物与源码摘要；它仍复制到上述受保护目录后才注册服务。只有设置页的「移除服务」(同样需要管理员确认)会删除它;按安装目录分子目录,多份安装互不影响。见 `native/remote-desktop/windows-host/src/staging.rs`、`apps/desktop/src/main/remote-desktop/windowsHost.ts` 与 [`../remote-desktop.md`](../remote-desktop.md) |
| 用户明确导出的文件                  | 用户选择或任务明确指定的目标路径                                                                                                                                                                                                                                                                                                                                                                                |

- worktree 启动维护（回收重试、旧归档清理、快照引用清理、审计与池恢复）在主窗口首帧、
  数据库及运行服务就绪后延迟 30 秒启动，不加入启动等待链；重复就绪通知与回收事件不能
  提前这次延迟。退出取消未开始的维护，窗口或数据库未就绪时不执行，维护错误按原有退避处理。
  快照与任务元数据按索引查找，每 128 项让出主线程；完整读取恢复记录后才允许清理，不能
  用不完整扫描推断引用无人使用。快照 Git 清理阶段最多安排 5 秒的工作，单次 Git 超时 1 秒，
  超时后的进程树收尾仍沿用 Git helper 的有界宽限期；剩余引用保留到下次启动再处理。
  该预算不包括异步元数据读取，也不强行中断正在执行的 worktree 删除。实现见
  `bootstrap-electron.ts`、`worktree/recycleMaintenance.ts`；回归见 `worktreeRecycleMaintenance.test.ts`。

- 内置 Skill 的官方身份只授予当前 manifest 已提交且指纹匹配的 bundle：`.active` 必须是
  指向该版本的合法链接，版本目录与 Skill 内容不能经替换的符号链接越界。物化失败或目录
  存在本身不构成官方身份；扫描、命令标记与 Learn 发现共用经验证的描述符。异常占位内容
  不覆盖、不认领。实现与回归见 `maker-host/built-in-skills.ts` 及其同名单测。

- 禁止把 `process.cwd()`、仓库根或源码目录作为 userData、凭证目录或临时目录的默认回退。
  特别不要写 `process.env.TEMP ?? process.cwd()` 一类跨平台会落入仓库的逻辑。
- 使用 `path.join`、`path.resolve` 和现有路径策略，不硬编码平台分隔符，不手拼 `~`、
  `%APPDATA%` 等平台目录。
- 共享 package 不直接依赖 Electron 来猜宿主目录；由 Desktop、Mobile 或测试显式注入路径。
- 新模块不得在 import 时创建目录、写文件或复制授权材料。文件系统副作用应在显式初始化
  或用户动作中发生，便于控制路径、失败语义和清理。
- 临时文件使用唯一目录或文件名，完成、失败和取消路径都应尽力清理；需要跨重启保留的
  内容不属于临时文件，应进入明确的 userData 存储与生命周期设计。
- 浏览器适配器的输入由实际调用任务的宿主文件代理打开，复核普通文件、大小和 bigint
  dev/ino 后，同一描述符用于读取和元数据检查；复制或外部转换器使用批准字节的调用内副本，
  不重开源路径。Desktop 不给适配器授予基于路径字符串的任务文件输出能力：已校验路径
  不能保证后续写入不跟随被替换的链接。直接落盘命令暂缓，生成返回链接、网页读取返回正文，
  需要保存时使用既有宿主文件工具。SSH 无本地根时拒绝读取，不使用控制端 cwd。诊断截图、跟踪、Cookie
  交接与媒体转换复用每次调用的唯一临时目录，调用结束时清理，不作为持久成果。
  实现见 `packages/opencli-vendor/cindy/host.ts` 与
  `apps/desktop/src/main/mcp-integrations/browser-backend/rsb-webview-upload-policy.ts`；
  回归见对应上传策略测试和 `packages/lizi-mcps/src/browser/opencli-recipes.test.ts`。

## Review 清单

1. 写入目标是否可能位于仓库、当前工作目录或被 Git 跟踪的路径？
2. 是否把真实凭证带入了测试、fixture、日志、错误或 Renderer？
3. 持久数据、临时数据和用户导出是否选择了正确的生命周期与目录？
4. 路径回退在 Windows、macOS 和 Linux 上是否都不会落入工作区？
5. package 是否由宿主注入路径，且初始化没有隐式写盘副作用？
6. 失败、取消和测试结束后，临时数据是否能安全清理？

命中凭证进入仓库或不受信任边界的改动必须阻断。验证命令按
[`desktop-development.md`](desktop-development.md) 或
[`mobile-development.md`](mobile-development.md) 选择，并为路径回退、清理和秘密不外泄补
定向测试。

## Cindy 托管的预装技能

`cindy-plugin-creator` 从内置 bundle 13 起提供。核验旧 bundle 时只对这个尚未引入的技能
容许缺席；已记录的指纹以及 bundle 13 起的完整性要求不放宽。升级失败时保留旧 bundle
的已核验技能入口，成功后随同一 `.active` 指针发布新技能，不要求用户重新安装。

内置技能字节仍在 Cindy 的 `shared-system-skills` 中随应用版本管理，当前实例在
`<userData>/managed-agent-skills/cindy` 中建立私有入口。三套 Harness 分别通过本地
Claude plugin、Cindy 的 `CODEX_HOME/skills`、Pi 显式 `--skill` 加载；不再安装到
`~/.agents/skills` 或 `~/.claude/skills`。存量插件技能使用账号隔离的
`<ghost-install-state>/agent-skills`，继续只指向已批准快照。

运行期清单来自已验证的内置描述符与插件批准快照，不扫描私有投影目录中的占位内容。
三套 Harness 均加载核验后的物理来源；Codex 在默认及独立账号的 `CODEX_HOME` 中
逐个挂载这些技能，每次本地任务启动（包括复用 app-server）都刷新实际 home 的入口，
并通过原生 `skills/list forceReload` 清除旧发现缓存；刷新失败则不提交新线程。
投影函数统一要求每个托管来源为已建立或保持正确链接；缺失、冲突、扫描环及 I/O 错误
直接抛出，默认账号、独立账号和复用进程均不能把 warning 当作成功。用户技能兼容根
仍保留原有 warning 行为，用户实体目录及外来链接不被覆盖。
不将整个私有目录交给扫描器。Bot 的路径授权与
Claude/Pi 最终加载使用同一物理来源，目录别名重指不能替换已授权的技能。
Codex Bot 在刷新原生技能清单后，按启动时冻结的物理路径授权生成线程级开关；
刷新中新出现或未成功核验的技能默认禁用，无法定位路径的发现错误阻止线程启动。

Pi 将筛选后的物理来源链接到现有会话配置目录内，通过单个 `--skill` 目录参数交给
原生加载器；技能数量不会增加启动参数长度，`--no-skills` 的 Bot 白名单仍生效。
入口随会话配置目录一起回收；技能发现、路径解析和建链失败均走同一既有启动失败清理，撤销 MCP 会话路由与
权限临时文件，不新增全局目录或独立清理机制。

Claude 的插件技能不受 `skillOverrides` 控制，因此每个本地 Query 只将已启用且
符合 Bot 白名单的技能链接到临时插件入口；关闭 Query 时回收入口，源文件不变。

升级清理只删除可确认由 Cindy 创建的旧软链接，不删除目标内容、不覆盖用户同名
技能、不修改 Git ignore。旧版本 Cindy 实例仍可能重建旧链接，这是迁移的已知边界。
