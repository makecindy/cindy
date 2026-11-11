# Host 通道覆盖清单（脚本生成）

> 由 `node scripts/host-channel-coverage.mjs` 生成，不要手工修改。
> 源码提交：`c1246bb4bf`。分类规则在脚本的 `WINDOW_RULES` 与 `classify()` 里。

统计对象是桌面主进程（`apps/desktop/src/main`，不含测试）里所有 `ipcMain.handle/on`
及其包装函数注册的通道；同名通道按 invoke / event 各计一次。

| 分类 | 含义 | 通道数 |
|---|---|---:|
| contract | 已在 Host 通道合同里，窗口做客户端时转发给 Host | 61 |
| client | 客户端模式自己的通道（连接状态、重连） | 2 |
| window | 只属于窗口（窗口管理、菜单、对话框、剪贴板、本机输入设备等） | 362 |
| backend | 应由 Host 提供但还没接 | 1029 |
| 合计 | | 1454 |

转发适配器 2 处（把通道原样转给另一个注册表，通道已在调用处计入）：
`apps/desktop/src/main/maker-ipc/electronIpcRegistry.ts:14`、`apps/desktop/src/main/maker-ipc/register.ts:19339`

合同里有、但桌面主进程没有注册的通道 4 个（Host 独有或桌面已改名）：

`auth:get-state`、`maker:commit-provisional-session`、`maker:discard-provisional-session`、`plugin-market:list-installed`

## 实际调用到、Host 还没接的通道

来源：`docs/host/evidence/channel-usage-mock-tour.json`（UI fixture tour (pnpm restart:desktop:remote -- --mock --isolated=host-usage + apps/desktop/scripts/host-client-usage-tour.mjs)；embedded 模式，2026-11-11）。
这次共调用 253 个通道：contract 30、client 1、window 72、backend 150、清单外 0。下表只列 backend 与清单外的通道；embedded 模式按全部调用次数排序，client 模式按没有处理者的调用次数排序。

| # | 通道 | 调用次数 | 结果 | 模块 |
|---:|---|---:|---|---|
| 1 | `maker:list-desktop-commands` | 45 | 桌面本地处理 | maker-ipc |
| 2 | `device-link:list-devices` | 33 | 桌面本地处理 | device-link |
| 3 | `ghosts:session-focused` | 31 | 桌面本地处理 | cindy-brain |
| 4 | `maker:session-background-tasks:list` | 27 | 桌面本地处理 | maker-ipc |
| 5 | `sidebar-settings:load-snapshot-sync` | 21 | 桌面本地处理 | sidebarSettingsStore |
| 6 | `maker:bot-group:outbox-command` | 20 | 桌面本地处理 | maker-ipc |
| 7 | `device-link:get-state` | 19 | 桌面本地处理 | device-link |
| 8 | `learn:list-runs` | 19 | 桌面本地处理 | learn-host |
| 9 | `maker:plugins:get-state` | 19 | 桌面本地处理 | maker-ipc |
| 10 | `ghosts:ui-prompts` | 18 | 桌面本地处理 | cindy-brain |
| 11 | `maker:model-context-limit:get` | 18 | 桌面本地处理 | maker-ipc |
| 12 | `git-context:get-for-session` | 16 | 桌面本地处理 | git-context |
| 13 | `maker:get-context-window-bounds` | 16 | 桌面本地处理 | maker-ipc |
| 14 | `git-context:find-linked-worktree` | 15 | 桌面本地处理 | git-context |
| 15 | `maker:get-session-agent-switch-intent` | 15 | 桌面本地处理 | maker-ipc |
| 16 | `maker:side-chat:list:v1` | 15 | 桌面本地处理 | maker-ipc |
| 17 | `provider-group:command` | 15 | 桌面本地处理 | provider-group |
| 18 | `binding:resolve-session` | 14 | 桌面本地处理 | im |
| 19 | `maker:goal:get-status` | 14 | 桌面本地处理 | maker-ipc |
| 20 | `maker:session-background-activity` | 14 | 桌面本地处理 | maker-ipc |
| 21 | `worktree:restore-status` | 14 | 桌面本地处理 | worktree |
| 22 | `git-context:pr-refs:list` | 13 | 桌面本地处理 | git-context |
| 23 | `local-db:right-sidebar-tabs:list` | 13 | 桌面本地处理 | localDb |
| 24 | `maker:model-visibility:sync` | 9 | 桌面本地处理 | maker-ipc |
| 25 | `ghosts:recommendations` | 8 | 桌面本地处理 | cindy-brain |
| 26 | `maker:bot-group:list` | 8 | 桌面本地处理 | maker-ipc |
| 27 | `maker:claude-session-route:get` | 8 | 桌面本地处理 | bootstrap-electron |
| 28 | `sidebar-settings:claim-renderer-legacy-owner-sync` | 8 | 桌面本地处理 | sidebarSettingsStore |
| 29 | `sidebar-settings:get-project-order` | 8 | 桌面本地处理 | projectOrderStore |
| 30 | `maker:claude-oauth:status` | 7 | 桌面本地处理 | bootstrap-electron |
| 31 | `maker:remote-ssh:list` | 7 | 桌面本地处理 | remote-ssh |
| 32 | `maker:usage:account` | 7 | 桌面本地处理 | maker-ipc |
| 33 | `maker:usage:claude-subscription` | 7 | 桌面本地处理 | maker-ipc |
| 34 | `maker:im-default-settings:get` | 6 | 桌面本地处理 | bootstrap-electron |
| 35 | `maker:sync-worker-creation-prefs` | 6 | 无处理者 | maker-ipc |
| 36 | `desktop:cc-prefs-changed` | 5 | 桌面本地处理 | im |
| 37 | `maker:subscription-accounts` | 5 | 桌面本地处理 | subscription-accounts |
| 38 | `maker:sync-new-maker-draft` | 5 | 桌面本地处理 | maker-ipc |
| 39 | `maker:usage:codex-rate-limits` | 5 | 桌面本地处理 | maker-ipc |
| 40 | `auth:has-persisted-session-hint-sync` | 4 | 桌面本地处理 | bootstrap-electron |
| 41 | `binding:list-attached` | 4 | 桌面本地处理 | im |
| 42 | `ghosts:models:list` | 4 | 桌面本地处理 | cindy-brain |
| 43 | `git-context:pr-refs:list-all` | 4 | 桌面本地处理 | git-context |
| 44 | `local-db:bots:model-chain-settings-get` | 4 | 桌面本地处理 | localDb |
| 45 | `local-db:bots:read-state:update` | 4 | 桌面本地处理 | maker-ipc |
| 46 | `maker:silent-encrypted-retry:get` | 4 | 桌面本地处理 | bootstrap-electron |
| 47 | `plugin-market:snapshot` | 4 | 桌面本地处理 | plugin-market |
| 48 | `provider-share:command` | 4 | 桌面本地处理 | device-link |
| 49 | `appearance-settings:get-sync` | 3 | 桌面本地处理 | appearance-settings-ipc |
| 50 | `database-size-warning:get-settings` | 3 | 桌面本地处理 | bootstrap-electron |
| 51 | `layout:get` | 3 | 桌面本地处理 | layout |
| 52 | `local-db:bots:list` | 3 | 桌面本地处理 | localDb |
| 53 | `local-themes:list-sync` | 3 | 桌面本地处理 | local-themes |
| 54 | `maker:agent:binary-version` | 3 | 桌面本地处理 | maker-ipc |
| 55 | `maker:bot-read-state` | 3 | 桌面本地处理 | maker-ipc |
| 56 | `maker:git-safety:get` | 3 | 桌面本地处理 | bootstrap-electron |
| 57 | `maker:memory:get` | 3 | 桌面本地处理 | maker-ipc |
| 58 | `self-hosted-relay:command` | 3 | 桌面本地处理 | device-link |
| 59 | `analytics:settings-get` | 2 | 桌面本地处理 | analyticsSettingsService |
| 60 | `auth:initialize` | 2 | 桌面本地处理 | bootstrap-electron |
| 61 | `database-size-warning:get-status` | 2 | 桌面本地处理 | bootstrap-electron |
| 62 | `feishuBot:get-state` | 2 | 桌面本地处理 | im |
| 63 | `ghosts:recent-usage` | 2 | 桌面本地处理 | cindy-brain |
| 64 | `local-db:maintenance:last-result` | 2 | 桌面本地处理 | bootstrap-electron |
| 65 | `maker:agent-resource-settings:get` | 2 | 桌面本地处理 | maker-ipc |
| 66 | `maker:agent:pi-kernel-state` | 2 | 桌面本地处理 | maker-ipc |
| 67 | `maker:chat-embedding:get` | 2 | 桌面本地处理 | bootstrap-electron |
| 68 | `maker:chat:display-cache` | 2 | 桌面本地处理 | maker-ipc |
| 69 | `maker:collaboration-settings:get` | 2 | 桌面本地处理 | maker-ipc |
| 70 | `maker:memory:get-settings` | 2 | 桌面本地处理 | bootstrap-electron |
| 71 | `maker:provider:order:set` | 2 | 桌面本地处理 | maker-ipc |
| 72 | `maker:schedule:list-sidebar-index-runs` | 2 | 桌面本地处理 | maker-ipc |
| 73 | `plugin-market:recommendations` | 2 | 桌面本地处理 | plugin-market |
| 74 | `setup-migration:state` | 2 | 桌面本地处理 | setup-migration |
| 75 | `skillhub:scan` | 2 | 桌面本地处理 | skillhub |
| 76 | `wecomGroupNotification:get-state` | 2 | 桌面本地处理 | wecomGroupNotification |
| 77 | `worktree:get-for-session` | 2 | 桌面本地处理 | worktree |
| 78 | `app-shortcuts:get` | 1 | 桌面本地处理 | app-shortcuts |
| 79 | `app:get-cindy-make-state` | 1 | 桌面本地处理 | bootstrap-electron |
| 80 | `app:ready-for-bot` | 1 | 桌面本地处理 | bootstrap-electron |
| 81 | `appearance-settings:get` | 1 | 桌面本地处理 | appearance-settings-ipc |
| 82 | `check-environment` | 1 | 桌面本地处理 | bootstrap-electron |
| 83 | `cindy-media:storage-stats` | 1 | 桌面本地处理 | bootstrap-electron |
| 84 | `client-endpoints:get-sync` | 1 | 桌面本地处理 | clientEndpointsService |
| 85 | `companion-import` | 1 | 桌面本地处理 | bot-import |
| 86 | `database-size-warning:measure` | 1 | 桌面本地处理 | bootstrap-electron |
| 87 | `deep-link:take-pending` | 1 | 桌面本地处理 | bootstrap-electron |
| 88 | `dialogue-workspace:get` | 1 | 桌面本地处理 | bootstrap-electron |
| 89 | `dingtalkBot:get-state` | 1 | 桌面本地处理 | im |
| 90 | `discordBot:get-status` | 1 | 桌面本地处理 | im |
| 91 | `fs:resolve-path-batch` | 1 | 桌面本地处理 | bootstrap-electron |
| 92 | `ghosts:take-pending-install` | 1 | 桌面本地处理 | cindy-brain |
| 93 | `ghosts:unread` | 1 | 桌面本地处理 | cindy-brain |
| 94 | `legacy-migration:get-state` | 1 | 桌面本地处理 | legacyUserDataMigration |
| 95 | `local-agent:connections` | 1 | 桌面本地处理 | bootstrap-electron |
| 96 | `local-agent:developer-connection` | 1 | 桌面本地处理 | bootstrap-electron |
| 97 | `local-db:bots:read-state:get` | 1 | 桌面本地处理 | maker-ipc |
| 98 | `local-db:bots:workbench:follow-scopes` | 1 | 桌面本地处理 | localDb |
| 99 | `local-db:ensure-ready` | 1 | 桌面本地处理 | localDb |
| 100 | `local-db:maintenance:startup-progress` | 1 | 桌面本地处理 | bootstrap-electron |
| 101 | `local-db:session-import:scan` | 1 | 桌面本地处理 | session-import |
| 102 | `local-db:session-import:status` | 1 | 桌面本地处理 | session-import |
| 103 | `local-db:sessions:set-pinned-card-summaries` | 1 | 桌面本地处理 | localDb |
| 104 | `local-themes:list` | 1 | 桌面本地处理 | local-themes |
| 105 | `maker:android:get-config` | 1 | 桌面本地处理 | maker-ipc |
| 106 | `maker:auto-title` | 1 | 桌面本地处理 | maker-ipc |
| 107 | `maker:auxiliary-model-settings:get` | 1 | 桌面本地处理 | maker-ipc |
| 108 | `maker:companion-cloud:state` | 1 | 桌面本地处理 | maker-ipc |
| 109 | `maker:issues:list-mine` | 1 | 桌面本地处理 | maker-ipc |
| 110 | `maker:issues:snapshot-mine` | 1 | 桌面本地处理 | maker-ipc |
| 111 | `maker:lsp-mode:get` | 1 | 桌面本地处理 | bootstrap-electron |
| 112 | `maker:mcp:custom:list` | 1 | 桌面本地处理 | maker-ipc |
| 113 | `maker:mcp:duplicates:list` | 1 | 桌面本地处理 | maker-ipc |
| 114 | `maker:memory:get-settings-state` | 1 | 桌面本地处理 | bootstrap-electron |
| 115 | `maker:pi-packages:list` | 1 | 桌面本地处理 | maker-ipc |
| 116 | `maker:plugins:list` | 1 | 桌面本地处理 | maker-ipc |
| 117 | `maker:project-automation:pending-imports` | 1 | 桌面本地处理 | maker-ipc |
| 118 | `maker:provider:local-cli-scan` | 1 | 桌面本地处理 | maker-ipc |
| 119 | `maker:provider:models-auto-refresh` | 1 | 桌面本地处理 | maker-ipc |
| 120 | `maker:remote-ssh:cc-mgr-list-pending-upgrades` | 1 | 桌面本地处理 | remote-ssh |
| 121 | `maker:schedule:get-runtime-state` | 1 | 桌面本地处理 | maker-ipc |
| 122 | `maker:schedule:list` | 1 | 桌面本地处理 | maker-ipc |
| 123 | `maker:schedule:list-runs` | 1 | 桌面本地处理 | maker-ipc |
| 124 | `maker:schedule:webhook-receiver` | 1 | 桌面本地处理 | maker-ipc |
| 125 | `maker:session-background-activity:list` | 1 | 桌面本地处理 | maker-ipc |
| 126 | `maker:session-background-work:list` | 1 | 桌面本地处理 | maker-ipc |
| 127 | `maker:session:commit-provisional` | 1 | 桌面本地处理 | maker-ipc |
| 128 | `maker:session:prewarm` | 1 | 桌面本地处理 | maker-ipc |
| 129 | `maker:subagent-model-settings:get` | 1 | 桌面本地处理 | bootstrap-electron |
| 130 | `maker:sync-provider-model-memory` | 1 | 无处理者 | maker-ipc |
| 131 | `maker:usage:history` | 1 | 桌面本地处理 | maker-ipc |
| 132 | `maker:vision-bridge-settings:get` | 1 | 桌面本地处理 | bootstrap-electron |
| 133 | `model-favorites:host-ready` | 1 | 桌面本地处理 | maker-ipc |
| 134 | `plugin-market:consume-removal-notice` | 1 | 桌面本地处理 | plugin-market |
| 135 | `plugin-market:lookup` | 1 | 桌面本地处理 | plugin-market |
| 136 | `process-monitor:subscribe` | 1 | 桌面本地处理 | process-monitor |
| 137 | `process-monitor:unsubscribe` | 1 | 桌面本地处理 | process-monitor |
| 138 | `projects-root:get` | 1 | 桌面本地处理 | bootstrap-electron |
| 139 | `safe-storage-read` | 1 | 桌面本地处理 | bootstrap-electron |
| 140 | `setup-migration:host-ready` | 1 | 桌面本地处理 | setup-migration |
| 141 | `skillhub:list-categories` | 1 | 桌面本地处理 | skillhub |
| 142 | `skillhub:list-market` | 1 | 桌面本地处理 | skillhub |
| 143 | `telegramBot:get-status` | 1 | 桌面本地处理 | im |
| 144 | `terminal:get-default-shell-pref` | 1 | 桌面本地处理 | maker-ipc |
| 145 | `terminal:list-available-shells` | 1 | 桌面本地处理 | maker-ipc |
| 146 | `wechatBot:get-channel-settings` | 1 | 桌面本地处理 | im |
| 147 | `wechatBot:get-state` | 1 | 桌面本地处理 | im |
| 148 | `wecomBot:get-status` | 1 | 桌面本地处理 | im |
| 149 | `worktree-recycle:list` | 1 | 桌面本地处理 | bootstrap-electron |
| 150 | `worktree:list-all` | 1 | 桌面本地处理 | worktree |

## 按注册模块

| 模块 | contract | window | backend | 合计 |
|---|---:|---:|---:|---:|
| maker-ipc | 26 | 12 | 316 | 354 |
| bootstrap-electron | 5 | 60 | 151 | 216 |
| localDb | 20 | 1 | 66 | 87 |
| cindy-brain | 5 | 2 | 59 | 66 |
| im | 0 | 0 | 59 | 59 |
| device-link | 0 | 0 | 52 | 52 |
| skillhub | 0 | 0 | 42 | 42 |
| hook-control | 0 | 0 | 29 | 29 |
| remote-ssh | 0 | 0 | 29 | 29 |
| file-browser | 0 | 0 | 24 | 24 |
| billing | 0 | 0 | 21 | 21 |
| git-review | 0 | 0 | 21 | 21 |
| plugin-market | 0 | 0 | 20 | 20 |
| local-model-runtime | 0 | 0 | 19 | 19 |
| git-context | 0 | 0 | 17 | 17 |
| plugin-contributions | 0 | 0 | 13 | 13 |
| worktree | 0 | 0 | 12 | 12 |
| setup-migration | 0 | 0 | 7 | 7 |
| appearance-settings-ipc | 2 | 0 | 6 | 8 |
| learn-host | 0 | 0 | 6 | 6 |
| local-themes | 0 | 0 | 5 | 5 |
| plugin-publisher | 0 | 0 | 5 | 5 |
| session-import | 0 | 0 | 5 | 5 |
| sidebarSettingsStore | 0 | 0 | 5 | 5 |
| wecomGroupNotification | 0 | 0 | 5 | 5 |
| analyticsSettingsService | 0 | 0 | 4 | 4 |
| app-shortcuts | 0 | 1 | 4 | 5 |
| fsBrowse | 0 | 0 | 3 | 3 |
| process-monitor | 0 | 0 | 3 | 3 |
| remotePrecreatedWorktreeLedger | 0 | 0 | 3 | 3 |
| cross-agent-convert | 0 | 0 | 2 | 2 |
| legacyUserDataMigration | 0 | 0 | 2 | 2 |
| projectOrderStore | 0 | 0 | 2 | 2 |
| subscription-accounts | 0 | 0 | 2 | 2 |
| app-settings | 0 | 0 | 1 | 1 |
| bot-import | 0 | 0 | 1 | 1 |
| clientEndpointsService | 0 | 0 | 1 | 1 |
| commands | 0 | 0 | 1 | 1 |
| layout | 2 | 0 | 1 | 3 |
| local-agent | 0 | 0 | 1 | 1 |
| mcp-apps | 0 | 0 | 1 | 1 |
| model-access | 2 | 0 | 1 | 3 |
| provider-group | 0 | 0 | 1 | 1 |
| task-migration | 0 | 0 | 1 | 1 |
| accessibility-support-ipc | 0 | 1 | 0 | 1 |
| agent-island | 0 | 15 | 0 | 15 |
| appBadgeService | 0 | 3 | 0 | 3 |
| crash-diagnosis | 0 | 3 | 0 | 3 |
| ipc | 0 | 2 | 0 | 2 |
| log-upload | 0 | 4 | 0 | 4 |
| login-item-ipc | 0 | 2 | 0 | 2 |
| maker-host | 1 | 0 | 0 | 1 |
| mcp-integrations | 0 | 9 | 0 | 9 |
| menubar | 0 | 2 | 0 | 2 |
| notificationService | 0 | 2 | 0 | 2 |
| performance-trace | 0 | 2 | 0 | 2 |
| region-screenshot | 0 | 48 | 0 | 48 |
| relaunchBusyActivityIpc | 0 | 2 | 0 | 2 |
| remote-desktop | 0 | 20 | 0 | 20 |
| remote-desktop-viewer | 0 | 17 | 0 | 17 |
| resource-usage-window | 0 | 4 | 0 | 4 |
| right-sidebar-window | 0 | 11 | 0 | 11 |
| rsb-browser-bridge | 0 | 12 | 0 | 12 |
| sidebar-tab-window | 0 | 10 | 0 | 10 |
| sidebarWindowExpansionIpc | 0 | 1 | 0 | 1 |
| updateService | 0 | 17 | 0 | 17 |
| voice-conversation | 0 | 22 | 0 | 22 |
| voice-input | 0 | 62 | 0 | 62 |
| worklouder-codex | 0 | 10 | 0 | 10 |
| xbox-gamepad | 0 | 5 | 0 | 5 |

