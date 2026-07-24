# Design System Inspired by Ollama

## 1. Visual Theme & Atmosphere

Ollama's interface is radical minimalism taken to its logical conclusion — a pure-white void where content floats without decoration, shadow, or color. The design philosophy mirrors the product itself: strip away everything unnecessary until only the essential tool remains. This is the digital equivalent of a Dieter Rams object — every pixel earns its place, and the absence of design IS the design.

The entire page exists in pure grayscale. There is zero chromatic color in the interface — no brand blue, no accent green, no semantic red. The only colors that exist are shades between pure black (`#000000`) and pure white (`#ffffff`), creating a monochrome environment that lets the user's mental model of "open models" remain uncolored by brand opinion. The Ollama llama mascot, rendered in simple black line art, is the only illustration — and even it's monochrome.

What makes this system distinctive is the combination of a single geometric sans-serif (Inter) with an exclusively pill-shaped geometry (9999px radius on everything interactive). The clean letterforms + rounded buttons + rounded containers create a cohesive "softness language" that makes a developer-oriented tool feel approachable and friendly rather than intimidating. This is minimalism with warmth — not cold Swiss-style grid minimalism, but the kind where the edges are literally softened.

**Key Characteristics:**

- Pure white canvas with zero chromatic color — completely grayscale
- Inter as the single sans family, carrying both display headlines and body text
- Tight border-radius system: 8px (inner controls) / 12px (containers) / 9999px (pill) — three values, nothing else
- Zero shadows — depth comes exclusively from background color shifts and borders
- Pill-shaped geometry on all interactive elements (buttons, tabs, inputs, tags)
- The Ollama llama as the sole illustration — black line art, no color
- Extreme content restraint — the homepage is short, focused, and uncluttered

## 2. Color Palette & Roles

> **多主题架构注意**:本节列出的色值是 **Default Light / Default Dark**(默认主题,设计灵感来自 Ollama 官网)的具体值,作为视觉规范的参考样本。运行时**每个色值都通过 token 引用**(见第 10 节 Theme System & Token Reference),所以同一组件在其它主题(如 Eclipse / One Dark Pro / Monokai Pro)下会自动呈现该主题的对应色。**实现组件时永远写 token 不写 hex**——具体规则见第 10 节。

### Primary Text

- **Pure Black** (`#000000`): Primary headlines, primary links, and the darkest text in Light Mode. The only "color" that demands attention. **Never used as a background** — reserved exclusively for text and icons.
- **Near Black** (`#262626`): Button text on light-colored surfaces, secondary headline weight.

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

> **Important — element-level vs. page-level:** The "flat Surface" rule in full-window layouts applies only to the **overall page structure**, not to individual widgets. Lifted widgets *within* a full-window layout — inputs, chat input boxes, raised cards, modal overlays, panel popups — still use **Card** color per their component rules (see Section 4). A full-window chat interface can have a flat Surface page *and* a Card-colored chat input box at the same time; those are two different scopes. "Surface flat" means "don't split the page into Page+Card layers," not "every element on the page must be Surface color."

### Chip & Button Neutrals

Small interactive chips (button backgrounds, tag pills, avatar fills, selected-nav pills) sit outside the layer system — they're foreground elements, not background layers.

- **Light Gray** (`#e5e5e5`): Chip/button backgrounds in Light Mode — the workhorse neutral for pressed states, filled pills, tag backgrounds, and avatar fills.
- **Dark Chip** (`#2c2c2a`): Chip/button backgrounds in Dark Mode — equal to Dark Card; the lifted-pill color against a `#1f1f1e` Surface. (In Dark Mode, the Card layer color and the chip color collapse to the same value — both represent "one step lifted off Surface.")

> ~~**Border Light** (`#d4d4d4`)~~ —— 已废弃(2026-06,G2)。原称"white-button 专用边框色",但全仓库无真实组件使用(只有 experimental 视图裸 hardcode)。White Pill 次按钮边框统一走 **Board**(`--border-default` `#d7d7d4`)。

### Neutrals & Text

- **Stone** (`#737373`): Secondary body text, footer links, and de-emphasized content. The primary "muted" tone.
- **Mid Gray** (`#525252`): Emphasized secondary text, slightly darker than Stone.
- **Silver** (`#a3a3a3`): Tertiary text and deeply de-emphasized metadata. **不要用作 placeholder**——太显眼、读着像已填(见 §4 Inputs + §13 G3,placeholder 走 `--text-placeholder` `#c4c4c4`)。

> ~~**Button Text Dark** (`#404040`)~~ —— 已废弃(2026-06,G1)。原称"white-surface 按钮文字专用色",但全仓库无真实按钮使用(只有 experimental 视图裸 hardcode)。White Pill 次按钮文字统一走 **Near Black**(`--text-primary` `#262626`)。

### Semantic & Accent

The grayscale rule is near-absolute. The following are the **only** sanctioned non-gray colors in the system — each tightly scoped to a specific surface. New semantic colors must not be introduced without being recorded here first.

- **Ring Blue** (`#3b82f6` at 50%): Tailwind's default focus ring, used exclusively for keyboard accessibility. Never visible in normal interaction flow.
- **Thinking Orange** (`#EA6B17`,设计定稿 2026-07-17 取代 `#FF6600` 冻结红线): Used exclusively for the Running Status Bar in ChatView when the Claude Code SDK is actively processing (streaming / tool_use). Applies only to the sparkles icon and status text (e.g. `Spelunking...`); no background fill, no use outside this surface.

