# Session 控制层与迁移验收

依据：2026-10-02《Cindy 控制框架开发交接文档》。实现基线
`990a243f003d7829b062679a6f704524bf4f5515`；本文件记录本次本地实现及验证，
不代表已经发布、合并或通过真机验收。准备讨论草稿时已同步到
`5d844b411df40a224b354328fd2cbb2189a3f78a`：没有代码冲突，仅共享包 exports 自动合并；
其余实现与已验证版本逐文件一致。同步后重新通过依赖检查与 diff 检查，未重复运行全量测试。

## 领域与调用方式

Session 就是现有产品任务。没有新增上层 Task，没有第二份 runtime、队列、模型目录或
插件运行状态。插件 taskId、伙伴 delegationId 继续是各自业务的回执，不是全局 Session ID。

共享契约位于 `packages/maker-shared/src/sessionController.ts`，wire 请求与 MCP 输入共用
`sessionControllerSchema.ts` 的严格 v1 schema。内部调用位于
`apps/desktop/src/main/session-controller/`：

| 层 | 实现与责任 |
| --- | --- |
| 公共准入 | `controller.ts`：typed 方法、宿主 caller、账号代次、真实 operation/target、晚检查；不执行业务状态转换 |
| 原业务组合 | `sessionServiceController.ts`、`management.ts`、`records.ts`、`opening.ts`、`history.ts`、`lifecycle.ts`：组合已有业务方法，保留锁与返回值 |
| 内部宿主端口 | `nativeRuntime.ts`、`hostOperation.ts`：scheduler/hook/IM/Orca/Learn/Goal/Review 的既有生命周期和事务进入同一准入；不改变它们的终态、回执或 cadence |
| 策略 | `callerContext.ts`、`internalCaller.ts`、`boundCaller.ts`、`toolPolicy.ts`、`uiCaller.ts`：策略来自宿主事实，不能从 JSON 构造 caller |
| 本机适配 | `ipcAdapter.ts`：现有 IPC 名称、参数、返回与 UI 行为保留；Main 内部直接调用 typed service，不反调 IPC 或 MCP |
| 跨设备适配 | `router.ts`、`remoteEndpoint.ts`、`remoteTickets.ts`、`attestation.ts`：一份请求契约、目标端执行和再授权；复用 device-link |
| 读取与观察 | `observation.ts`、`capabilities.ts`、`watch.ts`、`subscription.ts`、`signals.ts`：读取原始权威来源，事件触发重新读取，不保存另一套任务状态 |
| 幂等与资源 | `idempotency.ts`、`commands.ts`、`resources.ts`：业务请求回执及资源版本检查，不承担 Session 生命周期 |

新 Main 调用者使用 `sessionRecords`、`SessionService` 或内部宿主端口；提供本入口原有的
授权/取消检查，且在异步准备前捕获。独立宿主生命周期才使用 `inheritOperation:false`
（目前 Learn、Goal、Reviewer）；普通组合端口默认继承父操作的授权及存活期，不能把插件
请求换成一个无约束的内部身份。`ownedView` 只是 send/abort 等少数方法的代理接口，不进入
Maker registry，也没有自己的运行状态。

新模型入口使用 `control_session`，先由 `list_session_devices` 获得明确设备标识。旧工具
名称与 schema 保留，普通 Session 方法已从 `OrcaCollabService` 移出。控制框架能力完整，
不等于每个 caller 获得完整权限：批准交互、放宽权限、清空历史等仍只在原用户/宿主授权入口
开放。UI 的选模 pending intent、导航、窗口和乐观展示仍由 UI 路径负责。

## 目标、执行与结果

- `deviceId + sessionId` 定位记录；创建只有 deviceId，不能预造目标 ID。`remoteHostId`
  是该 Cindy 设备管理的 SSH 执行位置，绝不代替 deviceId。
- `requestId` 只关联一次 RPC；`businessKey` 关联 create/send 的业务重试；插件 revision
  仍归插件。运行模型 generation 是进程内 CAS，不能宣称重启后仍有效。
- 原生执行身份是 `instanceId + generation`。停止和关闭在进入异步授权前捕获，再于原生
  调用前复验。插件取消、伙伴输入归属、宿主精确句柄清理保持各自已有约束。
