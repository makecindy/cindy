# 阶段 4 端到端证据（脱敏）

环境：本机 `cindy-host`（`127.0.0.1:3456`）托管现有 renderer 的真实构建产物，
headless Chromium，临时 profile（owner 已绑定，共用同一 SQLite）。以下内容不含
cookie / token / API key / 账号标识 / 私有绝对路径。

## 1. 任务列表与打开任务

- `localDb.sessions.list()` 返回共用库中的任务数组（实测 13 条，其后持续增长）。
- `#/cc-agent/<id>` 正常渲染：标题、消息区、输入框、右栏面板均在位（此前该路由抛
  React #185，根因是 shim 每次属性访问新建 Proxy 导致外部 store 无限重订阅）。

## 2. 发送 → 流式 → 停止

用户输入 `Reply with exactly: FINAL OK` 后：

- 事件流依次收到 `status` → `session_id` → `text` → `done`；
- 界面出现用户气泡与助手回复 `FINAL OK`；
- 另一轮 `Write a 2000 word essay…` 在生成中点 **Stop generating** 后
  `input.getProjection().turnInProgress === false`，用户消息保留在库中。

## 3. 重开浏览器恢复会话

同一任务在新标签页打开（等效关页重开）：

```
#/cc-agent/0e6dd8eb-…
Untitled session
Reply with exactly: RESTORE OK   3 minutes ago
RESTORE OK                       2 minutes ago
```

刷新同一页面后同样恢复：

```
#/cc-agent/1a95600d-…
Reply with exactly: FINAL OK   just now
FINAL OK                       just now
```

数据来源：Host 在回合进行中把 user / assistant 行写入共用 `messages` 表，
`historyView` 用共享投影器（`@cindy/maker-shared/message-window`）生成页面，刷新后由
同一条路径读回。

## 4. 命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm --filter @cindy/host test` | 35/35 |
| `pnpm --filter desktop run typecheck` | exit 0 |
| `GET /health` | `runtime.state=ready`，`agents=["claude-code","codex"]` |
| `POST /api/input/enqueue` → `/events` | `text`("QUEUE OK") → `done` |


## 5. 权限确认（真实回合）

`permissionMode=ask` + “创建文件并回复 DONE”：

```
事件：status → tool_use? → interaction_request → interaction_dismissed → tool_result_full → text → done
应答：POST /api/interactions/respond → 200
结果：/tmp 目标文件内容为 OK，最终回复 DONE
```

说明 Host 的交互 broker 在真实 Agent 回合中可用（发布请求、接收应答、继续执行）。

## 6. Electron 客户端模式（验收 ③）

Host 运行中、**不设置任何环境变量**启动 dev Electron：

```
[bootstrap-electron] client mode requested at startup
[bootstrap-electron] client mode: delegating to http://127.0.0.1:3456
[bootstrap-electron] client mode proxies: local-db:sessions:list, …（21 条）
[bootstrap-electron] client mode keeps the host handler for …（42 次重复注册被挡下）
```

- 全程 0 个 `ERROR`/`FATAL`；窗口创建成功（`main-window-created t+7495ms`）。
- 退出阶段唯一相关日志：`maker.shutdown failed (or not ready): cindy-host owns the runtime; this process is a client`
  —— 反向证明本进程从未装配 Runtime。
- 发现机制：Host 启动时写 `<dataDir>/host-endpoint.json`（pid + loopback URL），Desktop 校验 pid
  存活后自动接管；`CINDY_HOST_API` 仍可显式指定。
- 已知回退：Host 未运行时 Desktop 仍用内嵌 Runtime（自动拉起 Host 为 TODO）。
