# ACP 插件执行引擎与插件模型工程规范

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改 ACP 引擎（`packages/maker-core/src/agents/acp/**`）、插件执行引擎注册／准入／切换／账号池／远程与分享调用／用量统计、插件路由模型、或任何可能受第 4 种引擎 `acp` 影响的跨模块任务入口之前
> **适用路径**：`packages/maker-core/src/agents/acp/**`、`packages/maker-core/src/types/common.ts`、
> `packages/plugin-protocol/src/{pluginHarnesses,pluginHarnessUsageReader,pluginModels}*`、
> `apps/desktop/src/main/cindy-brain/pluginHarnesses*`、
> `apps/desktop/src/main/cindy-brain/runtime/{ghostHarnessesEndpoint,ghostModelsEndpoint}*`、
> `apps/desktop/src/main/plugin-engine-accounts/**`、
> `apps/desktop/src/main/maker-host/{plugin-engine-prefs-store,pluginEngineModelCache,pluginEngineRemoteUse,pluginEngineSkills}*`、
> `apps/desktop/src/main/maker-ipc/{pluginEngineSessionAdmission,sessionAgentSwitchHandler,pluginEnginesIpc}*`、
> `apps/desktop/src/main/device-link/pluginEngineSwitchIntentPush*`、
> `apps/desktop/src/main/im/shared/pluginEngineCatalog*`、
> `apps/desktop/src/main/learn-host/pluginEngineLearnSession*`、
> `apps/desktop/src/main/mcp-integrations/antigravityToolCatalog*`、
> `apps/desktop/src/shared/{agentKindConversion,pluginEngines,pluginModelPicker}.ts`
> **要点**：`EngineKind = AgentKind | 'acp'` 已有 4 种引擎。凡分发引擎的分支必须显式处理 `'acp'`（优先用 `matchEngineKind` 穷举或 `isPluginEngineKind` 显式分流），禁止隐式 `else → 'claude-code'`；`agentKind === 'acp'` 永远与 `providerId = 'acp-plugin:...'` 配对；不支持的入口必须显式 fail-closed。

本文是 Cindy 插件执行引擎（ACP）与插件路由模型的工程规则正本，与
[PI harness 规则](pi-harness.md) 并列。产品定位与全场景能力台账见
[插件引擎与插件模型](../product-rules/plugin-engines-and-models.md)，跨端兼容、wire 字段与旧端降级见
[插件任务执行引擎协议记录](protocol-compatibility/plugin-harnesses.md) 与
[插件提供的模型协议记录](protocol-compatibility/plugin-provided-models.md)，安全与存量插件兼容红线见
[插件运行时安全与作者契约](plugin-security-and-authoring.md)。

## 1. 架构分层与代码导航

```text
Desktop / Mobile UI（UnifiedModelPanel / PluginEnginesSection / PluginModelsSection / pluginEngines.ts）
   │ IPC / Device Link（maker:list-plugin-engines、maker:set-plugin-engine-prefs、maker:get-plugin-engine-usage）
   ▼
Desktop Host（pluginEngineSessionAdmission / pluginEngineSessionSwitch / plugin-engine-accounts / remote-agent）
   │ 注册表 & 进程托管（cindy-brain/pluginHarnesses.ts → nodeRuntimeBroker.spawnHarness）
   ▼
maker-core（packages/maker-core/src/agents/acp/：protocol / connection / capabilities / session / translator / elicitation / briefing / mcp-tool-result）
   │ ACP v1 JSON-RPC（utilityProcess 原始 stdio 逐行，超长行分帧 stdin）
   ▼
插件声明的 JS 入口（harnesses[].entry ∈ node.entries）──► 外部 ACP Agent CLI（如 agy / dsh）
```