## 全部通道

### accessibility-support-ipc

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `accessibility-support:get-sync` | event | window（原生对话框、剪贴板、系统外壳与通知） | `accessibility-support-ipc.ts:11` |

### agent-island

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `agent-island:completion-action` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:643` |
| `agent-island:consume-entry-alert` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:690` |
| `agent-island:get-display-options` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:757` |
| `agent-island:get-live-activity-support` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:739` |
| `agent-island:preview-sound` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:776` |
| `agent-island:select-sound-file` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:785` |
| `agent-island:set-companion-chats` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:629` |
| `agent-island:set-display-target` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:752` |
| `agent-island:set-enabled` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:707` |
| `agent-island:set-live-activity` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:730` |
| `agent-island:set-mascot-skin` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:744` |
| `agent-island:set-remote-sessions` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:651` |
| `agent-island:set-sound-settings` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:715` |
| `agent-island:set-subtle-reminders` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:720` |
| `agent-island:set-visible-session` | invoke | window（窗口外壳、窗口布局与多窗口） | `agent-island/service.ts:668` |

### analyticsSettingsService

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `analytics:consent-accept` | invoke | backend | `analyticsSettingsService.ts:283` |
| `analytics:settings-get` | invoke | backend | `analyticsSettingsService.ts:257` |
| `analytics:settings-reset-enabled` | invoke | backend | `analyticsSettingsService.ts:273` |
| `analytics:settings-set-enabled` | invoke | backend | `analyticsSettingsService.ts:262` |

### app-settings

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `app-preferences:reply` | event | backend | `app-settings/preferences.ts:15` |

### app-shortcuts

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `app-shortcuts:clear-override` | invoke | backend | `app-shortcuts/index.ts:100` |
| `app-shortcuts:get` | event | backend | `app-shortcuts/index.ts:84` |
| `app-shortcuts:reset-all` | invoke | backend | `app-shortcuts/index.ts:105` |
| `app-shortcuts:set-override` | invoke | backend | `app-shortcuts/index.ts:92` |
| `app-shortcuts:set-recording` | event | window（本机输入设备与语音） | `app-shortcuts/index.ts:110` |

### appBadgeService

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `notification:clear-session-attention` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `appBadgeService.ts:105` |
| `notification:mark-session-attention` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `appBadgeService.ts:98` |
| `notification:set-app-attention-count` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `appBadgeService.ts:48` |

### appearance-settings-ipc

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `appearance-settings:ensure-wallpaper-image` | invoke | backend | `appearance-settings-ipc.ts:79` |
| `appearance-settings:ensure-wallpaper-video` | invoke | backend | `appearance-settings-ipc.ts:70` |
| `appearance-settings:get` | invoke | backend | `appearance-settings-ipc.ts:62` |
| `appearance-settings:get-sync` | event | backend | `appearance-settings-ipc.ts:56` |
| `appearance-settings:import-wallpaper` | invoke | backend | `appearance-settings-ipc.ts:87` |
| `appearance-settings:remove-wallpaper` | invoke | backend | `appearance-settings-ipc.ts:105` |
| `appearance-settings:reset` | invoke | contract | `appearance-settings-ipc.ts:123` |
| `appearance-settings:set-patch` | invoke | contract | `appearance-settings-ipc.ts:118` |

### billing

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `billing:cancel-current-subscription` | invoke | backend | `billing/index.ts:484` |
| `billing:cancel-plan-change` | invoke | backend | `billing/index.ts:484` |
| `billing:cancel-topup` | invoke | backend | `billing/index.ts:484` |
| `billing:confirm-plan-change` | invoke | backend | `billing/index.ts:484` |
| `billing:create-subscription` | invoke | backend | `billing/index.ts:484` |
| `billing:create-topup` | invoke | backend | `billing/index.ts:484` |
| `billing:get-balance` | invoke | backend | `billing/index.ts:484` |
| `billing:get-catalog` | invoke | backend | `billing/index.ts:484` |
| `billing:get-credit-usage` | invoke | backend | `billing/index.ts:484` |
| `billing:get-current-subscription` | invoke | backend | `billing/index.ts:484` |
| `billing:get-order` | invoke | backend | `billing/index.ts:484` |
| `billing:list-orders` | invoke | backend | `billing/index.ts:484` |
| `billing:list-payment-history` | invoke | backend | `billing/index.ts:484` |
| `billing:open-payment-redirect` | invoke | backend | `billing/index.ts:484` |
| `billing:open-subscription-portal` | invoke | backend | `billing/index.ts:484` |
| `billing:quote-plan-change` | invoke | backend | `billing/index.ts:484` |
| `billing:refresh-plan-change` | invoke | backend | `billing/index.ts:484` |
| `billing:refresh-subscription-purchase` | invoke | backend | `billing/index.ts:484` |
| `billing:refresh-topup` | invoke | backend | `billing/index.ts:484` |
| `billing:resume-current-subscription` | invoke | backend | `billing/index.ts:484` |
| `billing:retry-topup` | invoke | backend | `billing/index.ts:484` |

