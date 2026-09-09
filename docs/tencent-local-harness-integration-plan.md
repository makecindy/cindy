# Tencent 本地 Harness（tclaude / tcodex / CodeBuddy）接入实施方案

> 状态：基于真实 CLI 最小验证的实施设计  
> 更新时间：2026-09-09  
> 首期范围：Desktop 本机任务  
> 目标 CLI：`tclaude`、`tcodex`、`codebuddy`

## 1. 背景与目标

用户已经在本机安装并登录三种腾讯 CLI：

| CLI | 定位 | 本机验证版本 |
|---|---|---|
| `tclaude` | 官方 Claude Code 的腾讯鉴权/路由包装 | wrapper `0.1.6`，内含 Claude Code `2.1.251` |
| `tcodex` | 官方 Codex app-server 的腾讯鉴权/路由包装 | wrapper `0.0.16`，内含 Codex `0.144.5` |
| `codebuddy` | 独立 Agent Loop，提供 ACP/CLI/SDK 能力 | CodeBuddy `2.49.6` |

目标是让 Cindy 继续提供任务、会话、权限、MCP、文件与工具展示、多端查看和本地数据归属，
同时由本地腾讯 CLI 独占模型鉴权、token 刷新、模型目录和上游网关，不要求用户另行配置
Cindy Gateway、Anthropic API、OpenAI API 或外部订阅。

### 已确认的产品决策

- **两阶段交付**：第一阶段交付 `tclaude` / `tcodex` runtime variant；第二阶段交付
  CodeBuddy ACP Harness。
- **第一阶段即提供正式高级 Settings UI**，不以环境变量作为唯一用户入口。
- **CodeBuddy 旧端安全降级**：旧 Mobile / device-link 控制端可读消息与状态，但不提供
  创建、选模或 CodeBuddy 专属控制。
- **CodeBuddy 默认隔离**：只加载 `local` setting source，并只挂 Cindy 明确创建的 MCP
  配置；不默认继承用户或项目的 CodeBuddy Skill、插件、MCP 和 hooks。
- **候选功能必须进入支持计划**：每项功能在实现前标记为 MVP、probe-gated、上游依赖、
  延后或不支持，而不是根据 CLI 名称推断“应该可用”。

## 2. 已完成的最小可行性验证

所有验证均在 `/tmp` 临时工作目录中完成；未修改仓库、未读取或输出凭证明文。

| CLI | 已验证事实 | 可行性结论 |
|---|---|---|
| `tclaude` | `stream-json` 双向输入输出、真实推理、Session ID、thinking、usage、终态结果、原生 resume 均成功 | 可复用 `ClaudeCodeAgent` |
| `tcodex` | `app-server initialize`、`model/list`、`thread/start`、`turn/start`、流式消息、usage、隔离 `CODEX_HOME`、`skills/list`、`runtimeWorkspaceRoots`、plugin/skill config、`thread/unsubscribe` 均成功 | 可复用 `CodexAgent` |
| `codebuddy` | ACP v1 `initialize`、`notifications/initialized`、`session/new`、动态模型/权限模式、`session/prompt`、流式 update、权限请求拒绝、`session/load`、`session/set_mode`、`session/set_model`、`session/cancel` 均成功 | 需要新增 `CodeBuddyAgent` ACP Adapter |

### 2.1 已确认的关键约束

#### tclaude：必须由 Harness 接管模型路由

当模拟 Cindy 当前 Claude 路径注入：

```text
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1
ANTHROPIC_BASE_URL=<Cindy endpoint>
ANTHROPIC_API_KEY=<Cindy key>
ANTHROPIC_AUTH_TOKEN=<Cindy token>
```

时，`tclaude` 在超过 120 秒内未完成；同一 wrapper 不注入上述 provider/auth 环境时，真实
回合约 15 秒完成。因此 Tencent Claude 路径必须是：

```text
Cindy Claude adapter → tclaude → Tencent gateway
```

而不能是：

```text
Cindy proxy / provider env → tclaude → Tencent gateway
```