- accepted、queued、dispatched、completed 分开：受理不等于执行结束。普通 native 方法
  保留实际结果；v1 send/enqueue 使用原 durable coordinator，返回关联 inputId。终态来自
  原事件/快照，不从 RPC 成功推导。
- selectRuntime 保留 baseline/effective/pending、applied/deferred、next_send、fallback、
  窗口保护及 expectedGeneration。权限修改仍走 runtime-first / DB-second 的串行和补偿。
- requestStop 保留安全点/未确认等原结果；abortTurn 保留取消恢复、暂停 Goal、交互清理；
  closeRuntime 保留锁及工作目录生命周期。单个后台任务停止不会退化成 abort 整个 Session。

创建通过已有 `openSession`，记录创建与 ensureRuntime 分开。模型路由先走已有 admission，
创建回执返回实际接受的配置。create/send 的持久请求表只保存 key、意图摘要、生成 ID 和受理
回执。它不是插件 receipt 表或运行状态表；目标记录删除后保留幂等墓碑，防止迟到重试复活
记录。SQL reservation 在副作用之前原子写入：崩溃后已有业务事实可对账；没有足够证据则
返回 `UNKNOWN_OUTCOME`，不再执行。重试内容不同返回 `CONFLICT`。

## 状态、事件与诊断

数据库拥有持久记录；Maker 拥有 live handle/turn；input coordinator 拥有队列；现有交互
模块拥有待处理请求；runtime selection 拥有模型意图；各插件/伙伴拥有其业务回执。观察读取
canonical activity、live instance、queue、interactions 和 selection，保留 recordStatus 与
activity 的区别。listActive 只扫描 live registry，并明确 runtimeLoaded/currentTurnActive；
历史 running 标记不被升级成“当前正在运行”。

诊断只读原 watchdog、当前轮次终态及恢复事实。等待用户、队列暂停、待换模、恢复、睡眠
间隙、宿主无响应、轮次无事件超时与普通终态错误可区分。睡眠判据复用现有 watchdog 的
slice/gap，不另设计时器；诊断不会启动或重建 runtime。
冷任务的队列读取不分配内存状态、不触发持久队列恢复；只有实际在途恢复才显示 recovering。
SSH 执行位置从持久记录读取，冷任务不会被误标为本机执行。

记录、输入受理/派发/撤回、轮次、交互、runtime intent/applied、连接失效和 snapshot resync
均有事件语义。新增输入事件只在原持久/派发/撤回边界发出。现有广播是事实源，signals 只
携带失效通知和 ID，不提前泄露原消息内容。订阅为每个观察者维护读取代次：旧 promise
正常结束，期间有新事件则 fresh read；迟到结果不能覆盖新快照。离线只发 stale/offline
失效信息，不把上次 running 快照显示为当前事实。权限撤销、关闭控制和换账号会关闭订阅、
释放原 topic 引用；重连继续用既有订阅恢复。没有跨重启完整事件日志，也没有新监控进程。

## 多设备与资源

普通已授权任务及伙伴 owner 轮次可用同一 API 明确选择已授权设备。来源 Main 在工具调用
开始、第一次异步等待之前绑定 owner、instance、turn generation；目标 Main 仍独立检查
账号、控制开关、关闭代次及目标可见性。来源给出的 request-scoped 随机 ticket 绑定完整
意图摘要。目标经现有 authenticated push 返回通道发 challenge，来源重新授权并答复；
每个晚执行边界重验。不会反向创建控制连接，不要求来源设备开启“允许被控制”。共享任务
访客不能借这条同账号接口升级权限，受保护的伙伴目标沿用已有隐藏策略。

arranged 跨设备没有现成的远端项目委托记录，因此保持拒绝，不把“设备在线”当授权。当前
SSH 伙伴的窄工具面和工作台 SSH 限制保留。能力按现有 harness 与 SSH 支持投影，不补造
未支持的原生 rewind/compact。相同 API 是统一路由，不是绕过这些限制的承诺。

资源引用包含 owningDeviceId、remoteHostId、kind、locator、version。v1 可直接消费目标
设备本地目录、普通文件和已有 `cindy-media` 附件；先验证整个批次归属，再触碰文件系统。
文件检查真实路径、敏感路径规则、存在性与版本；目录使用设备/ inode 身份，避免合法的
Git 初始化改变目录 mtime 导致误报。首次解析会返回实际版本，后续受理和 durable drain
复验；相同路径但设备、SSH 命名空间或版本不同，不会被当作同一资源。

