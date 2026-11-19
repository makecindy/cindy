# ACP 插件桥接层：让插件提供任务执行引擎

> 状态：第 1–4 步已在 `feat/acp-plugin-bridge` 实现，待真实 DSH 联调与维护者评审；不代表发布承诺。
> 核对日期：2026-11-18。源码基线：`12d21eb7b3`。

## 要解决的问题

用户希望在 Cindy 里使用 Gemini CLI、DeepSeek Harness（DSH）、Cursor、OpenCode 等第三方
Agent 跑任务，但 Cindy 不逐个内置它们。这些 Agent 大多已支持 [Agent Client Protocol](https://agentclientprotocol.com)
（ACP，stdio 上的 JSON-RPC）。本设计让**插件声明一个 ACP Agent**，由 Cindy Core 以统一的
ACP 引擎把它当作任务执行引擎运行。

第一期交付两件事：

1. **插件桥接层**：Core 的通用 ACP 引擎 + 插件清单的通用声明字段。
2. **DSH 插件**：启动用户本机已安装的 `dsh --profile acp`，Cindy 不负责安装、分发 DSH。

依据[核心产品原则](../product-rules/core-product-principles.md)：Agent 连接与任务生命周期属于
Core，具体外部能力进插件；Core 只提供稳定、通用的原语（ACP 引擎），不为某个 CLI 写特例。
与[DSH 接入计划](dsh-harness-integration.md)的差异：本设计不由 Cindy 受控分发 DSH，而是由插件
启动本机已安装的版本（2026-11-18 用户决定）。

## 硬约束：不影响内置 Agent

Claude Code、Codex、Pi 的行为不得有任何变化。具体做法：

- **内置引擎类型不变**。各 package 的 `AgentKind = 'claude-code' | 'codex' | 'pi'` 保持原样。
  只在 maker-core 与 Desktop 的任务生命周期路径上新增 `EngineKind = AgentKind | 'acp'`。
- **引擎清单不变**。`Maker.listAvailableAgents()` 继续只返回内置三种，设备互联、手机、
  多 Agent 协同、定时任务、给 Agent 的工具参数（send_to_session、session_control 等）都看不到
  `acp`。另加仅本机可用的 `listLocalEngines()` 给模型选择器用。
- **内置目录与转换函数不改**。`agents/claude-code|codex|pi/` 不改；三种类型的 DB ↔ 运行时
  转换函数保持逐字节一致，ACP 走新增的 `dbToEngineKind`。
- **按需注册**。没有任何已启用、已批准的插件声明 ACP Agent 时，`acp` 引擎根本不注册，
  运行时与今天完全相同。
- **只做加法的防护**。会遍历全部任务的地方（用量统计、搜索、IM、历史导入等）遇到 `acp`
  任务一律跳过；手机或远端对 `acp` 任务发来的引擎专属请求（切换引擎、上下文用量等）由
  Desktop 拒绝。
- **不复制** PR #11135 中改变全体引擎行为的写法（例如把 `contextWindow > 0` 放宽为 `>= 0`）。

验收时必须证明：未安装 ACP 插件时，可用引擎列表、能力快照、内置三引擎的现有测试与全部
类型检查与改动前一致。

## 整体结构

```
任务界面（桌面）
   │ 发送 / 停止 / 切模型 / 权限确认
   ▼
maker-core  AcpAgent（kind = 'acp'）── 翻译 ──► 统一 AgentEvent
   │ ACP v1 JSON-RPC（逐行）
   ▼
Desktop  AcpEngineSlot ── 用插件 Node 运行时以「原始 stdio」方式启动插件声明的入口
   │
   ▼
插件入口（如 dsh-acp.js）── spawn ──► 本机 dsh --profile acp
```

Cindy 主进程**从不执行插件写的命令**，只启动插件包里声明过的 JS 入口；入口自己找到并启动
外部 Agent，把字节原样转发。这样不新增主进程执行面，安装确认也能如实描述。

## 一、maker-core：通用 ACP 引擎

新目录 `packages/maker-core/src/agents/acp/`，不依赖 Electron、插件或任何具体 Agent：

| 文件 | 职责 |
| --- | --- |
| `protocol.ts` | ACP v1 字段子集与宽容解析（按 schema 的 default-on-error 语义） |
| `line-transport.ts` | 宿主注入的逐行传输接口（`write`、`onLine`、`onClose`、`close` 以退出确认为准）与分块解码器 |
| `connection.ts` | JSON-RPC 双向连接：请求、通知、对端请求、超时、断链收尾；忽略 stdout 上的非协议行；对端错误文本截断并去控制字符 |
| `translator.ts` | `session/update` → `AgentEvent`（会话级实例，跨回合保持同一工具卡片） |
| `capabilities.ts` | 由 `initialize` 与配置项生成 `Capabilities`、模型列表与推理强度映射 |
| `session.ts` | `openAcpSession` 握手与 `AcpSession`（满足 `AgentSessionHandle` 形状，编译期校验） |
| `acp-agent.ts`（第 3 步） | `AcpAgent extends BaseAgent`，按「插件 Agent 标识」分派到宿主注册的端点 |

第 1 步自写最小 JSON-RPC 客户端，不新增依赖、不改锁文件；只实现 v1，v2 草案不接。
不经 ACP 向 Agent 注入 Cindy 的 system prompt（v1 已支持客户端 system prompt）；以后要注入，
按 [Agent 行为规则](../dev-rules/maker-core-and-agent-behavior.md)的 system prompt 门禁单独评审。

**行为映射**

| Cindy | ACP v1 |
| --- | --- |
| 新建任务 | `initialize` → `session/new`（`cwd` = 任务工作目录，`mcpServers` 见下文） |
| 重开任务 | 对端声明 `session/resume` 用它，否则有 `loadSession` 用 `session/load`（回放的历史不再重复展示）；都没有或恢复失败时抛 `AcpResumeUnavailableError`，由宿主决定新开会话并在界面说明「上下文未恢复」，引擎不静默换新会话 |
| 发送 | `session/prompt`（文本、资源链接；图片仅在对端声明支持时） |
| 停止 | `session/cancel`；未决权限请求立即回 `cancelled`（即使确认卡仍开着）；对端 15 秒内不收尾则 Cindy 自行以 `cancelled` 结束本轮，迟到的回复不再产生第二个结束 |
| 插话 | ACP 每个会话同时只有一个 prompt；插话按排队处理（保持发送顺序），`sameTurnSteer` 标为不支持 |
| 回合外输出 | Agent 自主运行（如子任务回报）产生的输出标记为 `turnScope: 'background'` |
| 关闭 | 支持则 `session/close`，随后结束进程 |
| 文本 / 思考 | `agent_message_chunk` / `agent_thought_chunk` → `text` / `thinking` |
| 工具 | `tool_call` / `tool_call_update` → `tool_use` / `tool_result`（同一 `toolCallId` 合并） |
| 计划 | `plan` → 折叠为任务内的待办展示（第一期可只记录为文本） |
| 用量 | `usage_update` → 上下文用量 |
| 权限 | `session/request_permission` → `interaction_request`（kind = permission） |
| 模型 / 推理强度 | 类别为 `model` 的配置项 / `reasoning_effort` 配置项 → `setModel` / `setEffort` |

不支持的能力（分叉、回退、会话树、手动压缩、记忆、计划模式、Fast）在 `Capabilities` 中
如实标为不支持，界面按现有能力开关隐藏，不伪装成功。

客户端能力：第一期**不**声明 `fs/*` 与 `terminal/*`（v2 已移除，且 DSH 不使用），由 Agent
自己读写文件、执行命令。

## 二、插件清单：通用 `harnesses` 字段

在 schemaVersion 3 新增顶层字段 `harnesses`，按协议区分、对具体 CLI 无特例（完整格式见下文「接口约定」）：

```json
{
  "node": { "entry": "worker.js", "protocol": "json-rpc-stdio", "entries": ["dsh-acp.js"] },
  "harnesses": [
    { "id": "dsh", "name": "DeepSeek Harness", "protocol": "acp", "entry": "dsh-acp.js" }
  ]
}
```

- `entry` 必须是 `node.entries` 里声明过的入口，因此要求同时声明 `node`。
- `protocol` 目前只认 `acp`；不认识的协议保留但不生效，旧版 Cindy 整个字段都忽略。
- **安装确认**新增独立权限项（独立 key，保证更新时「权限变多」能被识别），文案大意：
  「提供执行引擎 DeepSeek Harness：可以在你的任务里读写工作目录、执行命令，并使用你允许的
  Cindy 工具」。
- **存量兼容**：在 Cindy 认识此字段之前就已声明它的插件，升级后不得自动生效；需在安装回执
  中记录批准事实（参照 `approvedControlPoints` / `*CapabilityApproved` 的做法）。对其他存量
  插件零影响。
- 按[插件安全与编写规范](../dev-rules/plugin-security-and-authoring.md)同步：两份校验器
  （`packages/plugin-protocol/src/manifest.ts` 与 `apps/desktop/src/shared/ghost.ts`）、
  权限项与 24 个语言文件、插件详情页、插件编写手册、兼容记录与协议兼容文档，并补「从旧状态
  升级」测试。此部分属于插件基座，合并前需维护者明确 Approve。

**可用状态**（第一期必做）：插件通过类似 `PUT /models` 的宿主接口发布每个 Agent 的可用
状态，例如 `{ "id": "dsh", "available": false, "reason": "not-installed", "message": "…" }`。只发布
元数据，不能发布命令。Cindy 存下最新状态，模型选择器只读这份记录、不调用插件；不可用时
显示为不可选，并给出插件提供的安装提示。插件没发布过状态时按「未知」处理，允许尝试启动，
失败再展示入口进程的报错。

## 三、Desktop：引擎插槽与任务生命周期

- **AcpEngineSlot**（参照 `browserExtensionSlot.ts`）：在 `broadcastGhostsChanged` 时按
  「已启用 + 已批准 + 已声明」对账；新增则注册端点，停用、卸载、更新时先停止相关任务的进程
  再注销。每次调用重新校验批准状态。
- **进程模型**：一个任务一个入口进程，崩溃只影响该任务。复用插件 Node 运行时已有的子进程
  原始 stdio 模式（stdin 经 `parentPort`、stdout 管道），不新增 `child_process` 执行点。
- **任务记录**：`sessions.agent_kind = 'acp'`，`provider_id = 'acp-plugin:<插件 id>:<agent id>'`
  （命名空间不会与真实供应商冲突），`sdk_session_id` = ACP sessionId，`model` = Agent 的模型
  取值。均为现有列，不需要数据库迁移。界面展示的历史来自 Cindy 自己落库的消息，不依赖 Agent
  回放。
- **模型选择器**：ACP Agent 作为独立的「引擎」分组出现，不伪造成供应商（伪造供应商会迫使
  `model-providers` 的类型扩大）。模型列表在任务启动后从配置项获得，按「插件 Agent + 账号」
  缓存，下次直接显示；首次只显示「默认模型」。不为探测模型额外创建会话，避免在 Agent 侧留下
  垃圾会话。
- **权限**：第一期提供两档：「逐项确认」（转给用户确认卡）与「全部允许」（自动选 allow_once）。
  Cindy 自动审核留到后续。界面需说明：Agent 自己不发起确认的操作，Cindy 无法拦截。
- **Cindy 工具**：对端声明 `mcpCapabilities.http` 时，通过 `session/new` 的 `mcpServers` 交给
  它 Cindy 的本地 HTTP MCP 桥（复用 Codex / Pi 已有实现），令牌按任务签发、随任务失效。
  交出的工具范围与内置 Pi 相同（2026-11-18 用户决定），复用 Pi 的允许清单而不另立一份；
  安装确认文案需写明这一范围。
- **排除范围**：远程 / SSH / 设备互联被控端、定时任务、伙伴、多 Agent 协同、插件模型路由、
  标题生成的 oneShot 均不接入 `acp`，遇到即返回明确的「不支持」。

## 四、DSH 插件

独立插件包（不放进 Cindy 主仓），用 Cindy 插件工具链打包、在本机安装验证：

- **自动查找本机 CLI**：插件启动和设置页打开时检测 dsh——先查 PATH 中的 `dsh`（Windows 为
  `dsh.cmd`），并以 `dsh --version` 核对能运行；找到则发布「可用」，找不到或版本不满足则发布
  「不可用：需要安装」，提示 `npm i -g @deepseek-ai/dsh`（需要 Node 24.9+）。用户装好后再次
  检测即自动恢复可用，不要求重装插件。
- `dsh-acp.js`：用检测到的路径、以固定参数 `--profile acp` 启动，双向转发 stdio，stderr 进
  插件日志；子进程退出则入口退出。参数是常量，不拼接用户输入。
- 设置页：显示检测结果、版本与安装提示。第一期只做自动检测，不提供手动指定路径。
- DeepSeek 的模型与 API Key 由 DSH 自己的配置（`$DSH_HOME`）管理，Cindy 不传凭据。
- 已知限制（来自 DSH 的 ACP 说明）：不回放历史、不支持分叉、终端、计划与模式；支持恢复、
  列表、关闭、选模型与推理强度、HTTP MCP。

## 接口约定（第 2–4 步共同遵守）

**清单字段**（schemaVersion 3；v2 `slots` 不映射）：

```json
{
  "node": { "entry": "worker.js", "protocol": "json-rpc-stdio", "entries": ["dsh-acp.js"] },
  "harnesses": [{
    "id": "dsh", "name": "DeepSeek Harness", "description": "…", "protocol": "acp",
    "entry": "dsh-acp.js",
    "locales": { "zh-CN": { "name": "DeepSeek Harness", "description": "…" } }
  }]
}
```

- 1–4 项；`id` 匹配 `^[a-z][a-z0-9-]{0,31}$` 且唯一；`name` 1–64 字；`description` ≤ 200 字。
- `protocol` 目前只有 `acp` 生效；其他值保留但不生效。
- `entry` 必须逐字命中 `node.entries`（不能是 `node.entry` 主入口，主入口走插件宿主协议）。
- 安装回执记录批准事实；Cindy 认识此字段之前就已声明的旧安装不自动生效。

**可用状态**（插件 → Cindy）：插件页面 `fetch('/harnesses', { method: 'PUT', body })`，`body` 为
`{ "harnesses": [{ "id": "dsh", "available": false, "reason": "not-installed", "message": "…", "version": "0.2.2" }] }`。
整体覆盖、内容不变无副作用；`GET /harnesses` 读回；未声明字段返回 403，格式错误返回 400 且不改原状态；
`reason` 为短 slug，`message` ≤ 200 字。卸载时删除，停用时保留不显示。从未发布视为「未知」。

**引擎进程**（Cindy → 插件入口）：Cindy 以插件 Node 运行时的「原样 stdio」模式启动 `entry`（与
`childSpawn` 同一通道，`cwd` 为系统临时目录，环境与插件 Node 进程相同），一个任务一个进程。
入口的 stdin/stdout 只承载 ACP JSON-RPC 行，日志写 stderr；入口退出即 Agent 退出。插件停用、
更新、卸载前 Cindy 先结束这些进程。

**主进程注册表**（第 2 步提供，第 3 步使用）：`apps/desktop/src/main/cindy-brain/pluginHarnesses.ts`

```ts
export interface PluginHarness {
  key: string;              // `${ghostId}:${harnessId}`，任务记录里的稳定标识
  ghostId: string;
  harnessId: string;
  name: string;             // 已按界面语言选好
  description?: string;
  protocol: 'acp';
  availability: { state: 'available' | 'unavailable' | 'unknown'; reason?: string; message?: string; version?: string };
}
export interface PluginHarnessRegistry {
  list(): PluginHarness[];                                   // 已启用 + 已批准 + 已声明 + 协议已支持
  onChange(listener: (list: PluginHarness[]) => void): () => void;
  spawn(key: string): Promise<NodeWorkerProcess>;            // 原样 stdio；不在 list 中则拒绝
}
```

任务记录：`agent_kind = 'acp'`，`provider_id = 'acp-plugin:<ghostId>:<harnessId>'`。

## 五、分步交付

| 步骤 | 内容 | 对现有功能的影响 | 门禁 |
| --- | --- | --- | --- |
| 1 | maker-core ACP 引擎 + 假 Agent 进程测试 | 无（未接线） | 常规 |
| 2 | 插件清单 `harnesses` 字段、确认项、回执、文档 | 存量插件零影响，需升级测试 | 插件基座：维护者 Approve |
| 3 | Desktop 接线：插槽、进程、生命周期、模型选择器、权限卡、MCP | 未装插件时无变化 | 常规 + 内置引擎回归 |
| 4 | DSH 插件包，本机端到端验证 | 无 | 插件自身 |

## 六、验证

- 假 Agent（脚本模拟 ACP 对端）覆盖：流式输出、工具、权限允许 / 拒绝 / 等待中停止、取消、
  进程意外退出、重开恢复、乱序与重复更新、两个任务互不影响。
- 未装插件对照：可用引擎、能力快照、内置三引擎测试与 maker-core、Desktop main / renderer、
  Host 类型检查全部通过且与基线一致。
- 插件基座：旧版本已安装插件升级后行为不变；声明 `harnesses` 的旧包不自动生效。
- 真实 DSH：macOS 与 Windows 各走一遍「新建 → 发送 → 工具确认 / 拒绝 → 停止 → 重开 → 切模型」。

## 七、风险

- **降级**：用户退回旧版 Cindy 后，旧版会把 `acp` 任务当作 Claude 任务打开并开新会话。只影响
  ACP 任务本身，写入发布说明。
- **手机显示**：手机端暂不认识 `acp`，任务图标与部分控件会按默认引擎显示；查看与继续发送可用，
  引擎专属操作由 Desktop 拒绝。手机适配放后续。
- **安全**：插件已声明 `node` 即拥有用户级权限；新增的是「作为任务引擎并使用 Cindy 工具」，
  须在安装确认中单列，并限定交出的工具范围。
- **对端差异**：各家 ACP 实现在恢复、模型切换、权限语义上不一致，全部按握手结果降级。

## 已定事项

- 2026-11-18：Cindy 工具范围与内置 Pi 相同；DSH 插件自行检测本机 CLI，找不到即显示不可用并提示安装；
  清单字段名 `harnesses`，安装确认单列「提供执行引擎」权限项；插件 DSH 源码独立于主仓。

## 第一期明确不支持（遇到即明确拒绝，不回落到内置引擎）

（换引擎已在第二期支持，见下节。）分叉、回退、移到另一台电脑或 SSH、Orca 协同、定时任务、IM 渠道、伙伴、共享任务、
其他任务经 send_to_session 向插件引擎任务发消息、/learn 捕获、上下文溢出后的重放、Cindy 生成标题、
Node Host（`apps/host`）。插件引擎任务的消息按 `agent_kind = 'acp'` 落库，不带供应商元信息。

## 第二期：任务里换引擎（2026-11-19）

用户要求插件引擎与内置引擎在任务里能做的事一样。第二期按顺序做：任务中换引擎 → 手机 → 定时任务 → 多 Agent 协同；
插件 worker 的顶层会话视为已确认的调用方，可中途向 lead 汇报。本节记录第一项。

- **入口**：内置任务的模型选择器列出插件引擎；插件引擎任务的选择器与内置任务相同，列出内置模型与全部插件引擎。
  同一个插件引擎内换模型照旧立即生效；换到另一个引擎（内置 ↔ 插件、插件 ↔ 插件）与内置引擎之间一样登记意图，
  下一条消息发送时交接，模型胶囊显示「下条：引擎 · 模型」。
- **范围**：只限本机普通任务（`source = desktop`）。远程 / SSH、Agent 在另一台电脑、协同、IM、伙伴、定时、共享任务
  暂不支持换到或换出插件引擎，主进程拒绝，选择器也不列。
- **准入**：与在插件引擎上新建任务同一规则（`admitPluginEngineSwitchTarget`）：引擎此刻由本机提供且可用；登记与提交
  各判一次。插件停用或不可用时，发送前的切换失败会挡住发送并保留选择，不悄悄留在原引擎。
- **交接**：切到插件引擎总带完整交接，不复用它此前的原生会话，也不提前启动，下一条消息启动它；切回内置引擎照常找
  该引擎停泊的原生会话（插件引擎的边界行不会被当成内置引擎的停泊记录）。交接说明与分隔条写插件自己的名字
  （`fromEngineName` / `toEngineName` 快照）。
- **提交的字段**：`agent_kind = acp`、`provider_id = acp-plugin:…`、`sdk_session_id = null`、Fast 关；思考深度只写该模型
  列出的档位；权限模式保留引擎提供的那一档，否则用在该引擎上新建任务时的默认档（「全部允许」只在任务本来就是它时保留）。
  切回内置引擎且未指定来源时来源清空（走该引擎默认来源），不把 `acp-plugin:` 留在内置任务上。
- **兼容**：意图投影的 `targetAgentKind` 新增取值 `acp`，旧控制端（旧 Desktop / 旧手机）按「无意图」处理；边界行
  `fromAgentKind` / `toAgentKind` 可为 `acp`，旧端显示为 Claude Code。详见
  [协议兼容记录](../dev-rules/protocol-compatibility/plugin-harnesses.md)。

## 第二期：手机与定时任务（2026-11-19）

- **手机**：电脑经 device-link 只读通道把本机插件引擎列表交给手机（名称、图标、模型、思考深度、工作模式）。手机新建任务可以
  选插件引擎，插件引擎任务显示正确的引擎与模型，也能在任务里切换引擎；规则与电脑相同，只限被控电脑本机的普通任务。
  手机端改动只走 JS 热更新。
- **定时任务**：自动任务的模型选择里列出本机插件引擎，`cindy_scheduler` 工具同样能选。只用于每次新建任务、在本机运行的
  Agent 自动任务；绑定任务、持续会话、worktree、另一台电脑、脚本执行与项目自动化不提供。保存与每次运行前都按本机此刻
  提供的引擎准入，插件停用或不可用时保存或本次运行明确失败，不回落内置模型。权限与内置引擎的自动任务一样默认「全部允许」；
  插件 Agent 自己不请求确认的操作，Cindy 拦不住。

## 已知限制

- 插件入口进程拿到的是插件 Node 运行时的精简环境：`DSH_HOME`、`HTTP(S)_PROXY` 等用户 shell 变量不会传给
  dsh；需要代理或自定义 DSH 目录的用户第一期可能受影响。
- 模型列表在该引擎第一次跑任务后才有；之前只显示「默认模型」。
- 手机端在第二期适配后认识插件引擎；更早版本的手机仍按 Claude 显示插件引擎任务，可查看与继续发送。
- 降级到旧版 Cindy 后，旧版会把 `acp` 任务当作 Claude 任务打开。
