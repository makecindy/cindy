# 插件任务执行引擎 harnesses（2026-11-18 起演进）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录跨端／跨版本协议约定。
> 产品定位与能力台账见[插件引擎与插件模型](../../product-rules/plugin-engines-and-models.md)，
> 运行时工程不变量与回归入口见[ACP 插件执行引擎](../acp-plugin-harness.md)。

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
格式错误、未声明的 id 或模型 id 重复 400 且不改原状态，其它方法 405；额外字段丢弃。旧 Host 返回 404，插件按不支持处理（Node Host 同步支持 `/harnesses`）；
不认识 `models` 的旧 Host 丢弃该字段，新 Host 读到没有 `models` 的旧记录按「插件不列模型」处理。
`efforts` / `defaultEffort`（2026-11-19）是 Cindy 思考深度 id（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，与 maker-core 从
ACP `thought_level` 取值映射的集合相同）：非数组、非字符串或有 `defaultEffort` 无 `efforts` 400；本版不认识的 id 跳过、不拒整份
（新插件在旧 Host 上不丢模型），按低→高重排并去重，`defaultEffort` 不在 `efforts` 里则丢弃。旧 Host 丢弃这两个字段；旧插件不发，模型没有可选档位。
`modes` / `defaultMode`（2026-11-19）是 Agent 自己的工作模式，用 Cindy 权限档 id（`default`、`acceptEdits`、`auto`、`plan`；
ACP `mode` 配置项取值忽略大小写与 `-` / `_` 后与之相同才算，与 maker-core `mapModeValues` 同一规则）：校验方式同 `efforts`，保持 Agent 的顺序。
Host 把它们列进权限菜单，末尾固定加 Cindy 的 `bypassPermissions`；切换时引擎层用 `session/set_config_option` 切 Agent 的模式，
Cindy 对权限请求仍逐个询问。旧 Host 丢弃这两个字段；不发的插件提供与内置引擎统一的「默认权限 / 完全访问」，`ask` 与 `default` 跨引擎等价识别。任务行的 `permission_mode` 仍只存 Cindy 已有的取值。

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
自建中转无需改动。桌面控制端按账号和引擎所在电脑共享目录：任务列表存在该电脑的插件引擎任务或打开插件任务／模型选择器时共用一次 `maker:list-plugin-engines` 读取，断线保留已缓存图标、重连刷新、撤权或移除时驱逐（见 `usePluginEngines.ts`、`useDeviceLinkRemoteProjects.ts` 与 `pluginEngineVendorIcon.test.tsx`）。
同引擎模型变更沿用 `maker:set-model`，按稳定设备归属发往被控端并使用该端的任务变更推送回显。引擎提供的模型标识在 256 字符
以内原样缓存，超限项目不进入目录，展示名称另行限长。

伙伴的模型设置沿用现有设置表单。每个插件模型保存 `harness: 'acp'`、引擎的 `providerId`、模型 ID 与可选思考深度，在伙伴所在电脑上运行。
更新后的桌面和手机可以编辑同一份配置。不能识别 ACP 的旧设置服务会拒绝保存这项选择。插件清单、批准状态及中转消息格式沿用原契约。

定时任务（2026-11-19 起演进，2026-11-27 扩展）：`Schedule` / `CreateScheduleInput` 的 `agentKind`、`modelAgentKind` 新增取值 `acp`（`providerId` 必为
`acp-plugin:…`）。2026-11-25 起接受 `useWorktree`（旧版自动化电脑保存时拒绝）；2026-11-27（#13003）起支持本机与合法同账号远程／有效分享电脑的 `agentDeviceId` / `modelAgentDeviceId`，并支持本机普通桌面任务的绑定自动化在插件引擎与内置引擎之间临时切换，下次普通发送前自动恢复原引擎、模型、`agentDeviceId` 与 `permissionMode` 基线。保存与执行仍明确拒绝持续会话、伙伴例行任务、SSH、协同任务、脚本执行、非桌面来源、旧版仅模型覆盖、原始 wire peer 及只改一半的组合。`schedules.agent_kind` / `model_agent_kind` 列只放宽 TS 枚举，
没有 CHECK 约束，不需要迁移。旧版本读到 `acp` 行：运行时按未知引擎失败（不回落内置模型），旧表单显示为 Claude；旧端保存整张表单
时由新版校验拒绝，不会悄悄换引擎。项目自动化（随代码提交的 `.cindy/automations/schedules.json`）不接受插件引擎。
Agent 工具：`list_available_models` / `schedule_list_models` 的 host 结果追加可选 `pluginEngines`（按本机或目标 `agentDeviceId` 返回，且不按内置 agent
过滤时），`list_available_models` 输出为 `plugin_engines`；`schedule_create` / `schedule_update` 的引擎枚举追加 `acp`。旧 host 不带该字段。
回归见 maker-scheduler `scheduler.test.ts`「plugin engine」、`runnerModelSelection.test.ts`「plugin engine schedules」与
renderer `scheduleFormLogic.test.ts`「plugin engine selection」。

协同 Lead & Worker（2026-11-19 起演进，2026-11-27 扩展）：`maker:session:enable-orca` 的 `workerAgent`、`maker:worker:create` 的 `agent`、`create_worker` /
`create_workers` 的 `agent` 枚举新增取值 `acp`（`providerId` / `provider_id` 必为 `acp-plugin:…`）。桌面端与手机端创建面板都支持选择 Lead 所在电脑本机的插件引擎作为 Worker（远程运行设备与 SSH Lead 不列插件引擎）；旧版被控端不认识 `acp` 时以 `INVALID_PARAMS` 拒绝。插件引擎 Worker 只在 Lead 所在电脑本机运行，带运行设备、Agent 位置
或 SSH Lead 时拒绝（INVALID_PARAMS）；2026-11-25 起接受 `worktree`（旧版拒绝）。`maker:worker:list` 与团队快照里这种 Worker 的 `session.agentKind = acp`，并追加可选
`session.providerId`；`list_workers` / `get_workspace_info` 的 agent 字段同样可为 `acp`。共享解析器 `parseOrcaTeamWorkers` 给手机追加可选
`pluginEngineProviderId`，`agentKind` 仍是旧端可用的占位值；已发布的手机把它显示为 Claude Code，查看与派活不受影响，新版手机按 `pluginEngineProviderId` 解析真实插件引擎名与模型名。2026-11-27 起（#13001 / #13331）插件引擎任务当 Lead 在新版电脑端与手机端均已放开（同时补齐 ACP `elicitation/create` 问题卡、plan 更新、分叉／回退与手动压缩），旧版被控端仍以 `[PLUGIN_ENGINE_CANNOT_LEAD]` 拒绝并由手机端给出场景化提示；`set_worker_runtime` 对插件引擎 Worker 仍返回 UNSUPPORTED_CAPABILITY，远端 Worker
回报通道（`orcaRemoteWorkerBridge`）仍拒绝插件引擎 Worker。maker-core 内部新增 `StartSessionOptions.pluginEngineBriefing` /
`pluginEngineTrustedCaller`（只 acp 引擎读取，不跨端）。回归见 `orcaWorkerCreationService.test.ts`「plugin engine Worker」、maker-core
`acp-session.test.ts`（briefing / trusted caller / elicitation）、renderer `CreateWorkerPopover.test.tsx` 与 maker-shared `orcaTeam.test.ts`。

## 免装远程调用与跨账号分享插件引擎（2026-11-21）

任务在 A(文件、命令与任务记录所在)，Agent 用 B 上插件提供的引擎运行；B 可以是同账号的另一台电脑，也可以是跨账号分享给 A 的直连分享来源(`share:<shareId>`)。A 上无需预装对应的 `.cindy` 插件或 CLI。复用 [远程 Agent](remote-agent.md) 的 `maker:remote-agent:v1`、影子目录、工具隧道与 `provider-share-v1` 直连通道，不新增 wire channel、relay kind 或服务端表结构，官方与自建中转无需修改即可转发既有帧。

