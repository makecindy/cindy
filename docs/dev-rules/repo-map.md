# 仓库地图（Repo Map）

> **读取时机**：首次接触本仓、需要定位某个功能的代码位置、或新增代码／依赖前判断
> 应该放进哪个模块时

本文只做**定位导航**：先按用户行为找生产入口、共享判据和测试，再按目录判断代码归属。
事实源是各目录的源码、`package.json` 与 README；发现本文与代码不一致时，以代码为准并顺手修正本文。
依赖方向与解耦约束见 [`architecture-invariants.md`](architecture-invariants.md)。

## 按用户行为定位

模块约束从 [Desktop](../../apps/desktop/AGENTS.md)、[Mobile](../../apps/mobile/AGENTS.md)、
[maker-core](../../packages/maker-core/AGENTS.md) 进入；下表记录现有入口，不另建任务生命周期框架。
`register.ts` 仍负责部分宿主接线，按表中的函数／IPC 名定位即可，不必从头阅读。

| 用户行为 | 生产入口与共享判据 | 从哪些测试开始 |
| --- | --- | --- |
| 发送、排队、插话、停止后继续 | [AgentInputCoordinator](../../apps/desktop/src/main/maker-ipc/agent-input-coordinator.ts) 持有输入事务；[register.ts](../../apps/desktop/src/main/maker-ipc/register.ts) 的 `sendToSessionInternal` 接宿主发送；[agentInputQueue](../../apps/desktop/src/shared/agentInputQueue.ts) 定义队列契约。个人 IM / 官方 hook 的调用方账本见 [IM 轮次流程](im-turn-flow.md)。 | [coordinator](../../apps/desktop/src/main/maker-ipc/__tests__/agent-input-coordinator.test.ts)、[队列契约](../../apps/desktop/src/main/__tests__/agentInputQueue.test.ts) |
| 普通任务、伙伴与群任务切换权限 | [register.ts](../../apps/desktop/src/main/maker-ipc/register.ts) 的 `SET_PERMISSION_MODE` 与 [sessionPermissionChange](../../apps/desktop/src/main/maker-ipc/sessionPermissionChange.ts) 处理运行期变更；未加载运行时的持久化走 [sessionPermissionPersistence](../../apps/desktop/src/main/maker-ipc/sessionPermissionPersistence.ts)，伙伴专线同步走 [botPermissionSync](../../apps/desktop/src/main/maker-ipc/botPermissionSync.ts)。[permissionMode](../../packages/maker-shared/src/permissionMode.ts) 统一客户端的未知档位与 Full access 确认判据；实际执行权限仍由宿主／引擎决定。 | [权限持久化与专线同步](../../apps/desktop/src/main/maker-ipc/__tests__/sessionPermissionPersistence.test.ts)、[引擎控制](../../packages/maker-core/src/session-control.test.ts)、[跨端权限判据](../../packages/maker-shared/src/__tests__/permissionMode.test.ts) |
| 重启后发现中断任务、运行中断后续跑 | 启动候选由 [sessionActiveTurn](../../apps/desktop/src/main/localDb/sessionActiveTurn.ts) 判定，[interruptedResumeCandidates](../../apps/desktop/src/main/localDb/interruptedResumeCandidates.ts) 补展示信息；运行期自动续跑由 [interruptedTurnAutoResume](../../apps/desktop/src/main/maker-ipc/interruptedTurnAutoResume.ts) 分类，再回输入协调器。两者不是同一触发条件。 | [启动中断判据](../../apps/desktop/src/main/localDb/__tests__/sessionActiveTurn.test.ts)、[启动恢复对话框](../../apps/desktop/src/renderer/features/cc-agent/__tests__/InterruptedTasksResumeDialog.test.tsx)、[自动续跑判据](../../apps/desktop/src/main/maker-ipc/__tests__/interruptedTurnAutoResume.test.ts) |
| 新任务与伙伴选择默认模型 | Desktop 的 [newMakerDefaultTuple](../../apps/desktop/src/shared/newMakerDefaultTuple.ts) 选择默认组合；[botDefaultModelChain](../../apps/desktop/src/shared/botDefaultModelChain.ts) 复用推荐，但伙伴设置与新任务输入框选择独立。Mobile 的 [useNewSessionDefaultSelection](../../apps/mobile/src/session/useNewSessionDefaultSelection.ts) 调用 [newSession](../../apps/mobile/src/session/newSession.ts) 中的 `resolveNewSessionAutoDefault`，被控端默认与缓存由 [useNewSessionHostDefaults](../../apps/mobile/src/session/useNewSessionHostDefaults.ts) 提供。目录来源与覆盖顺序见[模型配置与下发](model-catalog-maintenance.md)。 | [默认组合](../../apps/desktop/src/renderer/lib/__tests__/newMakerDefaultTuple.test.ts)、[伙伴默认](../../apps/desktop/src/shared/__tests__/botDefaultModelChain.test.ts)、[手机默认与缓存](../../apps/mobile/src/__tests__/newSessionHostDefaults.test.tsx) |
| 手机新建任务、创建中继续输入、失败回编辑 | [new.tsx](../../apps/mobile/app/sessions/new.tsx) 组装页面；[prepareNewSessionCreation](../../apps/mobile/src/session/prepareNewSessionCreation.ts) 先保存草稿与附件，再预建 worktree；[newSessionCreation](../../apps/mobile/src/session/newSessionCreation.ts) 持有跨页面的乐观创建管线；[useNewSessionDraftRecovery](../../apps/mobile/src/session/useNewSessionDraftRecovery.ts) 恢复草稿。 | [乐观创建](../../apps/mobile/src/__tests__/newSessionCreation.test.ts)、[真实恢复 hook](../../apps/mobile/src/__tests__/useNewSessionDraftRecovery.test.tsx)、[草稿持久化](../../apps/mobile/src/__tests__/newSessionCreationPersistence.test.ts) |
| 订阅余量、Cindy 余额与用量汇总（菜单栏面板、手机桌面小组件） | [quota-overview/service.ts](../../apps/desktop/src/main/quota-overview/service.ts) 与平台无关，负责收集、缓存、其他电脑离线保留与重建节奏；面板持有（`acquire`），远程请求租用（`lease`）。视图模型在 [menubar/collect.ts](../../apps/desktop/src/main/menubar/collect.ts)、[menubar/snapshot.ts](../../apps/desktop/src/main/menubar/snapshot.ts)。面板逻辑（任务动态、远控指示、快见底提醒、面板里的各种操作）在 [panelController.ts](../../apps/desktop/src/main/quota-overview/panelController.ts)；展现层只负责画出视图、上报操作：macOS 是 [menubar/service.ts](../../apps/desktop/src/main/menubar/service.ts) 驱动的原生 helper，其他平台的面板实现同一个 `QuotaPanelPresenter` 接入。手机侧见 [usageWidgetSync](../../apps/mobile/src/widgets/usageWidgetSync.ts)。 | [面板与小组件租用](../../apps/desktop/src/main/menubar/__tests__/quotaInvalidation.test.ts)、[视图模型](../../apps/desktop/src/main/menubar/__tests__/snapshot.test.ts)、[收集与离线保留](../../apps/desktop/src/main/menubar/__tests__/collect.test.ts)、[手机取数](../../apps/mobile/src/__tests__/usageWidgetSync.test.ts) |

