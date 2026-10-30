# 插件调用普通任务（Session）

状态：实验接口，尚未发布。入口为插件逻辑页 `cindy.tasks`，声明 `agent.tasks: true` 后由既有插件权限流程确认。存量 `errand` 声明不自动获得此权限。

## 新建任务、继续任务与读取结果

插件调用的是 Cindy 普通任务（Session）能力。界面、工具说明和文档统一使用「新建任务」「打开任务」「继续任务」，不另设 AI 代办或插件专属任务概念。

| 作者要实现的事情 | 使用方式 | 是否创建新任务／自动回叫 |
| --- | --- | --- |
| 当前任务正在用你的工具，只需读写稿件或业务数据 | 工具直接返回数据，由当前 Agent 继续工作 | 不新建，不回叫 |
| 用户在稿件、批注面板中提交新的修改意见 | `cindy.agent.run({mode: 'continue', ...})`，走原有点击票或已关联任务授权 | 继续原任务，不另开任务 |
| 独立完成一项工作，需要单独的历史与模型 | `cindy.tasks.create(...)`，随后 `cindy.tasks.send(...)` | 创建普通任务；创建本身不启动模型 |
| 再给同一项工作追加要求 | 保存 taskId；`get` 获取最新 revision，再 `send` | 保留同一任务与历史 |
| 查询进度／完成后更新插件页面 | `getRun` / `listRuns`，完成后 `readMessages` | 查询状态和结果，不唤醒任何伙伴或 Agent |
| 只需一次短文本结果，无工具、无任务历史 | 原有 `cindy.text.oneshot` | 使用现有轻量模型通道，不创建任务 |

伙伴任务完成后向伙伴自己的时间线回报，是伙伴的业务流程。插件新建任务不默认附带该流程；
普通任务创建入口不发送完成回叫。插件根据需要读取回执和结果，无需模拟一个伙伴。
当前没有任务事件订阅接口，请查询持久回执；不要把「已创建」或「已接受输入」显示成「执行完成」。

### 作者使用示例

先声明 `agent.tasks: true`，按既有插件能力授权使用。面板按钮应转交逻辑页执行，不能访问宿主内部 IPC。

```js
const capabilities = await cindy.tasks.capabilities();
// 每个逻辑操作保存一个稳定 requestKey；重试沿用，不能每次生成新键。
const task = await cindy.tasks.create({
  requestKey: 'course:git:create', title: '学习 Git',
  // 处理在途工具调用时可传 callId，使用其发起任务的当前模型。
  // 面板直接点击省略 callId，使用 Cindy 当前的新任务选择。
});
// taskId 必须存到插件自己的业务记录里。新建成功并不表示模型已运行。
const run = await cindy.tasks.send({
  taskId: task.taskId, expectedRevision: task.revision,
  requestKey: 'course:git:first-input', text: '请生成 Git 第一课。',
});
const state = await cindy.tasks.getRun({ runId: run.runId });
if (state.status === 'completed') {
  const page = await cindy.tasks.readMessages({ taskId: task.taskId, limit: 50 });
  // 使用 outputMessageId 与消息游标读取本次结果，保存 nextCursor 后可继续分页。
}
```

需要显式选模时，使用现有统一目录的投影，不拼接供应商或型号：

```js
if (capabilities.operations.includes('models')) {
  const { models } = await cindy.tasks.models();
  // 让用户选择或按其明确偏好匹配 models 中的项，不擅自取第一项作为降级。
  // selected 是所选目录项；直接把 selected.route 传给 create 的 route。
}
// 已有任务要改模型，先 get 获取最新 revision，再调用：
// await cindy.tasks.setModel({taskId, expectedRevision: task.revision, route: selected.route});
// 遵循返回 status 和最新 get 的配置；运行中的切换可能推迟到安全边界。
```

`models` 与 `setModel` 是可发现的增量能力；调用前检查 `capabilities.operations`。
旧客户端不支持时显示不支持或使用当前任务选择，不自行调用私有 IPC。模型清单只包含宿主当前可选来源；
连接存在不等于远端凭证、配额和请求一定成功。保存、创建、发送／改模仍分别验证，错误应显示给用户，
允许恢复连接或明确改选同一任务的模型；不得自动改成另一型号、另一个账号或清掉历史后重建。

持续复用任务的插件若要在新输入前同步插件当前保存的模型设置，必须同时确认
`capabilities.operations.includes('setModel')` 和 `capabilities.pluginDefaultModel === true`，
再调用 `setModel({taskId, expectedRevision, route: 'plugin-default'})`。仅存在 `setModel`
operation 不代表支持这个特殊 route；它只适用于 `setModel`，不能传给 `create`。

```js
let currentTask = await cindy.tasks.get({ taskId });
if (capabilities.operations.includes('setModel') && capabilities.pluginDefaultModel === true) {
  const result = await cindy.tasks.setModel({
    taskId, expectedRevision: currentTask.revision, route: 'plugin-default',
  });
  currentTask = result.task;
}
// 仅用于尚未发送的新输入；之前已接受或结果不确定的输入须先恢复其原回执。
const nextRun = await cindy.tasks.send({
  taskId, expectedRevision: currentTask.revision, requestKey: nextRequestKey, text: nextText,
});
```

Host 每次调用都重新读取本插件的模型设置，复用创建任务的模型解析规则；没有完整插件覆盖时
可继承当前新任务选择。只同步模型、Agent、供应商、推理强度和 Fast，不修改权限、工作目录
或任务历史。返回 `{status, task}`；组合相同返回 `unchanged`，不重复切换运行时。
后续 `send.expectedRevision` 使用返回的 `task.revision`，不能继续使用切换前的 revision。

