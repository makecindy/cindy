# Host 通道覆盖清单（脚本生成）

> 由 `node scripts/host-channel-coverage.mjs` 生成，不要手工修改。
> 源码提交：`664d86d4bd`。归属规则见下方「归属规则」，正本在脚本的 `OWNERSHIP_RULES`。

统计对象是桌面主进程（`apps/desktop/src/main`，不含测试）里所有 `ipcMain.handle/on`
及其包装函数注册的通道；同名通道按 invoke / event 各计一次。

| 分类 | 含义 | 通道数 |
|---|---|---:|
| contract | 已在 Host 通道合同里，窗口做客户端时转发给 Host | 61 |
| client | 客户端模式自己的通道（连接状态、重连） | 2 |
| **A** | 必须由后台处理：读写后台持有的数据或运行状态 | 941 |
| **B** | 永久留在窗口：只能在 Electron／图形界面里做 | 363 |
| **C** | 待定，见各条原因 | 87 |
| 合计 | | 1454 |

判定依据：A 类 829 条按规则、112 条按默认（未登记前缀且处理函数没用窗口 API）；C 类 68 条按规则、19 条按依赖（后台领域或未登记前缀，但处理函数用到窗口 API）。

转发适配器 2 处（把通道原样转给另一个注册表，通道已在调用处计入）：
`apps/desktop/src/main/maker-ipc/electronIpcRegistry.ts:14`、`apps/desktop/src/main/maker-ipc/register.ts:19339`

合同里有、但桌面主进程没有注册的通道 4 个（Host 独有或桌面已改名）：

`auth:get-state`、`maker:commit-provisional-session`、`maker:discard-provisional-session`、`plugin-market:list-installed`

## 归属规则

按顺序匹配，先中先得；通道名或注册模块（`apps/desktop/src/main` 下的路径）命中即算。B、C 规则直接定类；
A 规则只标出领域，处理函数（及其调用的两层桌面源码函数）若用到下面的窗口 API 则改判 C；
没有命中任何规则的通道：用到窗口 API 判 C，否则判 A。

| 归属 | 原因 | 通道名 | 注册模块 |
|---|---|---|---|
| B | 窗口外壳、窗口布局与多窗口 | `^(window[-:]\|window$\|win:\|titlebar\|fullscreen\|toggle-fullscreen\|get-fullscreen-state\|find-in-page\|page-zoom\|theme:\|app-menu:\|app-locale:\|startup-gate\|maker:open-session-in-new-window\|maker:session-drag-preview\|maker:sidebar-tab-drag-preview\|maker:sidebar-tab-window\|sidebar-tab-window\|maker:rsb-window\|rsb-window\|resource-usage-window\|agent-island\|menubar)` | `^(sidebar-tab-window\|sidebarWindowExpansionIpc\|right-sidebar-window\|resource-usage-window\|agent-island\|menubar)\b` |
| B | 原生对话框、剪贴板、系统外壳与通知 | `^(dialog:\|show-open-directory-dialog\|clipboard:\|shell:\|open-with:\|notification:\|media:copy-(png-)?to-clipboard\|media:open-with-default-app\|media:save-as\|chat-attachment:save-as\|login-item:\|accessibility-support)` | `^(notificationService\|appBadgeService\|login-item-ipc\|accessibility-support-ipc)\b` |
| B | 本机屏幕截取、录制与远程桌面 | `^(region-screenshot\|recording-preview\|recording-audio\|remote-desktop\|away-guard)` | `^(region-screenshot\|remote-desktop\|remote-desktop-viewer)\b` |
| B | 图形能力，由窗口替 Agent 执行（平台 RPC） | `^(maker:computer\|maker:browser\|browser-backend\|rsb-browser-bridge\|rsb-native-popup)` | `^(rsb-browser-bridge)\b` |
| B | 本机输入设备与语音 | `^(voice-input\|voice-conversation\|xbox-gamepad\|worklouder-codex\|codex-micro-guard\|app-shortcuts:set-recording)` | `^(voice-input\|voice-conversation\|xbox-gamepad\|worklouder-codex)\b` |
| B | 桌面安装包自身：更新、版本、日志与诊断 | `^(update-\|get-app-version\|get-app-display-version-info\|get-os-release\|release-notes:\|app:get-arm64-translation\|app:open-logs-dir\|crash-diagnosis\|log-upload\|performance-trace\|renderer:log\|dev:\|cc:set-debug-net\|deep-link:)` | `^(updateService\|relaunchBusyActivityIpc\|crash-diagnosis\|log-upload\|performance-trace)\b` |
| C | 终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道 | `^terminal:` | — |
| C | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | `^(maker:file-browser\|maker:chat-file\|maker:chat-folder\|maker:html-preview\|maker:search:\|file-browser:\|fs:\|read-file-bytes\|read-file-for-attachment\|text-file:\|peek-file-header\|file:thumbnail)` | `^fsBrowse\b` |
| C | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | `(^\|:)(choose\|pick)([A-Z-]\|$)` | — |
| C | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | `(:\|-)(open-dir\|reveal)$\|:open-[a-z-]*-dir(ectory)?$\|^billing:open-` | — |
| C | 运行时发起、窗口收集用户输入（安全输入交接） | `^input-handoff:` | — |
| A | 任务、消息与输入队列 | `^(local-db:(sessions\|messages\|history\|session-share\|session-import\|right-sidebar-tabs\|recent-workdirs\|subagent-runs\|conversations\|task-tags\|project-aliases\|ensure-ready\|maintenance)\|maker:(session\|input\|send\|steer\|create-session\|close-session\|abort-session\|fork\|rewind\|compact\|message\|get-session\|navigate-session\|side-chat\|goal\|turn-change\|persist-turn\|working-status\|any-session\|export-session\|generate-title\|regenerate-title\|auto-title\|predict-prompt\|switch-session-agent\|write-plan-file\|images\|list-desktop-commands\|execute-desktop-command\|get-context\|set-))` | — |
| A | 自动化 | `^maker:schedule` | — |
| A | Orca | `^(maker:(orca\|worker\|team\|mark-orca\|sync-worker)\|local-db:orca)` | — |
| A | 伙伴与 IM | `^(maker:(bot\|companion\|im-)\|local-db:bots\|binding:\|botImConnection\|telegramBot\|wechatBot\|feishuBot\|discordBot\|dingtalkBot\|wecomBot\|wecomGroupNotification\|desktop:cc-prefs\|companion-import)` | `^(im\|bot-import)\b` |
| A | 账号与凭据 | `^(auth:\|safe-storage\|builtin-api-key\|plugin-oauth\|maker:(api-key\|claude-oauth\|xai-oauth\|auth:\|subscription))` | — |
| A | 供应商与模型 | `^(maker:(provider\|model\|usage\|local-model\|llamacpp\|sync-provider\|auxiliary-model\|subagent-model\|vision-bridge\|claude-session-route)\|provider-group\|provider-share\|model-favorites\|model-access)` | — |
| A | 插件、技能与 MCP | `^(ghosts:\|ghost-pipe\|forge-oidc\|maker:(plugins\|plugin-setup\|mcp\|runtime-plugins\|pi-packages)\|plugin-market\|plugin-publisher\|plugin-contributions\|skillhub)` | — |
| A | 设备互联与远程执行 | `^(device-link\|direct-link\|file-peer\|shared-task\|self-hosted-relay\|local-agent\|maker:(remote-resources\|shared-task\|remote-ssh\|provider-share))` | — |
| A | git 与工作树 | `^(git-context\|git-review\|worktree\|remote-precreated-worktree\|maker:git-safety)` | — |
| A | 记忆、学习与钩子 | `^(maker:(memory\|maker-memory\|hook-control)\|learn:)` | — |
| A | 附件与媒体库 | `^(chat-attachment\|cindy-media\|image-cache\|media:)` | — |
| A | 设置与偏好 | `^(sidebar-settings\|app-shortcuts\|appearance-settings\|layout:\|analytics\|database-size-warning\|app-preferences\|local-themes\|profile:\|projects-root\|maker:[a-z-]*settings)` | — |
| A | Cindy Make | `^app:(.*cindy-make\|cindy-versions)` | — |

窗口 API：Electron 导出 `dialog`、`shell`、`clipboard`、`Menu`、`MenuItem`、`screen`、`desktopCapturer`、`Notification`、`globalShortcut`、`systemPreferences`、`nativeTheme`、`Tray`、`TouchBar`、`BrowserView`、`WebContentsView`、`powerSaveBlocker`、`nativeImage`、`autoUpdater`；成员 `BrowserWindow.fromWebContents`、`BrowserWindow.getFocusedWindow`、`BrowserWindow.fromId`、`BrowserWindow.fromBrowserView`、`app.focus`、`app.dock`、`app.setBadgeCount`、`app.relaunch`、`app.quit`、`app.exit`、`app.setLoginItemSettings`、`app.getLoginItemSettings`、`app.show`、`app.hide`、`app.setAsDefaultProtocolClient`、`app.getFileIcon`；以及 `new BrowserWindow`。不计入：发送方校验（`src/main/security/`，客户端模式下由 Host 令牌鉴权），以及发给某个窗口的推送（`webContents.fromId`、`event.sender`，客户端模式下推送走 Host 事件流）。

## A 类：实际调用排行

来源：`docs/host/evidence/channel-usage-mock-tour.json`（UI fixture tour (pnpm restart:desktop:remote -- --mock --isolated=host-usage + apps/desktop/scripts/host-client-usage-tour.mjs)；embedded 模式，2026-11-11）。
这次共调用 253 个通道（1862 次）：contract 30、client 1、**A 144**（782 次，含清单外 0）、B 73、C 5。

| # | 通道 | 调用次数 | 领域 | 模块 |
|---:|---|---:|---|---|
| 1 | `maker:bot-group:outbox-command` | 51 | 伙伴与 IM | maker-ipc |
| 2 | `maker:list-desktop-commands` | 47 | 任务、消息与输入队列 | maker-ipc |
| 3 | `device-link:list-devices` | 33 | 设备互联与远程执行 | device-link |
| 4 | `ghosts:session-focused` | 32 | 插件、技能与 MCP | cindy-brain |
| 5 | `maker:session-background-tasks:list` | 28 | 任务、消息与输入队列 | maker-ipc |
| 6 | `maker:plugins:get-state` | 21 | 插件、技能与 MCP | maker-ipc |
| 7 | `sidebar-settings:load-snapshot-sync` | 21 | 设置与偏好 | sidebarSettingsStore |
| 8 | `device-link:get-state` | 20 | 设备互联与远程执行 | device-link |
| 9 | `maker:model-context-limit:get` | 20 | 供应商与模型 | maker-ipc |
| 10 | `ghosts:ui-prompts` | 19 | 插件、技能与 MCP | cindy-brain |
| 11 | `git-context:get-for-session` | 19 | git 与工作树 | git-context |
| 12 | `learn:list-runs` | 18 | 记忆、学习与钩子 | learn-host |
| 13 | `git-context:find-linked-worktree` | 17 | git 与工作树 | git-context |
| 14 | `maker:get-context-window-bounds` | 16 | 任务、消息与输入队列 | maker-ipc |
| 15 | `maker:get-session-agent-switch-intent` | 16 | 任务、消息与输入队列 | maker-ipc |
| 16 | `maker:side-chat:list:v1` | 16 | 任务、消息与输入队列 | maker-ipc |
| 17 | `provider-group:command` | 16 | 供应商与模型 | provider-group |
| 18 | `binding:resolve-session` | 15 | 伙伴与 IM | im |
| 19 | `maker:goal:get-status` | 15 | 任务、消息与输入队列 | maker-ipc |
| 20 | `maker:session-background-activity` | 15 | 任务、消息与输入队列 | maker-ipc |
| 21 | `worktree:restore-status` | 15 | git 与工作树 | worktree |
| 22 | `git-context:pr-refs:list` | 14 | git 与工作树 | git-context |
| 23 | `local-db:right-sidebar-tabs:list` | 13 | 任务、消息与输入队列 | localDb |
| 24 | `maker:bot-group:list` | 13 | 伙伴与 IM | maker-ipc |
| 25 | `ghosts:recommendations` | 8 | 插件、技能与 MCP | cindy-brain |
| 26 | `maker:subscription-accounts` | 8 | 账号与凭据 | subscription-accounts |
| 27 | `sidebar-settings:claim-renderer-legacy-owner-sync` | 8 | 设置与偏好 | sidebarSettingsStore |
| 28 | `sidebar-settings:get-project-order` | 8 | 设置与偏好 | projectOrderStore |
| 29 | `maker:claude-session-route:get` | 7 | 供应商与模型 | bootstrap-electron |
| 30 | `maker:model-visibility:sync` | 7 | 供应商与模型 | maker-ipc |
| 31 | `maker:remote-ssh:list` | 7 | 设备互联与远程执行 | remote-ssh |
| 32 | `maker:usage:account` | 7 | 供应商与模型 | maker-ipc |
| 33 | `local-db:bots:model-chain-settings-get` | 6 | 伙伴与 IM | localDb |
| 34 | `local-db:bots:read-state:update` | 6 | 伙伴与 IM | maker-ipc |
| 35 | `maker:claude-oauth:status` | 6 | 账号与凭据 | bootstrap-electron |
| 36 | `maker:im-default-settings:get` | 6 | 伙伴与 IM | bootstrap-electron |
| 37 | `maker:usage:claude-subscription` | 6 | 供应商与模型 | maker-ipc |
| 38 | `maker:usage:codex-rate-limits` | 6 | 供应商与模型 | maker-ipc |
| 39 | `local-db:bots:list` | 5 | 伙伴与 IM | localDb |
| 40 | `maker:sync-worker-creation-prefs` | 5 | Orca | maker-ipc |
| 41 | `auth:has-persisted-session-hint-sync` | 4 | 账号与凭据 | bootstrap-electron |
| 42 | `binding:list-attached` | 4 | 伙伴与 IM | im |
| 43 | `desktop:cc-prefs-changed` | 4 | 伙伴与 IM | im |
| 44 | `ghosts:models:list` | 4 | 插件、技能与 MCP | cindy-brain |
| 45 | `maker:bot-read-state` | 4 | 伙伴与 IM | maker-ipc |
| 46 | `maker:silent-encrypted-retry:get` | 4 | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 47 | `maker:sync-new-maker-draft` | 4 | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 48 | `plugin-market:snapshot` | 4 | 插件、技能与 MCP | plugin-market |
| 49 | `provider-share:command` | 4 | 供应商与模型 | device-link |
| 50 | `database-size-warning:get-settings` | 3 | 设置与偏好 | bootstrap-electron |
| 51 | `git-context:pr-refs:list-all` | 3 | git 与工作树 | git-context |
| 52 | `layout:get` | 3 | 设置与偏好 | layout |
| 53 | `local-themes:list-sync` | 3 | 设置与偏好 | local-themes |
| 54 | `maker:agent:binary-version` | 3 | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 55 | `maker:git-safety:get` | 3 | git 与工作树 | bootstrap-electron |
| 56 | `maker:memory:get` | 3 | 记忆、学习与钩子 | maker-ipc |
| 57 | `self-hosted-relay:command` | 3 | 设备互联与远程执行 | device-link |
| 58 | `analytics:settings-get` | 2 | 设置与偏好 | analyticsSettingsService |
| 59 | `auth:initialize` | 2 | 账号与凭据 | bootstrap-electron |
| 60 | `database-size-warning:get-status` | 2 | 设置与偏好 | bootstrap-electron |
| 61 | `feishuBot:get-state` | 2 | 伙伴与 IM | im |
| 62 | `ghosts:recent-usage` | 2 | 插件、技能与 MCP | cindy-brain |
| 63 | `local-db:maintenance:last-result` | 2 | 任务、消息与输入队列 | bootstrap-electron |
| 64 | `maker:agent-resource-settings:get` | 2 | 设置与偏好 | maker-ipc |
| 65 | `maker:agent:pi-kernel-state` | 2 | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 66 | `maker:chat-embedding:get` | 2 | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 67 | `maker:chat:display-cache` | 2 | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 68 | `maker:collaboration-settings:get` | 2 | 设置与偏好 | maker-ipc |
| 69 | `maker:memory:get-settings` | 2 | 记忆、学习与钩子 | bootstrap-electron |
| 70 | `maker:schedule:list-sidebar-index-runs` | 2 | 自动化 | maker-ipc |
| 71 | `maker:session:turn-active` | 2 | 任务、消息与输入队列 | maker-ipc |
| 72 | `plugin-market:recommendations` | 2 | 插件、技能与 MCP | plugin-market |
| 73 | `setup-migration:state` | 2 | 未登记前缀，处理函数没有用到窗口 API | setup-migration |
| 74 | `skillhub:scan` | 2 | 插件、技能与 MCP | skillhub |
| 75 | `wecomGroupNotification:get-state` | 2 | 伙伴与 IM | wecomGroupNotification |
| 76 | `worktree:get-for-session` | 2 | git 与工作树 | worktree |
| 77 | `app-shortcuts:get` | 1 | 设置与偏好 | app-shortcuts |
| 78 | `app:get-cindy-make-state` | 1 | Cindy Make | bootstrap-electron |
| 79 | `app:ready-for-bot` | 1 | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 80 | `appearance-settings:get` | 1 | 设置与偏好 | appearance-settings-ipc |
| 81 | `check-environment` | 1 | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 82 | `cindy-media:storage-stats` | 1 | 附件与媒体库 | bootstrap-electron |
| 83 | `client-endpoints:get-sync` | 1 | 未登记前缀，处理函数没有用到窗口 API | clientEndpointsService |
| 84 | `companion-import` | 1 | 伙伴与 IM | bot-import |
| 85 | `database-size-warning:measure` | 1 | 设置与偏好 | bootstrap-electron |
| 86 | `dialogue-workspace:get` | 1 | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 87 | `dingtalkBot:get-state` | 1 | 伙伴与 IM | im |
| 88 | `discordBot:get-status` | 1 | 伙伴与 IM | im |
| 89 | `ghosts:take-pending-install` | 1 | 插件、技能与 MCP | cindy-brain |
| 90 | `ghosts:unread` | 1 | 插件、技能与 MCP | cindy-brain |
| 91 | `legacy-migration:get-state` | 1 | 未登记前缀，处理函数没有用到窗口 API | legacyUserDataMigration |
| 92 | `local-agent:connections` | 1 | 设备互联与远程执行 | bootstrap-electron |
| 93 | `local-agent:developer-connection` | 1 | 设备互联与远程执行 | bootstrap-electron |
| 94 | `local-db:bots:read-state:get` | 1 | 伙伴与 IM | maker-ipc |
| 95 | `local-db:bots:workbench:follow-scopes` | 1 | 伙伴与 IM | localDb |
| 96 | `local-db:ensure-ready` | 1 | 任务、消息与输入队列 | localDb |
| 97 | `local-db:maintenance:startup-progress` | 1 | 任务、消息与输入队列 | bootstrap-electron |
| 98 | `local-db:session-import:scan` | 1 | 任务、消息与输入队列 | session-import |
| 99 | `local-db:session-import:status` | 1 | 任务、消息与输入队列 | session-import |
| 100 | `local-db:sessions:set-pinned-card-summaries` | 1 | 任务、消息与输入队列 | localDb |
| 101 | `local-themes:list` | 1 | 设置与偏好 | local-themes |
| 102 | `maker:android:get-config` | 1 | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 103 | `maker:auto-title` | 1 | 任务、消息与输入队列 | maker-ipc |
| 104 | `maker:auxiliary-model-settings:get` | 1 | 供应商与模型 | maker-ipc |
| 105 | `maker:companion-cloud:state` | 1 | 伙伴与 IM | maker-ipc |
| 106 | `maker:issues:list-mine` | 1 | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 107 | `maker:issues:snapshot-mine` | 1 | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 108 | `maker:lsp-mode:get` | 1 | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 109 | `maker:mcp:custom:list` | 1 | 插件、技能与 MCP | maker-ipc |
| 110 | `maker:mcp:duplicates:list` | 1 | 插件、技能与 MCP | maker-ipc |
| 111 | `maker:memory:get-settings-state` | 1 | 记忆、学习与钩子 | bootstrap-electron |
| 112 | `maker:pi-packages:list` | 1 | 插件、技能与 MCP | maker-ipc |
| 113 | `maker:plugins:list` | 1 | 插件、技能与 MCP | maker-ipc |
| 114 | `maker:project-automation:pending-imports` | 1 | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 115 | `maker:provider:local-cli-scan` | 1 | 供应商与模型 | maker-ipc |
| 116 | `maker:provider:models-auto-refresh` | 1 | 供应商与模型 | maker-ipc |
| 117 | `maker:remote-ssh:cc-mgr-list-pending-upgrades` | 1 | 设备互联与远程执行 | remote-ssh |
| 118 | `maker:schedule:get-runtime-state` | 1 | 自动化 | maker-ipc |
| 119 | `maker:schedule:list` | 1 | 自动化 | maker-ipc |
| 120 | `maker:schedule:list-runs` | 1 | 自动化 | maker-ipc |
| 121 | `maker:schedule:webhook-receiver` | 1 | 自动化 | maker-ipc |
| 122 | `maker:session-background-activity:list` | 1 | 任务、消息与输入队列 | maker-ipc |
| 123 | `maker:session-background-work:list` | 1 | 任务、消息与输入队列 | maker-ipc |
| 124 | `maker:session:commit-provisional` | 1 | 任务、消息与输入队列 | maker-ipc |
| 125 | `maker:session:prewarm` | 1 | 任务、消息与输入队列 | maker-ipc |
| 126 | `maker:subagent-model-settings:get` | 1 | 供应商与模型 | bootstrap-electron |
| 127 | `maker:sync-provider-model-memory` | 1 | 供应商与模型 | maker-ipc |
| 128 | `maker:usage:history` | 1 | 供应商与模型 | maker-ipc |
| 129 | `maker:vision-bridge-settings:get` | 1 | 供应商与模型 | bootstrap-electron |
| 130 | `model-favorites:host-ready` | 1 | 供应商与模型 | maker-ipc |
| 131 | `plugin-market:consume-removal-notice` | 1 | 插件、技能与 MCP | plugin-market |
| 132 | `plugin-market:lookup` | 1 | 插件、技能与 MCP | plugin-market |
| 133 | `process-monitor:unsubscribe` | 1 | 未登记前缀，处理函数没有用到窗口 API | process-monitor |
| 134 | `projects-root:get` | 1 | 设置与偏好 | bootstrap-electron |
| 135 | `safe-storage-read` | 1 | 账号与凭据 | bootstrap-electron |
| 136 | `setup-migration:host-ready` | 1 | 未登记前缀，处理函数没有用到窗口 API | setup-migration |
| 137 | `skillhub:list-categories` | 1 | 插件、技能与 MCP | skillhub |
| 138 | `skillhub:list-market` | 1 | 插件、技能与 MCP | skillhub |
| 139 | `telegramBot:get-status` | 1 | 伙伴与 IM | im |
| 140 | `wechatBot:get-channel-settings` | 1 | 伙伴与 IM | im |
| 141 | `wechatBot:get-state` | 1 | 伙伴与 IM | im |
| 142 | `wecomBot:get-status` | 1 | 伙伴与 IM | im |
| 143 | `worktree-recycle:list` | 1 | git 与工作树 | bootstrap-electron |
| 144 | `worktree:list-all` | 1 | git 与工作树 | worktree |

