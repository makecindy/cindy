# 伙伴的来源与操作权限

2026-10-29 用户裁决：普通工作默认沿用任务权限，只拦少数明确风险；受阻时必须显示可操作的授权请求，不能静默拒绝，也不能逐入口增加放行例外。
本条取代 2026-10-23 的自主工具白名单和 `NEEDS_OWNER_REQUEST` 规则。

## 三件事分开

1. **访问边界**：账号归属、共享访客、插件范围、群与 IM 的真实发言人仍由宿主核验。
   非主人渠道发言不能借授权卡获得主人账号操作权。验证失败说明来源或连接问题，不能说成主人拒绝。
2. **请求来源**：`owner`、`entrusted`、`autonomous` 只记录主人输入、常驻指令或自主触发。
   缺少主人输入标记不会使普通任务操作失效，也不伪造 `ownerVerified`；应用更新等本人专属入口不变。
3. **操作风险**：普通任务控制、新建任务、模型选择、保存或修改例行任务等沿用当前任务权限。
   Full Access 免普通风险审核，Auto 使用原意图审核，Ask 请用户决定；Plan 不执行副作用。
   helper / scheduler 两个工具面与直接／渐进调用使用同一判据。

## 少数明确风险

自主触发时只额外确认下列操作，不通过目标是否“自己的任务”逐项放行：

| 风险 | 实际入口 |
| --- | --- |
| 调度命令 | `schedule_create` / `schedule_update` 保存脚本执行或命令前置检查、`schedule_run_now` 执行含此类命令的已存定义、`cindy_helper` 和 `cindy_scheduler` 两个入口的 `schedule_set_pre_run_hook` 安装并自测脚本，以及 `routine_save` 保存新命令前置检查（沿用同一命令不追加确认）、`routine_run_now` 手动执行含前置命令的已存规则；本机和跨电脑统一判定 |
| 新建完全访问 Agent | `send_to_session` 不带目标任务与目录覆盖时新建完全访问任务，以及本机 `schedule_create` 创建未绑定任务的 Agent 调度、`schedule_update` 改写其指令/目录/worktree 隔离或解除绑定/改成可重建的持续模式、`schedule_run_now` 手动执行；跨电脑已有独立调度的同类改写与执行沿同一风险确认；包含持续模式丢失目标后新建任务的分支 |
| 授予常驻指令 | `routine_save` 新建启用的自定义规则或改写启用规则的指令；禁用草稿和不改指令的编辑沿原权限 |
| 删除自动化 | `routine_delete`、`schedule_delete` |
| 代用户回答权限请求 | `message_session_task` 携带 `decision` |
| 恢复暂停执行 | `message_session_task(mode=resume)`、`schedule_resume`，以及 `routine_save` 将已有停用规则保存为启用（含内置规则），以及 `routine_run_now` 手动执行停用规则 |

其余操作不命中风险表就继续现有权限流程。新增普通工具不需要另开“自主解锁”例外。
主人输入、已核实的主人转达和受托指令沿正常权限审核，不再加第二张行动确认卡。
风险表不是平台权限、账号访问或消息来源认证的替代品。
本机调度的脚本及前置检查由宿主直接执行，不经过 Agent 的 Bash 审批；自主调用须展示命令、工作目录及准确动作，由主人决定。绑定已有任务并继承其权限的无命令跟进、提醒与只读工具不追加此类确认。
独立 Agent 调度沿用调度器既有的新任务完全访问默认值，不得由自主轮静默创建更高权限的执行。卡片展示完整指令、目录与新任务权限默认值；已有独立调度只改名称/时间等元数据不追加确认。此处不修改调度器、普通任务权限档或全局自动审核器。
按 ID 执行、修改或恢复暂停时，卡片展示并绑定已存定义（含 worktree 隔离）；前置命令展示绑定任务解析出的实际执行目录，目录改变使旧许可失效；脚本安装按 `scheduleId` 展示目标、旧命令及绑定任务解析出的目录与后备落盘目录，并绑定同一快照；helper 安装器保持不接受 `scheduleId` 或外部目录，只展示并绑定调用伙伴自身的任务目录。确认期间定义或解析目录变化使旧许可失效，安装前再次复核。跨电脑普通任务继续沿已有逐次任务权限流程；跨电脑调度若会启动独立完全访问 Agent 或执行命令，则复用同一张可见风险卡，并绑定目标电脑回读的完整定义，不能把跨电脑能力变成黑名单。跨电脑新建定时任务沿用当前任务的权限档和上述执行风险确认，不额外要求本轮是已核实的主人请求。迁移已有定时任务由 Agent 读取源定义、在目标创建、回读核实后再暂停源任务；结果不明时先查询，不能盲目重建。
禁用草稿、重命名、改时间等不改常驻指令和命令的保存不追加授权；主人输入和受托指令仍沿原权限。
自主创建启用的自定义指令或改写启用规则指令，必须经一次性本人确认才可作为后续 entrusted 执行的常驻授权，不能靠保存制造主人授权。
停用草稿可普通保存；启用或手动执行前须确认完整指令。手动执行许可仅限这一次，不改变规则的停用状态。
指令授权、恢复和手动执行许可绑定规则版本；确认期间修改规则会使旧许可失效，执行沿服务已有原子版本检查。

