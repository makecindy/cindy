# Cindy Bots 工程完成矩阵

> 状态：Draft 工程验收正本。它把《Cindy Bots 完整设计与迁移契约》的终点线映射到当前实现和自动验证。真实 IM、真实定时触发、真实 Bot 委派、真实旧库升级与双端视觉目检仍必须由 Chris 在场完成；在这些验收通过前不得把 Draft 转为 Ready。

## 产品完成线

| 能力 | 生产实现 | 自动证据 | 当前结论 |
|---|---|---|---|
| Hermes 风格 Profile、SOUL、USER context | `botProfileVersioning.ts`、`botProfileRuntime.ts`、`botProfileDefaults.ts` | `botProfileVersioning.test.ts`、`botProfileRuntime.test.ts` | Profile 版本化；身份源和用户上下文分槽；运行任务固定使用已选版本。 |
| 三 Harness runtime 注入 | Claude、Codex、Pi 的 Bot runtime 接线 | `bot-profile-prompt.test.ts`、`codex/index.test.ts`、`bot-skill-policy.test.ts` | 三种 Harness 都消费同一份 Cindy Bot runtime snapshot，不由 UI 拼 prompt。 |
| Skills、MCP、Toolset、Memory | `botProfileRuntime.ts` 与 maker-core 原生能力策略 | `botCanonicalSession.test.ts` 的资源冻结、漂移和远端能力用例 | 能力必须来自真实 catalog；不可用项进入 degraded/failed，不靠名称猜测。 |
| canonical、Route、历史、Renew、恢复 | `localDb/ipc/bots.ts`、`botRouteService.ts`、`botLifecycleService.ts` | `botCanonicalSession.test.ts`、`botLifecycleService.test.ts` | canonical 与每条具体 IM lane 分离；历史只读；并发 Renew 使用 CAS；删除后建新任务而不复活旧记录。 |
| IM adapter 边界 | `im/shared/botRouteTarget.ts`、`hook-control/botRouteTarget.ts`、`botChannelRegistry.ts` | `botRouteTarget.test.ts`、`botChannelRegistry.test.ts`、`botMountedRouteDelivery.test.ts` | Telegram、飞书等仍保留各自引用、卡片、附件、thread 和群历史实现；差异是 native/degraded/unsupported 三态契约。 |
| Bot roster 与能力互补 | `botDelegationService.ts`、`bot_delegation.ts` | `botDelegationCapabilityTarget.test.ts`、`botCanonicalSession.test.ts` 委派用例 | roster 只暴露真实 runtime、项目和忙碌状态；权限与数据边界不随委派扩大。 |
| Bot-to-Bot handoff | `botDelegationService.ts`、父任务右侧栏 `bot-delegations` | 委派循环、深度、预算、取消、恢复、结果投递用例 | 子 Bot 使用自己的 Profile 和工作区；完整子任务持久可查；结果通过 durable delivery 返回冻结目标。 |
| 项目与 worktree | `botWorkspaceRuntime.ts`、`botRemoteWorkspaceService.ts`、`botWorkspaceLeaseLifecycle.ts` | canonical 测试中的本地/远端创建、恢复、释放与引用保护用例 | worktree 按任务 lease，不归 Profile 永久占用；owner generation 和数据库 attachment 是恢复真相。 |
| Automation | `bot-automation.ts`、`bot-automation-runner.ts` | `botAutomationRecovery.test.ts`、mutation lock 与 durable note 测试 | 每次触发冻结 Profile、项目、Route、目标任务、委派图、预算和 note namespace；执行结果与投递结果分离。 |
| 可靠投递 | `botDeliveryOutboxService.ts`、`botMountedRouteDelivery.ts` | ACK、retry、unknown、dead-letter、附件、route generation 用例 | 服务端 relay 可安全重试；本地 adapter 在外部结果未知时停止自动重放并要求显式确认重复风险。 |
| 旧 IM 数据迁移 | `botImMigrationService.ts`、0092 migration | `botMigrationReplay.test.ts`、`botImMigrationService.test.ts`、`db:validate` | 0092 只新增 Bot 表；旧任务、消息、引用、binding、Telegram 群历史和附件不搬动；apply/rollback 幂等且可续跑。 |
| Desktop UI | `renderer/features/bots/**` | renderer store、typecheck、设计契约测试 | 左侧 Bots 是固定任务入口；主区域复用真实 Session 与 ChatInput；设置、历史、委派、worktree、Automation 和投递诊断均有入口。 |
| Mobile UI | `app/bots/[deviceId].tsx`、设备详情入口 | Mobile typecheck、`remoteBots.test.ts`、device-link allowlist 测试 | 手机通过 device-link 只读列出 Bot，并打开真实 canonical 任务；旧 Desktop 明确显示不支持。 |