#### tcodex：采用 capability gate，不只看版本号

`tcodex` 自报上游 `0.144.5`，低于 Cindy 对官方 Codex 部分能力使用的 `0.145.0` 门槛。
但实测它已接受：

```text
--disable plugins --disable remote_plugin
thread/start.runtimeWorkspaceRoots
thread/start.config.plugins.*.enabled
thread/start.config.skills.config
thread/unsubscribe
```

并使用 `modelProvider=tencent` 成功完成真实推理。正式实现不得仅按 semver 决定可用性；
应以“版本 + 对实际功能的 capability probe”决定每项能力是否开放。

#### CodeBuddy：ACP v1 是稳定的最小接入面

实测 CodeBuddy ACP：

```text
initialize
notifications/initialized
session/new
session/prompt
session/request_permission
session/load
session/set_mode
session/set_model
session/cancel
```

满足 Cindy 首版所需会话、流式消息、权限、模型、模式、恢复和取消能力。已确认的协议形状：

- 使用 JSON-RPC 2.0，`protocolVersion = 1`；
- `session/new` 返回 `sessionId`、`models`、`modes`；
- 文本走 `session/update.agent_message_chunk`；
- 思考走 `session/update.agent_thought_chunk`；
- 工具走 `tool_call` / `tool_call_update`；
- 终态由 prompt request 的 response 返回 `stopReason`；
- 审批由 agent 反向请求 `session/request_permission`；
- `session/load` 会先重放历史 update，再返回当前 models/modes；
- `session/cancel` 是 notification。

CodeBuddy 默认读取用户设置时，可能因已有 marketplace/MCP 配置产生 stderr 错误或启动拖延。
以下启动约束已验证可以稳定完成主链路：

```text
--setting-sources local
--strict-mcp-config
--mcp-config {"mcpServers":{}}
--model <已验证模型>
```

因此 Cindy 首版必须默认只加载 `local` settings，并显式提供每个 Session 的最小 MCP 配置。

## 3. 产品与架构结论

### 3.0 已确认的交付决策

| 决策 | 结论 |
|---|---|
| 第一阶段发布 | `tclaude` 与 `tcodex` 必须同时完成并一起发布；不拆成单独上线版本 |
| 第一阶段入口 | 正式高级 Settings UI，不以环境变量作为唯一用户入口 |
| 默认与覆盖 | Settings 保存 Harness 默认；模型选择器可为单个任务显式覆盖来源/runtime |
| 显式 Tencent route 故障 | 保留原 route，显示修复信息与“切换到其他可用来源”；禁止自动 fallback |
| CodeBuddy resume stdout | 第一阶段允许对已验证的 `convertHistoryItemToAcp` 调试前缀做窄白名单过滤并记录诊断；其它非 JSON stdout 一律协议错误 |
| tcodex capability profile | Settings-time probe 后按 executable identity 缓存；wrapper 路径、realpath、版本、大小或 mtime 变化即失效重测 |
| CodeBuddy 资源继承 | 第一阶段始终隔离，只加载 `local` settings 和 Cindy 明确装配的 MCP；不提供用户/项目原生环境例外 |

### 3.1 tclaude / tcodex：现有 Harness 的 runtime variant

它们不新增产品级 Harness：

```text
ClaudeCodeAgent
├── Cindy managed Claude Code
└── Tencent local tclaude

CodexAgent
├── Cindy managed Codex
└── Tencent local tcodex
```

`AgentKind` 保持：

```ts
type AgentKind = 'claude-code' | 'codex' | 'pi';
```

现有 Session、Mobile、device-link、数据库中的 `cc` / `codex` 语义不变。

### 3.2 CodeBuddy：独立 Harness

CodeBuddy 不是 Claude Code 或 Codex 的二进制替换。它必须作为独立 Agent：

```text
CodeBuddyAgent
  → ACP client
    → codebuddy --acp --acp-transport stdio
```

因此需要 append-only 扩展：

```ts
type AgentKind = 'claude-code' | 'codex' | 'pi' | 'codebuddy';
```

