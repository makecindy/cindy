# Electron 客户端模式（阶段 5 进行中）

设置 `CINDY_HOST_API` 后，Desktop 不再装配自己的 Runtime，而是把已迁移的 renderer
通道转发到 `cindy-host`，并把宿主的事件流回灌到同一 push 通道。

```bash
# 1) 先让 host 持有该 profile（同一 userData）
CINDY_HOST_DATA_DIR=<profile> CINDY_HOST_OWNER=<owner> pnpm start-host
# 2) Desktop 以客户端模式启动
CINDY_HOST_API=http://127.0.0.1:3456 pnpm --filter desktop dev
```

启动日志会打印 `client mode: delegating to …` 与已接管通道列表。

## 已代理通道

| Renderer 通道 | Host 端点 |
|---|---|
| `local-db:sessions:list` | `POST /api/sessions/list` |
| `local-db:sessions:get` | `POST /api/sessions/get` |
| `local-db:messages:list` | `POST /api/messages/list` |
| `local-db:messages:view` | `POST /api/messages/history-view` |
| `local-db:messages:create` | `POST /api/messages/create` |
| `maker:provider:list` | `POST /api/providers` |
| `maker:get-capabilities` | `POST /api/capabilities` |
| `maker:input:get-projection` / `enqueue` / `stop` / `steer` / `resume` | `POST /api/input/*` |
| 事件流 | `GET /events` → `maker:event` |

## 安全边界

- 只接受 loopback（`127.0.0.1` / `localhost` / `::1`）目标；非 loopback 直接拒绝启动，
  避免把 profile token 发到机器外。
- 凭据取自 `<userData>/host-api-token`（Host 首次启动生成，0600）；缺失时拒绝启动。

## 明确未迁移（客户端模式下会显式失败）

`maker:send`、`maker:list-active`、中断/告警、MCP、插件执行、scheduler、device-link、
Orca 协同、记忆与文件工具等仍由 Desktop 内 Runtime 提供；客户端模式下调用这些通道会
返回 `UNSUPPORTED_CAPABILITY: cindy-host owns this profile; this channel is not proxied yet`，
不会静默回落到第二套 Runtime。

在把这些通道全部改为 Host API 之前，「Electron 不参与 Runtime」不视为达成。

## 验证

| 证据 | 结果 |
|---|---|
| `npx vitest run src/main/__tests__/hostDelegation.test.ts` | 7/7 |
| `pnpm --filter desktop run typecheck` | exit 0 |
| 真实 Electron 启动（`xvfb-run` + `XDT_USER_DATA_DIR` 指向 host profile） | 失败：Electron 启动阶段 `node::OOMErrorHandler` + 一个 Go 二进制报 `all goroutines are asleep - deadlock!`，与本次改动无关；需要交互式桌面环境复验 |