解析或运行时写入前若任务 revision、插件模型偏好或所继承的新任务默认组合变化，会返回
`STALE_REVISION`。调用方应重新 `get` 获取最新任务 revision，再重试同一次模型同步，成功后
才发送新输入；不得沿用过期 route。该重试不授权重发已经接受或结果不确定的旧输入，旧输入
仍按原 requestKey／run 回执恢复。不可用模型等其他错误应按原因处理，不静默换模型。
旧 Host 未声明 `pluginDefaultModel: true` 时不发送该特殊 route，保留任务已有模型和原有发送
流程；显式 `selected.route` 的调用契约不变。

`setModel` 返回 `deferred` 时，当前执行仍按原模型完成，下一条输入才应用新组合。
任务 `resolvedConfig` 与 revision 表示宿主已接受的下一条输入配置；在切换实际生效前后保持
一致，避免先用旧模型登记发送回执、再因新模型生效而拒绝首条续发。读取历史不受切模影响。

### 宿主实现边界

`localDb/sessionOpening.openSession` 是普通新建任务的公共入口：模型准入、目录准备、Session 行构造与提交。
普通新建任务 UI、`send_to_session` 新建、伙伴普通任务、插件普通任务和工作区创建均使用该入口。
伙伴通过提交回调把 Session 与原有委派回执保存在同一个事务中；伙伴信号、卡片、超时及完成回报留在伙伴层。
插件继续使用自己的持久操作回执。公共入口不认识伙伴／插件身份，不创建回叫任务。
`sessionExecutionSelection` 复用普通模型能力及供应商校验；显式目录选项沿用 `appDefaultModelControl`。
已有任务改模复用 `sessionControlService`，不另造运行时或供应商选择器。

## 模型配置与创建来源

插件是小程序；普通任务 API、用户任务交互、快速调用和旧派活接口是不同能力。
共用的是普通 Session 的模型配置与可用性校验，不是 errand 的取件生命周期。

2026-10-01 确认的默认行为：新建任务沿用发起任务的模型；从面板直接新建时使用当前
新任务选择；用户可为插件单独覆盖。模型、Agent、供应商、推理强度和 Fast 作为完整组合
解析，绝不从另一 Agent 的历史草稿拼出一组值。权限独立设置，不随模型来源继承。

每个插件可在自己的 `ghost.json` 声明 `showTaskPreferences: false`，隐藏该插件在 Desktop/手机上的
宿主「模型与任务」卡片，并使该卡的全部配置在运行期无效。统一通过 `getPluginTaskDefaults` 判定，
隐藏时不读取、不采用、不回写其旧模型、目录或权限值；数据保留，重新启用后恢复。
省略或 `true` 保持该插件原有卡片配置、权限限制和执行规则；其它插件和全局设置不受影响。
以下卡片规则均只适用于启用卡片的插件；Host 的能力批准、账号/安装代次、任务归属、目录/目标授权和
Session/Plan 仍独立检查。旧 Host 可能只隐藏 UI，依赖停用语义须使用实现此契约的客户端。

| 入口 | 模型来源与复用 | 权限与结果 |
| --- | --- | --- |
| `tasks.create` | 显式 route → 插件任务设置 → 经验证的 callId 发起任务 → 系统辅助模型链（同一供应商与模型先试 Pi 引擎，再试链上写明的引擎；先取 low／medium，都没有才用默认档）→ 当前新任务选择；保存准入后的完整 route | 可选 permissionMode；启用卡片时受其权限上限约束，隐藏时不读该上限；省略沿用设置，缺省 ask；返回普通任务及持久创建回执 |
| `tasks.send` | 使用该任务当前 route，检查 revision 和当前可用性；不因新默认变化重建任务 | 复核插件归属与权限；结果使用逐输入 run 回执 |
| `agent.errand` | 共用模型解析；无显式覆盖时优先保留已有专属任务的当前模型。配置冲突时只在新任务创建成功后替换映射，旧历史保留 | 旧权限边界、sessionKey、jobId 与结果取回协议保持兼容 |
| `workspace.ensureSession` | 已有工作区入口照常复用；新建才使用插件设置／发起任务／当前新任务完整组合 | 目录仍经亲选或原有确认流程；只建入口、不运行 Agent |
| `agent.run` | 操作已有用户任务；本机任务校验其当前组合，远程任务交由执行宿主校验，继续／新建／分叉仍按原接口继承用户任务 | 保留原有点击票、任务关联和源权限限制；不套用插件自有任务权限或取件协议 |
| 快问快答 | 与新建任务共用插件详情的唯一「模型」字段：用户显式选模即钉死该组合；未选时依次取身份卡 `oneshotModel` 声明、系统辅助模型链（每单现读） | 不创建任务、没有工具，走轻量文本通道 |
| 媒体生成／向量 | 没有逐插件选模，走调用方档位／点名与系统默认 | 不变成普通任务或代办 |

`tasks.capabilities().sourceCallContext` 声明支持 create 的可选 `callId`。Agent 在处理
在途插件工具时可转传该调用 ID；宿主只接受同插件、本机、仍在途的归属，不接受插件
自报 sourceSessionId。失效来源且没有完整显式模型配置时拒绝创建，不悄悄改用面板默认。
面板直接创建省略 callId。旧客户端不支持该能力时不能发送新字段；旧插件无新字段的
创建请求保持兼容。来源字段参与新请求的幂等摘要；已有回执重放不重新读取过期调用。

