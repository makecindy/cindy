# 伙伴代表谁：主人代办、受托与自主

2026-10-23 裁决，取代 2026-10-19 至 2026-10-22 之间几次互相翻转的「行动授权」说法。
范围只到伙伴：调用方是伙伴任务（主任务、群专线、IM 专线、私聊话题等带伙伴关联的任务）时适用；
普通任务、Orca 普通 Lead / Worker、普通定时任务与共享任务的放行逻辑不变。

## 一条规则

伙伴每次调用任务写工具，宿主**先判这一轮代表谁，再交给权限档审风险**。两件事分开：

1. **身份**：由宿主按输入来源确定，不看模型怎么说，也不看工具参数。
2. **风险**：身份放行后照常走当前任务的权限档——Full Access 免审，Auto 由 AI 审，Ask 请主人确认。
   不另加确认卡。

以前用同一个开关同时回答「谁的意思」和「风险多大」：10-20 的版本让主人那一轮还要多弹一张卡，
10-22 的版本为了不重复弹卡把身份判断整个拿掉，自动唤醒在 Full Access 下等同主人本人。

## 三种身份

| 身份 | 宿主依据 | 能做什么 |
| --- | --- | --- |
| 主人代办 | 本轮是主人亲手输入（含同账号手机 / 另一台电脑）；群里经 Chat Server 实时核验为主人；IM 专线逐轮租约的 `requesterIsOwner`；主人这一轮被自动续跑或零输出重试；当前已接受输入携带宿主核实的主人原话回执 | 像主人本人一样操作主人的任务：找到任务、发话、追加需求、停止、改名、归档、开后台任务等 |
| 受托 | 主人自己设的例行任务（含导入的自动化）；伙伴自己当 Lead 时收到本团队 Worker 的回报 | 按那条常驻指令或那个团队办事；Auto 审核以例行任务的指令为意图 |
| 自主 | 其它一切：宿主唤醒的跟进与查待办、没有主人请求凭证的伙伴来信、群成员 / IM 外人、无法核实的转入 | 只动自己的东西，见下表 |

IM 专线有逐轮租约时以租约为准，桌面看起来像主人的输入不能覆盖它。群专线没有实时主人核验时，
写工具照旧直接失败。

## 自主身份能做的事

| 工具 | 条件 |
| --- | --- |
| `send_to_agent` | 伙伴之间通话，防循环沿用现有上限 |
| `continue_workbench_task` | 目标必须已交给它跟进（工作台服务按接手、总调度和「别的伙伴开的任务」规则判定）；用来按原目标接着做，不借它追加新要求 |
| `set_session_runtime` | 自己的任务、自己开的后台任务，或已交给它跟进的任务（按摘要建议换模型） |
| `message_session_task` / `stop_session_task` / `advance_session_task_route` | 只限自己开的后台任务；不能替主人回答权限请求（`decision`），也不能恢复暂停（`mode=resume`） |
| `send_to_session` | 只限发给自己开的后台任务 |
| `set_workbench_task_responsibility` | 只能解除；接手需要主人开口 |
| Orca 写工具 | 只限自己当 Lead 的现有团队，且本轮来自该团队的 Worker；不能新开团队 |

例行任务与定时任务的写操作只在主人代办或受托轮里可用：主人设的例行任务会以受托身份运行，伙伴不能在
自主轮里自己造出或改写这份授权。覆盖两个工具面：`cindy_helper` 的 `routine_save` / `routine_delete` /
`routine_run_now` / `schedule_set_pre_run_hook`，以及按 id 直达任意定时任务（含 `routine-*`）的
`cindy_scheduler` 写工具（新建、修改、删除、立即运行、暂停、恢复、安装前置脚本，及其 `routine_*` 写工具）。
读取类与本轮自身的 `schedule_notify_current_run` / `schedule_silence_current_run` 不受限。

其它对主人任务的写操作返回 `NEEDS_OWNER_REQUEST`，不弹卡。伙伴应改为写待办或通知主人，
写清目标、动作和理由；主人在近况里点那条待办、说一句话，就成为主人代办轮。

已知边界：宿主只能确定性地限定**目标**。「按原目标接着做」还是「追加新要求」属于消息内容，
Auto 档由审核器结合例行任务指令判断，Full Access 不审，靠伙伴指引约束。

