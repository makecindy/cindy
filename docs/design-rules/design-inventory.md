# Cindy 生产 UI 台账

> 台账真相正本。登记事实（surface ID / 平台 / 标题 / 生产入口 / 路由覆盖）在 GENERATED 区块；人工决策（owner / 迁移状态 / protected / 目标道路 / 下一动作）在其后，按 surface ID 对齐。
> schema 见 [`design-governance.md`](./design-governance.md) §2.1。生成器只重写 GENERATED 区块。

重新生成：`pnpm design:inventory`。校验：`pnpm check:design-inventory`。统计报告（不入库）：`pnpm design:inventory:report`。
<!-- BEGIN GENERATED: surface-facts -->

本区块由 `scripts/design-inventory.mjs` 生成，请勿手改。
重新生成：`pnpm design:inventory`；校验：`pnpm check:design-inventory`。

可达组件、样式来源与 Token / 裸颜色 / 裸圆角统计不入库：需要时运行 `pnpm design:inventory:report`，输出到 `tmp/design-inventory-report.md`；要看某次提交时的数字，在该提交上重跑。

登记 surface 数：59。平台包含 Desktop 与 Mobile；静态入口发现不表示已迁移或已实机验证。

| ID | 平台 | 标题 | 生产入口 |
| --- | --- | --- | --- |
| `desktop.auth.add-account` | desktop | 添加账号 | hash `/add-account`（ProtectedRoute → AddAccountLoginPage） |
| `desktop.auth.legacy-migration` | desktop | 首登数据迁移弹窗 | App 顶层挂载 LegacyMigrationDialog（仅主窗；main 检测到旧版 userData 经 `legacy-migration:state` 驱动） |
| `desktop.auth.login` | desktop | 登录页 | hash `/login`（GuestRoute → LoginPage） |
| `desktop.bots` | desktop | 伙伴（列表 / 对话 / 设置 / 历史 / 伙伴私聊 / 群聊） | hash `/bots`、`/bots/list`、`/bots/:botId`、`/bots/roster` 及伙伴当前/历史任务、伙伴私聊、伙伴群聊路由（BotsFeatureLayout） |
| `desktop.chat.files` | desktop | 工作目录文件浏览 | hash `/cc-agent/files/:sessionId`（WorkdirBrowseRoute） |
| `desktop.chat.new-draft` | desktop | 新建任务草稿页 | hash `/cc-agent/new`（NewMakerDraftRoute） |
| `desktop.chat.orca-workflow` | desktop | Orca 协同工作台 | hash `/cc-agent/orca/:sessionId`（OrcaWorkflowRoute） |
| `desktop.chat.scheduled` | desktop | 调度任务列表 | hash `/cc-agent/scheduled`（SchedulerPage） |
| `desktop.chat.session` | desktop | 会话工作台 | hash `/cc-agent/:sessionId`；副窗经 `/cc-agent/boot` 解析后落到同一会话视图 |
| `desktop.dev.maker-experimental` | desktop | Maker 实验诊断页 | hash `/maker-experimental`（MakerExperimentalView；EXPERIMENTAL_FEATURES 现为空，仍是生产路由） |
| `desktop.issues.guide` | desktop | Issue 引导页 | hash `/issues`（IssueTrackerFeatureLayout，已迁 GitHub 后的引导页） |
| `desktop.native.app-menu` | desktop | 应用菜单 | Menu.setApplicationMenu（用户可见出口，不展开业务逻辑） |
| `desktop.native.system-notification` | desktop | 系统通知 | notificationService（系统通知出口） |
| `desktop.native.tray` | desktop | 系统托盘 | windowsTrayLifecycle（Windows 托盘菜单） |
| `desktop.overlay.confirm` | desktop | 确认弹窗 | ConfirmDialogProvider 及插件确认宿主 |
| `desktop.overlay.find-in-page` | desktop | 页内查找条 | App → FindInPageBar |
| `desktop.overlay.interaction-portal` | desktop | 交互提问卡片 | components/interaction-portal（AskUser / 权限类卡片出口） |
| `desktop.overlay.permission-prompt` | desktop | 权限询问 | PermissionPrompt（会话内权限卡；DS-9 迁移前置） |
| `desktop.overlay.route-error` | desktop | 路由错误页 | router errorElement → RouteErrorFallback / TopLevelErrorBoundary |
| `desktop.overlay.splash` | desktop | 启动遮罩 | App → SplashScreen；同源 gating 下并挂 LoginBrandStage（z-9980 品牌画布，启动期即可见、Splash(z-9999) 之下） |
| `desktop.overlay.toast` | desktop | Toast | App 常驻 ToastContainer（用户可见出口，不展开业务逻辑） |
| `desktop.plugins.app-main` | desktop | 插件主视图 | hash `/apps/:ghostId`（GhostMainViewFeatureLayout） |
| `desktop.plugins.installed` | desktop | 已装插件 | hash `/plugins`（GhostPluginPage） |
| `desktop.settings` | desktop | 设置 | hash `/settings`（SettingsView；tab 含 general / personalization / providers / billing / usage / voice-input / im-bot / shortcuts / agent-island / import / remote-control / ghosts / builtin-tools / computer-use / help / about） |
| `desktop.shell.main-layout` | desktop | 主窗口壳（标题栏 / 左右栏 / 内容区） | main BrowserWindow → renderer/index.tsx → main-entry.tsx → App → MainLayout (`#/` 受保护壳) |
| `desktop.skillhub.local` | desktop | SkillHub 本地技能 | hash `/skillhub/local` 及统一详情 `/skillhub/detail`（旧详情链接重定向） |
| `desktop.skillhub.market` | desktop | SkillHub 市场 | hash `/skillhub/market`（SkillhubMarketListView） |
| `desktop.window.computer-permission-guide` | desktop | 电脑使用权限引导 | `?view=computer-permission-guide` → ComputerPermissionGuideWindow；backdrop 同文件 |
| `desktop.window.recording-preview` | desktop | 录屏独立回放窗口 | `?recordingPreview=1` → renderer/recording-preview-entry.tsx（不走 router.tsx） |
| `desktop.window.region-screenshot` | desktop | 全局截图浮层 | `?regionScreenshot=1` → renderer/region-screenshot-entry.tsx（不走 router.tsx） |
| `desktop.window.region-screenshot-editor` | desktop | 截图独立编辑窗口 | `?regionScreenshotEditor=1` → renderer/region-screenshot-entry.tsx（不走 router.tsx） |
| `desktop.window.region-screenshot-pin` | desktop | 截图贴图窗口 | `?regionScreenshotPin=1` → renderer/region-screenshot-pin-entry.tsx（不走 router.tsx） |
| `desktop.window.remote-desktop` | desktop | 远程桌面独立窗口 | `?remoteDesktopViewer=1` → renderer/remote-desktop-viewer-entry.tsx |
| `desktop.window.resource-usage` | desktop | 资源用量窗口 | `?resourceUsageWindow=1` → renderer/resource-usage-entry.tsx（不走 router.tsx） |
| `desktop.window.review-artifact-confirm` | desktop | Review 成果确认窗 | main/reviewer/reviewArtifactConfirmWindow.ts 内联 HTML/CSS（不走 renderer 路由） |
| `desktop.window.session-drag-preview` | desktop | 会话拖拽预览 | main/session-drag-preview.ts 透明预览窗 |
| `desktop.window.sidebar` | desktop | 右侧栏独立窗口 | `?sidebarWindow=1` → renderer/sidebar-window-entry.tsx；hash `/sidebar-window` |
| `desktop.window.voice-dictionary-toast` | desktop | 语音词典 Toast 窗 | `?view=voice-input-dictionary-toast` → main-entry.tsx → VoiceInputDictionaryToast |
| `desktop.window.voice-overlay` | desktop | 语音输入浮窗 | `?view=voice-input-overlay` → main-entry.tsx → VoiceInputOverlay |
| `mobile.account-deletion` | mobile | 账号注销 | app/account-deletion.tsx |
| `mobile.auth` | mobile | 登录与添加账号 | app/(auth)/login.tsx / app/add-account.tsx |
| `mobile.chat.incoming-share` | mobile | 外部分享内容预览与任务、伙伴目标选择 | app/incoming-share.tsx |
| `mobile.chat.new` | mobile | 新建任务 | app/sessions/new.tsx |
| `mobile.chat.session` | mobile | 任务内容与输入 | app/sessions/[sessionId].tsx |
| `mobile.chat.sharing` | mobile | 共享任务邀请与成员；供应商分享链接提示 | app/shared-session.tsx / app/provider-share.tsx |
| `mobile.companions.cloud` | mobile | 云端伙伴：主力电脑离线时的对话与换电脑 | app/companions/cloud/[actorId].tsx |
| `mobile.companions.direct` | mobile | 伙伴私聊回看 | app/companions/direct/[threadId].tsx |
| `mobile.companions.groups` | mobile | 伙伴群聊与分工 | app/companions/groups/[groupId].tsx |
| `mobile.device-management` | mobile | 设备管理 | app/devices/manage.tsx / app/devices/manage/[deviceId].tsx |
| `mobile.devices` | mobile | 主机详情 | app/devices/[deviceId].tsx |
| `mobile.files` | mobile | 任务文件与预览 | app/files/[sessionId].tsx / app/files/preview/[sessionId].tsx |
| `mobile.home` | mobile | 主机与资源首页 | app/index.tsx / app/devices/index.tsx |
| `mobile.mail` | mobile | 邮件阅读与附件预览 | app/mail-preview.tsx |
| `mobile.overlay.connection-startup` | mobile | 根布局挂载的启动与连接反馈 | app/_layout.tsx → StartupSplashOverlay / ConnectionNoticeProvider；各页面 ConnectionBanner |
| `mobile.plugins` | mobile | 插件目录、页面与原生交互 | app/plugins.tsx |
| `mobile.relay-join` | mobile | 扫码加入自建中转 | app/relay-join.tsx |
| `mobile.remote-desktop` | mobile | 远程桌面 | app/devices/desktop/[deviceId].tsx |
| `mobile.resources` | mobile | 远程资源列表与详情 | app/resources/[collectionId].tsx / app/resources/[collectionId]/[resourceId].tsx |
| `mobile.settings` | mobile | 设置（含调试与日志上传可见入口） | app/settings.tsx / app/settings/developer.tsx / app/settings/device-name.tsx / app/settings/handheld.tsx / app/settings/user-bubble.tsx / app/settings/voice-dictionary.tsx / app/settings/voice-speaker-filter.tsx |