设置页使用现有 ModelSelector／PermissionSelector，显示默认来源与面板模型预览。
选择模型时保存完整组合；「恢复默认模型」只清除模型覆盖，保留目录与权限。保存被拒时
恢复原选项并就地展示可操作原因。普通任务、工作区及旧 errand 插件均可见这份设置。
新普通任务缺省使用 `ask`，与所选 Agent 的普通任务一致；已有任务不因默认值变化改权。
旧 errand 缺省及显式 `plan` 配置保留原行为，设置页显示保留的权限而不冒充 `ask` 或
跨 Agent 的只读保证；历史 acceptEdits 配置也原样保留。新选项统一为默认权限（ask）、
自动审批（auto）和完全访问（bypassPermissions），用户明确选择后才覆盖旧值。

`tasks.capabilities().createPermissionMode` 表示创建接口支持按次选择 ask／auto／bypassPermissions。
`tasks.create` 和 project 的 `targets.send` 接收可选 `permissionMode`，仅写入新 Session，不修改插件偏好。
启用卡片时保留当前设置上限，不足返回 PERMISSION_DENIED；隐藏时不读取或比较卡片，插件自行传参，未传为 ask。
隐藏插件传入的三档权限直接用于新任务，包括完全访问；不新增独立权限上限或逐次宿主确认。
两类插件都须获得 Host 任务能力批准，并复核账号、归属与真实任务状态；已有任务与伙伴不接受该参数。
新字段参与请求摘要，缺省不增加摘要项，旧回执可重放。既有 requestWriteAccess 仅支持 acceptEdits／auto，
启用卡片时保持原写回规则，隐藏时只改变目标 Session；不新增确认 UI 或授权存储。

`pluginTaskPrefsStore` 保留历史 `ghost-errand-prefs.json`、`errand` 与 `sessions` 键以及
既有 IPC 名；无需重装、重新授权或人工迁移。`sessions` 键只供旧 errand 映射使用。
`sessionExecutionSelection` 只处理来源组合，调用 `resolveSendToSessionExecutionConfig`
及实时已连接供应商快照，复用普通任务准入，不定义平行模型目录。

恢复路径：未就绪 Agent 则完成安装或改选；失效连接则修复供应商连接或明确改选；已有普通
任务在任务内修正模型后继续使用原历史。校验失败不创建任务、不投递首条消息、不自动换
廉价模型或其它账号。无推理档位模型使用空 effort，不凭空写 high。

### 2026-10-01 失败场景的证据边界

日志证明：旧 errand 在没有插件覆盖的情况下采用 Claude Code 的历史草稿，执行收到
API 400 / code 1210；该路径未做完整路由准入。不能由这一错误推断凭证失效。
Claude Code 适配层 `toSdkModelString` 会按目录窗口自动追加 `[1m]`；日志中的该后缀
不是用户保存了无效模型 ID 的证据，不能用简单拒绝带后缀 ID 的测试宣称修好了远端 400。

本次配置修复应分别验证来源选择、宿主准入以及真实 provider 推理。实时目录／已连接
快照能证明当前路由存在，不证明额度及远端参数有效。原失败请求的上游参数原因和新版
真实点击执行，在没有对应运行证据前继续标为未验证；不把单测、桥接替身或目录回放当作
已部署修复，也不重跑用户正在使用的学习任务。

隔离开发版的真实验收已覆盖：面板创建及 Astra 执行、同任务继续、Agent 经真实插件工具
发起创建、不可用供应商拒绝及明确选模恢复、旧 errand 执行并读取结果。补充验收确认：
面板默认 Sol 时工具调用仍继承 Astra；插件选择 Luna 后采用 Luna，单次指定 Astra 优先。
原任务切到 GPT-6.1-Sol 后返回 `MODEL_SWITCH_OK`，执行回执与实际模型一致，任务 ID 和
历史保留。新任务落库为 `ask`，与设置页「默认权限」一致；旧任务权限不随默认变化覆盖。
这些结果不证明原 GLM 请求的参数、凭证或配额有效；该供应商的 400 根因仍未验证。

## 已接入

