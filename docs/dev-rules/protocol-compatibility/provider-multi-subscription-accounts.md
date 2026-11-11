# 供应商内多订阅账号（2026-11-07，未发布）

2026-11-11 旧独立 Codex 连接归并：供应商视图可选追加 `subscriptionPoolAlias: true`，表示本机设置与新来源栏在 OpenAI 内管理此账号；原供应商 ID、执行与鉴权语义保留。旧控制端忽略字段，继续显示独立连接。新版 owner 控制端在模型清单展示层隐藏重复来源，但明确指定的旧任务／自动任务仍保留原 ID 并通过原连接校验。整个 OpenAI 池没有开放远程调用或没有覆盖旧连接全部已开放模型时，远程目录不带旧连接的归并标记，避免移除原已开放入口；跨账号分享一律剥离标记，不让被分享的单账号变成整个池。没有新 channel、能力协商、隧道帧或服务端字段，官方与自建中转均按原协议透传。

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

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
`subscription-accounts:changed` 仅推送供应商 id，路由到既有 `sessions` topic 后由当前管理页重读。
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
（`providerId`、`sessionId?`、`nativeSessionId?`，至少一个 id，各 ≤256 字符），沿用同一 owner 校验，共享任务访客不可用，
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