### 生产路由覆盖

纯 `<Navigate>` 与运行期跳转组件不算 surface。布局壳（ProtectedRoute / GuestRoute / feature layout）不出现在下表。新增或删除一条生产路由会改变本表，使 `pnpm check:design-inventory` 失败。

| 路由 | 组件 | surface ID |
| --- | --- | --- |
| `/add-account` | AddAccountLoginPage | `desktop.auth.add-account` |
| `/apps/:ghostId` | GhostMainViewFeatureLayout | `desktop.plugins.app-main` |
| `/bots` | BotsHomeView | `desktop.bots` |
| `/bots/:botId` | BotsHomeView | `desktop.bots` |
| `/bots/:botId/direct/:threadId` | BotDirectMessageView | `desktop.bots` |
| `/bots/:botId/history/:sessionId` | BotHistorySessionView | `desktop.bots` |
| `/bots/:botId/session/:sessionId` | BotSessionView | `desktop.bots` |
| `/bots/groups/:groupId` | BotGroupChatView | `desktop.bots` |
| `/bots/list` | BotsListView | `desktop.bots` |
| `/bots/market/:packageId?` | BotMarketRoute | `desktop.bots` |
| `/bots/remote/:deviceId/:botId` | RemoteBotSessionView | `desktop.bots` |
| `/bots/remote/:deviceId/:botId/history/:sessionId` | BotHistorySessionView | `desktop.bots` |
| `/bots/remote/:deviceId/:botId/session/:sessionId` | RemoteBotSessionView | `desktop.bots` |
| `/bots/roster` | BotRosterView | `desktop.bots` |
| `/cc-agent/:sessionId` | CCAgentSessionView | `desktop.chat.session` |
| `/cc-agent/boot` | SecondaryWindowBootGate | `desktop.chat.session` |
| `/cc-agent/files/:sessionId` | WorkdirBrowseRoute | `desktop.chat.files` |
| `/cc-agent/new` | NewMakerDraftRoute | `desktop.chat.new-draft` |
| `/cc-agent/orca/:sessionId` | OrcaWorkflowRoute | `desktop.chat.orca-workflow` |
| `/cc-agent/scheduled` | SchedulerPage | `desktop.chat.scheduled` |
| `/issues` | IssueTrackerFeatureLayout | `desktop.issues.guide` |
| `/login` | LoginPage | `desktop.auth.login` |
| `/maker-experimental` | MakerExperimentalView | `desktop.dev.maker-experimental` |
| `/plugins` | GhostPluginPage | `desktop.plugins.installed` |
| `/settings` | SettingsView | `desktop.settings` |
| `/sidebar-window` | SidebarWindowLayout | `desktop.window.sidebar` |
| `/skillhub` | SkillhubLocalLayout | `desktop.skillhub.local` |
| `/skillhub/detail` | SkillhubDetailRoute | `desktop.skillhub.local` |
| `/skillhub/local/:kind/global/:name` | LegacySkillDetailRedirect | `desktop.skillhub.local` |
| `/skillhub/local/:kind/project/:projectHash/:name` | LegacySkillDetailRedirect | `desktop.skillhub.local` |
| `/skillhub/local/by-path` | LegacySkillDetailRedirect | `desktop.skillhub.local` |
| `/skillhub/market` | SkillhubMarketListView | `desktop.skillhub.market` |
| `/skillhub/market/:kind/:name` | LegacySkillDetailRedirect | `desktop.skillhub.market` |
| `/skillhub/market/:name` | LegacySkillDetailRedirect | `desktop.skillhub.market` |
| `/skillhub/market/manage/:name` | LegacySkillDetailRedirect | `desktop.skillhub.market` |