v1 没有新增 SSH 文件下载或跨设备复制服务：SSH 资源、来源设备文件和失效附件明确返回
`RESOURCE_UNREACHABLE`，调用方需使用已有授权传输/映射取得目标引用。既有 SSH Session
文本控制仍走原业务能力。禁止同名本地路径兜底、自动传文件或自动批准目录。

错误区分 NOT_AUTHORIZED、DEVICE_OFFLINE、DEVICE_UNRESPONSIVE、CONTROL_DISABLED、
HOST_NOT_READY、UNSUPPORTED_CAPABILITY、CONFLICT、ROUTE_UNAVAILABLE、资源不可达及
UNKNOWN_OUTCOME。写入超时保留原 requestId/businessKey，用同一 key 对账；router 不重试
业务写入、不回退本机。device-link 原有发送前 LINK_NOT_OPEN 恢复保留，关闭代次/控制开关
照常复验；业务端结果在成功 transport envelope 内返回，不触发链路重放。

## 逐入口迁移账本

下表位置均为 `apps/desktop/src/main` 相对路径。原生业务实现允许保留在其原模块，调用入口
统一准入；它们不是另外一套可被模型调用的 service。精确符号、调用次数、原因、风险、
责任范围、依赖及删除条件见 `session-controller-ports.json`。

| 入口 | 共同入口与原业务 | 保留的授权、写入和生命周期 |
| --- | --- | --- |
| Desktop / Mobile | `maker-ipc/register` 的 IPC adapter → 同一 management/lifecycle/history；`localDb/ipc/sessions` → records/opening | IPC schema、UI 选模意图、原数据事务与广播、attention/IM/协同限制；窗口不进入核心 |
| 普通工具 | `mcp-integrations/mcp-providers` → SessionService/records；`lizi-mcps` 保留旧工具并新增版本化工具 | 工具开始绑定来源；每次 operation/target 重新授权；自有输入编辑撤回 |
| 本机/SSH 伙伴主任务 | 普通工具 → toolPolicy → 原 botToolCallAuthorizer | owner/arranged/other、外部插话/回报不提权；远程既有窄工具面保留 |
| 伙伴后台任务 | `botDelegationService` 注入 bound caller → SessionService/native runtime | delegation receipt、模型链、归属、运行代次、停止、完成通知与恢复 |
| 伙伴工作台 | workbench 原 access/service → 装配时注入 SessionService | 显式接手、项目归属、工作台自己的文件不变成 Session 状态 |
| 伙伴生命周期/群专线 | `botLifecycleService`、`localDb/ipc/bots`、register 的 group lane → native/host operation | 精确关闭、权限同步补偿、专线队列清理、伙伴身份与群编排仍归原模块 |
| 插件 cindy.tasks | 原 taskSlot/pluginTaskService → bound caller/opening/SessionService | 宿主核验身份、批准、own-task、revision、acceptedConfig、幂等及 run 对账 |
| 插件 agent/errand/workspace | `cindy-brain/agentSlot`、`ghostErrandRunner`、`pluginWorkspaceSessions` → 同一服务 | 老 API/key、取消 ownership、不可变团队计划与动态撤权 |
| scheduler | `scheduler-host/runner` → native runtime；队列能力继续接原 coordinator | cadence、模型跟随、effort/Fast、生效失败恢复、接受后取消及一次完成通知 |
| hook | `hook-control/session-runner`、`ipc` → native runtime/records | 触发来源、取消、归档、原完成生命周期 |
| Orca | bootstrap、预热、dispatcher、Worker 关闭与团队收口 → native/host operation | 团队授权、Worker 归属、锁、输入协调器；团队字段和补偿仍在原业务模块 |
| Learn / Goal / Review | 各 host index → native ownedView；Goal restore → ensureRuntime | 独立生命周期与精确 teardown；已完成 Reviewer 不接受普通继续输入 |
| IM 各渠道 | `sessionRepo`、`turnRunner`、`cardActionHandler`、`permissionModeControl` → native/host operation | 路由 UUID 复活/轮换、绑定、卡片、发送 callbacks、权限确认和失败回滚；Telegram 两套权限不改 |
| 同账号设备链路 | router → 单个 `maker:session-control:v1` → remoteEndpoint → 同一 command/core | 原账号与控制权限、目标端保护、来源轮次重验、topics/快照恢复 |