> **Additional narrowly-scoped exceptions** (documented in their respective component specs, do NOT generalize as system semantic colors):
>
> - **Toast Info / Success / Warning / Error** — `#417CDD` / `#2AAE5B` / `#F3A115` / `#D91F37`(E5D 定稿 2026-07-17 扩簇,Toast 豁免解除)used ONLY on the 16×16 lucide icon inside Toast pill notifications. The pill body (background, text, border, close icon) remains strictly grayscale. info 蓝 #417CDD 与 focus-ring/Auto Approval 同值(原 #3B82F6 2026-07-14 增,现定稿);success/warning/error 与全局状态色同值(done 绿/状态 error/warning 前景)。
> - **ConfirmDialog Danger** — `#EF4444` used ONLY on the confirm button background in the Danger variant. The cancel button and rest of the dialog remain grayscale.
> - **Permission Selector Mode Highlights** — selected risky permission modes may color only the option text/icon/checkmark and the collapsed trigger text/icon. The selected row background remains grayscale. Auto Approval uses `#417CDD` in both modes(设计定稿 2026-07-17 扩簇,light/dark 同值;取代 light #000050/dark #00D9C5). Full Access uses Heart Orange `#EA6B17` in both modes(随 warning-accent 自动跟随,定稿 2026-07-17). These hex values are the **default-theme palette only** — other themes may override `--perm-auto-selected-text` and `--perm-bypass-selected-text` with their own accent colors, provided both modes remain color-coded, distinguishable from each other, and visually distinct from neutral text. Tokens: `--perm-auto-selected-text` and `--perm-bypass-selected-text` in `apps/desktop/src/renderer/styles/globals.css`.
> - **Diff Add Green / Diff Del Red** — GitHub-standard diff syntax colors, used on the `+` / `-` symbol glyph, the changed-line text foreground, **and the full row background** inside code-diff renderings. Applied in three places: (1) the Edit-tool DiffView card (F-MSG-6), (2) markdown ````diff` fenced code blocks in the message stream, and (3) `.diff` / `.patch` files opened in TextLightbox (the document previewer) — there hljs `.hljs-addition` / `.hljs-deletion` are forced `display: block` so the background fills to the right edge instead of stopping at the last glyph. Line-number gutter and ctx (unchanged) lines remain strictly grayscale per the layer system. **Foreground** — Add: `#22863a` Light / `#7ee787` Dark; Del: `#b31d28` Light / `#ff7b72` Dark. **Background** — Add: `#f0fff4` Light / `#033a16` Dark; Del: `#ffeef0` Light / `#67060c` Dark. Tokens: `--diff-add-fg/-bg` and `--diff-del-fg/-bg` in `apps/desktop/src/renderer/styles/globals.css`. Updated 2026-04-21: backgrounds switched from grayscale → GitHub red/green for full-row fill so additions / deletions are unambiguous at a glance.

*Dark Mode text uses softened neutrals to reduce eye strain: **Soft Gray** (`#d4d4d4`) for primary text, Stone (`#737373`) for secondary, Silver (`#a3a3a3`) for tertiary. Pure White (`#ffffff`) is reserved for button labels and high-contrast UI elements on dark backgrounds.*

### Gradient System

- **None.** Ollama uses absolutely no gradients. Visual separation comes from flat color blocks and single-pixel borders. This is a deliberate, almost philosophical design choice.

## 3. Typography Rules

### Font Family

- **Display / Body / UI**: `Inter`, with fallbacks: `system-ui, -apple-system, "Segoe UI", sans-serif`
- **Monospace**: `JetBrains Mono`, with fallbacks: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`

*Note: The entire interface uses a single sans font — Inter — for both display headlines and body text. Inter is chosen for (a) its neutral, geometric character that stays out of the way, (b) its excellent legibility at small sizes, and (c) its wide availability in both web and design tooling (including the Pencil .pen editor). A single font keeps the hierarchy clean — separation comes from size and weight, not typeface contrast.*

### Hierarchy


| Role            | Font           | Size           | Weight  | Line Height  | Letter Spacing                         | Notes                                                                                                                                                                                                                                                        |
| --------------- | -------------- | -------------- | ------- | ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Display / Hero  | Inter          | 48px (3rem)    | 500     | 1.00 (tight) | normal                                 | Maximum impact headline                                                                                                                                                                                                                                      |
| Section Heading | Inter          | 36px (2.25rem) | 500     | 1.11 (tight) | normal                                 | Feature section titles                                                                                                                                                                                                                                       |
| Sub-heading     | Inter          | 30px (1.88rem) | 400–500 | 1.20 (tight) | normal                                 | Card headings, feature names                                                                                                                                                                                                                                 |
| Card Title      | Inter          | 24px (1.5rem)  | 400     | 1.33         | normal                                 | Medium emphasis headings                                                                                                                                                                                                                                     |
| Body Large      | Inter          | 18px (1.13rem) | 400–500 | 1.56         | normal                                 | Hero descriptions, button text                                                                                                                                                                                                                               |
| Body / Link     | Inter          | 16px (1rem)    | 400–500 | 1.50         | normal                                 | Standard body text, navigation                                                                                                                                                                                                                               |
| Caption         | Inter          | 14px (0.88rem) | 400     | 1.43         | normal                                 | Metadata, descriptions                                                                                                                                                                                                                                       |
| Small           | Inter          | 12px (0.75rem) | 400     | 1.33         | normal                                 | Smallest sans-serif text                                                                                                                                                                                                                                     |
| Micro Label     | Inter          | 10–13px        | 400–500 | 1.20–1.40    | optional 0.5–1px tracking on uppercase | **Auxiliary / non-reading** labels only — sidebar tree section heads (13px), tree row counts, frontmatter field names, scope chips, tag pills, status badges, breadcrumb segments. Never used for body text or anything the user reads sentence-by-sentence. |
| Code Body       | JetBrains Mono | 16px (1rem)    | 400     | 1.50         | normal                                 | Inline code, commands                                                                                                                                                                                                                                        |
| Code Caption    | JetBrains Mono | 14px (0.88rem) | 400     | 1.43         | normal                                 | Code snippets, secondary                                                                                                                                                                                                                                     |
| Code Small      | JetBrains Mono | 11–12px        | 400–500 | 1.40–1.63    | normal                                 | Tags, labels, in-tree paths                                                                                                                                                                                                                                  |


### Principles

- **Single sans family**: Inter carries both display headlines and body text — no typeface switching between hierarchy levels. Size and weight alone create hierarchy, keeping the typographic system maximally simple.
- **Weight restraint**: Only two weights matter — 400 (regular) for body and 500 (medium) for headings. No bold, no light, no black weight. This extreme restraint reinforces the minimal philosophy.
- **Tight display, comfortable body**: Headlines compress to 1.0 line-height, while body text relaxes to 1.43–1.56. The contrast creates clear hierarchy without needing weight contrast.
- **Monospace for code only**: JetBrains Mono is reserved for inline code, terminal commands, and code blocks — never used for UI chrome.

## 4. Component Stylings

### Buttons

**Gray Pill (Primary)**

- Background: Light Gray (`#e5e5e5`)
- Text: Near Black (`#262626`)
- Padding: 10px 24px
- Border: thin solid Light Gray (`1px solid #e5e5e5`)
- Radius: pill-shaped (9999px)
- The primary action button — understated, grayscale, always pill-shaped

**White Pill (Secondary)**

- Background: Pure White (`#ffffff`) — `--surface-elevated`
- Text: Near Black (`#262626`) — `--text-primary`
- Padding: 10px 24px
- Border: thin solid Board (`1px solid #d7d7d4`) — `--border-default`
- Radius: pill-shaped (9999px)
- Secondary action — visually lighter than Gray Pill

**Black Pill (CTA)**

- Background: Pure Black (`#000000`)
- Text: Pure White (`#ffffff`)
- Radius: pill-shaped (9999px)
- Inferred from "Create account" and "Explore" buttons
- Maximum emphasis — black on white

### Cards & Containers

- Background: Card (`#ffffff` Light / `#2c2c2a` Dark) or Surface (`#f8f8f6` Light / `#1f1f1e` Dark) depending on layer context
- Border: thin solid Board (`1px solid #d7d7d4` Light / `1px solid #3c3c3a` Dark) when needed
- Radius: comfortably rounded (12px) — the container radius (see §5 three-tier scale; 8px is reserved for inner controls like textareas / dropdown rows, pill for interactive elements)
- Shadow: **none** — zero shadows on any element
- Hover: likely subtle background shift or border darkening

### Inputs & Forms

- Background: Card (`#ffffff` Light / `#2c2c2a` Dark)
- Border: `1px solid` Board (`#d7d7d4` Light / `#3c3c3a` Dark)
- Radius: pill-shaped (9999px) — single-line search inputs and form fields are pill-shaped. **多行输入框(textarea)套不了胶囊**(高框会变形),改用 8px 内层圆角(见 §5 三档圆角)。
- Focus: Ring Blue (`#3b82f6` at 50%) ring
- Placeholder: **`--text-placeholder`** slot — **Faded Light** (`#c4c4c4`) Light / **Mid Gray** (`#525252`) Dark — must read as clearly empty, not pre-filled. Silver (`#a3a3a3`) is too prominent against either Card surface (≈5:1 in Dark, ≈2.6:1 in Light) and reads as real input. **所有输入面的 placeholder(chat / ask / settings / plan-action-fb)统一收口于此 slot**(2026-06 G3);非默认主题通过 override `text-placeholder` 表达各自的 placeholder 色。

### Select & Dropdown

- **Trigger**: 同单行输入 —— pill(9999px),Card bg,1px Board 边框,承载当前值 + chevron。
- **弹出面板**: 是个容器 —— 12px 圆角,Card bg(`--surface-elevated`),1px Board 边框,无阴影(靠 overlay / 层色分隔),内边距 6–8px。
- **面板宽度必须绑定 trigger 宽度** —— 不许比触发它的控件更窄或更宽。Radix Select 用 `position="popper"` + `width: var(--radix-select-trigger-width)`;其它原语则取 trigger 实测宽度对齐。(反复踩的点:下拉宽度要跟上方一致。)
- **选项行**: 选中 / 悬浮的高亮底色用 **8px 内层圆角**(见 §5 —— 面板是 12px 容器,行高亮是内层 8px,内层必须比面板小才嵌套协调)。高亮 bg 走 `--surface-hover` / Radix `data-[highlighted]`;选中行给 chip 填充,未选中行透明。
- **composer 下拉菜单行(模型 / 权限 / + 三个 MorphPopover 菜单)统一规约**(2026-07-22):这三个菜单的所有选项行必须**逐字一致**——横向内边距 `px-3`、圆角 `rounded-[8px]`、hover 与选中底都走**同一个 token `--model-item-hover`**,选中态仅额外靠对勾 + `font-medium` 区分(危险权限档的橙 / 蓝只染**文字**,不改底色)。**为什么不用 `--surface-chip` 做选中底**:cindy 默认皮肤把 `--surface-hover` / `--surface-chip` 调成"压在页面底上"的值,比抬起的弹层面板(`--surface-elevated`)还暗,行高亮会隐形;故菜单行 hover 收口到组件级 token `--model-item-hover`,并在 cindy-dark / cindy-light 里单独 override 到"面板之上一档"(dark 抬亮、light 压深)保证清晰。改这三个菜单的行样式时三处必须同步,不许只改一个导致又不统一。

### Dialog & Modal

参照实现 `components/ui/confirm-dialog.tsx`(通用确认弹窗);新建弹窗沿用它的结构,不另起一套。

- **Overlay**: 全屏遮罩走 `--overlay-modal` token(ConfirmDialog 现用 `neutral-900/40` 硬编码 pair 是历史遗留,**新弹窗一律走 token**,别照抄)。
- **容器**: 是个容器 —— 12px 圆角(`rounded-xl`),`--confirm-bg`,`--confirm-shadow`,16px 内边距(`p-4`),居中。宽度:确认 / 提示类 ≈ 400px(`max-w-[400px]`);带输入 / 表单的可放宽到 ≈ 460px 并随视口收窄(`min(460px, 100vw-32px)`)。
- **标题 / 描述**: `--confirm-title` / `--confirm-desc`,medium 字重。
- **按钮**: pill(9999px);主按钮 = 实心 CTA(`--confirm-btn-primary-*`),次按钮 / 取消 = 描边(`--confirm-btn-secondary-*`,透明底 + Board 边框);底部 `justify-end`。
- **打开时焦点**: 落在该弹窗的**主输入或主按钮**,不要默认停在取消键(见 §14.2 + ConfirmDialog 的 `autoFocusConfirm` / `onOpenAutoFocus`)。

### Navigation

- Clean horizontal nav with minimal elements
- Logo: Ollama llama icon + wordmark in black
- Links: "Models", "Docs", "Pricing" in black at 16px, weight 400
- Search bar: pill-shaped with placeholder text
- Right side: "Sign in" link + "Download" black pill CTA
- No borders, no background — transparent nav on white page

### Image Treatment

- The Ollama llama mascot is the only illustration — black line art on white
- Code screenshots/terminal outputs shown in bordered containers (12px radius)
- Integration logos displayed as simple icons in a grid
- No photographs, no gradients, no decorative imagery

### Distinctive Components

**Tab Pills**

- Pill-shaped tab selectors (e.g., "Coding" | "OpenClaw")
- Active: Light Gray bg; Inactive: transparent
- All pill-shaped (9999px)

**Model Tags**

- Small pill-shaped tags (e.g., "ollama", "launch", "claude")
- Light Gray background, dark text
- The primary way to browse models

**Terminal Command Block**

- Monospace code showing `ollama run` commands
- Minimal styling — just a bordered 12px-radius container
- Copy button integrated

**Integration Grid**

- Grid of integration logos (Codex, Claude Code, OpenCode, LangChain, etc.)
- Each in a bordered pill or card with icon + name
- Tabbed by category (Coding, Documents & RAG, Automation, Chat)

## 5. Layout Principles

### Spacing System

- Base unit: 8px
- Scale: 4px, 6px, 8px, 9px, 10px, 12px, 14px, 16px, 20px, 24px, 32px, 40px, 48px, 88px, 112px
- Button padding: 10px 24px (consistent across all buttons)
- Card internal padding: approximately 24–32px
- Section vertical spacing: very generous (88px–112px)

### Grid & Container

- Max container width: approximately 1024–1280px, centered
- Hero: centered single-column with llama illustration
- Feature sections: 2-column layout (text left, code right)
- Integration grid: responsive multi-column
- Footer: clean single-row

### Whitespace Philosophy

- **Emptiness as luxury**: The page is remarkably short and sparse — no feature section overstays its welcome. Each concept gets minimal but sufficient space.
- **Content density is low by design**: Where other AI companies pack feature after feature, Ollama presents three ideas (run models, use with apps, integrations) and stops.
- **The white space IS the brand**: Pure white space with zero decoration communicates "this tool gets out of your way."

### Border Radius Scale

三档圆角,**仅此三档**:

- **Inner control (8px)**: 窄第三档,**只**给"做不成胶囊"的小交互件:多行输入框(textarea)、下拉 / 菜单的选中行高亮、段内小单元格。实现为 Tailwind `rounded-lg`(8px)。
- **Container (12px)**: 盒子圆角 — 代码块、卡片、面板、弹窗。实现为 Tailwind `rounded-xl`(12px)。
- **Pill (9999px)**: 能套胶囊的所有交互件 — 按钮、Tab、单行输入、标签、徽标。

*没有 4px / 6px / 10px,也不开放任意圆角。绝大多数元素仍只在 12px 容器和 pill 里二选一;8px 是给"塞不进胶囊的小控件"的窄例外。注意嵌套:8px 行高亮套在 12px 面板里时,内层圆角必须比容器小才协调(所以是 8 而非 12),做成胶囊则会变成药丸、做成 12px 会显得鼓。*

## 6. Depth & Elevation


| Level              | Treatment                                                                 | Use                                            |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Flat (Level 0)     | No shadow, no border                                                      | Surface background, most content               |
| Bordered (Level 1) | `1px solid` Board (`#d7d7d4` Light / `#3c3c3a` Dark)                      | Cards, code blocks, dividers, section outlines |
| Lifted (Card)      | Card fill (`#ffffff` Light / `#2c2c2a` Dark) + optional 1px Board outline | Login cards, modals, raised panels             |


**Shadow Philosophy**: Ollama uses **zero shadows**. This is not an oversight — it's a deliberate design decision. Every other major AI product site uses at least subtle shadows. Ollama's flat, shadowless approach creates a paper-like experience where elements are distinguished purely by background color and single-pixel borders. Depth is communicated through **content hierarchy and typography weight**, not visual layering.

## 7. Do's and Don'ts

### Do

- Use Surface (`#f8f8f6` Light / `#1f1f1e` Dark) as the page background — every page starts here
- Use pill-shaped (9999px) radius on all interactive elements — buttons, tabs, inputs, tags
- Use 12px radius on all non-interactive containers — code blocks, cards, panels
- Use 8px radius only for inner controls that can't be a pill — multi-line inputs, dropdown/menu rows (see §5)
- Keep the palette strictly grayscale — no chromatic colors except the blue focus ring
- Use Inter at weight 500 for display headings — hierarchy comes from size + weight, not typeface switching
- Maintain zero shadows — depth comes from borders and background shifts only
- Keep content density low — each section should present one clear idea
- Use monospace for terminal commands and code — it's primary content, not decoration
- Keep all buttons at 10px 24px padding with pill shape — consistency is absolute

### Don't

- Don't introduce any chromatic color — no brand blue, no accent green, no warm tones
- Don't invent arbitrary radii — only three values exist: 8px (inner controls), 12px (containers), 9999px (pill). Nothing in between, nothing else.
- Don't add shadows to any element — the flat aesthetic is intentional
- Don't use font weights above 500 — no bold, no black weight
- Don't add decorative illustrations beyond the llama mascot
- Don't use gradients anywhere — flat blocks and borders only
- Don't overcomplicate the layout — two columns maximum, no complex grids
- Don't use borders heavier than 1px — containment is always the lightest possible touch
- Don't add decorative or large-motion animation — no bounce, parallax, looping, or gratuitous movement. Short **functional** state transitions (color / background / opacity, ≤150ms) are fine and expected — see §14.4.

## 8. Responsive Behavior

### Breakpoints


| Name          | Width       | Key Changes                                      |
| ------------- | ----------- | ------------------------------------------------ |
| Mobile        | <640px      | Single column, stacked everything, hamburger nav |
| Small Tablet  | 640–768px   | Minor adjustments to spacing                     |
| Tablet        | 768–850px   | 2-column layouts begin                           |
| Desktop       | 850–1024px  | Standard layout, expanded features               |
| Large Desktop | 1024–1280px | Maximum content width                            |


### Touch Targets

- All buttons are pill-shaped with generous padding (10px 24px)
- Navigation links at comfortable 16px size
- Minimum touch area easily exceeds 44x44px

### Collapsing Strategy

- **Navigation**: Collapses to hamburger menu on mobile
- **Feature sections**: 2-column → stacked single column
- **Hero text**: 48px → 36px → 30px progressive scaling
- **Integration grid**: Multi-column → 2-column → single column
- **Code blocks**: Horizontal scroll maintained

### Image Behavior

- Llama mascot scales proportionally
- Code blocks maintain monospace formatting
- Integration icons reflow to fewer columns
- No art direction changes

## 9. Agent Prompt Guide

### Quick Color Reference

- Primary Text: "Pure Black (#000000)" Light / "Soft Gray (#d4d4d4)" Dark
- **Surface** (page bg): "Light Surface (#f8f8f6)" / "Dark Surface (#1f1f1e)"
- **Card** (elevated layer): "Pure White (#ffffff)" / "Dark Card (#2c2c2a)"
- **Board** (1px dividers/borders): "Light Board (#d7d7d4)" / "Dark Board (#3c3c3a)"
- Secondary Text: "Dark Gray (#525252)" Light / "Silver (#a3a3a3)" Dark
- Tertiary Text: "Stone (#737373)" Light / "Stone (#737373)" Dark
- Near Black: (#262626) — Light primary reading text
- Chip/Button Background: "Light Gray (#e5e5e5)" Light / "Dark Chip (#2c2c2a)" Dark

### Example Component Prompts

- "Create a hero section on Surface (#f8f8f6) with an illustration centered above a headline at 48px Inter weight 500, line-height 1.0. Use Pure Black (#000000) text. Below, add a black pill-shaped CTA button (9999px radius, 10px 24px padding) and a gray pill button."
- "Design a code block with a 12px border-radius, 1px solid Board (#d7d7d4 Light / #3c3c3a Dark) border on Card background. Use JetBrains Mono at 16px for the terminal command. No shadow."
- "Build a tab bar with pill-shaped tabs (9999px radius). Active tab: Light Gray (#e5e5e5) background, Near Black (#262626) text. Inactive: transparent background, Stone (#737373) text."
- "Create an integration card grid. Each card is a bordered pill (9999px radius) or a 12px-radius card with 1px solid Board (#d7d7d4) border. Icon + name inside. Grid of 4 columns on desktop."
- "Design a navigation bar: transparent background, no border. Ollama logo on the left, 3 text links (Pure Black, 16px, weight 400), pill search input in the center, 'Sign in' text link and black pill 'Download' button on the right."

### Iteration Guide

1. Focus on ONE component at a time
2. Keep all values grayscale — "Stone (#737373)" not "use a light color"
3. Always specify radius from the three tiers — pill (9999px) / container (12px) / inner control (8px, only for textareas & dropdown rows). Nothing else.
4. Shadows are always zero — never add them
5. Weight is always 400 or 500 — never bold
6. If something feels too decorated, remove it — less is always more for Ollama

## 10. Theme System & Token Reference

### Light / Dark 双模式交付门槛

- **所有 UI 必须同时支持 Light 与 Dark 两种模式。**新增或修改页面、组件、布局、样式、
  动效或 UI 文案时，必须在同一项工作中完成两种模式；只设计、只实现或只验证一种模式，
  均视为未完成。
- 两种模式都必须覆盖本次改动涉及的默认态、hover、pressed、selected、focus、disabled、
  loading、empty、error、弹层与遮罩等实际状态；没有涉及的状态不要求为凑检查而改造。
- 颜色必须通过语义 token 消费，禁止用仅适配一种模式的硬编码色值或条件分支补丁。设计稿
  只提供一种模式时，也必须按现有 token 体系补齐另一种模式；若缺少明确的语义映射，先请求
  设计裁决，不得省略另一种模式。
- 交付前至少对本次受影响界面的 Light 与 Dark 模式分别完成验证，并在提交或 PR 的验证说明
  中如实记录；任一模式存在不可读、不可辨、状态缺失或明显视觉回退时，不得视为完成。

### 架构

Cindy 桌面端用 **VSCode 风格的 ColorRegistry + Theme override** 模型管理颜色。所有颜色都通过 CSS variable 以 token 形式被组件消费,**永远不允许在组件里硬编码 hex / rgba**(违反规则会让该组件在非默认主题下无法切色)。

源码:`apps/desktop/src/renderer/themes/`
- `color-registry.ts` — `ColorRegistry` 单例和 `registerColor(id, defaults, description)` API
- `colors.ts` — 注册全部 token(目前 352 个:40 semantic slot + 228 alias + 84 singleton),按"semantic slot 在前,alias 和 singleton 在后"组织
- `theme-service.ts` — `applyTheme(theme)` 把所有 token 序列化成 `:root{}` 注入 `<style id="theme-vars">`
- `builtin/` — 内置主题对象(`cindy-light.ts` / `cindy-dark.ts` / `eclipse.ts` / `default-light.ts` / `default-dark.ts` 及各社区配色)
- `registry.ts` — `builtinThemes` 注册表 + `listThemesByType('light' | 'dark')`

切主题:`useTheme.ts` 提供 `theme`(System / Light / Dark mode) + `lightThemeId` / `darkThemeId`(具体哪套主题)。Settings → Appearance 是 UI 入口。

### Token 分层

**Tier 1 — Semantic slot (39 个)**:跨语境复用的核心语义槽,加新主题时这一层是 override 的主战场。

| 类目 | Slot | Ollama Light | Ollama Dark | 主要用途 |
|---|---|---|---|---|
| **Surface (12)** | `--surface` | `#f8f8f6` | `#1f1f1e` | 页面 Surface(hex 形式) |
| | `--surface-hsl` | `60 12.5% 97%` | `60 2% 12%` | 同上 HSL 形式,`hsl(var(--xxx))` 消费 |
| | `--surface-elevated` | `#ffffff` | `#2c2c2a` | Card 抬一层 / 弹窗 / popover |
| | `--surface-elevated-soft` | `#e5e5e5` | `#2c2c2a` | Disabled 状态 Card |
| | `--surface-card-ivory` | `#faf9f5` | `#2c2c2a` | Settings 微暖 ivory Card |
| | `--surface-chip` | `#e5e5e5` | `#3c3c3a` | Chip / pill / 选中行 |
| | `--surface-chip-alt` | `#e5e5e5` | `#2c2c2a` | Chip 暗态塌缩到 Card 变体 |
| | `--surface-hover` | `#e5e5e5` | `#3c3c3a` | 通用 hover bg |
| | `--surface-hover-soft` | `#f8f8f6` | `#3c3c3a` | 柔和 hover bg |
| | `--surface-hover-hsl` | `0 0% 90%` | `60 2% 17%` | hover HSL 形式 |
| | `--surface-on-card` | `#ffffff` | `#1f1f1e` | CTA / checked icon 深色前景 |
| **Border (4)** | `--border-default` | `#d7d7d4` | `#3c3c3a` | 本规范 Board 1px 边框 |
| | `--border-default-hsl` | `60 3% 84%` | `60 2% 23%` | Board HSL 形式 |
| | `--border-shadcn-hsl` | `0 0% 90%` | `30 4% 28%` | shadcn input/border HSL |
| | `--border-transparent-mixed` | `transparent` | `#3c3c3a` | progress track 等单边边框 |
| **Text (16)** | `--text-primary` | `#262626` | `#d4d4d4` | 主标题 / 主正文 |
| | `--text-primary-hsl` | `0 0% 9%` | `0 0% 83%` | Primary HSL 形式 |
| | `--text-primary-on-dark` | `#262626` | `#ffffff` | 反相文本(stop button icon 等) |
| | `--text-primary-emphasis` | `#1a1a1a` | `#d4d4d4` | Plan 强调主文字 |
| | `--text-primary-inv` | `#1a1a1a` | `#ffffff` | Plan-action approve text |
| | `--text-primary-body-strong` | `#525252` | `#d4d4d4` | Plan content body 加重 |
| | `--text-secondary` | `#737373` | `#a3a3a3` | Secondary 文字 / icon |
| | `--text-secondary-cross` | `#a3a3a3` | `#a3a3a3` | 跨主题更浅 secondary |
| | `--text-secondary-mid` | `#525252` | `#a3a3a3` | Muted body 文字 |
| | `--text-tertiary` | `#a3a3a3` | `#737373` | Placeholder / tertiary |
| | `--text-tertiary-stone` | `#737373` | `#737373` | Stone 跨主题三级 |
| | `--text-tertiary-mid` | `#525252` | `#737373` | Mid-gray tertiary |
| | `--text-tertiary-hsl` | `0 0% 45%` | `0 0% 45%` | Tertiary HSL |
| | `--text-disabled` | `#d4d4d4` | `#525252` | Disabled / failed |
| | `--text-disabled-tertiary` | `#a3a3a3` | `#737373` | Disabled placeholder 变体 |
| | `--text-placeholder` | `#c4c4c4` | `#525252` | 统一 placeholder slot(比 tertiary 更淡,读着像空);chat/ask/settings/plan-action-fb 输入框 placeholder 均收口于此 |
| **Accent (7)** | `--accent-cta-bg` | `#262626` | `#ffffff` | 反相 CTA bg |
| | `--accent-cta-bg-pure` | `#000000` | `#ffffff` | Pure CTA bg |
| | `--accent-emphasis` | `#262626` | `#d4d4d4` | settings primary button 等 |
| | `--accent-soft` | `#262626` | `#ffffff` | Soft accent(folder btn 等) |
| | `--accent-hover` | `#262626` | `#e5e5e5` | CTA pressed/hover |
| | `--accent-pure-cta-fg` | `#ffffff` | `#000000` | CTA 文字 pure 反相 |
| | `--accent-fg-on-pure` | `#ffffff` | `#1f1f1e` | CTA 文字 light 白 / dark 沉 |

**Tier 2 — Alias (228 个)**:大量 component-scoped token(如 `--cmd-palette-bg`、`--msg-tool-card-text`、`--settings-input-border`)的 default 改写为 `var(--slot)`。浏览器自动 forward-resolve。组件不感知,**继续直接消费 alias 名字即可**。

**Tier 3 — Singleton (84 个)**:真独立的色值,无法收敛到 slot:语义豁免色(`--destructive` / `--diff-add-*` / `--status-bar-accent` 等)、平台特定色、splash 时长、`--radius` 等非颜色 token。

### 语义豁免色(跨主题不变)

| Token | Light | Dark | 用途 |
|---|---|---|---|
| `--destructive` (HSL) | `0 84% 60%` | `0 72% 63%` | 通用 destructive 文本/边 |
| `--login-error-text` 等 5 个 | `#ef4444` | `#ef4444` | 错误文本 |
| `--error-bg/-border/-fg/-fg-strong` | (red) | (red) | Error alert 卡片子系统 |
| `--diff-add-fg/-bg`, `--diff-del-fg/-bg` | GitHub palette | GitHub palette | Diff 渲染 |
| `--status-bar-accent` | `#EA6B17` | `#EA6B17` | Thinking Orange,跨主题统一(定稿 2026-07-17) |
| `--plan-action-approve-icon-bg` | `#EA6B17` | `#EA6B17` | Plan approve,同 thinking 语义(随 warning-accent,定稿 2026-07-17) |
| `--perm-bypass-selected-text` | `#EA6B17` | `#EA6B17` | Heart Orange,permission 语义(var(--warning-accent) 自动跟随,定稿 2026-07-17) |
| `--settings-integration-warning` | `#EA6B17` | `#EA6B17` | warning 语义(var(--warning-accent) 自动跟随,定稿 2026-07-17) |
| `--warning-bg-soft` | rgba(255,102,0,0.12) | rgba(255,102,0,0.18) | Warning alpha surface |
| `--focus-ring` / `--focus-ring-soft` | `#417CDD` / @50% | 同左 | a11y 焦点 ring,定稿 2026-07-17(取代 #3b82f6),跨主题统一 |
| `--shadow-menu` / `--cmd-palette-shadow` / `--confirm-shadow` | rgba | rgba(更深) | Shadow,跨主题统一 |
| `--overlay-modal` / `--overlay-lightbox` | rgba | rgba(更深) | Modal / lightbox backdrop |
| `--perm-auto-selected-text` | `#417CDD` | `#417CDD` | Auto Approval accent,定稿 2026-07-17(light/dark 同值,取代 #000050/#00D9C5) |
| Toast `#417CDD / #2AAE5B / #F3A115 / #D91F37` | (在 Toast.tsx hardcode,已导出 VARIANT_MAP) | 同左 | E5D 定稿 2026-07-17(Toast 豁免解除,并入状态色族) |

实现组件时**永远不要在硬编码 hex 上自由发挥这些语义色**——必须走对应 token。

### 内置主题

当前实现以 `apps/desktop/src/renderer/themes/registry.ts` 的 `builtinThemes` 为准,新增/移除主题不要求同步本文档。默认的 light/dark 主题(基础主题)就是本文 §2 列的色值。

### 新主题怎么加(完整流程)

1. 新建 `apps/desktop/src/renderer/themes/builtin/<id>.ts`,导出 `Theme` 对象:
   ```ts
   export const myTheme: Theme = {
     id: 'my-theme',
     name: 'My Theme',
     type: 'light' | 'dark',
     colors: {
       // 只 override 跟基础主题不同的 token,空对象 {} 也合法(完全等于基础主题)
       'surface': '#xxx',
       'text-primary': '#xxx',
       // ... 大概率只需要 override 30-90 个 token
     },
   };
   ```
2. 注册到 `themes/registry.ts` 的 `builtinThemes`
3. 设置页 Appearance 的 Light/Dark Theme dropdown 自动 pick up

参考 `themes/builtin/` 下任一已存在的非默认主题作为模板。

### Token 命名约定

- **slot**:`{category}-{subkind}[-{variant}]`,如 `text-primary-emphasis` / `surface-chip-alt`。`-hsl` 后缀表示 HSL 三元组形式。
- **alias**:沿用历史 component-scoped 命名(`--cmd-palette-bg` / `--settings-back-text` 等),无前缀。
- **singleton**:语义清晰即可,通常带 component 前缀。

CSS variable 名一律 kebab-case。点号风格(如 VSCode 的 `sidebar.itemActive`)由于 CSS variable 不支持暂未采用。

### 实现新 UI 时的 token 选择规则

1. **先 grep `colors.ts`**:你的 UI 类型常对应已有 slot/alias(card bg = `--cmd-palette-bg` / `--surface-elevated`,等)
2. **slot 优先**:能用 slot 就别用 component-scoped alias(slot 跨主题表现更可控)
3. **HSL token 必须 wrap**:`hsl(var(--background))` 不能写成 `var(--background)`(后者会得到原始 HSL 字符串,不是合法 CSS color)
4. **找不到合适 token 时,不要硬塞**:跟用户讨论是否要新增 slot/singleton
5. **不接受** `bg-[#xxx] dark:bg-[#xxx]` 这种硬编码 pair——这是 P2 前的反模式,已经全量迁移过一次,新代码不允许引入

本节即 token 使用规则的权威正文；UI 文案的 i18n 落地规则见
`docs/dev-rules/engineering-conventions.md` §5。

## 11. Voice & Content（微文案规范）

> **状态:草案**,2026-06 引入(参考 Vercel Geist `design.md` 的 Voice & Content 一节)。本节规定**界面文案怎么写**,与 `docs/dev-rules/engineering-conventions.md` §5(i18n 体系)配套——那边管"文案必须 4 语言对齐、经 i18n key 落地",本节管"每条文案本身的语气/措辞"。本节不新增任何 UI 字符串,只约束写法。

Cindy 的产品气质和视觉一致:**克制、直接、不自夸**。文案是工具的一部分,不是营销。

### 11.1 语言无关原则(zh-CN / en / ja / ko 全部适用)

- **动作 = 动词 + 宾语,不要裸动词**。按钮/菜单项说清"对什么做什么":`Deploy Project` / `删除会话` / `セッションを削除`,**禁止** `Confirm` / `OK` / `确定` / `提交` 这类无宾语的孤立动词(确认弹窗的主按钮尤其要带宾语,让用户脱离上下文也能看懂)。
- **错误信息 = 发生了什么 + 怎么办**。只报"出错了 / Failed"不合格;要给出下一步("连接超时,检查网络后重试")。对应 `docs/dev-rules/engineering-conventions.md` §2(IPC 错误协议):IPC 错误码是给代码用的,面向用户的那句话必须人话 + 可操作。
- **进行中态 = 现在进行时 + 省略号**。`Deploying…` / `正在部署…` / `デプロイ中…`。我们 ChatView 的 Thinking 状态栏(`Spelunking…`,Thinking Orange)已是这个范式,新增加载/处理态沿用。
- **结果反馈点名对象、不说"成功"**。Toast 说"变了什么"而不是"操作成功了":`会话已删除` 而非 `删除成功`;`Project deleted` 而非 `Deleted successfully`。**禁止** "successfully / 成功了" 这类废话词。(Toast 的视觉规范见 §2,本条只管文案。)
- **空状态指向第一个动作**,别只画一句"暂无数据"——告诉用户现在能做什么("还没有会话,点 + 新建一个")。
- **不卑不亢,但分语言**:英文不写 "Please"(界面不是在求用户)。**中文的"请"是地道礼貌用法,不在此列**——"请输入…""请先授权""请选择文件"这类该保留,不要为了套规则把中文改得生硬。两种语言都不写营销级形容词("强大的 / 极致 / 全新")。

### 11.2 各语言的大小写与标点(语言相关,不可照搬)

- **English**:标签 / 按钮 / 标题 / Tab 用 **Title Case**(`Deploy Project`);正文 / 帮助文字 / Toast 用 **sentence case**(只首字母大写)。用弯引号 `" "` 和省略号字符 `…`,不用 `"` 和 `...`。
- **zh-CN**:**没有 Title Case 概念**,不要逐词首字母大写、不要给中文塞英文式标点;中英混排时英文术语保留原样(`部署 Project`)。句末 Toast / 标签不加句号。
- **ja / ko**:同样无 Title Case;遵循各自的助词/敬体习惯,术语译法没把握时先查证(对应 `docs/dev-rules/engineering-conventions.md` §5:ja/ko 不许硬凑)。
- **数字 / 单位**:四语言都用阿拉伯数字 + 半角,数字与单位间距按各语言习惯。

### 11.3 自查清单(改动文案时)

- [ ] 动作按钮带宾语,不是裸 `确定` / `OK`
- [ ] 错误文案给了"怎么办",不是只报错
- [ ] 没有 "successfully / 成功" 废话词
- [ ] 进行中态是"现在进行时 + …"
- [ ] 4 个 `common.json` 都补齐且符合本语言的大小写/标点(见 `docs/dev-rules/engineering-conventions.md` §5)

## 12. Component Spec(结构化样板 — 待定)

> **状态:样板,待你 review。** 本节是把 §4 组件散文规格改写成 **Vercel `design.md` 那种「可机读 / 可执行」结构化键值**的试点,先做 Buttons / Inputs / Cards 三个。**确认采用后,就地替换 §4 的散文描述并删除本节**;不采用则整节删掉,§4 不受影响。
>
> 读法:`字段  →  token  →  Default Light / Default Dark 解析值`。token 名以 §10 表为准;`⚠` 标记"规范里有值但 §10 暂无对应 token / 字段在 §4 未定义"的缺口——这正是结构化格式相对散文的价值:把隐性缺口显性化。

```
button/primary  (Gray Pill — 主按钮)
  fill      --surface-chip        #e5e5e5 / #3c3c3a
  text      --text-primary        #262626 / #d4d4d4
  border    1px solid --surface-chip   (同 fill)
  radius    9999px (pill)
  padding   10px 24px
  height    ⚠ §4 未定义(§4 仅给 padding)

button/secondary  (White Pill — 次按钮)
  fill      --surface-elevated    #ffffff / #2c2c2a
  text      --text-primary        #262626 / #d4d4d4   (G1 已解决:原 #404040「Button Text Dark」是漂移)
  border    --border-default      #d7d7d4 / #3c3c3a   (G2 已解决:原 #d4d4d4「Border Light」是漂移)
  radius    9999px (pill)
  padding   10px 24px

button/cta  (Black Pill — 最高强调)
  fill      --accent-cta-bg-pure  #000000 / #ffffff
  text      --accent-pure-cta-fg  #ffffff / #000000
  radius    9999px (pill)
  padding   10px 24px

input/text
  fill        --surface-elevated  #ffffff / #2c2c2a
  text        --text-primary      #262626 / #d4d4d4
  border      --border-default    #d7d7d4 / #3c3c3a
  radius      9999px (pill)
  focus       --focus-ring        #3b82f6 @50%(双层带缝 ring 见外部讨论 ③,待定)
  placeholder --text-placeholder   #c4c4c4 / #525252   (G3 已解决:新增统一 slot,4 个输入面 alias 全部收口)

card/container
  fill      --surface-elevated    #ffffff / #2c2c2a   (页面级 flat 布局下改用 --surface,见 §2 layer rule)
  border    1px solid --border-default   #d7d7d4 / #3c3c3a   (需要分隔时才加)
  radius    12px (Tailwind rounded-xl,直接量) — 容器档圆角(三档之一,见 §5;8px 仅内层控件 textarea / 下拉行,pill 给交互件)
            ⚠ 不要用 §10 的 --radius:那是 shadcn 原语用的 0.5rem(8px),与本 12px 容器圆角是两回事
  shadow    none
  hover     --surface-hover       #e5e5e5 / #3c3c3a   (§4 原文是「likely」,此处给出可用 token)
```

## 13. Known Spec / Token Gaps（跟踪中）

> §12 结构化重写过程中暴露的设计系统欠债。本节**持久存在**(独立于 §12 是否被采用),每条解决后打勾并把结论并入 §2 / §4 / §10。下列"现状"均已 grep 源码核实(以源码为准),非臆测。涉及新增/改 token 的(G3 / G4)按第 10 节的 token 规则须先与 owner 确认再动 `colors.ts`。

- [x] **G1 — 白底次按钮文字 `#404040`「Button Text Dark」是文档漂移,非真 token**(已解决 2026-06)
  现状:§2 / §4 称其"专用于白底按钮文字",但全仓库只有 `features/maker-experimental/MakerExperimentalView.tsx`(实验视图,裸 hardcode)出现 #404040,**无任何真实次按钮**用它做文字色;§10 也无对应 token。
  处理:§2 标废弃、§4 White Pill 文字改引 `--text-primary`(#262626)。未动 token,纯文档。

- [x] **G2 — 次按钮边框 `#d4d4d4`「Border Light」同为漂移**(已解决 2026-06)
  现状:§4 称白底按钮边框 `1px solid #d4d4d4`,但无真实组件这么用;#d4d4d4 的线上出现要么在实验视图(裸 hardcode),要么是**暗色主文字**(`--text-primary` dark = #d4d4d4,如 SchedulerPage CTA 注释),与"边框"无关。真边框 token 是 `--border-default`(#d7d7d4)。
  处理:§2 标废弃、§4 White Pill 边框改引 `--border-default`(#d7d7d4)。纯文档。

- [x] **G3 — placeholder token 碎片化 + 取值自相矛盾(真欠债)**(已解决 2026-06)
  现状:4 个 per-surface alias 无统一 slot,且取值打架——`--settings-input-placeholder` = #c4c4c4(§4 认证的"淡到读着像空"),但 `--chat-input-placeholder` = `var(--text-tertiary)` = **#a3a3a3(Silver)**,而 §4 白纸黑字说 Silver **太显眼、读着像已填、不可做 placeholder**。即聊天输入框 placeholder 实际违反了我们自己的 §4 规范。
  处理:`colors.ts` 新增语义 slot `--text-placeholder`(#c4c4c4 / #525252),4 个 alias(chat/ask/settings/plan-action-fb)default 收口为 `var(--text-placeholder)`;7 套非默认主题原 `settings-input-placeholder` override 就地改名为 `text-placeholder`(沿用原常量,避免回退,符合第 10 节对每套主题的 override 评估)。默认主题下 chat placeholder 由 #a3a3a3 修正为 #c4c4c4。2 套亮色主题(atom-one-light / solarized-light)的 `text-placeholder` 进一步从 tertiary 改用各自 **disabled 档**(更淡)——亮色背景下 tertiary≈2.6:1 命中 §4 禁用 Silver 的对比度,placeholder 须更淡才读着像空(2026-06 review 反馈)。**本地/复制主题兼容**:slot 引入前创建的本地主题快照只冻结了旧 per-surface placeholder key、无 `text-placeholder`,加载期 `mapWireTheme` 经 `local-themes-normalize.ts` 归一化——缺 `text-placeholder` 时从旧 `settings-input-placeholder`(或任一 per-surface 值)播种并丢弃 4 个旧 per-surface override,使四个输入面统一走新 slot(不改写盘上 JSON、幂等;2026-06 review 反馈)。

- [x] **G4 — `--radius`(8px)与容器圆角同名不同义(已解决 2026-06)**
  现状:`--radius` 实为 `0.5rem`(8px,shadcn 原语用);容器 12px 圆角实际靠 Tailwind `rounded-xl` 直接量实现。
  处理:**圆角体系正式从"二元"改为"三档"**(8px 内层控件 / 12px 容器 / 9999px pill,见 §5 + §7 + §1)。8px 这一档窄范围限定多行输入框、下拉 / 菜单选中行、段内小单元,实现为 `rounded-lg`;shadcn `--radius`(8px)与这个内层档数值相同但语义独立(原语专用),容器仍走 `rounded-xl`(12px)。**本次纯文档,未动 token**。是否进一步 token 化为 `--radius-inner`(8px)/ `--radius-container`(12px)/ `--radius-pill`(9999px),收益偏低、**暂缓**,要做走第 10 节的新增 token 流程。

> **旁注(不在本次范围,仅记录)**:`MakerExperimentalView.tsx` 通篇裸 hardcode hex(#404040 / #d4d4d4 / #262626 / #333),违反第 10 节 token 规则。因是 experimental 视图、且非本次任务,**不在此清理**,仅备忘。

## 14. Interaction Conventions(交互约定)

> 2026-06 引入。本规范此前只规范"长什么样"(色 / 圆角 / 字体 / 间距),不规范"怎么交互"——文本能不能选中、弹窗开了焦点落哪、回车是发送还是换行,这些反复要靠人逐个指出。本节把这些**非视觉的交互行为**钉成全局约定,与 §11(文案语气)互补。能用代码统一保证的就别靠人记(对应 `docs/dev-rules/maker-core-and-agent-behavior.md` 的「代码优先确定性」)。

### 14.1 文本可选性(user-select)

- **正文内容可选**:消息气泡正文、代码块、文档预览、用户会"读句子 / 想复制"的文字 —— 默认可选,不要动。
- **Chrome 不可选**:按钮、菜单项、标签 / chip、状态条、徽标、工具条、侧栏项这类**界面骨架文字**一律 `select-none`。它们是控件不是内容,能被选中只会碍事(典型:goal 状态 chip 的文字)。
- 判断标准:用户会想"复制这段话"吗?会 → 可选;不会(它只是个控件)→ `select-none`。

### 14.2 焦点管理(focus)

- 弹窗 / 抽屉 / popover 打开时,焦点落到**首要输入框**(没有输入框则落主按钮),**不要**默认停在"取消"上。Radix 默认会聚焦第一个可聚焦元素 / Cancel —— 用 `onOpenAutoFocus`(`preventDefault()` + 手动 `focus()`)或 ConfirmDialog 的 `autoFocusConfirm` 覆盖。
- 关闭后焦点归还触发它的元素(Radix 默认行为,别破坏)。

### 14.3 键盘与输入法(发送型文本框)

适用于"敲完就发"的提交型文本框:聊天 composer、目标输入、ask 输入等。**不含**普通设置项里的单行编辑框 —— 那种 Enter 不应触发提交。

- **Enter = 提交**,**Shift+Enter = 换行**。
- **输入法组字期间的 Enter 不触发提交** —— 判 `event.nativeEvent.isComposing`(中 / 日 / 韩用户选字按的回车不能被当成发送)。
- 这套逻辑用代码统一,不要每个框各写一遍导致行为漂移(对应 `docs/dev-rules/maker-core-and-agent-behavior.md` 的「代码优先确定性」)。

### 14.4 动效与过渡(motion)

> 2026-07 扩写。Cindy 的动效性格承接 §1 / §7 的纸感与克制:**东西不飞不弹,只淡入、只轻推、只平滑改变尺寸**。允许功能性状态过渡,禁止装饰性动效;本节把"功能性"钉成可执行的档位与原型,避免各组件时长/曲线各自为政。

#### Motion token(唯一档位来源)

全局 token 定义在 `apps/desktop/src/renderer/styles/globals.css` 的 `:root`;移动端(`apps/mobile`)应在 `src/theme/tokens.ts` 落同名同值常量(双端同构,与颜色 token 的双端策略一致,随移动端动效改造落地)。**新增过渡/动画一律引用 token,不再硬编码时长与 cubic-bezier**;5 档时长 + 3 条曲线,与 §5 三档圆角同一哲学,档位之外的值先过设计评审。

| Token | 值 | 用途 |
|---|---|---|
| `--motion-instant` | 80ms | hover 即时反馈、轻浮层退场 |
| `--motion-fast` | 150ms | 颜色/透明度状态切换(`transition-colors` 即此档)、轻浮层入场 |
| `--motion-base` | 200ms | 尺寸变化:展开折叠、面板收展 |
| `--motion-enter` | 250ms | 重浮层(弹窗)入场 |
| `--motion-exit` | 150ms | 重浮层(弹窗)退场 |
| `--motion-ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | 入场/展开 |
| `--motion-ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | 退场 |
| `--motion-ease-move` | `cubic-bezier(0.4, 0, 0.2, 1)` | 位置/尺寸插值 |

#### 语义 → 动效原型(同一语义全 app 同一动效)

| 语义 | 规格 | 参照实现 |
|---|---|---|
| 轻浮层(menu / popover / tooltip) | 入 `animate-float-in`(opacity + scale 0.97→1,fast/ease-out;tooltip 纯 opacity 用 `animate-fade-in`),出 `animate-float-out`(纯 opacity,instant/ease-in)。**退场永远快于入场,退场不缩放**(缩放退场读作"被吸走",纸应该原地淡掉) | `components/ui/dropdown-menu.tsx` |
| 重浮层(modal / confirm) | 入 250ms 淡入+scale 0.95→1,出 150ms | `components/ui/confirm-dialog.tsx` |
| 展开/折叠 | base/ease-move,grid `0fr↔1fr` 高度 + opacity | `features/cc-agent/sidebar/SectionCollapse.tsx` |
| 列表重排 | FLIP,transform 平移 | `components/ui/toast/ToastContainer.tsx` |
| 按压 | `active:scale-[0.98]`(交互 pill / 按钮通用) | ConfirmDialog 按钮 |
| 完成 | **全 app 唯一允许 overshoot 的语义**(`status-done-pop`) | `globals.css` |
| 运行中 | opacity 呼吸,必须挂 HTML wrapper(AGENTS.md 规则 7) | `session-breathing` |
| hover / 状态色 | `transition-colors`,≤ fast(150ms) | 全 app 现状 |
| 容器形变(chip 长成弹层) | 220ms,见下方独立类目(显式例外) | composer 权限/模型选择器 |

#### 红线(性能与克制)

- **常驻/循环动画只允许 HTML 元素上的 `transform` / `opacity`**(compositor-only,AGENTS.md 规则 7 全文适用;SVG 上不挂任何动画)。
- 高度/grid 等非 compositor 属性只允许**一次性瞬态动画**(用户触发、有明确结束),不允许常驻。
- 新增 `@keyframes` / `animate-*` 类必须同步登记 `globals.css` 的 `prefers-reduced-motion` 白名单(全局 `* { transition: none }` 兜不住 keyframes)。
- 实时跟手的交互(resizer 拖动、拖拽跟随)**不加缓动**——跟手即反馈。
- 禁止:无意义位移、弹跳、视差、循环装饰动画、`transition-all`、给流式文本加打字机逐字动画(流式本身已是动效)。交互仍应"快、直接"。

#### 例外类目:容器形变(container transform,脱身上浮式)

- 2026-07-21 新增、2026-07-22 修订的第二类 sanctioned motion,专用于 composer 工具条上「chip 脱身上浮长成弹层」的开合(权限选择器 / 模型选择器 / + 菜单这类 trigger 即弹层锚点的控件):
  - **定义**:弹层不是"凭空浮现盖在 trigger 上",而是以 trigger chip 的精确几何(位置 / 尺寸 / 胶囊圆角 / pill 底色)为形变起点,一边生长一边**整体位移脱身**,最终停靠在 chip 的打开侧、与 chip 留 6px 间隙;关闭时反向缩回 chip。**trigger chip 全程可见、可交互** —— 面板打开后再点 chip 即关闭(保住"原地再点一下收起"的肌肉记忆)。曾试过"原位取代"式(chip 隐藏、面板占据原位),因丢失 toggle 关闭且时序复杂已废弃,不要回退。**开合两端均做与位移耦合的整体淡入/淡出**(面板与 chip 重叠的端部帧若不透明,会把 chip 内容盖没一下造成"按钮闪烁";淡入随上浮显形、淡出随缩回溶解)——禁止无位移的纯 fade-in/out。
  - **参数**:时长 **220ms**(开合对称,2026-07-22 自 300ms 调快定稿),缓动 `cubic-bezier(0.3, 0.9, 0.25, 1)`(快起步长缓收);菜单行淡入可带 ≤20ms/行 的错峰。这是 ≤150ms 基线的**显式例外**,仅限本类目,不得外溢到其它过渡。形变期间面板内容区必须禁滚(滚动条闪现会挤压行宽,行尾元素抖动),动画完成后再开自滚。
  - **圆角插值**:形变起点圆角写 chip 高度的一半(如 30px chip → 15px),**禁止写 9999px**(9999→12 的插值会让中途帧圆成一坨);终点为容器 12px。
  - **实现红线**:(a) 必须 `prefers-reduced-motion` 降级为直切;(b) 测量目标几何时必须临时禁用 transition(否则 offsetHeight 在宽度过渡第 0 帧按旧宽度排版,含换行文本时量出假高度);(c) 属一次性开合动画,不受"常驻动画 compositor-only"红线(`docs/dev-rules/engineering-conventions.md` §7)约束,但仍需在低端 Windows 实测 300ms 内不掉帧;(d) 焦点 / Esc / outside-click / 焦点归还语义与 §14.2 相同,形变不豁免任何 a11y 要求。
  - **适用边界**:仅限"trigger 长成弹层"的控件。普通 Dialog / ConfirmDialog / Toast / lightbox 不适用(它们没有 chip 锚点,维持现状)。窄变体(按钮宽度展开)仅允许**承载信息的展开**(如语音录音中的红点 + 计时,≤240ms);纯装饰性的 hover 展出文字标签(如 + 展出"添加")已评估并移除,不要再加。
- **composer 工具条控件两档 chrome + 会话内/新建对话框共用一套(2026-07-22 用户定稿)**:
  - **变形下拉档(+/权限/模型)**:静息**裸态无框**(`border border-transparent bg-transparent`),hover 才浮现胶囊外框(`hover:border-[var(--border-default)]` + `composer-pill-bg`);选中/危险档只染文字色,不改底。
  - **常驻工具档(语音/发送)**:常驻外框 / 实心 CTA(语音 `composer-pill-bg`+`border-default`,hover `model-trigger-hover`,录音态 `surface-chip` 填充+红点计时展开;发送 `send-btn-*` 中性反相实心)。
  - **会话内(default)与新建对话框(create-agent)必须逐字一致**:两处共享控件(+/权限/模型/语音/发送)不再按 `visualVariant` 分叉样式,`create-agent-control-*` / `create-agent-send-*` 不得再用于这五个控件(仅剩新建对话框独有的 Claude|Codex 分段切换、顶部 模式/项目/分支 pills 继续用 create-agent 私有 token)。改任一控件的 chrome,两端一起改。合同测试 `newMakerCreateAgentVisualContract.test.ts` 守此不变量。
- **限额重置撒花(quota reset confetti)** —— 2026-07-23 用户拍板新增的第三类 sanctioned motion,**仅限**状态栏用量 chip 的「限额窗口重置揭晓」时刻(倒计时归零 → 悬念期「重置中…」→ 新快照落地):
  - **定义**:新快照确认重置的一瞬间,以**正在揭晓的窗口段中心**为原点撒一次花,与剩余百分比 0%→100% 滚动同时开始 —— 把"额度回来了"做成一个可感知的庆祝点。
  - **形态**(用户四/五轮拍板 2026-07-23):**真实抛物线上抛 + 落地即隐** —— 全部粒子同时从段中心以约 **100° 扇形**(正上方 ±50°)同速率抛出,**水平匀速 + 垂直恒定重力**(上升恒减速、过顶点恒加速回落),从爆出到下落全程速度感一致;角度大的粒子弧低、飞得远、先落地,错落由物理自然给出。落到地面线的最后一小段以**短渐隐**消失:可以落地,但禁止落定后停留("躺尸")或不带渐隐地突然消失;地面线带随机抖动,落点不排队。
  - **参数红线**:一次性庆祝,同时起飞、无错峰 delay;单粒时长由弧高物理决定并 clamp 进 0.9s-1.6s、总时长约 1.6s 收尾(数字滚动 1.2s 站定后纸屑再落零点几秒;弧尺度与节奏为用户微调定稿 2026-07-23);粒子 ≤18 颗、3-5px,放完即拆,不循环不常驻;粒子为 HTML 元素、只动 `transform` / `opacity`(compositor-only,工程规范 §7;x/y 分离在两层 span 上实现匀速水平);颜色仅取「小状态点 hue 豁免簇」四色(done 绿 / awaiting 青 / thinking 橙 / error 红),light/dark 同值;必须 `prefers-reduced-motion` 整体跳过。
  - **适用边界**:仅此一处。撒花不得外溢到任务完成、发送成功等其它时刻 —— 那些场景维持 §14.4 基线(需要新豁免必须回到本节逐条新增)。实现见 `apps/desktop/src/renderer/components/status/QuotaResetConfetti.tsx`。


## 15. CINDY 皮肤族(品牌化可选 family)

> 本节为 CINDY 皮肤族的规范记录,**不改写 §1-7 默认皮肤规范**。值的权威来源:
> `skin-docs/10-specs/` 桌面端体系、`skin-docs/30-mobile/2026-07-18-m0-color-mapping.md`
> 移动端勘误版,以及 2026-07-18 双端验收后的用户最终口头定稿。实现时零自由裁量。

### 15.1 色板(Figma 文本节点提取)

| 语义 | Light | Dark |
|---|---|---|
| 品牌红 | `#DF0C27` | `#DF0C27` |
| 品牌深红(hover/pressed) | `#A61629` | `#A61629` |
| 背景 | `#EDEDED` | `#2A2828` |
| 卡片/输入框 | `#F8F8F8` | `#312F2F` |
| 边框 | `#DCDFE3`(desktop;mobile light 为全局例外 `#C6C9CE`,见「双端颜色同构」) | `#434343` |
| 二级信息 | `#8C8E94`(用户调参 2026-07-20,自 Figma `#9A9DA3` 两轮加深) | `#6F6F6F` |
| 正文 | `#3C3F43` | `#D4D4D4` |
| 纯白 | `#FFFFFF` | `#FFFFFF` |

### 15.2 三份红 exact map(品牌红边界)

- **BRAND_RED_EXPECTED_BY_ID**(必须等于品牌红/深红):`accent-cta-bg`/`accent-cta-bg-pure`/`accent-emphasis`/`confirm-btn-primary-bg`/`perm-allow-btn-bg`/`update-btn-border`/`update-btn-text`(均 `#DF0C27`);`primary`(HSL,RGB 归一等价品牌红)。`sidebar-item-active` 已于 2026-07-20 随反相胶囊定稿退出红 map(见 §15.10 勘误);`migration-bar-fill` 已随主干迁移条退役移出(2026-07-19)。
- **BRAND_RED_ALLOWED_IDS**(允许含红全集 = EXPECTED ∪ 派生):上述 + `accent-soft`/`accent-hover`/`confirm-btn-primary-hover`/`settings-btn-primary-bg`/`settings-btn-primary-border`/`settings-btn-primary-hover-bg`。`drop-overlay-bg` 已于 2026-07-19 撤红移出名单(见 §15.13 C 类勘误)。
- **CTA_FOREGROUND_WHITE_IDS**(红底白前景):`accent-pure-cta-fg`/`confirm-btn-primary-text`/`perm-allow-btn-text`/`primary-foreground`/`settings-btn-primary-text`。

单向禁止:`ALLOWED` 之外任何 token 出现 `#DF0C27`/`#A61629` = 测试红。

### 15.3 插值表(sRGB 每通道 `round(A+(B-A)*t)`)

详见决策表 §2。Light/Dark 各 20/40/65/75% 档已冻结精确值进单测(`#EFEFEF/#F1F1F1/#F4F4F4/#F5F5F5`、`#2B2929/#2D2B2B/#2F2D2D/#2F2D2D`)。

### 15.4 豁免(不纳入 CINDY 覆盖,跨主题统一)

- 语义色:`warning-accent` `#EA6B17`(定稿 2026-07-17,取代 `#FF6600`)/ `annotation-accent` `#FF3B30`(图片标注烧录笔迹色,语义豁免,不改)/ `status-bar-accent`(alias warning orange,自动跟随)。
- 状态四色(设计定稿 2026-07-17,取代冻结红线;全局 light/dark 同值,9 主题无 override 自动跟随):running `#EA6B17` / awaiting `#19D2C1` / error(状态族)`#D91F37` / done `#2AAE5B`;warning 前景 `warning-fg` `#F3A115`(与 Toast amber `#F59E0B` 解耦,Toast 维持 B 组现状)。
- `focus-ring` `#417CDD`(蓝,E5D 定稿 2026-07-17 取代 #3b82f6,不染红);diff 红绿;modal scrim/阴影;`overlay-lightbox`;Toast 四色定稿(豁免解除)。
- `destructive`/`search-match-bg` 语义色不纳入 HSL_FORMAT_IDS 覆盖。
- **hljs 语法高亮色**(light=highlight.js/styles/github.css;dark=globals.css `.dark .hljs-*` mirror github-dark):hljs 主题色为 default 代码块底设计,CINDY 代码块底(surface-elevated #F8F8F8/#312F2F)接近 default(#ffffff/#2c2c2a),边缘不达标(light -keyword 4.31/-built_in 3.29/-name 4.36;dark -punctuation 2.47/-tag 2.99/-section 2.87)是 hljs 既有折损(用 design surface 而非 github 默认 #ffffff/#0d1117),非 CINDY 引入——default 同源也不达标。CINDY 不补 [data-theme] 整改(与 default 同源,补整改值需重新过用户关卡);落档见 cindyCodeBlockContrast.test.ts(≥2 基线 + text ≥4.5 守卫)。
**双门槛口径(D 裁决 2026-07-17)**:hljs 语法高亮色属辅助性视觉编码,对齐 selection/边界 3:1 口径——语法色 ≥3:1、正文文本 ≥4.5:1。CINDY 代码块底(surface-elevated)接近 default,hljs 主题色为 github 默认底(#ffffff/#0d1117)设计,固有折损非 CINDY 引入(default 同源)。
- light:语法色全 ≥3(4.31/3.29/4.36),<4.5 但 ≥3 门槛通过,**不整改**,逐项落豁免档(default 同源折损);
- dark:`.hljs-section` #1f6feb × #312F2F = 2.87 <3,补 `[data-theme="cindy-dark"] .hljs-section` 提亮 `#2573ec`(保持蓝 H212 S84% L52→53.5%,× #312F2F=3.00 ≥3);`.hljs-punctuation`/`.hljs-tag` github-dark "purposely ignored" 无显式色,dark 继承 .dark .hljs text `#c9d1d9`(× #312F2F=8.62 ≥3 达标),补 `[data-theme="cindy-dark"]` 显式覆盖 `#c9d1d9` 防御性(D 裁决三项覆盖,值同 text 不降对比度)。
- model-budget 光谱条 / GhostTool shimmer:显式豁免(中性 shimmer,跨主题统一)。

### 15.5 U2 显式例外记录(二级信息色忠于 Figma 原值)

- token:`text-secondary`(light `#8C8E94` / dark `#6F6F6F`)/ `text-secondary-cross`(light 仍 `#9A9DA3`,未随调)。
- 改值史:light 原 Figma `#9A9DA3`(U2 忠于原值)→ `#919399` → `#8C8E94`(用户两轮调参定稿 2026-07-20,桌面 cindy-light 与移动 tokens.ts 同步);dark 不变。对比度仍低于 AA,沿用 U2 显式例外口径。
- 实测对比度(WCAG):× surface `2.32/2.92:1`、× elevated `2.56/2.65:1`、× chip `2.41/2.72:1`,均低于普通文本 AA `4.5:1`。
- 裁决:用户 **U2(2026-07-16 拍板)=(b) 忠于 Figma 原值**,接受可读性折损,作为记录在案的显式偏离。
- 约束:**不得擅自调深**(如 `#686B72` 已证伪且仅存档备查),改值须重新过用户关卡。
- 反向冻结单测:`cindyThemes.test.ts` 第 ⑦ 组断言该值必须恰等定稿值(light `#8C8E94`/dark `#6F6F6F`),注入 `#686B72` 必须变红;改值须过用户关卡后同步基准。

### 15.6 HSL 格式合约

42 个 `HSL_FORMAT_IDS` 必须 HSL 三元组(`h s% l%`,`h∈[0,360)`、灰色 `hue=0`、1 位小数);其余 token 走 hex/rgba。round-trip HSL→RGB 通道误差 ≤1。HSL_FORMAT_IDS 之外不得误填 HSL 三元组。

### 15.7 品牌标识资产(icon + logo)

新建对话页品牌区按 2026-07 新设计固定为 50×50px 方形 icon + 110×37.5px 横向 logo,间距 9px。`ThemeBrandLockup` 是新建页的唯一渲染实现。主题只通过 `theme.brand.icon/logo` 替换素材,不得通过 scale 改变定稿版式;本地图片透明留白按 alpha 可见边界在加载期裁切,不改写源文件。cindy-light 用黑字版(`cindy-logo-light.png`)、cindy-dark 用白字版(`cindy-logo-dark.png`)作为 logo。

新版品牌区只读取 `brand.icon/logo`,不兼容旧顶层 `logo`、`logoScale` 或开发过程中的 `brand.mark/wordmark`;旧配置与新版组合结构语义不同,禁止猜测映射。「设置 → 外观」只保留本地主题副本、打开目录和刷新三个轻量入口,不放品牌预览或素材选择器。新导出的标准 JSON 在 `brand.icon/logo` 中直接放 `icon-square-50x50px.png` / `logo-horizontal-110x37.5px.png` 示例路径,让配置文件自身同时说明用途与最终显示区域;源图可按同宽高比导出 2x/3x。不另生成 README 或改用 JSONC。

> logo 资产红 `#F70121` 是官方品牌资产固有色(WORD MARK frame 红箭头符号),与 UI 品牌红 `#DF0C27` **并存、不同值**——logo 是图片资产不进 token 体系,保持原色不改色。后人勿误改为 `#DF0C27`。

Splash 品牌块字标是另一套素材(`assets/splash/wordmark.png` 白字 DARK 用 / `wordmark-light.png` 深字 LIGHT 用),2026-07-22 起两版统一为 459×156(@2x),渲染框 `229.5×78` 恰为其 2x 满框——此前白字版为 486×184,塞同框被 object-contain 缩小 ~10%,DARK 字标偏小(用户实机发现,已换图修复)。同日用户拍板:splash 字标 DARK/LIGHT **均不带投影**(原 `drop-shadow-[0_2px_6.5px_rgba(0,0,0,0.25)]` 移除),冻结测试 `SplashScreen.test.tsx` 已同步反向断言。

### 15.8 status-badge-fg(§7 必炸点,用户确认 2026-07-17)

橙徽章(bg `status-bar-accent` `#EA6B17`,设计定稿 2026-07-17 取代 `#FF6600`)此前借用 `accent-pure-cta-fg`(白字)→ `#FFFFFF`×`#FF6600`=2.94:1 不达标(历史值,旧橙 #FF6600)。拆独立 `status-badge-fg`:
- **default 镜像 `accent-pure-cta-fg`**(light 白 / dark 黑),既有 9 主题行为零变化;
- **CINDY 两模式 override `#1F1F1F`**(深色近黑),× `status-bar-accent` `#EA6B17` = **5.19:1 ≥4.5**(用户亲批方案 #1F1F1F;设计定稿 2026-07-17 新橙 #EA6B17 实算 5.19:1,取代旧 #FF6600×5.61:1;不达 4.5 则加深 #000000);
- 覆盖数组 115→116(`cindyDecisionData` 注明 D2 期新增,源自 §7 必炸点方案);
- 消费点(`ContactsListPane:150`)从 `accent-pure-cta-fg` 切到 `status-badge-fg`;红 CTA 上的 `surface-on-card` 消费者(`RolePillDropdown:543/544`、`SkillhubDetailView:504`)迁到 `accent-pure-cta-fg`(白),`surface-on-card` 保留中性反相(Fast toggle thumb)。

### 15.10 E1D 红色体系重构(用户批准 2026-07-17)

常规主操作不再用品牌红,改反相中性(light 底 `#3C3F43`/字 `#FCFCFC`,dark 底 `#EEEEEE`/字 `#252222`;WCAG 10.32/13.60:1)。红色仅限语义例外:
- **A 类(保留红)**:`brand-login-bg`/`brand-login-error-border`/`brand-login-error-text`(品牌海报/错误);
- **C 类**:~~`sidebar-item-active` 红胶囊~~ 已于 2026-07-20 撤红改**反相胶囊**(light 深底 `#3C3F43`+浅字 `#FCFCFC`/dark 浅底 `#EEEEEE`+深字 `#252222`,描边 transparent,与 CTA 反相中性同族;用户三轮改稿定稿,PR #174/#190 落地);~~`migration-bar-fill`~~ 已随主干迁移条退役(2026-07-19,token 已删非撤红);~~`drop-overlay-bg` 红10%~~ 已于 2026-07-19 撤红(用户实机否决:整窗红罩语义似警报,回落 default 中性灰遮罩);
- **语义色**:`destructive`/delete、`error-*`、warning、diff 红、status 点;
- **B 类(改中性 11 项)**:`accent-cta-bg`/`-pure`/`-emphasis`/`-soft`/`-hover`、`update-btn-border`/`-text`、`confirm-btn-primary`、`perm-allow-btn`、`primary`、`settings-btn-primary`(alias)、`accent-pure-cta-fg`/`settings-btn-primary-text`(中性字);
- **C 类裁决**:confirm(普通中性,danger 另设)、perm-allow(中性,警示橙 chip)、primary(中性)、sidebar-item-active(light 红胶囊/dark 深红)、migration-bar-fill(保留红)、drop-overlay(原保留红10%,2026-07-19 撤红改中性)、brand-login-cta(不动);
- **中性按钮四态**:light 底`#3C3F43`/字`#FCFCFC`、hover`#2E3237`、pressed`#25282C`;dark 底`#EEEEEE`/字`#252222`、hover`#E2E2E2`、pressed`#D4D4D4`。
- **send-btn 族纳入值表(E1D 扩,lead 裁决 2026-07-17)**:`send-btn-bg`(default alias `--accent-cta-bg`)/`-icon`/`-hover-bg`/`-pressed-bg`/`-disabled-bg`/`-disabled-icon` CINDY override 全族走上述四态反相中性 + disabled 灰 `#444242`/`#585555`(R4 D1 实证);hover/pressed 为 E1D 新增 token(default 同 bg,默认皮肤维持 opacity-85 hover,膘叔 E3 组件层消费 var() 即全局生效);全族入 cindyDecisionData REQUIRED_IDS + CINDY_EXPECTED,③ 断言守。
- **侧栏颜色层级整改(E1D 扩,用户并排指错 2026-07-17,lead 钉死 light/dark 同套)**:
  - 正文(会话标题)= `text-foreground`(=`text-primary` light `#3C3F43`/dark `#D4D4D4`,不动);
  - 二级暗灰(行首图标普通态/时间戳/meta/分组标签)= light `#9A9DA3`/dark `#6F6F6F`(与 `text-secondary` 同值);CINDY override `sidebar-muted`/`sidebar-action-icon`(HSL `220.0 4.7% 62.2%`/`0 0% 43.5%`)+ 新增 `cmd-palette-item-meta` CINDY override(hex);
  - 选中胶囊 = 反相胶囊(2026-07-20 定稿):`sidebar-item-active` light `#3C3F43`/dark `#EEEEEE`,前景 `sidebar-item-active-foreground` light `#FCFCFC`/dark `#252222`,描边 `sidebar-item-active-border` transparent;**凡 `bg-sidebar-item-active` 上的前景必须配 `text-sidebar-item-active-foreground`,禁用 `text-foreground`**(PR#190 全量整改,该 token 缺省=foreground,非 CINDY 零变化);
  - 强调行(running)行首图标(厂商 glyph/Puzzle/RadioTower/Clock)= **Thinking Orange `--warning-accent` `#EA6B17`**(用户拍板 2026-07-20,取代红系时期规则),呼吸动画 `session-status-breathing`;**选中态同样橙(running 取色优先级高于反相前景)**;移动端 `statusAccent` 同值同规则。常驻呼吸动画必须挂 HTML wrapper,SVG 保持静态(常驻动画 compositor-only 红线,见 `docs/dev-rules/engineering-conventions.md` §7;PR#226 治理)。
  - 断言:③ CINDY_EXPECTED 守 4 token 值;⑦ 新增层级断言(二级暗灰 contrast 明显弱于正文 + 选中胶囊前景×红底 ≥4.5)。
- **backlog(R2 §4.3 五点差异,lead 裁决 2026-07-17 本轮不做,入 backlog)**:Project_List 三态拆分(active-task-pill/project-card/flat-list-row 不共用 `sidebar-item-active`);项目 header/list card 选中应中性底(#312F2F/#F6F6F6 非 #DF0C27 大红);去 Project_List 选中组 `focus-ring-soft` 蓝 ring,改 card stroke #DCDFE3/#434343;小箭头 #A61629 强调(非整行红底)。详见 `2026-07-17-r2-ui-specs.md` §4.3。本轮收敛不扩战线,后续另开。

三份新 map(`NEUTRAL_PRIMARY_EXPECTED_BY_ID`/`FOREGROUND` + `RED_EXCEPTION_ALLOWED_IDS`)替代旧 `BRAND_RED_*`。D2T ⑤/⑦/⑧ 改用新 map(中性 exact + 红例外白名单 + 中性对比度 + 可证伪)。

### 15.11 caret-accent 光标(用户二次改稿 2026-07-18 定稿:蓝,跨端规则)

> 决策史:07-18 日间"光标品牌红 #DF0C27"→ 07-18 晚**红 caret 定稿已被用户覆盖为蓝 `#417CDD`,双端一致**。以下为现行有效版本,历史文档中"caret 品牌红"表述一律作废。

- 全部可编辑输入面的光标(caret)统一消费 `--caret-accent` token——globals.css 已全局接管(原生 `caret-color` + ProseMirror 伪光标),**组件内不许另设 caret-color**。
- 取值:default 主题 = `var(--accent-cta-bg)`(中性反相,随主题走);**CINDY 两模式 override `#417CDD`**(与 focus ring 同值的信息蓝;已从 `RED_EXCEPTION_ALLOWED_IDS` 红例外白名单移除,`cindyDecisionData.ts` 断言锁值)。
- **易踩点**:①光标不再是红——红色白名单里没有光标,不要把 caret 接任何红 token;②虽然值与 `--focus-ring` 相同,**不要**把 caret 直接接 `--focus-ring`——语义不同,光标唯一合法出口仍是 `caret-accent`(便于日后独立调整)。
- **跨端对齐**:移动端(`apps/mobile` `src/theme/tokens.ts` 的 `inputCaret`)同值 `#417CDD` 双模式,RN 侧经 TextInput `cursorColor`/`selectionColor` 消费,`themeTokens.test.ts` 锁值。

### 15.12 毛玻璃(vibrancy)体系(用户定稿 2026-07-18,macOS)

- **唯一半透面 token**:`surface-translucent-sidebar`——CINDY light `rgba(255, 255, 255, 0.85)` / dark `rgba(18, 15, 15, 0.75)`(default 主题下 = `var(--surface)` 不透明,非 CINDY 主题零影响)。消费方为左侧栏(`aside.bg-sidebar`);后续新增半透明表面**默认复用此 token**,不另造 rgba 值。splash 根容器已于 2026-07-19 改为不透明 `--surface`(用户拍板:加载完成前必须完全遮盖底下已挂载的主界面,不再共用半透 token)。
- **透壁纸三重管线,缺一即死黑**(2026-07-18 实机 A/B 实证,详证据见换肤工程 sidebar-glass 补编终稿追记):
  1. **窗口创建期**即设 `backgroundColor: '#00000000'` + vibrancy(`bootstrap-electron.ts` / `vibrancyConfig.ts`);运行时再 setBackgroundColor 改 alpha 不可靠。
  2. CINDY 主题下**根容器让路**:globals.css 把 `.h-screen.bg-content-area`(及 splash 在场垫层)置 transparent,否则整窗不透明垫底挡死。
  3. **禁止 CSS `backdrop-filter`**——它会把透明窗背衬渲染成黑箱;壁纸模糊完全由原生 vibrancy 材质负责,CSS 层只铺半透底色。
- 材质经 `XDT_VIBRANCY_MATERIAL` 环境旋钮选择,**代码缺省 hud**(用户实测定稿,2026-07-19 由 sidebar 回写为缺省值)。Windows 侧 Win11+ 走 `backgroundMaterial`(缺省 acrylic,`XDT_BACKDROP_MATERIAL` 旋钮,未经实机验证);Win10/非 CINDY 回退不透明 `--surface`。
- 半透面上**不叠渐变覆盖层**——浅色红渐变层 2026-07-18 经用户确认设计稿无此元素,已整层砍除;splash 的渐变辉光层同样未实现(backlog 待用户表态)。
- `surface-translucent-sidebar` 的 alpha 是主题冻结区**唯一开放的观感旋钮**,调整必须三处同步(`cindy-light.ts` / `cindy-dark.ts` / `cindyDecisionData.ts`)且 themes 套件跑绿。

### 15.14 running/协同 橙色体系(用户拍板 2026-07-20)

- **running 呼吸图标一律 Thinking Orange**(`--warning-accent` `#EA6B17`,全主题同值):VendorIcon、SessionStatusIcon(Puzzle/RadioTower)、AutomationSessionGroupItem(Clock);选中态也橙,优先级 running > 选中反相前景 > 普通态。移动端 `statusAccent` 同值同规则(glyphColor 同优先级)。
- **协同按钮 ON 态橙**:CollaborationModeToggle 开启态文字+Puzzle 图标 `warning-accent`(覆盖 2026-07-17「composer pill 去橙中性」规范,仅 ON 态;OFF 入口态保持中性)。
- **SVG 常驻动画红线**:呼吸类常驻动画一律挂 HTML wrapper(span),SVG 保持静态。

### 15.15 新建页内容区定位 + 顶栏 hover 消费纪律(用户拍板 2026-07-21)

- **新建页(CREATE AGENT)内容组垂直定位**:距**窗口顶**恒为 `max(96px, 28vh) + 46px`。
  实现 = 路由容器 `pt-[calc(max(96px,28vh)+46px-var(--content-header-h,46px))]`:
  - 268px 封顶已废(Figma 定稿画框高度遗留,大窗口下内容"偏高"的根因);28% 为用户实机调参定稿(原 25.5%);
  - `--content-header-h` 由 `ContentHeaderSlot`(FeatureSidebarSlotProvider 内)经 display:contents 包裹层广播(顶栏渲染 46px / 隐藏 0px,与 ContentHeader `h-[46px]` 同源)——选中项目引发顶栏显隐时内容区**零跳动**,恒定在"有顶栏时"位置;
  - 顶栏显隐判定单一决策源 = `useContentHeaderHidden`(mac + Sidebar 展开 + 无注入内容 + 无右栏开关,沿用 2026-06-11"空 header 隐藏"决策);
  - 守卫:`newMakerCreateAgentVisualContract` 锁定位公式 + 防回退断言。
- **hover token 消费纪律**:`--update-btn-hover` 是升级按钮(反相深色 CTA)专用 hover,**禁止**用于普通 ghost 按钮/徽章(CINDY light 下近黑 `#2E3237`,吞字吞图标;2026-07-21 清理 6 处误用)。正确选型:
  - 顶栏(ContentHeader 一带)ghost 元素 → `titlebar-button-hover`(与 ChromeActions 窗口按钮组同款);
  - 内容区通用浅 hover → `--surface-hover`。

### 15.13 CINDY 双端换肤定稿规则(2026-07-18)

本节是后续桌面端 / 手机端 UI 更新的执行规则。若本节与上方历史小节有冲突,以后续用户验收定稿为准;不要按早期红 CTA / 红 caret 口径回退。出处见 `skin-docs/10-specs/`、`skin-docs/30-mobile/2026-07-18-m0-color-mapping.md`、`skin-docs/30-mobile/2026-07-18-m3-chat-tasksheet-impl-plan.md`。

#### 红色边界

- 品牌红 `#DF0C27` 只用于品牌展示 / splash、破坏性操作、运行 / 思考状态强调、列表 active glyph。列表 active glyph 在 dark 使用 `#A61629`。
- 普通 CTA、FAB、发送钮、确认类主操作一律使用中性反相:light 底 `#3C3F43` / 字 `#FCFCFC`,dark 底 `#EEEEEE` / 字 `#252222`。禁止把这些操作染成品牌红。
- 红色白名单不包含输入光标、focus ring、普通按钮、普通选中态背景。新增红色消费必须先写明语义并进入对应 token / 测试白名单;不能在组件中硬编码。

#### 光标与焦点

- 所有输入光标 `cursorColor` / `selectionColor` 统一为蓝 `#417CDD`,等于 `permAutoAccent` / Mac `caret-accent`;light / dark 同值。
- focus ring、Auto Approval、信息蓝同属 `#417CDD` 体系。Figma 旧蓝 `#426BF2` 不采用。
- 禁止红色系光标。备注:2026-07-18 早前红 caret 口径已于同日晚被用户最终定稿覆盖。

#### 双端颜色同构

- 手机端颜色语义必须与桌面端 token 决策表同构:主背景、正文、二级信息、边框等基础层级按 CINDY desktop 语义直映,不要为移动端另造一套相同含义的颜色。
- **`colors.border` light 是 mobile 全局例外,不是首页 scoped token**(裁决记录 2026-07-21,PR #266):mobile light `border` / `borderTranslucent` 取 `#C6C9CE` / `rgba(198,201,206,0.62)`,偏离 desktop `#DCDFE3`。原因:desktop 边框多衬 `#F8F8F8` 卡片,而 mobile 分割线直接衬 `#EDEDED` 主背景,`#DCDFE3` 对比仅 1.14:1 几乎不可见,加深到 1.42:1 后实机可辨。该值落在 `apps/mobile/src/theme/tokens.ts` 全局 `lightColors.border`,所有 mobile light 边框 / hairline 消费方一体生效;dark 维持 `#434343` 与 desktop 同构。`chatCodeBorder` / `sheetActionBorder` / `sheetGrabber` 等专用边框 token 独立取值,不随本例外联动。
- 移动端专用 token 只承载移动端特有层级或几何语境:

| Mobile token | Light | Dark | 用途 |
|---|---|---|---|
| `surfaceListRow` | `#F6F6F6` | `#312F2F` | list 项目行 / 任务行 |
| `surfaceListExpanded` | `#EAEAEA` | `#2A2828` | list 展开块 |
| `activeGlyph` | `#DF0C27` | `#A61629` | list 行首 active glyph |
| `chatCodeSurface` | `#F8F8F8` | `#353333` | chat / task code card |
| `chatCodeBorder` | `#DCDFE3` | `#3C3C3C` | chat / task code card 边框 |
| `inputCaret` | `#417CDD` | `#417CDD` | 所有输入光标 |
| `sheetSurface` | `rgba(248,248,248,0.95)` | `rgba(59,59,59,0.95)` | bottom sheet root |
| `sheetActionSurface` | `#F6F6F6` | `rgba(59,59,59,0.5)` | sheet action group / row |
| `sheetActionBorder` | `#DCDFE3` | `#505050` | sheet action group / row 边框 |
| `sheetActionText` | `#3C3F43` | `#C1C1C1` | sheet action row label |
| `sheetGrabber` | `#DCDFE3` | `#6F6F6F` | sheet / composer grabber |

#### 图标规范

- 会话行首 Agent 图标按运行时身份区分:Claude Code 官方像素脸 / Codex CLI `>_` 多瓣花,Mac(`VendorIcon`)与移动端(`MobileVendorIcon`)同源资产(2026-07-20 定稿)。Agent 身份 mark 不得与 Anthropic / OpenAI provider 或 model brand mark 混用;`BrandArrow` 仅保留给品牌装饰场景。
- 模型选择按 model brand 出图。Mac 已替换过的品牌图标,移动端直接复用同源资产;其余使用现有图标库(lucide)中语义等价的图形。
- 发送语义统一使用填充纸飞机 `Send`,颜色跟随中性反相 CTA token;不要用红色发送按钮或红色发送图标表达普通发送。

#### 排版与布局要点

- List 页采用卡片化密度:20pt gutter、60pt 行高、12pt 圆角、55pt FAB。不要回退到旧的松散列表或红色普通 CTA。
- Chat 顶栏使用毛玻璃 / 半透明玻璃体系:优先复用 `BlurBackdrop` 与专用 chat header token;未接线 blur 的位置使用半透明实色 token + hairline,不要新增未经验证的 blur 接入点。
- Sheet 系统一致使用 sheet token。共享 `SheetSurface` 等组件改新样式时默认走 variant 隔离,只让设计稿覆盖到的 tasksheet / `SessionActionSheet` / `SessionMenuSheet` 使用新样式;ContextSheet、ModelPicker、info sheet 等未覆盖页面不自动跟随。
- 展开块内部使用 hairline 分隔:非末行有线,末行无线;边框颜色走对应 token,不要写死(mobile light 全局 border 例外口径见上方「双端颜色同构」的 `colors.border` 条)。

#### 流程门禁

- 新增 / 修改颜色必须走 token,桌面端走 ColorRegistry / CSS variable,移动端走 `ThemeColors` / `useTheme`;组件里禁止硬编码 hex / rgba。
- `hardcoded-color-audit` 必须全绿才允许合入。若因资产固有色或平台语义确需例外,必须登记白名单并说明原因。
- 设计稿与既有 token 冲突时,先在规格或 PR 说明中列出"待拍板"并请求裁决;不得自行定案或用相近色偷换。
- 共享组件样式改动默认用 variant / prop 隔离影响面。设计稿没有覆盖的页面、状态、平台,默认保持现状。

## 16. Login Flow (登录链路)

> 本节是登录全链路的设计系统规范。逐参数权威 = 同目录的 [`figma-component-spec.md`](./figma-component-spec.md)（组件 / 色板速查，nodeId 溯源）与 [`token-decision-table.md`](./token-decision-table.md)（token / 尺寸决策）——两份自 2026-07-24 起随 `docs/design-rules/` 入仓维护；`DESIGN-login`（逐屏规格）、`flow-map`（状态机）、`fidelity-matrix`（保真度验收矩阵）仍为设计阶段工作文件，不入仓库。本节不重复抄全表，只钉死设计规则与组件契约，逐参数值以 Figma 组件库及本节色板表为准。
>
> **交付状态**：**亮色** as-built 已合并入 main；**深色**为目标规格（色值经 Figma 组件库 Dark symbol 逐个核验，见 §16.1 双态表 / §16.5），token 已注册但 dark 槽位当前为 light 占位值，待实现 PR 填入真实深色值。两模式均受 §2「Light / Dark 双模式交付门槛」约束——非可选愿景。
>
> 本节独立于 §1–§15 默认皮肤与 CINDY 皮肤族——登录页是独立白底 / 深底反色体系，**不消费编辑器主题的 `--surface` / `--text-*` 等 slot**，只走本节定义的 `--login-*` token（light / dark 二态已注册于 `apps/desktop/src/renderer/themes/colors.ts`；见 §10）。`--login-*` 随基础 light / dark **二态**切换，但**不跟随具体扩展主题**（登录页只认 light / dark 模式；首次亮、后续跟随见 §16.5）。

### 16.1 视觉风格

登录页是**黑白反色**体系（亮色 = 白底墨字 / 深色 = 深底米字），与编辑器主界面解耦，亮 / 深两模式镜像同构：

- **面板 / 控件走墨黑–米白反色，深色镜像反相**：亮色白面板 `#FBFBFB` + 米白控件 `#EEEEEE` + 墨黑主按钮 `#2A2828`；深色反相为深面板 `#312F2F` + 深控件 `#2C2A2A` + 白主按钮 `#EEEEEE`。**两模式的面板 / 控件底色与文字都不出现纯黑 `#000` 或纯白 `#fff`**（`figma-component-spec §1.1`）；细描边例外——暗色主按钮 / 圆钮的 `#FFFFFF` 白边为 figma `white_button` 实测值，不受此限。
- **品牌红 `#DF0C27` 只用于 Global pill 与字标红元素等品牌 accent，跨模式不变**；**禁止作页面背景**（wave4 改判，见 `token-decision-table §3` 对 `#df0c27` 的语义判定），不渗入面板内部（呼应 §15.10 红色边界）。画布底走 `--login-bg-base`（亮 `#EDEDED` / 深 `#1F1F1E`），红只经 `--login-brand-accent` 消费。错误红 `#D91F37` 同样跨模式不变（语义豁免，呼应 §10 豁免族）。
- **`--login-*` 调色板双态目标值** —— token 已注册于 `apps/desktop/src/renderer/themes/colors.ts`（dark 槽位当前为 light 占位值）。下表为深色实现的目标规格，经 Figma 组件库 Dark symbol 逐个核验；实现 PR 须将 dark 槽位更新为本表 dark 列的值：

| token | light | dark | 核验源 |
|---|---|---|---|
| `--login-panel-bg` | `#FBFBFB` | `#312F2F` | callback-card dark（as-built）|
| `--login-panel-border` | `#D4D4D4` | `#434343` | callback-card dark |
| `--login-control-bg`（输入框底） | `#EEEEEE` | `#2C2A2A` | figma `Dark_normal` 输入 symbol |
| `--login-action-control-bg`（方式行 / 返回钮底） | `#EEEEEE` | `#2A2828` | figma 549:850 / 549:897（暗色与输入框底分化，组件库更新 2026-07-23） |
| `--login-back-border`（返回钮描边） | `#FFFFFF` | `#434343` | figma 549:897 |
| `--login-control-border` | `#D4D4D4` | `#434343` | figma `Dark_normal` |
| `--login-control-border-active`（focus / filled） | `#2A2828` | `#EEEEEE` | figma `Dark_highlight` |
| `--login-control-text`（输入填充字，Bold） | `#252222` | `#EEEEEE` | figma Dark 填充 / error 态 |
| `--login-control-placeholder`（空态字） | `#D4D4D4` | `#6F6F6F` | figma Dark 空态 |
| `--login-title-text` | `#252222` | `#D4D4D4` | callback-title dark |
| `--login-secondary-text`（副标题 / 倒计时） | `#6F6F6F` | `#6F6F6F` | 两模式同值 |
| `--login-primary-button-bg` | `#2A2828` | `#EEEEEE` | figma `white_button` / callback-cta dark |
| `--login-primary-button-border` | `#434343` | `#FFFFFF` | 同上 |
| `--login-primary-button-text`（Bold） | `#D4D4D4` | `#2A2828` | 同上 |
| `--login-link-text`（重发链接） | `#2A2828` | `#EEEEEE` | figma `dark_重新发送` symbol |
| `--login-link-hover` | `#4A4848` | `#A8A8A8` | 推导值（无独立 dark hover symbol） |
| `--login-link-pressed` | `#1A1818` | `#C0BEBE` | 推导值 |
| `--login-disabled-button-overlay` | `rgba(255,255,255,0.7)` | 同 light | figma `white_button` Disable：disabled 两模式同构（见 §16.5） |
| `--login-splash-progress-track` / `--login-splash-progress-fill` | `#D9D9D9` / `#252222` | `#434343` / `#D4D4D4` | figma Dark symbol 核验 |
| `--login-loading-ring-track`（loading 环轨道） | `rgba(42,40,40,0.18)` | `rgba(212,212,212,0.18)` | 18% 半透明环轨二态；登录页 LoginLoadingRing 与 Splash 转圈环共用（Splash 侧自暗色实现 PR 起由字面 rgba 收敛至本 token） |
| `--login-error-fg` | `#D91F37` | `#D91F37` | 语义豁免不变 |
| `--login-brand-accent` / `--login-brand-accent-pressed` | `#DF0C27` / `#A61629` | 同 light | 品牌红不变 |
| `--login-bg-base`（画布底） | `#EDEDED` | `#1F1F1E` | figma 532:585 暗色帧实测；两模式纯平定稿——暗色帧的双红晕层（532:588/589）曾按 1:1 几何落地，2026-07-24 实机走查拍板去除（亮色撤渐变=PR#104 拍板，两条决策相互独立） |

  余下 token（`-control-border-disabled` / `-inverted-button-border` / `-callback-*` 等）的**亮色**值与 callback 族**双态**值见 `token-decision-table §3`、`figma-component-spec §1.1`（注意：这两份外部 spec 只覆盖亮色 + callback 族 dark，**登录主皮 dark 值以本表为权威**，原※推导值已经 Figma 组件库核验确认，本表为目标规格）；深色反相机制与 3 处组件改动见 §16.5。
- **社交圆钮深色 = 白圆**：与主按钮共用 `--login-primary-button-bg / -border`，深色自动反相为白圆 `#EEEEEE` + 白边，**圆内图标保持品牌色**（Google 彩 / WeChat 绿 / SSO），非反相（figma `white apple/google/wechat/SSO` symbol 核验）。

### 16.2 设计规则

**Token 体系**：`--login-*` 已注册于 `apps/desktop/src/renderer/themes/colors.ts`（dark 槽位当前为 light 占位值，待实现 PR 填入 §16.1 表中的目标深色值）。组件经 `LOGIN_COLORS`（桌面 `loginDesignTokens.ts`）/ `loginColors`（手机 `theme/tokens.ts`）单点消费。**禁止硬编码 hex pair**（呼应 §10）——`hardcoded-color-audit` 守护全绿才允许合入。`--login-*` 随基础 **light / dark 二态**切换（对齐 `callback-*` 族与 §15 CINDY 皮肤族的双态做法），但**不跟随具体扩展主题**——登录页只认 light / dark 模式，扩展主题不 override `--login-*`（首次亮、后续跟随上次模式见 §16.5）。

**几何 / 布局常量**：固化在两个常量文件，数值权威 = `figma-component-spec §5.1` + `token-decision-table §4`，不按截图目测补值。

| 常量 | 值 | 引用 |
|---|---|---|
| 面板 | 680×440，r36，`#FBFBFB` + inset 1px `--login-panel-border` | figma §4 / §5.1 |
| 输入框 / 主按钮 | 540×80，r40，@(70, 158 / 300) | figma §4.1 / §4.3 |
| 方式行 | 540×100，r60，@(70, 158 / 278)，左图标 24@(27,37)，右图标 @(490,40) | figma §4.9 |
| 返回钮 | 60×60，r40，@(20,20) | figma §4.6 |
| 重发 / Text_link 槽 | 540×50，20px，@(70,238) | figma §4.7 |
| 错误文本 | 680×50，20px，@(0,380)，`--login-error-fg` | figma §4.8 |
| 第三方圆钮行 | y=480，80×80，r50，icon 48，gap 70 | figma §4.5 |
| 标题 / 副标题 | 标题 y=31 h=38 32 Bold；副标题 x=70 y=75 w=540 20 Regular ≤2 行顶对齐（2026-07-24 拍板：宽度对齐控件列，原 figma 单行几何 599@41 作废） | figma §5.1 + 2026-07-24 拍板 |

桌面 `loginDesignTokens.ts`（1819×2098 画布）、手机 `loginSkinLayout.ts`（750 设计 px，键名用 `font` / `radius` 避开 typography 守护扫描）。两端面板内坐标同源同值，手机由外层统一 `transform` 缩放。

**平台差异**：桌面 = Web renderer（Electron，Win / Mac 同套）；手机 = React Native（iOS / Android，含 phone / pad-portrait / pad-landscape）。两端同参数源、同 token 语义（手机 `loginColors` 与桌面 `LOGIN_COLORS` 同名同值），仅实现宿主不同（RN 用 `StyleSheet` + `Animated`，桌面用 CSS + Tailwind）。

**交互态**：hover（仅桌面）/ pressed（双端）/ disabled / loading 五态。态叠层挂伪元素（桌面 `::after`）/ overlay View（手机），**不动图标 / 文本子节点**；disabled 叠层走 `--login-disabled-button-overlay` token。hover / pressed 叠层**暗色落地前**为 figma 实测 rgba 字面值（亮色 as-built 现状）；**暗色 PR 起 token 化为 `--login-overlay-*` 二态 token**（叠层方向随模式反转，见 §16.5），此后组件内禁止新增字面 rgba 叠层。态系细则见 `DESIGN.md §2`。

**常驻动画 compositor-only**：spinner / loading 环动画挂 HTML（桌面）/ `Animated.View`（手机）外层 wrapper，SVG 图形保持静态（呼应 §14.4）；`prefers-reduced-motion` 直落静止。面板入场 handoff 动画是 §14.4 容器形变的窄变体（双端冻结 420ms 升起 + 渐显，`LOGIN_HANDOFF_TIMINGS.panelMs` / `panelInMs`）。

**Apple「Sign in with Apple」按钮**：iOS HIG 硬性要求使用 Apple 官方按钮样式，**不可皮肤化**——iOS 上 Apple 槽位保持原生 `ASAuthorizationAppleIDButton`，不套 `LoginSocialButton` 皮。这是合规底线，非视觉遗漏。其余社交圆钮（Google / WeChat / SSO）正常上皮。

**i18n**：登录文案走 `react-i18next`（桌面 `common.json` `login.*` 节）/ `loginMessages`（手机），4 语对齐 `zh-CN` / `en` / `ja` / `ko`（zh-TW 已随 #488 回退对齐主干四语基线——设计阶段旧文（不在仓库内）的五语门为回退前遗留，待清理，以本节四语为准）。4 语全部翻准，不留空（空 key 静默回退英文）。

**多语言长文本与翻译长度预算（2026-07-24 拍板）**：

- **原则：登录链路里截断与省略号不可作为可见结果**。登录面板是 680×440 冻结几何、槽位不撑高，长文案没有退路——所以约束加在**文案侧**：所有 `login.*` 文案（含 agent 代写 / 补翻的四语文本）必须言简意赅、按槽位长度预算写作。线上出现可见省略号 = 该语言文案超预算 = **文案 bug（P1，修文案，不改布局）**。
- **长度预算自检**（写 / 翻文案时逐语言过一遍）：估宽公式——汉字 / 假名 / 谚文 ≈ 1×字号 px，拉丁字母 / 数字 / 空格 ≈ 0.5×字号 px；估宽 ≤ 槽宽 × 0.95 才算过。常用槽预算：

  | 槽 | 宽×字号 | ≈汉字上限 | ≈拉丁字符上限 |
  |---|---|---:|---:|
  | 标题 | 680 @32 Bold（Global 变体标题 span 仅 236px，按 236 算） | 20（Global 变体 7） | 40（Global 变体 14） |
  | 副标题（≤2 行，2026-07-24 拍板） | 540 @20 × 2 行 | 50 | 102 |
  | Text_link / hint / 倒计时 | 540 @20 | 25 | 51 |
  | 主按钮 CTA | 448 @24 Bold（540 − 双侧 46 padding） | 17 | 35 |
  | 方式行标题 / 副题 | 409 @24 / @20 | 16 / 19 | 32 / 38 |

- **agent 翻译硬约束**：为 `login.*` 生成或修改任何语言文案时，必须按上表逐语言自检；超预算就换更短表述（ja / ko 往往比 zh 长，优先压缩语序与敬语冗余），**禁止**靠布局手段（缩字号 / 加折行 / 依赖截断）吸收超长文案。
- **折行与对齐机制分级**：
  1. **单行槽**（标题 / 链接 / 倒计时 / CTA / 方式行文字）：`nowrap + ellipsis` 仅作**防御性兜底**（防极端 locale 炸版），不是设计许可——见原则条。标题类顶对齐 + 显式 `lineHeight = 槽高`（防继承行高被 overflow 裁 descender，MT-7 教训）。
  2. **说明 / 提示类**（**副标题**、输入框 hint、错误文本、游客模式说明）：允许折行但 **≤2 行 + 行数 clamp**，**顶对齐、槽高 = 行高 × 最大行数、折行只向下伸展**；禁止「固定小槽 + flex 垂直居中」——那会让超行文本上下双向外溢压到相邻控件（2026-07-24 Enterprise SSO hint 压输入框实拍事故即此模式）。副标题原属单行槽，2026-07-24 拍板改判入本级（禁省略号、完整展示，几何 540@70 对齐控件列，双端已落码）。
  3. **弹窗族例外**（迁移弹窗等独立弹窗）：卡片 flex column 允许文本撑高、按钮钉底、pill 圆角跟随——仅弹窗族，不适用登录面板。

### 16.3 组件定义

桌面 `apps/desktop/src/renderer/components/login/LoginControls.tsx`（11 组件），手机 `apps/mobile/src/components/LoginSkinControls.tsx`（13 组件）。两端同名组件同参数源。逐组件契约（逐参数规格见 `figma-component-spec §4`）：

| 组件 | 端 | 用途 | 关键 props | token / 几何 |
|---|---|---|---|---|
| `LoginPanel` | 双 | 白面板容器 | `children`, `testId` | 680×440 r36 `--login-panel-bg` + inset 1px border；桌面由 `LoginStage` 承载缩放 |
| `LoginStage` | 桌面 | 1819×2098 画布「面板宿主」层，等比缩放 + z 序 | `children`, `ssoOrgGroupY`, `groupStyle` | 登录组 @(570, 1229 / 1227) 680×560；品牌层在 `LoginBrandStage` |
| `LoginTitleBlock` | 双 | 标题 + 副标题 | `title`, `subtitle`, `globalPill?` | 标题 y=31 h=38 32 Bold `--login-title-text`；副标题 @(70,75) 540 宽 ≤2 行顶对齐 20 Regular `--login-secondary-text`（2026-07-24 拍板，原 599×23 单行作废） |
| `LoginInput` / `LoginSkinInput` | 桌 / 手 | 通用输入框 | `value`, `onChange`, `placeholder`, `center?`, `error?`, `prefix?` | @(70,158) 540×80 r40 `--login-control-bg`；边 placeholder→active；`center`=验证码居中变体 |
| `LoginSkinPhoneInput` | 手机 | 手机号 + 固定国家码前缀 | `prefix`, … | 同 `LoginSkinInput` 几何，前缀不可点 |
| `LoginPrimaryButton` | 双 | 主按钮（五态） | `label / children`, `onClick / onPress`, `disabled`, `loading / busy` | @(70,300) 540×80 r40 `--login-primary-button-bg / -border / -text`；disabled 白 70% 叠层 + 边 `--login-control-border-disabled` + 文字 opacity 0.8；loading spinner 24@(487,27) |
| `LoginSocialRow` | 双 | 第三方圆钮行 | `children`, `count` | y=480 行内水平居中，80×80 gap 70 |
| `LoginSocialButton` | 双 | 第三方 / SSO 圆钮 | `label`, `onClick`, `children`, `isLoading / busy` | 80×80 r50 `--login-primary-button-bg / -border`；icon 48 居中；仅 normal + hover（桌面）+ pressed，**无 disabled / loading 视觉态** |
| `LoginSocialGlyph` | 手机 | 社交图标矢量（Apple / Google / WeChat / SSO；**apple 分支仅非 iOS 场景**——iOS 走官方按钮不进圆钮行，见 §16.2） | 内部 | Google / WeChat 品牌色不变；Apple / SSO 单色随圆钮底反相（暗色白圆上 `#2A2828`） |
| `LoginBackButton` | 双 | 返回 | `label`, `onClick`, `disabled` | @(20,20) 60×60 r40 `--login-action-control-bg` / `--login-back-border`；chevron 24 |
| `LoginTextLink`（桌）/ `LoginTextLinkSlot`（手） | 桌 / 手 | 重发链接 / 提示文案 | `variant`（link / countdown，桌）, `tone`, `children` | @(70,238) 540×50 20；link 变体 `--login-link-text` 下划线可点；countdown / slot `--login-control-placeholder` 不可点 |
| `LoginResendCountdown` | 手机 | 验证码重发（倒计时 / 重发二态） | `deadline`, `countdownTemplate`, `resendLabel`, `onResend` | @(70,238)；`deadline=null` → 常驻可点无倒计时（SSO 验证码屏用） |
| `LoginMethodRow` | 双 | 方式选择行（企业 / 个人） | `top`, `title`, `subtitle`, `icon`(enterprise / person), `onClick` | 540×100 r60 `--login-action-control-bg` / `--login-control-border`；左图标 24@(27,37) / person 18×20@(30,39)；右 share 18@(490,40)；文字 @(67) 垂直居中 |
| `LoginErrorText` | 双 | 错误提示 | `children` | @(0,380) 680×50 20 `--login-error-fg` |
| `LoginLoadingRing` | 双 | 大 loading 环（浏览器 / 准备态） | `y`, `label` | 64×64 @(308, 158 / 193)；轨道 `--login-loading-ring-track`，内弧 `--login-primary-button-bg`（Splash 转圈环 64×64@(308,188) 同轨道 token，内弧为 `--login-secondary-text`） |

**组件库新增（2026-07-24，目标规格，随游客登录 / 协议 UI 实现 PR 落地）**：
- **协议勾选 radio**（figma `radiobutton 600:627`，四态双模式）：24×24 命中区，圈 20×20 r9 + 2px 描边，选中为**对勾**（非圆点）。亮：未选 `#F1F0F1` 底 / `#434343` 边 → 选中 `#2A2828` 实底 + 白勾；暗：未选 `#2A2828` 底 / `#F1F0F1` 边 → 选中 `#F1F0F1` 底 + `#2A2828` 勾——选中反色与登录黑白反色体系同构。用于登录页 `服务条款` 协议行。
- **服务条款弹窗小按钮**（figma `light_button_*` / `Dark_button_*` 四母版，`602:846/863/1297/1311`）：260×80 r40 文字 Bold 24；强调钮 = 模式反色（亮强调深底 `#2A2828`、暗强调浅底 `#EEEEEE`），暗模式普通钮引入新灰 `#434141` 底 / `#565454` 边。逐态值见 `figma-component-spec §11.3`。
- 既有组件扩容：`SSO 登录_企业` 与 `back` 均扩为含 Dark 三态的六态集（值已并入 §16.1 `--login-action-control-bg` / `--login-back-border` 口径），`white_button` 增 loading 五态。

### 16.4 登录链路逐屏

登录状态机权威 = `packages/auth-client` 源码（`AuthFlowState` / `LoginOutcome` 判别联合；`flow-map` 为辅助导航，个别 UI 段落滞后于区域定形态改版）。共享 step ∈ {`identifier`, `method-choice`, `verification-code`, `sso-verification`, `browser-redirect`, `account-selection`, `binding`, `completed`, `error`}（`sso-org` **不是**共享 step，是 `identifier` 下的页面局部 `ssoOrgMode` 子视图）；其中 `account-selection` / `binding` / `sso-verification` / `completed` 由服务端 `LoginOutcome.status`（`ok` / `select_account` / `binding_required` / `sso_verification_required`）分支决定，**不是固定步骤**——任意 outcome 调用都可能命中。逐屏职责与关键组件（逐屏坐标 / 文案见 `DESIGN-login §3` 国区 / `§4` 国际区 / `§5` 移动）：

| 屏（step） | 职责 | 关键组件 |
|---|---|---|
| `identifier` | 输入手机号 / 邮箱（国区 phone / 国际区 email），含 social 圆钮行 + SSO 入口 | `LoginInput` / `LoginSkinPhoneInput` + `LoginPrimaryButton` + `LoginSocialRow` |
| `method-choice` | 命中企业域名时选企业 SSO / 个人邮箱验证码 | `LoginMethodRow`×2（top 158 / 278）+ `LoginTitleBlock`（`chooseMethod`） |
| `verification-code` | 输入 6 位验证码，42s 重发倒计时 | `LoginInput`(center) / `CodeInput` + `LoginTextLink` / `LoginResendCountdown` + `LoginPrimaryButton` |
| `sso-verification` | SSO 登录后验证企业联系方式，两子态（`codeRequested` false = 只发码 / true = 输码 + 常驻重发，**无倒计时**） | `LoginPrimaryButton`(sendCode) → `LoginInput`(center) + `LoginPrimaryButton`(completeSignIn / signIn) + `LoginTextLink` / `LoginResendCountdown`(deadline=null) |
| `sso-org`（`identifier` 局部子视图，非共享 step） | 输入企业 ID / 组织 slug / 已验证域名跳转 SSO（`ssoOrgMode`） | `LoginInput` + `LoginPrimaryButton` + `LoginTextLinkSlot`（ssoOrgHint） |
| `account-selection` | 服务端返回 ≥2 membership，用户选一个 | account row + `LoginTitleBlock`（`chooseAccount`） |
| `binding` | 身份未绑 membership，补绑 phone / email（`codeRequested` 两子态；**无重发钮**，桌面 harness 锁定） | `LoginInput` / `LoginSkinPhoneInput` → `LoginInput`(center) + `LoginPrimaryButton` |
| `account-deletion`（状态面板） | 账号删除**状态展示**（发起流程在 Settings 的 `AccountDeletionSection`；登录页仅在存在删除回执时于面板内展示 status，非主状态机 step） | `AccountDeletionStatusPanel`（登录皮容器内） |
| `browser-redirect` | 社交 / SSO 跳浏览器验证，等待回调 | `LoginLoadingRing` + `LoginPrimaryButton`（取消）+ `LoginTitleBlock` |
| `completed` / `error` | 登录成功 / 失败（含 browser 回调终态页） | 成功无面板（进主界面）；error = `LoginTitleBlock` + `LoginPrimaryButton`（重试）+ `LoginErrorText`；browser 回调页 `oauthResultPage`（系统浏览器独立 HTML，main 侧内联常量,色值与 `--login-callback-*` token 同源——renderer CSS var 不可达,改值需两处同步） |

### 16.5 深色模式与主题跟随

> 深色受 §2「Light / Dark 双模式交付门槛」约束，是**必须交付**的另一模式，非可选愿景。深色色值经 Figma 组件库 Dark symbol 逐个核验（见 §16.1 双态表），为目标规格——token dark 槽位已预留，待实现 PR 填入真实值并补齐 overlay token、深色资产切换及主题跟随逻辑。落地机制如下。

**深色 = 黑白反色在深底的镜像**：面板 / 控件深底、主按钮与社交圆钮反相白、文字反相米白，几何 / 布局 / props / 状态机 / i18n **零改动**——只换色值。

**大部分组件纯 token 驱动**（补 §16.1 双态表的 dark 值即自动深色，组件不动）：`LoginPanel` / `LoginInput` / `LoginPrimaryButton`（底 / 边 / 字 + spinner）/ `LoginSocialButton`（随主按钮 token 自动反相白圆）/ `LoginBackButton` / `LoginTitleBlock` / `LoginTextLink` / `LoginMethodRow` / `LoginErrorText` / `LoginLoadingRing`。

**3 处非纯 token、需组件改动**：
1. **hover / pressed 叠层二态**：叠层原为组件内 figma 实测 rgba 字面值，暗色起 token 化为 `--login-overlay-*` 二态。**〔2026-07-24 组件库更新改判〕hover 统一「叠白变亮」**：全按钮族 hover = normal 底上叠白色半透明（深底 `#2A2828`/`#434141` 族 +白 8%；浅底 `#EEEEEE` 族 +白 10%；**唯一例外**：`back` 亮色 hover 维持既有白 70%），两模式同向——旧「白底钮 hover = 黑 5% 变暗」口径作废（figma `white_button 347:2529`、SSO `549:779` 已按新值改稿）。pressed 维持叠黑，alpha 分档：**深底强调钮 50%**（`log_in_button` 与亮模式强调小钮 `light_button_highlight`，不论尺寸）/ 暗普通小钮 `Dark_button_Normal` 20% / 浅底钮 10%（边 `#E5E5E5`）/ 方式行与返回钮 8%。归纳仅作速记，**落码逐组件对拍 `figma-component-spec §11.1` 的状态矩阵，不按类别名推断**。**〔落码状态〕本改判当前仅在文档层生效**：as-built 组件（含回调页 dark CTA / `oauthResultPage`）仍消费改判前的旧叠层值（浅底 hover 黑 5%、pressed 黑 10% 等），与新口径的同步随暗色实现 PR 的 `--login-overlay-*` token 化一并落地——在那之前「文档新口径 vs 代码旧值」的差异是已知且有意的，不构成实现缺陷；落地后以本段口径为准。hover 方向不再随底色反转，但 alpha 档位随组件底色深浅取值，`--login-overlay-*` 系列 light / dark 二态 token 照常承载，组件把字面 rgba 改为 `var(--login-overlay-*)`（机械替换，零行为变化）。
2. **`--login-bg-base` 前提变更**：画布底原为「跨主题恒定白 `#EDEDED`」，深色为 `#1F1F1E`（figma 532:585 帧实测）——即 `--login-*` 从「跨主题恒定」改为「随 light / dark 二态」（见 §16.2）。
3. **`LoginBrandStage` 资产按模式切**：深色画布用**登录专用**白字版字标 / slogan 资产（`assets/login/wordmark-dark*.png` / `slogan-dark*.png`，源自 figma 532:585 `CINDY_Standard_White` 与 SLOGAN `#FBFBFB`，由暗色实现 PR 新增；**不是** §15.7 的新页横版 `cindy-logo-dark.png`——落位与尺寸不同）；立绘两模式同资产。

**disabled 态特例**：主按钮 disabled **两模式同构**——深底 `#2A2828`（独立 token `--login-disabled-button-bg`，**不随** `--login-primary-button-bg` 反相；组件需 disabled 分支切换底/字）+ 白 70% 叠层（`--login-disabled-button-overlay`）+ 边 `#B4B4B4` + 文字 `#D4D4D4`（`--login-disabled-button-text`）opacity 0.8（figma `white_button` Disable 态核验：深色 disabled 不反相为白底，仍走亮色同款灰态）。

**双模式门槛覆盖**：深色须覆盖亮色全部态——控件 default / hover(桌) / focus / filled / active / pressed / disabled / loading / error，全部 11 屏，桌面 Win / Mac + 手机 iOS / Android（phone / pad）两端同 token 同值；`scripts/__fixtures__/login-fidelity/`（待后续补充，当前不存在于仓库中）补深色 fixture，checker 跑深色矩阵。色值以设计稿为唯一基准，1:1 还原，不引入设计稿之外的验收标准。

**主题跟随（产品逻辑）**：用户**首次**打开 Cindy → **亮色**登录界面（默认）；**第二次起** → 登录界面跟随用户上一次使用的 **light / dark 模式**（登录页只认 light / dark，不随具体扩展主题，见 §16.2）。这需要持久化「上次登录模式」+ 首次默认逻辑，超出纯 token 补范围，是一段状态逻辑，在暗色实现 PR 内一并落地。

**决策记录（2026-07-23 已定）**：(1) `--login-*`「跨主题恒定 → light / dark 二态」前提变更 + 新增 `--login-overlay-*` 二态 token——**已采纳**；(2) 深色落点 = **跟随编辑器 light / dark mode** + 上述主题跟随逻辑——**已采纳**；(3) 立绘 / 社交图标深色版——已核验（立绘两模式同资产，社交深色白圆 + 品牌色图标，见 §16.1）；本节原 ※推导值（splash 进度条 / 链接 hover / pressed）已经 Figma 组件库核验确认，§16.1 表已回填目标值。**（2026-07-24 增补）画布渐变定稿**：暗色帧红晕层（532:588/589）按 1:1 几何落地后，经实机走查拍板去除——两模式画布纯平（亮色撤渐变 = PR#104 拍板，两条决策相互独立、结论一致）；`--login-bg-gradient-*` token 保留 override 锚、值恒 `none`，红晕如需恢复须以该走查结论为基线重新与设计确认。**（2026-07-24 增补）组件库状态扩充**：hover 统一「叠白变亮」改判（本节 (1) 已按新口径改写，旧「白底钮 hover 叠黑 5%」作废）；新增协议勾选 radio 与服务条款弹窗小按钮目标规格（见 §16.3 尾注）；`SSO 登录_企业` / `back` Dark 三态、`white_button` loading 五态入库（权威逐参数 = `figma-component-spec §11`）。游客登录（跳过登录）样式为独立实现任务，不在本节展开。**（2026-07-24 增补·二）多语言长文本口径**：登录链路禁止以截断 / 省略号作为可见结果，文案侧按槽位长度预算约束（含 agent 翻译硬约束），说明类文本折行 ≤2 行 + 顶对齐 + 只向下伸展——规则全文见 §16.2「多语言长文本与翻译长度预算」。同日二次拍板：**副标题改判入说明类**（禁省略号、完整展示 ≤2 行，几何 540@70 对齐控件列，原 figma 单行 599@41 作废），双端已落码（桌面 `LoginTitleBlock` + 手机 `LOGIN_SUBTITLE`）。
