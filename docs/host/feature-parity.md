# Cindy Host 功能保留清单（阶段 7 台账）

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
| Codex harness | 部分 | 已注册并返回真实能力描述；未跑通真实回合 |
| 模型目录 / 选择器 | 已验证 | 单一 `xd` provider，28 个网关对话模型，双 harness routing；选择器可展开并选中 |
| 能力描述 | 已验证 | `/api/capabilities` 与 provider 模型列表逐项一致 |
| 斜杠命令 / 技能 | 部分 | `maker.listAgentCommands` / `listAgentSkills` 转真实 agent 实现；未在界面验证 |
| 多 Agent / 伙伴 / 群聊 | 禁用 + TODO | 依赖 bot 相关通道，当前返回明确的空态；未验证行为一致 |
| 插件执行（运行期） | 禁用 + TODO | 插件运行时仍在 Electron main；Host 侧只提供已装列表 |

## 平台与集成

| 能力 | 状态 | 证据 / 缺口 |
|---|---|---|
| 本地模式（无账号） | 部分 | 登录页可进入本地模式（`authGetLoginState`/`authEnterLocal` 已实现），但随后停在 “Waking Cindy…” 启动门；Host 侧尚无本地 owner 命名空间 |
| 复用现有登录 | 部分 | 登录入口真实可达（含 PKCE/托管回调），重启后 `authenticated:true` 复用现有会话（`evidence/stage2-login.md`）；**真实浏览器完成一次授权未验证**（需要用户本人凭证） |
| 复用现有存储 | 已验证 | 打开同一 owner 库（145 条 migration / 87 表），无平行数据库 |
| 单 Runtime 锁 | 已验证 | 第二个 Host 报 `runtime.state=blocked`、`storage=unopened` |
| 插件列表 | 已验证（读） | Host 复用 Desktop `GhostManager` 列出已装插件（`/api/ghosts`，单测 + 实跑 `[]`）；`#/plugins` 页明暗两种模式正常；插件**执行**未迁移 |
| Memory / 文件访问 | 禁用 + TODO | 未验证 |
| systemd user unit | 已验证（模板） | `apps/host/cindy-host.service`，`systemd-analyze verify` 通过；未在本机 enable/start |
| Tray / 原生菜单 / 窗口特效 / 桌面快捷键 | 禁用 + TODO | Electron 专属；浏览器端不提供，需在 `cindy-desktop` 保留 |
| Device Link / 手机端 | 部分 | 迁移期保持 Desktop 实现；Host 侧只返回空态 |

## 三条最终验收

| 验收 | 状态 | 证据 |
|---|---|---|
| 关掉浏览器后 Host 仍运行 | 已验证 | Host 为独立 Node 进程，关闭页面后 `/health` 持续可用 |
| 重开浏览器恢复会话 | 已验证 | 刷新/新标签页后恢复同一轮问答（`evidence/stage4-e2e.md`） |
| Electron 不参与 Runtime | 未达成 | Desktop 仍装载 Runtime；共享 API 未接入 |

## 最终审计（当前状态）

| 验收 | 结论 | 直接证据 |
|---|---|---|
| 关掉浏览器后 Host 仍运行 | 通过 | Host 为独立 Node 进程；关闭页面后 `/health` 持续 `runtime.state=ready` |
| 重开浏览器恢复会话 | 通过 | 刷新/新标签页后同一轮问答从共用 DB 恢复（`evidence/stage4-e2e.md`） |
| Electron 不参与 Runtime | **已验证（客户端模式）** | 本机有 Host 时 Desktop 自动进入客户端模式：`getMaker()` 结构性抛错、21 条通道由 Host 提供、42 次重复注册被挡下、全程 0 error；Host 未运行时回退内嵌 Runtime（自动拉起 Host 仍为 TODO） |

### 阶段 5（Electron 去核心化）的未完成清单

- `bootstrap-electron.ts` 仍在 splash 后调用 `getMakerCore()` 并注册整套 `maker:*` IPC。
- 插件运行时、scheduler、device-link、Orca 协同仍依赖进程内 Runtime。
- 迁移方案：先用 runtime 租约保证同一 profile 只有一个 Runtime（Host 侧已完成），再把
  `maker:*` / `local-db:*` handler 逐组替换为 Host HTTP 客户端（会话、消息、输入队列、
  事件流已具备对应端点），最后删除 Desktop 内的 Runtime 装配。

在完成上述迁移前，不把「Electron 不参与 Runtime」标为达成。
