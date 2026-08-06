# Codex Automation Import Design

## Goal

让 Cindy 能从本机旧 Codex 的 `~/.codex/automations/*/automation.toml` 读取自动化配置，解决 agent 无法直接看到“已安排任务”完整 prompt 的问题。

## Scope

本 PR 是单向、只读的系统 Codex → Cindy 发现 MVP；实际创建 Cindy 任务继续复用现有 `schedule_create`，不在本 PR 里做 UI 导入流程。

包含：

- 扫描系统 Codex home 下的自动化目录；默认路径为 `path.join(os.homedir(), '.codex', 'automations')`，不读取 Cindy 自己隔离的 `codex-home`。
- 解析 `automation.toml` 的名称、prompt、status、rrule、model、reasoning_effort、execution_environment、target 和 cwds。
- 输出可供现有 `schedule_create` 使用的字段和 RRULE 诊断。
- 在 `cindy_scheduler` MCP 提供 `codex_automation_list` 与 `codex_automation_get` 两个只读工具。
- MCP 层不写入 Cindy 数据库，不修改 Codex 原始 TOML，不执行任何自动化。

不包含：

- Codex 与 Cindy 的双向同步。
- 自动覆盖、暂停或删除现有任务。
- 读取网络端任务、凭证或 Codex 账号数据。
- 修改 Codex 原始 `automation.toml`。
- 在 Scheduler 页面增加导入入口、重复检测或自动创建 Cindy 任务（后续 PR）。
- 在本 PR 中扩展 Cindy Scheduler 的完整 RFC 5545/RRULE 执行引擎。

## Recurrence policy

本 PR 保留 Codex 原始 `rrule`，只做安全诊断，不把它静默转换成 Cindy cron。包含 `INTERVAL` 大于 1、缺少固定时间或使用当前 cron 不支持的字段时，标记为“需要手工调整”，展示原始规则和原因，避免把隔周任务错误地变成每周任务；精确 RRULE→cron 转换留给后续导入 PR。

当前用户的“铃兰排期双周刷新 review-only”会在预览中保留完整 prompt 和原始双周规则，但不会被静默转换；后续可单独提交 RRULE 原生支持的 PR。

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

agent 先调用 `codex_automation_list` 发现任务，再按需调用 `codex_automation_get` 获取完整 prompt，最后复用现有 `schedule_create` 创建 Cindy 任务。创建前由 agent 向用户确认；本 PR 不自动创建，避免无意产生模型费用。

## Mapping

| Codex field | Cindy field | Rule |
|---|---|---|
| `name` | `name` | 原样保留 |
| `prompt` | `prompt` | 原样保留 |
| `model` | `model` | 原样保留，`agentKind = 'codex'` |
| `reasoning_effort` | `effort` | 原样保留 |
| `cwds[0]` | `workingDir` | 只接受绝对路径；当前项目路径之外仍可预览但不能越权写入 |
| `execution_environment = 'local'` | `workspaceKind = 'project'` | 其它值标记不支持 |
| `status = 'ACTIVE'` | active | 非 ACTIVE 记录只读展示 |
| `rrule` | — | 本 PR 原样返回；后续导入流程再做精确转换 |
| — | `notify` | 使用 Cindy 默认 `{ desktop: true, feishu: false }`，在预览中明确展示 |
| — | `useWorktree` | `false`，与 Codex 本地任务语义一致 |

## Testing

- Reader unit tests：真实形态 fixture、UTF-8 prompt、缺字段、非法字段、重复 ID、不可转换双周规则。
- MCP tests：工具发现、完整 prompt 返回、未知 ID、reader 错误协议和只读约束。
- 运行受影响 package 的 typecheck/unit tests；完整 `pnpm test:unit` 按仓库门禁执行，若环境限制则在 PR 中如实说明。

## Risks and rollback

- 风险：用户旧 Codex 配置可能使用 Cindy 尚未支持的 RRULE 变体。处理方式是预览警告并禁止静默转换。
- 风险：本机存在多个 Codex home。V1 固定读取系统 `~/.codex/automations`，在预览标题中显示来源路径；不读取 Cindy 隔离目录。
- 风险：导入会创建可产生模型费用的自动化。确认前不写库，确认按钮展示费用提醒。
- 回滚：删除导入入口和 importer 文件即可；已创建的 Cindy 任务由用户在现有 Scheduler UI 中逐条暂停或删除，本 PR 不修改 Codex 源文件。