## C 类全量（87）

| 通道 | 类型 | 原因 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `appearance-settings:get-sync` | event | 设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents | 3 | `appearance-settings-ipc.ts:56` |
| `fs:resolve-path-batch` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 1 | `bootstrap-electron.ts:8198` |
| `process-monitor:subscribe` | invoke | 未登记前缀，但处理函数用到窗口 API：BrowserWindow.fromWebContents | 1 | `process-monitor/ipc.ts:225` |
| `terminal:get-default-shell-pref` | invoke | 终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道 | 1 | `maker-ipc/terminal-handlers.ts:144` |
| `terminal:list-available-shells` | invoke | 终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道 | 1 | `maker-ipc/terminal-handlers.ts:140` |
| `app:cindy-make-history-open-build` | invoke | Cindy Make，但处理函数用到窗口 API：shell | 0 | `bootstrap-electron.ts:8646` |
| `app:open-cindy-make-source-dir` | invoke | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `bootstrap-electron.ts:8732` |
| `app:open-cindy-make-tools-dir` | invoke | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `bootstrap-electron.ts:8474` |
| `appearance-settings:import-wallpaper` | invoke | 设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents | 0 | `appearance-settings-ipc.ts:87` |
| `billing:open-payment-redirect` | invoke | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `billing/index.ts:484` |
| `billing:open-subscription-portal` | invoke | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `billing/index.ts:484` |
| `cindy-media:chat-attachments-clear` | invoke | 附件与媒体库，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog | 0 | `bootstrap-electron.ts:9318` |
| `cindy-media:chat-attachments-open-dir` | invoke | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `bootstrap-electron.ts:9314` |
| `cindy-media:legacy-images-clear` | invoke | 附件与媒体库，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog | 0 | `bootstrap-electron.ts:9301` |
| `cindy-media:legacy-images-open-dir` | invoke | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `bootstrap-electron.ts:9297` |
| `create-project-from-task:chooseParent` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `bootstrap-electron.ts:9412` |
| `device-link:confirm-skill-mutation` | invoke | 设备互联与远程执行，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog | 0 | `device-link/ipc.ts:1612` |
| `device-link:invoke` | invoke | 设备互联与远程执行，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog、nativeTheme | 0 | `device-link/ipc.ts:1839` |
| `device-link:pick-plugin-package` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `device-link/ipc.ts:1675` |
| `dialogue-workspace:choose` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `bootstrap-electron.ts:9369` |
| `file-browser:remote-op` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/device-op.ts:1147` |
| `file:thumbnail` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `bootstrap-electron.ts:9070` |
| `fs:list-dir` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `fsBrowse/ipc.ts:173` |
| `fs:mkdir-p` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `fsBrowse/ipc.ts:181` |
| `fs:resolve-path` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `bootstrap-electron.ts:8170` |
| `fs:stat-path` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `fsBrowse/ipc.ts:177` |
| `ghosts:background-tasks:reveal` | invoke | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `maker-ipc/register.ts:15071` |
| `ghosts:export` | invoke | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog | 0 | `cindy-brain/index.ts:10731` |
| `ghosts:library-delete` | invoke | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog | 0 | `cindy-brain/index.ts:11113` |
| `ghosts:library-pick-location` | invoke | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog | 0 | `cindy-brain/index.ts:11018` |
| `ghosts:library-reattach-legacy` | invoke | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog | 0 | `cindy-brain/index.ts:11151` |
| `ghosts:pick-file` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `cindy-brain/index.ts:10648` |
| `input-handoff:picture` | invoke | 运行时发起、窗口收集用户输入（安全输入交接） | 0 | `maker-ipc/register.ts:22725` |
| `input-handoff:raise` | invoke | 运行时发起、窗口收集用户输入（安全输入交接） | 0 | `maker-ipc/register.ts:22717` |
| `input-handoff:submit` | invoke | 运行时发起、窗口收集用户输入（安全输入交接） | 0 | `maker-ipc/register.ts:22709` |
| `local-db:bots:choose-avatar` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `localDb/ipc/bots.ts:2528` |
| `local-db:bots:choose-avatar-source` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `localDb/ipc/bots.ts:2506` |
| `local-db:maintenance:choose-backup-directory` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `bootstrap-electron.ts:9555` |
| `local-db:maintenance:open-last-backup-directory` | invoke | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `bootstrap-electron.ts:9573` |
| `local-db:session-share:export` | invoke | 任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.getFocusedWindow、dialog | 0 | `localDb/ipc/session-share.ts:75` |
| `local-db:session-share:inspect` | invoke | 任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.getFocusedWindow、dialog | 0 | `localDb/ipc/session-share.ts:114` |
| `local-themes:import` | invoke | 设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog | 0 | `local-themes/register.ts:55` |
| `local-themes:open-dir` | invoke | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `local-themes/register.ts:51` |
| `maker:chat-file:cancel` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:654` |
| `maker:chat-file:download` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:624` |
| `maker:chat-file:fetch` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:535` |
| `maker:chat-file:stat` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:696` |
| `maker:chat-folder:upload` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:661` |
| `maker:export-session-html` | invoke | 任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.fromWebContents、BrowserWindow.getFocusedWindow、dialog、shell | 0 | `maker-ipc/register.ts:25084` |
| `maker:file-browser:cache-put` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:707` |
| `maker:file-browser:create-file` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:906` |
| `maker:file-browser:create-folder` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:921` |
| `maker:file-browser:delete-entry` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:956` |
| `maker:file-browser:fetch-remote` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:466` |
| `maker:file-browser:list-all` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:809` |
| `maker:file-browser:list-dir` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:776` |
| `maker:file-browser:read-cached` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:741` |
| `maker:file-browser:read-file` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:850` |
| `maker:file-browser:rename-entry` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:936` |
| `maker:file-browser:start-watch` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:973` |
| `maker:file-browser:stat` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:876` |
| `maker:file-browser:stop-watch` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:1008` |
| `maker:file-browser:write-file` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/index.ts:890` |
| `maker:html-preview:cancel` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/html-preview-ipc.ts:208` |
| `maker:html-preview:open` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/html-preview-ipc.ts:50` |
| `maker:mcp-apps:v1` | invoke | 插件、技能与 MCP，但处理函数用到窗口 API：shell | 0 | `mcp-apps/ipc.ts:117` |
| `maker:mcp:duplicates:choose` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `maker-ipc/mcpHandlers.ts:110` |
| `maker:remote-ssh:review-host-key` | invoke | 设备互联与远程执行，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog | 0 | `remote-ssh/index.ts:1486` |
| `maker:search:cancel` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/search/index.ts:192` |
| `maker:search:start` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `file-browser/search/index.ts:100` |
| `peek-file-header` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `bootstrap-electron.ts:8013` |
| `plugin-market:pick-local-source` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `plugin-market/registerIpc.ts:376` |
| `profile:choose-avatar` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `bootstrap-electron.ts:6812` |
| `projects-root:choose` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `bootstrap-electron.ts:9396` |
| `read-file-bytes` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `bootstrap-electron.ts:7968` |
| `read-file-for-attachment` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `bootstrap-electron.ts:7892` |
| `skillhub:pick-local` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `skillhub/registerIpc.ts:1045` |
| `skillhub:uninstall` | invoke | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog、shell | 0 | `skillhub/registerIpc.ts:1194` |
| `terminal:create` | invoke | 终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道 | 0 | `maker-ipc/terminal-handlers.ts:77` |
| `terminal:dispose` | invoke | 终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道 | 0 | `maker-ipc/terminal-handlers.ts:117` |
| `terminal:resize` | invoke | 终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道 | 0 | `maker-ipc/terminal-handlers.ts:109` |
| `terminal:restart` | invoke | 终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道 | 0 | `maker-ipc/terminal-handlers.ts:122` |
| `terminal:set-default-shell-pref` | invoke | 终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道 | 0 | `maker-ipc/terminal-handlers.ts:148` |
| `terminal:write` | invoke | 终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道 | 0 | `maker-ipc/terminal-handlers.ts:102` |
| `text-file:read-preview` | invoke | 本机文件读取：同一台电脑两边都能读，网页与手机只能走后台 | 0 | `bootstrap-electron.ts:8083` |
| `wechatBot:choose-working-directory` | invoke | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `im/index.ts:482` |
| `worktree:reveal` | invoke | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `worktree/index.ts:94` |

## B 类在客户端模式下的实际行为

来源：`docs/host/evidence/channel-usage-client-login.json`（client mode at the sign-in page (isolated cindy-host on a fresh sandbox + pnpm restart:desktop:remote -- --isolated=host-client with CINDY_HOST_API)；client 模式，2026-11-11）；对照 `docs/host/evidence/channel-usage-mock-tour.json`（UI fixture tour (pnpm restart:desktop:remote -- --mock --isolated=host-usage + apps/desktop/scripts/host-client-usage-tour.mjs)；embedded 模式，2026-11-11）。
两份快照都是报告写入时主进程已注册的处理者；客户端快照里没有、普通模式快照里有，就是该在窗口本地处理却被拒的通道。

| 行为 | 通道数 |
|---|---:|
| 窗口本地照常处理 | 347 |
| 被拒：UNSUPPORTED_CAPABILITY | 11 |
| 被拒：No handler registered | 2 |
| 消息无人监听（被丢弃） | 1 |
| 注册在插件页面的 webContents.ipc 上，主进程快照不覆盖 | 2 |

### 被误拒的 B 类（14）

| 通道 | 类型 | 客户端模式下 | 调用次数 | 原因 | 注册位置 |
|---|---|---|---:|---|---|
| `maker:browser:status` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 1 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25814` |
| `maker:computer:check-update` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 1 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25953` |
| `maker:computer:status` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 1 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25839` |
| `maker:browser:open-for-login` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 0 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25823` |
| `maker:computer:cancel-permission-grant` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 0 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25935` |
| `maker:computer:driver-icon` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 0 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25908` |
| `maker:computer:grant-permissions` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 0 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25863` |
| `maker:computer:install-driver` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 0 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25855` |
| `maker:computer:permission-app-drag-end` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 0 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25928` |
| `maker:computer:permission-app-drag-start` | event | 消息无人监听（被丢弃） | 0 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25921` |
| `maker:computer:permission-guide-status` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 0 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25912` |
| `maker:computer:update-driver` | invoke | 被拒：UNSUPPORTED_CAPABILITY | 0 | 图形能力，由窗口替 Agent 执行（平台 RPC） | `maker-ipc/register.ts:25965` |
| `update-relaunch:blocking-activity` | invoke | 被拒：No handler registered | 0 | 桌面安装包自身：更新、版本、日志与诊断 | `relaunchBusyActivityIpc.ts:86` |
| `update-relaunch:blocking-summary` | invoke | 被拒：No handler registered | 0 | 桌面安装包自身：更新、版本、日志与诊断 | `relaunchBusyActivityIpc.ts:97` |

## 按注册模块

| 模块 | 已代理 | A | B | C | 合计 |
|---|---:|---:|---:|---:|---:|
| maker-ipc | 26 | 302 | 12 | 14 | 354 |
| bootstrap-electron | 5 | 130 | 61 | 20 | 216 |
| localDb | 20 | 62 | 1 | 4 | 87 |
| im | 0 | 58 | 0 | 1 | 59 |
| cindy-brain | 5 | 54 | 2 | 5 | 66 |
| device-link | 0 | 49 | 0 | 3 | 52 |
| skillhub | 0 | 40 | 0 | 2 | 42 |
| hook-control | 0 | 29 | 0 | 0 | 29 |
| remote-ssh | 0 | 28 | 0 | 1 | 29 |
| git-review | 0 | 21 | 0 | 0 | 21 |
| billing | 0 | 19 | 0 | 2 | 21 |
| local-model-runtime | 0 | 19 | 0 | 0 | 19 |
| plugin-market | 0 | 19 | 0 | 1 | 20 |
| git-context | 0 | 17 | 0 | 0 | 17 |
| plugin-contributions | 0 | 13 | 0 | 0 | 13 |
| worktree | 0 | 11 | 0 | 1 | 12 |
| setup-migration | 0 | 7 | 0 | 0 | 7 |
| learn-host | 0 | 6 | 0 | 0 | 6 |
| plugin-publisher | 0 | 5 | 0 | 0 | 5 |
| session-import | 0 | 5 | 0 | 0 | 5 |
| sidebarSettingsStore | 0 | 5 | 0 | 0 | 5 |
| wecomGroupNotification | 0 | 5 | 0 | 0 | 5 |
| analyticsSettingsService | 0 | 4 | 0 | 0 | 4 |
| app-shortcuts | 0 | 4 | 1 | 0 | 5 |
| appearance-settings-ipc | 2 | 4 | 0 | 2 | 8 |
| local-themes | 0 | 3 | 0 | 2 | 5 |
| remotePrecreatedWorktreeLedger | 0 | 3 | 0 | 0 | 3 |
| cross-agent-convert | 0 | 2 | 0 | 0 | 2 |
| legacyUserDataMigration | 0 | 2 | 0 | 0 | 2 |
| process-monitor | 0 | 2 | 0 | 1 | 3 |
| projectOrderStore | 0 | 2 | 0 | 0 | 2 |
| subscription-accounts | 0 | 2 | 0 | 0 | 2 |
| app-settings | 0 | 1 | 0 | 0 | 1 |
| bot-import | 0 | 1 | 0 | 0 | 1 |
| clientEndpointsService | 0 | 1 | 0 | 0 | 1 |
| commands | 0 | 1 | 0 | 0 | 1 |
| layout | 2 | 1 | 0 | 0 | 3 |
| local-agent | 0 | 1 | 0 | 0 | 1 |
| model-access | 2 | 1 | 0 | 0 | 3 |
| provider-group | 0 | 1 | 0 | 0 | 1 |
| task-migration | 0 | 1 | 0 | 0 | 1 |
| accessibility-support-ipc | 0 | 0 | 1 | 0 | 1 |
| agent-island | 0 | 0 | 15 | 0 | 15 |
| appBadgeService | 0 | 0 | 3 | 0 | 3 |
| crash-diagnosis | 0 | 0 | 3 | 0 | 3 |
| file-browser | 0 | 0 | 0 | 24 | 24 |
| fsBrowse | 0 | 0 | 0 | 3 | 3 |
| ipc | 0 | 0 | 2 | 0 | 2 |
| log-upload | 0 | 0 | 4 | 0 | 4 |
| login-item-ipc | 0 | 0 | 2 | 0 | 2 |
| maker-host | 1 | 0 | 0 | 0 | 1 |
| mcp-apps | 0 | 0 | 0 | 1 | 1 |
| mcp-integrations | 0 | 0 | 9 | 0 | 9 |
| menubar | 0 | 0 | 2 | 0 | 2 |
| notificationService | 0 | 0 | 2 | 0 | 2 |
| performance-trace | 0 | 0 | 2 | 0 | 2 |
| region-screenshot | 0 | 0 | 48 | 0 | 48 |
| relaunchBusyActivityIpc | 0 | 0 | 2 | 0 | 2 |
| remote-desktop | 0 | 0 | 20 | 0 | 20 |
| remote-desktop-viewer | 0 | 0 | 17 | 0 | 17 |
| resource-usage-window | 0 | 0 | 4 | 0 | 4 |
| right-sidebar-window | 0 | 0 | 11 | 0 | 11 |
| rsb-browser-bridge | 0 | 0 | 12 | 0 | 12 |
| sidebar-tab-window | 0 | 0 | 10 | 0 | 10 |
| sidebarWindowExpansionIpc | 0 | 0 | 1 | 0 | 1 |
| updateService | 0 | 0 | 17 | 0 | 17 |
| voice-conversation | 0 | 0 | 22 | 0 | 22 |
| voice-input | 0 | 0 | 62 | 0 | 62 |
| worklouder-codex | 0 | 0 | 10 | 0 | 10 |
| xbox-gamepad | 0 | 0 | 5 | 0 | 5 |