- **插件上报**：`PUT /harnesses` 条目在 `remoteWorkspace: true` 之外追加可选 `guestWorkspace: true`(仅 `available: true` 时保留)，表示入口还认识固定启动参数 `--cindy-guest-workspace`(`GHOST_HARNESS_GUEST_WORKSPACE_ARG`)：受邀者任务启动时，Host 同时传入 `--cindy-remote-workspace --cindy-guest-workspace`，插件除关掉自带文件与命令工具外，还要隔离分享者个人的 CLI 技能、命令、记忆与自带网页抓取(网页抓取统一经受邀者本机 `cindy_exec` 的 `WebFetch` 执行)。旧 Host 丢弃 `guestWorkspace`；只发 `remoteWorkspace` 不发 `guestWorkspace` 的存量插件在同账号电脑间照旧可用，仅不开放跨账号分享；未声明 `guestWorkspace` 的引擎在受邀者启动时于 fork 前拒绝。不增加 manifest 字段、权限行或批准状态，存量安装零迁移。
- **开关与分享入口**：B 上逐引擎的「允许被远程调用」仍存在 `remote-provider-access-prefs.json`(键 `acp-plugin:<插件>:<引擎>`)。`maker:list-plugin-engines` 的 `remoteUse` 追加可选 `shareSupported: boolean`(当 `remoteWorkspace && guestWorkspace` 时为 `true`)；当 `shareSupported === true` 时插件详情页展示「远程与分享」入口，沿用既有一次性分享链接、配对码审批、按人/全局模型范围(`remote-model-access`)、暂停/恢复/移除与轮次/token 用量统计(不进入供应商组与备用机委托)。
- **受邀者目录读取**：受邀者通道白名单(`PROVIDER_SHARE_CHANNELS` 与受邀者侧 `PROVIDER_SHARE_RENDERER_CHANNELS`)追加只读 `maker:list-plugin-engines` 与 `maker:refresh-plugin-engines`。B 在投影受邀者读取时只返回 `providerId` 命中该分享且 `shareSupported === true`、仍开启远程调用的单项引擎，剥离 `reportsUsage`，并按 `remoteModelAccess` 过滤 `models`；非插件引擎分享直接返回空数组，不向内置供应商分享发送插件引擎目录请求。
- **能力位与打开**：`caps` 对同账号控制端和持有有效插件引擎直连分享授权的受邀者声明 `pluginEngines: true`。`open.agentKind = acp` 允许同账号控制端与直连分享受邀者(`!relayKey`、非 `groupAssigned`、非备用机委托)，受邀者载荷经 `sanitizeGuestOpenPayload` 清洗、会话续接经 `guestOwnsSession` 校验、凭证文件访问沿用受邀者逐次确认，且 `open` / `send` / `steer` / `setModel` 及模型权限变更时实时复核 `isPluginEngineOfferedToGuests` 与 `remoteModelAccess`(设有限制时 `default` 模型同样受控)。
- **消费端免装**：A 的新建任务草稿与普通任务会话切换不再要求本机预装同款插件即可列出并选用同账号其他电脑及已收到插件引擎分享(`share:<shareId>`)提供的引擎；图标(`≤64 KiB` data URL)、模型、思考深度与权限档直接取自执行端目录。
- **远程控制下同样可选**（2026-11-23 用户反馈后补齐）：A 远程控制 B 时，B 上的新建任务与已建任务的模型菜单除 B 自己的引擎外，
  也按 B 的来源名单(`maker:model-catalog:read` 的 `op: locations`，与内置模型同一份，[远程 Agent](remote-agent.md) #8010)列出同账号其他电脑
  (含 A)与 B 收到的插件供应商分享开放的引擎；内置供应商分享按名单里的 `favoriteSource.providerId` 排除，不发引擎目录请求。
  引擎列表经 B 代读：`op: read` 的固定只读 channel 追加 `maker:list-plugin-engines`(参数只能为空)，B 按名单前后复核来源，回包只保留
  `parseOfferedPluginEngines` 认可的引擎、去掉 `reportsUsage`，分享只保留授予的那一个引擎。选中后 `maker:create-session` 带
  `agentKind: 'acp'` 与 `agentDeviceId`(`share:<shareId>` 或电脑 id)，已建任务的 `maker:switch-session-agent` 同样带 `agentDeviceId`；
  B 沿用既有准入(`admitPluginEngineSessionElsewhere` / `admitRemotePluginEngineTarget`)与远程 Agent 启动路径，执行端照常实时复核授权。
  不新增 channel、allowlist、relay 帧或字段，官方与自建中转按既有 invoke 帧透明转发、无需修改。旧版 B 对新 channel 回 `INVALID_PARAMS`，
  控制端记为不支持、只列 B 自己的引擎(与此前相同)；B 没有来源名单(更早的版本)时同样只列 B 自己的引擎。手机端同样复用同一条
  `maker:model-catalog:read` 路径读取同账号其他电脑与已收到插件引擎分享，支持在模型选择器来源页筛选、收藏（沿用 `PLUGIN_ENGINE_FAVORITE_WIRE_AGENT = 'cc'` 既有槽位）、新建任务、会话内切换、伙伴模型链与插件自动化草稿中选择，并在不支持的旧被控端上静默降级为只列 B 本机引擎。
  来源名单或链接状态变化时丢弃该任务电脑的引擎目录与在途读取。重新发现来源后，只为已打开任务回读仍可用的来源。
- **暂未开放**：插件引擎加入供应商组（电脑组）或备用机委托、转分享(`relayKey`)、协同 Worker 跨机运行插件引擎。这些入口保持明确拒绝。（注：本机插件引擎任务的分叉与回退已于 2026-11-27 #13001 支持；Agent 在另一台电脑上运行时的冷恢复回退仍受 `session-regressions.md` 同口径约束。） 跨电脑或直连分享插件引擎的分叉与侧边追问于 2026-11-27 开放：沿用从 Cindy 记录交接的新会话路径(`sdk_session_id = null`)，子任务首轮启动时仍由执行端完整复核准入。


实现见 `maker-host/pluginEngineRemoteUse.ts`、`device-link/providerShareHost.ts`、`device-link/providerShareRuntime.ts`、`device-link/dispatch.ts`、`remote-agent/host/service.ts`、`remote-agent/host/runHost.ts`、`remote-agent/controller/service.ts`、maker-core `agents/acp/acp-agent.ts`；远程控制下的来源与代读见 `maker-ipc/controlledModelCatalog.ts`、renderer `lib/pluginEngineSelection.ts`(`controlledPluginEngineSources`)与 `hooks/usePluginEngines.ts`；回归见 `roundtrip.test.ts`、`providerShareDispatch.test.ts`、`pluginHarnesses.test.ts`、`nodeRuntimeBroker.test.ts`、`pluginEngineSessionAdmission.test.ts`、`PluginEnginesSection.test.tsx`、`PluginEngineRemoteUse.test.tsx`、`controlledModelCatalog.test.ts` 与 `newMakerDraftSubmission.test.ts`。

## 插件引擎进入模型供应商列表（2026-11-22）

这台电脑上已启用、已批准的插件声明的引擎，同时列在「设置 → 模型供应商」左栏(名字后带「插件」标识)，插件停用或
卸载后随引擎列表消失。只在视图与设置层和普通供应商并列：`@cindy/model-providers` 的类型、普通供应商的目录、
排序与停用存储(`model-disable-prefs.json`、供应商顺序、`local-codex-provider-prefs.json`)都不改，不增加 manifest
字段、权限行、批准状态或安装迁移，存量插件影响：无。产品约定见[供应商设置](../../product-rules/provider-settings.md)。

- **设置存储**：按账号的 `owners/<账号>/plugin-engine-prefs.json`，
  `{ engines: { "<插件实例>:<引擎 id>": { name?, hidden?, suspended?, disabledModels? } } }`，只记用户改过的项，
  恢复默认即删除对应字段(整项为空时删除键，文件为空时删除文件)。显示名 ≤64 字符，关闭的模型 ≤200 个、id ≤256 字符，
  最多 256 个引擎；文件缺失、损坏或形状不对按「没有设置」读取，不会把引擎读成停用。插件停用再启用保留设置。
  「允许被远程调用」仍在 `remote-provider-access-prefs.json`，不搬动。
- **写入通道**：`maker:set-plugin-engine-prefs`，正文 `{ key, name?: string | null, hidden?, suspended?, models?: { ids, disabled } }`，
  只改出现的字段，返回写入后的引擎视图(插件已不在时为 `null`)。只在本机窗口可用，不进 device-link allowlist；
  device-link 调用 `PERMISSION_DENIED`，形状或长度不对、关闭引擎没列出的模型 `INVALID_PARAMS`，给已不在列表里的
  引擎写入新设置 `NOT_FOUND`(撤销已有设置始终允许)。写入后照常经 `maker:plugin-engines-changed` 推完整列表。
- **`maker:list-plugin-engines` 的变化**(既有字段的新取值 + 追加可选字段，旧端无需升级)：
  - 有模型被关闭时，`defaultModelAllowed: false` 禁止回退到由引擎自行决定的默认模型。默认模型可能选中被关闭的模型，
    因此本机和远程执行端也拒绝该请求。恢复全部模型后恢复原默认行为。
  - 用户起的显示名直接作为 `name`；关掉的模型不在 `models` 里；停用的引擎报 `availability: { state: 'unavailable', reason: 'suspended' }`
    (不带 `message`，避免旧手机把主进程语言的文案原样显示)。旧手机与旧电脑本来就把 `unavailable` 的引擎排除在新任务之外。
  - 追加可选 `hidden: true`、`suspended: true`。新版桌面与手机的模型选择器不列 `hidden` 的引擎(当前任务已选着它时保留)；
    旧端不认识 `hidden`，照旧列出，隐藏只改陈列，不构成越权。
  - 追加可选 `declaredName`(有显示名时的插件原名)与 `disabledModels`(关掉的模型)，只给本机窗口的设置页；
    device-link 回包(手机、同账号其他电脑、分享受邀者)在 `remotePluginEngineViews` 去掉这两项。
  - 没有任何设置时回包与此前逐字段一致，不多出字段。
- **借用方不受主人的「隐藏」影响**：另一台电脑或受邀者借用引擎时(`parseOfferedPluginEngines`、
  renderer `remotePluginEngineChoices`)去掉 `hidden`、`suspended`、`declaredName`、`disabledModels`；停用的引擎因
  `unavailable` 不再开放。
- **准入**(在装着插件的电脑上判定，前端不列出不算边界)：停用的引擎与关掉的模型不能开新任务、不能把任务换过去、
  不能用于自动化与协同 Worker(`admitPluginEngineSession` / `admitPluginEngineSwitchTarget`)；停用的引擎不对同账号
  其他电脑和分享受邀者开放(`isPluginEngineOfferedRemotely` / `isPluginEngineOfferedToGuests`)，远程调用开关原样保留，
  启用后恢复；关掉的模型在执行端的 `pluginEngines.isOffered`(`remote-agent/host/service.ts`)同样拒绝，与
  `remoteModelAccess` 的模型范围叠加。隐藏不参与任何准入。本机已在运行的任务不被打断；其他电脑与受邀者的任务沿用既有的逐轮实时复核，
  停用或关掉模型后从下一轮起被拒绝(与关闭「允许被远程调用」相同)。
- **中转**：走既有 invoke 帧与既有只读 channel，没有新帧、新 channel 进 allowlist 或恢复语义变化，官方与自建中转
  原样转发回包里多出的可选字段，无需修改；未做互通重跑，依据是 device-link 包与 allowlist 均无改动。
- **设置页列出同账号其他电脑开放的引擎**(2026-11-23 补齐)：renderer `OwnRemotePluginEngines.tsx` 复用新建任务模型
  选择器的按电脑目录缓存(`useDevicesPluginEngines`)与筛选(`remotePluginEngineChoices`)，只列 `isPluginEngineOfferedRemotely`
  的引擎，只读展示。读取量：打开「模型供应商」页时向每台在线、允许远程控制的同账号电脑各发一次既有的只读
  `maker:list-plugin-engines`(后台档；与模型选择器共用 15 秒内不重读)。列表可见时，新上线或重连的电脑可补读，
  复用重连预取，不轮询；进入分享管理页则释放列表订阅。
  打开某一项详情时与模型选择器同一时机发一次 `maker:refresh-plugin-engines`(按电脑 60 秒冷却)并在 2.5 秒后复读。
  该引擎带 `reportsUsage` 时，详情还经既有只读的 `maker:get-plugin-engine-usage`(后台档)读一次那台电脑的账号用量，
  与本机详情同一组件，打开详情和窗口重新获得焦点时读，与无任务上下文的额度预览共用按电脑、按引擎一分钟内的读取，不轮询；
  不带 `reportsUsage` 的引擎不读。
  没有新 channel、新字段或 allowlist 变化，旧电脑回 `CHANNEL_NOT_ALLOWED` 时不列出(用量读失败时不显示用量)。
- **暂未提供**：与普通供应商混排的拖动排序、模型选择器里的「已隐藏」展开区、供应商组与引擎切换。

实现见 `maker-host/plugin-engine-prefs-store.ts`、`maker-ipc/pluginEnginesIpc.ts`、`maker-ipc/pluginEngineSessionAdmission.ts`、
`maker-host/pluginEngineRemoteUse.ts`、renderer `components/settings/PluginEngineProviders.tsx` 与 mobile
`session/pluginEngines.ts`；回归见 `plugin-engine-prefs-store.test.ts`、`pluginEnginesIpc.test.ts`、
`pluginEngineSessionAdmission.test.ts`、`PluginEngineProviders.test.tsx`、`providersSectionDeepLink.test.tsx`、
`PluginEnginesSection.test.tsx` 与 mobile `pluginEngines.test.ts`。

## 引擎账号用量

执行引擎通过 `PUT /harnesses` 的可选布尔标志 `reportsUsage: true` 表示其主 JSON-RPC worker
可以处理 `usage({harnessId})`。Host 在调用及返回前检查该实例、批准和可用状态，broker 校验当前账号。
主进程只把校验并裁剪过的 `GhostHarnessUsage` 返回给发起读取的界面；快照不落盘，也不进入模型列表广播。
快照使用毫秒时间戳，最多 24 个窗口和 8 个币种余额。读取失败或未提供数据时显示为空，零值保留。
额度预览按账号代次、执行电脑、引擎共用在途读取与一分钟缓存。按任务读取时额外区分任务 ID，桌面借用引擎与远程查看宿主任务也各自缓存。隐藏期间缓存到期只释放数据，账号切换后丢弃原账号的回包。
模型目录刷新保留仍可上报用量的引擎读数。引擎被移除或停止上报时，控制端清掉该引擎的缓存并丢弃迟到的回包。手机暂时连不上执行电脑时保留上次读到的目录。

同账号配对设备通过只读 `maker:get-plugin-engine-usage(key)` 查询执行电脑；SSH、分享访客与未配对调用没有账号用量入口。
旧插件继续使用现有状态与模型，新插件在旧 Host 上仍可在自己的设置页获取用量。旧 Host 缺少该 channel 时控制端按无数据处理。
支持区分 worker 错误的执行电脑会通过现有 invoke 错误返回临时读取失败。系统栏和小组件保留该引擎的上次读数、显示读取时间，并按已有失败节奏重试。成功的空读数和读取期间账号或授权失效仍返回空；旧版执行电脑返回的空值也按空读数处理。
既有 Device Link invoke 帧和自建中转可原样转发，无需扩展中转协议。该变更不增加 manifest 权限、批准或安装迁移。

## 引擎账号（多账号，2026-11-23，未发布）

产品规则见[插件引擎的账号](../../product-rules/subscription-account-pools.md#插件引擎的账号2026-11-23-用户裁决未发布)。
全部为 append-only 可选字段、宿主固定参数和新的 worker 方法，不改 manifest、权限行、批准状态或安装布局；存量插件影响：无
（旧插件不发布 `accounts`，引擎照旧单账号；回归见 `pluginHarnesses.test.ts` 与 `ghostHarnessesEndpoint.test.ts`）。

1. **声明**：`PUT /harnesses` 条目追加可选 `accounts: { methods: [{ id: slug, label: ≤64, kind: 'browser' | 'secret', secretLabel?: ≤64 }] ≤4 }`，
   只在 `available: true` 时保留，且主 worker 为 `json-rpc-stdio` 时注册表才投影。`methods` 为空数组表示只报告原有登录的身份、不能添加账号；
   至少一项表示支持多账号。形状错误、重复 id 按整份 400；本版不认识的 `kind` 跳过（新插件在旧 Host 上不丢其它方式），`secretLabel` 只随 `secret` 保留。
   旧 Host 丢弃该字段，插件照旧单账号。
2. **启动参数**：任务分到 Cindy 添加的账号时，`spawnHarness` 在既有参数后追加两项 `--cindy-account-dir <绝对路径>`。目录由 Host 建在
   `owners/<账号>/plugin-engine-accounts/<插件实例>/<引擎 id>/<账号 id>/`，注册表核对它是这个引擎根目录下的一级子目录、引擎声明了登录方式，
   否则拒绝启动；插件没有参数面。入口必须让外部 Agent 的登录、写入的设置与会话历史只用这个目录，做不到就写 stderr 并以非零状态退出，
   不得回落到原有登录。与 `--cindy-remote-workspace` / `--cindy-guest-workspace` 可同时出现，分享模式的隔离以这个目录为来源。原有登录不带此参数。
3. **worker 方法**（主 JSON-RPC worker，经 broker `handleRequest`；注册表调用前后复核实例、批准、可用状态与 owner）：
   - `accountStatus({ harnessId, accountDir? })` → `null` 或 `{ state: 'signed-in' | 'signed-out', identity?: { email?: ≤254, name?: ≤80, detail?: ≤80 }, plan?: ≤64, fingerprint?: ≤128, models?: string[] ≤200 }`。
     不带 `accountDir` 指原有登录。文字字段为不含控制字符的纯文本，形状不对的可选字段丢弃、不拒整份；`fingerprint` 只用于识别同一账号重复登录
     （调度只计一次），不显示、不出 Main；`models` 缺省表示与引擎清单相同。26 秒超时。
   - `accountLogin({ harnessId, accountDir?, methodId, secret? })` → `{ ok: true }` 或 `{ ok: false, error: 'cancelled' | 'timeout' | 'busy' | 'unsupported' | 'invalid-secret' | 'failed', message?: ≤200 }`；
     不带 `accountDir` 是重新登录原有登录。以 broker 的「有动静就续期」调用：沉默窗口 60 秒、最长 11 分钟，浏览器登录等待期间 worker 要定期发进度或写 stderr。
     `secret` 只在 `kind: 'secret'` 时出现（1–4096 字符）；只来自本机窗口的 Cindy 弹窗，经 Main 直接交给 worker，Cindy 不落盘、不进日志与模型；
     device-link 带 `secret` 的命令一律 `PERMISSION_DENIED`，Helper 的工具参数没有这个字段。Host 在登录返回后再用 `accountStatus` 确认。
   - `accountLoginCancel({ harnessId, accountDir? })` → `{ ok: true }`，结束对应的登录等待。
   - 既有 `usage` 追加可选参数 `accountDir`（只发给声明了登录方式的引擎；旧插件收不到，避免把原有登录的用量当成每个账号的用量）；
     窗口追加可选 `windowMinutes`（1–527040，窗口长度，用于按急迫度排序）与 `models`（该窗口只约束这些模型，缺省约束全部模型）。
4. **错误类型**：入口在 `session/new`、`session/load`、`session/resume`、`session/prompt` 的 JSON-RPC 错误里可带
   `error.data._meta.cindy = { kind: 'usage-limit' | 'auth-required' | 'overloaded', resetsAt?: 毫秒, model?: string }`。maker-core 把会话打开时的分类映射为
   `AcpAccountError`（消息用 Cindy 稳定码 `[SUBSCRIPTION_ACCOUNT_LIMITED]` / `[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED]`，并立即结束这个入口进程，让账号池能换下一个账号），
   运行中的分类映射为终态错误字段 `usageLimit` + `usageResetAt` / reason `acp-auth-required` / `errorStatus: 529`。既有 `-32000` 仍按需要重新登录处理；
   不认识的 `kind` 按普通错误处理；旧 Cindy 忽略 `data`。插件给的 `resetsAt` 是普通任务等重置后自动继续的唯一时间来源，不解析插件错误原文。
5. **拿出的单独供应商**：`providerId` 为 `acp-plugin:<插件实例>:<引擎 id>~<8 位小写字母数字>`。引擎 id 不含 `~`，maker-core
   `acpHarnessKeyFromProviderId` 与新版注册表据此拆出引擎；旧端按引擎键查不到而判为不可用，不会落到其他引擎或账号。
   `maker:list-plugin-engines` 把它列为一项：`key` 为 `<引擎键>~<后缀>`，追加可选 `accountProviderOf`（所属引擎键），沿用引擎的模型与模式，
   `remoteUse` 恒为不支持（不对其他电脑与分享开放）；显示名、隐藏、停用按自己的键存在 `plugin-engine-prefs.json`。
6. **Device Link 与 IPC**：账号管理沿用既有 `maker:subscription-accounts`（账号命令与只读 `session` 探测的 `providerId` 均接受插件引擎 id；`session` 查询仅面向本机或同账号其他电脑，分享受邀者与共享任务访客一律 `PERMISSION_DENIED`，执行端仅在引擎开放远程调用且模型允许时回报绑定账号是否停用/移出/受限及是否有替换账号可接手，不带身份与目录；`add`/`login` 追加可选
   `methodId`；视图追加可选 `pluginEngine`、账号用量 `usage.plugin`、`authIssue: 'account-mismatch'`）与推送 `subscription-accounts:changed`
   （插件引擎的 providerId 也会出现，旧界面按不认识的 providerId 忽略）。旧执行电脑以 `INVALID_PARAMS` 拒绝插件引擎 id（含 `session` 探测），控制端按不支持降级为原路径（不交接上下文、不自动换号）。
   `maker:list-plugin-engines` 视图追加可选 `accounts`（登录方式，不含秘密）。`maker:get-plugin-engine-usage` 追加可选第二参数 `{ sessionId }`：
   读该任务所绑账号的用量（本机窗口：未分配时为空）；device-link 调用（手机、同账号远控）带上时，执行电脑认识这个任务就读它所绑账号，
   同账号控制端借用本机引擎时另带可选的 `hosted: true`，执行端用经验证的调用设备和原任务 ID 查托管任务绑定。未找到绑定时沿用引擎原有登录；旧 Host 忽略多余参数。
   均为既有 invoke 帧与 channel 的可选字段或新取值，没有新 channel、relay 帧或 allowlist 变化，官方与自建中转原样转发，无需修改。
7. **存储**（均按 Cindy 账号隔离）：`owners/<账号>/plugin-engine-accounts.json`（各引擎的账号设置、拿出的供应商与归属、任务与原生会话绑定）、
   `owners/<账号>/plugin-engine-account-cooling.json`（与 `subscription-account-cooling.json` 同格式，单独存放：旧版写内置账号冷却会丢掉它不认识的键），
   以及上面的账号目录。卸载插件时删除它引擎的账号设置、绑定与目录；停用保留。

实现见 `packages/plugin-protocol/src/pluginHarnesses.ts`、`cindy-brain/pluginHarnesses.ts`、`nodeRuntimeBroker.ts`（`spawnHarness`）、
maker-core `agents/acp/{protocol,session,acp-agent}.ts`、`main/plugin-engine-accounts/`（`store`、`runtime`、`agent`、`failover`）、
`subscription-accounts/{commands,service,ipc}.ts`、`maker-ipc/pluginEnginesIpc.ts` 与 renderer `SubscriptionAccountsSection.tsx`、`PluginEngineSignIn.tsx`；
回归见 `plugin-engine-accounts/__tests__/runtime.test.ts`、`pluginHarnesses.test.ts`、`ghostHarnessesEndpoint.test.ts`、maker-core `acp-session.test.ts`
「account classification」「account the host picked」与 renderer `SubscriptionAccountsSection.test.tsx`「for plugin engines」。

## 插话（2026-11-22）

Cindy 与引擎入口之间的 ACP wire 追加一个可选扩展，沿用生态已有约定（claude-agent-acp 0.109、codex-acp、oh-my-pi），不自创方法：
Agent 在 `initialize` 结果**顶层** `_meta.steering.supported === true` 时，`sameTurnSteer` 为支持，运行中的插话发请求
`_session/steering`，参数 `{ sessionId, prompt: ContentBlock[], _meta: { steering: { idleBehavior: 'promptRequired' } } }`。
结果 `injected` 为受理；`queued`（如 `zcode-acp` 在当前轮无法中段注入时由引擎内部排队受理）按已受理处理且不提前截断当前回复段；
`promptRequired` 按「没有进行中的回合」交给宿主改为下一轮发送；`startedNewTurn`（不认识
`idleBehavior` 的旧适配器自己开了一轮）按受理处理，输出按回合外工作显示；其他结果或 JSON-RPC 错误按未受理处理；
已发出但超时或连接断开按「送达未知」（`delivery uncertain`）交给宿主，队首保留并暂停，不重发。Agent 声明了却回
method-not-found 时本会话撤回插话能力，之后的插话排队，并通过 `AgentSessionHandle.onCapabilitiesChange` 立即同步到
远程 Agent 状态帧与输入投影。

兼容：没有声明的 Agent（含全部存量插件引擎）`sameTurnSteer` 仍不支持。旧版 Cindy 从不发送该请求。
远程与分享任务的能力沿用既有 `negotiatedCapabilities` 状态带回控制端，`steer` 沿用既有 remote-agent 方法与受邀者实时复核，
运行中能力变化经 `onCapabilitiesChange` 即时推送给控制端与输入协调器；新旧控制端与被控端任意组合都按被控端握手结果决定是否插话；
不新增 manifest 字段、权限、批准、channel 或中转帧。
实现见 maker-core `agents/acp/protocol.ts`、`capabilities.ts`、`session.ts`、`agents/base-agent.ts`、`session.ts` 与
remote-agent `host/runHost.ts`、`controller/proxyHandle.ts`；回归见 `acp-session.test.ts`「AcpSession same-turn steering」与
`roundtrip.test.ts`「propagates runtime capability updates」。

不支持插话时的呈现（同日；手机端于 2026-11-26 对齐）：输入协调器（Desktop 与 Node Host 共用）在会话 `sameTurnSteer` 不支持时，界面发起的插话不再
交给引擎报 `UNSUPPORTED_CAPABILITY`，而是按「这一轮结束后发送」排队（队列行插话移到队首，输入框插话排到队尾），不显示错误；
控制面严格插话（`fallbackToTurn: false`）照旧返回未插入。`AgentInputProjection` 追加可选 `steerUnsupported?: boolean`，
只在确知不支持时为 `true`，经既有输入 projection 推给本机界面、控制端与手机。新版桌面与手机界面据此隐藏插话入口（输入框按排队发送、
排队消息菜单不出现插话），队列等待时在消息流末尾显示一行说明。旧被控端不带该字段，新界面按支持处理，行为与以前相同；
旧控制端与手机忽略该字段，仍显示插话入口，点击后由新被控端排队，不再报错。不新增 channel 或中转帧，自建中转原样转发。
回归见 `agent-input-coordinator.test.ts`「sends a steer after this turn」、renderer `pendingQueueRowPresentation.test.ts`「PendingQueueBubble steer action」、
`maker-shared/src/__tests__/queue.test.ts` 以及 mobile `inputProjection.test.ts`、`InlineQueueSection.test.tsx`、`PendingSendBubble.touch.test.tsx`。

## `/` 菜单里的 Skill（2026-11-25）

`maker:list-agent-skills` 的 `agentKind` 新增取值 `acp`：插件引擎任务的 `/` 菜单向执行电脑上的插件引擎读取它展开
`/<skill>` 用的 Skill 清单（`AcpAgent.listAgentSkills`，与首轮 Skill 清单同源），返回既有 `AgentSkillCommand` 形状，
`runtimeCommandName` / `runtimeStatus` / `origin` 不出现。这是既有字段的新取值，channel 早已在 allowlist：新控制端对旧被控端
发出时旧端以 INVALID_PARAMS 拒绝，菜单按读取失败不列 Skill（旧被控端的引擎也不展开 `/<skill>`，不会列出点了没用的项）；
旧控制端从不发出。Node Host（`/api/agent-skills`）装配了插件引擎，在 `acp` 已注册时与桌面同样经 `maker.listAgentSkills` 返回该引擎的 Skill 清单（未注册时回「未注册」，不按 Claude 列清单）。
不新增 channel、中转帧或字段，自建中转原样转发，无需同步修改。
实现见 desktop `maker-ipc/register.ts`、maker-core `agents/acp/acp-agent.ts`、host `agent/agent-skills.ts`；回归见
`acp-session.test.ts`「lists for the `/` menu」、renderer `slashCommands.test.ts`「plugin engine Skills」与 host `boundary.test.mjs`「25b L1」。

## Worktree（2026-11-25）

远程控制另一台电脑的项目、在插件引擎上新建任务并勾选 worktree 时（桌面控制端与手机），沿用内置引擎的两步创建：先向被控端发
既有 `worktree:create`（带预生成 `sessionId` 与 `recoveryKey`），再以检出路径与同一 id 发既有 `maker:create-session`
（`agentKind = acp`）。被控端两个 channel 都不按引擎区分，旧被控端同样接受；被控端未声明 `recoveryKey` 回收能力时控制端
不发起（与内置引擎同一门）。项目在本机、引擎在同账号另一台电脑时，本机 `local-db:sessions:create` 的 `localPluginWorktree`
接受 `agentDeviceId`（只在本机检出，不跨端）。协同 Worker 的 `worktree` 与定时任务的 `useWorktree` 见上文。不新增 channel、
中转帧或字段，自建中转无需改动。回归见 renderer `newMakerDraftSubmission.test.ts`「local plugin engine worktree submission」、
main `sessionsUpdate.test.ts`「plugin engine runs on another computer」、`orcaWorkerCreationService.test.ts`「plugin engine Worker」
与 `runnerModelSelection.test.ts`「plugin engine schedules」。

## 与内置引擎一致的其余入口（2026-11-25）

- `maker:predict-prompt` 的 `agentKind` 新增取值 `acp`（插件引擎任务的输入推荐）。新控制端对旧被控端发出时旧端以 INVALID_PARAMS
  拒绝，推荐按读取失败不显示；旧控制端对插件引擎任务仍报内置值，新被控端按引擎不一致不派发（与此前一样没有推荐）。
- `maker:generate-title` / `maker:auto-title` 的 `agentKind` 接受 `acp`（只用辅助模型）。旧被控端拒绝，标题保持占位。
- `session_goals.agent_kind`、目标状态的 `agentKind` 可为 `acp`（列无 CHECK 约束，只放宽 TS 枚举，无需迁移）。旧版读到 `acp`
  目标时不恢复该任务（与旧版行为一致），不会在内置引擎上运行。
- /learn 不新增字段或 channel。自建中转无需改动。

## 独立任务新建支持插件引擎（2026-11-27）

- **Agent 工具**：`send_to_session`（create 模式）的 `agent_kind` 新增取值 `acp`，配合 `provider_id`（`acp-plugin:<插件>:<引擎>`，取自 `list_available_models` 的 `plugin_engines[].provider_id`；来源本身已是插件引擎且未换引擎时可省）、`model`（省略或 `default` 由引擎自选；有模型关闭或受限时不可用 `default`）与 `effort`（按该模型的 `efforts` 严格校验，不支持 `fast`）。支持本机插件引擎、同账号其他电脑与已收到插件引擎分享（`provider_device_id` / 兼容旧名 `agent_device_id`），以及在同账号另一台电脑上新建插件引擎任务（`device`）。`list_available_models` 的 `agent` 枚举同步追加 `acp`，并在查询远程电脑或插件引擎分享位置时返回其开放的 `plugin_engines`（不向内置供应商分享发插件引擎目录请求）；向另一台电脑查询 `agent: 'acp'` 时经既有 `maker:orca:remote-worker:models` 省略 `agent` 参数并在本机裁剪，不向旧电脑发未知枚举值。
- **跨电脑新建协议（`maker:session:handoff`）**：`task-action-capability` 探测回包追加可选能力位 `ordinaryCreatePluginEngine: 1`（仅 Desktop 声明，Node Host 不声明）；`remoteSessionCreationSchema` 的 `agentKind` 新增取值 `acp`、追加可选字段 `providerId`（仅 `agentKind === 'acp'` 时出现，内置引擎新建载荷与回执操作串字节不变）。发送端在发起带 `agentKind: 'acp'` 或 `providerId` 的远程新建前复核 `ordinaryCreatePluginEngine === 1`，旧版电脑或 Node Host 缺少该位时在发送前以 `REMOTE_UNSUPPORTED` 拒绝，不创建任务。发送端对 `maker:session:handoff` 成功回包的 `agentKind` 校验同步接受 `acp`（覆盖跨电脑新建与既有插件引擎任务的 jump 投递）。不新增 channel、allowlist、relay 帧或服务端字段，官方与自建中转按既有 invoke 帧透明转发，无需同步修改。
- **实现与回归**：`packages/lizi-mcps/src/xdt-helper/{send_to_session,list_available_models}.ts`、`packages/device-link/src/orcaRemoteWorker.ts`、`apps/desktop/src/shared/remoteSessionCreation.ts`、`apps/desktop/src/main/maker-ipc/{sendToSessionExecutionConfig,remoteSessionCreation,sessionHandoffCore,register}.ts`、`apps/desktop/src/main/mcp-integrations/{sessionHandoffRemote,mcp-providers}.ts`、`apps/host/src/agent/session-handoff.ts`；回归见 `sendToSessionTool.test.ts`、`listAvailableModelsTool.test.ts`、`sendToSessionExecutionConfig.test.ts`、`sendToSessionLazyResumePermission.test.ts`、`sessionHandoffIpc.test.ts`、`sessionHandoffRemote.test.ts` 与 host `device-link.test.mjs`。

## 设置页打开引擎的供应商页（2026-11-27，未发布）

- **页面接口**：插件页面同源 `POST /harnesses/open-settings`，请求体 `{"id":"<本插件声明的引擎 id>"}`（只此一个字段，
  ≤256 字符，不带 query）。成功 `200 {"ok":true}`；`400` 请求体不合格，`403` 引擎未声明或没有紧跟用户操作，
  `405` 非 POST，`503` 没有可显示设置的主窗口。只导航，不读写任何设置。页面可用不带副作用的 `GET` 探测是否支持：
  支持的宿主回 405，不支持的回 404；这两个状态码是对插件的约定，不要改成别的。
- **本机内部事件**：Main → 主窗口 `deep-link:navigate` 新增 payload `{ type: 'plugin-engine-settings', engineKey }`，
  Renderer 路由 `/settings?tab=providers&pluginEngine=<引擎 key>`（一次性参数，消费后从 URL 摘除）。两者都只在同一台
  电脑的同一版本内使用，不跨设备、不落盘，没有对应的 `cindy://` 链接。
- **旧端与其他端**：旧 Desktop、Node Host、手机页和远程设置页对该路径返回 404，插件保留文字引导即可；不新增
  device-link channel 或 allowlist，自建中转无需改动。
- **实现与回归**：`apps/desktop/src/main/cindy-brain/runtime/{ghostEngineSettingsEndpoint,ghostPageHandler}.ts`、
  `apps/desktop/src/main/deepLink.ts`、`apps/desktop/src/renderer/components/settings/ProvidersSection.tsx`；
  `ghostEngineSettingsEndpoint.test.ts`、`deepLink.test.ts`、`providersSectionDeepLink.test.tsx`。

## 插件模型选择、插件任务与搜索筛选（2026-11-27）

- **插件模型选择与插件任务**：`PluginModelSelection`、`PluginTaskPreferences.config`、`PluginTaskRoute`、`tasks-request`（`taskSlot` / `pluginTargetSlot` / `pluginTargetReview`）与 `MobileTaskSettings` 的 `agentKind` 新增取值 `acp`（此时 `providerId` 必为 `acp-plugin:<插件>:<引擎>` 且 `fastMode === false`）。本机与远程位置分别按对应电脑的插件引擎目录实时复核；插件「模型与任务」设置页在选了插件引擎时，快问快答（`cindy.text.oneshot`）与远程模型同口径回落到声明／系统辅助模型链，不借本机内置供应商。未升级的旧控制端不会发出 `acp`；新控制端发给旧被控端时旧端以 `INVALID_PARAMS` / `PLUGIN_SETTINGS_INVALID` 明确拒绝，不会静默切到内置引擎。
- **搜索、筛选与历史读取**：会话搜索（`ConversationSearchAgentKind`、`local-db:conversations:search`）、侧栏与手机首页 Harness 筛选、`cindy_helper` 历史工具（`list_sessions` / `get_chat_history` / `search_chat_history`）及 `local-db:history:messages` 的 `agentKind` 新增取值 `acp`，且会话搜索返回行保留 `agentKind: 'acp'` 而不再压成 `'cc'`。旧被控端收到显式 `acp` 过滤时以 `INVALID_PARAMS` 拒绝，`all` 与既有内置取值不变。
- **远程灵动岛**：`applyDeviceSessionMeta` 保留远程任务 `agentKind = 'acp'`（插件引擎的 `/review` 只读审查沙盒已由下方「附加目录、只读 `/review` 与共享任务」支持）。
- 均属既有字段的新取值，不新增 channel、allowlist 或中转帧，官方与自建中转无需修改。

## 每轮权限闸（2026-11-25）

IM 群聊、访客与个人微信的轮次带宿主的 `turnPermissionPolicy`（哪些工具调用必须由人确认）。内置引擎在执行前的审批点执行它；
ACP Agent 不问就执行的调用 Cindy 看不到，所以 ACP wire 追加一个 Cindy 扩展（ACP v1 没有对应约定）：
Agent 在 `initialize` 结果**顶层** `_meta.permissionGate.supported === true` 时，会话能力 `turnPermissionPolicy` 为支持，
`unsupportedPermissionModes` 为 `['bypassPermissions']`（Cindy 的「全部允许」会自动同意请求）。带策略或只许文字回复
（`toolsDisabled`）的轮次，`session/prompt` 参数的 `_meta.permissionGate` 带 `scope: 'all-tool-calls'`，Agent 在这一轮
及其答完后继续的工作里执行任何工具前都发 `session/request_permission`。声明支持后，所有轮次（包括普通轮次）的
请求参数都带 `_meta.permissionGate.turnId`，Agent 在每个审批请求的同名字段回传发起该工作的轮次 ID。宿主仅处理当前
轮次的审批请求，空闲时处理最近正常结束的轮次；已被新轮次取代、被取消或无法关联的请求拒绝。
`routine: true` 表示 Agent 自己的规则本不会询问。宿主合并同一工具调用 ID 的已有字段，按 ACP `kind` 映射频道工具名，
并检查自定义工具名。仅当操作和输入可识别且规则均允许时自动选 `allow_once`；执行命令必须提供 `rawInput.command`。
IM 轮次只有已知的读和搜索操作可以经上述条件直接放行，写文件、运行命令等仍走渠道审批。普通 IM 私聊的审批也按 ACP
工具类型和引擎名称做安全检查。策略回调抛错按需要确认处理。主人运行中切到「全部允许」时，已受理的轮次按新档位处理，
新策略轮仍按渠道原有准入规则。`toolsDisabled` 轮次拒绝全部请求（「全部允许」也拒绝）。
策略轮插话只进入同样带闸的轮次（运行中的轮次没带闸时回「没有进行中的回合」，宿主改为下一轮发送），并只叠加限制。
没有声明的 Agent：策略轮在受理前以 `TurnPermissionPolicyUnsupportedError('acp', mode)` 拒绝，IM 按「当前引擎不支持」提示；
`toolsDisabled` 轮次照旧运行（行为与本扩展之前相同）；未声明支持的引擎也不接收上述 `_meta.permissionGate`。

兼容：全部存量插件引擎不声明，行为只有「IM 策略轮被明确拒绝」这一处可见，此前这些任务整体不接 IM。不新增 manifest 字段、
权限、批准、安装布局或包格式，已装插件无需重装或重新确认（存量插件影响：无）。远程与分享任务的能力沿用 `negotiatedCapabilities`
带回控制端；控制端 IM 在插件引擎任务的能力未声明支持时于发送前拒绝策略轮，所以被控端仍是旧版（其 ACP 会话忽略发送选项）
时 fail-closed，不会无闸运行。不新增 channel、中转帧或 IPC。实现见 maker-core `agents/acp/{protocol,capabilities,session}.ts`
与 Desktop `im/shared/turnRunner.ts`；回归见 `acp-session.test.ts`「AcpSession per-turn permission gate」与
`channelToolPolicy.test.ts`。

## 插件引擎模型收藏（2026-11-26）

插件引擎模型（Desktop 与 Mobile 统一模型选择器）复用既有收藏存储（`xdt:modelFavorites:v1`）与既有 Device Link 收藏通道（`maker:model-favorites:get` / `apply` / `changed`），不新增 wire 字段、channel、allowlist 或中转帧，官方与自建中转无需修改：

- **编码与兼容**：`providerId` 为本机引擎的 `acp-plugin:<插件实例>:<引擎 id>`，或按既有复合键包一层 `agent-device-favorite:`（同账号另一台电脑的引擎）/ `provider-share-favorite:`（收到的插件引擎分享）；`modelId` 为引擎模型 id 或 `default`；`effort` 为可选规范档位键；`agent` 固定写 `PLUGIN_ENGINE_FAVORITE_WIRE_AGENT`（`'cc'`，定义在 `packages/device-link/src/modelFavorites.ts`）。不发 `agent: 'acp'`——旧 Desktop 与旧 Mobile 的 `parseModelFavorites` 只接受 `cc | codex | pi`，否则会整表拒绝。旧端读到该条目后整表解析通过，因 `acp-plugin:` / 复合前缀不在内置供应商目录中而静默隐藏，不会报错也不会误派到内置引擎，单条增删改不会误删该条目；新端解析时以 `acp-plugin:` 识别插件引擎收藏并忽略 `agent`。
- **解析与准入**：桌面与手机按完整插件引擎目录（含 `hidden: true` 的引擎，与内置隐藏供应商同口径）解析收藏；引擎不可用（未登录 / 已停用）、模型被关闭或 `defaultModelAllowed: false` 时不展示但不删除原收藏。写入远控通道（被控电脑 / 手机）时遵守 512 字符通道上限。
- **插件路由模型（`GhostPickerModel`）**：仅在本机桌面新任务草稿提供，收藏按账号存在本机 `localStorage`（`cindy:pluginModelFavorites:v1`），与模型组收藏（`cindy:modelGroupFavorites:v1`）同口径，不跨设备同步、不进收藏同步协议。
- **实现与回归**：`packages/device-link/src/modelFavorites.ts`（`PLUGIN_ENGINE_FAVORITE_WIRE_AGENT`）、desktop `renderer/lib/pluginEngineFavorites.ts`、`PluginEnginesSection.tsx`、`UnifiedModelPanel.tsx`、`pluginModelFavorites.ts`、`PluginModelsSection.tsx` 与 mobile `session/pluginEngines.ts`、`UnifiedModelPickerSheet.tsx`、`UnifiedModelPickerView(.ios).tsx`；回归见 `packages/device-link/src/__tests__/modelFavorites.test.ts`、desktop `PluginEnginesSection.test.tsx`、`PluginModelsSection.test.tsx` 与 mobile `pluginEngines.test.ts`、`unifiedMobilePicker.test.tsx`、`unifiedMobilePickerView.test.tsx`。

## 轮次变更集与 `.cshare` 分享／任务迁移（2026-11-27）

1. **轮次变更集（`turn-change-set`）**：`TurnChangeProvider` 扩展加入 `'acp'`（`apps/desktop/src/shared/turnChangeSet.ts`、
   `turn-change-set/store.ts`、`dispatchBoundary.ts` 及远程 Agent 控制端 `remote-agent/controller/{startRemote,service}.ts`）。
   派发入口不再用 `hasBuiltinAgentKind` 跳过插件引擎，每轮均建立基准锚点；本机 ACP 会话仅把审批放行前的磁盘快照（含等待同路径
   在途采集完成再放行）与 `tool_call` / `tool_call_update` 中的结构化 `diff` 内容块视为可靠前像，绝不把通知时的非阻塞磁盘读取当作
   可靠基准，对命令执行、无路径或仅晚到路径而无审批前快照/精确 `diff` 的写工具保留 `opaque-tool` 不完整标记；远端执行的插件引擎任务经
   既有 `RemoteExecutor` 在真实工作区捕获并保留 `provider: 'acp'`。不新增 IPC / device-link channel、manifest 字段或中转帧；旧控制端
   按既有摘要形状读取 `TurnChangeSetSummary`，不识别具体 provider 枚举值，完全兼容。实现见 maker-core
   `agents/acp/{session,translator,acp-agent}.ts` 与 Desktop `turn-change-set/{store,dispatchBoundary}.ts`、
   `maker-host/{acp-host,index}.ts`、`remote-agent/controller/{startRemote,service}.ts`。
2. **`.cshare`（旧 `.xdtshare`）导出导入与跨设备任务迁移**：
   - `XDTSHARE_FORMAT_VERSION` 与 `XDTSHARE_READER_VERSION` 升至 `3`，新增 `XDTSHARE_ACP_MIN_READER_VERSION = 3`；
     `manifest.agentKind` 与 `manifest.orca.workers[].agentKind` 新增 `'acp'`，并追加可选 `providerId?: string | null`。
   - **向后兼容**：普通内置引擎（`cc`/`codex`/`pi`）包继续写 `formatVersion: 1, minReaderVersion: 1`，全内置协同包继续写
     `formatVersion: 2, minReaderVersion: 2`，旧读端行为零变化；仅当 lead 或任意协同 Worker 为 `'acp'` 时写入 `3`，旧读端以
     `SHARE_VERSION_UNSUPPORTED` 明确拒读，不会误报损坏或错配成内置引擎。
   - **DB-only 导出与上下文交接**：插件引擎会话按 DB-only 导出（`sdkSessionIds: []`、`activeSdkSessionId: null`、`transcripts: []`，
     单会话包保真度为 `'db-only'`，内置 lead 含 `acp` Worker 的协同包在内置转录齐全时保真度为 `'partial'`），保留 `agentKind: 'acp'`、
     `providerId`、`model`、`effort`。导入端不套用内置引擎草稿、`fastMode` 固定 `false`、`sdkSessionId` 固定 `null`，并在同一事务写入
     隐藏的 `context_rebuild` 交接行（`rewind_at` 非空、`consumed: false`），使目标机首轮续聊无缝承接完整历史。
   - **跨设备任务迁移**：`TaskMigrationView`（`packages/device-link/src/taskMigration.ts`）在 `agents` 扩展加入 `'acp'` 并新增可选
     `acpProviders?: string[]`（上报目标机已启用、已批准且非 `unavailable` 的插件引擎规范 `acp-plugin:<ghostId>:<harnessId>` 列表；无可用
     插件时不上报 `'acp'`）。源端启动前与目标端落库前均按成员逐一核对 Lead 与全部协同 Worker 的具体 `providerId`（含剥离源机独立账号池后缀
     `~<suffix>`），任一所需插件在目标机不可用或旧版目标机未上报时以 `MIGRATION_TARGET_MODEL_UNAVAILABLE` 明确拒绝，避免迁移后首轮续聊失败或上传不兼容的 v3 包。不新增 device-link channel 或中转帧，自建中转原样转发。
   - 实现见 `session-share/{xdtshareFormat.pure,sessionShareExport,sessionShareImport}.ts`、`task-migration/service.ts`、
     `packages/device-link/src/taskMigration.ts` 与 renderer `SessionShareImportWizard.tsx`；回归见
     `xdtshareFormat.pure.test.ts`、`sessionShareExport.test.ts`、`sessionShareImport.test.ts`、`task-migration/__tests__/service.test.ts`、
     `store.git-integration.test.ts` 与 maker-core `acp-session.test.ts`。

## 附加目录、只读 `/review` 与共享任务（2026-11-27）

三项边界能力对齐内置引擎，均复用既有 wire 与本地存储结构，不新增 channel、relay 帧、manifest 字段、批准项或数据库迁移，官方与自建中转无需改动：

- **附加参考目录与可写目录（`extraDirs` / `writableDirs`）**：`buildAcpCapabilities` 对 `extraDirs` 与 `writableDirs` 均声明支持。
  新会话首轮说明附 `<cindy-extra-reference-directories>` / `<cindy-extra-writable-directories>`（对齐内置 Pi，插件 Library 根不进通用参考清单，
  由 `<cindy-library-native-read>` 单独下发）；会话中调用 `setExtraDirs` / `setWritableDirs` 立即刷新实时快照并在下一条普通消息附上更新与撤销说明。
  完全访问（`bypassPermissions`）遵循与内置引擎（Claude Code / Codex / Pi）一致的口径，普通写操作直接放行、不因工作目录或附加目录边界弹窗拦截；
  非完全访问档下启用每轮权限闸（`permissionGate`）的 `routine` 自动放行路径中，宿主对 `edit` / `delete` / `move` 权限请求按 `realpath`
  （含大小写不敏感路径键提取、不存在子路径祖先校验与悬空符号链接拒绝、凭据路径与只读 Library 根拒绝，以及并发撤权复核）校验全部目标路径：
  落在任务工作目录与当前 `writableDirs` 之外的写操作绝不自动放行，升级到人工确认或无解析器时直接拒绝，撤销目录即时生效。桌面新建页与任务页对本机插件引擎任务开放附加目录入口（远程与 SSH 仍由既有能力门关闭）。
- **只读 `/review` 沙盒（`reviewMode` + `reviewReadPaths`）**：`maker:review:start` 保留来源任务的 `agentKind = acp`、`providerId`、`model`、`effort`
  并先做插件引擎准入；`AcpAgent` 启动时剥离全部 MCP 服务、记忆、插件花名册、Skill 清单与展开、伙伴画像、附加目录与宿主说明，并将权限模式固定为 `ask`。
  握手后强要求对端声明 `initialize._meta.permissionGate.supported === true`：未声明时立即关闭进程并 fail-closed 抛出
  `AgentStartupStoppedError(NotSupportedError('reviewMode', reason: 'sdk-missing'))`。声明支持时，每轮强制发送 `scope: 'all-tool-calls'`，
  在 `decidePermission` 强制执行不可绕过的只读审查闸（即使处于 `bypassPermissions` 也不放行）：因外部插件 `permissionGate` 仅在调用前拦截、无法在搜索执行或结果层逐文件过滤凭据与软硬链接，仅允许目标为具体常规文件（`stat.isFile()`）的 `read` / `search` 且全部路径经 `resolveReviewReadPath` 验证落在工作目录或 `reviewReadPaths` 内、非凭据路径且无硬链接逃逸；目录级搜索（如 `Grep` / `Glob` 扫描目录或省略路径）、`edit`、`delete`、
  `move`、`execute`、`fetch` 或未知/不可验证调用一律拒绝。直接消息附件在发送/插话前经 `assertReviewMessageContentPaths` 校验。
- **共享任务（Shared Tasks）**：`AgentInputCreateOpts.agentKind` 与主进程 `readSharedTaskTaskCreateOpts` / `requireQueuedMessage` 接受 `acp`，
  访客消息由宿主盖章保留任务自身的 `agentKind = acp`、`providerId`、`model`、`effort`、`agentDeviceId` 与权限档（剥离访客自报覆盖字段）；
  访客端不读取或泄漏宿主本地插件目录，沿用通用插件引擎图标与现有共享任务安全边界（访客交互过滤、仅用户可确认项拒绝、撤权隔离）。
  兼容：旧版宿主仍拒绝共享任务上的 `acp`；旧控制端或手机端查看共享任务按既有通用标识展示、继续发消息由新版宿主按任务记录盖章执行。

实现见 maker-core `agents/acp/{acp-agent,briefing,capabilities,sandbox,session}.ts` 与 Desktop `shared/agentInputQueue.ts`、
`maker-ipc/{register,reviewStartHandler}.ts`、`renderer/features/cc-agent/{CCAgentSessionView,NewMakerDraftRoute}.tsx`；
回归见 maker-core `acp-session.test.ts` 与 Desktop `reviewStartHandler.test.ts`、`sharedTaskInput.test.ts`、`newMakerProjectPicker.test.ts`。

## 全系统放开插件引擎的兼容边界（2026-11-27）

1. **IM 默认设置与项目偏好（`ImDefaultSettings` / `FeishuGroupRoute` / `HookWorkspacePrefs`）**：
   - `ImDefaultSettings.agentKind` 与 `FeishuGroupRoute.agentKind` 新增取值 `'acp'`，`ImDefaultSettings.agents` 追加可选键 `acp?: ImDefaultAgentSettings`（`effort` 允许 `''`，`providerId` 必为 `acp-plugin:…`）。未配置插件引擎时，磁盘 JSON 与指纹字符串与旧版逐字节一致；配置后旧版读写若遇到 `'acp'` 不会静默写入内置引擎。
   - 固定 schema 的云端/远程宿主设置读取口（`additionalIm.ts`、`additionalWorkspaces.ts`）遇到保存为 `'acp'` 的配置行时返回 `{ status: 'unavailable', revision: null }`，防止旧控制端或云端设置页覆写或丢弃插件引擎路由。
2. **智能路由 / 模型组（`ModelGroupAgentKind`）**：
   - `ModelGroupAgentKind` 新增取值 `'acp'`（`providerId` 必为 `acp-plugin:…`），同时放宽 `model-groups:bind-session`、决策日志与手机端 `mobileMakerTransport.bindModelGroupSession` 的入参枚举。不新增 channel、allowlist 或 relay 帧；旧控制端/旧手机按未知 `agentKind` 忽略该候选或结果，不误落内置引擎。
   - 辅助模型与 Subagent（`auxiliaryRouteRefs.ts`）读取模型组时显式过滤 `'acp'` 候选，不向直连 HTTP 一次性请求或 Claude `CLAUDE_CODE_SUBAGENT_MODEL` 下发插件引擎。
3. **自动化 / 定时任务与项目自动化**：
   - `Schedule` 放开 `persistentSession: true` 与插件引擎组合；`runner.ts`、`scheduledModelSelection.ts` 与 `scheduler-host/index.ts` 放开 IM、协同、伙伴例行任务绑定与切换（继续保留 `review`、SSH `remoteHostId` 与非法 peer ID 拒绝）。
   - 项目自动化文件（`.cindy/automations/schedules.json`）的 `agentKind` / `modelAgentKind` 接受 `'acp'`（校验 `providerId` 以 `acp-plugin:` 开头）。未装对应插件的成员执行时由准入明确报错，不回落内置模型。
4. **跨设备协同 Worker（`ORCA_REMOTE_WORKER_AGENT_KINDS`）**：
   - `packages/device-link/src/orcaRemoteWorker.ts` 的 `ORCA_REMOTE_WORKER_AGENT_KINDS` 新增 `'acp'`，`parseOrcaRemoteWorkerOpenRequest` 在 `agentKind === 'acp'` 且非模型组时校验 `providerId` 为 `acp-plugin:…`；旧版运行设备收到 `'acp'` 时以 `[INVALID_PARAMS] invalid agentKind` fail-closed 拒绝，不创建错误引擎的 Worker。
   - 代理任务行（`OrcaRemoteWorkerProxySessionSeed`）追加可选 `providerId` 落库，`orcaRemoteWorkerBridge` 放开 `'acp'` Worker 向 Lead 回报（MCP 上下文 `agentKind` 与 `acp-agent.ts` 同口径映射为 `'pi'`）。
   - 不新增 channel、allowlist 项或中转帧，官方与自建中转按既有 invoke 帧透明转发，无需改动。

## 插件工具卡片识别

任务消息的 `tool_use.content` 新增可选字符串 `mcpToolName`。新版桌面只在识别插件卡片和媒体锚点时
优先使用它，普通工具行继续显示 `toolName`。据对 Factory droid 1.23.0 打包代码的静态阅读（未实测），
droid 在 `tool_call.name` 中以 `server___tool` 报 MCP 机器名。新版仅按本会话挂载的服务器解析此格式；
同一解析也用于已有的空工具结果回填（#12891）。不识别截断加哈希的长名字。旧桌面忽略新字段，
不识别此机器名格式时降级为普通工具行；手机仍只读取已有字段。不改变权限判定、真实 MCP 参数、
消息通道或中转帧；自建中转原样转发。

## 用户自定义提示词（ACP `systemPrompt`，2026-11-28）

Cindy 自己的系统提示词仍不交给插件引擎；「个性化 → 自定义提示词」按 ACP v1 标准字段交出（#13098、#13515）：

- **协商**：只在对端 `initialize` 声明 `agentCapabilities.sessionCapabilities.systemPrompt` 时，在 `session/new`、`session/load`、
  `session/resume` 带 `systemPrompt: { mode: 'append', content: [{ type: 'text', text }] }`；只用 `append`，未声明的引擎与旧版 Cindy 一律不发，
  存量插件零迁移。对端收到却无法应用时按 ACP 要求以 `-32602` 拒绝建会话。
- **取值**：`Maker.createSession` 对插件引擎一律只取发起时冻结的个性化正文（`hostStartupPreferences.userPrompt`），丢弃之后拼进
  `userPrompt` 的项目知识与协同角色说明（后者也会经 `prepareStartOptions` 拼入，包括目标模式恢复这类不经 bootstrap 的入口）；
  没有冻结值的入口不发。隔离伙伴与只读 `/review` 不带，由发起端 Maker 判定（伙伴档案与审查标记不过线，执行端无法排除；审查隔离只清 `userPrompt`，`AcpAgent` 也按 `reviewMode` 再排除一次）。引擎在另一台电脑上时，发起端按同一规则取值后经连接发出。
  替另一台电脑运行的任务（同账号远程供应商 `--cindy-remote-workspace` 与分享受邀者 `--cindy-guest-workspace`）用任务所在电脑经既有
  remote-agent 启动参数 `RemoteAgentWireStartOptions.userPrompt` 发来的正文，不新增 wire 字段，也从不换成执行端自己保存的个性化：
  托管启动走 `Maker.startHostedAgentSession`，不经过执行端的 `prepareStartOptions`。受邀者任务带的是受邀者的指令。
- **新旧组合**：新执行端遇到旧发起端时，`userPrompt` 是旧发起端发给内置引擎的那份，可能在个性化正文后附有项目知识入口或协同角色说明，
  与内置引擎从旧发起端收到的内容一致；旧发起端也可能为隔离伙伴带上主人的个性化。双方都升级后只剩个性化正文。旧执行端不给托管任务发 `systemPrompt`，行为同前。中转与 relay 无改动。
- **插件侧**：受邀者的正文对分享者电脑是不受信的文字，插件不得让其触发读取本机文件（官方 Antigravity 插件在远程与分享模式下
  把它写进本次启动私有的 Agent 定义并转义 `@[label](path)` 引用，makecindy/cindy-official-plugins#427）。

实现见 maker-core `agents/acp/{acp-agent,protocol,session}.ts` 与 `maker.ts`；回归见 maker-core `acp-session.test.ts`
（本机、隔离伙伴、同账号托管、受邀者托管四种输入）、`maker.test.ts`（只取冻结正文，`prepareStartOptions` 拼入的协同说明不外发）
与 Desktop `remote-agent/__tests__/mirror.test.ts`（发起端 `userPrompt` 到达执行端）。

## 同账号远程任务的 Lead 角色说明

同账号远程任务仍通过既有 `setVendorOptions` 发送角色说明字符串，不新增协议或重连投递机制。
与本机重建时从宿主进程内交接待发说明不同，远程设置缓存随同账号代理存活：

1. **代理保留、团队未撤销**：远端执行进程让位后重连，代理会把缓存中待交付的说明交给新进程；
   已交付的说明也可能再进入一次提示。与 `main` 一致。
2. **整个代理重建**：原代理的设置缓存不会随之恢复，待交付的说明会丢失。与 `main` 一致。
3. **团队已撤销**：即使代理把旧说明和撤销字段一起重放，旧说明也不会再进入提示。
   这是本次改进；`main` 在这种情况下仍会注入旧说明。
