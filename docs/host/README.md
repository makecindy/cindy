# Cindy Host

把 Cindy 从「Electron 优先的桌面应用」拆成两个独立产品：

- **`cindy-host`**：后台常驻服务，持有 Runtime、Session、OAuth、插件与本地存储。
- **客户端**：浏览器（现有 renderer 复用）与 Electron（可选外壳），都只通过同一套 HTTP/SSE API 使用 Host。

## 文档

| 文档 | 内容 |
|---|---|
| [architecture-and-status.md](architecture-and-status.md) | 模块耦合分析、Host 入口、阶段进度 |
| [feature-parity.md](feature-parity.md) | 逐项功能状态（已验证 / 部分 / 禁用+TODO）与最终审计 |
| [electron-client-mode.md](electron-client-mode.md) | Electron 以客户端模式运行：通道代理表、安全边界、未迁移清单 |
| [systemd.md](systemd.md) | user unit 安装与运维 |
| [maker-assembly-extraction-plan.md](maker-assembly-extraction-plan.md) | Runtime 装配抽离计划 |
| [evidence/](evidence) | 脱敏的端到端证据（阶段 2 / 阶段 4） |

## 快速开始

```bash
# 1) 启动 Host（首次可用 login 子命令复用现有 OAuth）
CINDY_HOST_DATA_DIR=<profile> CINDY_HOST_OWNER=<owner> pnpm start-host
#   单独登录：
node --import tsx --import ./apps/host/src/loaders/register-raw.mjs apps/host/src/main.ts login --method=google

# 2) 浏览器客户端（Host 直接托管现有 renderer 构建产物）
pnpm --filter desktop exec vite build --config vite.renderer.config.ts
open http://127.0.0.1:3456/

# 3) Electron 作为客户端（可选）
CINDY_HOST_API=http://127.0.0.1:3456 pnpm --filter desktop dev
```

## 当前边界

- Host 只监听 `127.0.0.1`，所有数据接口要求 profile bearer 或本机 cookie。
- 浏览器客户端已通过真实 Agent 的完整回合验证（发送 → 流式 → 停止 → 刷新恢复 → 权限确认）。
- Electron 客户端模式覆盖任务、消息、供应商、能力、Agent 命令/技能、输入队列、交互与告警；
  插件执行、MCP、scheduler、device-link、记忆/文件工具仍由 Desktop Runtime 承担（见上表 TODO）。

## 验证

```bash
pnpm --filter @cindy/host test          # Host 单元/集成测试
npx vitest run src/main/__tests__/hostDelegation.test.ts   # 客户端代理
pnpm --filter desktop run typecheck
```
