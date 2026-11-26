# 插件引擎与插件模型：产品定位、边界与能力台账

> **状态**：权威产品规则（authoritative）
> **读取时机**：新增或修改任何涉及插件执行引擎（ACP / `acp-plugin:*`）、插件路由模型（`models.types: ['route']`）、插件任务选模或模型选择器／任务生命周期跨引擎行为的功能之前
> **适用路径**：`apps/desktop/src/shared/pluginEngines.ts`、`apps/desktop/src/shared/pluginModelPicker.ts`、
> `apps/desktop/src/renderer/components/new-chat/{PluginEnginesSection,PluginModelsSection}*`、
> `apps/desktop/src/renderer/features/cc-agent/{pluginModelFavorites,pluginModelRoute}*`、
> `apps/desktop/src/renderer/lib/{pluginEngineFavorites,pluginEngineSelection}*`、
> `apps/desktop/src/renderer/hooks/{usePluginEngines,pluginEngineUsage}*`、
> `apps/desktop/src/renderer/components/settings/{PluginEngineProviders,OwnRemotePluginEngines,PluginEngineSignIn,PluginModelAdvancedDialog}*`、
> `apps/desktop/src/renderer/features/plugin/PluginEngineRemoteUse*`、
> `apps/mobile/src/session/{pluginEngines,PluginEngineMark}*`、`apps/mobile/src/plugins/PluginModelPicker*`
> **要点**：不要把「插件执行引擎（ACP）」「插件路由模型（`route`）」「插件自有任务选模」混为一谈；插件引擎默认按与内置引擎同等待遇设计，缺协议能力时显式降级或 fail-closed，绝不静默伪装或回落成 Claude Code。

本文是 Cindy 插件引擎与插件模型产品行为的权威正本。工程不变量与实现入口见
[ACP 插件执行引擎](../dev-rules/acp-plugin-harness.md)，跨端兼容与线协议细节见
[插件任务执行引擎协议记录](../dev-rules/protocol-compatibility/plugin-harnesses.md) 与
[插件提供的模型协议记录](../dev-rules/protocol-compatibility/plugin-provided-models.md)。

## 1. 三个必须区分的概念

日常口头常统称「插件模型」，但在产品形态、授权边界和代码路径上分属三类完全不同的能力：