### 排除的 redirect

| 路由 | 目标 | 类型 |
| --- | --- | --- |
| `/` | (runtime home entry redirect) | MainEntryRedirect |
| `/billing` | /settings?tab=billing | Navigate |
| `/cc-agent` | (runtime session redirect) | CCAgentIndexRedirect |
| `/cc-agent/new-dialogue` | /cc-agent/new | Navigate |
| `/cc-agent/orca/new` | /cc-agent/new | Navigate |
| `/skillhub` | /skillhub/local | Navigate |

### Mobile 文件路由覆盖

| 入口 | 导出组件 | surface ID |
| --- | --- | --- |
| apps/mobile/app/(auth)/login.tsx | LoginRoute | `mobile.auth` |
| apps/mobile/app/account-deletion.tsx | AccountDeletionScreen | `mobile.account-deletion` |
| apps/mobile/app/add-account.tsx | AddAccountScreen | `mobile.auth` |
| apps/mobile/app/companions/cloud/[actorId].tsx | CloudCompanionRoute | `mobile.companions.cloud` |
| apps/mobile/app/companions/direct/[threadId].tsx | CompanionDirectMessages | `mobile.companions.direct` |
| apps/mobile/app/companions/groups/[groupId].tsx | BotGroupChatRoute | `mobile.companions.groups` |
| apps/mobile/app/devices/[deviceId].tsx | DeviceDetailScreen | `mobile.devices` |
| apps/mobile/app/devices/desktop/[deviceId].tsx | RemoteDesktopRoute | `mobile.remote-desktop` |
| apps/mobile/app/devices/index.tsx | HomeScreen | `mobile.home` |
| apps/mobile/app/devices/manage/[deviceId].tsx | DeviceInformationScreen | `mobile.device-management` |
| apps/mobile/app/devices/manage.tsx | DeviceManagementScreen | `mobile.device-management` |
| apps/mobile/app/files/[sessionId].tsx | RemoteFileBrowserScreen | `mobile.files` |
| apps/mobile/app/files/preview/[sessionId].tsx | RemoteFilePreviewScreen | `mobile.files` |
| apps/mobile/app/incoming-share.tsx | IncomingShareScreen | `mobile.chat.incoming-share` |
| apps/mobile/app/index.tsx | IndexScreen | `mobile.home` |
| apps/mobile/app/mail-preview.tsx | MailPreviewScreen | `mobile.mail` |
| apps/mobile/app/plugins.tsx | @/plugins/PluginsScreen | `mobile.plugins` |
| apps/mobile/app/provider-share.tsx | ProviderShareLinkScreen | `mobile.chat.sharing` |
| apps/mobile/app/relay-join.tsx | RelayJoinScreen | `mobile.relay-join` |
| apps/mobile/app/resources/[collectionId]/[resourceId].tsx | RemoteResourceResolverScreen | `mobile.resources` |
| apps/mobile/app/resources/[collectionId].tsx | RemoteCollectionScreen | `mobile.resources` |
| apps/mobile/app/sessions/[sessionId].tsx | SessionScreen | `mobile.chat.session` |
| apps/mobile/app/sessions/new.tsx | NewRemoteSessionScreen | `mobile.chat.new` |
| apps/mobile/app/settings/developer.tsx | DeveloperSettingsScreen | `mobile.settings` |
| apps/mobile/app/settings/device-name.tsx | RenameSelfDeviceScreen | `mobile.settings` |
| apps/mobile/app/settings/handheld.tsx | HandheldSettingsScreen | `mobile.settings` |
| apps/mobile/app/settings/user-bubble.tsx | UserBubblePage | `mobile.settings` |
| apps/mobile/app/settings/voice-dictionary.tsx | VoiceDictionaryScreen | `mobile.settings` |
| apps/mobile/app/settings/voice-speaker-filter.tsx | VoiceSpeakerFilterRoute | `mobile.settings` |
| apps/mobile/app/settings.tsx | SettingsScreen | `mobile.settings` |
| apps/mobile/app/shared-session.tsx | SharedSessionScreen | `mobile.chat.sharing` |