### bootstrap-electron

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `app-locale:get-preferred-system-locale-sync` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:3482` |
| `app-locale:set-classical-style` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:3491` |
| `app-menu:set-locale` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:3497` |
| `app:cancel-cindy-make-source` | invoke | backend | `bootstrap-electron.ts:8724` |
| `app:cancel-cindy-make-task` | invoke | backend | `bootstrap-electron.ts:8748` |
| `app:cindy-make-contribution` | invoke | backend | `bootstrap-electron.ts:8516` |
| `app:cindy-make-history` | invoke | backend | `bootstrap-electron.ts:8580` |
| `app:cindy-make-history-action` | invoke | backend | `bootstrap-electron.ts:8607` |
| `app:cindy-make-history-build` | invoke | backend | `bootstrap-electron.ts:8625` |
| `app:cindy-make-history-cancel-build` | invoke | backend | `bootstrap-electron.ts:8635` |
| `app:cindy-make-history-open-build` | invoke | backend | `bootstrap-electron.ts:8644` |
| `app:cindy-make-merge` | invoke | backend | `bootstrap-electron.ts:8484` |
| `app:cindy-make-personal-remote` | invoke | backend | `bootstrap-electron.ts:8498` |
| `app:cindy-make-sync` | invoke | backend | `bootstrap-electron.ts:8511` |
| `app:cindy-make-test` | invoke | backend | `bootstrap-electron.ts:8675` |
| `app:cindy-versions-action` | invoke | backend | `bootstrap-electron.ts:8667` |
| `app:cindy-versions-state` | invoke | backend | `bootstrap-electron.ts:8658` |
| `app:get-arm64-translation` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `bootstrap-electron.ts:5242` |
| `app:get-cindy-make-settings` | invoke | backend | `bootstrap-electron.ts:8565` |
| `app:get-cindy-make-source-status` | invoke | backend | `bootstrap-electron.ts:8521` |
| `app:get-cindy-make-state` | invoke | backend | `bootstrap-electron.ts:8694` |
| `app:manage-cindy-make-task` | invoke | backend | `bootstrap-electron.ts:8714` |
| `app:open-cindy-make-source-dir` | invoke | backend | `bootstrap-electron.ts:8730` |
| `app:open-cindy-make-tools-dir` | invoke | backend | `bootstrap-electron.ts:8472` |
| `app:open-logs-dir` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `bootstrap-electron.ts:8465` |
| `app:prepare-cindy-make-workspace` | invoke | backend | `bootstrap-electron.ts:8755` |
| `app:ready-for-bot` | invoke | backend | `bootstrap-electron.ts:10541` |
| `app:set-cindy-make-sync-latest-before-build` | invoke | backend | `bootstrap-electron.ts:8571` |
| `app:start-cindy-make-task` | invoke | backend | `bootstrap-electron.ts:8740` |
| `auth:account-deletion:clear-receipt` | invoke | backend | `bootstrap-electron.ts:6751` |
| `auth:account-deletion:confirm` | invoke | backend | `bootstrap-electron.ts:6747` |
| `auth:account-deletion:consume-restored-notice` | invoke | backend | `bootstrap-electron.ts:6754` |
| `auth:account-deletion:get-availability` | invoke | backend | `bootstrap-electron.ts:6741` |
| `auth:account-deletion:get-status` | invoke | backend | `bootstrap-electron.ts:6750` |
| `auth:account-deletion:request-challenge` | invoke | backend | `bootstrap-electron.ts:6744` |
| `auth:accounts:begin-add` | invoke | backend | `bootstrap-electron.ts:6691` |
| `auth:accounts:cancel-add` | invoke | backend | `bootstrap-electron.ts:6700` |
| `auth:accounts:list` | invoke | backend | `bootstrap-electron.ts:6668` |
| `auth:accounts:switch` | invoke | backend | `bootstrap-electron.ts:6682` |
| `auth:accounts:sync` | invoke | backend | `bootstrap-electron.ts:6673` |
| `auth:dispatch-login-action` | invoke | backend | `bootstrap-electron.ts:6650` |
| `auth:enter-local` | invoke | backend | `bootstrap-electron.ts:6705` |
| `auth:exit-local` | invoke | backend | `bootstrap-electron.ts:6713` |
| `auth:get-captcha-challenge-url` | invoke | backend | `bootstrap-electron.ts:6659` |
| `auth:get-login-state` | invoke | backend | `bootstrap-electron.ts:6648` |
| `auth:has-persisted-session-hint-sync` | event | backend | `bootstrap-electron.ts:5249` |
| `auth:initialize` | invoke | backend | `bootstrap-electron.ts:6598` |
| `auth:logout` | invoke | contract | `bootstrap-electron.ts:6664` |
| `auth:refresh` | invoke | contract | `bootstrap-electron.ts:6720` |
| `builtin-api-key-has` | invoke | backend | `bootstrap-electron.ts:6551` |
| `builtin-api-key-remove` | invoke | backend | `bootstrap-electron.ts:6574` |
| `builtin-api-key-store` | invoke | backend | `bootstrap-electron.ts:6559` |
| `cc:set-debug-net` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `bootstrap-electron.ts:6270` |
| `chat-attachment:cleanup` | invoke | backend | `bootstrap-electron.ts:8440` |
| `chat-attachment:save-as` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:8456` |
| `chat-attachment:stage` | invoke | backend | `bootstrap-electron.ts:8434` |
| `check-environment` | invoke | backend | `bootstrap-electron.ts:7123` |
| `cindy-media:chat-attachments-clear` | invoke | backend | `bootstrap-electron.ts:9316` |
| `cindy-media:chat-attachments-open-dir` | invoke | backend | `bootstrap-electron.ts:9312` |
| `cindy-media:legacy-images-clear` | invoke | backend | `bootstrap-electron.ts:9299` |
| `cindy-media:legacy-images-open-dir` | invoke | backend | `bootstrap-electron.ts:9295` |
| `cindy-media:report-draft-urls` | event | backend | `bootstrap-electron.ts:9226` |
| `cindy-media:storage-cleanup` | invoke | backend | `bootstrap-electron.ts:9278` |
| `cindy-media:storage-reconcile` | invoke | backend | `bootstrap-electron.ts:9294` |
| `cindy-media:storage-scan` | invoke | backend | `bootstrap-electron.ts:9273` |
| `cindy-media:storage-stats` | invoke | backend | `bootstrap-electron.ts:9269` |
| `clipboard:copy-text` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:8789` |
| `create-project-from-task:chooseParent` | invoke | backend | `bootstrap-electron.ts:9410` |
| `create-project-from-task:create` | invoke | backend | `bootstrap-electron.ts:9410` |
| `create-project-from-task:prepare` | invoke | backend | `bootstrap-electron.ts:9410` |
| `database-size-warning:get-settings` | invoke | backend | `bootstrap-electron.ts:4925` |
| `database-size-warning:get-status` | invoke | backend | `bootstrap-electron.ts:4958` |
| `database-size-warning:measure` | invoke | backend | `bootstrap-electron.ts:4962` |
| `database-size-warning:reset-settings` | invoke | backend | `bootstrap-electron.ts:4947` |
| `database-size-warning:set-settings` | invoke | backend | `bootstrap-electron.ts:4934` |
| `deep-link:take-pending` | invoke | backend | `bootstrap-electron.ts:3489` |
| `dialog:authorize-recent-writable-directory` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:7790` |
| `dialog:show-open-directory` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:7751` |
| `dialog:show-open-file` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:7817` |
| `dialog:show-open-resource` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:7838` |
| `dialogue-workspace:choose` | invoke | backend | `bootstrap-electron.ts:9367` |
| `dialogue-workspace:get` | invoke | backend | `bootstrap-electron.ts:9367` |
| `dialogue-workspace:open` | invoke | backend | `bootstrap-electron.ts:9367` |
| `dialogue-workspace:reset` | invoke | backend | `bootstrap-electron.ts:9367` |
| `file:thumbnail` | invoke | backend | `bootstrap-electron.ts:9068` |
| `find-in-page:start` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6170` |
| `find-in-page:stop` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6190` |
| `fs:resolve-path` | invoke | backend | `bootstrap-electron.ts:8168` |
| `fs:resolve-path-batch` | invoke | backend | `bootstrap-electron.ts:8196` |
| `get-app-display-version-info` | event | window（桌面安装包自身：更新、版本、日志与诊断） | `bootstrap-electron.ts:5253` |
| `get-app-version` | event | window（桌面安装包自身：更新、版本、日志与诊断） | `bootstrap-electron.ts:5233` |
| `get-device-id` | invoke | backend | `bootstrap-electron.ts:6202` |
| `get-fullscreen-state` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6151` |
| `get-os-release` | event | window（桌面安装包自身：更新、版本、日志与诊断） | `bootstrap-electron.ts:5237` |
| `host-client:observe` | event | client | `bootstrap-electron.ts:1431` |
| `host-client:retry` | event | client | `bootstrap-electron.ts:1435` |
| `image-cache:cleanup-files` | invoke | backend | `bootstrap-electron.ts:9622` |
| `image-cache:cleanup-session` | invoke | backend | `bootstrap-electron.ts:9611` |
| `image-cache:from-buffer` | invoke | backend | `bootstrap-electron.ts:9109` |
| `image-cache:from-path` | invoke | backend | `bootstrap-electron.ts:9095` |
| `image-cache:read-base64` | invoke | backend | `bootstrap-electron.ts:9596` |
| `local-agent:connections` | invoke | backend | `bootstrap-electron.ts:9253` |
| `local-agent:developer-connection` | invoke | backend | `bootstrap-electron.ts:9261` |
| `local-agent:revoke` | invoke | backend | `bootstrap-electron.ts:9265` |
| `local-agent:set-create-visible-sessions` | invoke | backend | `bootstrap-electron.ts:9257` |
| `local-db:maintenance:cancel-startup` | invoke | backend | `bootstrap-electron.ts:9581` |
| `local-db:maintenance:choose-backup-directory` | invoke | backend | `bootstrap-electron.ts:9553` |
| `local-db:maintenance:last-result` | invoke | backend | `bootstrap-electron.ts:9565` |
| `local-db:maintenance:open-last-backup-directory` | invoke | backend | `bootstrap-electron.ts:9571` |
| `local-db:maintenance:scan` | invoke | backend | `bootstrap-electron.ts:9549` |
| `local-db:maintenance:schedule` | invoke | backend | `bootstrap-electron.ts:9559` |
| `local-db:maintenance:startup-progress` | invoke | backend | `bootstrap-electron.ts:9577` |
| `maker:chat-embedding:get` | invoke | backend | `bootstrap-electron.ts:5691` |
| `maker:chat-embedding:reset` | invoke | backend | `bootstrap-electron.ts:5727` |
| `maker:chat-embedding:set` | invoke | backend | `bootstrap-electron.ts:5695` |
| `maker:claude-oauth:cancel` | invoke | backend | `bootstrap-electron.ts:5880` |
| `maker:claude-oauth:login` | invoke | backend | `bootstrap-electron.ts:5822` |
| `maker:claude-oauth:logout` | invoke | backend | `bootstrap-electron.ts:5843` |
| `maker:claude-oauth:status` | invoke | backend | `bootstrap-electron.ts:5817` |
| `maker:claude-session-route:get` | invoke | backend | `bootstrap-electron.ts:5773` |
| `maker:codex-runtime-route:get` | invoke | contract | `bootstrap-electron.ts:5766` |
| `maker:compaction:get-pct` | invoke | backend | `bootstrap-electron.ts:5565` |
| `maker:compaction:get-state` | invoke | backend | `bootstrap-electron.ts:5569` |
| `maker:compaction:reset-pct` | invoke | backend | `bootstrap-electron.ts:5573` |
| `maker:compaction:set-pct` | invoke | backend | `bootstrap-electron.ts:5580` |
| `maker:git-safety:get` | invoke | backend | `bootstrap-electron.ts:5747` |
| `maker:git-safety:reset` | invoke | backend | `bootstrap-electron.ts:5758` |
| `maker:git-safety:set` | invoke | backend | `bootstrap-electron.ts:5750` |
| `maker:im-default-settings:get` | invoke | backend | `bootstrap-electron.ts:5329` |
| `maker:im-default-settings:reset` | invoke | backend | `bootstrap-electron.ts:5377` |
| `maker:im-default-settings:set` | invoke | backend | `bootstrap-electron.ts:5333` |
| `maker:lsp-mode:get` | invoke | backend | `bootstrap-electron.ts:5676` |
| `maker:lsp-mode:set` | invoke | backend | `bootstrap-electron.ts:5679` |
| `maker:memory:get-settings` | invoke | backend | `bootstrap-electron.ts:5299` |
| `maker:memory:get-settings-state` | invoke | backend | `bootstrap-electron.ts:5302` |
| `maker:memory:preserve-legacy-maker-disabled` | invoke | backend | `bootstrap-electron.ts:5306` |
| `maker:open-session-in-new-window` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5066` |
| `maker:open-session-in-new-window-if-dropped-outside` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5084` |
| `maker:pi-compaction:get-pct` | invoke | backend | `bootstrap-electron.ts:5592` |
| `maker:pi-compaction:get-state` | invoke | backend | `bootstrap-electron.ts:5596` |
| `maker:pi-compaction:reset-pct` | invoke | backend | `bootstrap-electron.ts:5600` |
| `maker:pi-compaction:set-pct` | invoke | backend | `bootstrap-electron.ts:5607` |
| `maker:session-drag-preview:end` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5155` |
| `maker:session-drag-preview:start` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5112` |
| `maker:session-runtime-fallback:get` | invoke | backend | `bootstrap-electron.ts:5547` |
| `maker:session-runtime-fallback:reset` | invoke | backend | `bootstrap-electron.ts:5559` |
| `maker:session-runtime-fallback:set` | invoke | backend | `bootstrap-electron.ts:5551` |
| `maker:sidebar-tab-drag-preview:end` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5148` |
| `maker:sidebar-tab-drag-preview:start` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5137` |
| `maker:silent-encrypted-retry:get` | invoke | backend | `bootstrap-electron.ts:5527` |
| `maker:silent-encrypted-retry:reset` | invoke | backend | `bootstrap-electron.ts:5540` |
| `maker:silent-encrypted-retry:set` | invoke | backend | `bootstrap-electron.ts:5530` |
| `maker:subagent-model-settings:get` | invoke | backend | `bootstrap-electron.ts:5411` |
| `maker:subagent-model-settings:reset` | invoke | backend | `bootstrap-electron.ts:5487` |
| `maker:subagent-model-settings:set` | invoke | backend | `bootstrap-electron.ts:5460` |
| `maker:vision-bridge-settings:get` | invoke | backend | `bootstrap-electron.ts:5491` |
| `maker:vision-bridge-settings:reset` | invoke | backend | `bootstrap-electron.ts:5505` |
| `maker:vision-bridge-settings:set` | invoke | backend | `bootstrap-electron.ts:5500` |
| `maker:xai-oauth:cancel` | invoke | backend | `bootstrap-electron.ts:6024` |
| `maker:xai-oauth:login` | invoke | backend | `bootstrap-electron.ts:5945` |
| `maker:xai-oauth:logout` | invoke | backend | `bootstrap-electron.ts:5984` |
| `media:cache-for-session` | invoke | backend | `bootstrap-electron.ts:9056` |
| `media:copy-png-to-clipboard` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:8778` |
| `media:copy-to-clipboard` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:8877` |
| `media:open-with-default-app` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:9049` |
| `media:read-image-bytes` | invoke | backend | `bootstrap-electron.ts:9059` |
| `media:save-as` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:9052` |
| `open-with:list` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:8364` |
| `open-with:open` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:8368` |
| `page-zoom:in` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6123` |
| `page-zoom:out` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6131` |
| `page-zoom:reset` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6139` |
| `peek-file-header` | invoke | backend | `bootstrap-electron.ts:8011` |
| `profile:choose-avatar` | invoke | backend | `bootstrap-electron.ts:6810` |
| `profile:get-state` | invoke | backend | `bootstrap-electron.ts:6805` |
| `profile:update` | invoke | backend | `bootstrap-electron.ts:6815` |
| `projects-root:choose` | invoke | backend | `bootstrap-electron.ts:9394` |
| `projects-root:get` | invoke | backend | `bootstrap-electron.ts:9394` |
| `projects-root:reset` | invoke | backend | `bootstrap-electron.ts:9394` |
| `read-file-bytes` | invoke | backend | `bootstrap-electron.ts:7966` |
| `read-file-for-attachment` | invoke | backend | `bootstrap-electron.ts:7890` |
| `release-notes:fetch` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `bootstrap-electron.ts:6298` |
| `release-notes:fetch-index` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `bootstrap-electron.ts:6305` |
| `renderer:log` | event | window（桌面安装包自身：更新、版本、日志与诊断） | `bootstrap-electron.ts:5274` |
| `safe-storage-read` | invoke | backend | `bootstrap-electron.ts:6440` |
| `safe-storage-remove` | invoke | backend | `bootstrap-electron.ts:6478` |
| `safe-storage-store` | invoke | backend | `bootstrap-electron.ts:6386` |
| `shell:open-chatgpt-app` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:7331` |
| `shell:open-external` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:7303` |
| `shell:open-file-in-browser` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:8236` |
| `shell:open-path` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:8277` |
| `shell:show-item-in-folder` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:8822` |
| `show-open-directory-dialog` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `bootstrap-electron.ts:7352` |
| `startup-gate:stalled` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5260` |
| `text-file:read-preview` | invoke | backend | `bootstrap-electron.ts:8081` |
| `theme:apply-vibrancy` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5208` |
| `theme:set-sidebar-width` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5202` |
| `toggle-fullscreen` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6156` |
| `window-behavior:get-linux-close-behavior` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5651` |
| `window-behavior:get-windows-close-behavior` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5631` |
| `window-behavior:linux-close-behavior-shown` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5667` |
| `window-behavior:set-linux-close-behavior` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5656` |
| `window-behavior:set-swallow-activation-click` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5622` |
| `window-behavior:set-windows-close-behavior` | invoke | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5635` |
| `window-behavior:windows-close-behavior-shown` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:5646` |
| `window-close` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6104` |
| `window-close-self` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6120` |
| `window-drag-move-start` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6087` |
| `window-drag-move-stop` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6092` |
| `window-exit-fullscreen` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6051` |
| `window-maximize` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6037` |
| `window-minimize` | event | window（窗口外壳、窗口布局与多窗口） | `bootstrap-electron.ts:6033` |
| `workspace:scan-at-resources` | invoke | backend | `bootstrap-electron.ts:7381` |
| `workspace:scan-slash-commands` | invoke | backend | `bootstrap-electron.ts:7531` |
| `worktree-recycle:control` | invoke | backend | `bootstrap-electron.ts:9131` |
| `worktree-recycle:list` | invoke | backend | `bootstrap-electron.ts:9127` |

### bot-import

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `companion-import` | invoke | backend | `bot-import/registration.ts:13` |

### cindy-brain

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `forge-oidc-install:resolve-confirm` | invoke | backend | `cindy-brain/index.ts:10067` |
| `ghost-page:cancel-model-picker` | event | window（单个窗口内的插件页面 IPC（webContents.ipc）） | `cindy-brain/ghostPageModelPicker.ts:57` |
| `ghost-page:pick-model` | invoke | window（单个窗口内的插件页面 IPC（webContents.ipc）） | `cindy-brain/ghostPageModelPicker.ts:20` |
| `ghost-pipe:ping` | invoke | backend | `cindy-brain/index.ts:9707` |
| `ghost-pipe:send` | invoke | backend | `cindy-brain/index.ts:9723` |
| `ghosts:acknowledge-retirement` | invoke | backend | `cindy-brain/index.ts:10211` |
| `ghosts:activate-browser` | invoke | backend | `cindy-brain/index.ts:10179` |
| `ghosts:builtin-status` | event | backend | `cindy-brain/index.ts:10803` |
| `ghosts:card:action` | invoke | backend | `cindy-brain/index.ts:10170` |
| `ghosts:card:get` | invoke | contract | `cindy-brain/index.ts:10106` |
| `ghosts:card:list-by-session` | invoke | contract | `cindy-brain/index.ts:10135` |
| `ghosts:card:report-height` | invoke | backend | `cindy-brain/index.ts:10151` |
| `ghosts:clear-unread` | invoke | backend | `cindy-brain/index.ts:10314` |
| `ghosts:composer-list` | invoke | backend | `cindy-brain/index.ts:10234` |
| `ghosts:confirm:resolve` | invoke | backend | `cindy-brain/index.ts:10052` |
| `ghosts:control-points:candidates` | invoke | backend | `cindy-brain/index.ts:10918` |
| `ghosts:control-points:get` | invoke | backend | `cindy-brain/index.ts:10881` |
| `ghosts:defer-ui-prompt` | invoke | backend | `cindy-brain/index.ts:10870` |
| `ghosts:dev-runtime` | invoke | backend | `cindy-brain/index.ts:11218` |
| `ghosts:errand-prefs` | event | backend | `cindy-brain/index.ts:10458` |
| `ghosts:errand-prefs:set` | invoke | backend | `cindy-brain/index.ts:10465` |
| `ghosts:export` | invoke | backend | `cindy-brain/index.ts:10731` |
| `ghosts:handoff-delete` | invoke | backend | `cindy-brain/index.ts:10995` |
| `ghosts:handoff-folder` | invoke | backend | `cindy-brain/index.ts:10991` |
| `ghosts:handoff-list` | invoke | backend | `cindy-brain/index.ts:10987` |
| `ghosts:inspect` | invoke | backend | `cindy-brain/index.ts:10668` |
| `ghosts:install` | invoke | backend | `cindy-brain/index.ts:10485` |
| `ghosts:install-consent:resolve` | invoke | backend | `cindy-brain/index.ts:10085` |
| `ghosts:legacy-recovery-status` | invoke | backend | `cindy-brain/index.ts:9196` |
| `ghosts:library-bind` | invoke | backend | `cindy-brain/index.ts:11045` |
| `ghosts:library-delete` | invoke | backend | `cindy-brain/index.ts:11113` |
| `ghosts:library-overview` | invoke | backend | `cindy-brain/index.ts:10975` |
| `ghosts:library-pick-location` | invoke | backend | `cindy-brain/index.ts:11018` |
| `ghosts:library-reattach-legacy` | invoke | backend | `cindy-brain/index.ts:11151` |
| `ghosts:library-relocate` | invoke | backend | `cindy-brain/index.ts:11068` |
| `ghosts:library-revert-default` | invoke | backend | `cindy-brain/index.ts:11076` |
| `ghosts:library-unbind` | invoke | backend | `cindy-brain/index.ts:11096` |
| `ghosts:list` | event | contract | `cindy-brain/index.ts:10231` |
| `ghosts:mail-preview` | invoke | backend | `cindy-brain/index.ts:9042` |
| `ghosts:mark-used` | invoke | backend | `cindy-brain/index.ts:10272` |
| `ghosts:model-picker:resolve` | invoke | backend | `cindy-brain/index.ts:10039` |
| `ghosts:models:list` | invoke | backend | `cindy-brain/index.ts:10912` |
| `ghosts:open-retirement` | invoke | backend | `cindy-brain/index.ts:10189` |
| `ghosts:pick-file` | invoke | backend | `cindy-brain/index.ts:10648` |
| `ghosts:readme` | invoke | backend | `cindy-brain/index.ts:10967` |
| `ghosts:recent-usage` | event | backend | `cindy-brain/index.ts:10260` |
| `ghosts:recommendations` | event | backend | `cindy-brain/index.ts:10239` |
| `ghosts:reload` | invoke | backend | `cindy-brain/index.ts:11199` |
| `ghosts:request-task-approval` | invoke | backend | `cindy-brain/index.ts:10924` |
| `ghosts:request-ui-approval` | invoke | backend | `cindy-brain/index.ts:10857` |
| `ghosts:resolve-panel-media` | invoke | backend | `cindy-brain/index.ts:10388` |
| `ghosts:restore-builtin` | invoke | backend | `cindy-brain/index.ts:10829` |
| `ghosts:retry-legacy-recovery` | invoke | backend | `cindy-brain/index.ts:9197` |
| `ghosts:runtime-states` | invoke | contract | `cindy-brain/index.ts:10959` |
| `ghosts:session-focused` | event | backend | `cindy-brain/index.ts:10123` |
| `ghosts:set-enabled` | invoke | contract | `cindy-brain/index.ts:10941` |
| `ghosts:setup-status` | invoke | backend | `cindy-brain/index.ts:10337` |
| `ghosts:start-task:route` | invoke | backend | `cindy-brain/index.ts:10889` |
| `ghosts:take-pending-install` | invoke | backend | `cindy-brain/index.ts:10662` |
| `ghosts:ui-prompts` | invoke | backend | `cindy-brain/index.ts:10863` |
| `ghosts:uninstall` | invoke | backend | `cindy-brain/index.ts:10712` |
| `ghosts:unread` | event | backend | `cindy-brain/index.ts:10306` |
| `ghosts:update` | invoke | backend | `cindy-brain/index.ts:10559` |
| `ghosts:workdir-prefs` | event | backend | `cindy-brain/index.ts:10424` |
| `ghosts:workdir-prefs` | invoke | backend | `cindy-brain/index.ts:10430` |
| `ghosts:workdir-prefs:set` | invoke | backend | `cindy-brain/index.ts:10436` |

### clientEndpointsService

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `client-endpoints:get-sync` | event | backend | `clientEndpointsService.ts:1246` |

### commands

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `desktop-cmd:run` | invoke | backend | `commands/remoteCmdIpc.ts:40` |

### crash-diagnosis

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `crash-diagnosis:dismiss` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `crash-diagnosis.ts:93` |
| `crash-diagnosis:get` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `crash-diagnosis.ts:85` |
| `crash-diagnosis:prepare` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `crash-diagnosis.ts:89` |

### cross-agent-convert

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `maker:cross-agent:convert` | invoke | backend | `cross-agent-convert/ipc.ts:51` |
| `maker:cross-agent:detect` | invoke | backend | `cross-agent-convert/ipc.ts:42` |

### device-link

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `device-link:close-link` | invoke | backend | `device-link/ipc.ts:1834` |
| `device-link:confirm-skill-mutation` | invoke | backend | `device-link/ipc.ts:1612` |
| `device-link:delete-device` | invoke | backend | `device-link/ipc.ts:1824` |
| `device-link:disconnect-all` | invoke | backend | `device-link/ipc.ts:1948` |
| `device-link:get-peer-links` | invoke | backend | `device-link/ipc.ts:1814` |
| `device-link:get-state` | invoke | backend | `device-link/ipc.ts:1793` |
| `device-link:invoke` | invoke | backend | `device-link/ipc.ts:1839` |
| `device-link:list-devices` | invoke | backend | `device-link/ipc.ts:1811` |
| `device-link:mirror-cache:clear` | invoke | backend | `device-link/ipc.ts:2038` |
| `device-link:mirror-cache:messages:get` | invoke | backend | `device-link/ipc.ts:1985` |
| `device-link:mirror-cache:messages:put` | invoke | backend | `device-link/ipc.ts:1991` |
| `device-link:mirror-cache:session-list:get` | invoke | backend | `device-link/ipc.ts:2017` |
| `device-link:mirror-cache:session-list:put` | invoke | backend | `device-link/ipc.ts:2022` |
| `device-link:open-link` | invoke | backend | `device-link/ipc.ts:1829` |
| `device-link:pick-plugin-package` | invoke | backend | `device-link/ipc.ts:1675` |
| `device-link:plugin-settings:answer-directory` | invoke | backend | `device-link/ipc.ts:1748` |
| `device-link:plugin-settings:answer-model-picker` | invoke | backend | `device-link/ipc.ts:1753` |
| `device-link:plugin-settings:close` | invoke | backend | `device-link/ipc.ts:1744` |
| `device-link:plugin-settings:open` | invoke | backend | `device-link/ipc.ts:1736` |
| `device-link:rename-device` | invoke | backend | `device-link/ipc.ts:1819` |
| `device-link:restore` | invoke | backend | `device-link/ipc.ts:1970` |
| `device-link:revoke` | invoke | backend | `device-link/ipc.ts:1954` |
| `device-link:set-device-control-enabled` | invoke | backend | `device-link/ipc.ts:1804` |
| `device-link:set-enabled` | invoke | backend | `device-link/ipc.ts:1794` |
| `device-link:set-keep-awake` | invoke | backend | `device-link/ipc.ts:1801` |
| `device-link:set-model-use` | invoke | backend | `device-link/ipc.ts:1960` |
| `device-link:topic-subscribe` | invoke | backend | `device-link/ipc.ts:1935` |
| `device-link:topic-unsubscribe` | invoke | backend | `device-link/ipc.ts:1941` |
| `direct-link:host:event` | invoke | backend | `device-link/directLink.ts:38` |
| `direct-link:host:register` | invoke | backend | `device-link/directLink.ts:37` |
| `file-peer:host:closed` | invoke | backend | `device-link/filePeer.ts:579` |
| `file-peer:host:invoke` | invoke | backend | `device-link/filePeer.ts:534` |
| `file-peer:host:read` | invoke | backend | `device-link/filePeer.ts:601` |
| `file-peer:host:register` | invoke | backend | `device-link/filePeer.ts:578` |
| `file-peer:host:reply` | invoke | backend | `device-link/filePeer.ts:585` |
| `file-peer:host:write` | invoke | backend | `device-link/filePeer.ts:656` |
| `maker:provider-share:received-catalogs` | invoke | backend | `device-link/providerShareRuntime.ts:1366` |
| `maker:remote-resources:get` | invoke | backend | `device-link/remoteResourcesIpc.ts:62` |
| `maker:remote-resources:invoke` | invoke | backend | `device-link/remoteResourcesIpc.ts:73` |
| `maker:remote-resources:list` | invoke | backend | `device-link/remoteResourcesIpc.ts:51` |
| `maker:remote-resources:manifest` | invoke | backend | `device-link/remoteResourcesIpc.ts:44` |
| `maker:shared-task` | invoke | backend | `device-link/sharedTaskIpc.ts:18` |
| `plugin-oauth:answer-input-picture` | invoke | backend | `device-link/ipc.ts:1781` |
| `plugin-oauth:assist` | invoke | backend | `device-link/ipc.ts:1767` |
| `plugin-oauth:device-code` | invoke | backend | `device-link/ipc.ts:1606` |
| `plugin-oauth:open-input-picture` | invoke | backend | `device-link/ipc.ts:1772` |
| `plugin-oauth:submit-connection` | invoke | backend | `device-link/ipc.ts:1769` |
| `plugin-oauth:submit-input` | invoke | backend | `device-link/ipc.ts:1770` |
| `plugin-oauth:submit-secret` | invoke | backend | `device-link/ipc.ts:1768` |
| `provider-share:command` | invoke | backend | `device-link/providerShareRuntime.ts:1372` |
| `self-hosted-relay:command` | invoke | backend | `device-link/selfHostedRelayRuntime.ts:1885` |
| `shared-task:account` | invoke | backend | `device-link/sharedTaskIpc.ts:25` |

### file-browser

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `file-browser:remote-op` | invoke | backend | `file-browser/device-op.ts:1147` |
| `maker:chat-file:cancel` | invoke | backend | `file-browser/index.ts:654` |
| `maker:chat-file:download` | invoke | backend | `file-browser/index.ts:624` |
| `maker:chat-file:fetch` | invoke | backend | `file-browser/index.ts:535` |
| `maker:chat-file:stat` | invoke | backend | `file-browser/index.ts:696` |
| `maker:chat-folder:upload` | invoke | backend | `file-browser/index.ts:661` |
| `maker:file-browser:cache-put` | invoke | backend | `file-browser/index.ts:707` |
| `maker:file-browser:create-file` | invoke | backend | `file-browser/index.ts:906` |
| `maker:file-browser:create-folder` | invoke | backend | `file-browser/index.ts:921` |
| `maker:file-browser:delete-entry` | invoke | backend | `file-browser/index.ts:956` |
| `maker:file-browser:fetch-remote` | invoke | backend | `file-browser/index.ts:466` |
| `maker:file-browser:list-all` | invoke | backend | `file-browser/index.ts:809` |
| `maker:file-browser:list-dir` | invoke | backend | `file-browser/index.ts:776` |
| `maker:file-browser:read-cached` | invoke | backend | `file-browser/index.ts:741` |
| `maker:file-browser:read-file` | invoke | backend | `file-browser/index.ts:850` |
| `maker:file-browser:rename-entry` | invoke | backend | `file-browser/index.ts:936` |
| `maker:file-browser:start-watch` | invoke | backend | `file-browser/index.ts:973` |
| `maker:file-browser:stat` | invoke | backend | `file-browser/index.ts:876` |
| `maker:file-browser:stop-watch` | invoke | backend | `file-browser/index.ts:1008` |
| `maker:file-browser:write-file` | invoke | backend | `file-browser/index.ts:890` |
| `maker:html-preview:cancel` | invoke | backend | `file-browser/html-preview-ipc.ts:208` |
| `maker:html-preview:open` | invoke | backend | `file-browser/html-preview-ipc.ts:50` |
| `maker:search:cancel` | invoke | backend | `file-browser/search/index.ts:192` |
| `maker:search:start` | invoke | backend | `file-browser/search/index.ts:100` |

### fsBrowse

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `fs:list-dir` | invoke | backend | `fsBrowse/ipc.ts:173` |
| `fs:mkdir-p` | invoke | backend | `fsBrowse/ipc.ts:181` |
| `fs:stat-path` | invoke | backend | `fsBrowse/ipc.ts:177` |

### git-context

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `git-context:find-linked-worktree` | invoke | backend | `git-context/ipc.ts:339` |
| `git-context:get` | invoke | backend | `git-context/ipc.ts:249` |
| `git-context:get-for-session` | invoke | backend | `git-context/ipc.ts:257` |
| `git-context:github-read` | invoke | backend | `git-context/ipc.ts:234` |
| `git-context:github-setup:cancel` | invoke | backend | `git-context/githubSetupIpc.ts:111` |
| `git-context:github-setup:connection` | invoke | backend | `git-context/githubSetupIpc.ts:111` |
| `git-context:github-setup:start` | invoke | backend | `git-context/githubSetupIpc.ts:111` |
| `git-context:github-setup:status` | invoke | backend | `git-context/githubSetupIpc.ts:111` |
| `git-context:github-star:add` | invoke | backend | `git-context/githubSetupIpc.ts:111` |
| `git-context:github-star:check` | invoke | backend | `git-context/githubSetupIpc.ts:111` |
| `git-context:mr-status` | invoke | backend | `git-context/ipc.ts:487` |
| `git-context:pr-refs:list` | invoke | backend | `git-context/ipc.ts:357` |
| `git-context:pr-refs:list-all` | invoke | backend | `git-context/ipc.ts:363` |
| `git-context:pr-refs:manage` | invoke | backend | `git-context/ipc.ts:373` |
| `git-context:pr-status` | invoke | backend | `git-context/ipc.ts:486` |
| `git-context:unwatch` | invoke | backend | `git-context/ipc.ts:352` |
| `git-context:watch` | invoke | backend | `git-context/ipc.ts:347` |

### git-review

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `git-review:branch-diff` | invoke | backend | `git-review/ipc.ts:736` |
| `git-review:commit` | invoke | backend | `git-review/ipc.ts:826` |
| `git-review:commit-diff` | invoke | backend | `git-review/ipc.ts:727` |
| `git-review:commits` | invoke | backend | `git-review/ipc.ts:718` |
| `git-review:discard-all` | invoke | backend | `git-review/ipc.ts:806` |
| `git-review:discard-file` | invoke | backend | `git-review/ipc.ts:791` |
| `git-review:discard-hunk` | invoke | backend | `git-review/ipc.ts:821` |
| `git-review:file-diff` | invoke | backend | `git-review/ipc.ts:745` |
| `git-review:get` | invoke | backend | `git-review/ipc.ts:700` |
| `git-review:image-preview` | invoke | backend | `git-review/ipc.ts:754` |
| `git-review:markdown-preview` | invoke | backend | `git-review/ipc.ts:763` |
| `git-review:open-file` | invoke | backend | `git-review/ipc.ts:772` |
| `git-review:push` | invoke | backend | `git-review/ipc.ts:831` |
| `git-review:remote-op` | invoke | backend | `git-review/device-op.ts:192` |
| `git-review:stage-all` | invoke | backend | `git-review/ipc.ts:796` |
| `git-review:stage-file` | invoke | backend | `git-review/ipc.ts:781` |
| `git-review:stage-hunk` | invoke | backend | `git-review/ipc.ts:811` |
| `git-review:summary` | invoke | backend | `git-review/ipc.ts:709` |
| `git-review:unstage-all` | invoke | backend | `git-review/ipc.ts:801` |
| `git-review:unstage-file` | invoke | backend | `git-review/ipc.ts:786` |
| `git-review:unstage-hunk` | invoke | backend | `git-review/ipc.ts:816` |

### hook-control

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `maker:hook-control:add-binding` | invoke | backend | `hook-control/ipc.ts:1030` |
| `maker:hook-control:bind-revoke` | invoke | backend | `hook-control/ipc.ts:1000` |
| `maker:hook-control:bind-start` | invoke | backend | `hook-control/ipc.ts:991` |
| `maker:hook-control:cancel-pending-bind` | invoke | backend | `hook-control/ipc.ts:1057` |
| `maker:hook-control:get` | invoke | backend | `hook-control/ipc.ts:808` |
| `maker:hook-control:prefs-get` | invoke | backend | `hook-control/ipc.ts:1067` |
| `maker:hook-control:prefs-set` | invoke | backend | `hook-control/ipc.ts:1073` |
| `maker:hook-control:provider-bind-cancel` | invoke | backend | `hook-control/ipc.ts:869` |
| `maker:hook-control:provider-bind-revoke` | invoke | backend | `hook-control/ipc.ts:899` |
| `maker:hook-control:provider-bind-select` | invoke | backend | `hook-control/ipc.ts:882` |
| `maker:hook-control:provider-bind-start` | invoke | backend | `hook-control/ipc.ts:853` |
| `maker:hook-control:provider-open-action` | invoke | backend | `hook-control/ipc.ts:915` |
| `maker:hook-control:provider-prefs-get` | invoke | backend | `hook-control/ipc.ts:1091` |
| `maker:hook-control:provider-prefs-set` | invoke | backend | `hook-control/ipc.ts:1098` |
| `maker:hook-control:rebind-team` | invoke | backend | `hook-control/ipc.ts:1034` |
| `maker:hook-control:revoke-team` | invoke | backend | `hook-control/ipc.ts:1045` |
| `maker:hook-control:set-enabled` | invoke | backend | `hook-control/ipc.ts:816` |
| `maker:hook-control:set-lifecycle-announcement` | invoke | backend | `hook-control/ipc.ts:831` |
| `maker:hook-control:set-provider-default-workspace` | invoke | backend | `hook-control/ipc.ts:962` |
| `maker:hook-control:set-provider-enabled` | invoke | backend | `hook-control/ipc.ts:843` |
| `maker:hook-control:set-slack-communications` | invoke | backend | `hook-control/ipc.ts:1040` |
| `maker:hook-control:set-workspaces` | invoke | backend | `hook-control/ipc.ts:948` |
| `maker:hook-control:set-x-companion` | invoke | backend | `hook-control/ipc.ts:979` |
| `maker:hook-control:telegram-behavior-get` | invoke | backend | `hook-control/ipc.ts:1117` |
| `maker:hook-control:telegram-behavior-set` | invoke | backend | `hook-control/ipc.ts:1128` |
| `maker:hook-control:telegram-group-activation-set` | invoke | backend | `hook-control/ipc.ts:1193` |
| `maker:hook-control:telegram-groups-list` | invoke | backend | `hook-control/ipc.ts:1164` |
| `maker:hook-control:workspace-provider-source-get` | invoke | backend | `hook-control/ipc.ts:1221` |
| `maker:hook-control:workspace-provider-source-set` | invoke | backend | `hook-control/ipc.ts:1226` |

### im

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `binding:list-attached` | invoke | backend | `im/index.ts:583` |
| `binding:resolve-session` | invoke | backend | `im/index.ts:571` |
| `binding:revoke` | invoke | backend | `im/index.ts:597` |
| `botImConnection:add` | invoke | backend | `im/shared/botImConnectionRuntime.ts:809` |
| `botImConnection:adopt` | invoke | backend | `im/shared/botImPersonalAdoption.ts:288` |
| `botImConnection:archive-lane` | invoke | backend | `im/shared/botImConnectionRuntime.ts:863` |
| `botImConnection:list` | invoke | backend | `im/shared/botImConnectionRuntime.ts:805` |
| `botImConnection:list-adoptable` | invoke | backend | `im/shared/botImPersonalAdoption.ts:284` |
| `botImConnection:list-discord-channels` | invoke | backend | `im/shared/botImConnectionRuntime.ts:825` |
| `botImConnection:list-groups` | invoke | backend | `im/shared/botImConnectionRuntime.ts:819` |
| `botImConnection:list-lanes` | invoke | backend | `im/shared/botImConnectionRuntime.ts:848` |
| `botImConnection:remove` | invoke | backend | `im/shared/botImConnectionRuntime.ts:813` |
| `botImConnection:reset-lane` | invoke | backend | `im/shared/botImConnectionRuntime.ts:854` |
| `botImConnection:set-discord-channel-access` | invoke | backend | `im/shared/botImConnectionRuntime.ts:831` |
| `botImConnection:set-group-activation` | invoke | backend | `im/shared/botImConnectionRuntime.ts:837` |
| `desktop:cc-prefs-changed` | event | backend | `im/index.ts:262` |
| `dingtalkBot:clear` | invoke | backend | `packages/lizi-im/src/dingtalk/index.ts:231` |
| `dingtalkBot:get-state` | invoke | backend | `packages/lizi-im/src/dingtalk/index.ts:204` |
| `dingtalkBot:reconnect` | invoke | backend | `packages/lizi-im/src/dingtalk/index.ts:223` |
| `dingtalkBot:save` | invoke | backend | `packages/lizi-im/src/dingtalk/index.ts:205` |
| `discordBot:check-session-auth` | invoke | backend | `im/discord/sessionAuth.ts:79` |
| `discordBot:disconnect` | invoke | backend | `packages/lizi-im/src/discord/index.ts:374` |
| `discordBot:get-channel-access` | invoke | backend | `packages/lizi-im/src/discord/index.ts:381` |
| `discordBot:get-status` | invoke | backend | `packages/lizi-im/src/discord/index.ts:351` |
| `discordBot:list-channels` | invoke | backend | `packages/lizi-im/src/discord/index.ts:377` |
| `discordBot:reconnect` | invoke | backend | `packages/lizi-im/src/discord/index.ts:347` |
| `discordBot:set-channel-access` | invoke | backend | `packages/lizi-im/src/discord/index.ts:382` |
| `discordBot:set-config` | invoke | backend | `packages/lizi-im/src/discord/index.ts:346` |
| `discordBot:set-lifecycle-announcement` | invoke | backend | `packages/lizi-im/src/discord/index.ts:357` |
| `feishuBot:clear` | invoke | backend | `packages/lizi-im/src/feishu/ipc.ts:115` |
| `feishuBot:get-state` | invoke | backend | `packages/lizi-im/src/feishu/ipc.ts:93` |
| `feishuBot:reconnect` | invoke | backend | `im/index.ts:590` |
| `feishuBot:registration-begin` | invoke | backend | `packages/lizi-im/src/feishu/ipc.ts:128` |
| `feishuBot:registration-cancel` | invoke | backend | `packages/lizi-im/src/feishu/ipc.ts:163` |
| `feishuBot:save` | invoke | backend | `packages/lizi-im/src/feishu/ipc.ts:95` |
| `feishuBot:set-lifecycle-announcement` | invoke | backend | `packages/lizi-im/src/feishu/ipc.ts:120` |
| `telegramBot:check-session-auth` | invoke | backend | `im/telegram/sessionAuth.ts:88` |
| `telegramBot:disconnect` | invoke | backend | `packages/lizi-im/src/telegram/index.ts:791` |
| `telegramBot:get-behavior` | invoke | backend | `im/host.ts:295` |
| `telegramBot:get-persona` | invoke | backend | `im/host.ts:325` |
| `telegramBot:get-status` | invoke | backend | `packages/lizi-im/src/telegram/index.ts:764` |
| `telegramBot:list-groups` | invoke | backend | `im/host.ts:304` |
| `telegramBot:set-behavior` | invoke | backend | `im/host.ts:299` |
| `telegramBot:set-config` | invoke | backend | `packages/lizi-im/src/telegram/index.ts:762` |
| `telegramBot:set-group-activation` | invoke | backend | `im/host.ts:316` |
| `telegramBot:set-online` | invoke | backend | `packages/lizi-im/src/telegram/index.ts:771` |
| `telegramBot:set-persona` | invoke | backend | `im/host.ts:329` |
| `wechatBot:authorize` | invoke | backend | `im/index.ts:458` |
| `wechatBot:cancel-authorization` | invoke | backend | `im/index.ts:462` |
| `wechatBot:choose-working-directory` | invoke | backend | `im/index.ts:482` |
| `wechatBot:get-channel-settings` | invoke | backend | `im/index.ts:471` |
| `wechatBot:get-state` | invoke | backend | `im/index.ts:454` |
| `wechatBot:reset-working-directory` | invoke | backend | `im/index.ts:511` |
| `wechatBot:set-companion` | invoke | backend | `im/index.ts:475` |
| `wechatBot:unbind` | invoke | backend | `im/index.ts:467` |
| `wecomBot:disconnect` | invoke | backend | `packages/lizi-im/src/wecom/index.ts:292` |
| `wecomBot:get-status` | invoke | backend | `packages/lizi-im/src/wecom/index.ts:279` |
| `wecomBot:reconnect` | invoke | backend | `packages/lizi-im/src/wecom/index.ts:283` |
| `wecomBot:set-config` | invoke | backend | `packages/lizi-im/src/wecom/index.ts:280` |

### ipc

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `dev:embedding:status` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `ipc/dev/embedding.ts:24` |
| `dev:embedding:test-embed` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `ipc/dev/embedding.ts:39` |

### layout

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `layout:get` | event | backend | `layout/index.ts:44` |
| `layout:reset` | invoke | contract | `layout/index.ts:56` |
| `layout:set` | invoke | contract | `layout/index.ts:48` |

### learn-host

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `learn:apply` | invoke | backend | `learn-host/registerIpc.ts:112` |
| `learn:cancel` | invoke | backend | `learn-host/registerIpc.ts:129` |
| `learn:discard` | invoke | backend | `learn-host/registerIpc.ts:120` |
| `learn:get-proposal-diff` | invoke | backend | `learn-host/registerIpc.ts:102` |
| `learn:list-runs` | invoke | backend | `learn-host/registerIpc.ts:90` |
| `learn:start` | invoke | backend | `learn-host/registerIpc.ts:77` |

### legacyUserDataMigration

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `legacy-migration:confirm` | invoke | backend | `legacyUserDataMigration.ts:567` |
| `legacy-migration:get-state` | invoke | backend | `legacyUserDataMigration.ts:577` |

### local-agent

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `local-agent:confirmation:answer` | invoke | backend | `local-agent/confirmation.ts:15` |

### local-model-runtime

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `maker:llamacpp:cancel` | invoke | backend | `local-model-runtime/llamaCppIpc.ts:148` 等 2 处 |
| `maker:llamacpp:download` | invoke | backend | `local-model-runtime/llamaCppIpc.ts:132` 等 2 处 |
| `maker:llamacpp:ensure` | invoke | backend | `local-model-runtime/llamaCppIpc.ts:77` 等 2 处 |
| `maker:llamacpp:files` | invoke | backend | `local-model-runtime/llamaCppIpc.ts:120` 等 2 处 |
| `maker:llamacpp:install` | invoke | backend | `local-model-runtime/llamaCppIpc.ts:119` 等 2 处 |
| `maker:llamacpp:start` | invoke | backend | `local-model-runtime/llamaCppIpc.ts:142` 等 2 处 |
| `maker:llamacpp:status` | invoke | backend | `local-model-runtime/llamaCppIpc.ts:83` 等 2 处 |
| `maker:llamacpp:stop` | invoke | backend | `local-model-runtime/llamaCppIpc.ts:147` 等 2 处 |
| `maker:local-model:abort` | invoke | backend | `local-model-runtime/ipc.ts:163` |
| `maker:local-model:delete` | invoke | backend | `local-model-runtime/ipc.ts:249` |
| `maker:local-model:discard-paused` | invoke | backend | `local-model-runtime/ipc.ts:241` |
| `maker:local-model:ensure` | invoke | backend | `local-model-runtime/ipc.ts:204` |
| `maker:local-model:install` | invoke | backend | `local-model-runtime/ipc.ts:171` |
| `maker:local-model:install-abort` | invoke | backend | `local-model-runtime/ipc.ts:199` |
| `maker:local-model:list` | invoke | backend | `local-model-runtime/ipc.ts:96` |
| `maker:local-model:pull` | invoke | backend | `local-model-runtime/ipc.ts:127` |
| `maker:local-model:set-in-picker` | invoke | backend | `local-model-runtime/ipc.ts:223` |
| `maker:local-model:start` | invoke | backend | `local-model-runtime/ipc.ts:90` |
| `maker:local-model:status` | invoke | backend | `local-model-runtime/ipc.ts:85` |

### local-themes

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `local-themes:import` | invoke | backend | `local-themes/register.ts:55` |
| `local-themes:list` | invoke | backend | `local-themes/register.ts:48` |
| `local-themes:list-sync` | event | backend | `local-themes/register.ts:44` |
| `local-themes:open-dir` | invoke | backend | `local-themes/register.ts:51` |
| `local-themes:write` | invoke | backend | `local-themes/register.ts:49` |

### localDb

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `dev:sqlite-vec:status` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `localDb/ipc/dev/sqliteVec.ts:14` |
| `local-db:bots:choose-avatar` | invoke | backend | `localDb/ipc/bots.ts:2528` |
| `local-db:bots:choose-avatar-source` | invoke | backend | `localDb/ipc/bots.ts:2506` |
| `local-db:bots:create` | invoke | backend | `localDb/ipc/bots.ts:2586` |
| `local-db:bots:create-canonical-session` | invoke | backend | `localDb/ipc/bots.ts:2809` |
| `local-db:bots:dm-thread:ensure` | invoke | backend | `localDb/ipc/bots.ts:2923` |
| `local-db:bots:dm-thread:list` | invoke | backend | `localDb/ipc/bots.ts:2937` |
| `local-db:bots:generate-avatar` | invoke | backend | `localDb/ipc/bots.ts:2415` |
| `local-db:bots:generate-draft` | invoke | backend | `localDb/ipc/bots.ts:2421` |
| `local-db:bots:get` | invoke | backend | `localDb/ipc/bots.ts:2493` |
| `local-db:bots:history` | invoke | backend | `localDb/ipc/bots.ts:2947` |
| `local-db:bots:list` | invoke | backend | `localDb/ipc/bots.ts:2457` |
| `local-db:bots:memory:delete` | invoke | backend | `localDb/ipc/bots.ts:2909` |
| `local-db:bots:memory:list` | invoke | backend | `localDb/ipc/bots.ts:2881` |
| `local-db:bots:memory:read` | invoke | backend | `localDb/ipc/bots.ts:2887` |
| `local-db:bots:memory:update` | invoke | backend | `localDb/ipc/bots.ts:2892` |
| `local-db:bots:model-chain-settings-get` | invoke | backend | `localDb/ipc/bots.ts:2429` |
| `local-db:bots:model-chain-settings-reset` | invoke | backend | `localDb/ipc/bots.ts:2444` |
| `local-db:bots:model-chain-settings-set` | invoke | backend | `localDb/ipc/bots.ts:2435` |
| `local-db:bots:projects:list` | invoke | backend | `localDb/ipc/bots.ts:2844` |
| `local-db:bots:projects:set` | invoke | backend | `localDb/ipc/bots.ts:2844` |
| `local-db:bots:search-history` | invoke | backend | `localDb/ipc/bots.ts:2573` |
| `local-db:bots:skills:core` | invoke | backend | `localDb/ipc/botSkillSettingsIpc.ts:128` |
| `local-db:bots:skills:delete` | invoke | backend | `localDb/ipc/botSkillSettingsIpc.ts:145` |
| `local-db:bots:skills:list` | invoke | backend | `localDb/ipc/bots.ts:2871` |
| `local-db:bots:skills:read` | invoke | backend | `localDb/ipc/botSkillSettingsIpc.ts:132` |
| `local-db:bots:skills:save` | invoke | backend | `localDb/ipc/botSkillSettingsIpc.ts:136` |
| `local-db:bots:skills:set-enabled` | invoke | backend | `localDb/ipc/botSkillSettingsIpc.ts:140` |
| `local-db:bots:update` | invoke | backend | `localDb/ipc/bots.ts:2602` |
| `local-db:bots:workbench:follow-scopes` | invoke | backend | `localDb/ipc/bots.ts:2855` |
| `local-db:conversations:search` | invoke | contract | `localDb/ipc/search.desktop.ts:5` |
| `local-db:ensure-ready` | invoke | backend | `localDb/ipc/registerAll.ts:207` |
| `local-db:history:messages` | invoke | backend | `localDb/ipc/history.ts:306` |
| `local-db:history:query` | invoke | backend | `localDb/ipc/historyQuery.ts:68` |
| `local-db:messages:around` | invoke | backend | `localDb/ipc/messages.ts:521` |
| `local-db:messages:around-client-id` | invoke | backend | `localDb/ipc/messages.ts:604` |
| `local-db:messages:create` | invoke | contract | `localDb/ipc/messages.ts:740` |
| `local-db:messages:dismiss-error` | invoke | backend | `localDb/ipc/messages.ts:831` |
| `local-db:messages:estimatedSessionValue` | invoke | contract | `localDb/ipc/messages.ts:689` |
| `local-db:messages:list` | invoke | contract | `localDb/ipc/messages.ts:396` |
| `local-db:messages:updateAgentMeta` | invoke | backend | `localDb/ipc/messages.ts:793` |
| `local-db:messages:updateContent` | invoke | backend | `localDb/ipc/messages.ts:812` |
| `local-db:messages:view` | invoke | contract | `localDb/ipc/messages.ts:473` |
| `local-db:messages:view-intent` | invoke | backend | `localDb/ipc/messages.ts:496` |
| `local-db:messages:work-details` | invoke | backend | `localDb/ipc/messages.ts:503` |
| `local-db:orca-workflows:get-by-lead` | invoke | backend | `localDb/ipc/orcaTeams.ts:42` |
| `local-db:orca-workflows:get-by-worker-session` | invoke | backend | `localDb/ipc/orcaTeams.ts:49` |
| `local-db:orca-workflows:list-workers-by-lead` | invoke | backend | `localDb/ipc/orcaTeams.ts:56` |
| `local-db:orca-workflows:list-workers-by-leads` | invoke | backend | `localDb/ipc/orcaTeams.ts:64` |
| `local-db:orca-workflows:update-worker-status` | invoke | backend | `localDb/ipc/orcaTeams.ts:72` |
| `local-db:project-aliases:delete` | invoke | contract | `localDb/ipc/projectAliases.ts:91` |
| `local-db:project-aliases:list` | invoke | contract | `localDb/ipc/projectAliases.ts:79` |
| `local-db:project-aliases:set` | invoke | contract | `localDb/ipc/projectAliases.ts:86` |
| `local-db:recent-workdirs:list` | invoke | contract | `localDb/ipc/recentWorkdirs.ts:9` |
| `local-db:recent-workdirs:remove` | invoke | backend | `localDb/ipc/recentWorkdirs.ts:10` |
| `local-db:right-sidebar-tabs:close` | invoke | backend | `localDb/ipc/rightSidebarTabs.ts:273` |
| `local-db:right-sidebar-tabs:ensure-singleton` | invoke | backend | `localDb/ipc/rightSidebarTabs.ts:163` |
| `local-db:right-sidebar-tabs:list` | invoke | backend | `localDb/ipc/rightSidebarTabs.ts:129` |
| `local-db:right-sidebar-tabs:reorder` | invoke | backend | `localDb/ipc/rightSidebarTabs.ts:331` |
| `local-db:right-sidebar-tabs:setActive` | invoke | backend | `localDb/ipc/rightSidebarTabs.ts:296` |
| `local-db:right-sidebar-tabs:upsert` | invoke | backend | `localDb/ipc/rightSidebarTabs.ts:231` |
| `local-db:session-share:cancel` | invoke | backend | `localDb/ipc/session-share.ts:248` |
| `local-db:session-share:classify-path` | invoke | backend | `localDb/ipc/session-share.ts:257` |
| `local-db:session-share:commit` | invoke | backend | `localDb/ipc/session-share.ts:161` |
| `local-db:session-share:export` | invoke | backend | `localDb/ipc/session-share.ts:75` |
| `local-db:session-share:inspect` | invoke | backend | `localDb/ipc/session-share.ts:114` |
| `local-db:session-share:unlock` | invoke | backend | `localDb/ipc/session-share.ts:146` |
| `local-db:sessions:ack-interrupted` | invoke | backend | `localDb/ipc/sessions.ts:1615` |
| `local-db:sessions:create` | invoke | contract | `localDb/ipc/sessions.ts:1495` |
| `local-db:sessions:dismiss-pending-alerts` | invoke | backend | `localDb/ipc/sessions.ts:1562` |
| `local-db:sessions:error-tail-pending` | invoke | contract | `localDb/ipc/sessions.ts:1544` |
| `local-db:sessions:get` | invoke | contract | `localDb/ipc/sessions.ts:1645` |
| `local-db:sessions:get-many` | invoke | backend | `localDb/ipc/sessions.ts:1631` |
| `local-db:sessions:interrupted-pending` | invoke | contract | `localDb/ipc/sessions.ts:1509` |
| `local-db:sessions:interrupted-resume-candidates` | invoke | contract | `localDb/ipc/sessions.ts:1516` |
| `local-db:sessions:list` | invoke | contract | `localDb/ipc/sessions.ts:1368` |
| `local-db:sessions:patch-meta` | invoke | backend | `localDb/ipc/sessions.ts:1788` |
| `local-db:sessions:resolve-references` | invoke | backend | `localDb/ipc/sessions.ts:1657` |
| `local-db:sessions:restore-if-archived` | invoke | backend | `localDb/ipc/sessions.ts:1700` |
| `local-db:sessions:set-pinned-card-summaries` | invoke | backend | `localDb/ipc/sessions.ts:1815` |
| `local-db:sessions:touchUserSend` | invoke | backend | `localDb/ipc/sessions.ts:1804` |
| `local-db:sessions:update` | invoke | contract | `localDb/ipc/sessions.ts:1772` |
| `local-db:subagent-runs:detail` | invoke | contract | `localDb/ipc/subagentRuns.ts:83` |
| `local-db:subagent-runs:list` | invoke | contract | `localDb/ipc/subagentRuns.ts:83` |
| `local-db:subagent-runs:transcript` | invoke | contract | `localDb/ipc/subagentRuns.ts:83` |
| `local-db:task-tags:execute` | invoke | contract | `localDb/ipc/taskTags.ts:32` |
| `sidebar-settings:get-project-aliases` | invoke | backend | `localDb/ipc/projectAliases.ts:75` |

### log-upload

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `log-upload:reset-crash-auto` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `log-upload/index.ts:404` |
| `log-upload:set-crash-auto` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `log-upload/index.ts:383` |
| `log-upload:settings-get` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `log-upload/index.ts:378` |
| `log-upload:upload-now` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `log-upload/index.ts:418` |

### login-item-ipc

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `login-item:get` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `login-item-ipc.ts:14` |
| `login-item:set` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `login-item-ipc.ts:18` |

### maker-host

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `maker:model-visibility:legacy-owner-claim-sync` | event | contract | `maker-host/model-visibility-owner-claim.ts:126` |

### maker-ipc

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `ghosts:background-tasks:list` | invoke | backend | `maker-ipc/register.ts:15067` |
| `ghosts:background-tasks:reveal` | invoke | backend | `maker-ipc/register.ts:15071` |
| `input-handoff:picture` | invoke | backend | `maker-ipc/register.ts:22725` |
| `input-handoff:raise` | invoke | backend | `maker-ipc/register.ts:22717` |
| `input-handoff:submit` | invoke | backend | `maker-ipc/register.ts:22709` |
| `local-db:bots:read-state:get` | invoke | backend | `maker-ipc/botReadStateIpc.ts:84` |
| `local-db:bots:read-state:update` | invoke | backend | `maker-ipc/botReadStateIpc.ts:93` |
| `maker:abort-session` | invoke | backend | `maker-ipc/register.ts:22499` |
| `maker:agent-resource-settings:get` | invoke | backend | `maker-ipc/register.ts:16665` |
| `maker:agent-resource-settings:reset` | invoke | backend | `maker-ipc/register.ts:16671` |
| `maker:agent-resource-settings:set` | invoke | backend | `maker-ipc/register.ts:16668` |
| `maker:agent-task:stop` | invoke | backend | `maker-ipc/stopAgentTaskHandler.ts:29` |
| `maker:agent:binary-version` | invoke | backend | `maker-ipc/binary-version.ts:168` |
| `maker:agent:pi-kernel-install` | invoke | backend | `maker-ipc/pi-kernel.ts:60` |
| `maker:agent:pi-kernel-state` | invoke | backend | `maker-ipc/pi-kernel.ts:59` |
| `maker:agent:status` | invoke | contract | `maker-ipc/statusHandlers.ts:14` |
| `maker:android:get-config` | invoke | backend | `maker-ipc/androidHandlers.ts:102` |
| `maker:android:prepare-adb` | invoke | backend | `maker-ipc/androidHandlers.ts:132` |
| `maker:android:set-adb-path` | invoke | backend | `maker-ipc/androidHandlers.ts:121` |
| `maker:android:set-default-device` | invoke | backend | `maker-ipc/androidHandlers.ts:110` |
| `maker:android:status` | invoke | backend | `maker-ipc/androidHandlers.ts:94` |
| `maker:any-session-in-turn` | invoke | backend | `maker-ipc/register.ts:7214` |
| `maker:api-key:present` | invoke | backend | `maker-ipc/authHandlers.ts:428` |
| `maker:apply-new-maker-draft-pref` | invoke | backend | `maker-ipc/register.ts:7519` |
| `maker:apply-new-maker-worktree-branch-pref` | invoke | backend | `maker-ipc/newMakerWorktreeBranchPreferenceHandler.ts:82` |
| `maker:apply-new-maker-worktree-pref` | invoke | backend | `maker-ipc/newMakerWorktreePreferenceHandler.ts:24` |
| `maker:at-context:list` | invoke | backend | `maker-ipc/register.ts:8593` |
| `maker:auth:cancel-login` | invoke | contract | `maker-ipc/authHandlers.ts:481` |
| `maker:auth:get-state` | invoke | contract | `maker-ipc/authHandlers.ts:422` |
| `maker:auth:logout` | invoke | contract | `maker-ipc/authHandlers.ts:518` |
| `maker:auth:trigger-login` | invoke | contract | `maker-ipc/authHandlers.ts:433` |
| `maker:auto-title` | invoke | backend | `maker-ipc/title.ts:667` |
| `maker:auxiliary-model-settings:get` | invoke | backend | `maker-ipc/auxiliary-model-settings.ts:195` |
| `maker:auxiliary-model-settings:set` | invoke | backend | `maker-ipc/auxiliary-model-settings.ts:232` |
| `maker:background-task:output-tail` | invoke | backend | `maker-ipc/register.ts:7384` |
| `maker:bot-delegation:cancel` | invoke | backend | `maker-ipc/register.ts:14139` |
| `maker:bot-delegations:list` | invoke | backend | `maker-ipc/register.ts:13844` |
| `maker:bot-direct-message-thread:get` | invoke | backend | `maker-ipc/register.ts:13855` |
| `maker:bot-group:continue` | invoke | backend | `maker-ipc/register.ts:14020` |
| `maker:bot-group:create` | invoke | backend | `maker-ipc/register.ts:13964` |
| `maker:bot-group:delete` | invoke | backend | `maker-ipc/register.ts:13976` |
| `maker:bot-group:get` | invoke | backend | `maker-ipc/register.ts:13960` |
| `maker:bot-group:list` | invoke | backend | `maker-ipc/register.ts:13956` |
| `maker:bot-group:outbox` | invoke | backend | `maker-ipc/register.ts:14015` |
| `maker:bot-group:outbox-command` | invoke | backend | `maker-ipc/register.ts:14019` |
| `maker:bot-group:plan-continue` | invoke | backend | `maker-ipc/register.ts:14126` |
| `maker:bot-group:plan-dismiss` | invoke | backend | `maker-ipc/register.ts:14122` |
| `maker:bot-group:plan-edit` | invoke | backend | `maker-ipc/register.ts:14134` |
| `maker:bot-group:plan-retry` | invoke | backend | `maker-ipc/register.ts:14130` |
| `maker:bot-group:plan-start` | invoke | backend | `maker-ipc/register.ts:14028` |
| `maker:bot-group:send` | invoke | backend | `maker-ipc/register.ts:14013` |
| `maker:bot-group:set-members` | invoke | backend | `maker-ipc/register.ts:13972` |
| `maker:bot-group:stop` | invoke | backend | `maker-ipc/register.ts:14024` |
| `maker:bot-group:update` | invoke | backend | `maker-ipc/register.ts:13968` |
| `maker:bot-lifecycle:action` | invoke | backend | `maker-ipc/botLifecycleService.ts:434` |
| `maker:bot-read-state` | invoke | backend | `maker-ipc/register.ts:14001` |
| `maker:browser:open-for-login` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25823` |
| `maker:browser:status` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25814` |
| `maker:chat-server:acceptInvite` | invoke | backend | `maker-ipc/register.ts:13936` |
| `maker:chat-server:createInvite` | invoke | backend | `maker-ipc/register.ts:13921` |
| `maker:chat-server:followThread` | invoke | backend | `maker-ipc/register.ts:13906` |
| `maker:chat-server:manage` | invoke | backend | `maker-ipc/register.ts:13941` |
| `maker:chat-server:mask` | invoke | backend | `maker-ipc/register.ts:13873` |
| `maker:chat-server:mentions` | invoke | backend | `maker-ipc/register.ts:13877` |
| `maker:chat-server:ownedBots` | invoke | backend | `maker-ipc/register.ts:13946` |
| `maker:chat-server:previewInvite` | invoke | backend | `maker-ipc/register.ts:13926` |
| `maker:chat-server:react` | invoke | backend | `maker-ipc/register.ts:13901` |
| `maker:chat-server:reactors` | invoke | backend | `maker-ipc/register.ts:13916` |
| `maker:chat-server:readers` | invoke | backend | `maker-ipc/register.ts:13911` |
| `maker:chat-server:refreshProfile` | invoke | backend | `maker-ipc/register.ts:13951` |
| `maker:chat-server:reply` | invoke | backend | `maker-ipc/register.ts:13891` |
| `maker:chat-server:revokeInvite` | invoke | backend | `maker-ipc/register.ts:13931` |
| `maker:chat-server:shareToMain` | invoke | backend | `maker-ipc/register.ts:13896` |
| `maker:chat-server:status` | invoke | backend | `maker-ipc/register.ts:13881` |
| `maker:chat-server:thread` | invoke | backend | `maker-ipc/register.ts:13886` |
| `maker:chat:display-cache` | invoke | backend | `maker-ipc/register.ts:13980` |
| `maker:close-session` | invoke | backend | `maker-ipc/register.ts:22551` |
| `maker:collaboration-settings:get` | invoke | backend | `maker-ipc/register.ts:16642` |
| `maker:collaboration-settings:reset` | invoke | backend | `maker-ipc/register.ts:16657` |
| `maker:collaboration-settings:set` | invoke | backend | `maker-ipc/register.ts:16646` |
| `maker:compact-session` | invoke | backend | `maker-ipc/register.ts:25122` |
| `maker:companion-avatar:resolve` | invoke | backend | `maker-ipc/register.ts:14106` |
| `maker:companion-cloud:attachment` | invoke | backend | `maker-ipc/register.ts:14093` |
| `maker:companion-cloud:caps` | invoke | backend | `maker-ipc/register.ts:10560` |
| `maker:companion-cloud:cindy-copies` | invoke | backend | `maker-ipc/register.ts:14082` |
| `maker:companion-cloud:dismiss-notices` | invoke | backend | `maker-ipc/register.ts:14037` |
| `maker:companion-cloud:flush` | invoke | backend | `maker-ipc/register.ts:10570` |
| `maker:companion-cloud:hand-over` | invoke | backend | `maker-ipc/register.ts:10574` |
| `maker:companion-cloud:home-choices` | invoke | backend | `maker-ipc/register.ts:14115` |
| `maker:companion-cloud:merge` | invoke | backend | `maker-ipc/register.ts:10565` |
| `maker:companion-cloud:merge-cindy` | invoke | backend | `maker-ipc/register.ts:14087` |
| `maker:companion-cloud:state` | invoke | backend | `maker-ipc/register.ts:14033` |
| `maker:companion-cloud:switch-home` | invoke | backend | `maker-ipc/register.ts:14054` |
| `maker:companion-cloud:take-over` | invoke | backend | `maker-ipc/register.ts:14048` |
| `maker:companion-cloud:targets` | invoke | backend | `maker-ipc/register.ts:10563` |
| `maker:companion-cloud:transcript` | invoke | backend | `maker-ipc/register.ts:14061` |
| `maker:companion-live:read` | invoke | backend | `maker-ipc/register.ts:14888` |
| `maker:computer:cancel-permission-grant` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25935` |
| `maker:computer:check-update` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25953` |
| `maker:computer:driver-icon` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25908` |
| `maker:computer:grant-permissions` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25863` |
| `maker:computer:install-driver` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25855` |
| `maker:computer:permission-app-drag-end` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25928` |
| `maker:computer:permission-app-drag-start` | event | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25921` |
| `maker:computer:permission-guide-status` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25912` |
| `maker:computer:status` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25839` |
| `maker:computer:update-driver` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `maker-ipc/register.ts:25965` |
| `maker:create-session` | invoke | backend | `maker-ipc/sessionCreateHandler.ts:87` |
| `maker:execute-desktop-command` | invoke | backend | `maker-ipc/register.ts:8260` |
| `maker:export-session-html` | invoke | backend | `maker-ipc/register.ts:25084` |
| `maker:fork` | invoke | backend | `maker-ipc/fork.ts:79` |
| `maker:fork-strip-encrypted` | invoke | backend | `maker-ipc/fork.ts:123` |
| `maker:generate-title` | invoke | backend | `maker-ipc/title.ts:620` |
| `maker:get-capabilities` | invoke | contract | `maker-ipc/register.ts:7460` |
| `maker:get-context-usage` | invoke | backend | `maker-ipc/register.ts:19423` |
| `maker:get-context-window-bounds` | invoke | backend | `maker-ipc/register.ts:24917` |
| `maker:get-new-maker-defaults` | invoke | backend | `maker-ipc/register.ts:7511` |
| `maker:get-new-maker-worktree-branch-pref` | invoke | backend | `maker-ipc/newMakerWorktreeBranchPreferenceHandler.ts:76` |
| `maker:get-pending-interactions` | invoke | contract | `maker-ipc/register.ts:22695` |
| `maker:get-plugin-write-access-recovery` | invoke | backend | `maker-ipc/register.ts:15052` |
| `maker:get-session-agent-switch-intent` | invoke | backend | `maker-ipc/sessionAgentSwitchHandler.ts:1733` |
| `maker:get-session-tree` | invoke | backend | `maker-ipc/register.ts:25203` |
| `maker:get-workflow-progress` | invoke | backend | `maker-ipc/register.ts:7406` |
| `maker:goal:clear` | invoke | backend | `maker-ipc/goal.ts:135` |
| `maker:goal:get-status` | invoke | backend | `maker-ipc/goal.ts:142` |
| `maker:goal:pause` | invoke | backend | `maker-ipc/goal.ts:170` |
| `maker:goal:resume` | invoke | backend | `maker-ipc/goal.ts:178` |
| `maker:goal:set` | invoke | backend | `maker-ipc/goal.ts:110` |
| `maker:goal:update` | invoke | backend | `maker-ipc/goal.ts:188` |
| `maker:help:ask` | invoke | backend | `maker-ipc/help.ts:371` |
| `maker:help:feedback:create` | invoke | backend | `maker-ipc/help-feedback.ts:156` |
| `maker:images:retry` | invoke | backend | `maker-ipc/register.ts:22095` |
| `maker:input:cancel-usage-limit-wait` | invoke | backend | `maker-ipc/register.ts:22121` |
| `maker:input:clear-error` | invoke | contract | `maker-ipc/register.ts:22114` |
| `maker:input:clear-session` | invoke | backend | `maker-ipc/register.ts:22430` |
| `maker:input:compact` | invoke | backend | `maker-ipc/register.ts:21786` |
| `maker:input:enqueue` | invoke | contract | `maker-ipc/register.ts:21538` |
| `maker:input:get-projection` | invoke | contract | `maker-ipc/register.ts:21496` |
| `maker:input:move` | invoke | backend | `maker-ipc/register.ts:22391` |
| `maker:input:remove` | invoke | contract | `maker-ipc/register.ts:22166` |
| `maker:input:resume` | invoke | contract | `maker-ipc/register.ts:22089` |
| `maker:input:retry-last-error` | invoke | contract | `maker-ipc/register.ts:22106` |
| `maker:input:session-reference-capability` | invoke | backend | `maker-ipc/register.ts:21212` |
| `maker:input:set-edit-lock` | invoke | backend | `maker-ipc/register.ts:22421` |
| `maker:input:set-expanded` | invoke | backend | `maker-ipc/register.ts:22403` |
| `maker:input:set-interaction-lock` | invoke | backend | `maker-ipc/register.ts:22412` |
| `maker:input:steer` | invoke | contract | `maker-ipc/register.ts:21810` |
| `maker:input:stop` | invoke | contract | `maker-ipc/register.ts:22049` |
| `maker:input:update-content` | invoke | backend | `maker-ipc/register.ts:22267` |
| `maker:input:update-text` | invoke | backend | `maker-ipc/register.ts:22228` |
| `maker:issues:list-mine` | invoke | backend | `maker-ipc/my-issues.ts:107` |
| `maker:issues:snapshot-mine` | invoke | backend | `maker-ipc/my-issues.ts:101` |
| `maker:list-active` | invoke | contract | `maker-ipc/register.ts:22572` |
| `maker:list-agent-commands` | invoke | contract | `maker-ipc/register.ts:8277` |
| `maker:list-agent-skills` | invoke | contract | `maker-ipc/register.ts:8354` |
| `maker:list-available-agents` | invoke | contract | `maker-ipc/register.ts:7107` |
| `maker:list-customizations` | invoke | backend | `maker-ipc/register.ts:8637` |
| `maker:list-desktop-commands` | invoke | backend | `maker-ipc/register.ts:8248` |
| `maker:machine:status` | invoke | backend | `maker-ipc/register.ts:16323` |
| `maker:maker-memory:reset` | invoke | backend | `maker-ipc/register.ts:25701` |
| `maker:maker-memory:set-enabled` | invoke | backend | `maker-ipc/register.ts:25623` |
| `maker:mark-orca-role` | invoke | backend | `maker-ipc/register.ts:12177` |
| `maker:mcp:custom:create` | invoke | backend | `maker-ipc/mcpHandlers.ts:171` |
| `maker:mcp:custom:delete` | invoke | backend | `maker-ipc/mcpHandlers.ts:206` |
| `maker:mcp:custom:list` | invoke | backend | `maker-ipc/mcpHandlers.ts:121` |
| `maker:mcp:custom:refresh` | invoke | backend | `maker-ipc/mcpHandlers.ts:217` |
| `maker:mcp:custom:update` | invoke | backend | `maker-ipc/mcpHandlers.ts:196` |
| `maker:mcp:duplicates:choose` | invoke | backend | `maker-ipc/mcpHandlers.ts:110` |
| `maker:mcp:duplicates:list` | invoke | backend | `maker-ipc/mcpHandlers.ts:106` |
| `maker:memory:get` | invoke | backend | `maker-ipc/register.ts:25549` |
| `maker:memory:reset` | invoke | backend | `maker-ipc/register.ts:25593` |
| `maker:memory:reset-settings` | invoke | backend | `maker-ipc/register.ts:25671` |
| `maker:memory:set` | invoke | backend | `maker-ipc/register.ts:25591` |
| `maker:message:delete` | invoke | backend | `maker-ipc/messageDeleteHandler.ts:170` |
| `maker:model-catalog:read` | invoke | backend | `maker-ipc/register.ts:10492` |
| `maker:model-compaction:set` | invoke | backend | `maker-ipc/providerHandlers.ts:2245` |
| `maker:model-context-limit:get` | invoke | backend | `maker-ipc/providerHandlers.ts:2223` |
| `maker:model-context-limit:reset` | invoke | backend | `maker-ipc/providerHandlers.ts:2324` |
| `maker:model-context-limit:set` | invoke | backend | `maker-ipc/providerHandlers.ts:2291` |
| `maker:model-disable:set` | invoke | backend | `maker-ipc/providerHandlers.ts:1914` |
| `maker:model-favorites:apply` | invoke | backend | `maker-ipc/modelFavoritesSync.ts:114` |
| `maker:model-favorites:get` | invoke | backend | `maker-ipc/modelFavoritesSync.ts:110` |
| `maker:model-image-input:get` | invoke | backend | `maker-ipc/providerHandlers.ts:2181` |
| `maker:model-image-input:set` | invoke | backend | `maker-ipc/providerHandlers.ts:2205` |
| `maker:model-price-override:get` | invoke | backend | `maker-ipc/providerHandlers.ts:2048` |
| `maker:model-price-override:reset` | invoke | backend | `maker-ipc/providerHandlers.ts:2122` |
| `maker:model-price-override:set` | invoke | backend | `maker-ipc/providerHandlers.ts:2089` |
| `maker:model-visibility:sync` | invoke | backend | `maker-ipc/register.ts:6657` |
| `maker:navigate-session-tree` | invoke | backend | `maker-ipc/register.ts:25218` |
| `maker:orca:execution-devices` | invoke | backend | `maker-ipc/register.ts:16329` |
| `maker:orca:remote-worker:bridge` | invoke | backend | `maker-ipc/register.ts:10685` |
| `maker:orca:remote-worker:caps` | invoke | backend | `maker-ipc/orcaRemoteWorkerHost.ts:217` |
| `maker:orca:remote-worker:models` | invoke | backend | `maker-ipc/orcaRemoteWorkerHost.ts:218` |
| `maker:orca:remote-worker:open` | invoke | backend | `maker-ipc/orcaRemoteWorkerHost.ts:219` |
| `maker:orca:remote-worker:release` | invoke | backend | `maker-ipc/orcaRemoteWorkerHost.ts:220` |
| `maker:persist-turn-error-deferred` | invoke | backend | `maker-ipc/register.ts:22138` |
| `maker:pi-packages:list` | invoke | backend | `maker-ipc/register.ts:8423` |
| `maker:pi-packages:mutate` | invoke | backend | `maker-ipc/register.ts:8436` |
| `maker:pi-subagent:control` | invoke | backend | `maker-ipc/register.ts:7286` |
| `maker:plugin-setup:submit-inline` | invoke | backend | `maker-ipc/register.ts:22684` |
| `maker:plugins:clear-enabled` | invoke | backend | `maker-ipc/register.ts:25786` |
| `maker:plugins:clear-project-enabled` | invoke | backend | `maker-ipc/projectPluginPolicyHandlers.ts:50` |
| `maker:plugins:get-state` | invoke | backend | `maker-ipc/register.ts:25727` |
| `maker:plugins:list` | invoke | backend | `maker-ipc/pluginListHandler.ts:20` |
| `maker:plugins:set-enabled` | invoke | backend | `maker-ipc/register.ts:25759` |
| `maker:plugins:set-project-enabled` | invoke | backend | `maker-ipc/projectPluginPolicyHandlers.ts:31` |
| `maker:predict-prompt` | invoke | backend | `maker-ipc/title.ts:683` |
| `maker:project-automation:list-consents` | invoke | backend | `maker-ipc/project-automation.ts:94` |
| `maker:project-automation:pending-imports` | invoke | backend | `maker-ipc/project-automation.ts:85` |
| `maker:project-automation:reconcile` | invoke | backend | `maker-ipc/project-automation.ts:71` |
| `maker:project-automation:remove-schedule` | invoke | backend | `maker-ipc/project-automation.ts:138` |
| `maker:project-automation:revoke-consent` | invoke | backend | `maker-ipc/project-automation.ts:105` |
| `maker:project-automation:upsert-schedule` | invoke | backend | `maker-ipc/project-automation.ts:123` |
| `maker:provider:account-usage` | invoke | backend | `maker-ipc/providerHandlers.ts:2767` |
| `maker:provider:custom:create` | invoke | backend | `maker-ipc/providerHandlers.ts:2409` |
| `maker:provider:custom:delete` | invoke | backend | `maker-ipc/providerHandlers.ts:2757` |
| `maker:provider:custom:disconnect` | invoke | backend | `maker-ipc/providerHandlers.ts:3089` |
| `maker:provider:custom:update` | invoke | backend | `maker-ipc/providerHandlers.ts:2610` |
| `maker:provider:detect` | invoke | backend | `maker-ipc/providerHandlers.ts:2817` |
| `maker:provider:import:cancel` | invoke | backend | `maker-ipc/providerHandlers.ts:1500` |
| `maker:provider:import:confirm` | invoke | backend | `maker-ipc/providerHandlers.ts:1640` |
| `maker:provider:import:file` | invoke | backend | `maker-ipc/providerHandlers.ts:1450` |
| `maker:provider:import:local-edit` | invoke | backend | `maker-ipc/providerHandlers.ts:1438` |
| `maker:provider:import:local-scan` | invoke | backend | `maker-ipc/providerHandlers.ts:1397` |
| `maker:provider:import:preview` | invoke | backend | `maker-ipc/providerHandlers.ts:1477` |
| `maker:provider:list` | invoke | contract | `maker-ipc/providerHandlers.ts:1273` |
| `maker:provider:local-cli-scan` | invoke | backend | `maker-ipc/providerHandlers.ts:2919` |
| `maker:provider:models-auto-refresh` | invoke | backend | `maker-ipc/providerHandlers.ts:1302` |
| `maker:provider:models-fetch` | invoke | backend | `maker-ipc/providerHandlers.ts:2915` |
| `maker:provider:models-rediscover` | invoke | backend | `maker-ipc/providerHandlers.ts:2972` |
| `maker:provider:models-refresh` | invoke | backend | `maker-ipc/providerHandlers.ts:1278` |
| `maker:provider:oauth:cancel` | invoke | backend | `maker-ipc/providerHandlers.ts:3180` |
| `maker:provider:oauth:login` | invoke | backend | `maker-ipc/providerHandlers.ts:2986` |
| `maker:provider:oauth:logout` | invoke | backend | `maker-ipc/providerHandlers.ts:3125` |
| `maker:provider:order:set` | invoke | backend | `maker-ipc/providerHandlers.ts:1773` |
| `maker:provider:presentation:set` | invoke | backend | `maker-ipc/providerHandlers.ts:1725` |
| `maker:provider:presets` | invoke | backend | `maker-ipc/providerHandlers.ts:2762` |
| `maker:provider:remote-access:set` | invoke | backend | `maker-ipc/providerHandlers.ts:1919` |
| `maker:provider:run-location:set` | invoke | backend | `maker-ipc/providerHandlers.ts:1951` |
| `maker:provider:test-connection` | invoke | backend | `maker-ipc/providerHandlers.ts:2777` |
| `maker:regenerate-title` | invoke | backend | `maker-ipc/title.ts:631` |
| `maker:resolve-interaction` | invoke | contract | `maker-ipc/register.ts:22601` |
| `maker:retry-plugin-write-access` | invoke | backend | `maker-ipc/register.ts:15053` |
| `maker:review:start` | invoke | backend | `maker-ipc/reviewStartHandler.ts:291` |
| `maker:rewind:commit` | invoke | backend | `maker-ipc/rewind.ts:143` |
| `maker:rewind:preview` | invoke | backend | `maker-ipc/rewind.ts:114` |
| `maker:run` | invoke | backend | `maker-ipc/register.ts:25710` |
| `maker:runtime-plugins` | invoke | backend | `maker-ipc/register.ts:18448` |
| `maker:scan-at-resources` | invoke | backend | `maker-ipc/register.ts:8543` |
| `maker:schedule:create` | invoke | backend | `maker-ipc/schedule.ts:421` |
| `maker:schedule:create-from-template` | invoke | backend | `maker-ipc/schedule.ts:741` |
| `maker:schedule:delete` | invoke | backend | `maker-ipc/schedule.ts:468` |
| `maker:schedule:delete-run` | invoke | backend | `maker-ipc/schedule.ts:675` |
| `maker:schedule:generate-pre-run-hook` | invoke | backend | `maker-ipc/schedule.ts:529` |
| `maker:schedule:get` | invoke | backend | `maker-ipc/schedule.ts:416` |
| `maker:schedule:get-inflight-count` | invoke | backend | `maker-ipc/schedule.ts:683` |
| `maker:schedule:get-runtime-state` | invoke | backend | `maker-ipc/schedule.ts:691` |
| `maker:schedule:get-unread-count` | invoke | backend | `maker-ipc/schedule.ts:695` |
| `maker:schedule:list` | invoke | backend | `maker-ipc/schedule.ts:410` |
| `maker:schedule:list-cost-summaries` | invoke | backend | `maker-ipc/schedule.ts:673` |
| `maker:schedule:list-runs` | invoke | backend | `maker-ipc/schedule.ts:651` |
| `maker:schedule:list-sidebar-index-runs` | invoke | backend | `maker-ipc/schedule.ts:665` |
| `maker:schedule:list-templates` | invoke | backend | `maker-ipc/schedule.ts:735` |
| `maker:schedule:mark-all-runs-read` | invoke | backend | `maker-ipc/schedule.ts:699` |
| `maker:schedule:mark-run-read` | invoke | backend | `maker-ipc/schedule.ts:711` |
| `maker:schedule:mark-schedule-runs-read` | invoke | backend | `maker-ipc/schedule.ts:723` |
| `maker:schedule:pause` | invoke | backend | `maker-ipc/schedule.ts:487` |
| `maker:schedule:resume` | invoke | backend | `maker-ipc/schedule.ts:490` |
| `maker:schedule:run-now` | invoke | backend | `maker-ipc/schedule.ts:496` |
| `maker:schedule:script-capability-status` | invoke | backend | `maker-ipc/schedule.ts:839` |
| `maker:schedule:test-pre-run-hook` | invoke | backend | `maker-ipc/schedule.ts:627` |
| `maker:schedule:update` | invoke | backend | `maker-ipc/schedule.ts:436` |
| `maker:schedule:webhook-account` | invoke | backend | `maker-ipc/schedule.ts:796` |
| `maker:schedule:webhook-receiver` | invoke | backend | `maker-ipc/schedule.ts:780` |
| `maker:schedule:webhook-release` | invoke | backend | `maker-ipc/schedule.ts:797` |
| `maker:schedule:webhook-restore` | invoke | backend | `maker-ipc/schedule.ts:802` |
| `maker:schedule:webhook-rotate-url` | invoke | backend | `maker-ipc/schedule.ts:836` |
| `maker:schedule:webhook-set-secret` | invoke | backend | `maker-ipc/schedule.ts:831` |
| `maker:schedule:webhook-status` | invoke | backend | `maker-ipc/schedule.ts:771` |
| `maker:send` | invoke | contract | `maker-ipc/sessionSendHandler.ts:36` |
| `maker:session-background-activity` | invoke | backend | `maker-ipc/register.ts:7229` |
| `maker:session-background-activity:list` | invoke | backend | `maker-ipc/register.ts:7235` |
| `maker:session-background-tasks:list` | invoke | backend | `maker-ipc/register.ts:7366` |
| `maker:session-background-tasks:stop` | invoke | backend | `maker-ipc/stopSessionBackgroundTasksHandler.ts:25` |
| `maker:session-background-work:list` | invoke | backend | `maker-ipc/register.ts:7240` |
| `maker:session-in-turn` | invoke | backend | `maker-ipc/register.ts:7218` |
| `maker:session:commit-provisional` | invoke | backend | `maker-ipc/register.ts:19566` |
| `maker:session:disable-orca` | invoke | backend | `maker-ipc/register.ts:15867` |
| `maker:session:discard-provisional` | invoke | backend | `maker-ipc/register.ts:19541` |
| `maker:session:enable-orca` | invoke | backend | `maker-ipc/register.ts:15586` |
| `maker:session:handoff` | invoke | backend | `maker-ipc/sessionHandoffIpc.ts:160` |
| `maker:session:prewarm` | invoke | backend | `maker-ipc/register.ts:19527` |
| `maker:session:turn-active` | invoke | backend | `maker-ipc/register.ts:19407` |
| `maker:set-context-window-budget` | invoke | backend | `maker-ipc/register.ts:24884` |
| `maker:set-effort` | invoke | backend | `maker-ipc/register.ts:24717` |
| `maker:set-extra-dirs` | invoke | backend | `maker-ipc/register.ts:25512` |
| `maker:set-fast-mode` | invoke | backend | `maker-ipc/register.ts:25311` |
| `maker:set-model` | invoke | backend | `maker-ipc/sessionSetModelHandler.ts:13` |
| `maker:set-permission-mode` | invoke | backend | `maker-ipc/register.ts:24965` |
| `maker:set-plan-mode` | invoke | backend | `maker-ipc/register.ts:25032` |
| `maker:set-session-model-pref` | invoke | backend | `maker-ipc/register.ts:7602` |
| `maker:set-thinking-enabled` | invoke | backend | `maker-ipc/register.ts:25492` |
| `maker:set-writable-dirs` | invoke | backend | `maker-ipc/register.ts:25529` |
| `maker:side-chat:list:v1` | invoke | backend | `maker-ipc/fork.ts:51` |
| `maker:side-chat:v1` | invoke | backend | `maker-ipc/fork.ts:55` |
| `maker:steer` | invoke | backend | `maker-ipc/register.ts:19369` |
| `maker:switch-session-agent` | invoke | backend | `maker-ipc/sessionAgentSwitchHandler.ts:1684` |
| `maker:sync-new-maker-draft` | event | backend | `maker-ipc/register.ts:6650` |
| `maker:sync-provider-model-memory` | event | backend | `maker-ipc/register.ts:7099` |
| `maker:sync-session-model-pref` | event | backend | `maker-ipc/register.ts:7642` |
| `maker:sync-worker-creation-prefs` | event | backend | `maker-ipc/register.ts:7060` |
| `maker:team:end` | invoke | backend | `maker-ipc/register.ts:15989` |
| `maker:turn-change-set:apply` | invoke | backend | `maker-ipc/register.ts:7207` |
| `maker:turn-change-sets:get` | invoke | backend | `maker-ipc/register.ts:7120` |
| `maker:turn-change-sets:list` | invoke | contract | `maker-ipc/register.ts:7111` |
| `maker:usage:account` | invoke | backend | `maker-ipc/usageHandlers.ts:105` |
| `maker:usage:claude-subscription` | invoke | backend | `maker-ipc/usageHandlers.ts:164` |
| `maker:usage:codex-rate-limit-reset` | invoke | backend | `maker-ipc/usageHandlers.ts:136` |
| `maker:usage:codex-rate-limits` | invoke | backend | `maker-ipc/usageHandlers.ts:124` |
| `maker:usage:codex-reset-auto-use` | invoke | backend | `maker-ipc/usageHandlers.ts:153` |
| `maker:usage:device-rows` | invoke | backend | `maker-ipc/usageHandlers.ts:234` |
| `maker:usage:history` | invoke | backend | `maker-ipc/usageHandlers.ts:190` |
| `maker:usage:model-pricing` | invoke | contract | `maker-ipc/usageHandlers.ts:175` |
| `maker:usage:model-pricing-v2` | invoke | contract | `maker-ipc/usageHandlers.ts:180` |
| `maker:usage:reference-model-pricing` | invoke | contract | `maker-ipc/usageHandlers.ts:184` |
| `maker:usage:today` | invoke | backend | `maker-ipc/usageHandlers.ts:101` |
| `maker:usage:xai-subscription` | invoke | backend | `maker-ipc/usageHandlers.ts:169` |
| `maker:worker-roles:apply` | invoke | backend | `maker-ipc/register.ts:7087` |
| `maker:worker-roles:get` | invoke | backend | `maker-ipc/register.ts:7086` |
| `maker:worker:acknowledge-done` | invoke | backend | `maker-ipc/orcaWorkerControlHandlers.ts:49` |
| `maker:worker:archive` | invoke | backend | `maker-ipc/orcaWorkerControlHandlers.ts:52` |
| `maker:worker:create` | invoke | backend | `maker-ipc/register.ts:15879` |
| `maker:worker:dispatch-ui-assignment` | invoke | backend | `maker-ipc/register.ts:15654` |
| `maker:worker:idle` | invoke | backend | `maker-ipc/orcaWorkerControlHandlers.ts:46` |
| `maker:worker:list` | invoke | backend | `maker-ipc/register.ts:15944` |
| `maker:worker:project-context` | invoke | backend | `maker-ipc/register.ts:15874` |
| `maker:worker:project-label` | invoke | backend | `maker-ipc/register.ts:15875` |
| `maker:worker:switch-focus` | invoke | backend | `maker-ipc/register.ts:15950` |
| `maker:worker:update` | invoke | backend | `maker-ipc/orcaWorkerControlHandlers.ts:69` |
| `maker:working-status` | invoke | backend | `maker-ipc/workingStatus.ts:104` |
| `maker:write-plan-file` | invoke | backend | `maker-ipc/plan-write.ts:25` |
| `model-favorites:host-changed` | event | backend | `maker-ipc/modelFavoritesSync.ts:50` |
| `model-favorites:host-ready` | event | backend | `maker-ipc/modelFavoritesSync.ts:34` |
| `model-favorites:host-reply` | event | backend | `maker-ipc/modelFavoritesSync.ts:44` |
| `terminal:create` | invoke | backend | `maker-ipc/terminal-handlers.ts:77` |
| `terminal:dispose` | invoke | backend | `maker-ipc/terminal-handlers.ts:117` |
| `terminal:get-default-shell-pref` | invoke | backend | `maker-ipc/terminal-handlers.ts:144` |
| `terminal:list-available-shells` | invoke | backend | `maker-ipc/terminal-handlers.ts:140` |
| `terminal:resize` | invoke | backend | `maker-ipc/terminal-handlers.ts:109` |
| `terminal:restart` | invoke | backend | `maker-ipc/terminal-handlers.ts:122` |
| `terminal:set-default-shell-pref` | invoke | backend | `maker-ipc/terminal-handlers.ts:148` |
| `terminal:write` | invoke | backend | `maker-ipc/terminal-handlers.ts:102` |
| `worktree:cancel-precreated` | invoke | backend | `maker-ipc/precreatedWorktreeDiscardHandler.ts:124` 等 2 处 |
| `worktree:discard-precreated` | invoke | backend | `maker-ipc/precreatedWorktreeDiscardHandler.ts:123` 等 2 处 |

