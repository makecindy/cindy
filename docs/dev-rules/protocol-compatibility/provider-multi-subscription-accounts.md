# 供应商内多订阅账号（2026-11-07 起；账号池与旧 Codex 连接归并已随 v0.1.135 正式版发布）

## 自动化继续使用合并后的来源（2026-11-14）

供应商目录给同账号控制端可选追加 `subscriptionPoolTarget`，只与 `subscriptionPoolAlias: true` 一起出现，
值由执行电脑按当前账号归属派生。目标未开放远程调用或未覆盖原来源的逐模型权限时，两字段均不发布；
访客目录剥离目标字段，不公开分享者的其它供应商关系。没有增加读请求、channel、allowlist 或 relay 帧。

自动化下一次触发与恢复原配置时，只有原来源仍是 alias、原模型仍获授权、目录目标明确等于任务当前来源，
才沿用已交接的来源。旧执行端不带目标字段时仅兼容原先唯一目标 `openai`，不能据 alias 标记猜测其它目标；
旧控制端忽略新字段，沿用原行为。官方及自建中转继续透传既有 JSON，无需服务端适配；真实双设备互通未验。
回归为 `orcaModelSelectionIntent.test.ts`、`providerListProjection.test.ts` 和 `providerShare.test.ts`。

## ChatGPT credits 请求准入（2026-11-13）

执行电脑的账号池不再用套餐窗口拦截 ChatGPT 请求；缓存 credits 只显示，实际准入由上游判断。
组主读取已有 `nativeAccountPool: true` 快照时保留窗口展示与排序，忽略它作为套餐耗尽的准入阻断；
真实错误冷却、权限与并发上限照旧。按模型的可用性查询只接受执行端已登录、未暂停、授权且无真实冷却的账号，
仍要求已知模型窗口；窗口用满不排除可能使用 credits 的 ChatGPT 账号。重置卡唤醒仍判断实际窗口恢复。
没有新增或改写字段、channel、allowlist、重试、订阅或隧道帧；窗口百分比也不伪装成未用过。
旧组主仍按旧窗口逻辑筛选，新组主面对无原生池标记的旧执行端保留旧判定，修复完整生效需相关 Desktop 升级。
官方和自建中转仅透传原有 JSON，无需服务端修改；回归覆盖账号池准入及本机／远程成员的真实路由与冷却。

## 每个 OpenAI 账号的额度重置（2026-11-13）

账号管理视图可选追加 `codexResetProviderId`，仅供现有额度重置读／写 IPC 选择目标。
新增原生账号使用 `openai-account:<accountId>`，执行端按当前 owner 的已存账号解析目录，
不接受调用者提供路径；默认账号仍为 `openai`，迁移账号保留原连接 ID、设置与兑换锁。
读取、手动兑换和自动规则保存沿用原参数和回包；旧客户端忽略新字段，新客户端连接旧宿主时
读取不支持目标则隐藏额外控件，不回退到默认账号。可选字段不进入模型路线或匿名分享配额。
沿用同账号 owner 门禁，访客不能授权扣卡；没有新增 channel、allowlist、能力位或中转行为，
官方及自建中转继续透传原 JSON，无需服务端升级。自动检查运行于执行电脑；手机本轮未增加账号级重置 UI。
回归入口为 `subscription-accounts/__tests__/runtime.test.ts`、`SubscriptionAccountsSection.test.tsx`
和 `useCodexRateLimits.test.ts`；没有进行真实双设备互通或上游扣卡验收。

`openai` 目标代表默认账号。Windows 没有建链接权限时内置连接改走独立登录，Cindy 的 `codex-home`
可能没有任何登录文件，而默认账号仍在 `~/.codex` 正常运行（2026-11-13 设置页一直显示配额更新失败）。
只有「内置连接没有自己的登录文件、默认账号不是旧版私有目录且其目录有 `auth.json`」时，`openai` 的读取、
兑换与自动规则身份才改按默认账号目录处理，读法和凭证门禁与其它池内账号相同，不写入内置连接的用量缓存；
内置连接有任何登录条目时保持原读取与恢复确认。参数、回包与 channel 不变。回归见 `usage/__tests__/codexDefaultAccountHome.test.ts`。

