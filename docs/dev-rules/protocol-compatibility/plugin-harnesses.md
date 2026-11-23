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
自建中转无需改动。桌面控制端按账号和引擎所在电脑共享目录：任务列表存在该电脑的插件引擎任务或打开插件任务／模型选择器时共用一次 `maker:list-plugin-engines` 读取，断线保留已缓存图标、重连刷新、撤权或移除时驱逐（见 `usePluginEngines.ts`、`useDeviceLinkRemoteProjects.ts` 与 `pluginEngineVendorIcon.test.tsx`）。
同引擎模型变更沿用 `maker:set-model`，按稳定设备归属发往被控端并使用该端的任务变更推送回显。引擎提供的模型标识在 256 字符
以内原样缓存，超限项目不进入目录，展示名称另行限长。

伙伴的模型设置沿用现有设置表单。每个插件模型保存 `harness: 'acp'`、引擎的 `providerId`、模型 ID 与可选思考深度，在伙伴所在电脑上运行。
更新后的桌面和手机可以编辑同一份配置。不能识别 ACP 的旧设置服务会拒绝保存这项选择。插件清单、批准状态及中转消息格式沿用原契约。

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
  A 记为不支持、只列 B 自己的引擎(与此前相同)；B 没有来源名单(更早的版本)时同样只列 B 自己的引擎。手机端尚未提供这两个来源。
  来源名单或链接状态变化时丢弃该任务电脑的引擎目录与在途读取。重新发现来源后，只为已打开任务回读仍可用的来源。
- **暂未开放**：插件引擎加入供应商组或备用机委托、转分享(`relayKey`)、协同 Worker 跨机运行插件引擎、分叉与回退。这些入口保持明确拒绝。

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
  与本机详情同一组件，打开详情和窗口重新获得焦点时读，与任务里的用量标签共用按电脑、按引擎一分钟内的读取，不轮询；
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
桌面任务和手机菜单按账号代次、执行电脑、引擎共用在途读取与一分钟缓存。切换任务可复用结果，隐藏期间缓存到期只释放数据，账号切换后丢弃原账号的回包。
模型目录刷新保留仍可上报用量的引擎读数。引擎被移除或停止上报时，控制端清掉该引擎的缓存并丢弃迟到的回包。手机暂时连不上执行电脑时保留上次读到的目录。

同账号配对设备通过只读 `maker:get-plugin-engine-usage(key)` 查询执行电脑；SSH、分享访客与未配对调用没有账号用量入口。
旧插件继续使用现有状态与模型，新插件在旧 Host 上仍可在自己的设置页获取用量。旧 Host 缺少该 channel 时控制端按无数据处理。
既有 Device Link invoke 帧和自建中转可原样转发，无需扩展中转协议。该变更不增加 manifest 权限、批准或安装迁移。

## 插话（2026-11-22）

Cindy 与引擎入口之间的 ACP wire 追加一个可选扩展，沿用生态已有约定（claude-agent-acp 0.109、codex-acp、oh-my-pi），不自创方法：
Agent 在 `initialize` 结果**顶层** `_meta.steering.supported === true` 时，`sameTurnSteer` 为支持，运行中的插话发请求
`_session/steering`，参数 `{ sessionId, prompt: ContentBlock[], _meta: { steering: { idleBehavior: 'promptRequired' } } }`。
结果 `injected` 为受理；`promptRequired` 按「没有进行中的回合」交给宿主改为下一轮发送；`startedNewTurn`（不认识
`idleBehavior` 的旧适配器自己开了一轮）按受理处理，输出按回合外工作显示；其他结果或 JSON-RPC 错误按未受理处理；
已发出但超时或连接断开按「送达未知」（`delivery uncertain`）交给宿主，队首保留并暂停，不重发。Agent 声明了却回
method-not-found 时本会话撤回插话能力，之后的插话排队。

兼容：没有声明的 Agent（含全部存量插件引擎）`sameTurnSteer` 仍不支持。旧版 Cindy 从不发送该请求。
远程与分享任务的能力沿用既有 `negotiatedCapabilities` 状态带回控制端，`steer` 沿用既有 remote-agent 方法与受邀者实时复核，
新旧控制端与被控端任意组合都按被控端握手结果决定是否插话；不新增 manifest 字段、权限、批准、channel 或中转帧。
实现见 maker-core `agents/acp/protocol.ts`、`capabilities.ts`、`session.ts`；回归见 `acp-session.test.ts`「AcpSession same-turn steering」。

不支持插话时的呈现（同日）：输入协调器（Desktop 与 Node Host 共用）在会话 `sameTurnSteer` 不支持时，界面发起的插话不再
交给引擎报 `UNSUPPORTED_CAPABILITY`，而是按「这一轮结束后发送」排队（队列行插话移到队首，输入框插话排到队尾），不显示错误；
控制面严格插话（`fallbackToTurn: false`）照旧返回未插入。`AgentInputProjection` 追加可选 `steerUnsupported?: boolean`，
只在确知不支持时为 `true`，经既有输入 projection 推给本机界面、控制端与手机。新界面据此隐藏插话入口（输入框按排队发送、
排队消息菜单不出现插话），队列等待时在消息流末尾显示一行说明。旧被控端不带该字段，新界面按支持处理，行为与以前相同；
旧控制端与手机忽略该字段，仍显示插话入口，点击后由新被控端排队，不再报错。不新增 channel 或中转帧，自建中转原样转发。
回归见 `agent-input-coordinator.test.ts`「sends a steer after this turn」与 renderer `pendingQueueRowPresentation.test.ts`「PendingQueueBubble steer action」。
