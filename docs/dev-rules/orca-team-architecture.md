# Orca 协同架构与执行单元规划

> 这是 Orca 的唯一权威文档，覆盖当前实现、设计约束与未来规划。
>
> **状态**：权威（authoritative）。
> **约束力**：本文「协同运行时行为契约」「坑点与不变量」两节是 Orca 协同代码的约束源，治理范围包括 `apps/desktop` 的 `maker-ipc/orca*` 服务与 `mcp-integrations` codex MCP 集成、`packages/lizi-mcps` 的 `orca` server 与 worker 控制工具、`packages/orca-workflow`、`packages/maker-core` 的 codex MCP context。改这些模块前先读本文；本文与代码实现冲突时以代码为准（遵循「以源码实现为准」原则），但必须同步修正本文。

## 目录

- [Part 1 · 当前架构](#part-1--当前架构)
  - [目标与边界](#目标与边界)
  - [核心概念与数据模型](#核心概念与数据模型)
  - [PR #101 后的服务边界](#pr-101-后的服务边界)
  - [MCP 与 IPC 控制面](#mcp-与-ipc-控制面)
  - [Codex Lead 机制](#codex-lead-机制)
  - [UI、Split View 与 Worktree](#uisplit-view-与-worktree)
  - [协同运行时行为契约](#协同运行时行为契约)
  - [测试与回归清单](#测试与回归清单)
  - [坑点与不变量](#坑点与不变量)
- [Part 2 · 未来规划](#part-2--未来规划)
  - [执行单元愿景](#执行单元愿景)
  - [三态拆分](#三态拆分)
  - [Worker 生命周期分型](#worker-生命周期分型)
  - [顶层类型与 Runner 分层](#顶层类型与-runner-分层)
  - [Side Chat](#side-chat)
  - [关系契约](#关系契约)
  - [控制面九大机制](#控制面九大机制)
  - [分阶段路线](#分阶段路线)
  - [待讨论项](#待讨论项)

## Part 1 · 当前架构

### 目标与边界

Orca 是 Cindy Desktop 内的多 agent 协同能力：一个 **Lead session** 负责拆任务、派活、验收与汇总，多个 **Worker session** 负责并行或串行执行。Worker 是完整会话，不是一次性 subagent；它有自己的模型、effort、工具调用流、上下文与可见历史。

当前已经实现的能力：

- 多 worker：同一个 active team 下可创建多个 worker，支持 role、label、focused worker 切换、soft/hard limit 与归档。
- Split view：Lead 与 focused Worker 共用 `OrcaSplitView` pane 外壳，宽屏为左右 split，doc rail 为 Lead/Worker toggle。见 `apps/desktop/src/renderer/features/cc-agent/OrcaSplitView.tsx` 的 `OrcaSplitView`、`OrcaPaneShell`。
- Claude Code 与 Codex 的普通 Lead 无论是项目还是对话都可开启协同；SSH 远端会话两端均可作 Lead（远端 agent 经 SSH remote-forward 直连本机 HTTP MCP bridge，`cindy_orca` 在两端都可用：codex 走 daemon config 注入，cc 走 per-query http 注入）；device-link 被控端的项目与对话同样可作 Lead（Lead / Worker / team 的真身都在被控端，控制端只是镜像）。renderer 的入口判定收敛在 `apps/desktop/src/renderer/features/cc-agent/collabEntryPolicy.ts` 的 `resolveCollabEntryPolicy`，新建草稿（`NewMakerDraftRoute`）与会话视图（`CCAgentSessionView` 的 `allowCollabToggle`）共用同一份：普通 Lead 都显示入口，只排除不能嵌套协同的 Orca Worker 子会话。项目按项目级策略查询；Main 的 `resolveLocalCollabPolicyWorkingDir` 同时服务入口状态查询与最终授权，只有 workspace kind 为 dialogue 且 Main 确认目录位于 app 托管 dialogue root 时才只查用户级/全局级策略（即使 cwd 内出现 `.cindy/plugins.json`），显式绑定真实目录的对话仍按该目录的项目级策略查询，不能靠自报 `workspaceKind` 绕过项目禁用。
- Codex Lead 使用全局注册的 `cindy_orca`，调用时通过 context 恢复身份并在 handler 内拒绝越权。远端 Codex 同样走 `params._meta.threadId` 路由——remote thread 与本地 thread 一样注册进 `CodexMcpThreadContextStore`（`packages/maker-core/src/agents/codex/index.ts` 的 `registerCodexMcpContext` 不再跳过 remoteHostId）。远端 cc 没有 threadId，身份走持久 bearer token + URL `?session=<id>` 路由（`codexHttpBridge.registerSessionCtx`），审批归属快照在 `remoteCcQueryFactory` 注入后按 `startParams.mcpServers` 最终清单定稿。
- SSH 远端 Codex 的 MCP 桥接：本机 `codexHttpBridge` 在原有 per-run 主 token 之外接受一个 persistent bearer token（safeStorage）；`remote-ssh/codex-remote-mcp.ts` 在 session start/resume 前置完成 per-host 固定端口 remote-forward（`RemoteHost.openRemoteForward`，重连自动 rebind）、远端 `$CODEX_HOME/config.toml` 的 `mcp_servers` 管理段漂移检测（行级 marker + 剥离用户同名 table）与 daemon 幂等 bootstrap（token 只经 stdin 的 KEY=value 块注入，不进 argv）；config 漂移需要重启 daemon 时若同 host 有 live turn 则本次降级（留待下次 ensure）。worker 创建经 `OrcaLeadSessionSnapshot.remoteHostId` 继承在同一台远端主机 spawn，创建前走 `ensureRemoteReadyForSessionStart`（SSH 重连 / agent 安装 / MCP 注入）；lazy resume 与 Orca worker 唤醒路径同样先 ensure 再 bootstrap。
- PR #107 提供 side_chat 的底层 fork 数据动作：user/assistant 消息都能 fork，assistant 按 turn 粒度复制，Claude 用 uuid 锚点，Codex 用 ThreadFork + ThreadRollback。当前作为普通 session 跳转；未来要登记为 side activity 并挂入统一 pane。

当前边界：

- Orca Team 仍严格绑定单个 Lead session，不支持跨 Lead 共享 worker。
- Worker focused 切换是“单 worker pane 替换”，不是多 worker 并排。
- Worker archive 后 UI 内没有 unarchive 入口；DB 记录保留，用户需要新建 worker 继续。
- workflow_run / CC Workflow 编排还未纳入当前实现。
- side_chat 尚未登记为 side activity 对象，也未挂进 pane；PR #107 只是 fork 数据动作。
- device-link 协同的 Lead / Worker / team 全部在被控端进程内编排，控制端只按 session 来源经隧道路由（`makerTransport` 的 `makerApiFor` / `orcaWorkflowsFor` / `subscribeOrcaWorkerChanged`，channel 见 `packages/device-link/src/allowlist.ts` 的 Orca 段）。collab 开关同样查被控端（`maker:plugins:get-state` 经 `pluginEnableStateFor`）：项目读取被控端项目级策略，对话读取被控端用户级/全局级策略。控制端本机状态不能代表被控端真相。老被控端没有该 channel 时回 `CHANNEL_NOT_ALLOWED`，控制端 fail-closed 置灰入口并提示设备版本过旧，而不是放行到 `enableOrca` 才撞错。
- SSH 远端协同支持 codex 与 claude-code 两类 lead + 远端 worker（继承 remoteHostId）。cc 远端经 `cc-remote-mcp.ts` 把 `cindy_orca` / `orca_worker_bridge` 以 http 形态追加进 `startParams.mcpServers`（persistent token + `?session=` 路由，白名单仅此两个 server）。远端 worker 手动 `send_to_lead` 依赖 daemon 侧 `orca_worker_bridge` 经同一 bridge 可达；auto-bridge 回报不依赖 worker 侧 MCP，天然可用。共享 userData 多实例连同一远端 host 时，只有先建立 SSH 转发的实例能持有该 host 的 MCP bridge 端口，其余实例按“远端无 MCP”降级（与历史行为一致）。远端会话的项目级 collab 开关不查本机 fs；`assertCollabProjectEnabled` 对 remote 只查用户级/全局级开关，远端项目级配置机制是 follow-up。

### 核心概念与数据模型

| 概念 | 当前含义 | 载体 |
|---|---|---|
| Lead session | 主线会话，负责开 team、创建 worker、派活与验收 | `sessions.orca_role = 'lead'` |
| Worker session | 被 Lead 派出的完整 side session，有独立 agent/model/context | `sessions.orca_role = 'worker'` + `orca_workers.session_id` |
| Team | 一个 Lead 当前 active 的协同上下文 | `orca_teams` |
| Worker record | worker 在 team 内的 role、label、status、focused 等元数据 | `orca_workers` |
| Fork relation | 普通 session fork 来源关系，为 side_chat 底座 | `sessions.parent_session_id` + `forked_at_message_id` |

`orcaRole` 和 fork parent 是两个字段，不能混用。schema 明确写着 `orca_role` 用于 Orca split-session role，`parent_session_id` 保留给 fork/session-branch，见 `apps/desktop/src/main/localDb/schema.ts` 的 `sessions` schema。fork 关系不能承载 Orca 派单语义，这是后续把 side_chat 纳入 side activity 的数据前提。

`orca_teams` 保证同一个 Lead 同时最多一个 active team：唯一约束 `uniq_active_team_per_lead` 只约束 `status = 'active'`。约束：active 唯一性必须用 partial unique，不能用全表 unique，否则非 active team 占住索引会让同一个 Lead 无法重新开启协同。

`orca_workers` 保存 team 内 worker：`team_id`、`session_id`、`status(idle/running/done/error)`、`label`、`role`、`focused`、`idle_since`。同一个 team 只能有一个 focused worker，靠 partial unique `uniq_orca_workers_focused_per_team` 保证，见 `apps/desktop/src/main/localDb/schema.ts` 的 `orcaWorkers` schema。

fork/session-branch 的最小 provenance 当前只有两列：

- `parent_session_id`：源 session self-FK，源删掉时 set null。
- `forked_at_message_id`：来源 message 的 client id，无 FK。PR #107 后 assistant fork 也会写 assistant client id；schema 注释需要按实际语义同步，见 `apps/desktop/src/main/localDb/schema.ts` 的 `sessions.forkedAtMessageId`。

### PR #101 后的服务边界

PR #101 之后，Orca 的 main 侧业务由独立 service 承接，`register.ts` 只负责依赖装配、IPC/MCP wiring 和 host adapter。服务边界如下：

| 服务 | 文件 | 责任 |
|---|---|---|
| `OrcaLifecycleService` | `apps/desktop/src/main/maker-ipc/orcaLifecycleService.ts` | `start_team`、开启协同 `enableTeam`、创建 team、设置 Lead `orcaRole`、首个 worker 创建补偿 |
| `OrcaWorkerCreationService` | `apps/desktop/src/main/maker-ipc/orcaWorkerCreationService.ts` | 既有 team 下创建 worker，统一 role/label/model/effort/fast 校验与默认值；新 Worker 的 `permissionMode` 固定为 `auto`，不继承 Lead 当前模式；创建 worker session 并写 `orca_workers` |
| `OrcaTeamService` | `apps/desktop/src/main/maker-ipc/orcaTeamService.ts` | 给既有 worker 派活、resume、idle、archive、terminal turn 处理与 auto-bridge |
| `OrcaInterAgentDispatcher` | `apps/desktop/src/main/maker-ipc/orcaInterAgentDispatcher.ts` | Lead/Worker 之间的消息直发或排队、accepted callback、rollback/settle 语义 |

契约：team lifecycle、worker creation、worker lifecycle/auto-bridge、inter-agent dispatch 四类职责不能互相偷跑；所有入口都必须复用这组 service，不能在 IPC 或 MCP handler 内各自实现一套状态机。关键实现入口是 `OrcaLifecycleService.startTeam/enableTeam`、`OrcaWorkerCreationService.createWorkerInTeam`、`OrcaTeamService.dispatchWorkerTask/handleWorkerTerminalTurn`、`OrcaInterAgentDispatcher.dispatchOrEnqueueOrcaInterAgentMessage`。

### MCP 与 IPC 控制面

`cindy_orca` 是独立 MCP server，直接顶层注册 16 个工具：13 个 team 控制工具 + 3 个只读诊断工具（后者从已下线的 `orca_bridge` 桥入，保裸名）。它与 renderer IPC 共用同一组 main 侧 service，因此 MCP 和 UI 操作必须有一致的权限、状态和回滚语义。

1. `start_team`
2. `end_team`
3. `create_worker`
4. `create_workers`（批量创建；顺序执行、hard limit 后停止并返回逐项汇总）
5. `list_workers`
6. `switch_focus`
7. `send_to_worker`
8. `list_worker_queue`（排队消息控制）
9. `update_queued_message`（排队消息控制）
10. `cancel_queued_message`（排队消息控制）
11. `idle_worker`
12. `archive_worker`
13. `list_available_models`
14. `get_workspace_info`（只读诊断）
15. `worker_status`（只读诊断）
16. `read_worker`（只读诊断）

批量创建必须走一次 `create_workers` 调用，不能让 Lead 并行或连续发多个独立 `create_worker`。批量工具按输入顺序复用同一个 `OrcaLifecycleService.createWorker` 原语；首次收到 `WORKER_LIMIT_HARD_EXCEEDED` 或批次级 `HOST_NOT_READY` 后不再调用 host，剩余项稳定标为 `skipped`。返回值必须包含请求数、实际尝试数、成功数、失败数、跳过数、总未创建数、数量闸快照、代码确定生成的 `user_report`，以及逐项真实 worker/session 或失败终态，供 Lead 如实向用户收口；`success_count + failure_count + skipped_count` 必须等于 `request_count`，其中 `not_created_count = failure_count + skipped_count`。单个 `create_worker` 继续作为兼容入口，并返回相同的结构化 hard-limit 快照。

排队消息控制 3 工具让 Lead 在消息被 worker 消费前管理自己发出的排队消息：`send_to_worker` / `create_worker`（initial_task）在 `wakeKind='queued'` 时回传 `queued_message_id`（coordinator 队列内的 clientId），Lead 可据此列出、整条改写或撤回。实现走 `OrcaTeamService.listWorkerQueuedMessages / updateWorkerQueuedMessage / cancelWorkerQueuedMessage`，语义约束见「协同运行时行为契约 · 消息派发与 auto-bridge」第 6 条。

诊断 3 工具是纯只读，实现走 host `apps/desktop/src/main/maker-ipc/orcaDiagnostics.ts`（读 active team + DB worker 列表 + live session 状态 + 最近 assistant 消息），**无建 team 写副作用**——这是与旧 `orca_bridge` 版本的关键差异（旧版经 `ensureWorkflowForLead` 会顺手建 team）。早期 Lead 侧 `orca_bridge`（门面 + 私有 registry/restore/auto-bridge）已整体删除：Lead→worker/team 工具面唯 `cindy_orca`（C）一套，worker→lead 唯 `orca_worker_bridge`（B，在 `packages/orca-workflow`）一套；`@cindy/orca-workflow` 包通过 B provider 与 `renderOrcaLeadSystemPrompt`/`renderOrcaWorkerSystemPrompt` 两个 render 函数继续被 host 依赖。

`cindy_orca` 直接注册到顶层，而不是藏在 `list_tools/call_tool` 后面；模型在“开协同 / 派 worker”时需要稳定发现 `start_team/create_worker`。实现见 `packages/lizi-mcps/src/orca/server.ts` 的 `createOrcaMcpServer`、`DirectToolSink`、`OrcaMcpDeps`。

工具注册是全局可见 + handler 拒绝：

- 工具可见性不是权限边界：`providers.ts` 的 `cindy_orca` provider 没有 per-role `isEnabled` gate，普通 session / worker / lead 的差异必须由 handler 和 host service 拒绝。
- Codex 场景的真实 session 身份来自 MCP request context；`session-context.ts` 用 `AsyncLocalStorage` 提供 `withLiziMcpSessionContext` / `resolveLiziMcpSessionContext`，不能依赖全局 fallback 猜身份。
- renderer 开启协同走 `CCAgentSessionView.tsx` 的 `requestEnableCollab`，MCP 工具通过 `cindy_orca` callback 进入同一组 service。

### Codex Lead 机制

Codex app-server 是单例进程，多 thread 共用同一批 MCP server。Codex Lead 的设计边界是：工具全局注册，身份在调用时通过 thread context 恢复，并由 handler / host service 拒绝越权；它不是 per-thread MCP 工具隔离。

关键约束：`mcp-session-id` 只标识 MCP transport，不证明 maker session 归属，因此**不作为路由依据**。Codex HTTP bridge 在已初始化的 MCP POST message 里读取 `params._meta.threadId`，用它查 maker-core 注册的 Codex thread context；缺失、未知、batch 内不一致或不完整时，bridge 宁可不给 context（让工具调用安全降级为 NO_SESSION_CONTEXT），也不猜一个错误 context 造成跨会话串线。实现见 `apps/desktop/src/main/mcp-integrations/codexHttpBridge.ts` 的 MCP bridge request handling，以及 `apps/desktop/src/main/mcp-integrations/codexMcpThreadContextStore.ts` 的 `registerThreadContext`、`unregisterThreadContext`、`getContextForThreadId`。

Codex prompt / developerInstructions 有双通道：

- API key 模式：走 local proxy registry，把拼好的 instructions 按 thread 注册，再由 proxy 注入顶层 instructions。实现见 `packages/maker-core/src/agents/codex/index.ts` 的 `registerCodexDeveloperInstructions`、`apps/desktop/src/main/maker-host/index.ts` 的 Codex agent deps、`apps/desktop/src/main/maker-host/codex-proxy-host.ts` 的 `registerComposed`。
- OAuth / 非 proxy 模式：直接把 developerInstructions 放进 `thread/start`；resume 时按会话的产品 prompt 状态决定是否补发。实现见 `packages/maker-core/src/agents/codex/index.ts` 的 `ThreadStart/ThreadResume` 参数组装。

因此 Codex Lead 不依赖 proxy 才能注入提示词；proxy 只是 API key 模式下更稳定的投递通道。

#### ADR：Codex per-role 工具隔离不走 proxy 改写 tools

决策：不在 proxy 层改写 Responses `tools` 字段来让 Codex lead/worker/main 每个 thread 看到不同工具。

理由：

- Codex app-server 不支持单进程内 per-thread MCP 配置；MCP server 配置是 app-server spawn/config 层全局注入，thread/start 参数没有 per-thread MCP override。
- 另一个等价方案是按 profile 拆多个 app-server 实例，但会引入启动耗时、常驻内存、resume profile 匹配、shutdown 管理和 prompt cache 评估成本。
- Claude Code 侧的 `cindy_orca` 本身也是全局可见 + handler 拒绝。Codex 对齐这一语义即可，不为更强的曝光隔离付出多进程复杂度。
- 未来只有当 Codex app-server 原生支持 per-thread MCP 配置时，再重新评估。

### UI、协同 Tab 与 Worktree

普通聊天路由不再渲染独立 Worker pane，也不会在 Lead 变成 Orca Lead 后自动跳到 `/cc-agent/orca/<sessionId>`。当前主形态是普通 Lead route `/cc-agent/<leadSessionId>` + 右侧栏「协同」tab：Lead 仍由 `CCAgentSessionView` 渲染，Worker 列表与 focused Worker 会话流由 `apps/desktop/src/renderer/features/right-sidebar/plugins/orca-workers` 挂载。协同 tab 是 singleton，协同进行中常驻；点击 tab 的 X 等价于“结束协同”，会先弹确认，确认后 end team 并关闭 tab。

路由层：`/cc-agent/orca/:sessionId` 只保留为旧 deep link 的兼容 shim。它会转到普通 Lead route；若该 session 仍是 active Orca Lead，则打开/聚焦右侧栏「协同」tab，并把 `?worker=<workerSessionId>` 翻译为协同 tab state，随后清掉 URL query。Worker deep link 解析为 `/cc-agent/<leadSessionId>?worker=<workerSessionId>`，由 `CCAgentSessionView` 在普通 Lead route 中把 worker hint 翻译进协同 tab state 后清 query。实现见 `apps/desktop/src/renderer/lib/orcaSessionIdentity.ts` 的 `resolveSessionRoute`、`apps/desktop/src/renderer/features/cc-agent/OrcaWorkflowRoute.tsx`、`apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx`。

doc rail 不走右侧栏 tab，也不做 route navigate。WorkdirBrowseRoute 的窄聊天栏在 active session 是 Orca Lead 时复用 `apps/desktop/src/renderer/features/cc-agent/OrcaSplitView.tsx`；该组件现在仅服务 `/cc-agent/files/:sessionId` 文档模式，以 Lead / Worker toggle 同一时刻展示一个 pane。

Worker 不出现在普通 sidebar。renderer 用 `isOrcaWorkerSession(session) => session.orcaRole === 'worker'` 识别 worker，sidebar filter 直接排除 worker，见 `apps/desktop/src/renderer/lib/orcaSessionIdentity.ts` 的 `isOrcaWorkerSession` 与 `apps/desktop/src/renderer/features/cc-agent/CCAgentSidebarUpper.tsx` 的 `sidebarSessions` filter。worker deep link 会解析到所属 Lead 的普通 route，并通过 `?worker=` 一次性聚焦右侧栏协同 tab，见 `apps/desktop/src/renderer/lib/orcaSessionIdentity.ts` 的 `resolveSessionRoute`。

Worktree 现状：Orca 与普通 session 对齐，worktree 是可选项，不强制；toggle off 时 Lead/Worker 使用用户选的 workingDir，toggle on 时 Lead/Worker 共用同一个 worktree。

### 协同运行时行为契约

本节记录当前系统必须持续满足的运行时不变量。它们不是远期规划，而是 Lead / Worker 协同时已经依赖的行为契约。

#### Lead 派单与执行通道

1. **Orca Worker 派单不得由原生 subagent 冒充（状态：不变量）**<br>
   用户把任务指派给已有 Worker 的 role／label、要求 Lead 向 Worker 派单，或在 active team
   内按多个角色并行派单时，Lead 必须先读 workspace，再按场景通过
   `send_to_worker`（复用既有 Worker）／`create_worker`（显式新建一个 Worker）／`create_workers`（显式新建多个 Worker）进入 Orca 状态机；如果请求的 role／label 当前没有匹配的既有 Worker，Lead 必须先如实说明没有匹配项并征求是否创建，不能静默改派别的 Worker，也不能退回 native subagent。
   如果用户只泛称“Worker”且当前没有任何 Worker，Lead 同样必须先说明并询问是否创建；
   任务指派本身不等于创建授权。多角色请求必须在派发任何任务前解析全部 role／label；
   只要有目标缺失或创建授权未决，就不得部分派发，必须集中列出缺失项并先询问。全部映射
   和授权确定后，多角色请求必须在一个并行 tool-call batch 内一次发出：既有目标走
   `send_to_worker`，恰好一个授权新目标走带 `initial_task` 的 `create_worker`，两个及以上
   授权新目标走一次带齐 `initial_task` 的 `create_workers`；不能等待某个派发结果后才发
   剩余任务。Codex
   `spawn_agent` 或 Claude Code Agent/Task 的完成结果不能当成 Orca
   Worker 的完成。只有用户明确要求一次性 subagent／子代理且没有把任务指派给 Orca
   Worker，或明确要求不使用 Orca Worker 时，才走原生 subagent。

2. **实际执行通道必须披露并按同一通道验收（状态：不变量）**<br>
   Lead 汇总前必须按执行该任务的同一通道确认真实终态，并逐项标明
   `Orca Worker` 或 `native subagent`。原生 subagent 由 Codex
   `collabAgentToolCall`／Claude Agent/Task 任务卡展示标识、任务和终态，但不得写入 Orca
   Worker 状态，也不得触发 Orca Worker 完成提醒。实现指针：
   `packages/orca-workflow/src/orca-bridge-prompt.ts` 的
   `renderOrcaLeadSystemPrompt`，以及 `packages/maker-core/src/agents/codex/translator.ts`
   的 `handleCollabAgentToolCall`。

3. **只有真实异步派发才静默结束 turn（状态：不变量）**<br>
   `send_to_worker` 只有返回 `ok=true` 且 `wake_kind` 为 `resumed`／`already-active`／
   `queued` 时才算真实派发。`create_worker` 及 `create_workers` 的每个 created 结果，
   只有 `dispatched=true`、存在 `queued_message_id`，或
   `dispatch_outcome.kind=session-dispatch` 且 `dispatch_outcome.dispatched=true`
   （包括 `dispatch_outcome.wakeKind=queued`）时才算真实派发。Lead 只能据这些具体信号
   零输出结束当前 turn；工具失败、只创建 Worker 而没有首任务，或首任务未派发时，必须
   立即向用户报告真实结果，不能等待一个不会到来的 Worker 回报。`create_workers` 每次
   返回都必须先转告 `user_report`（若存在）并汇总逐项终态。多角色 batch 返回后还必须
   汇总其他工具的失败／未派发结果；若至少一个结果满足上述派发信号，只做这一次合并报告
   后立即结束 turn，全部成功且无 `create_workers` 必报内容时零输出结束。若没有任何任务
   派发，则报告结果后等待用户决定。所有情况都不得继续调用工具，也不 sleep、不 poll。
   实现指针：
   `packages/orca-workflow/src/orca-bridge-prompt.ts` 的
   `renderOrcaLeadSystemPrompt`，以及 `packages/lizi-mcps/src/xdt-helper/create_workers.ts`
   的批量结果契约。

#### 消息派发与 auto-bridge

1. **忙碌目标不丢消息（状态：不变量）**<br>
   Lead/Worker 互发消息时，如果目标 session 正在跑 turn、存在 queue lock，或刚好在派发竞态里返回 `SESSION_RUNNING`，消息必须进入输入队列，而不是丢弃或直接失败。实现指针：`orcaInterAgentDispatcher.ts` 的 `dispatchOrEnqueueOrcaInterAgentMessage`，以及 `register.ts` 的 `AgentInputCoordinator` wiring。

2. **accepted 才能产生运行副作用（状态：不变量）**<br>
   只有底层 send accepted 后，才能把 worker 标成 `running`、建立 auto-bridge pending 并广播 UI；dispatch 失败必须 rollback 到 accepted 前状态，且 rollback 不得覆盖已有终态。实现指针：`orcaTeamService.ts` 的 `dispatchWorkerTask` 与 `rollbackAcceptedDispatchState`。

3. **queued accepted 也要同样结算（状态：不变量）**<br>
   如果 inter-agent 消息进入队列，accepted callback 必须与直发路径保持同样的 settle / rollback / discard 语义，避免 auto-bridge pending 泄漏。实现指针：`orcaInterAgentDispatcher.ts` 的 queued accepted callback API，以及 `register.ts` 的 `AgentInputCoordinator` callbacks。

4. **worker 主动回报会结清自动回报态（状态：不变量）**<br>
   worker 主动 `send_to_lead` 一旦入队或 accepted，就必须清掉该 worker 的 auto-bridge pending，防止 Lead 同时收到手动回报和 auto-bridge 双份结果。实现指针：`orca-bridge-mcp.ts` 的 `send_to_lead` tool handler，以及 `orcaTeamService.ts` 的 `clearAutoBridgeState` / `clearRuntimeState`。

5. **手动中断不 auto-bridge（状态：不变量）**<br>
   用户手动 stop / abort worker 后，terminal turn 不应把最后消息 auto-bridge 给 Lead。实现指针：`register.ts` 的 stop / abort IPC handlers，以及 `orcaTeamService.ts` 的 `handleWorkerTerminalTurn`。

6. **Lead 只能管理自己的排队消息，撤回必须结清 accepted 暂存（状态：不变量）**<br>
   `list_worker_queue` / `update_queued_message` / `cancel_queued_message` 经 `resolveWorkerRef` 按 caller Lead 归属校验后，只允许操作目标 worker 队列中 `origin.kind='orca'` 的条目（worker 队列中的 orca 条目只可能来自其 Lead）；队列可见性口径是「看得全、只能动自己的」（2026-07-21 产品决策）——用户手打与 scheduler 排队条目对 Lead 正文可见（供基于完整队列内容编排），但不可改不可撤（`NOT_LEAD_MESSAGE`）。修改是整条正文替换，必须经 `rebuildQueuedOrcaLeadMessage` 按原派发格式重建 `text` / `persistedContent` / `chatMessage.content` / `origin.displayText`，身份字段（clientId / createOpts / createdAt / senderLabel）锚定原条目；不许直接调 coordinator 的 `updateText`（会破坏 orca 派发格式耦合）。撤回必须走 coordinator `remove`（触发 `onDiscardedQueuedMessage` → dispatcher 丢弃该 clientId 的 accepted 暂存回调，与 Stop 清队列同一条 settle 路径），否则 accepted 回调表泄漏。steering 中的条目一律拒绝（`MESSAGE_CONSUMING`）。实现指针：`orcaTeamService.ts` 的 `resolveLeadQueuedMessage` 与三个队列控制方法、`orcaInterAgentDispatcher.ts` 的 `rebuildQueuedOrcaLeadMessage`、`agent-input-coordinator.ts` 的 `replaceQueuedMessage`。

#### Worker 运行态

1. **worker 终态不被失败回滚覆盖（状态：不变量）**<br>
   派活 accepted 后如果后续失败，rollback 只允许把仍处于 `running` 的 worker 恢复到旧状态；已经进入 `done/error/idle` 的 worker 不得被回滚覆盖。实现指针：`orcaTeamService.ts` 的 `rollbackAcceptedDispatchState` 与 `handleWorkerTerminalTurn`。

2. **done 确认与派活必须互斥（状态：不变量）**<br>
   `done` worker 的隐式 `idle_worker(expectedStatus='done')` 确认不得与同一 worker 的派活交错：派活从 pre-resume reservation 起至 host dispatch settle 期间持有 active dispatch 计数，done 确认必须在每 worker transition 队列中串行执行，并在计数非零时拒绝。确认还必须在 DB CAS 前后检查 live turn、`send_to_session` 锁与 pending 输入；close 必须使用 `Session.closeIfIdle` 原子地与 send reservation 互斥。任一检查失败或 close 失败时，若已 CAS 为 `idle`，必须只恢复仍为 `idle` 的记录到 `done`，不得覆盖新终态。实现指针：`orcaTeamService.ts` 的 `withWorkerTransition`、`activeWorkerDispatches`、`dispatchWorkerTask`、`idleWorker`。

3. **idle worker 恢复必须保留 extraDirs（状态：不变量）**<br>
   idle worker 被 `switch_focus` 或 `send_to_worker` 唤醒时，要从 DB 读取 `extra_dirs` 并带回 `bootstrapSession`，否则恢复后的 worker 会丢附加目录上下文。实现指针：`register.ts` 的 idle worker resume helper。

4. **worker 状态变更必须广播给 renderer（状态：不变量）**
   创建 worker、`enableOrca` 创建首个 worker、任意真实 worker turn 开始后的 running、idle、archive、terminal done/error 都必须广播 `ORCA_WORKER_CHANGED`。worker DB `status` 跟随真实 turn 生命周期：Lead 派活或用户直接对话 worker 时，只有真实 turn 开始才置 `running`，terminal 才置 `done/error`；`switch_focus` / resume / restore 只能恢复可访问性，不能凭空置 `running`。实现指针：`orcaLifecycleService.ts` 的 `createWorker` / `enableTeam`、`orcaWorkerCreationService.ts` 的 `createWorkerInTeam`、`orcaTeamService.ts` 的 `dispatchWorkerTask` / `handleWorkerTurnStarted` / `handleWorkerTerminalTurn`、`register.ts` 的 status event adapter、`useWorkers.ts` 的 `useWorkers`。

5. **切换 session 不重置 worker 未读状态（状态：不变量）**
   worker done 的红点由 renderer 进程级 edge-trigger attention store 维护，而不是跟随组件切换重置的局部 state。worker 状态跳变进 `done` 才标 attention；正在查看该 worker 时清除 attention；只切走 / 切回不应让同一轮 done 重新变未读。实现指针：`useOrcaWorkerAttentionWatcher.ts` 的 `computeWorkerAttentionUpdates`，`RolePillDropdown.tsx` 的 selected worker clear effect，`workerAttentionStore.ts` 的 `attentionWorkerIds`。

6. **重启后对 known worker 懒登记（状态：不变量）**
   app 重启后内存里的 known worker / vendorOptions 都会丢。恢复时不能只信内存 cache，必须通过 DB 的 `sessions.orca_role`、`orca_workers`、`orca_teams` 懒合成 Orca vendorOptions / worker link，保证手动 stop、terminal turn、worker 列表仍能识别已存在 worker；手动中断跟踪只能作为运行时优化，不能作为唯一事实源。刚开启协同但 worker 尚未对话时，也必须先写出可恢复的 agent 侧历史；当前通过 ready placeholder 触发 worker 首次 send，避免 Codex worker 因 rollout 缺失在重启后无法 resume。实现指针：`register.ts` 的 `synthesizeOrcaVendorOptionsFromDb`、`sessionCreateHandler.ts` 的 `sendWorkerReadyMessage`、`orcaLifecycleService.ts` 的 `enableTeam` / `sendWorkerReadyPlaceholder` 依赖、`orcaTeamStore.ts` 的 `listWorkersByLead` / `getWorkerLink`、`orcaManualInterrupt.ts` 的 known worker / manual interrupt store。

7. **重启后 Lead↔Worker 互访 / resume 不随开启路径变化（状态：不变量）**
   无论协同通过 `enableTeam` 自动创建首个 worker、MCP `start_team` + `create_worker`，还是 renderer 的协同按钮开启；也无论重启发生在对话中途，还是初始化完毕但 worker 尚未接过真实任务，maker 重启后 Lead 与 Worker 都必须能继续互访。`send_to_worker`、`send_to_lead`、`switch_focus` / idle resume 不能因为内存态丢失、worker link 懒登记缺失或空 worker rollout 缺失而失败。实现指针：`CCAgentSessionView.tsx` 的 `requestEnableCollab`、`packages/lizi-mcps/src/orca/server.ts` 的 `start_team` / `create_worker` 顶层注册、`xdt-helper/start_team.ts` / `create_worker.ts`、`orcaLifecycleService.ts` 的 `startTeam` / `createWorker` / `enableTeam`、`register.ts` 的 `synthesizeOrcaVendorOptionsFromDb` / `resumeOrcaWorkerSessionIfMissing`、`orcaTeamService.ts` 的 `sendToWorker`、`orca-bridge-mcp.ts` 的 worker `send_to_lead` handler。

### 测试与回归清单

当前文档要求保留以下回归方向：

- Service 边界：`orcaLifecycleService`、`orcaWorkerCreationService`、`orcaTeamService` 的单测覆盖 start/enable/create/dispatch/idle/archive/auto-bridge 关键路径。
- MCP 工具：`cindy_orca` 16 工具（13 team + 3 只读诊断）的 role gate、ctx 缺失、worker/main 误调用、soft/hard limit、duplicate label、budget model API mode gate；`create_workers` 另覆盖默认 hard limit、配置 hard=3、部分成功、连续失败与 hard-limit 后不再调用 host；诊断工具的纯只读语义（无 active team 时返回空 workspace、不建 team）；排队消息控制 3 工具的归属校验（跨 lead 拒绝）、非 lead 条目拒绝（`NOT_LEAD_MESSAGE`）、steering 拒绝（`MESSAGE_CONSUMING`）、撤回结清 accepted 暂存。
- Codex MCP context：`CodexMcpThreadContextStore` 覆盖按 threadId 查 context、unknown / missing threadId fail-closed、unregister 后清理、`vendorOptions` 引用保持；`codexHttpBridge` 覆盖从 JSON-RPC `params._meta.threadId` 注入真实 session context。
- Host 归属校验：`send_to_worker`、`idle_worker`、`archive_worker` 经共享 `resolveWorkerRef`（同时接受 worker_id / session_id 两种 id）必须以 caller 自身 Lead 身份校验，拒绝跨 workflow worker id 与 ctx 缺失；即使模型传错 id 或换用另一种 id，也不能越权操作。
- UI route：Orca worker 不出现在 sidebar，Lead 自动进 split route，worker deep link 解析到 Lead split route；已有测试守住“不用 fork parentSessionId 或标题推断 Orca mapping”，见 `apps/desktop/src/renderer/__tests__/orcaWorkflowRoute.test.ts` 的 `does not use fork parentSessionId or title-linked worker lookup for Orca mapping`。
- Fork / side_chat 底座：user fork、assistant fork、Codex `tailTurnsToDrop`、Claude turn-final assistant uuid、tool_use 拒绝。
- Worktree：toggle off/on、非 git/已在 worktree 只 disable worktree toggle、不阻断 send；Lead close 后清 worktree。
- 重启后 Lead↔Worker 互访(resume)回归矩阵：覆盖开启路径 `enableTeam` 自动首 worker / MCP `start_team` + `create_worker` / renderer `requestEnableCollab` → `SESSION_ENABLE_ORCA` → `enableTeam`，以及重启时机“对话中途”和“初始化完毕但未对话”；验收动作至少包含 `list_workers` 可见 worker、Lead 侧 `send_to_worker` 可投递或排队、Worker 侧 `send_to_lead` 可回传、focused / idle worker 可 resume。
- 重启矩阵 / 场景 1「lead worker 正常初始化」：创建协同后应同时写出 Lead `orca_role='lead'`、worker session `orca_role='worker'`、`orca_workers` link 与 focused/list projection，renderer split view 和 MCP `list_workers` 都能看到同一 worker。
- 重启矩阵 / 场景 2「协同进行到一半，重启 maker，lead worker 能正常互相访问」：已有 Lead↔Worker 对话历史和可能的 running/done 状态时，重启后依赖 `sessions.orca_role` + `orca_workers/orca_teams` 懒合成 vendorOptions / worker link，`send_to_worker` 与 worker `send_to_lead` 仍能恢复投递；恢复 Worker runtime 必须保留 `sessions.permission_mode`，不得静默升级权限。
- 重启矩阵 / 场景 3「刚开启协同，初始化完毕后，不进行任何对话，重启 maker，lead worker 能正常互相访问」：空 worker 不能只停留在 DB link；ready placeholder 必须让 worker agent 侧写出可 resume 的历史，尤其防止 Codex rollout 缺失。
- 重启矩阵 / 场景 4「先开单会话，进行到一半的时候，通过提示词开启协同，看到 lead worker 正常初始化，然后立刻重启 maker 后，lead worker 能正常互相访问」：提示词路径必须走 MCP `start_team` + `create_worker` 与 shared lifecycle service，不能绕开 worker link、role 标记、vendorOptions rehydrate 和 resume 约束。
- 重启矩阵 / 场景 5「先开单会话，进行到一半的时候，通过协同按钮开启协同，看到 lead worker 正常初始化，然后立刻重启 maker 后，lead worker 能正常互相访问」：按钮路径必须从 `requestEnableCollab` 进入 `SESSION_ENABLE_ORCA` / `enableTeam`，并满足与 MCP 路径相同的重启恢复与互访能力。

### 坑点与不变量

#### 1. Codex MCP context 路由必须 fail-closed（状态：不变量）

Codex HTTP bridge 只能把 JSON-RPC `params._meta.threadId` 当业务会话路由依据；`mcp-session-id` 只标识 MCP transport、不证明 maker session 归属，因此不作为路由依据。路由规则：threadId 命中已注册 context 时才注入；缺失、未知、batch 内不一致或不完整时一律不注入，让工具调用安全降级为 NO_SESSION_CONTEXT，绝不猜一个 ctx 造成跨会话串线。实现见 `CodexMcpThreadContextStore.getContextForThreadId` 与 `codexHttpBridge` 的 message-level routing。

#### 2. Codex MCP context 生命周期必须跟 thread 绑定（状态：不变量）

Codex thread start / resume 成功后必须注册 `threadId -> session context`；session close 时必须 unregister。context 注入发生在 tool-call message 处理期间，不依赖 turn/item notification 的时序窗口，也不依赖 TTL。这样长 turn、并发 tool call、outdated notification 都不会影响 session context 的可用性；真正缺少 `_meta.threadId` 时仍按坑点 #1 fail-closed。

#### 3. worker 控制入口必须按 caller 自身 Lead 身份做归属校验（状态：不变量）

`send_to_worker` / `idle_worker` / `archive_worker` 通过共享的 `resolveWorkerRef` 解析目标：它**同时接受 worker_id 与 worker session_id 两种**（id 当 opaque token、精确匹配，命中 0 个 → NOT_FOUND、多匹配 → 报错且无副作用），但**只在 caller 自身的 worker 列表内**解析。必须用 caller 自身的 `ctx.sessionId` 作为 callerLeadSessionId，校验目标 worker 与该 Lead/team 一致；ctx 缺失必须直接拒绝（`LEAD_NOT_SUPPORTED`，不放行、不回填），跨 workflow 的 worker id 在 host service 层拒绝。这是与坑点 #1 正交的纵深防御：fail-closed 路由保证 ctx 不串成别人，归属校验再挡住“ctx 正确、模型传错 id”的越权。实现见 `orcaTeamService.ts` 的 `resolveWorkerRef` 与各 worker 控制方法。

`switch_focus` 是纯 UI focus 操作，走单独的纯函数 `findFocusTargetWorker`（`orcaTeamService.ts`）：**worker_id / session_id 优先精确匹配，label 兜底**——比 mutation 工具多接受人类友好的 label（人/agent 常按 label 切画面），故意不复用 `resolveWorkerRef`（mutation 工具不该认 label）。register.ts 的 IPC handler 与 MCP holder 两条 switch_focus 路径共用这一个 helper，不要再各自 inline find。

#### 4. `orca_worker_bridge` 对 Codex 全局可见（状态：follow-up）

`orca_worker_bridge` 对 Codex session 的可见性必须由 handler 做角色校验兜底。可见性短期收不掉时，handler 必须用 `resolveLiziMcpSessionContext` 检查真实 `orcaRole === 'worker'`，普通 session / Lead 调用应返回明确错误，而不是 fallback 到空 ctx。

#### 5. Lead prompt 的诊断工具名（状态：已解决）

历史问题：`renderOrcaLeadSystemPrompt`（`packages/orca-workflow/src/orca-bridge-prompt.ts`）的 Lead prompt 用裸工具名引用 `get_workspace_info` / `worker_status` / `read_worker`，而这些过去只在 Claude-lead 专属的 `orca_bridge` 里、Codex Lead 看不到，会制造稳定噪音。统一后这 3 个诊断工具以**同名裸工具**桥入全局可见的 `cindy_orca`，Claude 与 Codex Lead 都能解析到真实工具，噪音消除。prompt 正文保持不动（无 provider namespace、只用裸名），因此本次未触发 system prompt 改动门禁（[`maker-core-and-agent-behavior.md`](maker-core-and-agent-behavior.md) §4）。

#### 6. Model 不可中途换，effort 可调（状态：不变量）

对同一个 live worker session，中途换 model 应视为重建执行单元，不是普通请求参数。原因：model 切换会破坏 prompt/cache 前缀稳定，Claude SDK 也可能解析失败。effort 是 per-turn 参数，可以中途调。创建执行单元前可以选 model/effort；运行中 effort 可调，model 不可调。

Worker 创建与默认模型继承边界对历史短 ID 做 provider-aware 兼容：优先保留目标路由上
可用的精确 ID；只有精确匹配失败、候选来源属于 managed Gateway、且
`namespace/short-id` 规范候选恰好一个并同时存在于 `list_available_models` 的 capabilities
清单、Model Registry 又确认该路由 ID 本身就是稳定模型身份时，才在内存中解析为规范 ID。
不能只按后缀推断，否则会把标准模型静默切到同后缀的折扣模型。Custom Provider 的精确短 ID
必须保持不变；候选为零、多个或目录身份不一致时 fail-closed，不猜测、不改写已有 Lead、
Session 或默认配置的持久化值。
Worker defaults 中单独缓存的 `providerId` 不约束从 Lead / 硬编码默认值继承模型的规范化；
它只有在仍提供最终精确模型 ID 时才参与最终路由。反过来，旧 defaults 只缓存 `model` 而
没有 `providerId` 时也不能借用 Lead 来源，必须按当前已连接来源解析默认路由。缓存来源已失效
或不提供该模型时，创建边界可回退搜索当前已连接来源，但最终仍必须得到精确路由或唯一
managed 规范候选，否则在 reservation / bootstrap 前拒绝。

#### 7. Prompt / tool / MCP 注册路径必须评估 maker-core 四指标（状态：不变量）

任何改动落在 prompt 拼接、tool/MCP 暴露、translator、event loop、model 映射、usage/token 计量路径时，都必须评估缓存率、性能/返回速度、返回内容准确性，并按 [`maker-core-and-agent-behavior.md`](maker-core-and-agent-behavior.md) §3 给出实测证据。尤其不要把 per-turn 易变内容塞进稳定 system/developer 前缀，不要在会话中途随意增删/重排 tool 定义。

#### 8. `forkedAtMessageId` schema 注释滞后（状态：follow-up）

`forkedAtMessageId` 需要覆盖 user 与 assistant 两种 fork 来源，schema 注释也应按该语义维护，见 `apps/desktop/src/main/localDb/schema.ts` 的 `sessions.forkedAtMessageId`。这是文档/注释 bug，不影响运行；后续改 schema 注释时必须通过正常 migration/代码 review 流程，不手改 migration。

#### 9. `parent_session_id` 不表示 Orca 派单（状态：不变量）

`parent_session_id` 是 fork/session-branch 关系，不是 worker 归属关系。Orca 归属必须查 `orca_teams/orca_workers`。已有 route 测试防止 split view 用 `parentSessionId` 或标题匹配 worker，见 `apps/desktop/src/renderer/__tests__/orcaWorkflowRoute.test.ts` 的 `does not use fork parentSessionId or title-linked worker lookup for Orca mapping`。

#### 10. Worker 回收要克制（状态：无损 idle release 已落地）

Worker 的价值在于上下文可延续、可观察、可介入。PR #340 已落地无损的 idle release：idle watcher 在 Worker 超过设置的空闲阈值、没有运行中的 turn 或排队输入时，关闭本进程持有的 Maker runtime，并以 CAS 原子写入 `status = idle` 和 `idle_since`。`idle_since != null` 是 runtime 已释放的持久化标记，不是 `idle/running/done/error` 之外的第五种 Worker 状态；Worker 记录、session、历史和上下文都继续保留。

再次向该 Worker 派发任务时，既有 resume 链路会复用或重建 runtime，并在任务被接受时恢复运行态。共享 userData 多实例下，watcher 只释放本进程实际持有 runtime 的 Worker；没有本地 runtime 的记录保持不变，由其 runtime owner 负责处理。

这套机制只等价于无损 hibernate，不等价于 archive/delete。`idle_worker/archive_worker/end_team` 仍保留显式控制语义；长期 Worker 的自动有损回收，以及 persistent/ephemeral 分型后的差异化回收策略，仍应保持保守并在后续单独落地。

## Part 2 · 未来规划

### 执行单元愿景

Orca 的长期方向不是“进入一个固定协同模式”，而是在主线旁随手开启一组 **side activity / child execution**。不同类型底层能力不同，但 UI 和控制面尽量统一：都能被看见、被管理、被中断/归档、记录来源、产物和状态。

顶层 side activity 目标类型：

- `worker`：Lead 派单的 side session，可持续、可插话、可回传。
- `side_chat`：用户从某个消息/turn fork 的分支对话，自驱探索，默认不回传，可选回传。
- `workflow_run`：确定性编排运行，展示 step 树、进度、失败点和产物。

`subagent` 不是顶层 side activity。它是 runner：默认轻量、用完即弃，作为 workflow step 或 Lead 临时小活的底层执行体。只有当用户需要看过程、追问、接管、留痕时，才把其记录接手成可见 side session。

### 三态拆分

未来所有可见执行单元都要拆开三件事：

| 维度 | 问题 | 示例取值 |
|---|---|---|
| 对象在不在 | 身份、历史、上下文是否保留 | exists / deleted |
| UI 显不显示 | 是否挂在当前面板或 sidebar | active / archived |
| 后台醒没醒 | SDK/进程是否 live、能否马上接活 | live / dormant |

不要再让 `idle`、`archive`、`close` 混着表达这三件事。archive 是 UI/可见性，dormant 是后台活性，delete 才是对象删除。

### Worker 生命周期分型

当前 schema 尚未落地 persistent/ephemeral 字段和分型策略。PR #340 先提供了与类型无关的 idle release/resume 基础能力：所有合法 Worker 状态都可在空闲超时后释放本地 runtime，以 `idle_since != null` 记录释放结果。下面两类是后续分型后的目标策略：

Worker 计划分两类：

| 类型 | 语义 | 默认回收策略 |
|---|---|---|
| persistent | 长期协作者，价值是上下文延续与可介入 | 允许无损 hibernate/resume；不自动 archive/delete |
| ephemeral | 可观测的一次性执行单元，像“看得见的 subagent” | done/error 后可优先进入回收候选 |

`role` 与 lifecycle 正交。`developer/reviewer/tester/merger` 是职责，不表示长期或一次性。分型落地后，创建时可以声明 lifecycle；运行中升降级放后续。

一次性任务不一定要开 worker。只有满足“需要独立可见历史、多轮追问、Lead 切过去 review、用户接管、共用模型/桥接/审计”等条件时，才值得用 ephemeral worker；否则应走 subagent。

### 顶层类型与 Runner 分层

第一层是顶层 side activity：

| 类型 | 可视化对象 | 介入深度 |
|---|---|---|
| `worker` | 单条 side session 的过程流 | 深：派活、追问、接管、回传 |
| `side_chat` | 分支对话的过程流 | 深：用户自己驱动，可选择回传 |
| `workflow_run` | 编排树、进度、失败点、产物 | 编排级：pause/cancel/retry/skip/看产物 |

第二层是 workflow_run 内部 step 树：每个 step 有 runner，默认是 subagent；高风险、长耗时、失败、需要用户介入的 step 可以使用 worker runner 或被接手成 worker。

workflow step 不是顶层类型；它属于 workflow_run 内部。`subagent` 也不是顶层类型；它是 runner。

### Side Chat

side_chat 和 worker 共用同一套 pane 外壳。区别不在 UI 壳，而在关系契约：

| 维度 | worker | side_chat |
|---|---|---|
| 发起者 | Lead 派单或用户显式创建 worker | 用户从当前消息/turn fork |
| 默认通信 | Lead ↔ Worker，可自动/手动回传 | 用户 ↔ Side chat，默认不回传 |
| 结果归属 | 默认回给 Lead，由 Lead 验收 | 默认留在分支，可选采纳/回传 |
| 关系字段 | task、role、label、return_to、communication policy | source session/message/turn、fork reason、return policy |

PR #107 已完成 side_chat 的底层 fork 数据动作：

- user fork：复制该 user 之前上下文，新 session composer 预填原提问。
- assistant fork：复制到该回复所在 turn 的末尾，避免 dangling tool_use。
- Claude：找复制边界前最近的非 subagent assistant uuid，传 `upToMessageId`。
- Codex：先 ThreadFork latest，再按 `tailTurnsToDrop` ThreadRollback 尾部 user turns。
- 新 session 记录 `parentSessionId/forkedAtMessageId`，但目前仍作为普通 session 跳转。

side_chat 待落地的是：

1. 登记成 side activity 对象：补 `execution_type='side_chat'` 和关系契约。
2. 挂进统一 pane，而不是现在 `navigate(/cc-agent/<newSession.id>)` 跳走。
3. 关系契约分型：默认不回传、可选回传/采纳、记录来源 turn 和产物 provenance。

### 关系契约

关系不应做成单一 `relation_kind` 枚举。它应是一组字段，至少包括：

- `execution_type`：`worker | side_chat | workflow_run`。
- `lifecycle_kind`：`persistent | ephemeral`，适用于 worker / side_chat。
- `source_session_id`。
- `source_message_id` 或 `source_turn_id`。
- `initiator`：用户 fork、Lead 派单、workflow 触发、系统恢复等。
- `return_to`：结果回给哪个 parent / step / 用户动作，或 none。
- `communication_policy`：父子单向、父子双向、允许用户接管、允许同级等。
- `artifact_ownership`：diff / 文件改动 / 产物默认归谁。
- `provenance`：来源、采纳、覆盖、人工介入、预算/门禁结果。

注意 workflow_run 不是扁平父子关系，它有 `run → step → runner` 的嵌套树；关系表需要能表达这一点。

### 控制面九大机制

统一 side activity 外壳背后需要九类控制面能力：

1. **能力矩阵 / UI 降级契约**：每种 `execution_type × lifecycle_kind × runtime state` 下哪些动作可用，例如 send、interrupt、effort、archive、resume、接管、delete。
2. **通信拓扑**：谁能给谁发消息，父子、同级、用户接管分别如何路由。
3. **结果回传**：自动回、人工拉、完成时聚合、只留分支，要与当前粗粒度 auto-bridge 区分。
4. **产物聚合**：多个执行单元的 diff、文件改动、报告、结论如何聚合进主线决策。
5. **取消 / 中断 / 重试语义**：谁有权中断，是否级联；workflow step retry 是新 runner 还是复用 worker。
6. **质量门禁 / Lead 验收**：`done` 只是执行结束，质量裁决是正交轴。不要把 `gate_failed` 塞进 worker status；应记录 quality verdict / terminal reason / provenance。
7. **并发与资源治理**：soft/hard limit、排队、优先级、压力下回收策略。
8. **预算闸**：per-worker 与 per-team 的 turn/token/cost 上限；soft limit 交给 Lead/用户决策，hard limit 终止并记录原因。
9. **权限 / 归属 / 一致性修复**：谁能接管，child 能否看 parent 上下文，孤儿 step/worker 如何 reconcile，回传失败如何补偿。

### 分阶段路线

1. **稳住当前 worker 底座**：Codex MCP context 路由已是 fail-closed、worker 控制入口已按 caller 归属校验（坑点 #1/#3 已是不变量）；剩余 follow-up 是补 worker bridge role gate（坑点 #4）、持续补回归测试。（坑点 #5 已随诊断工具桥入 `cindy_orca` 解决；`orca_bridge`（A）已整体删除。）
2. **生命周期建模**：引入 `lifecycle_kind` 与 live/dormant，统一 resume helper，默认不自动有损回收。
3. **side activity 关系层**：新增关系/side activity 数据结构，兼容现有 `parent_session_id/forked_at_message_id` 和 `orca_teams/orca_workers`。
4. **side_chat 纳入 pane**：复用 PR #107 fork 动作，但创建 side_chat child execution，挂到统一 pane，默认不回传。
5. **统一控制面**：能力矩阵、通信/回传/产物聚合、质量门禁、预算治理。
6. **workflow_run**：引入 step 树、runner 策略、step retry/skip/cancel、关键 step 接手成 worker。

### 待讨论项

1. 关系层是单表、事件表 + projection，还是按 side activity / workflow_run 拆表。
2. side_chat 默认展示策略：创建后立即占 worker pane、开新 pane tab、还是进入 side activity 列表待用户选择。
3. side_chat 结果采纳 UX：回传一段总结、插入 parent composer、生成 diff/provenance review，还是三者都支持。
4. persistent/ephemeral 默认值：side_chat 默认 persistent 还是 ephemeral。
5. workflow step 何时自动接手为 worker：失败、超时、高风险文件、用户点名，判据需要收紧。
6. budget / quality routing 作为 skill+memory 决策，还是主进程 deterministic policy，如何与用户偏好并存。
