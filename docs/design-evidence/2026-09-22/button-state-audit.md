# Button 悬停与按压遗漏复查

2026-09-22，macOS / Electron Global 隔离开发客户端。基于 HEAD `6f56e4cd78aec8947ec4c621cd60fe115e2a072e` 的未提交工作区。本轮保留此前改动，没有提交、推送、部署网站或清理用户缓存。

## 原因

用户指出存储空间里的“打开目录、清理图片缓存、清理附件缓存”缺少 hover / pressed。它们走 StorageManagementCard 内部的 CardButton，其底层仍是独立的原生 button，未调用共享 Button。旧封装没有 active 样式；其 `enabled:hover:bg-[var(--settings-theme-card-border)]/40` 经当前 Tailwind 编译不产生任何 CSS，去掉 `/40` 的对照写法则生成 133 字节 CSS。

前一轮只迁移了清单里 236 个“待迁移”位置（234 接入、2 个下划线链接暂缓），CardButton 和它的 11 个使用位置当时标作“待核对”，所以被漏掉。该轮的数字本身正确，但不能据此推断整页或全部 Button 都已经接入。此次按实际源码调用链追踪局部封装，不只读清单状态。

## 本轮修复与检查范围

- 50 处旧的普通文字动作实现改为调用公共 Button，涉及 20 个消费者文件，包含多处被重复调用的局部封装。存储 CardButton 的 11 个调用位置一起获得统一状态反馈。
- 修复另外 4 处动作菜单入口的 `pressFeedback={false}`：添加插件、管理订阅、管理技能、管理模型。菜单入口继承按压反馈；表单 Select 和已排除的输入区控件保留其独立约定。
- 模型添加向导的“添加模型”去掉多余的局部 hover 覆盖，直接使用标准 secondary。上述合计修改 22 个消费者文件。
- 全 Renderer 扫描覆盖 914 个原生 button 定义，筛出 156 个药丸文字/局部 Button 候选，结合用途核对；这不是把所有原生 button 都归入 Button。保留导航、选择器、卡片、图标、登录专属控件和超链接等独立类别。
- 全部 390 处现有公共 Button JSX 调用（117 个文件）检查了局部样式、内联样式与关闭反馈的属性；未发现普通动作继续在固定命中层复制背景、边框或整颗按钮缩放。特殊主题仍通过 face 别名接入，SelectionQuoteButton 的内联定位不属于外观重复实现。
- 前轮 236 处记录再次逐项核对，仍为 234 处接入、2 处文字链接暂缓。现有 ProvidersSection / PublishDialog / WorkLouder 薄封装继续透传公共 Button。计数按源码定义/调用点，不能相加当作运行时按钮实例数。
- 本轮修复前后 onClick 等事件处理器、disabled、type、ref、aria 属性对照无差异；加载视觉通过 Button 管理。存储本地快速操作原有的无瞬态 loading 约定保留，未改变清理或确认逻辑。

## 实机状态验证

复用已启动、来源核对为当前工作区的隔离开发客户端，未重启其它开发实例。存储、模型供应商、SSH、插件、技能、自动化、任务导入 7 组页面，Light / Dark 各检查一次。

- 106 条按钮×主题观测记录：104 条可用、2 条禁用。可用按钮的 hover 颜色、pressed 颜色/面层内缩以及稳定尺寸检查均通过；禁用项单独记录，不计为可点击反馈失败。
- 状态批检通过 Chromium 的 CSS 伪状态检查实际页面的 computed style，不触发业务操作；额外使用真实鼠标对两个“打开目录”和两个“清理缓存”按钮，在双主题下逐个执行悬停、按下、移出后松开，8 组均通过。未触发打开目录、生成密钥或清理缓存。
- “清理图片缓存”实际为 104 × 28px。Light 静态底色 `rgb(253, 253, 248)`、hover `color(srgb 0.920941 0.920941 0.902902)`；Dark 静态底色 `rgb(31, 31, 31)`、hover `color(srgb 0.178353 0.178353 0.178353)`、pressed `color(srgb 0.243655 0.243655 0.243655)`。两主题按压面层 inset 从 -1px 变为 0px，命中框位置、宽高保持不变。
- 已目检存储页双主题和缓存按钮静态/悬停/按下截图。测试环境结束留在浅色“设置 → 存储空间”。

