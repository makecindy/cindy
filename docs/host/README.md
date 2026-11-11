# Cindy Host

当前先基于 PR #9246 提供主动启用的实验性基础网页版，让用户从浏览器操作 Host 上的基础任务。
普通桌面启动保持原状；不以完整迁移桌面功能为第一版前提。
当前范围与未完成验收见 [基础网页版](basic-web.md)，实际修复记录见 [本地完善与验收](pr-9246-completion.md)。
下一阶段目标已扩展为支持桌面、手机、网页及无图形 Linux 的共用后台，见
[完整无界面 Cindy 计划](headless-runtime-plan.md)；该目标尚未全部实现。

代码中的两个入口：

- **`cindy-host`**：按需启动的后台服务，提供任务、消息与模型调用等已接通的接口。
- **客户端**：浏览器复用现有 renderer，通过 HTTP/SSE API 使用 Host；Electron 连接 Host 是显式可选模式。

## 文档

| 文档 | 内容 |
|---|---|
| [headless-runtime-plan.md](headless-runtime-plan.md) | 当前架构目标、能力缺口、分批交付与完整无界面验收 |
| [architecture-and-status.md](architecture-and-status.md) | 原 PR 阶段的模块分析与实验记录；现状以基础网页版和当前计划为准 |
| [maintenance-plan.md](maintenance-plan.md) | PR #9246 合并后的维护计划与逐批验收边界 |
| [feature-parity.md](feature-parity.md) | 原 PR 阶段的逐项功能记录与审计，保留历史验证范围 |
| [electron-client-mode.md](electron-client-mode.md) | Electron 以客户端模式运行：通道代理表、安全边界、未迁移清单 |
| [systemd.md](systemd.md) | user unit 安装与运维 |
| [maker-assembly-extraction-plan.md](maker-assembly-extraction-plan.md) | Runtime 装配抽离计划 |
| [evidence/](evidence) | 脱敏的端到端证据（阶段 2 / 阶段 4） |

## 快速开始

本地基础版试用优先使用 `pnpm preview:host`，它固定使用独立测试目录并自动打开浏览器。
首次登录与验收情况见 [本机试用](basic-web.md#本机试用2026-11-07)。下面是底层 Host 命令。

```bash
# 1) 启动 Host（首次可用 login 子命令复用现有 OAuth）
CINDY_HOST_DATA_DIR=<profile> CINDY_HOST_OWNER=<owner> pnpm start-host
#   单独登录：
node --import tsx --import ./apps/host/src/loaders/register-raw.mjs apps/host/src/main.ts login --method=google

# 登录状态（脱敏，只输出 authenticated / realm）
node --import tsx --import ./apps/host/src/loaders/register-raw.mjs apps/host/src/main.ts status --json

# 2) 浏览器客户端（Host 直接托管现有 renderer 构建产物）
pnpm --filter desktop exec vite build --config vite.renderer.config.ts
pnpm host:open

# 注意：渲染产物 apps/desktop/.vite/renderer/main_window 会被 Desktop 构建清理；
# Host 每收到请求时才解析该目录，重建后无需重启 Host。`pnpm dev:host` 会先补建它。

# 3) 显式选择 Electron 客户端模式：脚本复用已有 Host，没有则先拉起
pnpm dev:host -- --mock
#    也可以显式指定目标：
CINDY_HOST_API=http://127.0.0.1:3456 pnpm --filter desktop dev
```

## 当前边界

- Host 只监听 `127.0.0.1`，所有数据接口要求 profile bearer 或本机 cookie。
- 当前已完成 macOS 上真实文本任务、刷新、停止、允许一次、Host 重启续接与受控事件断线恢复；
  手机、三平台实机与真实网络切换仍待验收，见 [本地人工验收](basic-web.md#本地人工验收2026-11-10)。
- Electron 客户端模式覆盖任务、消息、供应商、能力、Agent 命令/技能、输入队列、交互与告警；
  插件执行、MCP、scheduler、device-link、记忆/文件工具仍由 Desktop Runtime 承担（见上表 TODO）。

## 验证

```bash
pnpm --filter @cindy/host test          # Host 单元/集成测试
npx vitest run src/main/__tests__/hostDelegation.test.ts   # 客户端代理
pnpm --filter desktop run typecheck
```