## 全部通道

### accessibility-support-ipc

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `accessibility-support:get-sync` | event | B（原生对话框、剪贴板、系统外壳与通知） | 2 | `accessibility-support-ipc.ts:11` |

### agent-island

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `agent-island:completion-action` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `agent-island/service.ts:643` |
| `agent-island:consume-entry-alert` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `agent-island/service.ts:690` |
| `agent-island:get-display-options` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts:757` |
| `agent-island:get-live-activity-support` | invoke | B（窗口外壳、窗口布局与多窗口） | 2 | `agent-island/service.ts:739` |
| `agent-island:preview-sound` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `agent-island/service.ts:776` |
| `agent-island:select-sound-file` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `agent-island/service.ts:785` |
| `agent-island:set-companion-chats` | invoke | B（窗口外壳、窗口布局与多窗口） | 2 | `agent-island/service.ts:629` |
| `agent-island:set-display-target` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts:752` |
| `agent-island:set-enabled` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts:707` |
| `agent-island:set-live-activity` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts:730` |
| `agent-island:set-mascot-skin` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts:744` |
| `agent-island:set-remote-sessions` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts:651` |
| `agent-island:set-sound-settings` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts:715` |
| `agent-island:set-subtle-reminders` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts:720` |
| `agent-island:set-visible-session` | invoke | B（窗口外壳、窗口布局与多窗口） | 72 | `agent-island/service.ts:668` |

### analyticsSettingsService

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `analytics:consent-accept` | invoke | A（设置与偏好） | 0 | `analyticsSettingsService.ts:283` |
| `analytics:settings-get` | invoke | A（设置与偏好） | 2 | `analyticsSettingsService.ts:257` |
| `analytics:settings-reset-enabled` | invoke | A（设置与偏好） | 0 | `analyticsSettingsService.ts:273` |
| `analytics:settings-set-enabled` | invoke | A（设置与偏好） | 0 | `analyticsSettingsService.ts:262` |

### app-settings

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `app-preferences:reply` | event | A（设置与偏好） | 0 | `app-settings/preferences.ts:15` |

### app-shortcuts

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `app-shortcuts:clear-override` | invoke | A（设置与偏好） | 0 | `app-shortcuts/index.ts:100` |
| `app-shortcuts:get` | event | A（设置与偏好） | 1 | `app-shortcuts/index.ts:84` |
| `app-shortcuts:reset-all` | invoke | A（设置与偏好） | 0 | `app-shortcuts/index.ts:105` |
| `app-shortcuts:set-override` | invoke | A（设置与偏好） | 0 | `app-shortcuts/index.ts:92` |
| `app-shortcuts:set-recording` | event | B（本机输入设备与语音） | 0 | `app-shortcuts/index.ts:110` |

### appBadgeService

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `notification:clear-session-attention` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 26 | `appBadgeService.ts:105` |
| `notification:mark-session-attention` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `appBadgeService.ts:98` |
| `notification:set-app-attention-count` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 28 | `appBadgeService.ts:48` |

### appearance-settings-ipc

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `appearance-settings:ensure-wallpaper-image` | invoke | A（设置与偏好） | 0 | `appearance-settings-ipc.ts:79` |
| `appearance-settings:ensure-wallpaper-video` | invoke | A（设置与偏好） | 0 | `appearance-settings-ipc.ts:70` |
| `appearance-settings:get` | invoke | A（设置与偏好） | 1 | `appearance-settings-ipc.ts:62` |
| `appearance-settings:get-sync` | event | C（设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents） | 3 | `appearance-settings-ipc.ts:56` |
| `appearance-settings:import-wallpaper` | invoke | C（设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents） | 0 | `appearance-settings-ipc.ts:87` |
| `appearance-settings:remove-wallpaper` | invoke | A（设置与偏好） | 0 | `appearance-settings-ipc.ts:105` |
| `appearance-settings:reset` | invoke | contract | 0 | `appearance-settings-ipc.ts:123` |
| `appearance-settings:set-patch` | invoke | contract | 0 | `appearance-settings-ipc.ts:118` |

### billing

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `billing:cancel-current-subscription` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:cancel-plan-change` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:cancel-topup` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:confirm-plan-change` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:create-subscription` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:create-topup` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:get-balance` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:get-catalog` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:get-credit-usage` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:get-current-subscription` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:get-order` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:list-orders` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:list-payment-history` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:open-payment-redirect` | invoke | C（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `billing/index.ts:484` |
| `billing:open-subscription-portal` | invoke | C（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `billing/index.ts:484` |
| `billing:quote-plan-change` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:refresh-plan-change` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:refresh-subscription-purchase` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:refresh-topup` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:resume-current-subscription` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |
| `billing:retry-topup` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts:484` |

### bootstrap-electron

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `app-locale:get-preferred-system-locale-sync` | event | B（窗口外壳、窗口布局与多窗口） | 3 | `bootstrap-electron.ts:3484` |
| `app-locale:set-classical-style` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `bootstrap-electron.ts:3493` |
| `app-menu:set-locale` | invoke | B（窗口外壳、窗口布局与多窗口） | 3 | `bootstrap-electron.ts:3499` |
| `app:cancel-cindy-make-source` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8726` |
| `app:cancel-cindy-make-task` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8750` |
| `app:cindy-make-contribution` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8518` |
| `app:cindy-make-history` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8582` |
| `app:cindy-make-history-action` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8609` |
| `app:cindy-make-history-build` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8627` |
| `app:cindy-make-history-cancel-build` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8637` |
| `app:cindy-make-history-open-build` | invoke | C（Cindy Make，但处理函数用到窗口 API：shell） | 0 | `bootstrap-electron.ts:8646` |
| `app:cindy-make-merge` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8486` |
| `app:cindy-make-personal-remote` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8500` |
| `app:cindy-make-sync` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8513` |
| `app:cindy-make-test` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8677` |
| `app:cindy-versions-action` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8669` |
| `app:cindy-versions-state` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8660` |
| `app:get-arm64-translation` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 2 | `bootstrap-electron.ts:5244` |
| `app:get-cindy-make-settings` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8567` |
| `app:get-cindy-make-source-status` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8523` |
| `app:get-cindy-make-state` | invoke | A（Cindy Make） | 1 | `bootstrap-electron.ts:8696` |
| `app:manage-cindy-make-task` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8716` |
| `app:open-cindy-make-source-dir` | invoke | C（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `bootstrap-electron.ts:8732` |
| `app:open-cindy-make-tools-dir` | invoke | C（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `bootstrap-electron.ts:8474` |
| `app:open-logs-dir` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `bootstrap-electron.ts:8467` |
| `app:prepare-cindy-make-workspace` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8757` |
| `app:ready-for-bot` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `bootstrap-electron.ts:10543` |
| `app:set-cindy-make-sync-latest-before-build` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8573` |
| `app:start-cindy-make-task` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts:8742` |
| `auth:account-deletion:clear-receipt` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6753` |
| `auth:account-deletion:confirm` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6749` |
| `auth:account-deletion:consume-restored-notice` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6756` |
| `auth:account-deletion:get-availability` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6743` |
| `auth:account-deletion:get-status` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6752` |
| `auth:account-deletion:request-challenge` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6746` |
| `auth:accounts:begin-add` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6693` |
| `auth:accounts:cancel-add` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6702` |
| `auth:accounts:list` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6670` |
| `auth:accounts:switch` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6684` |
| `auth:accounts:sync` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6675` |
| `auth:dispatch-login-action` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6652` |
| `auth:enter-local` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6707` |
| `auth:exit-local` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6715` |
| `auth:get-captcha-challenge-url` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6661` |
| `auth:get-login-state` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6650` |
| `auth:has-persisted-session-hint-sync` | event | A（账号与凭据） | 4 | `bootstrap-electron.ts:5251` |
| `auth:initialize` | invoke | A（账号与凭据） | 2 | `bootstrap-electron.ts:6600` |
| `auth:logout` | invoke | contract | 0 | `bootstrap-electron.ts:6666` |
| `auth:refresh` | invoke | contract | 0 | `bootstrap-electron.ts:6722` |
| `builtin-api-key-has` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6553` |
| `builtin-api-key-remove` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6576` |
| `builtin-api-key-store` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6561` |
| `cc:set-debug-net` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `bootstrap-electron.ts:6272` |
| `chat-attachment:cleanup` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:8442` |
| `chat-attachment:save-as` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:8458` |
| `chat-attachment:stage` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:8436` |
| `check-environment` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `bootstrap-electron.ts:7125` |
| `cindy-media:chat-attachments-clear` | invoke | C（附件与媒体库，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog） | 0 | `bootstrap-electron.ts:9318` |
| `cindy-media:chat-attachments-open-dir` | invoke | C（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `bootstrap-electron.ts:9314` |
| `cindy-media:legacy-images-clear` | invoke | C（附件与媒体库，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog） | 0 | `bootstrap-electron.ts:9301` |
| `cindy-media:legacy-images-open-dir` | invoke | C（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `bootstrap-electron.ts:9297` |
| `cindy-media:report-draft-urls` | event | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9228` |
| `cindy-media:storage-cleanup` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9280` |
| `cindy-media:storage-reconcile` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9296` |
| `cindy-media:storage-scan` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9275` |
| `cindy-media:storage-stats` | invoke | A（附件与媒体库） | 1 | `bootstrap-electron.ts:9271` |
| `clipboard:copy-text` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:8791` |
| `create-project-from-task:chooseParent` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `bootstrap-electron.ts:9412` |
| `create-project-from-task:create` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:9412` |
| `create-project-from-task:prepare` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:9412` |
| `database-size-warning:get-settings` | invoke | A（设置与偏好） | 3 | `bootstrap-electron.ts:4927` |
| `database-size-warning:get-status` | invoke | A（设置与偏好） | 2 | `bootstrap-electron.ts:4960` |
| `database-size-warning:measure` | invoke | A（设置与偏好） | 1 | `bootstrap-electron.ts:4964` |
| `database-size-warning:reset-settings` | invoke | A（设置与偏好） | 0 | `bootstrap-electron.ts:4949` |
| `database-size-warning:set-settings` | invoke | A（设置与偏好） | 0 | `bootstrap-electron.ts:4936` |
| `deep-link:take-pending` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `bootstrap-electron.ts:3491` |
| `dialog:authorize-recent-writable-directory` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:7792` |
| `dialog:show-open-directory` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:7753` |
| `dialog:show-open-file` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:7819` |
| `dialog:show-open-resource` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:7840` |
| `dialogue-workspace:choose` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `bootstrap-electron.ts:9369` |
| `dialogue-workspace:get` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `bootstrap-electron.ts:9369` |
| `dialogue-workspace:open` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:9369` |
| `dialogue-workspace:reset` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:9369` |
| `file:thumbnail` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `bootstrap-electron.ts:9070` |
| `find-in-page:start` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6172` |
| `find-in-page:stop` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6192` |
| `fs:resolve-path` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `bootstrap-electron.ts:8170` |
| `fs:resolve-path-batch` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 1 | `bootstrap-electron.ts:8198` |
| `get-app-display-version-info` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `bootstrap-electron.ts:5255` |
| `get-app-version` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `bootstrap-electron.ts:5235` |
| `get-device-id` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:6204` |
| `get-fullscreen-state` | invoke | B（窗口外壳、窗口布局与多窗口） | 10 | `bootstrap-electron.ts:6153` |
| `get-os-release` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `bootstrap-electron.ts:5239` |
| `host-client:observe` | event | client | 2 | `bootstrap-electron.ts:1432` |
| `host-client:retry` | event | client | 0 | `bootstrap-electron.ts:1436` |
| `image-cache:cleanup-files` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9624` |
| `image-cache:cleanup-session` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9613` |
| `image-cache:from-buffer` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9111` |
| `image-cache:from-path` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9097` |
| `image-cache:read-base64` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9598` |
| `local-agent:connections` | invoke | A（设备互联与远程执行） | 1 | `bootstrap-electron.ts:9255` |
| `local-agent:developer-connection` | invoke | A（设备互联与远程执行） | 1 | `bootstrap-electron.ts:9263` |
| `local-agent:revoke` | invoke | A（设备互联与远程执行） | 0 | `bootstrap-electron.ts:9267` |
| `local-agent:set-create-visible-sessions` | invoke | A（设备互联与远程执行） | 0 | `bootstrap-electron.ts:9259` |
| `local-db:maintenance:cancel-startup` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts:9583` |
| `local-db:maintenance:choose-backup-directory` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `bootstrap-electron.ts:9555` |
| `local-db:maintenance:last-result` | invoke | A（任务、消息与输入队列） | 2 | `bootstrap-electron.ts:9567` |
| `local-db:maintenance:open-last-backup-directory` | invoke | C（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `bootstrap-electron.ts:9573` |
| `local-db:maintenance:scan` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts:9551` |
| `local-db:maintenance:schedule` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts:9561` |
| `local-db:maintenance:startup-progress` | invoke | A（任务、消息与输入队列） | 1 | `bootstrap-electron.ts:9579` |
| `maker:chat-embedding:get` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 2 | `bootstrap-electron.ts:5693` |
| `maker:chat-embedding:reset` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:5729` |
| `maker:chat-embedding:set` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:5697` |
| `maker:claude-oauth:cancel` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:5882` |
| `maker:claude-oauth:login` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:5824` |
| `maker:claude-oauth:logout` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:5845` |
| `maker:claude-oauth:status` | invoke | A（账号与凭据） | 6 | `bootstrap-electron.ts:5819` |
| `maker:claude-session-route:get` | invoke | A（供应商与模型） | 7 | `bootstrap-electron.ts:5775` |
| `maker:codex-runtime-route:get` | invoke | contract | 7 | `bootstrap-electron.ts:5768` |
| `maker:compaction:get-pct` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts:5567` |
| `maker:compaction:get-state` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts:5571` |
| `maker:compaction:reset-pct` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts:5575` |
| `maker:compaction:set-pct` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts:5582` |
| `maker:git-safety:get` | invoke | A（git 与工作树） | 3 | `bootstrap-electron.ts:5749` |
| `maker:git-safety:reset` | invoke | A（git 与工作树） | 0 | `bootstrap-electron.ts:5760` |
| `maker:git-safety:set` | invoke | A（git 与工作树） | 0 | `bootstrap-electron.ts:5752` |
| `maker:im-default-settings:get` | invoke | A（伙伴与 IM） | 6 | `bootstrap-electron.ts:5331` |
| `maker:im-default-settings:reset` | invoke | A（伙伴与 IM） | 0 | `bootstrap-electron.ts:5379` |
| `maker:im-default-settings:set` | invoke | A（伙伴与 IM） | 0 | `bootstrap-electron.ts:5335` |
| `maker:lsp-mode:get` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `bootstrap-electron.ts:5678` |
| `maker:lsp-mode:set` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:5681` |
| `maker:memory:get-settings` | invoke | A（记忆、学习与钩子） | 2 | `bootstrap-electron.ts:5301` |
| `maker:memory:get-settings-state` | invoke | A（记忆、学习与钩子） | 1 | `bootstrap-electron.ts:5304` |
| `maker:memory:preserve-legacy-maker-disabled` | invoke | A（记忆、学习与钩子） | 0 | `bootstrap-electron.ts:5308` |
| `maker:open-session-in-new-window` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5068` |
| `maker:open-session-in-new-window-if-dropped-outside` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5086` |
| `maker:pi-compaction:get-pct` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:5594` |
| `maker:pi-compaction:get-state` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:5598` |
| `maker:pi-compaction:reset-pct` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:5602` |
| `maker:pi-compaction:set-pct` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:5609` |
| `maker:session-drag-preview:end` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5157` |
| `maker:session-drag-preview:start` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5114` |
| `maker:session-runtime-fallback:get` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts:5549` |
| `maker:session-runtime-fallback:reset` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts:5561` |
| `maker:session-runtime-fallback:set` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts:5553` |
| `maker:sidebar-tab-drag-preview:end` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5150` |
| `maker:sidebar-tab-drag-preview:start` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5139` |
| `maker:silent-encrypted-retry:get` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 4 | `bootstrap-electron.ts:5529` |
| `maker:silent-encrypted-retry:reset` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:5542` |
| `maker:silent-encrypted-retry:set` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:5532` |
| `maker:subagent-model-settings:get` | invoke | A（供应商与模型） | 1 | `bootstrap-electron.ts:5413` |
| `maker:subagent-model-settings:reset` | invoke | A（供应商与模型） | 0 | `bootstrap-electron.ts:5489` |
| `maker:subagent-model-settings:set` | invoke | A（供应商与模型） | 0 | `bootstrap-electron.ts:5462` |
| `maker:vision-bridge-settings:get` | invoke | A（供应商与模型） | 1 | `bootstrap-electron.ts:5493` |
| `maker:vision-bridge-settings:reset` | invoke | A（供应商与模型） | 0 | `bootstrap-electron.ts:5507` |
| `maker:vision-bridge-settings:set` | invoke | A（供应商与模型） | 0 | `bootstrap-electron.ts:5502` |
| `maker:xai-oauth:cancel` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6026` |
| `maker:xai-oauth:login` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:5947` |
| `maker:xai-oauth:logout` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:5986` |
| `media:cache-for-session` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9058` |
| `media:copy-png-to-clipboard` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:8780` |
| `media:copy-to-clipboard` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:8879` |
| `media:open-with-default-app` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:9051` |
| `media:read-image-bytes` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts:9061` |
| `media:save-as` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:9054` |
| `open-with:list` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:8366` |
| `open-with:open` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:8370` |
| `page-zoom:in` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6125` |
| `page-zoom:out` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6133` |
| `page-zoom:reset` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6141` |
| `peek-file-header` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `bootstrap-electron.ts:8013` |
| `profile:choose-avatar` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `bootstrap-electron.ts:6812` |
| `profile:get-state` | invoke | A（设置与偏好） | 0 | `bootstrap-electron.ts:6807` |
| `profile:update` | invoke | A（设置与偏好） | 0 | `bootstrap-electron.ts:6817` |
| `projects-root:choose` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `bootstrap-electron.ts:9396` |
| `projects-root:get` | invoke | A（设置与偏好） | 1 | `bootstrap-electron.ts:9396` |
| `projects-root:reset` | invoke | A（设置与偏好） | 0 | `bootstrap-electron.ts:9396` |
| `read-file-bytes` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `bootstrap-electron.ts:7968` |
| `read-file-for-attachment` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `bootstrap-electron.ts:7892` |
| `release-notes:fetch` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 2 | `bootstrap-electron.ts:6300` |
| `release-notes:fetch-index` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `bootstrap-electron.ts:6307` |
| `renderer:log` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 79 | `bootstrap-electron.ts:5276` |
| `safe-storage-read` | invoke | A（账号与凭据） | 1 | `bootstrap-electron.ts:6442` |
| `safe-storage-remove` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6480` |
| `safe-storage-store` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts:6388` |
| `shell:open-chatgpt-app` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:7333` |
| `shell:open-external` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:7305` |
| `shell:open-file-in-browser` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:8238` |
| `shell:open-path` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:8279` |
| `shell:show-item-in-folder` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:8824` |
| `show-open-directory-dialog` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts:7354` |
| `startup-gate:stalled` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5262` |
| `text-file:read-preview` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `bootstrap-electron.ts:8083` |
| `theme:apply-vibrancy` | event | B（窗口外壳、窗口布局与多窗口） | 10 | `bootstrap-electron.ts:5210` |
| `theme:set-sidebar-width` | event | B（窗口外壳、窗口布局与多窗口） | 3 | `bootstrap-electron.ts:5204` |
| `toggle-fullscreen` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6158` |
| `window-behavior:get-linux-close-behavior` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5653` |
| `window-behavior:get-windows-close-behavior` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5633` |
| `window-behavior:linux-close-behavior-shown` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5669` |
| `window-behavior:set-linux-close-behavior` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5658` |
| `window-behavior:set-swallow-activation-click` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5624` |
| `window-behavior:set-windows-close-behavior` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5637` |
| `window-behavior:windows-close-behavior-shown` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:5648` |
| `window-close` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6106` |
| `window-close-self` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6122` |
| `window-drag-move-start` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6089` |
| `window-drag-move-stop` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6094` |
| `window-exit-fullscreen` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6053` |
| `window-maximize` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6039` |
| `window-minimize` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts:6035` |
| `workspace:scan-at-resources` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:7383` |
| `workspace:scan-slash-commands` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts:7533` |
| `worktree-recycle:control` | invoke | A（git 与工作树） | 0 | `bootstrap-electron.ts:9133` |
| `worktree-recycle:list` | invoke | A（git 与工作树） | 1 | `bootstrap-electron.ts:9129` |