旧控制端必须能安全处理未知/新增 agent kind：至少展示任务的普通消息、状态与
`fallbackMarkdown`，不得因未知枚举导致任务列表、消息页或 device-link 崩溃。

### 3.3 职责边界

| 能力 | Cindy | 腾讯 CLI |
|---|---:|---:|
| 腾讯账号、token、刷新 |  | ✓ |
| 模型 endpoint 与上游鉴权 |  | ✓ |
| 模型目录 | 读取并投影 | 权威来源 |
| Session 产品记录和消息存储 | ✓ |  |
| 工作目录和生命周期 | ✓ |  |
| 权限 UI 与用户决定 | ✓ | 执行协议 |
| MCP bridge | ✓ | 消费 |
| 任务、工具、usage 展示 | ✓ | 上报事件 |
| 多端投影 | ✓ |  |

禁止：

- Cindy 读取、复制或保存 `~/.tclaude`、`~/.tcodex`、`~/.codebuddy` 中的认证材料；
- Tencent CLI 接收 Cindy Gateway/OpenAI/Anthropic 凭证；
- 显式 Tencent route 失败后静默切换到其他付费来源；
- Renderer 直接传任意 executable 或 command string 给 Main 执行。

## 4. Runtime Profile 与可执行文件

新增 Main-owned runtime profile：

```ts
export type AgentRuntimeDistribution =
  | 'cindy-managed'
  | 'tencent-local';

export interface AgentRuntimeProfile {
  agentKind: 'claude-code' | 'codex' | 'codebuddy';
  distribution: AgentRuntimeDistribution;
  executable: string;
  argsPrefix: string[];
  authOwner: 'cindy' | 'harness';
  routeOwner: 'cindy' | 'harness';
  configHomePolicy: 'cindy-isolated' | 'harness-default';
  wrapperVersion?: string;
  upstreamVersion?: string;
  verifiedCapabilities?: Record<string, boolean>;
}
```

### 4.1 Launch plan

`tclaude` 是原生二进制，可直接执行：

```ts
{
  executable: '/absolute/path/to/tclaude',
  argsPrefix: [],
}
```

`tcodex` 与 `codebuddy` 是 Node shebang wrapper。正式 Electron 从 Finder 启动时不保证
继承 NVM 或用户 shell PATH，应保存 Node 解释器和 entry script 的绝对路径：

```ts
{
  executable: '/absolute/path/to/node',
  argsPrefix: ['/absolute/path/to/@tencent/.../bin/<wrapper>'],
}
```

所有 spawn 必须：

```ts
spawn(executable, [...argsPrefix, ...runtimeArgs], {
  shell: false,
  windowsHide: true,
});
```

不得拼接 shell 命令。

### 4.2 路径与版本校验

保存 override 和每次执行前都检查：

1. 路径绝对化并 `realpath`；
2. 最终目标存在且可执行；
3. wrapper 类型与目标 agent kind 匹配；
4. `--version` 输出可解析；
5. wrapper/upstream identity 变化时重新 probe；
6. 用户显式批准新 identity；
7. 高风险 capability 未通过 probe 时保持关闭。

持久化的 identity 只包含非秘密字段：

```ts
interface ApprovedExecutableIdentity {
  realpath: string;
  size: number;
  mtimeMs: number;
  wrapperKind: 'tclaude' | 'tcodex' | 'codebuddy';
  wrapperVersion: string;
  upstreamVersion?: string;
}
```

## 5. tclaude 设计

### 5.1 Adapter 复用

继续使用 `ClaudeCodeAgent` 和 Claude Agent SDK：

```ts
pathToClaudeCodeExecutable: resolvedRuntime.executable
```

已验证 `tclaude` 的 stream-json 事件形状兼容现有 Claude translator：init、thinking、
assistant、result、usage 与 session ID 都可用。

### 5.2 Harness-owned auth/routing

Tencent runtime 下：

- `AuthAdapter.getState()` 通过 wrapper 的稳定状态接口确认，而不是读取 Cindy Gateway；
- `getAuthEnv()` 默认返回空对象；
- 不设置 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`；
- 不设置 `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、
  `CLAUDE_CODE_OAUTH_TOKEN`；