| 职责 | 权威位置 |
| --- | --- |
| 通用 ACP 协议、连接、翻译、能力、提问表单、首轮 briefing、MCP 工具结果回填 | `packages/maker-core/src/agents/acp/`（零 Electron、零插件、零具体 CLI 特例） |
| 清单与用量协议解析 | `packages/plugin-protocol/src/{pluginHarnesses,pluginHarnessUsageReader,pluginModels}.ts` |
| 引擎注册表与插件端点 | `apps/desktop/src/main/cindy-brain/pluginHarnesses.ts`、`runtime/{ghostHarnessesEndpoint,ghostModelsEndpoint}.ts` |
| 引擎偏好、模型缓存、远程/分享开关、Skill 扫描 | `apps/desktop/src/main/maker-host/{plugin-engine-prefs-store,pluginEngineModelCache,pluginEngineRemoteUse,pluginEngineSkills}.ts` |
| 任务准入、会话内切换、IPC 投影 | `apps/desktop/src/main/maker-ipc/{pluginEngineSessionAdmission,sessionAgentSwitchHandler,pluginEnginesIpc}.ts` |
| 多账号存储、目录隔离、失败换号与冷却 | `apps/desktop/src/main/plugin-engine-accounts/{store,runtime,agent,failover,ids,paths}.ts` |
| 共享类型、键解析、DB/maker 转换 | `packages/maker-core/src/types/common.ts`、`apps/desktop/src/shared/{agentKindConversion,pluginEngines,pluginModelPicker}.ts` |
| 桌面与手机选择器／设置／收藏 | `apps/desktop/src/renderer/components/new-chat/{PluginEnginesSection,PluginModelsSection}.tsx`、`components/settings/{PluginEngineProviders,OwnRemotePluginEngines,PluginEngineSignIn,PluginModelAdvancedDialog}.tsx`、`lib/pluginEngineFavorites.ts`、`apps/mobile/src/session/pluginEngines.ts` |

## 2. 类型与身份不变量（防漏改与防隐式回落）

1. **区分内置三引擎与全部四引擎**：
   - `AgentKind`（`packages/maker-core/src/types/common.ts`）仅表示内置三引擎（`'claude-code' | 'codex' | 'pi'`），只用于明确限定内置引擎的供应商品类、原生二进制或旧 wire 兼容层。
   - 凡任务生命周期、消息归因、UI 展示、统计、调度、IM、Orca、远程控制、MCP 工具与反馈摘要路径，**默认使用 `EngineKind`（`AgentKind | 'acp'`）**（或 Desktop DB 层的 `DbEngineKind` / `MakerEngineKindWire`）。
   - 做引擎分支时使用 `matchEngineKind(kind, { 'claude-code': ..., codex: ..., pi: ..., acp: ... })` 或 `assertNeverEngineKind`，禁止写 `if (k === 'codex') ... else if (k === 'pi') ... else /* 当成 claude-code */`。
2. **`acp` 必配 `providerId`**：
   - 本机或执行端插件引擎的 `providerId` 固定为 `acp-plugin:<插件实例>:<引擎 id>`；独立拿出的单账号供应商为 `acp-plugin:<插件实例>:<引擎 id>~<8 位小写字母数字>`。
   - 遇到 `agentKind === 'acp'` 但缺少有效 `acp-plugin:` 前缀的请求，必须在准入层明确拒绝（不得按无供应商或默认内置引擎继续）。
   - 从 providerId 反查所属引擎时必须剥离可选 `~[a-z0-9]{8}` 后缀（`acpHarnessKeyFromProviderId` / `pluginEngineKeyFromProviderId`）。
3. **跨端收藏 wire 编码特例**：
   - 统一模型收藏通道（`packages/device-link/src/modelFavorites.ts`）写入插件引擎收藏时，`agent` 固定写 `PLUGIN_ENGINE_FAVORITE_WIRE_AGENT`（`'cc'`），**严禁发 `agent: 'acp'`**——否则旧 Desktop / Mobile 的 `parseModelFavorites` 会拒绝整张收藏表。新端通过 `providerId` 中的 `acp-plugin:`（含 `agent-device-favorite:` / `provider-share-favorite:` 复合前缀）识别插件引擎收藏并忽略 wire `agent`。
4. **身份全程保留（防回退成 Claude Code）**：
   - 同任务切模型分隔卡（`turnModelAttribution.ts` / #13274）、任务摘要（`get_task_digest` / `taskDigest.ts`）、反馈与 Issue 元数据（`issueRuntimeMetadata.ts` / #13153）、侧栏与菜单栏图标（`PluginEngineIcon.tsx` / `PluginEngineMark.tsx` / #12735）都必须保留 ACP 身份、引擎显示名与插件图标，不能因未识别 `'acp'` 而回落为 Claude Code 名称或图标。

## 3. 准入、懒启动与偏好不变量