### bot-import

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `companion-import` | invoke | A（伙伴与 IM） | 1 | `bot-import/registration.ts:13` |

### cindy-brain

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `forge-oidc-install:resolve-confirm` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10067` |
| `ghost-page:cancel-model-picker` | event | B（单个窗口内的插件页面 IPC（webContents.ipc）） | 0 | `cindy-brain/ghostPageModelPicker.ts:57` |
| `ghost-page:pick-model` | invoke | B（单个窗口内的插件页面 IPC（webContents.ipc）） | 0 | `cindy-brain/ghostPageModelPicker.ts:20` |
| `ghost-pipe:ping` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:9707` |
| `ghost-pipe:send` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:9723` |
| `ghosts:acknowledge-retirement` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10211` |
| `ghosts:activate-browser` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10179` |
| `ghosts:builtin-status` | event | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10803` |
| `ghosts:card:action` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10170` |
| `ghosts:card:get` | invoke | contract | 0 | `cindy-brain/index.ts:10106` |
| `ghosts:card:list-by-session` | invoke | contract | 13 | `cindy-brain/index.ts:10135` |
| `ghosts:card:report-height` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10151` |
| `ghosts:clear-unread` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10314` |
| `ghosts:composer-list` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10234` |
| `ghosts:confirm:resolve` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10052` |
| `ghosts:control-points:candidates` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10918` |
| `ghosts:control-points:get` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10881` |
| `ghosts:defer-ui-prompt` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10870` |
| `ghosts:dev-runtime` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:11218` |
| `ghosts:errand-prefs` | event | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10458` |
| `ghosts:errand-prefs:set` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10465` |
| `ghosts:export` | invoke | C（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog） | 0 | `cindy-brain/index.ts:10731` |
| `ghosts:handoff-delete` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10995` |
| `ghosts:handoff-folder` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10991` |
| `ghosts:handoff-list` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10987` |
| `ghosts:inspect` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10668` |
| `ghosts:install` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10485` |
| `ghosts:install-consent:resolve` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10085` |
| `ghosts:legacy-recovery-status` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:9196` |
| `ghosts:library-bind` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:11045` |
| `ghosts:library-delete` | invoke | C（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog） | 0 | `cindy-brain/index.ts:11113` |
| `ghosts:library-overview` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10975` |
| `ghosts:library-pick-location` | invoke | C（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog） | 0 | `cindy-brain/index.ts:11018` |
| `ghosts:library-reattach-legacy` | invoke | C（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog） | 0 | `cindy-brain/index.ts:11151` |
| `ghosts:library-relocate` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:11068` |
| `ghosts:library-revert-default` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:11076` |
| `ghosts:library-unbind` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:11096` |
| `ghosts:list` | event | contract | 5 | `cindy-brain/index.ts:10231` |
| `ghosts:mail-preview` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:9042` |
| `ghosts:mark-used` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10272` |
| `ghosts:model-picker:resolve` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10039` |
| `ghosts:models:list` | invoke | A（插件、技能与 MCP） | 4 | `cindy-brain/index.ts:10912` |
| `ghosts:open-retirement` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10189` |
| `ghosts:pick-file` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `cindy-brain/index.ts:10648` |
| `ghosts:readme` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10967` |
| `ghosts:recent-usage` | event | A（插件、技能与 MCP） | 2 | `cindy-brain/index.ts:10260` |
| `ghosts:recommendations` | event | A（插件、技能与 MCP） | 8 | `cindy-brain/index.ts:10239` |
| `ghosts:reload` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:11199` |
| `ghosts:request-task-approval` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10924` |
| `ghosts:request-ui-approval` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10857` |
| `ghosts:resolve-panel-media` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10388` |
| `ghosts:restore-builtin` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10829` |
| `ghosts:retry-legacy-recovery` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:9197` |
| `ghosts:runtime-states` | invoke | contract | 0 | `cindy-brain/index.ts:10959` |
| `ghosts:session-focused` | event | A（插件、技能与 MCP） | 32 | `cindy-brain/index.ts:10123` |
| `ghosts:set-enabled` | invoke | contract | 0 | `cindy-brain/index.ts:10941` |
| `ghosts:setup-status` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10337` |
| `ghosts:start-task:route` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10889` |
| `ghosts:take-pending-install` | invoke | A（插件、技能与 MCP） | 1 | `cindy-brain/index.ts:10662` |
| `ghosts:ui-prompts` | invoke | A（插件、技能与 MCP） | 19 | `cindy-brain/index.ts:10863` |
| `ghosts:uninstall` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10712` |
| `ghosts:unread` | event | A（插件、技能与 MCP） | 1 | `cindy-brain/index.ts:10306` |
| `ghosts:update` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10559` |
| `ghosts:workdir-prefs` | event | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10424` |
| `ghosts:workdir-prefs` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10430` |
| `ghosts:workdir-prefs:set` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts:10436` |

### clientEndpointsService

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `client-endpoints:get-sync` | event | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `clientEndpointsService.ts:1246` |

### commands

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `desktop-cmd:run` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `commands/remoteCmdIpc.ts:40` |

### crash-diagnosis

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `crash-diagnosis:dismiss` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `crash-diagnosis.ts:93` |
| `crash-diagnosis:get` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `crash-diagnosis.ts:85` |
| `crash-diagnosis:prepare` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `crash-diagnosis.ts:89` |

### cross-agent-convert

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `maker:cross-agent:convert` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `cross-agent-convert/ipc.ts:51` |
| `maker:cross-agent:detect` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `cross-agent-convert/ipc.ts:42` |

### device-link

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `device-link:close-link` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1834` |
| `device-link:confirm-skill-mutation` | invoke | C（设备互联与远程执行，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog） | 0 | `device-link/ipc.ts:1612` |
| `device-link:delete-device` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1824` |
| `device-link:disconnect-all` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1948` |
| `device-link:get-peer-links` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1814` |
| `device-link:get-state` | invoke | A（设备互联与远程执行） | 20 | `device-link/ipc.ts:1793` |
| `device-link:invoke` | invoke | C（设备互联与远程执行，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog、nativeTheme） | 0 | `device-link/ipc.ts:1839` |
| `device-link:list-devices` | invoke | A（设备互联与远程执行） | 33 | `device-link/ipc.ts:1811` |
| `device-link:mirror-cache:clear` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:2038` |
| `device-link:mirror-cache:messages:get` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1985` |
| `device-link:mirror-cache:messages:put` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1991` |
| `device-link:mirror-cache:session-list:get` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:2017` |
| `device-link:mirror-cache:session-list:put` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:2022` |
| `device-link:open-link` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1829` |
| `device-link:pick-plugin-package` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `device-link/ipc.ts:1675` |
| `device-link:plugin-settings:answer-directory` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1748` |
| `device-link:plugin-settings:answer-model-picker` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1753` |
| `device-link:plugin-settings:close` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1744` |
| `device-link:plugin-settings:open` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1736` |
| `device-link:rename-device` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1819` |
| `device-link:restore` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1970` |
| `device-link:revoke` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1954` |
| `device-link:set-device-control-enabled` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1804` |
| `device-link:set-enabled` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1794` |
| `device-link:set-keep-awake` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1801` |
| `device-link:set-model-use` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1960` |
| `device-link:topic-subscribe` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1935` |
| `device-link:topic-unsubscribe` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts:1941` |
| `direct-link:host:event` | invoke | A（设备互联与远程执行） | 0 | `device-link/directLink.ts:38` |
| `direct-link:host:register` | invoke | A（设备互联与远程执行） | 0 | `device-link/directLink.ts:37` |
| `file-peer:host:closed` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts:579` |
| `file-peer:host:invoke` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts:534` |
| `file-peer:host:read` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts:601` |
| `file-peer:host:register` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts:578` |
| `file-peer:host:reply` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts:585` |
| `file-peer:host:write` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts:656` |
| `maker:provider-share:received-catalogs` | invoke | A（供应商与模型） | 0 | `device-link/providerShareRuntime.ts:1366` |
| `maker:remote-resources:get` | invoke | A（设备互联与远程执行） | 0 | `device-link/remoteResourcesIpc.ts:62` |
| `maker:remote-resources:invoke` | invoke | A（设备互联与远程执行） | 0 | `device-link/remoteResourcesIpc.ts:73` |
| `maker:remote-resources:list` | invoke | A（设备互联与远程执行） | 0 | `device-link/remoteResourcesIpc.ts:51` |
| `maker:remote-resources:manifest` | invoke | A（设备互联与远程执行） | 0 | `device-link/remoteResourcesIpc.ts:44` |
| `maker:shared-task` | invoke | A（设备互联与远程执行） | 0 | `device-link/sharedTaskIpc.ts:18` |
| `plugin-oauth:answer-input-picture` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts:1781` |
| `plugin-oauth:assist` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts:1767` |
| `plugin-oauth:device-code` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts:1606` |
| `plugin-oauth:open-input-picture` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts:1772` |
| `plugin-oauth:submit-connection` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts:1769` |
| `plugin-oauth:submit-input` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts:1770` |
| `plugin-oauth:submit-secret` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts:1768` |
| `provider-share:command` | invoke | A（供应商与模型） | 4 | `device-link/providerShareRuntime.ts:1372` |
| `self-hosted-relay:command` | invoke | A（设备互联与远程执行） | 3 | `device-link/selfHostedRelayRuntime.ts:1885` |
| `shared-task:account` | invoke | A（设备互联与远程执行） | 0 | `device-link/sharedTaskIpc.ts:25` |

### file-browser

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `file-browser:remote-op` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/device-op.ts:1147` |
| `maker:chat-file:cancel` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:654` |
| `maker:chat-file:download` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:624` |
| `maker:chat-file:fetch` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:535` |
| `maker:chat-file:stat` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:696` |
| `maker:chat-folder:upload` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:661` |
| `maker:file-browser:cache-put` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:707` |
| `maker:file-browser:create-file` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:906` |
| `maker:file-browser:create-folder` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:921` |
| `maker:file-browser:delete-entry` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:956` |
| `maker:file-browser:fetch-remote` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:466` |
| `maker:file-browser:list-all` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:809` |
| `maker:file-browser:list-dir` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:776` |
| `maker:file-browser:read-cached` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:741` |
| `maker:file-browser:read-file` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:850` |
| `maker:file-browser:rename-entry` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:936` |
| `maker:file-browser:start-watch` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:973` |
| `maker:file-browser:stat` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:876` |
| `maker:file-browser:stop-watch` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:1008` |
| `maker:file-browser:write-file` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/index.ts:890` |
| `maker:html-preview:cancel` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/html-preview-ipc.ts:208` |
| `maker:html-preview:open` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/html-preview-ipc.ts:50` |
| `maker:search:cancel` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/search/index.ts:192` |
| `maker:search:start` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `file-browser/search/index.ts:100` |

### fsBrowse

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `fs:list-dir` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `fsBrowse/ipc.ts:173` |
| `fs:mkdir-p` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `fsBrowse/ipc.ts:181` |
| `fs:stat-path` | invoke | C（本机文件读取：同一台电脑两边都能读，网页与手机只能走后台） | 0 | `fsBrowse/ipc.ts:177` |

### git-context

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `git-context:find-linked-worktree` | invoke | A（git 与工作树） | 17 | `git-context/ipc.ts:339` |
| `git-context:get` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts:249` |
| `git-context:get-for-session` | invoke | A（git 与工作树） | 19 | `git-context/ipc.ts:257` |
| `git-context:github-read` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts:234` |
| `git-context:github-setup:cancel` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts:111` |
| `git-context:github-setup:connection` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts:111` |
| `git-context:github-setup:start` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts:111` |
| `git-context:github-setup:status` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts:111` |
| `git-context:github-star:add` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts:111` |
| `git-context:github-star:check` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts:111` |
| `git-context:mr-status` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts:487` |
| `git-context:pr-refs:list` | invoke | A（git 与工作树） | 14 | `git-context/ipc.ts:357` |
| `git-context:pr-refs:list-all` | invoke | A（git 与工作树） | 3 | `git-context/ipc.ts:363` |
| `git-context:pr-refs:manage` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts:373` |
| `git-context:pr-status` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts:486` |
| `git-context:unwatch` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts:352` |
| `git-context:watch` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts:347` |

### git-review

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `git-review:branch-diff` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:736` |
| `git-review:commit` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:826` |
| `git-review:commit-diff` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:727` |
| `git-review:commits` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:718` |
| `git-review:discard-all` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:806` |
| `git-review:discard-file` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:791` |
| `git-review:discard-hunk` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:821` |
| `git-review:file-diff` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:745` |
| `git-review:get` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:700` |
| `git-review:image-preview` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:754` |
| `git-review:markdown-preview` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:763` |
| `git-review:open-file` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:772` |
| `git-review:push` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:831` |
| `git-review:remote-op` | invoke | A（git 与工作树） | 0 | `git-review/device-op.ts:192` |
| `git-review:stage-all` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:796` |
| `git-review:stage-file` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:781` |
| `git-review:stage-hunk` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:811` |
| `git-review:summary` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:709` |
| `git-review:unstage-all` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:801` |
| `git-review:unstage-file` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:786` |
| `git-review:unstage-hunk` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts:816` |

### hook-control

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `maker:hook-control:add-binding` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1030` |
| `maker:hook-control:bind-revoke` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1000` |
| `maker:hook-control:bind-start` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:991` |
| `maker:hook-control:cancel-pending-bind` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1057` |
| `maker:hook-control:get` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:808` |
| `maker:hook-control:prefs-get` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1067` |
| `maker:hook-control:prefs-set` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1073` |
| `maker:hook-control:provider-bind-cancel` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:869` |
| `maker:hook-control:provider-bind-revoke` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:899` |
| `maker:hook-control:provider-bind-select` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:882` |
| `maker:hook-control:provider-bind-start` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:853` |
| `maker:hook-control:provider-open-action` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:915` |
| `maker:hook-control:provider-prefs-get` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1091` |
| `maker:hook-control:provider-prefs-set` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1098` |
| `maker:hook-control:rebind-team` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1034` |
| `maker:hook-control:revoke-team` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1045` |
| `maker:hook-control:set-enabled` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:816` |
| `maker:hook-control:set-lifecycle-announcement` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:831` |
| `maker:hook-control:set-provider-default-workspace` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:962` |
| `maker:hook-control:set-provider-enabled` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:843` |
| `maker:hook-control:set-slack-communications` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1040` |
| `maker:hook-control:set-workspaces` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:948` |
| `maker:hook-control:set-x-companion` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:979` |
| `maker:hook-control:telegram-behavior-get` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1117` |
| `maker:hook-control:telegram-behavior-set` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1128` |
| `maker:hook-control:telegram-group-activation-set` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1193` |
| `maker:hook-control:telegram-groups-list` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1164` |
| `maker:hook-control:workspace-provider-source-get` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1221` |
| `maker:hook-control:workspace-provider-source-set` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts:1226` |