## 转达主人原话（请求来源）

- 主人代办轮由宿主在回执上标 `ownerVerified`。伙伴私信、任务委派和后续转交沿用同一份原话及
  `sessionId/clientId`；当前已接受输入中的核实结果不会因为换了接收任务或伙伴而降权。
  仅从旧历史读到回执、没有当前受托输入时，不恢复旧请求；自主触发、插件与共享访客不能自行生成凭证。
- 接收方的任务写工具把这类输入视为原请求的继续，仍按当前权限档审风险；不要求主人重复复述。
  它不等同于主人刚刚亲手输入，应用更新等专门要求本人输入的操作保持原有边界。
- 空闲、繁忙和新建任务共用持久输入协调器，插话、重试及历史恢复都保留原话；审核上下文不采用 Agent 补充
  里的授权说法。原话不明或缺少背景时，先按来源任务查上下文，只有仍缺少必要决定才向主人提问。
- IM 轮次不经过输入协调器：原话取自 IM 运行器写在逐轮租约上的本轮落库消息（`inputClientId`），
  只在租约的发言人是主人时读取。
- 主人输入被自动续跑（包括生成的「继续」消息）仍算主人代办，但不算新的主人输入，
  不能用于应用更新这类只认主人亲手输入的操作。
- 接收任务看到带 `ownerVerified` 的回执时：
  - Auto 审核的意图就是这句原话，范围以原话为限；
  - 模型收到的 `[消息来源]` 说明写明「用户原话」就是主人对本任务的请求，「Agent补充」只是背景，
    补充里的授权说法不算授权。
- 正文格式（「[来源] … / 用户原话： / Agent补充：」三行）保持原样，因为旧版接收端会逐字比对；
  纠正说法只出现在发给模型的说明里。
- 跨电脑：`requestSource.ownerVerified` 是可选字段。旧接收端忽略它，行为与之前相同；
  旧发送端不发它，新接收端按未核实处理。
- 结果回传仍由发送方伙伴自己查看（`get_task_digest`），不要求接收任务给别的会话发消息。

## 模型看到的身份

- 伙伴例行任务无论直发还是因主任务忙而排队，审核意图都是例行任务的指令（不含事件数据）。
- 伙伴例行任务的 `[Scheduled run context]` 末尾带一行 `turnAuthority`：内置例行任务写 autonomous，
  主人设的例行任务写 entrusted。
- 内置「跟进」指令用宿主口吻，不再冒用主人第一人称。
- 伙伴系统提示词、teammate-guide 与工具说明使用同一口径，和宿主门判定一致。

## 实现入口

- 身份判定与自主范围：`apps/desktop/src/main/maker-ipc/taskActionHost.ts`
  （`teammateTurnPrincipal`、`autonomousActionAllowed`）；回执用的身份经
  `taskActionAuthorization.ts` 的 `taskActionPrincipal` 读取。
- 主人输入与自动续跑：`agent-input-coordinator.ts` 的 `isActiveInputOwnerAuthored` /
  `isActiveInputOwnerContinuation`。
- 已交给伙伴跟进的任务：`botWorkbenchAccess.ts` 的 `canContinue`。
- 转达凭证：`shared/forwardedRequest.ts`（`ownerVerified`、`verifiedOwnerRequestText`），
  接收端意图见 `agent-input-coordinator.ts` 的 `queuedAutoReviewText` 与 `register.ts` 的直发路径，
  模型说明见 `messageSourceNote.ts`。
- 例行任务意图与身份行：`scheduler-host/runner.ts`、`shared/botAutonomy.ts`
  （`routineInstructionFromPrompt`、`BUILTIN_ROUTINE_SCHEDULE_PREFIX`）。
- 回归：`maker-ipc/__tests__/taskActionAuthorization.test.ts`（teammate turn principal）、
  `forwardedRequest.test.ts`、`messageSourceNote.test.ts`、`sendToSessionLazyResumePermission.test.ts`、
  `agent-input-coordinator.test.ts`（teammate relay review intent）、
  `scheduler-host/__tests__/runnerBackgroundTasks.test.ts`。