本地证据暂存于 `/tmp/cindy-button-state-audit/`：`storage-light.png`、`storage-dark.png`、`pointer-sheet.png`、`pointer.json`、`runtime.json`。位图不入仓，目前没有公开附件链接。此次没有逐一触发支付、审核发布、连接实际外部设备等所有条件状态，不能把源码接入和共享组件测试记为全部页面人工验收。

## 检查结果

- 缓存目录四个动作补充回归检查，防止再次回到私有 button、丢失 hover/active 或关闭按压反馈。
- 存储、Hook 连接、Telegram 设置、插件卡片、Button 专项合计 162 项通过。
- Desktop 类型检查通过，设计台账生成校验通过，diff 空白检查通过。
- 根相关测试：Desktop 3993 项通过、1 项跳过、1 项失败；310 个文件通过、1 个文件失败。唯一失败仍为先前已有的 Windows `windowBackdropAcrylic.test.ts` 源码格式断言；所读 main 源码与该测试无本轮修改。design-tokens 相关测试通过。没有以此宣称完整门禁通过，也没有提交。

## 本轮接入明细

以下按源码实现位置记录；封装会覆盖多个界面实例。行号对应本次工作区。

| 源码 | 所在组件或封装 | 公共参数 |
| --- | --- | --- |
| [components/settings/StorageManagementCard.tsx:1284](../../../apps/desktop/src/renderer/components/settings/StorageManagementCard.tsx#L1284) | CardButton | variant={emphasis ? "cta" : "secondary"} size="sm" compact |
| [components/settings/WorkLouderCodexSettings.tsx:1143](../../../apps/desktop/src/renderer/components/settings/WorkLouderCodexSettings.tsx#L1143) | KeyMergeControls | variant="secondary" size="md" compact |
| [components/settings/WorkLouderCodexSettings.tsx:1365](../../../apps/desktop/src/renderer/components/settings/WorkLouderCodexSettings.tsx#L1365) | SettingsResetButton | variant="secondary" size="md" compact |
| [features/plugin/GhostPluginPage.tsx:455](../../../apps/desktop/src/renderer/features/plugin/GhostPluginPage.tsx#L455) | GhostPluginPage | variant="secondary" tone="quiet" size="sm" compact |
| [features/plugin/GhostPluginPage.tsx:1668](../../../apps/desktop/src/renderer/features/plugin/GhostPluginPage.tsx#L1668) | GhostPluginPage | variant="secondary" size="sm" compact |
| [features/plugin/GhostPluginPage.tsx:2376](../../../apps/desktop/src/renderer/features/plugin/GhostPluginPage.tsx#L2376) | GhostPluginCard | variant="secondary" size="sm" compact |
| [features/plugin/GhostPluginPage.tsx:2435](../../../apps/desktop/src/renderer/features/plugin/GhostPluginPage.tsx#L2435) | CardPillButton | variant="primary" size="md" compact |
| [features/scheduler/components/RunHistoryPane.tsx:437](../../../apps/desktop/src/renderer/features/scheduler/components/RunHistoryPane.tsx#L437) | PillButton | variant="primary" size="md" compact |
| [features/skillhub/ReviewVerdictDialog.tsx:71](../../../apps/desktop/src/renderer/features/skillhub/ReviewVerdictDialog.tsx#L71) | GrayPillButton | variant="primary" size="md" compact |
| [features/skillhub/ReviewVerdictDialog.tsx:85](../../../apps/desktop/src/renderer/features/skillhub/ReviewVerdictDialog.tsx#L85) | WhitePillButton | variant="secondary" size="md" compact |
| [features/skillhub/ReviewVerdictDialog.tsx:212](../../../apps/desktop/src/renderer/features/skillhub/ReviewVerdictDialog.tsx#L212) | ReviewVerdictDialog | variant="cta" size="md" compact |
| [features/skillhub/components/MarketCard.tsx:55](../../../apps/desktop/src/renderer/features/skillhub/components/MarketCard.tsx#L55) | CloneButton | variant="cta" size="lg" compact |
| [components/settings/SshKeySetupDialog.tsx:458](../../../apps/desktop/src/renderer/components/settings/SshKeySetupDialog.tsx#L458) | KeyList | variant="secondary" size="sm" compact |
| [components/settings/SshKeySetupDialog.tsx:900](../../../apps/desktop/src/renderer/components/settings/SshKeySetupDialog.tsx#L900) | CodeBlock | variant="secondary" size="xs" compact |
| [components/settings/TelegramBotSection.tsx:429](../../../apps/desktop/src/renderer/components/settings/TelegramBotSection.tsx#L429) | ConnectedCard | variant="secondary" size="lg" loading={props.isTogglingOnline} |
| [components/settings/DingTalkBotSection.tsx:185](../../../apps/desktop/src/renderer/components/settings/DingTalkBotSection.tsx#L185) | DingTalkBotSection | variant="cta" size="lg" loading={bot.isSaving} |
| [components/settings/DingTalkBotSection.tsx:200](../../../apps/desktop/src/renderer/components/settings/DingTalkBotSection.tsx#L200) | DingTalkBotSection | variant="cta" size="lg" loading={bot.isSaving} |
| [components/settings/TelegramBehaviorSettings.tsx:407](../../../apps/desktop/src/renderer/components/settings/TelegramBehaviorSettings.tsx#L407) | TelegramPersonaSettings | variant="secondary" size="md" compact loading={syncState === "syncing"} |
| [components/settings/TelegramBehaviorSettings.tsx:463](../../../apps/desktop/src/renderer/components/settings/TelegramBehaviorSettings.tsx#L463) | ContactsAutoRegisterHint | variant="primary" size="sm" compact loading={busy} |
| [components/chat/RewindPreviewDialog.tsx:250](../../../apps/desktop/src/renderer/components/chat/RewindPreviewDialog.tsx#L250) | RewindPreviewDialog | variant="cta" size="lg" loading={committing} |
| [features/skillhub/SkillhubDetailView.tsx:512](../../../apps/desktop/src/renderer/features/skillhub/SkillhubDetailView.tsx#L512) | SkillUsagePanel | variant="cta" size="md" compact loading={diagnoseLoading} |
| [features/bots/BotsHomeView.tsx:577](../../../apps/desktop/src/renderer/features/bots/BotsHomeView.tsx#L577) | BotSettings | variant="secondary" size="lg" compact |
| [features/bots/BotsHomeView.tsx:596](../../../apps/desktop/src/renderer/features/bots/BotsHomeView.tsx#L596) | BotSettings | variant="secondary" size="lg" compact |
| [features/bots/BotDirectMessageView.tsx:207](../../../apps/desktop/src/renderer/features/bots/BotDirectMessageView.tsx#L207) | BotDirectMessageView | variant="secondary" size="md" compact |
| [features/billing/BillingPage.tsx:1884](../../../apps/desktop/src/renderer/features/billing/BillingPage.tsx#L1884) | OrderHistoryCard | variant="secondary" size="sm" compact |
| [components/new-chat/ModelSelector.tsx:541](../../../apps/desktop/src/renderer/components/new-chat/ModelSelector.tsx#L541) | RemoteModelLoadNotice | variant="secondary" tone="danger" size="xs" compact |
| [components/settings/HelpThreadView.tsx:251](../../../apps/desktop/src/renderer/components/settings/HelpThreadView.tsx#L251) | FeedbackSection | variant="secondary" size="sm" compact |
| [components/settings/VoiceInputSection.tsx:2132](../../../apps/desktop/src/renderer/components/settings/VoiceInputSection.tsx#L2132) | VoiceInputSection | variant="secondary" size="md" compact |
| [features/scheduler/components/ScheduleFormDialog.tsx:1191](../../../apps/desktop/src/renderer/features/scheduler/components/ScheduleFormDialog.tsx#L1191) | ScheduleFormDialog | variant="secondary" size="sm" compact |
| [components/settings/HookConnectionsSection.tsx:1440](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1440) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1451](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1451) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1464](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1464) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1479](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1479) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1490](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1490) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1501](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1501) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1513](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1513) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1645](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1645) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1665](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1665) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1676](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1676) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1705](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1705) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1742](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1742) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1787](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1787) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1836](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1836) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1846](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1846) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1870](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1870) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1881](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1881) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1890](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1890) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1930](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1930) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1960](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1960) | HookConnectionsSection | variant="secondary" size="xs" compact |
| [components/settings/HookConnectionsSection.tsx:1978](../../../apps/desktop/src/renderer/components/settings/HookConnectionsSection.tsx#L1978) | HookConnectionsSection | variant="secondary" size="sm" compact |