### mcp-apps

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `maker:mcp-apps:v1` | invoke | backend | `mcp-apps/ipc.ts:117` |

### mcp-integrations

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `browser-backend:get-health` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `mcp-integrations/browser.ts:755` |
| `browser-backend:get-state` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `mcp-integrations/browser.ts:751` |
| `browser-backend:open-extension-store` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `mcp-integrations/browser.ts:758` |
| `browser-backend:probe-source-read` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `mcp-integrations/browser.ts:757` |
| `browser-backend:recover` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `mcp-integrations/browser.ts:756` |
| `browser-backend:reset` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `mcp-integrations/browser.ts:754` |
| `browser-backend:set-kind` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `mcp-integrations/browser.ts:752` |
| `browser-backend:set-use-real-profile` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `mcp-integrations/browser.ts:753` |
| `rsb-browser-bridge:set-active-session` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `mcp-integrations/browser.ts:760` |

### menubar

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `menubar:get-state` | invoke | window（窗口外壳、窗口布局与多窗口） | `menubar/ipc.ts:10` |
| `menubar:set-enabled` | invoke | window（窗口外壳、窗口布局与多窗口） | `menubar/ipc.ts:14` |

### model-access

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `model-access:get-status` | invoke | contract | `model-access/index.ts:608` |
| `model-access:retry` | invoke | contract | `model-access/index.ts:618` |
| `model-access:rotate` | invoke | backend | `model-access/index.ts:625` |