IM repository 的 host-only `findActiveSession` 自己解析 channel identity → UUID，因此准入前
没有外部提供的 Session target；空 target 不是给 wire 调用者的全库写授权。物理退出清理
可以在账号数据库已关闭后取消其持有的精确 native handle，不查 ID 后取消替换实例，不写
另一账号记录。原事务中的同步 accepted-cancellation 与失败补偿保留原位置和顺序。

## 依赖检查与实现端口

`pnpm check:session-controller` 已加入 CI。AST 检查新静态/动态导入、别名调用和已知原生
Session 变更，登记精确到文件、函数、符号及次数；新增调用、数量变化或已删除但残留的
登记都会失败。普通 renderer transport、AbortController、语音 WebSocket 不是原生 Session。
这是一道代码依赖检查，不是运行期安全沙箱；授权仍由 controller 和原业务执行边界负责。

允许的端口有三类：原业务事务及装配根、精确实例的物理退休/回滚、已有只读宿主查询。
不存在另保留一个普通 Session service 的“临时兼容”分支。新功能不得把所在文件已有登记
当作全文件豁免；迁走/删除原实现时，同批移除对应登记。schedulerRunId/Orca vendor
context 仍归其业务域，不伪装成通用模型配置。

## 已合并行为与开放增量

实施开始时重新核对：插件普通 Session/协同生命周期（5134）、宿主身份与撤权（5136）、
共享 openSession/插件选模（5333）、逐轮伙伴授权（5354）均已合并且在本基线中。
原 receipt/store、身份、授权分类和创建实现保留，公共层不另造这些机制。

下列仍是开放增量，不作为本次已交付功能：

| PR | 对接要求 |
| --- | --- |
| 4389 | helper 操作骨架应对接本公共层，不能合入第二套 Session facade |
| 4390–4394 | 导出/置顶/删除/Fork/分支/新窗口的新增工具适配；现有宿主业务和 UI 能力已接入，新增工具单独对账 |
| 4804 | 本次复用现有逐个停止实现并补齐旧 IPC allowlist，同时支持 v1；该开放 PR 合入时需去重对账 |
| 4496、5044 | Pi 跨来源退役、thinking/effort 拟议行为不冒充已统一；保持实际当前业务结果 |
| 5275 | Codex 跟进 queue/steer 来源设置单独合并，不能抹平自动来源/Orca 策略 |
| 5205 | Worker focus 预热/取消的进一步行为与现有预热端口对接 |
| 5166 | 插件安装实例身份继续由插件 policy 供应，公共层不认 manifest 名称自报身份 |
| 4366 | 实际 head `b8fe0424e4af05e2c232f4057eacaaf5a0559342` 的四文件 diff 做了隔离回归，仍 OPEN，未混入本实现 |

本次没有 cherry-pick 这些 PR。合并前仍须更新当前 main、migration 编号与开放 PR 冲突；本地
实施期间其他会话的新增提交不能视作本次已经集成。

## R / E / T 验收对应