- `capabilities/models/create/list/get/setModel/send/getRun/listRuns/readMessages/cancel/setHidden/archive`。
- `archive({taskId})` 归档本插件自建的空闲本地任务（有执行中或排队输入时返回 `TASK_BUSY`），走与侧栏归档相同的 `patchSessionMetaInDb` 路径；可逆（用户可恢复），不提供删除。归档后的任务由「存储空间 → 数据库清理」按既有规则处理。
- create 可传 `hidden:true`、`setHidden({taskId, hidden})` 切换，`get`/`list` 快照恒返回 `hidden` 布尔值；仅身份卡声明 `agent.hiddenTasks: true`（必须同时 `agent.tasks: true`）时可用，见下文「后台任务」。
- create 可传 isolatedWorkspace:true，由宿主分配独立空作答目录；返回本任务 workingDir 与实际 permissionMode，按次选择不得超过用户授予插件的权限。
- 默认创建用户可见的普通本地 Session（声明 hiddenTasks 后可在同一次 INSERT 中创建后台任务）；工作目录及权限来自用户配置，不接受插件传入绕过权限、任意目录或另一插件身份。普通任务创建前复用 Worker 的目录身份判据：配置路径必须仍为原规范路径，改链、缺失或非目录拒绝；异步解析后复核账号、tasks 批准及配置。缺省/isolatedWorkspace 仍由宿主分配目录，旧 errand 路径不变。旧别名配置没有原目标证据，不自动授权当前目标；这不解决校验后的目录置换窗口。
- 发送走普通输入协调器，使用持久 requestKey 去重和稳定输入 ID；重复请求不会再次启动模型。
- 指定 provider、model、effort、Fast 必须通过当前目录核验；派发前再次核验，不静默 fallback。
- 创建回执写入后、创建 Session 前，按原始请求重新解析路由并与已受理路由比较；默认模型配置变化则拒绝，不静默使用旧值。目录解析及创建器的最终 continuation 同时复核 agentKind/model/provider/effort/Fast、目录和权限。
- 本次创建在 Session INSERT 开始前明确失败（如配置、目录或工作区准备失败）时，沿现有回执队列撤回仍为原版本、且原始 Session 行不存在的新回执；修正原因后可用原 requestKey 显式重试，不自动重派。回执存储固定原账号数据库，撤销或版本变化的回执不删除。
- 新请求的幂等摘要忽略对象键顺序，保留数组顺序；计划及已受理配置共用相同比较。早期开发版创建回执保留原序列化输入的精确重试兼容；这类旧摘要未保存原始键序，不能承诺首次以不同键序重放成功。
- 回执独立落库，区分任务、输入执行及原生执行代次；原生终态按 instanceId + generation 结算，不以 idle 或最后一条 assistant 消息猜测完成。
- send 回执写入后，进入宿主派发前的检查拒绝可确定未发送，结算为 failed；进入派发后的异常仍为 reconciling，明确拒绝仍为 failed，已有原生进展优先。同 requestKey 只读取旧回执，权限恢复后需新 key 显式提交。若账号、归属或存储条件不再允许结算，调用仍拒绝并保留回执，不绕过权限门补写终态。
- 读取限定于本插件创建的任务；返回消息 clientId。list/listRuns 按 (createdAt, id) 排序，现有回执 ID 游标在同插件与目标内解析，不再只按随机 UUID 排序。列表是分页查询，不是增量订阅；刷新应从首页重扫，不能把游标当永久同步水位（同毫秒追加、系统时钟回退或既有回执终态更新均需刷新）。
- 插件创建的任务及其 Orca Worker 使用普通任务的 `cindy_helper` 能力面；`cindy_memory`（含 `session_search`）、`cindy_contacts`、`cindy_scheduler` 和 `cindy_slack` 也按普通任务的账号、对象归属及工具权限检查。任务创建来源不参与 Agent 工具授权；插件消息标签不额外收窄任务权限，原本要求用户当场输入的操作仍按通用规则判断。个人插件投稿同样沿当前任务权限档与账号身份检查。插件直接调用的 `cindy.tasks` 仍只能管理自己的任务，不能凭此接口读取或控制其他任务。
- 账号数据工具仍在访问前和返回前复核任务与账号，缺少任务、账号变化或查询失败时拒绝，不伪装为空结果，也不回滚已经接受的外部写入。插件卸载或创建回执损坏只撤销插件继续调用自有任务接口的资格，不收窄保留任务内 Agent 的工具面，也不保证停止已接受执行。
- 取消只撤回自己的排队输入或其原生重试别名；停止前在 Session 锁内再次核对执行身份与插件权限。
- 请求跨账号切换后不能继续操作新账号数据库。禁用插件后不能继续发送或停止。
- 用户通过插件页或市场卸载时，在删除插件包前持久撤销其旧任务归属；保留任务、消息、作答文件、成绩和回执。正常更新保留归属；卸载重装后旧任务和旧 requestKey 不再可用，新请求键可创建新任务。撤销写入失败则不删除包；删除包失败时已撤销的归属不回滚。此处不改变内置插件 orphan/audience 自动回收路径。

## 后台任务（agent.hiddenTasks）

任务默认可见。声明 `agent.hiddenTasks: true` 的插件可以把**自己经 create 回执拥有的**本地普通任务
放到后台：`sessions.hidden_at`（可空毫秒时间戳，migration 0126）非空即隐藏，存量行全部为 NULL。

- **声明与权限**：v3 直接能力字段，`GhostAgentNeeds.hiddenTasks`；新包校验要求布尔且依赖 `tasks: true`，
  已安装快照里不成对的历史值只作为未知数据保留、不授予（`ghostDeclaresHiddenTasks` 统一判定）。权限项
  `agent:hidden-tasks` 单列在 `agent:tasks` 之后，进入详情页权限区与安装/更新确认；更新新增该声明按
  「权限变多」触发确认，旧 receipt 缺字段视为未声明，不报错、不迁移。管子（taskSlot）先按身份卡拒绝，
  服务在回执队列内再经 `assertHiddenTasksAllowed` 复核插件批准与声明；未声明返回 `PERMISSION_DENIED`，
  `hidden:false` 是默认值，所有 tasks 插件可用。
- **幂等**：只有 `hidden:true` 进入 create 的请求摘要，存量可见回执的重放摘要不变。
- **写入口**：创建时由 `openSession({hiddenAt})` 在同一次 INSERT 落库，不发「新建」推送；切换与用户
  显示统一走 `localDb/ipc/sessionHidden.setSessionHidden`：隐藏广播 `sessions:patched {hiddenAt}`
  （renderer 从各桶移除并重拉、灵动岛收起），显示清列并刷新 updatedAt、广播 patched 后再发
  `sessions:created` 让侧栏与控制端整体重拉。归属复用 `ownTask`（创建回执 + 账号/批准复核），远程任务
  与 Worker 没有创建回执，`readSession` 不认，不支持 setHidden。
