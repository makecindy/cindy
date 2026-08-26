# Grok Build harness 集成规则

> 修改 `packages/maker-core/src/agents/grok-build/**`、`apps/desktop/src/main/maker-host/grok-build-host.ts`，
> 或任何 Grok Build 会话行为、权限、探测之前必读本文件。

## 1. 架构总览

Grok Build 是 xAI 的终端 coding agent（`grok` CLI）。Cindy 把它作为第四个**可选 runtime**
（`AgentKind = 'grok-build'`），与 Claude Code / Codex / Pi 并列。协议是 ACP
（`grok agent stdio`，JSON-RPC 2.0 NDJSON），**不是** Pi RPC，也不是把 Grok 当模型
（`xai/grok-*` 仍走 CC/Codex/Pi）。

关键装配点：

- **探测**：只走 PATH 上的 `grok`。`buildGrokBuildAgent()` 在二进制缺失时返回 `null`，
  Maker agents map 不注册，选择器隐藏。**禁止**读 `~/.grok/auth.json`，禁止复用
  SuperGrok OAuth，禁止 CDN 二进制 CONFIG。
- **Spawn**：ask/auto → `grok agent stdio`；bypassPermissions →
  `grok agent --always-approve stdio` 且 `session/new._meta.yoloMode = true`。
  auto 档**不得**设 grok 的 `autoMode` —— Cindy Auto-review 拦截 ACP
  `session/request_permission`。
- **Auth**：ACP `initialize.authMethods` 为空 = 已登录；非空 = logged-out。
  `XAI_API_KEY` 也算已登录。`triggerLogin` spawn `grok login`；`logout` spawn
  `grok logout`。

## 2. 维护不变量

1. **权限档从严到宽**：`capabilities.permissionModes` 必须
   `[ask, auto, bypassPermissions]`，`[0]` 是最严档。由
   `grok-build-capabilities.test.ts` 守。
2. **缺失 grok 不得影响其它 harness**：CC / Codex / Pi 的注册、启动、选择器保持原样。
3. **UI vendor 是 `'grok-build'`**，不要用 `'grok'`（与 xAI catalog provider 撞名）。
4. **不要**把 grok-build 加进 `VALID_AGENTS` / `CUSTOM_PROVIDER_RUNTIME_AGENTS`
   （那些是把 Cindy 目录模型路由进 CC/Codex/Pi；grok-build 用自己的模型）。
5. **就绪态**：二进制 + grok 登录 / `XAI_API_KEY`。不要用
   `connectedProvidersForAgent(..., 'grok-build')`（目录不会列出 grok-build）。

## 3. 非目标（本阶段不做）

- CDN / cindy-binary-release 钉死 grok 版本
- 移动端完整会话（只加类型与 `listAvailableAgents` 过滤）
- 把 SuperGrok OAuth 当本 harness 的登录
- 嵌入 Grok TUI；one-shot `grok -p`