### im

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `binding:list-attached` | invoke | A（伙伴与 IM） | 4 | `im/index.ts:583` |
| `binding:resolve-session` | invoke | A（伙伴与 IM） | 15 | `im/index.ts:571` |
| `binding:revoke` | invoke | A（伙伴与 IM） | 0 | `im/index.ts:597` |
| `botImConnection:add` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts:809` |
| `botImConnection:adopt` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImPersonalAdoption.ts:288` |
| `botImConnection:archive-lane` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts:863` |
| `botImConnection:list` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts:805` |
| `botImConnection:list-adoptable` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImPersonalAdoption.ts:284` |
| `botImConnection:list-discord-channels` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts:825` |
| `botImConnection:list-groups` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts:819` |
| `botImConnection:list-lanes` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts:848` |
| `botImConnection:remove` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts:813` |
| `botImConnection:reset-lane` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts:854` |
| `botImConnection:set-discord-channel-access` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts:831` |
| `botImConnection:set-group-activation` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts:837` |
| `desktop:cc-prefs-changed` | event | A（伙伴与 IM） | 4 | `im/index.ts:262` |
| `dingtalkBot:clear` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/dingtalk/index.ts:231` |
| `dingtalkBot:get-state` | invoke | A（伙伴与 IM） | 1 | `packages/lizi-im/src/dingtalk/index.ts:204` |
| `dingtalkBot:reconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/dingtalk/index.ts:223` |
| `dingtalkBot:save` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/dingtalk/index.ts:205` |
| `discordBot:check-session-auth` | invoke | A（伙伴与 IM） | 0 | `im/discord/sessionAuth.ts:79` |
| `discordBot:disconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts:374` |
| `discordBot:get-channel-access` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts:381` |
| `discordBot:get-status` | invoke | A（伙伴与 IM） | 1 | `packages/lizi-im/src/discord/index.ts:351` |
| `discordBot:list-channels` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts:377` |
| `discordBot:reconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts:347` |
| `discordBot:set-channel-access` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts:382` |
| `discordBot:set-config` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts:346` |
| `discordBot:set-lifecycle-announcement` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts:357` |
| `feishuBot:clear` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/feishu/ipc.ts:115` |
| `feishuBot:get-state` | invoke | A（伙伴与 IM） | 2 | `packages/lizi-im/src/feishu/ipc.ts:93` |
| `feishuBot:reconnect` | invoke | A（伙伴与 IM） | 0 | `im/index.ts:590` |
| `feishuBot:registration-begin` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/feishu/ipc.ts:128` |
| `feishuBot:registration-cancel` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/feishu/ipc.ts:163` |
| `feishuBot:save` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/feishu/ipc.ts:95` |
| `feishuBot:set-lifecycle-announcement` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/feishu/ipc.ts:120` |
| `telegramBot:check-session-auth` | invoke | A（伙伴与 IM） | 0 | `im/telegram/sessionAuth.ts:88` |
| `telegramBot:disconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/telegram/index.ts:791` |
| `telegramBot:get-behavior` | invoke | A（伙伴与 IM） | 0 | `im/host.ts:295` |
| `telegramBot:get-persona` | invoke | A（伙伴与 IM） | 0 | `im/host.ts:325` |
| `telegramBot:get-status` | invoke | A（伙伴与 IM） | 1 | `packages/lizi-im/src/telegram/index.ts:764` |
| `telegramBot:list-groups` | invoke | A（伙伴与 IM） | 0 | `im/host.ts:304` |
| `telegramBot:set-behavior` | invoke | A（伙伴与 IM） | 0 | `im/host.ts:299` |
| `telegramBot:set-config` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/telegram/index.ts:762` |
| `telegramBot:set-group-activation` | invoke | A（伙伴与 IM） | 0 | `im/host.ts:316` |
| `telegramBot:set-online` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/telegram/index.ts:771` |
| `telegramBot:set-persona` | invoke | A（伙伴与 IM） | 0 | `im/host.ts:329` |
| `wechatBot:authorize` | invoke | A（伙伴与 IM） | 0 | `im/index.ts:458` |
| `wechatBot:cancel-authorization` | invoke | A（伙伴与 IM） | 0 | `im/index.ts:462` |
| `wechatBot:choose-working-directory` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `im/index.ts:482` |
| `wechatBot:get-channel-settings` | invoke | A（伙伴与 IM） | 1 | `im/index.ts:471` |
| `wechatBot:get-state` | invoke | A（伙伴与 IM） | 1 | `im/index.ts:454` |
| `wechatBot:reset-working-directory` | invoke | A（伙伴与 IM） | 0 | `im/index.ts:511` |
| `wechatBot:set-companion` | invoke | A（伙伴与 IM） | 0 | `im/index.ts:475` |
| `wechatBot:unbind` | invoke | A（伙伴与 IM） | 0 | `im/index.ts:467` |
| `wecomBot:disconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/wecom/index.ts:292` |
| `wecomBot:get-status` | invoke | A（伙伴与 IM） | 1 | `packages/lizi-im/src/wecom/index.ts:279` |
| `wecomBot:reconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/wecom/index.ts:283` |
| `wecomBot:set-config` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/wecom/index.ts:280` |

### ipc

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `dev:embedding:status` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `ipc/dev/embedding.ts:24` |
| `dev:embedding:test-embed` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `ipc/dev/embedding.ts:39` |

### layout

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `layout:get` | event | A（设置与偏好） | 3 | `layout/index.ts:44` |
| `layout:reset` | invoke | contract | 0 | `layout/index.ts:56` |
| `layout:set` | invoke | contract | 0 | `layout/index.ts:48` |

### learn-host

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `learn:apply` | invoke | A（记忆、学习与钩子） | 0 | `learn-host/registerIpc.ts:112` |
| `learn:cancel` | invoke | A（记忆、学习与钩子） | 0 | `learn-host/registerIpc.ts:129` |
| `learn:discard` | invoke | A（记忆、学习与钩子） | 0 | `learn-host/registerIpc.ts:120` |
| `learn:get-proposal-diff` | invoke | A（记忆、学习与钩子） | 0 | `learn-host/registerIpc.ts:102` |
| `learn:list-runs` | invoke | A（记忆、学习与钩子） | 18 | `learn-host/registerIpc.ts:90` |
| `learn:start` | invoke | A（记忆、学习与钩子） | 0 | `learn-host/registerIpc.ts:77` |

### legacyUserDataMigration

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `legacy-migration:confirm` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `legacyUserDataMigration.ts:567` |
| `legacy-migration:get-state` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `legacyUserDataMigration.ts:577` |

### local-agent

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `local-agent:confirmation:answer` | invoke | A（设备互联与远程执行） | 0 | `local-agent/confirmation.ts:15` |

### local-model-runtime

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `maker:llamacpp:cancel` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts:148` 等 2 处 |
| `maker:llamacpp:download` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts:132` 等 2 处 |
| `maker:llamacpp:ensure` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts:77` 等 2 处 |
| `maker:llamacpp:files` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts:120` 等 2 处 |
| `maker:llamacpp:install` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts:119` 等 2 处 |
| `maker:llamacpp:start` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts:142` 等 2 处 |
| `maker:llamacpp:status` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts:83` 等 2 处 |
| `maker:llamacpp:stop` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts:147` 等 2 处 |
| `maker:local-model:abort` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:163` |
| `maker:local-model:delete` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:249` |
| `maker:local-model:discard-paused` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:241` |
| `maker:local-model:ensure` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:204` |
| `maker:local-model:install` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:171` |
| `maker:local-model:install-abort` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:199` |
| `maker:local-model:list` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:96` |
| `maker:local-model:pull` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:127` |
| `maker:local-model:set-in-picker` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:223` |
| `maker:local-model:start` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:90` |
| `maker:local-model:status` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts:85` |

### local-themes

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `local-themes:import` | invoke | C（设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog） | 0 | `local-themes/register.ts:55` |
| `local-themes:list` | invoke | A（设置与偏好） | 1 | `local-themes/register.ts:48` |
| `local-themes:list-sync` | event | A（设置与偏好） | 3 | `local-themes/register.ts:44` |
| `local-themes:open-dir` | invoke | C（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `local-themes/register.ts:51` |
| `local-themes:write` | invoke | A（设置与偏好） | 0 | `local-themes/register.ts:49` |

### localDb

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `dev:sqlite-vec:status` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `localDb/ipc/dev/sqliteVec.ts:14` |
| `local-db:bots:choose-avatar` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `localDb/ipc/bots.ts:2528` |
| `local-db:bots:choose-avatar-source` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `localDb/ipc/bots.ts:2506` |
| `local-db:bots:create` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2586` |
| `local-db:bots:create-canonical-session` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2809` |
| `local-db:bots:dm-thread:ensure` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2923` |
| `local-db:bots:dm-thread:list` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2937` |
| `local-db:bots:generate-avatar` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2415` |
| `local-db:bots:generate-draft` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2421` |
| `local-db:bots:get` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2493` |
| `local-db:bots:history` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2947` |
| `local-db:bots:list` | invoke | A（伙伴与 IM） | 5 | `localDb/ipc/bots.ts:2457` |
| `local-db:bots:memory:delete` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2909` |
| `local-db:bots:memory:list` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2881` |
| `local-db:bots:memory:read` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2887` |
| `local-db:bots:memory:update` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2892` |
| `local-db:bots:model-chain-settings-get` | invoke | A（伙伴与 IM） | 6 | `localDb/ipc/bots.ts:2429` |
| `local-db:bots:model-chain-settings-reset` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2444` |
| `local-db:bots:model-chain-settings-set` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2435` |
| `local-db:bots:projects:list` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2844` |
| `local-db:bots:projects:set` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2844` |
| `local-db:bots:search-history` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2573` |
| `local-db:bots:skills:core` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/botSkillSettingsIpc.ts:128` |
| `local-db:bots:skills:delete` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/botSkillSettingsIpc.ts:145` |
| `local-db:bots:skills:list` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2871` |
| `local-db:bots:skills:read` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/botSkillSettingsIpc.ts:132` |
| `local-db:bots:skills:save` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/botSkillSettingsIpc.ts:136` |
| `local-db:bots:skills:set-enabled` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/botSkillSettingsIpc.ts:140` |
| `local-db:bots:update` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts:2602` |
| `local-db:bots:workbench:follow-scopes` | invoke | A（伙伴与 IM） | 1 | `localDb/ipc/bots.ts:2855` |
| `local-db:conversations:search` | invoke | contract | 0 | `localDb/ipc/search.desktop.ts:5` |
| `local-db:ensure-ready` | invoke | A（任务、消息与输入队列） | 1 | `localDb/ipc/registerAll.ts:207` |
| `local-db:history:messages` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/history.ts:306` |
| `local-db:history:query` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/historyQuery.ts:68` |
| `local-db:messages:around` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts:521` |
| `local-db:messages:around-client-id` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts:604` |
| `local-db:messages:create` | invoke | contract | 0 | `localDb/ipc/messages.ts:740` |
| `local-db:messages:dismiss-error` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts:831` |
| `local-db:messages:estimatedSessionValue` | invoke | contract | 15 | `localDb/ipc/messages.ts:689` |
| `local-db:messages:list` | invoke | contract | 1 | `localDb/ipc/messages.ts:396` |
| `local-db:messages:updateAgentMeta` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts:793` |
| `local-db:messages:updateContent` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts:812` |
| `local-db:messages:view` | invoke | contract | 16 | `localDb/ipc/messages.ts:473` |
| `local-db:messages:view-intent` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts:496` |
| `local-db:messages:work-details` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts:503` |
| `local-db:orca-workflows:get-by-lead` | invoke | A（Orca） | 0 | `localDb/ipc/orcaTeams.ts:42` |
| `local-db:orca-workflows:get-by-worker-session` | invoke | A（Orca） | 0 | `localDb/ipc/orcaTeams.ts:49` |
| `local-db:orca-workflows:list-workers-by-lead` | invoke | A（Orca） | 0 | `localDb/ipc/orcaTeams.ts:56` |
| `local-db:orca-workflows:list-workers-by-leads` | invoke | A（Orca） | 0 | `localDb/ipc/orcaTeams.ts:64` |
| `local-db:orca-workflows:update-worker-status` | invoke | A（Orca） | 0 | `localDb/ipc/orcaTeams.ts:72` |
| `local-db:project-aliases:delete` | invoke | contract | 0 | `localDb/ipc/projectAliases.ts:91` |
| `local-db:project-aliases:list` | invoke | contract | 15 | `localDb/ipc/projectAliases.ts:79` |
| `local-db:project-aliases:set` | invoke | contract | 0 | `localDb/ipc/projectAliases.ts:86` |
| `local-db:recent-workdirs:list` | invoke | contract | 3 | `localDb/ipc/recentWorkdirs.ts:9` |
| `local-db:recent-workdirs:remove` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/recentWorkdirs.ts:10` |
| `local-db:right-sidebar-tabs:close` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/rightSidebarTabs.ts:273` |
| `local-db:right-sidebar-tabs:ensure-singleton` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/rightSidebarTabs.ts:163` |
| `local-db:right-sidebar-tabs:list` | invoke | A（任务、消息与输入队列） | 13 | `localDb/ipc/rightSidebarTabs.ts:129` |
| `local-db:right-sidebar-tabs:reorder` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/rightSidebarTabs.ts:331` |
| `local-db:right-sidebar-tabs:setActive` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/rightSidebarTabs.ts:296` |
| `local-db:right-sidebar-tabs:upsert` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/rightSidebarTabs.ts:231` |
| `local-db:session-share:cancel` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/session-share.ts:248` |
| `local-db:session-share:classify-path` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/session-share.ts:257` |
| `local-db:session-share:commit` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/session-share.ts:161` |
| `local-db:session-share:export` | invoke | C（任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.getFocusedWindow、dialog） | 0 | `localDb/ipc/session-share.ts:75` |
| `local-db:session-share:inspect` | invoke | C（任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.getFocusedWindow、dialog） | 0 | `localDb/ipc/session-share.ts:114` |
| `local-db:session-share:unlock` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/session-share.ts:146` |
| `local-db:sessions:ack-interrupted` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts:1615` |
| `local-db:sessions:create` | invoke | contract | 1 | `localDb/ipc/sessions.ts:1495` |
| `local-db:sessions:dismiss-pending-alerts` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts:1562` |
| `local-db:sessions:error-tail-pending` | invoke | contract | 36 | `localDb/ipc/sessions.ts:1544` |
| `local-db:sessions:get` | invoke | contract | 32 | `localDb/ipc/sessions.ts:1645` |
| `local-db:sessions:get-many` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts:1631` |
| `local-db:sessions:interrupted-pending` | invoke | contract | 1 | `localDb/ipc/sessions.ts:1509` |
| `local-db:sessions:interrupted-resume-candidates` | invoke | contract | 1 | `localDb/ipc/sessions.ts:1516` |
| `local-db:sessions:list` | invoke | contract | 12 | `localDb/ipc/sessions.ts:1368` |
| `local-db:sessions:patch-meta` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts:1788` |
| `local-db:sessions:resolve-references` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts:1657` |
| `local-db:sessions:restore-if-archived` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts:1700` |
| `local-db:sessions:set-pinned-card-summaries` | invoke | A（任务、消息与输入队列） | 1 | `localDb/ipc/sessions.ts:1815` |
| `local-db:sessions:touchUserSend` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts:1804` |
| `local-db:sessions:update` | invoke | contract | 0 | `localDb/ipc/sessions.ts:1772` |
| `local-db:subagent-runs:detail` | invoke | contract | 0 | `localDb/ipc/subagentRuns.ts:83` |
| `local-db:subagent-runs:list` | invoke | contract | 30 | `localDb/ipc/subagentRuns.ts:83` |
| `local-db:subagent-runs:transcript` | invoke | contract | 0 | `localDb/ipc/subagentRuns.ts:83` |
| `local-db:task-tags:execute` | invoke | contract | 0 | `localDb/ipc/taskTags.ts:32` |
| `sidebar-settings:get-project-aliases` | invoke | A（设置与偏好） | 0 | `localDb/ipc/projectAliases.ts:75` |

### log-upload

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `log-upload:reset-crash-auto` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `log-upload/index.ts:404` |
| `log-upload:set-crash-auto` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `log-upload/index.ts:383` |
| `log-upload:settings-get` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 2 | `log-upload/index.ts:378` |
| `log-upload:upload-now` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `log-upload/index.ts:418` |

### login-item-ipc

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `login-item:get` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 2 | `login-item-ipc.ts:14` |
| `login-item:set` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `login-item-ipc.ts:18` |

### maker-host

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `maker:model-visibility:legacy-owner-claim-sync` | event | contract | 0 | `maker-host/model-visibility-owner-claim.ts:126` |