### notificationService

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `notification:set-desktop-enabled` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `notificationService.ts:559` |
| `notification:show-session-event` | invoke | window（原生对话框、剪贴板、系统外壳与通知） | `notificationService.ts:568` |

### performance-trace

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `performance-trace:command` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `performance-trace/index.ts:100` |
| `performance-trace:events` | event | window（桌面安装包自身：更新、版本、日志与诊断） | `performance-trace/index.ts:118` |

### plugin-contributions

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `plugin-contributions:cancel` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:cancel-review` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:detail` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:discard` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:list` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:mark-review-read` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:prepare` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:releases` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:review-updates` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:set-anonymity` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:status` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:submission` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:submit` | invoke | backend | `plugin-contributions/registerIpc.ts:18` |

### plugin-market

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `plugin-market:add-source` | invoke | backend | `plugin-market/registerIpc.ts:335` |
| `plugin-market:consume-removal-notice` | invoke | backend | `plugin-market/registerIpc.ts:186` |
| `plugin-market:detail` | invoke | backend | `plugin-market/registerIpc.ts:190` |
| `plugin-market:git-preflight` | invoke | backend | `plugin-market/registerIpc.ts:400` |
| `plugin-market:install` | invoke | backend | `plugin-market/registerIpc.ts:254` |
| `plugin-market:install-local-share` | invoke | backend | `plugin-market/registerIpc.ts:204` |
| `plugin-market:list-sources` | invoke | backend | `plugin-market/registerIpc.ts:331` |
| `plugin-market:local-icons` | invoke | backend | `plugin-market/registerIpc.ts:231` |
| `plugin-market:local-share-detail` | invoke | backend | `plugin-market/registerIpc.ts:200` |
| `plugin-market:lookup` | invoke | backend | `plugin-market/registerIpc.ts:181` |
| `plugin-market:pick-local-source` | invoke | backend | `plugin-market/registerIpc.ts:376` |
| `plugin-market:prepare-local-share` | invoke | backend | `plugin-market/registerIpc.ts:210` |
| `plugin-market:prepare-share` | invoke | backend | `plugin-market/registerIpc.ts:196` |
| `plugin-market:query` | invoke | backend | `plugin-market/registerIpc.ts:172` |
| `plugin-market:recommendations` | invoke | backend | `plugin-market/registerIpc.ts:177` |
| `plugin-market:refresh-source` | invoke | backend | `plugin-market/registerIpc.ts:394` |
| `plugin-market:release-local-share` | invoke | backend | `plugin-market/registerIpc.ts:225` |
| `plugin-market:remove-source` | invoke | backend | `plugin-market/registerIpc.ts:388` |
| `plugin-market:snapshot` | invoke | backend | `plugin-market/registerIpc.ts:163` |
| `plugin-market:uninstall` | invoke | backend | `plugin-market/registerIpc.ts:322` |

