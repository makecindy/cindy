# 供应商组：受邀者运行中换电脑(P2c)

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §6.1「谁来执行换电脑 · 分享的人」。[「受邀者经组所在电脑中转」](provider-group-invitee-relay.md)的中转任务在组内
电脑 M 上因那台本身的原因失败时，交接要用到对话记录，只能由受邀者 G 执行；组所在电脑 O 只负责告诉 G「需要换一台」并在
G 重新打开时换一台。G 与 O 之间新增四项可选内容，O 与 M 之间不变：

- **open 载荷新增可选 `acceptsGroupSwitch: true`**(`remote-agent/wire.ts`，只认 `true`)：G 声明认识下面的凭证状态。新 G 打开
  远程 Agent 任务时一律声明；O 只在中转任务上使用。旧 O 丢弃这个字段。
- **事件流里的凭证状态 `{ t: 'state', state: { providerGroupSwitch: <token> } }`**(`REMOTE_AGENT_GROUP_SWITCH_STATE_KEY`，
  凭证格式同 `REMOTE_AGENT_RELAY_KEY_PATTERN`)：O 看到 M 转来的终态错误(或一轮进行中 M 的任务意外结束；组选中 O 本机、任务在
  O 本机运行时同样适用)、按组口径判定是那台的问题、并确认组里还有能接的电脑后，**先**追加这条状态，**再**转出原来的错误；判定与选电脑期间 M 转来的后续内容按原顺序
  暂存，不乱序。只发给声明了 `acceptsGroupSwitch` 的 G；旧 G 只看到原来的错误(行为同 P2b)。G 取走凭证、不并入任务状态
  (`controller/startRemote.ts` `takeGroupSwitchState`)。O 丢弃 M 转来的同名状态，M 不能替 O 发凭证。
- **open 载荷新增可选 `groupSwitchToken`**：G 自动交接(全量交接 + 全新原生会话)后重新打开时带回凭证。O 只认发给这个受邀者、
  这个任务(按 O 侧的 `hostSessionId`)且未过期(10 分钟)的凭证，用一次即作废；有效时选电脑避开这一轮已经换下来的组内电脑，
  无效时按普通新任务选。凭证只影响选哪台，不扩大任何权限；它与 `relay` / `groupAssigned` 一样不转给 M。
- 同一轮每台组内电脑最多换一次(O 按(受邀者, 任务)记录)；那台上一轮正常结束或距上次换电脑超过 30 分钟算新的一轮。
- **send 选项新增可选 `groupNewRound: true`**(`RemoteAgentWireSendOptions`，只认 `true`)：G 上的用户亲自接手(发消息、重试、
  换模型)后、且这个任务收到过凭证时，下一次 `send` 带上它，O 据此清掉这个任务这一轮已经换下来的电脑，也算新的一轮。
  O 读完即去掉，不交给 Agent、不转给 M；旧 O 丢弃这个字段(手动重试仍沿用旧的一轮，直到正常结束或 30 分钟)。它只影响
  这个受邀者自己这个任务的换电脑记录，不扩大任何权限。组设置关掉了自动换电脑时 O 照常冷却出问题的那台，但不发凭证。
- G 只在持有凭证时才换电脑：分享暂停、删除、撤权等来自 O 本身的错误没有凭证，照旧交回原有处理。
- **续接回到原来那台、那台接不下时同样发凭证**(2026-10-11)：G 续接一个经组运行过的任务(带 `resumeSessionId`)，O 只能回到
  当初那台(会话在那台上)；那台接不下、且按同一个判定是那台的问题时，O 在 `start-failed` **之前**追加同一条凭证状态。G 的
  `startRemote` 在任务开始之前也会取走凭证(`takeGroupSwitchState`)；随后的打开失败由 G 的启动重试认领凭证
  (`claimGuestStartSwitch`)，先交接(全量交接 + 全新原生会话)，再在同一个分享位置带凭证作为全新任务重新打开，只试这一次。没有新字段；旧 G 只看到原来的启动失败。组为受邀者的全新任务选中 O 本机、O 的 Agent 却没能
  启动时，O 与组内电脑接不下一样在启动阶段换下一台(受邀者无感，旧 G 同样享受)。
- 不改 relay、服务器与数据库。实现：`remote-agent/host/runHost.ts`(暂存与发凭证、校验凭证)、`host/groupRelay.ts`、
  `provider-group/guestRelay.ts`(运行中失败的冷却)、`provider-group/guestSwitch.ts` 与 `provider-group/service.ts`(G 侧凭证与
  自动交接)、`maker-ipc/sessionAgentSwitchHandler.ts`(仅内部可用的 `forceRelocation`)；回归见
  `remote-agent/__tests__/groupRelay.test.ts`、`provider-group/__tests__/service.test.ts`、`guestSwitch.test.ts`。

直连旧任务启动自愈（2026-11-13）：`direct-switch { sessionId, generation? }` 增加可选 UUID 授权代次，
新版 O 在进入及签发后检查匹配，并在成功结果回传 `generation`；旧 G 忽略回包新增字段，旧请求不带代次仍沿用原规则。
新 G 的启动恢复必须收到匹配代次的结果；旧 O 忽略请求字段且不回传代次时，保留原启动错误与改选入口，不猜测凭证归属。
G 只将 M 的明确 `start-failed` 且保留 `AgentStartupStoppedError`／`AgentNotAuthenticatedError` 标识的错误作为启动恢复来源；
本机错误、未确认退出的原生进程或不明结果的传输失败不替代该证据。旧 M 不提供明确退出标识时仍保留原失败。
O 向自己的 M 使用既有 `maker:subscription-accounts` 的 `session {providerId, sessionId, model}` 只读查询，
确认绑定账号不可用且有替代账号时，可签发一次允许原 M 参与的凭证；其排除列表可能为空，仍是有效凭证，
必须执行原直连位置退役。重开走已有交接和全新隔离会话，不复用旧账号的原生 ID。
同机换号记入该受邀者／任务的恢复轮次，再次失败仍避开该物理 M。旧 M 缺回执时继续原换机路径。
仅扩展现有 end-to-end 业务 payload，不改 relay envelope、握手、allowlist、加密、服务端或自建中转内核；
两类中转均用已有通用帧转发。回归补在 `roundtrip.test.ts`、`groupRelay.test.ts`、`fastPolicyRuntime.test.ts`
及 `packages/device-link/src/__tests__/remoteAgent.test.ts`。
