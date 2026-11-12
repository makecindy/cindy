# Host 通道覆盖清单（脚本生成）

> 由 `node scripts/host-channel-coverage.mjs` 生成，不要手工修改；行号只在 `--json` 输出里。
> 生成时的源码提交：`fa0061029d`。归属规则见下方「归属规则」，正本在脚本的 `OWNERSHIP_RULES`。

统计对象是桌面主进程（`apps/desktop/src/main`，不含测试）里所有 `ipcMain.handle/on`
及其包装函数注册的通道；注册、调用次数和排行均按 `(kind, channel)` 区分。

计数报告 v2 分别保存同名 invoke / event。旧报告按记录的 `kind` 归类；若旧采样已混算，无法事后拆分，需重新采样。

## 总口径

**真正要 Host 做的 = A + C-后台 + C-两段式 = 912 + 32 + 41 = 985**；巡检实际调用到 **132** 个（709 次，其中 A 130）。
同步通道（S）与回执通道（R）已单列，不在 A 里；C-窗口本地与 C-专项设计不计入。

| 分类 | 含义 | 通道数 |
|---|---|---:|
| contract | 已在 Host 通道合同里，窗口做客户端时转发给 Host | 75（巡检调用 33） |
| client | 客户端模式自己的通道（连接状态、重连） | 2（巡检调用 1） |
| **A** | 必须由后台处理：读写后台持有的数据或运行状态 | 912（巡检调用 130） |
| **B** | 永久留在窗口：只能在 Electron／图形界面里做 | 353（巡检调用 71） |
| **W** | 窗口本地设置：窗口直接读写同一份 profile，不经 Host | 6（巡检调用 1） |
| **S** | 同步通道（给 `event.returnValue` 赋值）：不能转发给 Host | 14（巡检调用 11） |
| 　S·本地 | 同步·本地（窗口读 profile：界面设置与首帧提示） | 8（巡检调用 8） |
| 　S·镜像 | 同步·数据归 Host（需窗口缓存镜像） | 6（巡检调用 3） |
| **R** | 回执通道：主进程向界面要数据，界面回执；先不排期 | 6（巡检调用 2） |
| **C** | 跨两边，按处理方式分四种 | 88（巡检调用 4） |
| 　C-后台 | | 32（巡检调用 2） |
| 　C-两段式（窗口做界面动作，数据调 Host） | | 41（巡检调用 0） |
| 　C-窗口本地 | | 11（巡检调用 2） |
| 　C-专项设计（安全边界） | | 4（巡检调用 0） |
| 合计 | | 1456 |

**窗口类**（B + W + S·本地 + C-窗口本地）在客户端模式下：
已注册 **364**、未注册 **12**（今天被拒或无人监听，见下文）、快照无法判断 2。

判定依据：A:default 110、A:rule 802、B:rule 353、C:dependency 18、C:rule 70、R:rule 6、S:dependency 14、W:rule 6（rule = 规则表，dependency = 窗口 API 或同步返回值判定，default = 未登记前缀且没用窗口 API）。

合同一侧（`hostChannelContract.ts`、`host-delegation.ts`、客户端模式预取）的通道名全部静态解析：解析不出任何一个时脚本直接失败，不会生成本清单。

转发适配器 2 处（把通道原样转给另一个注册表，通道已在调用处计入）：
`maker-ipc/electronIpcRegistry.ts`、`maker-ipc/register.ts`

合同里有、但桌面主进程没有注册的通道 4 个（Host 独有或桌面已改名）：

`auth:get-state`、`maker:commit-provisional-session`、`maker:discard-provisional-session`、`plugin-market:list-installed`

## 归属规则

按顺序匹配，先中先得；通道名或注册模块（`apps/desktop/src/main` 下的路径）命中即算。
1. B 规则直接定类。
2. 处理函数给 `event.returnValue` 赋值的同步通道判 S：命中 W 规则、领域为设置与偏好、账号与凭据或未登记前缀的为 S·本地，其余为 S·镜像。
3. W、R、C 规则直接定类（C 规则带细分）。
4. A 规则只标领域；处理函数及其调用的两层桌面源码函数（含参数默认值，不含被调函数里的嵌套回调）若用到下面的窗口 API，改判 C-两段式。
5. 没有命中任何规则：用到窗口 API 判 C-两段式，否则判 A（默认）。