`subscription-accounts:changed` 可选追加 `resetAccountId`：只标记该账号的重置数据已刷新，
额外账号的重置读取仅响应自身 ID。普通任务运行数通知继续只带供应商 ID，不触发整池 CLI 重读。
旧控制端忽略此可选字段；新端面对旧通知仍保留挂载与手动刷新，不借用其它账号的数据。
已登录账号的重置入口独立于用量卡：额度暂时未知时仍可读取重置卡与自动规则。

2026-11-13 取消自动归并并还原（[合并与拿出由用户决定](../../product-rules/subscription-account-pools.md)）：账号属于哪个供应商记在
owner 本机新文件 `subscription-account-placement.json`，不进入任何 wire 载荷。新版执行端只对仍归并的旧连接设置
`subscriptionPoolAlias`；`maker:subscription-accounts` 的 `read` 只列内置供应商自己的账号（带 `taskId` 时保留该任务自己的账号）；
池配额、模型可用性与匿名分享用量只统计内置供应商自己的账号；`session` 查询对已还原的旧连接不再回报 `replacementProviderId`。
字段与形状均不变，只是取值范围变小：旧控制端看到还原后的连接是普通独立连接，收到的回包仍可解析，且不会据此把任务改到 OpenAI；
旧执行端仍按归并处理，新控制端照旧只在明确收到替代来源时交接。没有新增 channel、allowlist、能力位或中转帧，官方与自建中转无需适配。
降级到旧版后，旧版会按自己的规则再次归并且忽略新文件；再升级时再还原，用户明确选择的归属不受影响。
回归入口：`subscription-accounts/__tests__/ipc.test.ts`（真实还原写入）、`runtime.test.ts`（任务跟着账号、内置供应商不再分配）、
`maker-host/__tests__/providerCatalogRealmReload.test.ts`（目录投影与定时任务准入）；未做真实双设备新旧混用互通。

同日第 2 批（用户主动并入／移动／拿出、Cindy 新建的订阅供应商）：
- **目录字段**：`Provider.subscriptionPool?: 'openai' | 'anthropic'` 标记 Cindy 为订阅账号新建的供应商，ID 为
  `openai-sub-<8 位>`／`anthropic-sub-<8 位>`，由执行端按 placement 文件镜像同类订阅的路由；OpenAI 模型成员按本供应商
  账号各自发现的目录投影，不借用其它供应商的目录（不带平台 key 的图片／视频）。已有任务的完整路由目录另保留
  持久绑定 `via` 指向本来源的账号型号，供合并后的历史与自动任务恢复；有历史的已登录暂停账号可只读发现模型元数据，
  使冷启动也能先到达交接流程，执行准入仍拒绝暂停账号。新选用与访客投影不加这部分。
  `ProviderView.subscriptionAccountPool?` 表示执行端在该类账号池里管理这个供应商的账号
  （内置、新建或已登记的旧 Codex 连接）。两者都是可选字段：旧控制端忽略后，新建条目按复制来的内置字段显示为
  `auth: { method: 'oauth' }`、无描述符的内置来源——只读、没有登录或断开动作，不会被当成 OpenAI／Anthropic 本身或
  09-24 停用的旧 Claude 连接；远程调用默认关闭，用户打开后旧控制端按原 ID 发起任务，由新执行端解析。