## 并发与故障矩阵

| 事件 | 约束后的行为 | 证据入口 |
|---|---|---|
| 重复创建 / Renew | 数据库唯一约束 + CAS 只允许一个 winner；失败方清理未使用 workspace。 | `botTx.test.ts`、`botCanonicalSession.test.ts` |
| 重复 Automation fire | Scheduler claim 与 Bot mutation lock 串行同一 Automation；execution row 和 delivery idempotency key 去重。 | `botAutomationMutationLock.test.ts`、`botAutomationRecovery.test.ts` |
| 重复委派 / 循环 | lineage、最大深度、并发数和聚合预算同时约束；数据库事务再次检查并发上限。 | `botCanonicalSession.test.ts` |
| 用户取消 / 父任务关闭 | 当前委派及后代进入明确终态并中止活动回合；历史任务保持可读。 | `botCanonicalSession.test.ts`、`botLifecycleService.test.ts` |
| 超时 | 委派和 Automation 都持久保存 deadline；重启恢复先判超时，再决定是否继续。 | `botCanonicalSession.test.ts`、`botAutomationRecovery.test.ts` |
| Host 崩溃 / 重启 | runtime、Automation run、delegation、workspace lease 和 outbox 均从数据库恢复，不信进程内 Map。 | recovery 系列测试 |
| IM 账号登出或连接失效 | mount 不自动改绑其它账号；adapter 返回不可用，outbox 进入重试或 dead-letter；恢复连接后仍校验原 account、Route 和 owner generation。 | `botMountedRouteDelivery.test.ts`、delivery tests |
| Route / canonical 被替换 | 旧执行只允许投递到冻结 task + generation；不把旧结果重定向到新任务。 | `botAutomationRecovery.test.ts`、delivery tests |
| 跨窗口操作 | main/数据库拥有状态；renderer 只订阅广播，不能自行改 Session source 或伪造 Bot 归属。 | `botCanonicalSession.test.ts`、trusted renderer 边界 |
| worktree 清理 | active Session、Automation、delegation 或 attachment 任一仍引用时拒绝清理；远端只调用远端 workspace 服务。 | canonical worktree tests、`botRemoteWorkspaceService.test.ts` |

## 可维护性检查

- Bot Profile、任务生命周期、通道能力、Route、委派、worktree、Automation 和 outbox 各有单一职责服务；没有第二套 Agent loop 或第二套 ChatInput。
- Telegram 与飞书的差异停留在 adapter 和 `botChannelRegistry.ts`，共享层不靠大段渠道 `switch` 重写消息语义。
- 新增通道先登记 route platform、连接发现、能力三态与 delivery adapter；未实现的 surface 自动是 `unsupported`，不会默认为支持。
- runtime snapshot、delegation plan 和 automation plan 都是版本化、无凭证的冻结数据；Profile 文本不能提升 workdir、MCP 或通道权限。
- Desktop Bot UI 遵守共享 8px/12px/pill 圆角、主题遮罩和零阴影；Mobile 使用主题 token，Light/Dark 由同一组件树切换。

## 仍需 Chris 在场的五项真实验收

以下项目不能由无授权的开发会话代跑，也不能用单测冒充：

1. Telegram 与飞书各真实收发一轮，检查引用、卡片、附件、thread/topic 和群历史降级说明。
2. 创建一个一分钟后触发的 Bot Automation，确认只执行一次，结果与投递状态分别可查。
3. 让一个 Bot 真实调用 `delegate_to_bot`，确认子任务正文、产物和返回结果在父任务中可查。
4. 对真实旧 IM 数据副本执行预检、迁移和 rollback，确认原任务、消息、群历史、附件及旧入口均可恢复。
5. Desktop 与 Mobile 分别在 Light/Dark 下目检创建、列表、主任务、设置、历史、错误和空态。

真实验收前保持 Draft；任何一项失败都回到对应矩阵行修复，不用 UI 绕过数据或运行时约束。