1. **后端单点准入，不信前端隐藏**：
   - 新建任务、已有任务切入、自动化、Orca Worker、IM 渠道、`/learn`、远程与分享调用，必须通过执行端 `admitPluginEngineSession` / `admitPluginEngineSwitchTarget` / `isPluginEngineOffered*` 复核：插件已启用、已批准、`approvedHarnesses` 已批准、引擎未停用、模型未关闭、且不在 `unavailable` 状态。
   - `hidden` 仅控制模型选择器陈列，**不参与准入**，且不得影响同账号其他电脑或分享受邀者的可见目录。
   - 用户在供应商设置里关闭任一模型后，`defaultModelAllowed` 必为 `false`，本机与远程执行端均拒绝 `model = 'default'`（防止引擎暗中选中被关闭的模型）。
2. **切引擎与绑定自动化的懒启动契约（#13003）**：
   - `performSessionAgentSwitch` 切到插件引擎后会关闭旧会话并把新引擎留到发送事务懒启动。
   - 因此，发送前检查（如调度器 `onPreparing`）对 `acp` 选型必须优先核对持久化路由（仅当活会话已存在时核对活会话），待发送事务实际启动后再在 `onAccepted` 复核活会话；跨插件临时切换还必须记录并恢复原 `permissionMode` 基线，防止覆盖用户在临时切换期间的手动修改。
3. **多账号隔离与存储边界**：
   - `--cindy-account-dir <dir>` 只能由宿主生成在 `owners/<账号>/plugin-engine-accounts/<插件实例>/<引擎 id>/<账号 id>/` 下的一级子目录；注册表启动前复核目录归属与 `accounts.methods` 声明。
   - 插件引擎账号冷却单独存于 `owners/<账号>/plugin-engine-account-cooling.json`（不得混入内置 `subscription-account-cooling.json`，避免旧版写回丢键）。
   - `kind: 'secret'` 凭证仅由本机受信窗口交 Main 透传给插件 worker 一次，不落盘、不写日志、不进模型，device-link 一律 `PERMISSION_DENIED`。

## 4. 进程、传输与 MCP 工具桥不变量

1. **进程托管与回收**：
   - Main 只启动包内声明且逐字命中 `node.entries` 的 JS 入口，无命令／参数面；停用、更新、卸载与切账号前必须先结束引擎进程并关闭启动闸。
   - 不对插件引擎进程设固定 8 进程硬上限（#12798）；任务空闲 30 分钟后自动释放引擎进程。
   - 长期常驻的 ACP 引擎服务不计入桌面「未完成工作」提示（#13012）。
   - 超过 utilityProcess 管道单帧上限的 ACP JSON-RPC 行必须切分为多帧 stdin 写入（#12061），避免大提示词或大上下文被截断／报错。
2. **远程与分享安全隔离**：
   - 同账号远程任务传固定参数 `--cindy-remote-workspace`，跨账号分享同时传 `--cindy-guest-workspace`；受邀者任务必须同时满足 `remoteWorkspace && guestWorkspace`，且在 `open` / `send` / `steer` / `setModel` 时实时复核授权与 `remoteModelAccess`。
   - 远程工作区依赖 HTTP MCP（`cindy_exec`），握手未声明 `mcpCapabilities.http` 时明确拒绝启动。
3. **MCP 工具结果回填与工具目录预算**：
   - 部分 ACP 外部 Agent 会在 `tool_call_update` 里省略或返回空 MCP 工具结果，导致插件卡片无法渲染；本机与远程路径通过 `packages/maker-core/src/agents/acp/mcp-tool-result.ts` 从本机 MCP 桥回填真实结果（#12891）。
   - 外部 CLI 存在共享工具总数上限时（如 Antigravity 的工具预算），经 `antigravityToolCatalog.ts` 控制暴露目录体积，确保 Orca 与插件发现入口不被挤出（#12663）。
   - 插件卡片交接等本机 ghost agent 回调必须显式接纳本机插件引擎会话（#13011）。

## 5. Briefing、斜杠指令与协议扩展不变量

1. **首轮 Briefing 与防斜杠误触发（#12683）**：
   - 插件引擎不接入 Cindy 的 system prompt（保持内置引擎前缀与缓存稳定），仅在新会话首条用户消息前按固定顺序附：`远程工作区说明 → 伙伴说明 → 已装插件花名册（仅 cindy MCP 实际挂载时）→ Skill 清单（内置 Pi 范围，隔离进程扫描）→ 协同角色说明`。
   - 宿主拼入的非用户文本必须清洗独立 `/命令` 的前导 `/`（不动路径、URL 与用户原话），防止 `agy acp` 等对端自动激活非预期工作流；用户原话本身以 `/` 开头时，首轮说明顺延至下一条普通消息。
   - 桌面 `/` 菜单读取插件引擎 Skill 清单必须按 `agentKind: 'acp'` 走 `AcpAgent.listAgentSkills`，不得借用内置 Pi 的清单。