- **`maker:subscription-accounts`**：`providerId` 从内置两种放宽为任意供应商 ID 形状，执行端按自己的记录解析，非订阅
  供应商仍拒绝。新增 `create`（只接受内置 ID）、`place`（`target: string | null`）、`merge`（`target: string`）、
  `remove-provider`；`SubscriptionPoolView` 可选追加 `kind`，`providerId` 为实际所属供应商。旧执行端对这些动作或非内置 ID
  一律回 `INVALID_PARAMS`，新控制端据此提示「执行电脑需要更新」，不退回成加进内置供应商。变更通知仍按账号池类型
  （`openai`／`anthropic`）发出，同类所有供应商的界面一起刷新。没有新增 channel、allowlist、能力位或中转帧，
  官方与自建中转无需适配。
- **任务绑定**：`subscription-accounts.json` 的账号绑定可选追加 `via`，记下绑定时任务指定的供应商（内置时省略）。
  任务改选同类的另一个供应商、且原账号不在那里时，发送前检查（`needsSubscriptionAccountHandoff`）要求交接，
  新会话在新供应商里选账号；绕过交接直接续接原生会话则明确报错，不在别的账号目录里续接。
  远程执行的任务由执行电脑自己判断，旧执行端不认识新建供应商，不在此列。账号被移动时任务指定的供应商不变，因此继续跟着账号走。旧版原样保留绑定对象，
  不读这个字段。
- **分供应商的远程交接（2026-11-14）**：`session` 查询可选追加 `routeProviderId`，表示任务选择的实际供应商；
  执行端按自己的归属和原生绑定解析，并在回包回显同名字段。旧 Codex 查询的 `legacyProviderId` 仍接受，二者不能同时传。
  新控制端只有收到匹配的回显，才采信新建供应商的换号准入；执行端忽略字段或返回不匹配来源时保留原生历史，不猜默认池。
  `replacementProviderId` 在带来源回显时可为执行端确认的同类目标 ID，表示实际准入通过后的合并目标或用户刚改选的目标。
  暂停账号可追加 `switchAvailable`；旧账号已移除或用户改选来源时可保持 `unavailable` 状态并附明确替代目标。
  无回显的旧回包只保留既有 `openai` 替代兼容路径；旧控制端忽略其它目标，不能据此交接到未知供应商。
  同账号权限、来源与目标模型授权、并发和真实失败冷却均由执行端核验，访客不使用此交接查询。
  仍为每次发送一次原有 owner 查询，共享原有 2 秒准入预算；新端暂停路径不再额外查整池额度。
  没有新增 channel、allowlist、隧道帧或服务端请求，官方与自建中转透传原有 JSON，无需同步服务端改动。
  回归通过真实查询／解析／交接入口覆盖新建及旧连接目标、来源改选与旧端无回显；未进行真实双设备新旧版本混用验证。
- **降级**：旧版忽略 placement 文件，新建供应商从目录消失，其账号回到内置供应商下显示；任务绑定存在账号池文件的
  既有字段里，不会丢失。指定了新建供应商 ID 的旧任务在旧版里显示为来源不可用；回到新版后归属与任务恢复。
- 回归入口：`subscription-accounts/__tests__/ipc.test.ts`、`runtime.test.ts`（命令解析与执行）、
  `renderer/__tests__/addProviderWizardOpenAiAuth.test.tsx`（添加时选择放在哪里）。

2026-11-11 旧独立 Codex 连接归并：供应商视图可选追加 `subscriptionPoolAlias: true`，表示本机设置与新来源栏在 OpenAI 内管理此账号；原供应商 ID、执行与鉴权语义保留。旧控制端忽略字段，继续显示独立连接。新版 owner 控制端在模型清单展示层隐藏重复来源，但明确指定的旧任务／自动任务仍保留原 ID 并通过原连接校验。整个 OpenAI 池没有开放远程调用或没有覆盖旧连接全部已开放模型时，远程目录不带旧连接的归并标记，避免移除原已开放入口；跨账号分享一律剥离标记，不让被分享的单账号变成整个池。没有新 channel、能力协商、隧道帧或服务端字段，官方与自建中转均按原协议透传。

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