## 等待、决定与恢复

- 风险确认进入普通 `Session.runHostInteraction` 和 `requestHostInteraction`，发布等待授权状态，
  桌面、同账号手机／远控与已绑定 IM 共用同一请求。卡片说明目标、动作和本次影响，只允许这一次。
- 执行调用等待决定；允许后在原调用继续，无需 Agent 重发。同一次放行只能消费一次。
- 代答许可在确认正文完整展示子任务当前请求的工具、参数（或计划）与请求 ID，不依赖截短的工具预览，绑定该实际请求；
  原请求已处理或被新请求替换时，旧卡不能批准新请求。
- 拒绝、取消、停止或任务关闭不执行；晚到回答不恢复旧操作。断线重连读取既有待处理请求，不重新派发操作。
- 同意到执行仍校验账号、实例、输入、权限与 Plan 代次；变更使这次放行失效。
- **延迟投递只认真实撤权**（2026-10-30 用户裁决：能力优先）：已准入的消息因目标忙而排队后，
  发起轮结束、发起方 Session 重建、换新输入，或发起方的权限档、计划模式变化，都不撤销这条消息；
  它由接收任务按自己的权限执行，主人可以在接收任务的队列里编辑或撤回。只有数据库客户端被替换
  （切换账号）、发起任务被清空或删除、伙伴被暂停或归档、委派执行代次或 Orca 团队变化、群授权失效时
  才不再投递；这类消息在落库前移出队列，不在接收任务里留下失败回复。清空以协调器的内存边界和数据库
  `cleared_at` 中较新者为准（`/clear` 先改内存、后写库，写库可能失败）；重启后晚加载的旧边界不算新的
  清空。「判不了」不算撤权：账号边界持有中但数据库客户端没换（同账号 Ghost 投影修复也会持有它）、
  群授权传输中断、数据库未就绪等校验失败，都不销毁消息，保留为可重试的队首。任务动作守卫只在消息
  落库之前判定（派发前预检，以及紧贴落库的那次复核）：确认撤权则不落库、不留痕地移出队列；落库之后
  不再由它截断，照常派发——此时拒绝只会留下用户行和失败回复，而排队的任务消息无法重试（重试会换新的
  clientId，守卫绑定的是原 clientId）。实现见
  `taskActionHost.ts` 的 `assertDeliveryCurrent`、`taskActionAuthorization.ts` 的 `isTaskActionRevoked`
  与 `agent-input-coordinator.ts` 的派发前复核；回归见 `taskActionAuthorization.test.ts` 与
  `agent-input-coordinator.test.ts`。
- 来源判定与操作决定分别保留。获准自主操作不会给后续转达生成主人原话凭证。

## 转达主人原话（请求来源）

- 主人代办轮由宿主在回执上标 `ownerVerified`。伙伴私信、任务委派和后续转交沿用同一份原话及
  `sessionId/clientId`；当前已接受输入中的核实结果不会因为换了接收任务或伙伴而降权。
  仅从旧历史读到回执、没有当前受托输入时，不恢复旧请求；自主触发、插件与共享访客不能自行生成凭证。
- 接收方的任务写工具把这类输入视为原请求的继续，仍按当前权限档审风险；不要求主人重复复述。
  它不等同于主人刚刚亲手输入，应用更新等专门要求本人输入的操作保持原有边界。
- 空闲、繁忙和新建任务共用持久输入协调器，插话、重试及历史恢复都保留原话；审核上下文不采用 Agent 补充
  里的授权说法。原话不明或缺少背景时，先按来源任务查上下文，只有仍缺少必要决定才向主人提问。
- 已准入的后台任务补充消息排队后按上文「延迟投递只认真实撤权」送达，实际接受时复核委派执行代次；
  新写操作仍复核当前输入。实现见 `botDelegationService.ts` 的 `dispatchTrackedInput`；回归见
  `botCanonicalSession.test.ts` 的排队补充与接受回调用例。
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
  （`teammateTurnPrincipal`）；明确风险表在 `taskActionAuthorization.ts` 的 `taskActionRisk`；回执用的身份经
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