- **可见性口径**：`local-db:sessions:list`、会话搜索（conversationSearch）、未结束提示两条腿
  （sessionActiveTurn）、hook-control 最近任务排除隐藏任务；用量统计等全量口径不排除。灵动岛/菜单栏
  运行态与系统通知经 `sessionFlagRegistry` 同步判定跳过（首次 list 时按账号库预热，加载前按可见处理）；
  renderer 通知兜底按单任务读取的 `hiddenAt` 判定。`subscriptionGateway.isGhostEligibleSessionRow`
  不因隐藏改变，插件仍可订阅自己的任务。
- **透明性兜底**：插件详情页「后台任务」区块（设置之后、Tools 之前）列出本插件回执拥有、仍在后台且未删除
  的任务（标题、最后活动、运行状态），可「打开任务」（`/cc-agent/:id`，与审查卡片同一路由）或「显示到
  任务列表」。停用插件同样可查；更新移除 hiddenTasks（甚至 tasks）声明后仍有遗留后台任务时区块照常出现，
  未声明且没有后台任务的插件不显示该区块。卸载时 `withUninstall`
  先把该插件的后台任务全部恢复显示，再撤销归属；恢复失败则不卸载。内置插件 orphan/audience 自动回收路径
  未改，不经此恢复。
- **多端**：SSH 远程工作区——插件任务只建在本机，不涉及。设备互联/手机——列表走同一个
  `local-db:sessions:list`；远端边界（`remoteBotSessionBoundary`）把隐藏任务标为 `background`，只从
  `sessions:list` / `maker:list-active` 结果中排除，`sessions:get` 等单任务读取与操作照常（插件页深链
  可打开）。详情页的两个新 IPC `ghosts:background-tasks:list` / `ghosts:background-tasks:reveal` **只登记
  Desktop**：它们服务本机插件详情页（打开任务、显示到任务列表都是本机 UI 动作），手机端没有插件详情页
  入口，按 allowlist 默认拒绝不进白名单；handler 同时拒绝 device-link 调用并校验可信窗口。手机列表在
  任务转入后台的瞬间不会主动移除已加载的行，下一次列表重拉后消失（手机端未改，未单独验证）。

## 与伙伴的共用和隔离

`sessionExecutionOwnership.ts` 提供执行身份比较、锁内二次核对、按归属撤回排队输入。伙伴委派与插件任务均使用这套函数。

插件继续复用现有普通 Session 创建、输入协调器、停止服务及产品终态边界。没有创建假伙伴，没有另建模型执行器。伙伴的身份、父子委派规则及专有配置仍由伙伴服务管理。

## 当前限制与后续工作

- 仅本插件创建的本地普通任务；不支持选择既有任务、远端任务或 Bot（setHidden 同样只作用于自有本地任务）；自有普通任务可通过 startTeam 成为 Orca Lead。
- 已支持通过 `setModel` 修改任务模型；尚未开放其它配置修改/归档任务、队列暂停、事件订阅、逐输入费用与用量。usage 明确返回 unavailable。
- 回执已经持久化，但完整的重启后终态补账、无输入别名的自动续跑归属尚未闭环。缺少原生证据时返回 reconciling，不重放请求、不报告成功；目前不应作为无人值守正式评测的完成依据。
- 一旦 Session INSERT 已开始、创建进程中断或回执撤回失败，结果仍可能不明：保留回执，重放只读取已存在任务，不补建，可能返回 TASK_NOT_FOUND。旧孤立回执没有本次失败证据，不自动修复；已删除任务不复活、已撤销任务及旧 key 不接管。此限制与创建前明确失败后的显式重试不同。
- 无推理档位的模型以空 effort 表示；显式提供不支持的档位仍拒绝。
- cancel 的 requestKey 当前不建立独立账本；同一 run 的终态保持幂等，进行中的重复取消仍可能再次请求原生停止。
- 评测插件已接入此接口；实际 UI 联调结果另记，未自动启动付费模型。

## 验证边界

服务、执行归属、权限入口、清单兼容、Worker 创建与释放均有定向回归。数据库迁移使用隔离临时数据库验证，不触碰真实用户数据库。完整 UI、真实 provider 执行和重启后的长期恢复仍需发布前验收；不能把模块测试通过解释为无人值守评测已完成。

代码入口：`apps/desktop/src/main/maker-ipc/pluginTaskService.ts`、`pluginTaskStore.ts`、`sessionExecutionOwnership.ts`、`register.ts`；插件入口 `apps/desktop/src/main/cindy-brain/taskSlot.ts` 与 `apps/desktop/src/preload/ghostPreload.ts`。

## 首次修改授权

插件新增的 tasks 能力首次使用时复用宿主权限确认。拒绝、超时或确认失败后，同一账号代际和安装修订在当前宿主进程内不再自动弹窗；插件重载或重复调用不能清除该状态。用户可在本机插件详情权限区点击“确认任务权限”重新进入原确认流程，点击不等于批准；在途确认不并发，账号、安装修订或发起窗口改变时旧结果无效。旧插件的既有功能、启用态、凭证与设置不变。此显式入口不向插件页面或 device-link 暴露；重启宿主后可重新首次询问。

