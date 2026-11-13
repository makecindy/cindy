# 供应商组任务进行中换号

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

2026-11-03 新增独立动作 `rebalance-preference { sessionId, enabled: boolean }` → `{ ok: boolean }`，
发给**任务所在电脑**，与下面两种动作复用本机 IPC 和同账号 `provider-group:remote` 入口及原有准入。
`enabled: false` 显式关闭本任务的配额均衡换号（含同账号自动接续），不关闭故障恢复或手动换电脑；
`true` 删除该 override，恢复原默认/自动偏好。`sessionId` 沿用已有 id 校验，非布尔值回 `[INVALID_PARAMS]`。
任务尚未归组或服务未装配回 `ok: false`；落盘失败不能回成功。关闭后清理未消费决定，发送前再次核对关闭状态，
拒绝旧控制端的缓存 `rebalance-decision`。
保存前读取当前组和任务实际位置核验归属，不能仅凭尚未清理的旧绑定写入。控制端 5 秒等待到期只释放发送，
继续处理迟到的保存回包；不能把界面超时当作明确失败，连接错误提示保存结果未确认。
成功保存后经已有 `local-db:sessions:patched` 广播可选布尔字段 `providerGroupRebalanceEnabled`，本机窗口与同账号
控制端据此按任务电脑 + 任务 id 清理已缓存及在途提议；广播沿用写入前捕获的 owner scope。旧端忽略新字段。
旧端不认识新动作时明确拒绝，控制端提示保存失败并在原位置发送，
不得降级成换号确认。旧动作和旧客户端不变。

持久文件新增可选 `disabledRebalance: { [sessionId]: at }`（每类偏好最多 4000 条），旧 `autoRebalance` 保留；
新端读取旧文件按未关闭处理。降级旧版本无法执行关闭语义，可能恢复旧版配额均衡行为，旧版写入也可能丢弃新字段。
本次只扩展端到端 invoke 的业务 payload，不改变 envelope、channel、allowlist、relay 握手/路由或重连；
官方及自建中转均按现有通用通道透传，无需更改服务器。协议与业务回归由 `remoteHandler.test.ts`、
`ipc.test.ts`、`service.test.ts` 及两端提示测试覆盖。

产品规则见 [`provider-groups.md`](../../product-rules/provider-groups.md) §6.2（2026-10-21 用户裁决：上一轮结束、用户发下一条消息
前弹窗问要不要换号，可为这个任务选「以后自动换」，手机与电脑一致）。

- **两个新动作，发给任务所在的电脑**：本机走 `providerGroup.command`（IPC，只限本机 renderer），手机与桌面远程控制走已有的
  同账号 `provider-group:remote`（dispatch 已拒绝受邀者与共享任务访客，allowlist 不变）。
  - `rebalance-suggestion { sessionId }` → `{ kind: 'ask' | 'auto', memberKey, label, quota } | null`：只读，不记占用、不改绑定。
    `auto` = 这个任务选过以后自动换，客户端不弹窗、直接回 `rebalance-decision`。`quota` 是要换去那台排序用的窗口，形状同
    `ProviderGroupView.members[].quota`；`label` 是那台的显示名（同一台电脑上有几个账号时带账号名），不含账号标识。
    组合名称最多 259 个 UTF-16 单元（电脑名 128 + 分隔符 3 + 账号名 128），电脑与手机按相同上限解析。
  - `rebalance-decision { sessionId, memberKey, remember, clientId? }` → `{ ok: boolean }`：只允许这个任务中匹配 `clientId` 的消息
    发送前换到 `memberKey`（2 分钟内有效，定时任务不消费）；复用 `persistUserMessage.clientId`，不增加发送协议字段。
    缺少消息 ID 或 `memberKey` 不在组里回 `ok: false`，不记决定与偏好；`remember: true` 时另记这个任务以后自动换。
  - 解析：`sessionId`、`clientId` 与 `memberKey` 按已有远程 id 规则校验，`remember` 必须是布尔值，坏请求回 `[INVALID_PARAMS]`。客户端读回包用
    `parseProviderGroupRebalanceSuggestion`（手机端 `parseMobileRebalanceSuggestion`，口径相同），格式不对按不提议处理。
- **时机**：客户端在任务空闲时预先问 `rebalance-suggestion`（变空闲、打开任务时，空闲期间每 5 分钟；单次最多等 5 秒），
  结果 10 分钟内有效、只用于一条消息；点发送时只用问好的结果，不为它多等一次往返。只有用户确认换号（或任务选过自动换）时，
  发送前等 `rebalance-decision` 回来再发，确保任务所在电脑先记下决定。
- **新旧兼容**：旧任务所在电脑不认识这两个动作，回 `[INVALID_PARAMS] unknown provider group action`；客户端失败或超时都按
  不提议处理、照常发送，与改动前一致。旧客户端不发这两个动作，任务所在电脑不会自己换号（没有用户确认就不换），行为与改动前
  一致。不新增 channel、relay、服务器或数据库字段。
- **最终选路约束**：`pick` 可选 `quotaRebalance: <当前成员键>`；组所在电脑在选路与占用登记的同一步，按当前负载、配额和换号
  收益门槛重新校验。成功结果回显 `quotaRebalance: true`；新调用端未收到回显就不主动迁移。旧组忽略可选字段时仍可普通
  分配，但不能作为主动换号结果；旧调用端不传该字段，行为不变。
- **分隔条内容可选 `switchReason: 'quota-rebalance'`**：`agent_switch` 边界行（`AgentSwitchBoundaryContent`）只在供应商组为此换了
  电脑时带上，桌面与手机在位置后写「· 这个账号的配额更该先用」。旧端忽略，照常只显示位置。
- **本机持久数据**：自动偏好与显式关闭状态存在按账号隔离的 `provider-group-session-prefs.json`
  （`{ autoRebalance: { [sessionId]: at }, disabledRebalance?: { [sessionId]: at } }`），每类最多 4000 条、超出丢最早的；
  读不出时保留原文件、按都没选过处理。文件不同步、不外发；手机与其他控制端通过上述动作读取建议、保存选择。
  不支持新动作的旧版本会忽略关闭状态，降级风险见本节开头。
- 实现：`provider-group/service.ts`、`usage.ts`(`providerGroupRebalanceTarget`)、`router.ts`(`rebalanceCandidates`)、`runtime.ts`、
  `ipc.ts`、`remoteHandler.ts`、`remoteRegistration.ts`、`sessionPrefs.ts`、`maker-ipc/sessionAgentSwitchHandler.ts`；客户端
  `renderer/features/provider-group/sessionRebalancePrompt.ts` 与 `apps/mobile/src/session/sessionRebalancePrompt.ts`。回归见
  `shared/__tests__/providerGroup.test.ts`、`provider-group/__tests__/service.test.ts`、两端 `sessionRebalancePrompt.test.ts`。