- 不启动或使用 Cindy Anthropic compatibility proxy；
- `triggerLogin()` / `logout()` 仅执行受信 wrapper 的对应命令。

当前仍可安全保留、但要以集成测试锁定的环境仅限：

```text
CLAUDE_CODE_DISABLE_CRON=1
PYTHONUTF8=1
PYTHONIOENCODING=utf-8
```

`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、自动 compact、subagent model、Explore cap 和 Fast
相关变量默认不传，只有针对 Tencent CLI 的实测证明无冲突后才逐项开放。

### 5.3 Session 与 one-shot

`tclaude --resume <id>` 已验证成功。Cindy 可继续存储原生 session id，但 Cindy-managed 与
Tencent-local distribution 之间禁止直接 resume；切换时走冷重建交接。

`ClaudeCodeAgent.oneShot()` 目前直连 Anthropic API，不能复用 Tencent auth。MVP：

- Tencent Claude 不参与 direct API one-shot 候选；
- 没有其他 utility model 时使用确定性标题/摘要降级；
- 后续可增加 `tclaude` CLI-backed one-shot，但必须无写工具、无 MCP、有限 max turns。

## 6. tcodex 设计

### 6.1 Adapter 复用

继续使用：

```text
CodexAgent
AppServerHost
AppServerClient
Codex translator
```

启动：

```text
<node> <tcodex-entry> app-server <Cindy host capability args>
```

已验证：

- initialize；
- model/list；
- thread/start；
- turn/start；
- 流式 assistant 文本；
- token usage；
- 隔离 `CODEX_HOME`；
- `skills/list`；
- `runtimeWorkspaceRoots`；
- `plugins.*.enabled`、`skills.config`；
- thread/unsubscribe。

### 6.2 认证、路由与 CODEX_HOME

Tencent route 下不注入：

- Cindy Codex proxy；
- Cindy Gateway key；
- OpenAI OAuth；
- provider OAuth 占位值；
- Cindy custom provider route；
- Cindy model provider override。

但保留 Cindy-managed `CODEX_HOME`。真实验证表明 wrapper 登录与隔离 `CODEX_HOME` 可共存，
并由 Tencent `modelProvider` 完成推理。这样能隔离：

- rollout/session；
- Cindy 注入的 MCP；
- Cindy Skills/插件配置；
- 多任务并发状态。

### 6.3 Capability gate

对 `tcodex` 不用单一 semver 判定全部功能。启动时记录：

```ts
interface TcodexCapabilities {
  appServer: boolean;
  modelList: boolean;
  runtimeWorkspaceRoots: boolean;
  pluginDisableConfig: boolean;
  skillsConfig: boolean;
  threadUnsubscribe: boolean;
  approvalRequests: boolean;
  namedPermissionProfiles: boolean;
  forkExcludeTurns: boolean;
  reviewIsolation: boolean;
}
```

MVP 只开启已验证的普通任务能力。Review、named permission profile、fork、复杂 MCP
capability routing、远程压缩等能力必须单独 probe；失败即隐藏或拒绝该能力，不降低安全边界。

### 6.4 普通任务权限

普通 Codex Tencent Session 继续走现有 Codex permission protocol。注意：测试中使用低层
`workspaceWrite` 参数时，wrapper 执行了写命令而没有发 approval request；正式实现不能依赖
手工构造的简化 sandbox 参数。必须复用 Cindy 现有 `currentThreadWorkspaceConfig()` /
`currentTurnWorkspaceConfig()` 和 `turnPermissionPolicy` 链路，使用经验证的 Cindy
permission profile 与 server request handler。

## 7. CodeBuddy ACP Adapter 设计

### 7.1 新模块

新增：

```text
packages/maker-core/src/agents/codebuddy/
├── index.ts
├── acp-client.ts
├── protocol.ts
├── translator.ts
├── transport.ts
└── __tests__/
```

```ts
export class CodeBuddyAgent extends BaseAgent {
  readonly kind = 'codebuddy' as const;
  readonly capabilities: Capabilities;