| 要求 | 实现/保留位置 | 验证性质与边界 |
| --- | --- | --- |
| R01 / R03 / E03 / T02 / T13 | 上述入口账本、唯一 controller、精确端口登记、CI AST 检查 | 原入口定向回归、准入与依赖检查；不是仅搜索一个类名 |
| R02 / R05 / R09 | 现有 Session、typed Main ports、薄 IPC/MCP/device-link | 编译诊断及代码审查；没有新增 Task 或云控制服务 |
| R04 | 已合并行为与开放增量表 | 插件、伙伴授权、队列、模型和内部宿主回归；开放 PR 不冒充 main |
| R06 / T05 / T11 | 完整管理/队列/历史、三种停止、逐后台任务、live 读取 | lifecycle、control、queue、history、rewind、后台任务用例 |
| R07 / R08 / T07 / T08 | router + source attestation + target policy + SSH 归属 | 进程内双端集成与旧错误映射；没有真实双设备弱网实测 |
| R10 | 交接的公开 Codex App Server、Claude SDK、Pi RPC 分层依据 | 借鉴 typed 控制及不同 transport 共享语义；不声称了解闭源 Claude CLI 内部 |
| R11 / E01 / T01 / T03 / T04 / T06 | durable ledger、input ID、精确执行身份、原 runtime CAS/插件 revision | 真 SQLite 文件重开；mock runtime、原队列/模型/插件/伙伴回归 |
| E02 / T10 | devices/SSH 引用、真实路径/版本、受理与 drain 重验 | 双设备同路径拒绝、版本冲突、不可达/权限错误；不执行自动传输 |
| T09 | topic refcount、owner fence、每订阅者 fresh read | 旧 promise 正常返回、乱序/失效/撤权关闭/离线新鲜度测试 |
| T12 | 原 watchdog/终态/恢复 getter + diagnosis | 等待/暂停/睡眠间隙/停滞/恢复的只读投影；原 watchdog fake-clock 回归 |
| E04 / T14 | 4366 实际四文件补丁的隔离副本 | Mobile 两个测试文件 77 项通过：双 Provider、多设备、history 在途、fresh read、旧 promise 正常返回，无额外 stop/restart/connect；是 mock，不是真机 |
| R12 / R13 / T15 | 本文及端口登记 | 可追溯交接；没有部署会话监控或自动接管 |

本地执行过的定向验证分批记录，重叠用例不累计成一个总数：

- controller、资源、SQLite、订阅/信号、远程集成和 watchdog 批次：15 文件 106 项通过；此前加 IM 权限和任务移动的批次 102 项通过。
- 最后修订的观察、订阅、生命周期、路由及 helper：5 文件 58 项通过；冷队列观察的单项定向回归通过（同文件其余 428 项未重跑）。
- helper MCP（含异步前绑定来源）：30 项通过；IM 卡片接管/群专线/多选：36/4/7 项通过。
- runtime harness 选择及 scheduler 模型/排队：3 文件 174 项通过。
- 原 control、runtime、伙伴轮次授权、Orca Worker 控制及 watchdog：5 文件 139 项通过。
- 此前内部宿主批次：Goal restore/controller、Learn controller、native runtime 共 254 项；
  IM turnRunner 136 项及 repository、伙伴生命周期定向回归通过。
- migration 验证通过六阶段、124 项迁移；重放测试 11 项通过。新增 migration 使用 Drizzle
  生成的 SQL/snapshot/journal，未改历史 migration，未操作正式数据库。
- 依赖门禁通过：104 个精确实现端口，无未登记调用；门禁自身 3 项回归通过。
- TypeScript 定向诊断覆盖 87 个修改源码文件、50 个修改测试文件，均无诊断；diff 检查通过。这不是整包 typecheck，完整 CI 门禁保留。

没有启动 Desktop/DEV/模拟器，没有使用真实账户执行 Codex、Claude Code 或 Pi 请求，
没有真实多设备、弱网、宿主进程杀死/重启的运行验收。SQLite 连接重开是磁盘持久性测试，
不能代替整个应用重启。测试中的宿主/transport 隔离 mock 不能当作正式设备验证。

## 后续控制器与待定产品项

| 领域 | 职责、依赖、优先级与入口 |
| --- | --- |
| Capability / ModelCatalog（P1 规划） | 继续复用现有模型目录及 device-link capabilities；未来统一查询入口，不复制跨设备凭证 |
| PluginLifecycle（后续） | GhostManager 安装/批准/运行与 PluginRegistry 启用分别保留；未来 typed 入口仍委托原事务，不收编 Session 执行 |
| Settings（后续） | 按领域配置及已有 owner-stamped/原子更新入口；不提供任意 key 写入或自动扩大权限 |
| CompanionPolicy / Coordination（保留现有） | delegation、工作台、群编排和通知仍由原服务负责，操作 Session 时用本控制层 |

Q01 arranged 跨设备维持现有授权边界；Q02 超时返回结果未知并沿同一业务 key 对账；
Q03 共享契约使用现有 maker-shared；Q04 复用文件/附件定位，无法读取则明确拒绝；
Q05 真机矩阵缺口如上列明；Q06 本次覆盖 Session 全入口，其他控制器仅规划。