2026-11-12 Claude 登录到期：owner 账号管理视图可选追加 `loginExpiresAt?: string`（官方 CLI 的 ISO 到期估计），
以及 `authIssue: 'claude-account-mismatch'` 和固定错误码 `SUBSCRIPTION_CLAUDE_ACCOUNT_MISMATCH`、`SUBSCRIPTION_CLAUDE_IDENTITY_UNKNOWN`。
新增字段只属于账号管理，不进入匿名分享用量或任务选号协议；登录命令仍只传原来的 `accountId`，目录与期望身份由执行电脑解析。
旧控制端忽略字段，未知错误按通用失败展示；新控制端面对旧执行电脑或旧 CLI 时显示到期未知，继续使用原登录命令，不承诺旧端具备身份复核。
本机 owner 元数据追加可选 `lastConfirmedIdentity`，在正常 CLI 认证读取后保存，退出登录或重启不清除；
`reloginIdentity` 保护一次未完成的重登，确认原身份成功后删除。两者不进入账号视图，也不搬移或改写官方凭证。
原身份无法确认时不启动重登，提示通过添加账号重新连接；初次 `add` / `connect` 不受该限制。
降级旧版本会恢复旧的登录行为，旧版本不认识身份保护元数据；未完成的重登应在新版确认原账号后再降级。
没有新增 channel、allowlist、订阅或轮询，也不改变 invoke/push 包装与中转签名；官方及自建中转继续透传原 JSON，无需中转升级。
回归覆盖新旧字段、owner IPC、所选目录、错误身份与取消后重启恢复；真实双账号浏览器授权仍需安装包验收。

Codex 所选目录由当前供应商管理认证、无法提供 ChatGPT 账号时，管理操作使用追加的
`SUBSCRIPTION_CODEX_PROVIDER_AUTH` 错误码。新版控制端显示独立账号指引，旧控制端仍按通用账号失败呈现；
新版连接旧宿主仍接受旧错误。账号视图可选追加 `authIssue: 'codex-provider-managed-auth'`，让新向导
在首次检测时显示原因和独立账号入口；旧端忽略、缺省或未知值沿用原显示。沿用原 IPC 包，无新 channel、allowlist 或 relay 行为，
官方及自建中转无需适配。错误只含固定诊断，不带供应商配置、目录、账号或 CLI 原始响应。

同账号远控新增 `maker:subscription-accounts`（查看、添加、重连、取消、移出、策略）及
`maker:subscription-pool:quota`（只读、无账号身份的池配额）。管理请求只接受内置供应商及
不含路径的账号 id，宿主按当前 owner 推导目录；共享任务访客不能使用。
该只读通道可选追加第二个参数 `model`（非空字符串，最多 512 字符），查询多账号池是否仍有该模型的明确可用容量，
返回 `{providerId, model, available: boolean | null}`，不带账号身份或目录。缺省参数仍返回原 `{providerId, pooled, usage}`。
新组主只接受 providerId/model 精确匹配的布尔回执；旧宿主忽略新参数并回原聚合形状时保留冷却，不能据此清除模型错误冷却。
查询沿用同账号 owner 校验和在途 owner 栅栏，不增加 channel、allowlist、协议帧或服务端字段。
官方与自建中转均通过原 invoke 参数透传，无需中转升级；验证覆盖 owner IPC、新旧端回包及共享客户端／自建中转测试与签名互通。
添加向导使用只读 `preview` 展示未绑定的默认 CLI 登录；`connect` 的 `target` 必填为
`default` 或 `new`，后者始终创建独立目录。沿用原 channel 和 owner 校验；旧客户端的
`read` / `add` 行为不变。旧宿主拒绝新 action 时显示重试错误，禁止退回含糊的 `add` 而
静默接入旧账号。官方及自建中转均透传这些 action，无新增服务端字段。
2026-11-14 起 `preview` 回包可选追加 `defaultAdded: boolean`：默认 CLI 登录已被内置供应商使用，或同一身份已是同类
未断开的其他账号时为 `true`，新向导据此不再提供默认账号快捷按钮。只读已保存记录与已缓存身份，不额外读取 CLI 或额度。
旧控制端忽略该字段；新控制端连接旧宿主时字段缺省，按原样提供快捷按钮。沿用原 channel，中转无需适配。
`subscription-accounts:changed` 普通变化仅推送供应商 id，重置数据刷新可附加上述 `resetAccountId`，
路由到既有 `sessions` topic 后由当前管理页重读。
`read` 的账号视图以 `usage`（该账号自身的 Claude 窗口快照或 Codex 桶及余额）取代未发布的单条 `quota`。
同账号 `manage-share` 的 `quota-account` 在池内有多个可分配账号时额外返回 `accounts`（匿名数组），
顶层仍是首个账号：旧组主只读顶层，新组主遇到无 `accounts` 的旧成员按单账号显示。
组主展开各电脑账号后仍遵守既有 insights v1 的 512 项上限，超出时按原顺序保留前 512 项并设
`partial: true`，不扩大接收端校验上限，旧接收端仍能解析额度及同份回包中的用量历史。
普通任务和远程执行仍通过宿主同一个 Agent 入口选择账号；账号能力是进程内 Symbol，不进入 JSON。