### maker-ipc

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `ghosts:background-tasks:list` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts:15067` |
| `ghosts:background-tasks:reveal` | invoke | C（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `maker-ipc/register.ts:15071` |
| `input-handoff:picture` | invoke | C（运行时发起、窗口收集用户输入（安全输入交接）） | 0 | `maker-ipc/register.ts:22725` |
| `input-handoff:raise` | invoke | C（运行时发起、窗口收集用户输入（安全输入交接）） | 0 | `maker-ipc/register.ts:22717` |
| `input-handoff:submit` | invoke | C（运行时发起、窗口收集用户输入（安全输入交接）） | 0 | `maker-ipc/register.ts:22709` |
| `local-db:bots:read-state:get` | invoke | A（伙伴与 IM） | 1 | `maker-ipc/botReadStateIpc.ts:84` |
| `local-db:bots:read-state:update` | invoke | A（伙伴与 IM） | 6 | `maker-ipc/botReadStateIpc.ts:93` |
| `maker:abort-session` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22499` |
| `maker:agent-resource-settings:get` | invoke | A（设置与偏好） | 2 | `maker-ipc/register.ts:16665` |
| `maker:agent-resource-settings:reset` | invoke | A（设置与偏好） | 0 | `maker-ipc/register.ts:16671` |
| `maker:agent-resource-settings:set` | invoke | A（设置与偏好） | 0 | `maker-ipc/register.ts:16668` |
| `maker:agent-task:stop` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/stopAgentTaskHandler.ts:29` |
| `maker:agent:binary-version` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 3 | `maker-ipc/binary-version.ts:168` |
| `maker:agent:pi-kernel-install` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/pi-kernel.ts:60` |
| `maker:agent:pi-kernel-state` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 2 | `maker-ipc/pi-kernel.ts:59` |
| `maker:agent:status` | invoke | contract | 13 | `maker-ipc/statusHandlers.ts:14` |
| `maker:android:get-config` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `maker-ipc/androidHandlers.ts:102` |
| `maker:android:prepare-adb` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/androidHandlers.ts:132` |
| `maker:android:set-adb-path` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/androidHandlers.ts:121` |
| `maker:android:set-default-device` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/androidHandlers.ts:110` |
| `maker:android:status` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/androidHandlers.ts:94` |
| `maker:any-session-in-turn` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:7214` |
| `maker:api-key:present` | invoke | A（账号与凭据） | 0 | `maker-ipc/authHandlers.ts:428` |
| `maker:apply-new-maker-draft-pref` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:7519` |
| `maker:apply-new-maker-worktree-branch-pref` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/newMakerWorktreeBranchPreferenceHandler.ts:82` |
| `maker:apply-new-maker-worktree-pref` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/newMakerWorktreePreferenceHandler.ts:24` |
| `maker:at-context:list` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:8593` |
| `maker:auth:cancel-login` | invoke | contract | 0 | `maker-ipc/authHandlers.ts:481` |
| `maker:auth:get-state` | invoke | contract | 1 | `maker-ipc/authHandlers.ts:422` |
| `maker:auth:logout` | invoke | contract | 0 | `maker-ipc/authHandlers.ts:518` |
| `maker:auth:trigger-login` | invoke | contract | 0 | `maker-ipc/authHandlers.ts:433` |
| `maker:auto-title` | invoke | A（任务、消息与输入队列） | 1 | `maker-ipc/title.ts:667` |
| `maker:auxiliary-model-settings:get` | invoke | A（供应商与模型） | 1 | `maker-ipc/auxiliary-model-settings.ts:195` |
| `maker:auxiliary-model-settings:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/auxiliary-model-settings.ts:232` |
| `maker:background-task:output-tail` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:7384` |
| `maker:bot-delegation:cancel` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14139` |
| `maker:bot-delegations:list` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:13844` |
| `maker:bot-direct-message-thread:get` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:13855` |
| `maker:bot-group:continue` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14020` |
| `maker:bot-group:create` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:13964` |
| `maker:bot-group:delete` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:13976` |
| `maker:bot-group:get` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:13960` |
| `maker:bot-group:list` | invoke | A（伙伴与 IM） | 13 | `maker-ipc/register.ts:13956` |
| `maker:bot-group:outbox` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14015` |
| `maker:bot-group:outbox-command` | invoke | A（伙伴与 IM） | 51 | `maker-ipc/register.ts:14019` |
| `maker:bot-group:plan-continue` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14126` |
| `maker:bot-group:plan-dismiss` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14122` |
| `maker:bot-group:plan-edit` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14134` |
| `maker:bot-group:plan-retry` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14130` |
| `maker:bot-group:plan-start` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14028` |
| `maker:bot-group:send` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14013` |
| `maker:bot-group:set-members` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:13972` |
| `maker:bot-group:stop` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14024` |
| `maker:bot-group:update` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:13968` |
| `maker:bot-lifecycle:action` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/botLifecycleService.ts:434` |
| `maker:bot-read-state` | invoke | A（伙伴与 IM） | 4 | `maker-ipc/register.ts:14001` |
| `maker:browser:open-for-login` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts:25823` |
| `maker:browser:status` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 1 | `maker-ipc/register.ts:25814` |
| `maker:chat-server:acceptInvite` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13936` |
| `maker:chat-server:createInvite` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13921` |
| `maker:chat-server:followThread` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13906` |
| `maker:chat-server:manage` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13941` |
| `maker:chat-server:mask` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13873` |
| `maker:chat-server:mentions` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13877` |
| `maker:chat-server:ownedBots` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13946` |
| `maker:chat-server:previewInvite` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13926` |
| `maker:chat-server:react` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13901` |
| `maker:chat-server:reactors` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13916` |
| `maker:chat-server:readers` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13911` |
| `maker:chat-server:refreshProfile` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13951` |
| `maker:chat-server:reply` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13891` |
| `maker:chat-server:revokeInvite` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13931` |
| `maker:chat-server:shareToMain` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13896` |
| `maker:chat-server:status` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13881` |
| `maker:chat-server:thread` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:13886` |
| `maker:chat:display-cache` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 2 | `maker-ipc/register.ts:13980` |
| `maker:close-session` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22551` |
| `maker:collaboration-settings:get` | invoke | A（设置与偏好） | 2 | `maker-ipc/register.ts:16642` |
| `maker:collaboration-settings:reset` | invoke | A（设置与偏好） | 0 | `maker-ipc/register.ts:16657` |
| `maker:collaboration-settings:set` | invoke | A（设置与偏好） | 0 | `maker-ipc/register.ts:16646` |
| `maker:compact-session` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:25122` |
| `maker:companion-avatar:resolve` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14106` |
| `maker:companion-cloud:attachment` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14093` |
| `maker:companion-cloud:caps` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:10560` |
| `maker:companion-cloud:cindy-copies` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14082` |
| `maker:companion-cloud:dismiss-notices` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14037` |
| `maker:companion-cloud:flush` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:10570` |
| `maker:companion-cloud:hand-over` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:10574` |
| `maker:companion-cloud:home-choices` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14115` |
| `maker:companion-cloud:merge` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:10565` |
| `maker:companion-cloud:merge-cindy` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14087` |
| `maker:companion-cloud:state` | invoke | A（伙伴与 IM） | 1 | `maker-ipc/register.ts:14033` |
| `maker:companion-cloud:switch-home` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14054` |
| `maker:companion-cloud:take-over` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14048` |
| `maker:companion-cloud:targets` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:10563` |
| `maker:companion-cloud:transcript` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14061` |
| `maker:companion-live:read` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts:14888` |
| `maker:computer:cancel-permission-grant` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts:25935` |
| `maker:computer:check-update` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 1 | `maker-ipc/register.ts:25953` |
| `maker:computer:driver-icon` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts:25908` |
| `maker:computer:grant-permissions` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts:25863` |
| `maker:computer:install-driver` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts:25855` |
| `maker:computer:permission-app-drag-end` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts:25928` |
| `maker:computer:permission-app-drag-start` | event | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts:25921` |
| `maker:computer:permission-guide-status` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts:25912` |
| `maker:computer:status` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 1 | `maker-ipc/register.ts:25839` |
| `maker:computer:update-driver` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts:25965` |
| `maker:create-session` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/sessionCreateHandler.ts:87` |
| `maker:execute-desktop-command` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:8260` |
| `maker:export-session-html` | invoke | C（任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.fromWebContents、BrowserWindow.getFocusedWindow、dialog、shell） | 0 | `maker-ipc/register.ts:25084` |
| `maker:fork` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/fork.ts:79` |
| `maker:fork-strip-encrypted` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/fork.ts:123` |
| `maker:generate-title` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/title.ts:620` |
| `maker:get-capabilities` | invoke | contract | 15 | `maker-ipc/register.ts:7460` |
| `maker:get-context-usage` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:19423` |
| `maker:get-context-window-bounds` | invoke | A（任务、消息与输入队列） | 16 | `maker-ipc/register.ts:24917` |
| `maker:get-new-maker-defaults` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:7511` |
| `maker:get-new-maker-worktree-branch-pref` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/newMakerWorktreeBranchPreferenceHandler.ts:76` |
| `maker:get-pending-interactions` | invoke | contract | 30 | `maker-ipc/register.ts:22695` |
| `maker:get-plugin-write-access-recovery` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:15052` |
| `maker:get-session-agent-switch-intent` | invoke | A（任务、消息与输入队列） | 16 | `maker-ipc/sessionAgentSwitchHandler.ts:1733` |
| `maker:get-session-tree` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:25203` |
| `maker:get-workflow-progress` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:7406` |
| `maker:goal:clear` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/goal.ts:135` |
| `maker:goal:get-status` | invoke | A（任务、消息与输入队列） | 15 | `maker-ipc/goal.ts:142` |
| `maker:goal:pause` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/goal.ts:170` |
| `maker:goal:resume` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/goal.ts:178` |
| `maker:goal:set` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/goal.ts:110` |
| `maker:goal:update` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/goal.ts:188` |
| `maker:help:ask` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/help.ts:371` |
| `maker:help:feedback:create` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/help-feedback.ts:156` |
| `maker:images:retry` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22095` |
| `maker:input:cancel-usage-limit-wait` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22121` |
| `maker:input:clear-error` | invoke | contract | 0 | `maker-ipc/register.ts:22114` |
| `maker:input:clear-session` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22430` |
| `maker:input:compact` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:21786` |
| `maker:input:enqueue` | invoke | contract | 1 | `maker-ipc/register.ts:21538` |
| `maker:input:get-projection` | invoke | contract | 15 | `maker-ipc/register.ts:21496` |
| `maker:input:move` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22391` |
| `maker:input:remove` | invoke | contract | 0 | `maker-ipc/register.ts:22166` |
| `maker:input:resume` | invoke | contract | 0 | `maker-ipc/register.ts:22089` |
| `maker:input:retry-last-error` | invoke | contract | 0 | `maker-ipc/register.ts:22106` |
| `maker:input:session-reference-capability` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:21212` |
| `maker:input:set-edit-lock` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22421` |
| `maker:input:set-expanded` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22403` |
| `maker:input:set-interaction-lock` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22412` |
| `maker:input:steer` | invoke | contract | 0 | `maker-ipc/register.ts:21810` |
| `maker:input:stop` | invoke | contract | 0 | `maker-ipc/register.ts:22049` |
| `maker:input:update-content` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22267` |
| `maker:input:update-text` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22228` |
| `maker:issues:list-mine` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `maker-ipc/my-issues.ts:107` |
| `maker:issues:snapshot-mine` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `maker-ipc/my-issues.ts:101` |
| `maker:list-active` | invoke | contract | 1 | `maker-ipc/register.ts:22572` |
| `maker:list-agent-commands` | invoke | contract | 47 | `maker-ipc/register.ts:8277` |
| `maker:list-agent-skills` | invoke | contract | 32 | `maker-ipc/register.ts:8354` |
| `maker:list-available-agents` | invoke | contract | 11 | `maker-ipc/register.ts:7107` |
| `maker:list-customizations` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:8637` |
| `maker:list-desktop-commands` | invoke | A（任务、消息与输入队列） | 47 | `maker-ipc/register.ts:8248` |
| `maker:machine:status` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:16323` |
| `maker:maker-memory:reset` | invoke | A（记忆、学习与钩子） | 0 | `maker-ipc/register.ts:25701` |
| `maker:maker-memory:set-enabled` | invoke | A（记忆、学习与钩子） | 0 | `maker-ipc/register.ts:25623` |
| `maker:mark-orca-role` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:12177` |
| `maker:mcp:custom:create` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/mcpHandlers.ts:171` |
| `maker:mcp:custom:delete` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/mcpHandlers.ts:206` |
| `maker:mcp:custom:list` | invoke | A（插件、技能与 MCP） | 1 | `maker-ipc/mcpHandlers.ts:121` |
| `maker:mcp:custom:refresh` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/mcpHandlers.ts:217` |
| `maker:mcp:custom:update` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/mcpHandlers.ts:196` |
| `maker:mcp:duplicates:choose` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `maker-ipc/mcpHandlers.ts:110` |
| `maker:mcp:duplicates:list` | invoke | A（插件、技能与 MCP） | 1 | `maker-ipc/mcpHandlers.ts:106` |
| `maker:memory:get` | invoke | A（记忆、学习与钩子） | 3 | `maker-ipc/register.ts:25549` |
| `maker:memory:reset` | invoke | A（记忆、学习与钩子） | 0 | `maker-ipc/register.ts:25593` |
| `maker:memory:reset-settings` | invoke | A（记忆、学习与钩子） | 0 | `maker-ipc/register.ts:25671` |
| `maker:memory:set` | invoke | A（记忆、学习与钩子） | 0 | `maker-ipc/register.ts:25591` |
| `maker:message:delete` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/messageDeleteHandler.ts:170` |
| `maker:model-catalog:read` | invoke | A（供应商与模型） | 0 | `maker-ipc/register.ts:10492` |
| `maker:model-compaction:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2245` |
| `maker:model-context-limit:get` | invoke | A（供应商与模型） | 20 | `maker-ipc/providerHandlers.ts:2223` |
| `maker:model-context-limit:reset` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2324` |
| `maker:model-context-limit:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2291` |
| `maker:model-disable:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1914` |
| `maker:model-favorites:apply` | invoke | A（供应商与模型） | 0 | `maker-ipc/modelFavoritesSync.ts:114` |
| `maker:model-favorites:get` | invoke | A（供应商与模型） | 0 | `maker-ipc/modelFavoritesSync.ts:110` |
| `maker:model-image-input:get` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2181` |
| `maker:model-image-input:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2205` |
| `maker:model-price-override:get` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2048` |
| `maker:model-price-override:reset` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2122` |
| `maker:model-price-override:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2089` |
| `maker:model-visibility:sync` | invoke | A（供应商与模型） | 7 | `maker-ipc/register.ts:6657` |
| `maker:navigate-session-tree` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:25218` |
| `maker:orca:execution-devices` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:16329` |
| `maker:orca:remote-worker:bridge` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:10685` |
| `maker:orca:remote-worker:caps` | invoke | A（Orca） | 0 | `maker-ipc/orcaRemoteWorkerHost.ts:217` |
| `maker:orca:remote-worker:models` | invoke | A（Orca） | 0 | `maker-ipc/orcaRemoteWorkerHost.ts:218` |
| `maker:orca:remote-worker:open` | invoke | A（Orca） | 0 | `maker-ipc/orcaRemoteWorkerHost.ts:219` |
| `maker:orca:remote-worker:release` | invoke | A（Orca） | 0 | `maker-ipc/orcaRemoteWorkerHost.ts:220` |
| `maker:persist-turn-error-deferred` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:22138` |
| `maker:pi-packages:list` | invoke | A（插件、技能与 MCP） | 1 | `maker-ipc/register.ts:8423` |
| `maker:pi-packages:mutate` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts:8436` |
| `maker:pi-subagent:control` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:7286` |
| `maker:plugin-setup:submit-inline` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts:22684` |
| `maker:plugins:clear-enabled` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts:25786` |
| `maker:plugins:clear-project-enabled` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/projectPluginPolicyHandlers.ts:50` |
| `maker:plugins:get-state` | invoke | A（插件、技能与 MCP） | 21 | `maker-ipc/register.ts:25727` |
| `maker:plugins:list` | invoke | A（插件、技能与 MCP） | 1 | `maker-ipc/pluginListHandler.ts:20` |
| `maker:plugins:set-enabled` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts:25759` |
| `maker:plugins:set-project-enabled` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/projectPluginPolicyHandlers.ts:31` |
| `maker:predict-prompt` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/title.ts:683` |
| `maker:project-automation:list-consents` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/project-automation.ts:94` |
| `maker:project-automation:pending-imports` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `maker-ipc/project-automation.ts:85` |
| `maker:project-automation:reconcile` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/project-automation.ts:71` |
| `maker:project-automation:remove-schedule` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/project-automation.ts:138` |
| `maker:project-automation:revoke-consent` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/project-automation.ts:105` |
| `maker:project-automation:upsert-schedule` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/project-automation.ts:123` |
| `maker:provider:account-usage` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2767` |
| `maker:provider:custom:create` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2409` |
| `maker:provider:custom:delete` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2757` |
| `maker:provider:custom:disconnect` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:3089` |
| `maker:provider:custom:update` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2610` |
| `maker:provider:detect` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2817` |
| `maker:provider:import:cancel` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1500` |
| `maker:provider:import:confirm` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1640` |
| `maker:provider:import:file` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1450` |
| `maker:provider:import:local-edit` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1438` |
| `maker:provider:import:local-scan` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1397` |
| `maker:provider:import:preview` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1477` |
| `maker:provider:list` | invoke | contract | 24 | `maker-ipc/providerHandlers.ts:1273` |
| `maker:provider:local-cli-scan` | invoke | A（供应商与模型） | 1 | `maker-ipc/providerHandlers.ts:2919` |
| `maker:provider:models-auto-refresh` | invoke | A（供应商与模型） | 1 | `maker-ipc/providerHandlers.ts:1302` |
| `maker:provider:models-fetch` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2915` |
| `maker:provider:models-rediscover` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2972` |
| `maker:provider:models-refresh` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1278` |
| `maker:provider:oauth:cancel` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:3180` |
| `maker:provider:oauth:login` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2986` |
| `maker:provider:oauth:logout` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:3125` |
| `maker:provider:order:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1773` |
| `maker:provider:presentation:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1725` |
| `maker:provider:presets` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2762` |
| `maker:provider:remote-access:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1919` |
| `maker:provider:run-location:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:1951` |
| `maker:provider:test-connection` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts:2777` |
| `maker:regenerate-title` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/title.ts:631` |
| `maker:resolve-interaction` | invoke | contract | 0 | `maker-ipc/register.ts:22601` |
| `maker:retry-plugin-write-access` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:15053` |
| `maker:review:start` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/reviewStartHandler.ts:291` |
| `maker:rewind:commit` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/rewind.ts:143` |
| `maker:rewind:preview` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/rewind.ts:114` |
| `maker:run` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:25710` |
| `maker:runtime-plugins` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts:18448` |
| `maker:scan-at-resources` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:8543` |
| `maker:schedule:create` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:421` |
| `maker:schedule:create-from-template` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:741` |
| `maker:schedule:delete` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:468` |
| `maker:schedule:delete-run` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:675` |
| `maker:schedule:generate-pre-run-hook` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:529` |
| `maker:schedule:get` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:416` |
| `maker:schedule:get-inflight-count` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:683` |
| `maker:schedule:get-runtime-state` | invoke | A（自动化） | 1 | `maker-ipc/schedule.ts:691` |
| `maker:schedule:get-unread-count` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:695` |
| `maker:schedule:list` | invoke | A（自动化） | 1 | `maker-ipc/schedule.ts:410` |
| `maker:schedule:list-cost-summaries` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:673` |
| `maker:schedule:list-runs` | invoke | A（自动化） | 1 | `maker-ipc/schedule.ts:651` |
| `maker:schedule:list-sidebar-index-runs` | invoke | A（自动化） | 2 | `maker-ipc/schedule.ts:665` |
| `maker:schedule:list-templates` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:735` |
| `maker:schedule:mark-all-runs-read` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:699` |
| `maker:schedule:mark-run-read` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:711` |
| `maker:schedule:mark-schedule-runs-read` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:723` |
| `maker:schedule:pause` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:487` |
| `maker:schedule:resume` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:490` |
| `maker:schedule:run-now` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:496` |
| `maker:schedule:script-capability-status` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:839` |
| `maker:schedule:test-pre-run-hook` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:627` |
| `maker:schedule:update` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:436` |
| `maker:schedule:webhook-account` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:796` |
| `maker:schedule:webhook-receiver` | invoke | A（自动化） | 1 | `maker-ipc/schedule.ts:780` |
| `maker:schedule:webhook-release` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:797` |
| `maker:schedule:webhook-restore` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:802` |
| `maker:schedule:webhook-rotate-url` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:836` |
| `maker:schedule:webhook-set-secret` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:831` |
| `maker:schedule:webhook-status` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts:771` |
| `maker:send` | invoke | contract | 0 | `maker-ipc/sessionSendHandler.ts:36` |
| `maker:session-background-activity` | invoke | A（任务、消息与输入队列） | 15 | `maker-ipc/register.ts:7229` |
| `maker:session-background-activity:list` | invoke | A（任务、消息与输入队列） | 1 | `maker-ipc/register.ts:7235` |
| `maker:session-background-tasks:list` | invoke | A（任务、消息与输入队列） | 28 | `maker-ipc/register.ts:7366` |
| `maker:session-background-tasks:stop` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/stopSessionBackgroundTasksHandler.ts:25` |
| `maker:session-background-work:list` | invoke | A（任务、消息与输入队列） | 1 | `maker-ipc/register.ts:7240` |
| `maker:session-in-turn` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:7218` |
| `maker:session:commit-provisional` | invoke | A（任务、消息与输入队列） | 1 | `maker-ipc/register.ts:19566` |
| `maker:session:disable-orca` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:15867` |
| `maker:session:discard-provisional` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:19541` |
| `maker:session:enable-orca` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:15586` |
| `maker:session:handoff` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/sessionHandoffIpc.ts:160` |
| `maker:session:prewarm` | invoke | A（任务、消息与输入队列） | 1 | `maker-ipc/register.ts:19527` |
| `maker:session:turn-active` | invoke | A（任务、消息与输入队列） | 2 | `maker-ipc/register.ts:19407` |
| `maker:set-context-window-budget` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:24884` |
| `maker:set-effort` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:24717` |
| `maker:set-extra-dirs` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:25512` |
| `maker:set-fast-mode` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:25311` |
| `maker:set-model` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/sessionSetModelHandler.ts:13` |
| `maker:set-permission-mode` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:24965` |
| `maker:set-plan-mode` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:25032` |
| `maker:set-session-model-pref` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:7602` |
| `maker:set-thinking-enabled` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:25492` |
| `maker:set-writable-dirs` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:25529` |
| `maker:side-chat:list:v1` | invoke | A（任务、消息与输入队列） | 16 | `maker-ipc/fork.ts:51` |
| `maker:side-chat:v1` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/fork.ts:55` |
| `maker:steer` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:19369` |
| `maker:switch-session-agent` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/sessionAgentSwitchHandler.ts:1684` |
| `maker:sync-new-maker-draft` | event | A（未登记前缀，处理函数没有用到窗口 API） | 4 | `maker-ipc/register.ts:6650` |
| `maker:sync-provider-model-memory` | event | A（供应商与模型） | 1 | `maker-ipc/register.ts:7099` |
| `maker:sync-session-model-pref` | event | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts:7642` |
| `maker:sync-worker-creation-prefs` | event | A（Orca） | 5 | `maker-ipc/register.ts:7060` |
| `maker:team:end` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:15989` |
| `maker:turn-change-set:apply` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:7207` |
| `maker:turn-change-sets:get` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts:7120` |
| `maker:turn-change-sets:list` | invoke | contract | 15 | `maker-ipc/register.ts:7111` |
| `maker:usage:account` | invoke | A（供应商与模型） | 7 | `maker-ipc/usageHandlers.ts:105` |
| `maker:usage:claude-subscription` | invoke | A（供应商与模型） | 6 | `maker-ipc/usageHandlers.ts:164` |
| `maker:usage:codex-rate-limit-reset` | invoke | A（供应商与模型） | 0 | `maker-ipc/usageHandlers.ts:136` |
| `maker:usage:codex-rate-limits` | invoke | A（供应商与模型） | 6 | `maker-ipc/usageHandlers.ts:124` |
| `maker:usage:codex-reset-auto-use` | invoke | A（供应商与模型） | 0 | `maker-ipc/usageHandlers.ts:153` |
| `maker:usage:device-rows` | invoke | A（供应商与模型） | 0 | `maker-ipc/usageHandlers.ts:234` |
| `maker:usage:history` | invoke | A（供应商与模型） | 1 | `maker-ipc/usageHandlers.ts:190` |
| `maker:usage:model-pricing` | invoke | contract | 0 | `maker-ipc/usageHandlers.ts:175` |
| `maker:usage:model-pricing-v2` | invoke | contract | 1 | `maker-ipc/usageHandlers.ts:180` |
| `maker:usage:reference-model-pricing` | invoke | contract | 1 | `maker-ipc/usageHandlers.ts:184` |
| `maker:usage:today` | invoke | A（供应商与模型） | 0 | `maker-ipc/usageHandlers.ts:101` |
| `maker:usage:xai-subscription` | invoke | A（供应商与模型） | 0 | `maker-ipc/usageHandlers.ts:169` |
| `maker:worker-roles:apply` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:7087` |
| `maker:worker-roles:get` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:7086` |
| `maker:worker:acknowledge-done` | invoke | A（Orca） | 0 | `maker-ipc/orcaWorkerControlHandlers.ts:49` |
| `maker:worker:archive` | invoke | A（Orca） | 0 | `maker-ipc/orcaWorkerControlHandlers.ts:52` |
| `maker:worker:create` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:15879` |
| `maker:worker:dispatch-ui-assignment` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:15654` |
| `maker:worker:idle` | invoke | A（Orca） | 0 | `maker-ipc/orcaWorkerControlHandlers.ts:46` |
| `maker:worker:list` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:15944` |
| `maker:worker:project-context` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:15874` |
| `maker:worker:project-label` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:15875` |
| `maker:worker:switch-focus` | invoke | A（Orca） | 0 | `maker-ipc/register.ts:15950` |
| `maker:worker:update` | invoke | A（Orca） | 0 | `maker-ipc/orcaWorkerControlHandlers.ts:69` |
| `maker:working-status` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/workingStatus.ts:104` |
| `maker:write-plan-file` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/plan-write.ts:25` |
| `model-favorites:host-changed` | event | A（供应商与模型） | 0 | `maker-ipc/modelFavoritesSync.ts:50` |
| `model-favorites:host-ready` | event | A（供应商与模型） | 1 | `maker-ipc/modelFavoritesSync.ts:34` |
| `model-favorites:host-reply` | event | A（供应商与模型） | 0 | `maker-ipc/modelFavoritesSync.ts:44` |
| `terminal:create` | invoke | C（终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道） | 0 | `maker-ipc/terminal-handlers.ts:77` |
| `terminal:dispose` | invoke | C（终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道） | 0 | `maker-ipc/terminal-handlers.ts:117` |
| `terminal:get-default-shell-pref` | invoke | C（终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道） | 1 | `maker-ipc/terminal-handlers.ts:144` |
| `terminal:list-available-shells` | invoke | C（终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道） | 1 | `maker-ipc/terminal-handlers.ts:140` |
| `terminal:resize` | invoke | C（终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道） | 0 | `maker-ipc/terminal-handlers.ts:109` |
| `terminal:restart` | invoke | C（终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道） | 0 | `maker-ipc/terminal-handlers.ts:122` |
| `terminal:set-default-shell-pref` | invoke | C（终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道） | 0 | `maker-ipc/terminal-handlers.ts:148` |
| `terminal:write` | invoke | C（终端 PTY：放窗口则换窗口时断开，放后台需要流式输出通道） | 0 | `maker-ipc/terminal-handlers.ts:102` |
| `worktree:cancel-precreated` | invoke | A（git 与工作树） | 0 | `maker-ipc/precreatedWorktreeDiscardHandler.ts:124` 等 2 处 |
| `worktree:discard-precreated` | invoke | A（git 与工作树） | 0 | `maker-ipc/precreatedWorktreeDiscardHandler.ts:123` 等 2 处 |

