# Tencent 本地 Harness 集成 Spec

> 状态：待发布到项目 issue tracker  
> 对应设计：`docs/tencent-local-harness-integration-plan.md`  
> 已接受决策：`docs/adr/0001-tencent-local-harness-boundaries.md`

## Problem Statement

已经登录腾讯内部 AI 工具的用户，当前不能在 Cindy 中直接使用本机的 `tclaude`、`tcodex`
和 CodeBuddy CLI。Cindy 要求自己的模型 API、Gateway 或订阅认证，而这些 CLI 已经持有
腾讯认证、模型目录和上游路由。用户不得不在终端和 Cindy 之间切换，或重复配置本不应由其
管理的凭证。

同时，三个 CLI 的技术形态不同：`tclaude` 和 `tcodex` 分别兼容 Claude Code 与 Codex，
而 CodeBuddy 是独立 Agent Loop，只能通过 ACP 接入。若 Cindy 把它们都视为普通模型
Provider，或把 CodeBuddy 冒充为 Claude/Codex，会破坏权限、会话恢复、工具事件、跨端展示
和认证边界。

## Solution

Cindy 提供腾讯本地 Harness 集成：

- 将 `tclaude` 作为 Claude Code 的 Tencent runtime distribution；
- 将 `tcodex` 作为 Codex 的 Tencent runtime distribution；
- 将 CodeBuddy 作为独立 `codebuddy` Harness，并通过 ACP v1 接入；
- 由腾讯 CLI 独占认证、token 刷新、模型目录和上游路由；
- 由 Cindy 独占任务、会话、权限、MCP、持久化、工具展示和多端投影；
- 在高级 Settings 中管理本机 executable、状态、版本、能力 profile 和默认 runtime；
- 在模型选择器中允许单个任务明确选择腾讯来源，覆盖全局默认；
- 显式腾讯 route 失效时保留选择并提供显式切换，绝不自动改走其他付费来源。

第一阶段必须同时交付 `tclaude` 和 `tcodex`，以及正式高级 Settings UI。第二阶段交付
CodeBuddy ACP Harness。CodeBuddy 的旧控制端使用安全只读降级。

## User Stories

1. 作为已登录 `tclaude` 的用户，我想在 Cindy 中选择 Tencent Claude Code，以便不配置额外 Anthropic API 或订阅。
2. 作为已登录 `tcodex` 的用户，我想在 Cindy 中选择 Tencent Codex，以便继续使用企业内模型目录和认证。
3. 作为已登录 CodeBuddy 的用户，我想在 Cindy 中创建 CodeBuddy 任务，以便在 Cindy 的任务体验中使用 CodeBuddy Agent Loop。
4. 作为用户，我想在 Settings 中选择本机 Tencent Harness executable，以便 Cindy 使用我已安装的 CLI。
5. 作为用户，我想看到 wrapper、上游版本和能力状态，以便知道为什么某个 Harness 可用或不可用。
6. 作为用户，我想让 Settings 保存默认 Harness runtime，以便新任务遵循我的常用选择。
7. 作为用户，我想在单个任务中显式选择 Tencent 来源，以便覆盖全局默认而不影响其他任务。
8. 作为用户，我想让已有任务保留其实际 runtime identity，以便我之后更改默认设置不会改写历史任务。
9. 作为用户，我想在 Tencent route 失效时看到修复和显式切换入口，以便自己决定是否使用其他来源。
10. 作为用户，我不希望腾讯 route 自动切到 Cindy Gateway、官方订阅或其他模型，以便避免意外计费和数据出口变化。
11. 作为用户，我想看到 Tencent runtime 实际提供的模型、上下文和推理档位，以便做出正确选择。
12. 作为用户，我想在 Tencent CLI 的模型目录更新后刷新 Cindy 展示，以便不使用过期模型信息。
13. 作为 Claude Code 用户，我想在 Cindy 中获得流式文本、thinking、usage 和原生恢复，以便体验不低于终端使用。
14. 作为 Codex 用户，我想在 Cindy 中获得 app-server 的模型列表、流式消息、任务历史和基础工具展示，以便继续使用 Codex 工作流。
15. 作为 CodeBuddy 用户，我想在 Cindy 中获得 ACP 的文本流、thinking、工具卡、权限卡、模式和模型切换，以便在 GUI 中使用 CodeBuddy。
16. 作为用户，我想在 CodeBuddy 请求写文件时看到 Cindy 权限确认，以便拒绝后文件不会写入。
17. 作为用户，我想让 CodeBuddy 任务默认不继承我本机的全局 MCP、Skill、插件和 hooks，以便本机环境不会意外扩大 Cindy 的能力面。
18. 作为用户，我想让 Cindy 只挂载我明确授权的 MCP，以便知道 Agent 在任务中能调用什么。
19. 作为 Bot 用户，我不希望 CodeBuddy 自动继承项目或全局资源，以便伙伴能力保持隔离。
20. 作为 Review 用户，我不希望未经验证的 CodeBuddy 隔离能力被宣称可用，以便只读审查边界不被弱化。
21. 作为 Mobile 控制端用户，我想在旧版本中仍能阅读 CodeBuddy 任务消息和状态，以便新 agent kind 不会破坏任务连续性。
22. 作为旧控制端用户，我不希望看到无法安全执行的 CodeBuddy 高级操作，以便不会误触未知能力。
23. 作为安全审计者，我不希望 Cindy 读取、复制、存储或显示腾讯 token，以便凭证继续留在 CLI 所属边界。
24. 作为安全审计者，我希望 Renderer 不能任意指定 executable，以便本机程序执行仍由 Main 审核。
25. 作为维护者，我希望 wrapper 更新后能力 profile 自动失效重测，以便旧探测结果不会错误授权新二进制。
26. 作为维护者，我希望 tcodex 高风险能力按 probe 开关，以便不能因版本名或基础功能成功而误开 Review、fork 或复杂权限能力。
27. 作为维护者，我希望 CodeBuddy stdout 只有 ACP NDJSON，以便协议解析稳定且不吞掉未知错误。
28. 作为维护者，我希望 CodeBuddy resume 的已知调试 stdout 被窄过滤并记录诊断，以便在上游修复前保持恢复可用且不掩盖其他污染。
29. 作为维护者，我希望每个本地 Harness 进程能够有界停止和确认退出，以便不会留下孤儿任务或凭证持有进程。
30. 作为维护者，我希望测试覆盖真实 CLI 主链路和 fake protocol 边界，以便 wrapper 升级时能快速发现兼容性漂移。

