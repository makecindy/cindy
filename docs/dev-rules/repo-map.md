# 仓库地图（Repo Map）

> **读取时机**：首次接触本仓、需要定位某个功能的代码位置、或新增代码／依赖前判断
> 应该放进哪个模块时

本文只做**定位导航**：每个目录一句话说明"它是干什么的、谁在用它"。事实源是各目录
的 `package.json` 与 README；发现本文与代码不一致时，以代码为准并顺手修正本文。
依赖方向与解耦约束见 [`architecture-invariants.md`](architecture-invariants.md)。

## 顶层结构

| 路径 | 说明 |
|---|---|
| `apps/` | 终端产品（desktop、mobile）与随包分发的二进制资产 |
| `packages/` | 客户端共享能力包（与 render／main 解耦，详见下表） |
| `config/` | 运行期端点清单（`endpoint.json` / `endpoint.dev.json` / `endpoint.global.json`：auth、device-link 等线上 base URL） |
| `scripts/` | 仓库级工程脚本：dev 启动包装、agent 二进制拉取（`ensure-agent-binaries.mjs`）、i18n／endpoint／文档等校验 guard、worktree 管理 |
| `tools/` | claude／codex／ripgrep／pi 四个 Desktop runtime 的版本 pin（`latest.json`）与更新器（`update.mjs`） |
| `docs/` | 规则文档：`dev-rules/`（工程）、`product-rules/`（产品）、`design-rules/`（设计入口）、`legal/` 等 |

## apps/

| 路径 | 说明 |
|---|---|
| `apps/desktop` | Cindy 桌面客户端（Electron + Vite），源码分 `main/`（主进程：业务逻辑、maker-host／maker-ipc、localDb、device-link、mcp-integrations、cindy-brain 等）、`renderer/`（纯渲染 UI：features、panels、themes、i18n 等）、`preload/`（最小桥接层）、`shared/`（主／渲染共享类型与常量）；SQLite migration 在 `apps/desktop/drizzle/` |
| `apps/mobile` | Cindy 手机客户端（Expo / React Native）：同账号登录、发现并远程控制桌面设备、镜像会话 |
| `apps/claude-code-bin`、`apps/codex-bin`、`apps/ripgrep-bin` | 随桌面端分发的预编译 CLI 二进制（按平台分目录）。不是构建包、不进 git 历史；版本由 `tools/<kind>/latest.json` pin，`pnpm install` postinstall 按需下载 |
| `apps/android-platform-tools-bin` | Android platform-tools（adb 等）二进制，当前仅 win32-x64，用于连接安卓设备 |

## packages/

「主要使用方」按各 `package.json` 的 workspace 依赖核对；mobile 只直接依赖其中
5 个（auth-client、device-link、maker-shared、model-providers、voice-input-core）。

| 包 | 一句话用途 | 主要使用方 |
|---|---|---|
| `maker-core` | Cindy 核心：agent 抽象（BaseAgent）、session 编排与事件流，零 Electron 依赖；改动前必读 [`maker-core-and-agent-behavior.md`](maker-core-and-agent-behavior.md) | desktop、lizi-mcps、orca-workflow |
| `maker-shared` | 桌面与手机共享的展示层契约模型，零 React／Electron／Expo 依赖 | desktop + mobile |
| `maker-cc-manager` | cc-remote：跑在远程 SSH 机器上的 NDJSON RPC 守护进程，封装 Claude Agent SDK，向本地桌面暴露多会话／detach-reattach 能力 | desktop（remote-ssh） |
| `maker-remote-ssh` | SSH remote：连接池、`~/.ssh/config` 读写、凭据解析，零 Electron 依赖 | desktop |
| `maker-scheduler` | 定时任务：cron 引擎 + storage／runner／notifier 接口 | desktop、lizi-mcps |
| `orca-workflow` | Orca 多 worker 协同的 lead 侧：MCP 桥接 + lead prompt；改动前必读 [`orca-team-architecture.md`](orca-team-architecture.md) | desktop |
| `device-link` | 跨设备远程控制（同账号互联）：envelope 协议、IPC 隧道 allowlist、重连／心跳；零依赖，WS 实现由 host 注入 | desktop + mobile |
| `auth-client` | 平台无关的 Cindy auth-server 客户端契约（zod） | desktop + mobile |
| `model-providers` | 模型供应商目录 + 路由抽象（Anthropic／OpenAI／XD），纯逻辑 | desktop + mobile |
| `anthropic-compat-proxy` | 本地回环 HTTP 代理：剥离 Anthropic 专有字段，让 Claude Code SDK 可经网关访问非 Anthropic 后端 | desktop |
| `anthropic-responses-bridge` | 挂载在 `anthropic-compat-proxy` 回环 HTTP 代理内部的进程内协议转换处理器：作为 `RoutingDecision.localHandler` 完成 Anthropic Messages API ↔ OpenAI Responses API 转换 | desktop |
| `responses-anthropic-bridge` | 本地 Responses → Anthropic Messages 桥：请求、图片／工具／thinking 转换与 Responses SSE 回译 | desktop |
| `lizi-mcps` | 可复用 MCP server 集合（Google 套件、GitHub／GitLab、浏览器、scheduler 等） | desktop |
| `cindy-tools` | 意识（Ghost）系统内部工具集（MCP），含 ghost 总机（`ghost_list` / `ghost_info` / `ghost_call`） | desktop |
| `browser-control-runtime` | 浏览器自动化运行时适配层（playwright-core + MCP） | desktop、lizi-mcps |
| `file-browser-core` | 文件浏览核心：workdir 扫描、ignore 匹配、ripgrep 搜索；本地后端与远程守护进程共享 | desktop、remote-file-service |
| `remote-file-service` | 远程文件服务：跑在远程 SSH 机器上的 NDJSON RPC 守护进程，封装 file-browser-core | desktop |
| `github-client` / `gitlab-client` | GitHub REST v3 ／ GitLab REST v4 客户端，零运行时依赖 | desktop／lizi-mcps |
| `embedding-client` | OpenAI `/v1/embeddings` 兼容客户端（走网关） | desktop |
| `heartbeat-client` | 在线心跳：周期上报维持在线状态，零依赖 | desktop |
| `lizi-im` | IM 传输层（飞书等 WS 通道）：凭据存储、附件下载、统一发送 API；host 注入适配 | desktop |
| `project-context` | agent 维护的项目知识层（commit 驱动的 markdown CLI） | desktop（maker-ipc） |
| `voice-input-core` | 语音输入核心：供应商无关的听写状态机与润色守卫 | desktop + mobile |