### plugin-publisher

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `plugin-publisher:cancel` | invoke | backend | `plugin-publisher/registerIpc.ts:54` |
| `plugin-publisher:list-mine` | invoke | backend | `plugin-publisher/registerIpc.ts:64` |
| `plugin-publisher:resolve-confirm` | invoke | backend | `plugin-publisher/registerIpc.ts:80` |
| `plugin-publisher:start` | invoke | backend | `plugin-publisher/registerIpc.ts:34` |
| `plugin-publisher:status` | invoke | backend | `plugin-publisher/registerIpc.ts:42` |

### process-monitor

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `process-monitor:subscribe` | invoke | backend | `process-monitor/ipc.ts:225` |
| `process-monitor:terminate-agent` | invoke | backend | `process-monitor/ipc.ts:253` |
| `process-monitor:unsubscribe` | invoke | backend | `process-monitor/ipc.ts:248` |

### projectOrderStore

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `sidebar-settings:apply-project-order` | invoke | backend | `projectOrderStore.ts:178` |
| `sidebar-settings:get-project-order` | invoke | backend | `projectOrderStore.ts:174` |

### provider-group

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `provider-group:command` | invoke | backend | `provider-group/ipc.ts:386` |

### region-screenshot

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `recording-audio:data` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/recordingAudio.ts:20` |
| `recording-audio:register` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/recordingAudio.ts:14` |
| `recording-audio:state` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/recordingAudio.ts:26` |
| `recording-preview:close` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/recordingPreview.ts:111` |
| `recording-preview:copy` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/recordingPreview.ts:124` |
| `recording-preview:failed` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/recordingPreview.ts:107` |
| `recording-preview:minimize` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/recordingPreview.ts:114` |
| `recording-preview:painted` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/recordingPreview.ts:108` |
| `recording-preview:ready` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/recordingPreview.ts:101` |
| `recording-preview:save` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/recordingPreview.ts:117` |
| `region-screenshot-editor:cancel` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/editor.ts:135` |
| `region-screenshot-editor:export` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/editor.ts:138` |
| `region-screenshot-editor:failed` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/editor.ts:123` |
| `region-screenshot-editor:minimize` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/editor.ts:120` |
| `region-screenshot-editor:painted` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/editor.ts:132` |
| `region-screenshot-editor:ready` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/editor.ts:126` |
| `region-screenshot-editor:set-translation-language` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/editor.ts:115` |
| `region-screenshot-pin:command` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/pins.ts:285` |
| `region-screenshot-pin:drag-move` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/pins.ts:261` |
| `region-screenshot-pin:drag-start` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/pins.ts:255` |
| `region-screenshot-pin:menu` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/pins.ts:281` |
| `region-screenshot-pin:opacity` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/pins.ts:276` |
| `region-screenshot-pin:painted` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/pins.ts:251` |
| `region-screenshot-pin:shell-ready` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/pins.ts:235` |
| `region-screenshot-pin:unlock-hover` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/pins.ts:290` |
| `region-screenshot-pin:zoom` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/pins.ts:270` |
| `region-screenshot:abandon` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:193` |
| `region-screenshot:audio-read` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:166` |
| `region-screenshot:audio-start` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:165` |
| `region-screenshot:audio-stop` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:167` |
| `region-screenshot:auto-scroll` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:170` |
| `region-screenshot:cancel` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:190` |
| `region-screenshot:compose-take` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/compose.ts:79` |
| `region-screenshot:copy-text` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:187` |
| `region-screenshot:elements-at` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:200` |
| `region-screenshot:export` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:205` |
| `region-screenshot:focused` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:181` |
| `region-screenshot:live-edit` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:174` |
| `region-screenshot:live-frame` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:172` |
| `region-screenshot:live-hold` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:175` |
| `region-screenshot:live-save` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:173` |
| `region-screenshot:live-start` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:171` |
| `region-screenshot:painted` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:178` |
| `region-screenshot:recording-controls` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:168` |
| `region-screenshot:recording-preview` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:169` |
| `region-screenshot:selection-start` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:184` |
| `region-screenshot:set-translation-language` | invoke | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:209` |
| `region-screenshot:shell-ready` | event | window（本机屏幕截取、录制与远程桌面） | `region-screenshot/index.ts:177` |

### relaunchBusyActivityIpc

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `update-relaunch:blocking-activity` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `relaunchBusyActivityIpc.ts:86` |
| `update-relaunch:blocking-summary` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `relaunchBusyActivityIpc.ts:97` |

### remote-desktop

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `away-guard:get-state` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/awayGuardService.ts:268` |
| `away-guard:preview` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/awayGuardService.ts:289` |
| `away-guard:set-delay` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/awayGuardService.ts:282` |
| `away-guard:set-enabled` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/awayGuardService.ts:272` |
| `remote-desktop:capture-stop` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1453` |
| `remote-desktop:channel-request` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1525` |
| `remote-desktop:dismiss-permission-guide` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1369` |
| `remote-desktop:enable` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1348` |
| `remote-desktop:host-input` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1504` |
| `remote-desktop:host-reply` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1457` |
| `remote-desktop:live-screen-frames` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1289` |
| `remote-desktop:native-audio` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1262` |
| `remote-desktop:native-frame` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1241` |
| `remote-desktop:open-permission` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1363` |
| `remote-desktop:permissions` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1359` |
| `remote-desktop:register-host` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1377` |
| `remote-desktop:state` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1313` |
| `remote-desktop:stop` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1373` |
| `remote-desktop:view-heartbeat` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1307` |
| `remote-desktop:windows-support` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop/index.ts:1328` |

### remote-desktop-viewer

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `remote-desktop-viewer:channel-reply` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:378` |
| `remote-desktop-viewer:clipboard` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:407` |
| `remote-desktop-viewer:clipboard-sync` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:395` |
| `remote-desktop-viewer:close` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:352` |
| `remote-desktop-viewer:credential` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:418` |
| `remote-desktop-viewer:fullscreen` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:498` |
| `remote-desktop-viewer:ice` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:430` |
| `remote-desktop-viewer:input-focus` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:503` |
| `remote-desktop-viewer:open` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:341` |
| `remote-desktop-viewer:preferences` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:362` |
| `remote-desktop-viewer:presented` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:349` |
| `remote-desktop-viewer:ready` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:346` |
| `remote-desktop-viewer:request` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:402` |
| `remote-desktop-viewer:resize` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:445` |
| `remote-desktop-viewer:resolution` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:369` |
| `remote-desktop-viewer:safety` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:386` |
| `remote-desktop-viewer:state` | invoke | window（本机屏幕截取、录制与远程桌面） | `remote-desktop-viewer/windows.ts:345` |

### remote-ssh

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `maker:remote-ssh:add` | invoke | backend | `remote-ssh/index.ts:1470` |
| `maker:remote-ssh:add-key-to-agent` | invoke | backend | `remote-ssh/index.ts:1952` |
| `maker:remote-ssh:build-install-cmd` | invoke | backend | `remote-ssh/index.ts:1974` |
| `maker:remote-ssh:build-install-cmd-inline` | invoke | backend | `remote-ssh/index.ts:1991` |
| `maker:remote-ssh:cc-mgr-dismiss-pending-upgrade` | invoke | backend | `remote-ssh/index.ts:2149` |
| `maker:remote-ssh:cc-mgr-force-upgrade` | invoke | backend | `remote-ssh/index.ts:2086` |
| `maker:remote-ssh:cc-mgr-list-pending-upgrades` | invoke | backend | `remote-ssh/index.ts:2145` |
| `maker:remote-ssh:check-codex-auth` | invoke | backend | `remote-ssh/index.ts:1826` |
| `maker:remote-ssh:connect` | invoke | backend | `remote-ssh/index.ts:1522` |
| `maker:remote-ssh:disconnect` | invoke | backend | `remote-ssh/index.ts:1546` |
| `maker:remote-ssh:generate-key` | invoke | backend | `remote-ssh/index.ts:1923` |
| `maker:remote-ssh:has-any-auto-connect-host` | invoke | backend | `remote-ssh/index.ts:2058` |
| `maker:remote-ssh:install-agent` | invoke | backend | `remote-ssh/index.ts:1598` |
| `maker:remote-ssh:list` | invoke | backend | `remote-ssh/index.ts:1459` |
| `maker:remote-ssh:list-codex-models` | invoke | backend | `remote-ssh/index.ts:1821` |
| `maker:remote-ssh:list-local-keys` | invoke | backend | `remote-ssh/index.ts:1914` |
| `maker:remote-ssh:list-remote-dir` | invoke | backend | `remote-ssh/index.ts:2066` |
| `maker:remote-ssh:mkdir-p-remote` | invoke | backend | `remote-ssh/index.ts:2027` |
| `maker:remote-ssh:probe-agent` | invoke | backend | `remote-ssh/index.ts:1588` |
| `maker:remote-ssh:read-pubkey` | invoke | backend | `remote-ssh/index.ts:1963` |
| `maker:remote-ssh:reload-config` | invoke | backend | `remote-ssh/index.ts:1465` |
| `maker:remote-ssh:remove` | invoke | backend | `remote-ssh/index.ts:1480` |
| `maker:remote-ssh:review-host-key` | invoke | backend | `remote-ssh/index.ts:1486` |
| `maker:remote-ssh:run-agent-one-shot` | invoke | backend | `remote-ssh/index.ts:1690` |
| `maker:remote-ssh:set-auto-connect` | invoke | backend | `remote-ssh/index.ts:2042` |
| `maker:remote-ssh:stat-remote-path` | invoke | backend | `remote-ssh/index.ts:2015` |
| `maker:remote-ssh:sync-codex-auth` | invoke | backend | `remote-ssh/index.ts:1846` |
| `maker:remote-ssh:uninstall-agent` | invoke | backend | `remote-ssh/index.ts:1665` |
| `maker:remote-ssh:update` | invoke | backend | `remote-ssh/index.ts:1475` |

### remotePrecreatedWorktreeLedger

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `remote-precreated-worktree-ledger:forget` | invoke | backend | `remotePrecreatedWorktreeLedger.ts:252` |
| `remote-precreated-worktree-ledger:list` | invoke | backend | `remotePrecreatedWorktreeLedger.ts:233` |
| `remote-precreated-worktree-ledger:register` | invoke | backend | `remotePrecreatedWorktreeLedger.ts:240` |

### resource-usage-window

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `resource-usage-window:close` | invoke | window（窗口外壳、窗口布局与多窗口） | `resource-usage-window/ipc.ts:28` |
| `resource-usage-window:open` | invoke | window（窗口外壳、窗口布局与多窗口） | `resource-usage-window/ipc.ts:23` |
| `resource-usage-window:presentation-ready` | invoke | window（窗口外壳、窗口布局与多窗口） | `resource-usage-window/ipc.ts:38` |
| `resource-usage-window:renderer-ready` | invoke | window（窗口外壳、窗口布局与多窗口） | `resource-usage-window/ipc.ts:33` |

### right-sidebar-window

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `maker:rsb-window:close` | invoke | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:395` |
| `maker:rsb-window:get-context` | invoke | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:428` |
| `maker:rsb-window:get-state` | invoke | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:383` |
| `maker:rsb-window:open` | invoke | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:385` |
| `maker:rsb-window:ready` | invoke | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:430` |
| `maker:rsb-window:send-command` | invoke | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:471` |
| `maker:rsb-window:set-context` | event | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:482` |
| `maker:rsb-window:set-detached` | invoke | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:402` |
| `rsb-window:presentation-ready` | invoke | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:451` |
| `rsb-window:refresh-context` | invoke | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:460` |
| `rsb-window:renderer-ready` | invoke | window（窗口外壳、窗口布局与多窗口） | `right-sidebar-window/ipc.ts:442` |

### rsb-browser-bridge

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `rsb-browser-bridge:capture-screenshot` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/ipc.ts:242` |
| `rsb-browser-bridge:capture-screenshot-data` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/ipc.ts:253` |
| `rsb-browser-bridge:force-kill` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/ipc.ts:289` |
| `rsb-browser-bridge:release` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/ipc.ts:146` |
| `rsb-browser-bridge:report` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/ipc.ts:102` |
| `rsb-browser-bridge:set-foreground` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/ipc.ts:266` |
| `rsb-browser-bridge:snapshot` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/ipc.ts:174` |
| `rsb-browser-bridge:tab-op-result` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/renderer-bridge.ts:79` |
| `rsb-native-popup:claim` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/native-popup-surfaces.ts:383` |
| `rsb-native-popup:close` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/native-popup-surfaces.ts:428` |
| `rsb-native-popup:command` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/native-popup-surfaces.ts:413` |
| `rsb-native-popup:set-bounds` | invoke | window（图形能力，由窗口替 Agent 执行（平台 RPC）） | `rsb-browser-bridge/native-popup-surfaces.ts:394` |

