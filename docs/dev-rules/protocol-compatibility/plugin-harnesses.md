# 插件任务执行引擎 harnesses（2026-11-18，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。设计见
> [ACP 插件桥接层](../../plans/acp-plugin-bridge.md)。

Ghost manifest 追加 v3 顶层字段 `harnesses?: Array<{ id, name, description?, protocol, entry, locales? }>`（append-only，
v2 `slots` 不映射）：解析器在协议正本 `packages/plugin-protocol/src/pluginHarnesses.ts`，`manifest.ts` 与 Desktop
`shared/ghost.ts` 共用。1–4 项；`id` 为 `^[a-z][a-z0-9-]{0,31}$` 且唯一；`name` 1–64；`description` ≤200；`protocol` 只有 `acp`
生效，其它合法标识保留但不生效、不拒装；`entry` 必须逐字命中 `node.entries`（不能是 `node.entry`），且必须声明 `node`；
每项未知扩展字段原样保留。新包不合规则拒装；已存 Release 与已装快照（`validateStoredGhostManifest` /
`validateInstalledGhostManifest`）只丢弃不合规的 `harnesses`，插件其余能力与批准照旧。未升级的消费者（旧 Desktop、
服务端仓同名 plugin-protocol 未同步前的 plugin-server）把它当未知 v3 字段原样保留、不授予、不拒装；服务端补同一校验时
沿用本仓 fixture（`manifest.test.ts`「harnesses」、Desktop `ghost.test.ts`「harnesses declaration」）。

Host receipt 追加可选 `approvedHarnesses?: string[]`：只来自安装／更新确认里显示过的 `harnesses` 权限行（服务端默认安装与
随包种子视为已批准声明），读写都按当前 manifest 的可运行声明过滤。旧 receipt 缺字段 = 一个都没批准，安装照常有效；旧客户端
读到新字段按未知字段忽略。

插件同源端点（本机 Electron 插件页与远程设置页的同一 fetch 白名单，非 device-link）：`PUT /harnesses` 正文
`{ harnesses: [{ id, available: boolean, reason?: slug, message?: ≤200, version?: ≤64, models?: [{ id: ≤256, name: ≤200, description?: ≤200, group?: ≤200, efforts?: [level] ≤16, defaultEffort?: level }] ≤200, modes?: [mode] ≤16, defaultMode?: mode }] }`，
整体覆盖，内容不变不写盘不通知，成功返回规范化后的列表；`GET /harnesses` 读回（按当前清单过滤）。未声明 `harnesses` 403，未安装 404，
格式错误、未声明的 id 或模型 id 重复 400 且不改原状态，其它方法 405；额外字段丢弃。旧 Host 与 Node Host 返回 404，插件按不支持处理；
不认识 `models` 的旧 Host 丢弃该字段，新 Host 读到没有 `models` 的旧记录按「插件不列模型」处理。
`efforts` / `defaultEffort`（2026-11-19）是 Cindy 思考深度 id（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，与 maker-core 从
ACP `thought_level` 取值映射的集合相同）：非数组、非字符串或有 `defaultEffort` 无 `efforts` 400；本版不认识的 id 跳过、不拒整份
（新插件在旧 Host 上不丢模型），按低→高重排并去重，`defaultEffort` 不在 `efforts` 里则丢弃。旧 Host 丢弃这两个字段；旧插件不发，模型没有可选档位。
`modes` / `defaultMode`（2026-11-19）是 Agent 自己的工作模式，用 Cindy 权限档 id（`default`、`acceptEdits`、`auto`、`plan`；
ACP `mode` 配置项取值忽略大小写与 `-` / `_` 后与之相同才算，与 maker-core `mapModeValues` 同一规则）：校验方式同 `efforts`，保持 Agent 的顺序。
Host 把它们列进权限菜单，末尾固定加 Cindy 的 `bypassPermissions`；切换时引擎层用 `session/set_config_option` 切 Agent 的模式，
Cindy 对权限请求仍逐个询问。旧 Host 丢弃这两个字段；不发的插件保持「逐项确认 / 全部允许」。任务行的 `permission_mode` 仍只存 Cindy 已有的取值。

