# Cindy Bots 工程完成矩阵

> 状态：Draft 工程验收正本。它把《Cindy Bots 完整设计与迁移契约》的终点线映射到当前实现和自动验证。真实 IM、真实定时触发、真实 Bot 委派、真实旧库升级与双端视觉目检仍必须由 Chris 在场完成；在这些验收通过前不得把 Draft 转为 Ready。

北极星用例：创建“总控”Bot，挂载 Telegram，按逻辑条件订阅统一任务状态模型的变迁；其它任务进入正常结束、出错或待决策状态时，变迁持久进入 Bot 收件匣并按心跳策略激活 Bot。Bot 再通过会话控制面查询当前事实、推进工作，最后把自己的处理结果发回 Telegram。PR 总管是同一模型下挂 Automation 的专用模板，不是另一套产品。

## 产品完成线

| 能力 | 生产实现 | 自动证据 | 当前结论 |
|---|---|---|---|
| Hermes 风格 Profile、SOUL、USER context | `botProfileVersioning.ts`、`botProfileRuntime.ts`、`botProfileDefaults.ts` | `botProfileVersioning.test.ts`、`botProfileRuntime.test.ts` | Profile 版本化；身份源和用户上下文分槽；运行任务固定使用已选版本。 |
| 开箱创建与模板 | `AddBotDialog.tsx`、`botTemplates.ts`、`botStore.ts` | `botTemplates.test.ts`、`botStore.test.ts`、`botTx.test.ts` | 新 Bot 固定先创建为本地 Profile；总控、PR 总管和普通助理模板一次写入身份、头像、能力与默认事件订阅，再进入真实 canonical 任务。 |
| 三 Harness runtime 注入 | Claude、Codex、Pi 的 Bot runtime 接线 | `bot-profile-prompt.test.ts`、`codex/index.test.ts`、`bot-skill-policy.test.ts` | 三种 Harness 都消费同一份 Cindy Bot runtime snapshot，不由 UI 拼 prompt。 |
| Skills、MCP、Toolset、Memory | `botProfileRuntime.ts` 与 maker-core 原生能力策略 | `botCanonicalSession.test.ts` 的资源冻结、漂移和远端能力用例 | 能力必须来自真实 catalog；不可用项进入 degraded/failed，不靠名称猜测。 |
| canonical、Route、历史、Renew、恢复 | `localDb/ipc/bots.ts`、`botRouteService.ts`、`botLifecycleService.ts` | `botCanonicalSession.test.ts`、`botLifecycleService.test.ts` | canonical 与每条具体 IM lane 分离；历史只读；并发 Renew 使用 CAS；删除后建新任务而不复活旧记录。 |
| 状态变迁订阅与自激活 | `botSessionEvents.ts` 的 control-plane consumer port、`botSessionEventService.ts`、0093 migration、`BotEventInboxSettings.tsx` | `botSessionEvents.test.ts`、`botSessionEventService.test.ts`、`botTx.test.ts`、`botMigrationReplay.test.ts` | 不自行解释 turn 或标题 patch；只消费统一任务状态模型的权威变迁。规则按“全部本机 / 我委派的 / 关注列表”等逻辑关系及 execution/attention/workflow 开放 facet 匹配，不逐任务登记。命中后去重写入持久收件匣，并按 `heartbeat-turn / inbox-only` 策略决定是否激活 Bot。当前明确依赖会话控制面 Draft #2804 先提供最终状态类型与 subscribe 出口。 |
| 隐藏 guardian heartbeat | `botGuardianHeartbeat.ts`、`botSessionEventService.ts` | `botGuardianHeartbeat.test.ts`、`botSessionEventService.test.ts` | 用户无配置项。只要 Bot 有活跃委派、全局逻辑订阅或未来关注列表，运行时自动维持 5—15 分钟的低频确定性检查；监管集合为空或 Bot 暂停/归档即停止。健康状态只读 snapshot 后静默返回，不创建收件匣、不激活任务；仅在运行失联、应到终态事件缺失、待决策无人认领时合成 guardian anomaly，并复用同一 ledger → inbox → heartbeat-turn → Route 链。异常指纹持久去重，单 Bot 每 tick 最多检查 256 个目标并轮转。真实 snapshot reader 仍等待 #2804 合入后绑定。 |
| 会话控制面接线 | `botSessionControl.ts`、`botProfileRuntime.ts` | runtime snapshot 与 Profile 测试 | `none / observe / coordinate` 是 Bot Profile 权限声明；实际查状态、查队列、派活、插话和停止仍由 `cindy_helper` 控制面逐次鉴权。本 Draft 依赖会话控制面 Draft #2804 提供最终工具契约。 |
| IM adapter 边界 | `im/shared/botRouteTarget.ts`、`hook-control/botRouteTarget.ts`、`botChannelRegistry.ts`、`im/index.ts` | `botRouteTarget.test.ts`、`botChannelRegistry.test.ts`、`botMountedRouteDelivery.test.ts`、`botRouteDelivery.test.ts` | Telegram、飞书等仍保留各自引用、卡片、附件、thread 和群历史实现；本地 Telegram 精确匹配挂载账号，服务端 relay 保持 `deliveryKey + opId`，不可寻址时失败关闭且不串到本地账号。 |
| Bot roster 与能力互补 | `botDelegationService.ts`、`bot_delegation.ts` | `botDelegationCapabilityTarget.test.ts`、`botCanonicalSession.test.ts` 委派用例 | roster 只暴露真实 runtime、项目和忙碌状态；权限与数据边界不随委派扩大。 |
| Bot-to-Bot handoff | `botDelegationService.ts`、父任务右侧栏 `bot-delegations` | 委派循环、深度、预算、取消、恢复、结果投递用例 | 子 Bot 使用自己的 Profile 和工作区；完整子任务持久可查；结果通过 durable delivery 返回冻结目标。 |
| 项目与 worktree | `botWorkspaceRuntime.ts`、`botRemoteWorkspaceService.ts`、`botWorkspaceLeaseLifecycle.ts` | canonical 测试中的本地/远端创建、恢复、释放与引用保护用例 | worktree 按任务 lease，不归 Profile 永久占用；owner generation 和数据库 attachment 是恢复真相。 |
| Automation | `bot-automation.ts`、`bot-automation-runner.ts` | `botAutomationRecovery.test.ts`、mutation lock 与 durable note 测试 | 每次触发冻结 Profile、项目、Route、目标任务、委派图、预算和 note namespace；执行结果与投递结果分离。 |
| 可靠投递 | `botDeliveryOutboxService.ts`、`botMountedRouteDelivery.ts` | ACK、retry、unknown、dead-letter、附件、route generation 用例 | 服务端 relay 可安全重试；本地 adapter 在外部结果未知时停止自动重放并要求显式确认重复风险。 |
| 旧 IM 数据迁移 | `botImMigrationService.ts`、0092/0093 migrations | `botMigrationReplay.test.ts`、`botImMigrationService.test.ts`、`db:validate` | 0092 增加 Bot 主体与迁移表，0093 增加状态变迁消费 ledger、逻辑订阅和收件匣；ledger 只做 Bot 去重/审计，不是第二套状态模型。两份 migration 都只增量，旧任务、消息、引用、binding、Telegram 群历史和附件不搬动；apply/rollback 幂等且可续跑。 |
| Desktop UI | `renderer/features/bots/**` | renderer store、typecheck、设计契约测试 | 左侧 Bots 是固定任务入口；主区域复用真实 Session 与 ChatInput；设置、历史、委派、worktree、Automation 和投递诊断均有入口。 |
| Mobile UI | `app/bots/[deviceId].tsx`、设备详情入口 | Mobile typecheck、`remoteBots.test.ts`、device-link allowlist 测试 | 手机通过 device-link 只读列出 Bot，并打开真实 canonical 任务；旧 Desktop 明确显示不支持。 |

