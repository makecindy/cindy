# Codex Automation Import Design

## Goal

让 Cindy 能从本机旧 Codex 的 `~/.codex/automations/*/automation.toml` 读取自动化配置，解决 agent 无法直接看到“已安排任务”完整 prompt 的问题。

## Scope

本 PR 是单向、用户确认后批量导入的系统 Codex → Cindy 流程：先预览全部任务，再逐条选择，最后一次确认创建 Cindy Scheduler 任务。

包含：

- 扫描系统 Codex home 下的自动化目录；默认路径为 `path.join(os.homedir(), '.codex', 'automations')`，不读取 Cindy 自己隔离的 `codex-home`。
- 解析 `automation.toml` 的名称、prompt、status、rrule、model、reasoning_effort、execution_environment、target 和 cwds。
- 输出可供现有 `schedule_create` 使用的字段和 RRULE 诊断，并精确转换当前 Cindy cron 能表达的规则。
- 在 `cindy_scheduler` MCP 提供 `codex_automation_list` 与 `codex_automation_get` 两个只读工具。
- 在 Scheduler 页面提供“从 Codex 导入”入口、逐条 checkbox、重复预览、二次确认和批量结果。
- Main 侧重新读取并按 source ID 导入，MCP/renderer 均不直接访问文件系统；不修改 Codex 原始 TOML。

不包含：

- Codex 与 Cindy 的双向同步。
- 自动覆盖、暂停或删除现有任务。
- 读取网络端任务、凭证或 Codex 账号数据。
- 修改 Codex 原始 `automation.toml`。
- 双向同步、删除/覆盖 Codex 原任务，以及自动把无法精确表达的规则改写为近似频率。
- 在本 PR 中扩展 Cindy Scheduler 的完整 RFC 5545/RRULE 执行引擎。

## Recurrence policy

当前只精确支持 `DAILY`、固定 `BYHOUR/BYMINUTE`，以及 `WEEKLY`/`MONTHLY` 的单值或多值日字段。`INTERVAL>1`、`UNTIL`、`COUNT`、`BYSETPOS`、多值时间和其它 Cindy cron 无法表达的规则会标记为不可直接迁移并默认不勾选；不会把双周任务静默改成每周。

当前用户的“铃兰排期双周刷新 review-only”会在预览中保留完整 prompt 和原始双周规则，但不会被静默转换。

## Architecture

### Main-process reader

新增纯解析模块，放在 `apps/desktop/src/main/scheduler-host/` 附近，负责：

1. 固定扫描系统 Codex automation root；不接受 renderer 传入任意路径。
2. 使用桌面端已有的 TOML 解析依赖读取文件。
3. 校验 `version`、`id`、`name`、`prompt`、`status`、`rrule` 和 `cwds` 的类型与长度。
4. 输出不含文件句柄的安全 DTO：源 ID、展示字段、原始 RRULE、诊断和可供 `schedule_create` 使用的字段。

### MCP boundary

新增两个窄 MCP 工具：

- `codex_automation_list()`：列出所有经过校验的自动化摘要。
- `codex_automation_get({id})`：读取指定自动化的完整 prompt 和字段。

Main 侧通过 `SchedulerMcpDeps` 注入 reader；MCP 包不直接访问 Electron 或文件系统。错误返回统一为可展示的结构化错误，不回传绝对内部堆栈。

### Agent-facing migration flow

页面调用窄 IPC `maker:schedule:codex-automation-preview` 获取迁移 DTO，默认勾选可精确迁移且不存在等价 Cindy 任务的项。用户可以逐条取消或全选/取消全选；确认按钮再次列出选中任务，之后调用 `maker:schedule:codex-automation-import`。Main 侧重新读取 TOML、重做转换和重复检测，再逐条创建，单条失败不会阻塞其余任务。

## Mapping

| Codex field | Cindy field | Rule |
|---|---|---|
| `name` | `name` | 原样保留 |
| `prompt` | `prompt` | 原样保留 |
| `model` | `model` | 原样保留，`agentKind = 'codex'` |
| `reasoning_effort` | `effort` | 原样保留 |
| `cwds[0]` | `workingDir` | 只接受绝对路径；当前项目路径之外仍可预览但不能越权写入 |
| `execution_environment = 'local'` | `workspaceKind = 'project'` | 其它值标记不支持 |
| `status = 'ACTIVE'` | active | `PAUSED/DISABLED/INACTIVE` 创建后保持 paused；未知状态不可迁移 |
| `rrule` | `cronExpr` | 仅写入可精确表达的五字段 cron；不支持的规则阻止导入 |
| — | `notify` | 使用 Cindy 默认 `{ desktop: true, feishu: false }`，在预览中明确展示 |
| — | `useWorktree` | `false`，与 Codex 本地任务语义一致 |

## Testing

- Reader unit tests：真实形态 fixture、UTF-8 prompt、缺字段、非法字段、重复 ID、不可转换双周规则。
- MCP tests：工具发现、完整 prompt 返回、未知 ID、reader 错误协议和只读约束。
- Converter/migration tests：RRULE 精确映射、双周阻断、重复检测、逐条跳过和部分失败。
- Renderer 通过 preload bridge 调用预览/批量导入；页面级刷新由 Scheduler 现有 store 负责。
- 运行受影响 package 的 typecheck/unit tests；完整 `pnpm test:unit` 按仓库门禁执行，若环境限制则在 PR 中如实说明。

## Risks and rollback

- 风险：用户旧 Codex 配置可能使用 Cindy 尚未支持的 RRULE 变体。处理方式是预览警告并禁止静默转换。
- 风险：本机存在多个 Codex home。V1 固定读取系统 `~/.codex/automations`，在预览标题中显示来源路径；不读取 Cindy 隔离目录。
- 风险：导入会创建可产生模型费用的自动化。确认前不写库，确认按钮展示费用提醒。
- 回滚：删除导入入口和 importer 文件即可；已创建的 Cindy 任务由用户在现有 Scheduler UI 中逐条暂停或删除，本 PR 不修改 Codex 源文件。