双端混用版本（2026-11-07）：新版提供端在通过原有同账号远控授权后，给旧控制端的
`maker:usage:claude-subscription`、`maker:usage:account`（codex）和
`maker:usage:codex-rate-limits` 投影池内可用额度，保持原窗口、桶表和 providerId 形状。
池未配置或只有正常默认账号时继续原 handler；已断开或没有可读额度时回 null，禁止回退首账号的旧快照。
不传账号身份、路径、凭证和重置 offer，不合计百分比。分享访客仍走既有 insights v1，不能调用这些 owner 通道。
Codex 原生桶不冒充 WHAM：旧 bridge 无法表达按模型的账号池额度时保持未知，由执行端选择账号；
旧 rate-limits 读取不把过期缓存重新标为刚读取的额度。
新版默认账号用量卡在旧参数后追加 `default-subscription-account`：Claude 位于 args[2]
（args[1] 仍是 fresh），Codex account 位于 args[2]，rate-limits 位于 args[1]。
新版提供端保留此 scope 的原单账号读取；旧提供端忽略附加参数，保持原行为。
任务额度重置查询在同一位置追加 `{ subscriptionSessionId: <native SDK id> }`，由执行端用
本机持久绑定读取实际账号的窗口，沿用原 reader 的缓存与节流，不能读取下一可用账号。旧宿主忽略追加对象，
仍返回自己的原单账号；未绑定的旧任务走原 reader，已移出或断开的绑定返回 null。
该对象不携带目录、账号标识或凭证。OpenAI 任务快照追加 `nativeAccountPool: true`，
新使用端的三个引擎都按该账号的原生模型桶求重置时间，不拿 WHAM 或其它账号窗口替代。
官方及自建中转仅透传原 invoke，无帧、allowlist 或服务器变更。

