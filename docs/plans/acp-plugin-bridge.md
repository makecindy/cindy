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
| 重开任务 | 对端声明 `session/resume` 就用此方法，有 `loadSession` 时可用 `session/load`（回放的历史不会重复展示）。无法恢复时保留原会话，提示用户切换引擎或新建任务。 |
| 发送 | `session/prompt`（文本、资源链接；图片仅在对端声明支持时） |
| 停止 | `session/cancel`。未决权限请求和等待收尾期间的新权限请求均回 `cancelled`。对端 15 秒内不收尾时结束当前轮次并终止该进程，宿主确认进程退出后才允许恢复。没有进行中的回合、但 Agent 仍在回合外工作时同样发 `session/cancel`（DSH 会停下自主工作，不支持的 Agent 忽略）。 |
| 插话 | ACP v1 每个会话同时只有一个 prompt，没有同轮输入。Agent 在 `initialize` 结果顶层 `_meta.steering.supported: true` 声明生态通行的 `_session/steering` 扩展（claude-agent-acp、codex-acp 等）时，`sameTurnSteer` 标为支持：运行中的插话以 `{ sessionId, prompt, _meta: { steering: { idleBehavior: 'promptRequired' } } }` 注入当前回合，`injected` 即受理，回复另起一段；`promptRequired`（Agent 的回合已结束）按「没有进行中的回合」交给宿主改为下一轮发送；已发出但没有回答按「送达未知」处理，不再重发；Agent 回 method-not-found 时本会话撤回插话能力。未声明的 Agent 保持原状：`sameTurnSteer` 不支持，插话按排队处理（保持发送顺序）（2026-11-22） |
| 回合外输出 | Agent 自主运行（回答完接着推分支、隔几分钟查 CI，或子任务回报）产生的输出标记为 `turnScope: 'background'`。回合正常结束（`end_turn`）时还没报完成的工具调用保持未完成，等 Agent 报告真实结果；Agent 30 分钟没有任何动静（运行中调用的进度更新也算动静）时按完成收尾，进程退出或被关闭时标为中断。回合外写的回复没有回合结束来收尾，停顿 2 秒即定稿（进程结束时也定稿）。显示见下文「回合外工作的显示」 |
| 关闭 | 支持则 `session/close`，随后结束进程 |
| 文本 / 思考 | `agent_message_chunk` / `agent_thought_chunk` → `text` / `thinking` |
| 工具 | `tool_call` / `tool_call_update` → `tool_use` / `tool_result`（同一 `toolCallId` 合并） |
| 计划 | `plan` → 折叠为任务内的待办展示（第一期可只记录为文本） |
| 用量 | `usage_update` → 上下文用量；`session/prompt` 结果里的 `usage`（本轮 token）→ `done.data.usage`，供「远程与分享」页按使用方的用量与插件的 did-turn-end 使用。`inputTokens` 按不含缓存记：对端的 `totalTokens` 等于输入 + 输出时，说明它的输入含缓存，先扣掉缓存。对端不报时只记轮数（2026-11-23） |
| 权限 | `session/request_permission` → `interaction_request`（kind = permission） |
| 模型 / 推理强度 | 类别为 `model` 的配置项 / `reasoning_effort` 配置项 → `setModel` / `setEffort` |