### mcp-apps

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `maker:mcp-apps:v1` | invoke | C（插件、技能与 MCP，但处理函数用到窗口 API：shell） | 0 | `mcp-apps/ipc.ts:117` |

### mcp-integrations

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `browser-backend:get-health` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 1 | `mcp-integrations/browser.ts:755` |
| `browser-backend:get-state` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 1 | `mcp-integrations/browser.ts:751` |
| `browser-backend:open-extension-store` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `mcp-integrations/browser.ts:758` |
| `browser-backend:probe-source-read` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `mcp-integrations/browser.ts:757` |
| `browser-backend:recover` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `mcp-integrations/browser.ts:756` |
| `browser-backend:reset` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `mcp-integrations/browser.ts:754` |
| `browser-backend:set-kind` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `mcp-integrations/browser.ts:752` |
| `browser-backend:set-use-real-profile` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `mcp-integrations/browser.ts:753` |
| `rsb-browser-bridge:set-active-session` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `mcp-integrations/browser.ts:760` |

### menubar

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `menubar:get-state` | invoke | B（窗口外壳、窗口布局与多窗口） | 2 | `menubar/ipc.ts:10` |
| `menubar:set-enabled` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `menubar/ipc.ts:14` |

### model-access

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `model-access:get-status` | invoke | contract | 10 | `model-access/index.ts:608` |
| `model-access:retry` | invoke | contract | 0 | `model-access/index.ts:618` |
| `model-access:rotate` | invoke | A（供应商与模型） | 0 | `model-access/index.ts:625` |

### notificationService

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `notification:set-desktop-enabled` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 1 | `notificationService.ts:559` |
| `notification:show-session-event` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `notificationService.ts:568` |

### performance-trace

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `performance-trace:command` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `performance-trace/index.ts:100` |
| `performance-trace:events` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `performance-trace/index.ts:118` |

### plugin-contributions

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `plugin-contributions:cancel` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:cancel-review` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:detail` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:discard` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:list` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:mark-review-read` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:prepare` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:releases` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:review-updates` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:set-anonymity` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:status` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:submission` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |
| `plugin-contributions:submit` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts:18` |

### plugin-market

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `plugin-market:add-source` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:335` |
| `plugin-market:consume-removal-notice` | invoke | A（插件、技能与 MCP） | 1 | `plugin-market/registerIpc.ts:186` |
| `plugin-market:detail` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:190` |
| `plugin-market:git-preflight` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:400` |
| `plugin-market:install` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:254` |
| `plugin-market:install-local-share` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:204` |
| `plugin-market:list-sources` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:331` |
| `plugin-market:local-icons` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:231` |
| `plugin-market:local-share-detail` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:200` |
| `plugin-market:lookup` | invoke | A（插件、技能与 MCP） | 1 | `plugin-market/registerIpc.ts:181` |
| `plugin-market:pick-local-source` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `plugin-market/registerIpc.ts:376` |
| `plugin-market:prepare-local-share` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:210` |
| `plugin-market:prepare-share` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:196` |
| `plugin-market:query` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:172` |
| `plugin-market:recommendations` | invoke | A（插件、技能与 MCP） | 2 | `plugin-market/registerIpc.ts:177` |
| `plugin-market:refresh-source` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:394` |
| `plugin-market:release-local-share` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:225` |
| `plugin-market:remove-source` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:388` |
| `plugin-market:snapshot` | invoke | A（插件、技能与 MCP） | 4 | `plugin-market/registerIpc.ts:163` |
| `plugin-market:uninstall` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts:322` |

### plugin-publisher

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `plugin-publisher:cancel` | invoke | A（插件、技能与 MCP） | 0 | `plugin-publisher/registerIpc.ts:54` |
| `plugin-publisher:list-mine` | invoke | A（插件、技能与 MCP） | 0 | `plugin-publisher/registerIpc.ts:64` |
| `plugin-publisher:resolve-confirm` | invoke | A（插件、技能与 MCP） | 0 | `plugin-publisher/registerIpc.ts:80` |
| `plugin-publisher:start` | invoke | A（插件、技能与 MCP） | 0 | `plugin-publisher/registerIpc.ts:34` |
| `plugin-publisher:status` | invoke | A（插件、技能与 MCP） | 0 | `plugin-publisher/registerIpc.ts:42` |

### process-monitor

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `process-monitor:subscribe` | invoke | C（未登记前缀，但处理函数用到窗口 API：BrowserWindow.fromWebContents） | 1 | `process-monitor/ipc.ts:225` |
| `process-monitor:terminate-agent` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `process-monitor/ipc.ts:253` |
| `process-monitor:unsubscribe` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `process-monitor/ipc.ts:248` |

### projectOrderStore

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `sidebar-settings:apply-project-order` | invoke | A（设置与偏好） | 0 | `projectOrderStore.ts:178` |
| `sidebar-settings:get-project-order` | invoke | A（设置与偏好） | 8 | `projectOrderStore.ts:174` |

### provider-group

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `provider-group:command` | invoke | A（供应商与模型） | 16 | `provider-group/ipc.ts:386` |

### region-screenshot

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `recording-audio:data` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingAudio.ts:20` |
| `recording-audio:register` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingAudio.ts:14` |
| `recording-audio:state` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingAudio.ts:26` |
| `recording-preview:close` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts:111` |
| `recording-preview:copy` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts:124` |
| `recording-preview:failed` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts:107` |
| `recording-preview:minimize` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts:114` |
| `recording-preview:painted` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts:108` |
| `recording-preview:ready` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts:101` |
| `recording-preview:save` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts:117` |
| `region-screenshot-editor:cancel` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts:135` |
| `region-screenshot-editor:export` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts:138` |
| `region-screenshot-editor:failed` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts:123` |
| `region-screenshot-editor:minimize` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts:120` |
| `region-screenshot-editor:painted` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts:132` |
| `region-screenshot-editor:ready` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts:126` |
| `region-screenshot-editor:set-translation-language` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts:115` |
| `region-screenshot-pin:command` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts:285` |
| `region-screenshot-pin:drag-move` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts:261` |
| `region-screenshot-pin:drag-start` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts:255` |
| `region-screenshot-pin:menu` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts:281` |
| `region-screenshot-pin:opacity` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts:276` |
| `region-screenshot-pin:painted` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts:251` |
| `region-screenshot-pin:shell-ready` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts:235` |
| `region-screenshot-pin:unlock-hover` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts:290` |
| `region-screenshot-pin:zoom` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts:270` |
| `region-screenshot:abandon` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:193` |
| `region-screenshot:audio-read` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:166` |
| `region-screenshot:audio-start` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:165` |
| `region-screenshot:audio-stop` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:167` |
| `region-screenshot:auto-scroll` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:170` |
| `region-screenshot:cancel` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:190` |
| `region-screenshot:compose-take` | invoke | B（本机屏幕截取、录制与远程桌面） | 1 | `region-screenshot/compose.ts:79` |
| `region-screenshot:copy-text` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:187` |
| `region-screenshot:elements-at` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:200` |
| `region-screenshot:export` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:205` |
| `region-screenshot:focused` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:181` |
| `region-screenshot:live-edit` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:174` |
| `region-screenshot:live-frame` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:172` |
| `region-screenshot:live-hold` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:175` |
| `region-screenshot:live-save` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:173` |
| `region-screenshot:live-start` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:171` |
| `region-screenshot:painted` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:178` |
| `region-screenshot:recording-controls` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:168` |
| `region-screenshot:recording-preview` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:169` |
| `region-screenshot:selection-start` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:184` |
| `region-screenshot:set-translation-language` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:209` |
| `region-screenshot:shell-ready` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts:177` |

### relaunchBusyActivityIpc

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `update-relaunch:blocking-activity` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `relaunchBusyActivityIpc.ts:86` |
| `update-relaunch:blocking-summary` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `relaunchBusyActivityIpc.ts:97` |

### remote-desktop

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `away-guard:get-state` | invoke | B（本机屏幕截取、录制与远程桌面） | 2 | `remote-desktop/awayGuardService.ts:268` |
| `away-guard:preview` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/awayGuardService.ts:289` |
| `away-guard:set-delay` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/awayGuardService.ts:282` |
| `away-guard:set-enabled` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/awayGuardService.ts:272` |
| `remote-desktop:capture-stop` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1453` |
| `remote-desktop:channel-request` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1525` |
| `remote-desktop:dismiss-permission-guide` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1369` |
| `remote-desktop:enable` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1348` |
| `remote-desktop:host-input` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1504` |
| `remote-desktop:host-reply` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1457` |
| `remote-desktop:live-screen-frames` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1289` |
| `remote-desktop:native-audio` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1262` |
| `remote-desktop:native-frame` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1241` |
| `remote-desktop:open-permission` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1363` |
| `remote-desktop:permissions` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1359` |
| `remote-desktop:register-host` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1377` |
| `remote-desktop:state` | invoke | B（本机屏幕截取、录制与远程桌面） | 246 | `remote-desktop/index.ts:1313` |
| `remote-desktop:stop` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1373` |
| `remote-desktop:view-heartbeat` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1307` |
| `remote-desktop:windows-support` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts:1328` |