任务的账号显示（2026-11-11）：`maker:subscription-accounts` 追加只读 action `session`
（`providerId`、`sessionId?`、`nativeSessionId?`，通常至少一个 id，各 ≤256 字符；旧来源的无原生会话查询见下文），沿用同一 owner 校验，共享任务访客不可用，
不进入管理命令执行器，Helper 不暴露。执行端按「任务 → 原生会话」顺序读持久绑定，回 `{ providerId, state }`：
`legacy`（无账号池、只有默认账号或池前旧任务，调用方沿用原 reader）、`unassigned`（下一轮才选账号）、
`unavailable`（绑定的账号已移出或供应商已断开）、`bound`（附 `account`：`isDefault`、池内序号、身份、套餐、状态与该账号
自己的 `usage`，形状同 `read` 的账号视图，不含目录与账号 id）。旧宿主以 INVALID_PARAMS 拒绝未知 action（读不懂的回复同样
处理）时，远程任务的新使用端改用上文任务额度重置查询的 `{ subscriptionSessionId }` 追加参数读原 Claude / Codex 用量 channel，
得到的是该原生会话所在账号的窗口，只显示用量、不显示身份；回 null 时不显示用量。不再落回 `default-subscription-account`
读法——那会把执行端的默认账号当成任务的账号。早于该追加参数的宿主忽略它并返回原单账号。查询失败、回复不可解析，或旧宿主不支持
新查询且缺少原生会话 id 时，保留同 owner 代次的上次结果；没有已知结果就保持未知并允许后续刷新，不冒用默认账号。
只有宿主明确返回 `legacy` 才恢复原读取。官方及自建中转只透传原 invoke，无新 channel、allowlist 或服务端字段。

远程组先探测池配额；旧电脑不支持时回到原有 Claude/Codex 配额 channel。同一电脑/供应商的
探测合并、缓存 30 秒并随 owner 代次丢弃。旧控制端忽略新 push，现有调用格式不变。
OpenAI 池快照增加可选 `nativeAccountPool` 标记，当前控制端让三种引擎按模型读取同一套
原生额度桶；旧控制端仍可读取 `webSnapshot` 的通用桶，不含账号身份。
官方及自建 relay 均只透传已有 invoke/push 帧，无需服务端协议变更。原生手机目前没有本机
供应商连接设置页；执行和远控通道复用上述协议，浏览器登录仍在执行电脑完成。

## 远程任务的账号换号判断（2026-11-12）

`session` 查询可选追加 `model`（非空字符串，最多 512 字符）。新版执行端在 `bound` 回包的 `account` 上可选追加
`blocked: true`：绑定账号此刻接不了这个模型（记着该模型的真实失败、可信快照显示耗尽或已退出登录），且不是暂停账号；
2026-11-13 起归并来的账号同样回报（执行端新开会话也会把任务换离它），字段格式不变，旧控制端收到后照原规则交接，
早于该日的执行端仍不回报归并账号、行为不变。字段缺省表示可用或未知。`blocked` 回包同时追加可选布尔字段 `switchAvailable`：执行端排除绑定账号后，
按真实选号入口只读检查另一个账号的认证、模型额度／冷却、并发名额和新路线权限，不预约、不修改绑定；读不到时为 `false`，
owner 变化仍拒绝。可选准入从查询开始共用 2 秒预算，原账号读取已耗尽预算时不启动额外探测，
原账号读取的既有超时保持不变；探测迟到仅完成既有 owner 隔离的快照读取，不改绑定或预约名额。
新版控制端只在 `blocked: true` 且 `switchAvailable: true` 时交接（重开原生会话，由执行端新开会话按池策略选号），
否则照常发送，不为此再读一次池配额。撞限后的立即续跑与供应商组的原地换账号用同一组证据。
旧执行端忽略 `model`、不回报这两个字段，新控制端据此不交接，
行为与以前相同；旧控制端不发 `model`，新执行端不回报新字段。暂停交接沿用原判定。新增字段不含账号 id、身份、目录或凭证；
原 `session` 回包仍只向同账号 owner 展示既有的账号身份与用量。
发送前仍只有原有的那次 `session` 读取，只多带模型并在执行端确认实际准入；暂停账号仍沿用原先的配额读取。
沿用原 channel、owner 校验与在途 owner 栅栏，
无新 channel、allowlist、能力位、帧或服务端字段，官方与自建中转按原 invoke 透传，无需升级。
回归入口：`subscription-accounts/__tests__/runtime.test.ts`（执行端回报、控制端新旧回包、真实组服务 → 路由 → 账号池）。

