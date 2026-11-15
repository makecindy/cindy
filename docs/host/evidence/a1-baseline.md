# A1 · S0 基线（静态部分，2026-11-06）

方法：从 `apps/desktop/src/preload/` 提取全部 `ipcRenderer.invoke/sendSync` 通道名，与
`host-delegation.ts` 的 `PROXIED_CHANNELS`、`apps/web/shim.js` 的 `routes` 对比。
命令可复现：

```bash
cd apps/desktop/src
grep -rhoE "ipcRenderer\.(invoke|sendSync)\(\s*['\"][a-zA-Z0-9:_-]+['\"]" preload \
  | sed -E "s/.*['\"]([^'\"]+)['\"]/\1/" | sort -u
```

## 数字

| 项 | 数量 |
|---|---|
| preload 暴露的 invoke/sendSync 通道（去重） | 1143 |
| 桌面客户端模式已代理（`PROXIED_CHANNELS`） | 31 |
| 其中确实对应 preload 通道 | 29 |
| 网页 shim `routes` 条目 | 约 140 |

最大的几组：`maker` 441、`local-db` 102、`ghosts` 61、`voice-input` 50、`skillhub` 42、
`device-link` 26、`auth` 20、`appearance-settings` 8。

## 已确认的问题

### P1 `ensure-ready` 在桌面客户端模式下确定会失败（R5 坐实）

`local-db:ensure-ready` 不在代理列表，而 `registerLocalDbIpc` 在客户端模式下照常注册它；
它调用的 `ensureReady` 在 `isHostClientMode()` 时直接返回
`{ready:false, DB_INIT_FAILED}`。渲染层 `LocalDbGate` 会调这个通道，因此客户端模式的桌面端
启动门会失败。此结论来自读代码，运行时表现留到 S0b 确认。

### P2 设置类通道完全没有代理（R4 坐实）

以下通道在桌面端仍由本地主进程直接读写本地文件，Host 并不知情：
`appearance-settings:*`（8）、`layout:*`、`sidebar-settings:*`、`auth:*`（20，含
`auth:initialize`、`auth:refresh`、`auth:logout`）。同时 Host 也写这些文件。
两端是"各写各的文件"，不是同步。

### P3 一个已代理的通道名是死的

代理表里有 `local-db:messages:estimated-value`，但 preload 实际调用的是
`local-db:messages:estimatedSessionValue`（`preload.ts:6282`，handler 在
`localDb/ipc/messages.ts:672`）。所以桌面端该调用仍走本地 handler，客户端模式下读不到库。
S2 的契约表要避免这类名字手写偏差。

### P4 `local-db` 下未代理、首屏会用到的通道

`project-aliases:list/set/delete`、`recent-workdirs:list/remove`、`right-sidebar-tabs:*`、
`sessions:get-many`、`sessions:touchUserSend`、`sessions:restore-if-archived`、
`messages:around`、`messages:work-details`、`messages:updateContent`、`task-tags:execute`、
`conversations:search`、`bots:*`（约 50 条）、`orca-workflows:*`、`subagent-runs:*`。
其中 `project-aliases:list`、`recent-workdirs:list` 等 Host 已有或易补，是 S3 的优先项；
`bots:*`、`orca-workflows:*` 属伙伴/多 Agent，按计划标 `unsupported`。

### P5 网页 shim 中返回写死空值的通道（会造成与桌面内容不一致）

`maker.listActive`、`maker.listBotGroups`、`maker.botGroupOutbox`、
`maker.schedule.listSidebarIndexRuns`、`localDb.bots.list`、`localDb.bots.workbench.followScopes`、
`localDb.rightSidebarTabs.list`、`worktreeListAll`、`deviceLink.*`、`providerGroup.command`
（部分）、`ghosts.listPickerModels`、`pluginRuns` 等。S2 要把它们改成显式 `unsupported`，
S3 再按优先级逐个补真数据。

## 尚未完成：S0b 运行时实测

需要同时跑 Host 与 Electron dev，受 R6（`better-sqlite3` ABI 冲突）阻塞，因此排在 S1 之后。
S0b 要回答：P1 的实际表现、客户端模式桌面界面实际缺哪些东西。
