# Cindy Design System

> **读取时机**：新增或修改任何界面、组件、布局、样式、动效或 UI 文案之前。先读下面的「阅读路由」，
> 再按路由读相关章节与专题，不需要通读全文；设计文档索引见 `cindy-design-system.md`。
> **适用路径**：`apps/desktop/src/renderer/**`、`apps/mobile/app/**`、`apps/mobile/src/**/*.tsx`、
> `apps/mobile/src/theme/**`、`packages/design-tokens/**`

## 阅读路由

本文件是 Cindy 视觉规则的入口，不需要通读。本节只指路，不写参数；每个参数只在对应章节保留一份。

本文件超过 2000 行。Read 工具不带 offset 时只读前 2000 行，单行超过 2000 字符的部分也会被截掉，所以不要整份读：先用 `grep -n "^## \|^### " docs/design-rules/DESIGN.md` 找到要读的章节和行号，再带 offset / limit 只读那一段。

所有界面改动先读本节、§1 和 §7，再按下表读与任务相关的部分。

| 要做的事 | 优先复用 | 规则位置 |
| --- | --- | --- |
| 文字按钮 | `components/ui/button.tsx` 的 `Button` | §4 Buttons |
| 只有图标的按钮 | `Button` 的正方形用法；标题栏用 `ChromeIconButton`、侧栏用 `SidebarIconButton` | §4 Buttons、§14.6 |
| 输入框 | `components/ui/input.tsx` 的 `Input` / `Textarea`；已有设置页输入用 `SettingsTextInput` | §4 Inputs & Forms |
| 搜索框 | `components/ui/search-input.tsx` 的 `SearchInput` | §4 Inputs & Forms |
| 表单字段的标签、说明和错误 | `components/ui/form-field.tsx` 的 `FormField` | §4 Inputs & Forms |
| 单选下拉 | `components/ui/select.tsx` 的 `Select` / `SelectParts` | §4 Select & Dropdown |
| 菜单 | `components/ui/dropdown-menu.tsx`；自带外壳的菜单复用 `menu-row.tsx` | §4 Select & Dropdown |
| 浮层 | `components/ui/popover.tsx`；输入框工具栏用 `MorphPopover` | §4 Select & Dropdown、[容器形变](./container-transform.md) |
| 悬停提示 | `components/ui/tooltip.tsx` 的 `Tip` | §14.6 |
| 徽标、计数、快捷键键帽 | `components/ui/badge.tsx` 的 `Badge` / `CountBadge`；`components/ui/kbd.tsx` 的 `Kbd` | §4 Badges |
| 确认弹窗 | `useConfirmDialog`、`ConfirmDialog` | §4 Dialog & Modal |
| 其他弹窗 | 暂无通用组件：Radix Dialog 加 `.modal-scrim` / `.modal-panel`，结构参考 `confirm-dialog.tsx` | §4 Dialog & Modal |
| 第一次用到某个功能时的介绍 | `components/feature-intro/` 的 `FeatureIntroDialog` | [功能介绍](./feature-introduction.md) |
| 分段切换 | `components/ui/segmented-control.tsx` 的 `SegmentedControl` | §4 Desktop segmented controls |
| 页面级标签导航（下划线） | `components/ui/underline-tabs.tsx` 的 `UnderlineTabs` | §4 Tabs |
| 开关、滑杆 | `Switch`、`Slider`、`EffortSlider` | §15.17、§15.18 |
| 复选框 | `components/ui/checkbox.tsx` 的 `Checkbox` | §4 Desktop settings controls |
| 加载中 | `components/ui/spinner.tsx` 的 `Spinner` | §14.4 |
| 下载、安装进度 | `components/ui/download-meter.tsx` 的 `DownloadMeter`；按钮大小的位置用同文件的 `DownloadRing` | §4 Download progress |
| 错误与通知 | `ErrorNotice`；短通知用 `lib/toast.ts` | §4 Error notices、§4 Toast |
| 展开收起 | `components/ui/collapse.tsx` 的 `Collapse` | §14.4 |
| 聊天内容 | `chatChrome.ts`、`activityRowChrome.ts` | [聊天界面](./chat-surfaces.md) |
| 设置页分区和行 | `components/ui/settings-rows.tsx` 的 `SettingsSection`、`SettingsCard`、`SettingsRow`、`SettingsField`、`SettingsBlock`、`SettingsPageHeader` | §4 Desktop settings rows |
| 选颜色 | 语义 Token，不写色值 | §10 Token Selection Rules for New UI、§2；例外见 [exceptions/color.md](./exceptions/color.md) |
| 亮暗模式 | 语义 Token | §10 Light / Dark Dual-Mode Delivery Gate |
| 圆角与点击区域 | 上述组件的默认值 | §5 Border Radius Scale、[治理合同](./design-governance.md) §13；间距例外与已登记的内容形状见 [exceptions/layout.md](./exceptions/layout.md) |
| 字号、字重、行高 | Tailwind 字号档位 | §3；例外见 [exceptions/typography.md](./exceptions/typography.md) |
| 动效 | Motion Token | §14.4；循环动效与动效类别见 [exceptions/motion.md](./exceptions/motion.md) |
| 叠放顺序（z-index） | 层级刻度 `z-<层名>`；共享浮层的默认层级 | §6 层级刻度 |
| 界面文案 | i18n 键 | §11、[术语表](../../i18n/GLOSSARY.md)（规则见[工程约定](../dev-rules/engineering-conventions.md) §5.1） |
| 文案里出现「任务／对话／消息」 | 已裁决的叫法 | [任务与对话命名](../product-rules/task-and-conversation-naming.md) |
| 修改 Token、主题或标准组件 | 现有生成链路 | [治理合同](./design-governance.md)、[Token README](../../packages/design-tokens/README.md) |

只在改动对应功能时才读下面的专题：

| 专题 | 文件 |
| --- | --- |
| 登录、注册与回调页（§16） | [login-flow.md](./login-flow.md) |
| 聊天正文的链接与可点性（§14.5） | [message-link-clickability.md](./message-link-clickability.md) |
| 输入框工具栏的容器形变 | [container-transform.md](./container-transform.md) |
| 功能介绍（第一次用到某个功能时的一页引导） | [feature-introduction.md](./feature-introduction.md) |
| 新建任务页 | [new-task-home.md](./new-task-home.md) |
| 任务侧栏、伙伴侧栏与任务筛选 | [task-sidebar.md](./task-sidebar.md) |
| 模型供应商设置页 | [provider-settings-ui.md](./provider-settings-ui.md) |
| 设置里的单页：设备访问、伙伴模型与能力、harness 版本 | [settings-pages.md](./settings-pages.md) |
| 「开启协同」「创建新 Worker」弹窗 | [collaboration-worker.md](./collaboration-worker.md) |
| 首次登录后的开始引导 | [first-run-guide.md](./first-run-guide.md) |
| 聊天正文、群聊、频道与对话里的附件图片 | [chat-surfaces.md](./chat-surfaces.md) |
| 远程连接 V2 | [remote-connection-v2.md](./remote-connection-v2.md) |
| 输入框的发送与停止按钮 | [composer.md](./composer.md) |
| 品牌图像、字标与吉祥物能出现在哪里 | [exceptions/brand-surfaces.md](./exceptions/brand-surfaces.md) |
| 应用壁纸 | [wallpaper.md](./wallpaper.md) |
| macOS 菜单栏额度面板 | [macos-menu-bar-quota.md](./macos-menu-bar-quota.md) |
| 附件预览 | [attachment-preview.md](./attachment-preview.md) |
| 用量历史图表 | [usage-history-charts.md](./usage-history-charts.md) |
| iOS 原生界面 | [ios-native-design.md](./ios-native-design.md) |
| 手机端界面 | [手机设计指南](../../apps/mobile/docs/mobile-design-guide.md) |

## 1. Visual Theme & Atmosphere

设计以[产品原则](../product-rules/core-product-principles.md)的品质要求为前提：理解是否自然、
操作是否顺手、反馈是否及时、工作能否连贯完成，每一处为用户省下的理解、等待与返工都值得投入。

界面把注意力留给用户内容与 Agent 成果，围绕清楚的工作目的组织，强调状态、结果和下一步
动作。视觉语言早期（2025）参考过外部极简设计，现已是 Cindy 自己的体系；新的视觉选择从
工作需要出发，不以外部产品为依据。

灰度构成安静的底色，彩色只表达已登记的语义（§2）。层次由背景差异与 1px 边界建立，基础
语言不用阴影，窄例外统一登记在 §6 Shadow Philosophy（含浮层阴影 Token 与少数非 Token 的
插画、预览例外）。工作区不放吉祥物或装饰插画，品牌图像只出现在 §15.7 / §16
允许的品牌界面；用户主动选用的[应用壁纸](./wallpaper.md)除外。

Inter 是标题与正文共用的唯一无衬线字体，配柔和几何让强大的工具容易接近。普通操作框默认
胶囊，内容容器与已登记形状按角色处理，圆角分类统一见 §5。

颜色经语义 Token 表达，同一角色在 Light 与 Dark 下都成立。复用组件让一致的设计自然延续。
排版、几何与状态的精确约定在后续章节。

### 1.1 New-task home content

正文已移至 [new-task-home.md](./new-task-home.md)，规范效力不变。

## 2. Color Palette & Roles

> **Multi-theme note**: this section names roles and their tokens, not color values. Every theme family resolves the same tokens to its own colors: the Classic values (theme family `default`, shown as Classic in Settings) are in the §10 generated table, and the CINDY values — the family new users start on (`DEFAULT_FAMILY_ID = 'cindy'`) — are in §15.16. At runtime **every color is consumed through a token** (see §10 Theme System & Token Reference), so the same component automatically renders each theme's own colors under other themes (Eclipse / One Dark Pro / Monokai Pro, …). **When implementing components, always write tokens, never hex** — rules in §10.

### Primary Text

- **Near Black** (token `--text-primary`): primary headlines, body text, primary links and button text on light-colored surfaces — the strongest ordinary text tier; only the registered emphasis tier (§15.16) goes further. In the CINDY themes the same token resolves to translucent ink (§15.16).
- **Pure Black** is not part of the ordinary text tiers: body and heading text use `--text-primary`. It remains only where a section registers it — the Light fill of the maximum-emphasis Black Pill CTA (`--accent-cta-bg-pure`) and the Dark inverse CTA foreground (`--accent-pure-cta-fg`, §4 Buttons) — and in local text tokens that keep their own value (for example `--chat-input-text` in the default Light theme).

### Layer System (Light & Dark)

The interface is built from a three-tier layer system that applies symmetrically to both modes — **Surface** as the base, **Card** as the elevated layer, and **Board** as the hairline divider. This is the foundation of every page in every mode.

| Role | Token | Usage |
| --- | --- | --- |
| **Surface** | `--surface` | The primary page background — every page starts here. In full-window app layouts, this is the single flat background. In centered-card layouts, this is the page beneath the card. |
| **Card** | `--surface-elevated` | The elevated layer sitting on top of Surface — login cards, modals, panels, raised containers, and any element that needs to visually lift off the page.                           |
| **Board** | `--border-default` | The hairline divider color — 1px borders between sections, card outlines, and any separator line within the same layer.                                                            |

**Layer rule — flat vs. elevated:**

- **Full-window applications** (e.g. main workspace, chat interface, dashboards): use **Surface** as a single flat background for the entire window — no Card layer at the page-structure level. Section boundaries (sidebar, toolbar, content area) are drawn with 1px **Board** dividers, never with background color shifts.
- **Centered-card layouts** (e.g. login, empty-state card on a blank page): use **Surface** as the page background and **Card** as the lifted card. The color difference between Surface and Card is what makes the card read as "lifted" — no shadow needed. The card outline is drawn in **Board**. Modal dialogs are floating layers, not centered cards: they keep the `--shadow-menu` elevation (§6 Floating row, §4 Dialog & Modal).

> **Important — element-level vs. page-level:** The "flat Surface" rule in full-window layouts applies only to the **overall page structure**, not to individual widgets. Lifted widgets _within_ a full-window layout — inputs, chat input boxes, raised cards, modal overlays, panel popups — still use **Card** color per their component rules (see Section 4). A full-window chat interface can have a flat Surface page _and_ a Card-colored chat input box at the same time; those are two different scopes. "Surface flat" means "don't split the page into Page+Card layers," not "every element on the page must be Surface color."

### Optional application wallpaper (user decision, 2026-10-01)

正文已移至 [wallpaper.md](./wallpaper.md)，规范效力不变。

### Task tag identity colors

用户确认的任务标签色板为红、橙、黄、绿、蓝、紫、灰、粉、珊瑚、青、靛蓝、白共十二色。用于标签色球与编辑色板，以及用户选择的项目图标和图标色板（见本节项目图标规则），表示用户分类或身份，不表示任务运行状态。色球为圆形、细描边，选中时勾位于球内；白色在 Light/Dark 中均保持白色，用独立深色勾保证对比度。Desktop 使用 `task-tag-*` 语义 token；Mobile 使用对应 `taskTag*` 色板字段。默认面板只显示选择列表，添加或编辑后才显示名称和两行六列色板，不显示双击编辑提示。

### Personal message bubble colors (Mobile, 2026-10-12)

