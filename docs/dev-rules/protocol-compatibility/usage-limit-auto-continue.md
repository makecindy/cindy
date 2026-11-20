# 账号用量上限的自动继续

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

输入投影 `AgentInputProjection` 新增可选字段 `usageLimitWait: { resumeAt } | null`，与 `error`
同时出现，表示被控端会在 `resumeAt` 自动继续该任务；旧被控端缺省，控制端按无等待处理。
新增 invoke `maker:input:cancel-usage-limit-wait(sessionId, opts?)`（Desktop preload、Mobile
transport 与 device-link 的 core / review-input / mobile allowlist 均已登记），只撤等待、保留错误
与 typed recovery，返回最新投影；控制端只在投影带等待时显示取消入口，因此不会对旧被控端发起
该调用。自动继续复用既有 `CONTINUE_AFTER_ERROR_PROMPT` 与 `agentMeta.autoResume`，
`autoResumeInfo.reason` 新值 `usage-limit-reset`，旧客户端按普通自动续跑行显示。
Claude Code 终态 error 事件可带 `usageResetAt`（unix ms）。服务端无需改动。
供应商组自动换电脑(2026-10-09，`docs/product-rules/provider-groups.md` §6.1)复用同一条续跑路径，
`autoResumeInfo` 新增可选字段 `agentSwitch: { from, to, cause }`(cause 为 `usage-limit` / `auth` /
`unavailable` / `overload`)，Desktop 与 Mobile 据此显示「{from} {原因}，已换到 {to} 继续」；字段缺失或
不合法时照常显示 `usage-limit-reset` 的文案，旧客户端忽略该字段。P1 不改远程 Agent 协议：被分配到别的电脑的
任务就是普通的远程 Agent 任务。分享的人这边的自动换电脑(P2c，2026-10-10)另加可选字段 `groupSwitch: { cause }`
(不带电脑名称)，Desktop 与 Mobile 显示「已自动换一台电脑继续」；旧客户端忽略，显示「用量已恢复，已自动继续」。
换电脑期间不报错(2026-10-10)：被控端判断供应商组会先试着换电脑时，输入投影里先不带这次 `error`(也不带
`usageLimitWait`)，改带 `autoResumePending`，其中新增可选字段 `groupSwitchPending: { cause }`，次数字段为 0、
`error` 只用于控制端认出随后的终态 event 是同一次失败的回声；新 Desktop 与 Mobile 据此显示「正在换一台电脑继续」，
并且不论哪种 Agent 都不再用这次终态 event 点亮横幅。换成了投影直接进入续跑；没换成投影恢复带 `error`。旧客户端忽略该
字段，按普通「重新连接中」显示(不带次数)；旧 Desktop 控制端对 Claude Code / Pi 仍会被终态 event 短暂点亮横幅，
下一份投影即收回。只改投影内容，不新增 invoke 或推送通道，服务端无需改动。
连不上先等它恢复(2026-10-11)：等原电脑恢复期间，`autoResumePending` 是一次普通的重连进度(`attempt` 1–5、
`maxAttempts` 5、`sessionTotal` 0，不带 `groupSwitchPending`)，新旧端都显示「重新连接中 n/5」；发送前等的时候同样挂在
还没派出的这一轮上(不带 `error`)。开始换电脑时回到上面的 `groupSwitchPending`。恢复后在原电脑续跑，续跑记录的
`autoResumeInfo` 新增可选字段 `agentReconnect: { computer }`(读不到名称时为空串)，新 Desktop 与 Mobile 显示
「已重新连上 {电脑}，继续运行」；旧客户端忽略该字段，显示「用量已恢复，已自动继续」(与 `agentSwitch` 相同)。
同样只改投影与记录内容，服务端无需改动。
换不换统一成一个判定(2026-10-11，`provider-group/failurePolicy.ts`)：`agentSwitch.cause` / `groupSwitch.cause` /
`groupSwitchPending.cause` 新增取值 `failed`(那台出了别的问题，如 Agent 意外退出、服务报错且重试用尽)，新 Desktop 与 Mobile
显示「{from} 出了问题，已换到 {to} 继续」；旧客户端不认识的原因整条忽略，活动行显示「用量已恢复，已自动继续」，进行中行按普通
「重新连接中」显示。`provider-group:remote` 的 `cool` 仍只报那台账号的问题(`usage-limit` / `auth` / `overload`)，不变。
本机远程 Agent 任务连续拉不到那台而结束时，终态 error 的 `reason` 由 `remote_agent_closed` 改为 `remote_agent_lost`(只在本机
与它的控制端之间流转，用于判定「只是连接断了」；渲染端两者都按错误码给文案，旧端不受影响)。
