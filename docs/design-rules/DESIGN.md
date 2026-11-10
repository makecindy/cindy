# Cindy Design System

## 阅读路由

本文件是 Cindy 视觉规则的入口，不需要通读。本节只指路，不写参数；每个参数只在对应章节保留一份。

所有界面改动先读本节、§1 和 §7，再按下表读与任务相关的部分。

| 要做的事 | 优先复用 | 规则位置 |
| --- | --- | --- |
| 文字按钮 | `components/ui/button.tsx` 的 `Button` | §4 Buttons |
| 只有图标的按钮 | 标题栏 `ChromeIconButton`、侧栏 `SidebarIconButton`；其他位置暂无通用组件 | §14.6 |
| 输入框 | `components/ui/input.tsx` 的 `Input` / `Textarea`；已有设置页输入用 `SettingsTextInput` | §4 Inputs & Forms |
| 表单字段的标签、说明和错误 | `components/ui/form-field.tsx` 的 `FormField` | §4 Inputs & Forms |
| 单选下拉 | `components/ui/select.tsx` 的 `Select` / `SelectParts` | §4 Select & Dropdown |
| 菜单 | `components/ui/dropdown-menu.tsx`；自带外壳的菜单复用 `menu-row.tsx` | §4 Select & Dropdown |
| 浮层 | `components/ui/popover.tsx`；输入框工具栏用 `MorphPopover` | §4 Select & Dropdown、[容器形变](./container-transform.md) |
| 悬停提示 | `components/ui/tooltip.tsx` 的 `Tip` | §14.6 |
| 确认弹窗 | `useConfirmDialog`、`ConfirmDialog` | §4 Dialog & Modal |
| 其他弹窗 | 暂无通用组件：Radix Dialog 加 `.modal-scrim` / `.modal-panel`，结构参考 `confirm-dialog.tsx` | §4 Dialog & Modal |
| 分段切换 | `components/ui/segmented-control.tsx` 的 `SegmentedControl` | §4 Desktop segmented controls |
| 开关、滑杆 | `Switch`、`Slider`、`EffortSlider` | §15.17、§15.18 |
| 复选框 | `components/ui/checkbox.tsx` 的 `Checkbox` | §4 Desktop settings controls |
| 加载中 | `components/ui/spinner.tsx` 的 `Spinner` | §14.4 |
| 错误与通知 | `ErrorNotice`；短通知用 `lib/toast.ts` | §4 Error notices、§4 Toast |
| 展开收起 | `components/ui/collapse.tsx` 的 `Collapse` | §14.4 |
| 聊天内容 | `chatChrome.ts`、`activityRowChrome.ts` | §4 Desktop chat and operation authorization |
| 设置页分区和行 | `components/ui/settings-rows.tsx` 的 `SettingsSection`、`SettingsCard`、`SettingsRow`、`SettingsField`、`SettingsBlock`、`SettingsPageHeader` | §4 Desktop settings rows |
| 选颜色 | 语义 Token，不写色值 | §10 Token Selection Rules for New UI、§2 |
| 亮暗模式 | 语义 Token | §10 Light / Dark Dual-Mode Delivery Gate |
| 圆角与点击区域 | 上述组件的默认值 | §5 Border Radius Scale、[治理合同](./design-governance.md) §13 |
| 字号、字重、行高 | Tailwind 字号档位 | §3 |
| 动效 | Motion Token | §14.4 |
| 界面文案 | i18n 键 | §11、[术语表](../../i18n/GLOSSARY.md) |
| 修改 Token、主题或标准组件 | 现有生成链路 | [治理合同](./design-governance.md)、[Token README](../../packages/design-tokens/README.md) |

只在改动对应功能时才读下面的专题：

| 专题 | 文件 |
| --- | --- |
| 登录、注册与回调页（§16） | [login-flow.md](./login-flow.md) |
| 聊天正文的链接与可点性（§14.5） | [message-link-clickability.md](./message-link-clickability.md) |
| 输入框工具栏的容器形变 | [container-transform.md](./container-transform.md) |
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
语言不用阴影，窄例外由 §10 的 Token 约束。工作区不放吉祥物或装饰插画，品牌图像只出现在
§15.7 / §16 允许的品牌界面；用户主动选用的[应用壁纸](./wallpaper.md)除外。

Inter 是标题与正文共用的唯一无衬线字体，配柔和几何让强大的工具容易接近。普通操作框默认
胶囊，内容容器与已登记形状按角色处理，圆角分类统一见 §5。

颜色经语义 Token 表达，同一角色在 Light 与 Dark 下都成立。复用组件让一致的设计自然延续。
排版、几何与状态的精确约定在后续章节。

### 1.1 New-task home content (user decision, 2026-09-06)

The new-task home does not display the inherited-subscription or promotional-credit
notice cards. With a usable model, the composer is followed by suggestion rows;
the existing zero-model action remains available when no model can be used.
Subscription details belong in provider settings, and credit balances and expiry
details remain in billing settings.

Removing these two cards is an explicit product decision, including for users who
have not dismissed them. Do not restore them or move them to another automatic
notice surface merely to preserve their former one-time-notification behavior.
The decision and review correction are recorded in
[`design-decision-log.md`](./design-decision-log.md) (2026-09-06).

## 2. Color Palette & Roles

> **Multi-theme note**: the values in this section are the concrete **Default Light / Default Dark** (base theme) palette, given as the visual-spec reference sample. At runtime **every color is consumed through a token** (see §10 Theme System & Token Reference), so the same component automatically renders each theme's own colors under other themes (Eclipse / One Dark Pro / Monokai Pro, …). **When implementing components, always write tokens, never hex** — rules in §10.

### Primary Text

- **Near Black** (`#262626` Light / `#d4d4d4` Dark, token `--text-primary`): primary headlines, body text, primary links and button text on light-colored surfaces — the strongest ordinary text tier; only the registered emphasis tier (§15.16) goes further. In the CINDY themes the same token resolves to translucent ink (§15.16).
- **Pure Black** (`#000000`) is not part of the ordinary text tiers: body and heading text use `--text-primary`. It remains only where a section registers it — the Light fill of the maximum-emphasis Black Pill CTA (`--accent-cta-bg-pure`) and the inverse CTA foreground (`--accent-pure-cta-fg`, Dark `#000000`, §4 Buttons) — and in local text tokens that keep their own value (for example `--chat-input-text` in the default Light theme).

### Layer System (Light & Dark)

The interface is built from a three-tier layer system that applies symmetrically to both modes — **Surface** as the base, **Card** as the elevated layer, and **Board** as the hairline divider. This is the foundation of every page in every mode.

| Role        | Light Mode | Dark Mode | Usage                                                                                                                                                                              |
| ----------- | ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Surface** | `#f8f8f6`  | `#1f1f1e` | The primary page background — every page starts here. In full-window app layouts, this is the single flat background. In centered-card layouts, this is the page beneath the card. |
| **Card**    | `#ffffff`  | `#2c2c2a` | The elevated layer sitting on top of Surface — login cards, modals, panels, raised containers, and any element that needs to visually lift off the page.                           |
| **Board**   | `#d7d7d4`  | `#3c3c3a` | The hairline divider color — 1px borders between sections, card outlines, and any separator line within the same layer.                                                            |

**Layer rule — flat vs. elevated:**

- **Full-window applications** (e.g. main workspace, chat interface, dashboards): use **Surface** as a single flat background for the entire window — no Card layer at the page-structure level. Section boundaries (sidebar, toolbar, content area) are drawn with 1px **Board** dividers, never with background color shifts.
- **Centered-card layouts** (e.g. login, modal, empty-state card on a blank page): use **Surface** as the page background and **Card** as the lifted card. The color difference between Surface and Card is what makes the card read as "lifted" — no shadow needed. The card outline is drawn in **Board**.

> **Important — element-level vs. page-level:** The "flat Surface" rule in full-window layouts applies only to the **overall page structure**, not to individual widgets. Lifted widgets _within_ a full-window layout — inputs, chat input boxes, raised cards, modal overlays, panel popups — still use **Card** color per their component rules (see Section 4). A full-window chat interface can have a flat Surface page _and_ a Card-colored chat input box at the same time; those are two different scopes. "Surface flat" means "don't split the page into Page+Card layers," not "every element on the page must be Surface color."

### Optional application wallpaper (user decision, 2026-10-01)

正文已移至 [wallpaper.md](./wallpaper.md)，规范效力不变。

### Task tag identity colors

用户确认的任务标签色板为红、橙、黄、绿、蓝、紫、灰、粉、珊瑚、青、靛蓝、白共十二色。只用于标签色球与编辑色板，表示用户分类，不表示任务运行状态。色球为圆形、细描边，选中时勾位于球内；白色在 Light/Dark 中均保持白色，用独立深色勾保证对比度。Desktop 使用 `task-tag-*` 语义 token；Mobile 使用对应 `taskTag*` 色板字段。默认面板只显示选择列表，添加或编辑后才显示名称和两行六列色板，不显示双击编辑提示。

### Personal message bubble colors (Mobile, 2026-10-12)