## Implementation Decisions

- `tclaude` 和 `tcodex` 不新增 `AgentKind`；它们是现有 Claude Code / Codex adapter 的 runtime distribution。
- CodeBuddy 新增 append-only `codebuddy` AgentKind，通过 ACP v1 接入。
- 第一阶段同时发布 `tclaude` 与 `tcodex`，并提供正式高级 Settings UI；不得只发布其中一个 runtime。
- Settings 管理默认 runtime distribution；任务模型选择可保存单任务 Tencent source override。
- 腾讯 route 是 Harness-managed route。腾讯 CLI 负责 auth 和 provider routing；Cindy 不注入自己的模型 endpoint、API key、OAuth token 或 proxy route。
- `tclaude` 必须不接收 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`、Anthropic endpoint 或 Cindy auth 环境。
- `tcodex` 保留 Cindy 隔离 `CODEX_HOME`，但不接收 Cindy Codex provider routing；wrapper 继续使用 Tencent model provider。
- tcodex 的 capability profile 由 Settings-time probe 建立，按 executable identity 缓存，在 realpath、版本、大小或 mtime 变化后失效。
- 未 probe 的 tcodex 高风险能力默认关闭。普通任务只使用已验证的 app-server、模型、workspace root、plugin/skill config 和 unsubscribe 能力。
- CodeBuddy 每个 Cindy Session 独立启动 ACP stdio 进程，首期不共享进程。
- CodeBuddy 固定使用 isolated local settings、strict MCP 和 Cindy 创建的最小 MCP config。
- CodeBuddy 模型和权限模式从 ACP `session/new` / `session/load` 返回结果投影，不读取私有缓存。
- CodeBuddy 权限通过 ACP `session/request_permission` 映射到 Cindy interaction resolver；超时和未知 option 一律拒绝。
- CodeBuddy resume 首期只过滤已观察到的 `convertHistoryItemToAcp` stdout 调试前缀并记录诊断；其他非 JSON stdout 是协议错误。
- CodeBuddy 的 Bot、Review、Scheduler、fork、rewind、background task、Auto 和完整 Mobile 控制不进入首期。
- 旧 Mobile/device-link 对端对 CodeBuddy 使用安全只读降级：消息和状态可读，创建、模型切换和高级控制不可用。
- executable 由 Main-owned profile 保存并在执行前复核；Renderer 不能传任意 command。

## Testing Decisions

测试优先覆盖用户可见边界和协议行为，而不是内部类实现：

- runtime profile 默认、override、恢复默认、owner 隔离和 identity 失效；
- executable realpath、symlink、Node wrapper launch plan 和不可执行文件拒绝；
- tclaude 在 Harness-managed route 下不接收 Cindy provider/auth env；
- tcodex capability probe、未验证能力关闭、隔离 `CODEX_HOME` 和 model provider identity；
- CodeBuddy ACP initialize/new/load/prompt/mode/model/cancel/permission；
- CodeBuddy 写入拒绝时文件不落盘；
- CodeBuddy stdout 的已知调试前缀过滤和未知污染 fail-closed；
- MCP 最小配置、lease 清理、权限和资源隔离；
- 新 `codebuddy` AgentKind 在数据库、Desktop、Mobile 和 device-link 的 append-only 演进；
- 旧控制端对 CodeBuddy 的安全降级；
- stop/close/crash 后的子进程确认退出。

优先复用现有 Claude Code stream、Codex app-server transport、Pi JSONL transport、Session
生命周期、interaction resolver、provider catalog、device-link allowlist 与跨端 fallback
测试 seam。新增 CodeBuddy ACP transport 应保持相同的 line limit、stderr 脱敏、关闭确认和
错误收口语义。

## Out of Scope

- 腾讯 CLI 的 token 导入、复制、迁移或共享。
- 任意第三方 executable 的通用开放式接入。
- SSH 远端运行三种腾讯 Harness。
- CodeBuddy 用户/项目原生环境继承。
- CodeBuddy Bot、Review、Scheduler、Auto、fork、rewind、background tasks。
- CodeBuddy 完整 Mobile/device-link 交互。
- 自动从腾讯 route 切换到其他模型来源。
- 对 CodeBuddy 非白名单 stdout 的宽松兼容。

## Further Notes

真实 CLI 已验证三条主协议路径可行。后续工作重点是实现受信 runtime profile、单一 auth/route
owner、CodeBuddy ACP adapter、capability gate 和 append-only 跨端兼容，而不是继续探索 CLI
是否能完成普通任务。

项目当前没有配置本地 issue tracker、triage label 或 `ready-for-agent` 标签，因此该 spec
暂存于仓库文档。运行 `/setup-matt-pocock-skills` 后，应将此内容发布到目标 issue tracker
并应用 `ready-for-agent` 标签。
