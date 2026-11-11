# Electron 客户端模式（阶段 5 进行中）

默认 Desktop 不发现或自动接管 Host。只有显式设置 `CINDY_HOST_API` 才进入客户端模式；
`pnpm dev:host` 会验证并复用或启动 profile 的后台 Host，再为子窗口注入地址与
`CINDY_HOST_INSTANCE`。窗口或启动终端退出不停止后台。

本次后台生命周期、平台 RPC 与换窗合同见[窗口交接地基](client-handoff-foundation.md)。
整机迁移声明保持 `ready: false`，不能由窗口测试推断完整桌面功能已经迁移。

Host 也可不指定 owner：profile 内只有一个 `cindy-<owner>.db` 时自动采用该账号，
多账号 profile 会明确拒绝猜测（`CINDY_HOST_OWNER` 仍可显式指定）。

设置 `CINDY_HOST_API` 后，Desktop 不再装配自己的 Runtime，而是把已迁移的 renderer
通道转发到 `cindy-host`，并把宿主的事件流回灌到同一 push 通道。

```bash
# 1) 先让 host 持有该 profile（同一 userData）
CINDY_HOST_DATA_DIR=<profile> CINDY_HOST_OWNER=<owner> pnpm start-host
# 2) Desktop 以客户端模式启动
CINDY_HOST_API=http://127.0.0.1:3456 pnpm --filter desktop dev
# 上例兼容 HTTP/SSE，不启用平台 RPC；需电脑/浏览器执行时使用 pnpm dev:host。
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
| `local-db:sessions:update` | `POST /api/sessions/update`（title/status/pinnedAt/… 白名单） |
| `local-db:messages:estimated-value` | `POST /api/messages/estimated-value` |
| `maker:input:remove` | `POST /api/input/remove` |
| `model-access:get-status` | `POST /api/model-access` |
| `maker:usage:model-pricing` / `-v2` / `reference-model-pricing` | `POST /api/usage/*` |
| `maker:model-visibility:legacy-owner-claim-sync` | `POST /api/model-visibility/claim`（启动时预取，同步回放） |
| `maker:get-pending-interactions` / `maker:resolve-interaction` | `POST /api/interactions/*` |
| `ghosts:list`（同步，启动预取后回放） | `POST /api/ghosts`（复用 Desktop `GhostManager`，非第二套实现） |
| `maker:turn-change-sets:list` | `POST /api/turn-change-sets/list`（`store.ts` 已去掉 Electron 依赖，窗口广播改为注入） |
| `maker:list-available-agents` | `POST /api/agents` |
| `maker:list-agent-commands` | `POST /api/agent-commands` |
| `maker:list-agent-skills` | `POST /api/agent-skills` |
| `local-db:sessions:interrupted-pending` / `error-tail-pending` / `interrupted-resume-candidates` | `POST /api/sessions/*` |
| `maker:send` | `POST /api/input/enqueue`（返回 `{accepted:true}`） |
| `maker:list-active` | `POST /api/sessions/list` |
| `maker:provider:list` | `POST /api/providers` |
| `maker:get-capabilities` | `POST /api/capabilities` |
| `maker:input:get-projection` / `enqueue` / `stop` / `steer` / `resume` | `POST /api/input/*` |
| `recent-workdirs:list` | `POST /api/recent-workdirs/list` |
| `appearance-settings:read` / `write` | `POST /api/settings/appearance/*` |
| `layout:read` / `write` | `POST /api/settings/layout/*` |
| `app-shortcuts:read` / `write` | `POST /api/settings/shortcuts/*` |
| `local-db:project-aliases:list` / `set` / `delete` | `POST /api/project-aliases/*` |
| `auth:refresh` / `auth:get-state` | `POST /api/auth/*`（单写者令牌刷新） |
| 事件流 | `GET /events`（带序号断线重连补读） → `maker:event` 及各项设置/会话/消息广播 |

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

## 结构保证：客户端模式不会装配 Runtime

`getMaker()` 在客户端模式下直接抛错（`setMakerClientMode(true)`），因此任何懒加载路径
（scheduler、device-link、托盘忙碌探针、MCP 刷新等）都无法在本进程里构造 Runtime；
调用方原有的 try/catch 会把它们当作「无 runtime」处理。

## 插件列表

Host 直接复用 Desktop 的 `GhostManager`（同一实现），只注入 owner 作用域路径；市场账本、
命名空间迁移、常驻进程拉起等安全相关适配保持默认（fail closed）。Web 与 Electron 客户端的
插件列表都来自这里。

## 明确未迁移（客户端模式下会显式失败）

`maker:send`、`maker:list-active`、中断/告警、MCP、插件执行、scheduler、device-link、
Orca 协同、记忆与文件工具等仍由 Desktop 内 Runtime 提供，不会静默回落到第二套 Runtime。
客户端模式下没有处理者的 `maker:*` 通道返回
`UNSUPPORTED_CAPABILITY: Capability <通道> is not supported in host client mode`；其它前缀的
未接通道保持 Electron 原错误（`No handler registered`）。两类都会计数，每个通道首次出现时
记一行日志，退出时打印调用最多的 30 个。全量清单与真实使用排行见
[channel-coverage.md](channel-coverage.md)。

2026-11-12 之前，兜底只改写了 `_invokeHandlers.get()`，而 Electron 在 invoke 时先查
`has()`，所以 `maker:*` 实际上也只回 `No handler registered`；现已一并应答 `has()`，
并且不影响桌面之后注册的 `maker:*` 通道。

注意：本该留在窗口的通道里有 12 个在客户端模式下没有注册（`maker:computer:*` 10 个、
`maker:browser:*` 2 个），因为它们注册在客户端模式跳过的 `registerMakerIpcsAfterSplash` 里；
`update-relaunch:*` 两个同理，但它们问的是 Host 持有的运行状态。清单
（[channel-coverage.md](channel-coverage.md)）的「窗口类但客户端模式下未注册」列出全部，尚未修改。

在把这些通道全部改为 Host API 之前，「Electron 不参与 Runtime」不视为达成。

## 验证

| 证据 | 结果 |
|---|---|
| `vitest run src/main/__tests__/hostDelegation.test.ts` | 16/16 通过 |
| `pnpm --filter host test` | 52/52 通过 |
| `pnpm --filter maker-shared test` | 111 文件 / 2126 测试全数通过 |
| `pnpm check:test-hygiene` | PASS（356 files within baseline） |
| `pnpm check:dev-docs` | PASS |
| 生产环境实机切换验收（Debian Linux） | **已验证达成**：`cindy-host.service` 持有生产 profile（`~/.config/CindyGlobal`）排他 SQLite 锁并推至 seq 129；`cindy-desktop.service` 自动发现 endpoint 进入客户端模式，窗口在 Wayland 桌面稳定渲染，192 条存量任务与外观设置双向同步；`fuser -v` 验证唯一数据库写者为 Host 进程。 |