### session-import

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `local-db:session-import:cancel` | invoke | backend | `session-import/ipc.ts:50` |
| `local-db:session-import:relocate` | invoke | backend | `session-import/ipc.ts:55` |
| `local-db:session-import:scan` | invoke | backend | `session-import/ipc.ts:35` |
| `local-db:session-import:start` | invoke | backend | `session-import/ipc.ts:40` |
| `local-db:session-import:status` | invoke | backend | `session-import/ipc.ts:44` |

### setup-migration

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `setup-migration:apply` | invoke | backend | `setup-migration/register.ts:693` |
| `setup-migration:dismiss` | invoke | backend | `setup-migration/register.ts:710` |
| `setup-migration:host-ready` | event | backend | `setup-migration/rendererPrefsHost.ts:47` |
| `setup-migration:host-reply` | event | backend | `setup-migration/rendererPrefsHost.ts:57` |
| `setup-migration:preview` | invoke | backend | `setup-migration/register.ts:686` |
| `setup-migration:sources` | invoke | backend | `setup-migration/register.ts:682` |
| `setup-migration:state` | invoke | backend | `setup-migration/register.ts:706` |

### sidebar-tab-window

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `maker:sidebar-tab-window:close-for-tab` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebar-tab-window/ipc.ts:197` |
| `maker:sidebar-tab-window:focus` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebar-tab-window/ipc.ts:177` |
| `maker:sidebar-tab-window:get-state` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebar-tab-window/ipc.ts:160` |
| `maker:sidebar-tab-window:open` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebar-tab-window/ipc.ts:165` |
| `maker:sidebar-tab-window:return-tab` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebar-tab-window/ipc.ts:187` |
| `sidebar-tab-window:adopt-tab` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebar-tab-window/ipc.ts:239` |
| `sidebar-tab-window:get-assignment` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebar-tab-window/ipc.ts:211` |
| `sidebar-tab-window:merge-back` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebar-tab-window/ipc.ts:226` |
| `sidebar-tab-window:presentation-ready` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebar-tab-window/ipc.ts:221` |
| `sidebar-tab-window:renderer-ready` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebar-tab-window/ipc.ts:216` |