| 归属 | 原因 | 通道名 | 注册模块 |
|---|---|---|---|
| B | 窗口外壳、窗口布局与多窗口 | <code>^(window[-:]&#124;window$&#124;win:&#124;titlebar&#124;fullscreen&#124;toggle-fullscreen&#124;get-fullscreen-state&#124;find-in-page&#124;page-zoom&#124;theme:&#124;app-menu:&#124;app-locale:&#124;startup-gate&#124;maker:open-session-in-new-window&#124;maker:session-drag-preview&#124;maker:sidebar-tab-drag-preview&#124;maker:sidebar-tab-window&#124;sidebar-tab-window&#124;maker:rsb-window&#124;rsb-window&#124;resource-usage-window&#124;agent-island&#124;menubar)</code> | <code>^(sidebar-tab-window&#124;sidebarWindowExpansionIpc&#124;right-sidebar-window&#124;resource-usage-window&#124;agent-island&#124;menubar)&#92;b</code> |
| B | 原生对话框、剪贴板、系统外壳与通知 | <code>^(dialog:&#124;show-open-directory-dialog&#124;clipboard:&#124;shell:&#124;open-with:&#124;notification:&#124;media:copy-(png-)?to-clipboard&#124;media:open-with-default-app&#124;media:save-as&#124;chat-attachment:save-as&#124;login-item:&#124;accessibility-support)</code> | <code>^(notificationService&#124;appBadgeService&#124;login-item-ipc&#124;accessibility-support-ipc)&#92;b</code> |
| B | 本机屏幕截取、录制与远程桌面 | <code>^(region-screenshot&#124;recording-preview&#124;recording-audio&#124;remote-desktop&#124;away-guard)</code> | <code>^(region-screenshot&#124;remote-desktop&#124;remote-desktop-viewer)&#92;b</code> |
| B | 图形能力，由窗口替 Agent 执行（平台 RPC） | <code>^(maker:computer&#124;maker:browser&#124;browser-backend&#124;rsb-browser-bridge&#124;rsb-native-popup)</code> | <code>^(rsb-browser-bridge)&#92;b</code> |
| B | 本机输入设备与语音 | <code>^(voice-input&#124;voice-conversation&#124;xbox-gamepad&#124;worklouder-codex&#124;codex-micro-guard&#124;app-shortcuts:set-recording)</code> | <code>^(voice-input&#124;voice-conversation&#124;xbox-gamepad&#124;worklouder-codex)&#92;b</code> |
| B | 桌面安装包自身：更新、版本、日志与诊断 | <code>^(update-(?!relaunch:)&#124;get-app-version&#124;get-app-display-version-info&#124;get-os-release&#124;release-notes:&#124;app:get-arm64-translation&#124;app:open-logs-dir&#124;crash-diagnosis&#124;log-upload&#124;performance-trace&#124;renderer:log&#124;dev:&#124;cc:set-debug-net&#124;deep-link:)</code> | <code>^(updateService&#124;crash-diagnosis&#124;log-upload&#124;performance-trace)&#92;b</code> |
| C-专项设计（安全边界） | 安全边界待专项设计：用户填写的值只交给宿主执行（input-handoff），远程控制派发；方案出来前不动 | <code>^(input-handoff:&#124;device-link:invoke$)</code> | — |
| C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | `^terminal:` | — |
| C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | <code>^(maker:file-browser&#124;maker:chat-file&#124;maker:chat-folder&#124;maker:html-preview&#124;maker:search:&#124;file-browser:remote-op$)</code> | — |
| C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | <code>^(fs:&#124;read-file-bytes&#124;read-file-for-attachment&#124;peek-file-header&#124;text-file:&#124;file:thumbnail&#124;process-monitor:subscribe$)</code> | <code>^fsBrowse&#92;b</code> |
| C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | <code>(^&#124;:)(choose&#124;pick)([A-Z-]&#124;$)</code> | — |
| C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | <code>(:&#124;-)(open-dir&#124;reveal)$&#124;:open-[a-z-]*-dir(ectory)?$&#124;^billing:open-</code> | — |
| R | 主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期 | <code>(^&#124;:)(host-ready&#124;host-reply&#124;host-changed)$&#124;^app-preferences:reply$</code> | — |
| W | 窗口本地设置：窗口直接读写同一份 profile 文件，不经 Host | `^sidebar-settings:` | — |
| A | 升级与交接（归交接任务：它留在原工作区的升级流程） | `^update-relaunch:` | — |
| A | 任务、消息与输入队列 | <code>^(local-db:(sessions&#124;messages&#124;history&#124;session-share&#124;session-import&#124;right-sidebar-tabs&#124;recent-workdirs&#124;subagent-runs&#124;conversations&#124;task-tags&#124;project-aliases&#124;ensure-ready&#124;maintenance)&#124;maker:(session&#124;input&#124;send&#124;steer&#124;create-session&#124;close-session&#124;abort-session&#124;fork&#124;rewind&#124;compact&#124;message&#124;get-session&#124;navigate-session&#124;side-chat&#124;goal&#124;turn-change&#124;persist-turn&#124;working-status&#124;any-session&#124;export-session&#124;generate-title&#124;regenerate-title&#124;auto-title&#124;predict-prompt&#124;switch-session-agent&#124;write-plan-file&#124;images&#124;list-desktop-commands&#124;execute-desktop-command&#124;get-context&#124;set-))</code> | — |
| A | 自动化 | `^maker:schedule` | — |
| A | Orca | <code>^(maker:(orca&#124;worker&#124;team&#124;mark-orca&#124;sync-worker)&#124;local-db:orca)</code> | — |
| A | 伙伴与 IM | <code>^(maker:(bot&#124;companion&#124;im-)&#124;local-db:bots&#124;binding:&#124;botImConnection&#124;telegramBot&#124;wechatBot&#124;feishuBot&#124;discordBot&#124;dingtalkBot&#124;wecomBot&#124;wecomGroupNotification&#124;desktop:cc-prefs&#124;companion-import)</code> | <code>^(im&#124;bot-import)&#92;b</code> |
| A | 账号与凭据 | <code>^(auth:&#124;safe-storage&#124;builtin-api-key&#124;plugin-oauth&#124;maker:(api-key&#124;claude-oauth&#124;xai-oauth&#124;auth:&#124;subscription))</code> | — |
| A | 供应商与模型 | <code>^(maker:(provider&#124;model&#124;usage&#124;local-model&#124;llamacpp&#124;sync-provider&#124;auxiliary-model&#124;subagent-model&#124;vision-bridge&#124;claude-session-route)&#124;provider-group&#124;provider-share&#124;model-favorites&#124;model-access)</code> | — |
| A | 插件、技能与 MCP | <code>^(ghosts:&#124;ghost-pipe&#124;forge-oidc&#124;maker:(plugins&#124;plugin-setup&#124;mcp&#124;runtime-plugins&#124;pi-packages)&#124;plugin-market&#124;plugin-publisher&#124;plugin-contributions&#124;skillhub)</code> | — |
| A | 设备互联与远程执行 | <code>^(device-link&#124;direct-link&#124;file-peer&#124;shared-task&#124;self-hosted-relay&#124;local-agent&#124;maker:(remote-resources&#124;shared-task&#124;remote-ssh&#124;provider-share))</code> | — |
| A | git 与工作树 | <code>^(git-context&#124;git-review&#124;worktree&#124;remote-precreated-worktree&#124;maker:git-safety)</code> | — |
| A | 记忆、学习与钩子 | <code>^(maker:(memory&#124;maker-memory&#124;hook-control)&#124;learn:)</code> | — |
| A | 附件与媒体库 | <code>^(chat-attachment&#124;cindy-media&#124;image-cache&#124;media:)</code> | — |
| A | 设置与偏好 | <code>^(sidebar-settings&#124;app-shortcuts&#124;appearance-settings&#124;layout:&#124;analytics&#124;database-size-warning&#124;app-preferences&#124;local-themes&#124;profile:&#124;projects-root&#124;maker:[a-z-]*settings)</code> | — |
| A | Cindy Make | <code>^app:(.*cindy-make&#124;cindy-versions)</code> | — |

窗口 API：Electron 导出 `dialog`、`shell`、`clipboard`、`Menu`、`MenuItem`、`screen`、`desktopCapturer`、`Notification`、`globalShortcut`、`systemPreferences`、`nativeTheme`、`Tray`、`TouchBar`、`BrowserView`、`WebContentsView`、`powerSaveBlocker`、`nativeImage`、`autoUpdater`；成员 `BrowserWindow.fromWebContents`、`BrowserWindow.getFocusedWindow`、`BrowserWindow.fromId`、`BrowserWindow.fromBrowserView`、`app.focus`、`app.dock`、`app.setBadgeCount`、`app.relaunch`、`app.quit`、`app.exit`、`app.setLoginItemSettings`、`app.getLoginItemSettings`、`app.show`、`app.hide`、`app.setAsDefaultProtocolClient`、`app.getFileIcon`；以及 `new BrowserWindow`。不计入：发送方校验（`src/main/security/`，客户端模式下由 Host 令牌鉴权），以及发给某个窗口的推送（`webContents.fromId`、`event.sender`，客户端模式下推送走 Host 事件流）。

## 要 Host 做的：实际调用排行

来源：`docs/host/evidence/channel-usage-mock-tour.json`（UI fixture tour (pnpm restart:desktop:remote -- --mock --isolated=host-usage + apps/desktop/scripts/host-client-usage-tour.mjs)；embedded 模式，2026-11-11）。范围是 A + C-后台 + C-两段式；这次共调用 253 个通道（1862 次）。

| # | 通道 | 类型 | 调用次数 | 归属 | 领域／原因 | 模块 |
|---:|---|---|---:|---|---|---|
| 1 | `maker:bot-group:outbox-command` | invoke | 51 | A | 伙伴与 IM | maker-ipc |
| 2 | `maker:list-desktop-commands` | invoke | 47 | A | 任务、消息与输入队列 | maker-ipc |
| 3 | `device-link:list-devices` | invoke | 33 | A | 设备互联与远程执行 | device-link |
| 4 | `ghosts:session-focused` | event | 32 | A | 插件、技能与 MCP | cindy-brain |
| 5 | `maker:session-background-tasks:list` | invoke | 28 | A | 任务、消息与输入队列 | maker-ipc |
| 6 | `maker:plugins:get-state` | invoke | 21 | A | 插件、技能与 MCP | maker-ipc |
| 7 | `device-link:get-state` | invoke | 20 | A | 设备互联与远程执行 | device-link |
| 8 | `maker:model-context-limit:get` | invoke | 20 | A | 供应商与模型 | maker-ipc |
| 9 | `ghosts:ui-prompts` | invoke | 19 | A | 插件、技能与 MCP | cindy-brain |
| 10 | `git-context:get-for-session` | invoke | 19 | A | git 与工作树 | git-context |
| 11 | `learn:list-runs` | invoke | 18 | A | 记忆、学习与钩子 | learn-host |
| 12 | `git-context:find-linked-worktree` | invoke | 17 | A | git 与工作树 | git-context |
| 13 | `maker:get-context-window-bounds` | invoke | 16 | A | 任务、消息与输入队列 | maker-ipc |
| 14 | `maker:get-session-agent-switch-intent` | invoke | 16 | A | 任务、消息与输入队列 | maker-ipc |
| 15 | `maker:side-chat:list:v1` | invoke | 16 | A | 任务、消息与输入队列 | maker-ipc |
| 16 | `provider-group:command` | invoke | 16 | A | 供应商与模型 | provider-group |
| 17 | `binding:resolve-session` | invoke | 15 | A | 伙伴与 IM | im |
| 18 | `maker:goal:get-status` | invoke | 15 | A | 任务、消息与输入队列 | maker-ipc |
| 19 | `maker:session-background-activity` | invoke | 15 | A | 任务、消息与输入队列 | maker-ipc |
| 20 | `worktree:restore-status` | invoke | 15 | A | git 与工作树 | worktree |
| 21 | `git-context:pr-refs:list` | invoke | 14 | A | git 与工作树 | git-context |
| 22 | `maker:bot-group:list` | invoke | 13 | A | 伙伴与 IM | maker-ipc |
| 23 | `maker:subscription-accounts` | invoke | 8 | A | 账号与凭据 | subscription-accounts |
| 24 | `maker:claude-session-route:get` | invoke | 7 | A | 供应商与模型 | bootstrap-electron |
| 25 | `maker:model-visibility:sync` | invoke | 7 | A | 供应商与模型 | maker-ipc |
| 26 | `maker:remote-ssh:list` | invoke | 7 | A | 设备互联与远程执行 | remote-ssh |
| 27 | `maker:usage:account` | invoke | 7 | A | 供应商与模型 | maker-ipc |
| 28 | `local-db:bots:model-chain-settings-get` | invoke | 6 | A | 伙伴与 IM | localDb |
| 29 | `local-db:bots:read-state:update` | invoke | 6 | A | 伙伴与 IM | maker-ipc |
| 30 | `maker:claude-oauth:status` | invoke | 6 | A | 账号与凭据 | bootstrap-electron |
| 31 | `maker:im-default-settings:get` | invoke | 6 | A | 伙伴与 IM | bootstrap-electron |
| 32 | `maker:usage:claude-subscription` | invoke | 6 | A | 供应商与模型 | maker-ipc |
| 33 | `maker:usage:codex-rate-limits` | invoke | 6 | A | 供应商与模型 | maker-ipc |
| 34 | `local-db:bots:list` | invoke | 5 | A | 伙伴与 IM | localDb |
| 35 | `maker:sync-worker-creation-prefs` | event | 5 | A | Orca | maker-ipc |
| 36 | `binding:list-attached` | invoke | 4 | A | 伙伴与 IM | im |
| 37 | `desktop:cc-prefs-changed` | event | 4 | A | 伙伴与 IM | im |
| 38 | `ghosts:models:list` | invoke | 4 | A | 插件、技能与 MCP | cindy-brain |
| 39 | `maker:bot-read-state` | invoke | 4 | A | 伙伴与 IM | maker-ipc |
| 40 | `maker:silent-encrypted-retry:get` | invoke | 4 | A | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 41 | `maker:sync-new-maker-draft` | event | 4 | A | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 42 | `plugin-market:snapshot` | invoke | 4 | A | 插件、技能与 MCP | plugin-market |
| 43 | `provider-share:command` | invoke | 4 | A | 供应商与模型 | device-link |
| 44 | `database-size-warning:get-settings` | invoke | 3 | A | 设置与偏好 | bootstrap-electron |
| 45 | `git-context:pr-refs:list-all` | invoke | 3 | A | git 与工作树 | git-context |
| 46 | `maker:agent:binary-version` | invoke | 3 | A | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 47 | `maker:git-safety:get` | invoke | 3 | A | git 与工作树 | bootstrap-electron |
| 48 | `maker:memory:get` | invoke | 3 | A | 记忆、学习与钩子 | maker-ipc |
| 49 | `self-hosted-relay:command` | invoke | 3 | A | 设备互联与远程执行 | device-link |
| 50 | `analytics:settings-get` | invoke | 2 | A | 设置与偏好 | analyticsSettingsService |
| 51 | `auth:initialize` | invoke | 2 | A | 账号与凭据 | bootstrap-electron |
| 52 | `database-size-warning:get-status` | invoke | 2 | A | 设置与偏好 | bootstrap-electron |
| 53 | `feishuBot:get-state` | invoke | 2 | A | 伙伴与 IM | im |
| 54 | `local-db:maintenance:last-result` | invoke | 2 | A | 任务、消息与输入队列 | bootstrap-electron |
| 55 | `maker:agent-resource-settings:get` | invoke | 2 | A | 设置与偏好 | maker-ipc |
| 56 | `maker:agent:pi-kernel-state` | invoke | 2 | A | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 57 | `maker:chat-embedding:get` | invoke | 2 | A | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 58 | `maker:chat:display-cache` | invoke | 2 | A | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 59 | `maker:collaboration-settings:get` | invoke | 2 | A | 设置与偏好 | maker-ipc |
| 60 | `maker:memory:get-settings` | invoke | 2 | A | 记忆、学习与钩子 | bootstrap-electron |
| 61 | `maker:schedule:list-sidebar-index-runs` | invoke | 2 | A | 自动化 | maker-ipc |
| 62 | `maker:session:turn-active` | invoke | 2 | A | 任务、消息与输入队列 | maker-ipc |
| 63 | `plugin-market:recommendations` | invoke | 2 | A | 插件、技能与 MCP | plugin-market |
| 64 | `setup-migration:state` | invoke | 2 | A | 未登记前缀，处理函数没有用到窗口 API | setup-migration |
| 65 | `skillhub:scan` | invoke | 2 | A | 插件、技能与 MCP | skillhub |
| 66 | `wecomGroupNotification:get-state` | invoke | 2 | A | 伙伴与 IM | wecomGroupNotification |
| 67 | `worktree:get-for-session` | invoke | 2 | A | git 与工作树 | worktree |
| 68 | `app:get-cindy-make-state` | invoke | 1 | A | Cindy Make | bootstrap-electron |
| 69 | `app:ready-for-bot` | invoke | 1 | A | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 70 | `appearance-settings:get` | invoke | 1 | A | 设置与偏好 | appearance-settings-ipc |
| 71 | `check-environment` | invoke | 1 | A | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 72 | `cindy-media:storage-stats` | invoke | 1 | A | 附件与媒体库 | bootstrap-electron |
| 73 | `companion-import` | invoke | 1 | A | 伙伴与 IM | bot-import |
| 74 | `database-size-warning:measure` | invoke | 1 | A | 设置与偏好 | bootstrap-electron |
| 75 | `dialogue-workspace:get` | invoke | 1 | A | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 76 | `dingtalkBot:get-state` | invoke | 1 | A | 伙伴与 IM | im |
| 77 | `discordBot:get-status` | invoke | 1 | A | 伙伴与 IM | im |
| 78 | `ghosts:take-pending-install` | invoke | 1 | A | 插件、技能与 MCP | cindy-brain |
| 79 | `legacy-migration:get-state` | invoke | 1 | A | 未登记前缀，处理函数没有用到窗口 API | legacyUserDataMigration |
| 80 | `local-agent:connections` | invoke | 1 | A | 设备互联与远程执行 | bootstrap-electron |
| 81 | `local-agent:developer-connection` | invoke | 1 | A | 设备互联与远程执行 | bootstrap-electron |
| 82 | `local-db:bots:read-state:get` | invoke | 1 | A | 伙伴与 IM | maker-ipc |
| 83 | `local-db:bots:workbench:follow-scopes` | invoke | 1 | A | 伙伴与 IM | localDb |
| 84 | `local-db:ensure-ready` | invoke | 1 | A | 任务、消息与输入队列 | localDb |
| 85 | `local-db:maintenance:startup-progress` | invoke | 1 | A | 任务、消息与输入队列 | bootstrap-electron |
| 86 | `local-db:session-import:scan` | invoke | 1 | A | 任务、消息与输入队列 | session-import |
| 87 | `local-db:session-import:status` | invoke | 1 | A | 任务、消息与输入队列 | session-import |
| 88 | `local-db:sessions:set-pinned-card-summaries` | invoke | 1 | A | 任务、消息与输入队列 | localDb |
| 89 | `local-themes:list` | invoke | 1 | A | 设置与偏好 | local-themes |
| 90 | `maker:android:get-config` | invoke | 1 | A | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 91 | `maker:auto-title` | invoke | 1 | A | 任务、消息与输入队列 | maker-ipc |
| 92 | `maker:auxiliary-model-settings:get` | invoke | 1 | A | 供应商与模型 | maker-ipc |
| 93 | `maker:companion-cloud:state` | invoke | 1 | A | 伙伴与 IM | maker-ipc |
| 94 | `maker:issues:list-mine` | invoke | 1 | A | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 95 | `maker:issues:snapshot-mine` | invoke | 1 | A | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 96 | `maker:lsp-mode:get` | invoke | 1 | A | 未登记前缀，处理函数没有用到窗口 API | bootstrap-electron |
| 97 | `maker:mcp:custom:list` | invoke | 1 | A | 插件、技能与 MCP | maker-ipc |
| 98 | `maker:mcp:duplicates:list` | invoke | 1 | A | 插件、技能与 MCP | maker-ipc |
| 99 | `maker:memory:get-settings-state` | invoke | 1 | A | 记忆、学习与钩子 | bootstrap-electron |
| 100 | `maker:pi-packages:list` | invoke | 1 | A | 插件、技能与 MCP | maker-ipc |
| 101 | `maker:plugins:list` | invoke | 1 | A | 插件、技能与 MCP | maker-ipc |
| 102 | `maker:project-automation:pending-imports` | invoke | 1 | A | 未登记前缀，处理函数没有用到窗口 API | maker-ipc |
| 103 | `maker:provider:local-cli-scan` | invoke | 1 | A | 供应商与模型 | maker-ipc |
| 104 | `maker:provider:models-auto-refresh` | invoke | 1 | A | 供应商与模型 | maker-ipc |
| 105 | `maker:remote-ssh:cc-mgr-list-pending-upgrades` | invoke | 1 | A | 设备互联与远程执行 | remote-ssh |
| 106 | `maker:schedule:get-runtime-state` | invoke | 1 | A | 自动化 | maker-ipc |
| 107 | `maker:schedule:list` | invoke | 1 | A | 自动化 | maker-ipc |
| 108 | `maker:schedule:list-runs` | invoke | 1 | A | 自动化 | maker-ipc |
| 109 | `maker:schedule:webhook-receiver` | invoke | 1 | A | 自动化 | maker-ipc |
| 110 | `maker:session-background-activity:list` | invoke | 1 | A | 任务、消息与输入队列 | maker-ipc |
| 111 | `maker:session-background-work:list` | invoke | 1 | A | 任务、消息与输入队列 | maker-ipc |
| 112 | `maker:session:commit-provisional` | invoke | 1 | A | 任务、消息与输入队列 | maker-ipc |
| 113 | `maker:session:prewarm` | invoke | 1 | A | 任务、消息与输入队列 | maker-ipc |
| 114 | `maker:subagent-model-settings:get` | invoke | 1 | A | 供应商与模型 | bootstrap-electron |
| 115 | `maker:sync-provider-model-memory` | event | 1 | A | 供应商与模型 | maker-ipc |
| 116 | `maker:usage:history` | invoke | 1 | A | 供应商与模型 | maker-ipc |
| 117 | `maker:vision-bridge-settings:get` | invoke | 1 | A | 供应商与模型 | bootstrap-electron |
| 118 | `plugin-market:consume-removal-notice` | invoke | 1 | A | 插件、技能与 MCP | plugin-market |
| 119 | `plugin-market:lookup` | invoke | 1 | A | 插件、技能与 MCP | plugin-market |
| 120 | `process-monitor:unsubscribe` | invoke | 1 | A | 未登记前缀，处理函数没有用到窗口 API | process-monitor |
| 121 | `projects-root:get` | invoke | 1 | A | 设置与偏好 | bootstrap-electron |
| 122 | `safe-storage-read` | invoke | 1 | A | 账号与凭据 | bootstrap-electron |
| 123 | `skillhub:list-categories` | invoke | 1 | A | 插件、技能与 MCP | skillhub |
| 124 | `skillhub:list-market` | invoke | 1 | A | 插件、技能与 MCP | skillhub |
| 125 | `telegramBot:get-status` | invoke | 1 | A | 伙伴与 IM | im |
| 126 | `terminal:get-default-shell-pref` | invoke | 1 | C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | maker-ipc |
| 127 | `terminal:list-available-shells` | invoke | 1 | C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | maker-ipc |
| 128 | `wechatBot:get-channel-settings` | invoke | 1 | A | 伙伴与 IM | im |
| 129 | `wechatBot:get-state` | invoke | 1 | A | 伙伴与 IM | im |
| 130 | `wecomBot:get-status` | invoke | 1 | A | 伙伴与 IM | im |
| 131 | `worktree-recycle:list` | invoke | 1 | A | git 与工作树 | bootstrap-electron |
| 132 | `worktree:list-all` | invoke | 1 | A | git 与工作树 | worktree |

## 同步通道 S（14）

S·本地：界面设置与登录首帧提示，由窗口本地读同一份 profile 文件，客户端模式下照常注册（登录状态本身仍以 Host 为准）。S·镜像：数据归 Host（插件状态），需要“窗口缓存镜像”（Host 经事件流推送、窗口同步回答缓存）或把界面改成异步，单独设计，放进对应的小批（插件那批），不混进 1a。

| 通道 | 类型 | 归属 | 原因 | 调用次数 | 注册文件 |
|---|---|---|---|---:|---|
| `sidebar-settings:load-snapshot-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示） | 同步通道·界面设置：窗口本地读同一份 profile 文件 | 21 | `sidebarSettingsStore.ts` |
| `ghosts:recommendations` | event | 同步·数据归 Host（需窗口缓存镜像） | 同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计 | 8 | `cindy-brain/index.ts` |
| `sidebar-settings:claim-renderer-legacy-owner-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示） | 同步通道·界面设置：窗口本地读同一份 profile 文件 | 8 | `sidebarSettingsStore.ts` |
| `auth:has-persisted-session-hint-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示） | 同步通道·账号提示：只读 profile 里的首帧提示（事件流连上之前就要回答），登录状态仍以 Host 为准 | 4 | `bootstrap-electron.ts` |
| `appearance-settings:get-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示） | 同步通道·界面设置：窗口本地读同一份 profile 文件 | 3 | `appearance-settings-ipc.ts` |
| `layout:get` | event | 同步·本地（窗口读 profile：界面设置与首帧提示） | 同步通道·界面设置：窗口本地读同一份 profile 文件 | 3 | `layout/index.ts` |
| `local-themes:list-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示） | 同步通道·界面设置：窗口本地读同一份 profile 文件 | 3 | `local-themes/register.ts` |
| `ghosts:recent-usage` | event | 同步·数据归 Host（需窗口缓存镜像） | 同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计 | 2 | `cindy-brain/index.ts` |
| `app-shortcuts:get` | event | 同步·本地（窗口读 profile：界面设置与首帧提示） | 同步通道·界面设置：窗口本地读同一份 profile 文件 | 1 | `app-shortcuts/index.ts` |
| `client-endpoints:get-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示） | 同步通道·界面设置：窗口本地读同一份 profile 文件 | 1 | `clientEndpointsService.ts` |
| `ghosts:unread` | event | 同步·数据归 Host（需窗口缓存镜像） | 同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计 | 1 | `cindy-brain/index.ts` |
| `ghosts:builtin-status` | event | 同步·数据归 Host（需窗口缓存镜像） | 同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计 | 0 | `cindy-brain/index.ts` |
| `ghosts:errand-prefs` | event | 同步·数据归 Host（需窗口缓存镜像） | 同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计 | 0 | `cindy-brain/index.ts` |
| `ghosts:workdir-prefs` | event | 同步·数据归 Host（需窗口缓存镜像） | 同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计 | 0 | `cindy-brain/index.ts` |

## 回执通道 R（6）

主进程发请求、界面用本地存储里的数据回执。Host 要这些数据得经窗口往返一次，不是普通的“接一个接口”；先标出来，不排期。

| 通道 | 类型 | 归属 | 原因 | 调用次数 | 注册文件 |
|---|---|---|---|---:|---|
| `model-favorites:host-ready` | event | R | 主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期 | 1 | `maker-ipc/modelFavoritesSync.ts` |
| `setup-migration:host-ready` | event | R | 主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期 | 1 | `setup-migration/rendererPrefsHost.ts` |
| `app-preferences:reply` | event | R | 主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期 | 0 | `app-settings/preferences.ts` |
| `model-favorites:host-changed` | event | R | 主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期 | 0 | `maker-ipc/modelFavoritesSync.ts` |
| `model-favorites:host-reply` | event | R | 主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期 | 0 | `maker-ipc/modelFavoritesSync.ts` |
| `setup-migration:host-reply` | event | R | 主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期 | 0 | `setup-migration/rendererPrefsHost.ts` |

## C 类全量（88）

C-后台：换窗口时不能断、网页和手机也要用，计入要 Host 做的（终端优先级低）。C-两段式：窗口保留处理者做界面动作，数据那一半调 Host，每个需要一个 Host 接口，计入但低频、排在后面。C-窗口本地：路径来自用户在本窗口的选择，客户端模式下照常注册，不计入。C-专项设计：安全边界，先读 docs/product-rules/input-handoff.md，方案出来前不动。

| 通道 | 类型 | 归属 | 原因 | 调用次数 | 注册文件 |
|---|---|---|---|---:|---|
| `fs:resolve-path-batch` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 1 | `bootstrap-electron.ts` |
| `process-monitor:subscribe` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 1 | `process-monitor/ipc.ts` |
| `terminal:get-default-shell-pref` | invoke | C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | 1 | `maker-ipc/terminal-handlers.ts` |
| `terminal:list-available-shells` | invoke | C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | 1 | `maker-ipc/terminal-handlers.ts` |
| `app:cindy-make-history-open-build` | invoke | C-两段式（窗口做界面动作，数据调 Host） | Cindy Make，但处理函数用到窗口 API：shell；窗口做界面动作，数据那一半调 Host | 0 | `bootstrap-electron.ts` |
| `app:open-cindy-make-source-dir` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `bootstrap-electron.ts` |
| `app:open-cindy-make-tools-dir` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `bootstrap-electron.ts` |
| `appearance-settings:import-wallpaper` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents；窗口做界面动作，数据那一半调 Host | 0 | `appearance-settings-ipc.ts` |
| `appearance-settings:plugin-font` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents；窗口做界面动作，数据那一半调 Host | 0 | `appearance-settings-ipc.ts` |
| `billing:open-payment-redirect` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `billing/index.ts` |
| `billing:open-subscription-portal` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `billing/index.ts` |
| `cindy-media:chat-attachments-clear` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 附件与媒体库，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host | 0 | `bootstrap-electron.ts` |
| `cindy-media:chat-attachments-open-dir` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `bootstrap-electron.ts` |
| `cindy-media:legacy-images-clear` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 附件与媒体库，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host | 0 | `bootstrap-electron.ts` |
| `cindy-media:legacy-images-open-dir` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `bootstrap-electron.ts` |
| `create-project-from-task:chooseParent` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `bootstrap-electron.ts` |
| `device-link:confirm-skill-mutation` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 设备互联与远程执行，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host | 0 | `device-link/ipc.ts` |
| `device-link:invoke` | invoke | C-专项设计（安全边界） | 安全边界待专项设计：用户填写的值只交给宿主执行（input-handoff），远程控制派发；方案出来前不动 | 0 | `device-link/ipc.ts` |
| `device-link:pick-plugin-package` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `device-link/ipc.ts` |
| `dialogue-workspace:choose` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `bootstrap-electron.ts` |
| `file-browser:remote-op` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/device-op.ts` |
| `file:thumbnail` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 0 | `bootstrap-electron.ts` |
| `fs:list-dir` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 0 | `fsBrowse/ipc.ts` |
| `fs:mkdir-p` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 0 | `fsBrowse/ipc.ts` |
| `fs:resolve-path` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 0 | `bootstrap-electron.ts` |
| `fs:stat-path` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 0 | `fsBrowse/ipc.ts` |
| `ghosts:background-tasks:reveal` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `maker-ipc/register.ts` |
| `ghosts:export` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host | 0 | `cindy-brain/index.ts` |
| `ghosts:library-delete` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host | 0 | `cindy-brain/index.ts` |
| `ghosts:library-pick-location` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host | 0 | `cindy-brain/index.ts` |
| `ghosts:library-reattach-legacy` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host | 0 | `cindy-brain/index.ts` |
| `ghosts:pick-file` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `cindy-brain/index.ts` |
| `git-review:open-file` | invoke | C-两段式（窗口做界面动作，数据调 Host） | git 与工作树，但处理函数用到窗口 API：shell；窗口做界面动作，数据那一半调 Host | 0 | `git-review/ipc.ts` |
| `input-handoff:picture` | invoke | C-专项设计（安全边界） | 安全边界待专项设计：用户填写的值只交给宿主执行（input-handoff），远程控制派发；方案出来前不动 | 0 | `maker-ipc/register.ts` |
| `input-handoff:raise` | invoke | C-专项设计（安全边界） | 安全边界待专项设计：用户填写的值只交给宿主执行（input-handoff），远程控制派发；方案出来前不动 | 0 | `maker-ipc/register.ts` |
| `input-handoff:submit` | invoke | C-专项设计（安全边界） | 安全边界待专项设计：用户填写的值只交给宿主执行（input-handoff），远程控制派发；方案出来前不动 | 0 | `maker-ipc/register.ts` |
| `local-db:bots:choose-avatar` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:choose-avatar-source` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `localDb/ipc/bots.ts` |
| `local-db:maintenance:choose-backup-directory` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `bootstrap-electron.ts` |
| `local-db:maintenance:open-last-backup-directory` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `bootstrap-electron.ts` |
| `local-db:session-share:export` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.getFocusedWindow、dialog；窗口做界面动作，数据那一半调 Host | 0 | `localDb/ipc/session-share.ts` |
| `local-db:session-share:inspect` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.getFocusedWindow、dialog；窗口做界面动作，数据那一半调 Host | 0 | `localDb/ipc/session-share.ts` |
| `local-themes:import` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host | 0 | `local-themes/register.ts` |
| `local-themes:open-dir` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `local-themes/register.ts` |
| `maker:chat-file:cancel` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:chat-file:download` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:chat-file:fetch` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:chat-file:stat` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:chat-folder:upload` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:export-session-html` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.fromWebContents、BrowserWindow.getFocusedWindow、dialog、shell；窗口做界面动作，数据那一半调 Host | 0 | `maker-ipc/register.ts` |
| `maker:file-browser:cache-put` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:create-file` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:create-folder` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:delete-entry` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:fetch-remote` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:list-all` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:list-dir` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:read-cached` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:read-file` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:rename-entry` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:start-watch` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:stat` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:stop-watch` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:file-browser:write-file` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/index.ts` |
| `maker:html-preview:cancel` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/html-preview-ipc.ts` |
| `maker:html-preview:open` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/html-preview-ipc.ts` |
| `maker:mcp-apps:v1` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、shell；窗口做界面动作，数据那一半调 Host | 0 | `mcp-apps/ipc.ts` |
| `maker:mcp:duplicates:choose` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `maker-ipc/mcpHandlers.ts` |
| `maker:remote-ssh:review-host-key` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 设备互联与远程执行，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host | 0 | `remote-ssh/index.ts` |
| `maker:search:cancel` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/search/index.ts` |
| `maker:search:start` | invoke | C-后台 | 任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时 | 0 | `file-browser/search/index.ts` |
| `peek-file-header` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 0 | `bootstrap-electron.ts` |
| `plugin-market:pick-local-source` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `plugin-market/registerIpc.ts` |
| `profile:choose-avatar` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `bootstrap-electron.ts` |
| `projects-root:choose` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `bootstrap-electron.ts` |
| `read-file-bytes` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 0 | `bootstrap-electron.ts` |
| `read-file-for-attachment` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 0 | `bootstrap-electron.ts` |
| `skillhub:pick-local` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `skillhub/registerIpc.ts` |
| `skillhub:uninstall` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog、shell；窗口做界面动作，数据那一半调 Host | 0 | `skillhub/registerIpc.ts` |
| `terminal:create` | invoke | C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | 0 | `maker-ipc/terminal-handlers.ts` |
| `terminal:dispose` | invoke | C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | 0 | `maker-ipc/terminal-handlers.ts` |
| `terminal:resize` | invoke | C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | 0 | `maker-ipc/terminal-handlers.ts` |
| `terminal:restart` | invoke | C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | 0 | `maker-ipc/terminal-handlers.ts` |
| `terminal:set-default-shell-pref` | invoke | C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | 0 | `maker-ipc/terminal-handlers.ts` |
| `terminal:write` | invoke | C-后台 | 终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次） | 0 | `maker-ipc/terminal-handlers.ts` |
| `text-file:read-preview` | invoke | C-窗口本地 | 用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册 | 0 | `bootstrap-electron.ts` |
| `wechatBot:choose-working-directory` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 弹出系统选择框后写入后台数据：选择在窗口，结果归后台 | 0 | `im/index.ts` |
| `worktree:reveal` | invoke | C-两段式（窗口做界面动作，数据调 Host） | 在访达／资源管理器或系统浏览器里打开后台持有的内容 | 0 | `worktree/index.ts` |

## 窗口类在客户端模式下的实际行为

来源：`docs/host/evidence/channel-usage-client-login.json`（client mode at the sign-in page (isolated cindy-host on a fresh sandbox + pnpm restart:desktop:remote -- --isolated=host-client with CINDY_HOST_API)；client 模式，2026-11-11）；对照 `docs/host/evidence/channel-usage-mock-tour.json`（UI fixture tour (pnpm restart:desktop:remote -- --mock --isolated=host-usage + apps/desktop/scripts/host-client-usage-tour.mjs)；embedded 模式，2026-11-11）。
两份快照都是报告写入时主进程已注册的处理者；客户端快照里没有、普通模式快照里有，就是该在窗口本地处理却没有注册的通道。
客户端快照取在登录页（Host 没有免账号模式），登录后才注册的处理者不在其中。

| 行为 | 通道数 |
|---|---:|
| 窗口本地照常处理 | 364 |
| 被拒：UNSUPPORTED_CAPABILITY | 11 |
| 消息无人监听（被丢弃） | 1 |
| 注册在插件页面的 webContents.ipc 上，主进程快照不覆盖 | 2 |

### 窗口类但客户端模式下未注册（12，尚未实现）

| 通道 | 类型 | 归属 | 客户端模式下 | 调用次数 | 注册文件 |
|---|---|---|---|---:|---|
| `maker:browser:status` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 1 | `maker-ipc/register.ts` |
| `maker:computer:check-update` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 1 | `maker-ipc/register.ts` |
| `maker:computer:status` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 1 | `maker-ipc/register.ts` |
| `maker:browser:open-for-login` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 0 | `maker-ipc/register.ts` |
| `maker:computer:cancel-permission-grant` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 0 | `maker-ipc/register.ts` |
| `maker:computer:driver-icon` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 0 | `maker-ipc/register.ts` |
| `maker:computer:grant-permissions` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 0 | `maker-ipc/register.ts` |
| `maker:computer:install-driver` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 0 | `maker-ipc/register.ts` |
| `maker:computer:permission-app-drag-end` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 0 | `maker-ipc/register.ts` |
| `maker:computer:permission-app-drag-start` | event | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 消息无人监听（被丢弃） | 0 | `maker-ipc/register.ts` |
| `maker:computer:permission-guide-status` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 0 | `maker-ipc/register.ts` |
| `maker:computer:update-driver` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 被拒：UNSUPPORTED_CAPABILITY | 0 | `maker-ipc/register.ts` |

快照无法判断的窗口类通道（2）：`ghost-page:cancel-model-picker`（注册在插件页面的 webContents.ipc 上，主进程快照不覆盖）、`ghost-page:pick-model`（注册在插件页面的 webContents.ipc 上，主进程快照不覆盖）

## 按注册模块

| 模块 | 已代理 | A | B | W | S | R | C | 合计 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| maker-ipc | 26 | 299 | 12 | 0 | 0 | 3 | 14 | 354 |
| bootstrap-electron | 5 | 129 | 61 | 0 | 1 | 0 | 20 | 216 |
| im | 0 | 58 | 0 | 0 | 0 | 0 | 1 | 59 |
| localDb | 26 | 55 | 1 | 1 | 0 | 0 | 4 | 87 |
| device-link | 0 | 49 | 0 | 0 | 0 | 0 | 3 | 52 |
| cindy-brain | 5 | 48 | 2 | 0 | 6 | 0 | 5 | 66 |
| skillhub | 0 | 40 | 0 | 0 | 0 | 0 | 2 | 42 |
| hook-control | 0 | 29 | 0 | 0 | 0 | 0 | 0 | 29 |
| remote-ssh | 0 | 28 | 0 | 0 | 0 | 0 | 1 | 29 |
| git-review | 0 | 20 | 0 | 0 | 0 | 0 | 1 | 21 |
| billing | 0 | 19 | 0 | 0 | 0 | 0 | 2 | 21 |
| local-model-runtime | 0 | 19 | 0 | 0 | 0 | 0 | 0 | 19 |
| plugin-market | 0 | 19 | 0 | 0 | 0 | 0 | 1 | 20 |
| git-context | 0 | 17 | 0 | 0 | 0 | 0 | 0 | 17 |
| plugin-contributions | 0 | 13 | 0 | 0 | 0 | 0 | 0 | 13 |
| worktree | 0 | 11 | 0 | 0 | 0 | 0 | 1 | 12 |
| learn-host | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 6 |
| setup-migration | 0 | 6 | 0 | 0 | 0 | 2 | 0 | 8 |
| plugin-publisher | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 5 |
| session-import | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 5 |
| wecomGroupNotification | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 5 |
| analyticsSettingsService | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 4 |
| appearance-settings-ipc | 2 | 4 | 0 | 0 | 1 | 0 | 2 | 9 |
| app-shortcuts | 0 | 3 | 1 | 0 | 1 | 0 | 0 | 5 |
| remotePrecreatedWorktreeLedger | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 3 |
| cross-agent-convert | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| legacyUserDataMigration | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| local-themes | 0 | 2 | 0 | 0 | 1 | 0 | 2 | 5 |
| process-monitor | 0 | 2 | 0 | 0 | 0 | 0 | 1 | 3 |
| relaunchBusyActivityIpc | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| subscription-accounts | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| bot-import | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| commands | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| local-agent | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| model-access | 2 | 1 | 0 | 0 | 0 | 0 | 0 | 3 |
| provider-group | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| task-migration | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| accessibility-support-ipc | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |
| agent-island | 0 | 0 | 15 | 0 | 0 | 0 | 0 | 15 |
| app-settings | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 |
| appBadgeService | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 3 |
| clientEndpointsService | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 1 |
| crash-diagnosis | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 3 |
| file-browser | 0 | 0 | 0 | 0 | 0 | 0 | 24 | 24 |
| fsBrowse | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 3 |
| ipc | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |
| layout | 2 | 0 | 0 | 0 | 1 | 0 | 0 | 3 |
| log-upload | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 4 |
| login-item-ipc | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |
| maker-host | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| mcp-apps | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| mcp-integrations | 8 | 0 | 1 | 0 | 0 | 0 | 0 | 9 |
| menubar | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |
| notificationService | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |
| performance-trace | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 2 |
| projectOrderStore | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 2 |
| region-screenshot | 0 | 0 | 48 | 0 | 0 | 0 | 0 | 48 |
| remote-desktop | 0 | 0 | 20 | 0 | 0 | 0 | 0 | 20 |
| remote-desktop-viewer | 0 | 0 | 17 | 0 | 0 | 0 | 0 | 17 |
| resource-usage-window | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 4 |
| right-sidebar-window | 0 | 0 | 11 | 0 | 0 | 0 | 0 | 11 |
| rsb-browser-bridge | 0 | 0 | 12 | 0 | 0 | 0 | 0 | 12 |
| sidebar-tab-window | 0 | 0 | 10 | 0 | 0 | 0 | 0 | 10 |
| sidebarSettingsStore | 0 | 0 | 0 | 3 | 2 | 0 | 0 | 5 |
| sidebarWindowExpansionIpc | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 |
| updateService | 0 | 0 | 17 | 0 | 0 | 0 | 0 | 17 |
| voice-conversation | 0 | 0 | 22 | 0 | 0 | 0 | 0 | 22 |
| voice-input | 0 | 0 | 62 | 0 | 0 | 0 | 0 | 62 |
| worklouder-codex | 0 | 0 | 10 | 0 | 0 | 0 | 0 | 10 |
| xbox-gamepad | 0 | 0 | 5 | 0 | 0 | 0 | 0 | 5 |

## 全部通道

### accessibility-support-ipc

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `accessibility-support:get-sync` | event | B（原生对话框、剪贴板、系统外壳与通知） | 2 | `accessibility-support-ipc.ts` |

### agent-island

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `agent-island:completion-action` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `agent-island/service.ts` |
| `agent-island:consume-entry-alert` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `agent-island/service.ts` |
| `agent-island:get-display-options` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts` |
| `agent-island:get-live-activity-support` | invoke | B（窗口外壳、窗口布局与多窗口） | 2 | `agent-island/service.ts` |
| `agent-island:preview-sound` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `agent-island/service.ts` |
| `agent-island:select-sound-file` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `agent-island/service.ts` |
| `agent-island:set-companion-chats` | invoke | B（窗口外壳、窗口布局与多窗口） | 2 | `agent-island/service.ts` |
| `agent-island:set-display-target` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts` |
| `agent-island:set-enabled` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts` |
| `agent-island:set-live-activity` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts` |
| `agent-island:set-mascot-skin` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts` |
| `agent-island:set-remote-sessions` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts` |
| `agent-island:set-sound-settings` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts` |
| `agent-island:set-subtle-reminders` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `agent-island/service.ts` |
| `agent-island:set-visible-session` | invoke | B（窗口外壳、窗口布局与多窗口） | 72 | `agent-island/service.ts` |

### analyticsSettingsService

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `analytics:consent-accept` | invoke | A（设置与偏好） | 0 | `analyticsSettingsService.ts` |
| `analytics:settings-get` | invoke | A（设置与偏好） | 2 | `analyticsSettingsService.ts` |
| `analytics:settings-reset-enabled` | invoke | A（设置与偏好） | 0 | `analyticsSettingsService.ts` |
| `analytics:settings-set-enabled` | invoke | A（设置与偏好） | 0 | `analyticsSettingsService.ts` |

### app-settings

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `app-preferences:reply` | event | R（主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期） | 0 | `app-settings/preferences.ts` |

### app-shortcuts

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `app-shortcuts:clear-override` | invoke | A（设置与偏好） | 0 | `app-shortcuts/index.ts` |
| `app-shortcuts:get` | event | 同步·本地（窗口读 profile：界面设置与首帧提示）（同步通道·界面设置：窗口本地读同一份 profile 文件） | 1 | `app-shortcuts/index.ts` |
| `app-shortcuts:reset-all` | invoke | A（设置与偏好） | 0 | `app-shortcuts/index.ts` |
| `app-shortcuts:set-override` | invoke | A（设置与偏好） | 0 | `app-shortcuts/index.ts` |
| `app-shortcuts:set-recording` | event | B（本机输入设备与语音） | 0 | `app-shortcuts/index.ts` |

### appBadgeService

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `notification:clear-session-attention` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 26 | `appBadgeService.ts` |
| `notification:mark-session-attention` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `appBadgeService.ts` |
| `notification:set-app-attention-count` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 28 | `appBadgeService.ts` |

### appearance-settings-ipc

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `appearance-settings:ensure-wallpaper-image` | invoke | A（设置与偏好） | 0 | `appearance-settings-ipc.ts` |
| `appearance-settings:ensure-wallpaper-video` | invoke | A（设置与偏好） | 0 | `appearance-settings-ipc.ts` |
| `appearance-settings:get` | invoke | A（设置与偏好） | 1 | `appearance-settings-ipc.ts` |
| `appearance-settings:get-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示）（同步通道·界面设置：窗口本地读同一份 profile 文件） | 3 | `appearance-settings-ipc.ts` |
| `appearance-settings:import-wallpaper` | invoke | C-两段式（窗口做界面动作，数据调 Host）（设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents；窗口做界面动作，数据那一半调 Host） | 0 | `appearance-settings-ipc.ts` |
| `appearance-settings:plugin-font` | invoke | C-两段式（窗口做界面动作，数据调 Host）（设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents；窗口做界面动作，数据那一半调 Host） | 0 | `appearance-settings-ipc.ts` |
| `appearance-settings:remove-wallpaper` | invoke | A（设置与偏好） | 0 | `appearance-settings-ipc.ts` |
| `appearance-settings:reset` | invoke | contract | 0 | `appearance-settings-ipc.ts` |
| `appearance-settings:set-patch` | invoke | contract | 0 | `appearance-settings-ipc.ts` |

### billing

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `billing:cancel-current-subscription` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:cancel-plan-change` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:cancel-topup` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:confirm-plan-change` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:create-subscription` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:create-topup` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:get-balance` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:get-catalog` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:get-credit-usage` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:get-current-subscription` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:get-order` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:list-orders` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:list-payment-history` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:open-payment-redirect` | invoke | C-两段式（窗口做界面动作，数据调 Host）（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `billing/index.ts` |
| `billing:open-subscription-portal` | invoke | C-两段式（窗口做界面动作，数据调 Host）（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `billing/index.ts` |
| `billing:quote-plan-change` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:refresh-plan-change` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:refresh-subscription-purchase` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:refresh-topup` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:resume-current-subscription` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |
| `billing:retry-topup` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `billing/index.ts` |

### bootstrap-electron

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `app-locale:get-preferred-system-locale-sync` | event | B（窗口外壳、窗口布局与多窗口） | 3 | `bootstrap-electron.ts` |
| `app-locale:set-classical-style` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `bootstrap-electron.ts` |
| `app-menu:set-locale` | invoke | B（窗口外壳、窗口布局与多窗口） | 3 | `bootstrap-electron.ts` |
| `app:cancel-cindy-make-source` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cancel-cindy-make-task` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-make-contribution` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-make-history` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-make-history-action` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-make-history-build` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-make-history-cancel-build` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-make-history-open-build` | invoke | C-两段式（窗口做界面动作，数据调 Host）（Cindy Make，但处理函数用到窗口 API：shell；窗口做界面动作，数据那一半调 Host） | 0 | `bootstrap-electron.ts` |
| `app:cindy-make-merge` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-make-personal-remote` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-make-sync` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-make-test` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-versions-action` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:cindy-versions-state` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:get-arm64-translation` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 2 | `bootstrap-electron.ts` |
| `app:get-cindy-make-settings` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:get-cindy-make-source-status` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:get-cindy-make-state` | invoke | A（Cindy Make） | 1 | `bootstrap-electron.ts` |
| `app:manage-cindy-make-task` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:open-cindy-make-source-dir` | invoke | C-两段式（窗口做界面动作，数据调 Host）（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `bootstrap-electron.ts` |
| `app:open-cindy-make-tools-dir` | invoke | C-两段式（窗口做界面动作，数据调 Host）（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `bootstrap-electron.ts` |
| `app:open-logs-dir` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `bootstrap-electron.ts` |
| `app:prepare-cindy-make-workspace` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:ready-for-bot` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `bootstrap-electron.ts` |
| `app:set-cindy-make-sync-latest-before-build` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `app:start-cindy-make-task` | invoke | A（Cindy Make） | 0 | `bootstrap-electron.ts` |
| `auth:account-deletion:clear-receipt` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:account-deletion:confirm` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:account-deletion:consume-restored-notice` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:account-deletion:get-availability` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:account-deletion:get-status` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:account-deletion:request-challenge` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:accounts:begin-add` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:accounts:cancel-add` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:accounts:list` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:accounts:switch` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:accounts:sync` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:dispatch-login-action` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:enter-local` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:exit-local` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:get-captcha-challenge-url` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:get-login-state` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `auth:has-persisted-session-hint-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示）（同步通道·账号提示：只读 profile 里的首帧提示（事件流连上之前就要回答），登录状态仍以 Host 为准） | 4 | `bootstrap-electron.ts` |
| `auth:initialize` | invoke | A（账号与凭据） | 2 | `bootstrap-electron.ts` |
| `auth:logout` | invoke | contract | 0 | `bootstrap-electron.ts` |
| `auth:refresh` | invoke | contract | 0 | `bootstrap-electron.ts` |
| `builtin-api-key-has` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `builtin-api-key-remove` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `builtin-api-key-store` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `cc:set-debug-net` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `bootstrap-electron.ts` |
| `chat-attachment:cleanup` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `chat-attachment:save-as` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `chat-attachment:stage` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `check-environment` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `bootstrap-electron.ts` |
| `cindy-media:chat-attachments-clear` | invoke | C-两段式（窗口做界面动作，数据调 Host）（附件与媒体库，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `bootstrap-electron.ts` |
| `cindy-media:chat-attachments-open-dir` | invoke | C-两段式（窗口做界面动作，数据调 Host）（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `bootstrap-electron.ts` |
| `cindy-media:legacy-images-clear` | invoke | C-两段式（窗口做界面动作，数据调 Host）（附件与媒体库，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `bootstrap-electron.ts` |
| `cindy-media:legacy-images-open-dir` | invoke | C-两段式（窗口做界面动作，数据调 Host）（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `bootstrap-electron.ts` |
| `cindy-media:report-draft-urls` | event | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `cindy-media:storage-cleanup` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `cindy-media:storage-reconcile` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `cindy-media:storage-scan` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `cindy-media:storage-stats` | invoke | A（附件与媒体库） | 1 | `bootstrap-electron.ts` |
| `clipboard:copy-text` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `create-project-from-task:chooseParent` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `bootstrap-electron.ts` |
| `create-project-from-task:create` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `create-project-from-task:prepare` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `database-size-warning:get-settings` | invoke | A（设置与偏好） | 3 | `bootstrap-electron.ts` |
| `database-size-warning:get-status` | invoke | A（设置与偏好） | 2 | `bootstrap-electron.ts` |
| `database-size-warning:measure` | invoke | A（设置与偏好） | 1 | `bootstrap-electron.ts` |
| `database-size-warning:reset-settings` | invoke | A（设置与偏好） | 0 | `bootstrap-electron.ts` |
| `database-size-warning:set-settings` | invoke | A（设置与偏好） | 0 | `bootstrap-electron.ts` |
| `deep-link:take-pending` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `bootstrap-electron.ts` |
| `dialog:authorize-recent-writable-directory` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `dialog:show-open-directory` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `dialog:show-open-file` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `dialog:show-open-resource` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `dialogue-workspace:choose` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `bootstrap-electron.ts` |
| `dialogue-workspace:get` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `bootstrap-electron.ts` |
| `dialogue-workspace:open` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `dialogue-workspace:reset` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `file:thumbnail` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 0 | `bootstrap-electron.ts` |
| `find-in-page:start` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `find-in-page:stop` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `fs:resolve-path` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 0 | `bootstrap-electron.ts` |
| `fs:resolve-path-batch` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 1 | `bootstrap-electron.ts` |
| `get-app-display-version-info` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `bootstrap-electron.ts` |
| `get-app-version` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `bootstrap-electron.ts` |
| `get-device-id` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `get-fullscreen-state` | invoke | B（窗口外壳、窗口布局与多窗口） | 10 | `bootstrap-electron.ts` |
| `get-os-release` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `bootstrap-electron.ts` |
| `host-client:observe` | event | client | 2 | `bootstrap-electron.ts` |
| `host-client:retry` | event | client | 0 | `bootstrap-electron.ts` |
| `image-cache:cleanup-files` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `image-cache:cleanup-session` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `image-cache:from-buffer` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `image-cache:from-path` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `image-cache:read-base64` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `local-agent:connections` | invoke | A（设备互联与远程执行） | 1 | `bootstrap-electron.ts` |
| `local-agent:developer-connection` | invoke | A（设备互联与远程执行） | 1 | `bootstrap-electron.ts` |
| `local-agent:revoke` | invoke | A（设备互联与远程执行） | 0 | `bootstrap-electron.ts` |
| `local-agent:set-create-visible-sessions` | invoke | A（设备互联与远程执行） | 0 | `bootstrap-electron.ts` |
| `local-db:maintenance:cancel-startup` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts` |
| `local-db:maintenance:choose-backup-directory` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `bootstrap-electron.ts` |
| `local-db:maintenance:last-result` | invoke | A（任务、消息与输入队列） | 2 | `bootstrap-electron.ts` |
| `local-db:maintenance:open-last-backup-directory` | invoke | C-两段式（窗口做界面动作，数据调 Host）（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `bootstrap-electron.ts` |
| `local-db:maintenance:scan` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts` |
| `local-db:maintenance:schedule` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts` |
| `local-db:maintenance:startup-progress` | invoke | A（任务、消息与输入队列） | 1 | `bootstrap-electron.ts` |
| `maker:chat-embedding:get` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 2 | `bootstrap-electron.ts` |
| `maker:chat-embedding:reset` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `maker:chat-embedding:set` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `maker:claude-oauth:cancel` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `maker:claude-oauth:login` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `maker:claude-oauth:logout` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `maker:claude-oauth:status` | invoke | A（账号与凭据） | 6 | `bootstrap-electron.ts` |
| `maker:claude-session-route:get` | invoke | A（供应商与模型） | 7 | `bootstrap-electron.ts` |
| `maker:codex-runtime-route:get` | invoke | contract | 7 | `bootstrap-electron.ts` |
| `maker:compaction:get-pct` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts` |
| `maker:compaction:get-state` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts` |
| `maker:compaction:reset-pct` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts` |
| `maker:compaction:set-pct` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts` |
| `maker:git-safety:get` | invoke | A（git 与工作树） | 3 | `bootstrap-electron.ts` |
| `maker:git-safety:reset` | invoke | A（git 与工作树） | 0 | `bootstrap-electron.ts` |
| `maker:git-safety:set` | invoke | A（git 与工作树） | 0 | `bootstrap-electron.ts` |
| `maker:im-default-settings:get` | invoke | A（伙伴与 IM） | 6 | `bootstrap-electron.ts` |
| `maker:im-default-settings:reset` | invoke | A（伙伴与 IM） | 0 | `bootstrap-electron.ts` |
| `maker:im-default-settings:set` | invoke | A（伙伴与 IM） | 0 | `bootstrap-electron.ts` |
| `maker:lsp-mode:get` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `bootstrap-electron.ts` |
| `maker:lsp-mode:set` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `maker:memory:get-settings` | invoke | A（记忆、学习与钩子） | 2 | `bootstrap-electron.ts` |
| `maker:memory:get-settings-state` | invoke | A（记忆、学习与钩子） | 1 | `bootstrap-electron.ts` |
| `maker:memory:preserve-legacy-maker-disabled` | invoke | A（记忆、学习与钩子） | 0 | `bootstrap-electron.ts` |
| `maker:open-session-in-new-window` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `maker:open-session-in-new-window-if-dropped-outside` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `maker:pi-compaction:get-pct` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `maker:pi-compaction:get-state` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `maker:pi-compaction:reset-pct` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `maker:pi-compaction:set-pct` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `maker:session-drag-preview:end` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `maker:session-drag-preview:start` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `maker:session-runtime-fallback:get` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts` |
| `maker:session-runtime-fallback:reset` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts` |
| `maker:session-runtime-fallback:set` | invoke | A（任务、消息与输入队列） | 0 | `bootstrap-electron.ts` |
| `maker:sidebar-tab-drag-preview:end` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `maker:sidebar-tab-drag-preview:start` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `maker:silent-encrypted-retry:get` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 4 | `bootstrap-electron.ts` |
| `maker:silent-encrypted-retry:reset` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `maker:silent-encrypted-retry:set` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `maker:subagent-model-settings:get` | invoke | A（供应商与模型） | 1 | `bootstrap-electron.ts` |
| `maker:subagent-model-settings:reset` | invoke | A（供应商与模型） | 0 | `bootstrap-electron.ts` |
| `maker:subagent-model-settings:set` | invoke | A（供应商与模型） | 0 | `bootstrap-electron.ts` |
| `maker:vision-bridge-settings:get` | invoke | A（供应商与模型） | 1 | `bootstrap-electron.ts` |
| `maker:vision-bridge-settings:reset` | invoke | A（供应商与模型） | 0 | `bootstrap-electron.ts` |
| `maker:vision-bridge-settings:set` | invoke | A（供应商与模型） | 0 | `bootstrap-electron.ts` |
| `maker:xai-oauth:cancel` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `maker:xai-oauth:login` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `maker:xai-oauth:logout` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `media:cache-for-session` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `media:copy-png-to-clipboard` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `media:copy-to-clipboard` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `media:open-with-default-app` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `media:read-image-bytes` | invoke | A（附件与媒体库） | 0 | `bootstrap-electron.ts` |
| `media:save-as` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `open-with:list` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `open-with:open` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `page-zoom:in` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `page-zoom:out` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `page-zoom:reset` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `peek-file-header` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 0 | `bootstrap-electron.ts` |
| `profile:choose-avatar` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `bootstrap-electron.ts` |
| `profile:get-state` | invoke | A（设置与偏好） | 0 | `bootstrap-electron.ts` |
| `profile:update` | invoke | A（设置与偏好） | 0 | `bootstrap-electron.ts` |
| `projects-root:choose` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `bootstrap-electron.ts` |
| `projects-root:get` | invoke | A（设置与偏好） | 1 | `bootstrap-electron.ts` |
| `projects-root:reset` | invoke | A（设置与偏好） | 0 | `bootstrap-electron.ts` |
| `read-file-bytes` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 0 | `bootstrap-electron.ts` |
| `read-file-for-attachment` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 0 | `bootstrap-electron.ts` |
| `release-notes:fetch` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 2 | `bootstrap-electron.ts` |
| `release-notes:fetch-index` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `bootstrap-electron.ts` |
| `renderer:log` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 79 | `bootstrap-electron.ts` |
| `safe-storage-read` | invoke | A（账号与凭据） | 1 | `bootstrap-electron.ts` |
| `safe-storage-remove` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `safe-storage-store` | invoke | A（账号与凭据） | 0 | `bootstrap-electron.ts` |
| `shell:open-chatgpt-app` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `shell:open-external` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `shell:open-file-in-browser` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `shell:open-path` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `shell:show-item-in-folder` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `show-open-directory-dialog` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `bootstrap-electron.ts` |
| `startup-gate:stalled` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `text-file:read-preview` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 0 | `bootstrap-electron.ts` |
| `theme:apply-vibrancy` | event | B（窗口外壳、窗口布局与多窗口） | 10 | `bootstrap-electron.ts` |
| `theme:set-sidebar-width` | event | B（窗口外壳、窗口布局与多窗口） | 3 | `bootstrap-electron.ts` |
| `toggle-fullscreen` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-behavior:get-linux-close-behavior` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-behavior:get-windows-close-behavior` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-behavior:linux-close-behavior-shown` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-behavior:set-linux-close-behavior` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-behavior:set-swallow-activation-click` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-behavior:set-windows-close-behavior` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-behavior:windows-close-behavior-shown` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-close` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-close-self` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-drag-move-start` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-drag-move-stop` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-exit-fullscreen` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-maximize` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `window-minimize` | event | B（窗口外壳、窗口布局与多窗口） | 0 | `bootstrap-electron.ts` |
| `workspace:scan-at-resources` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `workspace:scan-slash-commands` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `bootstrap-electron.ts` |
| `worktree-recycle:control` | invoke | A（git 与工作树） | 0 | `bootstrap-electron.ts` |
| `worktree-recycle:list` | invoke | A（git 与工作树） | 1 | `bootstrap-electron.ts` |

### bot-import

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `companion-import` | invoke | A（伙伴与 IM） | 1 | `bot-import/registration.ts` |

### cindy-brain

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `forge-oidc-install:resolve-confirm` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghost-page:cancel-model-picker` | event | B（单个窗口内的插件页面 IPC（webContents.ipc）） | 0 | `cindy-brain/ghostPageModelPicker.ts` |
| `ghost-page:pick-model` | invoke | B（单个窗口内的插件页面 IPC（webContents.ipc）） | 0 | `cindy-brain/ghostPageModelPicker.ts` |
| `ghost-pipe:ping` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghost-pipe:send` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:acknowledge-retirement` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:activate-browser` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:builtin-status` | event | 同步·数据归 Host（需窗口缓存镜像）（同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计） | 0 | `cindy-brain/index.ts` |
| `ghosts:card:action` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:card:get` | invoke | contract | 0 | `cindy-brain/index.ts` |
| `ghosts:card:list-by-session` | invoke | contract | 13 | `cindy-brain/index.ts` |
| `ghosts:card:report-height` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:clear-unread` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:composer-list` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:confirm:resolve` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:control-points:candidates` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:control-points:get` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:defer-ui-prompt` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:dev-runtime` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:errand-prefs` | event | 同步·数据归 Host（需窗口缓存镜像）（同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计） | 0 | `cindy-brain/index.ts` |
| `ghosts:errand-prefs:set` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:export` | invoke | C-两段式（窗口做界面动作，数据调 Host）（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `cindy-brain/index.ts` |
| `ghosts:handoff-delete` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:handoff-folder` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:handoff-list` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:inspect` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:install` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:install-consent:resolve` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:legacy-recovery-status` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:library-bind` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:library-delete` | invoke | C-两段式（窗口做界面动作，数据调 Host）（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `cindy-brain/index.ts` |
| `ghosts:library-overview` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:library-pick-location` | invoke | C-两段式（窗口做界面动作，数据调 Host）（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `cindy-brain/index.ts` |
| `ghosts:library-reattach-legacy` | invoke | C-两段式（窗口做界面动作，数据调 Host）（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `cindy-brain/index.ts` |
| `ghosts:library-relocate` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:library-revert-default` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:library-unbind` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:list` | event | contract | 5 | `cindy-brain/index.ts` |
| `ghosts:mail-preview` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:mark-used` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:model-picker:resolve` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:models:list` | invoke | A（插件、技能与 MCP） | 4 | `cindy-brain/index.ts` |
| `ghosts:open-retirement` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:pick-file` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `cindy-brain/index.ts` |
| `ghosts:readme` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:recent-usage` | event | 同步·数据归 Host（需窗口缓存镜像）（同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计） | 2 | `cindy-brain/index.ts` |
| `ghosts:recommendations` | event | 同步·数据归 Host（需窗口缓存镜像）（同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计） | 8 | `cindy-brain/index.ts` |
| `ghosts:reload` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:request-task-approval` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:request-ui-approval` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:resolve-panel-media` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:restore-builtin` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:retry-legacy-recovery` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:runtime-states` | invoke | contract | 0 | `cindy-brain/index.ts` |
| `ghosts:session-focused` | event | A（插件、技能与 MCP） | 32 | `cindy-brain/index.ts` |
| `ghosts:set-enabled` | invoke | contract | 0 | `cindy-brain/index.ts` |
| `ghosts:setup-status` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:start-task:route` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:take-pending-install` | invoke | A（插件、技能与 MCP） | 1 | `cindy-brain/index.ts` |
| `ghosts:ui-prompts` | invoke | A（插件、技能与 MCP） | 19 | `cindy-brain/index.ts` |
| `ghosts:uninstall` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:unread` | event | 同步·数据归 Host（需窗口缓存镜像）（同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计） | 1 | `cindy-brain/index.ts` |
| `ghosts:update` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:workdir-prefs` | event | 同步·数据归 Host（需窗口缓存镜像）（同步通道·插件、技能与 MCP：数据归 Host，需窗口缓存镜像（Host 经事件流推送，窗口同步回答缓存）或改界面为异步，放进对应小批单独设计） | 0 | `cindy-brain/index.ts` |
| `ghosts:workdir-prefs` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |
| `ghosts:workdir-prefs:set` | invoke | A（插件、技能与 MCP） | 0 | `cindy-brain/index.ts` |

### clientEndpointsService

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `client-endpoints:get-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示）（同步通道·界面设置：窗口本地读同一份 profile 文件） | 1 | `clientEndpointsService.ts` |

### commands

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `desktop-cmd:run` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `commands/remoteCmdIpc.ts` |

### crash-diagnosis

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `crash-diagnosis:dismiss` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `crash-diagnosis.ts` |
| `crash-diagnosis:get` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `crash-diagnosis.ts` |
| `crash-diagnosis:prepare` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `crash-diagnosis.ts` |

### cross-agent-convert

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `maker:cross-agent:convert` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `cross-agent-convert/ipc.ts` |
| `maker:cross-agent:detect` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `cross-agent-convert/ipc.ts` |

### device-link

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `device-link:close-link` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:confirm-skill-mutation` | invoke | C-两段式（窗口做界面动作，数据调 Host）（设备互联与远程执行，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `device-link/ipc.ts` |
| `device-link:delete-device` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:disconnect-all` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:get-peer-links` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:get-state` | invoke | A（设备互联与远程执行） | 20 | `device-link/ipc.ts` |
| `device-link:invoke` | invoke | C-专项设计（安全边界）（安全边界待专项设计：用户填写的值只交给宿主执行（input-handoff），远程控制派发；方案出来前不动） | 0 | `device-link/ipc.ts` |
| `device-link:list-devices` | invoke | A（设备互联与远程执行） | 33 | `device-link/ipc.ts` |
| `device-link:mirror-cache:clear` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:mirror-cache:messages:get` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:mirror-cache:messages:put` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:mirror-cache:session-list:get` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:mirror-cache:session-list:put` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:open-link` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:pick-plugin-package` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `device-link/ipc.ts` |
| `device-link:plugin-settings:answer-directory` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:plugin-settings:answer-model-picker` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:plugin-settings:close` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:plugin-settings:open` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:rename-device` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:restore` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:revoke` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:set-device-control-enabled` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:set-enabled` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:set-keep-awake` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:set-model-use` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:topic-subscribe` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `device-link:topic-unsubscribe` | invoke | A（设备互联与远程执行） | 0 | `device-link/ipc.ts` |
| `direct-link:host:event` | invoke | A（设备互联与远程执行） | 0 | `device-link/directLink.ts` |
| `direct-link:host:register` | invoke | A（设备互联与远程执行） | 0 | `device-link/directLink.ts` |
| `file-peer:host:closed` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts` |
| `file-peer:host:invoke` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts` |
| `file-peer:host:read` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts` |
| `file-peer:host:register` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts` |
| `file-peer:host:reply` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts` |
| `file-peer:host:write` | invoke | A（设备互联与远程执行） | 0 | `device-link/filePeer.ts` |
| `maker:provider-share:received-catalogs` | invoke | A（供应商与模型） | 0 | `device-link/providerShareRuntime.ts` |
| `maker:remote-resources:get` | invoke | A（设备互联与远程执行） | 0 | `device-link/remoteResourcesIpc.ts` |
| `maker:remote-resources:invoke` | invoke | A（设备互联与远程执行） | 0 | `device-link/remoteResourcesIpc.ts` |
| `maker:remote-resources:list` | invoke | A（设备互联与远程执行） | 0 | `device-link/remoteResourcesIpc.ts` |
| `maker:remote-resources:manifest` | invoke | A（设备互联与远程执行） | 0 | `device-link/remoteResourcesIpc.ts` |
| `maker:shared-task` | invoke | A（设备互联与远程执行） | 0 | `device-link/sharedTaskIpc.ts` |
| `plugin-oauth:answer-input-picture` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts` |
| `plugin-oauth:assist` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts` |
| `plugin-oauth:device-code` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts` |
| `plugin-oauth:open-input-picture` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts` |
| `plugin-oauth:submit-connection` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts` |
| `plugin-oauth:submit-input` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts` |
| `plugin-oauth:submit-secret` | invoke | A（账号与凭据） | 0 | `device-link/ipc.ts` |
| `provider-share:command` | invoke | A（供应商与模型） | 4 | `device-link/providerShareRuntime.ts` |
| `self-hosted-relay:command` | invoke | A（设备互联与远程执行） | 3 | `device-link/selfHostedRelayRuntime.ts` |
| `shared-task:account` | invoke | A（设备互联与远程执行） | 0 | `device-link/sharedTaskIpc.ts` |

### file-browser

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `file-browser:remote-op` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/device-op.ts` |
| `maker:chat-file:cancel` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:chat-file:download` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:chat-file:fetch` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:chat-file:stat` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:chat-folder:upload` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:cache-put` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:create-file` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:create-folder` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:delete-entry` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:fetch-remote` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:list-all` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:list-dir` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:read-cached` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:read-file` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:rename-entry` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:start-watch` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:stat` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:stop-watch` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:file-browser:write-file` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/index.ts` |
| `maker:html-preview:cancel` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/html-preview-ipc.ts` |
| `maker:html-preview:open` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/html-preview-ipc.ts` |
| `maker:search:cancel` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/search/index.ts` |
| `maker:search:start` | invoke | C-后台（任务范围内的文件操作：换窗口时不能断，网页和手机也要用，路径授权跟着运行时） | 0 | `file-browser/search/index.ts` |

### fsBrowse

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `fs:list-dir` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 0 | `fsBrowse/ipc.ts` |
| `fs:mkdir-p` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 0 | `fsBrowse/ipc.ts` |
| `fs:stat-path` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 0 | `fsBrowse/ipc.ts` |

### git-context

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `git-context:find-linked-worktree` | invoke | A（git 与工作树） | 17 | `git-context/ipc.ts` |
| `git-context:get` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts` |
| `git-context:get-for-session` | invoke | A（git 与工作树） | 19 | `git-context/ipc.ts` |
| `git-context:github-read` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts` |
| `git-context:github-setup:cancel` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts` |
| `git-context:github-setup:connection` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts` |
| `git-context:github-setup:start` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts` |
| `git-context:github-setup:status` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts` |
| `git-context:github-star:add` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts` |
| `git-context:github-star:check` | invoke | A（git 与工作树） | 0 | `git-context/githubSetupIpc.ts` |
| `git-context:mr-status` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts` |
| `git-context:pr-refs:list` | invoke | A（git 与工作树） | 14 | `git-context/ipc.ts` |
| `git-context:pr-refs:list-all` | invoke | A（git 与工作树） | 3 | `git-context/ipc.ts` |
| `git-context:pr-refs:manage` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts` |
| `git-context:pr-status` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts` |
| `git-context:unwatch` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts` |
| `git-context:watch` | invoke | A（git 与工作树） | 0 | `git-context/ipc.ts` |

### git-review

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `git-review:branch-diff` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:commit` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:commit-diff` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:commits` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:discard-all` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:discard-file` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:discard-hunk` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:file-diff` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:get` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:image-preview` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:markdown-preview` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:open-file` | invoke | C-两段式（窗口做界面动作，数据调 Host）（git 与工作树，但处理函数用到窗口 API：shell；窗口做界面动作，数据那一半调 Host） | 0 | `git-review/ipc.ts` |
| `git-review:push` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:remote-op` | invoke | A（git 与工作树） | 0 | `git-review/device-op.ts` |
| `git-review:stage-all` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:stage-file` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:stage-hunk` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:summary` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:unstage-all` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:unstage-file` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |
| `git-review:unstage-hunk` | invoke | A（git 与工作树） | 0 | `git-review/ipc.ts` |

### hook-control

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `maker:hook-control:add-binding` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:bind-revoke` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:bind-start` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:cancel-pending-bind` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:get` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:prefs-get` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:prefs-set` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:provider-bind-cancel` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:provider-bind-revoke` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:provider-bind-select` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:provider-bind-start` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:provider-open-action` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:provider-prefs-get` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:provider-prefs-set` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:rebind-team` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:revoke-team` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:set-enabled` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:set-lifecycle-announcement` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:set-provider-default-workspace` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:set-provider-enabled` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:set-slack-communications` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:set-workspaces` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:set-x-companion` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:telegram-behavior-get` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:telegram-behavior-set` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:telegram-group-activation-set` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:telegram-groups-list` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:workspace-provider-source-get` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |
| `maker:hook-control:workspace-provider-source-set` | invoke | A（记忆、学习与钩子） | 0 | `hook-control/ipc.ts` |

### im

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `binding:list-attached` | invoke | A（伙伴与 IM） | 4 | `im/index.ts` |
| `binding:resolve-session` | invoke | A（伙伴与 IM） | 15 | `im/index.ts` |
| `binding:revoke` | invoke | A（伙伴与 IM） | 0 | `im/index.ts` |
| `botImConnection:add` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts` |
| `botImConnection:adopt` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImPersonalAdoption.ts` |
| `botImConnection:archive-lane` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts` |
| `botImConnection:list` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts` |
| `botImConnection:list-adoptable` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImPersonalAdoption.ts` |
| `botImConnection:list-discord-channels` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts` |
| `botImConnection:list-groups` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts` |
| `botImConnection:list-lanes` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts` |
| `botImConnection:remove` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts` |
| `botImConnection:reset-lane` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts` |
| `botImConnection:set-discord-channel-access` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts` |
| `botImConnection:set-group-activation` | invoke | A（伙伴与 IM） | 0 | `im/shared/botImConnectionRuntime.ts` |
| `desktop:cc-prefs-changed` | event | A（伙伴与 IM） | 4 | `im/index.ts` |
| `dingtalkBot:clear` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/dingtalk/index.ts` |
| `dingtalkBot:get-state` | invoke | A（伙伴与 IM） | 1 | `packages/lizi-im/src/dingtalk/index.ts` |
| `dingtalkBot:reconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/dingtalk/index.ts` |
| `dingtalkBot:save` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/dingtalk/index.ts` |
| `discordBot:check-session-auth` | invoke | A（伙伴与 IM） | 0 | `im/discord/sessionAuth.ts` |
| `discordBot:disconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts` |
| `discordBot:get-channel-access` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts` |
| `discordBot:get-status` | invoke | A（伙伴与 IM） | 1 | `packages/lizi-im/src/discord/index.ts` |
| `discordBot:list-channels` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts` |
| `discordBot:reconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts` |
| `discordBot:set-channel-access` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts` |
| `discordBot:set-config` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts` |
| `discordBot:set-lifecycle-announcement` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/discord/index.ts` |
| `feishuBot:clear` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/feishu/ipc.ts` |
| `feishuBot:get-state` | invoke | A（伙伴与 IM） | 2 | `packages/lizi-im/src/feishu/ipc.ts` |
| `feishuBot:reconnect` | invoke | A（伙伴与 IM） | 0 | `im/index.ts` |
| `feishuBot:registration-begin` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/feishu/ipc.ts` |
| `feishuBot:registration-cancel` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/feishu/ipc.ts` |
| `feishuBot:save` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/feishu/ipc.ts` |
| `feishuBot:set-lifecycle-announcement` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/feishu/ipc.ts` |
| `telegramBot:check-session-auth` | invoke | A（伙伴与 IM） | 0 | `im/telegram/sessionAuth.ts` |
| `telegramBot:disconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/telegram/index.ts` |
| `telegramBot:get-behavior` | invoke | A（伙伴与 IM） | 0 | `im/host.ts` |
| `telegramBot:get-persona` | invoke | A（伙伴与 IM） | 0 | `im/host.ts` |
| `telegramBot:get-status` | invoke | A（伙伴与 IM） | 1 | `packages/lizi-im/src/telegram/index.ts` |
| `telegramBot:list-groups` | invoke | A（伙伴与 IM） | 0 | `im/host.ts` |
| `telegramBot:set-behavior` | invoke | A（伙伴与 IM） | 0 | `im/host.ts` |
| `telegramBot:set-config` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/telegram/index.ts` |
| `telegramBot:set-group-activation` | invoke | A（伙伴与 IM） | 0 | `im/host.ts` |
| `telegramBot:set-online` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/telegram/index.ts` |
| `telegramBot:set-persona` | invoke | A（伙伴与 IM） | 0 | `im/host.ts` |
| `wechatBot:authorize` | invoke | A（伙伴与 IM） | 0 | `im/index.ts` |
| `wechatBot:cancel-authorization` | invoke | A（伙伴与 IM） | 0 | `im/index.ts` |
| `wechatBot:choose-working-directory` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `im/index.ts` |
| `wechatBot:get-channel-settings` | invoke | A（伙伴与 IM） | 1 | `im/index.ts` |
| `wechatBot:get-state` | invoke | A（伙伴与 IM） | 1 | `im/index.ts` |
| `wechatBot:reset-working-directory` | invoke | A（伙伴与 IM） | 0 | `im/index.ts` |
| `wechatBot:set-companion` | invoke | A（伙伴与 IM） | 0 | `im/index.ts` |
| `wechatBot:unbind` | invoke | A（伙伴与 IM） | 0 | `im/index.ts` |
| `wecomBot:disconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/wecom/index.ts` |
| `wecomBot:get-status` | invoke | A（伙伴与 IM） | 1 | `packages/lizi-im/src/wecom/index.ts` |
| `wecomBot:reconnect` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/wecom/index.ts` |
| `wecomBot:set-config` | invoke | A（伙伴与 IM） | 0 | `packages/lizi-im/src/wecom/index.ts` |

### ipc

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `dev:embedding:status` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `ipc/dev/embedding.ts` |
| `dev:embedding:test-embed` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `ipc/dev/embedding.ts` |

### layout

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `layout:get` | event | 同步·本地（窗口读 profile：界面设置与首帧提示）（同步通道·界面设置：窗口本地读同一份 profile 文件） | 3 | `layout/index.ts` |
| `layout:reset` | invoke | contract | 0 | `layout/index.ts` |
| `layout:set` | invoke | contract | 0 | `layout/index.ts` |

### learn-host

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `learn:apply` | invoke | A（记忆、学习与钩子） | 0 | `learn-host/registerIpc.ts` |
| `learn:cancel` | invoke | A（记忆、学习与钩子） | 0 | `learn-host/registerIpc.ts` |
| `learn:discard` | invoke | A（记忆、学习与钩子） | 0 | `learn-host/registerIpc.ts` |
| `learn:get-proposal-diff` | invoke | A（记忆、学习与钩子） | 0 | `learn-host/registerIpc.ts` |
| `learn:list-runs` | invoke | A（记忆、学习与钩子） | 18 | `learn-host/registerIpc.ts` |
| `learn:start` | invoke | A（记忆、学习与钩子） | 0 | `learn-host/registerIpc.ts` |

### legacyUserDataMigration

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `legacy-migration:confirm` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `legacyUserDataMigration.ts` |
| `legacy-migration:get-state` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `legacyUserDataMigration.ts` |

### local-agent

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `local-agent:confirmation:answer` | invoke | A（设备互联与远程执行） | 0 | `local-agent/confirmation.ts` |

### local-model-runtime

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `maker:llamacpp:cancel` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts` |
| `maker:llamacpp:download` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts` |
| `maker:llamacpp:ensure` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts` |
| `maker:llamacpp:files` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts` |
| `maker:llamacpp:install` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts` |
| `maker:llamacpp:start` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts` |
| `maker:llamacpp:status` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts` |
| `maker:llamacpp:stop` | invoke | A（供应商与模型） | 0 | `local-model-runtime/llamaCppIpc.ts` |
| `maker:local-model:abort` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |
| `maker:local-model:delete` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |
| `maker:local-model:discard-paused` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |
| `maker:local-model:ensure` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |
| `maker:local-model:install` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |
| `maker:local-model:install-abort` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |
| `maker:local-model:list` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |
| `maker:local-model:pull` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |
| `maker:local-model:set-in-picker` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |
| `maker:local-model:start` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |
| `maker:local-model:status` | invoke | A（供应商与模型） | 0 | `local-model-runtime/ipc.ts` |

### local-themes

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `local-themes:import` | invoke | C-两段式（窗口做界面动作，数据调 Host）（设置与偏好，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `local-themes/register.ts` |
| `local-themes:list` | invoke | A（设置与偏好） | 1 | `local-themes/register.ts` |
| `local-themes:list-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示）（同步通道·界面设置：窗口本地读同一份 profile 文件） | 3 | `local-themes/register.ts` |
| `local-themes:open-dir` | invoke | C-两段式（窗口做界面动作，数据调 Host）（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `local-themes/register.ts` |
| `local-themes:write` | invoke | A（设置与偏好） | 0 | `local-themes/register.ts` |

### localDb

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `dev:sqlite-vec:status` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `localDb/ipc/dev/sqliteVec.ts` |
| `local-db:bots:choose-avatar` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:choose-avatar-source` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:create` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:create-canonical-session` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:dm-thread:ensure` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:dm-thread:list` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:generate-avatar` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:generate-draft` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:get` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:history` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:list` | invoke | A（伙伴与 IM） | 5 | `localDb/ipc/bots.ts` |
| `local-db:bots:memory:delete` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:memory:list` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:memory:read` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:memory:update` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:model-chain-settings-get` | invoke | A（伙伴与 IM） | 6 | `localDb/ipc/bots.ts` |
| `local-db:bots:model-chain-settings-reset` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:model-chain-settings-set` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:projects:list` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:projects:set` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:search-history` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:skills:core` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/botSkillSettingsIpc.ts` |
| `local-db:bots:skills:delete` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/botSkillSettingsIpc.ts` |
| `local-db:bots:skills:list` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:skills:read` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/botSkillSettingsIpc.ts` |
| `local-db:bots:skills:save` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/botSkillSettingsIpc.ts` |
| `local-db:bots:skills:set-enabled` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/botSkillSettingsIpc.ts` |
| `local-db:bots:update` | invoke | A（伙伴与 IM） | 0 | `localDb/ipc/bots.ts` |
| `local-db:bots:workbench:follow-scopes` | invoke | A（伙伴与 IM） | 1 | `localDb/ipc/bots.ts` |
| `local-db:conversations:search` | invoke | contract | 0 | `localDb/ipc/search.desktop.ts` |
| `local-db:ensure-ready` | invoke | A（任务、消息与输入队列） | 1 | `localDb/ipc/registerAll.ts` |
| `local-db:history:messages` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/history.ts` |
| `local-db:history:query` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/historyQuery.ts` |
| `local-db:messages:around` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts` |
| `local-db:messages:around-client-id` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts` |
| `local-db:messages:create` | invoke | contract | 0 | `localDb/ipc/messages.ts` |
| `local-db:messages:dismiss-error` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts` |
| `local-db:messages:estimatedSessionValue` | invoke | contract | 15 | `localDb/ipc/messages.ts` |
| `local-db:messages:list` | invoke | contract | 1 | `localDb/ipc/messages.ts` |
| `local-db:messages:updateAgentMeta` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts` |
| `local-db:messages:updateContent` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts` |
| `local-db:messages:view` | invoke | contract | 16 | `localDb/ipc/messages.ts` |
| `local-db:messages:view-intent` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts` |
| `local-db:messages:work-details` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/messages.ts` |
| `local-db:orca-workflows:get-by-lead` | invoke | A（Orca） | 0 | `localDb/ipc/orcaTeams.ts` |
| `local-db:orca-workflows:get-by-worker-session` | invoke | A（Orca） | 0 | `localDb/ipc/orcaTeams.ts` |
| `local-db:orca-workflows:list-workers-by-lead` | invoke | A（Orca） | 0 | `localDb/ipc/orcaTeams.ts` |
| `local-db:orca-workflows:list-workers-by-leads` | invoke | A（Orca） | 0 | `localDb/ipc/orcaTeams.ts` |
| `local-db:orca-workflows:update-worker-status` | invoke | A（Orca） | 0 | `localDb/ipc/orcaTeams.ts` |
| `local-db:project-aliases:delete` | invoke | contract | 0 | `localDb/ipc/projectAliases.ts` |
| `local-db:project-aliases:list` | invoke | contract | 15 | `localDb/ipc/projectAliases.ts` |
| `local-db:project-aliases:set` | invoke | contract | 0 | `localDb/ipc/projectAliases.ts` |
| `local-db:recent-workdirs:list` | invoke | contract | 3 | `localDb/ipc/recentWorkdirs.ts` |
| `local-db:recent-workdirs:remove` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/recentWorkdirs.ts` |
| `local-db:right-sidebar-tabs:close` | invoke | contract | 0 | `localDb/ipc/rightSidebarTabs.desktop.ts` |
| `local-db:right-sidebar-tabs:ensure-singleton` | invoke | contract | 0 | `localDb/ipc/rightSidebarTabs.desktop.ts` |
| `local-db:right-sidebar-tabs:list` | invoke | contract | 13 | `localDb/ipc/rightSidebarTabs.desktop.ts` |
| `local-db:right-sidebar-tabs:reorder` | invoke | contract | 0 | `localDb/ipc/rightSidebarTabs.desktop.ts` |
| `local-db:right-sidebar-tabs:setActive` | invoke | contract | 0 | `localDb/ipc/rightSidebarTabs.desktop.ts` |
| `local-db:right-sidebar-tabs:upsert` | invoke | contract | 0 | `localDb/ipc/rightSidebarTabs.desktop.ts` |
| `local-db:session-share:cancel` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/session-share.ts` |
| `local-db:session-share:classify-path` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/session-share.ts` |
| `local-db:session-share:commit` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/session-share.ts` |
| `local-db:session-share:export` | invoke | C-两段式（窗口做界面动作，数据调 Host）（任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.getFocusedWindow、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `localDb/ipc/session-share.ts` |
| `local-db:session-share:inspect` | invoke | C-两段式（窗口做界面动作，数据调 Host）（任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.getFocusedWindow、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `localDb/ipc/session-share.ts` |
| `local-db:session-share:unlock` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/session-share.ts` |
| `local-db:sessions:ack-interrupted` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:create` | invoke | contract | 1 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:dismiss-pending-alerts` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:error-tail-pending` | invoke | contract | 36 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:get` | invoke | contract | 32 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:get-many` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:interrupted-pending` | invoke | contract | 1 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:interrupted-resume-candidates` | invoke | contract | 1 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:list` | invoke | contract | 12 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:patch-meta` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:resolve-references` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:restore-if-archived` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:set-pinned-card-summaries` | invoke | A（任务、消息与输入队列） | 1 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:touchUserSend` | invoke | A（任务、消息与输入队列） | 0 | `localDb/ipc/sessions.ts` |
| `local-db:sessions:update` | invoke | contract | 0 | `localDb/ipc/sessions.ts` |
| `local-db:subagent-runs:detail` | invoke | contract | 0 | `localDb/ipc/subagentRuns.ts` |
| `local-db:subagent-runs:list` | invoke | contract | 30 | `localDb/ipc/subagentRuns.ts` |
| `local-db:subagent-runs:transcript` | invoke | contract | 0 | `localDb/ipc/subagentRuns.ts` |
| `local-db:task-tags:execute` | invoke | contract | 0 | `localDb/ipc/taskTags.ts` |
| `sidebar-settings:get-project-aliases` | invoke | W（窗口本地设置：窗口直接读写同一份 profile 文件，不经 Host） | 0 | `localDb/ipc/projectAliases.ts` |

### log-upload

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `log-upload:reset-crash-auto` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `log-upload/index.ts` |
| `log-upload:set-crash-auto` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `log-upload/index.ts` |
| `log-upload:settings-get` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 2 | `log-upload/index.ts` |
| `log-upload:upload-now` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `log-upload/index.ts` |

### login-item-ipc

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `login-item:get` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 2 | `login-item-ipc.ts` |
| `login-item:set` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `login-item-ipc.ts` |

### maker-host

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `maker:model-visibility:legacy-owner-claim-sync` | event | contract | 0 | `maker-host/model-visibility-owner-claim.ts` |

### maker-ipc

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `ghosts:background-tasks:list` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts` |
| `ghosts:background-tasks:reveal` | invoke | C-两段式（窗口做界面动作，数据调 Host）（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `maker-ipc/register.ts` |
| `input-handoff:picture` | invoke | C-专项设计（安全边界）（安全边界待专项设计：用户填写的值只交给宿主执行（input-handoff），远程控制派发；方案出来前不动） | 0 | `maker-ipc/register.ts` |
| `input-handoff:raise` | invoke | C-专项设计（安全边界）（安全边界待专项设计：用户填写的值只交给宿主执行（input-handoff），远程控制派发；方案出来前不动） | 0 | `maker-ipc/register.ts` |
| `input-handoff:submit` | invoke | C-专项设计（安全边界）（安全边界待专项设计：用户填写的值只交给宿主执行（input-handoff），远程控制派发；方案出来前不动） | 0 | `maker-ipc/register.ts` |
| `local-db:bots:read-state:get` | invoke | A（伙伴与 IM） | 1 | `maker-ipc/botReadStateIpc.ts` |
| `local-db:bots:read-state:update` | invoke | A（伙伴与 IM） | 6 | `maker-ipc/botReadStateIpc.ts` |
| `maker:abort-session` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:agent-resource-settings:get` | invoke | A（设置与偏好） | 2 | `maker-ipc/register.ts` |
| `maker:agent-resource-settings:reset` | invoke | A（设置与偏好） | 0 | `maker-ipc/register.ts` |
| `maker:agent-resource-settings:set` | invoke | A（设置与偏好） | 0 | `maker-ipc/register.ts` |
| `maker:agent-task:stop` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/stopAgentTaskHandler.ts` |
| `maker:agent:binary-version` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 3 | `maker-ipc/binary-version.ts` |
| `maker:agent:pi-kernel-install` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/pi-kernel.ts` |
| `maker:agent:pi-kernel-state` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 2 | `maker-ipc/pi-kernel.ts` |
| `maker:agent:status` | invoke | contract | 13 | `maker-ipc/statusHandlers.ts` |
| `maker:android:get-config` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `maker-ipc/androidHandlers.ts` |
| `maker:android:prepare-adb` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/androidHandlers.ts` |
| `maker:android:set-adb-path` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/androidHandlers.ts` |
| `maker:android:set-default-device` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/androidHandlers.ts` |
| `maker:android:status` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/androidHandlers.ts` |
| `maker:any-session-in-turn` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:api-key:present` | invoke | A（账号与凭据） | 0 | `maker-ipc/authHandlers.ts` |
| `maker:apply-new-maker-draft-pref` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:apply-new-maker-worktree-branch-pref` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/newMakerWorktreeBranchPreferenceHandler.ts` |
| `maker:apply-new-maker-worktree-pref` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/newMakerWorktreePreferenceHandler.ts` |
| `maker:at-context:list` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:auth:cancel-login` | invoke | contract | 0 | `maker-ipc/authHandlers.ts` |
| `maker:auth:get-state` | invoke | contract | 1 | `maker-ipc/authHandlers.ts` |
| `maker:auth:logout` | invoke | contract | 0 | `maker-ipc/authHandlers.ts` |
| `maker:auth:trigger-login` | invoke | contract | 0 | `maker-ipc/authHandlers.ts` |
| `maker:auto-title` | invoke | A（任务、消息与输入队列） | 1 | `maker-ipc/title.ts` |
| `maker:auxiliary-model-settings:get` | invoke | A（供应商与模型） | 1 | `maker-ipc/auxiliary-model-settings.ts` |
| `maker:auxiliary-model-settings:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/auxiliary-model-settings.ts` |
| `maker:background-task:output-tail` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:bot-delegation:cancel` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-delegations:list` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-direct-message-thread:get` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:continue` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:create` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:delete` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:get` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:list` | invoke | A（伙伴与 IM） | 13 | `maker-ipc/register.ts` |
| `maker:bot-group:outbox` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:outbox-command` | invoke | A（伙伴与 IM） | 51 | `maker-ipc/register.ts` |
| `maker:bot-group:plan-continue` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:plan-dismiss` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:plan-edit` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:plan-retry` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:plan-start` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:send` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:set-members` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:stop` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-group:update` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:bot-lifecycle:action` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/botLifecycleService.ts` |
| `maker:bot-read-state` | invoke | A（伙伴与 IM） | 4 | `maker-ipc/register.ts` |
| `maker:browser:open-for-login` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts` |
| `maker:browser:status` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 1 | `maker-ipc/register.ts` |
| `maker:chat-server:acceptInvite` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:createInvite` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:followThread` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:manage` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:mask` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:mentions` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:ownedBots` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:previewInvite` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:react` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:reactors` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:readers` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:refreshProfile` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:reply` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:revokeInvite` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:shareToMain` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:status` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat-server:thread` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:chat:display-cache` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 2 | `maker-ipc/register.ts` |
| `maker:close-session` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:collaboration-settings:get` | invoke | A（设置与偏好） | 2 | `maker-ipc/register.ts` |
| `maker:collaboration-settings:reset` | invoke | A（设置与偏好） | 0 | `maker-ipc/register.ts` |
| `maker:collaboration-settings:set` | invoke | A（设置与偏好） | 0 | `maker-ipc/register.ts` |
| `maker:compact-session` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:companion-avatar:resolve` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:attachment` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:caps` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:cindy-copies` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:dismiss-notices` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:flush` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:hand-over` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:home-choices` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:merge` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:merge-cindy` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:state` | invoke | A（伙伴与 IM） | 1 | `maker-ipc/register.ts` |
| `maker:companion-cloud:switch-home` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:take-over` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:targets` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-cloud:transcript` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:companion-live:read` | invoke | A（伙伴与 IM） | 0 | `maker-ipc/register.ts` |
| `maker:computer:cancel-permission-grant` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts` |
| `maker:computer:check-update` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 1 | `maker-ipc/register.ts` |
| `maker:computer:driver-icon` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts` |
| `maker:computer:grant-permissions` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts` |
| `maker:computer:install-driver` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts` |
| `maker:computer:permission-app-drag-end` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts` |
| `maker:computer:permission-app-drag-start` | event | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts` |
| `maker:computer:permission-guide-status` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts` |
| `maker:computer:status` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 1 | `maker-ipc/register.ts` |
| `maker:computer:update-driver` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `maker-ipc/register.ts` |
| `maker:create-session` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/sessionCreateHandler.ts` |
| `maker:execute-desktop-command` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:export-session-html` | invoke | C-两段式（窗口做界面动作，数据调 Host）（任务、消息与输入队列，但处理函数用到窗口 API：BrowserWindow.fromWebContents、BrowserWindow.getFocusedWindow、dialog、shell；窗口做界面动作，数据那一半调 Host） | 0 | `maker-ipc/register.ts` |
| `maker:fork` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/fork.ts` |
| `maker:fork-strip-encrypted` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/fork.ts` |
| `maker:generate-title` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/title.ts` |
| `maker:get-capabilities` | invoke | contract | 15 | `maker-ipc/register.ts` |
| `maker:get-context-usage` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:get-context-window-bounds` | invoke | A（任务、消息与输入队列） | 16 | `maker-ipc/register.ts` |
| `maker:get-new-maker-defaults` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:get-new-maker-worktree-branch-pref` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/newMakerWorktreeBranchPreferenceHandler.ts` |
| `maker:get-pending-interactions` | invoke | contract | 30 | `maker-ipc/register.ts` |
| `maker:get-plugin-write-access-recovery` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:get-session-agent-switch-intent` | invoke | A（任务、消息与输入队列） | 16 | `maker-ipc/sessionAgentSwitchHandler.ts` |
| `maker:get-session-tree` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:get-workflow-progress` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:goal:clear` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/goal.ts` |
| `maker:goal:get-status` | invoke | A（任务、消息与输入队列） | 15 | `maker-ipc/goal.ts` |
| `maker:goal:pause` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/goal.ts` |
| `maker:goal:resume` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/goal.ts` |
| `maker:goal:set` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/goal.ts` |
| `maker:goal:update` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/goal.ts` |
| `maker:help:ask` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/help.ts` |
| `maker:help:feedback:create` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/help-feedback.ts` |
| `maker:images:retry` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:input:cancel-usage-limit-wait` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:input:clear-error` | invoke | contract | 0 | `maker-ipc/register.ts` |
| `maker:input:clear-session` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:input:compact` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:input:enqueue` | invoke | contract | 1 | `maker-ipc/register.ts` |
| `maker:input:get-projection` | invoke | contract | 15 | `maker-ipc/register.ts` |
| `maker:input:move` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:input:remove` | invoke | contract | 0 | `maker-ipc/register.ts` |
| `maker:input:resume` | invoke | contract | 0 | `maker-ipc/register.ts` |
| `maker:input:retry-last-error` | invoke | contract | 0 | `maker-ipc/register.ts` |
| `maker:input:session-reference-capability` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:input:set-edit-lock` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:input:set-expanded` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:input:set-interaction-lock` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:input:steer` | invoke | contract | 0 | `maker-ipc/register.ts` |
| `maker:input:stop` | invoke | contract | 0 | `maker-ipc/register.ts` |
| `maker:input:update-content` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:input:update-text` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:issues:list-mine` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `maker-ipc/my-issues.ts` |
| `maker:issues:snapshot-mine` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `maker-ipc/my-issues.ts` |
| `maker:list-active` | invoke | contract | 1 | `maker-ipc/register.ts` |
| `maker:list-agent-commands` | invoke | contract | 47 | `maker-ipc/register.ts` |
| `maker:list-agent-skills` | invoke | contract | 32 | `maker-ipc/register.ts` |
| `maker:list-available-agents` | invoke | contract | 11 | `maker-ipc/register.ts` |
| `maker:list-customizations` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:list-desktop-commands` | invoke | A（任务、消息与输入队列） | 47 | `maker-ipc/register.ts` |
| `maker:machine:status` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:maker-memory:reset` | invoke | A（记忆、学习与钩子） | 0 | `maker-ipc/register.ts` |
| `maker:maker-memory:set-enabled` | invoke | A（记忆、学习与钩子） | 0 | `maker-ipc/register.ts` |
| `maker:mark-orca-role` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:mcp:custom:create` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/mcpHandlers.ts` |
| `maker:mcp:custom:delete` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/mcpHandlers.ts` |
| `maker:mcp:custom:list` | invoke | A（插件、技能与 MCP） | 1 | `maker-ipc/mcpHandlers.ts` |
| `maker:mcp:custom:refresh` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/mcpHandlers.ts` |
| `maker:mcp:custom:update` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/mcpHandlers.ts` |
| `maker:mcp:duplicates:choose` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `maker-ipc/mcpHandlers.ts` |
| `maker:mcp:duplicates:list` | invoke | A（插件、技能与 MCP） | 1 | `maker-ipc/mcpHandlers.ts` |
| `maker:memory:get` | invoke | A（记忆、学习与钩子） | 3 | `maker-ipc/register.ts` |
| `maker:memory:reset` | invoke | A（记忆、学习与钩子） | 0 | `maker-ipc/register.ts` |
| `maker:memory:reset-settings` | invoke | A（记忆、学习与钩子） | 0 | `maker-ipc/register.ts` |
| `maker:memory:set` | invoke | A（记忆、学习与钩子） | 0 | `maker-ipc/register.ts` |
| `maker:message:delete` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/messageDeleteHandler.ts` |
| `maker:model-catalog:read` | invoke | A（供应商与模型） | 0 | `maker-ipc/register.ts` |
| `maker:model-compaction:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:model-context-limit:get` | invoke | A（供应商与模型） | 20 | `maker-ipc/providerHandlers.ts` |
| `maker:model-context-limit:reset` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:model-context-limit:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:model-disable:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:model-favorites:apply` | invoke | A（供应商与模型） | 0 | `maker-ipc/modelFavoritesSync.ts` |
| `maker:model-favorites:get` | invoke | A（供应商与模型） | 0 | `maker-ipc/modelFavoritesSync.ts` |
| `maker:model-image-input:get` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:model-image-input:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:model-price-override:get` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:model-price-override:reset` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:model-price-override:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:model-visibility:sync` | invoke | A（供应商与模型） | 7 | `maker-ipc/register.ts` |
| `maker:navigate-session-tree` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:orca:execution-devices` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:orca:remote-worker:bridge` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:orca:remote-worker:caps` | invoke | A（Orca） | 0 | `maker-ipc/orcaRemoteWorkerHost.ts` |
| `maker:orca:remote-worker:models` | invoke | A（Orca） | 0 | `maker-ipc/orcaRemoteWorkerHost.ts` |
| `maker:orca:remote-worker:open` | invoke | A（Orca） | 0 | `maker-ipc/orcaRemoteWorkerHost.ts` |
| `maker:orca:remote-worker:release` | invoke | A（Orca） | 0 | `maker-ipc/orcaRemoteWorkerHost.ts` |
| `maker:persist-turn-error-deferred` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:pi-packages:list` | invoke | A（插件、技能与 MCP） | 1 | `maker-ipc/register.ts` |
| `maker:pi-packages:mutate` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts` |
| `maker:pi-subagent:control` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:plugin-setup:submit-inline` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts` |
| `maker:plugins:clear-enabled` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts` |
| `maker:plugins:clear-project-enabled` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/projectPluginPolicyHandlers.ts` |
| `maker:plugins:get-state` | invoke | A（插件、技能与 MCP） | 21 | `maker-ipc/register.ts` |
| `maker:plugins:list` | invoke | A（插件、技能与 MCP） | 1 | `maker-ipc/pluginListHandler.ts` |
| `maker:plugins:set-enabled` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts` |
| `maker:plugins:set-project-enabled` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/projectPluginPolicyHandlers.ts` |
| `maker:predict-prompt` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/title.ts` |
| `maker:project-automation:list-consents` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/project-automation.ts` |
| `maker:project-automation:pending-imports` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `maker-ipc/project-automation.ts` |
| `maker:project-automation:reconcile` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/project-automation.ts` |
| `maker:project-automation:remove-schedule` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/project-automation.ts` |
| `maker:project-automation:revoke-consent` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/project-automation.ts` |
| `maker:project-automation:upsert-schedule` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/project-automation.ts` |
| `maker:provider:account-usage` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:custom:create` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:custom:delete` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:custom:disconnect` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:custom:update` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:detect` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:import:cancel` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:import:confirm` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:import:file` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:import:local-edit` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:import:local-scan` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:import:preview` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:list` | invoke | contract | 24 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:local-cli-scan` | invoke | A（供应商与模型） | 1 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:models-auto-refresh` | invoke | A（供应商与模型） | 1 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:models-fetch` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:models-rediscover` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:models-refresh` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:oauth:cancel` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:oauth:login` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:oauth:logout` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:order:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:presentation:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:presets` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:remote-access:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:run-location:set` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:provider:test-connection` | invoke | A（供应商与模型） | 0 | `maker-ipc/providerHandlers.ts` |
| `maker:regenerate-title` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/title.ts` |
| `maker:resolve-interaction` | invoke | contract | 0 | `maker-ipc/register.ts` |
| `maker:retry-plugin-write-access` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:review:start` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/reviewStartHandler.ts` |
| `maker:rewind:commit` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/rewind.ts` |
| `maker:rewind:preview` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/rewind.ts` |
| `maker:run` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:runtime-plugins` | invoke | A（插件、技能与 MCP） | 0 | `maker-ipc/register.ts` |
| `maker:scan-at-resources` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:schedule:create` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:create-from-template` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:delete` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:delete-run` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:generate-pre-run-hook` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:get` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:get-inflight-count` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:get-runtime-state` | invoke | A（自动化） | 1 | `maker-ipc/schedule.ts` |
| `maker:schedule:get-unread-count` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:list` | invoke | A（自动化） | 1 | `maker-ipc/schedule.ts` |
| `maker:schedule:list-cost-summaries` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:list-runs` | invoke | A（自动化） | 1 | `maker-ipc/schedule.ts` |
| `maker:schedule:list-sidebar-index-runs` | invoke | A（自动化） | 2 | `maker-ipc/schedule.ts` |
| `maker:schedule:list-templates` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:mark-all-runs-read` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:mark-run-read` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:mark-schedule-runs-read` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:pause` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:resume` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:run-now` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:script-capability-status` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:test-pre-run-hook` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:update` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:webhook-account` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:webhook-receiver` | invoke | A（自动化） | 1 | `maker-ipc/schedule.ts` |
| `maker:schedule:webhook-release` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:webhook-restore` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:webhook-rotate-url` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:webhook-set-secret` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:schedule:webhook-status` | invoke | A（自动化） | 0 | `maker-ipc/schedule.ts` |
| `maker:send` | invoke | contract | 0 | `maker-ipc/sessionSendHandler.ts` |
| `maker:session-background-activity` | invoke | A（任务、消息与输入队列） | 15 | `maker-ipc/register.ts` |
| `maker:session-background-activity:list` | invoke | A（任务、消息与输入队列） | 1 | `maker-ipc/register.ts` |
| `maker:session-background-tasks:list` | invoke | A（任务、消息与输入队列） | 28 | `maker-ipc/register.ts` |
| `maker:session-background-tasks:stop` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/stopSessionBackgroundTasksHandler.ts` |
| `maker:session-background-work:list` | invoke | A（任务、消息与输入队列） | 1 | `maker-ipc/register.ts` |
| `maker:session-in-turn` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:session:commit-provisional` | invoke | A（任务、消息与输入队列） | 1 | `maker-ipc/register.ts` |
| `maker:session:disable-orca` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:session:discard-provisional` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:session:enable-orca` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:session:handoff` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/sessionHandoffIpc.ts` |
| `maker:session:prewarm` | invoke | A（任务、消息与输入队列） | 1 | `maker-ipc/register.ts` |
| `maker:session:turn-active` | invoke | A（任务、消息与输入队列） | 2 | `maker-ipc/register.ts` |
| `maker:set-context-window-budget` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:set-effort` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:set-extra-dirs` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:set-fast-mode` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:set-model` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/sessionSetModelHandler.ts` |
| `maker:set-permission-mode` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:set-plan-mode` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:set-session-model-pref` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:set-thinking-enabled` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:set-writable-dirs` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:side-chat:list:v1` | invoke | A（任务、消息与输入队列） | 16 | `maker-ipc/fork.ts` |
| `maker:side-chat:v1` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/fork.ts` |
| `maker:steer` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:switch-session-agent` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/sessionAgentSwitchHandler.ts` |
| `maker:sync-new-maker-draft` | event | A（未登记前缀，处理函数没有用到窗口 API） | 4 | `maker-ipc/register.ts` |
| `maker:sync-provider-model-memory` | event | A（供应商与模型） | 1 | `maker-ipc/register.ts` |
| `maker:sync-session-model-pref` | event | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `maker-ipc/register.ts` |
| `maker:sync-worker-creation-prefs` | event | A（Orca） | 5 | `maker-ipc/register.ts` |
| `maker:team:end` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:turn-change-set:apply` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:turn-change-sets:get` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/register.ts` |
| `maker:turn-change-sets:list` | invoke | contract | 15 | `maker-ipc/register.ts` |
| `maker:usage:account` | invoke | A（供应商与模型） | 7 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:claude-subscription` | invoke | A（供应商与模型） | 6 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:codex-rate-limit-reset` | invoke | A（供应商与模型） | 0 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:codex-rate-limits` | invoke | A（供应商与模型） | 6 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:codex-reset-auto-use` | invoke | A（供应商与模型） | 0 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:device-rows` | invoke | A（供应商与模型） | 0 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:history` | invoke | A（供应商与模型） | 1 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:model-pricing` | invoke | contract | 0 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:model-pricing-v2` | invoke | contract | 1 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:reference-model-pricing` | invoke | contract | 1 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:today` | invoke | A（供应商与模型） | 0 | `maker-ipc/usageHandlers.ts` |
| `maker:usage:xai-subscription` | invoke | A（供应商与模型） | 0 | `maker-ipc/usageHandlers.ts` |
| `maker:worker-roles:apply` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:worker-roles:get` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:worker:acknowledge-done` | invoke | A（Orca） | 0 | `maker-ipc/orcaWorkerControlHandlers.ts` |
| `maker:worker:archive` | invoke | A（Orca） | 0 | `maker-ipc/orcaWorkerControlHandlers.ts` |
| `maker:worker:create` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:worker:dispatch-ui-assignment` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:worker:idle` | invoke | A（Orca） | 0 | `maker-ipc/orcaWorkerControlHandlers.ts` |
| `maker:worker:list` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:worker:project-context` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:worker:project-label` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:worker:switch-focus` | invoke | A（Orca） | 0 | `maker-ipc/register.ts` |
| `maker:worker:update` | invoke | A（Orca） | 0 | `maker-ipc/orcaWorkerControlHandlers.ts` |
| `maker:working-status` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/workingStatus.ts` |
| `maker:write-plan-file` | invoke | A（任务、消息与输入队列） | 0 | `maker-ipc/plan-write.ts` |
| `model-favorites:host-changed` | event | R（主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期） | 0 | `maker-ipc/modelFavoritesSync.ts` |
| `model-favorites:host-ready` | event | R（主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期） | 1 | `maker-ipc/modelFavoritesSync.ts` |
| `model-favorites:host-reply` | event | R（主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期） | 0 | `maker-ipc/modelFavoritesSync.ts` |
| `terminal:create` | invoke | C-后台（终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次）） | 0 | `maker-ipc/terminal-handlers.ts` |
| `terminal:dispose` | invoke | C-后台（终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次）） | 0 | `maker-ipc/terminal-handlers.ts` |
| `terminal:get-default-shell-pref` | invoke | C-后台（终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次）） | 1 | `maker-ipc/terminal-handlers.ts` |
| `terminal:list-available-shells` | invoke | C-后台（终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次）） | 1 | `maker-ipc/terminal-handlers.ts` |
| `terminal:resize` | invoke | C-后台（终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次）） | 0 | `maker-ipc/terminal-handlers.ts` |
| `terminal:restart` | invoke | C-后台（终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次）） | 0 | `maker-ipc/terminal-handlers.ts` |
| `terminal:set-default-shell-pref` | invoke | C-后台（终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次）） | 0 | `maker-ipc/terminal-handlers.ts` |
| `terminal:write` | invoke | C-后台（终端 PTY：换窗口时不能断，网页和手机也要用（优先级低，放后面批次）） | 0 | `maker-ipc/terminal-handlers.ts` |
| `worktree:cancel-precreated` | invoke | A（git 与工作树） | 0 | `maker-ipc/precreatedWorktreeDiscardHandler.ts` |
| `worktree:discard-precreated` | invoke | A（git 与工作树） | 0 | `maker-ipc/precreatedWorktreeDiscardHandler.ts` |

### mcp-apps

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `maker:mcp-apps:v1` | invoke | C-两段式（窗口做界面动作，数据调 Host）（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、shell；窗口做界面动作，数据那一半调 Host） | 0 | `mcp-apps/ipc.ts` |

### mcp-integrations

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `browser-backend:get-health` | invoke | contract | 1 | `mcp-integrations/browser.desktop.ts` |
| `browser-backend:get-state` | invoke | contract | 1 | `mcp-integrations/browser.desktop.ts` |
| `browser-backend:open-extension-store` | invoke | contract | 0 | `mcp-integrations/browser.desktop.ts` |
| `browser-backend:probe-source-read` | invoke | contract | 0 | `mcp-integrations/browser.desktop.ts` |
| `browser-backend:recover` | invoke | contract | 0 | `mcp-integrations/browser.desktop.ts` |
| `browser-backend:reset` | invoke | contract | 0 | `mcp-integrations/browser.desktop.ts` |
| `browser-backend:set-kind` | invoke | contract | 0 | `mcp-integrations/browser.desktop.ts` |
| `browser-backend:set-use-real-profile` | invoke | contract | 0 | `mcp-integrations/browser.desktop.ts` |
| `rsb-browser-bridge:set-active-session` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `mcp-integrations/browser.desktop.ts` |

### menubar

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `menubar:get-state` | invoke | B（窗口外壳、窗口布局与多窗口） | 2 | `menubar/ipc.ts` |
| `menubar:set-enabled` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `menubar/ipc.ts` |

### model-access

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `model-access:get-status` | invoke | contract | 10 | `model-access/index.ts` |
| `model-access:retry` | invoke | contract | 0 | `model-access/index.ts` |
| `model-access:rotate` | invoke | A（供应商与模型） | 0 | `model-access/index.ts` |

### notificationService

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `notification:set-desktop-enabled` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 1 | `notificationService.ts` |
| `notification:show-session-event` | invoke | B（原生对话框、剪贴板、系统外壳与通知） | 0 | `notificationService.ts` |

### performance-trace

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `performance-trace:command` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `performance-trace/index.ts` |
| `performance-trace:events` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `performance-trace/index.ts` |

### plugin-contributions

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `plugin-contributions:cancel` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:cancel-review` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:detail` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:discard` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:list` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:mark-review-read` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:prepare` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:releases` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:review-updates` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:set-anonymity` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:status` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:submission` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |
| `plugin-contributions:submit` | invoke | A（插件、技能与 MCP） | 0 | `plugin-contributions/registerIpc.ts` |

### plugin-market

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `plugin-market:add-source` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:consume-removal-notice` | invoke | A（插件、技能与 MCP） | 1 | `plugin-market/registerIpc.ts` |
| `plugin-market:detail` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:git-preflight` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:install` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:install-local-share` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:list-sources` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:local-icons` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:local-share-detail` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:lookup` | invoke | A（插件、技能与 MCP） | 1 | `plugin-market/registerIpc.ts` |
| `plugin-market:pick-local-source` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:prepare-local-share` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:prepare-share` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:query` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:recommendations` | invoke | A（插件、技能与 MCP） | 2 | `plugin-market/registerIpc.ts` |
| `plugin-market:refresh-source` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:release-local-share` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:remove-source` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |
| `plugin-market:snapshot` | invoke | A（插件、技能与 MCP） | 4 | `plugin-market/registerIpc.ts` |
| `plugin-market:uninstall` | invoke | A（插件、技能与 MCP） | 0 | `plugin-market/registerIpc.ts` |

### plugin-publisher

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `plugin-publisher:cancel` | invoke | A（插件、技能与 MCP） | 0 | `plugin-publisher/registerIpc.ts` |
| `plugin-publisher:list-mine` | invoke | A（插件、技能与 MCP） | 0 | `plugin-publisher/registerIpc.ts` |
| `plugin-publisher:resolve-confirm` | invoke | A（插件、技能与 MCP） | 0 | `plugin-publisher/registerIpc.ts` |
| `plugin-publisher:start` | invoke | A（插件、技能与 MCP） | 0 | `plugin-publisher/registerIpc.ts` |
| `plugin-publisher:status` | invoke | A（插件、技能与 MCP） | 0 | `plugin-publisher/registerIpc.ts` |

### process-monitor

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `process-monitor:subscribe` | invoke | C-窗口本地（用户在本窗口选择或拖入的本机文件、本机进程监视：窗口直接处理，客户端模式下照常注册） | 1 | `process-monitor/ipc.ts` |
| `process-monitor:terminate-agent` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `process-monitor/ipc.ts` |
| `process-monitor:unsubscribe` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 1 | `process-monitor/ipc.ts` |

### projectOrderStore

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `sidebar-settings:apply-project-order` | invoke | W（窗口本地设置：窗口直接读写同一份 profile 文件，不经 Host） | 0 | `projectOrderStore.ts` |
| `sidebar-settings:get-project-order` | invoke | W（窗口本地设置：窗口直接读写同一份 profile 文件，不经 Host） | 8 | `projectOrderStore.ts` |

### provider-group

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `provider-group:command` | invoke | A（供应商与模型） | 16 | `provider-group/ipc.ts` |

### region-screenshot

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `recording-audio:data` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingAudio.ts` |
| `recording-audio:register` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingAudio.ts` |
| `recording-audio:state` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingAudio.ts` |
| `recording-preview:close` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts` |
| `recording-preview:copy` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts` |
| `recording-preview:failed` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts` |
| `recording-preview:minimize` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts` |
| `recording-preview:painted` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts` |
| `recording-preview:ready` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts` |
| `recording-preview:save` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/recordingPreview.ts` |
| `region-screenshot-editor:cancel` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts` |
| `region-screenshot-editor:export` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts` |
| `region-screenshot-editor:failed` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts` |
| `region-screenshot-editor:minimize` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts` |
| `region-screenshot-editor:painted` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts` |
| `region-screenshot-editor:ready` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts` |
| `region-screenshot-editor:set-translation-language` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/editor.ts` |
| `region-screenshot-pin:command` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts` |
| `region-screenshot-pin:drag-move` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts` |
| `region-screenshot-pin:drag-start` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts` |
| `region-screenshot-pin:menu` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts` |
| `region-screenshot-pin:opacity` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts` |
| `region-screenshot-pin:painted` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts` |
| `region-screenshot-pin:shell-ready` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts` |
| `region-screenshot-pin:unlock-hover` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts` |
| `region-screenshot-pin:zoom` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/pins.ts` |
| `region-screenshot:abandon` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:audio-read` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:audio-start` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:audio-stop` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:auto-scroll` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:cancel` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:compose-take` | invoke | B（本机屏幕截取、录制与远程桌面） | 1 | `region-screenshot/compose.ts` |
| `region-screenshot:copy-text` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:elements-at` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:export` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:focused` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:live-edit` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:live-frame` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:live-hold` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:live-save` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:live-start` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:painted` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:recording-controls` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:recording-preview` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:selection-start` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:set-translation-language` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |
| `region-screenshot:shell-ready` | event | B（本机屏幕截取、录制与远程桌面） | 0 | `region-screenshot/index.ts` |

### relaunchBusyActivityIpc

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `update-relaunch:blocking-activity` | invoke | A（升级与交接（归交接任务：它留在原工作区的升级流程）） | 0 | `relaunchBusyActivityIpc.ts` |
| `update-relaunch:blocking-summary` | invoke | A（升级与交接（归交接任务：它留在原工作区的升级流程）） | 0 | `relaunchBusyActivityIpc.ts` |

### remote-desktop

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `away-guard:get-state` | invoke | B（本机屏幕截取、录制与远程桌面） | 2 | `remote-desktop/awayGuardService.ts` |
| `away-guard:preview` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/awayGuardService.ts` |
| `away-guard:set-delay` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/awayGuardService.ts` |
| `away-guard:set-enabled` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/awayGuardService.ts` |
| `remote-desktop:capture-stop` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:channel-request` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:dismiss-permission-guide` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:enable` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:host-input` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:host-reply` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:live-screen-frames` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:native-audio` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:native-frame` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:open-permission` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:permissions` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:register-host` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:state` | invoke | B（本机屏幕截取、录制与远程桌面） | 246 | `remote-desktop/index.ts` |
| `remote-desktop:stop` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:view-heartbeat` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |
| `remote-desktop:windows-support` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop/index.ts` |

### remote-desktop-viewer

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `remote-desktop-viewer:channel-reply` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:clipboard` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:clipboard-sync` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:close` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:credential` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:fullscreen` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:ice` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:input-focus` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:open` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:preferences` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:presented` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:ready` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:request` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:resize` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:resolution` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:safety` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |
| `remote-desktop-viewer:state` | invoke | B（本机屏幕截取、录制与远程桌面） | 0 | `remote-desktop-viewer/windows.ts` |

### remote-ssh

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `maker:remote-ssh:add` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:add-key-to-agent` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:build-install-cmd` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:build-install-cmd-inline` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:cc-mgr-dismiss-pending-upgrade` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:cc-mgr-force-upgrade` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:cc-mgr-list-pending-upgrades` | invoke | A（设备互联与远程执行） | 1 | `remote-ssh/index.ts` |
| `maker:remote-ssh:check-codex-auth` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:connect` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:disconnect` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:generate-key` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:has-any-auto-connect-host` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:install-agent` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:list` | invoke | A（设备互联与远程执行） | 7 | `remote-ssh/index.ts` |
| `maker:remote-ssh:list-codex-models` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:list-local-keys` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:list-remote-dir` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:mkdir-p-remote` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:probe-agent` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:read-pubkey` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:reload-config` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:remove` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:review-host-key` | invoke | C-两段式（窗口做界面动作，数据调 Host）（设备互联与远程执行，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog；窗口做界面动作，数据那一半调 Host） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:run-agent-one-shot` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:set-auto-connect` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:stat-remote-path` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:sync-codex-auth` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:uninstall-agent` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |
| `maker:remote-ssh:update` | invoke | A（设备互联与远程执行） | 0 | `remote-ssh/index.ts` |

### remotePrecreatedWorktreeLedger

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `remote-precreated-worktree-ledger:forget` | invoke | A（git 与工作树） | 0 | `remotePrecreatedWorktreeLedger.ts` |
| `remote-precreated-worktree-ledger:list` | invoke | A（git 与工作树） | 0 | `remotePrecreatedWorktreeLedger.ts` |
| `remote-precreated-worktree-ledger:register` | invoke | A（git 与工作树） | 0 | `remotePrecreatedWorktreeLedger.ts` |

### resource-usage-window

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `resource-usage-window:close` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `resource-usage-window/ipc.ts` |
| `resource-usage-window:open` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `resource-usage-window/ipc.ts` |
| `resource-usage-window:presentation-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `resource-usage-window/ipc.ts` |
| `resource-usage-window:renderer-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `resource-usage-window/ipc.ts` |

### right-sidebar-window

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `maker:rsb-window:close` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts` |
| `maker:rsb-window:get-context` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts` |
| `maker:rsb-window:get-state` | invoke | B（窗口外壳、窗口布局与多窗口） | 46 | `right-sidebar-window/ipc.ts` |
| `maker:rsb-window:open` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts` |
| `maker:rsb-window:ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts` |
| `maker:rsb-window:send-command` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts` |
| `maker:rsb-window:set-context` | event | B（窗口外壳、窗口布局与多窗口） | 18 | `right-sidebar-window/ipc.ts` |
| `maker:rsb-window:set-detached` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts` |
| `rsb-window:presentation-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts` |
| `rsb-window:refresh-context` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts` |
| `rsb-window:renderer-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `right-sidebar-window/ipc.ts` |

### rsb-browser-bridge

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `rsb-browser-bridge:capture-screenshot` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts` |
| `rsb-browser-bridge:capture-screenshot-data` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts` |
| `rsb-browser-bridge:force-kill` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts` |
| `rsb-browser-bridge:release` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts` |
| `rsb-browser-bridge:report` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts` |
| `rsb-browser-bridge:set-foreground` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/ipc.ts` |
| `rsb-browser-bridge:snapshot` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 1 | `rsb-browser-bridge/ipc.ts` |
| `rsb-browser-bridge:tab-op-result` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/renderer-bridge.ts` |
| `rsb-native-popup:claim` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/native-popup-surfaces.ts` |
| `rsb-native-popup:close` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/native-popup-surfaces.ts` |
| `rsb-native-popup:command` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/native-popup-surfaces.ts` |
| `rsb-native-popup:set-bounds` | invoke | B（图形能力，由窗口替 Agent 执行（平台 RPC）） | 0 | `rsb-browser-bridge/native-popup-surfaces.ts` |

### session-import

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `local-db:session-import:cancel` | invoke | A（任务、消息与输入队列） | 0 | `session-import/ipc.ts` |
| `local-db:session-import:relocate` | invoke | A（任务、消息与输入队列） | 0 | `session-import/ipc.ts` |
| `local-db:session-import:scan` | invoke | A（任务、消息与输入队列） | 1 | `session-import/ipc.ts` |
| `local-db:session-import:start` | invoke | A（任务、消息与输入队列） | 0 | `session-import/ipc.ts` |
| `local-db:session-import:status` | invoke | A（任务、消息与输入队列） | 1 | `session-import/ipc.ts` |

### setup-migration

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `setup-migration:apply` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `setup-migration/register.ts` |
| `setup-migration:dismiss` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `setup-migration/register.ts` |
| `setup-migration:first-run-guide` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `setup-migration/register.ts` |
| `setup-migration:host-ready` | event | R（主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期） | 1 | `setup-migration/rendererPrefsHost.ts` |
| `setup-migration:host-reply` | event | R（主进程向界面要数据的回执协议：数据在界面本地存储，Host 要用需经窗口往返，先不排期） | 0 | `setup-migration/rendererPrefsHost.ts` |
| `setup-migration:preview` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `setup-migration/register.ts` |
| `setup-migration:sources` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `setup-migration/register.ts` |
| `setup-migration:state` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 2 | `setup-migration/register.ts` |

### sidebar-tab-window

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `maker:sidebar-tab-window:close-for-tab` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts` |
| `maker:sidebar-tab-window:focus` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts` |
| `maker:sidebar-tab-window:get-state` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `sidebar-tab-window/ipc.ts` |
| `maker:sidebar-tab-window:open` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts` |
| `maker:sidebar-tab-window:return-tab` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts` |
| `sidebar-tab-window:adopt-tab` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts` |
| `sidebar-tab-window:get-assignment` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `sidebar-tab-window/ipc.ts` |
| `sidebar-tab-window:merge-back` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts` |
| `sidebar-tab-window:presentation-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebar-tab-window/ipc.ts` |
| `sidebar-tab-window:renderer-ready` | invoke | B（窗口外壳、窗口布局与多窗口） | 1 | `sidebar-tab-window/ipc.ts` |

### sidebarSettingsStore

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `sidebar-settings:claim-renderer-legacy-owner-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示）（同步通道·界面设置：窗口本地读同一份 profile 文件） | 8 | `sidebarSettingsStore.ts` |
| `sidebar-settings:load-snapshot-sync` | event | 同步·本地（窗口读 profile：界面设置与首帧提示）（同步通道·界面设置：窗口本地读同一份 profile 文件） | 21 | `sidebarSettingsStore.ts` |
| `sidebar-settings:save-pinned-order` | invoke | W（窗口本地设置：窗口直接读写同一份 profile 文件，不经 Host） | 0 | `sidebarSettingsStore.ts` |
| `sidebar-settings:set-main-view-hidden` | invoke | W（窗口本地设置：窗口直接读写同一份 profile 文件，不经 Host） | 0 | `sidebarSettingsStore.ts` |
| `sidebar-settings:set-project-hidden` | invoke | W（窗口本地设置：窗口直接读写同一份 profile 文件，不经 Host） | 0 | `sidebarSettingsStore.ts` |

### sidebarWindowExpansionIpc

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `window-sidebar-expansion` | invoke | B（窗口外壳、窗口布局与多窗口） | 0 | `sidebarWindowExpansionIpc.ts` |

### skillhub

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `skillhub:cancel-install` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:cancel-publish` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:compare-published` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:delete-published` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:get-folder-hash` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:get-my-depts` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:get-published-files` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:get-published-visibility` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:get-scan-status` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:get-snapshot-diff` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:get-usage-diagnosis-context` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:get-usage-summary` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:has-snapshot` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:import-local` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:info` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:install` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:list-categories` | invoke | A（插件、技能与 MCP） | 1 | `skillhub/registerIpc.ts` |
| `skillhub:list-children` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:list-market` | invoke | A（插件、技能与 MCP） | 1 | `skillhub/registerIpc.ts` |
| `skillhub:list-published-versions` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:list-user-teams` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:pick-local` | invoke | C-两段式（窗口做界面动作，数据调 Host）（弹出系统选择框后写入后台数据：选择在窗口，结果归后台） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:publish` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:read-published-file` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:read-raw` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:read-sibling-file` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:read-skill` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:reconcile-mine-registry` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:registry:get-by-name` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:rename-local` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:retry-uninstall-cleanup` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:scan` | invoke | A（插件、技能与 MCP） | 2 | `skillhub/registerIpc.ts` |
| `skillhub:set-enabled` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:set-published-visibility` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:start-scan-poll` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:stop-scan-poll` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:sync` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:uninstall` | invoke | C-两段式（窗口做界面动作，数据调 Host）（插件、技能与 MCP，但处理函数用到窗口 API：BrowserWindow.fromWebContents、dialog、shell；窗口做界面动作，数据那一半调 Host） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:unpublish-published` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:update-published` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:validate-frontmatter` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |
| `skillhub:write-file` | invoke | A（插件、技能与 MCP） | 0 | `skillhub/registerIpc.ts` |

### subscription-accounts

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `maker:subscription-accounts` | invoke | A（账号与凭据） | 8 | `subscription-accounts/ipc.ts` |
| `maker:subscription-pool:quota` | invoke | A（账号与凭据） | 0 | `subscription-accounts/ipc.ts` |

### task-migration

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `task-copy:request` | invoke | A（未登记前缀，处理函数没有用到窗口 API） | 0 | `task-migration/service.ts` |

### updateService

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `update-auto-settings-get` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 1 | `updateService.ts` |
| `update-auto-settings-reset` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-auto-settings-set` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-channel-probe-beta` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-channel-relaunch` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-channel-settings-get` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 4 | `updateService.ts` |
| `update-channel-settings-reset` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-channel-settings-set` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-check-now` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-check-startup` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-get-status` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 9 | `updateService.ts` |
| `update-harness-prepare` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-harness-relaunch` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-move-to-applications` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-relaunch` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-relaunch-auto` | invoke | B（桌面安装包自身：更新、版本、日志与诊断） | 0 | `updateService.ts` |
| `update-set-relaunch-theme` | event | B（桌面安装包自身：更新、版本、日志与诊断） | 5 | `updateService.ts` |

### voice-conversation

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `voice-conversation:audio` | event | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:call-command` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:call-publish` | event | B（本机输入设备与语音） | 1 | `voice-conversation/index.ts` |
| `voice-conversation:call-status` | invoke | B（本机输入设备与语音） | 1 | `voice-conversation/index.ts` |
| `voice-conversation:classify-exit` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:end` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:finish-utterance` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:interrupt` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:models` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:preference` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:preview` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:promote-turn` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:read-preview` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:read-speech` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:set-input-muted` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:set-preference` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:speak` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:start` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:start-playback` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:stop-preview` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:submit-turn` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |
| `voice-conversation:voices` | invoke | B（本机输入设备与语音） | 0 | `voice-conversation/index.ts` |

### voice-input

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `voice-input:audio` | event | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:audio-drain` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:benchmark-fixture-audio` | invoke | B（本机输入设备与语音） | 1 | `voice-input/index.ts` |
| `voice-input:cancel` | invoke | B（本机输入设备与语音） | 5 | `voice-input/index.ts` |
| `voice-input:consume-shortcut-recovery-failure` | invoke | B（本机输入设备与语音） | 1 | `voice-input/global.ts` |
| `voice-input:data:get` | event | B（本机输入设备与语音） | 1 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:data:migrate-legacy` | event | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:dictionary-learning:advise` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:dictionary-learning:record-actions` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:dictionary-toast-close` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:dictionary-toast-show` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:dictionary:add-entry` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:dictionary:delete-entries` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:dictionary:edit-entry` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:dictionary:import-entries` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:dictionary:rename-entry` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:get-microphone-permission-cached` | event | B（本机输入设备与语音） | 1 | `voice-input/microphonePermissionIpc.ts` |
| `voice-input:get-readiness` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:get-readiness-cached` | event | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:get-system-permissions` | invoke | B（本机输入设备与语音） | 1 | `voice-input/index.ts` |
| `voice-input:get-system-permissions-cached` | event | B（本机输入设备与语音） | 1 | `voice-input/index.ts` |
| `voice-input:global-overlay-close` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:global-overlay-drag-end` | event | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:global-overlay-drag-move` | event | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:global-overlay-drag-start` | event | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:global-overlay-position-reset` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:global-overlay-ready` | event | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:global-overlay-show-passive` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:global-paste` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:global-restore-target-focus` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:global-shortcut-claim` | event | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:global-shortcut:set` | invoke | B（本机输入设备与语音） | 14 | `voice-input/global.ts` |
| `voice-input:history:delete` | event | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:history:get` | event | B（本机输入设备与语音） | 1 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:history:get-for-refinement` | event | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:history:record` | event | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:history:update` | event | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:model-selection:get` | invoke | B（本机输入设备与语音） | 2 | `voice-input/index.ts` |
| `voice-input:model-selection:reload` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:model-selection:set` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:modifier-shortcut-recording:start` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:modifier-shortcut-recording:stop` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:mute-system-audio` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:open-accessibility-settings` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:open-input-monitoring-settings` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:open-microphone-settings` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:open-settings` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:prewarm` | invoke | B（本机输入设备与语音） | 6 | `voice-input/index.ts` |
| `voice-input:request-input-monitoring-permission` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:request-microphone-permission` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:restore-system-audio` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:set-renderer-microphone-permission-verified` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:settings:update` | invoke | B（本机输入设备与语音） | 0 | `voice-input/VoiceInputDataStore.ts` |
| `voice-input:settings:update-shortcut` | invoke | B（本机输入设备与语音） | 0 | `voice-input/global.ts` |
| `voice-input:speaker:cancel-download` | invoke | B（本机输入设备与语音） | 0 | `voice-input/speaker/index.ts` |
| `voice-input:speaker:delete-profile` | invoke | B（本机输入设备与语音） | 0 | `voice-input/speaker/index.ts` |
| `voice-input:speaker:download-models` | invoke | B（本机输入设备与语音） | 0 | `voice-input/speaker/index.ts` |
| `voice-input:speaker:enroll` | invoke | B（本机输入设备与语音） | 0 | `voice-input/speaker/index.ts` |
| `voice-input:speaker:get-status` | invoke | B（本机输入设备与语音） | 2 | `voice-input/speaker/index.ts` |
| `voice-input:start` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:stop` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |
| `voice-input:test-connection` | invoke | B（本机输入设备与语音） | 0 | `voice-input/index.ts` |

### wecomGroupNotification

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `wecomGroupNotification:clear` | invoke | A（伙伴与 IM） | 0 | `wecomGroupNotification.ts` |
| `wecomGroupNotification:get-state` | invoke | A（伙伴与 IM） | 2 | `wecomGroupNotification.ts` |
| `wecomGroupNotification:save-and-test` | invoke | A（伙伴与 IM） | 0 | `wecomGroupNotification.ts` |
| `wecomGroupNotification:set-enabled` | invoke | A（伙伴与 IM） | 0 | `wecomGroupNotification.ts` |
| `wecomGroupNotification:test` | invoke | A（伙伴与 IM） | 0 | `wecomGroupNotification.ts` |

### worklouder-codex

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `codex-micro-guard:get-state` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts` |
| `codex-micro-guard:recover` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts` |
| `codex-micro-guard:set-enabled` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts` |
| `worklouder-codex:get-state` | invoke | B（本机输入设备与语音） | 2 | `worklouder-codex/index.ts` |
| `worklouder-codex:open-input-monitoring-settings` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts` |
| `worklouder-codex:probe` | invoke | B（本机输入设备与语音） | 2 | `worklouder-codex/index.ts` |
| `worklouder-codex:publish-tasks` | invoke | B（本机输入设备与语音） | 6 | `worklouder-codex/index.ts` |
| `worklouder-codex:reset-settings` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts` |
| `worklouder-codex:set-layout-preview` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts` |
| `worklouder-codex:set-settings` | invoke | B（本机输入设备与语音） | 0 | `worklouder-codex/index.ts` |

### worktree

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `worktree:branch-sync-status` | invoke | A（git 与工作树） | 0 | `worktree/index.ts` |
| `worktree:create` | invoke | A（git 与工作树） | 0 | `worktree/index.ts` |
| `worktree:detect-cwd` | invoke | A（git 与工作树） | 0 | `worktree/index.ts` |
| `worktree:get-for-session` | invoke | A（git 与工作树） | 2 | `worktree/index.ts` |
| `worktree:list-all` | invoke | A（git 与工作树） | 1 | `worktree/index.ts` |
| `worktree:list-branches` | invoke | A（git 与工作树） | 0 | `worktree/index.ts` |
| `worktree:removal-preview` | invoke | A（git 与工作树） | 0 | `worktree/index.ts` |
| `worktree:restore-for-session` | invoke | A（git 与工作树） | 0 | `worktree/index.ts` |
| `worktree:restore-status` | invoke | A（git 与工作树） | 15 | `worktree/index.ts` |
| `worktree:reveal` | invoke | C-两段式（窗口做界面动作，数据调 Host）（在访达／资源管理器或系统浏览器里打开后台持有的内容） | 0 | `worktree/index.ts` |
| `worktree:suggest-name` | invoke | A（git 与工作树） | 0 | `worktree/index.ts` |
| `worktree:sync-branch` | invoke | A（git 与工作树） | 0 | `worktree/index.ts` |

### xbox-gamepad

| 通道 | 类型 | 归属 | 调用次数 | 注册文件 |
|---|---|---|---:|---|
| `xbox-gamepad:get-state` | invoke | B（本机输入设备与语音） | 4 | `xbox-gamepad/index.ts` |
| `xbox-gamepad:probe` | invoke | B（本机输入设备与语音） | 4 | `xbox-gamepad/index.ts` |
| `xbox-gamepad:reset-settings` | invoke | B（本机输入设备与语音） | 0 | `xbox-gamepad/index.ts` |
| `xbox-gamepad:set-layout-preview` | invoke | B（本机输入设备与语音） | 0 | `xbox-gamepad/index.ts` |
| `xbox-gamepad:set-settings` | invoke | B（本机输入设备与语音） | 0 | `xbox-gamepad/index.ts` |