2. **协议扩展与运行期能力同步**：
   - **插话（`_session/steering`）**：支持 `injected`、`queued`（不提前截断当前回复段）、`promptRequired`（改下一轮发送）、`startedNewTurn`（按回合外工作显示）四类结局；超时／断连按 `delivery uncertain` 暂停队首不重发；若声明后实际返回 `method not found`，立即撤回 `sameTurnSteer` 能力并通过 `AgentSessionHandle.onCapabilitiesChange` 同步到 remote-agent、输入协调器与手机端（#13231）。
   - **每轮权限闸（`_meta.permissionGate`）**：支持引擎每轮带 `turnId`，受限轮次带 `scope: 'all-tool-calls'`，宿主只受理当前轮（或空闲时最近正常结束轮）的请求并按 ACP `kind` 与 `rawInput.command` 执行频道安全策略；未声明该能力的引擎在策略轮受理前以 `TurnPermissionPolicyUnsupportedError('acp', mode)` fail-closed。
   - **问题卡（`elicitation/create`）**：经 `packages/maker-core/src/agents/acp/elicitation.ts` 转换为原生 `ask_user_question`，强制校验 schema 约束，并把成对的 `k` + 可选纯文本 `${k}_other` 折叠为单题选项 + 自填框（#13001）。
3. **用量与计费归因**：
   - 回合 token 从 `session/prompt` 结果的 `usage` 结算，保留 `promptModel` 与零值；设备托管的 ACP token 在控制端结算；企业用量授权跳过插件引擎；限额自动继续只认 `error.data._meta.cindy.resetsAt`，不解析外部错误原文。

## 6. Review 清单与最小回归入口

新增或修改任何任务、模型、对话、协作、自动化、IM 或多端功能时，逐条核对：

1. 是否把 `agentKind` 写死为三引擎枚举，或出现 `else → claude-code` 隐式回落？
2. 遇到 `agentKind === 'acp'` 时，`providerId`（含 `~<suffix>`）与 `agentDeviceId` 是否完整透传、持久化并参与准入？
3. 若该功能暂不支持插件引擎，是否在入口与执行端双向 fail-closed（返回明确错误／隐藏入口），而不是静默降级？
4. 若触及新任务草稿或模型选择器，是否同时验证了插件执行引擎（`PluginEnginesSection`）与插件路由模型（`PluginModelsSection`）的遮罩、收藏与远控边界？
5. 若触及远程控制或手机端，是否核对旧被控端 `CHANNEL_NOT_ALLOWED` 降级、图标大小预算与 `steerUnsupported` / `onCapabilitiesChange` 同步？
6. 若修改了 ACP 协议扩展或插件可见字段，是否同步更新了 `docs/dev-rules/protocol-compatibility/plugin-harnesses.md` 与 `cindy-plugin-creator/references/plugin-harnesses.md`（并新增 `apps/desktop/resources/system-skills/_versions/` 记录文件）？

最小回归入口（按改动范围挑选）：

```bash
# maker-core ACP 引擎与类型穷举
pnpm --filter @cindy/maker-core test -- src/agents/acp/acp-session.test.ts src/types/common.test.ts

# Desktop 插件引擎注册、准入、切换、账号、选择器与分隔卡
pnpm --filter desktop exec vitest run \
  src/main/cindy-brain/__tests__/pluginHarnesses.test.ts \
  src/main/maker-ipc/__tests__/pluginEngineSessionAdmission.test.ts \
  src/main/maker-ipc/__tests__/pluginEngineSessionSwitch.test.ts \
  src/main/maker-ipc/__tests__/turnModelAttribution.test.ts \
  src/main/plugin-engine-accounts/__tests__/runtime.test.ts \
  src/renderer/components/new-chat/__tests__/PluginEnginesSection.test.tsx \
  src/renderer/components/new-chat/__tests__/PluginModelsSection.test.tsx

# Mobile 插件引擎选择器与插话降级
pnpm --filter mobile exec vitest run \
  src/__tests__/pluginEngines.test.ts \
  src/__tests__/inputProjection.test.ts
```
