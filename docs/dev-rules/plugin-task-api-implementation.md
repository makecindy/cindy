# 插件普通任务接口：第一阶段实现

状态：实验接口，尚未发布。入口为插件逻辑页 `cindy.tasks`，声明 `agent.tasks: true` 后由既有插件权限流程确认。存量 `errand` 声明不自动获得此权限。

## 已接入

- `capabilities/create/list/get/send/getRun/listRuns/readMessages/cancel`。
- create 可传 isolatedWorkspace:true，由宿主分配独立空作答目录；返回本任务 workingDir 与 permissionMode，插件不能覆盖权限。
- 创建用户可见的普通本地 Session；工作目录及权限来自用户配置，不接受插件传入绕过权限、任意目录或另一插件身份。
- 发送走普通输入协调器，使用持久 requestKey 去重和稳定输入 ID；重复请求不会再次启动模型。
- 指定 provider、model、effort、Fast 必须通过当前目录核验；派发前再次核验，不静默 fallback。
- 回执独立落库，区分任务、输入执行及原生执行代次；原生终态按 instanceId + generation 结算，不以 idle 或最后一条 assistant 消息猜测完成。
- 读取限定于本插件创建的任务；返回消息 clientId，分页游标仍使用数据库稳定游标。
- 取消只撤回自己的排队输入或其原生重试别名；停止前在 Session 锁内再次核对执行身份与插件权限。
- 请求跨账号切换后不能继续操作新账号数据库。禁用插件后不能继续发送或停止。

## 与伙伴的共用和隔离

`sessionExecutionOwnership.ts` 提供执行身份比较、锁内二次核对、按归属撤回排队输入。伙伴委派与插件任务均使用这套函数。

插件继续复用现有普通 Session 创建、输入协调器、停止服务及产品终态边界。没有创建假伙伴，没有另建模型执行器。伙伴的身份、父子委派规则及专有配置仍由伙伴服务管理。

## 当前限制与后续工作

- 仅本插件创建的本地普通任务；不支持选择既有任务、远端任务或 Bot；自有普通任务可通过 startTeam 成为 Orca Lead。
- 尚未开放修改/归档任务、队列暂停、事件订阅、逐输入费用与用量。usage 明确返回 unavailable。
- 回执已经持久化，但完整的重启后终态补账、无输入别名的自动续跑归属尚未闭环。缺少原生证据时返回 reconciling，不重放请求、不报告成功；目前不应作为无人值守正式评测的完成依据。
- 创建回执落库后若 Session 创建中断，重放不会再建一个任务，可能返回 TASK_NOT_FOUND；尚无自动修复入口。
- 无推理档位的模型暂不支持；不支持的 route 明确拒绝。
- cancel 的 requestKey 当前不建立独立账本；同一 run 的终态保持幂等，进行中的重复取消仍可能再次请求原生停止。
- 评测插件已接入此接口；实际 UI 联调结果另记，未自动启动付费模型。

## 验证边界

服务、执行归属、权限入口、清单兼容、Worker 创建与释放均有定向回归。数据库迁移使用隔离临时数据库验证，不触碰真实用户数据库。完整 UI、真实 provider 执行和重启后的长期恢复仍需发布前验收；不能把模块测试通过解释为无人值守评测已完成。

代码入口：`apps/desktop/src/main/maker-ipc/pluginTaskService.ts`、`pluginTaskStore.ts`、`sessionExecutionOwnership.ts`、`register.ts`；插件入口 `apps/desktop/src/main/cindy-brain/taskSlot.ts` 与 `apps/desktop/src/preload/ghostPreload.ts`。

## 首次修改授权

逻辑页可调用 cindy.tasks.requestWriteAccess({taskId, mode?})。省略 mode 保留旧行为（acceptEdits，仅限未开始执行的任务）；mode: auto 请求宿主原生确认，为空闲自有任务及插件后续任务启用 Auto。插件不能替用户确认，不能请求 Full access。拒绝不改状态；账号、配置、任务版本在确认期间改变则拒绝写入。Auto 插件主任务的 Worker 固定使用 Auto，不继承或改写全局 Worker 偏好；授权撤销后拒绝新建。独立目录不是沙箱。返回 granted 与更新后的 task/revision，插件应继续原批次。

### 主任务协调评测