刷新（Host → 插件逻辑页，经既有 `ghost-pipe:message` / `cindy.onHostMessage`）：打开模型选择器时 Host 发
`{ type: 'harnesses-refresh-requested' }`，同一插件 10 分钟内最多一次，逻辑页不在线不发；插件不回复，重新 `PUT /harnesses`。
不认识该消息的旧插件按未知消息忽略。

Main 内部接口（不跨端）：`cindy-brain/pluginHarnesses.ts` 的注册表与 `nodeRuntimeBroker.spawnHarness`。引擎进程沿用 childSpawn 的
utilityProcess 原样 stdio 模式，stdin 为 base64 字节帧、stdout 为原始字节，wire 不变。实现与回归见
`runtime/ghostHarnessesEndpoint.ts`、`ghostInstallConsent.ts`、`ghostInstallReceipt.ts` 及 `ghostHarnessesEndpoint.test.ts`、
`pluginHarnesses.test.ts`、`nodeRuntimeBroker.test.ts`、`ghostLocalInstallIdentity.test.ts`。
ACP 工具晚到的输入参数更新原有历史行，控制端通过既有消息行广播收到，重复上报同一参数不重复写入。

任务中换引擎（2026-11-19，第二期）：`sessions:patched` 的 `agentSwitchIntent`（`PublicAgentSwitchIntent`）与
`maker:get-session-agent-switch-intent` 的 `targetAgentKind` 新增取值 `acp`（此时 `providerId` 必为 `acp-plugin:<插件>:<引擎>`）。
这是既有字段的新取值。被控端仅向声明 `plugin-engine-switch-intent-v1` 的控制端推送和返回插件引擎意图，旧控制端收到空意图。
新端遇到不带引擎标识的 `acp` 同样按无意图处理。`maker:switch-session-agent` 新接受 `targetAgentKind = acp`（Agent 原在另一台电脑时意图的 `agentDeviceId` 为 `null`，即回到被控端本机；请求点名别的电脑时拒绝）；旧控制端不会发出，
新控制端对旧被控端发出时旧端以 INVALID_PARAMS 拒绝。`agent_switch` 边界行的 `fromAgentKind` / `toAgentKind` 可为 `acp`，
追加可选 `fromEngineName` / `toEngineName`；旧端把 `acp` 显示为 Claude Code，停泊会话查找只匹配内置引擎，不会误续接。
回归见 `pluginEngineSessionSwitch.test.ts`、`pluginEngineSessionAdmission.test.ts` 与 renderer `sessionAgentSwitchRemoteRouting.test.ts`。

手机和桌面控制端读插件引擎（2026-11-19，第二期）：device-link allowlist 新增只读 `maker:list-plugin-engines`（返回 `PluginEngineView[]`，与本机
Renderer 读到的字段相同；图标数据 URL 单个最多 64 KiB、一次列表合计最多 512 KiB，超出预算的图标显示通用标志）与 `maker:refresh-plugin-engines`（请那台的
插件重新上报模型，插件各自冷却），两者都进后台 invoke 档。变更推送 `maker:plugin-engines-changed` 仍只发本机窗口，控制端打开选择器时
按需读取。旧被控端没有这两条准入 → `CHANNEL_NOT_ALLOWED`，控制端按「没有插件引擎」隐藏入口；旧控制端不调用。走既有 invoke 帧，
自建中转无需改动。桌面控制端按账号和任务所属电脑共享目录，打开插件任务或模型选择器时读取，任务列表复用已有结果。
同引擎模型变更沿用 `maker:set-model`，按稳定设备归属发往被控端并使用该端的任务变更推送回显。引擎提供的模型标识在 256 字符
以内原样缓存，超限项目不进入目录，展示名称另行限长。

