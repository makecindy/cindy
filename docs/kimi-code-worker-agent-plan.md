# Kimi Code CLI 作为 Orca Worker Agent 接入方案

关联 issue：https://github.com/makecindy/cindy/issues/2953

## 背景

Kimi Code CLI 是月之暗面官方的终端 AI Agent（TypeScript 编写，npm 包
`@moonshot-ai/kimi-code`，可执行文件 `kimi`）。用户群体中已有 Kimi 会员通过
OAuth 登录使用该 CLI 编程，希望在 Cindy 的 Orca 多 worker 协同中以与
codex / claude-code / pi 并列的方式创建 `kimi-code` worker。

当前 Orca worker 的 agent 类型仅有 `claude-code` / `codex` / `pi`，只能在它们
之上挂 Kimi 的模型（如 `kimi-for-coding`），无法直接使用 Kimi Code CLI 本体，
也就无法利用 Kimi 会员的 OAuth 登录权益。

## 目标

- Orca 协同中创建 worker 时可选 `agent: "kimi-code"`，与现有三种 agent 并列。
- worker 会话由 Kimi Code CLI 驱动，复用其本地凭据（`~/.kimi-code/`），Cindy
  不接管 Kimi 的 OAuth 登录流程。
- 类型层、MCP 工具层、worker 创建 preflight、renderer 选项全链路贯通。
- 桥接实现有单元测试覆盖协议转换逻辑。

## 非目标

- 不接入 Kimi Code 的 Agent Client Protocol（`kimi acp` 子命令）。
- 不改变 Kimi Code CLI 自身的登录、配置与数据存储（`~/.kimi-code/`）。
- 本期不支持 SSH 远端 `kimi-code` worker（预留扩展点，见「分阶段计划」）。
- 本期不接入 Kimi 侧用量统计（`/api/v1/oauth/usage`）到 Cindy usage 面板。
- 不为 `kimi-code` worker 接线 Fast 模式（Kimi 侧无对应概念）。

## 方案

### 桥接架构：经 `kimi web` 本地服务驱动

Kimi Code CLI 内置本地服务（官方文档「本地服务与 API」「服务 API」）：

- `kimi web --no-open --port <port>` 前台启动服务，挂载 REST API（`/api/v1`）
  与 WebSocket 事件流（`/api/v1/ws`），与 TUI 共享同一份登录态与配置。
- 鉴权：bearer token 持久化于 `~/.kimi-code/server.token`（权限 0600），
  首次启动自动生成；REST 用 `Authorization: Bearer <token>` 头，WebSocket
  可用同名头或子协议 `kimi-code.bearer.<token>`。
- 会话最小流程：
  1. `POST /api/v1/sessions`（`metadata.cwd` 指定工作目录）→ 得 `data.id`；
  2. WebSocket 连接 `/api/v1/ws` 并发送 `subscribe`（`session_ids`）；
  3. `POST /api/v1/sessions/{id}/prompts` 提交提示词；
  4. 订阅端依次收到 `turn.started` → `assistant.delta`（流式增量）→
     工具调用时 `tool.call.started` / `tool.result` → `turn.ended`；
  5. `GET /api/v1/sessions/{id}/messages` 回读历史。
- 会话动作：`POST /api/v1/sessions/{id}:{action}` 支持
  `fork` / `compact` / `undo` / `abort` / `archive` / `restore`，
  可映射 worker 的 idle / abort 等生命周期操作。
- 就绪检测：`GET /api/v1/healthz`（免鉴权）、`GET /api/v1/auth`（登录态快照）。
- 服务自描述 `GET /openapi.json` 与 `GET /asyncapi.json`。

与 pi 的接入对比：pi 本地/远端均走 `pi --mode rpc` stdio JSONL（本仓库另有
`maker-pi-manager` 面向 SSH 远端）；Kimi 的 HTTP/WebSocket 形态对 desktop 主
进程更友好，无需 stdio 桥接进程，事件流天然支持断线重订阅。