### sidebarSettingsStore

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `sidebar-settings:claim-renderer-legacy-owner-sync` | event | backend | `sidebarSettingsStore.ts:903` |
| `sidebar-settings:load-snapshot-sync` | event | backend | `sidebarSettingsStore.ts:907` |
| `sidebar-settings:save-pinned-order` | invoke | backend | `sidebarSettingsStore.ts:911` |
| `sidebar-settings:set-main-view-hidden` | invoke | backend | `sidebarSettingsStore.ts:919` |
| `sidebar-settings:set-project-hidden` | invoke | backend | `sidebarSettingsStore.ts:915` |

### sidebarWindowExpansionIpc

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `window-sidebar-expansion` | invoke | window（窗口外壳、窗口布局与多窗口） | `sidebarWindowExpansionIpc.ts:24` |

### skillhub

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `skillhub:cancel-install` | invoke | backend | `skillhub/registerIpc.ts:1156` |
| `skillhub:cancel-publish` | invoke | backend | `skillhub/registerIpc.ts:1038` |
| `skillhub:compare-published` | invoke | backend | `skillhub/registerIpc.ts:867` |
| `skillhub:delete-published` | invoke | backend | `skillhub/registerIpc.ts:736` |
| `skillhub:get-folder-hash` | invoke | backend | `skillhub/registerIpc.ts:903` |
| `skillhub:get-my-depts` | invoke | backend | `skillhub/registerIpc.ts:786` |
| `skillhub:get-published-files` | invoke | backend | `skillhub/registerIpc.ts:674` |
| `skillhub:get-published-visibility` | invoke | backend | `skillhub/registerIpc.ts:774` |
| `skillhub:get-scan-status` | invoke | backend | `skillhub/registerIpc.ts:837` |
| `skillhub:get-snapshot-diff` | invoke | backend | `skillhub/registerIpc.ts:918` |
| `skillhub:get-usage-diagnosis-context` | invoke | backend | `skillhub/registerIpc.ts:977` |
| `skillhub:get-usage-summary` | invoke | backend | `skillhub/registerIpc.ts:942` |
| `skillhub:has-snapshot` | invoke | backend | `skillhub/registerIpc.ts:933` |
| `skillhub:import-local` | invoke | backend | `skillhub/registerIpc.ts:1084` |
| `skillhub:info` | invoke | backend | `skillhub/registerIpc.ts:658` |
| `skillhub:install` | invoke | backend | `skillhub/registerIpc.ts:1129` |
| `skillhub:list-categories` | invoke | backend | `skillhub/registerIpc.ts:806` |
| `skillhub:list-children` | invoke | backend | `skillhub/registerIpc.ts:529` |
| `skillhub:list-market` | invoke | backend | `skillhub/registerIpc.ts:645` |
| `skillhub:list-published-versions` | invoke | backend | `skillhub/registerIpc.ts:705` |
| `skillhub:list-user-teams` | invoke | backend | `skillhub/registerIpc.ts:823` |
| `skillhub:pick-local` | invoke | backend | `skillhub/registerIpc.ts:1045` |
| `skillhub:publish` | invoke | backend | `skillhub/registerIpc.ts:1012` |
| `skillhub:read-published-file` | invoke | backend | `skillhub/registerIpc.ts:689` |
| `skillhub:read-raw` | invoke | backend | `skillhub/registerIpc.ts:560` |
| `skillhub:read-sibling-file` | invoke | backend | `skillhub/registerIpc.ts:543` |
| `skillhub:read-skill` | invoke | backend | `skillhub/registerIpc.ts:514` |
| `skillhub:reconcile-mine-registry` | invoke | backend | `skillhub/registerIpc.ts:1277` |
| `skillhub:registry:get-by-name` | invoke | backend | `skillhub/registerIpc.ts:1292` |
| `skillhub:rename-local` | invoke | backend | `skillhub/registerIpc.ts:603` |
| `skillhub:retry-uninstall-cleanup` | invoke | backend | `skillhub/registerIpc.ts:1255` |
| `skillhub:scan` | invoke | backend | `skillhub/registerIpc.ts:448` |
| `skillhub:set-enabled` | invoke | backend | `skillhub/registerIpc.ts:1163` |
| `skillhub:set-published-visibility` | invoke | backend | `skillhub/registerIpc.ts:758` |
| `skillhub:start-scan-poll` | invoke | backend | `skillhub/registerIpc.ts:860` |
| `skillhub:stop-scan-poll` | invoke | backend | `skillhub/registerIpc.ts:854` |
| `skillhub:sync` | invoke | backend | `skillhub/registerIpc.ts:632` |
| `skillhub:uninstall` | invoke | backend | `skillhub/registerIpc.ts:1194` |
| `skillhub:unpublish-published` | invoke | backend | `skillhub/registerIpc.ts:747` |
| `skillhub:update-published` | invoke | backend | `skillhub/registerIpc.ts:722` |
| `skillhub:validate-frontmatter` | invoke | backend | `skillhub/registerIpc.ts:590` |
| `skillhub:write-file` | invoke | backend | `skillhub/registerIpc.ts:573` |

### subscription-accounts

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `maker:subscription-accounts` | invoke | backend | `subscription-accounts/ipc.ts:50` |
| `maker:subscription-pool:quota` | invoke | backend | `subscription-accounts/ipc.ts:34` |

### task-migration

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `task-copy:request` | invoke | backend | `task-migration/service.ts:1494` |

### updateService

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `update-auto-settings-get` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2426` |
| `update-auto-settings-reset` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2443` |
| `update-auto-settings-set` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2430` |
| `update-channel-probe-beta` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2520` |
| `update-channel-relaunch` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2530` |
| `update-channel-settings-get` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2454` |
| `update-channel-settings-reset` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2496` |
| `update-channel-settings-set` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2459` |
| `update-check-now` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2606` |
| `update-check-startup` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2620` |
| `update-get-status` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2422` |
| `update-harness-prepare` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2543` |
| `update-harness-relaunch` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2567` |
| `update-move-to-applications` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2594` |
| `update-relaunch` | event | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2388` |
| `update-relaunch-auto` | invoke | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2402` |
| `update-set-relaunch-theme` | event | window（桌面安装包自身：更新、版本、日志与诊断） | `updateService.ts:2588` |

### voice-conversation

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `voice-conversation:audio` | event | window（本机输入设备与语音） | `voice-conversation/index.ts:286` |
| `voice-conversation:call-command` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:call-publish` | event | window（本机输入设备与语音） | `voice-conversation/index.ts:351` |
| `voice-conversation:call-status` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:classify-exit` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:end` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:finish-utterance` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:interrupt` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:models` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:preference` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:preview` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:promote-turn` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:read-preview` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:read-speech` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:set-input-muted` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:set-preference` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:speak` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:start` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:start-playback` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:stop-preview` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:submit-turn` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |
| `voice-conversation:voices` | invoke | window（本机输入设备与语音） | `voice-conversation/index.ts:172` |

### voice-input

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `voice-input:audio` | event | window（本机输入设备与语音） | `voice-input/index.ts:2559` |
| `voice-input:audio-drain` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2565` |
| `voice-input:benchmark-fixture-audio` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2015` |
| `voice-input:cancel` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2591` |
| `voice-input:consume-shortcut-recovery-failure` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1448` |
| `voice-input:data:get` | event | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:750` |
| `voice-input:data:migrate-legacy` | event | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:754` |
| `voice-input:dictionary-learning:advise` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2145` |
| `voice-input:dictionary-learning:record-actions` | invoke | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:855` |
| `voice-input:dictionary-toast-close` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1529` |
| `voice-input:dictionary-toast-show` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1519` |
| `voice-input:dictionary:add-entry` | invoke | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:784` |
| `voice-input:dictionary:delete-entries` | invoke | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:770` |
| `voice-input:dictionary:edit-entry` | invoke | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:829` |
| `voice-input:dictionary:import-entries` | invoke | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:795` |
| `voice-input:dictionary:rename-entry` | invoke | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:814` |
| `voice-input:get-microphone-permission-cached` | event | window（本机输入设备与语音） | `voice-input/microphonePermissionIpc.ts:23` |
| `voice-input:get-readiness` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2053` |
| `voice-input:get-readiness-cached` | event | window（本机输入设备与语音） | `voice-input/index.ts:2011` |
| `voice-input:get-system-permissions` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2036` |
| `voice-input:get-system-permissions-cached` | event | window（本机输入设备与语音） | `voice-input/index.ts:2007` |
| `voice-input:global-overlay-close` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1284` |
| `voice-input:global-overlay-drag-end` | event | window（本机输入设备与语音） | `voice-input/global.ts:1356` |
| `voice-input:global-overlay-drag-move` | event | window（本机输入设备与语音） | `voice-input/global.ts:1340` |
| `voice-input:global-overlay-drag-start` | event | window（本机输入设备与语音） | `voice-input/global.ts:1331` |
| `voice-input:global-overlay-position-reset` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1378` |
| `voice-input:global-overlay-ready` | event | window（本机输入设备与语音） | `voice-input/global.ts:1534` |
| `voice-input:global-overlay-show-passive` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1296` |
| `voice-input:global-paste` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1247` |
| `voice-input:global-restore-target-focus` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1555` |
| `voice-input:global-shortcut-claim` | event | window（本机输入设备与语音） | `voice-input/global.ts:1394` |
| `voice-input:global-shortcut:set` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1103` |
| `voice-input:history:delete` | event | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:902` |
| `voice-input:history:get` | event | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:869` |
| `voice-input:history:get-for-refinement` | event | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:873` |
| `voice-input:history:record` | event | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:881` |
| `voice-input:history:update` | event | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:889` |
| `voice-input:model-selection:get` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2098` |
| `voice-input:model-selection:reload` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2135` |
| `voice-input:model-selection:set` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2104` |
| `voice-input:modifier-shortcut-recording:start` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1191` |
| `voice-input:modifier-shortcut-recording:stop` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1235` |
| `voice-input:mute-system-audio` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2156` |
| `voice-input:open-accessibility-settings` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1415` |
| `voice-input:open-input-monitoring-settings` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1460` |
| `voice-input:open-microphone-settings` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2040` |
| `voice-input:open-settings` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1307` |
| `voice-input:prewarm` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:1991` |
| `voice-input:request-input-monitoring-permission` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1496` |
| `voice-input:request-microphone-permission` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2026` |
| `voice-input:restore-system-audio` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2168` |
| `voice-input:set-renderer-microphone-permission-verified` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2001` |
| `voice-input:settings:update` | invoke | window（本机输入设备与语音） | `voice-input/VoiceInputDataStore.ts:762` |
| `voice-input:settings:update-shortcut` | invoke | window（本机输入设备与语音） | `voice-input/global.ts:1158` |
| `voice-input:speaker:cancel-download` | invoke | window（本机输入设备与语音） | `voice-input/speaker/index.ts:228` |
| `voice-input:speaker:delete-profile` | invoke | window（本机输入设备与语音） | `voice-input/speaker/index.ts:240` |
| `voice-input:speaker:download-models` | invoke | window（本机输入设备与语音） | `voice-input/speaker/index.ts:222` |
| `voice-input:speaker:enroll` | invoke | window（本机输入设备与语音） | `voice-input/speaker/index.ts:234` |
| `voice-input:speaker:get-status` | invoke | window（本机输入设备与语音） | `voice-input/speaker/index.ts:218` |
| `voice-input:start` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2551` |
| `voice-input:stop` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2567` |
| `voice-input:test-connection` | invoke | window（本机输入设备与语音） | `voice-input/index.ts:2059` |

### wecomGroupNotification

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `wecomGroupNotification:clear` | invoke | backend | `wecomGroupNotification.ts:327` |
| `wecomGroupNotification:get-state` | invoke | backend | `wecomGroupNotification.ts:295` |
| `wecomGroupNotification:save-and-test` | invoke | backend | `wecomGroupNotification.ts:300` |
| `wecomGroupNotification:set-enabled` | invoke | backend | `wecomGroupNotification.ts:322` |
| `wecomGroupNotification:test` | invoke | backend | `wecomGroupNotification.ts:313` |

### worklouder-codex

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `codex-micro-guard:get-state` | invoke | window（本机输入设备与语音） | `worklouder-codex/index.ts:318` |
| `codex-micro-guard:recover` | invoke | window（本机输入设备与语音） | `worklouder-codex/index.ts:322` |
| `codex-micro-guard:set-enabled` | invoke | window（本机输入设备与语音） | `worklouder-codex/index.ts:319` |
| `worklouder-codex:get-state` | invoke | window（本机输入设备与语音） | `worklouder-codex/index.ts:294` |
| `worklouder-codex:open-input-monitoring-settings` | invoke | window（本机输入设备与语音） | `worklouder-codex/index.ts:301` |
| `worklouder-codex:probe` | invoke | window（本机输入设备与语音） | `worklouder-codex/index.ts:304` |
| `worklouder-codex:publish-tasks` | invoke | window（本机输入设备与语音） | `worklouder-codex/index.ts:305` |
| `worklouder-codex:reset-settings` | invoke | window（本机输入设备与语音） | `worklouder-codex/index.ts:298` |
| `worklouder-codex:set-layout-preview` | invoke | window（本机输入设备与语音） | `worklouder-codex/index.ts:308` |
| `worklouder-codex:set-settings` | invoke | window（本机输入设备与语音） | `worklouder-codex/index.ts:295` |

### worktree

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `worktree:branch-sync-status` | invoke | backend | `worktree/index.ts:71` |
| `worktree:create` | invoke | backend | `worktree/index.ts:74` |
| `worktree:detect-cwd` | invoke | backend | `worktree/index.ts:78` |
| `worktree:get-for-session` | invoke | backend | `worktree/index.ts:88` |
| `worktree:list-all` | invoke | backend | `worktree/index.ts:92` |
| `worktree:list-branches` | invoke | backend | `worktree/index.ts:135` |
| `worktree:removal-preview` | invoke | backend | `worktree/index.ts:146` |
| `worktree:restore-for-session` | invoke | backend | `worktree/index.ts:156` |
| `worktree:restore-status` | invoke | backend | `worktree/index.ts:151` |
| `worktree:reveal` | invoke | backend | `worktree/index.ts:94` |
| `worktree:suggest-name` | invoke | backend | `worktree/index.ts:131` |
| `worktree:sync-branch` | invoke | backend | `worktree/index.ts:72` |

### xbox-gamepad

| 通道 | 类型 | 分类 | 注册位置 |
|---|---|---|---|
| `xbox-gamepad:get-state` | invoke | window（本机输入设备与语音） | `xbox-gamepad/index.ts:216` |
| `xbox-gamepad:probe` | invoke | window（本机输入设备与语音） | `xbox-gamepad/index.ts:223` |
| `xbox-gamepad:reset-settings` | invoke | window（本机输入设备与语音） | `xbox-gamepad/index.ts:220` |
| `xbox-gamepad:set-layout-preview` | invoke | window（本机输入设备与语音） | `xbox-gamepad/index.ts:224` |
| `xbox-gamepad:set-settings` | invoke | window（本机输入设备与语音） | `xbox-gamepad/index.ts:217` |