逻辑页可调用 `cindy.tasks.requestWriteAccess({taskId, mode?})`。省略 mode 保留旧行为（acceptEdits，仅限未开始执行的任务）；`mode: auto` 请求宿主原生确认，为空闲自有任务启用 Auto。插件不能替用户确认，该接口不接受 Full access。插件直接调用 `tasks.startTeam` 仍须核对自己的任务、当前插件批准和 Auto 权限，开启团队本身不创建 Worker，也不改写全局 Worker 权限偏好；后续 Worker 沿用普通 Orca 创建权限流程。返回 granted 与更新后的 task/revision，插件应继续原批次。

### 主任务协调评测

插件创建的任务及其 Worker 使用普通任务的权限模型。公共 `start_team`、`create_worker`、队列控制、结束团队和 Worker 改名只检查当前任务权限、账号、团队成员关系及已有操作凭证；不会因创建者、插件输入标签、插件安装状态、团队计划或收据额外拒绝。请求 Worker Full access 时走普通任务的原生确认。排队派发与延后完成沿现有账号、会话权限和任务清空边界复核；插件卸载不会因此中止已接收的任务执行。插件直接调用 `cindy.tasks` 仍只可管理自己的任务。

任务写权限请求在当前宿主进程中按账号代际、安装修订和任务记忆拒绝或失败，插件 reload 和更换请求模式不能恢复自动弹窗。用户可在本机任务权限菜单点击“重新确认插件写权限”，复用原请求模式和原生确认；在途请求不能并发。此专用 IPC 拒绝 device-link，并校验真实顶层窗口、账号与安装修订。已有效授予的权限直接复用，未改变普通权限切换行为或旧 errand。重启宿主后可再次首次询问。

插件授权确认后的提交、本地/远程任务权限切换及 IM 权限命令，共用按任务排列的内存提交队列，覆盖运行态变更、数据库保存和失败回滚；较早操作不能在较晚用户选择完成后再回滚覆盖它。确认弹窗在队列外。普通权限切换不占发送/重启锁，原生群轮次的临时权限恢复和续跑仍可完成；插件提交仍保留原来的空闲检查与发送保护。界面与远程转发不再追加第二次权限保存。等待后及异步边界核对原账号实例，失败不延迟重试，不承诺跨账号补偿或跨重启事务。

首次协同计划检查落盘 user 消息与任务开始/结束时间；清空或回退对话不会抹除执行事实。目录核验到保存复用普通发送锁，同计划重放仍保持幂等。

`tasks.startTeam({taskId})` 为本插件拥有的普通任务启用 Orca Lead，复用现有协同入口并沿用当前 Worker 创建权限偏好，不隐式改写偏好。插件不能指定 Worker 权限绕过确认。确认返回后检查原修订；团队查询、创建和 Lead 激活后复用同一准入回调，核对原账号、插件归属/批准、当前 Auto/Plan、任务路由与目录以及插件配置目录。正常成为 Lead 会改变包含角色的修订，原生阶段改比这些准入事实，不把本次角色变化误判为用户变更。`tasks.getTeam({taskId})` 只投影所属团队的 Worker 身份、实际模型配置、目录、队列和终态；不会将 Lead 一轮完成解释为整个团队完成。

协同启动要求任务仍为 active；创建或激活中的归档、撤权、降权及配置变化会拒绝本次调用。新建团队沿原 lifecycle 补偿标为 failed，清理 Lead 角色及运行态选项，不删除任务或成果；复用已有团队时只拒绝本次调用，不结束原团队。检查与尽力补偿均处于原生操作的 drain 跟踪内；存储补偿失败仍返回失败，不保证跨账号数据库补偿，也不宣称最终复核与后续跨进程归档形成事务。

插件可读取自己任务在权限变化后的状态与执行停止，但新发送拒绝超出插件策略的 full access 任务。任务快照同时返回独立的 planModeEnabled 与原 permissionMode；独立 Plan Mode 开启时拒绝新发送、排队接受、写权限请求及 Worker/团队启动，不以原 Auto/AcceptEdits 作为执行授权。普通 permissionMode 为 plan 的既有流程保持不变。既有普通任务的所有权收据在成为 Lead 后继续有效；Worker 不是插件直接控制的普通任务。

评测客户端每批仅创建一个 Lead，答案目录逐份隔离，由 Lead 使用原生 Orca 调度。插件根据 Worker 成员、配置、目录、done 且无活动/队列的状态独立验收。该投影不是逐轮执行账本，不作为精确费用证据。重试先核对既有 Worker；未知归属不得重派或算零分。停止须确认 Lead 停止处理完成和团队不再活动。

getTeam 的 completedAt 可由宿主落盘的 turnCompleted 终态恢复：仅接受当前轮最终顶层 assistant、启动/结束边界吻合、无后续用户输入、无活动/排队/暂停工作，并须有未清空/回退的真实顶层任务输入。初始化就绪确认及仅有自动续跑输入不能充当题目；续跑可关联原始真实输入。同毫秒消息按 SQLite rowid 插入顺序确定最后一条，不按随机消息 ID 排序；releaseWorker 共用该读取。没有交卷证据的原生 done 仅在插件投影中显示 idle，不改原生状态；lastTurnEndedAt 仍是诊断时间而非交卷凭据。空闲状态或 Worker 报告正文自身不是交卷凭据。投影同时返回实际 permissionMode，供插件诊断。

### 已登记协同计划与释放