### Mobile 布局 / 开发入口排除

| 文件 | 原因 |
| --- | --- |
| apps/mobile/app/+native-intent.ts | native intent routing; no screen |
| apps/mobile/app/_layout.tsx | layout; visible mounted feedback is a separate overlay surface |
| apps/mobile/app/automations/[deviceId].tsx | legacy automation link redirect; no screen |
| apps/mobile/app/group-execution-preview.tsx | MOBILE_VISUAL_MOCK_ENABLED group execution fixture; not production UI |
| apps/mobile/app/listperf.tsx | __DEV__ list performance harness; not production UI |
| apps/mobile/app/plugin-management-preview.tsx | gated plugin settings visual fixture; not production UI |
| apps/mobile/app/splash-preview.tsx | MOBILE_VISUAL_MOCK_ENABLED preview; not production UI |

Mobile 静态图跟随本地 import/reexport 与平台 TSX；根布局仅登记可见反馈，不把布局自身或资源实例另算 surface。服务端动态内容、运行期 import 拼接、原生系统呈现及未显式导入的消费者需人工复核；不宣称完整递归渲染图。

<!-- END GENERATED: surface-facts -->

## 人工标注

DS-8（#4268 已合并；以下为 2026-09-10 接管证据）：Desktop 的 522/541 注册项、11 内置主题静态覆盖与通用排版/间距/圆角/尺寸/动效已通过 DTCG→Terrazzo 2.7.1 接入原消费者；19 项暂留及维护方法见 [Token README](../../packages/design-tokens/README.md)。默认/内置冻结、用户主题兼容、全量单测与两模式代表样本已验证，可撤销源改风格演练已恢复。这是数值来源接管，不把下面任一完整 surface 自动升级为 migrated；图表命中、Permission、G2、69 图公开与平台待项仍按原责任跟进。实机审核以当前 Cindy 测试版为准，截图在桌面唯一主计划的 `附件/DS-8/`，不入 Git。