  override startSession(
    options: StartSessionOptions,
  ): Promise<AgentSessionHandle>;
}
```

首期每个 Cindy Session 启动一个：

```text
codebuddy --acp --acp-transport stdio
```

不共享 ACP 进程，直到多 Session 并发、取消和崩溃隔离有专门证据。

### 7.2 固定启动参数

```text
--acp
--acp-transport stdio
--setting-sources local
--strict-mcp-config
--mcp-config <Cindy 临时最小配置>
--model <Session 当前模型>
```

`--setting-sources local` 是当前已验证的隔离边界：不继承 user/project/global 配置。
`--strict-mcp-config` 单独使用不足以阻止部分默认 marketplace/MCP 初始化，因此必须与
`--setting-sources local` 同时使用。

### 7.3 ACP 到 Cindy 的映射

| ACP | Cindy |
|---|---|
| `session/new` | 创建原生会话，持久化 `sdkSessionId` |
| `session/load` | 恢复并按 update 重投历史 |
| `session/prompt` | `handle.send()` |
| `session/cancel` | `handle.abort()` |
| `session/set_model` | `handle.setModel()` |
| `session/set_mode` | `handle.setPermissionMode()` |
| `session/fork` | `forkSdkSession()` |
| `session/update.agent_message_chunk` | 文本流 |
| `session/update.agent_thought_chunk` | thinking 流 |
| `session/update.tool_call` / update | 工具事件 |
| `session/request_permission` | `InteractionResolver` |
| prompt response `stopReason` | 单一终态 done/error |

`steer`、manual compact、rewind、Fast mode、background task 先不声明支持，直到 ACP 真实
能力和事件契约验证完成。

### 7.4 权限

已验证 CodeBuddy 在写文件前：

1. 发送 `tool_call`，带稳定 `toolCallId`、文件路径、diff 和 kind；
2. 反向请求 `session/request_permission`；
3. 收到 `reject` 后返回 `stopReason=refusal`；
4. 文件未落盘。

首版支持：

```text
ask                → default
acceptEdits        → acceptEdits
plan               → plan
bypassPermissions  → bypassPermissions（仍需 Cindy Full Access 确认）
auto               → 暂不支持，回退 ask
```

对每次 permission request：

- 解析 options；
- 映射“允许一次 / 始终允许 / 拒绝”；
- 将会话级批准映射为 Cindy 的 session permission update；
- 超时、未知 option、resolver 崩溃一律选择拒绝；
- prompt 终态必须与已处理的审批 request 一致结算。

### 7.5 模型、模式与恢复

`session/new` 和 `session/load` 已验证返回：

```ts
{
  models: { availableModels, currentModelId },
  modes: { availableModes, currentModeId }
}
```

因此 CodeBuddy 模型目录以 ACP session 返回为真相源，不读取私有缓存或配置库。

已验证：

```text
session/set_mode
session/set_model
session/load
session/cancel
```

恢复时 CodeBuddy 会向 stdout 重投历史 update。ACP transport 不能容忍非 JSON stdout：
当前 `session/load` 曾观察到 CodeBuddy 写出调试文本 `[convertHistoryItemToAcp] ...`。第一阶段
允许只对这个**精确前缀**做有限过滤，并记录每次过滤的诊断；其它非 JSON stdout 仍必须作为
协议错误。Tencent 应将该调试输出移到 stderr，届时删除兼容过滤器。

### 7.6 MCP、Skill、插件与特殊任务

CodeBuddy 首版只注入 Cindy 明确创建的 MCP 配置。由于 `local` setting sources 已隔离
user/project/global settings：

- 普通任务默认不继承用户 CodeBuddy MCP、Skill、插件；
- Bot、Review、Scheduler 初期默认关闭 CodeBuddy，或只在有专门 capability profile 后启用；
- 不得通过 prompt 声称某类插件/Skill 已禁用；
- Cindy 与 CodeBuddy 同名工具需增加 `codebuddy` capability-routing adapter。

## 8. 模型与 Provider

新增 Harness-managed provider：

```text
tencent-claude
tencent-codex
tencent-codebuddy
```

它们不是普通 HTTP `CustomProviderConfig`，不暴露可编辑 base URL/API key。

模型来源优先级：

1. `tcodex app-server model/list`；
2. CodeBuddy `session/new.models`；
3. `tclaude runtime-info --json` 或稳定模型接口；
4. Tencent 发布的版本 manifest；
5. 仅 tclaude 暂时使用受控静态 snapshot。

每条模型至少投影：

```text
id、名称、context window、max output、图像输入、reasoning、effort、默认 effort、可用状态
```

Tencent route 不依赖 Cindy account provider readiness，但仍必须在启动前完成：

```text
runtime profile 已解析
CLI probe 通过
模型存在于该 runtime 快照
```

不能因为跳过 Cindy Gateway readiness 而允许空模型任务启动。

## 9. Session、数据库与跨端

### 9.1 Session 切换

同一业务任务内从 Cindy-managed 切 Tencent-local，或从任意其它 Harness 切 CodeBuddy，均是
原生运行时身份变化：

1. 冻结最近上下文；
2. 关闭旧 handle；
3. 不复用旧 `sdkSessionId`；
4. 以受控交接摘要启动新 runtime；
5. 保持同一 Cindy 业务 Session；
6. 有工具副作用时禁止自动重放用户消息。

### 9.2 CodeBuddy AgentKind

`codebuddy` 是 append-only 新 `AgentKind`。需审计：

```text
packages/maker-core/src/types/common.ts
packages/model-providers/src/types.ts
apps/desktop/src/shared/agentKindConversion.ts
apps/desktop/src/preload/preload.ts
packages/maker-shared/
packages/device-link/
apps/mobile/
apps/desktop/src/main/localDb/schema.ts
```

所有旧三元分支都要显式处理 CodeBuddy，避免被误判为 Pi。

数据库主 `sessions.agent_kind` 当前为 text，但相关 usage、输入队列、Bot、Scheduler 和
Review 表的 schema/validator 必须一并审计；存在数据库 enum/check 时添加 append-only
migration，不能把 CodeBuddy 存成 `cc`、`codex` 或 `pi`。

### 9.3 Device-link 与 Mobile

首期 Desktop 执行端支持完整 CodeBuddy。Mobile/旧控制端先保证：

- 普通消息与任务状态可读；
- 停止可用；
- 未知 CodeBuddy 专属操作隐藏；
- 不因新 kind 解析失败。

新建 CodeBuddy 任务、模型选择、fork、Skill 和高级控制仅在双方 capability 都支持时开放。

## 10. MVP 实施范围

### 可交付

| CLI | MVP |
|---|---|
| tclaude | 新任务、stream、resume、模型选择、现有 Claude 工具/权限/MCP 链路 |
| tcodex | 新任务、模型发现、流式消息、隔离 `CODEX_HOME`、已 probe 的普通任务能力 |
| CodeBuddy | ACP 新任务、load、流、模型/模式切换、权限、取消、最小 MCP |

### 候选功能支持计划

状态定义：

| 状态 | 含义 |
|---|---|
| **MVP** | 已有真实协议证据，纳入当前阶段交付 |
| **Probe-gated** | 仅在该 executable identity 的 capability probe 通过后开放 |
| **Upstream dependency** | 需要腾讯 CLI 修复或提供稳定契约后才能正式开放 |
| **Deferred** | 不是当前阶段范围，但保留明确入口与验收条件 |
| **Unsupported** | 当前明确不提供，不做静默兼容 |

| Harness | 候选功能 | 阶段 | 状态 | 准入或退出条件 |
|---|---|---:|---|---|
| tclaude | 新任务、流式文本、usage | 1 | MVP | 已验证 stream-json |
| tclaude | 原生 resume | 1 | MVP | 已验证 `--resume` |
| tclaude | Cindy MCP 与工具审批 | 1 | Probe-gated | Claude SDK `canUseTool`、MCP 与拒绝写入 smoke |
| tclaude | Fast、自动 compact、subagent model | 1+ | Probe-gated | 单项环境变量兼容和回归验证 |
| tclaude | CLI-backed one-shot | 2+ | Deferred | 无工具、无 MCP、有界调用的独立实现 |
| tcodex | 新任务、模型列表、流式文本、usage | 1 | MVP | 已验证 app-server 主链路 |
| tcodex | 隔离 `CODEX_HOME`、workspace roots、plugin/skill config | 1 | MVP | 已验证 |
| tcodex | Review、复杂 permission profile、fork、远程压缩 | 1+ | Probe-gated | 每项 capability probe 与安全测试 |
| CodeBuddy | 新任务、模型/模式、流、权限、取消 | 2 | MVP | ACP v1 已验证 |
| CodeBuddy | 原生 load/resume | 2 | MVP | 仅过滤已验证的 `convertHistoryItemToAcp` stdout 前缀；其它污染 fail closed，并持续推动上游改 stderr |
| CodeBuddy | Cindy MCP bridge | 2 | Probe-gated | 最小 MCP 配置的真实工具调用、权限和清理测试 |
| CodeBuddy | fork、rewind、background task、Auto | 2+ | Deferred | 独立协议和产品语义设计 |
| CodeBuddy | Bot、Review、Scheduler | 2+ | Deferred | 可确定性隔离 Skill/插件/权限后再评估 |
| CodeBuddy | 完整 Mobile/device-link 控制 | 3 | Deferred | 新 kind capability 协商与 UI 设计完成 |

### capability-gated 或后续

| 能力 | 策略 |
|---|---|
| tclaude 自动 compact、Fast、subagent model | 逐项验证后开启 |
| tcodex Review、fork、复杂 profile、远程压缩 | capability probe 后开启 |
| CodeBuddy fork、rewind、background tasks、Auto | 暂不开放 |
| CodeBuddy Bot、Review、Scheduler | 默认关闭，单独设计 |
| 三者 SSH remote | 后续独立项目 |
| 多端完整 CodeBuddy 控制 | 后续 append-only protocol 版本 |

## 11. 文件改动地图

新增：

```text
apps/desktop/src/main/harness-runtime/
├── types.ts
├── settings-store.ts
├── executable-resolver.ts
├── probe.ts
├── tencent-auth-adapter.ts
└── __tests__/