正文已移至 [手机设计指南 §9](../../apps/mobile/docs/mobile-design-guide.md#9-从根规范迁入的手机规则)，规范效力不变。

### Chip & Button Neutrals

Small interactive chips (button backgrounds, tag pills, avatar fills, selected-nav pills) sit outside the layer system — they're foreground elements, not background layers.

- **Light Gray** (`#e5e5e5`): Chip/button backgrounds in Light Mode — the workhorse neutral for pressed states, filled pills, tag backgrounds, and avatar fills.
- **Dark Chip** (`#3c3c3a`, token `--surface-chip`): the primary chip/button background in Dark Mode — one step lifted above a Card or Surface context.
- **Dark Chip Alt** (`#2c2c2a`, token `--surface-chip-alt`): the variant that collapses to the Dark Card value — used where a chip sits directly on Surface and only needs the Card-level lift. When in doubt, use `--surface-chip`; see §10 for both slots.

> ~~**Border Light** (`#d4d4d4`)~~ — deprecated (2026-06, G2). Once labeled the "white-button border color", but no real component ever used it (only bare hardcodes in the experimental view). White Pill secondary borders uniformly use **Board** (`--border-default` `#d7d7d4`).

### Neutrals & Text

**Text tiers (user decision, 2026-10-22).** Neutral text follows one ordered ladder: primary > description > secondary > tertiary > placeholder/disabled. The CINDY family keeps every step distinct; other built-in themes never invert the order, though some share one value for description and secondary. In the CINDY family every tier is the same ink at decreasing alpha — black in Light, white in Dark (values in §15.16) — the way Apple's label colors work: a translucent tier keeps its step on glass, wallpaper, hover fills and cards, and picks up the warmth of the surface beneath it. Don't recreate a tier with a solid gray picked by eye, and don't fake a tier by fading an element with `opacity`. Text on inverse surfaces (selected pills, tooltips, CTAs) uses its dedicated foreground token, never a translucent ink tier. The same ink at low alpha draws the CINDY hover, chip, selected and pressed fills and its borders and dividers (§15.16). The hex values below are the Classic (default) theme's reference sample.

- **Stone** (`#737373`): Secondary body text, footer links, and de-emphasized content. The primary "muted" tone.
- **Mid Gray** (`#525252`): Emphasized secondary text, slightly darker than Stone.
- **Silver** (`#a3a3a3`): Tertiary text and deeply de-emphasized metadata. **Never use it as a placeholder** — too prominent, reads as filled-in (see §4 Inputs; the G3 erratum is archived in [`design-decision-log.md`](./design-decision-log.md); placeholders use `--text-placeholder` `#c4c4c4`).

> ~~**Button Text Dark** (`#404040`)~~ — deprecated (2026-06, G1). Once labeled the "white-surface button text color", but no real button ever used it (only bare hardcodes in the experimental view). White Pill secondary text uniformly uses **Near Black** (`--text-primary` `#262626`).

### Semantic & Accent

**Mobile group mention text** — 用户 2026-11-04 要求群聊 `@点名` 样式对齐 PC；专用 `groupMentionText` 采用 CINDY Light／Dark `msg-link` 的对应色（Mobile 数值正本 `apps/mobile/src/theme/tokens.ts`），只用于群聊已识别点名，不用于普通链接、状态或其他文字。仅着色，不另加下划线、底色或字重；身份入口与边界见 §14.5、`bot-group-chat.md`。

- **PR/MR merge conflicts (user decision, 2026-11-05)** — an open, non-draft PR/MR with a confirmed merge conflict uses `--warning-fg` (Mobile `warningFg`) on its existing state icon across headers, sidebars, companion cards and management lists; no extra icon. Draft, merged and closed keep their main-state colors. The Desktop hover panel shows a separate Merge / Conflicts data row for open and draft conflicts, with a warning-colored, medium-weight value; its header stays unchanged. The button's accessible name includes the conflict. Unknown or absent conflict fields add no signal; passing checks remain independent. Both Light and Dark use the same semantic tokens. Plugin cards are outside this scope and retain their existing merge-state text row.

Toast loading is neutral: use the shared 16×16 Spinner in `--text-secondary`, with polite status semantics. Keep it visible until the operation settles and explicitly dismiss it; only failures use the error variant.

The grayscale rule is near-absolute. The following are the **only** sanctioned non-gray colors in the system — each tightly scoped to a specific surface. New semantic colors must not be introduced without being recorded here first.

- **Focus Blue** (`#417CDD` at 50%; tokens `--focus-ring` / `--focus-ring-soft`): the keyboard-accessibility focus ring, finalized 2026-07-17 (replaces Tailwind's default `#3b82f6`). Keep it out of mouse-only interaction: controls show it on `:focus-visible`, not on click. Text inputs are the approved exception — a focused text field always matches `:focus-visible`, so the generic `Input` shows the soft ring `--focus-ring-soft` whenever focused, while settings and composer inputs use their own focus-border aliases (§4 Inputs).
- **Thinking / Warning Orange** (`#EA6B17`, finalized 2026-07-17, replaces the frozen `#FF6600`): the shared warning-accent family, identical in both modes. Sanctioned consumers only — the ChatView Running Status Bar (sparkles icon + status text, e.g. `Spelunking...`, no background fill), running-state breathing icons in the sidebar, the collaboration-mode menu row's ON state, the plan-approve icon, the Full Access permission highlight, the settings integration warning, and the workflow agent status strip's running cells (8×8px filled squares in the background-tasks panel detail and the workflow chat card, registered 2026-07-28 — running-state semantics, same family as the sidebar breathing icons; the done/failed/queued cells stay on their own semantic tokens: `--card-status-done` / `--error-fg` / `--surface-chip`), and the sidebar task-info PR unresolved corner dot (registered 2026-08-17 — same `--status-bar-accent` as the session-header unresolved count; static, no breathing), and the filter reminder dot (registered 2026-10-20 — a static 6px/6pt dot at the top-right corner of a filter or view-settings button, meaning "this list is not the default active view": the search filter button while any narrowing filter is applied, and the sidebar organize button / Mobile home `⋯` display-settings button while viewing archived tasks; same `--status-bar-accent` / `statusAccent`, no breathing, no text; Desktop shares one `FilterReminderDot` component and Mobile one `FilterReminderDot` component so size, offset and color live in one place; it is purely visual, so the button's accessible name or state must carry the same information; sort and grouping changes and the "all" status do not light it), and the Desktop private-Bot running subtitle (local, remote and merged Cindy; registered 2026-11-04, matching the group row’s 11px breathing sparkles and orange progress text; see [Desktop list status](./desktop-bot-list-status.md)), and the Bot group chat speaking row (registered 2026-09-27 — sparkles icon + status text for the teammate currently taking its turn, the same running semantics and `--status-bar-accent` as the ChatView Running Status Bar; no background fill), and the running step of a Bot group chat 分工 plan card and the group's sidebar 「正在做 / 正在安排」 preview (registered 2026-09-27 — icon + status word of the one step in progress, same running semantics and `--status-bar-accent`; no background fill; done / pending / failed steps stay neutral), and the Desktop Bot delegation card status dot (registered 2026-11-04 — starting/running use `--warning-accent` with `session-status-breathing`; waiting/completed/failed use `--card-status-awaiting` / `--card-status-done` / `--card-status-error`, while cancelled/unknown stay neutral; see [Desktop delegation status](./desktop-bot-delegation-status.md)) (see the §10 exemption table and §15 for the full token list: `--warning-accent` and its follower tokens). A consumer that introduces no new token — one that reads `--warning-accent` or an existing follower directly, like this strip — is registered by this list alone; a consumer needing a NEW token must also be registered in the §10 exemption table.

> **Additional narrowly-scoped exceptions** (documented in their respective component specs, do NOT generalize as system semantic colors):
>
> - **Screenshot toolbar Cindy icon** — the star icon before “Cindy” in Desktop's `ScreenshotModeBar` uses the existing gold foreground `--warning-fg` (`#F3A115` in Light and Dark; user decision 2026-10-28). Only this entry icon is gold; its label and button keep their standard theme colors and disabled treatment.
> - **Quota colors, one rule everywhere** (owner decision 2026-10-31) — every surface that colors a quota (Desktop usage card, composer chip and model picker; Mobile model picker and session menu; macOS menu bar panel; iPhone widgets) judges the window it shows (the panel and widget tubes show each account's weekly window) by `@cindy/maker-shared/quota-level`: **30% or less left is yellow `#F3A115`, 10% or less is red `#EF4444`**; a provider verdict only raises the level (a warning is at least yellow, exceeded/rejected is red). A balance is judged by its share left and is red when empty. Desktop `--quota-bar-warn` aliases `--warning-fg`, `--quota-bar-crit` aliases `--error-flat` (`#EF4444`, unchanged; owner decision 2026-10-31: `#D91F37` read too dark on dark widgets); Mobile `quotaBarWarn` / `quotaBarCrit`. When plenty is left, App bars and the Mac panel stay neutral; only the iPhone widget liquid is teal (`#14B8A6` / `#2DD4BF`). On tube surfaces (Mac panel, iPhone widgets) the percentage and amount keep their ink at every level; only the liquid, its glow and the detail ring carry the color (owner decision 2026-10-31). The reset time has its own rule there: it colors only when a window longer than a day will reset with quota still unused at the current pace (used so far ÷ elapsed time, extended to the reset; the Cindy period quota is a budget and never colors its time) — a day or less to go is yellow, six hours or less is red, otherwise ink. It is independent of the liquid color, and 5-hour windows never color their time (`resetTimeLevel` / `willLeaveQuotaUnused` in the same module; the widget counts it from the current time). Text-only indicators with no bar (Desktop composer chip, model-picker row percentage, Mobile session menu) color the number itself, since it is their only signal. The Claude composer chip temporarily includes the total weekly window when a model-specific week would otherwise hide an alerting total. Only each remaining percentage carries its quota color; separators and task value stay neutral. A rejected request adds a separate red “Temporarily limited” segment, with the existing quota popover showing the limit notice and known reset times. Missing severity in incremental headers does not clear a still-valid window warning; full snapshots, explicit severity or window rollover confirm recovery (user decision 2026-11-11). Pace (running out before reset) does not change a color; it only drives the menu bar headline.
> - **Mobile model-picker account quota bars** — owner-approved desktop parity (2026-10-23): `quotaBarWarn` marks remaining quota at or below 30% and above 10%; `quotaBarCrit` marks remaining quota at or below 10%. Both are quota-only semantic fills registered in §10, independent of the owner-crown and task-error roles. Normal quota remains neutral (`textSecondary`), and the track uses `surfaceChip`. iOS / Android share the real remaining proportion without a minimum fill width; 0% is empty. Keep the numerical percentage alongside the bar, so color is supplementary and never the only information. These colors do not apply to the account title, percentage text or row background.
> - **Cindy Make source comparison** — the owner-approved source overview (2026-09-20, refined 2026-09-21) combines local main and the online target in one row, with personal below. Matching main hashes appear once in `--status-success`; differing hashes show the local value in `--text-secondary` → the verified online target in `--status-success`, with a `--text-tertiary` arrow. The online green identifies the official target even when local main is behind; difference counts remain explicit. Personal uses an icon-first label flush with the main row's left edge, without chip fill or inset padding: status icon, then `cindy-personal` with the localized status in parentheses, followed by the SHA and change count. The icon, name and parenthesized status inherit one color. Latest uses a check and `--status-success`; missing official updates use a download icon and the existing Light/Dark update foreground `--upgrade-banner-fg`; an inconclusive comparison uses a help icon and `--text-secondary`. The status stays visible; the shared hover/focus `Tip` may explain it further. This is informational, with no click action. During operations that replace the comparison, keep the name neutral and omit the status icon, suffix and tooltip. Personal-only changes do not invalidate latest; unavailable lookups never imply latest or an available update. Each source row wraps independently. Both modes use existing tokens; no other version surface inherits this treatment. Since 2026-10-01 (owner-approved plain-language Settings, [cindy-make-upstream.md](../cindy-make-upstream.md)), this hash comparison, the source path and its open/clear buttons sit inside the default-collapsed native `details` disclosure “Technical details (for developers)”; the visible overview is the plain-language `CindyMakeVersionSummary` (personal: official version + N changes; latest official: release/beta/dev label + included / not yet / can't confirm). The summary reuses the same verified comparison, the same check / download / help icons and `--status-success` / `--upgrade-banner-fg` / `--text-secondary` colors, shows no hash, branch or main, and is plain text because the technical comparison keeps the single live status region.
> - **Shared-task mobile confirmations** — only the management page is full-screen. Remove, leave, close-current and close-all use compact confirmations. iOS retains `showConfirm` and the system Alert with supported Liquid Glass / older-system fallback. On 2026-09-20 the user rejected Android's default green-text system Alert: Android uses a centered content-height card, container radius 12, themed elevated surface, neutral outlined Cancel and pill-shaped solid danger action using `sharedTaskConfirmBackground/Foreground`. Reuse Mobile action primitives, minimum target 44, wrap actions when needed, and scroll long descriptions. Android Back cancels; the scrim does not dismiss. Cancellation preserves the task, page, tab and scroll position. An in-task guest exits directly from task details, without another management page. No native configuration changes or simulated iOS glass. Desktop retains the Plan B shared window.
> - **CINDY checked Switch** — `--switch-track-on` uses blue `#417CDD` in CINDY Light and Dark (owner decision 2026-09-15, §15.17). This is an enabled-state signal, independently adjustable from focus, caret and Auto Approval despite sharing their current hue. Other themes retain their own checked-track colors.
> - **Windows taskbar attention badge** — the native OS overlay uses a fixed red background (`#D91F37`) and white digits with no outline (`#FFFFFF`) in both Light and Dark taskbars. This is the count of local tasks needing attention, not an error-only status and not a literal total of every task. Device-link sessions owned by another machine are excluded, as are automation-generated sessions (scheduler source or a legacy Schedule title prefix) and a heartbeat completion (done with an unread run) bound to an ordinary task. A local learn session is not that exception: awaiting-review is a review the user must handle on this machine, using the same done / awaiting / error signals. Later awaiting or error attention on a heartbeat-bound ordinary task still counts. The image-specific semantic pair lives in `apps/desktop/src/main/windowsBadgeIcon.ts`; it is not an in-app theme token. Keep a 16-logical-pixel transparent canvas and center the circle and digits at 80% of their original size (user refinement, 2026-09-16). Render using the highest connected display scale and pass that physical-size image directly to the Windows Shell through the native taskbar bridge (Electron 41 otherwise forces overlays to 16 physical pixels). Redraw after display/DPI changes and taskbar recreation; keep the multi-resolution Electron overlay as a failure fallback. Use a circle for one digit, a rounded square for multiple digits, and `99+` above 99. The accessibility description keeps the exact total. Only the OS image may use its fitted 8–12px system-font digits; web typography and status-dot color rules are unchanged.
> - **Toast Info / Success / Warning / Error** — `#417CDD` / `#2AAE5B` / `#F3A115` / `#D91F37`(finalized 2026-07-17; Toast exemption lifted) — used ONLY on the 16×16 lucide icon inside Toast pill notifications. The pill body (background, text, border, close icon) remains strictly grayscale. Info blue #417CDD equals the focus-ring / Auto Approval value (originally #3B82F6, added 2026-07-14, now finalized); success/warning/error equal the global status colors (done green / status error / warning foreground).
> - **Usage History category color (owner-approved 2026-09-08, extended 2026-09-09).** The registered usage heatmap uses a blue intensity scale. Daily token bars and their corresponding model-table swatches/share marks use `--usage-model-1` … `--usage-model-5` as the seed palette; additional models receive theme-derived hues without a top-five cutoff. All model identities in the full history are included, even when absent from the last 30 days. Agent/harness swatches, share marks and the stacked share strip reuse the existing engine identity tokens: `--engine-badge-cc` (terracotta orange), `--engine-badge-codex` (blue), and `--usage-model-1` (owner-chosen teal for pi, to distinguish it from Codex blue). Claude/Codex retain their cross-mode fixed-value contract; pi follows the existing Light/Dark teal values. `--usage-heatmap-high` supplies the high end of the heatmap. The heatmap retains its process-blue alias; category colors do not inherit process/status semantics. Task marks, text and control frames stay neutral. **Extended 2026-10-17 (owner approved the prototype):** the provider「远程与分享」page reuses the same charts and tables for provider usage; there the same seed palette and derivation also colour the person and group-computer categories (bars stacked by person / computer / model, plus each table's swatches, share marks and share strip), ranked by a fixed order (people as listed, computers in group order, models by full-history tokens) that filters never reassign. No new tokens, shapes or status meaning. See [the component specification](./usage-history-charts.md); colors.ts remains the seed-value source, with runtime derivation under governance §3.4.
> - **Resource Usage Process Categories** — the Resource Usage table may color only its 14px process-type glyphs so dense rows can be scanned by category (user-requested 2026-08-06). The six category pairs are task Agent blue `#2563EB / #60A5FA`, Agent service purple `#7C3AED / #A78BFA`, main-process pink `#DB2777 / #F472B6`, renderer cyan `#0891B2 / #22D3EE`, GPU amber `#D97706 / #F59E0B`, and utility green `#059669 / #34D399` (Light / Dark). These colors encode process category, **not health or status**; row backgrounds, labels, metrics, selection and actions remain on the neutral system. Direct use is confined to `resource-usage` process glyphs; the explicitly registered Usage History heatmap alias above may also reference the task-blue value. No other table or process UI inherits this permission. Tokens: `--process-agent-task-icon`, `--process-agent-service-icon`, `--process-main-icon`, `--process-renderer-icon`, `--process-gpu-icon`, `--process-utility-icon`.
> - **Bot Avatar Hues** — the Bots feature may fill a Bot's round avatar with one of nine registered tints so a list of persistent assistants can be told apart at a glance (registered 2026-08-17). The hue encodes **which Bot this is** — an identity cue like the file-type badges above, never health, status, or channel. Light mode uses soft tints, Dark mode the matching deep tints; the emoji and the initial-letter fallback (always `--text-primary`) stay legible in both. Tokens: `--bot-avatar-red-bg` / `-orange-` / `-amber-` / `-green-` / `-teal-` / `-blue-` / `-violet-` / `-pink-` / `-graphite-bg` (the last is the neutral step, and is where legacy `graphite` avatar data lands). Scope is strictly the Bot avatar fill in `features/bots` — do not reuse these tints for status dots, badges, row backgrounds, or any other surface. External theme import never touches them (the import template is allow-list only), so Bot identity colors do not drift between themes.
> - **Bot Unread Badge** — information blue `#417CDD` with white text (`--bot-unread-bg` / `--bot-unread-fg`) encodes IM unread messages, not execution or connection health. In the 2026-11-04 Desktop list preview, private-Bot unread and completed-unread indicators use green `--card-status-done`, including the Cindy device row; these sidebar rows no longer draw unread counts or @ glyphs. The Cindy computer picker and computer rows in 近况 retain the production blue unread marks, including numeric counts where the picker already has them. Expanded list status dots and count badges align to the vertical center of the subtitle line while retaining the existing timestamp column. Expanded private-Bot running previews (local, remote and merged Cindy) use the group row’s orange progress text and 11px breathing sparkles, with no additional trailing running dot; idle previews retain their original muted text. Group completed-unread without a mention shows only a green trailing dot when expanded, and a green mark on the collapsed avatar and overflow. Group ordinary unread without completion retains a muted expanded count and uses a blue mark on the collapsed avatar and overflow; unread group mentions use a blue count badge (the existing total group unread count, not a separate mention count) when expanded and a blue dot when collapsed or in overflow, without an @ glyph. Running groups retain a muted unread count beside progress text, including unread mentions; no additional dot is shown in expanded running rows. Read acknowledgements clear collapsed unread marks when no work needs attention. Execution states retain the shared production precedence: awaiting, error, running, completed-unread, unread, idle; this also applies to merged Cindy and overflow. Replies without an explicit mention are not yet classified by this preview. See [Desktop list status](./desktop-bot-list-status.md). This does not change the existing blue 6px unread dots for group topics (root entry, composer hint and its rows, and the thread panel’s new-replies divider); adjacent text remains `--text-primary`. Mobile is unchanged: `botUnread` remains blue for companion-list unread dots and the approved 6px group-topic marks, excluding the in-thread divider. Same blue value in both themes; the foreground remains standalone white because the CTA foreground changes in Dark. Do not reuse these tokens for unrelated badges, execution-status dots or row backgrounds.
> - **Mobile thread new-reply divider (owner-requested 2026-10-29)** — one horizontal 0.5pt line followed by the localized “New” label, both using Mobile `threadUnreadDivider` (`#D91F37` Light / `#FF667A` Dark). This replaces the blue dot and border above the label only inside the thread timeline. Existing unread detection, visibility and dismissal remain unchanged; list and topic-summary dots retain `botUnread`.
> - **Teammate todo due dot (registered 2026-10-21, owner request)** — a static 6px `--error-fg` dot (Mobile `statusError`, 7pt) meaning "this todo's own deadline is today or already passed". Exactly two placements, one shared component per platform (`TodoDueDot` in `features/bots/BotGlancePopover.tsx`): before the deadline text of the due row inside the teammate 近况 popover, and at the top-right of the chat-header 近况 entry (Mobile: the header avatar) while the owner has not opened 近况 since that item became due. The row dot stays until the item is handled or rescheduled; the entry dot clears on opening. No text, no breathing; the entry's accessible name carries the same information. It is not an error state and must not be reused for task errors, unread, or other badges.
> - **Task import result marks (registered 2026-10-30)** — the import results list (Desktop Settings 「从其他工具导入」 and the Mobile computer page sheet) colors only the 14px/sm status icon before each result line: can continue `--status-success` (Mobile `statusDone`), needs your action `--warning-fg` (Mobile `warningFg`), not imported `--error-fg` (Mobile `statusError`); queued, running and cancelled stay `--text-tertiary`. The summary counts at the top reuse the same three icons. Titles, result text, rows and buttons stay neutral, and the text always states the outcome, so color is never the only signal. No new tokens.
> - **ConfirmDialog Danger** — the theme's semantic destructive color (`--destructive`, via Button `tone="danger-solid"`) used inside ConfirmDialog only on the confirm button background of the destructive variant (the token's general use is in §10); the value differs between Light and Dark only; it is a theme-invariant exemption that imported themes cannot override. The cancel button and rest of the dialog remain grayscale.
> - **Screenshot overlay and annotation ink (registered 2026-10-26, owner-approved)** — the global screenshot overlay and its pinned images draw on top of arbitrary screen content, so two small fixed sets live in `features/region-screenshot/screenshotColors.ts` and are the same in Light and Dark. **Annotation ink** (`SCREENSHOT_INK`): red `#FF3B30` (the `annotation-accent` value), yellow `#FFCC00`, green `#34C759`, blue `#007AFF`, black `#000000`, white `#FFFFFF`. Ink is burned into the user's screenshot; it is user content, not UI color. The color swatches in the annotation style bar show the ink itself, each inside a `--border-default` ring so black and white stay visible in both modes. **Functional overlay pixels** (`SCREENSHOT_OVERLAY`): the dim layer `rgba(0,0,0,0.45)` outside the selection, the 1px white selection edge with a `rgba(0,0,0,0.6)` outer ring, white resize handles, the dashed selected-annotation box, the magnifier crosshair band and the black backdrop under the frozen frame. These must stay legible over any wallpaper, window or video. Everything else in the screenshot UI (toolbar, style bar, AI menu, magnifier card and its text, size label, hint pill, pin zoom badge and pin border) uses theme tokens and the standard icon-button and CTA treatments. Do not reuse these values outside the screenshot overlay and pinned images.
> - **Permission Selector Mode Highlights** — selected risky permission modes may color only the option text/icon/checkmark and the collapsed trigger text/icon. The selected row background remains grayscale. Auto Approval uses `#417CDD` in both modes (finalized 2026-07-17, same value light/dark; replaces light #000050 / dark #00D9C5). Full Access uses Heart Orange `#EA6B17` in both modes (auto-follows warning-accent, finalized 2026-07-17). These hex values are the **default-theme palette only** — other themes may override `--perm-auto-selected-text` and `--perm-bypass-selected-text` with their own accent colors, provided both modes remain color-coded, distinguishable from each other, and visually distinct from neutral text. Tokens: `--perm-auto-selected-text` and `--perm-bypass-selected-text` in `apps/desktop/src/renderer/styles/globals.css`.
> - **Shared-task Owner Crown** — the small crown immediately after the Agent/status icon uses the existing gold foreground `#F3A115` in both modes (`--warning-fg` on Desktop, `warningFg` on Mobile). This is a narrowly registered identity mark: it appears only for tasks owned by the current account, stays gold on selected rows, and never colors the title, row background, guest tasks, or an empty placeholder.
> - **Diff Add Green / Diff Del Red** — GitHub-standard diff syntax colors, used on the `+` / `-` symbol glyph, the changed-line text foreground, **and the full row background** inside code-diff renderings. Applied in three places: (1) the Edit-tool DiffView card (F-MSG-6), (2) markdown ````diff`fenced code blocks in the message stream, and (3)`.diff`/`.patch`files opened in TextLightbox (the document previewer) — there hljs`.hljs-addition`/`.hljs-deletion`are forced`display: block`so the background fills to the right edge instead of stopping at the last glyph. Line-number gutter and ctx (unchanged) lines remain strictly grayscale per the layer system. **Foreground** — Add:`#22863a`Light /`#7ee787`Dark; Del:`#b31d28`Light /`#ff7b72`Dark. **Background** — Add:`#f0fff4`Light /`#033a16`Dark; Del:`#ffeef0`Light /`#67060c`Dark. Tokens:`--diff-add-fg/-bg`and`--diff-del-fg/-bg`in`apps/desktop/src/renderer/styles/globals.css`. Updated 2026-04-21: backgrounds switched from grayscale → GitHub red/green for full-row fill so additions / deletions are unambiguous at a glance.
> - **PR Status Colors (session-git-pr-context / sidebar task-info)** — closed = `--error-fg`, merged = `--focus-ring`, draft = `--text-tertiary` (single source: `PR_STATUS_COLOR` in `apps/desktop/src/renderer/features/cc-agent/gitContextPrVisuals.ts`). **Open green is split:** the session-header GitContextBadge and sidebar hover tooltip keep `--diff-add-fg` (theme-following GitHub greens). The sidebar task-info icon (registered 2026-08-17) follows the **surface**, not the theme name: it reads HSL lightness of `--sidebar` / `--sidebar-item-active` (selected surfaces vary by theme). Light surfaces use `--pr-open-on-light` `#2EA043`; dark surfaces use `--pr-open-on-dark` `#3FB950`. Both values are theme-invariant. The `#number` stays on the info-slot foreground. Open/draft PRs with `unresolvedCount > 0` add a 5px static `--status-bar-accent` corner dot on the status icon (not an AttentionDot tone). Unknown/unloaded status degrades to `--text-tertiary`. Scope is strictly PR-state surfaces; do not generalize these colors to other status systems. Mobile mirrors the semantics with its own tokens (`prStatusVisual`): open `statusDone`, merged `prMerged` (focus blue `#417CDD`), closed `statusError`, draft / unknown `textTertiary`.

_Dark Mode text uses softened neutrals to reduce eye strain: **Soft Gray** (`#d4d4d4`) for primary text, **Silver** (`#a3a3a3`) for secondary, **Stone** (`#737373`) for tertiary (per `--text-secondary` / `--text-tertiary` in `colors.ts` — the two swap between modes). Pure White (`#ffffff`) is reserved for button labels and high-contrast UI elements on dark backgrounds._

### Gradient System

- **None in the core UI.** Cindy uses no gradients; visual separation comes from flat color blocks and single-pixel borders. This is a deliberate, almost philosophical design choice. (The login canvas is also flat by ruling — see §16.5.)
- **Functional edge fades (owner decision, 2026-11-07).** A fade may show that content continues past an edge: the composer fade, the horizontal scroll ends of `RolePillDropdown` and the right-sidebar `TabBar`, and scroll-list and collapsed-body masks. It runs from the surface colour to transparent, or is a mask, and carries no colour of its own. Same-colour overlay layers (`linear-gradient(c, c)`) and the transparency checkerboard are not visual gradients. The WorkLouder device illustration keeps its knob highlight. An audio card without a cover keeps its gradient placeholder (owner decision, 2026-11-07). Everything else stays flat. `designEffectsDiscipline.test.ts` keeps this list closed.
- **Session-loading wordmark sheen — narrow functional exception (Desktop approved 2026-08-10).** `BrandLoadingMark` may use one neutral `transparent → --text-primary → transparent` gradient solely as a mask-clipped highlight inside the official Light/Dark wordmark while a session's message tree is deferred. It is a loading-progress signal, not a background, separator, fill, or reusable surface treatment. It may appear only after the 200ms delayed-reveal threshold, disappears as soon as the message tree mounts, and may not leak to messages, cards, dialogs, sidebars, or static branding. Full motion and brand-surface constraints are registered in §14.4 and §15.7.

### Filter reminder inside display settings (2026-10-28)

When the sidebar display-settings trigger shows the archived-view reminder, repeat
the same static accent dot on the Task status submenu and its selected Archived
option. Desktop and Mobile retain neutral labels and selection checkmarks. Active
and All remove the whole reminder path. Native iOS menus retain their system UIMenu
and toolbar presenters and use the image slot for the dot. MenuView receives an
absolute path to a temporary 1x copy of the bundled PNG: a 20pt canvas containing
the same 6pt dot. Ordinary row icons and selection checkmarks remain available.
Custom menus remain fallback paths and use the shared inline dot. This extends
the existing filter reminder registration without changing which settings light
the entry indicator.

## 3. Typography Rules

### Font Family

- **Display / Body / UI**: `Inter`, with fallbacks: `system-ui, -apple-system, "Segoe UI", sans-serif`
- **Monospace**: `JetBrains Mono`, with fallbacks: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`

> Desktop default clarification: JetBrains Mono below is an optional preset and a historical typography sample. The shipped default uses the system monospace stack from `reference/foundations.json` → `app-font-code-default`, with the existing CJK fallbacks. DS-8 preserves that stack and user font selection; see [the recorded decision](./design-decision-log.md#2026-09-11-ds-8-默认代码字体依据迁移).

_Note: The entire interface uses a single sans font — Inter — for both display headlines and body text. Inter is chosen for (a) its neutral, geometric character that stays out of the way, (b) its excellent legibility at small sizes, and (c) its wide availability in both web and design tooling. A single font keeps the hierarchy clean — separation comes from size and weight, not typeface contrast._

### Hierarchy

| Role            | Font           | Size           | Weight    | Line Height  | Letter Spacing                         | Notes                                                                                                                                                                                                                                                        |
| --------------- | -------------- | -------------- | --------- | ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Display / Hero  | Inter          | 48px (3rem)    | 500       | 1.00 (tight) | normal                                 | Maximum impact headline                                                                                                                                                                                                                                      |
| Section Heading | Inter          | 36px (2.25rem) | 500       | 1.11 (tight) | normal                                 | Feature section titles                                                                                                                                                                                                                                       |
| Sub-heading     | Inter          | 30px (1.88rem) | 400 / 500 | 1.20 (tight) | normal                                 | Card headings, feature names                                                                                                                                                                                                                                 |
| Card Title      | Inter          | 24px (1.5rem)  | 400       | 1.33         | normal                                 | Medium emphasis headings                                                                                                                                                                                                                                     |
| Body Large      | Inter          | 18px (1.13rem) | 400 / 500 | 1.56         | normal                                 | Hero descriptions, button text                                                                                                                                                                                                                               |
| Body / Link     | Inter          | 16px (1rem)    | 400 / 500 | 1.50         | normal                                 | Standard body text, navigation                                                                                                                                                                                                                               |
| Caption         | Inter          | 14px (0.88rem) | 400       | 1.43         | normal                                 | Metadata, descriptions                                                                                                                                                                                                                                       |
| Small           | Inter          | 12px (0.75rem) | 400       | 1.33         | normal                                 | Smallest reading-text size (auxiliary Micro Label may go smaller, floor 10px)                                                                                                                                                                                |
| Micro Label     | Inter          | 10–13px        | 400 / 500 | 1.20–1.40    | optional 0.5–1px tracking on uppercase | **Auxiliary / non-reading** labels only — sidebar tree section heads (13px), tree row counts, frontmatter field names, scope chips, tag pills, status badges, breadcrumb segments. Never used for body text or anything the user reads sentence-by-sentence. |
| Code Body       | JetBrains Mono | 16px (1rem)    | 400       | 1.50         | normal                                 | Inline code, commands                                                                                                                                                                                                                                        |
| Code Caption    | JetBrains Mono | 14px (0.88rem) | 400       | 1.43         | normal                                 | Code snippets, secondary                                                                                                                                                                                                                                     |
| Code Small      | JetBrains Mono | 11–12px        | 400 / 500 | 1.40–1.63    | normal                                 | Tags, labels, in-tree paths                                                                                                                                                                                                                                  |

_Positioning note: the Display / Section Heading / Sub-heading rows are conceptual role targets for **brand canvases only** (the §16 login / splash family and its self-contained pages). Their concrete values live in canvas constants and §16 tables, not in app code. The 「排版豁免登记表」 below only registers exemption domains. Everything else — everyday chrome **and** in-app empty states — lives in the Body / Caption / Small / Micro rows, and for `apps/desktop` code the normative size set is the 「桌面 UI 字号白名单」 below: this table describes roles, the whitelist constrains values._

### Principles

- **Single sans family**: Inter carries both display headlines and body text — no typeface switching between hierarchy levels. Size and weight alone create hierarchy, keeping the typographic system maximally simple.
- **Weight restraint**: Everyday chrome defaults to 400 (regular) and 500 (medium); 600 is a rationed emphasis tier, and 700 lives exclusively inside registered exemption domains. No light, no black weight, no in-between values. The full ladder and its rules are in 「字重阶梯」 below (2026-08 revision, issue #1505 — this supersedes the former "400/500 only" wording).
- **Tight display, comfortable body**: Headlines compress to 1.0 line-height, while body text relaxes to 1.43–1.56. The contrast creates clear hierarchy without needing weight contrast.
- **Monospace for code only**: the code font (system monospace stack by default; JetBrains Mono is an optional preset, see Font Family above) is reserved for inline code, terminal commands, and code blocks — never used for UI chrome.

### 字重阶梯(2026-08 修订,issue #1505)

全站字重只允许以下四档整百值,禁止一切中间值(550/650…)与 800 及以上:

| 档  | 名称     | 用途                                                                        |
| --- | -------- | --------------------------------------------------------------------------- |
| 400 | Regular  | 长文阅读正文、代码                                                          |
| 500 | Medium   | UI 默认强调、标题 —— 日常 chrome 的主力档                                   |
| 600 | Semibold | 限量强调(徽标、表头、选中态等局部加重)。新增使用要能说出「为什么 500 不够」 |
| 700 | Bold     | **仅限下方豁免登记表中的域**,禁止出现在普通 UI chrome                       |

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

### 排版豁免登记表(2026-08,issue #1505)

以下是**登记过的刻意分歧**,不要当 bug「修」;新增豁免必须先改本表:

| 域                                    | 范围                                                                                                                                                                                                                                                                                                                                                                 | 允许                  | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 录屏倒计时 | `features/region-screenshot/LiveCapturePanel.tsx` 的倒计时数字 | 64px / 600 | 2026-10-27 用户要求显著放大录制倒计时；仅选区中央 160px 圆形提示使用此字号，控制条与其它文案仍遵守字号 token 阶梯。 |
| 登录 / Splash 品牌画布                | 桌面 `LoginControls.tsx`、`loginDesignTokens.ts`(Splash 借用同族面板)、`LegacyMigrationDialog.tsx`(仅字重)、`oauthResultPage.ts`(自包含品牌页生成器,raw CSS 为其常量载体)；手机 `apps/mobile/app/(auth)/login.tsx`(登录页本体)、`apps/mobile/src/components/LoginSkinControls.tsx` 与 `apps/mobile/src/auth/loginSkinLayout.ts`                                      | 700 + 设计 px 字号    | §16 已登记 Bold,两端共用同源登录画布与 figma 坐标系；桌面守卫只扫描 `apps/desktop/src/renderer`，手机端由自身守卫体系负责，本登记不扩展 PR #1553 的扫描范围                                                                                                                                                                                                                                                                         |
| markdown 内容                         | **仅 Markdown 渲染路径**：桌面 Markdown 渲染器输出的 DOM `<strong>`（`MarkdownRenderer` 及其消费方；必须解析为绝对 700；嵌套 strong 仍封顶 700）、CodeMirror strong 语法节点（`codemirrorGithubTheme.ts` 的 `t.strong` → `fontWeight: 'bold'`）、移动端原生 Markdown strong（`apps/mobile/src/session/MessageRenderer.tsx` 的 `markdownStrong` → `fontWeight.bold`） | 700 / `bold`          | 用户内容语义,非 UI chrome;编辑器内 strong 与两端渲染后的 strong 同权。DS-11 已在 `MarkdownRenderer` 的内容 strong 显式使用绝对 700，嵌套层同样封顶；不依赖 preflight 的相对 `bolder`。**本行不覆盖普通 UI chrome 里直接写的 `<strong>`**（如 `MakerExperimentalView.tsx` 会话状态与事件列表）——它们同样被 preflight 的相对 `bolder` 渲染成 700,但不属豁免域,是已登记缺口,待归一为 `font-medium` / `font-semibold`。 |
| hljs 主题移植                         | `globals.css` 内 hljs 规则                                                                                                                                                                                                                                                                                                                                           | `bold`                | 第三方主题移植,保真优先                                                                                                                                                                                                                                                                                                                                                                                                             |
| 第三方查看器（用户内容）              | `apps/desktop/src/renderer/vendor/drawio/viewer-static.min.js`（由 `DrawioPreview.tsx` 加载）及 `vendor/` 下其他上游产物                                                                                                                                                                                                                                             | 上游自带字重与字号    | 上游压缩产物,渲染的是用户绘图内容而非本产品 chrome;不改上游、不逐行归一。**守卫边界**:整个 `vendor/` 目录不纳入扫描（PR #1553 已在守卫盲区中显式登记该排除,不是未登记的漏扫）。                                                                                                                                                                                                                                                     |
| CodeMirror / Markdown 内容字号        | `codemirrorGithubTheme.ts` 的标题等内容层级（`2.15em` / `1.62em` 等相对值,CSS-in-JS 路径）                                                                                                                                                                                                                                                                           | 相对字号（`em` 派生） | 内容标题层级必须随编辑器基础字号等比缩放,固定 token 会打断这个比例关系;相对值本身不脱离缩放链,故不要求落在 numeric 白名单。**守卫边界**:`em` / `rem` / `%` 相对值不参与 numeric 白名单判定。                                                                                                                                                                                                                                        |
| 命令式第三方 API（非 DOM class 路径） | xterm 的 `ITerminalOptions.fontSize`（`features/right-sidebar/plugins/terminal/lib/xtermPool.ts`）等只接受**数值字段**、无法挂 class 的第三方配置入口；SVG 的 `fontSize="N"` 属性同理                                                                                                                                                                                | 数值字面量            | 这类 API 不消费 DOM class,Tailwind token 类挂不上去,只能传数字。**取值规则**:数值必须取自本白名单档位,或取自用户代码字号设置（`--app-code-font-size` / `appearanceSettings.codeSize`）解析出的运行期值 —— 不允许凭手感另取一个数。**守卫边界**:按精确签名放行（文件 + 字段 + 期望次数）,不做整文件豁免,新增此类入口须先改本表。                                                                                                     |
| 用户可配置代码字号（变量路径）        | `--app-code-font-size` 及其派生写法（`text-[length:var(--app-code-font-size)]`、`text-[length:calc(var(--app-code-font-size)_-_1px)]` 等,消费方含 Markdown / DiffView / ToolCallCard 等约 19 个文件）                                                                                                                                                                | 变量与其 `calc` 派生  | 该字号是**用户设置项**,`appearanceSettings.ts` 的 `codeSize` 允许 10–24 逐整数取值,因此运行期可落在 17 / 19 / 21 / 22 / 23 等 numeric 白名单外的值;这是刻意的可配置能力,不是漏归一。本白名单约束的是**开发者写死的档位**,不约束用户设置的运行期取值。**守卫边界**:`--app-code-font-size` 的变量与 `calc` 派生写法按精确签名登记豁免（见 PR #1553 守卫的豁免表）,不按 numeric 白名单判定。                                           |
| 外部页注入                            | `browserCommentPreload.ts`                                                                                                                                                                                                                                                                                                                                           | 系统字体族            | 注入他人网页,不强加 Inter                                                                                                                                                                                                                                                                                                                                                                                                           |
| 手机 WebView HTML 生成器              | `selectableMarkdownHtml.ts` 等                                                                                                                                                                                                                                                                                                                                       | CSS 语法字面量        | 手机守卫已自登记盲区,值仍须守本阶梯                                                                                                                                                                                                                                                                                                                                                                                                 |
| 紧凑模式派生值                        | `globals.css` `.chat-rail-compact` 段                                                                                                                                                                                                                                                                                                                                | calc / -1px 派生      | 机制本体                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 排版 non-goals(2026-08 登记)

以下漂移**已知且本轮明确不治理**,后人见到不要当「漏网」顺手修,治理需另立 issue:

- line-height **档位统一**:桌面存在 `leading-[1.45]` / `leading-[1.55]` 等微调档与无单位 / px 混轨,本轮不收敛成统一阶梯。
  - **但有一条例外,已在 #1553 治理完毕**:`text-<n>` 与**固定 px 行高**(`leading-[Mpx]`)并存属于**功能缺陷**,不是风格漂移 —— `text-<n>` 经 `--text-<n>` 响应「外观 → UI 字号」设置,固定 px 行框不跟随,用户放大字号时文字会裁切/重叠。原设计未考虑用户可自行调整字号,故留下这个洞。**该组合一律改为无单位比例**(比例 = 原 px ÷ 字号),渲染在默认字号下不变而放大时正确。#1553 已把当时全部 38 处清零(其中 14 处为字号归一新引入、24 处先于其存在);后续新增 `text-<n>` 时**不得再配固定 px 行高**,该约束由 `typographyDiscipline.test.ts` 的 `fixed-leading` 规则做机器门禁,**按 `className` / `cn(...)` 整块区域跨行判定**(只比对同一行会漏掉 `cn()` 分行写法,#1553 实际漏过一处)。行高被 JS 布局计算写死引用时(如按行高算 auto-grow 上限),须同时改成读计算值,否则上限不跟随缩放。
- 语义类 `text-xs/sm/base/lg` → `text-<n>` 的机械统一:等值改写零收益,收编即可。
- letter-spacing 与 font-family 治理。
- 原生层排版:macOS agent-island helper 等 Swift / 原生 UI 的字号字重不在本白名单域(Web 白名单与守卫均不覆盖,治理需另立 issue)。

## 4. Component Stylings

**Desktop scrolling screenshot flow (owner correction, 2026-10-26).** Scrolling capture stays in the original screenshot overlay: the selected area passes input to the source app, while the available space beside it contains a width-scaled, scrollable preview and edit/save/cancel/finish icons. During capture, the area outside the selection keeps the same dimming mask as region selection; the selected area remains clear and preview/actions appear above the mask (owner correction, 2026-10-28). Do not add a separate capture toolbar or result page. Finish copies and closes; Edit returns the stitched image to the existing annotation toolbar. Preview scaling must not reduce export resolution. All control chrome follows the same Light/Dark tokens as the ordinary toolbar. The draggable screen-top mode bar contains Screenshot, Scrolling screenshot, Region recording, GIF and Cindy, and appears only on the currently operated display. Switching modes does not start capture; after selection an explicit start action begins scrolling/recording. The bottom toolbar contains only annotation and export tools. Manual scrolling supports both directions without duplicating previously captured content; automatic scrolling can be stopped. Automatic scrolling must not move, lock, or repeatedly restore the system pointer; users can move freely and click Stop. Acceptance must include real pointer movement and button clicks, not only DOM automation (owner correction, 2026-10-28). The bottom automatic-scroll control has a single standard button face; its positioning wrapper has no background or border (owner correction, 2026-10-28). Static or briefly unmatched frames do not immediately show a failure notice; persistent failure preserves the captured content and stops automatic scrolling.

**Screenshot chrome safe area (owner request, 2026-10-27).** The selection may cover the whole display, but every piece of screenshot chrome (mode bar, hint, size label, magnifier, annotation toolbar and style bar, scrolling preview and its actions, recording controls) stays inside the display's chrome area: the system work area (no menu bar, Dock or taskbar), with the macOS camera housing (notch) also excluded when the menu bar is hidden. Live controls fall back to the rest of the display only when the selection leaves no room inside it. On macOS, a two-finger trackpad swipe never zooms a pinned image (pinch zooms it continuously around the pointer); pinch in the editor zooms around the pointer; one swipe, including its momentum, changes the snap level by one step.

**Recording toolbar movement (owner request, 2026-10-27).** The grip, format, timer and their shared empty space form one drag target. Recording actions remain separate click targets. Releasing or cancelling a drag leaves the toolbar at its final accepted position, outside the capture region and within the same display's chrome area; delayed host replies must not move it back. Starting recording keeps the existing macOS panel's geometry and stacking unchanged.

> Buttons / Cards / Inputs below use the structured key-value format (adopted from the §12 pilot, 2026-07): `field → token → Default Light / Default Dark resolved values`. Token names per §10.

### Buttons

```
button/primary  (Gray Pill)
  fill      --surface-chip        #e5e5e5 / #3c3c3a
  text      --text-primary        #262626 / #d4d4d4
  border    1px solid --surface-chip   (same as fill)
  radius    9999px (pill)
  padding   horizontal 24px; vertical content centered within the fixed height
  height    28px (sm) / 32px (md) / 36px (lg); compact exceptions 24px (xs) / 22px (xxs), see the inventory migration below — no 40px size (DS-4 G1, 2026-09-03)
  type      text-13 / font-medium 500 (DS-4 G4, 2026-09-03)
  hover     --button-primary-hover     rest fill mixed 8% toward --text-primary   (swap-color, never opacity; DS-4 G2)
  pressed   --button-primary-pressed   hover mixed a further 10% toward --text-primary   (DS-4 G3)
  disabled  opacity 60%; ordinary pointer (#3246)
  note      understated, grayscale, always a pill
  impl      components/ui/button.tsx variant="primary"

button/secondary  (White Pill)
  fill      --surface-elevated    #ffffff / #2c2c2a
  text      --text-primary        #262626 / #d4d4d4
  border    --border-default      #d7d7d4 / #3c3c3a
  radius    9999px (pill)
  padding   horizontal 24px; vertical content centered within the fixed height
  height    28px (sm) / 32px (md) / 36px (lg); compact xs 24px / xxs 22px — no 40px size (DS-4 G1)
  type      text-13 / font-medium 500 (DS-4 G4)
  hover     --button-secondary-hover    rest fill mixed 8% toward --text-primary
  pressed   --button-secondary-pressed  hover mixed a further 10% toward --text-primary
  disabled  opacity 60%; ordinary pointer
  note      visually lighter than primary; binds Tier-1, not --settings-btn-secondary-* (DS-4 G5)
  impl      components/ui/button.tsx variant="secondary"

button/cta  (Black Pill — maximum emphasis)
  fill      --accent-cta-bg-pure  #000000 / #ffffff
  text      --accent-pure-cta-fg  #ffffff / #000000
  radius    9999px (pill)
  padding   horizontal 24px; vertical content centered within the fixed height
  height    28px (sm) / 32px (md) / 36px (lg); compact xs 24px / xxs 22px — no 40px size (DS-4 G1)
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

**Compact settings actions (owner feedback, 2026-09-21).** Button adds an explicit 28px sm size alongside 32px md and 36px lg. Logs and compact automation actions use this shared size with their existing horizontal spacing. Contacts section actions retain their approved 24px target; appearance actions retain 36px or 32px targets. A 13px identity-removal icon keeps its visible size inside a 24px target. Destructive contacts actions retain semantic red hover/pressed feedback. The authorization-waiting Cancel action remains named and enabled; it is not a disabled loading button. The contacts discard/add-identity treatments are retained per this batch’s explicit keep-before decisions.

**Button inventory migration (owner-authorized 2026-09-22).** Functional text actions in Design Lab's pending-migration Button inventory call the shared Button, directly or through thin wrappers. Standard heights remain 28/32/36px; `xs` (24px) and `xxs` (22px) are compact exceptions. `compact` supplies shared 12px horizontal padding for dense rows and narrow toolbars. `tone` owns quiet and destructive treatments; `palette="confirmation"` preserves existing confirmation theme overrides without copying paint rules into dialogs. The portrait-confirmation row keeps its image-led height; long confirmation labels may wrap and grow. Loading retains an accessible action name and shows only the spinner. A busy action whose purpose is to open progress may explicitly use `allowWhileLoading`; ordinary loading actions remain disabled. Underlined links, pure icon actions and the AI composer/send topic remain separate. Runtime and visual verification are recorded in the migration evidence; this does not claim every native button in the client is a Button.

**Button state audit follow-up (2026-09-22).** Inventory status alone does not prove that an action calls the shared implementation: follow local wrappers to their rendered control. Storage CardButton and the repaired pill wrappers now delegate to Button. Functional action-menu triggers (add plugin, manage subscription, manage skill, manage models) inherit normal press feedback; opening a menu is not itself a reason to disable feedback. Form Select triggers and the excluded input controls retain their separate contract. Audit both computed hover/pressed colors and the 1px face inset; a matching resting screenshot or a color-only assertion cannot prove the press motion. See [state audit evidence](../design-evidence/2026-09-22/button-state-audit.md).

**Source-wide Button audit (2026-09-22).** Scan native actions and local wrappers even when absent from the Lab migration list. Text branches of responsive action wrappers use Button; icon-only branches remain in the icon-action topic. The danger-surface tone retains an opaque theme surface for inline archive confirmations that cover existing text. The permission palette retains the existing permit-action colors and derives hover/pressed from that pair; confirmation handlers and keyboard guards do not change. See [the source-wide audit](../design-evidence/2026-09-22/button-full-source-audit.md).

**Why hover / pressed are derived, not aliased** (DS-4; ratios ruled by the designer 2026-09-04): in Dark, `--surface-hover` and `--surface-chip` resolve to the same value in default-dark / cindy-dark / one-dark-pro / monokai-pro, so aliasing primary's hover to `--surface-hover` made the hover state invisible; `--surface-hover-soft` sat within 2/255 of `--surface-elevated` in cindy-dark, breaking secondary the same way. Each state is therefore mixed off **its own variant's rest fill toward its own foreground** — 8% for hover, a further 10% for pressed. The ladder follows any theme override automatically and introduces no theme-blind literals. Guard: `themes/__tests__/buttonStateContrast.test.ts` asserts every builtin theme keeps each step at ΔRGB ≥ 8. These are runtime-derived values, registered but not modeled in the DTCG shadow layer (governance §3.4).

**Desktop Button feedback (HTML v3 approved 2026-09-19).** Shared action Buttons use 28/32/36px heights (28px added by owner feedback on 2026-09-21), pill radius, 13px/500 text and existing semantic colors. Icon/text gap defaults to 6px. On press, only the non-interactive fill/border layer retracts by 1px per edge over `--motion-instant` (80ms), using `--motion-ease-out`; the text, icon, layout and hit region stay fixed. State colors transition over `--motion-fast` (150ms). Loading shows only the centered spinner, retaining the accessible name and label width; disabled/loading controls do not receive press feedback. Reduced motion removes inset movement, transitions and spinner rotation.

The same paint layer is shared with ChromeIconButton (28px) and SidebarIconButton (36px; retired 34px grid style removed). Button's `--button-face-bg` / `--button-face-border` are component-local aliases of existing theme tokens, not additional theme IDs. Domain overrides set these aliases, including hover/active states, instead of painting the stationary hitbox. Select triggers and excluded composer/permission controls opt out via `pressFeedback={false}`. AI input/send/stop, login, legacy ConfirmDialog and other independent native buttons are outside this migration; HTML approval is not a claim that every button-tag consumer has migrated or passed client acceptance.

### Cards & Containers

```
card/container
  fill      --surface-elevated    #ffffff / #2c2c2a   (page-level flat layouts use --surface instead — §2 layer rule)
  border    1px solid --border-default   #d7d7d4 / #3c3c3a   (only when separation is needed)
  radius    12px (container tier; Tailwind rounded-xl literal)
            ⚠ do NOT use §10's --radius — that is shadcn's 0.5rem (8px) primitive, unrelated to this 12px container radius
  shadow    none
  hover     --surface-hover       #e5e5e5 / #3c3c3a
```

### Desktop settings rows

Desktop Settings sections put the 16px/500 section title outside the card. A card groups related settings as rows: label (13px/500, line height 1.5) and hint (12px, line height 1.4, 4px below the label) on the left, the control on the right, `px-4 py-4` per row, and an inset divider between visible rows only. Related switches share one card instead of one card each; a row that opens a sub-page uses the same row with a trailing chevron. Use `SettingsSection`, `SettingsCard` and `SettingsRow` from [settings-rows.tsx](../../apps/desktop/src/renderer/components/ui/settings-rows.tsx); do not define local copies. The row name is 13px/500 everywhere (owner decision, 2026-11-07). **Narrow drawer exception (owner decision, 2026-11-07):** inside a narrow drawer, currently only the group settings drawer, wrap them in `SettingsDrawerScope`. The section title is an `h3`, 13px/500 in `--text-secondary` instead of 16px, 8px above the card, rows are at least 48px tall (`py-3`, 52px with an avatar) instead of `py-4`, the label sits at line height 1.38 with 2px above the hint, and cards use `--surface-elevated`. The row name stays 13px/500. Settings pages never use this scope. `SettingsRow flush` is for rows in a dialog that has its own padding. On settings pages the section title is an `h2` (`h3` for a sub-section on a page that has its own `h2` title), with 14px between the title, the cards and any note under them; a one-line description of the section (12px, line height 1.45) sits 4px under the title (`description`). **Page titles (owner decision, 2026-11-08):** every Settings tab page and sub-page (Model providers, IM bots, Tools, Computer use, Pi extensions, Cindy Make, Accessories and the gamepad pages included) opens with a 20px/500 page title, line height 1.3, one step above the 16px section titles; its description is 13px, line height 1.5, 4px below; a back button (sub-pages) sits before the title and page actions on the right. Inside a page the first card or section starts 24px below the title, sections are 36px apart, and the cards and notes of one section are 14px apart; consecutive untitled cards form one section (owner decision, 2026-11-08, matching General and Appearance). Use `SettingsSection variant="page"`, or `SettingsPageHeader` plus `SettingsPageScope` where the page lays out its own content; sections under a page title are `h3`. Groups inside a page use the 16px section title. General has no page title; Plugins keeps its own plugin-management header. Not yet migrated (known exceptions): the Shared tasks header (description 8px below), the provider Remote & sharing sub-page header (text back link above the title, 12px description), the Storage worktree-recycle card, the IM default-settings and WeChat panel headings, General → default permission for new tasks, and the shortcut list card (20px padding). Rows that belong to one item, such as an app connection and its toggle, get their own card instead of a divider between them. When a setting's name and hint sit above a wide control (slider, full-width picker, textarea, list), use `SettingsField`: the control follows the hint 12px below, with no divider in between — dividers separate two settings, never a setting from its own control. Other content that is not a label-and-control row goes in `SettingsBlock`, which keeps the row padding and divider. Settings → General follows this layout throughout (owner request, 2026-10-17).

### Desktop settings controls

Owner decisions, 2026-11-08. They apply to every Settings page, drawer and settings dialog.

- **Switch or Checkbox.** A setting that takes effect immediately uses `Switch`. An option inside a form, draft or batch selection that only takes effect on Save or Confirm uses `Checkbox` (`components/ui/checkbox.tsx`: native input, 16px, `--text-primary` accent, focus ring, disabled state, `indeterminate` for partial selection). Do not put a Switch inside a Save-gated form, and do not use a Checkbox for an instant setting.
- **Select size.** Single-value fields use the shared `Select`; menus are for actions only, and a DropdownMenu radio group is not a field. Trigger height is 36px by default (`size` default) or 32px (`size="compact"`) in narrow drawers and dense lists; widths are 220px (`width="sm"`), 320px (`width="md"`) or full width for stacked fields (`width="full"`). No other trigger heights or ad-hoc widths.
- **Restore default.** A single setting shows the "customized" badge and a 28px pill icon button with a `Tip` (`DefaultOverrideControls`), always to the left of its control and only while the value differs from the default. A page or group reset is a `Button` `variant="secondary"` `size="sm"` with an icon and text, on the right of the page or section title.
- **Destructive actions.** Irreversible actions (clear memories or caches, delete, remove an account, dissolve a group) use the danger treatment: `Button` `tone="danger"`, with `danger-solid` reserved for the ConfirmDialog confirm button. Reversible actions such as Disconnect stay secondary. Destructive rows in a menu always use `variant="danger"`.
- **Same setting, same control.** When one setting appears in two places (for example the provider account strategy), both use the same control with the same option order. Known exception (owner decision, 2026-11-09): the group reply and speaking modes stay a segmented control in local groups and a Select in server-backed groups for now.

### Device access pills

Settings → Remote Connection → My devices shows what each other device may do as two rows split by direction, not as a stack of switches (owner decision, 2026-11-03, unified authorization direction B): “I can” holds the outbound pill (Control it), “It can” holds what that device may do with this computer (Control this device; later Sync keys and Use models on this computer join the same row). The row label is 12px `--text-secondary` in a `max-content` column; pills are 28px-tall full-radius buttons with 12px text. Pressed = `--surface-chip` fill, no border, 12px check icon, `--text-primary`; not pressed = 1px `--border-default` outline, `--text-tertiary`, hover `--surface-hover`; disabled = 40% opacity. A pill is a `button` with `aria-pressed` and keeps the per-device accessible name of the switch it replaced; a click applies immediately with no confirmation. A reason line (11px `--text-tertiary`) sits under the pills of its row. Devices that cannot be controlled (phones/tablets) or that refused this computer show only the “It can” row. The master “Allow devices on this account to control this computer” switch on the This device card stays a switch. Implementation: [MyDevicesPanel.tsx](../../apps/desktop/src/renderer/components/settings/MyDevicesPanel.tsx).

### Provider detail header

All provider connections share one header pattern, independent of builtin/custom storage or login source.
Model counts belong in the provider list, not the detail header. The fixed slots are: brand mark; connection display name and access type; account/source
subtitle; connection status, at most one primary action and one overflow menu. Editing and deletion
belong in that shared menu, not additional provider-specific icon buttons. Identity text is not an
implicit expand/collapse target. At narrow widths, wrap the action group without clipping controls.
Use existing Button, menu and themed settings styles; radii and hit targets follow §5, icon-only
controls follow §14.6, and both Light/Dark follow §10. Account usage sits below the header identity
row with the existing layer separation, not a nested card. Provider-specific authentication and
recovery content may fill the explanation slot without replacing the header layout.
Identity, state, action semantics and pending implementation are defined in
[供应商设置](../product-rules/provider-settings.md). This contract does not declare existing headers migrated.

### Provider dialog disclosures

In Desktop `ProviderConnectionDialog`, Manual add model and Advanced connection settings are
registered frameless text disclosures (user-approved lightweight indentation layout, 2026-11-03).
Stack the sections vertically with aligned left chevrons, existing 13px/500 settings section title
color and a minimum 32px hit height. Resting, hover and pressed states retain no fill or border
and do not change label color or geometry. Keyboard focus independently uses a 2px semantic
`--focus-ring` box-shadow ring with a pill shape; this does not introduce a resting button frame. The left
chevron rotates with the expanded state. Indent the expanded manual form by 20px, retaining
vertical fields and existing shared inputs, select and Add button. Light and Dark use existing
semantic theme tokens. This registration covers only these two disclosures; other provider
actions retain their shared Button treatment. Model and connection logic remain unchanged.

### Teammate model settings

The existing model page groups the primary model and task model by purpose. Both use the shared
model picker, retaining provider account, Harness, thinking level and Fast. The primary backup chain
stays folded; the task model is a single route. Task settings start in “Inherit Primary Model” and
provide a compact restore action after an explicit selection. Desktop separates the two groups with
the semantic border token; mobile uses the existing grouped spacing and inheritance switch.
Reuse themed controls for Light/Dark; this contract does not claim runtime visual verification.

### Teammate capability page (owner-approved r2, 2026-11-01)

The teammate's Capabilities page follows the Memory page's grouped list: a quiet 12px/500 group
heading with a tabular count or summary (`1 of 3 on`, `Following this computer · 11`), then one
12px-radius card per group with 13px/500 names, one-line 12px descriptions (full text on hover)
and inset dividers. Groups in order: Core skill (always on, opens a read-only page with a
plain-language summary and the original text folded), System skills (switch per item; the page
explains what turning it off stops), Learned skills (switch; the page shows the content with Edit
and Delete), Skills on this computer, Built-in tools, MCP, Permissions (Input Handoff). A group
shows at most four rows, enabled first and unavailable last; the rest unfold under "Show N more"
with the shared grid `0fr ↔ 1fr` motion. Configuration lives in one heading link per group
(Manage / Tool settings) instead of a button on every row; an unavailable tool says so in its
note line with a "Turn on" link. Rows that open a page carry a trailing chevron and keep the switch
as a separate control. Light and Dark use the existing tokens; prototype and screenshots live in
the design archive for Cindy-伙伴能力页重设计-2026-11-01. Product rules: cindy-bots-runtime.md §6
「伙伴技能分层」.

### Inputs & Forms

```
input/text
  fill        --surface-elevated  #ffffff / #2c2c2a
  text        --text-primary      #262626 / #d4d4d4
  border      --border-default    #d7d7d4 / #3c3c3a
  radius      9999px (pill — single-line inputs)
  height      32px (sm) / 36px (md) / 40px (lg)  (DS-4 G1; three sizes, shared 4px step with buttons)
  focus       --focus-ring-soft   rgba(65,124,221,0.5)   (50% of #417CDD; opaque border variant = --focus-ring)
              DS-6: approved soft ring; settings retain their local focus-border alias; error styling takes priority. Light/Dark and legacy-theme readability must be verified.
  placeholder --text-placeholder  #c4c4c4 / #525252
  error       --error-border / --error-fg
  impl        components/ui/input.tsx
  disabled    60% opacity + ordinary pointer  (new in DS-4; the pre-DS-4 SettingsTextInput had no disabled styling and none of its 6 consumers passed it)
  ivory       surface="ivory" → --settings-input-bg (--surface-card-ivory). Explicit white-panel / nested-card surface (DS-6 decision); elevated remains the default. Preserve local theme overrides.
```

- **Multi-line inputs (textarea) take the 8px inner-control radius — never the pill** (tall frames deform it), whether nested in a container or standing alone in a form (§5 radius scale; single rule, no nesting condition). Implementation: `components/ui/input.tsx` `Textarea`.
- **Existing settings inputs retain their local theme contract** through `SettingsTextInput`, a thin wrapper over `ui/input`. It supplies the historical `settings-input-text`, `settings-input-border`, `settings-input-border-focus`, and `settings-input-placeholder` aliases via `inputClassName`. Their defaults still resolve to Tier-1; explicit local overrides stay local. Generic `Input` keeps the Tier-1 defaults above. Standard error-state border/ring takes precedence over wrapper styles. Do not promote these legacy overrides into global semantic slots or rewrite user theme files. Existing placeholder load-time normalization remains unchanged.
- **Composer-surface inputs keep the composer's local focus-border alias** — the composer input and the composer suggestion panel's own search field (the 「+」面板 in `AtMentionPanel`) take `focus:border-[var(--chat-input-border-focus)]`, a neutral token (30% in the CINDY themes; other built-in themes default to `--text-tertiary`), not the generic `--focus-ring-soft` ring (owner decision 2026-10-29: the blue frame read as off-style). The panel floats directly over the composer input, so it is focused by ordinary mouse flow, and §2 keeps Focus Blue out of the normal interaction flow; a text input matches `:focus-visible` whenever it is focused, so the blue ring cannot be reserved for keyboard-only use there. The generic `Input` keeps the Tier-1 soft ring above; the settings family keeps its local focus-border alias.
- Placeholders must **read as clearly empty** — Silver (`#a3a3a3`) is too prominent against either Card surface (≈5:1 Dark / ≈2.6:1 Light) and reads as real input; forbidden. **Every input surface's placeholder (chat / ask / settings / plan-action-fb) resolves to `--text-placeholder`** (2026-06 G3, archived in `design-decision-log.md`); non-default themes express their own placeholder color by overriding `text-placeholder`.

**DS-6 form usage (approved 2026-09-08)**: use `FormField` for a real field's label, hint and inline validation error; pass its render-function props to `Input` / `SettingsTextInput`. `required` supplies assistive semantics only, never adds browser validation or changes the business rules. Reserve feedback space on fields that can fail and focus/scroll to the first invalid field; dynamic rows keep stable IDs when siblings are added or removed. Service failures remain Toasts. No new Textarea consumer is required.

`Button loading` retains its accessible label and dimensions, exposes `aria-busy`, disables activation, and reuses `Spinner` (static under reduced motion). The form owns the request and a synchronous duplicate-submit guard: actual saving blocks Cancel/Esc/scrim; success closes through the original callback, failure restores editing. Independent connection tests/model fetching remain independent. No change to cancellation, settlement, configuration, secrets or payload contracts.

Ordinary confirmations opt into standard buttons with `presentation="standard"` on the shared `ConfirmDialog` / provider. DS-6 selects only custom-provider and custom-MCP deletion. Standard confirmation actions keep a 36px minimum height; long labels wrap within the panel and may grow vertically instead of overflowing or truncating. Keep `confirm-btn-*` local styling, default/destructive choice, focus branches and no scrim dismissal. Unselected callers, Permission, Full Access and plugin authorization keep their existing presentation.

**Interaction answer composers (user decision, 2026-11-10):** Free-text answers, custom-choice answers,
withdrawn-question supplements and plan feedback use a full-width input frame. Text occupies its own
full-width area; existing microphone and submit controls sit inside the frame in a trailing toolbar
below the text, never squeeze the textarea into a narrow side column. Submission uses the main
composer's paper-plane glyph, with the actual action retained in localized accessible names and
Desktop tooltips. Multi-select custom input has one submit control, not a second footer submit.
Question navigation, close/skip, validation, voice finalization and approval semantics stay unchanged.

### Typography roles and control pairing (DS-11)

- Preserve the accepted hierarchy: ordinary ConfirmDialog title 18/500; provider/MCP form title 18/600; compact prompt title 15/600 where already specified. Different roles are not interchangeable merely because their font size matches.
- Pair Button md (32px) with Input sm (32px), Button lg (36px) with Input md (36px). Input lg remains 40px for spacious fields; Button has no 40px size. Size names are local component APIs, not a shared ordinal scale.
- Font aliases may share default numbers while retaining separate line-height/role contracts. Preserve public aliases; do not globally round historical unitless line heights or optical spacing. On affected surfaces, UI text consumes `--text-*`, and line boxes must grow with font settings.
- FormField reading hints use `--form-field-hint` (defaults to `--text-secondary-mid`; One Dark Pro / Solarized Light override this help role only): in Cindy Light/Dark this is the description ink tier (70% / 66%, §15.16), and other built-in themes get stronger reading contrast. Preserve `text-tertiary` metadata and `text-placeholder` roles.
- MarketCard's title is a registered frameless text action inside the existing card content, with an independent inset focus indicator. The title button supplies keyboard detail access without nesting the card's Clone/manage controls inside a button. Mouse card selection remains available.

### Select & Dropdown

- **Trigger**: same as a single-line input — pill (9999px), Card bg, 1px Board border, carrying the current value + a chevron.
- **Panel**: a container — 12px radius, 1px Board border; padding depends on the panel type. Select listbox panels use 6–8px padding, the Card bg (`--surface-elevated`) and the soft, downward `--shadow-menu` elevation in both modes, like the menu panels below (owner decision, 2026-10-18; supersedes their former no-shadow rule and does not authorize shadows on in-page controls). Existing local panel-color aliases remain compatible.
- **Menu and popover panels** (shared defaults in `components/ui/dropdown-menu.tsx` / `popover.tsx`): 12px radius and the registered floating-layer shadow `--shadow-menu` (a §6 token-gated exception) written as `shadow-[shadow:var(--shadow-menu)]` — the untyped `shadow-[var(--shadow-menu)]` is a Tailwind shadow *colour* and renders no shadow. `DropdownMenuContent` / `DropdownMenuSubContent` use `p-1`, `bg-[var(--cmd-palette-bg)]`, `border-[var(--cmd-palette-border)]` and `text-[var(--cmd-palette-item-text)]`; under Cindy themes that surface is glass (`--surface-translucent-overlay` + `blur(6px)`, globals.css), and on Windows (`html[data-platform='win32']`) every `--cmd-palette-bg` surface is opaque with no `backdrop-filter` (§15.12). `PopoverContent` stays opaque `bg-popover`. `DropdownMenuSeparator` uses `--cmd-palette-border`. Row highlights use the 8px inner tier.
- **Menu text** (`components/ui/dropdown-menu.tsx`): option rows (Item / CheckboxItem / RadioItem / SubTrigger) are `text-14` / `leading-[1.43]` (32px row with `py-1.5`) on `--cmd-palette-item-text`; shortcuts `text-12` / `leading-[1.33]` / 400 on `--cmd-palette-item-meta`; group labels `text-12` / 500 on `--cmd-palette-item-meta`; destructive rows `variant="danger"` on `--error-fg`; disabled rows 50% opacity. The text colour is the same at rest and on hover. The highlighted (`data-menu-active` / `data-[highlighted]`), checked or open row is 500 (§3 ladder) and its default-stroke Lucide icons go 1.5 → 2, on `--motion-instant` / `--motion-ease-out` (instant under reduced motion). Width never moves: row text and `truncate` spans reserve the 500 width with an invisible zero-height `::after` copy (`content: attr(data-menu-label) / ""`, so `textContent`, typeahead and the accessible name are unchanged), and the shared panels lock their laid-out width (`lockMenuWidth`, re-measured on content, window, image or font changes). A caller's own text colour, weight or inline width wins.
- **Menu hover highlight** (`components/ui/dropdown-menu-highlight.ts`): one `--sidebar-item-hover` surface (8px) per `DropdownMenuContent` / `DropdownMenuSubContent` glides between rows with `transform`; the row nearest the pointer anywhere in the panel wins, and separators do not interrupt the glide. Entering fades in from the checked row (or the target), leaving fades out; keyboard follows Radix's highlighted item, and an open SubTrigger stays highlighted while its submenu is in use. Motion: `transform` / `opacity` on `--motion-instant` / `--motion-ease-out` (fade-out `--motion-ease-in`), size snaps, no slide under reduced motion. Danger rows use the same grey layer. Rows whose caller sets its own `focus:` / `hover:` / `data-[highlighted]:` / `data-[state=open]:` background keep it and get no layer; `hoverHighlight={false}` restores per-row fills. Sidebar menus (`features/cc-agent/sidebar/menuStyles.ts`: `MENU_ITEM_CLASS` / `MENU_ROW_CLASS` = `h-8 gap-2`, triggers `cursor-pointer`) use the same highlight.
- **Form-field Select panel width must bind to the trigger width** — never narrower or wider than the control that opened it, except for the explicitly scoped device-navigation treatment below. Radix Select: `position="popper"` + `width: var(--radix-select-trigger-width)`; other primitives measure the trigger. Ordinary form fields retain this equal-width invariant.
- **Compact Cindy device navigation (sidebar only)**: the trigger fits the device label, unread indicator and chevron, retaining its 24px height. The sidebar's remaining row area opens chat. The teammate chat header no longer carries this picker (2026-10-21): computers are listed in the 近况 popover instead. Long labels truncate and retain their full title. Its listbox is independently 256px wide, capped by the available viewport width, so device names, offline state and unread indicators remain usable even when the trigger says only “本机”. This exception belongs to `CindyDevicePicker`, not the shared Select default or other dropdowns. Keep the existing Radix keyboard/focus behavior and theme tokens. Hit-target and layout regression: `pnpm ui:check --page device-picker --case all --theme all --locale all`.
- **Select listbox option rows** (Select only; dropdown menu rows follow the Menu entries above): rows use the **8px inner radius** (§5 — inner tier inside the 12px panel) and join the **shared menu hover highlight** above — one `--sidebar-item-hover` layer per listbox viewport, same glide, fade and reduced-motion behaviour as the dropdown menu (2026-10-18, supersedes the per-row `--surface-hover` / chip fills). The saved value is marked by its checkmark (and the caller's checked text style), not by a fill; Radix's highlighted option drives the layer for keyboard browsing, including the saved option it focuses on open. Rows whose caller sets its own `data-[highlighted]:` / `hover:` / `focus:` background keep it and get no layer. Group labels, wrapped descriptions, disabled options and scroll controls retain their semantics.
- **Shared Select implementation (2026-10-18)**: use `components/ui/select.tsx` for single-value fields; rich/grouped consumers use its `SelectParts` compound API (`components/ui/select-parts.tsx`) instead of importing `@radix-ui/react-select` directly. Both share the trigger, panel, highlight and motion. Trigger rings use `focus-visible`, including after menu dismissal: mouse-only open/close leaves no ring, keyboard navigation keeps a visible focus cue. Radix still owns focus return, keyboard/typeahead, cancellation and value callbacks. Panel entry/exit reuses §14.4's `float-in` / `float-out` with the transform origin following the actual top/bottom collision placement; reduced motion removes the animation.
- **Composer dropdown rows — one contract with the shared menu** (2026-10-04, supersedes 2026-07-22): the composer menus keep their own shells — MorphPopover (model / permission / + / agent; §14.4 container transform unchanged), the / and @ lists, the bot-chat @ list and the settings search results — but use the shared menu row parts from `components/ui/menu-row.tsx`: `COMPOSER_MENU_ROW` (8px radius, menu text / weight / motion), `menuRowAttrs`, `withMenuLabels`, and one glide highlight per panel (`useMenuPanel` + `MenuHighlightLayer`, the same `--sidebar-item-hover` layer as the shared menu). Rows inside a glide panel set no `hover:` / `focus:` fill of their own (rows that sit outside any glide panel — the model config card's engine rows, the legacy follow-session and "manage providers" rows — keep a `hover:bg-sidebar-item-hover` fill in the same grey). The selected row is marked by a check + 500 and never by a fill — permission, + and agent menus. **The model menu is the one exception** (owner ruling 2026-10-04, keeping the 2026-08-13 ruling): its chosen row keeps a whole-row `--sidebar-item-hover` fill with no check (`data-[menu-active]:bg-transparent`, so the fill steps aside while the glide layer covers that row instead of stacking two translucent layers), the model name stays 500, and the effort / follow-session rows keep their fill and existing check; it still takes the shared glide highlight and the glass panel. Danger-tier orange / blue tints the **text only**. Lists that keep focus in a text input (/, @, bot @, settings search) stay focus-in-input: the highlight follows their own current index (`data-menu-current` or `aria-selected`) through `attachMenuHighlight`'s `current` option, never Radix focus. Panels: MorphPopover ends on `--menu-panel-surface` (the shared menu's glass under Cindy themes, opaque on Windows) with `--cmd-palette-border` and `--shadow-menu`; the / and @ lists and the model config flyout use the same 12px panel and `--shadow-menu` (the softer `--cmd-palette-shadow` stays for the command palette and the / tooltip). Group labels use the shared label (12 / 500 / `--cmd-palette-item-meta`). When touching any composer menu's row styles, change them through `menu-row.tsx` — never one menu alone.

FormField → Select forwards descriptions, required/error semantics, and the semantic error border; native browser required validation remains opt-in by the business form.

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

### Dialog & Modal

Reference implementation: `apps/desktop/src/renderer/components/ui/confirm-dialog.tsx` (the shared confirm dialog); new dialogs reuse its structure — do not invent a parallel one.

**Cindy Make preflight exception (owner decision, 2026-09-20):** this progress dialog uses a top-right × instead of a footer Cancel. The header stays visible while the report scrolls. The ×, Esc and scrim all open the same confirmation, with live copy distinguishing environment preparation, source preparation, upstream search and finished checks. Explain that stopping shared preparation also stops its Settings projection and that prepared resources are kept. Creating the build session temporarily disables dismissal. This exception supersedes the general closing-affordance rule below only for `CindyMakePreflightDialog`; the request form keeps its existing footer.

- **Overlay** (blur added 2026-10-04): every modal scrim — Radix `Dialog.Overlay` / `AlertDialog.Overlay`, hand-built scrims and the Radix side drawers — uses the shared `.modal-scrim` class (`styles/globals.css`): `--overlay-modal` (Light `rgba(0,0,0,0.5)` / Dark `rgba(0,0,0,0.7)`) plus a 4px `backdrop-filter` blur of whatever is behind; on Windows (`html[data-platform='win32']`) there is no blur, the same reason as the opaque Windows menus (§15.12). Desktop attachment previews float over the same `.modal-scrim` (2026-11-03, see [attachment-preview.md](attachment-preview.md)); unlike dialogs, a click on their scrim closes the preview. Never write a scrim colour, `bg-black/…`, `backdrop-blur-*` or an inline background at the call site; to change depth or blur, change the token or the class, never one component. Not dialogs and therefore not covered: the lighter whole-window closing dim in `WindowControls.tsx`, the tap-to-close drawer scrims in `DiffPanelShell.tsx`, the login brand canvas (§16) and the transparent click blocker behind anchored plugin-card prompts.
- **Tooltips opened inside the modal** (2026-09-08, DS-6 review fix): the shared `Tip` portals its content to `document.body` on the default `z-[60]` layer — **below** the `z-[10000]` modal overlay, so an unraised tooltip is covered by its own dialog. Any `Tip` whose trigger lives inside a modal must raise its content above the host dialog: pass `contentClassName="z-[10001]"` to `Tip`, and `secretTipContentClassName="z-[10001]"` on `Input` for the password reveal button (both DS-6 forms do). This mirrors the existing `z-[10001]` popover/dropdown convention inside `z-[10000]` dialogs.
- **Container**: every centered modal panel uses the shared `.modal-panel` class — 12px radius, `--confirm-bg` Card fill, 1px Board (`--border-default`) outline and the registered floating-layer shadow `--shadow-menu` — the same shadow as menu panels (2026-10-04 unification; user ruling the same day). Bot dialogs share this panel; the Bot zero-shadow rule covers in-page Bot surfaces, not modal panels. Call sites never add their own radius, background, border colour or shadow, nor glass `--cmd-palette-bg`; they set only width, position, padding (16px `p-4` by default) and layout. Radix side drawers keep their own edge-anchored panel and share only the scrim. Guard: `__tests__/modalSurfaceContract.test.ts`. Width: confirm/notice dialogs ≈ 400px (`max-w-[400px]`); dialogs with inputs/forms may widen to ≈ 460px and shrink with the viewport (`min(460px, 100vw-32px)`). The DS-6 multi-runtime provider and MCP forms use 600px with the same 16px viewport gutters and a scrollable body capped within 88vh.
- **Title / description**: `--confirm-title` / `--confirm-desc`, medium weight.
- **Buttons**: pill (9999px); primary = inverse neutral (`--confirm-btn-primary-*`, not an automatic CTA assignment), secondary/cancel = outlined (`--confirm-btn-secondary-*`, transparent fill + Board border); footer `justify-end`.
- **Focus on open**: dismissible forms focus their primary input. Ordinary AlertDialog confirmation retains Cancel by default; explicit `autoFocusConfirm` focuses the primary action, while a required typed confirmation takes precedence. Preserve primary → optional third → Cancel DOM order (DS-6 decision).
- **Closing affordance** (made explicit 2026-07-30, updated 2026-09-24, widened 2026-10-01): **no modal dialog closes by clicking the scrim** — forms, wizards, catalogs, confirmations, progress/copy dialogs and informational notices alike, on desktop and mobile. They close only through their own controls (Cancel / primary action / ×) or Esc (Android: Back). A mis-tap outside must not discard an in-progress form or interrupt a flow. Radix `Dialog.Content` therefore always sets `onPointerDownOutside={(event) => event.preventDefault()}`; hand-built scrims only block the click (and keep focus inside so Esc still works). Not covered: media viewers (lightboxes), anchored menus and plain popovers, side drawers and mobile bottom sheets, which keep tap-outside dismissal — except an anchored input popover holding text the user is typing (e.g. the plugin card prompt popover), which follows this rule and closes only via Cancel / Send / Esc. Dialogs with a Cancel action carry **no top-right × close icon** — a × coexisting with Cancel is a spec violation. Confirm-tier dialogs built on AlertDialog (ConfirmDialog) also do **not** close on scrim click. The provider form has no ×; its image-generation interruption confirmation remains a separate business layer. Implementation and regressions: [AddProviderWizard](../../apps/desktop/src/renderer/components/settings/AddProviderWizard.tsx), [provider dialog tests](../../apps/desktop/src/renderer/components/settings/__tests__/CustomProviderDialogAccessibility.test.tsx).
- **Multi-step dialogs / wizards** (registered 2026-07-30, first consumer: Add-Provider wizard): the step indicator lives in the header row (round numbered chips — current step solid `--accent-cta-bg` with `--surface-on-card` text, completed steps ✓ on `--surface-chip`, upcoming outlined `--border-default`). Footer: **back navigation ("← 上一步") is a left-aligned bare text button** (`--text-secondary`, 13px/500, no background — the §5 bare-text-button exemption, no radius) — navigation is not a commit action and must not sit inside the right-aligned pill group; commit actions (取消 / 下一步 / 完成) remain right-aligned pills per the button rule above. Catalog/list steps put the scrollable region between **two full-width 1px `--border-default` hairlines**, with permanent entries (e.g. 自定义端点) pinned below the scroll region, always visible. Width matches the custom-provider form dialog (600px, `min(600px, 100vw-32px)`) so the two provider dialogs read as one family; height is capped at `min(640px, 85vh)` — on large displays a catalog dialog must not stretch toward full-screen height (2026-07-30 ruling).

- **Add-Provider first-step exception (owner-approved, 2026-10-30):** on the initial provider-catalog step only, replace the header step indicator with the right-aligned, always-visible bare-text action “没找到？添加自定义”. Use the theme's existing `--accent-emphasis` foreground, medium weight and a persistent underline so it reads as an action rather than muted descriptive text; preserve its visible keyboard focus treatment. It opens the existing custom-provider form through the existing dialog handoff. Do not render a second custom-provider entry below the scroll region; the footer contains only Cancel. Preserve the catalog ordering, filtering, scrolling and both full-width dividers. Subsequent steps retain the registered header step indicator and back/commit navigation above. Other wizards, dialog dimensions and shared modal/focus rules are unchanged. This exception records the user-approved layout for PR #8073 and the subsequent review's emphasis correction; it does not authorize general removal of wizard progress or permanent catalog entries.

### Tabs

Pill-shaped tab selectors (e.g. the Claude | Codex agent switch on the new-session screen) are segmented controls: use the shared `SegmentedControl` described in the next subsection. The former Tab Pills rule (active `--surface-chip` fill, transparent inactive) was superseded by the 2026-09-25 v8 decision; do not hand-roll chip-filled tabs.

### Desktop segmented controls (v8 appearance / v9 layout, owner-approved 2026-09-25)

- All Desktop segmented settings, form choices, filters, Agent selectors and pill navigation use `components/ui/segmented-control.tsx`. `VendorSegmentedSwitcher` only adapts Agent labels/icons. Mobile and native iOS controls are outside this decision.
- The borderless pill track uses `--segmented-track`: a black alpha overlay, Light 6% / Dark 25%, applied to its background only. It adapts to the parent surface; pure black cannot be darkened further. Do not add a compensating track border.
- The selected pill uses component-local `--segmented-selected-bg`, `--segmented-selected-border` and `--segmented-selected-shadow`. CINDY Light: #FDFDF8 / #F0F0EB; Dark: #353535 / #3B3B3B. Its narrowly scoped two-layer shadow is the owner-approved elevation exception; it does not authorize shadows on other controls. Other themes default to their elevated/border aliases and may override these roles without changing saved theme files. DTCG is the numeric source.
- Preserve each scene's density, icons, counts, configured markers, width and callbacks. Options stay on one line. Let the description wrap first; when the row cannot fit, move the whole control to the next line. At extreme widths the outer viewport scrolls horizontally while the track remains one line. Settings default to a 32px track / 28px option; compact Diff retains 24px / 18px visuals with a transparent minimum 24px target. Do not force all scenes to one fixed dimension.
- A single measured plate moves with selection over `--motion-base`; hover/press use `--motion-fast`, and press scale is .98. Reduced motion disables movement/transitions. Resize and label changes realign the plate. Unselected text uses `--segmented-option-fg`, hover fill uses `--segmented-hover-bg`, selected/hover text uses `--text-primary`; all options keep weight 500. Disabled controls preserve selection at reduced opacity and cannot activate; focus remains independently visible.
- Settings and filters use `radiogroup` / `radio` / `aria-checked`; panel navigation retains `tablist` / `tab` / `aria-selected`. Tab enters at the enabled selected option (or first enabled option); arrows wrap, skip disabled choices and respect RTL. Home/End select the first/last enabled option; Space/Enter retain native button activation. A missing preset remains unselected.
- Fixed short alternatives with one shared setting can share a track (Telegram reply modes, import dimensions, authentication mode/flow). Dynamic account/object lists, wrapping API protocols, popup actions, multi-select and ordinary document/sidebar tabs remain separate controls.

### Usage data graphics

- `UsageHeatmap` and `UsageTokenBars` encode dates and quantities, including when clicking a mark filters by date. **Clickable data marks keep their data geometry; they are not ordinary pill buttons.** Their corner treatment is the registered data-mark members `usage-heatmap-day` and `usage-token-bar` (§5) — **the registration covers the coloured mark itself, not its hit region, legend, container or tooltip** — and is limited to these usage charts. For the heatmap, the transparent date hit target overlays the cell and shares its resting footprint. For the token bars, the hit target may extend beyond a low or zero bar — the implementation gives it at least 24px of height — while the bar itself keeps its data height. In both charts the hit target's corner treatment is an implementation choice (currently the mark's 2px) and is not fixed by the registration; focus and selection indicators are independent of the registration and follow §5's interaction rules.
- Heatmap: the home dashboard keeps 12×12px cells; Usage History and provider usage automatically use a four-row compact view for histories younger than six months (including empty history), otherwise a trailing 365-day view; only nonzero usage in the current device/party scope counts (see usage-history-charts.md), filling the plot width with equal square cells sized from the annual-view geometry (minimum 12px). Both views use the same column count. The compact view fills four rows with continuous dates ending today (about 212 days), rather than enforcing exactly six months; the annual view keeps seven weekday rows. Narrow plots scroll to the latest dates. Both read-only and clickable views use 2px radius and fixed 3px gaps in both directions. Reserve a 3px outer gutter so edge cells retain their focus/selected outlines. Preserve month alignment, the complete requested history window and the existing four-level blue intensity scale (§2).
- Token bars: 30 equal-width slim columns fitted to the plot, 3px gaps, 2px outer radius, shared baseline and proportional stacked segments. Do not enforce a 24px minimum column width or clip the latest days behind horizontal scrolling. A low/zero bar may have a taller transparent hit target without inflating its data height.
- Preserve date/value tooltips (the heatmap keeps the native title; the daily token bars use the shared `UsageBarsTooltip` overlay registered in `usage-history-charts.md`, 2026-09-26), accessible date/value labels, keyboard activation and visible focus/selected outlines. Charts stay on the semantic gray palette except for the owner-approved Usage History chart colors registered in §2 (2026-09-08); this remains a geometry exception, not permission to introduce further category colors or apply chart radii to other buttons.

### Usage History Charts

The usage heatmap, daily-token bars and their separate interaction indicators follow [the Usage History component specification](./usage-history-charts.md). Their 2px data-mark geometry is set by the §5 registered data-mark members (`usage-heatmap-day` / `usage-token-bar`); the bounded hover/focus/selection emphasis is registered with those members in §5 (interaction constraints), and the extensible model palette, fixed Agent/harness colors and heatmap blue are the §2 Usage History color registration. Date filtering enters through the charts themselves (cell / bar hit targets), the range selector on the page, and the DS-11-restored 36px labelled date field beside it, which writes the same single-day filter as chart activation and shares the charts' selected-day state — the previously owed equivalent entry (the component spec keeps the unchanged hit-target geometry and the pending platform/user acceptance record).

### macOS menu bar quota panel (owner-approved v6 prototype, 2026-10-11)

正文已移至 [macos-menu-bar-quota.md](./macos-menu-bar-quota.md)，规范效力不变。

### Desktop chat and operation authorization (DS-9, 2026-09-11)

Chat prose and compact code use the existing `chatChrome.ts` presentation entry; activity rows reuse `activityRowChrome.ts`. Keep user/assistant, tool, code, thinking and media theme aliases local. Icon actions use the ordinary pill frame with their contextual targets, visible keyboard focus and a Tip; a hidden message action bar becomes visible when keyboard focus enters it. Media previews and content-clipping cards retain their content geometry under §5. Do not change message identity, streaming, history, Diff Worker/virtualization or media/file lifecycles to share presentation.

**IM context card disclosures (owner-confirmed HTML direction, registered 2026-09-12, #4367):** `HookTaskCard` has two narrowly scoped bare-text controls: long-body expand/collapse and the attached-context disclosure. Both remain frameless in resting, hover and expanded states; group contents also have no background frame. This records the confirmed quiet presentation, not a general exemption for chat actions. Both controls share a minimum 24px hit height/width and 4px vertical padding, retain native button keyboard activation, and use a separate visible `focus-ring` box-shadow ring. Text uses `text-tertiary`, with `text-secondary` on hover, in both modes; context text may wrap. The outer message card retains its existing content-clipping treatment. This registration does not assert real-client visual acceptance; Light/Dark HTML previews are not client screenshots.

**Android in-app update card (owner-approved HTML direction, registered 2026-10-16, #6199):** `AndroidUpdateSheet` is one content-height Material bottom sheet for discovery, install permission, download and install. Its paired actions are pills (secondary `surfaceChip` left, primary `cta` right). The only bare-text control is the centered browser-download fallback ("改用浏览器下载" / "Download in Browser Instead") shown under the pills while a decision is pending: frameless, `footnote` 13/18 medium in `textSecondary`, full-width 44pt hit height, pressed opacity 0.72. It is a secondary escape route rather than a commit action, so it stays out of the pill pair; this is not a general exemption for other sheet actions. In short windows the details region scrolls while the actions stay pinned. Floating compatibility presentations round all four container corners. The Light/Dark HTML previews are not Android device screenshots.

**Desktop Permission decisions, user-approved 2026-09-11 after actual-component comparison:** Allow once remains the visual main action using `perm-allow-*`; deny and session-scoped allow remain secondary. Retain neutral operation information: Desktop has no trusted risk-level field, and `autoReviewUnavailable` is not a risk conclusion. No invented danger variant or command-based risk inference. Keep the request in the composer area with title → description → scrollable operation → right-aligned wrapping actions, at the existing density. Use Button with a narrow local-alias adaptation; apply §5's existing pill-button and keycap treatments. Keep long scoped rules bounded by the column and available in the Tip. Labels, order, shortcuts, IME/editable-focus guards, submitting and failure recovery remain owned by the existing permission flow. This decision does not cover permission mode selectors, account/plugin authorization lifecycles or Mobile layout; Mobile is deferred to its own phase.

### Desktop chat threads

Group and private threads share the same panel chrome, root message row and reply divider. The complete root message belongs to the replies’ scroll container; it has no independent height limit or scrollbar. Keep the header and reply composer visible outside that scrolling content. Private threads retain the ordinary task runtime for progress, approvals and stopping.

### Desktop group progress strip

`BotGroupProgressStrip` is the in-progress entry in the group timeline
([group chat §5](../product-rules/bot-group-chat.md#5-界面)): one left-aligned entry per running
execution, made of the member avatar and the shared `WorkGroupBlock` journal (2026-10-31). It has no
capsule or other outer frame; its content and states follow the product rule. Keep semantic
surface/border/text colors in both Light and Dark. It does not authorize pill-shaped toolbars or other status panels.

### Desktop hidden channel records

`BotChannelsPage` lists each connection's hidden channel tasks. The record name and
summary are one narrowly scoped bare-text control: resting, hover and pressed states
keep the existing text block (12px `--text-primary` name, 11px `--text-tertiary` meta,
no fill, border, radius or added padding). Making that existing text open the ordinary
task page does not assign a pill frame or change task state. The separate restart
action remains the registered compact secondary Button and is outside this exemption.
This records the accepted quiet list, not a general exemption for settings actions.

Keyboard focus uses the theme-invariant `--focus-ring` as a `focus-visible` box-shadow
ring. Non-input `outline` is suppressed globally, so an outline class is not a visible
focus treatment here. The ring appears only for keyboard focus and does not create an
ordinary control frame (§5). The single-page comparison showed no resting-pixel change;
this registration does not claim a new client screenshot of the keyboard ring.

### About: harness versions

Each harness occupies one compact row. Pi shows the executable's actual version and a short
check/update status in that row. Its pill trigger opens a menu containing upstream update,
restore Cindy release, check again, and release notes; source versions never become permanently
expanded rows. Upstream compatibility risk appears only in the install confirmation. Installation
progress remains inside the row. Menus use the existing container and inner-row geometry, and
all states use semantic colors in both Light and Dark.

Claude Code and Codex use the same row, trigger and menu (`HarnessVersionMenuRow`), with only
the Cindy-maintained version chain: update to the current channel's version (shown right-aligned,
disabled unless strictly newer), check again, and the last successful check time. A later failed
online check keeps that last version in the menu but disables Update. There is no upstream
source, restore or release-notes entry. Updating first prepares the selected version in the
shared background cache, showing download status in the row, then follows the existing
confirm → busy warning → restart flow. Startup installs only a complete cache matching the
current manifest; if that target has changed or the cache is unavailable, it keeps a usable
old runtime and retries in the background. First-install and repair downloads retain their
existing startup fallback.


### User-attached long images

Desktop user attachments with natural height / width **strictly greater than 3** use a
240×240 top-aligned partial preview, shrinking to the available container width. A
non-interactive pill overlay says “长图 · 点击查看完整图片” (localized); it uses semantic
surface/text tokens and wraps in narrow containers. The image retains its existing
12px content crop and keyboard/click target. Ordinary portraits, landscape images,
unknown dimensions and tool-output images retain their existing contain rules.
Click/Enter/Space still opens the complete original in ImageLightbox; gallery, copy,
annotations and original bytes remain unchanged. This applies through the shared
Desktop user-attachment renderer in private chats, groups and tasks.
Decision: [#6796, maintainer confirmation](https://github.com/makecindy/cindy/issues/6796#issuecomment-6361112964).

## 5. Layout Principles

### Spacing System

- Base unit: 8px
- Scale: 4px, 6px, 8px, 10px, 12px, 14px, 16px, 20px, 24px, 32px, 40px, 48px
- Standard Button action frames use 24px horizontal padding and vertical centering within the 28/32/36px height (§4); do not add 10px top/bottom padding to that height. Registered keycaps, data marks and bare-text buttons follow their component treatments; a `<button>` tag alone does not assign this padding to a visible layer or hit region (§5 Border Radius Scale).
- Container padding: dialogs 16px (`p-4`, see §4 Dialog & Modal); Select listbox panels 6–8px and shared menu panels `p-1` (see §4 Select & Dropdown)

### Layout Structure (App)

- Full-window three-region structure: sidebar + content area (+ optional right panel), separated by 1px Board dividers on a single flat Surface — never by background shifts (see §2 layer rule).
- Centered-card layouts (login, empty states) follow the Surface + Card two-layer rule in §2.
- Reading-width content (settings forms, document previews) is centered with a comfortable max width; full-bleed content (chat stream, file tree) fills its region.

### Desktop task sidebar identity

Individually pinned tasks stay out of the ordinary list. Automatic task groups use two presentation modes:
while expanded, history includes the task represented by the group header, whether read or unread;
while collapsed, omit that task from the visible attention rows so it only appears in the header.
Deduplicate collapsed rows by task ID, not title. The header keeps its existing click target (latest run,
or the failing run when a collapsed group reports an error). Expanded preview limits, frozen layouts
and “Show all” continue to include the header task.
Non-silent unread runs and pending errors/replies remain visible while collapsed, without a five-row cap;
a task already represented by the header satisfies this visibility rule. Silent successful runs and
read history stay hidden unless the group is expanded.
Implementation: `AutomationSessionGroupItem.tsx` and `automationSidebarGrouping.ts`; regression:
`automationGroupCollapsedAlerts.test.tsx` and the `automation-unread` UI fixture.

### Desktop teammate sidebar

The expanded teammate section previews five chats (local teammates, remote teammates, groups and the merged Cindy device row share this limit). Keep the current chat visible within those five rows. Use the task list’s “Show all N” footer style, with “Show less” after expansion. Collapsing the section to its existing avatar strip resets the preview; the strip’s +N button opens the full list. This limit applies to the Desktop sidebar; the Mobile task home section below previews three.

### Desktop and Mobile task creator filters (2026-10-27)

The sidebar's existing Filter submenu adds Teammates. All (全部) is the default and includes personal tasks and all teammates' tasks;
choosing one teammate selects only its created tasks, then further choices add or remove teammates.
Hide all (都不显示) excludes teammate-created tasks and teammate routine/IM tasks while retaining personal tasks.
Selecting a teammate from Hide all switches to that teammate; removing the last choice restores All. Reset Filters also clears this dimension, preserving task status,
grouping and sorting. Pinned entries retain their existing exemption from content filters.
Use the existing menu rows, avatar component and check marks; keep the menu open for multiple choices.
Show a remote computer name only for device-scoped identities, to distinguish same-name teammates.
Cindy and cloud companions use a single name row without a computer subtitle: their filters span computers. Persist selections
per viewer account. Built-in Cindy is one choice across computers; choosing it includes every copy’s
created tasks, including archived history. Identify it from preset/cloud identity, never its name; custom
namesakes remain separate. Existing per-computer Cindy selections migrate to the unified choice.
Cloud companions use their account identity across old and current computers; retired copies stay out
of the choices, as in the teammate roster. Unlinked teammates remain keyed by computer and teammate ID.
Creation attribution is distinct from following. Existing teammate routine and IM channel tasks also
appear in the desktop task list and share this filter. Their exact linked owner supplies the avatar;
the tooltip says “Belongs to” to distinguish ownership from delegation or following. Active/archived
filters still apply; main chats, private threads and internal group lanes retain their dedicated entries.
Task rows retain their creator avatar after archiving, on both local and remote computers. Prefer the
creator's avatar when others follow the same task; the tooltip distinguishes creation from following.
Two-line teammate rows grow with their content; align the avatar and check mark with the name line,
keeping the computer name in the same text column and preserving vertical padding.
Verify the menu in every supported UI locale and both themes; long names retain the existing menu width.
Mobile uses the same multi-selection semantics in the existing iOS native / Android display menus.
The home (including the task drawer) and device task lists retain creation/ownership avatars after
archiving and cold start. Read the existing teammate delegation and history APIs on older hosts;
keep main chats and internal lanes out of these lists. Cache only portable ownership/avatar metadata
in the account-scoped home snapshot. Late cloud/preset discovery canonicalizes existing selections
without clearing the list or splitting Cindy by computer.

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
| **Keyboard keycap** | Every visible keyboard shortcut frame, whether rendered as `<kbd>` or as an interactive button that accepts the shortcut. Border, fill, padding and text colors stay appropriate to the surrounding surface; the radius is the shared cross-surface rule. *(Registered 2026-09-06, #4001.)* | 4px |
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

*A member ID identifies an approved visual role, not a filename or an entire component subtree. Reuse within its stated scope and semantics-preserving refactors do not require a new radius ruling; keep implementation references current. A new role, wider scope or changed geometry requires adjudication. Component entries reference the member ID and record other dimensions and interaction details instead of maintaining a second radius value.*

*The last two members absorb the narrow "status micro-cells (2px)" exception registered 2026-07-28. Their value and their components are unchanged; what changes is the basis — they are classified by the role their shape plays, not by being ≤8px and non-interactive. See the decision log for the two scope changes this entails. The first two members likewise carry the usage-chart geometry that #4064 phrased as a separate "usage data marks (2px)" exception; that parallel wording was folded into these registrations when this section merged, and §4 Usage data graphics is the component entry that records their dimensions.*

**Evidence required to register a new data mark** — what an adjudication request must establish. **Not** a self-service test that admits a layer automatically:

1. a stable mapping from a data field to a visual channel of that layer (position, size, area, colour intensity, **or categorical colour**);
2. which visible layers belong to the data and which belong to the control, stated separately;
3. that the classification does not depend on the current number of data points, the label text, the presence of a click handler, or the rendering technology (DOM / SVG / canvas).

Ordinary input options, control selected-states and action frames do **not** enter merely by carrying data. Mixed objects are resolved in the component entry.

#### Content and unresolved shapes

**Pixels and intrinsic geometry within images, icons and other assets are not control frames.** Existing approved content and cropping treatments follow their owning component specifications; any surrounding action frame is assigned separately. Replacing an asset within such a treatment does not register a new shape.

A new content-owned outline or mixed object not covered by an existing specification **must be submitted for adjudication**. Reviewers report unresolved classification and request the missing decision; they must **neither force the object into the pill tier solely because it is clickable nor approve an unregistered exception**.

#### Step 2 — Control tiers

Ordinary control frames, containers and inner-control surfaces not covered by Step 1 use the following three tiers.

- **Pill (9999px)** — control frames: buttons, tabs, single-line inputs, tags, badges. **A control's fill style never changes its tier** — transparent and outlined fills are still pills (dialog secondary/cancel are pills with a transparent fill).
- **Container (12px)** — the box that holds content: code blocks, cards, panels, dialogs. Tailwind `rounded-xl`.
- **Inner control (8px)** — multi-line inputs (textarea), **always 8px** whether nested in a visible container or standing alone in a form; plus selected/hover row highlights in dropdowns/menus, and small in-block cells nested inside a container. Tailwind `rounded-lg`.

**A layer with no frame or surface to round needs no corner-radius assignment.** This does not authorize a control to discard its prescribed frame treatment merely by omitting a fill or border. A transient hover or pressed surface on an ordinary control remains that control's frame and takes its assigned tier.

**A focus or selection indicator is a separate visual treatment.** Its appearance alone does not create a new ordinary control frame or reclassify the associated layer. Registered bare-text buttons (wizard back-navigation "← 上一步", the §16.3 login text-button category, and the hidden-channel record text in the §4 Desktop hidden channel records entry) remain frameless and retain their visible focus treatment (the login text buttons do not have one yet; `login-flow.md` §16.3 records the gap); new bare-text-button usages must still be registered in the introducing component entry.

Evaluate the approved component treatment across its states, including shared styles and pseudo-elements. **The absence of a local background or border class is not evidence of frameless status.**

#### Interaction constraints — apply after assignment

Making something clickable never moves a layer between Step 1 and Step 2.

- **Hit testing and mark geometry are independent responsibilities; they may share a DOM element or drawing primitive. No additional wrapper is required.** Hit-target geometry must not replace, clip or distort the mark's registered visible geometry or its data mapping. The mark's own registered clipping remains permitted. Resetting an existing radius with `rounded-none` is permitted when needed to achieve this result; **the presence or absence of a particular class is not the compliance test**.
- **Focus and selection indicators use the associated component's approved interaction treatment.** For registered marks, the component entry identifies the indicator geometry; it must not be inferred by reclassifying the mark as a pill control. An indicator may be drawn on the existing element, a pseudo-element, an overlay or the drawing surface. It must remain distinguishable without changing the mark's registered geometry or data encoding.
- **On a data-bearing layer, hover must not alter the visual mapping that encodes the data.** Use a distinguishable indicator on a separate visual layer when the relevant channel is already occupied.
- **For the same data and display configuration, a registered mark's geometry and corner treatment must not change solely because interaction is enabled or disabled.** Independent hover, focus and selection indicators are allowed.
- **Hit-target sizing.** Registered data-mark status does not itself provide an exception from pointer-target requirements. For the usage heatmap and daily-token chart, dense date targets may be retained through the **Equivalent** route of WCAG 2.2 SC 2.5.8 only when the Usage History view also provides a date-selection control that satisfies that criterion and reaches every selectable date with the same filtering result. Relative presets alone are not equivalent to arbitrary single-day selection. **DS-11 adds a 36px-high, labelled date field beside the range selector; it writes the same single-day filter as chart activation and displays chart-selected dates.** This closes the previously owed equivalent-entry implementation; platform/visual acceptance is recorded separately in the DS-11 evidence. Overlapping targets for different dates are not an acceptable enlargement technique. These members have no category-wide Essential exemption. Keyboard access and visible focus remain required independently.
- **Registered interaction emphasis — Usage History charts (owner-approved 2026-09-08).** For the two registered data-mark members `usage-heatmap-day` and `usage-token-bar`, the component's approved interaction treatment additionally includes a bounded emphasis: the non-hit-testing visible layer may expand by 2px (heatmap cell width/height, bar width), which fits inside the 3px grid gaps and changes neither the grid pitch, the resting geometry, nor any data encoding; bar height, baseline, categorical colour tokens, heatmap intensity and hit regions do not change. The 09-08 reference refinement permits only the token chart to fade non-selected bars while an in-window date is selected or the recent-seven-day range is highlighted; the heatmap uses its registered neutral selection outline, bars stay without a pointer-selection outline, and keyboard focus stays independently visible. All four corner radii remain 2px throughout. The exact geometry and curve are specified in the component entry ([usage-history-charts.md](./usage-history-charts.md)); §14.4 carries the matching motion registration. No other member may borrow this emphasis.

#### Scope and inventory

*Do not invent radii. **"It looks small" is never a reason to move a layer down a tier** — within Step 2 a layer's tier follows what it IS (control frame / box / textarea), not its size or nesting. **This sentence governs Step 2 only**; it is not an argument that every clickable layer is a control. Mind nesting: an 8px row highlight inside a 12px panel must stay smaller than its container; a pill there becomes a lozenge, 12px looks bloated.*

*New tiers and new registered shapes both enter only through adjudication — neither is added by a reviewer's reading of this section.*

*Governed corner-radius values are **0px and 2px** for registered data marks, **4px** for keycaps, **8px** for inner controls, **12px** for containers, and **9999px** for pill frames. No 3px / 6px / 10px, and no arbitrary values. A layer with no frame to round needs no assignment; "no assignment" is not an additional radius value. **Intrinsic content and mark geometry remain outside this corner-radius inventory** — a scatter dot's circle, a pie sector's arc, a map outline are shapes of the mark itself. Existing non-keycap `rounded-[4px]` usages remain registered debt; bare `rounded` and `rounded-sm` substitute for nothing.*

*Guard (2026-10-30): in Desktop renderer code, an added line whose radius resolves outside this inventory — `rounded-md` (6px), `rounded-2xl` / `rounded-3xl`, arbitrary values such as `rounded-[6px]` / `rounded-[10px]`, or a literal `border-radius` / `borderRadius` — fails `pnpm check:design-colors`. Intrinsic content geometry (an icon mask, an illustration shape) is declared with a `design: intrinsic-geometry — <reason>` comment on that line or just above and is then reported for review instead. Existing occurrences are debt, migrated page by page as visible changes; see [`design-governance.md` §8](./design-governance.md).*


## 6. Depth & Elevation

**Mobile home navigation drawer exception (owner request, 2026-09-27):** The left-edge main menu uses an elevated surface, right-side container corners, and a soft outward shadow from mobile's `homeDrawerShadow` theme token. This exception is confined to `HomeChromeDrawer` (including its companion entry), not in-page cards or the task-list sidebar. The account header puts the user's name first, with the same personal avatar as Settings (falling back to a letter when no photo is available), optional email, and a small organization logo beside the organization name; do not show an account ID. Opening waits for native layout, then translates the panel and fades the backdrop together; drag, cancellation and close share one UI-thread progress value and respect reduced motion. Numeric values remain in mobile tokens and component styles.

| Level              | Treatment                                                                 | Use                                            |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Flat (Level 0)     | No shadow, no border                                                      | Surface background, most content               |
| Bordered (Level 1) | `1px solid` Board (`#d7d7d4` Light / `#3c3c3a` Dark)                      | Cards, code blocks, dividers, section outlines |
| Lifted (Card)      | Card fill (`#ffffff` Light / `#2c2c2a` Dark) + optional 1px Board outline | Login cards, modals, raised panels             |

**Shadow Philosophy**: Cindy's base visual language uses **zero shadows**. This is not an oversight — it's a deliberate design decision. The flat, shadowless approach creates a paper-like experience where elements are distinguished purely by background color and single-pixel borders. Depth is communicated through **content hierarchy and typography weight**, not visual layering. (The only shadows in the system are the mobile home drawer exception above, the PDF page in the document preview, whose white page would otherwise merge with a light surface, the stick cap of the WorkLouder device illustration, the `ThemeBrandLockup` icon, and the token-gated floating-layer exceptions and the Slider thumb (§15.18) / Segmented selected-pill (§4) exceptions registered in §10 — `--shadow-menu` (menus, popovers, modal panels and every other layer floating above content: tooltips, jump and new-message chips, find bars, toasts and floating notices, owner decision 2026-11-07) / `--cmd-palette-shadow` / `--segmented-selected-shadow` (`--confirm-shadow` stays registered for theme compatibility but is no longer consumed by dialogs); never add ad-hoc shadows to in-page elements. A Switch-knob shadow was trialed and explicitly rejected — user ruling 2026-08-05: the legacy `shadow-lg` on the 16px thumb was invisible in practice, and a visible replacement read as noise; the knob is flat by decision, don't re-add it.)

## 7. Do's and Don'ts

### Do

- Use Surface (`#f8f8f6` Light / `#1f1f1e` Dark) as the page background — every page starts here
- Assign each visible layer using §5: check Step 1 registered shapes (keyboard keycaps and data-mark members) first; ordinary control frames then take the Step 2 pill tier.
- Use the §5 Step 2 container tier for content boxes — code blocks, cards, panels; assign contained layers separately.
- Use the §5 Step 2 inner-control tier for multi-line inputs (textarea, always), dropdown/menu row highlights and in-block cells not covered by Step 1.
- Keep the palette strictly grayscale — chromatic color only via the sanctioned semantic set in §2, always through tokens
- Use Inter at weight 400 / 500 for display headings (per the §3 Hierarchy rows) — hierarchy comes from size + weight, not typeface switching
- Keep in-page elements shadowless — depth comes from borders and background shifts; only the shadows registered in §6 are allowed
- Keep content density low — each section should present one clear idea
- Use monospace for terminal commands and code — it's primary content, not decoration
- Keep ordinary action frames on their §4 component treatment and §5 assigned tier, including transient hover / pressed surfaces. Focus and selection indicators are separate treatments: their appearance alone creates no ordinary control frame and does not reclassify the associated layer. Registered bare-text buttons remain frameless with visible focus; evaluate approved states, shared styles and pseudo-elements, not only local background or border classes.

### Don't

- Don't introduce any chromatic color outside the sanctioned semantic set in §2 — no brand blue, no accent green, no warm tones beyond the registered exceptions
- Don't invent arbitrary radii — §5 governs the inventory: 0px / 2px for registered data marks (pinned per member), 4px for keycaps, 8px for inner controls, 12px for containers and 9999px for pill frames. No 3px / 6px / 10px or arbitrary values. Frameless layers need no assignment; intrinsic content and mark geometry remain outside this corner-radius inventory. Existing non-keycap `rounded-[4px]` usages remain registered debt; bare `rounded` and `rounded-sm` substitute for nothing.
- Don't add shadows outside the §6 registry (floating layers via `shadow-[shadow:var(--shadow-menu)]`, the segmented selected pill, the Slider thumb, the document-preview PDF page, the WorkLouder stick cap, the `ThemeBrandLockup` icon, the Mobile home drawer) — never ad-hoc shadows on in-page elements, no preset `shadow-sm` … `shadow-2xl`; the flat aesthetic is intentional. `designEffectsDiscipline.test.ts` enforces this
- Don't use font weights above 600 in UI chrome — 700 only inside the exemption domains registered in the §3 registry (that table is the single source of truth; it currently covers markdown content, hljs theme ports, login / Splash brand canvas, third-party viewers under `vendor/`, and imperative third-party APIs). Don't re-enumerate the domains here — read §3. No 800+, no in-between values, anywhere
- Don't add decorative illustrations — Cindy's working UI carries no mascots or artwork; brand imagery appears only on the explicitly enumerated sanctioned brand surfaces in §15.7 / §16; the only other artwork is the user-selected [application wallpaper](./wallpaper.md)
- Don't introduce gradients — flat blocks and borders only; the registered exceptions are the session-loading wordmark sheen and functional edge fades (§2 Gradient System), the Computer Use cursor bloom (§15.7) and the neutral model-budget spectrum bar / GhostTool shimmer (§15.4)
- Don't hard-code a solid gray for neutral text or fake a text tier with element `opacity` — use the text tier tokens (§2); in the CINDY family they are translucent ink and stay correct on glass and wallpaper
- Don't overcomplicate the layout — stick to the region structure in §5; no complex nested grids
- Don't use borders heavier than 1px — containment is always the lightest possible touch
- Don't add decorative or large-motion animation — no bounce, parallax or gratuitous movement, and no looping beyond the loops registered in §14.4 and the optional Dynamic [wallpaper](./wallpaper.md). Short **functional** state transitions (color / background / opacity) are fine and expected; their durations follow the §14.4 tiers.

## 8. Window & Adaptive Behavior

Cindy Desktop is an Electron app: layout responds to window resizing, not page breakpoints.

### Desktop Window

- Minimum window size: **800 × 600** for the main window and secondary session windows (enforced at the BrowserWindow level — `apps/desktop/src/main/bootstrap-electron.ts` / `secondary-windows.ts`). The detached right-sidebar window has its own smaller floor of **360 × 480** (`right-sidebar-window/window.ts`), and a popped-out sidebar tab window (one or more tabs) floors at **360 × 420** (`sidebar-tab-window/window.ts`) — layouts hosted there must stay legible down to that width
- The sidebar is collapsible; region dividers and paddings hold as the window narrows, and content reflows fluidly
- Chat stream and composer reflow with the window; code blocks keep horizontal scroll instead of wrapping
- Ordinary control sizes and paddings follow their §4 component treatments at every window size. Registered shapes and their hit regions follow their owning component treatments and §5 Interaction constraints; the usage charts' dense date targets use the Equivalent route only under the conditions stated there. Window resizing does not waive the applicable target requirements or authorize changing a mark's registered geometry.

### Mobile

Cindy Mobile (React Native) has its own device-class rules (phone / pad portrait / pad landscape). Cross-platform skins and login follow §15.13 and §16. iOS navigation, sheets, materials and controls follow the platform supplement [iOS native design](./ios-native-design.md); implementation guidance remains in [Mobile design guide](../../apps/mobile/docs/mobile-design-guide.md). **Mobile text (color, size, weight, line height) is decided by role from the guide's §3 text quick-reference table** (ruling 2026-09-26 / 27): five neutral text colors, lighter colors never take heavier weights, an 11-step type scale, and every text style paired with a line height; guard tests enforce these, role choice is checked in review. Real system-owned components retain system geometry, typography and material; this does not exempt custom content from Mobile tokens. Existing implementations are migration evidence, not the specification for new surfaces.

## 9. Agent Prompt Guide

### Quick Color Reference

Default-theme values; the CINDY themes resolve the same tokens to translucent ink (§15.16), so always write the token.

- Primary Text: "Near Black (#262626)" Light / "Soft Gray (#d4d4d4)" Dark — `--text-primary`
- **Surface** (page bg): "Light Surface (#f8f8f6)" / "Dark Surface (#1f1f1e)"
- **Card** (elevated layer): "Pure White (#ffffff)" / "Dark Card (#2c2c2a)"
- **Board** (1px dividers/borders): "Light Board (#d7d7d4)" / "Dark Board (#3c3c3a)"
- Secondary Text: "Stone (#737373)" Light / "Silver (#a3a3a3)" Dark — `--text-secondary`
- Tertiary Text: "Silver (#a3a3a3)" Light / "Stone (#737373)" Dark — `--text-tertiary`
- Chip/Button Background: "Light Gray (#e5e5e5)" Light / "Dark Chip (#3c3c3a)" Dark — `--surface-chip` (the collapse-to-Card variant `--surface-chip-alt` #2c2c2a: see §2)

### Example Component Prompts

- "Create a settings section: a 16px/500 section title outside the card; one elevated Card (--surface-elevated, 12px radius, 1px --border-default outline) groups related rows — label 13px/500 and hint 12px on the left, control on the right, inset dividers between visible rows (§4 Desktop settings rows)."
- "Design a code block with a 12px border-radius, 1px solid `--border-default` border on a `--surface-elevated` background. Use the code font stack (§3 Font Family). No shadow."
- "Build a pill tab switch with the shared SegmentedControl (§4 Desktop segmented controls): borderless --segmented-track, selected pill on --segmented-selected-bg, all options weight 500. Do not hand-roll chip-filled tabs."
- "Build a chat composer: a Card-colored (--surface-elevated) 12px-radius container; inside, pill control chips (9999px) that are borderless at rest and gain a --border-default outline on hover."
- "Design a confirm dialog: 12px-radius container, max-width 400px, pill buttons — inverse neutral primary, optional outlined third action, then outlined Cancel; Cancel receives initial focus unless the caller explicitly selects primary focus or requires typed confirmation."
- "Create a dropdown: pill trigger; panel width bound to the trigger; 12px-radius Card panel with 1px Board border; option rows highlighted with 8px inner radius via the shared menu highlight (--sidebar-item-hover)."

### Iteration Guide

1. Focus on ONE component at a time
2. Keep all values grayscale — name the token (`--text-secondary`), not "use a light color" or a literal gray
3. Assign the specific visible layer through §5: check Step 1 registered shapes first (keycaps or an approved data-mark member), then use Step 2 for ordinary control frames, containers and inner-control surfaces. Keep contained content, hit testing and focus / selection indicators separate as §5 requires; submit unresolved shapes for adjudication.
4. No new shadows — only the §6 registered exceptions carry one
5. Weight is 400/500 for everyday chrome, 600 for rationed emphasis — 700 never appears in new UI (registered exemption domains in §3 only)
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
- `builtin/` — built-in theme objects (`cindy-light.ts` / `cindy-dark.ts` / `eclipse.ts` / `default-light.ts` / `default-dark.ts` and the community palettes)
- `registry.ts` — the `builtinThemes` registry + `listThemesByType('light' | 'dark')`

Theme switching: `useTheme.ts` provides `theme` (System / Light / Dark mode) plus `lightThemeId` / `darkThemeId` (which concrete theme). Settings → Appearance is the UI entry.

Settings → Appearance opens with the settings page title (see “Desktop settings rows”). The theme card follows the page title directly, without its own section title; Wallpaper, Fonts, Sidebar & panels and Reply Animation follow, each titled outside its card and laid out as settings rows (see “Desktop settings rows”). In the theme card, Theme, Appearance mode and Local themes are separate rows divided by lines. Theme is a single row whose picker is the same 320×36 pill select as Settings → General → Display language (same trigger, popover, option and selected styles). Theme, Local themes and Wallpaper carry no extra description line. Wide controls (wallpaper grid, sliders, and the font pickers, whose preview popovers must match the trigger width) sit under their row label. The appearance mode is one row: label on the left, three 92×60 window thumbnails on the right with a 12px caption. Each thumbnail draws a miniature Cindy window (sidebar, user message, reply lines, composer with send dot) from the selected color theme’s own `surface`, `surface-chip`, `border-default`, `surface-elevated`, `text-primary` and `text-tertiary` values; “System” shows the light half on the left and the dark half on the right. The selected thumbnail gets a 2px `--settings-theme-preview-border-active` ring with a 2px gap (12px outer / 8px inner radius), unselected ones show the ordinary preview border on hover. The theme picker comes before the appearance mode. A theme family with only one variant is tagged “Light only” / “Dark only” in the theme list. While such a theme is selected, the three mode cards are disabled and show the variant actually rendered, with one line under the mode label explaining it; the saved mode is not changed and applies again when a two-variant theme is chosen (owner request, 2026-10-17). Implementation: [AppearanceSection.tsx](../../apps/desktop/src/renderer/components/settings/AppearanceSection.tsx); regressions in `AppearanceSection.accessibility.test.tsx`.

### Token Tiers

**Tier 1 — Semantic slots**: the core cross-context slots; when adding a theme, this tier is the main override battleground. The exact-value summary below is generated from the Desktop DTCG source. Registry IDs and usages remain the compatibility contract.

<!-- BEGIN GENERATED DS-8: semantic-colors -->
| Category | Slot | Default Light | Default Dark | Primary use |
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
|  | `--surface-hover-hsl` | `0 0% 90%` | `60 2% 17%` | Hover, HSL form |
|  | `--surface-on-card` | `#ffffff` | `#1f1f1e` | Dark foreground on CTAs / checked icons |
| **Border** | `--border-default` | `#d7d7d4` | `#3c3c3a` | This spec's Board 1px border |
|  | `--border-default-hsl` | `60 3% 84%` | `60 2% 23%` | Board, HSL form |
|  | `--border-shadcn-hsl` | `0 0% 90%` | `30 4% 28%` | shadcn input/border HSL |
|  | `--border-transparent-mixed` | `transparent` | `#3c3c3a` | Single-side borders (progress track etc.) |
| **Text** | `--text-primary` | `#262626` | `#d4d4d4` | Primary headings / body |
|  | `--text-primary-hsl` | `0 0% 9%` | `0 0% 83%` | Primary, HSL form |
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
|  | `--text-tertiary-hsl` | `0 0% 45%` | `0 0% 45%` | Tertiary, HSL form |
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

`--perm-auto-selected-text` and `--perm-bypass-selected-text` are protected only from automatic theme import; hand-ported built-in themes may override them (§2).

| Token                                                                                                                                                         | Light                                                                   | Dark                                                                  | Use                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--destructive` (HSL)                                                                                                                                         | `0 84% 60%`                                                             | `0 72% 63%`                                                           | Generic destructive text/border                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--error-flat`                                                                                                                                                | `#ef4444`                                                               | `#ef4444`                                                             | Flat danger foreground                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--login-error-fg`                                                                                                                                            | `#D91F37`                                                               | `#D91F37`                                                             | Login error text/border (see §16.1)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--error-bg/-border/-fg/-fg-strong`                                                                                                                           | (red)                                                                   | (red)                                                                 | Error alert card subsystem                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--diff-add-fg/-bg`, `--diff-del-fg/-bg`                                                                                                                      | GitHub palette                                                          | GitHub palette                                                        | Diff rendering                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--pr-open-on-light`                                                                                                                                          | `#2EA043`                                                               | `#2EA043`                                                             | Sidebar task-info PR open on light surfaces (2026-08-17)                                                                                                                                                                                                                                                                                                                                                                                         |
| `--pr-open-on-dark`                                                                                                                                           | `#3FB950`                                                               | `#3FB950`                                                             | Sidebar task-info PR open on dark surfaces (2026-08-17)                                                                                                                                                                                                                                                                                                                                                                                          |
| `--status-bar-accent`                                                                                                                                         | `#EA6B17`                                                               | `#EA6B17`                                                             | Thinking Orange, theme-invariant (finalized 2026-07-17)                                                                                                                                                                                                                                                                                                                                                                                          |
| `--plan-action-approve-icon-bg`                                                                                                                               | `#EA6B17`                                                               | `#EA6B17`                                                             | Plan approve — same thinking semantics (follows warning-accent, finalized 2026-07-17)                                                                                                                                                                                                                                                                                                                                                            |
| `--perm-bypass-selected-text`                                                                                                                                 | `#EA6B17`                                                               | `#EA6B17`                                                             | Heart Orange, permission semantics (auto-follows `var(--warning-accent)`, finalized 2026-07-17)                                                                                                                                                                                                                                                                                                                                                  |
| `--settings-integration-warning`                                                                                                                              | `#EA6B17`                                                               | `#EA6B17`                                                             | Warning semantics (auto-follows `var(--warning-accent)`, finalized 2026-07-17)                                                                                                                                                                                                                                                                                                                                                                   |
| `--warning-bg-soft`                                                                                                                                           | rgba(234,107,23,0.12)                                                   | rgba(234,107,23,0.18)                                                 | Warning alpha surface (alpha recomputed against `#EA6B17`, 2026-07-17)                                                                                                                                                                                                                                                                                                                                                                           |
| `--warning-fg`                                                                                                                                                | `#F3A115`                                                               | `#F3A115`                                                             | Warning text/icons, including the update-restart busy-turn interruption hint                                                                                                                                                                                                                                                                                                                                                                     |
| `--focus-ring` / `--focus-ring-soft`                                                                                                                          | `#417CDD` / @50%                                                        | same                                                                  | A11y focus ring, finalized 2026-07-17 (replaces #3b82f6), theme-invariant                                                                                                                                                                                                                                                                                                                                                                        |
| `--text-selection-bg`                                                                                                                                         | `var(--focus-ring-soft)`                                                | same                                                                  | Selected text background; remains visible when focus moves into an embedded webview                                                                                                                                                                                                                                                                                                                                                              |
| Mobile `quotaBarWarn` | `#F3A115` | `#F3A115` | Quota yellow only: 10% < remaining ≤30% (shared rule, 2026-10-31; §2). |
| Mobile `quotaBarCrit` | `#EF4444` | `#EF4444` | Quota red only: remaining ≤10% (shared rule, 2026-10-31; §2); same value as Desktop `--quota-bar-crit` → `--error-flat`. |
| `--slider-thumb-shadow` | two neutral shadows | two neutral shadows (deeper) | Slider numeric/media thumb only, owner-approved 2026-09-17 (§15.18); no Switch or panel reuse. |
| `--shadow-menu` / `--cmd-palette-shadow` / `--confirm-shadow`                                                                                                 | rgba                                                                    | rgba (deeper)                                                         | Shadows, theme-invariant                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--segmented-selected-shadow` | two neutral shadows | two neutral shadows (deeper) | Segmented selected pill only, owner-approved 2026-09-18 (§4); no Switch or panel reuse. |
| `--overlay-modal` / `--overlay-lightbox`                                                                                                                      | rgba                                                                    | rgba (deeper)                                                         | Modal / lightbox backdrop                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--perm-auto-selected-text`                                                                                                                                   | `#417CDD`                                                               | `#417CDD`                                                             | Auto Approval accent, finalized 2026-07-17 (same value both modes; replaces #000050/#00D9C5)                                                                                                                                                                                                                                                                                                                                                     |
| Toast `#417CDD / #2AAE5B / #F3A115 / #D91F37`                                                                                                                 | (hardcoded in Toast.tsx, VARIANT_MAP exported)                          | same                                                                  | Finalized 2026-07-17 (Toast exemption lifted, merged into the status-color family)                                                                                                                                                                                                                                                                                                                                                               |
| `--file-badge-pdf/-doc/-sheet/-slide/-code` + `--file-badge-fg`                                                                                               | `#B23A26` / `#2C5CA8` / `#2E7D4F` / `#A25A12` / `#5B49A8`, fg `#FFFFFF` | same                                                                  | File-type badges on the self-drawn attachment icon (2026-07-27). Bound to _what the file is_, not to the theme, so both modes share one value. Each accent is picked for ≥4.5:1 against `--file-badge-fg` (5.96 / 6.56 / 5.05 / 5.24 / 7.09) — the badge label renders at 10px (Micro Label floor, §3), so AA small-text applies. `--file-badge-fg` is a standalone white: `--accent-pure-cta-fg` flips to black in Dark and cannot be borrowed. |
| `--bot-avatar-red-bg` … `--bot-avatar-graphite-bg` (9 tokens)                                                                                                 | soft tints (`#f7ded9` … `#e5e5e5`)                                      | deep tints (`#4a2e2a` … `#3c3c3a`)                                    | Bot avatar fills in `features/bots` only (2026-08-17). Identity cue ("which Bot"), not status; emoji / initial-letter fallback reads `--text-primary` in both modes. Not part of the external-theme import allow-list, so the hues stay stable across themes.                                                                                                                                                                                    |
| `--bot-unread-bg` / `--bot-unread-fg`                                                                                                                         | `#417CDD` / `#FFFFFF`                                                   | same                                                                  | Desktop group unread indicators, Cindy device-picker and 近况 computer-row unread marks, group-topic unread dots and existing Mobile unread indicators. Desktop private-Bot sidebar unread instead uses `--card-status-done` (2026-11-04; see [Desktop list status](./desktop-bot-list-status.md)); Mobile `botUnread` mirrors it for the companion list unread dot (2026-09-29) and 6px group-topic unread marks (2026-10-28); never for the adjacent text. IM unread semantics, not a CTA and not status; theme-invariant because "unread" means the same thing in both modes. Value is the registered focus-ring / Auto Approval / Toast-info blue; the fg is a standalone white because `--accent-pure-cta-fg` flips to black in Dark. Must not leak to unrelated badges, dots or surfaces.               |
| `--usage-heatmap-high`, `--usage-model-1` … `--usage-model-5` | Heatmap blue alias + reference-refined model palette; see colors.ts | Corresponding Dark palette; see colors.ts | Usage History heatmap, token bars and matching model-table marks only (2026-09-08); since 2026-10-17 also the same charts and person / computer / model table marks in the provider「远程与分享」usage block. Category/intensity, never status. Only these newly introduced model-role defaults are refined; process tokens and user theme overrides do not change. |
| `--process-agent-task-icon`, `--process-agent-service-icon`, `--process-main-icon`, `--process-renderer-icon`, `--process-gpu-icon`, `--process-utility-icon` | `#2563EB` / `#7C3AED` / `#DB2777` / `#0891B2` / `#D97706` / `#059669`   | `#60A5FA` / `#A78BFA` / `#F472B6` / `#22D3EE` / `#F59E0B` / `#34D399` | Resource Usage 14px process-category glyphs only (2026-08-06). Category cue, not status; all surrounding UI stays neutral. Protected from automatic external-theme import so category identity does not drift.                                                                                                                                                                                                                                   |

Mobile's `betaChannelBadgeBackground/Foreground` remain the cross-theme fixed pair `#DF0C27` /
`#FFFFFF`. They are limited to the enabled Beta-channel badge beside the installed app version
in mobile Settings, explicitly requested 2026-08-25. The Desktop sidebar uses ordinary text after
the version number and does not consume a red Beta badge token. This is a persistent channel-state
cue, not an error or CTA; the mobile white text contrast is 4.98:1.

Never freestyle these semantic colors as hardcoded hex — always go through the corresponding token.

**Plugin provenance (user-approved 2026-11-09):** one compact identity mark beside the name:
official blue, community purple, organization teal, custom-market orange and local neutral.
Use `plugin-identity-{official,community,team,custom}-{text,bg}` through the existing DTCG
generation chain; local uses `text-secondary` / `surface-chip`. These colors express source
identity, never package verification, runtime permission or the connected service's endorsement.
The owner-approved mark is a registered §5 shape exception: 20px high, 5px corners, no border,
11px medium text and a 12px icon; it is not an ordinary action frame. Keep its text and icon
so identity does not depend on color. Do not reuse these roles for status or other categories.

**Search matches (2026-09-18, user-approved direction):** global find, file previews and
file editors share `search-match-bg` / `search-match-fg` for ordinary matches and
`search-match-active-bg` / `search-match-active-fg` for the current match. Both modes
use a stronger gold current-match fill with readable dark text. Keep a non-color cue:
global CSS highlights use an underline; preview/editor marks retain their outline.
The existing IDs and explicit theme overrides remain supported. Exact values live in
`packages/design-tokens/src/reference/color.json` and generate `themes/colors.ts`;
this decision does not grant new uses of warning/status colors.

### Built-in Themes

The implementation truth is `builtinThemes` in `apps/desktop/src/renderer/themes/registry.ts`; adding or removing themes does not require updating this document. The default light/dark (base) themes are exactly the §2 palette.

### Adding a New Theme (full flow)

1. Create `apps/desktop/src/renderer/themes/builtin/<id>.ts` exporting a `Theme` object:
   ```ts
   export const myTheme: Theme = {
     id: "my-theme",
     name: "My Theme",
     type: "light" | "dark",
     colors: {
       // Override only the tokens that differ from the base theme;
       // an empty object {} is also valid (identical to base).
       surface: "#xxx",
       "text-primary": "#xxx",
       // ... most themes only need to override 30–90 tokens
     },
   };
   ```
2. Register it in `builtinThemes` in `themes/registry.ts`
3. The Light/Dark Theme dropdowns in Settings → Appearance pick it up automatically

Use any existing non-default theme under `apps/desktop/src/renderer/themes/builtin/` as a template.

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

- **One template, taken from the hand-ported community themes.** The seven ported themes under `apps/desktop/src/renderer/themes/builtin/` (one-dark-pro, github-dark, eclipse, material-ocean-hc, monokai-pro, atom-one-light, solarized-light) share a 108-token base template (DS-11 additionally gives One Dark Pro / Solarized Light a local `form-field-hint` override, outside the import template), derived from 13 palette roles plus the optional light-only `inputBg` role (CREATE AGENT card/input background, e.g. Solarized base2; absent ⇒ collapses to `surface`). Within the template, when a light palette supplies an `inputBg` distinct from `surface` (e.g. Solarized base2 cards), CREATE AGENT `*-hover` and the resting `quick-card-icon-bg` lift to `surface` (icon drops back to `chip` on hover); otherwise `*-hover`=`hover` and `quick-card-icon-bg` is `border` in dark / `chip` in light — keeping default/hover/icon visually distinct in every theme. `control-bg-pressed` is `chip` in dark and `hover` in light. `send-btn-bg`/`send-btn-icon` use the inverse-neutral pair (`textPrimary`/`surface`), not the accent, because the shared send tokens also render 10–12px text that must clear 4.5:1. `apps/desktop/src/shared/theme-import/palette.ts` is that derivation, code-ified; `one-dark-pro.ts`'s header comment is the source-of-truth for which VSCode key feeds which role. The template is **allow-list only** — it emits those 108 base ids plus the imported-theme-only `switch-track-off` / `switch-thumb-off` safety pair. Because external muted/comment colors are unconstrained, the track keeps the source `textSecondary` only when it clears the 3.2:1 derivation target (above the 3:1 non-text floor) against the relevant surfaces and thumb; otherwise the converter takes the smaller passing correction along the source-to-black/source-to-white paths, or rejects the palette with the dedicated contrast error rather than reporting it as an unrecognized file or internal error. Existing local snapshots created before this pair existed are backfilled with the same 3.2:1 target at renderer load time only when both tokens are absent and the complete legacy semantic palette is parseable; if no track can satisfy the target, the runtime restores the pre-upgrade `border-default` track and `surface` thumb instead of falling through to unchecked aliases. Disk JSON and explicit user overrides are never changed. Optional Markdown tokens (`md-h1-fg`…`md-h6-fg` / `md-strong-fg`) are added when the source theme provides heading or bold colors.
- **Exemption families are never imported.** `--login-*`, brand red, `--destructive`, `--error-*`, `--warning-accent`, `--status-bar-accent`, `--focus-ring*`, `--diff-*`, shadows and overlays stay at their spec values under every imported theme (see the exemption table above and §16). `apps/desktop/src/shared/theme-import/protected-tokens.ts` enforces it as a second gate; the import report tells the user how many tokens were held back.
- **`-hsl` tokens are computed, not copied.** Both forms of a color must denote the same color, so the converter derives every HSL triplet from its hex via `toHslTriplet()`. (Note: a few hand-written builtin themes carry approximate HSL values — `github-dark`'s `SURFACE_BG_HSL` was copied off one-dark-pro. Those are left as-is; new imports are exact.)
- **Markdown text colors go through `--md-h1-fg`…`--md-h6-fg` / `--md-strong-fg`, and default to `inherit`.** Before these tokens existed, Markdown headings and bold text inherited their color from the container (`baseComponents` sets size/weight only). Defaulting to `var(--text-primary)` would have repainted headings inside blockquotes, tool cards and secondary-text regions, so the defaults are `inherit` — every built-in theme renders exactly as before. Imported themes fill them from Obsidian `--hN-color` / `--bold-color` or VSCode `markup.heading` / `markup.bold`. Guard: `themes/__tests__/markdownColorTokens.test.ts`.
- **Obsidian import is a palette import, not a theme port.** Only CSS custom properties are read; selectors, layout, radii and fonts are discarded — Cindy's layout and typography stay owned by §3/§5. Values that cannot be evaluated statically (`color-mix()`, undefined `var()`) are skipped and reported rather than guessed.
- **Checked Switch track = theme accent.** The seven ported theme files each override `switch-track-on` to their own accent (user ruling 2026-08-05; solarized-light uses `GREEN_DEEP` — the official `#859900` fails the 3:1 floor). The registry default stays `hsl(var(--primary))`: Classic and imported themes keep the pre-existing neutral checked track. CINDY Light and Dark use blue `#417CDD` (owner decision 2026-09-15, §15.17), replacing their former neutral checked tracks. Guard: `switchThemeContrast.test.ts` asserts every builtin theme's checked track ≥3:1 against the checked thumb (`switch-thumb-on`, defaulting to `hsl(var(--background))`) and all five surfaces.
- **Local themes may declare an optional `family`.** Same-family light + dark variants merge into one switchable family (`themes/families.ts`); files without the field keep behaving exactly as before (family id = theme id). Obsidian's dual-mode CSS uses this to land as a single theme that follows Light/Dark mode.
- **Omarchy live theme (Linux).** When `~/.local/state/omarchy/current/theme.name` exists, the main loader (`apps/desktop/src/main/local-themes/omarchy.ts`) converts Omarchy's generated `theme/vscode-theme.json` with the same VSCode converter and lists it as family `omarchy` (no `-local` suffix, no local badge, one variant matching Omarchy's light/dark). The main process watches the `current` directory; each `theme.name` write (Omarchy writes it after swapping the theme directory) reloads themes and pushes `local-themes:changed` to trusted Cindy windows, which retint at once. Cindy never writes Omarchy files. A read that lands inside Omarchy's swap keeps the last good theme and records a path-free diagnostic, so the user's selection is not reset.

## 11. Voice & Content(微文案规范)

> **Status: draft**, introduced 2026-06 (after the Voice & Content section of Vercel Geist's `design.md`). This section governs **how interface copy is written** and pairs with `docs/dev-rules/engineering-conventions.md` §5 (the i18n system) — that side enforces "copy lands via i18n keys, aligned across 5 languages"; this side governs each string's tone and wording. It adds no UI strings, only constraints.

Cindy's product voice matches its visuals: **restrained, direct, never self-congratulatory**. Copy is part of the tool, not marketing.

### 11.1 Language-Independent Principles (every supported locale alike)

- **Actions = verb + object, never a bare verb.** Buttons and menu items say what is done to what: `Deploy Project` / `删除任务` / `セッションを削除`. **Forbidden**: objectless verbs like `Confirm` / `OK` / `确定` / `提交` (confirm-dialog primary buttons especially must carry the object so they read correctly out of context).
- **Errors name what failed; advice must be supported by the cause.** When the cause is known, give the corresponding remedy. Suggest retrying only when there is evidence it may help; never append "Try again / 请重试" by default. When the cause or recovery path is unknown, state the failed operation honestly (for example, `Could not save panel positions` / `未能保存面板位置`), without inventing a cause, promising recovery, or prescribing an arbitrary action. Before suggesting a repeated write, import, or payment, account for possible partial completion. Pairs with `docs/dev-rules/engineering-conventions.md` §2 (IPC error protocol).
- **In-progress = present continuous + ellipsis.** `Deploying…` / `正在部署…` / `デプロイ中…`. The ChatView Thinking status bar (`Spelunking…`, Thinking Orange) already is this pattern; new loading/processing states follow it.
- **Results name the object — never say "success".** Toasts say what changed, not that an operation succeeded: `任务已删除` not `删除成功`; `Project deleted` not `Deleted successfully`. **Forbidden**: filler like "successfully / 成功了". (Toast visuals are §2; this rule is copy only.)
- **Empty states point at the first action** — never just "No data"; tell the user what they can do now ("No sessions yet — hit + to create one").
- **Neither servile nor cold — per language**: English never writes "Please" (the interface isn't begging). **Chinese 「请」 is idiomatic politeness and is exempt** — keep "请输入…" "请先授权" "请选择文件"; don't stiffen Chinese to satisfy the English rule. Neither language uses marketing adjectives ("强大的 / 极致 / 全新").

### 11.2 Casing & Punctuation Per Language (not transferable)

- **English**: labels / buttons / titles / tabs use **Title Case** (`Deploy Project`); body / help text / toasts use **sentence case**. Curly quotes and the ellipsis character `…`, never straight quotes or `...`.
- **zh-CN**: **no Title Case concept** — no per-word capitalization, no English-style punctuation in Chinese; keep English terms as-is in mixed text (`部署 Project`). No full stop at the end of toasts / labels.
- **zh-TW**: likewise has no Title Case; use Traditional Chinese characters and punctuation, while keeping English terms as-is in mixed text. No full stop at the end of toasts / labels.
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
- Draw keyboard focus as a `focus-visible` box-shadow ring. `globals.css` suppresses `outline` globally, so outline utilities and CSS `outline` declarations do not render.
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

**Desktop companion composer action (owner-approved prototype, 2026-10-22).** An idle
one-to-one companion composer shows dictation and a call action. A visible prompt
recommendation keeps the call action available (owner correction, 2026-10-29); its
Tab/click acceptance and Enter send remain available. An accepted or typed draft,
attachments or browser comments replace the call with Send in the same 30px circular
target. Crossfade the icon layers and scale 55% ↔ 100% on
`--motion-enter` (250ms) / `--motion-ease-move`; keep the shell, hit target and dictation
position fixed, with no bounce. CSS transitions retarget from their current values.
Respect reduced motion, retain keyboard focus, and reject a press whose action changes
before activation. Recording/refinement, Stop, Queue and queue editing retain their
existing actions. Other composers keep their existing behavior.

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

**Semantic loop-cycle exception:** `--motion-spinner-cycle` = `1000ms` is the
full-turn duration for functional loading spinners. It is not a sixth interaction
tier and must not be used for enter/exit, hover, resize, or decorative motion.
Spinner rotation remains linear, transform-only, mounted on an HTML wrapper, and
must become static under reduced motion. This exception keeps loading rotation
readable without coupling it to dialog timing or copying a hardcoded Tailwind
default into components.

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

**macOS menu bar quota fill (owner request, 2026-10-11; liquid and ripple 2026-10-16).** The native menu bar panel (`apps/desktop/native/menubar/`) fills its detail rings from empty over 0.5s with `timingCurve(0.22, 1, 0.36, 1)` (no overshoot) each time the panel opens or a page loads; page switches use the same curve and duration. Usage tube liquid rises on the same curve over 0.9s, staggered 60ms per tube; while it rises the surface rocks only slightly (about 1pt, a quick 0.34s rock that swells mid-climb and is level again on arrival) and it sloshes properly once it stops — inertia tips the surface from side to side (first mode, up to about 5pt at the edges for a nearly full tube, ~0.95s period) with a smaller faster second mode, decaying over about 4.5s. How hard a tube sloshes follows how high its liquid climbed (momentum grows with level^1.5, so a low tube barely moves), and every opening draws a fresh profile — first lean direction, strength, period, decay, the second mode and the instant of arrival — so the tubes never repeat themselves. The slosh then decays to the gentle ripple on a source in use and to a still surface everywhere else (owner request, 2026-10-16). The task total reads "3M token · $66.46": tokens first, so the amount ends flush with the task amounts below; without tokens the amount alone sits at the right. Plain numbers (tube values, task amounts and total, the month total, the detail ring value) count up from zero on the same 0.9s curve each time the panel opens, with the final text reserving its width so nothing shifts; strings that mix in words stay static. Today's task total (19pt) reads larger than each task's amount (14pt). After the opening settles, continuous motion carries one meaning only — **tokens are being spent right now**: the liquid surface of a source that a running task on this computer is drawing on ripples gently (about 1.5pt, a 3.6s period; main marks it `active` from the running session's provider, with Cindy-managed providers marking the Cindy balance), and a running task's share bar carries a travelling highlight. When the task stops, the ripple eases to a flat, still surface over 1.4s; every other tube and the warning glow stay still. Feedback: moving the pointer onto a tube gives its liquid a small nudge (about a third of the opening slosh, scaled by its level, random first direction) that dies down within about a second, and sweeping across the row does not restart a nudge that just began; a pressed tube squeezes to 95% and springs back; the "Open Cindy" `>` slides in once as the panel opens, leans 2pt forward on hover and pushes 4pt on press. These are SwiftUI motions, not Web duration tiers: the Web tokens do not apply inside the native helper. Reduced motion shows the final values without animation and keeps every surface still. This exception does not apply to any other surface.

#### Semantics → motion prototypes (one semantic, one motion, app-wide)

| Semantic                                    | Spec                                                                                                                                                                                                                                                                                         | Reference implementation                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Light overlay (menu / popover / tooltip)    | In: `animate-float-in` (opacity + scale 0.97→1, fast/ease-out; pure-opacity tooltips use `animate-fade-in`). Out: `animate-float-out` (opacity only, instant/ease-in). **Exit is always faster than enter, and never scales** (a scaling exit reads as "sucked away" — paper fades in place) | `components/ui/dropdown-menu.tsx`               |
| Heavy overlay (modal / confirm)             | Every modal, from the shared `.modal-scrim` / `.modal-panel` (2026-10-04): scrim fades in; panel fades in + rises 8px + scale 0.96→1 on `--motion-enter` / `--motion-ease-out` (entrance borrowed from Fluid Functionalism's chat-message). Out: fade only on `--motion-exit` / `--motion-ease-in` — a dismissal does not replay the entrance. Radix dialogs animate by `data-state`; hand-built dialogs have the entrance only. Call sites add no `animate-*` classes | `styles/globals.css`, `__tests__/modalSurfaceContract.test.ts` |
| Expand / collapse                           | base/ease-move, grid `0fr↔1fr` height + opacity                                                                                                                                                                                                                                              | `features/cc-agent/sidebar/SectionCollapse.tsx` |
| List reorder                                | FLIP, transform translation                                                                                                                                                                                                                                                                  | `components/ui/toast/ToastContainer.tsx`        |
| Press                                       | Shared Desktop Button / ChromeIconButton / SidebarIconButton: paint-only 1px inset, instant/ease-out, stable text and hitbox (§4). Legacy frames retain their existing `active:scale-[0.98]` until separately migrated. Registered shapes follow §5; a button tag does not authorize scaling a contained data mark or its data mapping. | `components/ui/button.css` |
| Done                                        | registered completion overshoot (`status-done-pop`); chart response has its own narrow registration below                                                                                                                                                                                                                                  | `globals.css`                                   |
| Running                                     | Opacity breathing; must sit on an HTML wrapper (`docs/dev-rules/engineering-conventions.md` §7)                                                                                                                                                                                              | `session-breathing`                             |
| Loading spinner                             | `animate-spinner` (`--motion-spinner-cycle`, linear full turn); HTML wrapper only, static under reduced motion                                                                                                                                                                               | `tailwind.config.ts`                            |
| Hover / state colors                        | `transition-colors`, ≤ fast (150ms)                                                                                                                                                                                                                                                          | App-wide status quo                             |
| Menu row hover (shared dropdown panels)     | One layer glides between rows: `transform` + `opacity` on `--motion-instant` / `--motion-ease-out` (fade-out `--motion-ease-in`); row weight 400 → 500 and icon stroke 1.5 → 2 on `--motion-instant`; no slide under reduced motion (§4 Select & Dropdown) | `components/ui/dropdown-menu-highlight.ts` |
| Container transform (chip grows into panel) | 220ms — see the dedicated category below (explicit exception)                                                                                                                                                                                                                                | Composer permission/model selectors             |

_Reference-implementation paths in this table are relative to `apps/desktop/src/renderer/`._

#### Red lines (performance & restraint)

- **Persistent/looping animation may only touch `transform` / `opacity` on HTML elements** (compositor-only; `docs/dev-rules/engineering-conventions.md` §7 applies in full; nothing animates on SVG).
- Non-compositor properties (height/grid …) are allowed only in **one-shot transient animations** (user-triggered, with a definite end) — never persistent.
- Every new `@keyframes` / `animate-*` class must be registered in the `prefers-reduced-motion` whitelist in `globals.css` (the global `* { transition: none }` does not catch keyframes).
- Real-time direct-manipulation interactions (resizer drag, drag-follow) get **no easing** — following the hand IS the feedback.
- Forbidden: pointless displacement, unregistered bouncing, parallax, looping decoration, `transition-all`, and typewriter per-character animation on streamed text (streaming already is the motion). Interactions stay fast and direct. (Per-**word** opacity fade-in on streamed text is **not** the typewriter — see the sanctioned stream-word-fade class below: the word is fully laid out and only its opacity ramps; ruled distinct on 2026-08-07.)
- **Cadenced running shimmer (2026-08-07)**: the running status bar's breathing (`status-bar-shimmer`) is **event-driven, not an infinite loop** — one 1.5s dip (1 → 0.45 → 1, `steps(18)`) plays per real sign of progress (status text change / token count advance; re-triggered via keyed remount in `RunningStatusBar`, back-to-back plays merge through an animation-end pending flag). Silence (long thinking, tool wait) holds steady full opacity. Semantics: _breathing = producing_, not _heartbeat = alive_. New loading/working indicators should prefer this cadenced pattern over a new infinite loop.

#### Registered response: Usage History chart emphasis (2026-09-08)

Only the two registered chart members inside Usage History may enlarge their non-hit-testing visible layer on hover, keyboard focus or selection. Enter uses `--motion-base` and the component-scoped `--usage-mark-ease`; leave uses `--motion-fast` / `--motion-ease-out`. The local curve has one small overshoot; no looping, replay on unrelated rerenders, or whole-chart motion. Selection holds the enlarged state after pointer leave. The bounded width/height transition is a one-shot non-compositor exception already allowed by the red lines; the exact local geometry/curve is specified in [usage-history-charts.md](./usage-history-charts.md). Corners remain 2px, bar height/baseline, categorical color tokens and heatmap intensity stay fixed, and targets do not grow or overlap. The token-chart-only selection fade follows the component entry; the heatmap selection outline and recent-week bar emphasis follow the latest component ruling, while keyboard focus retains its separate indicator. Reduced motion removes the transition while retaining immediate, visible focus/selection feedback. No other component may borrow this response.

#### Exception category: container transform (chip lifts off and grows)

- The second sanctioned motion class: see [container-transform.md](./container-transform.md); this category's parameters and composer toolbar tiers live there.

#### Other sanctioned motion classes

- **Quota-reset confetti** — the third sanctioned motion class (approved 2026-07-23), **only** for the status-bar usage chip’s full-quota reveal (updated by user decision, 2026-09-12):
  - **Definition**: the first observation of 100% remaining quota throws confetti once from the full window segment, including the first visit. Deduplicate by provider across task switches and component remounts. After that first burst, the quota must drop below 100% and return to 100% before another burst. Remaining at 100% never replays, even across scheduled cycles. Reset deadlines do not participate in this decision; official extra resets follow the same rule. Snapshot update timestamps only reject stale task data. The percentage roll keeps its own reset detection.
  - **Form** (shared celebration component, approved 2026-11-09): one small upward fan from the full segment center. Use the same `canvas-confetti` engine as Star, adding paper wobble, tilt and continuous fading while keeping the effect local to the footer. No stagger, loop or persistent particles.
  - **Small preset**: 18 particles, angle 90, spread 80, startVelocity 5.5, decay 0.92, gravity 0.35, ticks 105 (about 1.75s), scalar 0.45. Resolve the original four status tokens (done, awaiting, warning-accent, error) from the active theme to hex for the canvas library. The quota preset supersedes the earlier DOM-only, constant-horizontal-speed and end-only-fade implementation constraints; it keeps the modest scale and original palette. Skip reduced motion, lazy-load, clean up after completion or unmount, and retain the quota layer at 9999.
  - **Scope boundary**: quota reset and the explicitly approved GitHub Star confirmation below only. Task completion and send success stay on the §14.4 baseline. Both use `components/ui/ConfettiBurst.tsx`; `QuotaResetConfetti.tsx` remains the anchor adapter. Existing full-quota detection and provider deduplication remain unchanged.
- **GitHub Star confirmation (user-approved 2026-11-09)** — after the GitHub API confirms the user's Star, use `canvas-confetti` 1.9.4 through the shared celebration component with the Star preset: 160 particles, spread 360, startVelocity 30, gravity 1.6, ticks 140. Capture the Star activation point in viewport CSS pixels and use it as the burst origin after success; keyboard activation uses the button center. Normalize against the actual canvas when firing, clamping if the window has resized; cursor movement or the success layout change must not move the origin. Keep the library's default colors, size, wobble, tilt, velocity decay and continuous fade; this explicit celebration is exempt from the quota-specific particle/color/DOM-animation limits. Render once on a full-window, pointer-transparent canvas above the Toast; load lazily, skip under reduced motion, remove on completion or dismissal. Use a dedicated main-thread instance without adding a blob-worker CSP exception. Quota reset shares the engine with its separate small preset above. Ordinary success notifications, failed writes and opening GitHub in the browser do not celebrate.
- **Plugin selection annotation (2026-11-07)** — `GhostSummonCard` records only the user's explicit plugin choice, with a static identity ring and “selected” label. Historical mention directives remain quiet pills. Autonomous plugin calls never add or upgrade a label on the user's message, on either Desktop or Mobile. Mobile keeps its existing companion work-log header; its activity is gated by actual pending calls. Execution progress belongs to the existing work-log tool row and settles when its result arrives, independently of the assistant's remaining turn. The former whole-turn seal spin/closing/success choreography is retired; no context rules or new settings are introduced.

- **Stream-word fade(流式正文分段淡入)** — the fifth sanctioned motion class (approved 2026-08-07, ordinary-chat timing aligned 2026-08-25), **only** for streaming assistant prose in the chat message flow:
  - **Definition**: during streaming, each newly-arrived text **word** and each inline-code atom fades in over `--motion-fast` (150ms, opacity only) instead of popping in — content appears to *surface*, not *type*. This is explicitly **not** the forbidden per-character typewriter: each segment is fully rendered and positioned from its first frame; only opacity ramps. CJK is segmented per word via `Intl.Segmenter`; an inline-code chip keeps its internal structure and fades as one indivisible segment.
  - **Architecture red lines**: CSS owns the form, JS owns only the timing — `rehypeStreamWordFade` wraps words and inline-code atoms in `span.stream-word` and writes `--wf-delay`. Ordinary chat uses one **message-level continuous timeline** across render batches and Markdown chunks: new segments normally start `16ms` apart; once queued transparent wait reaches `96ms`, the step compresses to `4ms`; no segment may remain transparent for more than `160ms`. This keeps a burst from flashing in all at once without allowing a long batch to leave a visible transparent hole. Inline-code atoms and list markers borrow the corresponding prose segment's key and delay, so semantic atoms cannot overtake their text. Segments are keyed by type + stable content matching (same-position matches, text-prefix continuation, and bounded backward matching), not by document index. Render computes a candidate state; only a committed DOM render may publish it from a layout effect. Each segment keeps an absolute start time / remaining delay across re-parse and remount, so already-seen content never replays. The animation itself is a pure-opacity one-shot keyframe in `globals.css` (compositor-only). The final (non-streaming) render carries **zero** wrapper spans — the plugin only mounts while `isStreaming`.
  - **Degradation**: `prefers-reduced-motion` short-circuits in JS (plugin not mounted, no spans in DOM) *and* the CSS reduce block strips the animation — double coverage, and the CSS side is safe because `.stream-word` has no own opacity declaration to get stuck on.
  - **Scope boundary**: streaming chat prose only. Inline `code` participates as one atomic segment; fenced `pre` code blocks and KaTeX subtrees are skipped. Must not be applied to static content, titles, toasts, or any non-streamed text. Implementation: `apps/desktop/src/renderer/components/chat/rehypeStreamWordFade.ts` + `.stream-word` in `globals.css`; tests: `rehypeStreamWordFade.test.ts`.
- **Session-loading wordmark sheen(会话加载字标扫光)** — the sixth sanctioned motion class (approved 2026-08-10), **only** for Desktop `BrandLoadingMark` while `MessageStream` defers its message tree during a session switch:
  - **Definition**: the active theme's official Light/Dark Cindy wordmark sits centered in the empty message viewport at 35% opacity; after a 200ms delayed-reveal threshold, one narrow neutral highlight traverses the wordmark shape. The PNG alpha channel is the mask, so motion is confined to the glyphs and never paints a panel/background. This is functional loading feedback for a measured long switch, not a decorative brand loop: ordinary sessions complete before the reveal threshold and never show it; the mark unmounts immediately when the message tree mounts.
  - **Parameters / performance**: highlight cycle 1.6s, `cubic-bezier(0.4, 0, 0.2, 1)`, HTML pseudo-element `transform: translateX(-120% → 350%)` only (compositor-only). The neutral gradient is the narrow §2 exception registered under “Gradient System”; it may use only `transparent` and `--text-primary`, never brand red or a component-authored chromatic value. `prefers-reduced-motion` removes both the reveal and sheen animations and shows a static wordmark; `[data-app-hidden='true']` pauses the infinite sheen via `animation-play-state` while the window is hidden.
  - **Scope boundary**: session-switch deferred-loading overlay only. No reuse for startup, streaming, tool execution, message generation, dialogs, cards, sidebars, empty states, or static branding. The standard `animate-spinner` remains the default loader everywhere else. Implementation: `components/branding/BrandLoadingMark.tsx`, `MessageStream.tsx`, and `.brand-loading-mark*` in `globals.css`.
- **Mobile new-task morph(移动端新建按钮形变)** — the seventh sanctioned motion class: see [手机设计指南 §9](../../apps/mobile/docs/mobile-design-guide.md#9-从根规范迁入的手机规则).
- **Bot Market detail entrance(Bot Market 详情入场错峰)** — the eighth sanctioned motion class (approved 2026-10-16), **only** for the Bot Market detail page (`BotMarketDialog` / `BotMarketModules`):
  - **Definition**: when a teammate's detail opens, its segments — identity block, capability strip, then each module that has data (skills, knowledge and memory, work tools, routines) — fade in and rise 6px one after another, so the page reads as content arriving in reading order. This is a one-shot entrance for the opened detail; it does not replay on scroll, expand/collapse, or data refresh.
  - **Parameters**: each segment `--motion-base` / `--motion-ease-out`, opacity 0→1 and `translateY(6px→0)`; adjacent segments start **30ms** apart via `--rise-index` (`animation-delay: calc(var(--rise-index) * 30ms)`); at most **6** segments (the index is clamped at 5). `transform` / `opacity` only. This is an explicit exception to the rule that stagger is limited to the composer-container rows (≤20ms/row) and must not leak elsewhere.
  - **Degradation**: `.bot-market-rise` is in the `prefers-reduced-motion` whitelist in `globals.css`; reduced motion lands on the final frame directly.
  - **Scope boundary**: this page only. The same detail page's other motion uses existing tiers: the header identity and compact action fade in on `--motion-fast` / `--motion-ease-out` and out on `--motion-instant` / `--motion-ease-in` (a state-driven transition, not a keyframe); placeholders appear only after 300ms of loading, static, with no shimmer. Implementation: `.bot-market-rise` in `globals.css`.
- **Retired: mobile-download QR brand edge** — a rotating app-icon edge on the `MobileDownloadDialog` QR card was briefly registered here as a fourth (persistent) motion class on 2026-07-25 and **removed the same day** at the user's request: read as a strange ring turning behind the code. There is **no sanctioned persistent decorative motion** — the red lines above hold without exception. The card is now a bare QR (no edge, no border, no shadow, no tilt); its only motion is the linked ↔ onboarding size tween. Do not re-add. Contract test: `mobileDownloadDialog.test.tsx` → `keeps the QR card flat with no brand edge`.

### 14.5 聊天正文的可点性信号(Clickability in message bodies)

正文已移至 [message-link-clickability.md](./message-link-clickability.md)，规范效力不变。

### 14.6 Icon-only Controls and Tooltips

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

## 15. CINDY Skin Family(品牌化可选 family)

> This section records the CINDY skin family; it does **not** rewrite the §1–7 default-skin rules. Values were finalized from design-stage working files (`skin-docs/10-specs/` desktop, `skin-docs/30-mobile/` mobile errata — **not in this repo**, same status as the §16 login working files) plus the user's final sign-off of 2026-07-18. Zero discretion at implementation time: within the repo, the authoritative encodings are the DTCG sources in `packages/design-tokens` (generated into `cindy-light.ts` / `cindy-dark.ts`), `cindyDecisionData.ts`, and the frozen tests — this section is their prose summary.
>
> Subsection numbers are **stable identifiers** (referenced by §16, code comments, frozen tests, and other documents; 15.9 was never assigned) — do not renumber. Decision history for this section is archived in [`design-decision-log.md`](./design-decision-log.md).

### 15.1 Palette (extracted from Figma text nodes)

| Semantic                       | Light                                                                                                              | Dark                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Brand red                      | `#DF0C27`                                                                                                          | `#DF0C27`                                   |
| Deep brand red (hover/pressed) | `#A61629`                                                                                                          | `#A61629`                                   |
| Background                     | `#F2F2ED` (warm ivory — 2026-08 revision, see 15.16)                                                               | `#181818` (pure neutral — 2026-08 revision) |
| Card / input                   | `#FDFDF8`                                                                                                          | `#1F1F1F`                                   |
| Border                         | black ink 8% (desktop, since 2026-10-22 — see 15.16; mobile owns its own ramp since 2026-09-26 — see 15.13)       | white ink 10%                               |
| Secondary info                 | black ink 56% (2026-10-22 ink ladder, supersedes `#888883` and U2; full ladder in 15.16)                           | white ink 55%                               |
| Body text                      | black ink 88% (emphasis 95%)                                                                                       | white ink 82% (emphasis 100%)               |
| Pure white                     | `#FFFFFF`                                                                                                          | `#FFFFFF`                                   |

### 15.2 Red-Boundary Test Maps(品牌红边界)

- Current authority (post-E1D, see 15.10): `NEUTRAL_PRIMARY_EXPECTED_BY_ID` / `NEUTRAL_PRIMARY_FOREGROUND_BY_ID` (exact neutral values for primary actions) + `RED_EXCEPTION_ALLOWED_IDS` (the complete set of tokens allowed to contain red), all in `apps/desktop/src/renderer/themes/__tests__/cindyDecisionData.ts`.
- One-way ban: any token outside `RED_EXCEPTION_ALLOWED_IDS` containing `#DF0C27` / `#A61629` fails the suite.
- The pre-E1D `BRAND_RED_*` maps are retained in `cindyDecisionData.ts` only for D2T migration and are marked for deletion; their contents are archived in the decision log — do not treat them as current rules.

### 15.3 Interpolation Table (sRGB per-channel `round(A+(B-A)*t)`)

See the skin decision table §2 (design-stage working file, not in repo). The Light/Dark 20/40/65/75% shades were frozen with exact values in unit tests (`#EFEFEF/#F1F1F1/#F4F4F4/#F5F5F5`, `#2B2929/#2D2B2B/#2F2D2D/#2F2D2D`). **Superseded 2026-08**: the interpolation shades were replaced by the ladder model of the color-ramp revision (rules in 15.16, decision record `token-decision-table.md` §9); the current frozen values live in `cindyDecisionData.ts`.

### 15.4 Cross-Theme Exemptions (not covered by CINDY overrides)

- Semantic colors: `warning-accent` `#EA6B17` (finalized 2026-07-17, replaces `#FF6600`) / `annotation-accent` `#FF3B30` (image-annotation burn-in ink — exempt, do not change) / `status-bar-accent` (alias of warning orange, auto-follows).
- The status four (finalized 2026-07-17; same values both modes, all 9 themes follow with no override): running `#EA6B17` / awaiting `#19D2C1` / error (status family) `#D91F37` / done `#2AAE5B`; warning foreground `warning-fg` `#F3A115`, which the Toast warning icon also uses since the 2026-07-17 Toast finalization (§2; the former Toast amber `#F59E0B` is retired).
- `sidebar-draft-indicator` is a narrow semantic exception for the 8px pencil shown on non-selected sidebar rows with a composer draft or paused send queue. Light uses deep teal `#0B726B`; dark aliases `card-status-awaiting` (`#19D2C1`). Both must remain ≥3:1 against ordinary and hover CINDY sidebar surfaces after the translucent sidebar is composited over black and white wallpaper extremes (worst case at registration: `3.17:1` light / `5.65:1` dark). Rail tiles therefore use `--sidebar-item-hover`, never the inverse upgrade-button-only `--update-btn-hover`. Do not reuse the indicator token for generic awaiting states or add an active-row variant; the pencil is intentionally hidden while that task is selected.
- `focus-ring` `#417CDD` (blue — never red); diff red/green; modal scrim/shadows; `overlay-lightbox`; the four Toast colors.
- `destructive` / `search-match-bg` stay outside HSL_FORMAT_IDS coverage.
- **hljs syntax colors** (light = highlight.js `github.css`; dark = globals.css `.dark .hljs-*` mirroring github-dark) — dual-threshold ruling (2026-07-17): syntax colors ≥3:1, body text ≥4.5:1. The hljs palettes were designed for GitHub's default canvases; CINDY's code-block canvas (`surface-elevated`, since 2026-08 `#FDFDF8`/`#1F1F1F`; code block fill `perm-code-bg` `#FAFAF5`/`#191919`) sits close to default's, so marginal shortfalls are inherited, not CINDY-introduced (default is equally affected). Light: all syntax colors ≥3 — no remediation, itemized as exemptions. Dark: `[data-theme="cindy-dark"]` overrides `.hljs-section` to `#2573ec` (3.00:1 on the pre-2026-08 canvas; 3.72:1 after the darker revision — margins only improved, override retained) and sets `.hljs-punctuation` / `.hljs-tag` explicitly to `#c9d1d9` (defensive). Guarded by `cindyCodeBlockContrast.test.ts` (≥2 baseline + text ≥4.5). Full derivation: decision log.
- model-budget spectrum bar / GhostTool shimmer: explicitly exempt (neutral shimmer, theme-invariant).

### 15.5 U2 Explicit Exception — retired 2026-10-22

- **Retired by user ruling (2026-10-22).** CINDY text tiers are translucent ink (§2, §15.16), so the dark secondary `#6F6F6F` "stay true to Figma" exemption and the light `#888883` secondary no longer apply on Desktop. The reverse-frozen test in `cindyThemes.test.ts` group ⑦ is re-baselined to the ink ladder under this ruling; changing a tier's alpha still requires a fresh user ruling.
- Mobile keeps its own secondary values (`#4D4D4A` / `#BDBDBD`, §15.13) until its own phase.
- History (U2 2026-07-16, light re-tunes 2026-07-20 / 2026-08-13, mobile scope 2026-09-26) is in [`design-decision-log.md`](./design-decision-log.md).

### 15.6 HSL Format Contract

The 42 `HSL_FORMAT_IDS` must be HSL triplets (`h s% l%`, `h∈[0,360)`, grays use `hue=0`, 1 decimal place); every other token is hex/rgba. Translucent values append the same alpha as their rgba twin (`h s% l% / a`, e.g. the text tiers). Tailwind opacity modifiers on these slots (`border-border/40`) compile through `color-mix` (`tailwind.config.ts` `hslVar`), so a slot that carries its own alpha stays valid; never hand-write `hsl(var(--x) / a)` for a slot that may be translucent. Round-trip HSL→RGB channel error ≤1. Nothing outside `HSL_FORMAT_IDS` may be written as an HSL triplet.

### 15.7 Brand Assets (icon + logo)

The new-session brand block is fixed at a 50×50px square icon + 110×37.5px horizontal logo with a 9px gap (2026-07 design). `ThemeBrandLockup` is the sole renderer. Themes swap artwork only via `theme.brand.icon/logo` — never rescale the finalized lockup; local images are cropped at load time to their alpha visible bounds (source files untouched). cindy-light uses the black-text logo (`cindy-logo-light.png`), cindy-dark the white-text one (`cindy-logo-dark.png`).

The brand block reads only `brand.icon/logo` — no compatibility with the legacy top-level `logo`, `logoScale`, or the interim `brand.mark/wordmark`; the structures differ semantically, never guess a mapping. Settings → Appearance keeps only three light entries (local theme copy, open folder, refresh) — no brand preview or asset picker. Exported standard JSON ships self-describing example paths (`icon-square-50x50px.png` / `logo-horizontal-110x37.5px.png`) so the config file documents both purpose and final display area; sources may export 2x/3x at the same aspect ratio. No extra README, no JSONC.

> The logo-asset red `#F70121` is intrinsic to the official brand artwork (the WORD MARK arrow glyph); it coexists with — and differs from — UI brand red `#DF0C27`. Logos are image assets outside the token system; keep the original color. Do not "correct" it to `#DF0C27`.

The splash wordmark is a separate asset pair (`assets/splash/wordmark.png`, white text, for DARK / `wordmark-light.png`, dark text, for LIGHT): both 459×156 (@2x) with a 229.5×78 render frame (its exact 2x full frame), and **neither carries a drop shadow** — `SplashScreen.test.tsx` asserts the absence. (Asset-size and shadow history: decision log.)

**Reserved artwork namespace — Bot avatar sentinels (Desktop registered 2026-08-17).**

- **Where**: the Bot identity mark only — `features/bots/BotAvatar.tsx`. A Bot's `avatar` field holds either one grapheme or a reserved `cindy://avatar/…` sentinel (`botAvatarIdentity.ts`). The three user-selected Cindy, Dash and LiZi preset portraits share this component and its round crop. Custom graphemes and the initial-letter fallback render over the §10 `--bot-avatar-*-bg` hue.
- **Forward compatibility**: a sentinel this build cannot resolve (artwork added by a newer client, or shipped by a future release) renders the neutral initial — never a broken `<img>` and never the raw `cindy://avatar/…` string as text. Contract test: `botAvatar.test.tsx`. Unknown sentinels retain this fallback contract; additional portrait sets require artwork-surface approval.

**Sanctioned brand surface — session-switch deferred-loading overlay (Desktop approved 2026-08-10).**

- **Where**: `BrandLoadingMark` mounted by `MessageStream` only while a session switch has committed the shell but deferred the message tree. It is centered as a pointer-transparent overlay in the empty message viewport and is eligible to become visible only after the 200ms delayed-reveal threshold. The live message tree and composer never carry the mark; once messages mount, the overlay unmounts immediately.
- **Asset / theme boundary**: use only the active theme's official Light/Dark horizontal wordmark returned by `useBrandLogo`; source aspect ratio is preserved and no custom-theme asset mapping beyond that existing hook is introduced. Brand red is intrinsic to the official artwork per the asset rule above, not authored by this component.
- **Motion / treatment**: 35% static base wordmark plus the §14.4 session-loading sheen. No character artwork, app icon, shadow, border, plate, enlarged hero composition, slogan, or additional brand copy. The single neutral mask-clipped sheen is the narrow gradient exception registered in §2; reduced motion lands on the static wordmark.
- **Scope boundary**: this approval identifies an in-progress session switch only. It is not precedent for branding streaming, running tasks, tools, cards, dialogs, sidebars, empty states, or other working-UI surfaces; those remain neutral and use the standard spinner/cadenced patterns.

**Sanctioned brand surface — conversation-share export footer (Desktop approved 2026-08-06; Mobile approved 2026-08-08).**

- **Where**: the footer of conversation-share PNG images generated by Desktop `renderer/lib/shareConversationImage.ts` or Mobile `src/session/conversationShareWebViewHtml.ts` / `src/session/ConversationShareSvg.tsx` only. The live conversation, selection mode, message stream, composer, and other working-UI surfaces remain neutral and must not display the character artwork.
- **Lockup**: Desktop uses one static 40×40px product-approved Cindy character crop (8px radius), followed by the active theme's 24px-high wordmark with an 8px gap. Mobile uses the same crop at 22×22px (6px radius), followed by an 18px-high wordmark with a 6px gap, keeping the narrower export understated. Do not append a website or regional host. The character keeps the source asset's original color and opacity without component-authored filtering.
- **Constraints**: no animation, shadow, decorative background, additional brand color, enlarged hero treatment, or alternate character composition. This approval identifies the source of an exported Cindy conversation; it is not precedent for adding mascots to cards, dialogs, tool output, or other share-adjacent UI.
- **Theme boundary**: Light and Dark use their matching wordmark assets. The same static character crop may be used in both modes because it is an exported brand asset, not a UI color surface.

**Sanctioned brand surface — mobile download dialog (approved 2026-07-25).**

- **Where**: `components/sidebar/MobileDownloadDialog.tsx` only, and only the dialog header icon (64px `resources/icon.png`). This is a promotion surface for the mobile app, so showing the app's own icon is identification, not decoration.
- **Constraints**: the color comes only from the official asset — no component-authored gradient or brand hex. The QR card itself carries **no brand edge, no border, no shadow and no pointer 3D tilt**: a 2px edge made of the scaled app icon was tried on 2026-07-25 and removed the same day (it read as a strange ring rotating behind the code — see §14.4). Do not re-add it in any form, static or animated.
- **Scope boundary**: this dialog only. Other working-UI surfaces keep the neutral treatment; a new brand surface needs a new entry here. Contract test: `mobileDownloadDialog.test.tsx` → `keeps the QR card flat with no brand edge`.
- **Reference renders** (light theme, zh-CN, @2x — `assets/mobile-download-dialog/`): [local mode](assets/mobile-download-dialog/guest-local.webp) (QR only — no account, so no permission card) · [signed in, no linked mobile](assets/mobile-download-dialog/onboarding.webp) (228px QR + permission card) · [signed in, mobile linked](assets/mobile-download-dialog/linked.webp) (132px QR + device list). Re-shoot these when the dialog's layout changes. **Stale as of 2026-07-25**: all three still show the retired brand edge around the QR — read them for layout only, not for the card's treatment.

**Sanctioned brand surface — Alipay payment QR (approved 2026-07-29).**

- **Where**: `features/billing/BillingCheckoutDialog.tsx` and `PlanChangeDialog.tsx` (`PlanChangeStatusDialog`) only. The 40px white center plate may show the 32px official `resources/icon.png` only after a QR payment payload successfully encodes at H error correction.
- **Payload / rollout**: this surface accepts only the server-issued Alipay short link. Desktop rollout is gated on the server being fully deployed and all pre-deployment QR actions having exceeded their 5-minute TTL; do not add a legacy long-Scheme or lower-error-correction fallback.
- **Constraints**: the white QR background is a scanner-contrast requirement, not a general brand panel. Do not add a border, edge, shadow, motion or other decoration to the code.
- **Scope boundary**: this approval covers the current Alipay QR payment paths only. `BillingPaymentAction` currently does not carry a provider; any future non-Alipay `QR_CODE` channel must first add provider-aware rendering rather than inheriting this mark by default.

**Sanctioned brand surface — Computer Use cursor (approved 2026-08-04).**

- **Where**: the optional agent cursor configured by `apps/desktop/src/main/mcp-integrations/computer.ts` while Cindy Computer Use actions are running. Its arrow color and bloom use Brand red `#DF0C27`; the driver-required gradient transitions from Brand red to Deep brand red `#A61629`.
- **Why the values are concrete**: the cursor is rendered by the out-of-process `cua-driver`, which cannot consume renderer CSS variables or the active theme registry. The fixed two-color brand palette is therefore identical in Light, Dark, and imported themes.
- **Scope boundary**: this approval identifies Cindy's automated pointer only. It does not authorize brand red for ordinary controls, focus/caret states, buttons, or other working UI. Cursor styling remains optional; a driver capability/policy rejection degrades without blocking Computer Use and is remembered for the current MCP session.

### 15.8 status-badge-fg

- The orange badge (bg `status-bar-accent` `#EA6B17`) has its own foreground token `status-badge-fg`: **default mirrors `accent-pure-cta-fg`** (light white / dark black — zero change for the 9 existing themes); **CINDY overrides light to `#1F1F1F`, dark to `#121212`** (near-black; dark shifted with the 2026-08 ramp — see 15.16), contrast × `#EA6B17` = **5.19:1 / 5.90:1 ≥ 4.5** (user-approved; darken toward `#000000` if a future orange fails 4.5).
- Consumers: `ContactsListPane:150` uses `status-badge-fg`; the `surface-on-card` consumers that sat on red CTAs (`RolePillDropdown:543/544`, `SkillhubDetailView:504`) moved to `accent-pure-cta-fg` (white); `surface-on-card` stays neutral-inverse (Fast toggle thumb). Registered in `cindyDecisionData` (a D2-phase addition).

### 15.10 Red-System Boundary & Neutral CTAs — current state(E1D 红色边界)

- Ordinary primary actions never use brand red — they are neutral-inverse. **Neutral button four states**: light bg `#3C3F43` / text `#FCFCFC`, hover `#303337`, pressed `#27292D`; dark bg `#EEEEEE` / text `#151515` (2026-08: inverse dark text shifted with the darker ramp, was `#252222`), hover `#DFDFDF`, pressed `#D2D2D2` (WCAG 10.32/15.74:1). Hover and pressed are computed from the base by §4 Filled button states.
- Red is confined to brand display / splash surfaces (§15.7, §15.13) and semantic exceptions: `destructive`/delete, `error-*`, warning, diff red, status dots, the explicit Mobile Beta-channel state badge (`betaChannelBadgeBackground/Foreground`, user decision 2026-08-25), the Windows taskbar attention badge (§2), the quota critical fill (§2, §10), the Mobile thread new-reply divider (`threadUnreadDivider`, line and localized “New” label, §2), the Computer Use automated cursor (§15.7) and the Mobile `activeGlyph` (§15.13) — plus the login brand accent via `--login-brand-accent` (§16). Red members of palettes that identify rather than signal stay registered with their palette and carry no red semantics: file-type badges and Bot avatar hues (§2, §10), task tags, screenshot annotation ink (§2), chart series and tier scales, and code syntax highlighting. This list is the complete red whitelist; other sections only refer to it. The Desktop sidebar's Beta label is ordinary version text. The older `brand-login-*` tokens were retired with the wave4 white-canvas login and survive only as whitelist strings in `cindyDecisionData.ts` (harmless — the whitelist permits, it does not require).
- **send-btn family**: `send-btn-bg/-icon/-disabled-bg/-disabled-icon` — CINDY overrides these to the neutral fill + disabled grays (light `#444242`/`#585555` unchanged; dark shifted 2026-08 to `#323232`/`#464646`); these sit in `cindyDecisionData` REQUIRED_IDS + CINDY_EXPECTED, guarded by assertion ③. `-hover-bg/-pressed-bg` are computed from `send-btn-bg` in every theme by §4 Filled button states. SendButton does not consume `-disabled-bg/-icon`: a disabled send keeps the normal `send-btn-bg/-icon` at 40% opacity, and the two disabled tokens stay registered for compatibility.
- **Sidebar color hierarchy** (same set for light/dark):
  - Body (session titles) = `text-foreground` (= `text-primary`: black ink 88% / white ink 82%, §15.16).
  - Secondary gray (timestamps / meta / group labels) = secondary ink (black 56% / white 55%, same as `text-secondary`), via CINDY overrides `sidebar-muted` (HSL with alpha) and `cmd-palette-item-meta`; leading icons at rest use `sidebar-action-icon` = tertiary ink (black 44% / white 40%). Since 2026-10-22 these follow the ink ladder (§15.16) instead of `#888883` / `#6F6F6F`.
  - Selected pill uses a softer surface: `sidebar-item-active` light `hsl(214.3 6% 99%)` / dark `#3C3F43`, foreground `sidebar-item-active-foreground` light `#292A2C` / dark `#EEEEEE`, border transparent. CTA colors stay independent. **Any foreground sitting on `bg-sidebar-item-active` must use `text-sidebar-item-active-foreground` — `text-foreground` is forbidden there** (the token defaults to foreground, so non-CINDY themes see zero change).
  - Running-state leading icons (vendor glyph / Puzzle / RadioTower / Clock) = **Thinking Orange `--warning-accent` `#EA6B17`**, breathing via `session-status-breathing`; the selected state stays orange (running outranks the selected foreground), with contrast ≥3:1 against the selected fill in both modes. Mobile `statusAccent` mirrors value and priority. Persistent breathing sits on an HTML wrapper; SVG stays static (engineering conventions §7).
  - Assertions: ③ CINDY_EXPECTED locks the 4 token values; ⑦ adds hierarchy assertions (secondary gray clearly weaker than body; selected-pill foreground ≥4.5 on its fill).
- Test maps: `NEUTRAL_PRIMARY_EXPECTED_BY_ID` / `NEUTRAL_PRIMARY_FOREGROUND_BY_ID` + `RED_EXCEPTION_ALLOWED_IDS` (replacing the pre-E1D `BRAND_RED_*` maps — archived in the decision log). Assertions ⑤/⑦/⑧ enforce exact neutrals, the red whitelist, neutral contrast, and falsifiability.
- Backlog: the five R2 §4.3 Project_List deviations stay deferred (see the decision log backlog).

### 15.11 Input Caret (`--caret-accent`)

- Every editable input surface takes its caret color from the `--caret-accent` token. `globals.css` owns this globally (native `caret-color` plus the ProseMirror pseudo-caret); components MUST NOT set their own caret color.
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

- Brand red `#DF0C27` only for brand display / splash, destructive actions, and the list active glyph (dark uses `#A61629` for the glyph). Running / thinking states use Thinking Orange, never red (§15.14); the complete red whitelist is §15.10.
- Ordinary CTAs, FABs, send buttons, and confirm-style primaries are neutral-inverse: desktop light bg `#3C3F43` / text `#FCFCFC`, dark bg `#EEEEEE` / text `#151515` (2026-08); mobile light `#0F0F0F` / `#FFFFFF`, dark `#EDEDED` / `#121212` (2026-09-26, see Cross-platform color semantics). Never brand-red these.
- The red whitelist does not include carets, focus rings, ordinary buttons, or ordinary selected backgrounds. A new red consumer must document its semantics and enter the token/test whitelist first; no component-level hardcoding.

#### Caret & focus

- All input carets (`cursorColor` / `selectionColor`) are blue `#417CDD`, equal to `permAutoAccent` / desktop `caret-accent`; same value both modes.
- Focus ring, Auto Approval, and info blue share the `#417CDD` family. Figma's older blue `#426BF2` is not adopted.
- Red-family carets are forbidden.

#### Cross-platform color semantics (mobile owns its ramp — ruling 2026-09-26)

- Mobile shares Cindy's brand identity and semantic roles with desktop — the same meanings for background, card, body, secondary / tertiary text, borders, neutral-inverse CTA, brand red, status colors, caret and focus blue — but **owns its own ramp values, contrast and warmth** (user ruling 2026-09-25: mobile design may decouple from desktop and should be higher contrast; values finalized 2026-09-26). Do not copy desktop hex values into mobile, and do not sync them back to desktop; semantics stay mirrored, values do not. This supersedes the 2026-07-18 "isomorphism" baseline and the 2026-08 pending mobile follow-up.
- **Mobile light = bright ivory**: page `#F9F9F6` (user-specified: brighter than desktop `#F2F2ED`, warmth B = R−3 — a lighter ivory than desktop's R−5), card / list row / popover `#FFFFFC`, chip / selected `#EAEAE6`, border `#CCCCC8`. Body text stays neutral `#0F0F0F`; secondary `#4D4D4A`, tertiary `#686864`.
- **Consequence of the brighter page — mobile light cards separate by hairline, not by fill.** Against `#F9F9F6` the near-white ceiling leaves only a 1.05 card lift (desktop 1.12, iOS grouped background 1.12). Every new raised mobile-light surface (card, list row, popover, input container) therefore **must carry the 1px `border`**; do not rely on the `surfaceElevated` fill alone. Surfaces that must read as recessed (chip / selected, expanded block, code card) sit **below** the page instead.
- **Mobile dark = pure neutral near-black**: page `#121212`, card `#1E1E1E`, chip `#2A2A2A`, border `#383838`; body `#EDEDED`, secondary `#BDBDBD`, tertiary `#999999`. No warmth.
- **Text tiers are ordered and legible**: body → secondary → tertiary go from strongest to weakest, and all three are ≥ 4.5:1 on every surface they sit on (page, card, chip, code card, sheet action group). This replaces the inverted pre-2026-09 mobile order where secondary (`#8C8E94` / `#6F6F6F`, 2.8 / 2.9:1) was lighter than tertiary; the U2 exception (15.5) no longer applies to mobile. Guarded by `themeTokens.test.ts` and the frozen `theme-colors-snapshot.json`.
- **Mobile text colors are five neutral tiers** (ruling 2026-09-27): body, secondary, tertiary, placeholder, neutral-inverse (`ctaText`). `textPlaceholder` (light `#858581` / dark `#757575`, ≥ 3:1 on page, card and chip) is a registered exception to the 4.5:1 tier rule and may be used only for input placeholders and the voice-listening prompt that mirrors them. Sheet action labels use `textPrimary` (the former `sheetActionText` alias was removed); text on a `textPrimary` / `cta` fill uses `ctaText`, never `surface`; the shared-task danger button label uses `#FFFFFF` / `#121212`. The login skin (§16) keeps its own registered grays for now.
- **Neutral-inverse CTA on mobile**: light `#0F0F0F` / `#FFFFFF`, dark `#EDEDED` / `#121212` (19.17 / 16.00:1).
- The appearance mode is a user setting (Settings → Appearance: follow system / light / dark, default follow system; only an explicit light / dark choice is persisted). It forces native system surfaces to the same mode; the first-launch light login gate (§16.5) still applies inside the login stage.
- Values live only in `apps/mobile/src/theme/tokens.ts`; the proposal record and before / after comparison are in Design Lab (`colors` study, platform iPhone / Android). Login skin tokens (§16), brand splash, status four, task tags and syntax colors are outside this ramp and keep their own registered values.
- Mobile-only tokens carry only mobile-specific layers or geometry:

| Mobile token          | Light                    | Dark                  | Use                             |
| --------------------- | ------------------------ | --------------------- | ------------------------------- |
| `surfaceListRow`      | `#FFFFFC`                | `#1E1E1E`             | List project/task rows          |
| `surfaceTranslucent`  | `rgba(249,249,246,0.78)` | `rgba(18,18,18,0.78)` | Sticky chrome (page at opacity) |
| `edgeBlurShade`       | `transparent`            | `rgba(0,0,0,0.18)`    | Shade on the single-layer edge blur (composer), so an empty page stays `surface` |
| `edgeBlurShadeLayered`| `transparent`            | `rgba(0,0,0,0.08)`    | Same shade on each of the three header blur layers |
| `surfaceListExpanded` | `#EAEAE6`                | `#121212`             | Expanded list block             |
| `activeGlyph`         | `#DF0C27`                | `#A61629`             | Leading active glyph in lists   |
| `chatCodeSurface`     | `#F1F1EC` (recessed)     | `#1A1A1A`             | Chat / task code card           |
| `chatCodeBorder`      | `#CCCCC8`                | `#383838`             | Chat / task code card border    |
| `inputCaret`          | `#417CDD`                | `#417CDD`             | All input carets                |
| `sheetSurface`        | `rgba(249,249,246,0.96)` | `rgba(28,28,28,0.96)` | Bottom-sheet root               |
| `sheetActionSurface`  | `#FFFFFC`                | `#262626`             | Sheet action group / row        |
| `sheetActionBorder`   | `#CCCCC8`                | `#383838`             | Sheet action group / row border |
| `sheetGrabber`        | `#C2C2BE`                | `#5C5C5C`             | Sheet / composer grabber        |
| `textPlaceholder`     | `#858581`                | `#757575`             | Input placeholder only (≈3.5:1) |

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
- `hardcoded-color-audit` (`scripts/hardcoded-color-audit.mjs`) runs in client-ci as `pnpm check:design-colors` and checks added lines only. It blocks new literal colors in Desktop renderer consumer code; Mobile and other paths are reported, not blocked (Mobile keeps its own blocking token tests). Genuine exceptions (asset-intrinsic or platform-semantic) need a narrow, reasoned entry in `scripts/hardcoded-color-exemptions.json`. Scope, exemption format and rollback: [`design-governance.md` §8](./design-governance.md).
- When a design mock conflicts with existing tokens, list it as "pending ruling" in the spec / PR and request a decision — never self-adjudicate or substitute a near color.
- Shared-component restyles default to variant / prop isolation. Pages, states, and platforms not covered by the mock keep the status quo.

### 15.14 Running / Collaboration Orange (finalized 2026-07-20)

- **Running breathing icons are always Thinking Orange** (`--warning-accent` `#EA6B17`, all themes): VendorIcon, SessionStatusIcon (Puzzle/RadioTower), AutomationSessionGroupItem (Clock); the selected state stays orange — priority: running > selected inverse foreground > rest. Mobile `statusAccent` mirrors value and priority (glyphColor same).
- **Collaboration menu row ON state is orange**: the collaboration item inside the composer「+」menu sits beside Goal and Plan. Its active text + UsersRound icon use `warning-accent`; the row highlight remains the shared menu glide, and the OFF state stays neutral. This is an explicit carve-out from the 2026-07-17 neutral composer-menu rule for the ON state only.
- **SVG persistent-animation red line**: breathing-type persistent animation sits on an HTML wrapper (span); SVG stays static.

### 15.15 Create-Page Content Position + Titlebar Hover Discipline (finalized 2026-07-21)

- **CREATE AGENT content-group vertical position**: constant `max(96px, 28vh) + 46px` from the window top.
  Implementation = route container `pt-[calc(max(96px,28vh)+46px-var(--content-header-h,46px))]`:
  - the 268px cap is dead (a leftover of the Figma frame height — the root cause of content sitting high on large windows); 28% is device-tuned (from 25.5%);
  - `--content-header-h` is broadcast by `ContentHeaderSlot` (inside FeatureSidebarSlotProvider) through a display:contents wrapper (46px rendered / 0px hidden, same source as ContentHeader `h-[46px]`) — content stays pinned at the "header present" position with **zero jump** when selecting a project toggles the header;
  - header visibility has a single decision source = `useContentHeaderHidden` (mac + sidebar expanded + no injected content + no right-panel toggle; continues the 2026-06-11 "hide empty header" ruling);
  - guard: the position formula and its anti-regression assertions are part of the create-page review contract.
- **Hover-token discipline**: `--update-btn-hover` is exclusively the upgrade button's hover (inverse dark CTA) — **forbidden** on ordinary ghost buttons/badges (near-black under CINDY light swallows text and icons; 6 misuses cleaned up 2026-07-21). Correct picks:
  - titlebar-area (ContentHeader) ghost elements → `titlebar-button-hover` (same as the ChromeActions window buttons);
  - general light hover in the content area → `--surface-hover`.

### 15.16 2026-08 Color-Ramp Revision (warm ivory light / neutral near-black dark)

> Numeric source: the DTCG files in `packages/design-tokens` (generated into the Desktop defaults), with the CINDY expectations frozen in `cindyDecisionData.ts`. [`token-decision-table.md`](./token-decision-table.md) §9 is the decision record (full ladders, text tiers, contrast matrix, approval trail), not a numeric source (`design-governance.md` §11). This subsection pins the rules.

- **Light** = warm ivory: page `#F2F2ED`; every surface is warm with **B = R−5**, and the translucent borders and fills inherit that warmth (single warmth constant; one sanctioned ceiling exception — pure white `#FFFFFF` stays for floating planes that need maximum lift above the near-white card, currently `ask-option-list-bg` only). Cards stay near-white (`#FDFDF8`) — card lift ≈9.4%, matching the original spec. Hover/chip tiers sit **below** the page (the white ceiling leaves no room above); the sidebar is its own plane one step darker (`#EEEEE9` at 85% glass opacity).
- **Dark** = pure neutral: page `#181818`, all layers R=G=B (zero warmth), simple parallel shift from the 2026-07 values. Known debt: near-black compression keeps only ~65% of the original perceived layer separation — recorded in [#2559](https://github.com/makecindy/cindy/issues/2559), fix is the equal-luminance ladder.
- **Text tiers (user ruling 2026-10-22, replaces the 2026-08 warm text ramp)**: one neutral ink at decreasing alpha, black in Light and white in Dark — emphasis 95% / 100%, primary 88% / 82%, description 70% / 66%, secondary 56% / 55%, tertiary 44% / 40%, placeholder and disabled 32% / 30%. On the page that measures 17.4 / 15.0 / 8.1 / 4.8 / 3.2 / 2.2 (Light) and 17.8 / 12.1 / 8.2 / 6.1 / 3.8 / 2.7 (Dark); the ≥3.0 floor for informational text holds on page, card and hover planes. Warmth now comes from the ivory surface showing through, not from per-tier hue shifts. Desktop only; Mobile keeps its values until its own phase. Decision record: token-decision-table §9.4.
- **Fills and lines (user ruling 2026-10-22, replaces dual anchoring)**: hover, chip, selected and pressed fills and all borders and dividers are the same ink at low alpha — soft hover 3.5% / 4%, hover and chip 5% / 6%, selected and pressed 8% / 10%, weak tier (file chip, scrollbar hover) 10% / 13%, borders and dividers 8% / 10% (Light black / Dark white). A translucent fill shifts whatever plane it sits on — page, card, popover, glass or wallpaper — by the same step, so page- and card-anchored variants are no longer needed, and in Dark a chip is always lighter than the card beneath it. Borders read softer on wallpaper than the former solid lines; this was accepted with the ruling. A line or fill that sits over a transparent window region (the layout dividers between panes under glass) is laid on the page color first, so the native window material never shows through. The Light switch off-track darkens to `#808080` so it keeps 3:1 on hovered rows. Decision record: token-decision-table §9.2–§9.3. Registered solid exceptions (owner decision, 2026-11-07): segmented controls (`segmented-option-fg`, `segmented-hover-bg` and the selected pill) and the sidebar selected pill (`sidebar-item-active`) stay solid, because they sit on tracks and sidebars they must stand out from at a fixed step.
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
- Effort: retain tier-colored 21×21 thumb, 2.5px panel-colored border and 4px same-color 22% halo;
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

## 流式正文与可组合组件（2026-10-18）

用户确认的答案方向：正文由流式编辑器与共享组件库承载，模型自由组合图文、图表和交互布局；普通任务与伙伴采用同一能力。每个完整节点增量出现，局部修订保留稳定控件身份和用户操作值。视觉沿现有正文、控件和媒体规范，不以整页 HTML 预览框替代连续正文。两端主题与窄屏同等实现。协议、能力发现与当前验收边界见 [流式正文与可组合组件](../rich-answers.md)。

### 伙伴私聊消息下操作（2026-10-29）

伙伴私聊同一轮的工作过程区与最终回复共用一个当前伙伴头像，三端一致。
头像在本轮开头显示，右侧依次呈现处理记录与回复正文；执行中转为完成态时保持同组，不再给回复重复头像。
复用回复头像的尺寸、间距和正文列；展开的中间文字与工具明细不重复头像，成果卡仍与正文对齐。没有过程的回复照常显示头像，新一轮重新显示头像。

常用操作固定在消息下方，复用现有群聊图标、引用预览与输入组件。桌面32px按钮、4px间隔、14px图标；手机44pt热区、不额外插空，左右消息的操作图形对齐对应正文边缘。复制/回复/更多常显，现有朗读与编辑能力保留；创建话题与分享图片放更多。已有话题沿用头像、回复数及最后回复时间/未读提示入口，不另造数字徽章。群聊操作及主对话914px宽度规则不变，手机正文直接选字不受操作栏影响。沿用语义色与原菜单开合、焦点和按压状态；各语言及明暗模式均不得溢出。

### 伙伴内部通讯入口（2026-11-01）

伙伴间收发只留一行次级文字「已发消息给 X」／「消息来自 X」，复用原小头像与双向箭头的单行胶囊入口，
入口与「处理记录」及助手正文共用左对齐轴，不用两侧伸展分隔线把入口推到中间；
11px 字号、28px 最小点击高度，颜色走现有语义 token，键盘焦点可见。
不铺两行摘要、不另放展开/完整对话按钮。点击直接打开原只读往来页，返回原主任务位置。
长名字在可用宽度内省略，完整标签保留在可访问名称和悬停提示。手机沿用已有触摸热区。
内部往来不制造用户未读；执行与提醒边界见 `cindy-bots-runtime.md` §6.1。
