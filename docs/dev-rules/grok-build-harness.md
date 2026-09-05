# Grok harness 集成规则

> 修改 `packages/maker-core/src/agents/grok-build/**`、`apps/desktop/src/main/maker-host/grok-build-host.ts`，
> 或任何 Grok 会话行为、权限、探测之前必读本文件。

## 0. 产品方向（2026-09 调整）

Cindy 要的 harness 是和 Claude Code 同级的一等公民，不是一条独立 ACP 对话通道。
换到 Grok 必须仍能用 Cindy 的模型面 / 账号与计费、MCP / Orca / Ghost、以及
fork / rewind / steer / plan。纯 `grok agent stdio` 做不到这些，本 PR 按这个方向改。

Grok 是 **harness**（和 Claude Code / Codex / Pi 一样），不是模型分类、也不是目录里的一行「Grok Build」。

## 1. 架构总览

目标形态对齐 Claude Code：Cindy 持有会话与工具面，模型走 Cindy 已连接的 xAI / SuperGrok
（或网关）路由，而不是再走一份 grok CLI 自己的登录态。

`GrokBuildAgent` 是 Cindy hosted loop（与 Pi 同一执行面）上的第四个 harness：
`kind = 'grok-build'`，模型只投影独占 Grok catalog slug，MCP / Orca / Ghost /
rewind / fork / plan 与 Pi 同源。仓库里仍保留 ACP client 文件，但 **host 不再
spawn `grok agent stdio`**，也不再把 PATH 上的 `grok` 当作注册条件。

关键装配点：

- **探测 / 注册**：Cindy Pi runtime 可用才注册。`grok` CLI 不在 PATH 不影响。
- **Auth**：Cindy `desktopPiAuthAdapter`（SuperGrok OAuth / 网关 key）。禁止
  `grok login`，禁止读 `~/.grok/auth.json`。
- **模型**：`deriveGrokBuildAvailableModels` 从目录投影独占 Grok slug。
- **会话家目录**：`grok-build-agent-home`，与 `pi-agent-home` 分开。

## 2. 维护不变量

1. **权限档从严到宽**：`capabilities.permissionModes` 必须
   `[ask, auto, bypassPermissions]`，`[0]` 是最严档。由
   `grok-build-capabilities.test.ts` 守。
2. **缺失 Cindy hosted loop 不得影响其它 harness**：CC / Codex / Pi 的注册保持原样。
3. **UI vendor 是 `'grok-build'`**，不要用 `'grok'`（与 xAI catalog provider 撞名）。
4. **模型面**：独占 Grok catalog slug（`grok-*` / `xai/grok-*`）。不要再注入
   `id: grok-build` 这种假模型行。
5. **就绪态**：Cindy SuperGrok / 网关已连接即可。不要再 spawn `grok login`。

## 3. 非目标（本阶段不做）

- CDN 钉死独立 grok CLI
- 移动端完整会话（只加类型与 `listAvailableAgents` 过滤）
- 嵌入 Grok TUI；one-shot `grok -p`
- 继续加深 ACP client（文件可留，host 不再调用）