Worktree（[#11956](https://github.com/makecindy/cindy/issues/11956)；2026-11-25 用户要求所有入口与内置引擎一致）：
worktree 跟着项目所在的电脑建，规则与内置引擎相同。项目在本机时（引擎在本机或同账号另一台电脑），宿主等受管
worktree 完整检出，才用新目录创建任务；远程控制另一台电脑的项目（桌面或手机）时，由被控端两步预创建（先
`worktree:create`，再以检出路径与同一预生成 id 建任务，清理账本与内置引擎共用）。第一条消息启动时，`session/new.cwd`
使用同一目录。检出失败时保留原草稿和附件，不在基础仓库创建任务或发送。未启用 worktree 或直接选择已有 worktree 时，
仍在所选目录运行。协同 Worker 与每次新建任务的定时任务同样可用 worktree。SSH 工作区不提供插件引擎。

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
  `model-providers` 的类型扩大）。2026-11-22 起引擎同时列在「设置 → 模型供应商」，带「插件」标识，可在那里改名、
  隐藏、停用和逐模型关闭；这只是视图与设置层的并列，`model-providers` 的类型与普通供应商的存储仍不变，见
  [协议记录](../dev-rules/protocol-compatibility/plugin-harnesses.md)。模型列表在任务启动后从配置项获得，按「插件 Agent + 账号」
  缓存，下次直接显示；首次只显示「默认模型」。不为探测模型额外创建会话，避免在 Agent 侧留下
  垃圾会话。
- **权限**：第一期提供两档：「逐项确认」（转给用户确认卡）与「全部允许」（自动选 allow_once）。
  两档均不替外部 Agent 建立持久授权；没有单次允许选项时拒绝或取消该请求。Cindy 的「全部允许」只控制
  本任务的确认响应，不切进 Agent 的原生全权限模式。
  Cindy 自动审核留到后续。界面需说明：Agent 自己不发起确认的操作，Cindy 无法拦截。
- **Cindy 工具**：对端声明 `mcpCapabilities.http` 时，通过 `session/new` 的 `mcpServers` 交给
  它 Cindy 的本地 HTTP MCP 桥（复用 Codex / Pi 已有实现），令牌按任务签发、随任务失效。
  交出的工具范围与内置 Pi 相同（2026-11-18 用户决定），复用 Pi 的允许清单而不另立一份；
  安装确认文案需写明这一范围。直接连接的第三方 MCP 与其凭证留在宿主。
- **Antigravity 的工具预算（2026-11-25）**：agy 把 ACP 传入的所有 MCP 工具放进一份约 16 KB、
  所有服务共用的声明预算（按它在 `~/.gemini/antigravity-cli/mcp/<服务>/` 写下的单个工具 JSON 计），
  超出时从最大的工具开始整个删掉，模型看不到、也没有别的调用途径
  （[上游 #1530](https://github.com/google-antigravity/antigravity-cli/issues/1530)）。Cindy 的完整目录约
  160 KB，`ghost_call`、`cindy_scheduler.call_tool` 等因此不可用，PR Skill 挂不了卡片、建不了跟进。
  HTTP MCP 桥对 `antigravity-client` 按服务数加权分配 12 KB 总量（`antigravityToolCatalog.ts`）：放得下就原样下发；
  否则压成一句话摘要加参数类型，完整说明经 `describe_tool` 读取；仍放不下时只保留首选入口与
  `list_tools` / `call_tool`，其余经 `run_tool` 调用。`run_tool` 在传输层还原成原来的 `tools/call`，
  注册、参数校验与授权不变；其他客户端的目录不受影响。两个辅助入口只由传输层应答、不在 `McpServer` 上注册：
  MCP App 代理（`mcp-apps/serverProxy.ts`）与伙伴连接（`bot-import/connectionProvider.ts`）自己安装
  `tools/list` / `tools/call` 处理器，再调 `registerTool` 会与之冲突，使服务初始化失败。新增工具或加长说明不需要改这里，
  预算由测试 `keeps every agy catalog within the shared budget` 守住。
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

（换引擎、定时任务与协同 Worker 已在第二期支持，见下面几节；标题、send_to_session、/learn、目标、IM / 官方 hook 渠道
与分叉、侧聊、上下文溢出续接、每轮权限闸见下文。）回退、移到另一台电脑或 SSH、插件引擎当协同 Lead、共享任务、
Node Host（`apps/host`）。插件引擎任务的消息按 `agent_kind = 'acp'` 落库，不带供应商元信息。

伙伴的后续支持范围见[模型候选链](../product-rules/cindy-bots-runtime.md#5-模型候选链)。伙伴可以在设置中选择所在电脑的插件模型，主聊天按所选模型运行。

## 第二期：任务里换引擎（2026-11-19）

用户要求插件引擎与内置引擎在任务里能做的事一样。第二期按顺序做：任务中换引擎 → 手机 → 定时任务 → 多 Agent 协同；
插件 worker 的顶层会话视为已确认的调用方，可中途向 lead 汇报。本节记录第一项，后几项见下面两节。

- **入口**：内置任务的模型选择器列出插件引擎；插件引擎任务的选择器与内置任务相同，列出内置模型与全部插件引擎。
  同一个插件引擎内换模型照旧立即生效；换到另一个引擎（内置 ↔ 插件、插件 ↔ 插件）与内置引擎之间一样登记意图，
  下一条消息发送时交接，模型胶囊显示「下条：引擎 · 模型」。
- **范围**：开放本机普通任务（`source = desktop`）、伙伴（`source = bot`）以及个人 IM / 官方 hook 会话
  （`x` / `feishu` / `telegram` / `discord` / `discord-hook` / `slack` / `wechat` / `dingtalk` / `wecom` / `imessage`）。
  SSH 远端宿主机、协同（Orca）、review、learn、cindy-make、定时、共享任务仍不支持换到或换出插件引擎，主进程拒绝，
  选择器也不列。个人 IM 新对话默认设置与飞书按群设置也支持选择本机或同账号远程 / 分享插件引擎；微信等无条件挂载
  `turnPermissionPolicy` 的渠道保留不支持提示，Node Host `host-settings` v1 读到 `acp` 默认配置时返回 `unavailable`。
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
- **定时任务**：自动任务的模型选择里列出本机与同账号其他电脑开放的插件引擎，`cindy_scheduler` 工具同样能选。支持每次新建任务
  （可用 worktree，2026-11-25；支持另一台电脑，2026-11-26）以及绑定普通桌面任务或独立自动任务产出的会话（2026-11-26，经 `scheduledModelScope` 临时切换并在下次
  用户消息前恢复原引擎，含另一台电脑上的插件引擎）；持续会话、协同/SSH 任务、脚本执行、伙伴例行任务与项目自动化不提供。保存与每次运行前都按对应电脑此刻
  提供的引擎准入，插件停用、不可用或对端不可达时保存或本次运行明确失败，不回落内置模型。权限与内置引擎的自动任务一样默认「全部允许」；
  插件 Agent 自己不请求确认的操作，Cindy 拦不住。
- **绑定插件引擎任务的自动化（2026-11-25；2026-11-26 支持临时切换模型、远程插件引擎与自动化产出任务）**：用户反馈 Antigravity 任务（含另一台电脑上的远程插件引擎以及自动化新建出来的插件引擎任务）里 GitHub 插件的 PR 自动跟进在未指定模型时每轮报
  「Scheduled tasks is not available for tasks running on a plugin engine」或落库报「this plugin engine task cannot be bound to an automation」，指定了跟进模型时保存又被拒。
  现在绑定到普通桌面或独立自动任务产出的插件引擎任务（本机或另一台电脑，非持续会话、非伙伴例行任务）的自动化（`bindToCurrentSession` / `targetSessionId`）分两种情况运行：
  - **未指定模型**：按用户续发消息运行，不论任务忙闲都进该任务的消息队列，由任务自己的发送路径启动引擎，沿用任务当前的引擎、位置、模型与权限档，入队前与派发前各按对应电脑做一次准入检查。
  - **指定了模型（含内置引擎或本机/远程插件引擎）**：走与内置任务相同的 `scheduledModelScope` 临时切换链路——触发前保存原任务基线（支持 `agentKind = 'acp'` 与 `agentDeviceId`）到 `scheduled_model_baseline`（UI 投影继续展示原任务模型），经 `performSessionAgentSwitch` / `applySessionRuntimeSelection` 临时切换到自动化指定模型执行本轮，下次用户发消息或未指定模型的自动任务触发时自动切回原插件引擎与原位置并清理基线（对端离线时保留基线不丢弃）。同样支持绑定普通桌面或独立自动任务产出的内置任务临时切到本机或另一台电脑的插件引擎执行。
  以下仍明确拒绝，不换引擎、不回落内置模型：
  未带 `modelAgentKind` 的旧版仅模型覆盖、SSH / 协同任务、持续会话（`persistentSession`）、IM / 审查等非普通任务、伙伴例行任务与原始转发对端位置。
  入口见 `scheduler-host/runner.ts` 的 `boundPluginEngineRefusal`、`scheduler-host/storage.ts` 与 `maker-ipc/scheduledModelSelection.ts`。

## 第二期：多 Agent 协同（2026-11-19）

- **能做什么**：本机 Lead 的 Worker 可以放在插件引擎上——开启协同时的第一个 Worker、之后再加的 Worker，以及 Lead
  用 `create_worker` / `create_workers`（`agent = acp` + `provider_id`，引擎从 `list_available_models` 的
  `plugin_engines` 取）。插件引擎 Worker 能收 Lead 的派活与插话（不支持同轮插话的按排队处理），能用 `send_to_lead`
  回报、改写或撤回排队的回报。Worker 页签与手机上的团队列表显示插件引擎，不显示成 Claude Code。
- **范围**：Worker 只在 Lead 所在的这台电脑运行；SSH Lead、另一台工作电脑、Agent 在另一台电脑都明确拒绝。
  worktree 与内置 Worker 相同（2026-11-25）。插件引擎任务暂不能当 Lead：开启协同、`start_team`、新建 Worker 的
  所有入口统一拒绝（`PLUGIN_ENGINE_CANNOT_LEAD`）。Lead 不能用 `set_worker_runtime` 改插件引擎 Worker 的模型，需在它
  自己的任务窗口里改。
- **准入与唤醒**：创建时与在插件引擎上新建任务同一准入（停用、卸载或不可用时创建失败，不回落内置引擎）；休眠后再唤醒
  按它自己的引擎与 `provider_id` 启动。
- **角色说明**：插件引擎不收 Cindy system prompt。Worker 不知道自己要用 `send_to_lead` 回报就没法协作，所以把内置
  Worker 已在用的那段 Worker 说明（原文不改）放在它**新开会话的第一条消息前**一起发送（`pluginEngineBriefing`）；
  恢复的会话里已有，不重复。内置引擎的提示词与路径不变。
- **调用方身份**：Cindy 分不清插件 Agent 自己与它内部的子 Agent。按用户决定（整体信任插件 Agent），协同 Worker 的
  插件引擎会话把工具调用视为任务本身发起（`pluginEngineTrustedCaller`），因此能回报 Lead；它内部的子 Agent 同样能
  回报。非协同的插件引擎任务仍是「来源未知」。
- **兼容**：Worker 列表里插件引擎 Worker 的 `session.agentKind = acp` 并带 `session.providerId`；手机经共享解析器读
  `pluginEngineProviderId`，`agentKind` 仍给旧端可用的占位值。`maker:session:enable-orca` 的 `workerAgent` 与
  `maker:worker:create` 的 `agent` 新增取值 `acp`，只由本机新版电脑的面板发起（远程控制与手机不列插件引擎），
  旧端从不发送。

## 第三期：自己的其他电脑使用（2026-11-20）

用户要求插件引擎也能像普通供应商那样「允许被远程调用」。先做同一账号的电脑之间；供应商分享与供应商组另议。

- **能做什么**：在 B(装了插件、CLI 已登录)的插件设置里为引擎打开「允许被远程调用」后，同账号的 A 新建任务时可以
  选 B 的这个引擎。Agent 在 B 上运行，用 B 的程序、登录和额度；任务、项目文件与命令都留在 A。
- **为什么不能直接照搬内置引擎**：内置引擎在另一台电脑运行时，Cindy 把它自带的文件与命令工具整套换成回到任务
  电脑执行的工具。插件引擎的工具是外部 Agent 自己的，Cindy 接管不了，也拦不住它不来问的操作。所以由插件声明
  自己能做到(`remoteWorkspace`)：以 `--cindy-remote-workspace` 启动时，只对这一次启动关掉自带的文件与命令工具，
  全部改用 Cindy 经 MCP 交过去的工具。没声明的插件不提供这个开关。
- **不影响用户单独使用 CLI**：关工具只能用这次启动的参数、环境变量或独立配置，不得改写用户的全局配置；
  做不到或无法确认时入口必须拒绝启动，不能带着自带工具运行。DSH 插件用 `dsh --patch` 叠加层实现，
  启动前读回实际配置核对，出现不认识的工具即拒绝。
- **没有配置叠加层的 CLI 怎么办(Antigravity 插件，agy 1.5.13 实测)**：它的权限规则在 ACP 下拦不住自带工具，
  能拦住的是自定义 Agent 定义里的工具白名单。插件在只属于这次启动的临时目录里写一份定义(只留联网搜索，
  按名字列出可用的工具服务；地址与任务令牌只随 `session/new` 传入，不落盘)，用 `--agent` 启动。入口因此从
  「原样转发」变成读得懂 ACP 的转接：先用一个普通进程回答 `initialize`(并补上它实际支持却没声明的 HTTP MCP)，
  拿到 `session/new` 里的服务名后再启动跑会话的进程；把它报告的工具调用(新会话是通用调用器，续接后是
  `mcp_<服务>_<工具>`)还原成 Cindy 的工具名与参数；它读不回实际生效的工具，所以转接层在任务中检查，
  出现本机的文件或命令工具就结束任务。
- **只给同账号**：B 上的 Agent 以 B 用户的身份、登录与历史运行，「自带工具已关」只能靠插件保证，模型请求也不经过
  Cindy(无法按人限模型、计用量、设预算)。因此受邀者、供应商组中转与本机应用一律拒绝，开关说明里也不提分享。
- **开关归 Cindy**：开关由 Cindy 画在插件设置里，只能在 B 本机修改；插件页面与其他电脑都改不了。默认关闭。
  关闭、插件停用或报告不可用后，不再开始新的一轮，也不再换模型，进行中的这一轮照常结束。
- **选择与切换**：桌面新建任务和普通任务的模型选择器在 A 安装并启用对应插件后列出 B 开放的引擎。A 未登录的
  本机引擎从候选列表隐藏，已选任务仍显示引擎状态。会话内选中 B 后，下条消息前按 B 的开放状态校验并交接。
  模型、思考深度与权限档来自引擎在 B 上握手的结果，随任务状态带回 A。交给引擎的 Cindy 工具范围
  与项目说明文件仍按内置 Pi 的口径，来自 A。B 自己的 Cindy 工具、已装插件与记忆不进入这个任务。
- **第一条消息前的说明**：引擎收不到 Cindy system prompt，新会话第一条消息前附一段工作区说明(项目位置、平台、
  该用 `cindy_exec` 的哪些工具)，协同 Worker 的角色说明接在它后面；恢复的会话不重复。
- **暂未开放**：协同 Worker、手机上选择另一台电脑的插件引擎、
  分叉与回退（自动任务已于 2026-11-26 开放，见上文「定时任务」与「绑定插件引擎任务的自动化」）。遇到即明确拒绝，不回落内置引擎。
- **兼容**：全部为追加。旧版本的 B 不声明能力，A 提示更新那台的 Cindy；旧版本的 A 不会发出这类请求。
  详见[协议兼容记录](../dev-rules/protocol-compatibility/plugin-harnesses.md)「自己的其他电脑使用插件引擎」。

## 回合外工作的显示（2026-11-20）

用户发现 Antigravity 回答完后仍在推分支、建 PR、每隔几分钟查一次 CI，任务里却看不出在跑：消息流停在
回答上，侧栏一直转圈且不会熄灭。用户定的原则是「有就正确显示状态，没有就不触发」，所有插件引擎一样，
不需要插件声明——会不会在回合外工作取决于外部 CLI 及其版本，不取决于插件；DSH 的 ACP 层同样支持
「没有 prompt 时的自主工作」，只是本机记录里还没出现过。

- **判定**：主进程 `maker-host/claude-session-background-activity.ts` 的 `observePluginEngineEvent`
  读插件引擎任务的事件，回合外输出或回合结束时仍未完成的工具调用即点亮与 Claude Code 后台子任务
  同一份「后台活动」：任务列表、状态栏（「正在后台继续工作…」与「全部停止」）、归档与删除前的守卫。
  没有未完成调用时 30 秒无动静熄灭；有未完成调用时最多亮 31 分钟（maker-core 30 分钟收尾，多 1 分钟
  兜住另一台电脑断开的情况）。
- **消息流**：期间按进行中显示，未完成的工具调用带转圈。Agent 在回合外写的回复停顿 2 秒后定稿，
  由 `maker-ipc/sessionEventStreamCore.ts` 提交保存；此前它一直不定稿，重开任务后就看不到（本机历史里
  Antigravity 的回合外回复一条也没有保存下来）。回合结束时仍未完成的调用，其稍后的结果同样保存：
  `messagePersistBroadcaster.ts` 在回合收尾时为插件引擎任务保留全部未完成调用的保存上下文（此前只保留
  `collab:` 子任务调用）。
- **其他设备与手机**：Agent Island 在此期间把任务显示为运行中，结束后静默回到完成、不重复提醒
  （`setAgentIslandSessionBackgroundWork`）；插件引擎回合外的工具调用本身不再新开一段运行
  （此前会点亮且永不熄灭）。内置引擎不经过这条通知。
- **不变**：回合边界、回合结束时的完成提醒、发送与排队。
- **停止**：「全部停止」先发 `session/cancel` 再关闭插件进程，任务下次发送时恢复会话。
- **空闲回收**：`AcpSession.hasLiveBackgroundWork()` 在有未完成调用或 30 秒内有回合外输出时为真，
  定时任务与协同 Worker 的空闲回收因此不会结束仍在工作的插件进程。普通插件引擎任务（2026-11-25）
  与 Claude、Codex 同一回收器、同一范围与判据，空闲 30 分钟结束插件进程，下次发送恢复会话；
  只回收 Agent 声明了 `session/resume` 或 `session/load` 的任务（`AcpSession.canResumeAfterClose`），
  见 [普通任务空闲回收](../claude-idle-release.md)。起因：每个任务占一个进程（每个几百 MB），空闲也不退出；
  当时每个插件还有固定 8 个进程的上限，空闲任务占满后新任务启动失败。#12798 已去掉该上限，
  回收用来避免空闲进程越积越多。
- **未覆盖**：引擎在另一台电脑上运行时，那台电脑判断名额能否收回只看回合、后台任务与待唤醒续跑，
  Agent 长时间静默等待（如一次等很久的定时检查）期间，名额紧张时可能被收回。只发进度、界面上没有
  变化的调用不会传到 Desktop：这类调用超过 31 分钟没有可见输出时，任务内「正在后台继续工作」先熄灭，
  结果到达时再亮起（maker-core 不会因此提前收尾该调用）。

## /learn、目标模式与溢出续接（2026-11-25）

用户要求插件引擎与内置引擎在任务里的能力一致（2026-11-25 用户决定）。三项都不借用用户没选的内置引擎。

- **上下文溢出续接**：插件引擎报出能识别为上下文溢出的错误（`isContextOverflowErrorData` 的文本匹配）时，
  与内置引擎一样关掉溢出的会话、用 Cindy 记录写交接并重放这条消息，任务在同一插件引擎、同一来源的全新会话里继续。
  `getLiveSession` 看不到插件引擎的运行时，忙碌检查与关闭改用 `getRuntimeSession`；宿主没有这个读取口时什么都不
  重建（此前会在旧会话仍开着时提交重建、挂上交接，重放又被拒绝）。发送前的换会话（含插件引擎账号切换）同一规则。
  重建记录写 `sourceAgentKind = acp`。插件引擎不会自己压缩上下文，Cindy 也不能截断它的历史，主动换窗不适用。
  IM 消息的重试由原渠道负责，以便保留每轮权限和审批入口；Desktop 可以准备交接，但不会通用重放 IM 消息。
  实现见 `maker-ipc/contextOverflowRollover.ts`、`contextRecoveryAssembly.ts`，回归见 `contextOverflowRollover.test.ts`。
- **/learn**：蒸馏任务开在同一个插件引擎上，与在它上面新建任务同一准入（停用、卸载、不可用或模型关闭时本次 /learn
  明确失败），素材与内置引擎相同（含用户画像与其他任务的检索片段，这些内容会交给该插件的服务商），权限收敛到
  acceptEdits。另一台电脑上的插件引擎仍拒绝。Learn Skill 的调用捕获（按 Skill 文件钉住）没有对应的 ACP 原语，仍只走
  `/learn` 命令。实现见 `learn-host/pluginEngineLearnSession.ts`。
- **目标模式**：插件引擎任务可以设目标，休眠后按自己的引擎与来源恢复（`goal-host/sessionRestore.ts`）。插件引擎没有
  AskUserQuestion，首轮跳过「澄清目标」，按原文执行（`buildFirstTurnDirective` 的 `clarify: false`）。插件引擎不发
  回合结束的状态事件，每轮用量取自回合结果的 `usage`（含缓存），否则 token 预算永远不触发。插件引擎自己登录，Cindy
  没有它的账号快照：限额错误自带的重置时刻照常用，账号限额查询对它返回空。`session_goals.agent_kind` 的 `'acp'`
  只在 TS 枚举里，SQLite 无 CHECK 约束，不需要迁移。权限沿用任务原有档位，插件 Agent 不主动请求确认的操作 Cindy 拦不住。

## 插件与 Skill 告知（2026-11-24）

用户发现 Antigravity 任务不知道装了哪些插件和 Skill：发 PR 时直接用 `gh`，没走 GitHub 插件的 `pr` Skill，也开不了自动跟进。
内置引擎从 system prompt 读到插件花名册，从原生 Skill 加载拿到 Skill；插件引擎两样都没有。用户决定只补这两样，
不把 Cindy 的其他 system prompt 交给插件引擎。

- **内容**：新会话首条消息前的说明里加两段——已装插件花名册（与内置引擎同一份文本，`getGhostRosterPrompt`），
  以及 Skill 清单（名称、说明、`SKILL.md` 路径，Agent 需要时用自己的文件工具读）。Skill 范围与内置 Pi 相同
  （Cindy 内置与已批准插件的 Skill、Pi 的共享与项目目录，按用户的启用开关过滤；目录在隔离、限时的扫描进程里发现，不在 Main 上同步扫描，见 `maker-host/pluginEngineSkills.ts`），
  与 Cindy 工具范围同一口径。恢复的会话已有，不重复。
- **只写真实可用的**：花名册只在 Agent 实际接收了插件网关（`cindy` MCP）时附上；对端不收 HTTP MCP 或工具桥不可用时
  只留 Skill 清单。花名册或 Skill 读取失败只少这一段，不挡任务启动。
- **另一台电脑的任务与伙伴**：另一台电脑托管的任务与内置引擎一致，附任务所在电脑带来的花名册快照（`deviceHostedGhostRoster`，隧道提供 `cindy` 时），不读本机花名册；Skill 清单不附（没有跨电脑的来源）。隔离伙伴（按伙伴自己冻结的能力集）两样都不附；按普通任务装配的 V2 项目伙伴（`projectContext`）照常附上。恢复的会话不读取。
- **顺序**：远程工作区说明 → 伙伴说明 → 花名册 → Skill 清单 → 协同角色说明。
- **缓存**：说明在首条用户消息里，内置引擎的 system prompt 与缓存前缀不变。
- **防斜杠指令误触**：部分 ACP 对端（如 Antigravity `agy acp`）会扫描整段 `session/prompt` 文本中的 `/命令` 并自动激活对应工作流。宿主拼入的非用户文本（首轮说明、跨引擎交接与各类环境说明）会去掉独立斜杠指令前的 `/`，不动文件路径、URL 与用户原话；用户消息本身以斜杠指令开头时，环境说明与首轮说明不抢占句首（首轮说明顺延到下一条普通消息）。

## 斜杠调用 Skill（2026-11-25）

用户要求插件引擎任务也能像内置引擎一样在输入框打 `/` 选 Skill。此前输入框只列 Cindy 的桌面命令，手打的 `/pr`
原样送到引擎，引擎不认识 Cindy 的 Skill，只当作一行字。

- **列出**：桌面输入框的 `/` 菜单在插件引擎任务与新任务草稿里列出引擎展开 `/<名字>` 用的同一份清单（上节的首轮
  Skill 清单，内置 Pi 范围），经 `maker:list-agent-skills` 按 `acp` 向插件引擎读取（`AcpAgent.listAgentSkills`），
  不借内置 Pi 的清单：本机 Pi 不可用时 Pi 那份读取失败，菜单会是空的。清单不含只在 Pi 里加载的 Pi 包 Skill，也没有
  Pi 专用的 `/skill:` 别名和「项目 Skill 尚未加载」状态。内置 Harness 的命令仍不列。
  Agent 在另一台电脑上运行的任务不列，与首轮清单一致；远控另一台电脑时从那台电脑读（旧版电脑不认 `acp`，菜单不列
  Skill，它的引擎也不展开）；SSH 任务不变。
- **展开**：消息开头是 `/<名字>` 且对上执行电脑上的 Skill 时，maker-core（`acp/skill-invocation.ts`）在发给引擎前
  把它换成与 Pi `/skill:` 相同的 `<skill name location>` 块（`SKILL.md` 去掉 frontmatter 的正文），后面接用户其余的文字。
  也认其他引擎的发送路径留下的 `skill:`、`cindy:`、`cindy-plugin-<id>:` 前缀；同名 Skill 按清单顺序取第一个，与 Pi 相同。
  界面与历史里的用户消息仍是用户输入的 `/名字`。恢复的会话同样展开；隔离伙伴与另一台电脑托管的任务不展开，原因同上节。
  没有对应 Skill、文件读不到或超过 512 KB 时原样发送，不挡发送。
- **开头的文字**：消息的第一段文字（带图片时也是第一段文字）。宿主给消息加的说明（设备、来源、切换引擎的交接、
  插话说明等）同 Pi 一样不加在以 `/` 开头的消息上（`shouldPrependMobileClientPromptNote`），否则 `/` 被挤到后面、
  不会展开；可重复的说明留给下一条消息，切换引擎的交接同样顺延。
- **代价**：只有以 `/` 开头的消息才在发送前读一次 Skill 清单（隔离、限时的扫描进程）；其他消息的发送路径不变。
  展开内容在当轮用户消息里，不进 system prompt。手机与自动化发来的 `/名字` 走同一发送路径，同样展开；手机输入框的列表本次未改。

## 分叉、侧聊与起名（2026-11-25）

用户要求插件引擎与内置引擎在任务里的体验一致（2026-11-25 用户决定）。插件引擎的原生历史归插件 Agent 所有，
Cindy 不能复制或截断，所以这三项都只用 Cindy 自己的记录。

- **分叉与侧聊**：目标消息所在的那一段跑在插件引擎上时（当前就在插件引擎上，或任务之后换走了，按换走时
  `agent_switch` 边界的 `fromProviderId` / `fromModel` 找回是哪个引擎），子任务留在同一个插件引擎上：复制可见
  历史，不开原生分叉（`sdk_session_id = null`），写一条待发送的交接（`context_rebuild`，
  `reason = native-session-recovery`，`sourceAgentKind = acp`），子任务第一条消息启动全新会话并带上它。
  在第一条消息上分叉时没有可交接的内容，不写空交接。目标在内置引擎的段落里时照旧原生分叉。
  只限本机插件引擎：那一段跑在另一台电脑或收到的分享上时，分叉会绕过执行端对每个任务的准入，仍明确拒绝
  （见[插件引擎协议记录](../dev-rules/protocol-compatibility/plugin-harnesses.md)「暂未开放」）。
  实现见 `maker-orchestration/fork.ts`（`resolveForkNativeSource`），回归见 `__tests__/fork.test.ts`。
  侧聊走同一条路径。`[Fork·已剥离]`（剥离加密思考块）只针对 Claude，仍拒绝。手机不需改动。
- **起名**：自动起名、插件建的任务起名与「AI 重命名」都走辅助模型。辅助模型不可用时不借用任何内置引擎
  兜底（以前普通任务按 Claude Code 读，会回落到 Claude 的一次性请求），标题保留用户原话的截断版；
  「AI 重命名」此时提示生成失败。实现见 `maker-ipc/title.ts`、`maker-host/auxiliary-title-one-shot.ts`
  （`agentKind: null` = 没有可兜底的内置引擎）。
- **仍不支持回退**：回退要裁剪插件 Agent 自己的历史并回滚文件，界面不显示回退。

## IM 渠道（2026-11-25）

用户要求插件引擎在 Cindy 里与内置引擎有同样的体验和全套能力，IM 按「对齐内置引擎」做。

- **接线**：个人 IM（飞书、Slack、Discord、Telegram、钉钉、企业微信、个人微信、iMessage）的接线、换绑、接管（`/ctr`）、
  通知回复与伙伴专线不再拒绝插件引擎任务。`toCoreAgentKind` 保留 `acp`（此前会把它当 Claude 写回），任务在自己的引擎上启动。
- **就绪检查**：插件引擎不走供应商密钥检查，改用与桌面换到该引擎相同的准入（引擎由本机提供、未停用、模型未关闭）。
  不可用时聊天里按「供应商未连接」提示并写引擎名，修复入口同为「设置 → 模型供应商」。另一台电脑上的引擎由那台电脑在启动时判断。
- **权限**：群聊、访客与个人微信轮次的每轮权限策略由引擎执行，协议见
  [plugin-harnesses.md 每轮权限闸](../dev-rules/protocol-compatibility/plugin-harnesses.md#每轮权限闸2026-11-25)。
  引擎没有声明时这些轮次明确失败、提示当前引擎不支持；主人私聊的普通轮次照常运行。「全部允许」与内置引擎一样不接策略轮，
  私聊修复卡切到引擎的 Auto，没有 Auto 时切到第一个非「全部允许」的模式。`/permission` 卡列出引擎自己的模式。
- **`/model`**：插件引擎对话只列该引擎的模型，与应用内一样同一引擎内换模型立即生效（准入同上，档位只保留引擎为该模型列出的）；
  换到别的引擎在 Cindy 里做。
- **不变**：渠道「新对话配置」仍只能选内置引擎，渠道默认跟随不会改动插件引擎对话；插件引擎不产生回合文件变更记录，与桌面相同。
- **未覆盖**：渠道新对话默认直接用插件引擎（设置格式同步到手机与远程设置，需单独做协议兼容）；官方机器人渠道（hook-control）；
  访客轮次临时切 Auto 只对提供 Auto 模式的引擎生效。

## 已知限制

- 插件入口进程拿到的是插件 Node 运行时的精简环境：`DSH_HOME`、`HTTP(S)_PROXY` 等用户 shell 变量不会传给
  dsh；需要代理或自定义 DSH 目录的用户第一期可能受影响。
- 模型列表在该引擎第一次跑任务后才有；之前只显示「默认模型」。
- 手机端在第二期适配后认识插件引擎；更早版本的手机仍按 Claude 显示插件引擎任务，可查看与继续发送。
- 降级到旧版 Cindy 后，旧版会把 `acp` 任务当作 Claude 任务打开。

## 与内置引擎一致（2026-11-25）

用户要求插件引擎在所有地方与内置引擎一样可用（「所有的地方都需要支持」）。无法靠 ACP 协议直接实现的分叉、压缩、
回退等由 Cindy 模拟（交接到新的原生会话、Cindy 自己的逐轮文件记录）；SSH 工作区按「自己的其他电脑使用」同一机制开放，
跨账号分享、供应商组与中转仍不开放（无法按人限权、计量）。已完成：

- **worktree**：见上文「Worktree」，所有入口（本机、引擎在另一台电脑、远程控制的项目、手机、协同 Worker、定时任务）。
- **标题与输入推荐**：与其他任务一样只用辅助模型链；辅助模型不可用时不回落到任何引擎（标题请求的 `agentKind = null`，
  推荐请求带 `acp`）。AI 重新起名同样可用。
- **send_to_session**：其他任务可以向插件引擎任务发消息（与用户亲手发送同一路径）；从插件引擎任务新建任务时默认沿用同一个
  插件引擎、模型与位置，指定位置或模型时必须同时点名内置 agent。
- **/learn**：蒸馏任务跑在来源任务的同一个插件引擎与模型上，权限用逐项确认（插件引擎没有「工作区内自动接受」），
  永不自动给「全部允许」；任务里经 `/learn` 调起的内置 Skill 同样核对来源文件后授权。
- **目标**：插件引擎任务可以设目标；休眠任务按它自己的引擎恢复（另一台电脑上的引擎留在那台）。用量限额只按回合报错停止
  （Cindy 读不到插件 CLI 的账号窗口）。
- **自动化绑定插件引擎任务**：见上文「第二期：手机与定时任务」的「绑定插件引擎任务的自动化」。
- **IM 渠道与官方机器人渠道**：能接管、能对话，冷启动按任务行的 `acp` 与 `providerId` 恢复（IM 读行一律保留 `acp`）；
  `/model` 和 `/permission` 都以任务的执行电脑与插件引擎为准。模型只在同一引擎内切换；权限档优先采用该电脑上的运行态
  能力，休眠时由执行电脑的目录提供，菜单与按钮校验共用此规则。远程目录不可用时，保留当前权限档并暂停提供切换选项。
  **带本轮权限策略的轮次（群聊要求主人确认）一律拒绝**：插件的 Agent 可以不经 Cindy 询问就执行操作，任何权限档都
  无法兑现「须经主人确认」，所以与内置引擎在绕过审批钩子的档位下同样 fail-closed（`AcpSession.validateSendOptions` 抛
  `TurnPermissionPolicyUnsupportedError`，渠道按「所选 Agent 无法提供逐条确认」提示）。不带策略的私聊与已关闭群强确认的轮次照常运行。

## 全系统放开插件模型（2026-11-27）

用户要求插件模型与内置模型在 Cindy 所有系统及所有模型选择器里一致可用。以下入口已全部打通，仅保留安全与技术硬边界（复核任务 `review`、共享任务访客 `sharedTask`、SSH 工作区、非法原始转发 peer ID，以及未声明 `permissionGate` 时的 IM 强确认策略 fail-closed）：

- **任意来源任务的引擎切换**：去除 `sessionAgentSwitchHandler`、`agentSwitchRows`、Desktop `CCAgentSessionView` 与 Mobile `[sessionId]` 对 IM（Telegram / 飞书 / Discord 等）、多 Agent 协同（Lead / Worker）和自动化（`scheduler`）任务的插件引擎白名单限制；切换与交接语义与普通桌面任务一致。
- **IM 渠道与飞书群新对话默认设置**：`ImDefaultSettings` 与 `FeishuGroupRoute` 新增可选 `'acp'` 槽位（仅在选中插件引擎时落盘 `agents.acp`，未选用时磁盘 JSON 与指纹与旧版逐字节一致）；设置页与飞书群设置接入 `usePickerPluginEngines`（本机 + 同账号其他电脑 + 已收到分享），并联动权限选择器与 `/settings` 展示。远程云设置只读投影（`additionalIm.ts`）遇到 `'acp'` 路由时降级返回 `unavailable`，避免旧云端或旧控制端误覆盖。
- **项目与模型（Hook Workspace Preferences）**：`HookWorkspacePrefsEditor` 与 `hook-control/session-runner.ts` 支持直接配置和运行本机与远程/分享插件引擎（沿用 `bypassPermissions` 默认，不静默放宽显式权限档）；`additionalWorkspaces.ts` 遇到 `'acp'` 行时同样降级返回 `unavailable`。
- **智能路由 / 模型组（Model Groups）**：`ModelGroupAgentKind` 扩展 `'acp'`，本地与远程/分享插件引擎均可作为候选参与解析、新建任务、目标创建、任务内切换、撞配额提议、定时任务启动、伙伴候选链及手机端选路；`switchOffer` 将不同插件引擎（不同 `providerId`）按跨引擎处理。
- **自动化 / 定时任务与项目自动化**：放开持续会话（`persistentSession`）、伙伴例行任务（`source = 'bot'`）、IM / 协同绑定任务及项目自动化（`.cindy/automations/schedules.json`）对插件引擎的支持。
- **多 Agent 协同（Orca Worker）**：`CreateWorkerPopover` 接入 `usePickerPluginEngines`，支持本机、同账号其他电脑、跨账号分享及跨设备执行（`executionDeviceId`）的插件引擎 Worker；`orcaRemoteWorkerBridge` 与 `ORCA_REMOTE_WORKER_AGENT_KINDS` 放开 `'acp'`（远端回报 MCP 上下文沿用与 `acp-agent.ts` 相同的 `'pi'` 口径）。
- **明确不适用插件引擎的两个非 ACP 机制**：
  - `SubagentModelSection`（Claude Code CLI 的 `CLAUDE_CODE_SUBAGENT_MODEL` Anthropic 模型 ID 透传，不是独立 ACP 进程）；
  - `AuxiliaryModelSection` / `OneshotModelPinPicker`（主进程直连 HTTP 一次性轻量请求，不拉起完整 ACP CLI 进程）；
  两者消费模型组时自动过滤 `'acp'` 候选，不会错把插件引擎送入直连 HTTP 或 Claude 环境变量。


