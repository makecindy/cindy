# Cindy Host 功能保留清单（历史阶段记录）

> 2026-11-07 复核：以下保留原分支的历史验证描述，不代表当前完整功能或三平台验收通过。当前缺口与交付条件见 [PR #9246 本地完善与验收](pr-9246-completion.md)。桌面自动接管已取消，改为显式选择 Host。

状态口径只有三种：

- **已验证**：真实浏览器 / 真实 Agent 走通，并留有可复现命令或日志。
- **部分**：接口存在但只覆盖一条路径，或只在单元/进程级验证过。
- **禁用 + TODO**：当前不可用，写明原因与接手条件。

「接口存在」不算「行为一致」。本文件随每次验证更新。

## 聊天与任务

| 能力 | 状态 | 证据 / 缺口 |
|---|---|---|
| 任务列表（真实数据） | 已验证 | 浏览器侧 `localDb.sessions.list()` 返回共用 SQLite 中的任务数组（实测 13 条） |
| 新建任务（草稿 → 落库 → 转正） | 已验证 | `POST /api/sessions/create` 写会话行；`localDb.sessions.create` 走同一路由；`provisional` 标记与 `discard/commit` 路由存在 |
| 发送消息（真实 Agent 回合） | 已验证 | 通过 renderer 通道发送后，SSE 依次收到 `session`、`status`、`text` 增量、`text(isFinal)`、`done`（`stop_reason: end_turn`） |
| 流式回复呈现 | 已验证 | 浏览器内用户气泡 + 助手回复 `FINAL OK`；事件流 `status → session_id → text → done` |
| 权限确认 / 提问交互 | 已验证（协议） | 真实回合：`permissionMode=ask` 下 Host 发出 `interaction_request`，客户端 `respond` 返回 200，随后 `interaction_dismissed` → 工具执行 → `DONE`，目标文件内容为 `OK`。UI 上的确认卡尚未目检（本地 profile 已登出） |
| 停止生成 | 已验证 | 「Stop generating」后 `turnInProgress=false`，用户消息保留，已产出的部分文本落库 |
| 打开历史任务 / 恢复会话 | 已验证 | 新标签页/刷新后仍显示同一轮问答（见 `evidence/stage4-e2e.md`） |
| 历史消息窗口 | 已验证 | Host 在回台中落库 user/assistant 行；`historyView` 用共享投影器生成页面（单页返回，未分页） |
| 会话用量 | 部分 | `estimatedSessionValue` 读会话行总数，无逐条明细 |
| 附件 / 图片 / 语音 | 禁用 + TODO | 未实现媒体通道；voice readiness 返回明确“不可用” |

## Agent 与 Harness

| 能力 | 状态 | 证据 / 缺口 |
|---|---|---|
| Claude Code harness | 已验证 | 网关 key lane（`ANTHROPIC_API_KEY` 注入）跑通真实回合；订阅 lane 由 CLI 自身登录 |
| Codex harness | 部分 | 线程可启动并流式（已修掉 `invalid transport in mcp_servers.cindy_memory` 崩溃）；真实回合仍卡在 `responseStreamDisconnected`：网关 lane 需要 Desktop 的 Responses 代理（`codex-proxy-host.ts`，4171 行、依赖多个 desktop 模块），Host 未迁移 → TODO |
| 模型目录 / 选择器 | 已验证 | 单一 `xd` provider，28 个网关对话模型，双 harness routing；选择器可展开并选中 |
| 能力描述 | 已验证 | `/api/capabilities` 与 provider 模型列表逐项一致 |
| 斜杠命令 / 技能 | 部分 | `maker.listAgentCommands` / `listAgentSkills` 转真实 agent 实现；未在界面验证 |
| 多 Agent / 伙伴 / 群聊 | 禁用 + TODO | 依赖 bot 相关通道，当前返回明确的空态；未验证行为一致 |
| 插件执行（运行期） | 禁用 + TODO | 插件沙箱宿主是 Electron `webContents` 实现（1026 行）；Host 需独立沙箱方案，未做 |

## 平台与集成

| 能力 | 状态 | 证据 / 缺口 |
|---|---|---|
| 本地模式（无账号） | 部分 | 登录页可进入本地模式（`authGetLoginState`/`authEnterLocal` 已实现），但随后停在 “Waking Cindy…” 启动门；Host 侧尚无本地 owner 命名空间 |
| 复用现有登录 | 已验证（单写者） | 登录态稳定：Host 后台每 30 分钟定时刷新，暴露 `/api/auth/refresh`；Desktop 客户端模式重定向所有刷新至 Host，杜绝并发 refresh token 轮转失效 |
| 复用现有存储 | 已验证 | 打开同一 owner 生产库（192 条存量任务与全部历史），无平行数据库，`fuser -v` 确认单写者 |
| 单 Runtime 锁 | 已验证 | 第二个 Host 报 `runtime.state=blocked`、`storage=unopened` |
| 设置与偏好同步 | 已验证 | 外观设置、窗口布局、全局快捷键、项目别名由 Host 统一读写，并通过带序号 SSE 事件实时广播，两端 1 秒内同步 |
| 插件列表 | 已验证（读） | Host 复用 Desktop `GhostManager` 列出已装插件（`/api/ghosts`，单测 + 实跑 `[]`）；`#/plugins` 页明暗两种模式正常；插件**执行**未迁移 |
| 文件访问（回合内工具） | 已验证 | Host 回合内 Bash/文件工具真实执行：`/chat` 回合经 `/api/interactions/respond` 批准后写出 `proof.txt`，回复回显内容 |
| 文件选择 / 目录浏览 UI | 禁用 + TODO | 依赖 Electron `dialog`；浏览器端改用路径输入 |
| Memory（Claude 回合内） | 已验证 | Host 装配同一 owner 作用域的 `MakerMemoryManager` + `cindy_memory` MCP；真实回合 `list_tools → memory_write → memory_read` 回读 `memory-roundtrip-ok` |
| Memory（Codex 回合内） | 禁用 + TODO | Codex 需要 Desktop 的 HTTP MCP 桥（`prepareCodexExtraSpawnConfig`），未迁移 |
| MCP 服务器配置 | 禁用 + TODO | `custom-mcp-store` 无 Electron 依赖，可复用；尚未接线到 Host |
| 定时任务（scheduler） | 禁用 + TODO | 仍在 Electron main；Host 侧未实现 |
| device-link / 手机端 | 部分 | 迁移期仍由 Desktop 承担；客户端模式下相关通道显式失败 |
| systemd user unit | 已验证 | `cindy-host.service` 与 `cindy-desktop.service` 均已安装并在生产 profile 上成功启动与运行 |
| Tray / 原生菜单 / 窗口特效 / 桌面快捷键 | 禁用 + TODO | Electron 专属；浏览器端不提供，需在 `cindy-desktop` 保留 |
| Device Link / 手机端 | 部分 | 迁移期保持 Desktop 实现；Host 侧只返回空态 |

## 三条最终验收

| 验收 | 状态 | 证据 |
|---|---|---|
| 关掉浏览器后 Host 仍运行 | 已验证 | Host 为独立 Node 进程由 `cindy-host.service` 托管，关闭页面后 `/health` 持续可用 |
| 重开浏览器恢复会话 | 已验证 | 刷新/新标签页后恢复同一轮问答，与桌面端共享 192 条存量任务 |
| Electron 不参与 Runtime | 已达成 | Desktop 客户端模式接管所有共享通道，`getMaker()` 抛错，`localDb.ensureReady` 阻断写库，`fuser -v` 证明仅 Host 持有 SQLite 锁 |

## 最终审计（当前状态）

| 验收 | 结论 | 直接证据 |
|---|---|---|
| 关掉浏览器后 Host 仍运行 | 通过 | Host 为独立 Node 进程；关闭页面后 `/health` 持续 `runtime.state=ready` |
| 重开浏览器恢复会话 | 通过 | 刷新/新标签页后同一轮问答从共用 DB 恢复，存量 192 条会话完整 |
| Electron 不参与 Runtime | **已达成（客户端模式）** | 本机有 Host 时 Desktop 自动进入客户端模式：`getMaker()` 结构性抛错、共享契约通道全由 Host 提供、单写者认证刷新、仅 Host 持有 SQLite 库，全程 0 error |

### 生产切换与存量保护达成记录

- **真实 profile 验证**：在 Debian Linux 生产环境下，通过 systemd 成功将真实 profile (`~/.config/CindyGlobal`) 切换为由 `cindy-host.service` 常驻接管。
- **存量无损**：192 条存量任务与完整消息平滑迁移至 seq 129，冷备份已归档。
- **两端无缝**：Web 端（`http://127.0.0.1:3456/`）与桌面端（Wayland 客户端模式窗口）实时双向同步会话、消息、外观与布局设置。
