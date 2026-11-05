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
| `local-db:sessions:create` | `POST /api/sessions/create` |
| `local-db:messages:estimated-value` | `POST /api/messages/estimated-value` |
| `maker:input:remove` | `POST /api/input/remove` |
| `model-access:get-status` | `POST /api/model-access` |
| `maker:usage:model-pricing` / `-v2` / `reference-model-pricing` | `POST /api/usage/*` |
| `maker:model-visibility:legacy-owner-claim-sync` | `POST /api/model-visibility/claim`（启动时预取，同步回放） |
| `maker:send` | `POST /api/input/enqueue`（返回 `{accepted:true}`） |
| `maker:list-active` | `POST /api/sessions/list` |
| `maker:provider:list` | `POST /api/providers` |
| `maker:get-capabilities` | `POST /api/capabilities` |
| `maker:input:get-projection` / `enqueue` / `stop` / `steer` / `resume` | `POST /api/input/*` |
| 事件流 | `GET /events` → `maker:event` |

## 实测发现并修掉的问题

- 代理安装若早于 Desktop 自身的 `maker:*` 注册，会让后者抛 `Attempted to register a second handler`
  并**跳过其后所有注册**（remote-ssh、project-automation 等 handler 缺失）。已把代理安装
  移到注册之后。
- 原生绑定 ABI：为 Electron 安装的 `better-sqlite3` 会让同一进程树里的 Host 无法启动，
  反之亦然；这是验证环境限制，不是代码问题。

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
| `electron-forge start`（dev，`xvfb-run`） | 失败：主进程打包阶段 V8 堆上限 4GB OOM（本机内存受限），未进入应用启动 |
| 打包产物 `out/Cindy-linux-x64/Cindy`（`--no-sandbox --mock`） | 失败：打包缺 `sharp` 的 linux-x64 原生依赖（`libvips-cpp.so`），属既有打包问题 |
| `electron-forge start`（dev，8GB 堆，xvfb，修复原生依赖后） | **主进程成功以客户端模式启动**：日志出现 `client mode: delegating to http://127.0.0.1:3456` 与 `client mode proxies: …`（18 个通道），随后 renderer 通过代理读取任务/供应商/能力 |
| 全通道真机验收 | **未完成**：给 `apps/desktop/node_modules` 放一份 Electron ABI 绑定后，Host 与 Electron 可同时运行，客户端模式能读到任务/供应商/能力；但 renderer 的 `localCatalogSnapshot` 仍以 `code:UNKNOWN` 失败，模型选择器降级，未定位（浏览器端同一路径是通的） |