2026-11-13 补齐仍保存旧连接 ID 的同账号远程任务：`session` 查询可选追加 `legacyProviderId`（仅 OpenAI、非空且不超过 256 字符），
尚未建立原生会话时可只传该旧来源与模型，不必伪造任务或原生 ID；旧执行端会拒绝这种新查询，控制端保留原路径。
执行电脑按自己的归并映射与已有原生绑定核对，不能用控制电脑的映射猜。仅宿主派生的同账号远程上下文，且原来源和归并后 OpenAI 的远程／
模型权限及另一个账号的实际准入均通过时，在原回包顶层追加可选 `replacementProviderId: openai`；暂停与移出账号也可回报，后者仍为
`state: unavailable`。该字段只表示可带上下文交接到归并来源，不带账号标识、目录或凭证，不预约或修改绑定。
新控制端仅在明确收到该字段时交接、把保存来源改为 OpenAI，再由同一执行电脑的新启动按池选号；普通 `blocked` / `switchAvailable`
不足以改变旧连接来源。旧执行端忽略请求的新字段且不回报替代来源，新控制端保留原路径；旧控制端忽略新回包字段。
标准 OpenAI／Anthropic 路线沿用既有查询。候选旧来源每次发送只读一次执行端账号查询，未归并 ID 在映射检查即返回；无新轮询或重试。
沿用原 channel、owner 和在途 owner 栅栏，无新增 allowlist、能力位、relay 帧或端点；官方与自建中转均为原 invoke 载荷透传，无需升级。
回归入口为 `runtime.test.ts` 的执行端准入 → 回包解析 → 控制端交接 → 新 Agent 启动，以及 `ipc.test.ts` 的字段校验和目标来源权限。

## 已绑定任务启动失败的提示

启动准入仍使用原账号绑定与原用量判据，不改变选号、重试或自动等待。
错误文本增加 `SUBSCRIPTION_ACCOUNT_LIMITED`、`SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED`、
`SUBSCRIPTION_ACCOUNT_SIGNING_IN`、`SUBSCRIPTION_ACCOUNT_UNAVAILABLE` 方括号标记。
受限错误仅在该账号、该模型的既有判据给出可靠未来重置时间时追加一行
`resetAtMs=<unix 毫秒>`；不附账号身份、目录或凭证。
Desktop 的实时横幅、历史错误卡和 Mobile 共用 `maker-shared/error-redaction` 的展示解析，
按查看端语言与时区显示时间；展示时再次检查重置时间仍在未来，已到期的历史错误使用不带时间的提示。
未知时间不推算，旧的 login-or-quota 文本只显示中性的账号状态检查提示。
旧控制端仍显示通用错误及原始详情，新控制端兼容旧宿主。沿用错误字符串，无新 channel、
能力协商或 relay 行为；官方及自建中转保持透传，不需要服务端发布。

## Claude 百分比来源（2026-11-11）

`ClaudeUsageWindow` 可选追加 `utilizationSource`（`oauth-endpoint` / `unified-headers`），
记录该窗口百分比的来源；快照级 `source` 仍表示最近一次更新来源。同一有效额度周期内，
已知端点百分比不被 SDK 事件覆盖；事件仍即时更新限额状态，端点缺失、窗口已失效或新周期
时可补充百分比。端点后续回包可修正数值，不采用只升不降的最大值策略。

旧快照无字段时沿用快照级来源；旧端忽略新字段，照旧读取百分比与重置时刻。
不同窗口分别记录来源，避免 5 小时重置影响仍有效的周窗口。
字段随现有用量快照传递，无新增 channel、能力门或中转行为；官方与自建中转继续透传。
账号池的运行时事件不更新账号查询的缓存时间，保持已有 30 秒账号检查与 180 秒额度复用周期。
回归入口：`claudeSubscriptionUsageMerge.test.ts`、`subscription-accounts/__tests__/runtime.test.ts`。