定时任务（2026-11-19，第二期）：`Schedule` / `CreateScheduleInput` 的 `agentKind`、`modelAgentKind` 新增取值 `acp`（`providerId` 必为
`acp-plugin:…`），只用于每次新建任务、在自动任务所在电脑运行的 Agent 任务；保存时拒绝绑定任务、持续会话、worktree、运行位置、
脚本执行，以及只改一半（例如旧端把 `agentKind` 写回内置引擎）的组合。`schedules.agent_kind` / `model_agent_kind` 列只放宽 TS 枚举，
没有 CHECK 约束，不需要迁移。旧版本读到 `acp` 行：运行时按未知引擎失败（不回落内置模型），旧表单显示为 Claude；旧端保存整张表单
时由新版校验拒绝，不会悄悄换引擎。项目自动化（随代码提交的 `.cindy/automations/schedules.json`）不接受插件引擎。
Agent 工具：`list_available_models` / `schedule_list_models` 的 host 结果追加可选 `pluginEngines`（只列任务电脑本机、且不按 agent
过滤时），`list_available_models` 输出为 `plugin_engines`；`schedule_create` / `schedule_update` 的引擎枚举追加 `acp`。旧 host 不带该字段。
回归见 maker-scheduler `scheduler.test.ts`「plugin engine」、`runnerModelSelection.test.ts`「plugin engine schedules」与
renderer `scheduleFormLogic.test.ts`「plugin engine selection」。

协同 Worker（2026-11-19，第二期）：`maker:session:enable-orca` 的 `workerAgent`、`maker:worker:create` 的 `agent`、`create_worker` /
`create_workers` 的 `agent` 枚举新增取值 `acp`（`providerId` / `provider_id` 必为 `acp-plugin:…`）。只由本机新版电脑的创建面板与 Lead 的
工具发起，远程控制与手机不列插件引擎；旧版被控端从不会收到。插件引擎 Worker 只在 Lead 所在电脑本机运行，带运行设备、Agent 位置、
worktree 或 SSH Lead 时拒绝（INVALID_PARAMS）。`maker:worker:list` 与团队快照里这种 Worker 的 `session.agentKind = acp`，并追加可选
`session.providerId`；`list_workers` / `get_workspace_info` 的 agent 字段同样可为 `acp`。共享解析器 `parseOrcaTeamWorkers` 给手机追加可选
`pluginEngineProviderId`，`agentKind` 仍是旧端可用的占位值；已发布的手机把它显示为 Claude Code，查看与派活不受影响。插件引擎任务当 Lead
的所有入口统一拒绝（`[PLUGIN_ENGINE_CANNOT_LEAD]`），`set_worker_runtime` 对插件引擎 Worker 返回 UNSUPPORTED_CAPABILITY。远端 Worker
回报通道（`orcaRemoteWorkerBridge`）拒绝插件引擎 Worker。maker-core 内部新增 `StartSessionOptions.pluginEngineBriefing` /
`pluginEngineTrustedCaller`（只 acp 引擎读取，不跨端）。回归见 `orcaWorkerCreationService.test.ts`「plugin engine Worker」、maker-core
`acp-session.test.ts`（briefing / trusted caller）、renderer `CreateWorkerPopover.test.tsx` 与 maker-shared `orcaTeam.test.ts`。

## 引擎账号用量

执行引擎通过 `PUT /harnesses` 的可选布尔标志 `reportsUsage: true` 表示其主 JSON-RPC worker
可以处理 `usage({harnessId})`。Host 在调用及返回前检查该实例、批准和可用状态，broker 校验当前账号。
主进程只把校验并裁剪过的 `GhostHarnessUsage` 返回给发起读取的界面；快照不落盘，也不进入模型列表广播。
快照使用毫秒时间戳，最多 24 个窗口和 8 个币种余额。读取失败或未提供数据时显示为空，零值保留。
桌面任务和手机菜单按账号代次、执行电脑、引擎共用在途读取与一分钟缓存。切换任务可复用结果，隐藏期间缓存到期只释放数据，账号切换后丢弃原账号的回包。
模型目录刷新保留仍可上报用量的引擎读数。引擎被移除或停止上报时，控制端清掉该引擎的缓存并丢弃迟到的回包。手机暂时连不上执行电脑时保留上次读到的目录。

同账号配对设备通过只读 `maker:get-plugin-engine-usage(key)` 查询执行电脑；SSH、分享访客与未配对调用没有账号用量入口。
旧插件继续使用现有状态与模型，新插件在旧 Host 上仍可在自己的设置页获取用量。旧 Host 缺少该 channel 时控制端按无数据处理。
既有 Device Link invoke 帧和自建中转可原样转发，无需扩展中转协议。该变更不增加 manifest 权限、批准或安装迁移。