### remote-desktop-viewer

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `remote-desktop-viewer:channel-reply` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:378` |
| `remote-desktop-viewer:clipboard` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:407` |
| `remote-desktop-viewer:clipboard-sync` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:395` |
| `remote-desktop-viewer:close` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:352` |
| `remote-desktop-viewer:credential` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:418` |
| `remote-desktop-viewer:fullscreen` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:498` |
| `remote-desktop-viewer:ice` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:430` |
| `remote-desktop-viewer:input-focus` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:503` |
| `remote-desktop-viewer:open` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:341` |
| `remote-desktop-viewer:preferences` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:362` |
| `remote-desktop-viewer:presented` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:349` |
| `remote-desktop-viewer:ready` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:346` |
| `remote-desktop-viewer:request` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:402` |
| `remote-desktop-viewer:resize` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:445` |
| `remote-desktop-viewer:resolution` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:369` |
| `remote-desktop-viewer:safety` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:386` |
| `remote-desktop-viewer:state` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts:345` |

### remote-ssh

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `maker:remote-ssh:add` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1470` |
| `maker:remote-ssh:add-key-to-agent` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1952` |
| `maker:remote-ssh:build-install-cmd` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1974` |
| `maker:remote-ssh:build-install-cmd-inline` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1991` |
| `maker:remote-ssh:cc-mgr-dismiss-pending-upgrade` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:2149` |
| `maker:remote-ssh:cc-mgr-force-upgrade` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:2086` |
| `maker:remote-ssh:cc-mgr-list-pending-upgrades` | invoke | A（设备互联与远程执行） | 1 | `remote-ssh/index.ts:2145` |
| `maker:remote-ssh:check-codex-auth` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1826` |
| `maker:remote-ssh:connect` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1522` |
| `maker:remote-ssh:disconnect` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1546` |
| `maker:remote-ssh:generate-key` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1923` |
| `maker:remote-ssh:has-any-auto-connect-host` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:2058` |
| `maker:remote-ssh:install-agent` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1598` |
| `maker:remote-ssh:list` | invoke | A（设备互联与远程执行） | 7 | `remote-ssh/index.ts:1459` |
| `maker:remote-ssh:list-codex-models` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1821` |
| `maker:remote-ssh:list-local-keys` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1914` |
| `maker:remote-ssh:list-remote-dir` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:2066` |
| `maker:remote-ssh:mkdir-p-remote` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:2027` |
| `maker:remote-ssh:probe-agent` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1588` |
| `maker:remote-ssh:read-pubkey` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1963` |
| `maker:remote-ssh:reload-config` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1465` |
| `maker:remote-ssh:remove` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1480` |
| `maker:remote-ssh:review-host-key` | invoke | C（设备互联与远程执行，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog） | 0 | `remote-ssh/index.ts:1486` |
| `maker:remote-ssh:run-agent-one-shot` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1690` |
| `maker:remote-ssh:set-auto-connect` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:2042` |
| `maker:remote-ssh:stat-remote-path` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:2015` |
| `maker:remote-ssh:sync-codex-auth` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1846` |
| `maker:remote-ssh:uninstall-agent` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1665` |
| `maker:remote-ssh:update` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts:1475` |

### remotePrecreatedWorktreeLedger

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `remote-precreated-worktree-ledger:forget` | invoke | A（git 与工作树） | 0 | `remotePrecreatedWorktreeLedger.ts:252` |
| `remote-precreated-worktree-ledger:list` | invoke | A（git 与工作树） | 0 | `remotePrecreatedWorktreeLedger.ts:233` |
| `remote-precreated-worktree-ledger:register` | invoke | A（git 与工作树） | 0 | `remotePrecreatedWorktreeLedger.ts:240` |

### resource-usage-window

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `resource-usage-window:close` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `resource-usage-window/ipc.ts:28` |
| `resource-usage-window:open` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `resource-usage-window/ipc.ts:23` |
| `resource-usage-window:presentation-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `resource-usage-window/ipc.ts:38` |
| `resource-usage-window:renderer-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `resource-usage-window/ipc.ts:33` |

### right-sidebar-window

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `maker:rsb-window:close` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts:395` |
| `maker:rsb-window:get-context` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts:428` |
| `maker:rsb-window:get-state` | invoke | B（窗口外壳、窗口布局与多窗口） | 46 | `right-sidebar-window/ipc.ts:383` |
| `maker:rsb-window:open` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts:385` |
| `maker:rsb-window:ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts:430` |
| `maker:rsb-window:send-command` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts:471` |
| `maker:rsb-window:set-context` | event | B（窗口外壳、窗口布局与多窗口） | 18 | `right-sidebar-window/ipc.ts:482` |
| `maker:rsb-window:set-detached` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts:402` |
| `rsb-window:presentation-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts:451` |
| `rsb-window:refresh-context` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts:460` |
| `rsb-window:renderer-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts:442` |

### rsb-browser-bridge

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `rsb-browser-bridge:capture-screenshot` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts:242` |
| `rsb-browser-bridge:capture-screenshot-data` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts:253` |
| `rsb-browser-bridge:force-kill` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts:289` |
| `rsb-browser-bridge:release` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts:146` |
| `rsb-browser-bridge:report` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts:102` |
| `rsb-browser-bridge:set-foreground` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts:266` |
| `rsb-browser-bridge:snapshot` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 1 | `rsb-browser-bridge/ipc.ts:174` |
| `rsb-browser-bridge:tab-op-result` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/renderer-bridge.ts:79` |
| `rsb-native-popup:claim` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/native-popup-surfaces.ts:383` |
| `rsb-native-popup:close` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/native-popup-surfaces.ts:428` |
| `rsb-native-popup:command` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/native-popup-surfaces.ts:413` |
| `rsb-native-popup:set-bounds` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/native-popup-surfaces.ts:394` |

### session-import

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `local-db:session-import:cancel` | invoke | A（任务、消息与输入队列） | 0 | `session-import/ipc.ts:50` |
| `local-db:session-import:relocate` | invoke | A（任务、消息与输入队列） | 0 | `session-import/ipc.ts:55` |
| `local-db:session-import:scan` | invoke | A（任务、消息与输入队列） | 1 | `session-import/ipc.ts:35` |
| `local-db:session-import:start` | invoke | A（任务、消息与输入队列） | 0 | `session-import/ipc.ts:40` |
| `local-db:session-import:status` | invoke | A（任务、消息与输入队列） | 1 | `session-import/ipc.ts:44` |

### setup-migration

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `setup-migration:apply` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `setup-migration/register.ts:693` |
| `setup-migration:dismiss` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `setup-migration/register.ts:710` |
| `setup-migration:host-ready` | event | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `setup-migration/rendererPrefsHost.ts:47` |
| `setup-migration:host-reply` | event | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `setup-migration/rendererPrefsHost.ts:57` |
| `setup-migration:preview` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `setup-migration/register.ts:686` |
| `setup-migration:sources` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `setup-migration/register.ts:682` |
| `setup-migration:state` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 2 | `setup-migration/register.ts:706` |

### sidebar-tab-window

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `maker:sidebar-tab-window:close-for-tab` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts:197` |
| `maker:sidebar-tab-window:focus` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts:177` |
| `maker:sidebar-tab-window:get-state` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `sidebar-tab-window/ipc.ts:160` |
| `maker:sidebar-tab-window:open` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts:165` |
| `maker:sidebar-tab-window:return-tab` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts:187` |
| `sidebar-tab-window:adopt-tab` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts:239` |
| `sidebar-tab-window:get-assignment` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `sidebar-tab-window/ipc.ts:211` |
| `sidebar-tab-window:merge-back` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts:226` |
| `sidebar-tab-window:presentation-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts:221` |
| `sidebar-tab-window:renderer-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `sidebar-tab-window/ipc.ts:216` |

### sidebarSettingsStore

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `sidebar-settings:claim-renderer-legacy-owner-sync` | event | A（设置与偏好） | 8 | `sidebarSettingsStore.ts:903` |
| `sidebar-settings:load-snapshot-sync` | event | A（设置与偏好） | 21 | `sidebarSettingsStore.ts:907` |
| `sidebar-settings:save-pinned-order` | invoke | A（设置与偏好） | 0 | `sidebarSettingsStore.ts:911` |
| `sidebar-settings:set-main-view-hidden` | invoke | A（设置与偏好） | 0 | `sidebarSettingsStore.ts:919` |
| `sidebar-settings:set-project-hidden` | invoke | A（设置与偏好） | 0 | `sidebarSettingsStore.ts:915` |

### sidebarWindowExpansionIpc

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `window-sidebar-expansion` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebarWindowExpansionIpc.ts:24` |

### skillhub

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `skillhub:cancel-install` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:1156` |
| `skillhub:cancel-publish` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:1038` |
| `skillhub:compare-published` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:867` |
| `skillhub:delete-published` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:736` |
| `skillhub:get-folder-hash` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:903` |
| `skillhub:get-my-depts` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:786` |
| `skillhub:get-published-files` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:674` |
| `skillhub:get-published-visibility` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:774` |
| `skillhub:get-scan-status` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:837` |
| `skillhub:get-snapshot-diff` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:918` |
| `skillhub:get-usage-diagnosis-context` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:977` |
| `skillhub:get-usage-summary` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:942` |
| `skillhub:has-snapshot` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:933` |
| `skillhub:import-local` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:1084` |
| `skillhub:info` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:658` |
| `skillhub:install` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:1129` |
| `skillhub:list-categories` | invoke | A（插件、技能与 MCP） | 1 | `skillhub/registerIpc.ts:806` |
| `skillhub:list-children` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:529` |
| `skillhub:list-market` | invoke | A（插件、技能与 MCP） | 1 | `skillhub/registerIpc.ts:645` |
| `skillhub:list-published-versions` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:705` |
| `skillhub:list-user-teams` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:823` |
| `skillhub:pick-local` | invoke | C（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `skillhub/registerIpc.ts:1045` |
| `skillhub:publish` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:1012` |
| `skillhub:read-published-file` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:689` |
| `skillhub:read-raw` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:560` |
| `skillhub:read-sibling-file` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:543` |
| `skillhub:read-skill` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:514` |
| `skillhub:reconcile-mine-registry` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:1277` |
| `skillhub:registry:get-by-name` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:1292` |
| `skillhub:rename-local` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:603` |
| `skillhub:retry-uninstall-cleanup` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:1255` |
| `skillhub:scan` | invoke | A（插件、技能与 MCP） | 2 | `skillhub/registerIpc.ts:448` |
| `skillhub:set-enabled` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:1163` |
| `skillhub:set-published-visibility` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:758` |
| `skillhub:start-scan-poll` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:860` |
| `skillhub:stop-scan-poll` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:854` |
| `skillhub:sync` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:632` |
| `skillhub:uninstall` | invoke | C（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog、shell） | 0 | `skillhub/registerIpc.ts:1194` |
| `skillhub:unpublish-published` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:747` |
| `skillhub:update-published` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:722` |
| `skillhub:validate-frontmatter` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:590` |
| `skillhub:write-file` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts:573` |

### subscription-accounts

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `maker:subscription-accounts` | invoke | A（账号与凭据） | 8 | `subscription-accounts/ipc.ts:50` |
| `maker:subscription-pool:quota` | invoke | A（账号与凭据） | 0 | `subscription-accounts/ipc.ts:34` |

### task-migration

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `task-copy:request` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `task-migration/service.ts:1494` |

### updateService

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `update-auto-settings-get` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `updateService.ts:2426` |
| `update-auto-settings-reset` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2443` |
| `update-auto-settings-set` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2430` |
| `update-channel-probe-beta` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2520` |
| `update-channel-relaunch` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2530` |
| `update-channel-settings-get` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 4 | `updateService.ts:2454` |
| `update-channel-settings-reset` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2496` |
| `update-channel-settings-set` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2459` |
| `update-check-now` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2606` |
| `update-check-startup` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2620` |
| `update-get-status` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 9 | `updateService.ts:2422` |
| `update-harness-prepare` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2543` |
| `update-harness-relaunch` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2567` |
| `update-move-to-applications` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2594` |
| `update-relaunch` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2388` |
| `update-relaunch-auto` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts:2402` |
| `update-set-relaunch-theme` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 5 | `updateService.ts:2588` |

### voice-conversation

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `voice-conversation:audio` | event | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:286` |
| `voice-conversation:call-command` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:call-publish` | event | B（本机输入设备与语音） | 1 | `voice-conversation/index.ts:351` |
| `voice-conversation:call-status` | invoke | B（本机输入设备与语音） | 1 | `voice-conversation/index.ts:172` |
| `voice-conversation:classify-exit` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:end` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:finish-utterance` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:interrupt` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:models` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:preference` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:preview` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:promote-turn` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:read-preview` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:read-speech` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:set-input-muted` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:set-preference` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:speak` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:start` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:start-playback` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:stop-preview` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:submit-turn` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |
| `voice-conversation:voices` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts:172` |

### voice-input

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `voice-input:audio` | event | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2559` |
| `voice-input:audio-drain` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2565` |
| `voice-input:benchmark-fixture-audio` | invoke | B（本机输入设备与语音） | 1 | `voice-input/index.ts:2015` |
| `voice-input:cancel` | invoke | B（本机输入设备与语音） | 5 | `voice-input/index.ts:2591` |
| `voice-input:consume-shortcut-recovery-failure` | invoke | B（本机输入设备与语音） | 1 | `voice-input/global.ts:1448` |
| `voice-input:data:get` | event | B（本机输入设备与语音） | 1 | `voice-input/VoiceInputDataStore.ts:750` |
| `voice-input:data:migrate-legacy` | event | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:754` |
| `voice-input:dictionary-learning:advise` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2145` |
| `voice-input:dictionary-learning:record-actions` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:855` |
| `voice-input:dictionary-toast-close` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1529` |
| `voice-input:dictionary-toast-show` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1519` |
| `voice-input:dictionary:add-entry` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:784` |
| `voice-input:dictionary:delete-entries` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:770` |
| `voice-input:dictionary:edit-entry` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:829` |
| `voice-input:dictionary:import-entries` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:795` |
| `voice-input:dictionary:rename-entry` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:814` |
| `voice-input:get-microphone-permission-cached` | event | B（本机输入设备与语音） | 1 | `voice-input/microphonePermissionIpc.ts:23` |
| `voice-input:get-readiness` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2053` |
| `voice-input:get-readiness-cached` | event | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2011` |
| `voice-input:get-system-permissions` | invoke | B（本机输入设备与语音） | 1 | `voice-input/index.ts:2036` |
| `voice-input:get-system-permissions-cached` | event | B（本机输入设备与语音） | 1 | `voice-input/index.ts:2007` |
| `voice-input:global-overlay-close` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1284` |
| `voice-input:global-overlay-drag-end` | event | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1356` |
| `voice-input:global-overlay-drag-move` | event | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1340` |
| `voice-input:global-overlay-drag-start` | event | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1331` |
| `voice-input:global-overlay-position-reset` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1378` |
| `voice-input:global-overlay-ready` | event | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1534` |
| `voice-input:global-overlay-show-passive` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1296` |
| `voice-input:global-paste` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1247` |
| `voice-input:global-restore-target-focus` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1555` |
| `voice-input:global-shortcut-claim` | event | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1394` |
| `voice-input:global-shortcut:set` | invoke | B（本机输入设备与语音） | 14 | `voice-input/global.ts:1103` |
| `voice-input:history:delete` | event | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:902` |
| `voice-input:history:get` | event | B（本机输入设备与语音） | 1 | `voice-input/VoiceInputDataStore.ts:869` |
| `voice-input:history:get-for-refinement` | event | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:873` |
| `voice-input:history:record` | event | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:881` |
| `voice-input:history:update` | event | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:889` |
| `voice-input:model-selection:get` | invoke | B（本机输入设备与语音） | 2 | `voice-input/index.ts:2098` |
| `voice-input:model-selection:reload` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2135` |
| `voice-input:model-selection:set` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2104` |
| `voice-input:modifier-shortcut-recording:start` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1191` |
| `voice-input:modifier-shortcut-recording:stop` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1235` |
| `voice-input:mute-system-audio` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2156` |
| `voice-input:open-accessibility-settings` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1415` |
| `voice-input:open-input-monitoring-settings` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1460` |
| `voice-input:open-microphone-settings` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2040` |
| `voice-input:open-settings` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1307` |
| `voice-input:prewarm` | invoke | B（本机输入设备与语音） | 6 | `voice-input/index.ts:1991` |
| `voice-input:request-input-monitoring-permission` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1496` |
| `voice-input:request-microphone-permission` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2026` |
| `voice-input:restore-system-audio` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2168` |
| `voice-input:set-renderer-microphone-permission-verified` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2001` |
| `voice-input:settings:update` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts:762` |
| `voice-input:settings:update-shortcut` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts:1158` |
| `voice-input:speaker:cancel-download` | invoke | B（本机输入设备与语音） | 0 | `voice-input/speaker/index.ts:228` |
| `voice-input:speaker:delete-profile` | invoke | B（本机输入设备与语音） | 0 | `voice-input/speaker/index.ts:240` |
| `voice-input:speaker:download-models` | invoke | B（本机输入设备与语音） | 0 | `voice-input/speaker/index.ts:222` |
| `voice-input:speaker:enroll` | invoke | B（本机输入设备与语音） | 0 | `voice-input/speaker/index.ts:234` |
| `voice-input:speaker:get-status` | invoke | B（本机输入设备与语音） | 2 | `voice-input/speaker/index.ts:218` |
| `voice-input:start` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2551` |
| `voice-input:stop` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2567` |
| `voice-input:test-connection` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts:2059` |

### wecomGroupNotification

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `wecomGroupNotification:clear` | invoke | A（伙伴与 IM） | 0 | `wecomGroupNotification.ts:327` |
| `wecomGroupNotification:get-state` | invoke | A（伙伴与 IM） | 2 | `wecomGroupNotification.ts:295` |
| `wecomGroupNotification:save-and-test` | invoke | A（伙伴与 IM） | 0 | `wecomGroupNotification.ts:300` |
| `wecomGroupNotification:set-enabled` | invoke | A（伙伴与 IM） | 0 | `wecomGroupNotification.ts:322` |
| `wecomGroupNotification:test` | invoke | A（伙伴与 IM） | 0 | `wecomGroupNotification.ts:313` |

### worklouder-codex

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `codex-micro-guard:get-state` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts:318` |
| `codex-micro-guard:recover` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts:322` |
| `codex-micro-guard:set-enabled` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts:319` |
| `worklouder-codex:get-state` | invoke | B（本机输入设备与语音） | 2 | `worklouder-codex/index.ts:294` |
| `worklouder-codex:open-input-monitoring-settings` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts:301` |
| `worklouder-codex:probe` | invoke | B（本机输入设备与语音） | 2 | `worklouder-codex/index.ts:304` |
| `worklouder-codex:publish-tasks` | invoke | B（本机输入设备与语音） | 6 | `worklouder-codex/index.ts:305` |
| `worklouder-codex:reset-settings` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts:298` |
| `worklouder-codex:set-layout-preview` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts:308` |
| `worklouder-codex:set-settings` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts:295` |

### worktree

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `worktree:branch-sync-status` | invoke | A（git 与工作树） | 0 | `worktree/index.ts:71` |
| `worktree:create` | invoke | A（git 与工作树） | 0 | `worktree/index.ts:74` |
| `worktree:detect-cwd` | invoke | A（git 与工作树） | 0 | `worktree/index.ts:78` |
| `worktree:get-for-session` | invoke | A（git 与工作树） | 2 | `worktree/index.ts:88` |
| `worktree:list-all` | invoke | A（git 与工作树） | 1 | `worktree/index.ts:92` |
| `worktree:list-branches` | invoke | A（git 与工作树） | 0 | `worktree/index.ts:135` |
| `worktree:removal-preview` | invoke | A（git 与工作树） | 0 | `worktree/index.ts:146` |
| `worktree:restore-for-session` | invoke | A（git 与工作树） | 0 | `worktree/index.ts:156` |
| `worktree:restore-status` | invoke | A（git 与工作树） | 15 | `worktree/index.ts:151` |
| `worktree:reveal` | invoke | C（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `worktree/index.ts:94` |
| `worktree:suggest-name` | invoke | A（git 与工作树） | 0 | `worktree/index.ts:131` |
| `worktree:sync-branch` | invoke | A（git 与工作树） | 0 | `worktree/index.ts:72` |

### xbox-gamepad

| 通道 | 类型 | 归属 | 调用次数 | 注册位置 |
|---|---|---|---:|---|
| `xbox-gamepad:get-state` | invoke | B（本机输入设备与语音） | 4 | `xbox-gamepad/index.ts:216` |
| `xbox-gamepad:probe` | invoke | B（本机输入设备与语音） | 4 | `xbox-gamepad/index.ts:223` |
| `xbox-gamepad:reset-settings` | invoke | B（本机输入设备与语音） | 0 | `xbox-gamepad/index.ts:220` |
| `xbox-gamepad:set-layout-preview` | invoke | B（本机输入设备与语音） | 0 | `xbox-gamepad/index.ts:224` |
| `xbox-gamepad:set-settings` | invoke | B（本机输入设备与语音） | 0 | `xbox-gamepad/index.ts:217` |