`setTeamPlan({taskId,plan:{concurrency,items}})` 在本插件自己的创建收据中冻结计划。首次登记必须早于输入派发和 Worker 创建（包括创建预留）；同一计划的幂等重放不受此限制。每项含唯一 label、workingDir 和精确 route；重复设置必须一致。未登记计划的存量任务仍按普通任务权限执行。Worker 创建复用原子 reservation；计划作为插件的批次记录，不作为公共 Agent 工具的权限来源。历史收据中的计划与 settledLabels 保持原样兼容，不再用它们限制 Worker 创建或归档。

计划保存目录准入返回的 canonical 路径，后续别名改链不会把冻结计划改成新目标；这不构成 OS 目录对象隔离。首版仅用于可信本地工作区，不防御同权限进程在最后校验后、harness 使用 cwd 前恶意替换目录对象；路径复核或 JS 锁不能消除该窗口，不把另建 OS 隔离后端列为本接口的发布前提。插件直接调用任务 API 时仍检查归属和权限；Agent 工具按当前任务权限检查。`getTeam` 先恢复 Lead 的持久输入队列，恢复失败或未确认时拒绝返回空闲；最终读取实时 Lead 状态，不以启动后的空内存队列报告批次完成。

`releaseWorker({taskId,workerId,completedAt})` 仅释放本插件 Lead 内、结束时间仍匹配、无活动/排队输入的 Worker。它与 getTeam 共用宿主成功终态判据，不能以 Worker 更新时间或失败轮结束时间替代交卷凭据。调用方应先保存交卷快照和评分。复用 Orca 的归档路径、transition 锁和发送锁；持锁后再次核对 completedAt 与归属。Worker 按稳定的 workerId 与所属团队识别，改名不影响释放，也不要求匹配计划标签。已有发送锁时直接拒绝释放，不等待而形成锁反转；成功后以 Worker 归档状态记录释放，已归档重试仍复核完成凭据。拒绝正在发送或运行的 Worker，保留任务历史与作答文件。

`getTeam` 增加包含创建预留的 capacity 快照（advisory；准入仍由创建事务裁决）、逐 Worker 的等待确认状态、首条输入/首条执行消息时间、最近轮结束时间，以及 Worker/Lead 分列的 session-total 用量。`host-message-window` 是可观测作答窗口，不是精确模型计算时长。无确切 USD 金额时返回 null，不把订阅估值或其他币种直接当美元。

写权限确认前及最终提交前，在原 session/send 锁下恢复持久输入队列；恢复未确认或仍有排队输入时拒绝提权，不把冷任务的空内存队列当作空闲。任务能力批准在收据临时文件准备完成后紧邻原子发布复核账号时效，该受保护替换不跨事件循环；普通收据写入保持原路径。

Plan Mode 的本地及 device-link 切换与插件确认复用同一内存权限提交队列，由 Host 完成 runtime、落库与失败恢复；renderer 不再另写 DB 或发第二次回滚。原生 Plan 事件只异步登记镜像，不阻塞事件消费和 turn 收尾；落库前核对原账号、绑定 Session 及当前 armed 值，忽略迟到的旧事件。插件授权另同步核对现有稳定 Plan 状态（含未知/切换中），不等同于仅看数据库镜像。普通新输入 IPC 在 send/restart fence 外等已有权限提交完成后才进入发送；内部续跑、steering 与独立停止不等待该队列。上述复用不新增 Plan 代次、持久字段或后台重试，也不承诺跨工具事务。

插件 `tasks.send` 与排队输入最终 `accept` 同样核对 live Session 的 `stablePlanModeState`；
DB 中下一条输入的 armed 值为 false 不代表原生执行已退出 Plan。执行态开启、未知或切换中时拒绝；
路由查询、回执保存后复核同一 Session 对象及已有 Plan generation，变更后不沿用旧授权。
冷任务仍可入队，但最终接受必须匹配已启动的执行实例。读取、取消和同 requestKey 的回执查询保持原行为。

### Agent 工具权限与 Auto 审阅

插件创建的任务与普通任务共用 Host Auto 审阅、MCP 快捷放行、Ask/acceptEdits 逐次确认、Full access 与 Plan Mode 判据。Agent 审阅只使用当前任务权限和原有用户指令证据；插件计划中的 `task`、收据、任务创建来源及消息标签不构成额外授权或限制。Codex 原生 `on-request`、`workspace-write` / `auto_review` 仍按原生机制执行；任务说明不是 OS 沙箱。

计划的顶层 `task` 及每项 `task` 仍可作为插件自己的批次说明，每段最多 8000 字符。完整计划 `JSON.stringify(plan).length` 最多 1,048,576 个 UTF-16 字符；超限返回 `INVALID_REQUEST`。计划整体不可变，`releaseWorker` 按 workerId 归档，不再维护标签结算；插件按 Worker 身份记录自己的批次进度。缺少计划不影响任务中的 Agent 使用普通 Auto 权限。

卸载撤销插件后续 API 控制，不保证停止已派发的原生工作；用户可使用原有任务停止入口。

## 通用投递目标（增量接口，尚未发布）

`cindy.targets` 的作者契约见 `FORGE_GUIDE`，实现位于 `pluginTargetSlot.ts` 和
`pluginTargetCandidates.ts`。查询、解析和投递相互独立，没有宿主目标选择弹窗、Renderer 目标选择接线。权限说明复用既有安装/更新确认界面。
选择方式、固定目标及其配置由使用这些接口的插件维护；Host 不保存插件的固定目标绑定。
入口要求 `agent.tasks: true` 与独立的 `agent.targets: true`，后者单列为 `agent:targets` 权限，需 Host receipt 的 `targetCapabilityApproved` 明确批准事实。
安装/更新确认只授予实际展示的新能力；旧 tasks 批准与历史未知字段不授予 targets。存量插件的原有能力不变，缺独立批准只阻止新接口；首次新接口调用复用既有宿主确认。
保留 `cindy.tasks` 自有任务边界，不放宽它的 get/list/send，也不改变默认设置卡。