同一行为涉及普通任务、伙伴、群、调度、本机与远程入口时，从公共入口反查调用方，保留产品规则明确的差异。
手机新建页的[表单编辑与恢复](../../apps/mobile/src/session/newSessionForm.ts)、
[工作区选择](../../apps/mobile/src/session/useNewSessionWorkspace.ts)、
[worktree 偏好同步](../../apps/mobile/src/session/useNewSessionWorktreeSync.ts)、
[语音与光标](../../apps/mobile/src/session/newSessionVoiceInput.ts)、
[模型运行选项校准](../../apps/mobile/src/session/newSessionRuntimeReconciliation.ts)和
[待发消息的会话适配](../../apps/mobile/src/session/mobileOutboxSessionAdapter.ts)可直接测试；
创建前的附件与草稿写盘复用 [persistNewSessionCreationDraft](../../apps/mobile/src/session/persistNewSessionCreationDraft.ts)。
最小草稿、附件与异步夹具复用 [fixtures/newSession](../../apps/mobile/src/__tests__/fixtures/newSession.ts)。
测试优先直接 import 生产模块或挂载真实 hook；价值门槛与源码契约的适用范围见
[工程约定 §3.2](engineering-conventions.md#32-新增测试的价值门槛)，选测入口见[开发流程](development-workflow.md)。
创建中继续输入、离线历史与后台失败等已发生过的回归，见[任务回归场景](session-regressions.md)。

## 顶层结构

| 路径        | 说明                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/`     | 终端产品（desktop、mobile）与随包分发的二进制资产                                                                              |
| `packages/` | 客户端共享能力包（与 render／main 解耦，详见下表）                                                                             |
| `config/`   | 区域端点清单（CN / Global 的公共配置与本地 dev 模板）；新 worktree 的本地配置准备见[环境安装](environment-setup.md) |
| `scripts/`  | 仓库级工程脚本：dev 启动包装、agent 二进制拉取（`ensure-agent-binaries.mjs`）、i18n／endpoint／文档等校验 guard、worktree 管理 |
| `tools/`    | claude／codex／ripgrep／pi 四个 Desktop runtime 的版本 pin（`latest.json`）与更新器（`update.mjs`）                            |
| `docs/`     | 规则文档：`dev-rules/`（工程）、`product-rules/`（产品）、`design-rules/`（设计入口）、`legal/` 等                             |

## apps/

| 路径                                                         | 说明                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`                                               | Cindy 桌面客户端（Electron + Vite），源码分 `main/`（主进程：业务逻辑、maker-host／maker-ipc、localDb、device-link、mcp-integrations、cindy-brain 等）、`renderer/`（纯渲染 UI：features、panels、themes、i18n 等）、`preload/`（最小桥接层）、`shared/`（主／渲染共享类型与常量）；SQLite migration 在 `apps/desktop/drizzle/` |
| `apps/mobile`                                                | Cindy 手机客户端（Expo / React Native）：同账号登录、发现并远程控制桌面设备、镜像会话                                                                                                                                                                                                                                           |
| `apps/claude-code-bin`、`apps/codex-bin`、`apps/ripgrep-bin`、`apps/pi-bin` | 随桌面端分发的预编译 CLI 二进制（按平台分目录）。不是构建包、不进 git 历史；版本由 `tools/<kind>/latest.json` pin，`pnpm install` postinstall 按需下载 |
| `apps/android-platform-tools-bin`                            | Android platform-tools（adb 等）二进制，当前仅 win32-x64，用于连接安卓设备                                                                                                                                                                                                                                                      |

## packages/

「主要使用方」按各 `package.json` 的 workspace 依赖核对；mobile 只直接依赖其中
5 个（auth-client、device-link、maker-shared、model-providers、voice-input-core）。

| 包                                                        | 一句话用途                                                                                                                                                            | 主要使用方                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `maker-core`                                              | Cindy 核心：agent 抽象（BaseAgent）、session 编排与事件流，零 Electron 依赖；改动前必读 [`maker-core-and-agent-behavior.md`](maker-core-and-agent-behavior.md)        | desktop、lizi-mcps、orca-workflow                                                  |
| [`design-tokens`](../../packages/design-tokens/README.md) | DTCG reference / semantic / 薄 component 字典与 Terrazzo 生成合同                                                                                                     | DS-8 已接 Desktop 生产颜色、主题与通用基础；DS-9 消费现有链路，Mobile 后续独立接管 |
| `maker-shared`                                            | 桌面与手机共享的展示层契约模型，零 React／Electron／Expo 依赖                                                                                                         | desktop + mobile                                                                   |
| `maker-cc-manager`                                        | cc-remote：跑在远程 SSH 机器上的 NDJSON RPC 守护进程，封装 Claude Agent SDK，向本地桌面暴露多会话／detach-reattach 能力                                               | desktop（remote-ssh）                                                              |
| `maker-pi-manager`                                        | pi-remote：跑在远程 SSH 机器上的 PI 单例 daemon（TS NDJSON RPC + unix socket bridge），持有 pi 会话、条件 restart、空闲回收                                           | desktop（remote-ssh）                                                              |
| `maker-remote-ssh`                                        | SSH remote：连接池、`~/.ssh/config` 读写、凭据解析，零 Electron 依赖                                                                                                  | desktop                                                                            |
| `maker-scheduler`                                         | 定时任务：cron 引擎 + storage／runner／notifier 接口                                                                                                                  | desktop、lizi-mcps                                                                 |
| `orca-workflow`                                           | Orca 多 worker 协同的 lead 侧：MCP 桥接 + lead prompt；改动前必读 [`orca-team-architecture.md`](orca-team-architecture.md)                                            | desktop                                                                            |
| `device-link`                                             | 跨设备远程控制（同账号互联）：envelope 协议、IPC 隧道 allowlist、重连／心跳；零依赖，WS 实现由 host 注入                                                              | desktop + mobile                                                                   |
| `auth-client`                                             | 平台无关的 Cindy auth-server 客户端契约（zod）                                                                                                                        | desktop + mobile                                                                   |
| `model-providers`                                         | 模型供应商目录、Registry 资料合并与路由抽象；先读 [模型配置与下发](model-catalog-maintenance.md) 获取代码导航                                                         | desktop + mobile                                                                   |
| `anthropic-compat-proxy`                                  | 本地回环 HTTP 代理：剥离 Anthropic 专有字段，让 Claude Code SDK 可经网关访问非 Anthropic 后端                                                                         | desktop                                                                            |
| `anthropic-responses-bridge`                              | 挂载在 `anthropic-compat-proxy` 回环 HTTP 代理内部的进程内协议转换处理器：作为 `RoutingDecision.localHandler` 完成 Anthropic Messages API ↔ OpenAI Responses API 转换 | desktop                                                                            |
| `responses-anthropic-bridge`                              | 本地 Responses → Anthropic Messages 桥：请求、图片／工具／thinking 转换与 Responses SSE 回译                                                                          | desktop                                                                            |
| `lizi-mcps`                                               | 可复用 MCP server 集合（Google 套件、GitHub／GitLab、浏览器、scheduler 等）                                                                                           | desktop                                                                            |
| `cindy-tools`                                             | 意识（Ghost）系统内部工具集（MCP），含 ghost 总机（`ghost_list` / `ghost_info` / `ghost_call`）                                                                       | desktop                                                                            |
| `browser-control-runtime`                                 | 浏览器自动化运行时适配层（playwright-core + MCP）                                                                                                                     | desktop、lizi-mcps                                                                 |
| `file-browser-core`                                       | 文件浏览核心：workdir 扫描、ignore 匹配、ripgrep 搜索；本地后端与远程守护进程共享                                                                                     | desktop、remote-file-service                                                       |
| `remote-file-service`                                     | 远程文件服务：跑在远程 SSH 机器上的 NDJSON RPC 守护进程，封装 file-browser-core                                                                                       | desktop                                                                            |
| `github-client` / `gitlab-client`                         | GitHub REST v3 ／ GitLab REST v4 客户端，零运行时依赖                                                                                                                 | desktop／lizi-mcps                                                                 |
| `embedding-client`                                        | OpenAI `/v1/embeddings` 兼容客户端（走网关）                                                                                                                          | desktop                                                                            |
| `heartbeat-client`                                        | 在线心跳：周期上报维持在线状态，零依赖                                                                                                                                | desktop                                                                            |
| `lizi-im`                                                 | IM 传输层（飞书等 WS 通道）：凭据存储、附件下载、统一发送 API；host 注入适配                                                                                          | desktop                                                                            |
| `project-context`                                         | agent 维护的项目知识层（commit 驱动的 markdown CLI）                                                                                                                  | desktop（maker-ipc）                                                               |
| `voice-input-core`                                        | 语音输入核心：供应商无关的听写状态机与润色守卫                                                                                                                        | desktop + mobile                                                                   |

## 本机应用 Agent 接入

Desktop 的 `main/local-agent/` 提供经 Cindy 主题确认授权的通用本机 Agent API，复用 maker-core 的引擎与内存 Session；应用自己的界面、记录、上下文和业务工具留在调用方。协议、存储和兼容边界见 [本机应用接入](../local-agent-api.md)，独立客户端示例在 `scripts/examples/`。

## 校验下载与工具安装

Desktop 发行资产统一走 `main/downloader/index.ts`；通用工具安装位于
`main/managed-tools/`。接入方法和各业务保留的边界见
[校验下载与受管工具安装](verified-downloads.md)。