DS-9（2026-09-11，本地候选）：用户已决定桌面授权三项，聊天与授权呈现统一使用既有数值链及薄封装。工程/运行证据与未验证范围见 [DS-9 索引](../design-evidence/2026-09-11/ds9-desktop-core.md)。本轮 Codex 负责影响核对与修复，kirozeng 做视觉验收；长期 surface owner 不据此永久改派。没有把静态引用或组件样本等同整页 migrated。

生成器不得改本表。首轮（DS-2a）：全部 `legacy`；暂无归属写 `unassigned`。`protected` 与迁移状态正交。

Mobile 已由 DS-7 纳入同一台账（2026-09-10 静态入口发现），保留 legacy；数值接管留待 Mobile 独立阶段。发现维护由 Codex 执行、kirozeng 协调；长期页面负责人待认领，2026-09-17 复查，不以 unassigned 表示无人跟进。

另册 / 排除（不进必做迁移清单）：

- `apps/desktop/cindy-updater/ui/`：独立更新器子应用；
- 插件沙箱窗 `electronSandboxAdapter.ts`：加载插件内容，不是主机 UI；
- `htmlPdfRenderer.ts`：无头 PDF 渲染，用户不可见；
- 测试样张与 `__tests__` fixture。

| ID | owner | 迁移状态 | protected | 目标道路 | 下一动作 |
| ------------------------------------------ | ------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `desktop.auth.add-account` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | DESIGN.md §16 登录链路 | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.auth.legacy-migration` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | DESIGN.md §16 登录链路（消费 --login-callback-* 品牌豁免族 component token） | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.auth.login` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | DESIGN.md §16 登录链路 | 既有登录品牌保护；本批无全局按钮/主题变更 | 真实隔离窗口走过登录→本地模式；没有验证 Apple/Google/企业账号登录；2026-09-17 或 DS-10 开工前复查 |
| `desktop.bots` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | 当前 #4283 伙伴设置与聊天路径；操作集合由原业务决定 | 核标准/伙伴精简消息与授权相邻回归；实际远程伙伴/跨账号联调留 kirozeng 安排，Codex 复测，不以样本标整页完成；2026-09-17 或 DS-10 开工前复查；#6768（2026-10-22）区分朗读候选可见性与已保存选择，保留当前隐藏选择的展示和调用，其余隐藏候选不展示；不改变停用/账号准入，双主题五语言单页证据随 PR 提供 |
| `desktop.chat.files` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | 文件页聊天 rail 继承本批呈现；文件扫描与 watcher 不变 | 核真实文件路由与窄栏；整页不标迁移，文件新鲜度/焦点继续用既有回归保护；2026-09-17 或 DS-10 开工前复查 |
| `desktop.chat.new-draft` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | DESIGN.md §15.15 创建页内容位 | 保持既有 ChatInput 与新建布局，本批改动在后续消息与授权 | 真实本地新建入口正常；完整聊天与授权分别验收，不把创建页标 migrated；2026-09-17 或 DS-10 开工前复查 |
| `desktop.chat.orca-workflow` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | 复用 CCAgentSessionView 的聊天组件，Orca 编排不变 | 共用呈现与紧凑宽度有受控验证；实际多 Agent 调度未发起，kirozeng 安排实测、Codex 复测；2026-09-17 或 DS-10 开工前复查 |
| `desktop.chat.scheduled` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | 调度列表自身无本批样式变更；生成任务使用标准聊天 | 核列表路由及生成任务对标准聊天的消费；未触发真实计划执行，kirozeng 安排实测、Codex 复测；2026-09-17 或 DS-10 开工前复查 |
| `desktop.chat.session` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | pilot | DESIGN §10 status/diff/消息卡语义族；§5 workflow-status-cell / system-category-square | chatChrome / activityRowChrome、原消息组件与 Diff Worker | 真实本地路由 + 固定历史与受控流式；09-11 用户整体视觉验收通过，尚未合并；DS-10 接成熟保护样本；不改消息与媒体业务；2026-09-17 或 DS-10 开工前复查 |
| `desktop.dev.maker-experimental` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.issues.guide` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.native.app-menu` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.native.system-notification` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.native.tray` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.overlay.confirm` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.overlay.find-in-page` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.overlay.interaction-portal` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.overlay.permission-prompt` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | pilot | DESIGN §4 桌面授权决定；§5 键帽与按钮规则；权限业务和旧主题覆盖保护 | DS-9 已按 09-11 桌面三项决定接标准 Button，保留 perm/chat-input 局部 alias | 普通/窄栏/长规则/提交/失败/快捷键/主题按 DS-9 证据验证；09-11 用户整体视觉验收通过，尚未合并；模式选择与账号/插件授权分别保留；2026-09-17 或 DS-10 开工前复查 |
| `desktop.overlay.route-error` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.overlay.splash` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | DESIGN.md §16 登录链路 | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.overlay.toast` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.plugins.app-main` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.plugins.installed` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.settings` | kirozeng（DS-6 与用量图表跟进） | pilot | DESIGN.md §10 语义豁免色族消费者；外部主题导入保护 token（资源用量类别色在独立窗）；DESIGN.md §5 登记成员 `usage-heatmap-day` / `usage-token-bar` | DS-4 / DS-4b 已落地；DS-6 两张表单与指定普通确认已随 #4135 合入，用户测试版手动审核通过；DS-8 数值同源 | DS-6 工程与真实测试版审核已交付，G2/公开附件/平台待项按证据复查；focus、ivory/elevated 见治理 §10。旧 alias 与 slot 按作用域生效，禁止仅因同值删除局部配色；DS-6/8/9 按实际消费者分批核对跨 surface alias，confirm-dialog 归 DS-6；用量图表形状与密度已随 #4064 恢复；DS-11 补 36px 任意日期入口，与图表共用 day 筛选（最终视觉验收另记）；09-08 蓝色热力图描边、多色柱图七日强调与微弹裁决见 [组件规范](./usage-history-charts.md)，此前移除的日期入口由 DS-11 用户授权重新补足；图表优化 #4076 已合入；DS-11 等价日期输入已实施，平台与用户验收仍须独立记录，不提前标记 migrated；DS-6 SC/G2/公开附件/平台待项见 [本批证据](../design-evidence/2026-09-08/ds6-forms.md)，不把局部通过当完整设置页 migrated；#6768（2026-10-22）补普通厂商空目录/发现失败时的通用型号手填回退，语音分组说明保持原位置；新增回归与双主题五语言单页证据随 PR 提供 |
| `desktop.shell.main-layout` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | DESIGN.md §15 CINDY 皮肤族（侧栏 vibrancy / 选中 pill）；外部主题导入保护 token；DESIGN.md §5 登记成员 `workflow-status-cell`（background-tasks 面板详情） | 保持布局树与主题；聊天区域继承本批共用呈现 | 真实本地主窗口、侧栏与聊天可用；其它皮肤/平台待用户实看；2026-09-17 或 DS-10 开工前复查 |
| `desktop.skillhub.local` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | SkillhubDiffPanel 继承 DiffView 排版，文件比较和发布逻辑不变 | 同一 DiffView 的真实 Worker/长行/大字号验证；Skill Hub 真实网络长反馈未联调；2026-09-17 或 DS-10 开工前复查 |
| `desktop.skillhub.market` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | SkillhubDiffPanel 复用 DiffView，列表/网络逻辑不变 | 真实 Diff 组件验证不等于市场流程完成；真实远端联调按 DS-10 平台清单继续安排；2026-09-17 或 DS-10 开工前复查 |
| `desktop.window.computer-permission-guide` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.window.recording-preview` | unassigned | legacy | — | 查现有标准组件与治理 §12 当前路线；按人工下一动作接管 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `desktop.window.region-screenshot` | unassigned | legacy | — | 查现有标准组件与治理 §12 当前路线；按人工下一动作接管 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `desktop.window.region-screenshot-editor` | unassigned | legacy | — | 查现有标准组件与治理 §12 当前路线；按人工下一动作接管 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `desktop.window.region-screenshot-pin` | unassigned | legacy | — | 查现有标准组件与治理 §12 当前路线；按人工下一动作接管 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `desktop.window.remote-desktop` | unassigned | legacy | — | 查现有标准组件与治理 §12 当前路线；按人工下一动作接管 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `desktop.window.resource-usage` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | 外部主题导入保护 token（进程类别色） | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.window.review-artifact-confirm` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.window.session-drag-preview` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.window.sidebar` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | DESIGN.md §15 CINDY 皮肤族 | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.window.voice-dictionary-toast` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `desktop.window.voice-overlay` | Codex（DS-9 影响核对）/ kirozeng（验收协调） | legacy | — | DS-9 保留现有专属表面；未改全局 Button/主题源，按共享依赖核影响 | 本批未直接改该入口；无真实实例的独立/原生/账号/插件场景保留原合同，未作完整运行验收；kirozeng 安排所需环境，Codex 核对，2026-09-17 或 DS-10 开工前复查 |
| `mobile.account-deletion` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.auth` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.chat.incoming-share` | Chris / Codex（PR #6582） | legacy | — | iOS 外部分享目标选择新入口；沿用 Mobile 主题与 Typography，未声明整体设计系统迁移 | 2026-10-20 系统模拟器实测；发布前补充真机与专用目标发送验收 |
| `mobile.chat.new` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.chat.session` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.chat.sharing` | unassigned | legacy | — | DS-7 发现入口，Mobile 独立阶段接管；未迁移 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `mobile.companions.cloud` | unassigned | legacy | — | DS-7 发现入口，Mobile 独立阶段接管；未迁移 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `mobile.companions.direct` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.companions.groups` | unassigned | legacy | — | DS-7 发现入口，Mobile 独立阶段接管；未迁移 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `mobile.device-management` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.devices` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.files` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.home` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.mail` | unassigned | legacy | — | DS-7 发现入口，Mobile 独立阶段接管；未迁移 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `mobile.overlay.connection-startup` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.plugins` | unassigned | legacy | — | DS-7 发现入口，Mobile 独立阶段接管；未迁移 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `mobile.relay-join` | unassigned | legacy | — | DS-7 发现入口，Mobile 独立阶段接管；未迁移 | 保持现状；发现问题记下一动作，本张不修视觉 |
| `mobile.remote-desktop` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.resources` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |
| `mobile.settings` | kirozeng 协调 / Codex 发现维护；页面 owner 待认领 | legacy | — | DS-7 已发现入口；Mobile 独立阶段接管，未迁移 | 2026-09-17 复查入口变化和页面 owner；动态内容、平台实际呈现留 Mobile 独立阶段验证 |

### Usage History category colors (2026-09-09)

- Surface: `desktop.settings`; owner: kirozeng.
- All historical model identities share the category palette across table and daily bars; Agent/harness marks reuse `--engine-badge-cc`, `--engine-badge-codex` and `--usage-model-1` for pi teal (owner refinement, 2026-09-09).
- `usageHistoryColors.ts` derives OKLCH hues from existing `--usage-model-*` seeds at runtime (governance §3.4), outside static token migration.
- Geometry, hit testing and filtering retain their existing contracts. Light/Dark evidence and designer acceptance are recorded separately.

### Mobile login native actions (2026-09-21)

- Surface: `mobile.auth`; partial iOS migration, not a whole-screen native conversion.
- LoginNativeButton.ios shares nativeGlassButtonStyle with navigation chrome. Primary, social, back, method, resend, consent-dialog, captcha, organization-history and saved-account actions use SwiftUI Button; loading uses ProgressView. Brand artwork and login geometry remain owned by their existing components.
- RN remains for non-iOS controls, inputs, consent checkbox and inline legal links. Login panels themselves remain RN layout. No authentication protocol or native fingerprint inputs changed.
- Evidence: `docs/design-evidence/iphone-duo-adaptation.md`, login native actions section. Light iPad landscape inspected; dark and complete native interactions remain unverified.

伙伴语音操作条：`CompanionVoiceToolbar.tsx` 复用原通话控制器，输入框保留草稿并锁定，操作条与详情预留布局空间；窄窗换行，Light/Dark 语义 token，退出及后台任务边界见 `docs/product-rules/companion-voice-mode.md`。

伙伴输入框双按钮（2026-10-22，用户确认原型）：`ChatInput` / `SendButton` 在空输入时显示听写与语音对话；推荐输入出现时仍保留语音入口，采纳推荐为正文或输入正文、添加附件／浏览器评论后同槽位切换为发送（2026-10-29 用户裁决）；30px 固定命中区，250ms 图标缩放与淡切，Light/Dark 语义 token，减弱动效即时切换。保留停止、排队、待发内容编辑和听写发送。规范见 `DESIGN.md §14.4`，验证入口 `ui:check --page companion-composer`；截图证据随 #6768 发布，不等同真实 ASR/TTS 验收。

语音型号管理（2026-10-23，#6768 评审修复）：`desktop.settings` 的 TTS 行复用显示开关与未显示分区，支持重新选回首次未勾选的目录型号；Main 的可用性投影复用伙伴朗读目录资格。北京 Token Plan 独立推荐 Qwen-Audio，两个添加入口同源。沿用 `DESIGN.md §4` 标准控件、`§5` 点击目标与 `§10` 双主题语义 token；双主题单页证据随 PR 提供，不等同真实套餐合成验收。