- `list({targetKind})` 返回 `{targets:[{kind,id,label,detail}]}`，仅返回本机可用目标元数据，不返回消息历史。
  项目使用 Cindy 已有目录分组（id 为目录路径），普通任务和伙伴使用其 ID。最近活动只排序，插件自行展示和选择。
- `resolve({target:{kind,id}})` 返回最新目标元数据，供插件校验保存的固定目标；无写入、弹窗或隐式选中。
  `send` 同样重新校验目标，不要求先 list/resolve，也不接受任意不可用路径或目标；失效返回 TARGET_UNAVAILABLE，不降级改投。
- `send({target,requestKey,text,context?,title?,autoTitle?,route?,permissionMode?,delivery?,attachments?})` 在指定项目中新建普通任务，或向指定普通任务/伙伴投递。
  新任务经现有 `PluginTaskService.create` 登记归属后使用 `createPluginTaskSession`，沿用插件模型选择、受限动手权限及卸载撤销流程，可传统一模型目录的 route，以及当前授权范围内的 permissionMode。
  存量任务和伙伴保留其模型、权限、目录，不接受 route 或 permissionMode；伙伴通过唯一 canonical 注册解析，不使用兼容镜像或伪造伙伴身份。
- 同键并发发送共享同一 Promise。回执复用当前账号 SQLite 的 `plugin_task_requests`，以 `operation=target` 按插件和请求键读写单行；只保存请求摘要、Host 生成的 taskId/clientId、批准修订和状态，
  不保存正文、图片或插件固定配置。执行前原子预留回执；已接受请求可在重启后返回原结果，尚未确定的回执返回 DELIVERY_UNCERTAIN，
  不自动重派。幂等键按插件和 requestKey 隔离，不因插件升级或 Host 重启更换身份；同键修改目标、正文、附件或 delivery 返回 REQUEST_KEY_CONFLICT。
- `delivery` 为 `queue | steer`，缺省 queue（与显式 queue 幂等签名一致）；project 仅接受 queue。
  queue 走 `sendToSessionInternal` 与既有输入队列；steer 复用 `steerControlInput` 同轮注入，不停止或重启当前轮。
  空闲、框架不支持或当前输入边界不允许插话时走普通队列，保留 Stop/pause 边界。
  返回 `{taskId,accepted:true,delivery:'queue'|'steer'}` 表示实际接受路径，不表示 AI 已执行完成。
- main 盖 sourcePlugin 和 delegated-continuation 来源；入队前及实际受理时复核插件批准与目标。受理通过持久 clientId 查回执，重启恢复后仍检查当前批准修订、取消状态和伙伴 canonical 归属；失效以队列取消信号拦下派发。插话还在异步筛查后及 provider 派发前复核。
  筛查拒绝返回 DELIVERY_REJECTED，不改走队列；ACK 未知保留宿主保护性暂停队列并返回 DELIVERY_UNCERTAIN，不再次排队。
  `cancel({requestKey})` 持久使迟到请求失效，只按本插件该请求的 clientId 撤回排队输入，不停止整个会话或撤回已经接受的插话。
- 仅本机 Desktop，不新增 Mobile/device-link 透传，也不承诺跨平台原生触发。异步请求持续复核原逻辑页、批准 revision 和 owner generation。

此能力供同时声明并获批 `agent.tasks` 与 `agent.targets` 的插件使用；投递沿用目标任务权限，不授予读取历史、修改配置或停止其他任务的权限。
静态检查与单元测试不等于真实 AI 执行的联调验收，不得把 accepted 当成完成。

### 消息图片附件

`tasks.send` 与 `targets.send` 支持 `attachments?: Array<{base64:string,name?:string}>`。
插件先核对 `tasks.capabilities().messageAttachments`，无此能力时停止发送截图，不能静默丢图或回退文件路径。
只接受插件自己提供的字节；不接受 Host 路径、URL、其他会话的媒体 URI 或自报 MIME。
Host 校验规范 base64，嗅探 PNG/JPEG/WebP，最多 4 张、合计 20 MiB；附件字节指纹和名称参与幂等签名，回执不保存 base64。
两种发送入口在解码前共用 40 MiB 在途字节额度，持有至请求完成；超额返回可重试的 `TASK_BUSY`，成功、失败及取消均在 `finally` 释放额度，不在 Host 内排队保留超额附件。

`pluginMessageAttachments.ts` 复用 `ingestMedia` 和草稿/排队消息提交链路。入库前同步登记内容地址到现有回收器的活引用集合，
覆盖去重旧 blob 的入库、取消和派发在途窗口。调用方等待既有持久队列写入或插话落库后释放在途保护；
之后由内存队列、恢复快照和 `createMessage → commitMessageMediaRefs` 的会话附件引用保护。
失败或取消且未采用的图片不保留永久引用，由既有零引用缓冲与手动回收处理。无新目录、数据表、媒体协议或 media.deposit 授权。

queue 与 steer 都把托管 URL 写入 files、chatMessage.images 和持久消息信封；模型输入由既有附件装配器生成。
正文/附件来源仍是插件续行，不把截图变为新用户授权；目标、批准、owner 和取消闸保持不变。