注意：Kimi 服务 API 标注为**实验性**，端点与事件类型可能随版本变更。桥接层
应以运行期的 `/openapi.json`、`/asyncapi.json` 为准做能力探测，并对未知事件
类型做前向兼容（忽略而非报错）。

### 进程与生命周期

- desktop 主进程为每个 `kimi-code` worker spawn `kimi web --no-open --port 0`
  （或复用同机已运行实例——`~/.kimi-code/server/instances/` 有实例登记，
  可据此决策复用或新起）。
- token 读取 `~/.kimi-code/server.token`；文件缺失或 `auth` 快照未登录时，
  preflight 引导用户在终端执行 `kimi` → `/login`（Kimi 会员 OAuth）。
- worker idle 时保留服务进程（会话数据在 `~/.kimi-code/`，恢复成本低）；
  archive 时按会话 `archive` 动作收尾，服务进程在无活跃会话后回收。

### 改动面清单

以下为本期需要触达的位置（基于 main 分支 a201619a 调研）：

#### 1. 类型层：AgentKind 联合类型扩展（+ `'kimi-code'`）

- `packages/model-providers/src/types.ts:23` — `AgentKind`
- `packages/maker-scheduler/src/types.ts:2` — `AgentKind`
- `packages/maker-core/src/types/common.ts:8` — `AgentKind`
- `apps/desktop/src/renderer/hooks/useAgentCapabilities.ts:20` — `AgentKind`
- `packages/maker-shared/src/agentTask.ts:132,199,214,295,350,429` —
  `provider` / `source` 联合类型与归一逻辑
- `packages/maker-shared/src/scheduleTypes.ts:2` — `RemoteScheduleAgentKind`
- `packages/maker-shared/src/subagentWorkspace.ts:11` — `SubagentProvider`
- `packages/maker-shared/src/agentCapabilities.ts:10,309` —
  `newSessionDefault` 与类型守卫
- `packages/maker-shared/src/fixtures.ts:21` — `agentKind`（注意此处为
  `'cc' | 'codex' | 'pi'` 缩写形态，新增值建议 `'kimi'` 并在映射层对齐）

#### 2. MCP 工具层

- `packages/lizi-mcps/src/xdt-helper/create_worker.ts:72` — agent enum 增加
  `'kimi-code'`，同步更新 127/131 行的说明文案（Fast 模式说明保持不含
  kimi-code）。
- `packages/lizi-mcps/src/xdt-helper/list_available_models.ts` — agent 参数
  枚举同步。
- `packages/orca-workflow/src/orca-bridge-mcp.ts:714,719` — codex 特判逻辑
  审视是否需覆盖 kimi-code（当前为 codex 专属的上下文能力判断）。

#### 3. worker 创建服务（desktop 主进程）

`apps/desktop/src/main/maker-ipc/orcaWorkerCreationService.ts`：

- `selectWorkerModel`（约 352 行）：新增 `kimi-code` 默认模型
  `kimi-for-coding`（与 Kimi CLI 的默认 coding 模型对齐）。
- `agentDisplayName`（约 524 行）：显示名 `Kimi Code`。
- `agentConsumesExplicitFast`（约 533 行）：保持不含 `kimi-code`。
- `buildNoProviderMessage`（约 546 行）：`others` 候选列表加入 `kimi-code`。
- preflight 就绪检查：`kimi` 可执行文件存在 + `~/.kimi-code/server.token`
  或 OAuth 登录态（经 `GET /api/v1/auth`）就绪；未就绪给出终端登录指引。

#### 4. 会话路由与鉴权态广播（desktop 主进程）

- `apps/desktop/src/main/maker-host/index.ts`：
  - session 创建分发（约 860–880 行 `agentKind` 透传处）接入 `kimi-code`
    的 session 工厂；
  - `AUTH_STATE_CHANGED` 广播（约 2211–2243 行，现有 codex / claude-code
    两路）新增 `agentKind: 'kimi-code'` 一路，数据源为 `GET /api/v1/auth`
    快照 + WebSocket 事件。
