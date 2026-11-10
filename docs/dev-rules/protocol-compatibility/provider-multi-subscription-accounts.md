# 供应商内多订阅账号（2026-11-07，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Codex 所选目录由当前供应商管理认证、无法提供 ChatGPT 账号时，管理操作使用追加的
`SUBSCRIPTION_CODEX_PROVIDER_AUTH` 错误码。新版控制端显示独立账号指引，旧控制端仍按通用账号失败呈现；
新版连接旧宿主仍接受旧错误。账号视图可选追加 `authIssue: 'codex-provider-managed-auth'`，让新向导
在首次检测时显示原因和独立账号入口；旧端忽略、缺省或未知值沿用原显示。沿用原 IPC 包，无新 channel、allowlist 或 relay 行为，
官方及自建中转无需适配。错误只含固定诊断，不带供应商配置、目录、账号或 CLI 原始响应。

同账号远控新增 `maker:subscription-accounts`（查看、添加、重连、取消、移出、策略）及
`maker:subscription-pool:quota`（只读、无账号身份的池配额）。管理请求只接受内置供应商及
不含路径的账号 id，宿主按当前 owner 推导目录；共享任务访客不能使用。
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

远程组先探测池配额；旧电脑不支持时回到原有 Claude/Codex 配额 channel。同一电脑/供应商的
探测合并、缓存 30 秒并随 owner 代次丢弃。旧控制端忽略新 push，现有调用格式不变。
OpenAI 池快照增加可选 `nativeAccountPool` 标记，当前控制端让三种引擎按模型读取同一套
原生额度桶；旧控制端仍可读取 `webSnapshot` 的通用桶，不含账号身份。
官方及自建 relay 均只透传已有 invoke/push 帧，无需服务端协议变更。原生手机目前没有本机
供应商连接设置页；执行和远控通道复用上述协议，浏览器登录仍在执行电脑完成。