| 维度 | 插件执行引擎（Plugin Engine / ACP） | 插件路由模型（Plugin Route Model） | 插件任务选模 / 宿主选模（Plugin Task Picker） |
| --- | --- | --- | --- |
| 面向用户的形态 | 一种模型供应商与执行引擎（如 Antigravity、DeepSeek Harness），直接运行整个任务 | 新任务模型选择器里的一个模型选项（如 AgentCompass），发首条消息前动态挑一个真实模型 | 插件自己的设置页／侧边栏／面板复用 Cindy 统一模型选择器，决定该插件发任务或快问快答用哪个模型 |
| Manifest 声明 | v3 `harnesses`（`protocol: 'acp'`）+ `node.entries` | `models: { types: ['route'] }` + `subscribe.hooks: ['will-start-task']` | `GET /agent-models`、可选 `agent.modelPreferences`、`cindy.pickModel` / `window.cindyUI.pickModel` |
| 身份与存储键 | `agentKind = 'acp'` + `providerId = 'acp-plugin:<插件实例>:<引擎 id>'`（独立拿出账号带 `~<8位>`） | `pluginModel = { pluginId, modelId }`（仅本机新任务草稿 `localStorage`） | 选中结果是真实模型路由（内置三引擎或已允许来源），存入插件自己的任务偏好或单次草稿 |
| 生效入口 | 桌面新任务、已有任务、手机、远控、跨账号分享、伙伴、定时任务、Orca、IM、Goal、`/learn` | **仅限本机桌面新任务草稿**；不进执行目录，手机、远控、定时任务、伙伴、Orca 均不可见 | 插件自己的页面、设置卡与任务创建流程；远程来源需显式 `allowRemote: true` |
| 思考深度与 Fast | 思考深度按引擎上报的 `efforts` 逐模型展示；Fast 不适用 | 选中时不显示思考深度与 Fast（真实模型在发送时才确定） | 遵循所选真实模型的能力 |
| 收藏与最近 | 复用统一收藏通道同步到手机与远控（见[协议记录](../dev-rules/protocol-compatibility/plugin-harnesses.md#插件引擎模型收藏2026-11-26)） | 仅存本机按账号 `localStorage`（`cindy:pluginModelFavorites:v1`），不跨设备同步 | 复用宿主收藏读取与变更；手机与远控暂不开放 `/model-preferences` 端点 |

## 2. 核心产品原则

1. **与内置引擎同等待遇（2026-11-25 用户裁决）**：插件执行引擎不是「边缘试用入口」，而是 Cindy 的第四类任务执行引擎。新增任何任务、模型、对话交互、协作、自动化、IM 或多端功能时，默认同时评估并支持插件引擎，除非受外部协议边界客观限制。
2. **明确降级或 Fail-Closed，绝不静默误判**：插件引擎不支持某项操作时（例如未声明每轮权限闸、未声明插话、引擎已停用、模型已关闭），必须明确提示原因或按确定性规则降级（如插话自动改为排队并隐藏插话入口），**严禁**静默回落到 Claude Code、丢弃 `providerId` 或绕过权限边界执行。
3. **身份全程同源**：插件引擎的显示名（含用户在「设置 → 模型供应商」改的名）与图标在供应商设置、模型选择器、任务行、切换分隔卡、用量、摘要与反馈元数据里同源，不把插件引擎显示成内置引擎。

## 3. 插件执行引擎能力对齐台账

下表记录插件执行引擎在各产品面的当前契约与降级边界；实现变化时须同步更新本表。

| 产品面 | 当前状态 | 规则与依赖条件 | 不支持／不可用时的用户表现 |
| --- | --- | --- | --- |
| 模型选择器与收藏（桌面 & 手机） | 已支持 | 在统一模型选择器中按插件引擎分组呈现；列出引擎上报模型与逐模型 `efforts`；支持收藏（含本机、同账号远程与分享引擎）与最近使用 | 未上报模型时显示「引擎默认模型」；关闭任意模型后 `defaultModelAllowed: false` 禁止选默认模型；引擎隐藏时不出现在选择器但不影响已有任务 |
| 模型供应商设置与高级设置 | 已支持 | 在「设置 → 模型供应商」左栏带「插件」标识列出（含同账号在线电脑开放的远程插件引擎）；支持改名、隐藏、停用、逐模型关闭、高级设置；「添加供应商」向导列出官方模型插件 | 停用后禁止新任务／自动化／Worker／远控与分享下一轮调用，本机运行中任务不打断；登录和安装仍由插件自身管理（详情提供「打开插件」） |
| 多账号池与账号用量 | 已支持 | 插件声明 `accounts.methods` 后复用内置账号池界面、分配、限流冷却、换号与拿出独立供应商（`~<8位>`）；声明 `reportsUsage` 后在任务、设置、菜单栏与小组件展示用量 | 未声明 `accounts` 按单账号运行；错误未提供 `error.data._meta.cindy.resetsAt` 时只报错不猜自动继续时刻；不向分享访客暴露主人私有账号用量 |
| 同账号免装远程调用 | 已支持 | 插件上报 `remoteWorkspace: true` 且用户在装插件的电脑开启「允许被远程调用」；使用端无需预装插件或 CLI，自动走影子目录与 `cindy_exec` 隧道 | 未上报或未开启时不在其他电脑列出；目标离线或中途停用时下一轮明确报错，不回退本机 |
| 跨账号分享插件引擎 | 已支持 | 插件同时上报 `remoteWorkspace` 与 `guestWorkspace`；复用一次性分享链接、配对审批、模型白名单与受邀者用量统计 | 未声明 `guestWorkspace` 不出现分享入口，并在受邀者启动前拒绝 |
| 桌面远程控制 & 手机控制端 | 已支持（部分边界） | 桌面远控支持被控电脑自身、其同账号其他电脑及其收到的插件引擎分享；手机支持被控电脑本机插件引擎的新建、切换、收藏、用量与 Worktree | 手机端暂不列被控电脑再转接的第三方远程／分享插件引擎；旧被控端缺 `maker:list-plugin-engines` 时隐藏入口不报错 |
| 同轮插话与排队 | 已支持 | 引擎握手声明 `_meta.steering.supported` 时支持 `_session/steering`（含 `injected` 与 `queued` 结局）；运行期撤回能力即时同步至各端 | 确知不支持时经 `steerUnsupported` 在桌面与手机隐藏插话入口，输入框与队列插话改为「本轮结束后发送」排队并提示，不报 `UNSUPPORTED_CAPABILITY` |
| 问题卡、计划更新、分叉、回退、压缩、侧聊 | 已支持 | 通过 ACP `elicitation/create` 渲染原生问题卡（含选择 + 自填折叠）；支持 `plan` 更新、分叉、编辑／回退、压缩、侧聊与上下文溢出同引擎新会话续接 | 外部引擎不支持原生操作时由 Cindy 交接／重放模拟；无原生历史回退点时按已有降级文案提示 |
| `/` 菜单 Skill 与首轮能力告知 | 已支持 | 新会话首轮按固定顺序在首条用户消息前告知插件花名册与 Skill 清单（内置 Pi 同范围）；输入框 `/` 菜单按 `acp` 向执行电脑读取 Skill 清单并展开调用 | 宿主注入文本清洗独立 `/命令` 防误触；旧被控端不支持 `maker:list-agent-skills(acp)` 时菜单按无 Skill 降级 |
| Worktree | 已支持 | 覆盖本机、引擎在另一台电脑、远程控制项目、手机、协同 Worker 与定时任务；检出完整完成后才启动任务并发送首条消息 | 检出失败保留草稿与附件，不在原仓库目录启动 |
| Orca 协同（Lead & Worker） | 已支持（含边界） | 支持作为 Orca Lead 与本机 Worker（含 worktree）；新任务草稿保留 Orca 插件引擎 Worker 选择 | 插件引擎 Worker 仅在 Lead 所在电脑本机运行，拒绝跨机／SSH 远端 Worker；`set_worker_runtime` 对插件引擎 Worker 返回 `UNSUPPORTED_CAPABILITY` |
| 伙伴（Teammate）与群聊 | 已支持 | 伙伴模型设置与群内点名均可选择本机或普通会话可选的远程插件引擎，沿用引擎默认模型与档位规则 | 隔离伙伴不附普通任务花名册／Skill 清单；V2 项目伙伴照常附上；不支持的旧设置服务拒绝保存 |
| 定时任务与绑定任务临时切换 | 已支持 | 支持每次新建任务（含 worktree、本机与同账号远程／有效分享插件引擎）以及本机普通任务的绑定自动化在插件引擎与内置引擎间临时切换并在下次普通发送前恢复原引擎、模型与权限档 | 拒绝持续会话、伙伴例行任务、SSH、项目级 `.cindy/automations/schedules.json` 与仅模型覆盖；绑定任务启动前准入失败须发失败通知 |
| 目标模式与 `/learn` | 已支持 | 目标任务可设、可休眠恢复并从回合 `usage` 计预算；`/learn` 在来源任务的同一插件引擎与模型上蒸馏（不自动给「全部允许」） | 无原生 `AskUserQuestion` 的引擎在目标首轮跳过澄清；另一台电脑上的插件引擎暂不接受 `/learn` |
| IM 渠道与每轮权限闸 | 已支持（依赖扩展） | 个人 IM 与官方机器人可接管插件引擎任务、支持 `/model`（同引擎内）与 `/permission`；群聊／访客／个人微信的逐轮权限策略由 `_meta.permissionGate` 执行 | 引擎未声明 `_meta.permissionGate` 时，带逐轮策略的轮次一律 fail-closed 并提示「当前引擎不支持」；不带策略的私聊照常运行；渠道「新对话默认模型」暂只选内置引擎 |
| Agent 工具（`send_to_session` / `list_available_models` / `get_task_digest`） | 已支持 | `send_to_session(create)` 与 `list_available_models` 支持 `agent_kind: 'acp'` + `provider_id`（含本机、远程来源与跨电脑新建）；`get_task_digest` 与反馈保留 ACP 身份 | 目标电脑未声明 `ordinaryCreatePluginEngine: 1` 或为 Node Host 时，跨电脑新建在发送前以 `REMOTE_UNSUPPORTED` 拒绝 |
| 自动标题、输入推荐、模型切换分隔卡、Token 统计 | 已支持 | 标题与推荐走辅助模型链（不回落到引擎）；同任务换模型记录并展示切换分隔卡；按回合 `usage` 计入每日用量（远程托管在控制端结算）；ACP 空 MCP 工具结果从本机桥回填以显示插件卡片 | 辅助模型不可用时保留占位标题，不借主引擎起名；企业用量授权跳过插件引擎 |

## 4. 当前明确不开放的范围

以下入口在现阶段保持显式拒绝，不在产品面承诺可用（开放前须单独完成产品与协议评审）：

- **电脑组（供应商组）与备用机委托**：插件引擎暂不加入多机电脑组，不支持跨账号转分享（`relayKey`）。
- **SSH 工作区**：插件引擎不能在 SSH 远端主机工作区中运行（跨电脑使用走同账号远程 Agent，不走 SSH）。
- **辅助模型、媒体模型与子代理默认链**：不列插件引擎。
- **Node Host 独立运行 ACP**：无桌面插件宿主环境，`acp` 新建与技能读取返回不支持／未注册。
- **项目级自动化文件（`.cindy/automations/schedules.json`）**：不接受插件引擎（避免把依赖个人本机插件的声明提交进共享代码库）。

## 5. 插件路由模型（`route`）产品契约

- **定位**：对用户呈现为新任务模型选择器里的一个模型（名称、说明、多语言由插件定义）；实际执行时在首条消息发出前通过 `will-start-task` 询问插件一次，路由到一个真实模型，任务后续始终沿用该真实模型。
- **可见范围**：仅出现在**本机桌面新任务**的模型选择器里。远程电脑、SSH 主机、多 Agent 协同草稿、定时任务、伙伴和手机均不展示。
- **兜底与不阻塞**：插件未配置好时应发布空列表；路由超时、出错、无回复或返回不可用模型时，使用用户底层原模型发出消息，绝不阻断发送。
- **草稿替换与收藏**：单任务临时替换模型（alternate draft）激活时，必须遮罩已保存的插件路由模型与模型组模式，防止底层草稿状态串扰（#13238）；插件路由模型收藏按账号保存在本机 `localStorage`（`cindy:pluginModelFavorites:v1`），不同步到其他设备。
- **用户可见回执**：首条消息后写入系统说明行（`agentMeta.pluginModelRoute`），在桌面和手机说明本次路由结果，历史投影不计入模型正文。

## 6. 插件自有任务选模与宿主选择器

- 能创建任务的插件，其「模型与任务」设置卡（桌面与手机）与普通任务保持同一来源清单与位置语义（见[统一模型选择器 §1.2](model-selector-unified.md#12-面板向下展开)）。
- 第三方插件调用 `cindy.pickModel` / `window.cindyUI.pickModel` 默认只返回本机模型，需显式传 `allowRemote: true` 才开放远程与分享来源；旧端不支持远程初值时返回 `UNAVAILABLE`，不得静默改回本机。
- 不可用的来源在选择器里保留可编辑态，不得静默替用户换模型。

## 关联文档

- 工程不变量与回归入口：[ACP 插件执行引擎](../dev-rules/acp-plugin-harness.md)
- 统一模型选择器规则：[model-selector-unified.md](model-selector-unified.md)
- 模型供应商设置：[provider-settings.md](provider-settings.md)
- 账号池与插件引擎账号：[subscription-account-pools.md](subscription-account-pools.md)
- 插件安全与作者契约：[plugin-security-and-authoring.md](../dev-rules/plugin-security-and-authoring.md)