正文已移至 [手机设计指南 §9](../../apps/mobile/docs/mobile-design-guide.md#9-从根规范迁入的手机规则)，规范效力不变。

### Chip & Button Neutrals

Small interactive chips (button backgrounds, tag pills, avatar fills, selected-nav pills) sit outside the layer system — they're foreground elements, not background layers.

- **Light Gray** (token `--surface-chip`, Light): Chip/button backgrounds in Light Mode — the workhorse neutral for pressed states, filled pills, tag backgrounds, and avatar fills.
- **Dark Chip** (token `--surface-chip`, Dark): the primary chip/button background in Dark Mode — one step lifted above a Card or Surface context.
- **Dark Chip Alt** (token `--surface-chip-alt`): the variant that collapses to the Dark Card value — used where a chip sits directly on Surface and only needs the Card-level lift. When in doubt, use `--surface-chip`; see §10 for both slots.

### Neutrals & Text

**Text tiers (user decision, 2026-10-22).** Neutral text follows one ordered ladder: primary > description > secondary > tertiary > placeholder/disabled. The CINDY family keeps every step distinct; other built-in themes never invert the order, though some share one value for description and secondary. In the CINDY family every tier is the same ink at decreasing alpha — black in Light, white in Dark (values in §15.16) — the way Apple's label colors work: a translucent tier keeps its step on glass, wallpaper, hover fills and cards, and picks up the warmth of the surface beneath it. Don't recreate a tier with a solid gray picked by eye, and don't fake a tier by fading an element with `opacity`. Text on inverse surfaces (selected pills, tooltips, CTAs) uses its dedicated foreground token, never a translucent ink tier. The same ink at low alpha draws the CINDY hover, chip, selected and pressed fills and its borders and dividers (§15.16).

- **Stone** (token `--text-secondary`): Secondary body text, footer links, and de-emphasized content. The primary "muted" tone.
- **Mid Gray** (token `--text-secondary-mid`): Emphasized secondary text, slightly darker than Stone.
- **Silver** (token `--text-tertiary`): Tertiary text and deeply de-emphasized metadata. **Never use it as a placeholder** — too prominent, reads as filled-in (see §4 Inputs; the G3 erratum is archived in [`design-decision-log.md`](./design-decision-log.md); placeholders use `--text-placeholder`).

### Project icon identity colors (user request, 2026-11-13)

Project symbols and letter icons reuse the existing task-tag palette, order and localized color names (`TASK_TAG_COLORS`):
red, orange, yellow, green, blue, purple, gray, pink, coral, teal, indigo and white.
Desktop reads `--task-tag-*`; Mobile reads `taskTag*` directly. No separate project palette or new color
values. This extends the tag identity-color role to user-selected project symbols, letter icons and their picker.
Default explicitly uses `text-primary` / `textPrimary`: dark ink in Light, light ink in Dark. White uses the tag's white fill, neutral border
and `task-tag-white-check` / `taskTagWhiteCheck` glyph to remain visible on light surfaces.
Images and emoji retain their intrinsic colors. Palette swatches are two rows of six; default is the first explicit choice above the palette, with an adaptive neutral swatch, a selected check and a localized “follow theme” label. It is not presented as a reset action. Color choices have localized names and a neutral selection ring. Mobile targets are 44pt;
Desktop uses standard pill Buttons. Controls, project names and task status remain on their existing tokens.
Project letter icons are identity artwork: square tiles with 25% corner radius, Cindy typography and weight 600. Automatic initials use a stable name-derived choice from the existing non-white identity colors, with theme-adjusted foreground and a 14% same-color background. Explicit default remains the theme foreground. Manual letter colors remain selectable; the tile shape also applies to them.
Project image thumbnails use the same 25% corner crop on Desktop and Mobile, including automatic images, uploaded images and previews. This clips opaque asset corners without changing the image's intrinsic colors or persisted bytes; emoji and symbol geometry stay unchanged.

### Semantic & Accent

**Mobile group mention text** — 用户 2026-11-04 要求群聊 `@点名` 样式对齐 PC；专用 `groupMentionText` 采用 CINDY Light／Dark `msg-link` 的对应色（Mobile 数值正本 `apps/mobile/src/theme/tokens.ts`），只用于群聊已识别点名，不用于普通链接、状态或其他文字。仅着色，不另加下划线、底色或字重；身份入口与边界见 §14.5、`bot-group-chat.md`。

**Group chat External badge (user decision, 2026-11-25)** — 面向企业 SSO 查看者的「外部 / External」小徽标（仅在群含非本组织成员或群归属外部时，于群列表行、群顶栏、群设置头、消息作者行、成员列表与点名浮层出现；C 端个人账号永不显示）。Desktop 复用已登记的 `--status-info` 前景与 `color-mix(in srgb, var(--status-info) 14%, transparent)` 淡底（4px `rounded` 微圆角，区别于中性圆胶囊标签）；Mobile 复用 `groupMentionText` 前景与同色 14% 淡底（`radius.micro` 4pt 圆角、`micro` 11/16 medium）。仅表达跨组织/外部成员边界，不复用为状态或链接色；同组织部门标签继续使用中性 `--surface-chip` / `surfaceChip`。

- **PR/MR merge conflicts (user decision, 2026-11-05)** — an open, non-draft PR/MR with a confirmed merge conflict uses `--warning-fg` (Mobile `warningFg`) on its existing state icon across headers, sidebars, companion cards and management lists; no extra icon. Draft, merged and closed keep their main-state colors. The Desktop hover panel shows a separate Merge / Conflicts data row for open and draft conflicts, with a warning-colored, medium-weight value; its header stays unchanged. The button's accessible name includes the conflict. Unknown or absent conflict fields add no signal; passing checks remain independent. Both Light and Dark use the same semantic tokens. Plugin cards are outside this scope and retain their existing merge-state text row.

Toast loading is neutral: use the shared 16×16 Spinner in `--text-secondary`, with polite status semantics. Keep it visible until the operation settles and explicitly dismiss it; only failures use the error variant.

The grayscale rule is near-absolute. The sanctioned non-gray colors are exactly those registered in this section (the list below, the narrowly-scoped exceptions and the functional identity colors that follow it), in the §10 Semantic Exemption table with its plugin-provenance and search-match notes, and in §15.4 — read together, they are the complete list; each is tightly scoped to a specific surface. A non-gray color found in none of them is unregistered. New semantic colors must not be introduced without being recorded in one of these places first.

- **Focus Blue** (`#417CDD` at 50%; tokens `--focus-ring` / `--focus-ring-soft`): the keyboard-accessibility focus ring, finalized 2026-07-17 (replaces Tailwind's default `#3b82f6`). Keep it out of mouse-only interaction: controls show it on `:focus-visible`, not on click. Text inputs are the approved exception — a focused text field always matches `:focus-visible`, so the generic `Input` shows the soft ring `--focus-ring-soft` whenever focused, while settings and composer inputs use their own focus-border aliases (§4 Inputs).
- **Thinking / Warning Orange** (`#EA6B17`, finalized 2026-07-17, replaces the frozen `#FF6600`): the shared warning-accent family, identical in both modes. Sanctioned consumers only — the ChatView Running Status Bar (sparkles icon + status text, e.g. `Thinking…`, no background fill), running-state breathing icons in the sidebar, the collaboration-mode menu row's ON state, the plan-approve icon, the settings integration warning, and the workflow agent status strip's running cells (8×8px filled squares in the background-tasks panel detail and the workflow chat card, registered 2026-07-28 — running-state semantics, same family as the sidebar breathing icons; the done/failed/queued cells stay on their own semantic tokens: `--card-status-done` / `--error-fg` / `--surface-chip`), and the sidebar task-info PR unresolved corner dot (registered 2026-08-17 — same `--status-bar-accent` as the session-header unresolved count; static, no breathing), and the filter reminder dot (registered 2026-10-20 — a static 6px/6pt dot at the top-right corner of a filter or view-settings button, meaning "this list is not the default active view": the search filter button while any narrowing filter is applied, and the Mobile home `⋯` display-settings button while viewing archived tasks (Desktop sidebar display settings never show it, including inbox filters and hidden kinds, per the final owner decision on 2026-11-28; menu summaries and checked options carry that state); same `--status-bar-accent` / `statusAccent`, no breathing, no text; Desktop shares one `FilterReminderDot` component and Mobile one `FilterReminderDot` component so size, offset and color live in one place; it is purely visual, so the button's accessible name or state must carry the same information; sort and grouping changes and the "all" status do not light it), and the Desktop private-Bot running subtitle (local, remote and merged Cindy; registered 2026-11-04, 11px breathing sparkles and orange progress text; see [Desktop list status](./desktop-bot-list-status.md)), and the Bot group chat speaking row (registered 2026-09-27 — sparkles icon + status text for the teammate currently taking its turn, the same running semantics and `--status-bar-accent` as the ChatView Running Status Bar; no background fill), and the running step of a Bot group chat 分工 plan card (registered 2026-09-27 — icon + status word of the one step in progress, same running semantics and `--status-bar-accent`; no background fill; done / pending / failed steps stay neutral), and the Desktop Bot delegation card status dot (registered 2026-11-04 — starting/running use `--warning-accent` with `session-status-breathing`; waiting/completed/failed use `--card-status-awaiting` / `--card-status-done` / `--card-status-error`, while cancelled/unknown stay neutral; see [Desktop delegation status](./desktop-bot-delegation-status.md)), and the Remote connection V2 topology's busy state (registered 2026-11-07, owner: 忙碌中 is our orange, not gray — an 8px `--warning-accent` dot at a busy device tile's top-right corner with a 2px `--settings-theme-card-bg` ring and `session-status-breathing`, plus the 忙碌中 value of the status row in that device's card; same running semantics as the sidebar breathing icons; offline devices never show it) (see the §10 exemption table and §15 for the full token list: `--warning-accent` and its follower tokens). A consumer that introduces no new token — one that reads `--warning-accent` or an existing follower directly, like this strip — is registered by this list alone; a consumer needing a NEW token must also be registered in the §10 exemption table.

> **Additional narrowly-scoped exceptions** — 正文已移至 [exceptions/color.md](./exceptions/color.md#narrowly-scoped-exceptions)，规范效力不变。

**Functional identity colors in use (registered 2026-11-11, maintainer ruling A-03).** These were already shipping without a §2 entry; registering them records the current state and grants no new uses. Each stays on its own surface, uses only the named tokens (values in `colors.ts`, edited in `packages/design-tokens`), and never doubles as a status, CTA or row color:

- **Reasoning-effort tiers** — `--effort-tier-minimal` / `-low` `#2AAE5B`, `-medium` `#14B8A6`, `-high` `#3B82F6`, `-xhigh` `#4F46E5`, `-max` / `-ultra` `#8B5CF6` (Light = Dark; the static table is exported as `EFFORT_TIER_COLORS` and interpolated by `effortTierColors.ts`). Only the effort marks of the model configuration surfaces (model flyout, `EffortSlider`, advanced model drawer); they encode how hard the model thinks, not health.
- **Price tiers** — `--price-tier-t1` `#2AAE5B`, `-t2` `#B58A1F`, `-t3` `#C05353` (Light = Dark; `PRICE_TIER_COLORS`). Only the model price marks.
- **Fast blue** — `--fast-accent` `#3B9EFF` (Light = Dark), the Fast mode on-state accent only.
- **Favorite gold** — `--favorite-star` `#d99a06` Light / `#e8b425` Dark, the lit favorite star only.
- **Engine badges** — `--engine-badge-cc` `#d97757`, `--engine-badge-codex` `#7a9dff`, `--engine-badge-pi` `#a78bfa` (Light = Dark), the agent-engine (harness) identity marks in model presentation only (the Usage History reuse is registered above). Plugin engines (ACP) do not add fixed global engine color tokens: they render their plugin-declared icon (or the neutral generic plugin mark when absent or over the 64 KiB remote budget), keep original brand color on active/running task indicators, and use monochrome tinting on sidebar/menubar task marks (`PluginEngineIcon.tsx` / `PluginEngineMark.tsx`, inheriting task tint and recognizing legacy brand marks such as Antigravity).
- **Remote SSH host status dot** — `--remote-status-ready` `#2AAE5B`, `--remote-status-progress` `#f59e0b` (connecting / authenticating / reconnecting), `--remote-status-failed` `#D91F37`, `--remote-status-disconnected` neutral gray (Light = Dark). The small host status dot only; the host name and row stay neutral.
- **Skill Hub review badges** — `--skillhub-review-pending-*` orange (fg `#ea580c` Light / `#fb923c` Dark) for automated review in progress, `--skillhub-review-quarantine-*` yellow (fg `#a16207` / `#facc15`) for manual review. Only those two review-state badges.
- **Information blue** — `--info-700` `#1D4ED8` Light / `#60a5fa` Dark (and its alias `--status-info`): file / parameter highlights and the in-progress state on teammate surfaces. It is close to, but not the same token as, Focus Blue; keep the two independent.

Other registered non-gray colors live where their component is specified: plugin provenance and search matches in §10, the sidebar draft pencil in §15.4.

**Plugin engine task marks (user decision, 2026-11-19).** Desktop and Mobile keep the plugin's
supplied icon colours while a task is running and use the existing status breathing animation.
Idle tasks use a neutral grey mark. When the plugin supplies no icon, the generic puzzle mark uses
the usual task status colours. This exception covers only the image pixels of a plugin engine's
running task mark.

MCP App 卡片来源例外（2026-11-16）：第三方来源、本地安装、来源未知使用 warning 语义前景色（Desktop `--warning-fg`，Mobile `warningFg`）；市场来源不标色，自定义 MCP 使用普通文字色。只表达安装来源，不替代权限或签名判断。

_Dark Mode text uses softened neutrals to reduce eye strain. In Classic, `--text-secondary` and `--text-tertiary` swap values between Light and Dark (see the §10 generated table); in the CINDY family every tier is translucent ink (§15.16). Pure white is reserved for button labels and high-contrast UI elements on dark backgrounds._

### Gradient System

- **None in the core UI.** Cindy uses no gradients; visual separation comes from flat color blocks and single-pixel borders. This is a deliberate, almost philosophical design choice. (The login canvas is also flat by ruling — see §16.5.)
- **Functional edge fades (owner decision, 2026-11-07).** A fade may show that content continues past an edge: the composer fade, the horizontal scroll ends of `RolePillDropdown` and the right-sidebar `TabBar`, and scroll-list and collapsed-body masks. It runs from the surface colour to transparent, or is a mask, and carries no colour of its own. Same-colour overlay layers (`linear-gradient(c, c)`) and the transparency checkerboard are not visual gradients. The WorkLouder device illustration keeps its knob highlight. An audio card without a cover keeps its gradient placeholder (owner decision, 2026-11-07). Apart from these and the registered exceptions below, everything else stays flat. `designEffectsDiscipline.test.ts` keeps this list closed.
- **Windows tray quota card — same picture as the macOS menu bar panel** — 正文已移至 [macos-menu-bar-quota.md](./macos-menu-bar-quota.md#windows-tray-quota-card)，规范效力不变。
- **Mobile usage-overview quota tubes — same picture as the Home Screen widget (owner decision, 2026-11-19, PR #11376).** The tubes in Mobile’s drawer and usage overview (`UsageQuotaColumns`) keep the glass well that the widget’s `TubeView` draws: one vertical neutral gradient, `surfaceElevated → surfaceChip`, standing in for `wellTop → wellBottom` on an app surface. It belongs to these tubes only; the liquid stays one flat tone and nothing else on the page may use a gradient.
- **Model-budget spectrum — registered identity exception (registered 2026-11-11, maintainer ruling A-04).** A deliberate 7-step rainbow, the only colored gradient in the working UI. It fills the **model-name text** (`background-clip: text`) of discount-routed (Codex gateway) models in the model selector; it is not a bar and not neutral. Light runs `#e11d48 → #0d9488`, Dark `#fb7185 → #2dd4bf`; both sets live in `MODEL_SPECTRUM_COLORS` (`packages/model-providers/src/modelSpectrum.ts`), are injected as `--model-spectrum-1 … 7` by `theme-service.ts` and composed into `--model-budget-gradient` in `globals.css`. Imported and user themes do not override them. The temporary enterprise Codex provider mark (`OpenAISpectrumMark`) shares the same seven colors; no other text, fill or surface may use them.
- **Composer Stop working glow** — 正文已移至 [composer.md](./composer.md#working-glow-gradients)，规范效力不变。
- **GhostTool shimmer** — a neutral gray sweep (`rgba(160,160,160,0.16)` over transparent) across a running GhostTool card; carries no hue (§15.4).
- **Computer Use cursor bloom** — the out-of-process agent cursor's brand-red bloom and its driver-required gradient (§15.7). It is not drawn by the renderer.
- **Session-loading wordmark sheen — narrow functional exception (Desktop approved 2026-08-10).** `BrandLoadingMark` may use one neutral `transparent → --text-primary → transparent` gradient solely as a mask-clipped highlight inside the official Light/Dark wordmark while a session's message tree is deferred. It is a loading-progress signal, not a background, separator, fill, or reusable surface treatment. It may appear only after the 200ms delayed-reveal threshold, disappears as soon as the message tree mounts, and may not leak to messages, cards, dialogs, sidebars, or static branding. Full motion and brand-surface constraints are registered in §14.4 and §15.7.

### Filter reminder inside display settings

正文已移至 [task-sidebar.md](./task-sidebar.md)，规范效力不变。

## 3. Typography Rules

### Font Family

- **Display / Body / UI**: `Inter`. The shipped fallback stack is the generated value `app-font-ui-default` (`packages/design-tokens/src/reference/foundations.json` → `--app-font-ui-default`; do not hand-copy it elsewhere): `'Inter Variable', Inter, -apple-system, BlinkMacSystemFont`, then the CJK fonts (`'PingFang SC', 'Hiragino Sans GB', 'HarmonyOS Sans SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC'`), then `'Segoe UI', Roboto, sans-serif`. The CJK fonts deliberately come **before** Segoe UI: Segoe UI carries narrow glyphs for CJK punctuation such as 《》, so on Windows a line would otherwise mix half-width and full-width punctuation; with the CJK fonts first, punctuation Inter does not cover falls to PingFang / YaHei and keeps one width. Latin text still renders in Inter.
- **Monospace**: the shipped default is the system monospace stack `app-font-code-default` (same source → `--app-font-code-default`): `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New'`, the same CJK fallbacks, then `monospace`. Users may pick another code font in Settings; JetBrains Mono is an optional preset, not the default.

> DS-8 preserves the default code stack and user font selection; see [the recorded decision](./design-decision-log.md#2026-09-11-ds-8-默认代码字体依据迁移).

_Note: The entire interface uses a single sans font — Inter — for both display headlines and body text. Inter is chosen for (a) its neutral, geometric character that stays out of the way, (b) its excellent legibility at small sizes, and (c) its wide availability in both web and design tooling. A single font keeps the hierarchy clean — separation comes from size and weight, not typeface contrast._

### Hierarchy

Desktop roles (rewritten 2026-11-11, audit B-02 / B-03 / B-11). Sizes are `text-<n>` tokens from the 「桌面 UI 字号白名单」 below and scale with the UI font-size setting; weights follow the 「字重阶梯」 below — **every title is 500**.

| Role | Size | Weight | Line height | Where it is used |
| --- | --- | --- | --- | --- |
| Page title | 20px `text-20` | 500 | 1.3 | Settings page header (`SettingsPageHeader`), right-sidebar empty-state title |
| Dialog title | 18px `text-18` / `text-lg` | 500 | — | `ConfirmDialog` and every form dialog (provider, MCP, voice, input handoff…); one weight for all dialogs |
| Section title | 16px `text-16` | 500 | 1.2 | `SettingsSection`; compact dialogs that use a 16px title |
| Chat body, composer, card title | 15px `text-15` | 400 body, 500 titles | 1.6 chat body (`CHAT_BODY_CLASS`), 1.467 composer | Message body, composer input; titles of in-chat prompt cards (permission, plugin grant, rename confirmation) and system cards |
| Reading text, prompt and panel title | 14px `text-14` / `text-sm` | 400 text, 500 titles | — | Longer descriptions, Input lg; titles of composer interaction prompts (plan review, plugin setup, collapsed prompt shell), the handoff card, the update banner and side-panel headers |
| UI text and controls | 13px `text-13` | 400; 500 for buttons and labels | 1.5 for multi-line descriptions | Button label (all sizes, 13/500), settings row label (13/500), settings descriptions, Tooltip body, Input md. 13px **is** a reading size: descriptions and tooltips are read sentence by sentence |
| Small | 12px `text-12` / `text-xs` | 400 / 500 | — | Metadata, timestamps, Input sm; smallest size for sentences |
| Micro label | 10–11px `text-10` / `text-11` | 400 / 500 | — | **Non-reading** labels only — counts, badges, eyebrows, scope chips, tag pills; floor 10px |
| Code | code stack, `--app-code-font-size` | 400 | — | Code blocks, inline code, diffs, tool output. Default **14px**, user setting `codeSize` 10–24 (see the registry row 「用户可配置代码字号」) |
| Code, compact | code stack, `calc(var(--app-code-font-size) - 1px)` and the other registered derivatives | 400 | — | Compact chat cards; only the derivatives registered in the guard's EXEMPTIONS |
| Code in UI chrome | code stack, 11–12px from the UI ladder | 400 / 500 | — | Paths, IDs and tags shown inside ordinary UI (they follow the UI size setting, not `codeSize`) |

Brand canvases (§16 login / Splash family and its self-contained pages) keep their own design-px titles — conceptually Display 48px, Section Heading 36px, Sub-heading 30px. Their values live in the canvas constants and §16 tables, not in app code. They are the only place a title may use a weight other than 500; which weight applies is set in 「字重阶梯」 below. Mobile has its own role table (`apps/mobile/docs/mobile-design-guide.md` §3). This table describes roles; the whitelist constrains values.

### Principles

- **Single sans family**: Inter carries both display headlines and body text — no typeface switching between hierarchy levels. Size and weight alone create hierarchy, keeping the typographic system maximally simple.
- **Weight restraint**: Everyday chrome defaults to 400 (regular) and 500 (medium); every desktop title is 500; 600 is a rationed emphasis tier that is not used for titles, and 700 lives exclusively inside registered exemption domains. No light, no black weight, no in-between values. The full ladder and its rules are in 「字重阶梯」 below.
- **Tight display, comfortable body**: Titles use tight line heights (1.2–1.3 on desktop, 1.0 on brand canvases), while reading text relaxes to 1.5–1.6. The contrast creates clear hierarchy without needing weight contrast.
- **Monospace for code only**: the code font (system monospace stack by default; JetBrains Mono is an optional preset, see Font Family above) is reserved for inline code, terminal commands, and code blocks — never used for UI chrome.

### 字重阶梯(2026-08 修订,issue #1505)

全站字重只允许以下四档整百值,禁止一切中间值(550/650…)与 800 及以上:

| 档  | 名称     | 用途                                                                        |
| --- | -------- | --------------------------------------------------------------------------- |
| 400 | Regular  | 长文阅读正文、代码                                                          |
| 500 | Medium   | UI 默认强调；**桌面端所有标题**（页面、弹窗、分区、卡片与提示卡标题）—— 日常 chrome 的主力档 |
| 600 | Semibold | 限量强调(徽标、表头、选中态等局部加重)，**不用于标题**。新增使用要能说出「为什么 500 不够」 |
| 700 | Bold     | **仅限下方豁免登记表中的域**,禁止出现在普通 UI chrome                       |

- **标题一律 500**(2026-11-11 维护者裁决,设计审核 B-03 方案 B):桌面端标题不再按「普通确认框 / 表单弹窗 / 紧凑提示」区分字重,原先 600 的表单弹窗标题、紧凑提示与交互提示卡标题已改回 500;分组小标签、表头与名称(服务商名、目录名等)不是标题,仍可按 600 的限量强调使用;层级靠字号区分(见上方 Hierarchy)。唯一例外是品牌画布:登录 / Splash 家族的标题按 §16 / `login-flow.md` 的明确规定取字重——下方豁免登记表「登录 / Splash 品牌画布」行的 700(范围只限该行列出的文件),或登录规范写明的字重(如注销状态气泡标题 Regular 400);登录规范没有规定的界面(如人机验证弹窗)同样用 500;登录相关但不在该行的界面(如设置里的账号页、其他弹窗)仍按本条用 500。手机端按自己的角色表选字重(见下一条),不受本条约束。
- 与手机端 `apps/mobile/src/theme/tokens.ts` 的 `fontWeight` token(regular / medium / semibold / bold)一一对应 —— 两端一张梯子。
- **手机端按角色选字重**(2026-09-26 用户定稿):标题 600、列表行 / 按钮 500、正文与说明 400、分组小标签 600;浅色字不配粗字重。角色表正本见 `apps/mobile/docs/mobile-design-guide.md` §3。
- **两端 700 口径**:手机端 UI chrome 的上限仍是 600（正本为 `apps/mobile/docs/mobile-design-guide.md`,该文已同步登记本例外）。`bold` / 700 在手机端**只允许**出现在下表登记的域——原生 Markdown strong 与登录品牌画布。也就是说「四档梯子」是两端共用的**档位定义**,不等于两端 chrome 都可用 700。
- **CJK 注记**:桌面未设 `font-synthesis: none`,中文回退字体(PingFang)公开档位到 600 —— UI 里用 700 会在中文上触发伪粗体(算法加粗、边缘发糊),且 600 与 700 在 CJK 上的渲染差异不可靠。**中文层级不得依赖 600 vs 700 区分**,强调靠字号或颜色。

### 桌面 UI 字号白名单(2026-08,issue #1505)

<!-- BEGIN GENERATED DS-8: numeric-type -->
- **UI 段:{10, 11, 12, 13, 14, 15, 16}px;标题 / 内容段:{18, 20, 24, 28}px。** 下限 10px —— 9px 及以下禁止(再小就不是文字是纹理)。
<!-- END GENERATED DS-8: numeric-type -->
- **下限约束的是「开发者写死的档位」,不约束运行期缩放结果。** 用户可把 UI 字号设到 `appearanceSettings.uiSize` 允许的最小值 12（默认 14）,`useFontSettings` 按 `uiSize / 14` 缩放并 `Math.round`,此时 `--text-10` 与 `--text-11` 都会算成 9px（两档在该设置下失去区分）。这是用户主动选择的整体缩小,不是违反下限;守卫也只检查源码里写的档位,不检查运行期计算值。**若要保住 10px 视觉下限,应在字号设置侧（提高 `uiSize` 下限或改缩放曲线）解决,而不是往白名单里加更小的档位。**
- **写法**:一律用 `tailwind.config.ts` 的 `text-<n>` token 类(映射 `--text-<n>` 变量;doc 紧凑模式与后续字号缩放能力都挂在这层变量上,任意值类会静默漏掉这些机制)。语义类 `text-xs / text-sm / text-base / text-lg` 只收编存量(等值 12 / 14 / 16 / 18)；源码侧禁止使用 `text-xl` 及以上语义档位（由守卫拦截），配置侧 `theme.extend.fontSize` 的 `xl..5xl` 遗留项不在本轮删除范围，避免删除后静默回退到 Tailwind 内置固定值、失去用户字号缩放；其清理另行处理。**禁止新增任意值 `text-[Npx]`(含一切小数)与白名单外档位**;需要新档先改本表与权威来源，再进组件。
- **单源约定（DS-8）**：DTCG 为已接管族的唯一编辑源；同一 Terrazzo 流程生成本节摘要、CSS 默认值及 Tailwind/字号 hook/class merge 的映射。`useFontSettings` 保留原缩放计算，shared 默认字号只引用无 DOM 的生成子集。生成新鲜度与独立白名单、实际缩放测试共同保护此链，不再手动同步多份数值。
- 品牌画布域(登录 / Splash 家族等设计 px 坐标系表面)不映射本白名单:字面量只允许进画布常量文件(`loginDesignTokens.ts` 的地位,对齐手机端 `loginSkinLayout.ts`)**或下表登记的自包含品牌页生成器**(`oauthResultPage.ts` 整页由 main 侧生成,其内嵌 raw CSS 即该页的常量载体),组件消费端照常受守卫扫描。

### 排版豁免登记表

正文已移至 [exceptions/typography.md](./exceptions/typography.md)，规范效力不变。

### 排版 non-goals

正文已移至 [exceptions/typography.md](./exceptions/typography.md)，规范效力不变。

## 4. Component Stylings

**Desktop scrolling screenshot flow (owner correction, 2026-10-26).** Scrolling capture stays in the original screenshot overlay: the selected area passes input to the source app, while the available space beside it contains a width-scaled, scrollable preview and edit/save/cancel/finish icons. During capture, the area outside the selection keeps the same dimming mask as region selection; the selected area remains clear and preview/actions appear above the mask (owner correction, 2026-10-28). Do not add a separate capture toolbar or result page. Finish copies and closes; Edit returns the stitched image to the existing annotation toolbar. Preview scaling must not reduce export resolution. All control chrome follows the same Light/Dark tokens as the ordinary toolbar. The draggable screen-top mode bar contains Screenshot, Scrolling screenshot, Region recording, GIF and Cindy, and appears only on the currently operated display. Switching modes does not start capture; after selection an explicit start action begins scrolling/recording. The bottom toolbar contains only annotation and export tools. Manual scrolling supports both directions without duplicating previously captured content; automatic scrolling can be stopped. Automatic scrolling must not move, lock, or repeatedly restore the system pointer; users can move freely and click Stop. Acceptance must include real pointer movement and button clicks, not only DOM automation (owner correction, 2026-10-28). The bottom automatic-scroll control has a single standard button face; its positioning wrapper has no background or border (owner correction, 2026-10-28). Static or briefly unmatched frames do not immediately show a failure notice; persistent failure preserves the captured content and stops automatic scrolling.

**Screenshot chrome safe area (owner request, 2026-10-27).** The selection may cover the whole display, but every piece of screenshot chrome (mode bar, hint, size label, magnifier, annotation toolbar and style bar, scrolling preview and its actions, recording controls) stays inside the display's chrome area: the system work area (no menu bar, Dock or taskbar), with the macOS camera housing (notch) also excluded when the menu bar is hidden. Live controls fall back to the rest of the display only when the selection leaves no room inside it. On macOS, a two-finger trackpad swipe never zooms a pinned image (pinch zooms it continuously around the pointer); pinch in the editor zooms around the pointer; one swipe, including its momentum, changes the snap level by one step.

**Recording toolbar movement (owner request, 2026-10-27).** The grip, format, timer and their shared empty space form one drag target. Recording actions remain separate click targets. Releasing or cancelling a drag leaves the toolbar at its final accepted position, outside the capture region and within the same display's chrome area; delayed host replies must not move it back. Starting recording keeps the existing macOS panel's geometry and stacking unchanged.

> Buttons / Cards / Inputs below use the structured key-value format (adopted from the §12 pilot, 2026-07): `field → token → Classic Light / Classic Dark resolved values`. Token names per §10.

### Buttons

```
button/primary  (Gray Pill)
  fill      --surface-chip
  text      --text-primary
  border    1px solid --surface-chip   (same as fill)
  radius    9999px (pill)
  padding   horizontal 24px; vertical content centered within the fixed height
  height    28px (sm) / 32px (md) / 36px (lg); compact exceptions 24px (xs) / 22px (xxs) — no 40px size (DS-4 G1, 2026-09-03; sm added 2026-09-21). The only size definition for every Button variant; impl components/ui/button.tsx
  type      text-13 / font-medium 500 (DS-4 G4, 2026-09-03)
  hover     --button-primary-hover     rest fill mixed 8% toward --text-primary   (swap-color, never opacity; DS-4 G2)
  pressed   --button-primary-pressed   hover mixed a further 10% toward --text-primary   (DS-4 G3)
  disabled  opacity 60%; ordinary pointer (#3246)
  note      understated, grayscale, always a pill
  impl      components/ui/button.tsx variant="primary"

button/secondary  (White Pill)
  fill      --surface-elevated
  text      --text-primary
  border    --border-default
  radius    9999px (pill)
  padding   horizontal 24px; vertical content centered within the fixed height
  height    same sizes as button/primary
  type      text-13 / font-medium 500 (DS-4 G4)
  hover     --button-secondary-hover    rest fill mixed 8% toward --text-primary
  pressed   --button-secondary-pressed  hover mixed a further 10% toward --text-primary
  disabled  opacity 60%; ordinary pointer
  note      visually lighter than primary; binds Tier-1, not --settings-btn-secondary-* (DS-4 G5)
  impl      components/ui/button.tsx variant="secondary"

button/cta  (Black Pill — maximum emphasis)
  fill      --accent-cta-bg-pure
  text      --accent-pure-cta-fg
  radius    9999px (pill)
  padding   horizontal 24px; vertical content centered within the fixed height
  height    same sizes as button/primary
  type      text-13 / font-medium 500 (DS-4 G4)
  hover     --button-cta-hover    derived from the fill, see Filled button states below (swap-color, never opacity; DS-4 G2)
  pressed   --button-cta-pressed  derived from the fill, see Filled button states below
  disabled  opacity 60%; ordinary pointer
  note      pure black on white (inverts in Dark); at most one per screen
  impl      components/ui/button.tsx variant="cta"
```

**Filled button states (owner decision, 2026-11-05).** Themes supply a filled button's base color; hover and pressed are computed from it, so a theme or custom color never needs state colors. This follows Apple's model of one color plus a system effect (`NSColor.withSystemEffect`), with steps calibrated from Cindy's approved neutral values.

- Rule (`themes/filledButtonStates.ts`): in OKLCH, hover lowers lightness by 0.045 and pressed by 0.085. A base at or below lightness 0.25 has no visible room to darken, so hover lifts to 0.27 and pressed to 0.355. Pressed always continues in the same direction as hover.
- Applies to: `cta`, SendButton, confirmation primary, permission allow, `danger-solid` and Cindy's solid relaunch pill.
- Neutral buttons (`primary`, `secondary`, quiet) keep mixing toward `--text-primary` as specified above.
- One registered exception: `danger-solid` in Dark keeps mixing toward `--text-primary`. It is dark text on a mid-lightness red, and darkening would drop text contrast below 4.5:1.
- A theme may still override a state token explicitly; the override wins.
- Compatibility: a local or imported theme that sets `accent-hover` keeps it as the hover of `cta` and confirmation primary (load-time only, `local-themes-normalize`); pressed takes one more 0.04 lightness step in the direction from base to hover.

**Compact settings actions (owner feedback, 2026-09-21).** Logs and compact automation actions use Button's `sm` size with their existing horizontal spacing. Contacts section actions retain their approved 24px target; appearance actions retain 36px or 32px targets. A 13px identity-removal icon keeps its visible size inside a 24px target. Destructive contacts actions retain semantic red hover/pressed feedback. The authorization-waiting Cancel action remains named and enabled; it is not a disabled loading button. The contacts discard/add-identity treatments are retained per this batch’s explicit keep-before decisions.

**Button inventory migration (owner-authorized 2026-09-22).** Functional text actions in Design Lab's pending-migration Button inventory call the shared Button, directly or through thin wrappers. Sizes follow the button blocks above. `compact` supplies shared 12px horizontal padding for dense rows and narrow toolbars. `tone` owns quiet and destructive treatments; `palette="confirmation"` preserves existing confirmation theme overrides without copying paint rules into dialogs. The portrait-confirmation row keeps its image-led height; long confirmation labels may wrap and grow. Loading retains an accessible action name and shows only the spinner. A busy action whose purpose is to open progress may explicitly use `allowWhileLoading`; ordinary loading actions remain disabled. Underlined links and the AI composer/send topic remain separate; icon-only actions follow the icon button rule below. Runtime and visual verification are recorded in the migration evidence; this does not claim every native button in the client is a Button.

**Button state audit follow-up (2026-09-22).** Inventory status alone does not prove that an action calls the shared implementation: follow local wrappers to their rendered control. Storage CardButton and the repaired pill wrappers now delegate to Button. Functional action-menu triggers (add plugin, manage subscription, manage skill, manage models) inherit normal press feedback; opening a menu is not itself a reason to disable feedback. Form Select triggers and the excluded input controls retain their separate contract. Audit both computed hover/pressed colors and the 1px face inset; a matching resting screenshot or a color-only assertion cannot prove the press motion. See [state audit evidence](../design-evidence/2026-09-22/button-state-audit.md).

**Source-wide Button audit (2026-09-22).** Scan native actions and local wrappers even when absent from the Lab migration list. Text branches of responsive action wrappers use Button; icon-only branches use the square Button below. The danger-surface tone retains an opaque theme surface for inline archive confirmations that cover existing text. The permission palette retains the existing permit-action colors and derives hover/pressed from that pair; confirmation handlers and keyboard guards do not change. See [the source-wide audit](../design-evidence/2026-09-22/button-full-source-audit.md).

**Icon buttons (owner decision C-07, 2026-11-11).** The shared `Button` used as a square is the general icon-only button: `px-0` with the width equal to the height — 28px (`size="sm"`, `w-7`), 32px (`size="md"`, the default, `w-8`) or 36px (`size="lg"`, `w-9`). It has two looks: frameless `variant="secondary"` `tone="quiet"`, and outlined `variant="secondary"`; `tone="danger"` marks destructive ones and is frameless — red glyph with the red hover / pressed fill, no outline, also on `variant="secondary"` (final, owner ruling 2026-11-27), and `cta` is kept for the single finishing action of a compact capture toolbar. Icon buttons are always square — no 28×24 or other flattened sizes — and keep the accessible name and `Tip` required by §14.6. The title bar keeps `ChromeIconButton` (28px) and the sidebar `SidebarIconButton` (36px); both share Button's paint layer.

**Why hover / pressed are derived, not aliased** (DS-4; ratios ruled by the designer 2026-09-04): in Dark, `--surface-hover` and `--surface-chip` resolve to the same value in default-dark / cindy-dark / one-dark-pro / monokai-pro, so aliasing primary's hover to `--surface-hover` made the hover state invisible; `--surface-hover-soft` sat within 2/255 of `--surface-elevated` in cindy-dark, breaking secondary the same way. For the neutral variants (`primary` / `secondary` / quiet), each state is therefore mixed off **its own variant's rest fill toward its own foreground** — 8% for hover, a further 10% for pressed; filled variants follow Filled button states above. The ladder follows any theme override automatically and introduces no theme-blind literals. Guard: `themes/__tests__/buttonStateContrast.test.ts` asserts every builtin theme keeps each step at ΔRGB ≥ 8. These are runtime-derived values, registered but not modeled in the DTCG shadow layer (governance §3.4).

**Desktop Button feedback (HTML v3 approved 2026-09-19).** Shared action Buttons use the sizes, pill radius, type and colors of the button blocks above. Icon/text gap defaults to 6px. On press, only the non-interactive fill/border layer retracts by 1px per edge over `--motion-instant` (80ms), using `--motion-ease-out`; the text, icon, layout and hit region stay fixed. State colors transition over `--motion-fast` (150ms). Loading shows only the centered spinner, retaining the accessible name and label width; disabled/loading controls do not receive press feedback. Reduced motion removes inset movement, transitions and spinner rotation.

The same paint layer is shared with ChromeIconButton (28px) and SidebarIconButton (36px; retired 34px grid style removed). Button's `--button-face-bg` / `--button-face-border` are component-local aliases of existing theme tokens, not additional theme IDs. Domain overrides set these aliases, including hover/active states, instead of painting the stationary hitbox. Select triggers and excluded composer/permission controls opt out via `pressFeedback={false}`. AI input/send/stop, login and other independent native buttons are outside this migration; HTML approval is not a claim that every button-tag consumer has migrated or passed client acceptance.

### Cards & Containers

```
card/container
  fill      --surface-elevated    (page-level flat layouts use --surface instead — §2 layer rule)
  border    1px solid --border-default   (only when separation is needed)
  radius    12px (container tier; Tailwind rounded-xl literal)
            ⚠ do NOT use §10's --radius — that is shadcn's 0.5rem (8px) primitive, unrelated to this 12px container radius
  shadow    none
  hover     --surface-hover
```

### Desktop settings rows

Desktop Settings sections put the 16px/500 section title outside the card. A card groups related settings as rows: label (13px/500, line height 1.5) and hint (12px, line height 1.4, 4px below the label) on the left, the control on the right, `px-4 py-4` per row, and an inset divider between visible rows only.
Related switches share one card instead of one card each; a row that opens a sub-page uses the same row with a trailing chevron. Use `SettingsSection`, `SettingsCard` and `SettingsRow` from [settings-rows.tsx](../../apps/desktop/src/renderer/components/ui/settings-rows.tsx); do not define local copies.
The row name is 13px/500 everywhere (owner decision, 2026-11-07). **Narrow drawer exception (owner decision, 2026-11-07):** inside a narrow drawer, currently only the group settings drawer, wrap them in `SettingsDrawerScope`. The section title is an `h3`, 13px/500 in `--text-secondary` instead of 16px, 8px above the card, rows are at least 48px tall (`py-3`, 52px with an avatar) instead of `py-4`, the label sits at line height 1.38 with 2px above the hint, and cards use `--surface-elevated`.
The row name stays 13px/500. Settings pages never use this scope. `SettingsRow flush` is for rows in a dialog that has its own padding. On settings pages the section title is an `h2` (`h3` for a sub-section on a page that has its own `h2` title), with 14px between the title, the cards and any note under them; a one-line description of the section (12px, line height 1.45) sits 4px under the title (`description`).
**Page titles (owner decision, 2026-11-08):** every Settings tab page and sub-page (Model providers, IM bots, Tools, Computer use, Pi extensions, Cindy Make, Accessories and the gamepad pages included) opens with a 20px/500 page title, line height 1.3, one step above the 16px section titles; its description is 13px, line height 1.5, 4px below; a back button (sub-pages) sits before the title and page actions on the right.
Inside a page the first card or section starts 24px below the title, sections are 36px apart, and the cards and notes of one section are 14px apart; consecutive untitled cards form one section (owner decision, 2026-11-08, matching General and Appearance). Use `SettingsSection variant="page"`, or `SettingsPageHeader` plus `SettingsPageScope` where the page lays out its own content; sections under a page title are `h3`.
Groups inside a page use the 16px section title. General has no page title; Plugins keeps its own plugin-management header. Not yet migrated (known exceptions): the Shared tasks header (description 8px below), the provider Remote & sharing sub-page header (text back link above the title, 12px description), the Storage worktree-recycle card, the IM default-settings and WeChat panel headings, General → default permission for new tasks, and the shortcut list card (20px padding).
Rows that belong to one item, such as an app connection and its toggle, get their own card instead of a divider between them. When a setting's name and hint sit above a wide control (slider, full-width picker, textarea, list), use `SettingsField`: the control follows the hint 12px below, with no divider in between — dividers separate two settings, never a setting from its own control.
Other content that is not a label-and-control row goes in `SettingsBlock`, which keeps the row padding and divider. Settings → General follows this layout throughout (owner request, 2026-10-17).

### Desktop settings controls

Owner decisions, 2026-11-08. They apply to every Settings page, drawer and settings dialog.

- **Switch or Checkbox.** A setting that takes effect immediately uses `Switch`. An option inside a form, draft or batch selection that only takes effect on Save or Confirm uses `Checkbox` (`components/ui/checkbox.tsx`: native input, 16px, `--text-primary` accent, focus ring, disabled state, `indeterminate` for partial selection). Do not put a Switch inside a Save-gated form, and do not use a Checkbox for an instant setting. Outside Settings too, a checkbox is the shared `Checkbox` inside a `label` row, not a hand-drawn box (owner decision B-10, 2026-11-11); keep `indeterminate` for partial selection. Remaining hand-drawn boxes migrate when touched. Hand-drawn round selection marks (sidebar navigation customize, provider group candidates, group member picker, thread "also send") are checkboxes too and use the shared `Checkbox`; its checked colour is `--text-primary` and its size 16px wherever it replaces a CTA-coloured or 14px box (owner decision, 2026-11-23). **Circle style (owner decision, 2026-11-25):** `Checkbox` `shape="circle"` is only for message multi-select (conversation share selection): each message has a 20px circle — unchecked 1px `--border-default` on transparent, `--text-secondary` border on hover; checked filled `--accent-cta-bg-pure` with a 12px `--accent-pure-cta-fg` check — and the bottom bar's select-all is a 32px pill button (`role="checkbox"` + `aria-checked`) holding a decorative 16px `CheckCircleMark` (unchecked 1px `--text-tertiary`; checked the same fill with an 11px check). Both draw with `CheckCircleMark` from `components/ui/checkbox.tsx`; the circle and the button are pill tier (§5). Nothing else uses the circle. The login consent control keeps its own registered screen-reader design (§16). A checked mark inside a menu is not a checkbox: use `DropdownMenuCheckboxItem` (Select & Dropdown below).
- **Select size.** Single-value fields use the shared `Select`; menus are for actions only, and a DropdownMenu radio group is not a field. Trigger height is 36px by default (`size` default) or 32px (`size="compact"`) in narrow drawers and dense lists; widths are 220px (`width="sm"`), 320px (`width="md"`) or full width for stacked fields (`width="full"`). **Narrow width (owner decision C-12, 2026-11-11):** a short value paired inline with another control in the same row (concurrency limit, weight, the Classical Chinese script next to its style) uses 120px (`width="xs"`). **Inline size (owner decision, 2026-11-23):** a value that sits inside a line of text — plugin UI contribution slots, the provider run-location line, the Cindy device picker — uses `size="inline"`: 24px tall, no frame or fill at rest, the surrounding text colour, 6px horizontal padding, a 12px chevron, and the secondary hover/pressed fill and focus ring; it fits its value, and the caller may only cap it with `max-w-*` so long values truncate; its list fits the options instead of matching the trigger (at least the trigger width, at most 18rem). No other trigger heights or ad-hoc widths: set height with `size` and width with `width`, never with `className`. Options that need a second line use the option `description` (12px `--text-secondary` under the label in the list; the trigger shows the label only) instead of a hand-built `SelectParts` list.
- **Restore default.** A single setting shows the "customized" badge and a 28px pill icon button with a `Tip` (`DefaultOverrideControls`), always to the left of its control and only while the value differs from the default; the icon button alone is `RestoreDefaultButton` (`components/ui/reset-buttons.tsx`) for rows that carry their own customized cue, such as keyboard shortcuts. A page or group reset is `ResetGroupButton` from the same file — `Button` `variant="secondary"` `size="sm"` `compact` with the 14px `RotateCcw` icon and text, an optional `tip` for what is reset, and `loading` — on the right of the page or section title, or in the footer of the form it resets. Not a quiet text button, not a link. Exceptions (owner decision #10, 2026-11-23): the underlined text link inside the composer model flyout stays because the flyout has no room; a "Restore default" option inside a Select's own list and the irreversible usage reset (`tone="danger"`) are not restore-default buttons.
- **Destructive actions.** Irreversible actions (clear memories or caches, delete, remove an account, dissolve a group) use the danger treatment: `Button` `tone="danger"`, with `danger-solid` reserved for the final confirm button of a confirmation dialog — the shared ConfirmDialog (`confirmVariant="destructive"`) or a hand-built dialog with the same cancel + confirm structure. Hand-built confirmations should migrate to ConfirmDialog first; where they stay hand-built, write the button as `variant="primary" tone="danger-solid"` like ConfirmDialog. Buttons outside a confirmation step use `tone="danger"`, never `danger-solid`. Reversible actions such as Disconnect stay secondary. Unbinding follows what it actually does (2026-11-23): an unbind that deletes local credentials or unfinished work (personal WeChat) is destructive; one that only removes this computer's binding and can be redone (Feishu, Telegram, X, a Slack workspace, a plugin library location) stays default. Destructive rows in a menu always use `variant="danger"`. **No outline (owner ruling 2026-11-27, final):** after comparing outlined candidates the owner kept destructive buttons frameless — `tone="danger"` (any variant) and `danger-surface` have no outline; `danger-solid` keeps its filled red face. This is the intended design, not a pending fix.
- **Same setting, same control.** When one setting appears in two places (for example the provider account strategy), both use the same control with the same option order. Known exception (owner decision, 2026-11-09): the group reply and speaking modes stay a segmented control in local groups and a Select in server-backed groups for now.

### Device access pills

正文已移至 [settings-pages.md](./settings-pages.md)，规范效力不变。

### Provider detail header

正文已移至 [provider-settings-ui.md](./provider-settings-ui.md)，规范效力不变。

### Provider dialog disclosures

正文已移至 [provider-settings-ui.md](./provider-settings-ui.md)，规范效力不变。

### Teammate model settings

正文已移至 [settings-pages.md](./settings-pages.md)，规范效力不变。

### Teammate capability page

正文已移至 [settings-pages.md](./settings-pages.md)，规范效力不变。

### Worker creation dialog

正文已移至 [collaboration-worker.md](./collaboration-worker.md)，规范效力不变。

### Get-started guide

正文已移至 [first-run-guide.md](./first-run-guide.md)，规范效力不变。

### Feature introduction (owner-requested, 2026-11-18)

The one-page introduction shown the first time someone uses a feature, built like the get-started
guide's cover and meant to be reused wherever a feature needs one. When to use it, when it appears,
the page structure, how to make its scenes and how to add one: [feature-introduction.md](./feature-introduction.md).
Its motion is the get-started guide entrance: [first-run-guide.md](./first-run-guide.md#get-started-guide-entrance).

### Inputs & Forms

```
input/text
  fill        --surface-elevated
  text        --text-primary
  border      --border-default
  radius      9999px (pill — single-line inputs)
  height      32px (sm) / 36px (md) / 40px (lg)  (DS-4 G1; three sizes, shared 4px step with buttons)
  default     md (36px), the same height as the default Select and Button lg (owner decision C-08, 2026-11-11); pass lg only for a spacious field
  focus       --focus-ring-soft   rgba(65,124,221,0.5)   (50% of #417CDD; opaque border variant = --focus-ring)
              DS-6: approved soft ring; settings retain their local focus-border alias; error styling takes priority. Light/Dark and legacy-theme readability must be verified.
  placeholder --text-placeholder
  error       --error-border / --error-fg
  impl        components/ui/input.tsx
  disabled    60% opacity + ordinary pointer  (new in DS-4; the pre-DS-4 SettingsTextInput had no disabled styling and none of its 6 consumers passed it)
  ivory       surface="ivory" → --settings-input-bg (--surface-card-ivory). Explicit white-panel / nested-card surface (DS-6 decision); elevated remains the default. Preserve local theme overrides.
```

- **Multi-line inputs (textarea) take the 8px inner-control radius — never the pill** (tall frames deform it), whether nested in a container or standing alone in a form (§5 radius scale; single rule, no nesting condition). Implementation: `components/ui/input.tsx` `Textarea`.
- **Existing settings inputs retain their local theme contract** through `SettingsTextInput`, a thin wrapper over `ui/input`. It supplies the historical `settings-input-text`, `settings-input-border`, `settings-input-border-focus`, and `settings-input-placeholder` aliases via `inputClassName`. Their defaults still resolve to Tier-1; explicit local overrides stay local. Generic `Input` keeps the Tier-1 defaults above. Standard error-state border/ring takes precedence over wrapper styles. Do not promote these legacy overrides into global semantic slots or rewrite user theme files. Existing placeholder load-time normalization remains unchanged.
- **Composer-surface inputs keep the composer's local focus-border alias** — the composer input and the composer suggestion panel's own search field (the 「+」面板 in `AtMentionPanel`) take `focus:border-[var(--chat-input-border-focus)]`, a neutral token (30% in the CINDY themes; other built-in themes default to `--text-tertiary`), not the generic `--focus-ring-soft` ring (owner decision 2026-10-29: the blue frame read as off-style). The panel floats directly over the composer input, so it is focused by ordinary mouse flow, and §2 keeps Focus Blue out of the normal interaction flow; a text input matches `:focus-visible` whenever it is focused, so the blue ring cannot be reserved for keyboard-only use there. The generic `Input` keeps the Tier-1 soft ring above; the settings family keeps its local focus-border alias.
- **Search fields (owner decisions #1 A and #2, 2026-11-23).** A single-line search box is `SearchInput` (`components/ui/search-input.tsx`), built on `Input`'s `leading` slot: 32px pill (`Input` sm), 13px text and a 14px lucide `Search` icon placed by the component — callers never position the icon or add `pl-*` themselves.
  Two surfaces: `page` (default) on pages, settings cards, side panels and dialog bodies, with the `input/text` border and soft focus ring above and its own fill token `--search-input-bg` (defaults to `--surface-elevated`, so it looks the same as `Input`; retune every page search box there, never per call site — the wallpaper glass rule in `globals.css` lists it alongside `--surface-elevated`, so over a wallpaper it turns translucent exactly like other elevated fills);
  `panel` inside menus, popovers and dropdown panels, with a transparent fill, the panel's own border and text (`--cmd-palette-border` / `--cmd-palette-item-text`, icon `--cmd-palette-item-meta`) and focus shown only by the neutral `--chat-input-border-focus` border, as for the composer suggestion panel above.
  It keeps the `textbox` role (never `type="search"`) and forwards everything else to the input unchanged — `role="combobox"` and its `aria-*`, `onKeyDown` (IME composition checks, arrows, Enter, Escape stay with the caller), `autoFocus`, `inputRef`, `data-*`. **A clear button is standard (owner decision 2026-11-27): every `SearchInput` shows one at the right end while the field has text, on both surfaces; callers never build their own.** It is hidden when the field is empty, disabled or read-only and takes no space then; it is the square quiet `Button` (28px circle, §14.6 accessible name and `Tip` from `commonUi.clearSearch`) with a 14px lucide `X` in the search icon's colour (`--text-tertiary` / `--cmd-palette-item-meta`), one step darker on hover.
  Clicking it calls `onChange('')` and the optional `onClear`, returns focus to the field, and neither blurs the field on press nor bubbles the click, so it never closes the menu or popover it sits in. Text keeps the right padding the button needs, so long queries never run under it. Escape is not bound to clearing (it closes popovers).
  Extra right-side content goes in `trailing`, which `SearchInput` lays out next to the clear button. Kept as their own patterns: the sidebar inline/conversation search (hover expansion, locked chip), the plugin / skill management header search (expanding, or frosted on the skills page), frameless search rows at the top of a picker panel (the unified model panel, the script-capability picker), and submit-driven find bars (PDF).
  The file browser's file-content search is no longer one of them (owner decision 2026-11-27, so it gets the clear button): it is a `panel` `SearchInput` with its 「Aa」 match-case toggle in `trailing`, keeping its own Escape-to-clear.
- Placeholders must **read as clearly empty** — Silver (`#a3a3a3`) is too prominent against either Card surface (≈5:1 Dark / ≈2.6:1 Light) and reads as real input; forbidden. **Every input surface's placeholder (chat / ask / settings / plan-action-fb) resolves to `--text-placeholder`** (2026-06 G3, archived in `design-decision-log.md`); non-default themes express their own placeholder color by overriding `text-placeholder`.

**DS-6 form usage (approved 2026-09-08)**: use `FormField` for a real field's label, hint and inline validation error; pass its render-function props to `Input` / `SettingsTextInput`. `required` supplies assistive semantics only, never adds browser validation or changes the business rules. Reserve feedback space on fields that can fail and focus/scroll to the first invalid field; dynamic rows keep stable IDs when siblings are added or removed. Service failures remain Toasts. No new Textarea consumer is required.

`Button loading` retains its accessible label and dimensions, exposes `aria-busy`, disables activation, and reuses `Spinner` (static under reduced motion). The form owns the request and a synchronous duplicate-submit guard: actual saving blocks Cancel/Esc/scrim; success closes through the original callback, failure restores editing. Independent connection tests/model fetching remain independent. No change to cancellation, settlement, configuration, secrets or payload contracts.

Every confirmation built on the shared `ConfirmDialog` / provider uses its standard buttons; there is no per-caller presentation switch (maintainer ruling 2026-11-11, C-02 — supersedes the DS-6 two-caller pilot). Confirmation actions keep a 36px minimum height; long labels wrap within the panel and may grow vertically instead of overflowing or truncating. Keep `confirm-btn-*` local styling, default/destructive choice, focus branches and no scrim dismissal. Full Access and plugin-authorization confirmations follow the same buttons; the in-chat Permission card is not a `ConfirmDialog` and keeps its own `palette="permission"` presentation.

**Interaction answer composers (user decisions, 2026-11-10 and 2026-11-16):** Free-text answers, custom-choice answers,
withdrawn-question supplements and plan feedback use one input frame that starts as a single line: while
the answer is empty or fits one line, the text sits beside the existing microphone and submit controls,
centred on them (about 48px tall). Once the answer wraps or contains a line break, the frame expands: the
text takes its own full-width area and the controls move to a trailing toolbar below it, so a multi-line
answer is never squeezed into a narrow column. The expansion holds until the answer is cleared, so the
layout does not flip back and forth while typing (`useAnswerComposerExpanded`). Submission uses the main
composer's paper-plane glyph, with the actual action retained in localized accessible names and
Desktop tooltips. Multi-select custom input has one submit control, not a second footer submit.
Question navigation, close/skip, validation, voice finalization and approval semantics stay unchanged.

### Typography roles and control pairing (DS-11)

- Title weights: every dialog and prompt title is 500 (§3 「字重阶梯」) — ConfirmDialog and provider/MCP form titles 18/500, compact prompt titles 15/500. Sizes come from the §3 Hierarchy roles; different roles are not interchangeable merely because their font size matches.
- Pair Button md with Input sm and Button lg with Input md (the Input default) — equal heights. Input lg is for spacious fields and must be passed explicitly; Button has no matching size. Size names are local component APIs, not a shared ordinal scale.
- Font aliases may share default numbers while retaining separate line-height/role contracts. Preserve public aliases; do not globally round historical unitless line heights or optical spacing. On affected surfaces, UI text consumes `--text-*`, and line boxes must grow with font settings.
- FormField reading hints use `--form-field-hint` (defaults to `--text-secondary-mid`; One Dark Pro / Solarized Light override this help role only): in Cindy Light/Dark this is the description ink tier (70% / 66%, §15.16), and other built-in themes get stronger reading contrast. Preserve `text-tertiary` metadata and `text-placeholder` roles.
- MarketCard's title is a registered frameless text action inside the existing card content, with an independent inset focus indicator. The title button supplies keyboard detail access without nesting the card's Clone/manage controls inside a button. Mouse card selection remains available.

### Select & Dropdown

- **Trigger**: same as a single-line input — pill (9999px), Card bg, 1px Board border, carrying the current value + a chevron.
- **Panel**: a container — 12px radius, 1px Board border; padding depends on the panel type. Select listbox panels use 6–8px padding, the Card bg (`--surface-elevated`) and the soft, downward `--shadow-menu` elevation in both modes, like the menu panels below (owner decision, 2026-10-18; supersedes their former no-shadow rule and does not authorize shadows on in-page controls). Existing local panel-color aliases remain compatible.
- **Menu and popover panels** (shared defaults in `components/ui/dropdown-menu.tsx` / `popover.tsx`): 12px radius and the registered floating-layer shadow `--shadow-menu` (a §6 token-gated exception) written as `shadow-[shadow:var(--shadow-menu)]` — the untyped `shadow-[var(--shadow-menu)]` is a Tailwind shadow *colour* and renders no shadow. `DropdownMenuContent` / `DropdownMenuSubContent` use `p-1`, `bg-[var(--cmd-palette-bg)]`, `border-[var(--cmd-palette-border)]` and `text-[var(--cmd-palette-item-text)]`; under Cindy themes that surface is glass (`--surface-translucent-overlay` + `blur(6px)`, globals.css), and on Windows (`html[data-platform='win32']`) every `--cmd-palette-bg` surface is opaque with no `backdrop-filter` (§15.12). `PopoverContent` stays opaque `bg-popover`. `DropdownMenuSeparator` uses `--cmd-palette-border`. Row highlights use the 8px inner tier.
- **Menu checkmarks** (`components/ui/dropdown-menu.tsx`): a row whose check marks membership in a set is `DropdownMenuCheckboxItem` (menuitemcheckbox + `aria-checked`), never a plain item with a hand-drawn ✓. The default shared leading check column applies; a menu with an approved trailing selection slot passes `indicator="none"` and keeps drawing its own mark there — currently only the sidebar machine switcher, whose row click still selects only that computer and whose trailing box toggles multi-select (owner decisions 2026-07 / 2026-08-13).
- **Menu text** (`components/ui/dropdown-menu.tsx`): option rows (Item / CheckboxItem / RadioItem / SubTrigger) are `text-14` / `leading-[1.43]` (32px row with `py-1.5`) on `--cmd-palette-item-text`; shortcuts `text-12` / `leading-[1.33]` / 400 on `--cmd-palette-item-meta`; group labels `text-12` / 500 on `--cmd-palette-item-meta`; destructive rows `variant="danger"` on `--error-fg`; disabled rows 50% opacity. The text colour is the same at rest and on hover. The highlighted (`data-menu-active` / `data-[highlighted]`), checked or open row is 500 (§3 ladder) and its default-stroke Lucide icons go 1.5 → 2, on `--motion-instant` / `--motion-ease-out` (instant under reduced motion). Width never moves: row text and `truncate` spans reserve the 500 width with an invisible zero-height `::after` copy (`content: attr(data-menu-label) / ""`, so `textContent`, typeahead and the accessible name are unchanged), and the shared panels lock their laid-out width (`lockMenuWidth`, re-measured on content, window, image or font changes). A caller's own text colour, weight or inline width wins.
- **Menu hover highlight** (`components/ui/dropdown-menu-highlight.ts`): one `--sidebar-item-hover` surface (8px) per `DropdownMenuContent` / `DropdownMenuSubContent` glides between rows with `transform`; the row nearest the pointer anywhere in the panel wins, and separators do not interrupt the glide. Entering fades in from the checked row (or the target), leaving fades out; keyboard follows Radix's highlighted item, and an open SubTrigger stays highlighted while its submenu is in use. Motion: `transform` / `opacity` on `--motion-instant` / `--motion-ease-out` (fade-out `--motion-ease-in`), size snaps, no slide under reduced motion. Danger rows use the same grey layer. Rows whose caller sets its own `focus:` / `hover:` / `data-[highlighted]:` / `data-[state=open]:` background keep it and get no layer; `hoverHighlight={false}` restores per-row fills. Sidebar menus (`features/cc-agent/sidebar/menuStyles.ts`: `MENU_ITEM_CLASS` / `MENU_ROW_CLASS` = `h-8 gap-2`, triggers `cursor-pointer`) use the same highlight.
- **Segmented rows in the sidebar display settings menu** (owner decision, 2026-11-28; `SegmentedMenuRow` in `features/cc-agent/sidebar/SidebarFilterPopover.tsx`): a setting with two to five short choices (list mode, task status, row style, recent activity) is the shared `SegmentedControl` (`fullWidth`) inside a menu row, not a submenu, so it changes in one click and every choice stays visible. Every row of that 288px menu is an icon column plus a content column. A bar row (task status, row style) is the row icon followed by an `xs` control that fills the content column, with no visible label: the bars start on the same vertical line as the row labels, share one width and never wrap in longer locales; the label is the row's accessible name and the icon's `title`. A block row fills the whole row (`sm` for the list mode at the top; `xs` under a `DropdownMenuLabel` for recent activity). The row is still a `menuitem`: Up/Down reach it, Left/Right change the choice, Enter, Space or a click on its icon moves to the next one, and a mouse click on a segment leaves focus on the row (`preserveMouseFocus`). Segmented rows take no glide highlight and show the `--focus-ring` outline on the control when the keyboard reaches them. The row style here and 「列表样式」 in Appearance settings are the same setting with the same control. This covers that menu only: other menus keep submenus, and a field elsewhere is still a `Select`.
- **Form-field Select panel width must bind to the trigger width** — never narrower or wider than the control that opened it, except for the explicitly scoped device-navigation treatment below. Radix Select: `position="popper"` + `width: var(--radix-select-trigger-width)`; other primitives measure the trigger. Ordinary form fields retain this equal-width invariant.
- **Model picker on a narrow field**: the model picker is a rich list. The model-groups "添加来源" row sizes its panel to the content and trigger (`ModelSelector fieldPanelWidth="content"`). In the IM settings “项目与模型” section, the source rail and readable model names need room independently of the field. That panel uses the larger of 440px and the field width, with a 12px viewport gutter on each side (`fieldPanelWidth="readable"`). Other model fields retain their trigger-width default. In this IM panel, each model name gets a wrapping line of its own, with supplementary details below.
- **Compact Cindy device navigation (sidebar only)**: the trigger fits the device label, unread indicator and chevron, retaining its 24px height. The sidebar's remaining row area opens chat. The teammate chat header no longer carries this picker (2026-10-21): computers are listed in the 近况 popover instead. Long labels truncate and retain their full title. Its listbox is independently 256px wide, capped by the available viewport width, so device names, offline state and unread indicators remain usable even when the trigger says only “本机”. This exception belongs to `CindyDevicePicker`, not the shared Select default or other dropdowns. Keep the existing Radix keyboard/focus behavior and theme tokens. Hit-target and layout regression: `pnpm ui:check --page device-picker --case all --theme all --locale all`.
- **Select listbox option rows** (Select only; dropdown menu rows follow the Menu entries above): rows use the **8px inner radius** (§5 — inner tier inside the 12px panel) and join the **shared menu hover highlight** above — one `--sidebar-item-hover` layer per listbox viewport, same glide, fade and reduced-motion behaviour as the dropdown menu (2026-10-18, supersedes the per-row `--surface-hover` / chip fills). The saved value is marked by its checkmark (and the caller's checked text style), not by a fill; Radix's highlighted option drives the layer for keyboard browsing, including the saved option it focuses on open. Rows whose caller sets its own `data-[highlighted]:` / `hover:` / `focus:` background keep it and get no layer. Group labels, wrapped descriptions, disabled options and scroll controls retain their semantics.
- **Shared Select implementation (2026-10-18)**: use `components/ui/select.tsx` for single-value fields; rich/grouped consumers use its `SelectParts` compound API (`components/ui/select-parts.tsx`) instead of importing `@radix-ui/react-select` directly. Both share the trigger, panel, highlight and motion. Trigger rings use `focus-visible`, including after menu dismissal: mouse-only open/close leaves no ring, keyboard navigation keeps a visible focus cue. Radix still owns focus return, keyboard/typeahead, cancellation and value callbacks. Panel entry/exit reuses §14.4's `float-in` / `float-out` with the transform origin following the actual top/bottom collision placement; reduced motion removes the animation.
- **Composer dropdown rows — one contract with the shared menu** (2026-10-04, supersedes 2026-07-22): the composer menus keep their own shells — MorphPopover (model / permission / + / agent; §14.4 container transform unchanged), the / and @ lists, the bot-chat @ list and the settings search results — but use the shared menu row parts from `components/ui/menu-row.tsx`: `COMPOSER_MENU_ROW` (8px radius, menu text / weight / motion), `menuRowAttrs`, `withMenuLabels`, and one glide highlight per panel (`useMenuPanel` + `MenuHighlightLayer`, the same `--sidebar-item-hover` layer as the shared menu).
  Rows inside a glide panel set no `hover:` / `focus:` fill of their own (rows that sit outside any glide panel — the model config card's engine rows, the legacy follow-session and "manage providers" rows — keep a `hover:bg-sidebar-item-hover` fill in the same grey). The selected row is marked by a check + 500 and never by a fill — permission, + and agent menus.
  **The model menu is the one exception** (owner ruling 2026-10-04, keeping the 2026-08-13 ruling): its chosen row keeps a whole-row `--sidebar-item-hover` fill with no check (`data-[menu-active]:bg-transparent`, so the fill steps aside while the glide layer covers that row instead of stacking two translucent layers), the model name stays 500, and the effort / follow-session rows keep their fill and existing check; it still takes the shared glide highlight and the glass panel.
  Danger-tier orange / blue tints the **text only**. Lists that keep focus in a text input (/, @, bot @, settings search) stay focus-in-input: the highlight follows their own current index (`data-menu-current` or `aria-selected`) through `attachMenuHighlight`'s `current` option, never Radix focus. Panels: MorphPopover ends on `--menu-panel-surface` (the shared menu's glass under Cindy themes, opaque on Windows) with `--cmd-palette-border` and `--shadow-menu`; the / and @ lists and the model config flyout use the same 12px panel and `--shadow-menu` (the softer `--cmd-palette-shadow` stays for the command palette and the / tooltip).
  Group labels use the shared label (12 / 500 / `--cmd-palette-item-meta`). When touching any composer menu's row styles, change them through `menu-row.tsx` — never one menu alone.

FormField → Select forwards descriptions, required/error semantics, and the semantic error border; native browser required validation remains opt-in by the business form.

### Badges

Owner decisions, 2026-11-23 (component audit #3–#5). Badges are short labels and counts that do nothing when clicked; a clickable chip is a Button.

- **Badge** (`components/ui/badge.tsx`). A pill (§5) whose text keeps its own case: there is no uppercase or extra letter spacing. `size="sm"` is the default: 11px/500, line height 1.45, 8px sides and 1px top and bottom, about 18px tall. `size="xs"` is for compact rows, Chinese and Latin alike: 10px, line height 1.4, 8px sides, 16px tall. A Chinese badge that reads cramped gets wider sides, not a larger font or a taller pill, and its text stays at or above the 10px floor of §3 (owner decision, 2026-11-26). `size="md"` is for chat cards such as the plan review bubble: 12px, line height 1.5, 8px sides and 2px top and bottom. Tones: `neutral` (default) is a `--surface-chip` fill with `--text-secondary` text; `outline` is a 1px `--border-default` border with no fill and `--text-secondary` text, and the border takes 1px of the vertical padding so both looks are the same height; `accent` (`--accent-cta-bg` / `--accent-pure-cta-fg`) is the model picker's promotion badge; `plan` keeps the plan review bubble's `--plan-bubble-badge-*` theme slots. `mono` switches to the code font for commands, versions and identifiers; `icon` takes a 10–12px leading glyph that screen readers skip. Callers pass only layout through `className` (`ml-auto`, `max-w-*`, `truncate`), never their own size.
- **CountBadge** (same file). A round count, 16px tall and at least 16px wide, 10px/500 tabular figures, 4px sides. `tone="neutral"` is `--surface-chip` with `--text-primary`; `tone="unread"` is the IM unread blue (§2 Bot Unread Badge) and is used for nothing else. Counts above `max` (default 99) show as `99+`. Screen readers skip the visible number and read `label` instead, which also becomes the hover title — write the full meaning, such as "3 unread messages". A zero count renders nothing.
- **Kbd** (`components/ui/kbd.tsx`). A keyboard shortcut keycap with the registered 4px keycap shape (§5 Step 1), a 1px border, 11px/400 text in the keycap's monospace font and 6px × 1px padding. `tone="default"` sits on ordinary surfaces (`--border-default`, `--perm-code-bg`, `--text-secondary`); `tone="onSolid"` sits inside the filled Allow action of permission-style confirmation cards and follows that button's slots (`--perm-allow-kbd-border`, `--perm-allow-kbd-bg`, `--perm-allow-btn-text` at 70%).

### Toast

DS-11: short notifications keep their pill frame. When the rendered message or action wraps, the outer frame is a 12px content container (`rounded-xl`, §5), using the same background, border, status icon colors and padding. The whole notification fits within the viewport with 16px gutters; long URLs wrap, source identity stays visible, and action text remains complete. Hover and keyboard focus independently pause auto-dismiss until both have left. This classification follows the user’s 2026-09-15 instruction to prioritize the actual Cindy UI; final visual acceptance is recorded separately.

The GitHub Star invitation uses the same Toast store and container with an optional heading,
star icon, close control and wrapping end-aligned action row. Persistent invitations use the
12px content-container shape. The invitation stays at the top right, below window controls,
with the shared `--shadow-menu` elevation; loading and success retain that corner and avoid
the centered toast stack's movement animation. The action uses the standard contrasting CTA
Button (user decision, 2026-11-09), and dismissal uses its quiet tone. Eligibility and dismissal semantics are documented in
[GitHub Star prompt](../product-rules/github-star-prompt.md).

### Error notices

错误提示统一使用中性浮层底色、默认细边框、12px 圆角和小尺寸红色状态图标；正文使用正常文字颜色，不铺大面积红底。先说明发生了什么，再给出恢复操作，技术错误详情默认折叠。桌面复用 `ErrorNotice`，移动端复用同名组件并保持至少 44pt 的操作热区。表单校验、危险操作与状态徽章保留各自语义色。

独立的加载、保存、执行失败，以及需要用户处理的错误横幅使用卡片；字段校验、列表项状态、消息发送状态、已经有完整容器的内嵌工具结果、短暂 Toast（含 §4 Inputs & Forms 的表单提交服务失败）与系统原生警告保留原有形态，避免卡片套卡片。手机采用紧凑布局：标题下集中放说明，右上角关闭代替重复的「忽略」按钮；重试、Fork 与详情入口共用可换行的操作区。按钮面板操作文字为 15/20、500、`textPrimary`，视觉底板最小 36pt，但点击热区保持至少 44pt。卡片内边距与说明到操作区的间距为 16pt，标题与说明间距为 8pt；按钮内水平留白 12pt、图标到文字 8pt，操作间距 12pt。空间不足时自然换行，不压缩留白来强塞一行。说明与详情入口为 13/18 常规字重、`textSecondary`，红色只用于 `statusError` 图标。iOS 原生表单使用 `NativeErrorNotice`，由现有 Section 提供卡片底色与圆角，不再嵌套第二层边框，保留 SwiftUI 文字换行。错误卡片不自行增加重试、自动恢复或 Fork 的适用范围。

历史恢复操作命名为「在新任务中继续」，说明会保留对话记录与原任务，以及需要重新发送刚才的消息。图标必须与消息 Fork「开启一个新任务」入口一致，使用 `Split`；不使用侧栏新建任务的 `SquarePen`。

### Download progress

Desktop 上用户能看到的下载与安装进度（工具、运行时、模型、更新包、插件、Skill、壁纸等）统一使用
`components/ui/download-meter.tsx` 的 `DownloadMeter`，数据为 Main 端统一生成的 `DownloadProgress`
（工程约定见 [校验下载](../dev-rules/verified-downloads.md)「下载进度与界面」）。不在业务界面里另画进度条或
自行格式化字节、速度与剩余时间。起因：2026-11-17 GitHub CLI 安装在重试与龟速时进度停住且无任何说明，
用户以为卡死。

- 三行结构：第一行名称（`text-12`、`--text-secondary`，过长截断）与整数百分比（`--text-tertiary`、
  等宽数字，只有真正完成才显示 100%）；第二行 4px 胶囊进度条，轨道 `--surface-chip`、填充
  `--text-primary`，宽度变化 150ms；第三行 `text-11` `--text-tertiary`，左侧状态、右侧速度与剩余时间。
- 进度条不动时必须有文字说明：传输中左侧显示「已下载 / 总大小」，重试显示原因（网络较慢在换连接、
  连接中断、超时、服务器繁忙）且右侧显示第几次尝试，校验、安装、排队、准备、暂停各有状态文字。
  速度与剩余时间只在传输中显示，避免停住时残留旧速度。
- 失败时状态行换成失败说明（`--error-flat`），填充改为 `--remote-status-failed`，并隐藏百分比。
- 不使用循环动画或不确定进度的动效；大小未知时只显示已下载量。暂停、继续、取消等操作由所在界面
  提供，组件只负责显示。`role="progressbar"` 的 `aria-valuetext` 汇总状态与速度，供读屏读取。
- 启动页、壁纸缩略图等已登记的品牌或特定界面若不能放入三行结构，保留原外形，但状态文字与数值
  仍取自同一份 `DownloadProgress` 和本组件导出的格式化函数。
- **圆环形态（2026-11-18 用户裁决，插件更新）**：进度出现在按钮大小的位置、放不下三行时，用同文件
  的 `DownloadRing`。圆环几何沿用 `ContextCapacityRing`（2.5px 线宽、圆头、从 12 点顺时针），
  轨道 `--msg-tool-card-border`、填充 `--text-primary`；尺寸 16（列表行）、20（卡片）、24（详情头部）。
  圆环旁只写步骤（`downloadProgress.phase.*`，有空间时重试写原因），**不画百分比、字节、速度或剩余
  时间**——用户裁决「有圆圈表示就够了」；这些数值只进 `aria-valuetext`。下载完成后的校验、安装阶段
  圆环保持满格，由文字说明；完成时换成对勾与 `--card-status-done` 文字，失败时填充改
  `--remote-status-failed`、文字 `--error-flat`。失败原因与失败提示同一句话：详情页与「全部更新」弹窗直接显示，卡片写
  「更新失败／安装失败」，原因放在悬停提示与读屏文本里。卡片上的失败状态旁用带 `Tip`「重试」的正方形图标
  按钮（§4 Icon buttons），使失败状态不比原按钮宽；详情页与弹窗空间够，用文字按钮。同样不旋转、不循环。使用方：插件市场的手动
  安装与更新——已装插件卡片与详情页、「全部更新」弹窗、市场卡片和市场详情页；首装完成写「已安装」，
  更新写「已更新」。

### Dialog & Modal

Reference implementation: `apps/desktop/src/renderer/components/ui/confirm-dialog.tsx` (the shared confirm dialog); new dialogs reuse its structure — do not invent a parallel one.

**Cindy Make preflight exception (owner decision, 2026-09-20):** this progress dialog uses a top-right × instead of a footer Cancel. The header stays visible while the report scrolls. The ×, Esc and scrim all open the same confirmation, with live copy distinguishing environment preparation, source preparation, upstream search and finished checks. Explain that stopping shared preparation also stops its Settings projection and that prepared resources are kept. Creating the build session temporarily disables dismissal. This exception supersedes the general closing-affordance rule below only for `CindyMakePreflightDialog`; the request form keeps its existing footer.

- **Overlay** (blur added 2026-10-04): every modal scrim — Radix `Dialog.Overlay` / `AlertDialog.Overlay`, hand-built scrims and the Radix side drawers — uses the shared `.modal-scrim` class (`styles/globals.css`): `--overlay-modal` (Light `rgba(0,0,0,0.5)` / Dark `rgba(0,0,0,0.7)`) plus a 4px `backdrop-filter` blur of whatever is behind; on Windows (`html[data-platform='win32']`) there is no blur, the same reason as the opaque Windows menus (§15.12). Desktop attachment previews float over the same `.modal-scrim` (2026-11-03, see [attachment-preview.md](attachment-preview.md)); unlike dialogs, a click on their scrim closes the preview. Never write a scrim colour, `bg-black/…`, `backdrop-blur-*` or an inline background at the call site; to change depth or blur, change the token or the class, never one component. Not dialogs and therefore not covered: the lighter whole-window closing dim in `WindowControls.tsx`, the tap-to-close drawer scrims in `DiffPanelShell.tsx`, the login brand canvas (§16) and the transparent click blocker behind anchored plugin-card prompts.
- **Tooltips, menus and popovers opened inside the modal**: their shared defaults sit above all dialogs — `Tip` on `tooltip` (10011), `DropdownMenu` / `Popover` / `MorphPopover` / `Select` on `dropdown` (10010) — so do not pass `contentClassName`, `secretTipContentClassName` or a `z-*` class to lift them. Dialog layers (`modal` / `modal-raised` / `modal-nested`) and the rules for nested dialogs are in §6.
- **Container**: every centered modal panel uses the shared `.modal-panel` class — 12px radius, `--confirm-bg` Card fill, 1px Board (`--border-default`) outline and the registered floating-layer shadow `--shadow-menu` — the same shadow as menu panels (2026-10-04 unification; user ruling the same day). Bot dialogs share this panel; the Bot zero-shadow rule covers in-page Bot surfaces, not modal panels. Call sites never add their own radius, background, border colour or shadow, nor glass `--cmd-palette-bg`; they set only width, position, padding (16px `p-4` by default) and layout. Radix side drawers keep their own edge-anchored panel and share only the scrim. Guard: `__tests__/modalSurfaceContract.test.ts`. Width: confirm/notice dialogs ≈ 400px (`max-w-[400px]`); dialogs with inputs/forms may widen to ≈ 460px and shrink with the viewport (`min(460px, 100vw-32px)`). The DS-6 multi-runtime provider and MCP forms use 600px with the same 16px viewport gutters and a scrollable body capped within 88vh.
- **Title / description**: `--confirm-title` / `--confirm-desc`; title medium (500), description regular (400).
- **Buttons**: pill (9999px); primary = inverse neutral (`--confirm-btn-primary-*`, not an automatic CTA assignment), secondary/cancel = outlined (`--confirm-btn-secondary-*`, transparent fill + Board border); footer `justify-end`.
- **Button order** (maintainer ruling 2026-11-11, C-01 — supersedes the DS-6 primary → third → Cancel order): Cancel is leftmost and the primary action rightmost, in both visual and DOM order. With three actions the order is Cancel → optional third action → primary (e.g. Cancel / Don't Save / Save). This applies to every modal footer, including hand-built dialogs; `ConfirmDialog` has a single fixed order with no per-caller switch.
- **Plugin form dialog layout** (user decision 2026-11-23, after the stacked first version read as wordy and grew with every list item): `GhostFormDialogHost` has a fixed height `min(640px, 85vh)` at the 600px form width; the body scrolls between two full-width hairlines, so adding or removing list items never resizes the dialog. Fields are label-left rows (104px label column, control on the right; one column below 520px) built on `FormField`. List items collapse to one-line summaries — the first text field as the title, the selected select/choice labels as the detail — and only one item is expanded at a time; a new item opens expanded. Required fields reserve no feedback space: they are checked on Save, which expands the first incomplete item and shows the inline error there (a collapsed incomplete item shows an error-coloured summary).
- **Plugin form dialog extra action** (user decision 2026-11-23): `GhostFormDialogHost` (the plugin `form` capability) may carry one extra action such as 「删除关注」. It does not commit the form, so — like the wizard back navigation below — it sits alone at the left of the footer (`Button variant="secondary"`, `tone="danger"` when destructive), while Cancel → primary stay right-aligned per the button-order rule above. When the plugin asks for the trash icon it is the square icon-only form of that button (36px, `Trash2` 16px) with the action text as its `Tip` and accessible name. Deletion confirms through the shared `ConfirmDialog` with the destructive variant. Other dialogs keep the C-01 order, including a third action that is part of committing (e.g. Don't Save).
- **Focus on open**: dismissible forms focus their primary input. Ordinary AlertDialog confirmation retains Cancel by default; explicit `autoFocusConfirm` focuses the primary action, while a required typed confirmation takes precedence. Initial focus does not depend on button position. Enter activates the focused button (or confirms from a satisfied typed-confirmation field) and Esc cancels unless an action is in progress.
- **Closing affordance** (made explicit 2026-07-30, updated 2026-09-24, widened 2026-10-01): **no modal dialog closes by clicking the scrim** — forms, wizards, catalogs, confirmations, progress/copy dialogs and informational notices alike, on desktop and mobile. They close only through their own controls (Cancel / primary action / ×) or Esc (Android: Back). A mis-tap outside must not discard an in-progress form or interrupt a flow. Radix `Dialog.Content` therefore always sets `onPointerDownOutside={(event) => event.preventDefault()}`; hand-built scrims only block the click (and keep focus inside so Esc still works). Not covered: media viewers (lightboxes), anchored menus and plain popovers, side drawers and mobile bottom sheets, which keep tap-outside dismissal — except an anchored input popover holding text the user is typing (e.g. the plugin card prompt popover), which follows this rule and closes only via Cancel / Send / Esc. Dialogs with a Cancel action carry **no top-right × close icon** — a × coexisting with Cancel is a spec violation. Confirm-tier dialogs built on AlertDialog (ConfirmDialog) also do **not** close on scrim click. The provider form has no ×; its image-generation interruption confirmation remains a separate business layer. Implementation and regressions: [AddProviderWizard](../../apps/desktop/src/renderer/components/settings/AddProviderWizard.tsx), [provider dialog tests](../../apps/desktop/src/renderer/components/settings/__tests__/CustomProviderDialogAccessibility.test.tsx).
- **Multi-step dialogs / wizards** (registered 2026-07-30, first consumer: Add-Provider wizard): the step indicator lives in the header row (round numbered chips — current step solid `--accent-cta-bg` with `--surface-on-card` text, completed steps ✓ on `--surface-chip`, upcoming outlined `--border-default`). Footer: **back navigation ("← 上一步") is a left-aligned bare text button** (`--text-secondary`, 13px/500, no background — the §5 bare-text-button exemption, no radius) — navigation is not a commit action and must not sit inside the right-aligned pill group; commit actions (取消 / 下一步 / 完成) remain right-aligned pills per the button rule above. Catalog/list steps put the scrollable region between **two full-width 1px `--border-default` hairlines**, with permanent entries (e.g. 自定义端点) pinned below the scroll region, always visible. Width matches the custom-provider form dialog (600px, `min(600px, 100vw-32px)`) so the two provider dialogs read as one family; height is capped at `min(640px, 85vh)` — on large displays a catalog dialog must not stretch toward full-screen height (2026-07-30 ruling).

- **Add-Provider first-step exception (owner-approved, 2026-10-30):** on the initial provider-catalog step only, replace the header step indicator with the right-aligned, always-visible bare-text action “没找到？添加自定义”. Use the theme's existing `--accent-emphasis` foreground, medium weight and a persistent underline so it reads as an action rather than muted descriptive text; preserve its visible keyboard focus treatment. It opens the existing custom-provider form through the existing dialog handoff. Do not render a second custom-provider entry below the scroll region; the footer contains only Cancel. Preserve the catalog ordering, filtering, scrolling and both full-width dividers. Subsequent steps retain the registered header step indicator and back/commit navigation above. Other wizards, dialog dimensions and shared modal/focus rules are unchanged. This exception records the user-approved layout for PR #8073 and the subsequent review's emphasis correction; it does not authorize general removal of wizard progress or permanent catalog entries.

### Tabs

Pill-shaped tab selectors (e.g. the Claude | Codex agent switch on the new-session screen) are segmented controls: use the shared `SegmentedControl` described in the next subsection. The former Tab Pills rule (active `--surface-chip` fill, transparent inactive) was superseded by the 2026-09-25 v8 decision; do not hand-roll chip-filled tabs or build tabs out of `Button`s.

**Underline tabs (owner decision #9, 2026-11-23).** Page-level navigation that swaps a whole page's content — the plugin detail sections and the Shared tasks page in Settings — uses `UnderlineTabs` (`components/ui/underline-tabs.tsx`): a row of 13px/500 labels over a 1px `--border-default` baseline, 24px apart; the selected tab is `--text-primary` with a 2px `--text-primary` underline, the others `--text-secondary` (hover `--text-primary`); an optional count follows in 11px `--text-secondary`; the focus ring is `--focus-ring`. It is a `tablist` of `tab`s with `aria-selected` / `aria-controls`; the caller renders each `tabpanel` with `aria-labelledby`. Tab enters at the selected tab; Left/Right (mirrored in RTL) wrap across enabled tabs and select them, Home/End go to the first/last; a whole-strip `disabled` keeps the selection. Settings, filters and in-panel switches stay `SegmentedControl`; the Shared tasks dialog's full-width button tabs are not yet migrated.

**Underline on the divider (owner rule, 2026-11-28).** Every underline-style tab row — `UnderlineTabs` and the `SegmentedControl` rows restyled as underline tabs — draws the selected 2px underline on the container's 1px divider: its bottom edge meets the divider's bottom edge, covering the line, with no gap above it. `UnderlineTabs` does this with `-mb-px` / `border-b-2`. The two restyled rows, the Skills catalog source tabs (`skill-catalog-source-tabs`, `SkillhubHomeView`) and the plugin catalog heading tabs (`plugin-catalog-heading-tabs`, `CatalogHeadingTabs`), keep explicit `height` / `optionHeight` (40/40, 44/44): they remove the track padding and plate, so a density preset would only shorten the tab and lift the underline off the divider. They stay `SegmentedControl` rather than `UnderlineTabs` because the heading tabs need a 15px label, a reserved count slot before the market total loads and horizontal scrolling at narrow widths, which `UnderlineTabs` does not provide.

### Desktop segmented controls (v8 appearance / v9 layout, owner-approved 2026-09-25)

- All Desktop segmented settings, form choices, filters, Agent selectors and pill navigation use `components/ui/segmented-control.tsx`. `VendorSegmentedSwitcher` only adapts Agent labels/icons. Mobile and native iOS controls are outside this decision.
- The borderless pill track uses `--segmented-track`: a black alpha overlay, Light 6% / Dark 25%, applied to its background only. It adapts to the parent surface; pure black cannot be darkened further. Do not add a compensating track border.
- The selected pill uses component-local `--segmented-selected-bg`, `--segmented-selected-border` and `--segmented-selected-shadow`. CINDY Light: #FDFDF8 / #F0F0EB; Dark: #353535 / #3B3B3B. Its narrowly scoped two-layer shadow is the owner-approved elevation exception; it does not authorize shadows on other controls. Other themes default to their elevated/border aliases and may override these roles without changing saved theme files. DTCG is the numeric source.
- Preserve each scene's density, icons, counts, configured markers, width and callbacks. Options stay on one line. Let the description wrap first; when the row cannot fit, move the whole control to the next line. At extreme widths the outer viewport scrolls horizontally while the track remains one line. Settings default to a 32px track / 28px option; compact Diff retains 24px / 18px visuals with a transparent minimum 24px target. Do not force all scenes to one fixed dimension.
- **Density presets (owner decision #8, 2026-11-23; four presets final, 2026-11-28).** Size comes from `density`, not numbers: `xs` 24/18, `sm` 28/24 (dense lists, cards and compact panels), `md` 32/28 (default: settings, forms and dialogs), `lg` 38/32 (page-level navigation and large form rows beside ~40px inputs). `xs` has two uses only: a compact toolbar where the control shares a row with 24px controls (the Review diff view-mode toggle), and a compact menu row where it sits beside a 12px icon (the sidebar Display settings menu, #13544; owner-confirmed 2026-11-28); elsewhere use `sm` or larger. Explicit `height` / `optionHeight` are deprecated; the only call sites that keep them are the two underline-style rows in **Tabs** above. New code uses `density`.
- A single measured plate moves with selection over `--motion-base`; hover/press use `--motion-fast`, and press scale is .98. Reduced motion disables movement/transitions. Resize and label changes realign the plate. Unselected text uses `--segmented-option-fg`, hover fill uses `--segmented-hover-bg`, selected/hover text uses `--text-primary`; all options keep weight 500. Disabled controls preserve selection at reduced opacity and cannot activate; focus remains independently visible.
- Settings and filters use `radiogroup` / `radio` / `aria-checked`; panel navigation retains `tablist` / `tab` / `aria-selected`. Tab enters at the enabled selected option (or first enabled option); arrows wrap, skip disabled choices and respect RTL. Home/End select the first/last enabled option; Space/Enter retain native button activation. A missing preset remains unselected.
- Fixed short alternatives with one shared setting can share a track (Telegram reply modes, import dimensions, authentication mode/flow). Dynamic account/object lists, wrapping API protocols, popup actions, multi-select and ordinary document/sidebar tabs remain separate controls.

### Usage History Charts

The usage heatmap (`UsageHeatmap`) and daily-token bars (`UsageTokenBars` / `UsageSeriesBars`) encode dates and quantities; clicking a mark filters by date. They are data marks, not pill buttons: the coloured mark's 2px corners are the §5 members `usage-heatmap-day` / `usage-token-bar` (the registration covers the mark, not its hit region, legend, container or tooltip), the bounded hover / focus / selection emphasis is registered in §5 Interaction constraints with its motion in §14.4, and the colours are the §2 Usage History registration. Geometry (cells, bars, gaps, windows), hit targets, tooltips, selection fade and outline, the date field and the provider 「远程与分享」 reuse are specified only in [usage-history-charts.md](./usage-history-charts.md). None of this lets other components borrow chart radii, colours or emphasis.

### macOS menu bar quota panel (owner-approved v6 prototype, 2026-10-11)

正文已移至 [macos-menu-bar-quota.md](./macos-menu-bar-quota.md)，规范效力不变。

### Desktop chat and operation authorization

正文已移至 [chat-surfaces.md](./chat-surfaces.md)，规范效力不变。

### Desktop chat content width

正文已移至 [chat-surfaces.md](./chat-surfaces.md)，规范效力不变。

### Desktop message nav rail preview

正文已移至 [chat-surfaces.md](./chat-surfaces.md)，规范效力不变。

### Desktop chat threads

正文已移至 [chat-surfaces.md](./chat-surfaces.md)，规范效力不变。

### Desktop group progress strip

正文已移至 [chat-surfaces.md](./chat-surfaces.md)，规范效力不变。

### Group Cindy waiting-for-a-computer card

正文已移至 [chat-surfaces.md](./chat-surfaces.md)，规范效力不变。

### Desktop hidden channel records

正文已移至 [chat-surfaces.md](./chat-surfaces.md)，规范效力不变。

### About: harness versions

正文已移至 [settings-pages.md](./settings-pages.md)，规范效力不变。

### User-attached long images

正文已移至 [chat-surfaces.md](./chat-surfaces.md)，规范效力不变。

### Remote connection V2 topology

正文已移至 [remote-connection-v2.md](./remote-connection-v2.md)，规范效力不变。

## 5. Layout Principles

### Spacing System

- Spacing values come from the generated DTCG spacing source, not a hand-written list: `space-*` in `packages/design-tokens/src/reference/foundations.json` → `--space-*` in `generated/tokens.css`; `tailwind.config.ts` maps every Tailwind spacing class to these variables, and the layer guard (`scripts/shared/design-layer-report.mjs`) accepts the same `semantic.foundations.space-*` source. The scale is on a 4px base (`space-1` = 4px) with `space-px` (1px) and the half steps `space-0_5` / `1_5` / `2_5` / `3_5` (2 / 6 / 10 / 14px), up to `space-96` (384px); 28, 36, 44 or 56px are ordinary steps. A value outside that source needs a token change first (2026-11-11 maintainer ruling, audit B-04).
- Standard Button action frames use 24px horizontal padding and vertical centering within the Button's fixed height (§4); do not add 10px top/bottom padding to that height. Registered keycaps, data marks and bare-text buttons follow their component treatments; a `<button>` tag alone does not assign this padding to a visible layer or hit region (§5 Border Radius Scale).
- Container padding: dialogs 16px (`p-4`, see §4 Dialog & Modal); Select listbox panels 6–8px and shared menu panels `p-1` (see §4 Select & Dropdown)
- **Registered spacing exceptions and debt** — 正文已移至 [exceptions/layout.md](./exceptions/layout.md#spacing-exceptions)，规范效力不变。

### Layout Structure (App)

- Full-window three-region structure: sidebar + content area (+ optional right panel), separated by 1px Board dividers on a single flat Surface — never by background shifts (see §2 layer rule).
- Centered-card layouts (login, empty states) follow the Surface + Card two-layer rule in §2.
- Reading-width content (settings forms, document previews) is centered with a comfortable max width; full-bleed content (chat stream, file tree) fills its region.

### Desktop task sidebar identity

正文已移至 [task-sidebar.md](./task-sidebar.md)，规范效力不变。

### Desktop teammate sidebar

正文已移至 [task-sidebar.md](./task-sidebar.md)，规范效力不变。

### Desktop and Mobile task creator filters

正文已移至 [task-sidebar.md](./task-sidebar.md)，规范效力不变。

### Mobile task home teammate section (owner-approved “A+B”, 2026-10-24)

正文已移至 [手机设计指南 §9](../../apps/mobile/docs/mobile-design-guide.md#9-从根规范迁入的手机规则)，规范效力不变。

Desktop 伙伴列表的状态、尺寸与选中态见 [桌面伙伴与群列表状态](./desktop-bot-list-status.md)；手机沿用上述指南。

### Mobile iOS navigation chrome / iPhone Duo

正文已移至 [ios-native-design.md §8](./ios-native-design.md#8-mobile-ios-navigation-chrome--iphone-duo)，规范效力不变。

### Whitespace Philosophy

- **Emptiness as luxury**: no surface overstays its welcome — each concept gets minimal but sufficient space.
- **Content density is low by design**: one clear idea per surface. When a screen needs more, split it into progressive disclosure (§14) instead of packing it tighter.
- **The white space IS the brand**: calm, undecorated space communicates "this tool gets out of your way."

### Border Radius Scale

*(rewritten 2026-09-07 — owner-authorized rule decision, see `design-decision-log.md` 09-07. Supersedes the 08-29 three-tier wording and folds in the 07-28 micro-cell exception and the 09-06 keycap ruling.)*

**What this section assigns a radius to is a *visible layer* — one specific frame, surface, or clipping outline — not a DOM tag and not a whole component.** A single control routinely carries several: a "运行 ⌘Enter" button has a pill action frame, a 4px keycap inside it, and a hit-testing responsibility that needs no frame of its own. Assign each layer on its own. **A parent's radius is not the assignment rule for a contained layer.** A container may retain its approved content-clipping treatment, but an interaction wrapper must not use its own geometry to replace a contained mark's registered geometry.

**Assignment is a two-step decision tree. Step 1 wins over Step 2.**

**This section is the authoritative source for radius assignment.** Component entries and the summaries in §§1, 4, 7 and 9 reference it; they do not introduce competing assignment rules. The decision log records decisions and history, not a second current-value table.

#### Step 1 — Registered shapes

**A layer uses a registered shape only when an approved entry below covers that specific visible layer and use.** The entry supplies its corner treatment. Semantic arguments support an application for registration; they do not establish membership. Adding or widening an entry requires adjudication under the design-governance process and a decision-log record. **Neither an author nor a reviewer may create membership merely by interpreting this section.**

| Category | Scope | Corner radius |
| --- | --- | --- |
| **Keyboard keycap** | Every visible keyboard shortcut frame, whether rendered as `<kbd>` or as an interactive button that accepts the shortcut. Border, fill, padding and text colors stay appropriate to the surrounding surface; the radius is the shared cross-surface rule. *(Registered 2026-09-06, #4001.)* The 15px outlined provider-letter mark in `ModelSelector` takes the same treatment *(owner decision 2026-11-22)*. | 4px |
| **Text highlight mark** | The background behind matched or changed text runs: inline diff add/remove (`review/DiffViewer/inlineDiff.ts`), document and editor find matches (`.doc-search-mark`, `.cm-doc-search-match` in `globals.css`), sidebar search matches (`ConversationSearchBox`) and file-search matches (`workdir-browse/search/SearchResults`). Not a control frame; any other text mark needs its own adjudication. *(Owner decision 2026-11-22.)* | 2px |
| **Data mark** | A visible layer inside a chart or visualization whose shape belongs to the data rather than to the control. Members below. *(Registered 2026-09-07.)* | 0px or 2px, pinned per member |
| **Bot Market opening bubble tail** | Only the opening-line bubble in the Bot Market detail header (`BotMarketDialog`): 12px bubble with a square bottom-left corner joined to a curved SVG tail on the left that follows the bubble fill and border. Not a general chat-bubble shape; any other bubble needs its own adjudication. *(User ruling 2026-10-15; decision log 10-15.)* | 12px, bottom-left square + tail |

**Overlap.** A keyboard shortcut frame retains its registered 4px treatment when another channel, such as colour, also encodes data. Data encoding alone does not override the keycap entry. Other overlaps must be resolved explicitly in the registration; listing order alone does not grant precedence.

**Registered data-mark members.** The value is fixed per member, never chosen at the call site:

| Member ID | Covered visible layer | Corner radius |
| --- | --- | --- |
| `usage-heatmap-day` | The coloured cell representing one day's usage in `UsageHeatmap`. Excludes the hit region, legend, outer container and tooltip. | 2px, all four corners |
| `usage-token-bar` | The coloured bar representing one day's token volume in `UsageTokenBars`. Excludes the hit region, outer container and tooltip. Its own clipping may follow the same treatment. Top-only rounding or square baseline corners are not variants of this registration. | 2px, all four corners |
| `workflow-status-cell` | The coloured micro-cell in the agent status strip (background-tasks panel detail + workflow chat card). | 2px, all four corners |
| `system-category-square` | The registered per-category status square in SystemCard. | 2px, all four corners |
| `usage-daily-stack` | The clipped column of stacked model segments in `UsageDailyBars` (home usage card). Excludes the hit region and tooltip. | 2px, all four corners |
| `usage-share-bar` | Proportion bars whose segment widths are token shares: the tooltip bar in `UsageBarsTooltip`, the breakdown bar and the in-cell share bar in `UsageBreakdownTables`, and the provider usage bar in `ProviderUsageSection`. | 2px, all four corners |
| `usage-legend-swatch` | The 8px colour square keyed to a model, harness or task series: `UsageBarsTooltip` rows (including the outlined “more” swatch), `UsageBreakdownTables` `Swatch` and `UsageTaskTable`. | 2px, all four corners |
| `rich-answer-track` | The 8px value track of a rich-answer chart (`chat/rich-answer.css`). | 2px, all four corners |

*`usage-daily-stack`, `usage-share-bar`, `usage-legend-swatch` and `rich-answer-track` were registered by owner decision 2026-11-22 (Desktop hard-coded value inventory).* *A member ID identifies an approved visual role, not a filename or an entire component subtree. Reuse within its stated scope and semantics-preserving refactors do not require a new radius ruling; keep implementation references current. A new role, wider scope or changed geometry requires adjudication. Component entries reference the member ID and record other dimensions and interaction details instead of maintaining a second radius value.*

*`workflow-status-cell` and `system-category-square` absorb the narrow "status micro-cells (2px)" exception registered 2026-07-28. Their value and their components are unchanged; what changes is the basis — they are classified by the role their shape plays, not by being ≤8px and non-interactive. See the decision log for the two scope changes this entails. `usage-heatmap-day` and `usage-token-bar` likewise carry the usage-chart geometry that #4064 phrased as a separate "usage data marks (2px)" exception; that parallel wording was folded into these registrations when this section merged; their dimensions live in [usage-history-charts.md](./usage-history-charts.md) (§4 Usage History Charts).*

**Evidence required to register a new data mark** — what an adjudication request must establish. **Not** a self-service test that admits a layer automatically:

1. a stable mapping from a data field to a visual channel of that layer (position, size, area, colour intensity, **or categorical colour**);
2. which visible layers belong to the data and which belong to the control, stated separately;
3. that the classification does not depend on the current number of data points, the label text, the presence of a click handler, or the rendering technology (DOM / SVG / canvas).

Ordinary input options, control selected-states and action frames do **not** enter merely by carrying data. Mixed objects are resolved in the component entry.

#### Content and unresolved shapes

**Pixels and intrinsic geometry within images, icons and other assets are not control frames.** Existing approved content and cropping treatments follow their owning component specifications; any surrounding action frame is assigned separately. Replacing an asset within such a treatment does not register a new shape.

**Registered content shapes, debt and single-use exceptions** — 正文已移至 [exceptions/layout.md](./exceptions/layout.md#content-shapes)，规范效力不变。

A new content-owned outline or mixed object not covered by an existing specification **must be submitted for adjudication**. Reviewers report unresolved classification and request the missing decision; they must **neither force the object into the pill tier solely because it is clickable nor approve an unregistered exception**.

#### Step 2 — Control tiers

Ordinary control frames, containers and inner-control surfaces not covered by Step 1 use the following three tiers.

- **Pill (9999px)** — control frames: buttons, tabs, single-line inputs, tags, badges. **A control's fill style never changes its tier** — transparent and outlined fills are still pills (dialog secondary/cancel are pills with a transparent fill).
- **Container (12px)** — the box that holds content: code blocks, cards, panels, dialogs. Tailwind `rounded-xl`.
- **Inner control (8px)** — multi-line inputs (textarea), **always 8px** whether nested in a visible container or standing alone in a form; plus selected/hover row highlights in dropdowns/menus, and small in-block cells nested inside a container. Tailwind `rounded-lg`.

**A layer with no frame or surface to round needs no corner-radius assignment.** This does not authorize a control to discard its prescribed frame treatment merely by omitting a fill or border. A transient hover or pressed surface on an ordinary control remains that control's frame and takes its assigned tier.

**A focus or selection indicator is a separate visual treatment.** Its appearance alone does not create a new ordinary control frame or reclassify the associated layer. Registered bare-text buttons (wizard back-navigation "← 上一步", the §16.3 login text-button category, the hidden-channel record text in the §4 Desktop hidden channel records entry, and — owner decision 2026-11-22 — the task links in `BotStartedTasks`, the disclosure summary in `BotSkillPage` and the text links in `UsageTaskTable` and `BotCapabilitySettings`, whose 4px radius only shapes the focus ring; owner decision 2026-11-23 — the underlined settings links in `PluginEngineProviders` and `plugin/PluginEngineRemoteUse`, the quota text in `status/PluginEngineUsageChip`, the PR title links in `GitContextBadge` and `SessionPrManager`, the expand text in `GhostPluginDetailView`, the version-history summary in `PluginVersionUpdates`, the name buttons in `ProviderUsageSection`, the working-directory link in `RunHistoryPane`, the filter text trigger in `TaskListFilterPopover`, the truncated value buttons in `SkillhubDetailView` and the tick rows of the chat navigation rail (`MessageNavRail`), whose `rounded` / `rounded-sm` / `rounded-md` likewise only shapes the focus ring; and the member-joined disclosure in the §4 Desktop chat and operation authorization entry) remain frameless and retain their visible focus treatment (the login text buttons do not have one yet; `login-flow.md` §16.3 records the gap); new bare-text-button usages must still be registered in the introducing component entry.

Evaluate the approved component treatment across its states, including shared styles and pseudo-elements. **The absence of a local background or border class is not evidence of frameless status.**

#### Interaction constraints — apply after assignment

Making something clickable never moves a layer between Step 1 and Step 2.

- **Hit testing and mark geometry are independent responsibilities; they may share a DOM element or drawing primitive. No additional wrapper is required.** Hit-target geometry must not replace, clip or distort the mark's registered visible geometry or its data mapping. The mark's own registered clipping remains permitted. Resetting an existing radius with `rounded-none` is permitted when needed to achieve this result; **the presence or absence of a particular class is not the compliance test**.
- **Focus and selection indicators use the associated component's approved interaction treatment.** For registered marks, the component entry identifies the indicator geometry; it must not be inferred by reclassifying the mark as a pill control. An indicator may be drawn on the existing element, a pseudo-element, an overlay or the drawing surface. It must remain distinguishable without changing the mark's registered geometry or data encoding.
- **On a data-bearing layer, hover must not alter the visual mapping that encodes the data.** Use a distinguishable indicator on a separate visual layer when the relevant channel is already occupied.
- **For the same data and display configuration, a registered mark's geometry and corner treatment must not change solely because interaction is enabled or disabled.** Independent hover, focus and selection indicators are allowed.
- **Hit-target sizing.** Registered data-mark status does not itself provide an exception from pointer-target requirements. For the usage heatmap and daily-token chart, dense date targets may be retained through the **Equivalent** route of WCAG 2.2 SC 2.5.8 only when the Usage History view also provides a date-selection control that satisfies that criterion and reaches every selectable date with the same filtering result. Relative presets alone are not equivalent to arbitrary single-day selection. **DS-11 adds a 36px-high, labelled date field beside the range selector; it writes the same single-day filter as chart activation and displays chart-selected dates.** This closes the previously owed equivalent-entry implementation; platform/visual acceptance is recorded separately in the DS-11 evidence. Overlapping targets for different dates are not an acceptable enlargement technique. These members have no category-wide Essential exemption. Keyboard access and visible focus remain required independently.
- **Registered interaction emphasis — Usage History charts (owner-approved 2026-09-08).** For the two registered data-mark members `usage-heatmap-day` and `usage-token-bar`, the approved interaction treatment additionally includes a bounded emphasis: the non-hit-testing visible layer may grow by 2px, inside the 3px grid gaps. All four corners stay 2px; hit regions, grid pitch, resting geometry and data encoding do not change. Scope: Settings → Usage History and the provider 「远程与分享」 usage block, which reuses the same components (maintainer ruling D-08, 2026-11-11). Exact geometry, the token-chart fade and the heatmap selection outline are in [usage-history-charts.md](./usage-history-charts.md); motion is in §14.4. No other member may borrow this emphasis.

#### Scope and inventory

*Do not invent radii. **"It looks small" is never a reason to move a layer down a tier** — within Step 2 a layer's tier follows what it IS (control frame / box / textarea), not its size or nesting. **This sentence governs Step 2 only**; it is not an argument that every clickable layer is a control. Mind nesting: an 8px row highlight inside a 12px panel must stay smaller than its container; a pill there becomes a lozenge, 12px looks bloated.*

*New tiers and new registered shapes both enter only through adjudication — neither is added by a reviewer's reading of this section.*

*Governed corner-radius values are **0px and 2px** for registered data marks, **4px** for keycaps, **8px** for inner controls, **12px** for containers, and **9999px** for pill frames. No 3px / 6px / 10px, and no arbitrary values. A layer with no frame to round needs no assignment; "no assignment" is not an additional radius value. **Intrinsic content and mark geometry remain outside this corner-radius inventory** — a scatter dot's circle, a pie sector's arc, a map outline are shapes of the mark itself. Existing non-keycap `rounded-[4px]` usages remain registered debt; bare `rounded` and `rounded-sm` substitute for nothing.*

*Guard (2026-10-30): in Desktop renderer code, an added line whose radius resolves outside this inventory — `rounded-md` (6px), `rounded-2xl` / `rounded-3xl`, arbitrary values such as `rounded-[6px]` / `rounded-[10px]`, or a literal `border-radius` / `borderRadius` — fails `pnpm check:design-colors`. Intrinsic content geometry (an icon mask, an illustration shape) is declared with a `design: intrinsic-geometry — <reason>` comment on that line or just above and is then reported for review instead. Existing occurrences are debt, migrated page by page as visible changes; see [`design-governance.md` §8](./design-governance.md).*

## 6. Depth & Elevation

| Level              | Treatment                                                                 | Use                                            |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Flat (Level 0)     | No shadow, no border                                                      | Surface background, most content               |
| Bordered (Level 1) | `1px solid` Board (`--border-default`)                                    | Cards, code blocks, dividers, section outlines |
| Lifted (Card)      | Card fill (`--surface-elevated`) + optional 1px Board outline             | Login cards, raised panels                     |
| Floating           | Card fill + 1px Board outline + `--shadow-menu`                           | Menus, popovers, modal dialogs (every dialog, confirm or not) |

**Shadow Philosophy**: Cindy's base visual language uses **zero shadows**. This is not an oversight — it's a deliberate design decision. The flat, shadowless approach creates a paper-like experience where elements are distinguished purely by background color and single-pixel borders. Depth is communicated through **content hierarchy and type size**, not visual layering.
(The only shadows in the system are the mobile home drawer exception below, the PDF page in the document preview, whose white page would otherwise merge with a light surface, the stick cap of the WorkLouder device illustration, the `ThemeBrandLockup` icon, and the token-gated floating-layer exceptions and the Slider thumb (§15.18) / Segmented selected-pill (§4) exceptions registered in §10 — `--shadow-menu` (menus, popovers, modal panels and every other layer floating above content: tooltips, jump and new-message chips, find bars, toasts and floating notices, owner decision 2026-11-07) / `--cmd-palette-shadow` / `--segmented-selected-shadow` (`--confirm-shadow` stays registered for theme compatibility but is no longer consumed by dialogs;
`--shadow-soft-panel`, the base value of `--cmd-palette-shadow` and `--confirm-shadow`, and `--shadow-chip-raised`, kept only for compatibility, are registered in §10 and are not for direct use by new UI); never add ad-hoc shadows to in-page elements. Two single-use shadows are also registered (owner decision 2026-11-22): the inset shadow of the Windows tray quota card's glass well (`styles/quota-tray.css` `.tube`, the same well as the §2 gradient exception) and the live-device glow in the remote connection topology (`remote-connection-v2.css` `.rcv2-tile[data-live]`, 1px ring at 30% plus `0 4px 18px` at 22%, as specified in §4 Remote connection V2 topology); neither becomes a token.
A Switch-knob shadow was trialed and explicitly rejected — user ruling 2026-08-05: the legacy `shadow-lg` on the 16px thumb was invisible in practice, and a visible replacement read as noise; the knob is flat by decision, don't re-add it.)

**Mobile home navigation drawer exception (owner request, 2026-09-27):** The left-edge main menu uses an elevated surface, right-side container corners, and a soft outward shadow from mobile's `homeDrawerShadow` theme token. This exception is confined to `HomeChromeDrawer` (including its companion entry), not in-page cards or the task-list sidebar. The account header puts the user's name first, with the same personal avatar as Settings (falling back to a letter when no photo is available), optional email, and a small organization logo beside the organization name; do not show an account ID. Opening waits for native layout, then translates the panel and fades the backdrop together; drag, cancellation and close share one UI-thread progress value and respect reduced motion. Numeric values remain in mobile tokens and component styles.

**Transparent window shadow margins (owner decision 2026-11-22).** A floating card that lives in its own transparent window keeps an empty margin around the card so its shadow is not clipped by the window edge. The margin is shared with the main process, which sizes and places the window from it: `VoiceInputOverlay` `p-[52px]` ↔ `OVERLAY_SHADOW_PADDING = 52` and `VoiceInputDictionaryToast` `p-[34px]` ↔ `DICTIONARY_TOAST_SHADOW_PADDING = 34` in `apps/desktop/src/main/voice-input/global.ts`. Change each pair together; changing only the renderer moves the card off its anchor.

### 层级刻度（z-index，2026-11-22 维护者裁决）

桌面端的叠放顺序只用下面这套层名，不在调用处写 `z-[N]` 或预设的 `z-10`…`z-50`。数值的唯一来源是
`packages/design-tokens` 的 foundations（`z-*`），生成到 `tokens.css` 的 `--z-*` 变量、Tailwind 的
`z-<层名>` 类，以及 `styles/generated/token-mappings.ts` 的 `Z_INDEX_LAYERS`（style 计算、组件
`zIndex` 参数等需要数字的地方用它）。改值只改 token 源并重新生成。`cn()` 已把层名登记进
tailwind-merge，调用方传入的 `z-<层名>` 会覆盖组件的默认层。

| 层名 | 值 | 用途 | 谁用 |
| --- | ---: | --- | --- |
| `below` | -1 | 放到内容之下 | 少量背景层；多数负 z 是例外，见下 |
| `raised` | 10 | 页内略高一层 | 吸顶栏、拖拽调整手柄、角标、页内遮罩 |
| `page-float` | 20 | 页内浮起 | 标题栏动作、页内浮动提示 |
| `page-overlay` | 30 | 页内覆盖 | 页内吸顶覆盖、页内菜单 |
| `page-top` | 40 | 页内最上 | 回到底部、新消息提示、Diff 抽屉 |
| `float` | 50 | 非菜单的窗口级浮层 | 横幅、更新提示、悬浮预览、窗口控件、侧边抽屉面板 |
| `float-top` | 60 | 盖过横幅的浮层 | 新手引导条、迁移引导条、选区引用按钮 |
| `fullscreen` | 9999 | 全屏层 | 灯箱、启动页、致命错误页、拖拽影像、文件右键菜单 |
| `modal` | 10000 | 弹窗遮罩 | 所有弹窗的遮罩；`ConfirmDialog` 默认值 |
| `modal-raised` | 10001 | 弹窗面板 | 弹窗面板（压住自己的遮罩） |
| `modal-nested` | 10002 | 二级弹窗 | 叠在另一个弹窗上的弹窗（遮罩与面板同值，按 DOM 顺序） |
| `dropdown` | 10010 | 菜单与弹出层 | `DropdownMenu`、`Popover`、`MorphPopover`、`Select` / `SelectParts` 的默认值；模型选择器的二级面板 |
| `tooltip` | 10011 | 悬停提示 | `Tip` / `Tooltip` 的默认值；自绘的图表提示 |
| `modal-popover-nested` | 10020 | 浮层上的浮层 | 弹出层里再弹出的浮层，以及其中的 Tip（如定时任务表单） |
| `modal-blocking` | 10050 | 全局阻断提示 | 只经 `confirm({ blocking: true })` 使用（现为登录过期）；遮罩与面板同值，其中 Tip 取 +1 |
| `toast` | 10100 | 通知 | Toast 容器 |
| `toast-top` | 10101 | 通知之上 | 下载 Toast、庆祝动画（`ConfettiBurst` 默认值，额度重置动画同层） |
| `blocking-gate` | 10200 | 必须先处理才能继续使用的整窗遮挡 | 协议更新确认（`LegalTermsUpdateGate`）及其加载中的透明遮挡；盖过通知，只用于不处理就不能继续用的场景 |

使用规则：

- **共享组件不用再抬层级。** Tip 默认在 `tooltip`，菜单、Popover、MorphPopover、Select 默认在 `dropdown`，
  都已高于弹窗、二级弹窗和灯箱。在弹窗、灯箱、插件面板里使用时不传 `contentClassName` /
  `secretTipContentClassName` / `className` 去抬层级；只有父浮层本身在 `dropdown` 层而子浮层要压住它时，
  才用 `modal-popover-nested`。
- **自绘浮层**（直接用 Radix Popover / Tooltip，或 `fixed` 定位的面板）按用途选层：菜单和弹出层用
  `dropdown`，提示用 `tooltip`，横幅等非菜单浮层用 `float`。挂在共享浮层上的二级面板也用 `dropdown`，
  不能停在 `float`，否则会被父浮层盖住。
- **弹窗**：遮罩 `z-modal`，面板 `z-modal-raised`。弹窗打开期间会调用全局 `confirm()` 或再打开
  `modal` 层弹窗的，面板也用 `z-modal`，让后挂载的弹窗按 DOM 顺序在上（`ConfirmDialog` 的遮罩和面板
  都在 `modal`）。叠在弹窗上的二级弹窗用 `modal-nested`；内嵌的 `ConfirmDialog` 传
  `zIndex={Z_INDEX_LAYERS['modal-nested']}`。
- **全局阻断提示**（2026-11-22 维护者裁决）：`modal-blocking` 只给「不处理就无法继续使用应用」的全局提示，
  现在只有登录过期。普通确认、二级弹窗和授权请求（插件确认、插件安装授权、本机 Agent 确认等）都不得使用；
  调用方只能经全局 `confirm()` 的 `blocking: true` 拿到这一层，不写 `z-modal-blocking`，也不传
  `Z_INDEX_LAYERS['modal-blocking']`（`modalBlockingLayer.guard.test.ts` 拦截）。阻断提示走独立槽位：
  不排在普通确认后面、立即显示，多个阻断提示之间依次显示；关闭后焦点回到被它打断的弹窗。阻断提示在显示或排队期间，
  新来的普通确认暂缓、只排队不显示，阻断提示全部关闭后再依次出现（Radix 按挂载顺序管理焦点与 Esc，不看层级，
  之后才挂载的普通确认会抢走焦点）；阻断提示打开前已在显示的普通确认原地保留在它下面。界面里自己挂载的
  `ConfirmDialog`（如关窗确认）同样如此：阻断提示显示期间新打开的先不挂载，阻断提示关闭后再出现，由
  `ConfirmDialog` 统一处理，调用方不用改。直接用 Radix Dialog / AlertDialog 的弹窗不在此列。没有取消按钮时
  焦点落在主按钮；Esc 与点「重新登录」一样关闭提示（结算为取消，登录过期两者都进入登出），只关提示本身，
  不关下面的弹窗。Toast 仍在它之上：Toast 不拦截操作、只占角落，盖住它的是结果反馈而不是另一个要处理的问题。
- **组件内部的局部叠放**只和同一组件里的兄弟元素比较，不进全局刻度，见下方例外。

登记的例外与子档（保留字面量，新增同类须在这里登记）：

- **组件内局部叠放 0–5**：只在同一层叠上下文里比较兄弟元素（灯箱内部、登录控件、手柄图示、滑杆等）。
- **负 z**：放到内容之下的背景层（壁纸、按钮叠层、离屏宿主等）。
- **运行时计算**：`ConfirmDialog` 内提示取弹窗 `zIndex + 1`、列表按顺序叠放、拖拽中的标签临时 +1。
- **登录页层叠上下文**：品牌舞台 9980 < 登录面板 9990 < 启动页 9999，以及登录根节点内部的 30/40/50 相对层级。
- **子档**：拖拽落点框 9998（必须低于 `fullscreen` 的拖拽影像）；全局拖入文件提示 100（高于页内、低于所有弹窗）；
  侧栏抽屉 15（高于页内 `raised`、低于标题栏 `page-float`）；侧栏悬浮面板 48 / 49（必须低于 `dropdown`，
  行内右键菜单要画在面板之上）。

## 7. Do's and Don'ts

### Do

- Use Surface (`--surface`) as the page background — every page starts here
- Assign each visible layer's corner radius through §5 (Step 1 registered shapes first, then the Step 2 tiers).
- Keep the palette strictly grayscale — chromatic color only via the sanctioned semantic set in §2, always through tokens
- Use Inter at weight 500 for every title (§3 「字重阶梯」; brand-canvas 700 only as registered in §3) — hierarchy comes from size, not typeface switching or heavier weights
- Keep in-page elements shadowless — depth comes from borders and background shifts; only the shadows registered in §6 are allowed
- Keep content density low — each section should present one clear idea
- Use monospace for terminal commands and code — it's primary content, not decoration
- Keep ordinary action frames on their §4 component treatment and §5 assigned tier, including transient hover / pressed surfaces; focus / selection indicators and bare-text buttons follow §5 Step 2.

### Don't

- Don't introduce any chromatic color outside the sanctioned semantic set in §2 — no brand blue, no accent green, no warm tones beyond the registered exceptions
- Don't invent arbitrary radii — use only the §5 inventory (Step 1 / Step 2, Scope and inventory).
- Don't add shadows outside the §6 registry (§6 Shadow Philosophy is the single list; floating layers use `shadow-[shadow:var(--shadow-menu)]`) — never ad-hoc shadows on in-page elements, no preset `shadow-sm` … `shadow-2xl`; the flat aesthetic is intentional. `designEffectsDiscipline.test.ts` enforces this
- Don't use font weights above 600 in UI chrome — 700 only inside the §3 「排版豁免登记表」 domains. No 800+, no in-between values, anywhere
- Don't add decorative illustrations — Cindy's working UI carries no mascots or artwork; brand imagery appears only on the explicitly enumerated sanctioned brand surfaces in §15.7 / §16; the only other artwork is the user-selected [application wallpaper](./wallpaper.md)
- Don't introduce gradients — flat blocks and borders only; the registered exceptions are listed in §2 Gradient System, and `designEffectsDiscipline.test.ts` keeps that list closed
- Don't hard-code a solid gray for neutral text or fake a text tier with element `opacity` — use the text tier tokens (§2); in the CINDY family they are translucent ink and stay correct on glass and wallpaper
- Don't overcomplicate the layout — stick to the region structure in §5; no complex nested grids
- Don't give containers or dividers a border heavier than 1px — containment is always the lightest possible touch. The rule covers containers (cards, panels, dialogs, list frames) and dividers, not control strokes (owner decision B-10, 2026-11-11): checkboxes use the shared `Checkbox` (§4 Desktop settings controls) instead of a hand-drawn box; hand-drawn radio dots, edit / focus frames, avatar and status-dot cut-out rings and spinners may use 1.5–2px; the EffortSlider thumb's 2.5px border is a registered exception (§15.18). **Selection indicator exception (maintainer ruling, 2026-11-12):** the outline that marks the selected item in a picker may be 1.5–2px — currently the scheduler `TemplateCard` (1.5px) and the Appearance theme and wallpaper previews (2px); ordinary containers stay 1px
- Don't add decorative or large-motion animation — no bounce, parallax or gratuitous movement, and no looping beyond the loops registered in §14.4 and the optional Dynamic [wallpaper](./wallpaper.md). Short **functional** state transitions (color / background / opacity) are fine and expected; their durations follow the §14.4 tiers.

## 8. Window & Adaptive Behavior

Cindy Desktop is an Electron app: layout responds to window resizing, not page breakpoints.

### Desktop Window

- Minimum window size: **800 × 600** for the main window (`apps/desktop/src/main/bootstrap-electron.ts`). Secondary session windows (`secondary-windows.ts`) floor at **360 × 420** so dragged-out chats can sit compactly alongside other windows. The detached right-sidebar window has its own smaller floor of **360 × 480** (`right-sidebar-window/window.ts`), and a popped-out sidebar tab window (one or more tabs) floors at **360 × 420** (`sidebar-tab-window/window.ts`) — layouts hosted there must stay legible down to that width
- In the Desktop sidebar and Mobile session list, grouping adds no leading inset to session rows. Project, chat, shared, device and expanded automation entries use the pinned row margin for their display mode.
- The sidebar is collapsible; region dividers and paddings hold as the window narrows, and content reflows fluidly
- Chat stream and composer reflow with the window; code blocks keep horizontal scroll instead of wrapping
- Ordinary control sizes and paddings follow their §4 component treatments at every window size. Registered shapes and their hit regions follow their owning component treatments and §5 Interaction constraints; the usage charts' dense date targets use the Equivalent route only under the conditions stated there. Window resizing does not waive the applicable target requirements or authorize changing a mark's registered geometry.

### Mobile

Cindy Mobile (React Native) has its own device-class rules (phone / pad portrait / pad landscape). Cross-platform skins and login follow §15.13 and §16. iOS navigation, sheets, materials and controls follow the platform supplement [iOS native design](./ios-native-design.md); implementation guidance remains in [Mobile design guide](../../apps/mobile/docs/mobile-design-guide.md). **Mobile text (color, size, weight, line height) is decided by role from the guide's §3 text quick-reference table** (ruling 2026-09-26 / 27): five neutral text colors, lighter colors never take heavier weights, an 11-step type scale, and every text style paired with a line height; guard tests enforce these, role choice is checked in review. Real system-owned components retain system geometry, typography and material; this does not exempt custom content from Mobile tokens. Existing implementations are migration evidence, not the specification for new surfaces.

## 9. Agent Prompt Guide

### Quick Color Reference

Always write the token, never the value. The values per theme family are in the §10 generated table (Classic) and §15.16 (CINDY).

### Example Component Prompts

- "Create a settings section with the shared `SettingsSection` / `SettingsCard` / `SettingsRow` (§4 Desktop settings rows): the section title sits outside the card, related rows share one card, and the card paints `--settings-theme-card-*` itself — don't hand-roll the card or name lower-level slots."
- "Design a code block with a 12px border-radius, 1px solid `--border-default` border on a `--surface-elevated` background. Use the code font stack (§3 Font Family). No shadow."
- "Build a pill tab switch with the shared SegmentedControl (§4 Desktop segmented controls): borderless --segmented-track, selected pill on --segmented-selected-bg, all options weight 500. Do not hand-roll chip-filled tabs."
- "Build a chat composer by reusing `ComposerCard` (12px, `--chat-input-bg` / `--chat-input-border`, focus border `--chat-input-border-focus`); toolbar controls follow the two tiers in [container-transform.md](./container-transform.md)."
- "Design a confirm dialog: 12px-radius container, max-width 400px, pill buttons — outlined Cancel on the left, optional outlined third action, inverse neutral primary on the right; Cancel receives initial focus unless the caller explicitly selects primary focus or requires typed confirmation."
- "Pick one value in a form with the shared `Select` (§4 Select & Dropdown): panel as wide as the trigger, Card surface, `--shadow-menu`."
- "Offer actions in a menu with the shared `DropdownMenu` (§4 Select & Dropdown): `--cmd-palette-bg` panel, `--shadow-menu`, width set by the menu. Don't hand-roll either panel."

### Iteration Guide

1. Focus on ONE component at a time
2. Keep values grayscale and name the token (`--text-secondary`), never a literal gray — §7 Do, §10 Token Selection Rules for New UI
3. Radii and visible layers: §5 Border Radius Scale — Step 1 registered shapes first, then the Step 2 tiers; keep content, hit areas and focus / selection indicators separate, and submit unresolved shapes for adjudication
4. Shadows: §6 Shadow Philosophy
5. Weights: §3 「字重阶梯」
6. If something feels too decorated, remove it — less is always more

## 10. Theme System & Token Reference

### Light / Dark Dual-Mode Delivery Gate(双模式交付门槛)

- **Every UI must be implemented for both Light and Dark modes.** When adding or changing any page, component, layout, style, motion, or UI copy, both modes must be designed and built within the same piece of work; designing or implementing only one mode counts as incomplete. **Visual QA in both modes is expected effort, not a blocking gate** — see the last bullet.
- Both modes must cover every state actually touched by the change — default, hover, pressed, selected, focus, disabled, loading, empty, error, overlays and scrims. States the change does not touch need not be retrofitted just to tick a box.
- Colors must be consumed through semantic tokens; hardcoded values or conditional patches that only fit one mode are forbidden. When the design mock provides only one mode, the other mode must still be filled in through the existing token system; if a clear semantic mapping is missing, request a design ruling first — never ship with a mode omitted.
- **Verification is best-effort and must be reported honestly.** Eyeballing the affected surfaces in both Light and Dark before delivery is the preferred path, but skipping it does not block the change — say plainly in the commit / PR verification notes which mode was actually checked and which was not. Never upgrade "reused existing themed styles / added no raw color values" into a claim that both modes were verified. If a mode _is_ checked and comes back unreadable, indistinguishable, missing states, or visibly regressed, that is a real defect and must be fixed before delivery.

### Architecture

Cindy Desktop manages color with a **VSCode-style ColorRegistry + theme-override** model. Every color reaches components as a CSS-variable token; **hardcoding hex / rgba inside a component is never allowed** (it makes the component un-themeable outside the default theme).

Source: `apps/desktop/src/renderer/themes/`

- `color-registry.ts` — the `ColorRegistry` singleton and the `registerColor(id, defaults, description)` API
- `colors.ts` — registers every token, organized "semantic slots first, aliases and singletons after" (counts drift constantly — **the registration API in `colors.ts` is the live inventory; generated defaults are edited in `packages/design-tokens/src`**; this document does not track totals)
- `theme-service.ts` — `applyTheme(theme)` serializes all tokens into `:root{}` and injects `<style id="theme-vars">`
- `builtin/` — built-in theme objects (`cindy-light.ts` / `cindy-dark.ts` / `eclipse.ts` / `default-light.ts` / `default-dark.ts` and the community palettes). Their colors live in a `GENERATED DS-8: theme` block written by `packages/design-tokens`; only identity (`id` / `name` / `type`) and hand-kept runtime expressions sit outside it
- `registry.ts` — the `builtinThemes` registry (id → theme lookup, legacy id aliases, `listThemesByType('light' | 'dark')`)
- `families.ts` — `BUILTIN_FAMILIES`, the theme list shown in Settings, each family pairing an optional light and dark variant; local themes are appended after them

Theme switching: `useTheme.ts` provides `theme` (System / Light / Dark mode) plus `familyId` / `setFamily` (which theme family). The variant actually rendered comes from `resolveFamilyVariant(familyId, requestedType)`; when the family has no variant for that mode it falls back to the other one and `fallbackFromType` reports it (the “Light only” / “Dark only” state below). Older saved `theme.lightId` / `theme.darkId` values are migrated to a family on read. Settings → Appearance is the UI entry and lists `getThemeFamilies()`.

Settings → Appearance opens with the settings page title (see “Desktop settings rows”). The theme card follows the page title directly, without its own section title; Wallpaper, Fonts, Sidebar & panels and Reply Animation follow, each titled outside its card and laid out as settings rows (see “Desktop settings rows”). In the theme card, Theme, Appearance mode and Local themes are separate rows divided by lines. Theme is a single row whose picker is the same 320×36 pill select as Settings → General → Display language (same trigger, popover, option and selected styles). Theme, Local themes and Wallpaper carry no extra description line. Wide controls (wallpaper grid, sliders, and the font pickers, whose preview popovers must match the trigger width) sit under their row label. The appearance mode is one row: label on the left, three 92×60 window thumbnails on the right with a 12px caption. Each thumbnail draws a miniature Cindy window (sidebar, user message, reply lines, composer with send dot) from the selected color theme’s own `surface`, `surface-chip`, `border-default`, `surface-elevated`, `text-primary` and `text-tertiary` values; “System” shows the light half on the left and the dark half on the right. The selected thumbnail gets a 2px `--settings-theme-preview-border-active` ring with a 2px gap (12px outer / 8px inner radius), unselected ones show the ordinary preview border on hover. The theme picker comes before the appearance mode. A theme family with only one variant is tagged “Light only” / “Dark only” in the theme list. While such a theme is selected, the three mode cards are disabled and show the variant actually rendered, with one line under the mode label explaining it; the saved mode is not changed and applies again when a two-variant theme is chosen (owner request, 2026-10-17). Implementation: [AppearanceSection.tsx](../../apps/desktop/src/renderer/components/settings/AppearanceSection.tsx); regressions in `AppearanceSection.accessibility.test.tsx`.

### Token Tiers

**Tier 1 — Semantic slots**: the core cross-context slots; when adding a theme, this tier is the main override battleground. The exact-value summary below is generated from the Desktop DTCG source. Registry IDs and usages remain the compatibility contract.

<!-- BEGIN GENERATED DS-8: semantic-colors -->
| Category | Slot | Classic Light | Classic Dark | Primary use |
| --- | --- | --- | --- | --- |
| **Surface** | `--surface` | `#f8f8f6` | `#1f1f1e` | Page Surface (hex form) |
|  | `--surface-hsl` | `60 12.5% 97%` | `60 2% 12%` | Same, HSL triplet — consume via `hsl(var(--xxx))` |
|  | `--surface-elevated` | `#ffffff` | `#2c2c2a` | Card lift / dialogs / popovers |
|  | `--surface-elevated-soft` | `#e5e5e5` | `#2c2c2a` | Disabled-state Card |
|  | `--surface-card-ivory` | `#faf9f5` | `#2c2c2a` | Slightly warm ivory Card (Settings) |
|  | `--surface-chip` | `#e5e5e5` | `#3c3c3a` | Chips / pills / selected rows |
|  | `--surface-chip-alt` | `#e5e5e5` | `#2c2c2a` | Chip variant that collapses to Card in Dark |
|  | `--surface-hover` | `#e5e5e5` | `#3c3c3a` | General hover bg |
|  | `--surface-hover-soft` | `#f8f8f6` | `#3c3c3a` | Soft hover bg |
|  | `--surface-hover-hsl` | `0 0% 90%` | `60 2% 23%` | Hover, HSL form |
|  | `--surface-on-card` | `#ffffff` | `#1f1f1e` | Dark foreground on CTAs / checked icons |
| **Border** | `--border-default` | `#d7d7d4` | `#3c3c3a` | This spec's Board 1px border |
|  | `--border-default-hsl` | `60 3% 84%` | `60 2% 23%` | Board, HSL form |
|  | `--border-shadcn-hsl` | `0 0% 90%` | `30 4% 28%` | shadcn input/border HSL |
|  | `--border-transparent-mixed` | `transparent` | `#3c3c3a` | Single-side borders (progress track etc.) |
| **Text** | `--text-primary` | `#262626` | `#d4d4d4` | Primary headings / body |
|  | `--text-primary-hsl` | `0 0% 15%` | `0 0% 83%` | Primary, HSL form |
|  | `--text-primary-on-dark` | `#262626` | `#ffffff` | Inverse text (stop-button icon etc.) |
|  | `--text-primary-emphasis` | `#1a1a1a` | `#d4d4d4` | Plan emphasized primary text |
|  | `--text-primary-inv` | `#1a1a1a` | `#ffffff` | Plan-action approve text |
|  | `--text-primary-body-strong` | `#525252` | `#d4d4d4` | Plan content body, strong |
|  | `--text-secondary` | `#737373` | `#a3a3a3` | Secondary text / icons |
|  | `--text-secondary-cross` | `#a3a3a3` | `#a3a3a3` | Lighter cross-theme secondary |
|  | `--text-secondary-mid` | `#525252` | `#a3a3a3` | Muted body text |
|  | `--text-tertiary` | `#a3a3a3` | `#737373` | Tertiary text / metadata (never placeholders — use --text-placeholder) |
|  | `--text-tertiary-stone` | `#737373` | `#737373` | Cross-theme Stone tertiary |
|  | `--text-tertiary-mid` | `#525252` | `#737373` | Mid-gray tertiary |
|  | `--text-tertiary-hsl` | `0 0% 45%` | `0 0% 64%` | Secondary tier (`--text-secondary`), HSL form — sidebar muted / welcome text |
|  | `--text-disabled` | `#d4d4d4` | `#525252` | Disabled / failed |
|  | `--text-disabled-tertiary` | `#a3a3a3` | `#737373` | Disabled placeholder variant |
|  | `--text-placeholder` | `#c4c4c4` | `#525252` | Unified placeholder slot (lighter than tertiary — reads as empty); chat/ask/settings/plan-action-fb inputs all resolve here |
| **Accent** | `--accent-cta-bg` | `#262626` | `#ffffff` | Inverse CTA bg |
|  | `--accent-cta-bg-pure` | `#000000` | `#ffffff` | Pure CTA bg |
|  | `--accent-emphasis` | `#262626` | `#d4d4d4` | Settings primary button etc. |
|  | `--accent-soft` | `#262626` | `#ffffff` | Soft accent (folder button etc.) |
|  | `--accent-hover` | `#262626` | `#e5e5e5` | CTA pressed/hover |
|  | `--accent-pure-cta-fg` | `#ffffff` | `#000000` | Pure-inverse CTA text |
<!-- END GENERATED DS-8: semantic-colors -->

**Tier 2 — Aliases**: the many component-scoped tokens (`--cmd-palette-bg`, `--msg-tool-card-text`, `--settings-input-border`, …) whose defaults resolve to `var(--slot)`. The browser forward-resolves automatically; components are unaware — **keep consuming the alias names directly**.

**Tier 3 — Singletons**: genuinely independent values that cannot collapse into a slot: semantic exemption colors (`--destructive` / `--diff-add-*` / `--status-bar-accent` …), platform-specific colors, splash durations, and non-color tokens such as `--radius`.

### Semantic Exemption Colors (theme-invariant)

正文已移至 [exceptions/color.md](./exceptions/color.md)，规范效力不变。

### Built-in Themes

The implementation truth is `builtinThemes` in `apps/desktop/src/renderer/themes/registry.ts` for lookup and `BUILTIN_FAMILIES` in `themes/families.ts` for what Settings shows; adding or removing themes does not require updating this document. The Classic light/dark themes (family `default`) are exactly the §2 palette; new users start on the CINDY family (`DEFAULT_FAMILY_ID`, §15).

### Adding a New Theme (full flow)

Built-in theme colors are not hand-written in the theme file. They are edited in `packages/design-tokens/src` and generated into it (see `packages/design-tokens/README.md`). One theme file per variant; a family with both modes needs two files.

1. **Add the theme file** `apps/desktop/src/renderer/themes/builtin/<file>.ts` with an empty generated block and the theme identity:
   ```ts
   import type { Theme } from '../types';

   // BEGIN GENERATED DS-8: theme
   const GENERATED_OVERRIDES = {} as const;
   // END GENERATED DS-8: theme

   export const myTheme: Theme = {
     id: 'my-theme',
     name: 'My Theme',
     type: 'dark',
     colors: GENERATED_OVERRIDES,
   };
   ```
2. **Register the colors in `packages/design-tokens/src`**, all three files in the same change:
   - `reference/themes.json` — literal palette values under `reference.themes.<id>.palette-<NAME>` (only the reference layer may hold literals);
   - `themes/builtin.json` — the override roles under `themes.<id>.<token>`, each aliasing a reference or semantic token;
   - `desktop-bindings.json` — `themes["<file>.ts"]` with `type` (`light` / `dark`), `tokens` (registry id → `themes.<id>.<token>`) and `retained` (expressions kept by hand outside the generated block; usually `{}`).

   Override only the roles that differ from the base theme; the ported community themes override 108–111 (the import template's 108 base roles plus a few local ones). Every file in `builtin/` must have a `desktop-bindings.json` entry, otherwise generation stops with `Theme bindings must cover every builtin file`.
3. **Generate**: `pnpm --filter @cindy/design-tokens generate` fills the theme file's generated block; `pnpm --filter @cindy/design-tokens generate -- --check` must then pass. Never edit the generated block by hand.
4. **Register the theme** in `builtinThemes` in `themes/registry.ts`. This alone does not show it in Settings.
5. **Add the family** to `BUILTIN_FAMILIES` in `themes/families.ts` (`{ id, name, light, dark }`, `null` for a missing variant; array order is the Settings order). Only families appear in Settings → Appearance → Theme; a single-variant family is tagged “Light only” / “Dark only” there.
6. **Verify and update the deliberate freezes** in the same change: `themes/__tests__/fixtures/builtin-theme-overrides.json` (`builtinThemesFreeze.test.ts`), the builtin theme list in `themes/__tests__/cindyThemes.test.ts`, and the generated-output count in `packages/design-tokens/src/__tests__/structure.test.ts`; then run the theme contrast guards (`switchThemeContrast`, `buttonStateContrast`, `searchHighlightContrast`, `formHintContrast`, …) under `themes/__tests__/` and the `packages/design-tokens` tests. New built-in colors need design approval and real evidence in both modes ([design-governance.md §6](./design-governance.md)).

Use any existing non-default theme as a template: its file under `themes/builtin/` and its entries in the three token files.

### Token Naming Conventions

- **slot**: `{category}-{subkind}[-{variant}]`, e.g. `text-primary-emphasis` / `surface-chip-alt`. The `-hsl` suffix marks the HSL-triplet form.
- **alias**: keeps its historical component-scoped name (`--cmd-palette-bg` / `--settings-back-text` …), no prefix.
- **singleton**: any clear semantic name, usually component-prefixed.

CSS variable names are always kebab-case. Dot-style ids (VSCode's `sidebar.itemActive`) are not used — CSS variables don't support them.

### Token Selection Rules for New UI

1. **grep `colors.ts` first**: your UI type usually maps to an existing slot/alias (card bg = `--surface-elevated`, …)
2. **Slots first**: prefer a slot over a component-scoped alias (slots behave more predictably across themes)
3. **HSL tokens must be wrapped**: `hsl(var(--background))`, never bare `var(--background)` (the latter yields a raw HSL string, not a valid CSS color)
4. **No suitable token? Don't force one**: discuss adding a slot/singleton with the user instead
5. **Never** use `bg-[#xxx] dark:bg-[#xxx]` hardcoded pairs — the pre-P2 anti-pattern; it was migrated away once and new code must not reintroduce it
6. **Text color = the tier token for its role**: `--text-primary`, `--text-secondary-mid` (description), `--text-secondary`, `--text-tertiary`, `--text-placeholder` (or its input aliases). Placeholders use the placeholder tier itself, not `--text-tertiary` or an extra `placeholder:opacity-*`; neutral text never pairs its token with a static `opacity-*` to sit between tiers (disabled states and `opacity-0`/`100` reveals excepted). Guarded by `textTierDiscipline.test.ts`

This section is the authoritative token-usage text; i18n rules for UI copy live in `docs/dev-rules/engineering-conventions.md` §5.

### External Theme Import (VSCode / Obsidian)

Settings → Appearance can import a VSCode color theme (`*.json` / jsonc) or an Obsidian `theme.css` and convert it into a local theme. Implementation: `apps/desktop/src/shared/theme-import/` (pure conversion) + `apps/desktop/src/main/local-themes/importer.ts` (dialog / read / write). Rules that govern it:

- **One template, taken from the hand-ported community themes.** The seven ported themes under `apps/desktop/src/renderer/themes/builtin/` (one-dark-pro, github-dark, eclipse, material-ocean-hc, monokai-pro, atom-one-light, solarized-light) share a 108-token base template (DS-11 additionally gives One Dark Pro / Solarized Light a local `form-field-hint` override, outside the import template), derived from 13 palette roles plus the optional light-only `inputBg` role (CREATE AGENT card/input background, e.g.
  Solarized base2; absent ⇒ collapses to `surface`). Within the template, when a light palette supplies an `inputBg` distinct from `surface` (e.g. Solarized base2 cards), CREATE AGENT `*-hover` and the resting `quick-card-icon-bg` lift to `surface` (icon drops back to `chip` on hover); otherwise `*-hover`=`hover` and `quick-card-icon-bg` is `border` in dark / `chip` in light — keeping default/hover/icon visually distinct in every theme.
  `control-bg-pressed` is `chip` in dark and `hover` in light. `send-btn-bg`/`send-btn-icon` use the inverse-neutral pair (`textPrimary`/`surface`), not the accent, because the shared send tokens also render 10–12px text that must clear 4.5:1. `apps/desktop/src/shared/theme-import/palette.ts` is that derivation, code-ified;
  `one-dark-pro.ts`'s header comment is the source-of-truth for which VSCode key feeds which role. The template is **allow-list only** — it emits those 108 base ids plus the imported-theme-only `switch-track-off` / `switch-thumb-off` safety pair. Because external muted/comment colors are unconstrained, the track keeps the source `textSecondary` only when it clears the 3.2:1 derivation target (above the 3:1 non-text floor) against the relevant surfaces and thumb; otherwise the converter takes the smaller passing correction along the source-to-black/source-to-white paths, or rejects the palette with the dedicated contrast error rather than reporting it as an unrecognized file or internal error.
  Existing local snapshots created before this pair existed are backfilled with the same 3.2:1 target at renderer load time only when both tokens are absent and the complete legacy semantic palette is parseable; if no track can satisfy the target, the runtime restores the pre-upgrade `border-default` track and `surface` thumb instead of falling through to unchecked aliases.
  Disk JSON and explicit user overrides are never changed. The Allow-action keycap (`perm-allow-kbd-bg` / `-border`, owner ruling 2026-11-27) is a translucent overlay on the accent button, not `chip` / `border`: the converter first tints toward the button text (dark text: black 8% / border 20%; light text: white 16% / 30%); if the keycap text — the `Kbd` is 70% opaque over the button — stays under 4:1, it overlays the opposite way from 10% in 10% steps and takes the first that reaches 4:1 (border = fill + 12%), or the highest-contrast candidate when none does.
  This rule reproduces the six built-in accent themes' values. Optional Markdown tokens (`md-h1-fg`…`md-h6-fg` / `md-strong-fg`) are added when the source theme provides heading or bold colors.
- **Exemption families are never imported.** `--login-*`, brand red, `--destructive`, `--error-*`, `--warning-accent`, `--status-bar-accent`, `--focus-ring*`, `--diff-*`, shadows and overlays stay at their spec values under every imported theme (see the exemption table above and §16). `apps/desktop/src/shared/theme-import/protected-tokens.ts` enforces it as a second gate; the import report tells the user how many tokens were held back.
- **`-hsl` tokens are computed, not copied.** Both forms of a color must denote the same color, so the converter derives every HSL triplet from its hex via `toHslTriplet()`. (Note: a few hand-ported builtin themes carry approximate HSL values — `github-dark`'s surface triplet (`reference.themes.github-dark.palette-SURFACE_BG_HSL` in `packages/design-tokens/src/reference/themes.json`) was copied off one-dark-pro. Those are left as-is; new imports are exact.)
- **Markdown text colors go through `--md-h1-fg`…`--md-h6-fg` / `--md-strong-fg`, and default to `inherit`.** Before these tokens existed, Markdown headings and bold text inherited their color from the container (`baseComponents` sets size/weight only). Defaulting to `var(--text-primary)` would have repainted headings inside blockquotes, tool cards and secondary-text regions, so the defaults are `inherit` — every built-in theme renders exactly as before. Imported themes fill them from Obsidian `--hN-color` / `--bold-color` or VSCode `markup.heading` / `markup.bold`. Guard: `themes/__tests__/markdownColorTokens.test.ts`.
- **Obsidian import is a palette import, not a theme port.** Only CSS custom properties are read; selectors, layout, radii and fonts are discarded — Cindy's layout and typography stay owned by §3/§5. Values that cannot be evaluated statically (`color-mix()`, undefined `var()`) are skipped and reported rather than guessed.
- **Checked Switch track = theme accent.** The seven ported themes each override `switch-track-on` to their own accent (user ruling 2026-08-05; bound in `packages/design-tokens/src/themes/builtin.json`). Solarized Light uses the deeper green `reference.themes.solarized-light.palette-GREEN_DEEP` (`#5e6a00`, in `reference/themes.json`) — the official `#859900` fails the 3:1 floor. The registry default stays `hsl(var(--primary))`: Classic and imported themes keep the pre-existing neutral checked track. CINDY Light and Dark use blue `#417CDD` (owner decision 2026-09-15, §15.17), replacing their former neutral checked tracks. Guard: `switchThemeContrast.test.ts` asserts every builtin theme's checked track ≥3:1 against the checked thumb (`switch-thumb-on`, defaulting to `hsl(var(--background))`) and all five surfaces.
- **Local themes may declare an optional `family`.** Same-family light + dark variants merge into one switchable family (`themes/families.ts`); files without the field keep behaving exactly as before (family id = theme id). Obsidian's dual-mode CSS uses this to land as a single theme that follows Light/Dark mode.
- **Omarchy live theme (Linux).** When `~/.local/state/omarchy/current/theme.name` exists, the main loader (`apps/desktop/src/main/local-themes/omarchy.ts`) converts Omarchy's generated `theme/vscode-theme.json` with the same VSCode converter and lists it as family `omarchy` (no `-local` suffix, no local badge, one variant matching Omarchy's light/dark). The main process watches the `current` directory; each `theme.name` write (Omarchy writes it after swapping the theme directory) reloads themes and pushes `local-themes:changed` to trusted Cindy windows, which retint at once. Cindy never writes Omarchy files. A read that lands inside Omarchy's swap keeps the last good theme and records a path-free diagnostic, so the user's selection is not reset.

## 11. Voice & Content(微文案规范)

> **Status: draft**, introduced 2026-06 (after the Voice & Content section of Vercel Geist's `design.md`). This section governs **how interface copy is written** and pairs with `docs/dev-rules/engineering-conventions.md` §5 (the i18n system) — that side enforces "copy lands via i18n keys, aligned across every locale in `SUPPORTED_LOCALES`" (`apps/desktop/src/shared/locale.ts`; current list in §11.4); this side governs each string's tone and wording. It adds no UI strings, only constraints.
>
> **Existing English debt (owner decision B-14, 2026-11-11).** The rules stay; the en catalog does not follow them yet. The generic error defaults, the shared error banners and toasts, "Pushed successfully" and the bare Confirm / OK buttons with a clear object were fixed first. The remaining "Please", "successfully", straight-quote and bare Confirm / OK / Submit strings are frozen in `i18n/glossary-baseline.json` and move page by page; `pnpm check:i18n-glossary` blocks new ones (rules in `docs/dev-rules/engineering-conventions.md` §5.1). Retry advice added by default cannot be machine-checked and is caught in review.

Cindy's product voice matches its visuals: **restrained, direct, never self-congratulatory**. Copy is part of the tool, not marketing.

### 11.1 Language-Independent Principles (every supported locale alike)

- **Actions = verb + object, never a bare verb.** Buttons and menu items say what is done to what: `Deploy project` / `删除任务` / `セッションを削除`. **Forbidden**: objectless verbs like `Confirm` / `OK` / `确定` / `提交` (confirm-dialog primary buttons especially must carry the object so they read correctly out of context).
- **Errors name what failed; advice must be supported by the cause.** When the cause is known, give the corresponding remedy. Suggest retrying only when there is evidence it may help; never append "Try again / 请重试" by default. When the cause or recovery path is unknown, state the failed operation honestly (for example, `Could not save panel positions` / `未能保存面板位置`), without inventing a cause, promising recovery, or prescribing an arbitrary action. Before suggesting a repeated write, import, or payment, account for possible partial completion. Pairs with `docs/dev-rules/engineering-conventions.md` §2 (IPC error protocol).
- **In-progress = present continuous + ellipsis.** `Deploying…` / `正在部署…` / `デプロイ中…`. The ChatView Thinking status bar (`Thinking…`, Thinking Orange) already is this pattern; new loading/processing states follow it.
- **Results name the object — never say "success".** Toasts say what changed, not that an operation succeeded: `任务已删除` not `删除成功`; `Project deleted` not `Deleted successfully`. **Forbidden**: filler like "successfully / 成功了". (Toast visuals are §2; this rule is copy only.)
- **Empty states point at the first action** — never just "No data"; tell the user what they can do now ("No sessions yet — hit + to create one").
- **Neither servile nor cold — per language**: English never writes "Please" (the interface isn't begging). **Chinese 「请」 is idiomatic politeness and is exempt** — keep "请输入…" "请先授权" "请选择文件"; don't stiffen Chinese to satisfy the English rule. Neither language uses marketing adjectives ("强大的 / 极致 / 全新").

### 11.2 Casing & Punctuation Per Language (not transferable)

- **English**: everything uses **sentence case** — labels, buttons, titles, tabs, menu items, body, help text and toasts alike (`Deploy project`, `Delete session`). Only the first word is capitalized, except words that are capitalized anyway: product and brand names (`Cindy`, `Claude Code`, `GitHub`), glossary terms that keep a fixed English form (`Agent`, `Worker`, `Skill`; see `i18n/GLOSSARY.md`), acronyms (`SSH`, `API`), and the exact names of OS or third-party controls the user must find (`System Settings`). Owner decision B-13, 2026-11-11: the en catalog was already mostly sentence case (about 455 : 129); remaining Title Case strings move when their page is touched. Curly quotes and the ellipsis character `…`, never straight quotes or `...`.
- **es / fr / de / pt-PT / pt-BR**: sentence case as in English, with the same exceptions; English Title Case is not carried over. German additionally capitalizes every noun, as its orthography requires. Punctuation follows each language: es opens questions and exclamations with `¿` / `¡`; fr puts a space before `:` `;` `!` `?` and quotes with `« »`; de quotes with `„ “`; pt-BR quotes with `“ ”`. es and pt-PT catalogs still mix `« »` and `“ ”`; keep the surrounding page consistent and never introduce straight quotes.
- **zh-CN**: **no Title Case concept** — no per-word capitalization, no English-style punctuation in Chinese; keep English terms as-is in mixed text (`部署 Project`). No full stop at the end of toasts / labels.
- **zh-TW**: likewise has no Title Case; use Traditional Chinese characters and punctuation, while keeping English terms as-is in mixed text. No full stop at the end of toasts / labels.
- **Classical Chinese editions (zh-Hant-x-lzh / zh-Hans-x-lzh)**: no Title Case; full-width Chinese punctuation with `「」` quotes, the same as zh-TW / zh-CN (the half-width punctuation gate covers both). zh-Hant-x-lzh uses Traditional characters and zh-Hans-x-lzh Simplified; tone, terms that stay untranslated and length limits follow `i18n/classical-chinese-style.md`.
- **ja / ko**: likewise no Title Case; follow each language's particle / politeness conventions, and verify terminology when unsure (per `docs/dev-rules/engineering-conventions.md` §5: no improvised ja/ko).
- **Numbers / units**: Arabic numerals + half-width in every language; number-to-unit spacing per language convention.
- **Task elapsed time**: promote long durations to hours/minutes at one hour and days/hours/minutes at one day. Always retain the minute field, including zero (for example, `1h 0m` or `2d 0h 5m`). Apply this to work summaries, thinking, live counters, task cards and usage details on Desktop and Mobile. Keep existing sub-hour precision; live counters may retain a zero-padded remainder. Stored durations and rate calculations keep their original precision.

### 11.3 Self-Check (when touching copy)

- [ ] Action buttons carry an object — not a bare `确定` / `OK`
- [ ] Error copy names the failed operation; any cause, remedy, or retry advice is supported by the actual failure
- [ ] No "successfully / 成功" filler
- [ ] In-progress states read "present continuous + …"
- [ ] Affected copy reviewed in every locale in `SUPPORTED_LOCALES` on each affected client, including descriptions, navigation names, and accessible labels (see `docs/dev-rules/engineering-conventions.md` §5)
- [ ] Names and descriptions match the actual controls, scope, conditions, and consequences; shorter copy has not changed the promise
- [ ] Relevant structural, placeholder, terminology, and copy tests run; language review and any unverified runtime presentation are reported separately

### 11.4 Plain-language copy and multilingual review (owner decision, 2026-10-09)

- **Make the next action understandable at a glance.** Menus and settings use everyday language describing what users can do or what changes. Do not expose implementation vocabulary such as `chip`, `hover tooltip`, or `max_budget` as instructions. Keep established product terms, brand names, and technical identifiers when users need them to identify a real option; consult `i18n/GLOSSARY.md` rather than inventing synonyms.
- **Brevity is a target, not a truncation rule.** In Simplified and Traditional Chinese, aim for 2–4 characters for names and no more than 20 characters for short descriptions. Preserve the action's object, device/account scope, effective time, exceptions, and irreversible consequences even when they require more text. Detailed help and accessible labels may be longer. Other languages use natural concise phrasing, not the Chinese character limit or word-for-word translations.
- **Explain the actual behavior.** Read the consuming UI and relevant behavior before rewriting. A three-way display selector must not be described as a card-mode switch; a notification setting covering errors and requests for a reply must not be named only for completion. Distinguish mode labels from action buttons and keep page headings, navigation/search labels, descriptions, and accessible names consistent.
- **Review every affected language.** Compare all locales in `SUPPORTED_LOCALES` (currently zh-CN, zh-TW, en, ja, ko, es, fr, de, pt-PT, pt-BR, and the Classical Chinese editions zh-Hant-x-lzh and zh-Hans-x-lzh) for meaning, conditions, terminology, natural phrasing, and local punctuation. For shared concepts, check Desktop and Mobile together. Preserve placeholders and plural forms. A translation that is already correct need not be changed merely to produce a matching diff.
- **Use checks and language review together.** Run the existing i18n structure and glossary gates plus relevant Desktop/Mobile catalog, placeholder, and copy tests. These do not prove semantic accuracy or naturalness, and static references do not cover every dynamically constructed key. State the review scope and distinguish automated checks, language review, native-speaker review, and runtime layout/readability checks; do not claim a full-product audit or verified Light/Dark presentation from a passing catalog check.

## 12. Component Spec (merged into §4)

> The structured component-spec pilot (Buttons / Inputs / Cards) was adopted in 2026-07 and folded into §4 in place. This section number is kept as a placeholder: section numbers in this document are stable identifiers referenced by other documents, code comments, and frozen tests — do not renumber (see `design-decision-log.md`).

## 13. Open Spec / Token Gaps

This section no longer tracks open items; it keeps the pointer only. Open design rulings — for example the user-theme `colors.radius` override, legacy cross-surface aliases, the Mobile permission presentation and Mobile/Desktop radius-tier differences — are registered in [`design-governance.md` §10](./design-governance.md#10-待裁决登记). Do not treat an absence here as "no open gaps".

Resolved items (G1–G4, 2026-06 — button-text drift, border drift, placeholder unification, radius tiering) are archived in [`design-decision-log.md`](./design-decision-log.md); each entry records the drift, the ruling, and where the conclusion was folded back (§2 / §4 / §5 / §10).

Known but deliberately-deferred cleanups are tracked in the decision log's backlog section, not here.

## 14. Interaction Conventions(交互约定)

> Introduced 2026-06. This spec used to govern only how things look (color / radius / type / spacing), not how they behave — whether text is selectable, where focus lands when a dialog opens, whether Enter sends or breaks the line; these kept needing case-by-case human correction. This section pins those **non-visual interaction behaviors** as global conventions, complementing §11 (copy tone). Whatever code can guarantee uniformly should not rely on human memory (per "code-first determinism" in `docs/dev-rules/maker-core-and-agent-behavior.md`).

### 14.1 Text Selectability (user-select)

- **Content is selectable**: message body text, code blocks, document previews — anything the user reads sentence-by-sentence or may want to copy. Selectable by default; leave it alone.
- **Selections survive focus changes**: moving focus into an embedded webview (plugin panel, built-in browser, etc.) must not clear the host selection or let Chromium repaint it as an unreadable inactive color. Global and editor selections use `--text-selection-bg`, which remains visible in both Light and Dark modes.
- **Chrome is not selectable**: buttons, menu items, labels/chips, status bars, badges, toolbars, sidebar rows — interface-skeleton text gets `select-none`. They are controls, not content; being selectable only gets in the way (typical offender: the goal-status chip label).
- Litmus test: would the user ever think "let me copy this"? Yes → selectable; no (it's just a control) → `select-none`.

### 14.2 Focus Management

- Preserve ordinary Tab / Shift+Tab traversal at the app root. Only the focused component may consume Tab for a specific interaction (such as editor completion or a modal focus loop); never globally cancel it. Verify keyboard paths with the real App mounted, since component-only fixtures omit root listeners.

- When a dismissible form opens, focus its primary input. Ordinary ConfirmDialog retains Cancel by default; explicit `autoFocusConfirm` opts into the primary action, and typed confirmation takes precedence (§4, DS-6). Selection-only dialogs such as InstallTargetPicker start on Cancel to avoid focusing an immediate installation action. Contain Tab, support Esc when idle, and restore the opener on close; actual saving/installation blocks dismissal until settlement.
- On close, focus returns to the triggering element (Radix default — don't break it).
- Draw keyboard focus as a `focus-visible` box-shadow ring. `globals.css` forces `outline: none` on the focused element itself (`*:focus` / `*:focus-visible`), so an outline on the focused control never renders; an outline drawn on a separate indicator layer (for example the usage-chart focus indicator) is unaffected. Controls use the shared Button or `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]`. Inputs are no exception: the later `outline: revert` for `input` / `textarea` / contenteditable has no `!important` and loses to the reset, so text fields show focus through their focus border or a ring. Guarded by `designEffectsDiscipline.test.ts` (`invisibleFocus`).
- Composer-replacing cards (permission, plan review, ask) take window-level Enter / Esc / number shortcuts only when the key is otherwise unclaimed. An already-handled key, IME composition, an editable field, a control or popup layer outside the card, and Enter on the card's own control (native activation — Enter on Deny denies) all take precedence. Implementation: `shouldCardShortcutYield` in [editableKeyboardTarget.ts](../../apps/desktop/src/renderer/lib/editableKeyboardTarget.ts); regressions in [cardShortcutYield.test.tsx](../../apps/desktop/src/renderer/__tests__/cardShortcutYield.test.tsx).
- Settings (an in-window route, all desktop platforms) steps back one level on an unclaimed Esc, the same exit as its top-left Back: the Pi extensions sub-page returns to General, otherwise Settings closes. Inner owners settle first — clearing a non-empty search, shortcut recording, dialogs / menus / popovers, a plugin detail page (back to its list) and the Help panel; IME composition, modified Esc and auto-repeat from a held key never navigate (one physical press steps back one level). With a Settings field focused, the first Esc only leaves the field (blur-to-save fields commit as on click-away) and the next one exits. Implementation: [useSettingsEscape.ts](../../apps/desktop/src/renderer/components/settings/useSettingsEscape.ts); regressions in [useSettingsEscape.test.tsx](../../apps/desktop/src/renderer/components/settings/__tests__/useSettingsEscape.test.tsx).

### 14.3 Keyboard & IME (send-type text fields)

Applies to submit-on-Enter fields: the chat composer, goal input, ask input, etc. **Not** ordinary single-line editors in Settings — there Enter must not submit.

- By default, **Enter = submit**, **Shift+Enter = newline**. The desktop chat composer also supports the existing **Cmd/Ctrl+Enter = submit** preference; when enabled, **Enter = newline**.
- Composer list continuation follows newline intent: Enter in that preference, as well as Shift/Alt+Enter, continues a list or exits an empty item. Send shortcuts and IME confirmation must not edit lists; fenced code keeps native newline behavior. The shared key handler is `handleComposerListEnter` in `apps/desktop/src/renderer/components/new-chat/ComposerListNodes.ts`, covered by `apps/desktop/src/renderer/lib/__tests__/composerListContinuationEditor.test.ts`.
- **Enter during IME composition must not submit** — check `event.nativeEvent.isComposing` (a CJK user confirming a candidate must not accidentally send).
- Centralize this logic in code; do not re-implement it per field and let behavior drift (per "code-first determinism" in `docs/dev-rules/maker-core-and-agent-behavior.md`).

### 14.4 Motion & Transitions

> Expanded 2026-07. Cindy's motion character extends the paper-like restraint of §1 / §7: **ordinary UI fades, nudges, and resizes smoothly; overshoot is limited to the explicitly registered Done, Usage History chart and mobile new-task morph responses below**. Functional state transitions are allowed; decorative motion is forbidden. This section pins "functional" into executable tiers and prototypes so components stop inventing their own durations and curves.

#### Motion tokens (the only tier source)

Global tokens are generated from `packages/design-tokens` into `:root` of `apps/desktop/src/renderer/styles/generated/tokens.css`; `styles/globals.css` only holds the reduced-motion overrides. Mobile (`apps/mobile`) mirrors same-name same-value constants in `src/theme/tokens.ts` (`motionDuration` / `motionEasing`; dual-platform isomorphism, same policy as color tokens). **New transitions/animations must reference tokens — no hardcoded durations or cubic-beziers**; 5 interaction-duration tiers + 3 curves, the same philosophy as the §5 radius scale. Values outside the tiers require design review first. Narrow semantic exceptions are recorded directly below.

| Token                | Value                           | Use                                                                                |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `--motion-instant`   | 80ms                            | Instant hover feedback; light-overlay exit                                         |
| `--motion-fast`      | 150ms                           | Color/opacity state changes (`transition-colors` = this tier); light-overlay enter |
| `--motion-base`      | 200ms                           | Size changes: expand/collapse, panel open/close                                    |
| `--motion-enter`     | 250ms                           | Heavy-overlay (dialog) enter                                                       |
| `--motion-exit`      | 150ms                           | Heavy-overlay (dialog) exit                                                        |
| `--motion-ease-out`  | `cubic-bezier(0.16, 1, 0.3, 1)` | Enter / expand                                                                     |
| `--motion-ease-in`   | `cubic-bezier(0.4, 0, 1, 1)`    | Exit                                                                               |
| `--motion-ease-move` | `cubic-bezier(0.4, 0, 0.2, 1)`  | Position/size interpolation                                                        |

**Panel width and list reorder (maintainer ruling D-04, 2026-11-11).** Desktop panel open/close width animations — left sidebar, right sidebar, the title-bar traffic-light inset and floating chrome cluster, and the file-browse chat rail — use `--motion-base` / `--motion-ease-move`; the former hardcoded 250ms is retired. The Toast FLIP reorder uses the same pair instead of 300ms browser `ease-out`. Renderer `.ts` / `.tsx` may not add hardcoded durations or `cubic-bezier` curves (`duration-150`, `duration-[250ms]`, `animate-[x_200ms_…]`, any `cubic-bezier(…)` outside a `var(--motion-ease-*, …)` fallback — Tailwind, inline style or Web Animations `easing` — inline `'transform 300ms ease-out'`, a bare `'300ms'` string); existing literals are a shrink-only baseline in `__tests__/motionDiscipline.test.ts`.

**Stream-word duration exception (requested and confirmed by the user 2026-11-25):** `--motion-stream-word` =
`500ms` (linear) is the fade-in of streamed assistant prose only — see the Stream-word fade
class and Stream pacing below. Dense output shortens individual segments through the per-span
`--wf-duration` (never below `--motion-fast`). It is not an interaction tier; nothing else may use it, and it
is zeroed in the reduced-motion block like the other tokens.

**Semantic loop-cycle exception:** `--motion-spinner-cycle` = `1000ms` is the
full-turn duration for functional loading spinners. It is not a sixth interaction
tier and must not be used for enter/exit, hover, resize, or decorative motion.
Spinner rotation remains linear, transform-only, mounted on an HTML wrapper, and
must become static under reduced motion. This exception keeps loading rotation
readable without coupling it to dialog timing or copying a hardcoded Tailwind
default into components.

**Registered looping indicators** — 正文已移至 [exceptions/motion.md](./exceptions/motion.md#registered-looping-indicators)，规范效力不变。

**Sidebar title reading exception:** `--motion-sidebar-title-marquee-per-viewport`
= `2400ms` is the reading time for each visible-width span of an overflowing
Desktop sidebar task title. It is not an interaction-duration tier and is confined
to `SidebarTitleMarquee` in `SessionItem.tsx`: actual-overflow only, pointer hover
only, one-shot, reset immediately on pointer leave, and proportional to the number
of viewport spans needed to reveal the full title. The track may animate only
`transform` / `opacity`; `prefers-reduced-motion` keeps the original static
ellipsis (with the native full-title tooltip) and disables the track. This narrow
exception preserves readable, constant-paced title playback without allowing the
long duration to leak into any other hover or transition.

**Switch feedback (owner-approved 2026-09-16).** The shared Desktop Switch uses the bounded thumb width/height changes registered in §15.17: a one-shot size transition with `--motion-fast` / `--motion-ease-out`, no overshoot, and direct pointer tracking during drag. The track and hit region do not move or grow. This is a functional transient width/height exception; it does not authorize looping layout animation. Reduced motion removes transitions and keeps immediate state feedback.

**Mobile list disclosure rhythm (owner request, 2026-09-30).** On mobile, expanding and collapsing list groups (home pinned / shared / project / conversation groups, automation run groups on the home and device pages, the collapsible Settings debug group) and task-row moves from archive, unarchive, pin or unpin (rows leaving stay visible while the rows below close over them, then fade) follow the iOS system list rhythm instead of the Desktop `base` tier (200ms): 225ms quadratic ease-out with no overshoot, reaching about 90% of the travel within 150ms (the owner asked for the first 450ms version to be halved the same day). The group opens from under its header: list cells clip their content while their position and height animate, new rows sit at their final positions and are revealed as the group grows, and the rows below move down in step; new rows do not fade in place. Collapsing reverses this: removed rows stay visible while the group closes over them and fade only near the end. The disclosure chevron switches without animation. The duration lives in mobile's `listDisclosureMotion` token and the shared implementation is `apps/mobile/src/session/listDisclosureTransition.tsx` (Reanimated layout animations, attached only during the transition window; React Native `LayoutAnimation` is a no-op in this app because Reanimated owns the Fabric mounting layer). Reduced motion switches instantly. This exception does not apply to Desktop, sheets, dialogs, or other panels.

**Mobile image viewer edge elasticity (owner request, 2026-10-10).** In the mobile full-screen image viewer (`apps/mobile/src/session/ImageLightbox.tsx`), direct manipulation follows the system Photos physics instead of hard stops: a zoomed one-finger pan may run past the image edge with rubber-band resistance (UIScrollView coefficient 0.55 over the container size), and a pinch may overshoot 1x / the maximum zoom with the same resistance. On release, anything out of bounds returns on a near-critically damped spring (no visible oscillation, about 0.3s); an in-bounds release continues with inertial decay that may briefly overrun the edge and return; a touch catches it in place. Scale and translation settle on the same spring so the point under the fingers stays put. These are physics responses to the hand, not duration-tier transitions, so they use spring/decay parameters rather than motion tokens; the parameters and decisions live in `imageLightboxModel.ts`. A single image at 1x keeps the native horizontal edge bounce. This exception does not apply to any other surface.

**macOS menu bar quota fill** — 正文已移至 [macos-menu-bar-quota.md](./macos-menu-bar-quota.md#menu-bar-quota-fill-motion)，规范效力不变。

#### Semantics → motion prototypes (one semantic, one motion, app-wide)

| Semantic                                    | Spec                                                                                                                                                                                                                                                                                         | Reference implementation                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Light overlay (menu / popover / tooltip)    | In: `animate-float-in` (opacity + scale 0.97→1, fast/ease-out; pure-opacity tooltips use `animate-fade-in`). Out: `animate-float-out` (opacity only, instant/ease-in). **Exit is always faster than enter, and never scales** (a scaling exit reads as "sucked away" — paper fades in place) | `components/ui/dropdown-menu.tsx`               |
| Heavy overlay (modal / confirm)             | Every modal, from the shared `.modal-scrim` / `.modal-panel` (2026-10-04): scrim fades in; panel fades in + rises 8px + scale 0.96→1 on `--motion-enter` / `--motion-ease-out` (entrance borrowed from Fluid Functionalism's chat-message). Out: fade only on `--motion-exit` / `--motion-ease-in` — a dismissal does not replay the entrance. Radix dialogs animate by `data-state`; hand-built dialogs have the entrance only. Call sites add no `animate-*` classes | `styles/globals.css`, `__tests__/modalSurfaceContract.test.ts` |
| Expand / collapse                           | base/ease-move, grid `0fr↔1fr` height + opacity                                                                                                                                                                                                                                              | `components/ui/collapse.tsx` |
| List reorder                                | FLIP, transform translation on base/ease-move                                                                                                                                                                                                                                                | `components/ui/toast/ToastContainer.tsx`        |
| Press                                       | Shared Desktop Button / ChromeIconButton / SidebarIconButton: paint-only 1px inset, instant/ease-out, stable text and hitbox (§4). Legacy frames retain their existing `active:scale-[0.98]` until separately migrated. Registered shapes follow §5; a button tag does not authorize scaling a contained data mark or its data mapping. | `components/ui/button.css` |
| Done                                        | registered completion overshoot (`status-done-pop`); chart response has its own narrow registration below                                                                                                                                                                                                                                  | `globals.css`                                   |
| Running                                     | Opacity breathing; must sit on an HTML wrapper (`docs/dev-rules/engineering-conventions.md` §7)                                                                                                                                                                                              | `session-breathing`                             |
| Loading spinner                             | `animate-spinner` (`--motion-spinner-cycle`, linear full turn); HTML wrapper only, static under reduced motion                                                                                                                                                                               | `tailwind.config.ts`                            |
| Hover / state colors                        | `transition-colors`, ≤ fast (150ms)                                                                                                                                                                                                                                                          | App-wide status quo                             |
| Menu row hover (shared dropdown panels)     | One layer glides between rows: `transform` + `opacity` on `--motion-instant` / `--motion-ease-out` (fade-out `--motion-ease-in`); row weight 400 → 500 and icon stroke 1.5 → 2 on `--motion-instant`; no slide under reduced motion (§4 Select & Dropdown) | `components/ui/dropdown-menu-highlight.ts` |
| Container transform (chip grows into panel) | 220ms — see the dedicated category below (explicit exception)                                                                                                                                                                                                                                | Composer permission/model selectors             |

_Reference-implementation paths in this table are relative to `apps/desktop/src/renderer/`._

#### Red lines (performance & restraint)

- **Persistent/looping animation may only touch `transform` / `opacity` on HTML elements** (compositor-only; `docs/dev-rules/engineering-conventions.md` §7 applies in full; nothing animates on SVG except the registered voice caret / level-bar exception above).
- Non-compositor properties (height/grid …) are allowed only in **one-shot transient animations** (user-triggered, with a definite end) — never persistent.
- Every new `@keyframes` / `animate-*` class must be registered in the `prefers-reduced-motion` whitelist in `globals.css` (the global `* { transition: none }` does not catch keyframes).
- Real-time direct-manipulation interactions (resizer drag, drag-follow) get **no easing** — following the hand IS the feedback.
- Forbidden: pointless displacement, unregistered bouncing, parallax, looping decoration, `transition-all`, and typewriter per-character animation on streamed text (streaming already is the motion). Interactions stay fast and direct. (Per-**word** opacity fade-in on streamed text is **not** the typewriter — see the sanctioned stream-word-fade class below: the word is fully laid out and only its opacity ramps; ruled distinct on 2026-08-07.)
- **Cadenced running shimmer (2026-08-07)**: the running status bar's breathing (`status-bar-shimmer`) is **event-driven, not an infinite loop** — one 1.5s dip (1 → 0.45 → 1, `steps(18)`) plays per real sign of progress (status text change / token count advance; re-triggered via keyed remount in `RunningStatusBar`, back-to-back plays merge through an animation-end pending flag). Silence (long thinking, tool wait) holds steady full opacity. Semantics: _breathing = producing_, not _heartbeat = alive_. New loading/working indicators should prefer this cadenced pattern over a new infinite loop.

#### Registered response: Usage History chart emphasis

正文已移至 [usage-history-charts.md](./usage-history-charts.md)，规范效力不变。

#### Exception category: container transform (chip lifts off and grows)

- The second sanctioned motion class: see [container-transform.md](./container-transform.md); this category's parameters and composer toolbar tiers live there.

#### Other sanctioned motion classes

正文已移至 [exceptions/motion.md](./exceptions/motion.md)，规范效力不变。

### 14.5 聊天正文的可点性信号(Clickability in message bodies)

正文已移至 [message-link-clickability.md](./message-link-clickability.md)，规范效力不变。

### 14.6 Icon-only Controls and Tooltips

- **Which component (owner decision C-07, 2026-11-11):** new icon-only actions use the square
  shared `Button` (frameless or outlined — §4 Buttons, Icon buttons), `ChromeIconButton` in the
  title bar and `SidebarIconButton` in the sidebar. Feature-local native icon buttons are legacy
  and migrate when touched.
- **Delivery contract for new and modified icon-only controls:** every icon-only interactive
  control has two labels: a localized accessible name (`aria-label`) and a visible `Tip`.
  Familiar glyphs, dense lists, and actions that only appear on hover are not exemptions: if
  the control has no persistent text label, users must not have to guess what it does.
- **Describe the action that will happen next.** Stateful controls say `Expand Sidebar` or
  `Collapse Sidebar`, not the vague `Toggle Sidebar`; their tooltip and accessible name
  change together. A disabled icon-only control explains why it is unavailable.
- **Do not duplicate persistent labels.** A button that already contains a visible text
  label normally does not need a tooltip. Decorative icons are silent and are not made
  focusable.
- **Tooltips supplement; they do not carry risk alone.** Destructive consequences,
  permission requests, and other information needed before acting must remain visible in
  the interface or confirmation flow.
- **Desktop action controls use the shared Radix `Tip`, not native `title`.** Native `title`
  remains acceptable for truncated persistent text, marked explicitly where the element is
  interactive. Shared icon-button primitives own this behavior wherever possible.
- **Windows system window controls are the narrow platform exception.** The shared
  `WindowControls` minimize, maximize / restore, and close buttons follow familiar Windows window
  chrome and do not require a visible `Tip`; they still expose localized accessible names. The
  maximize toggle uses a state-independent name because the Renderer does not own the native
  maximized state. This exception does not apply to Cindy-specific title-bar actions or panel
  controls.
- **Migration is incremental and guarded by surface.** Recursive regression coverage currently
  enforces this contract for app chrome, the title bar, the left sidebar and session list, and
  the right sidebar (`components/layout`, `components/sidebar`, `components/title-bar`,
  `features/cc-agent/sidebar`, and `features/right-sidebar`). Legacy feature-local controls
  outside those roots migrate when touched; their existence is not an exemption for new work.
- **Send button delivery tip (owner decision, 2026-11-19).** While a task is running, the
  composer has something to send and the task can be steered, the Send button's tip becomes
  `SendDeliveryTip` (`components/new-chat/SendDeliveryTip.tsx`). It replaces the banner that
  used to sit above the composer; the composer itself gains nothing at rest or while typing.
  - **When it opens.** After the standard 500ms hover, on keyboard focus, on right-click or
    on a touch long-press (which does not send). It never moves focus out of the editor.
  - **Two rows.** The row next to the button is always the default — what a click and the
    send key do — and carries the single glide highlight; the row above is the other mode.
    Clicking a row sends this one message that way and leaves the default unchanged.
  - **Modifier.** With Enter as the send key, holding ⌘ / Ctrl slides the highlight to the
    other row and the Send glyph follows (↑ for Steer, the glyph the queued-message Steer
    action uses; a clock for Queue); modifier+Enter and modifier+click send the other way.
    With modifier+Enter as the send key the other row names no key.
  - **Changing the default.** The swap icon at the left edge trades the two rows in place and
    sends nothing. Its visible label is the note inside the rows (「设为默认」 while pointed
    at or focused, 「已设为默认」 afterwards) rather than a `Tip` nested in a tip; its
    accessible name states the action. Settings keeps the same preference.
  - **Surface.** It is the one interactive layer that wears the tooltip surface:
    `--tooltip-bg` / `--tooltip-text` in both modes, with secondary text, the highlight and
    keycap fills mixed from `--tooltip-text` (`color-mix`), and the same text-derived hairline
    as the usage chart tooltip. No new tokens. Radii follow §5 (12px panel, 8px rows and swap
    button, 4px keycaps); motion uses `--motion-fast` and a 250ms row exchange (§14.4), both
    off under reduced motion. Every other tooltip stays plain text through `Tip`.

## 15. CINDY Skin Family(品牌化 family,新用户默认)

> This section records the CINDY skin family, the default for new users; it does **not** rewrite the §1–7 rules, which name roles and tokens rather than values; the Classic values are in the §10 generated table. Values were finalized from design-stage working files (`skin-docs/10-specs/` desktop, `skin-docs/30-mobile/` mobile errata — **not in this repo**, same status as the §16 login working files) plus the user's final sign-off of 2026-07-18. Zero discretion at implementation time: within the repo, the authoritative encodings are the DTCG sources in `packages/design-tokens` (generated into `cindy-light.ts` / `cindy-dark.ts`), `cindyDecisionData.ts`, and the frozen tests — this section is their prose summary.
>
> Subsection numbers are **stable identifiers** (referenced by §16, code comments, frozen tests, and other documents; 15.9 was never assigned) — do not renumber. Decision history for this section is archived in [`design-decision-log.md`](./design-decision-log.md).

### 15.1 Palette (extracted from Figma text nodes)

The CINDY palette values — page, card, border, text tiers, brand red, deep brand red and pure white — are listed in 15.16.

### 15.2 Red-Boundary Test Maps(品牌红边界)

- Current authority (post-E1D, see 15.10): `NEUTRAL_PRIMARY_EXPECTED_BY_ID` / `NEUTRAL_PRIMARY_FOREGROUND_BY_ID` (exact neutral values for primary actions) + `RED_EXCEPTION_ALLOWED_IDS` (the complete set of tokens allowed to contain red), all in `apps/desktop/src/renderer/themes/__tests__/cindyDecisionData.ts`.
- One-way ban: any token outside `RED_EXCEPTION_ALLOWED_IDS` containing `#DF0C27` / `#A61629` fails the suite.

### 15.3 Interpolation Table (sRGB per-channel `round(A+(B-A)*t)`)

See the skin decision table §2 (design-stage working file, not in repo). The Light/Dark 20/40/65/75% shades were frozen with exact values in unit tests (`#EFEFEF/#F1F1F1/#F4F4F4/#F5F5F5`, `#2B2929/#2D2B2B/#2F2D2D/#2F2D2D`). **Superseded 2026-08**: the interpolation shades were replaced by the ladder model of the color-ramp revision (rules in 15.16, decision record `token-decision-table.md` §9); the current frozen values live in `cindyDecisionData.ts`.

### 15.4 Cross-Theme Exemptions (not covered by CINDY overrides)

正文已移至 [exceptions/color.md](./exceptions/color.md)，规范效力不变。

### 15.5 U2 Explicit Exception — retired 2026-10-22

- **Retired by user ruling (2026-10-22).** CINDY text tiers are translucent ink (§2, §15.16), so the dark secondary `#6F6F6F` "stay true to Figma" exemption and the light `#888883` secondary no longer apply on Desktop. The reverse-frozen test in `cindyThemes.test.ts` group ⑦ is re-baselined to the ink ladder under this ruling; changing a tier's alpha still requires a fresh user ruling.
- Mobile keeps its own secondary values (`#4D4D4A` / `#BDBDBD`, §15.13) until its own phase.
- History (U2 2026-07-16, light re-tunes 2026-07-20 / 2026-08-13, mobile scope 2026-09-26) is in [`design-decision-log.md`](./design-decision-log.md).

### 15.6 HSL Format Contract

The 42 `HSL_FORMAT_IDS` must be HSL triplets (`h s% l%`, `h∈[0,360)`, grays use `hue=0`, 1 decimal place); every other token is hex/rgba. Translucent values append the same alpha as their rgba twin (`h s% l% / a`, e.g. the text tiers). Tailwind opacity modifiers on these slots (`border-border/40`) compile through `color-mix` (`tailwind.config.ts` `hslVar`), so a slot that carries its own alpha stays valid; never hand-write `hsl(var(--x) / a)` for a slot that may be translucent. Round-trip HSL→RGB channel error ≤1. Nothing outside `HSL_FORMAT_IDS` may be written as an HSL triplet. `cindyThemes.test.ts` group ③ checks both directions for the CINDY overrides (since 2026-11-11, E-12).

### 15.7 Brand Assets (icon + logo)

正文已移至 [exceptions/brand-surfaces.md](./exceptions/brand-surfaces.md)，规范效力不变。

### 15.8 status-badge-fg

- The orange badge (bg `status-bar-accent` `#EA6B17`) has its own foreground token `status-badge-fg`: **default mirrors `accent-pure-cta-fg`** (light white / dark black — zero change for the 9 existing themes); **CINDY overrides light to `#1F1F1F`, dark to `#121212`** (near-black; dark shifted with the 2026-08 ramp — see 15.16), contrast × `#EA6B17` = **5.19:1 / 5.90:1 ≥ 4.5** (user-approved; darken toward `#000000` if a future orange fails 4.5).
- No current UI consumes `status-badge-fg`. The token is kept as a compatibility item for older custom themes (same treatment as `shadow-chip-raised`): don't delete or rename the ID, and don't add new consumers without a new ruling (maintainer ruling E-10, 2026-11-11). `surface-on-card` stays neutral-inverse. Registered in `cindyDecisionData` (a D2-phase addition).

### 15.10 Red-System Boundary & Neutral CTAs — current state(E1D 红色边界)

- Ordinary primary actions never use brand red — they are neutral-inverse. **Neutral button four states**: light bg `#3C3F43` / text `#FCFCFC`, hover `#303337`, pressed `#27292D`; dark bg `#EEEEEE` / text `#151515` (2026-08: inverse dark text shifted with the darker ramp, was `#252222`), hover `#DFDFDF`, pressed `#D2D2D2` (WCAG 10.32/15.74:1). Hover and pressed are computed from the base by §4 Filled button states.
- Red is confined to brand display / splash surfaces (§15.7, §15.13) and semantic exceptions: `destructive`/delete, `error-*`, warning, diff red, status dots, the explicit Mobile Beta-channel state badge (`betaChannelBadgeBackground/Foreground`, user decision 2026-08-25), the Windows taskbar attention badge (§2), the quota critical fill (§2, §10), the Computer Use automated cursor (§15.7) and the Mobile list `activeGlyph` (brand red; Dark uses the deep `#A61629`) — plus the login brand accent via `--login-brand-accent` (§16). Red members of palettes that identify rather than signal stay registered with their palette and carry no red semantics: file-type badges and Bot avatar hues (§2, §10), task tags, screenshot annotation ink (§2), chart series and tier scales, and code syntax highlighting. This list is the complete red whitelist; other sections only refer to it. The Desktop sidebar's Beta label is ordinary version text. The older `brand-login-*` tokens were retired with the wave4 white-canvas login and survive only as whitelist strings in `cindyDecisionData.ts` (harmless — the whitelist permits, it does not require).
- **send-btn family**: `send-btn-bg/-icon/-disabled-bg/-disabled-icon` — CINDY overrides these to the neutral fill + disabled grays (light `#444242`/`#585555` unchanged; dark shifted 2026-08 to `#323232`/`#464646`); these sit in `cindyDecisionData` REQUIRED_IDS + CINDY_EXPECTED, guarded by assertion ③. `-hover-bg/-pressed-bg` are computed from `send-btn-bg` in every theme by §4 Filled button states. SendButton does not consume `-disabled-bg/-icon`: a disabled send keeps the normal `send-btn-bg/-icon` at 40% opacity, and the two disabled tokens stay registered for compatibility.
- **Sidebar color hierarchy** (same set for light/dark):
  - Body (session titles) = `text-foreground` (= `text-primary`: black ink 88% / white ink 82%, §15.16).
  - Secondary gray (timestamps / meta / group labels) = secondary ink (black 56% / white 55%, same as `text-secondary`), via CINDY overrides `sidebar-muted` (HSL with alpha) and `cmd-palette-item-meta`; leading icons at rest use `sidebar-action-icon` = tertiary ink (black 44% / white 40%). Since 2026-10-22 these follow the ink ladder (§15.16) instead of `#888883` / `#6F6F6F`.
  - Selected pill uses a softer surface: `sidebar-item-active` light `hsl(214.3 6% 99%)` / dark `#3C3F43`, foreground `sidebar-item-active-foreground` light `#292A2C` / dark `#EEEEEE`, border transparent. CTA colors stay independent. **Any foreground sitting on `bg-sidebar-item-active` must use `text-sidebar-item-active-foreground` — `text-foreground` is forbidden there** (the token defaults to foreground, so non-CINDY themes see zero change).
  - Running-state leading icons follow §15.14 (Thinking Orange, stays orange when selected).
  - Assertions: ③ CINDY_EXPECTED locks the 4 token values; ⑦ adds hierarchy assertions (secondary gray clearly weaker than body; selected-pill foreground ≥4.5 on its fill).
- Test maps: `NEUTRAL_PRIMARY_EXPECTED_BY_ID` / `NEUTRAL_PRIMARY_FOREGROUND_BY_ID` + `RED_EXCEPTION_ALLOWED_IDS` (replacing the pre-E1D `BRAND_RED_*` maps — archived in the decision log). Assertions ⑤/⑦/⑧ enforce exact neutrals, the red whitelist, neutral contrast, and falsifiability.
- Backlog: the five R2 §4.3 Project_List deviations stay deferred (see the decision log backlog).

### 15.11 Input Caret (`--caret-accent`)

- Every editable input surface takes its caret color from the `--caret-accent` token. `globals.css` owns this globally (native `caret-color` plus the ProseMirror pseudo-caret); components MUST NOT set their own caret color.
- **Registered exception — screenshot annotation text (2026-11-11, E-03):** while typing an annotation in the screenshot overlay, the caret takes the current annotation ink (`SCREENSHOT_INK`, §2 screenshot exception), so it previews the color being drawn on the user's image. It applies only to that in-overlay text field; every other input, including the plan editor and the CodeMirror editors, uses `--caret-accent`.
- Value: default themes = `var(--accent-cta-bg)` (neutral inverse, follows the theme). CINDY overrides both modes to `#417CDD` (information blue, same value as the focus ring); removed from `RED_EXCEPTION_ALLOWED_IDS`, value locked by `cindyDecisionData.ts`.
- Do not wire the caret to any red token — red is not in the caret's allowed palette.
- Do not alias the caret to `--focus-ring` even though the values match: the semantics differ, and `--caret-accent` must stay independently adjustable.
- Mobile parity: `inputCaret` in `apps/mobile/src/theme/tokens.ts` carries the same value in both modes, consumed via TextInput `cursorColor` / `selectionColor`; `themeTokens.test.ts` locks it.

_(Finalized 2026-07-18 after two same-day revisions — earlier "brand-red caret" wording anywhere is void; see design-decision-log.md.)_

### 15.12 Vibrancy (frosted glass) System (macOS / Windows; finalized 2026-07-18, Windows resize backing updated 2026-08-21)

- **Translucent-surface tokens**: `surface-translucent-sidebar` — CINDY light `rgba(238, 238, 233, 0.85)` / dark `rgba(5, 5, 5, 0.85)` (defaults to opaque `var(--surface)` in the default theme; zero effect on non-CINDY themes), consumed by the left sidebar (`aside.bg-sidebar`); and `surface-translucent-overlay`, the CINDY floating-menu glass behind `--cmd-palette-bg` (§4 Menu and popover panels). Any future translucent surface **reuses one of these two by default** — no new ad-hoc rgba. The splash root is opaque `--surface` (it must fully cover the mounted UI until loading completes — ruling 2026-07-19).
- **Wallpaper-through triple pipeline — missing any one yields dead black** (verified by on-device A/B, 2026-07-18):
  1. Set the vibrancy backing **at window creation** (`bootstrap-electron.ts` / `vibrancyConfig.ts`); changing alpha via `setBackgroundColor` at runtime is unreliable. macOS uses `backgroundColor: '#00000000'`. Windows Acrylic uses the current `surface-translucent-sidebar` RGBA as its steady-state BrowserWindow backing, and the ordinary sidebar CSS is transparent on that exact platform/material combination to avoid double tinting. The material remains stable during live resize; Renderer layout must follow the changing window through CSS rather than switching the native backdrop per gesture.
  2. Under CINDY themes the **root container steps aside**: globals.css sets `.h-screen.bg-content-area` (and the splash backing layer while present) to transparent — otherwise the opaque root blocks everything.
  3. **No CSS `backdrop-filter` on the ordinary sidebar** — it renders the transparent window backing as a black box; wallpaper blur is entirely the native vibrancy material's job. macOS CSS lays the translucent tint; Windows Acrylic gets that same tint from the creation-time native backing. The sidebar peek drawer is the intentional exception because it covers application content rather than wallpaper.
- Material selected via the `XDT_VIBRANCY_MATERIAL` env knob, **code default `hud`** (user-tested). Windows: Win11+ uses `backgroundMaterial` (default `acrylic`, `XDT_BACKDROP_MATERIAL` knob — not yet device-verified); Win10 / non-CINDY fall back to opaque `--surface`.
- **No gradient overlays on translucent surfaces** — the light-red gradient layer was confirmed absent from the design and removed wholesale (2026-07-18); the splash gradient glow is likewise unimplemented (backlog, awaiting a ruling).
- **Floating cards on `--cmd-palette-bg`** (menus, including the shared dropdown default): `--surface-translucent-overlay` + `blur(6px)` on macOS Cindy themes; opaque with no `backdrop-filter` on Windows (the rule 3 black-box risk; Windows native material not device-verified). See §4 Select & Dropdown.
- The `surface-translucent-sidebar` alpha is the **only open look-and-feel knob** in the theme-frozen zone; adjusting it requires synchronized changes in three places (`cindy-light.ts` / `cindy-dark.ts` / `cindyDecisionData.ts`) with the themes suite green.

### 15.13 Cross-Platform Skin Rules(双端换肤定稿规则,2026-07-18)

The execution rulebook for subsequent desktop / mobile UI updates. Sources: the skin-docs working files (not in repo) plus the 2026-07-18 dual-platform acceptance.

#### Red boundary

- Where brand red `#DF0C27` (and the deep `#A61629`) may appear on either platform is the §15.10 whitelist; this section adds no uses. Running / thinking states use Thinking Orange, never red (§15.14).
- Ordinary CTAs, FABs, send buttons, and confirm-style primaries are neutral-inverse: desktop values in §15.10; mobile light `#0F0F0F` / `#FFFFFF`, dark `#EDEDED` / `#121212` (2026-09-26, see Cross-platform color semantics). Never brand-red these.
- The red whitelist does not include carets, focus rings, ordinary buttons, or ordinary selected backgrounds. A new red consumer must document its semantics and enter the token/test whitelist first; no component-level hardcoding.

#### Caret & focus

- All input carets (`cursorColor` / `selectionColor`) are blue `#417CDD`, equal to `permAutoAccent` / desktop `caret-accent`; same value both modes.
- Focus ring, Auto Approval, and info blue share the `#417CDD` family. Figma's older blue `#426BF2` is not adopted.
- Red-family carets are forbidden.

#### Cross-platform color semantics (mobile owns its ramp)

正文已移至 [手机设计指南 §2](../../apps/mobile/docs/mobile-design-guide.md#2-颜色-token)，规范效力不变。

#### Iconography

- Session leading agent icons follow runtime identity: the Claude Code official pixel face / the Codex CLI `>_` multi-petal mark; desktop (`VendorIcon`) and mobile (`MobileVendorIcon`) share source assets (finalized 2026-07-20). Agent identity marks must not be mixed with Anthropic / OpenAI provider or model brand marks; `BrandArrow` is reserved for brand decoration.
- Model selection renders by model brand. Brand icons already replaced on desktop are reused on mobile from the same source.
- **Cross-platform action icons must match exactly (2026-09-08 owner ruling):** the same action on desktop and mobile uses the same source glyph and stroke geometry. For Lucide icons, use the same named glyph from `lucide-react` / `lucide-react-native`; a semantically similar SF Symbol or another icon family is not an equivalent replacement. Platform-appropriate size and semantic Light/Dark colors may differ, but the icon artwork must remain identical. This applies to native menus as well as custom components. Message menu baseline: `MessageSquarePlus` (add to chat), `Link2` (copy message link), `Undo2` (rewind), `Trash2` (delete message), `Pencil` (edit the last message; in the menu only while the task is running). If a native component cannot display the shared artwork, resolve the rendering approach explicitly instead of silently substituting a system symbol.
- **Mobile action-menu icon sizing (2026-09-08 owner ruling):** message, session, and file action menus use `iconSize.lg` (18 pt) and `iconStroke.regular` (2 in Lucide's 24-unit viewBox). Native menu assets follow the same logical size: 18 / 36 / 54 px at 1x / 2x / 3x; a 24-unit SVG viewBox does not imply a 24 pt display size. Keep the shared glyph geometry and scale the whole artwork. Existing compact filter/navigation menus may retain `iconSize.md` (16); `iconSize.action` (20) is the toolbar/lightbox tier, not the action-menu default. Preserve native menu row layout and touch targets when sizing the glyph.
- Send semantics use the filled paper plane `Send`, colored by the neutral-inverse CTA tokens; never a red send button or icon for ordinary send.

#### File identity: shared classification, two presentation sizes (2026-09-22)

- File identity is classified by `packages/maker-shared/src/filePresentation.ts` on both platforms. Known file names/extensions take precedence; MIME is a fallback for unknown names. This is presentation metadata only, never a decoder or permission decision.
- Compact file rows, search results, tabs, mentions, references and diff headers use `FileTypeIcon` / `pickFileIcon`: the same named Lucide glyph on Desktop and Mobile, regular stroke, inherited semantic foreground. At 12–18 px/pt, do not squeeze PDF/DOC/XLS text into the glyph. PDF, prose and word-processing documents may share `FileText`; the filename provides the finer distinction.
- Large attachment and generated-file tiles keep real content previews first. Without a preview, use `FileTypeTile` and the shared type label. Desktop reuses the attachment paper/badge artwork and registered file-badge tokens; Mobile uses the shared Lucide glyph and a separate readable label; at the 64 pt `iconSize.glyph` tier that glyph matches the file-browser folder glyph — `iconStroke.thin` with `absoluteStrokeWidth` on `borderStrong` — because Lucide's regular 2-unit stroke would otherwise scale to ~5 pt (2026-10-02). Labels must respect the platform micro-text minimum; never scale a labeled tile down into a compact icon.
- Categories cover code/configuration, text, PDF, documents, spreadsheets, presentations, images, audio, video, archives, databases and unknown files. New entry points reuse the shared classifier and platform components instead of adding extension tables.
- File-type decoration does not replace upload progress, errors, diff counts, rename/copy status or action icons. Folder navigation, pasted-text actions and generic “files” section icons keep their own semantics. Decorative file glyphs add no focus stop or duplicate accessible label.

#### Type & layout

- List pages use card density: 20pt gutter, 60pt row height, 12pt radius, 55pt FAB. Never regress to the loose legacy list or red ordinary CTAs.
- Chat headers use the frosted / translucent glass system: prefer `BlurBackdrop` + the dedicated chat-header tokens; where blur is not wired up, use translucent solid tokens + hairline — no unverified new blur entry points.
- Sheets consistently use the sheet tokens. Restyling shared components (`SheetSurface` …) defaults to variant isolation: only the surfaces the design covered (tasksheet / `SessionActionSheet` / `SessionMenuSheet`) take the new style; ContextSheet, ModelPicker, info sheets do not auto-follow.
- Hairline separators inside expanded blocks: every row but the last; colors via tokens, never hardcoded (see the mobile-light global border exception above).

#### Process gates

- New or changed colors go through tokens — desktop via ColorRegistry / CSS variables, mobile via `ThemeColors` / `useTheme`; no hex/rgba in components.
- `hardcoded-color-audit` (`scripts/hardcoded-color-audit.mjs`) runs in client-ci as `pnpm check:design-colors` and checks added lines only. It blocks new literal colors in Desktop renderer consumer code, and the same check also blocks off-scale corner radii (§5 Guard, governance §8); Mobile and other paths are reported, not blocked (Mobile keeps its own blocking token tests). Genuine exceptions (asset-intrinsic or platform-semantic) need a narrow, reasoned entry in `scripts/hardcoded-color-exemptions.json`. Scope, exemption format and rollback: [`design-governance.md` §8](./design-governance.md).
- When a design mock conflicts with existing tokens, list it as "pending ruling" in the spec / PR and request a decision — never self-adjudicate or substitute a near color.
- Shared-component restyles default to variant / prop isolation. Pages, states, and platforms not covered by the mock keep the status quo.

### 15.14 Running / Collaboration Orange (finalized 2026-07-20)

- **Running breathing icons are always Thinking Orange** (`--warning-accent` `#EA6B17`, all themes): VendorIcon, SessionStatusIcon (Puzzle/RadioTower), AutomationSessionGroupItem (Clock); breathing via `session-status-breathing`; the selected state stays orange — priority: running > selected inverse foreground > rest — with contrast ≥3:1 against the selected fill in both modes. Mobile `statusAccent` mirrors value and priority (glyphColor same).
- **Collaboration menu row ON state is orange**: the collaboration item inside the composer「+」menu sits beside Goal and Plan. Its active text + UsersRound icon use `warning-accent`; the row highlight remains the shared menu glide, and the OFF state stays neutral. This is an explicit carve-out from the 2026-07-17 neutral composer-menu rule for the ON state only.
- **SVG persistent-animation red line**: breathing-type persistent animation sits on an HTML wrapper (span); SVG stays static (engineering conventions §7).

### 15.15 Create-Page Content Position + Titlebar Hover Discipline

正文已移至 [new-task-home.md](./new-task-home.md)，规范效力不变。

### 15.16 2026-08 Color-Ramp Revision (warm ivory light / neutral near-black dark)

> Numeric source: the DTCG files in `packages/design-tokens` (generated into the Desktop defaults), with the CINDY expectations frozen in `cindyDecisionData.ts`. [`token-decision-table.md`](./token-decision-table.md) §9 is the decision record (full ladders, text tiers, contrast matrix, approval trail), not a numeric source (`design-governance.md` §11). This subsection pins the rules.

- **Light** = warm ivory: page `#F2F2ED`; every surface is warm with **B = R−5**, and the translucent borders and fills inherit that warmth (single warmth constant; one sanctioned ceiling exception — pure white `#FFFFFF` stays for floating planes that need maximum lift above the near-white card, currently `ask-option-list-bg` only). Cards stay near-white (`#FDFDF8`) — card lift ≈9.4%, matching the original spec. Hover/chip tiers sit **below** the page (the white ceiling leaves no room above); the sidebar is its own plane one step darker (`#EEEEE9` at 85% glass opacity).
- **Dark** = pure neutral: page `#181818`, cards `#1F1F1F`, all layers R=G=B (zero warmth), simple parallel shift from the 2026-07 values. Known debt: near-black compression keeps only ~65% of the original perceived layer separation — recorded in [#2559](https://github.com/makecindy/cindy/issues/2559), fix is the equal-luminance ladder.
- **Fixed in both modes**: brand red `#DF0C27`, deep brand red `#A61629` for hover and pressed (where red may appear is set in 15.2 and 15.10), and pure white `#FFFFFF`.
- **Text tiers (user ruling 2026-10-22, replaces the 2026-08 warm text ramp)**: one neutral ink at decreasing alpha, black in Light and white in Dark — emphasis 95% / 100%, primary 88% / 82%, description 70% / 66%, secondary 56% / 55%, tertiary 44% / 40%, placeholder and disabled 32% / 30%. On the page that measures 17.4 / 15.0 / 8.1 / 4.8 / 3.2 / 2.2 (Light) and 17.8 / 12.1 / 8.2 / 6.1 / 3.8 / 2.7 (Dark); the ≥3.0 floor for informational text holds on page, card and hover planes. Warmth now comes from the ivory surface showing through, not from per-tier hue shifts. Desktop only; Mobile keeps its values until its own phase. Decision record: token-decision-table §9.4.
- **Fills and lines (user ruling 2026-10-22, replaces dual anchoring)**: hover, chip, selected and pressed fills and all borders and dividers are the same ink at low alpha — soft hover 3.5% / 4%, hover and chip 5% / 6%, selected and pressed 8% / 10%, weak tier (file chip, scrollbar hover) 10% / 13%, borders and dividers 8% / 10% (Light black / Dark white). A translucent fill shifts whatever plane it sits on — page, card, popover, glass or wallpaper — by the same step, so page- and card-anchored variants are no longer needed, and in Dark a chip is always lighter than the card beneath it. Borders read softer on wallpaper than the former solid lines; this was accepted with the ruling. A line or fill that sits over a transparent window region (the layout dividers between panes under glass) is laid on the page color first, so the native window material never shows through. The Light switch off-track darkens to `#808080` so it keeps 3:1 on hovered rows. Decision record: token-decision-table §9.2–§9.3. Registered solid exceptions (owner decision, 2026-11-07): segmented controls (`segmented-option-fg`, `segmented-hover-bg` and the selected pill) and the sidebar selected pill (`sidebar-item-active`) stay solid, because they sit on tracks and sidebars they must stand out from at a fixed step. The shared menu / Select / sidebar row hover `sidebar-item-hover` is on the same hover step — black 5% / white 6% (maintainer ruling 2026-11-11, E-02; Dark was white 9% from 2026-07-21) — so CINDY Dark menus, sidebars and file trees hover at the same strength as buttons and list rows.
- **Icons on ink**: icons take their tier through `currentColor`, so an icon drawn from several strokes would turn darker (Light) or brighter (Dark) wherever its strokes overlap. In the CINDY family `globals.css` composites each icon as one shape — strokes drawn opaque, the whole icon masked to the ink's alpha — so it reads like a solid icon at reduced opacity; opaque icon colors are unchanged. Lucide icons get this automatically; a hand-drawn single-color icon made of several strokes adds `data-ink-icon`. Don't add it to an SVG whose parts carry their own colors: the mask would fade those parts too.
- **Twin sync**: every color carried in both hex/rgba and HSL forms (24 pairs) must stay value-identical, translucent tiers included (same alpha in both forms). Pairs follow the tier, not the token name: `text-tertiary-hsl` / `muted-foreground` serve the secondary tier (`text-secondary`), exactly as in Classic. Control outlines such as `chat-input-border-focus` keep their own values and are no longer derived from a text tier.
- **Exempt families untouched**: `login-*` (60 tokens; since 2026-10-23 its text tokens, and since 2026-10-27 its panel, control, border, primary-button and hover/pressed tokens, take the same values as the CINDY skin, §16.1, but stay protected from theme overrides), `diff-*`, `error-*`, `overlay-*`, semantic status colors, shadows — per §10/§16 and `protected-tokens.ts`.
- User-tuned one-offs: dark sidebar glass `rgba(5,5,5,0.85)` (2026-08-11); light sidebar glass 85% opacity (2026-08-17, aligned with dark).

### 15.17 Switch color and motion (owner decisions 2026-09-15 / 2026-09-16)

- Desktop CINDY Light and Dark both override `switch-track-on` to `#417CDD`, replacing the 2026-08-05 Light `#4A4D51` / Dark `#EEEEEE` decision. Blue adds an enabled-state signal to the existing thumb-position cue.
- The 2026-09-16 approved HTML study makes CINDY Dark's checked and unchecked thumbs near-white `#FCFCFC`. `switch-thumb-on` is a dedicated role; its registry default remains `hsl(var(--background))` so old themes and customized backgrounds continue to apply. CINDY Light retains `hsl(var(--background))` for ON and `var(--surface-on-card)` for OFF. Never change global `background` to recolor a Switch.
- The shared Desktop Switch keeps its 36 × 20 track and 16 × 16 resting thumb. Mouse hover widens the thumb to 17 × 16; press/drag uses 18 × 14 (the user reduced the earlier 20 × 12 prototype). The outer edge stays anchored, the thumb stays vertically centered, and the original focus treatment and shadow-free pill shape remain. A transparent hit area provides at least 24px height without resizing the visible track.
- Motion: geometry uses `--motion-fast` / `--motion-ease-out`; track color uses `--motion-instant`. No overshoot. Dragging tracks the pointer after 2px of horizontal travel; release chooses the nearest state, cancellation restores the current value, and each completed change uses the existing Radix click/form/callback path once. Disabled controls do not deform or drag; opacity remains track 0.3 × thumb 0.5. Reduced motion changes state/shape immediately.
- Scope: approved thumb colors belong to CINDY; shared Switch feedback applies across Desktop themes. Ordinary CTAs keep their own contracts. Mobile retains its separate baseline pending its own follow-up.
- Values live in the DTCG sources and generated theme defaults/overrides. `cindyDecisionData.ts` and the builtin-theme fixture independently freeze the approved values; `switchThemeContrast.test.ts` guards both states against the thumb and all five surfaces (checked blue minimum: Light 3.50:1 / Dark 3.97:1). Component input tests cover controlled/uncontrolled use, form events, drag cancellation and disabled behavior.

### 15.18 Slider family (owner-approved 2026-09-17)

Three shared Desktop variants: numeric (`ui/slider`), reasoning effort (`ui/effort-slider`),
and media position (`ui/media-scrubber`, seconds in/out). Native media controls are excluded.

- Numeric: 6px track, 36px transparent hit height; thumb 16×16 → hover 18×18 → pressed 22×16.
- Media: 4px track, 28px hit height; thumb 10×10 → hover 12×12 → pressed 14×10.
- Effort: retain tier-colored 21×21 thumb, 2.5px panel-colored border (registered exception to the §7 border rule, owner decision B-10, 2026-11-11) and 4px same-color 22% halo;
  hover 23×23, pressed 27×21. Preserve absolute tier colors, continuous drag and release-to-commit.
- Geometry changes actual width/height with full pill radius, never elliptical scale. Hit regions
  stay fixed. Geometry uses motion-fast/ease-out; position follows the pointer immediately;
  reduced motion suppresses deformation and transitions. Enabled pointer cursor is ew-resize.
- Numeric/media thumbs have no normal border and use slider-thumb-shadow: Light
  0 1px 3px black 18% + 0 2px 6px black 8%; Dark 30% + 16%. This narrow exception
  makes the movable handle readable without outlining it; it does not permit Switch shadows.
- Independent CINDY tokens: track Light #A3A39E / Dark #626262; fill #3C3F43 / #EEEEEE;
  thumb #FDFDF8 / #FCFCFC. Other themes follow semantic border/text/surface slots.
  Brightness must not inherit Switch blue. Keyboard focus remains visible; disabled controls
  do not change values. Media supports arrows ±1 second, Home/End, and unknown-duration disable.

## 16. Login Flow (登录链路)

正文已移至 [login-flow.md](./login-flow.md)，规范效力不变。

§16.1 视觉风格、§16.2 设计规则、§16.3 组件定义、§16.4 登录链路逐屏与 §16.5 深色模式与主题跟随都在该文件，编号不变。

## 流式正文与可组合组件

正文已移至 [chat-surfaces.md](./chat-surfaces.md)，规范效力不变。
