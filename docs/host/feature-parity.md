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
| 流式回复呈现 | 部分 | SSE 与事件模型已验证；界面渲染被详情页崩溃阻断（见下） |
| 停止生成 | 禁用 + TODO | 需详情页可用后验证 `maker.stop` 通道 |
| 打开历史任务 / 恢复会话 | 禁用 + TODO | `#/cc-agent/<id>` 抛 React #185（Maximum update depth exceeded），组件栈指向 `ChatInput`；已排除全部 Host IPC 失败与模型目录形状 |
| 历史消息窗口 | 部分 | `localDb.messages.list` 返回数组；`historyView` 只对“确实没有消息”的任务返回真实空页，非空任务显式报 `history_view_not_implemented_on_host`（windowed reader 仍在 Electron IPC 内） |
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
| 多 Agent / 伙伴 / 群聊 | 禁用 + TODO | 依赖 bot 相关通道，当前返回空态 |

## 平台与集成

| 能力 | 状态 | 证据 / 缺口 |
|---|---|---|
| 复用现有登录 | 部分 | OSCrypt 双向实测通过；`cindy-host login` 单测通过；**真实浏览器完成一次授权未验证**（需要用户本人凭证） |
| 复用现有存储 | 已验证 | 打开同一 owner 库（145 条 migration / 87 表），无平行数据库 |
| 单 Runtime 锁 | 已验证 | 第二个 Host 报 `runtime.state=blocked`、`storage=unopened` |
| 插件列表 | 部分 | `GET /plugins` 列出 canonical 实例；插件执行未迁移 |
| Memory / 文件访问 | 禁用 + TODO | 未验证 |
| systemd user unit | 已验证（模板） | `apps/host/cindy-host.service`，`systemd-analyze verify` 通过；未在本机 enable/start |
| Tray / 原生菜单 / 窗口特效 / 桌面快捷键 | 禁用 + TODO | Electron 专属；浏览器端不提供，需在 `cindy-desktop` 保留 |
| Device Link / 手机端 | 部分 | 迁移期保持 Desktop 实现；Host 侧只返回空态 |

## 三条最终验收

| 验收 | 状态 | 证据 |
|---|---|---|
| 关掉浏览器后 Host 仍运行 | 已验证 | Host 为独立 Node 进程，关闭页面后 `/health` 持续可用 |
| 重开浏览器恢复会话 | 未达成 | 详情页渲染循环阻断 |
| Electron 不参与 Runtime | 未达成 | Desktop 仍装载 Runtime；共享 API 未接入 |