packages/maker-core/src/agents/codebuddy/
├── index.ts
├── acp-client.ts
├── protocol.ts
├── translator.ts
├── transport.ts
└── __tests__/
```

修改：

```text
packages/maker-core/src/interfaces/auth-adapter.ts
packages/maker-core/src/interfaces/runtime-config.ts
packages/maker-core/src/agents/claude-code/env-builder.ts
packages/maker-core/src/agents/claude-code/index.ts
packages/maker-core/src/agents/codex/index.ts
packages/maker-core/src/agents/codex/app-server/stdioTransport.ts
packages/maker-core/src/agents/index.ts
packages/maker-core/src/types/common.ts
packages/maker-core/src/types/events.ts
packages/maker-core/src/types/capabilities.ts

apps/desktop/src/main/maker-host/index.ts
apps/desktop/src/main/maker-ipc/binary-version.ts
apps/desktop/src/main/maker-ipc/providerHandlers.ts
apps/desktop/src/shared/agentKindConversion.ts
apps/desktop/src/preload/preload.ts

packages/model-providers/src/types.ts
packages/model-providers/src/catalog.ts
packages/model-providers/src/unifiedSelection.ts
packages/maker-shared/
packages/device-link/
apps/mobile/
```

第一阶段的 Settings UI、模型选择器来源展示和 i18n 必须与 `tclaude + tcodex` 同时完成，
并同时交付 Light/Dark。

## 12. 分阶段计划

### Phase 1：tclaude / tcodex MVP 与正式 Settings

1. 实现 runtime profile、受信 executable resolver 和版本/capability probe。
2. 为 tclaude/tcodex 接入 harness-owned auth/routing。
3. 将 Codex spawn 配置拆成 host capability 与 model routing 两部分。
4. 添加 Tencent Claude/Codex provider/model projection。
5. 实现正式高级 Settings UI、受控文件选择、默认 runtime 和单任务来源覆盖。
6. 完成 tclaude/tcodex 的真实 smoke、能力 profile 与失败修复入口。

### Phase 2：CodeBuddy ACP

1. 实现 CodeBuddy ACP transport/client/translator/agent。
2. 添加 `codebuddy` AgentKind 的 Desktop 数据链路与 provider/model projection。
3. 固化 `local` settings 与最小 MCP 运行时配置。
4. 实现 CodeBuddy 新任务、load、模型/模式、权限与取消。
5. 实现已知 stdout 调试前缀的窄过滤，并记录诊断。
6. 完成 Mobile/device-link 的安全只读降级。

### Phase 3：能力收敛与后续产品化

1. 将已完成的真实 smoke 固化为脚本。
2. 添加 fake wrapper / fake ACP 的单元与集成测试。
3. 对 tcodex 高风险能力执行 capability probe。
4. 推动或验证 CodeBuddy stdout 调试行上游修复。
5. 扩展 CodeBuddy resume、fork、Review、Bot、Scheduler 和完整多端控制。

## 13. 测试与验收

### 必须自动化

- runtime override 的默认、保存、恢复默认、owner 隔离；
- executable realpath、symlink、Node wrapper launch plan、身份漂移；
- tclaude 不注入 Cindy provider/auth env；
- tcodex capability probe 与关闭未验证能力；
- CodeBuddy ACP JSON validator、未知字段、未知关键消息、stdout 纯度；
- CodeBuddy permission allow/reject/timeout；
- CodeBuddy session/load 历史重投；
- CodeBuddy mode/model/cancel；
- `codebuddy` 不落入任何旧 AgentKind fallback；
- device-link/Mobile 对新 kind 的旧端降级；
- stop/close/崩溃后的子进程确认退出。

### 提交前门禁

```bash
pnpm test:unit:related
pnpm --filter @cindy/maker-core run --if-present typecheck
pnpm --filter @cindy/model-providers run --if-present typecheck
pnpm --filter desktop run --if-present typecheck
```

涉及 wire、数据库、IPC 和权限时按专项规则追加测试。

## 14. 风险与硬约束

| 风险 | 处理 |
|---|---|
| tclaude 被 Cindy provider env 劫持 | Tencent route 下彻底关闭 Cindy Claude provider/auth 注入 |
| tcodex 低版本误开高风险能力 | capability probe；未验证即关闭 |
| CodeBuddy 用户 MCP/插件污染 | `--setting-sources local` + `--strict-mcp-config` + Cindy 最小 MCP |
| CodeBuddy resume stdout 混入调试行 | 优先上游修复；仅对已知前缀窄过滤，其余 fail closed |
| Renderer 任意执行本机程序 | Main-owned profile、批准、realpath、执行前复核 |
| token 泄露 | 不读取私有 auth 文件；stderr/日志统一脱敏 |
| 显式选择失败后意外换付费来源 | 不静默 fallback |
| 新 `codebuddy` wire 破坏旧端 | append-only、fallbackMarkdown、能力协商和分阶段发布 |

## 15. 最终结论

三种 CLI 的接入协议均已通过真实最小验证：

```text
tclaude  → 现有 ClaudeCodeAgent 的 Tencent runtime variant
tcodex   → 现有 CodexAgent 的 Tencent runtime variant
CodeBuddy → 新 CodeBuddyAgent，通过 ACP v1
```

技术可行性问题已经收敛。后续实现重点不是继续探索 CLI 是否可用，而是按本方案落实：

1. 单一的 auth/route owner；
2. 受信 executable 与 capability profile；
3. CodeBuddy ACP adapter；
4. CodeBuddy 的 append-only 跨端兼容；
5. 未验证高风险能力默认关闭。