- `apps/desktop/src/main/process-monitor/agent-scan.ts` 及 codex 进程登记
  相邻逻辑：`kimi web` 服务进程纳入进程监控。

#### 5. 新包 `@cindy/maker-kimi-manager`（建议）

结构参照 `packages/maker-pi-manager`（client / codec / protocol / server /
session-registry / bin，约 2600 行规模），但桥接目标为 HTTP/WebSocket：

- `server-client.ts` — `kimi web` REST 客户端（信封 `code/msg/data/request_id`
  解包、错误码分段处理）。
- `event-stream.ts` — WebSocket 订阅、事件归一（`assistant.delta` /
  `tool.call.*` / `turn.*` → Cindy 消息事件）、断线重订阅。
- `session-registry.ts` — worker session ↔ kimi session id 映射、
  fork / abort / archive 动作转发。
- `instance-manager.ts` — `kimi web` 进程 spawn / 端口分配 /
  `server/instances/` 复用判定 / token 读取与轮换（`kimi web rotate-token`）。
- 权限审批：Kimi 侧审批事件（`40901/40902/41001` 错误码语义表明存在审批
  模型）映射为 Cindy 权限卡，本期可先以只读自动通过 + 写操作透传确认的卡
  片桥接，完整审批桥接列为开放问题。

#### 6. renderer UI

- `apps/desktop/src/renderer/features/cc-agent/CreateWorkerPopover.tsx` —
  agent 选项增加 Kimi Code（图标、显示名）。
- `packages/maker-shared/src/sessionActionStrip.ts:219` 与
  `apps/desktop/src/renderer/features/cc-agent/workerLabel.ts` — 显示名
  `Kimi Code`。
- 新建 worker 的模型下拉：经 `list_available_models` 返回 kimi-code 可用
  模型集（`moonshotai/kimi-k3`、`kimi-for-coding` 等，随账号 Model Access）。

### 凭据策略

Cindy **不接管** Kimi 的 OAuth 流程：用户在终端执行 `kimi` → `/login` 完成
Kimi 会员授权，凭据落在 `~/.kimi-code/`。Cindy 侧仅做：

1. 检测 `kimi` 可执行文件（PATH / 常见安装路径）；
2. 检测 `~/.kimi-code/server.token` 与登录态（`GET /api/v1/auth`）；
3. 未就绪时在 worker 创建 preflight 给出明确指引（复用
   `buildNoProviderMessage` 的引导模式）。

这与 claude-code 的 OAuth 由 CLI 持有、Cindy 广播鉴权态的模式一致。

### 分阶段计划

- **Phase 1（本 PR 范围）**：类型层扩展 + MCP 工具枚举 + 创建服务默认值 /
  显示名 + renderer 选项 + 本方案文档。此阶段合入后，选择 `kimi-code` 会在
  preflight 得到「尚未支持」的明确错误，不会静默落到错误路由。
- **Phase 2**：`@cindy/maker-kimi-manager` 包与本地 worker 启动链路
  （spawn `kimi web`、会话驱动、事件归一、权限卡桥接）。
- **Phase 3**：远端 SSH `kimi-code` worker（远端跑 `kimi web`，经 SSH
  本地端口转发桥接，复用 maker-remote-ssh 的通道模式）、usage 统计接入、
  scheduler 支持。

## 开放问题

1. **实验性 API 稳定性**：Kimi 服务 API 标注为实验性，桥接层需要按
   `/openapi.json` 做版本能力探测，还是锁定已验证的 kimi-code 版本区间？
2. **审批桥接深度**：Kimi CLI 的「修改文件 / 执行 Shell 前确认」模型与
   Cindy 权限卡的映射粒度（逐工具 vs 会话级）需要与维护者确认。
3. **多实例复用**：同机已运行 `kimi web` 实例（用户手动起的）是否复用？
   复用可省去重复进程，但会话隔离边界需谨慎。
4. **fixtures 命名**：`maker-shared/src/fixtures.ts` 的 `agentKind` 缩写
   形态新增 `'kimi'` 还是 `'kimi-code'`，需与现有 `'cc'` 缩写惯例对齐。
