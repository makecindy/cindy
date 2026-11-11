# Maker 装配抽取计划（Agent Runtime 前置）

目标：让 Desktop 与 `cindy-host` 使用**同一份** Maker 装配代码，而不是在 Host 里再写一个精简 Maker（#137 禁止第二套 Runtime）。

## 现状测量（2026-11-04）

以 `apps/desktop/src/main/maker-host/index.ts` 为起点做 import 图 BFS（相对路径 + 直接包名，6 跳上限）：

- 直接依赖 177 个，其中 **118 个在 6 跳内可达 `electron`**；
- **36 个直接 `import 'electron'`**。

进度（2026-11-04，五个切片后）：可达数 **118 → 114**；已迁移 10 个模块（Maker Memory 装配、profile 根、5 个设置存储、2 个装配设置存储、插件注册表偏好、Memory 设置）。数量下降慢是因为剩余可达路径大多经由 `authManager`/`cindy-brain`/`device-link` 这类大型服务，而不是零散 store。

直接 Electron 依赖按职责分组：

| 组 | 模块 | 装配需要的替代端口 |
| --- | --- | --- |
| 账号与凭据 | `authManager`、`appSessionState`、`maker-host/auth-adapters`、`codex-account-auth` | 当前 owner、access token、agent 凭证适配器（Claude/Codex/Pi） |
| 二进制与工具链 | `agent-binaries/index`、`codex-cli-launcher` | 已校验的二进制路径（Host 已有 `binaryStatus`） |
| 插件/意识 | `cindy-brain/index`、`maker-ipc/register`、`maker-ipc/botSkillService` | 插件注册表、MCP provider 列表、插件工具审批 |
| 设备与远程 | `device-link/*`、`remote-ssh/*`、`maker-ipc/orcaRemoteWorkerBridge` | 远程调用/设备目录（Host 先可返回未配置） |
| 媒体与附件 | `cindy-media/blobStore`、`maker-ipc/normalizeAttachments`、`reviewer/reviewPdfProcess` | 附件落盘与读取（Host 可先用同一 userData） |
| 模型与供应商 | `createDesktopProviderService`、`model-discovery/*`、`runtime-configs`、`outbound-proxy-resolver` | 目录快照、路由解析、出站代理 |
| 宿主交互 | `i18n`、`local-agent/service`、`agent-app-update/*`、`maker-ipc/interactionRouter` | 交互请求（Host 走 API/SSE 或明确拒绝） |

## 抽取顺序（每步都可独立 typecheck + 定向测试）

1. **端口定义**：新增 `packages/maker-assembly`（零 Electron），定义 `MakerAssemblyHost` 接口，字段就是上表右列。
2. **纯模块上移**：把已经是纯逻辑的部分（`session-storage` 的映射、`context budget`、`model-*` store 等）作为 assembly 的直接依赖，`Desktop` 只保留 Electron 适配。
3. **Agent 构造**：把 `ClaudeCodeAgent`/`CodexAgent`/`PiAgent` 的构造与 MCP/技能/权限装配移入 assembly，参数改为端口。
4. **Desktop 适配**：`getMaker()` 变为「构造端口实现 → 调 assembly」，行为不变（用 maker-host 现有 4,000+ 单测兜底）。
5. **Host 适配**：实现同一端口的 Node 版本；未实现的能力显式返回 `unsupported`，不得静默降级。
6. **收敛**：删除 `getMaker()` 内已迁走的代码，确保只有一份装配。

## 已完成的第一刀

`packages/maker-core/src/memory/host-factory.ts`：把 Maker Memory 的宿主装配（owner 根解析、boundary fail-closed、ownerScopeKey、换根重读 enabled、Bot Home override）从 Desktop 适配器中移入 maker-core，Desktop 的 `maker-memory-host.ts` 只保留 Electron 端口。Desktop typecheck 通过，邻近 maker-host 测试 21/21 通过。

## 第二个切片

`apps/desktop/src/main/userDataPath.ts`：profile 根改由启动时注入（Desktop 在 `index.ts` 安装 Electron 值），`agent-resource-settings-store` 不再 import `electron`。测试改为 `configureUserDataDir()`，7/7 通过；Desktop typecheck 通过。

## 第三个切片

`apps/desktop/src/main/ownerContext.ts`：owner 根解析与 generation 从 `appSessionState`（Electron）抽成可注入上下文；`appSessionState` 反向委托给它。五个设置存储（`session-context-budget`、`model-context-limit`、`model-catalog-override`、`model-disable`、`compaction-settings`）不再 import `electron`，它们的测试改为 mock `ownerContext`。Desktop typecheck 通过；四个受影响测试 5+9+5+6 全过（`sessionContextBudgetStore` 中 1 例为基线既有失败）。

## 每步验证

- `pnpm --filter desktop run typecheck`（约 7 分钟，改动后必跑）。
- `pnpm --filter desktop exec vitest run src/main/maker-host/__tests__`（现有 4,000+ 用例）。
- Host 侧：`pnpm --filter @cindy/host test` + 实际启动 `/health` 观察 `runtime.state`。
- 阶段 5 前补一次真实会话回归（发送/流式/停止），否则不能宣称 Agent Runtime 已迁移。

## 重要约束：maker-core 只能按子路径导入

在 Host 中 `import ... from '@cindy/maker-core'` 会失败：barrel 会连带加载 `?raw` 形式的 markdown（如 `memory/system-prompt.md`），Node 无法解析该扩展。Host 侧必须使用子路径导出（如 `@cindy/maker-core/claude-cli-login-status`）。新增供 Host 使用的模块时，同时补 `exports` 子路径。

## 已完成：Claude CLI 登录态共享

`packages/maker-core/src/agents/claude-code/cli-login-status.ts` 承载 `auth status --json` 的解析与一次性 spawn 读取；Desktop 的 `claude-native-cli` 改为复用同一解析（27 个 CLI 测试覆盖），Host 已用真实二进制实测读通（本机返回 `loggedIn:false`）。

## 已完成：本机 CLI 使用许可绑定

`nativeProviderAuthBinding`（1,072 行）改走注入的 profile 根与 owner 上下文，不再 import `electron`；`hasClaudeNativeLogin` 因此可在 Host 侧成立。owner 上下文新增 `boundaryPending` 与 `activeDataOwnerId()` / `isOwnerBoundaryPending()`。

## 已知风险

- 装配体量约 2,300 行，闭包捕获大量模块级状态；必须整段迁移后一次 typecheck，不能半途提交。
- `getMaker()` 同时承担账号边界重建、插件注册表重置、Codex 重启序列等生命周期逻辑，迁移时要区分「装配」与「重建」。
- 本机无法直接跑 Desktop 图形界面回归；只能依赖 typecheck + 单测 + Host 侧真实启动，这一点必须在 PR 里如实说明。
