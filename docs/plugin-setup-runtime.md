# 插件 Setup Runtime 技术设计

> 状态：Desktop 已实现并通过自动化与 Electron 真机视觉验收；外部授权完成回流待联调；Mobile 独立后续  
> 关联 Issue：[makecindy/cindy#136](https://github.com/makecindy/cindy/issues/136)  
> 适用范围：Desktop 的 `ghost_list` / `ghost_call`、插件配置宿主、聊天交互卡  
> 不改变：插件沙箱权限、Secret 存储边界、Agent system prompt

## 1. 背景与根需求

当前宿主已经能根据 `ghost.json` 的 `setup.requires` 判断插件是否就绪，但检查只用于插件页的「使用」入口。Agent 在聊天中调用 `ghost_call` 时仍可能直接进入附件授权、目录票据、沙箱启动和插件派发，最后才因缺少 OAuth、Secret、Connection 或插件参数而失败。

本功能把 setup 检查提升为 `ghost_call` 的通用运行时门：

1. Agent 调用插件前，Host 确定性检查该插件的 setup；
2. 未就绪时，在输入框位置展示与 Ask 卡片一致的 Setup 卡片；
3. Agent 可依据 Host 暴露的需求和受控 Action 编排说明、步骤和顺序；
4. Host 执行内联 Secret 收单、OAuth、打开插件设置、管理连接等受控 Action；
5. 任一配置来源保存成功后，Host 立即重新判定并更新卡片；
6. 全部就绪后，继续同一个挂起的 `ghost_call`，不唤醒 LLM、不要求 Agent 重试。

插件不需要各自实现一套聊天卡回调。普通 `source: "user"` Secret 可由 Host
根据 manifest 声明直接生成内联表单；已有 `settings.js` 仍通过宿主 `/oauth`、`/kv`、
`/secrets`、`/connections` 接口承担详情页的长期管理。客户端内 Provider / 模型配置也走
同一 Host 状态变更机制。Core 不维护插件 id / Provider id 路由表：插件只需通过
manifest 声明 Host 能力，所属 Host 子系统继续作为 readiness 的唯一权威来源。

## 2. 用户体验契约

### 2.1 呈现

- Setup 卡片复用 Ask 卡片的容器、尺寸、位置和视觉 token，替换聊天输入框；Setup 始终
  展开，不提供右上角收起/恢复交互。
- Setup 不是 `ask_user_question`，不会把用户操作或配置内容发送给模型。
- 卡片标题中的插件身份由 Host 提供，不采信 Agent 文本：
  - 插件 icon；
  - `插件名 设置`。
- 卡片正文、步骤标题、步骤说明和顺序可由 Agent 编排，但必须引用 Host 提供的 requirement 和 action。
- 未满足的 `any_of` 组必须完整展示所有可执行配置路径，由用户选择其中一种；
  Agent 和 Host fallback 都不得只取组内第一项。卡片正文沿用 Ask 的最大高度，
  内容溢出时在正文区域纵向滚动，Header 与 Action 区保持可见。
- `any_of` 的多条路径使用同一个平坦纵向列表和 hairline 分隔，不渲染 radio、清单圆点
  或中性的 `Pending` 标签，避免暗示用户需要先选中或完成全部路径；每条路径仍完整展示，
  不折叠成 Provider selector，也不按具体插件或 Provider 定制布局。
- 单路径不再额外嵌套带边框卡片。`inline_form` 统一按「字段标题 → 输入框与对应 Action
  同行 → 辅助信息」呈现；校验错误原位替换字段说明，Host 声明的外链保持在同一辅助行
  右侧。更多路径继续使用相同列表结构，并由正文最大高度统一收口。
- 单字段内联配置只展示一层主说明：优先 Agent `intro`，缺失时才使用 step description；
  字段 label / hint 由 Host 展示，UI 不重复渲染同义的 step title / description。
- manifest 的 `network.secrets[].url` 若存在，Host 在字段旁展示本地化的
  「获取凭证」辅助入口；URL 不由 Agent 提供，也不进入 Agent 可回传的 plan。
- 主 Action 随步骤状态显示，例如「授权」「授权中」「等待授权」「检查中」「重试」「已完成」。
- 次级 Action 为「取消」。取消只终止当前挂起调用，不回滚已经完成的配置，也不影响其他等待同一插件的调用。
- 卡片在 setup 结束前保持展开，避免配置流程被隐藏或产生额外恢复入口。

### 2.2 通用状态

单步骤统一使用以下状态，不按 Gmail、Art 等具体插件分叉：

```ts
type PluginSetupStepPhase =
  | "pending"
  | "action_running"
  | "waiting_external"
  | "verifying"
  | "satisfied"
  | "failed"
  | "cancelled";
```

卡片终态：

- `ready`：所有 requirement 已由 Host 重新判定为满足，卡片关闭并恢复原调用；
- `cancelled`：用户取消当前调用；
- `failed`：Action 执行失败但仍可重试；
- `unavailable`：插件被卸载、停用、工具消失或配置声明变化，终止原调用并返回结构化错误。

### 2.3 典型流程

OAuth 插件：

```text
[icon] Google Gmail 设置
使用 Google Gmail 需要连接您的 Google 账号
[授权] [取消]

授权 → 授权中 → 等待浏览器完成 → 检查中 → 已完成
```

客户端内配置型插件：

```text
[icon] Cindy Art 设置
使用 Cindy Art 需要先配置可用的图片模型
[打开设置] [取消]

打开设置 → 等待保存 → 检查中 → 已完成
```

文案只是 Agent 编排示例；是否完成始终以 Host 的 setup assessment 为准。

简单填入型插件：

```text
[icon] XD Mivo 设置
使用 XD Mivo 需要配置 Mivo API Key
[密码输入框]
[获取 Mivo API Key ↗]
[保存配置] [取消]

保存配置 → 正在保存… → 正在检查… → 已完成
```

该输入只存在于本地 Desktop 当前组件的临时状态。插件详情页仍保留主动替换、清除和复杂
管理入口，但调用当下不再要求用户离开对话。

### 2.4 Desktop 真机效果

OAuth 授权：

![OAuth Setup 卡片](assets/plugin-setup-runtime/oauth-setup-card.png)

内联 Secret 配置：

![内联 Secret Setup 卡片](assets/plugin-setup-runtime/inline-secret-setup-card.png)

## 3. 职责边界

### 3.1 Agent

- 从 `ghost_list` 读取 Host 返回的 setup assessment；
- 在 `ghost_call` 中可选提交 setup plan；
- 决定对用户展示的步骤、顺序、标题和说明；
- 只能引用 Host 已允许的 requirement ref 和 action id；
- 不能读取 Secret、Token 或 OAuth 返回值；
- 不能声明某一步已经完成；
- setup 等待期间不会被再次唤醒。

### 3.2 Host / Main

- 提供可信的插件 id、名称和 icon；
- 从 manifest 和真实存储计算 setup assessment；
- 生成允许执行的 action 白名单；
- 校验 Agent setup plan，非法或缺失 plan 时生成安全默认 plan；
- 在任何附件授权、目录票据、沙箱启动、卡片注册或插件派发前执行 setup gate；
- 执行 Action、订阅配置变更、重新判定、广播卡片更新；
- ready 后继续原 `ghost_call`；
- 配置变化后再次验证插件存在、enabled、workdir policy、tool existence 和 setup；
- manifest 与 setup 引用漂移时，运行时 gate fail-closed 并返回结构化错误；
- 保证 Token / Secret 不进入 Agent、Ghost、interaction / pending snapshot、会话历史、
  日志、分析事件或远程通道；内联 Secret 只允许短暂存在于本地 Desktop 输入组件和
  trusted Renderer → Main 专用 IPC。

### 3.3 插件设置页

- 继续使用现有 `settings.html` / `settings.js`；
- 继续通过宿主受控端点保存 OAuth、KV、Secret 和 Connection；
- 作为用户主动管理、替换、清除和复杂配置的长期入口；简单 Secret 的调用前收单由
  Host Setup 卡完成；
- 不直接操作聊天卡状态；
- 保存成功即结束插件侧职责，Host 持久化层统一发出变更事件。

### 3.4 Renderer

- 复用 Ask 卡片外壳，不复用 Ask 的答案模型；
- 仅渲染 Host 下发的插件身份、经校验的 plan 和权威步骤状态；
- 普通 Action 点击只传 `requestId`、`actionId` 和期望 revision；
- 内联 Secret 只保存在组件临时 state，并经本地专用 IPC 一次性交给 Main；不得进入
  session store、interaction decision、pending snapshot 或持久化消息；
- 忽略低于当前 revision 的旧更新；
- 提交成功、取消、request / revision 替换和组件卸载时清空临时输入；
- 不读取已保存凭证，不自行判定 setup 完成。

## 4. 协议模型

### 4.1 Host assessment

`ghost_list` 在每个插件条目中增加动态 `setup`。未配置内容只包含引用、展示信息、状态和可执行 Action，不包含值。

```ts
type PluginSetupRequirementKind =
  "oauth" | "secret" | "connection" | "plugin_config" | "client_config";

type PluginSetupRequirementState = "missing" | "expired" | "satisfied";

interface PluginSetupAllowedAction {
  id: string;
  kind:
    | "oauth_connect"
    | "inline_form"
    | "open_plugin_settings"
    | "manage_connection"
    | "open_client_settings";
  form?: {
    fields: [
      {
        id: "value";
        type: "secret";
        label: string;
        description?: string;
        externalLink?: {
          url: string; // Host 从已校验的 manifest 声明生成；MCP 边界剥离
        };
        required: true;
        maxLength: number;
      },
    ];
  };
}

interface PluginSetupAssessment {
  state: "ready" | "required";
  revision: number;
  groups: Array<{
    id: string;
    mode: "any_of";
    items: Array<{
      ref: string;
      kind: PluginSetupRequirementKind;
      label: string;
      description?: string;
      state: PluginSetupRequirementState;
      actions: PluginSetupAllowedAction[];
    }>;
  }>;
}
```

约束：

- groups 之间为 all-of，group 内为 any-of，与现有 `setup.requires` 语义一致；
- `revision` 由 Host 单调递增；
- `ref` 是稳定关联引用，不是可执行路径或授权凭据；
- `satisfied` 条目可用于 Agent 理解 any-of 当前状态，但不暴露配置值；
- Action 按 `kind` 由 Renderer 做四语言按钮文案，不在 assessment 中下发未本地化文案；
- Host 可将现有 `secret`、`connection`、`kv` 声明映射成以上通用类型；
- 客户端内 Provider / 模型能力映射为 `client_config`，不要求插件伪造 Secret 或 KV；
- `client_config` 按 manifest 声明的 Host capability 匹配，不按插件 id 或具体
  Provider id 分支。新增使用既有 Host capability 的插件时，无需改 Setup Runtime Core。

### 4.2 Agent setup plan

`ghost_call` 增加可选 `setup_plan`。这是展示计划，不是授权或完成声明。

```ts
interface AgentPluginSetupPlan {
  assessmentRevision: number;
  intro?: string;
  steps: Array<{
    id: string;
    requirementRefs: string[];
    title: string;
    description: string;
    actionId: string;
  }>;
}
```

Host 校验：

- `requirementRefs` 必须存在于本次最新 assessment；
- `actionId` 必须属于这些 requirement 允许的 Action；
- plan 必须覆盖所有尚未满足 group 中的每个可执行 item；Agent 可调整顺序与文案，
  但不能隐藏某个合法配置路径；
- 字段长度、步骤数和字符集受限；
- Agent 不得提供插件名、icon、step phase、revision 或完成状态；
- 校验失败不执行任意 Action，Host 回落到按 assessment 生成的默认 plan。

这次工具 schema 扩展会改变一次 MCP 工具定义和 prompt cache 前缀；上线后 schema 保持稳定。插件安装、配置和状态变化只影响 `ghost_list` 返回值，不再动态改变工具定义。

### 4.3 Runtime interaction

Setup 使用现有 interaction push / dismissed 基础设施挂载和清理卡片，但使用独立 `plugin_setup` kind 和 Action 命令，不走 Ask 的 `answers`：

```ts
interface PluginSetupInteraction {
  kind: "plugin_setup";
  requestId: string;
  sessionId: string;
  ghost: {
    id: string;
    name: string;
    iconDataUrl?: string;
  };
  revision: number;
  intro?: string;
  steps: Array<{
    id: string;
    title: string;
    description: string;
    phase: PluginSetupStepPhase;
    action?: PluginSetupAllowedAction;
    errorMessage?: string;
  }>;
}
```

Renderer → Main：

```ts
type PluginSetupCommand =
  | {
      kind: "run_action";
      requestId: string;
      actionId: string;
      expectedRevision: number;
    }
  | {
      kind: "cancel";
      requestId: string;
      expectedRevision: number;
    };

interface PluginSetupInlineSubmit {
  requestId: string;
  actionId: string;
  expectedRevision: number;
  value: string;
}
```

- `run_action` / `cancel` 继续走现有通用 interaction resolve；
- `inline_form` 不进入通用 decision，Desktop Renderer 通过
  `maker:plugin-setup:submit-inline` 专用 invoke 提交；
- Main 只接受 trusted app frame，按 `requestId + actionId + expectedRevision`
  重新绑定最新 assessment 和 manifest 声明后写入保险库；
- Secret 值只在本地输入组件和这次 invoke 参数中短暂存在，不进入 interaction
  snapshot、pending snapshot、session store、消息历史、日志、分析或远程传输；
- pending snapshot 只允许保存脱敏字段 schema。reload / 切会话后卡片可恢复，但输入框
  必须为空，用户需要重新输入；
- 辅助 URL 必须来自当前 manifest 的 `network.secrets[].url`，满足安装期
  `https`、无内嵌凭证校验；Renderer 再做同样的协议/长度校验后才展示；
- 专用 invoke 不加入 device-link allowlist。远程端可看到等待态，但输入和主 Action
  禁用，并提示回到权威 Desktop 完成。

Main → Renderer：

- 首次 `INTERACTION_REQUEST` 挂载卡片；
- setup update push 使用完整 snapshot，而不是 Renderer 合并局部 patch；
- ready / cancel / unavailable 使用 `INTERACTION_DISMISSED` 清理；
- `getPendingInteractions` 或等价 pending snapshot 必须包含当前 setup，供窗口重载、切会话和后加入窗口恢复。

## 5. Main Runtime

### 5.1 Preflight 顺序

`ghost_call` 的顺序必须是：

```text
校验 ghost / workdir policy（普通调用同时校验 tool；grant_only 忽略 tool）
→ subscribe setup change
→ initial evaluate
→ ready：继续
→ required：挂起 coordinator + 展示卡片
→ ready / cancel / unavailable
→ 再次校验 ghost / workdir policy / setup（普通调用同时重验 tool）
→ grant_only：建立附件预授权并返回（不执行插件）
→ 附件授权 / dir ticket / save ticket
→ sandbox spawn
→ card registration
→ plugin dispatch
```

禁止在 setup ready 前产生授权记忆、目录票据、沙箱副作用或插件调用。已经进入 dispatch 的调用不因后续配置变化自动重试。

`grant_only` 只建立附件交接，不执行插件工具，并保持忽略 `tool` 的调用语义。非
Full Access 下，用户确认会建立人工 `ghost-grant`；本地 Full Access 下则只建立
`ghost-tool-grant` 取件引用，不弹卡，也不形成降档后仍生效的人工永久授权。两种路径都必须
先通过 Host-authoritative setup gate，禁止未配置插件提前获得任何媒体引用。旧插件页
`GhostSetupStatus` 投影可保留兼容行为；真正的运行时 gate 遇到缺失声明或无法解析的
requirement 时不得 fail-open。

### 5.2 Coordinator

每个未就绪的调用创建 waiter，保存：

- `requestId`、`sessionId`、`ghostId`、`tool`；
- 原始且已经完成输入结构校验的调用参数；
- Host 校验后的 setup plan；
- 当前 assessment revision；
- 超时、取消和 session cleanup。

Coordinator 必须先订阅 change bus，再做 initial evaluate，避免“刚保存配置但事件发生在订阅前”的丢失竞态。

同一个插件的多个 waiter 可共享底层状态 watcher，但每个 waiter 独立：

- 卡片和 session 生命周期；
- 取消；
- 原调用恢复；
- 错误返回。

取消一个 waiter 只 detach 当前 waiter，不终止 OAuth、不回滚配置、不取消其他 waiter。

### 5.3 Change bus

所有 setup 相关持久化成功路径统一 emit：

```ts
interface PluginSetupChanged {
  ghostId: string;
  source: "oauth" | "kv" | "secret" | "connection" | "manifest" | "host_config";
  ref?: string;
  revision: number;
}
```

必须覆盖：

- OAuth client 保存、账号连接、重连、删除；
- `/kv` 保存；
- `/secrets` 保存或删除；
- `/connections` 新增、修改、删除；
- 插件安装、更新、卸载、唤醒、沉睡；
- Host Provider / 模型配置保存。

插件自身的 OAuth、KV、Secret、Connection 和 manifest 变化携带 `ghostId`，只唤醒
对应插件的 waiter。Host Provider / 模型等共享配置没有可靠的单插件归属，因此使用
广播 wake：只唤醒当前正在等待 setup 的插件，由每个 waiter 根据自己的最新 manifest
和权威 Host 探针重新 assessment。广播事件本身不携带 plugin/provider 路由表，也不代表
任一插件已经 ready。

事件只表示“可能发生变化”，不能直接代表完成。Coordinator 收到事件后必须重新读取真实存储并执行 `evaluateGhostSetup`。

补强 recheck：

- Action Promise 完成；
- Desktop app-content 窗口重新获得焦点；
- pending snapshot 重建；
- Renderer 以旧 revision 发命令时。

### 5.4 Action 执行

Action 是 Host 生成和执行的能力句柄：

- `inline_form`：仅由 trusted Desktop Renderer 提交声明内 Secret 字段，Main 按最新
  assessment 和 manifest 重新绑定后写入保险库；
- `oauth_connect`：打开或复用现有 OAuth 流程；
- `open_plugin_settings`：打开目标插件设置页，可选聚焦对应 section；
- `manage_connection`：打开已有连接管理入口；
- `open_client_settings`：打开宿主 Provider / 模型配置入口。

Agent 只选择句柄，不能提供 URL、窗口参数、Secret key 路径或任意 IPC 名称。Main 在执行前按最新 assessment 再校验 action id。

### 5.5 结构化错误

本期只增加两个 setup 专用错误码，避免扩大现有工具错误协议：

- `SETUP_CANCELLED`：用户或 session 生命周期取消当前 waiter；
- `SETUP_REQUIRED`：当前入口没有可用交互面，必须转到 Desktop 完成配置。

等待超时沿用现有 `TIMEOUT`，assessment、受控 Action 或状态恢复失败沿用
`INTERNAL`。这些结果都发生在插件派发前，错误文案必须明确“本次调用未执行”；
不得触发 Agent 自动重试，是否重试由用户明确操作决定。

## 6. 安全边界

- 已保存的 Secret、OAuth access/refresh token、连接凭证只存在于 Main 的保险库或受控存储；
- assessment 只返回 `saved / missing / expired / satisfied` 等状态；
- Renderer store、interaction snapshot 和消息历史不接收 Secret 值、Token、OAuth code
  或连接详情；inline Secret 仅短暂存在于本地输入组件并通过专用 invoke 交给 Main；
- Agent / `ghost_list` / `ghost_call` 不接收 Secret 值；
- Ghost 在 setup 阶段不启动，也不能参与 readiness 判定；
- 插件 icon 由 Main 读取已安装包并转成受控 data URL；
- Agent 文案必须做长度限制；Renderer 按纯文本渲染；
- action id 与 requirement ref 均由 Host 校验，不能作为路径、URL 或 IPC 名直接执行；
- 日志仅记录 ghostId、ref、source、phase 和错误码，不记录配置值。

## 7. 并发、超时与恢复

- `revision` 单调递增；Renderer 忽略旧 snapshot，Main 拒绝或重查旧命令；
- 重复 Action 点击幂等：同一 request + action 运行中时不重复打开窗口；
- OAuth 外部窗口完成但回调丢失时，窗口聚焦 recheck 可收敛；
- Renderer reload 或新窗口通过 pending snapshot 恢复；
- session close / abort 清理 waiter，并以结构化取消结果结束 `ghost_call`；
- setup timeout 只结束等待，不撤销已保存配置；
- 插件卸载、停用、工具删除或 workdir policy 变化返回明确错误，不恢复派发；
- Main 退出时所有 waiter 以取消结束，不持久化原始调用参数到磁盘。

## 8. Desktop、Mobile、IM 与 Headless

本期结论：**当前分支只交付 Desktop；Mobile UI 和跨设备配置另开独立
worktree / 分支 / PR。所有入口都不得静默绕过 setup gate。**

- Desktop：完整 Ask-shell 卡片、Action、实时 update 和原调用恢复；
- Mobile / device-link：当前分支不声明支持 `plugin_setup` 原生卡片，也不修改
  `packages/maker-shared` / `apps/mobile`；后续任务需补协议 allowlist、只读等待态和
  “请在被控桌面完成设置”的明确引导，配置仍只能在 Desktop 完成；
- IM：返回安全的配置引导，不发送 Secret；需要 Desktop UI 的 Action 提示用户转到 Desktop；
- Headless / hook：Host 返回结构化 `SETUP_REQUIRED`，包含安全 assessment 和可操作提示，不自动打开本地窗口；
- 远端渠道不得为了“继续任务”而跳过 setup gate。

Desktop 功能 PR 必须明确 Mobile deferred，且注明 device-link allowlist 未变化。Mobile
支持必须作为独立 PR 验收，不能把未知 interaction 当作 raw snapshot 展示。

## 9. 任务拆分

当前 Desktop 分支的执行状态：

| 任务                         | 状态                    | 交付边界                                                |
| ---------------------------- | ----------------------- | ------------------------------------------------------- |
| T1 公共类型与 assessment     | 已实现                  | Host 权威 group / item / action 与严格运行时判定        |
| T2 Agent gateway             | 已实现                  | `ghost_list.setup`、可选 `ghost_call.setup_plan`        |
| T3 Change bus 与写入源       | 已实现 / 自动化通过     | 插件定向 wake；共享 Host 配置广播 wake + 权威重判定     |
| T4 Coordinator 与 preflight  | 已实现 / 自动化通过     | 竞态、取消、超时、恢复前二次校验                        |
| T5 Desktop interaction / IPC | 已实现 / 自动化通过     | pending snapshot、Action、dismiss、session cleanup      |
| T6 Ask shell / Renderer      | 已实现                  | 共用外壳、revision 去旧、四语言、Setup 固定展开         |
| T7 集成与验收                | 自动化 / 真机视觉通过   | 外部 OAuth 完成回流与 Host 配置保存仍需联调             |
| M1 Mobile / device-link      | 独立后续                | 单独 worktree / 分支 / PR，不混入 Desktop 改动          |

2026-07-24 验证记录：Desktop 全量单测、类型检查、i18n、endpoint、开发文档和
Mobile 回归已通过；对抗复查无未解决 P0/P1。已用 remote endpoint 启动当前 worktree
的 Electron 实例，并完成 OAuth 与内联 Secret 卡片的真机视觉验收。外部 OAuth
完成回流与 Host 配置保存仍需连接真实服务联调。

### T1 — 公共类型与 readiness assessment

范围：

- 扩展 shared setup 类型；
- 保留现有 `GhostSetupStatus` 兼容入口；
- 让 `evaluateGhostSetup` 产出完整 group / item verdict / allowed action；
- 新增单测：显式 setup、启发式、any-of、reauth、KV、client config、无凭证泄漏。

依赖：无。  
完成条件：Main 和 `cindy-tools` 可只依赖稳定类型。

### T2 — Agent gateway 协议

范围：

- `ghost_list` 返回每个插件的 setup assessment；
- `ghost_call` 接受可选 `setup_plan`；
- Host deps 接口透传 plan；
- plan schema 长度和数量上限；
- 更新 `packages/cindy-tools` 单测；
- 记录一次性 prompt cache schema 影响。

依赖：T1 类型契约。  
不负责：执行 Action、Renderer。

### T3 — Change bus 与写入源

范围：

- 建立 Main 进程内 `GhostSetupChangeBus`；
- OAuth、KV、Secret、Connection、manifest 生命周期保存成功后 emit；
- Host Provider / 模型配置成功后 emit `host_config`；
- revision、订阅/退订和幂等测试。

依赖：T1。  
不负责：卡片 UI。

### T4 — Setup coordinator 与 ghost_call preflight

范围：

- 在副作用前接入 setup gate；
- plan 校验与默认 plan；
- waiter、共享 watcher、Action 去重、timeout、cancel、session cleanup；
- ready 后恢复同一个调用；
- 恢复前二次校验；
- Main 单测覆盖竞态、并发、取消、卸载和不重复 dispatch。

依赖：T1、T3；可与 T5 并行，先用 fake bridge。

### T5 — Interaction bridge 与 IPC / preload

范围：

- `plugin_setup` request / update / dismissed；
- run action / cancel 命令；
- pending snapshot 恢复；
- preload 类型；
- device-link / mobile allowlist 评估和显式降级；
- IPC 参数校验与错误协议测试。

依赖：T1；与 T4、T6 对齐 payload。

### T6 — Ask shell 与 PluginSetupPrompt

范围：

- 从 `AskUserQuestionPrompt` 提取纯 UI shell；
- Ask 原行为不变；
- 新增 `PluginSetupPrompt`；
- session store、revision 去旧、展开/收起、reload 恢复；
- 四语言文案、Light / Dark token；
- Renderer 单测。

依赖：T1、T5 payload。  
不负责：readiness 和 Action 执行。

### T7 — 集成、验证与作者文档

范围：

- 接好真实 gateway、coordinator、bridge 和 UI；
- 更新插件作者文档：`settings.js` 无需卡片回调；
- 自动化检查；
- Electron 真实流程验证 OAuth、插件内配置和 Host 配置三类插件；
- 检查相邻状态：draft、focus、session switch、minimize、loading、error、disabled、abort；
- 更新最终文档使其与实际实现一致。

依赖：T1–T6。

## 10. 验收矩阵

| 场景                                     | 预期                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| 插件已 ready                             | 不展示卡片，直接进入现有 `ghost_call`                                                |
| OAuth 未连接                             | 卡片展示授权 Action；完成回调后立即更新并继续原调用                                  |
| OAuth 已过期                             | 展示重新授权；不得显示成普通缺失                                                     |
| Mivo 等单个 `source: "user"` Secret 缺失 | Ask 壳内展示 Host 字段并直接提交，不跳插件详情页                                     |
| 内联 Secret 保存成功                     | 展示保存中 / 验证中 / 已完成，并继续原 `ghost_call` 一次                             |
| 内联 Secret 保存失败                     | 清除本地值、展示失败并允许重新输入重试                                               |
| `settings.js` 保存 KV / Secret           | 保存成功后无需插件手写回调，卡片自动更新                                             |
| Connection 新增                          | 持久化成功后自动 recheck                                                             |
| Host Provider / 模型保存                 | `host_config` 触发相关插件 recheck                                                   |
| any-of                                   | 完整展示组内所有可执行备选；用户选择任一条并满足后完成该 group，其他备选无需配置     |
| 多 group                                 | 所有 group 满足才恢复调用                                                            |
| Agent plan 非法                          | Host 使用默认 plan，不执行非法 action                                                |
| 用户取消                                 | 当前 `ghost_call` 结束；已保存配置保留；其他 waiter 不受影响                         |
| 两个会话等待同一插件                     | 配置一次后两个 waiter 分别恢复，且各只 dispatch 一次                                 |
| reload / 切会话                          | pending snapshot 恢复卡片和最新 revision                                             |
| 旧 update / 重复点击                     | 旧 update 被忽略，Action 不重复执行                                                  |
| setup 中卸载插件                         | 卡片结束，返回结构化 unavailable 错误                                                |
| setup 中停止 session                     | waiter 清理，不产生插件调用                                                          |
| Secret / Token 检查                      | 除本地输入组件和专用 invoke 参数外，Renderer store、snapshot、MCP 返回、日志均不含值 |
| 设置窗口完成但事件丢失                   | committed-write event / Action / Desktop focus recheck 最终收敛                      |
| Mobile / device-link                     | 本分支不声明 UI 支持；不绕过 gate；独立 PR 补协议与只读等待态                        |
| IM / Headless                            | 返回安全的 `SETUP_REQUIRED`，不自动打开本地窗口                                      |

## 11. 实施风险

P0（必须由自动化测试阻断）：

- setup gate 接在附件授权、目录票据、沙箱或 dispatch 之后，导致用户未完成设置就产生副作用；
- Secret / Token / OAuth code 进入 Agent、Ghost、Renderer store、日志、分析、
  interaction / pending snapshot 或远程通道；本地输入组件与 trusted 专用 invoke
  的短暂 Secret 传递是唯一例外；
- 配置完成后重新发起第二次 `ghost_call`，或 dispatch 后自动重试，造成外部操作重复；
- 把 `settings.js` 的前端事件当成权威完成信号，而不重新读取 Host 存储；
- 声称支持 Art 等客户端配置，却没有 `client_config` 探针和受控 Action，错误放行为 ready。

P1（本期必须收敛）：

- runtime manifest 漂移沿用旧 setup 页的 fail-open 行为；
- reload / 切会话后 pending setup 无法恢复；
- session abort / close 未清 waiter，导致 MCP Promise 永久挂起；
- OAuth 全局单飞取消前一流程后，旧卡片没有进入可重试状态；
- 写入失败或仅尝试写入时误发 change event；
- Mobile / IM / Headless 静默绕过 setup gate。

## 12. 非目标

- 不让 Agent 读取或填写 Secret；
- 不让插件自行决定 setup 是否完成；
- 不为每个内建插件写专用聊天流程；
- 不在 setup 阶段启动插件沙箱；
- 不在本期实现跨设备填写 Secret；
- 不修改 Agent system prompt；
- 不改变已经派发中的插件调用的重试语义；
- 不把 Setup 卡片持久化为一条模型可见的 Ask 回答。

## 13. 实施分工与文件边界

为降低并行开发冲突，实施按以下边界拆分；文件名是当前代码结构下的主要落点，
实际实现可新增同目录模块，但不得跨层复制状态机。

### A. Assessment 与 Agent gateway

- `apps/desktop/src/shared/ghost.ts`
- `apps/desktop/src/main/cindy-brain/ghostSetupStatus.ts`
- `apps/desktop/src/main/cindy-brain/__tests__/ghostSetupStatus.test.ts`
- `packages/cindy-tools/src/types.ts`
- `packages/cindy-tools/src/ghost/mcpServer.ts`
- `packages/cindy-tools/src/__tests__/ghostMcp.test.ts`

负责 T1、T2：脱敏 assessment、`ghost_list.setup`、`ghost_call.setup_plan` 和边界测试。

### B. Main runtime 与配置变更源

- `apps/desktop/src/main/cindy-brain/index.ts`
- `apps/desktop/src/main/cindy-brain/runtime/ghost*Endpoint.ts`
- `apps/desktop/src/main/mcp-integrations/ghost.ts`
- `apps/desktop/src/main/cindy-brain/ghostSetup*.ts`
- `apps/desktop/src/main/maker-ipc/register.ts`
- `apps/desktop/src/main/maker-ipc/bridges/*`

负责 T3、T4 以及 T5 的 Main 部分：change bus、coordinator、preflight、Action
执行、pending snapshot、取消和恢复。

### C. Renderer 与 Ask-shell

- `apps/desktop/src/renderer/components/new-chat/AskUserQuestionPrompt.tsx`
- `apps/desktop/src/renderer/components/interaction-portal/*`
- `apps/desktop/src/renderer/components/new-chat/PluginSetupPrompt.tsx`
- `apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx`
- `apps/desktop/src/renderer/lib/makerChatStore.ts`
- `apps/desktop/src/renderer/hooks/useCCAgentChat.ts`
- `apps/desktop/src/renderer/i18n/locales/{zh-CN,en,ja,ko}/common.json`

负责 T6：只渲染 Host snapshot，复用 Ask 外壳、替换输入框、展开/收起、
revision 去旧和四语言文案。

### D. IPC、远程接线与整合

- `apps/desktop/src/main/maker-ipc/channels.ts`
- `apps/desktop/src/preload/preload.ts`
- `apps/desktop/src/renderer/vite-env.d.ts`
- `packages/device-link/src/allowlist.ts`
- `packages/device-link/src/topics.ts`
- `apps/desktop/src/shared/agentIsland.ts`

当前方案复用 `interaction-request`、`interaction-dismissed` 和
`get-pending-interactions` push / snapshot 基础设施。普通 Action 与取消继续复用
`resolve-interaction`；Secret 表单新增 trusted Desktop-only
`plugin-setup:submit-inline` invoke，且不得进入 device-link allowlist。本组负责核对
类型、preload 暴露、device-link 远程降级和 Agent Island 提示，并完成 T7 的跨层整合。

## 14. Review 风险门禁

### P0

- 任何 Secret、Token、OAuth code 或配置原值进入 Agent、Ghost、Renderer store、
  卡片 / pending payload、日志、分析或远程通道；本地输入组件与 trusted 专用 invoke
  的短暂 Secret 传递除外；
- setup 尚未 ready 就创建目录票据、授权记忆、沙箱或派发插件；
- 点击主 Action 即 resolve / 清卡，导致 OAuth 或插件内配置尚未完成而原调用继续；
- setup 未进入 pending snapshot，页面跳转、reload、切会话后调用永久挂起；
- 依赖 `settings.js` 主动回调或 Renderer 轮询，而不是持久化成功路径统一 emit；
- Main 未校验 request、revision、action 归属，或直接执行 Agent 提供的 URL / IPC；
- 远程控制端在本机打开不存在的插件设置或 OAuth；
- session done/error 抢先清卡，但 Main waiter 仍挂起。

### P1

- 未做 revision 单调保护，迟到 snapshot 令状态倒退；
- 复制 Ask DOM/CSS 而不是抽取壳，导致主题、尺寸和收起交互漂移；
- 新文案硬编码或四语言 key 不齐；
- 全局快捷键在 IME composing、收起态或后台窗口误触；
- 每次 update 抢焦点，或 ChatInput 恢复时后台窗口抢焦点；
- terminal 状态立即 dismissed，用户看不到完成或取消反馈；
- 插件卸载、停用、manifest/tool 漂移时没有 `unavailable` 收口；
- 隐藏会话的 Agent Island 仍显示 running，无法提示等待插件配置。