`tasks.startTeam({taskId})` 为本插件拥有的普通任务启用 Orca Lead，复用现有协同入口及 Worker 权限确认。插件不能指定 Worker 权限绕过确认。确认返回后、实际启用前再次校验账号、插件授权、任务配置修订。`tasks.getTeam({taskId})` 只投影所属团队的 Worker 身份、实际模型配置、目录、队列和终态；不会将 Lead 一轮完成解释为整个团队完成。

插件可读取自己任务在权限变化后的状态与执行停止，但新发送拒绝超出插件策略的 full access 任务。既有普通任务的所有权收据在成为 Lead 后继续有效；Worker 不是插件直接控制的普通任务。

评测客户端每批仅创建一个 Lead，答案目录逐份隔离，由 Lead 使用原生 Orca 调度。插件根据 Worker 成员、配置、目录、done 且无活动/队列的状态独立验收。该投影不是逐轮执行账本，不作为精确费用证据。重试先核对既有 Worker；未知归属不得重派或算零分。停止须确认 Lead 停止处理完成和团队不再活动。

getTeam 的 completedAt 可由宿主落盘的 turnCompleted 终态恢复：仅接受当前轮最终顶层 assistant、启动/结束边界吻合、无后续用户输入、无活动/排队/暂停工作。空闲状态或 Worker 报告正文自身不是交卷凭据。投影同时返回实际 permissionMode，供插件诊断。

### 已登记协同计划与释放

`setTeamPlan({taskId,plan:{concurrency,items}})` 在本插件自己的创建收据中冻结计划。每项含唯一 label、workingDir 和精确 route；重复设置必须一致。未登记计划的存量插件沿用原行为。Worker 创建复用原子 reservation，计划上限只可收窄宿主硬上限。已结算 label 持久保留，不因归档再次变成可派发项。

`releaseWorker({taskId,workerId,completedAt})` 仅释放本插件 Lead 内、结束时间仍匹配、无活动/排队输入的 Worker。调用方应先保存交卷快照和评分。复用 Orca 的归档路径、transition 锁和发送锁；持锁后再次核对 completedAt 与归属。已有发送锁时直接拒绝释放，不等待而形成锁反转；只有归档成功才结算 label。拒绝正在发送或运行的 Worker，保留任务历史与作答文件。

`getTeam` 增加包含创建预留的 capacity 快照（advisory；准入仍由创建事务裁决）、逐 Worker 的等待确认状态、首条输入/首条执行消息时间、最近轮结束时间，以及 Worker/Lead 分列的 session-total 用量。`host-message-window` 是可观测作答窗口，不是精确模型计算时长。无确切 USD 金额时返回 null，不把订阅估值或其他币种直接当美元。


### 委派范围与 Auto 审阅

计划的顶层 `task` 及每项 `task` 是可选的插件原始任务说明，最多 8000 字符。
Host 只接受经绑定插件身份写入的自有创建收据；允许旧计划一次补齐缺失范围，不允许重写
已有范围或改变执行身份。没有新增权限档位、没有提升到 Full access。

审批在查询缓存前重新核对插件批准版本、启用状态、Auto 设置、账号 epoch、任务状态、
团队归属和计划匹配；异步结果返回前再次核对。真实用户限制来自 Host 保存的作者凭据，
不从 Orca 消息、模型声称或工具参数恢复。缺少旧作者凭据时标注历史不完整，不猜测授权。
插件文字放在独立 `delegatedTask` 字段，不能覆盖用户限制、跨题授权或声称自己是用户。
直接派发和排队派发均保存空的用户原话凭据；应用重启后从同一 Host 收据重建委派范围。

明确带任务范围的所有动作（包括读取）均检查范围；不会仅凭工作目录安全而忽略插件的禁读条款。已登记的空作者凭据在 SQL 限量前过滤，避免频繁协调消息挤走真实用户限制；缺凭据的旧卡片保守标记历史不完整。

验证入口：`pluginTaskReviewContext.test.ts`、`pluginTaskService.test.ts`、`taskSlot.test.ts`、
`auto-review-context.test.ts`、Pi/Claude Code 审批接线回归以及 `eval-auto-approval.mts` 的
`delegated-*` 正反对照（后者需要真实审阅模型，当前拆分 PR 未运行付费验证）。主机身份校验是确定性边界，动作与任务是否相符仍由 Auto 审阅，
不宣称题目目录是系统沙箱。