## 并发与故障矩阵

| 事件 | 约束后的行为 | 证据入口 |
|---|---|---|
| 重复创建 / Renew | 数据库唯一约束 + CAS 只允许一个 winner；失败方清理未使用 workspace。 | `botTx.test.ts`、`botCanonicalSession.test.ts` |
| 重复状态变迁 / Bot 自触发 | 权威 transition id 与 subscription-transition 唯一索引去重；origin、lineage 与 hop 限制阻止 Bot 结果递归激活自己。 | `botSessionEventService.test.ts`、0093 indexes |
| Guardian 重复 tick / refresh 竞态 | 同一异常以 Bot、任务、监管代次和状态快照生成持久指纹；并发 refresh 会在当前扫描后强制重扫，清空监管关系后不再留下下一次 timer。暂停竞态在写 ledger 前重新校验 Bot 仍 active。 | `botGuardianHeartbeat.test.ts`、`botSessionEventService.test.ts` |
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

- Bot Profile、任务生命周期、通道能力、Route、委派、worktree、Automation 和 outbox 各有单一职责服务；没有第二套 Agent loop、ChatInput 或任务状态生产体系。
- 会话控制面拥有统一任务状态模型和变迁发布出口；Bots 只通过 consumer port 订阅、筛选、持久化收件匣和自激活。#2804 未合并前不提供本地 fallback producer，避免两套事实再次分叉。
- Guardian 不创建用户 Schedule，也不另建事件系统；它只是统一状态 snapshot 上的零 token 预检。数据库或 snapshot 读取失败时 fail-closed，不唤醒 Bot，并保留低频重试。
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
6. 在总控 Bot 有活跃监管关系时，让一个子任务保持 `running` 且超过 guardian 阈值不再产生活动；确认总控只收到一次“失联/卡死”事件、会被激活并可汇报到 Telegram，重复 tick 不再次唤醒。随后清空监管关系，确认 heartbeat 自动停止。

真实验收前保持 Draft；任何一项失败都回到对应矩阵行修复，不用 UI 绕过数据或运行时约束。
