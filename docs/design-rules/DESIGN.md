# Cindy Design System

> Heritage note: this visual language was originally derived from an external
> minimalist reference (2025). It has since evolved into Cindy's own system —
> no external site or product is a reference for new design decisions.

## 1. Visual Theme & Atmosphere

Cindy's interface is radical minimalism applied to an AI-agent workbench — a quiet, near-monochrome canvas where the user's content and the agent's output are the only things that demand attention. The design philosophy mirrors the product: strip away everything unnecessary until only the essential tool remains. This is the digital equivalent of a Dieter Rams object — every pixel earns its place, and the absence of decoration IS the design.

The default theme lives almost entirely in grayscale. Chromatic color is reserved for a small, explicitly sanctioned set of semantic signals (status, diff, focus — see §2); everything else is shades between near-black and near-white. Long working sessions stay calm, and color means something whenever it does appear.

What makes this system distinctive is the combination of a single geometric sans-serif (Inter) with a pill-first geometry (9999px radius on interactive elements). The clean letterforms + rounded buttons + rounded containers create a cohesive "softness language" that makes a developer-oriented tool feel approachable and friendly rather than intimidating. This is minimalism with warmth — not cold Swiss-style grid minimalism, but the kind where the edges are literally softened.

**Key Characteristics:**

- Near-monochrome default theme; chromatic color only via the sanctioned semantic set (§2), always consumed through tokens (§10)
- Inter as the single sans family, carrying both display headlines and body text
- Tight border-radius system: 8px (inner controls) / 12px (containers) / 9999px (pill) — three values, nothing else
- Zero shadows in the base language — depth comes from background color shifts and 1px borders (narrow token-gated exceptions live in §10)
- Pill-shaped geometry on all interactive elements (buttons, tabs, inputs, tags)
- No mascots or decorative artwork in the working UI — brand imagery appears only on sanctioned brand surfaces (see §15.7 / §16)
- Extreme content restraint — each surface presents one clear idea

## 2. Color Palette & Roles

> **Multi-theme note**: the values in this section are the concrete **Default Light / Default Dark** (base theme) palette, given as the visual-spec reference sample. At runtime **every color is consumed through a token** (see §10 Theme System & Token Reference), so the same component automatically renders each theme's own colors under other themes (Eclipse / One Dark Pro / Monokai Pro, …). **When implementing components, always write tokens, never hex** — rules in §10.

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
- **Dark Chip** (`#3c3c3a`, token `--surface-chip`): the primary chip/button background in Dark Mode — one step lifted above a Card or Surface context.
- **Dark Chip Alt** (`#2c2c2a`, token `--surface-chip-alt`): the variant that collapses to the Dark Card value — used where a chip sits directly on Surface and only needs the Card-level lift. When in doubt, use `--surface-chip`; see §10 for both slots.

> ~~**Border Light** (`#d4d4d4`)~~ — deprecated (2026-06, G2). Once labeled the "white-button border color", but no real component ever used it (only bare hardcodes in the experimental view). White Pill secondary borders uniformly use **Board** (`--border-default` `#d7d7d4`).

### Neutrals & Text

- **Stone** (`#737373`): Secondary body text, footer links, and de-emphasized content. The primary "muted" tone.
- **Mid Gray** (`#525252`): Emphasized secondary text, slightly darker than Stone.
- **Silver** (`#a3a3a3`): Tertiary text and deeply de-emphasized metadata. **Never use it as a placeholder** — too prominent, reads as filled-in (see §4 Inputs; the G3 erratum is archived in [`design-decision-log.md`](./design-decision-log.md); placeholders use `--text-placeholder` `#c4c4c4`).

> ~~**Button Text Dark** (`#404040`)~~ — deprecated (2026-06, G1). Once labeled the "white-surface button text color", but no real button ever used it (only bare hardcodes in the experimental view). White Pill secondary text uniformly uses **Near Black** (`--text-primary` `#262626`).

### Semantic & Accent

The grayscale rule is near-absolute. The following are the **only** sanctioned non-gray colors in the system — each tightly scoped to a specific surface. New semantic colors must not be introduced without being recorded here first.

- **Focus Blue** (`#417CDD` at 50%; tokens `--focus-ring` / `--focus-ring-soft`): the keyboard-accessibility focus ring, finalized 2026-07-17 (replaces Tailwind's default `#3b82f6`). Never visible in normal interaction flow.
- **Thinking / Warning Orange** (`#EA6B17`, finalized 2026-07-17, replaces the frozen `#FF6600`): the shared warning-accent family, identical in both modes. Sanctioned consumers only — the ChatView Running Status Bar (sparkles icon + status text, e.g. `Spelunking...`, no background fill), running-state breathing icons in the sidebar, the collaboration toggle ON state, the plan-approve icon, the Full Access permission highlight, the settings integration warning, and the workflow agent status strip's running cells (8×8px filled squares in the background-tasks panel detail and the workflow chat card, registered 2026-07-28 — running-state semantics, same family as the sidebar breathing icons; the done/failed/queued cells stay on their own semantic tokens: `--card-status-done` / `--error-fg` / `--surface-chip`) (see the §10 exemption table and §15 for the full token list: `--warning-accent` and its follower tokens). A consumer that introduces no new token — one that reads `--warning-accent` or an existing follower directly, like this strip — is registered by this list alone; a consumer needing a NEW token must be registered in the §10 exemption table first.

> **Additional narrowly-scoped exceptions** (documented in their respective component specs, do NOT generalize as system semantic colors):
>
> - **Toast Info / Success / Warning / Error** — `#417CDD` / `#2AAE5B` / `#F3A115` / `#D91F37`(finalized 2026-07-17; Toast exemption lifted) — used ONLY on the 16×16 lucide icon inside Toast pill notifications. The pill body (background, text, border, close icon) remains strictly grayscale. Info blue #417CDD equals the focus-ring / Auto Approval value (originally #3B82F6, added 2026-07-14, now finalized); success/warning/error equal the global status colors (done green / status error / warning foreground).
> - **ConfirmDialog Danger** — `#EF4444` used ONLY on the confirm button background in the Danger variant. The cancel button and rest of the dialog remain grayscale.
> - **Permission Selector Mode Highlights** — selected risky permission modes may color only the option text/icon/checkmark and the collapsed trigger text/icon. The selected row background remains grayscale. Auto Approval uses `#417CDD` in both modes (finalized 2026-07-17, same value light/dark; replaces light #000050 / dark #00D9C5). Full Access uses Heart Orange `#EA6B17` in both modes (auto-follows warning-accent, finalized 2026-07-17). These hex values are the **default-theme palette only** — other themes may override `--perm-auto-selected-text` and `--perm-bypass-selected-text` with their own accent colors, provided both modes remain color-coded, distinguishable from each other, and visually distinct from neutral text. Tokens: `--perm-auto-selected-text` and `--perm-bypass-selected-text` in `apps/desktop/src/renderer/styles/globals.css`.
> - **Diff Add Green / Diff Del Red** — GitHub-standard diff syntax colors, used on the `+` / `-` symbol glyph, the changed-line text foreground, **and the full row background** inside code-diff renderings. Applied in three places: (1) the Edit-tool DiffView card (F-MSG-6), (2) markdown ````diff` fenced code blocks in the message stream, and (3) `.diff` / `.patch` files opened in TextLightbox (the document previewer) — there hljs `.hljs-addition` / `.hljs-deletion` are forced `display: block` so the background fills to the right edge instead of stopping at the last glyph. Line-number gutter and ctx (unchanged) lines remain strictly grayscale per the layer system. **Foreground** — Add: `#22863a` Light / `#7ee787` Dark; Del: `#b31d28` Light / `#ff7b72` Dark. **Background** — Add: `#f0fff4` Light / `#033a16` Dark; Del: `#ffeef0` Light / `#67060c` Dark. Tokens: `--diff-add-fg/-bg` and `--diff-del-fg/-bg` in `apps/desktop/src/renderer/styles/globals.css`. Updated 2026-04-21: backgrounds switched from grayscale → GitHub red/green for full-row fill so additions / deletions are unambiguous at a glance.

*Dark Mode text uses softened neutrals to reduce eye strain: **Soft Gray** (`#d4d4d4`) for primary text, **Silver** (`#a3a3a3`) for secondary, **Stone** (`#737373`) for tertiary (per `--text-secondary` / `--text-tertiary` in `colors.ts` — the two swap between modes). Pure White (`#ffffff`) is reserved for button labels and high-contrast UI elements on dark backgrounds.*

### Gradient System

- **None in the core UI.** Cindy uses no gradients; visual separation comes from flat color blocks and single-pixel borders. This is a deliberate, almost philosophical design choice. (The login canvas is also flat by ruling — see §16.5.)

## 3. Typography Rules

### Font Family

- **Display / Body / UI**: `Inter`, with fallbacks: `system-ui, -apple-system, "Segoe UI", sans-serif`
- **Monospace**: `JetBrains Mono`, with fallbacks: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`

*Note: The entire interface uses a single sans font — Inter — for both display headlines and body text. Inter is chosen for (a) its neutral, geometric character that stays out of the way, (b) its excellent legibility at small sizes, and (c) its wide availability in both web and design tooling. A single font keeps the hierarchy clean — separation comes from size and weight, not typeface contrast.*

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


*Positioning note: the Display / Section Heading / Sub-heading rows are for brand-scale surfaces (login, splash, empty states); everyday app chrome lives in the Body / Caption / Small / Micro rows.*

### Principles

- **Single sans family**: Inter carries both display headlines and body text — no typeface switching between hierarchy levels. Size and weight alone create hierarchy, keeping the typographic system maximally simple.
- **Weight restraint**: Only two weights matter — 400 (regular) for body and 500 (medium) for headings. No bold, no light, no black weight. This extreme restraint reinforces the minimal philosophy.
- **Tight display, comfortable body**: Headlines compress to 1.0 line-height, while body text relaxes to 1.43–1.56. The contrast creates clear hierarchy without needing weight contrast.
- **Monospace for code only**: JetBrains Mono is reserved for inline code, terminal commands, and code blocks — never used for UI chrome.

## 4. Component Stylings

> Buttons / Cards / Inputs below use the structured key-value format (adopted from the §12 pilot, 2026-07): `field → token → Default Light / Default Dark resolved values`. Token names per §10.

### Buttons

```
button/primary  (Gray Pill)
  fill      --surface-chip        #e5e5e5 / #3c3c3a
  text      --text-primary        #262626 / #d4d4d4
  border    1px solid --surface-chip   (same as fill)
  radius    9999px (pill)
  padding   10px 24px
  height    ⚠ not yet specified (only padding is normative)
  note      understated, grayscale, always a pill

button/secondary  (White Pill)
  fill      --surface-elevated    #ffffff / #2c2c2a
  text      --text-primary        #262626 / #d4d4d4
  border    --border-default      #d7d7d4 / #3c3c3a
  radius    9999px (pill)
  padding   10px 24px
  note      visually lighter than primary

button/cta  (Black Pill — maximum emphasis)
  fill      --accent-cta-bg-pure  #000000 / #ffffff
  text      --accent-pure-cta-fg  #ffffff / #000000
  radius    9999px (pill)
  padding   10px 24px
  note      pure black on white (inverts in Dark)
```

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

### Inputs & Forms

```
input/text
  fill        --surface-elevated  #ffffff / #2c2c2a
  text        --text-primary      #262626 / #d4d4d4
  border      --border-default    #d7d7d4 / #3c3c3a
  radius      9999px (pill — single-line inputs)
  focus       --focus-ring-soft   rgba(65,124,221,0.5)   (50% of #417CDD; opaque border variant = --focus-ring)
  placeholder --text-placeholder  #c4c4c4 / #525252
```

- **Multi-line inputs (textarea) cannot wear the pill** (tall frames deform it) — use the 8px inner-control radius instead (§5 three-tier scale).
- Placeholders must **read as clearly empty** — Silver (`#a3a3a3`) is too prominent against either Card surface (≈5:1 Dark / ≈2.6:1 Light) and reads as real input; forbidden. **Every input surface's placeholder (chat / ask / settings / plan-action-fb) resolves to `--text-placeholder`** (2026-06 G3, archived in `design-decision-log.md`); non-default themes express their own placeholder color by overriding `text-placeholder`.

### Select & Dropdown

- **Trigger**: same as a single-line input — pill (9999px), Card bg, 1px Board border, carrying the current value + a chevron.
- **Panel**: a container — 12px radius, Card bg (`--surface-elevated`), 1px Board border, no shadow (separation comes from the overlay / layer colors), 6–8px padding.
- **Panel width must bind to the trigger width** — never narrower or wider than the control that opened it. Radix Select: `position="popper"` + `width: var(--radix-select-trigger-width)`; other primitives measure the trigger. (A repeatedly-tripped rule: dropdown width must match the control above.)
- **Option rows**: selected / hovered highlight fills use the **8px inner radius** (see §5 — the panel is a 12px container, the row highlight is the inner 8px tier; the inner radius must be smaller than the container's to nest cleanly). Highlight bg via `--surface-hover` / Radix `data-[highlighted]`; selected rows get the chip fill, unselected rows stay transparent.
- **Composer dropdown rows (the model / permission / + MorphPopover menus) — one unified contract** (2026-07-22): every option row in these three menus must match **verbatim** — horizontal padding `px-3`, radius `rounded-[8px]`, and both hover and selected fills on the **same token `--model-item-hover`**; the selected state is additionally marked only by a check + `font-medium` (danger-tier orange / blue tints **text only**, never the fill). **Why not `--surface-chip` for the selected fill**: the cindy default skins tune `--surface-hover` / `--surface-chip` to sit-on-page values that are darker than the lifted panel (`--surface-elevated`), which would make row highlights invisible; so menu-row hover resolves to the component-level token `--model-item-hover`, overridden in cindy-dark / cindy-light to "one step above the panel" (dark lifts lighter, light presses darker). When touching any of these three menus' row styles, change all three in sync — never just one.

### Dialog & Modal

Reference implementation: `apps/desktop/src/renderer/components/ui/confirm-dialog.tsx` (the shared confirm dialog); new dialogs reuse its structure — do not invent a parallel one.

- **Overlay**: the full-screen scrim uses the `--overlay-modal` token (ConfirmDialog's current `neutral-900/40` hardcoded pair is legacy — **new dialogs always use the token**; do not copy the legacy pair).
- **Container**: a container — 12px radius (`rounded-xl`), `--confirm-bg`, `--confirm-shadow`, 16px padding (`p-4`), centered. Width: confirm/notice dialogs ≈ 400px (`max-w-[400px]`); dialogs with inputs/forms may widen to ≈ 460px and shrink with the viewport (`min(460px, 100vw-32px)`).
- **Title / description**: `--confirm-title` / `--confirm-desc`, medium weight.
- **Buttons**: pill (9999px); primary = solid CTA (`--confirm-btn-primary-*`), secondary/cancel = outlined (`--confirm-btn-secondary-*`, transparent fill + Board border); footer `justify-end`.
- **Focus on open**: lands on the dialog's **primary input or primary button**, never defaults to Cancel (see §14.2 + ConfirmDialog's `autoFocusConfirm` / `onOpenAutoFocus`).

### Tabs

**Tab Pills**

- Pill-shaped tab selectors (e.g. the Claude | Codex agent switch on the new-session screen)
- Active: Light Gray bg (`--surface-chip`); Inactive: transparent
- All pill-shaped (9999px)

## 5. Layout Principles

### Spacing System

- Base unit: 8px
- Scale: 4px, 6px, 8px, 10px, 12px, 14px, 16px, 20px, 24px, 32px, 40px, 48px
- Button padding: 10px 24px (consistent across all buttons)
- Container padding: dialogs 16px (`p-4`, see §4 Dialog & Modal); dropdown panels 6–8px (see §4 Select & Dropdown)

### Layout Structure (App)

- Full-window three-region structure: sidebar + content area (+ optional right panel), separated by 1px Board dividers on a single flat Surface — never by background shifts (see §2 layer rule).
- Centered-card layouts (login, empty states) follow the Surface + Card two-layer rule in §2.
- Reading-width content (settings forms, document previews) is centered with a comfortable max width; full-bleed content (chat stream, file tree) fills its region.

### Whitespace Philosophy

- **Emptiness as luxury**: no surface overstays its welcome — each concept gets minimal but sufficient space.
- **Content density is low by design**: one clear idea per surface. When a screen needs more, split it into progressive disclosure (§14) instead of packing it tighter.
- **The white space IS the brand**: calm, undecorated space communicates "this tool gets out of your way."

### Border Radius Scale

Three tiers — **these three only**:

- **Inner control (8px)**: the narrow third tier, **only** for small interactive pieces that cannot wear the pill: multi-line inputs (textarea), selected/hover row highlights in dropdowns/menus, small in-block cells. Implemented as Tailwind `rounded-lg` (8px).
- **Container (12px)**: box radius — code blocks, cards, panels, dialogs. Implemented as Tailwind `rounded-xl` (12px).
- **Pill (9999px)**: every interactive element that can wear the pill — buttons, tabs, single-line inputs, tags, badges.

*No 4px / 6px / 10px, and no arbitrary radii. Most elements still pick between the 12px container and the pill; 8px is a narrow exception for controls that don't fit the pill. Mind nesting: an 8px row highlight inside a 12px panel must stay smaller than its container to nest cleanly (hence 8, not 12) — a pill there becomes a lozenge, 12px looks bloated.*

> **Narrow exception — status micro-cells (2px)** (registered 2026-07-28): non-interactive status squares of 8×8px or smaller keep a 2px radius — the workflow agent status strip's cells (background-tasks panel detail + workflow chat card) and the equivalent per-category square in SystemCard. At that size any tier radius rounds the square into a dot and destroys the "block strip" read that lets a large agent fleet be scanned at a glance. Scope is exactly this: **non-interactive, ≤8px, status-only**. Do NOT generalize to buttons, tags, rows, badges or containers — those still pick a tier.

## 6. Depth & Elevation


| Level              | Treatment                                                                 | Use                                            |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Flat (Level 0)     | No shadow, no border                                                      | Surface background, most content               |
| Bordered (Level 1) | `1px solid` Board (`#d7d7d4` Light / `#3c3c3a` Dark)                      | Cards, code blocks, dividers, section outlines |
| Lifted (Card)      | Card fill (`#ffffff` Light / `#2c2c2a` Dark) + optional 1px Board outline | Login cards, modals, raised panels             |


**Shadow Philosophy**: Cindy's base visual language uses **zero shadows**. This is not an oversight — it's a deliberate design decision. The flat, shadowless approach creates a paper-like experience where elements are distinguished purely by background color and single-pixel borders. Depth is communicated through **content hierarchy and typography weight**, not visual layering. (The only shadows in the system are the token-gated floating-layer exceptions registered in §10 — `--shadow-menu` / `--cmd-palette-shadow` / `--confirm-shadow`; never add ad-hoc shadows to in-page elements.)

## 7. Do's and Don'ts

### Do

- Use Surface (`#f8f8f6` Light / `#1f1f1e` Dark) as the page background — every page starts here
- Use pill-shaped (9999px) radius on all interactive elements — buttons, tabs, inputs, tags
- Use 12px radius on all non-interactive containers — code blocks, cards, panels
- Use 8px radius only for inner controls that can't be a pill — multi-line inputs, dropdown/menu rows (see §5)
- Keep the palette strictly grayscale — chromatic color only via the sanctioned semantic set in §2, always through tokens
- Use Inter at weight 500 for display headings — hierarchy comes from size + weight, not typeface switching
- Maintain zero shadows — depth comes from borders and background shifts only
- Keep content density low — each section should present one clear idea
- Use monospace for terminal commands and code — it's primary content, not decoration
- Keep all buttons at 10px 24px padding with pill shape — consistency is absolute

### Don't

- Don't introduce any chromatic color outside the sanctioned semantic set in §2 — no brand blue, no accent green, no warm tones beyond the registered exceptions
- Don't invent arbitrary radii — only three values exist: 8px (inner controls), 12px (containers), 9999px (pill). Nothing in between, nothing else.
- Don't add shadows to any element — the flat aesthetic is intentional
- Don't use font weights above 500 — no bold, no black weight
- Don't add decorative illustrations — Cindy's working UI carries no mascots or artwork; brand imagery appears only on sanctioned brand surfaces (login, splash, new-session brand block — see §15.7 / §16)
- Don't use gradients anywhere — flat blocks and borders only
- Don't overcomplicate the layout — stick to the region structure in §5; no complex nested grids
- Don't use borders heavier than 1px — containment is always the lightest possible touch
- Don't add decorative or large-motion animation — no bounce, parallax, looping, or gratuitous movement. Short **functional** state transitions (color / background / opacity, ≤150ms) are fine and expected — see §14.4.

## 8. Window & Adaptive Behavior

Cindy Desktop is an Electron app: layout responds to window resizing, not page breakpoints.

### Desktop Window

- Minimum window size: **800 × 600** for the main window and secondary session windows (enforced at the BrowserWindow level — `apps/desktop/src/main/bootstrap-electron.ts` / `secondary-windows.ts`). The detached right-sidebar window has its own smaller floor of **360 × 480** (`right-sidebar-window/window.ts`) — layouts hosted there must stay legible down to that width
- The sidebar is collapsible; region dividers and paddings hold as the window narrows, and content reflows fluidly
- Chat stream and composer reflow with the window; code blocks keep horizontal scroll instead of wrapping
- Control sizes and paddings follow §4 at every window size — targets never shrink below their specified geometry

### Mobile

Cindy Mobile (React Native) has its own device-class rules (phone / pad portrait / pad landscape). The surfaces specified so far are documented in §15.13 (cross-platform skin rules) and §16 (login); mobile layout beyond those surfaces follows `apps/mobile` as implemented.

## 9. Agent Prompt Guide

### Quick Color Reference

- Primary Text: "Pure Black (#000000)" Light / "Soft Gray (#d4d4d4)" Dark
- **Surface** (page bg): "Light Surface (#f8f8f6)" / "Dark Surface (#1f1f1e)"
- **Card** (elevated layer): "Pure White (#ffffff)" / "Dark Card (#2c2c2a)"
- **Board** (1px dividers/borders): "Light Board (#d7d7d4)" / "Dark Board (#3c3c3a)"
- Secondary Text: "Stone (#737373)" Light / "Silver (#a3a3a3)" Dark — `--text-secondary`
- Tertiary Text: "Silver (#a3a3a3)" Light / "Stone (#737373)" Dark — `--text-tertiary`
- Near Black: (#262626) — Light primary reading text
- Chip/Button Background: "Light Gray (#e5e5e5)" Light / "Dark Chip (#3c3c3a)" Dark — `--surface-chip` (the collapse-to-Card variant `--surface-chip-alt` #2c2c2a: see §2)

### Example Component Prompts

- "Create a settings section: an ivory Card (--surface-card-ivory, 12px radius, 1px --border-default outline) on the Surface page background; section title 14px Inter 500, body rows 14px 400."
- "Design a code block with a 12px border-radius, 1px solid Board (#d7d7d4 Light / #3c3c3a Dark) border on Card background. Use JetBrains Mono for the code. No shadow."
- "Build a tab bar with pill-shaped tabs (9999px radius). Active tab: Light Gray (#e5e5e5) background, Near Black (#262626) text. Inactive: transparent background, Stone (#737373) text."
- "Build a chat composer: a Card-colored (--surface-elevated) 12px-radius container; inside, pill control chips (9999px) that are borderless at rest and gain a --border-default outline on hover."
- "Design a confirm dialog: 12px-radius container, max-width 400px, pill buttons — solid CTA on the right, outlined secondary beside it; focus lands on the primary button."
- "Create a dropdown: pill trigger; panel width bound to the trigger; 12px-radius Card panel with 1px Board border; option rows highlighted with 8px inner radius via --model-item-hover."

### Iteration Guide

1. Focus on ONE component at a time
2. Keep all values grayscale — "Stone (#737373)" not "use a light color"
3. Always specify radius from the three tiers — pill (9999px) / container (12px) / inner control (8px, only for textareas & dropdown rows). Nothing else.
4. Shadows are always zero — never add them
5. Weight is always 400 or 500 — never bold
6. If something feels too decorated, remove it — less is always more

## 10. Theme System & Token Reference

### Light / Dark Dual-Mode Delivery Gate(双模式交付门槛)

- **Every UI must be implemented for both Light and Dark modes.** When adding or changing any page, component, layout, style, motion, or UI copy, both modes must be designed and built within the same piece of work; designing or implementing only one mode counts as incomplete. **Visual QA in both modes is expected effort, not a blocking gate** — see the last bullet.
- Both modes must cover every state actually touched by the change — default, hover, pressed, selected, focus, disabled, loading, empty, error, overlays and scrims. States the change does not touch need not be retrofitted just to tick a box.
- Colors must be consumed through semantic tokens; hardcoded values or conditional patches that only fit one mode are forbidden. When the design mock provides only one mode, the other mode must still be filled in through the existing token system; if a clear semantic mapping is missing, request a design ruling first — never ship with a mode omitted.
- **Verification is best-effort and must be reported honestly.** Eyeballing the affected surfaces in both Light and Dark before delivery is the preferred path, but skipping it does not block the change — say plainly in the commit / PR verification notes which mode was actually checked and which was not. Never upgrade "reused existing themed styles / added no raw color values" into a claim that both modes were verified. If a mode *is* checked and comes back unreadable, indistinguishable, missing states, or visibly regressed, that is a real defect and must be fixed before delivery.

### Architecture

Cindy Desktop manages color with a **VSCode-style ColorRegistry + theme-override** model. Every color reaches components as a CSS-variable token; **hardcoding hex / rgba inside a component is never allowed** (it makes the component un-themeable outside the default theme).

Source: `apps/desktop/src/renderer/themes/`
- `color-registry.ts` — the `ColorRegistry` singleton and the `registerColor(id, defaults, description)` API
- `colors.ts` — registers every token, organized "semantic slots first, aliases and singletons after" (counts drift constantly — **`colors.ts` itself is the only authoritative inventory**; this document does not track totals)
- `theme-service.ts` — `applyTheme(theme)` serializes all tokens into `:root{}` and injects `<style id="theme-vars">`
- `builtin/` — built-in theme objects (`cindy-light.ts` / `cindy-dark.ts` / `eclipse.ts` / `default-light.ts` / `default-dark.ts` and the community palettes)
- `registry.ts` — the `builtinThemes` registry + `listThemesByType('light' | 'dark')`

Theme switching: `useTheme.ts` provides `theme` (System / Light / Dark mode) plus `lightThemeId` / `darkThemeId` (which concrete theme). Settings → Appearance is the UI entry.

### Token Tiers

**Tier 1 — Semantic slots**: the core cross-context slots; when adding a theme, this tier is the main override battleground. The table below lists every slot exhaustively — it IS the Tier-1 registry.

| Category | Slot | Default Light | Default Dark | Primary use |
|---|---|---|---|---|
| **Surface** | `--surface` | `#f8f8f6` | `#1f1f1e` | Page Surface (hex form) |
| | `--surface-hsl` | `60 12.5% 97%` | `60 2% 12%` | Same, HSL triplet — consume via `hsl(var(--xxx))` |
| | `--surface-elevated` | `#ffffff` | `#2c2c2a` | Card lift / dialogs / popovers |
| | `--surface-elevated-soft` | `#e5e5e5` | `#2c2c2a` | Disabled-state Card |
| | `--surface-card-ivory` | `#faf9f5` | `#2c2c2a` | Slightly warm ivory Card (Settings) |
| | `--surface-chip` | `#e5e5e5` | `#3c3c3a` | Chips / pills / selected rows |
| | `--surface-chip-alt` | `#e5e5e5` | `#2c2c2a` | Chip variant that collapses to Card in Dark |
| | `--surface-hover` | `#e5e5e5` | `#3c3c3a` | General hover bg |
| | `--surface-hover-soft` | `#f8f8f6` | `#3c3c3a` | Soft hover bg |
| | `--surface-hover-hsl` | `0 0% 90%` | `60 2% 17%` | Hover, HSL form |
| | `--surface-on-card` | `#ffffff` | `#1f1f1e` | Dark foreground on CTAs / checked icons |
| **Border** | `--border-default` | `#d7d7d4` | `#3c3c3a` | This spec's Board 1px border |
| | `--border-default-hsl` | `60 3% 84%` | `60 2% 23%` | Board, HSL form |
| | `--border-shadcn-hsl` | `0 0% 90%` | `30 4% 28%` | shadcn input/border HSL |
| | `--border-transparent-mixed` | `transparent` | `#3c3c3a` | Single-side borders (progress track etc.) |
| **Text** | `--text-primary` | `#262626` | `#d4d4d4` | Primary headings / body |
| | `--text-primary-hsl` | `0 0% 9%` | `0 0% 83%` | Primary, HSL form |
| | `--text-primary-on-dark` | `#262626` | `#ffffff` | Inverse text (stop-button icon etc.) |
| | `--text-primary-emphasis` | `#1a1a1a` | `#d4d4d4` | Plan emphasized primary text |
| | `--text-primary-inv` | `#1a1a1a` | `#ffffff` | Plan-action approve text |
| | `--text-primary-body-strong` | `#525252` | `#d4d4d4` | Plan content body, strong |
| | `--text-secondary` | `#737373` | `#a3a3a3` | Secondary text / icons |
| | `--text-secondary-cross` | `#a3a3a3` | `#a3a3a3` | Lighter cross-theme secondary |
| | `--text-secondary-mid` | `#525252` | `#a3a3a3` | Muted body text |
| | `--text-tertiary` | `#a3a3a3` | `#737373` | Placeholder / tertiary |
| | `--text-tertiary-stone` | `#737373` | `#737373` | Cross-theme Stone tertiary |
| | `--text-tertiary-mid` | `#525252` | `#737373` | Mid-gray tertiary |
| | `--text-tertiary-hsl` | `0 0% 45%` | `0 0% 45%` | Tertiary, HSL form |
| | `--text-disabled` | `#d4d4d4` | `#525252` | Disabled / failed |
| | `--text-disabled-tertiary` | `#a3a3a3` | `#737373` | Disabled placeholder variant |
| | `--text-placeholder` | `#c4c4c4` | `#525252` | Unified placeholder slot (lighter than tertiary — reads as empty); chat/ask/settings/plan-action-fb inputs all resolve here |
| **Accent** | `--accent-cta-bg` | `#262626` | `#ffffff` | Inverse CTA bg |
| | `--accent-cta-bg-pure` | `#000000` | `#ffffff` | Pure CTA bg |
| | `--accent-emphasis` | `#262626` | `#d4d4d4` | Settings primary button etc. |
| | `--accent-soft` | `#262626` | `#ffffff` | Soft accent (folder button etc.) |
| | `--accent-hover` | `#262626` | `#e5e5e5` | CTA pressed/hover |
| | `--accent-pure-cta-fg` | `#ffffff` | `#000000` | Pure-inverse CTA text |

**Tier 2 — Aliases**: the many component-scoped tokens (`--cmd-palette-bg`, `--msg-tool-card-text`, `--settings-input-border`, …) whose defaults resolve to `var(--slot)`. The browser forward-resolves automatically; components are unaware — **keep consuming the alias names directly**.

**Tier 3 — Singletons**: genuinely independent values that cannot collapse into a slot: semantic exemption colors (`--destructive` / `--diff-add-*` / `--status-bar-accent` …), platform-specific colors, splash durations, and non-color tokens such as `--radius`.

### Semantic Exemption Colors (theme-invariant)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--destructive` (HSL) | `0 84% 60%` | `0 72% 63%` | Generic destructive text/border |
| `--error-flat` | `#ef4444` | `#ef4444` | Flat danger foreground |
| `--login-error-fg` | `#D91F37` | `#D91F37` | Login error text/border (see §16.1) |
| `--error-bg/-border/-fg/-fg-strong` | (red) | (red) | Error alert card subsystem |
| `--diff-add-fg/-bg`, `--diff-del-fg/-bg` | GitHub palette | GitHub palette | Diff rendering |
| `--status-bar-accent` | `#EA6B17` | `#EA6B17` | Thinking Orange, theme-invariant (finalized 2026-07-17) |
| `--plan-action-approve-icon-bg` | `#EA6B17` | `#EA6B17` | Plan approve — same thinking semantics (follows warning-accent, finalized 2026-07-17) |
| `--perm-bypass-selected-text` | `#EA6B17` | `#EA6B17` | Heart Orange, permission semantics (auto-follows `var(--warning-accent)`, finalized 2026-07-17) |
| `--settings-integration-warning` | `#EA6B17` | `#EA6B17` | Warning semantics (auto-follows `var(--warning-accent)`, finalized 2026-07-17) |
| `--warning-bg-soft` | rgba(234,107,23,0.12) | rgba(234,107,23,0.18) | Warning alpha surface (alpha recomputed against `#EA6B17`, 2026-07-17) |
| `--focus-ring` / `--focus-ring-soft` | `#417CDD` / @50% | same | A11y focus ring, finalized 2026-07-17 (replaces #3b82f6), theme-invariant |
| `--shadow-menu` / `--cmd-palette-shadow` / `--confirm-shadow` | rgba | rgba (deeper) | Shadows, theme-invariant |
| `--overlay-modal` / `--overlay-lightbox` | rgba | rgba (deeper) | Modal / lightbox backdrop |
| `--perm-auto-selected-text` | `#417CDD` | `#417CDD` | Auto Approval accent, finalized 2026-07-17 (same value both modes; replaces #000050/#00D9C5) |
| Toast `#417CDD / #2AAE5B / #F3A115 / #D91F37` | (hardcoded in Toast.tsx, VARIANT_MAP exported) | same | Finalized 2026-07-17 (Toast exemption lifted, merged into the status-color family) |
| `--file-badge-pdf/-doc/-sheet/-slide/-code` + `--file-badge-fg` | `#B23A26` / `#2C5CA8` / `#2E7D4F` / `#A25A12` / `#5B49A8`, fg `#FFFFFF` | same | File-type badges on the self-drawn attachment icon (2026-07-27). Bound to *what the file is*, not to the theme, so both modes share one value. Each accent is picked for ≥4.5:1 against `--file-badge-fg` (5.96 / 6.56 / 5.05 / 5.24 / 7.09) — the badge label renders at 10px (Micro Label floor, §3), so AA small-text applies. `--file-badge-fg` is a standalone white: `--accent-pure-cta-fg` flips to black in Dark and cannot be borrowed. |

Never freestyle these semantic colors as hardcoded hex — always go through the corresponding token.

### Built-in Themes

The implementation truth is `builtinThemes` in `apps/desktop/src/renderer/themes/registry.ts`; adding or removing themes does not require updating this document. The default light/dark (base) themes are exactly the §2 palette.

### Adding a New Theme (full flow)

1. Create `apps/desktop/src/renderer/themes/builtin/<id>.ts` exporting a `Theme` object:
   ```ts
   export const myTheme: Theme = {
     id: 'my-theme',
     name: 'My Theme',
     type: 'light' | 'dark',
     colors: {
       // Override only the tokens that differ from the base theme;
       // an empty object {} is also valid (identical to base).
       'surface': '#xxx',
       'text-primary': '#xxx',
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

1. **grep `colors.ts` first**: your UI type usually maps to an existing slot/alias (card bg = `--cmd-palette-bg` / `--surface-elevated`, …)
2. **Slots first**: prefer a slot over a component-scoped alias (slots behave more predictably across themes)
3. **HSL tokens must be wrapped**: `hsl(var(--background))`, never bare `var(--background)` (the latter yields a raw HSL string, not a valid CSS color)
4. **No suitable token? Don't force one**: discuss adding a slot/singleton with the user instead
5. **Never** use `bg-[#xxx] dark:bg-[#xxx]` hardcoded pairs — the pre-P2 anti-pattern; it was migrated away once and new code must not reintroduce it

This section is the authoritative token-usage text; i18n rules for UI copy live in `docs/dev-rules/engineering-conventions.md` §5.

### External Theme Import (VSCode / Obsidian)

Settings → Appearance can import a VSCode color theme (`*.json` / jsonc) or an Obsidian `theme.css` and convert it into a local theme. Implementation: `apps/desktop/src/shared/theme-import/` (pure conversion) + `apps/desktop/src/main/local-themes/importer.ts` (dialog / read / write). Rules that govern it:

- **One template, taken from the hand-ported community themes.** The seven ported themes under `apps/desktop/src/renderer/themes/builtin/` (one-dark-pro, github-dark, eclipse, material-ocean-hc, monokai-pro, atom-one-light, solarized-light) share a byte-identical key set of 91 tokens derived from 13 palette roles. `apps/desktop/src/shared/theme-import/palette.ts` is that derivation, code-ified; `one-dark-pro.ts`'s header comment is the source-of-truth for which VSCode key feeds which role. The template is **allow-list only** — it emits exactly those 91 base ids, plus optional Markdown tokens (`md-h1-fg`…`md-h6-fg` / `md-strong-fg`) when the source theme provides heading or bold colors.
- **Exemption families are never imported.** `--login-*`, brand red, `--destructive`, `--error-*`, `--warning-accent`, `--status-bar-accent`, `--focus-ring*`, `--diff-*`, shadows and overlays stay at their spec values under every imported theme (see the exemption table above and §16). `apps/desktop/src/shared/theme-import/protected-tokens.ts` enforces it as a second gate; the import report tells the user how many tokens were held back.
- **`-hsl` tokens are computed, not copied.** Both forms of a color must denote the same color, so the converter derives every HSL triplet from its hex via `toHslTriplet()`. (Note: a few hand-written builtin themes carry approximate HSL values — `github-dark`'s `SURFACE_BG_HSL` was copied off one-dark-pro. Those are left as-is; new imports are exact.)
- **Markdown text colors go through `--md-h1-fg`…`--md-h6-fg` / `--md-strong-fg`, and default to `inherit`.** Before these tokens existed, Markdown headings and bold text inherited their color from the container (`baseComponents` sets size/weight only). Defaulting to `var(--text-primary)` would have repainted headings inside blockquotes, tool cards and secondary-text regions, so the defaults are `inherit` — every built-in theme renders exactly as before. Imported themes fill them from Obsidian `--hN-color` / `--bold-color` or VSCode `markup.heading` / `markup.bold`. Guard: `themes/__tests__/markdownColorTokens.test.ts`.
- **Obsidian import is a palette import, not a theme port.** Only CSS custom properties are read; selectors, layout, radii and fonts are discarded — Cindy's layout and typography stay owned by §3/§5. Values that cannot be evaluated statically (`color-mix()`, undefined `var()`) are skipped and reported rather than guessed.
- **Local themes may declare an optional `family`.** Same-family light + dark variants merge into one switchable family (`themes/families.ts`); files without the field keep behaving exactly as before (family id = theme id). Obsidian's dual-mode CSS uses this to land as a single theme that follows Light/Dark mode.

## 11. Voice & Content(微文案规范)

> **Status: draft**, introduced 2026-06 (after the Voice & Content section of Vercel Geist's `design.md`). This section governs **how interface copy is written** and pairs with `docs/dev-rules/engineering-conventions.md` §5 (the i18n system) — that side enforces "copy lands via i18n keys, aligned across 4 languages"; this side governs each string's tone and wording. It adds no UI strings, only constraints.

Cindy's product voice matches its visuals: **restrained, direct, never self-congratulatory**. Copy is part of the tool, not marketing.

### 11.1 Language-Independent Principles (zh-CN / en / ja / ko alike)

- **Actions = verb + object, never a bare verb.** Buttons and menu items say what is done to what: `Deploy Project` / `删除会话` / `セッションを削除`. **Forbidden**: objectless verbs like `Confirm` / `OK` / `确定` / `提交` (confirm-dialog primary buttons especially must carry the object so they read correctly out of context).
- **Errors = what happened + what to do.** A bare "Failed / 出错了" is not acceptable — give the next step ("Connection timed out — check your network and retry"). Pairs with `docs/dev-rules/engineering-conventions.md` §2 (IPC error protocol): error codes are for code; the user-facing sentence must be human and actionable.
- **In-progress = present continuous + ellipsis.** `Deploying…` / `正在部署…` / `デプロイ中…`. The ChatView Thinking status bar (`Spelunking…`, Thinking Orange) already is this pattern; new loading/processing states follow it.
- **Results name the object — never say "success".** Toasts say what changed, not that an operation succeeded: `会话已删除` not `删除成功`; `Project deleted` not `Deleted successfully`. **Forbidden**: filler like "successfully / 成功了". (Toast visuals are §2; this rule is copy only.)
- **Empty states point at the first action** — never just "No data"; tell the user what they can do now ("No sessions yet — hit + to create one").
- **Neither servile nor cold — per language**: English never writes "Please" (the interface isn't begging). **Chinese 「请」 is idiomatic politeness and is exempt** — keep "请输入…" "请先授权" "请选择文件"; don't stiffen Chinese to satisfy the English rule. Neither language uses marketing adjectives ("强大的 / 极致 / 全新").

### 11.2 Casing & Punctuation Per Language (not transferable)

- **English**: labels / buttons / titles / tabs use **Title Case** (`Deploy Project`); body / help text / toasts use **sentence case**. Curly quotes and the ellipsis character `…`, never straight quotes or `...`.
- **zh-CN**: **no Title Case concept** — no per-word capitalization, no English-style punctuation in Chinese; keep English terms as-is in mixed text (`部署 Project`). No full stop at the end of toasts / labels.
- **ja / ko**: likewise no Title Case; follow each language's particle / politeness conventions, and verify terminology when unsure (per `docs/dev-rules/engineering-conventions.md` §5: no improvised ja/ko).
- **Numbers / units**: Arabic numerals + half-width in all four languages; number-to-unit spacing per language convention.

### 11.3 Self-Check (when touching copy)

- [ ] Action buttons carry an object — not a bare `确定` / `OK`
- [ ] Error copy says what to do next, not just that it failed
- [ ] No "successfully / 成功" filler
- [ ] In-progress states read "present continuous + …"
- [ ] All 4 `common.json` files updated, each matching its language's casing/punctuation (see `docs/dev-rules/engineering-conventions.md` §5)

## 12. Component Spec (merged into §4)

> The structured component-spec pilot (Buttons / Inputs / Cards) was adopted in 2026-07 and folded into §4 in place. This section number is kept as a placeholder: section numbers in this document are stable identifiers referenced by other documents, code comments, and frozen tests — do not renumber (see `design-decision-log.md`).

## 13. Open Spec / Token Gaps

No gaps are currently open.

Resolved items (G1–G4, 2026-06 — button-text drift, border drift, placeholder unification, radius tiering) are archived in [`design-decision-log.md`](./design-decision-log.md); each entry records the drift, the ruling, and where the conclusion was folded back (§2 / §4 / §5 / §10).

Known but deliberately-deferred cleanups (e.g. hardcoded hex in `MakerExperimentalView.tsx`) are tracked in the decision log's backlog section, not here.

## 14. Interaction Conventions(交互约定)

> Introduced 2026-06. This spec used to govern only how things look (color / radius / type / spacing), not how they behave — whether text is selectable, where focus lands when a dialog opens, whether Enter sends or breaks the line; these kept needing case-by-case human correction. This section pins those **non-visual interaction behaviors** as global conventions, complementing §11 (copy tone). Whatever code can guarantee uniformly should not rely on human memory (per "code-first determinism" in `docs/dev-rules/maker-core-and-agent-behavior.md`).

### 14.1 Text Selectability (user-select)

- **Content is selectable**: message body text, code blocks, document previews — anything the user reads sentence-by-sentence or may want to copy. Selectable by default; leave it alone.
- **Chrome is not selectable**: buttons, menu items, labels/chips, status bars, badges, toolbars, sidebar rows — interface-skeleton text gets `select-none`. They are controls, not content; being selectable only gets in the way (typical offender: the goal-status chip label).
- Litmus test: would the user ever think "let me copy this"? Yes → selectable; no (it's just a control) → `select-none`.

### 14.2 Focus Management

- When a dialog / drawer / popover opens, focus lands on the **primary input** (or the primary button if there is no input) — **never** defaults to "Cancel". Radix focuses the first focusable element / Cancel by default — override with `onOpenAutoFocus` (`preventDefault()` + manual `focus()`) or ConfirmDialog's `autoFocusConfirm`.
- On close, focus returns to the triggering element (Radix default — don't break it).

### 14.3 Keyboard & IME (send-type text fields)

Applies to submit-on-Enter fields: the chat composer, goal input, ask input, etc. **Not** ordinary single-line editors in Settings — there Enter must not submit.

- **Enter = submit**, **Shift+Enter = newline**.
- **Enter during IME composition must not submit** — check `event.nativeEvent.isComposing` (a CJK user confirming a candidate must not accidentally send).
- Centralize this logic in code; do not re-implement it per field and let behavior drift (per "code-first determinism" in `docs/dev-rules/maker-core-and-agent-behavior.md`).

### 14.4 Motion & Transitions

> Expanded 2026-07. Cindy's motion character extends the paper-like restraint of §1 / §7: **nothing flies or bounces — things only fade, nudge, and resize smoothly**. Functional state transitions are allowed; decorative motion is forbidden. This section pins "functional" into executable tiers and prototypes so components stop inventing their own durations and curves.

#### Motion tokens (the only tier source)

Global tokens live in `:root` of `apps/desktop/src/renderer/styles/globals.css`; mobile (`apps/mobile`) mirrors same-name same-value constants in `src/theme/tokens.ts` (dual-platform isomorphism, same policy as color tokens, landing with the mobile motion overhaul). **New transitions/animations must reference tokens — no hardcoded durations or cubic-beziers**; 5 duration tiers + 3 curves, the same philosophy as the §5 three-tier radius. Values outside the tiers require design review first.

| Token | Value | Use |
|---|---|---|
| `--motion-instant` | 80ms | Instant hover feedback; light-overlay exit |
| `--motion-fast` | 150ms | Color/opacity state changes (`transition-colors` = this tier); light-overlay enter |
| `--motion-base` | 200ms | Size changes: expand/collapse, panel open/close |
| `--motion-enter` | 250ms | Heavy-overlay (dialog) enter |
| `--motion-exit` | 150ms | Heavy-overlay (dialog) exit |
| `--motion-ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Enter / expand |
| `--motion-ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Exit |
| `--motion-ease-move` | `cubic-bezier(0.4, 0, 0.2, 1)` | Position/size interpolation |

#### Semantics → motion prototypes (one semantic, one motion, app-wide)

| Semantic | Spec | Reference implementation |
|---|---|---|
| Light overlay (menu / popover / tooltip) | In: `animate-float-in` (opacity + scale 0.97→1, fast/ease-out; pure-opacity tooltips use `animate-fade-in`). Out: `animate-float-out` (opacity only, instant/ease-in). **Exit is always faster than enter, and never scales** (a scaling exit reads as "sucked away" — paper fades in place) | `components/ui/dropdown-menu.tsx` |
| Heavy overlay (modal / confirm) | In: 250ms fade + scale 0.95→1; out: 150ms | `components/ui/confirm-dialog.tsx` |
| Expand / collapse | base/ease-move, grid `0fr↔1fr` height + opacity | `features/cc-agent/sidebar/SectionCollapse.tsx` |
| List reorder | FLIP, transform translation | `components/ui/toast/ToastContainer.tsx` |
| Press | `active:scale-[0.98]` (all interactive pills/buttons) | ConfirmDialog buttons |
| Done | **the app's only sanctioned overshoot** (`status-done-pop`) | `globals.css` |
| Running | Opacity breathing; must sit on an HTML wrapper (`docs/dev-rules/engineering-conventions.md` §7) | `session-breathing` |
| Hover / state colors | `transition-colors`, ≤ fast (150ms) | App-wide status quo |
| Container transform (chip grows into panel) | 220ms — see the dedicated category below (explicit exception) | Composer permission/model selectors |

*Reference-implementation paths in this table are relative to `apps/desktop/src/renderer/`.*

#### Red lines (performance & restraint)

- **Persistent/looping animation may only touch `transform` / `opacity` on HTML elements** (compositor-only; `docs/dev-rules/engineering-conventions.md` §7 applies in full; nothing animates on SVG).
- Non-compositor properties (height/grid …) are allowed only in **one-shot transient animations** (user-triggered, with a definite end) — never persistent.
- Every new `@keyframes` / `animate-*` class must be registered in the `prefers-reduced-motion` whitelist in `globals.css` (the global `* { transition: none }` does not catch keyframes).
- Real-time direct-manipulation interactions (resizer drag, drag-follow) get **no easing** — following the hand IS the feedback.
- Forbidden: pointless displacement, bouncing, parallax, looping decoration, `transition-all`, and typewriter per-character animation on streamed text (streaming already is the motion). Interactions stay fast and direct.

#### Exception category: container transform (chip lifts off and grows)

- The second sanctioned motion class (added 2026-07-21, revised 2026-07-22), exclusively for composer-toolbar controls whose trigger chip anchors the panel (permission selector / model selector / the + menu):
  - **Definition**: the panel does not simply appear over the trigger — it morphs from the trigger chip's exact geometry (position / size / pill radius / pill fill), growing while **translating away as a whole**, docking on the chip's opening side with a 6px gap; closing reverses back into the chip. **The trigger chip stays visible and interactive throughout** — clicking the chip while the panel is open closes it (preserving the "tap again in place to dismiss" muscle memory). An "in-place replacement" variant (chip hidden, panel occupying its spot) was tried and retired — it loses toggle-to-close and complicates timing; do not regress to it. **Both open and close must fade as a whole, coupled with the translation** (if the frames where panel and chip overlap were opaque, the chip content would flash-hide — fade in while lifting, dissolve while shrinking back); positionless pure fade-in/out is forbidden.
  - **Parameters**: **220ms** (symmetric open/close; tightened from 300ms, finalized 2026-07-22), easing `cubic-bezier(0.3, 0.9, 0.25, 1)` (fast start, long settle); menu rows may stagger fade-in ≤20ms/row. This is an **explicit exception** to the ≤150ms baseline, confined to this category — it must not leak into other transitions. While morphing, the panel content must not scroll (a flashing scrollbar squeezes row width and jitters row ends); enable scrolling only after the animation completes.
  - **Radius interpolation**: the morph's starting radius is half the chip height (e.g. 30px chip → 15px), **never 9999px** (interpolating 9999→12 balloons the mid-frames); the end value is the container 12px.
  - **Implementation red lines**: (a) must degrade to a hard cut under `prefers-reduced-motion`; (b) temporarily disable transitions while measuring target geometry (otherwise `offsetHeight` at frame 0 of a width transition lays out at the old width and measures a false height when text wraps); (c) as a one-shot open/close animation it is exempt from the "persistent animations are compositor-only" red line (`docs/dev-rules/engineering-conventions.md` §7), but must still hold 300ms without dropped frames on low-end Windows, verified on hardware; (d) focus / Esc / outside-click / focus-return semantics are identical to §14.2 — morphing exempts nothing in a11y.
  - **Scope boundary**: only "trigger grows into panel" controls. Ordinary Dialog / ConfirmDialog / Toast / lightbox do not qualify (no chip anchor — they keep their current motion). The narrow variant (button-width expansion) is allowed only for **information-bearing expansion** (e.g. the recording red dot + timer, ≤240ms); purely decorative hover label reveal (e.g. + expanding the word "Add") was evaluated and removed — do not re-add.
- **Composer toolbar: two chrome tiers, one set shared between in-session and the create dialog (finalized 2026-07-22)**:
  - **Morphing-dropdown tier (+/permission/model)**: bare at rest (`border border-transparent bg-transparent`); the pill outline appears only on hover (`hover:border-[var(--border-default)]` + `composer-pill-bg`); selected/danger tiers tint the text only, never the fill.
  - **Persistent-tool tier (voice/send)**: permanent outline / solid CTA (voice: `composer-pill-bg` + `border-default`, hover `model-trigger-hover`, recording state `surface-chip` fill + red-dot timer expansion; send: `send-btn-*` neutral-inverse solid).
  - **In-session (default) and the create dialog (create-agent) must match verbatim**: the five shared controls (+/permission/model/voice/send) no longer fork styles by `visualVariant`; `create-agent-control-*` / `create-agent-send-*` must not be used for these five controls (they remain only for the create dialog's own Claude|Codex segmented switch and its top mode/project/branch pills). Changing any control's chrome changes both surfaces. Contract test: `newMakerCreateAgentVisualContract.test.ts`.
- **Quota-reset confetti** — the third sanctioned motion class (approved 2026-07-23), **only** for the status-bar usage chip's "quota window reset reveal" (countdown hits zero → suspense "resetting…" → new snapshot lands):
  - **Definition**: the instant the new snapshot confirms the reset, throw confetti once from the center of the revealing window segment, simultaneous with the 0%→100% percentage roll — making "the quota is back" a perceptible moment of celebration.
  - **Form** (finalized over four/five review rounds, 2026-07-23): **true parabolic toss + vanish on landing** — all particles launch simultaneously from the segment center in a ~**100° fan** (±50° of straight up) at equal speed, **constant horizontal velocity + constant vertical gravity** (decelerating up, accelerating down past the apex), so perceived speed is consistent from burst to fall; wider-angle particles fly lower arcs, travel farther, land earlier — the scatter comes from physics, not scripting. The final stretch before the ground line ends in a **short fade**: landing is fine, but lingering after landing ("corpsing") or vanishing without a fade is forbidden; the ground line jitters randomly so landing points don't queue up.
  - **Parameter red lines**: a one-shot celebration — simultaneous launch, no stagger delay; per-particle duration follows arc physics clamped to 0.9s–1.6s, total ≈1.6s (the number roll settles at 1.2s, then the last confetti falls a few tenths more; arc scale and rhythm are user-tuned, finalized 2026-07-23); ≤18 particles, 3–5px, torn down when done, never looping or persistent; particles are HTML elements animating only `transform` / `opacity` (compositor-only, engineering conventions §7; x/y split across two nested spans keeps horizontal velocity constant); colors come only from the four status-dot hue exemptions (done green / awaiting teal / thinking orange / error red), same values in both modes; must skip entirely under `prefers-reduced-motion`.
  - **Scope boundary**: this one spot only. Confetti must not leak into task completion, send success, or anywhere else — those stay on the §14.4 baseline (a new exemption requires a new entry here). Implementation: `apps/desktop/src/renderer/components/status/QuotaResetConfetti.tsx`.
- **Retired: mobile-download QR brand edge** — a rotating app-icon edge on the `MobileDownloadDialog` QR card was briefly registered here as a fourth (persistent) motion class on 2026-07-25 and **removed the same day** at the user's request: read as a strange ring turning behind the code. There is **no sanctioned persistent decorative motion** — the red lines above hold without exception. The card is now a bare QR (no edge, no border, no shadow, no tilt); its only motion is the linked ↔ onboarding size tween. Do not re-add. Contract test: `mobileDownloadDialog.test.tsx` → `keeps the QR card flat with no brand edge`.

## 15. CINDY Skin Family(品牌化可选 family)

> This section records the CINDY skin family; it does **not** rewrite the §1–7 default-skin rules. Values were finalized from design-stage working files (`skin-docs/10-specs/` desktop, `skin-docs/30-mobile/` mobile errata — **not in this repo**, same status as the §16 login working files) plus the user's final sign-off of 2026-07-18. Zero discretion at implementation time: within the repo, the authoritative encodings are the theme files (`cindy-light.ts` / `cindy-dark.ts`), `cindyDecisionData.ts`, and the frozen tests — this section is their prose summary.
>
> Subsection numbers are **stable identifiers** (referenced by §16, code comments, frozen tests, and other documents; 15.9 was never assigned) — do not renumber. Decision history for this section is archived in [`design-decision-log.md`](./design-decision-log.md).

### 15.1 Palette (extracted from Figma text nodes)

| Semantic | Light | Dark |
|---|---|---|
| Brand red | `#DF0C27` | `#DF0C27` |
| Deep brand red (hover/pressed) | `#A61629` | `#A61629` |
| Background | `#EDEDED` | `#2A2828` |
| Card / input | `#F8F8F8` | `#312F2F` |
| Border | `#DCDFE3` (desktop; mobile light is a global exception `#C6C9CE` — see 15.13 "Cross-platform color isomorphism") | `#434343` |
| Secondary info | `#8C8E94` (re-tuned from Figma `#9A9DA3` in two rounds, finalized 2026-07-20) | `#6F6F6F` |
| Body text | `#3C3F43` | `#D4D4D4` |
| Pure white | `#FFFFFF` | `#FFFFFF` |

### 15.2 Red-Boundary Test Maps(品牌红边界)

- Current authority (post-E1D, see 15.10): `NEUTRAL_PRIMARY_EXPECTED_BY_ID` / `NEUTRAL_PRIMARY_FOREGROUND_BY_ID` (exact neutral values for primary actions) + `RED_EXCEPTION_ALLOWED_IDS` (the complete set of tokens allowed to contain red), all in `apps/desktop/src/renderer/themes/__tests__/cindyDecisionData.ts`.
- One-way ban: any token outside `RED_EXCEPTION_ALLOWED_IDS` containing `#DF0C27` / `#A61629` fails the suite.
- The pre-E1D `BRAND_RED_*` maps are retained in `cindyDecisionData.ts` only for D2T migration and are marked for deletion; their contents are archived in the decision log — do not treat them as current rules.

### 15.3 Interpolation Table (sRGB per-channel `round(A+(B-A)*t)`)

See the skin decision table §2 (design-stage working file, not in repo). The Light/Dark 20/40/65/75% shades are frozen with exact values in unit tests (`#EFEFEF/#F1F1F1/#F4F4F4/#F5F5F5`, `#2B2929/#2D2B2B/#2F2D2D/#2F2D2D`).

### 15.4 Cross-Theme Exemptions (not covered by CINDY overrides)

- Semantic colors: `warning-accent` `#EA6B17` (finalized 2026-07-17, replaces `#FF6600`) / `annotation-accent` `#FF3B30` (image-annotation burn-in ink — exempt, do not change) / `status-bar-accent` (alias of warning orange, auto-follows).
- The status four (finalized 2026-07-17; same values both modes, all 9 themes follow with no override): running `#EA6B17` / awaiting `#19D2C1` / error (status family) `#D91F37` / done `#2AAE5B`; warning foreground `warning-fg` `#F3A115` (decoupled from Toast amber `#F59E0B` — Toast keeps its group-B status quo).
- `focus-ring` `#417CDD` (blue — never red); diff red/green; modal scrim/shadows; `overlay-lightbox`; the four Toast colors.
- `destructive` / `search-match-bg` stay outside HSL_FORMAT_IDS coverage.
- **hljs syntax colors** (light = highlight.js `github.css`; dark = globals.css `.dark .hljs-*` mirroring github-dark) — dual-threshold ruling (2026-07-17): syntax colors ≥3:1, body text ≥4.5:1. The hljs palettes were designed for GitHub's default canvases; CINDY's code-block canvas (`surface-elevated` `#F8F8F8`/`#312F2F`) sits close to default's, so marginal shortfalls are inherited, not CINDY-introduced (default is equally affected). Light: all syntax colors ≥3 — no remediation, itemized as exemptions. Dark: `[data-theme="cindy-dark"]` overrides `.hljs-section` to `#2573ec` (reaches 3.00:1) and sets `.hljs-punctuation` / `.hljs-tag` explicitly to `#c9d1d9` (defensive). Guarded by `cindyCodeBlockContrast.test.ts` (≥2 baseline + text ≥4.5). Full derivation: decision log.
- model-budget spectrum bar / GhostTool shimmer: explicitly exempt (neutral shimmer, theme-invariant).

### 15.5 U2 Explicit Exception (secondary-info color stays true to Figma)

- Tokens: `text-secondary` (light `#8C8E94` / dark `#6F6F6F`) / `text-secondary-cross` (light stays `#9A9DA3`, not re-tuned).
- Measured contrast (WCAG): × surface `2.32/2.92:1`, × elevated `2.56/2.65:1`, × chip `2.41/2.72:1` — all below the 4.5:1 body-text AA. Ruling **U2 (2026-07-16): stay true to the Figma values**, readability loss accepted as a recorded explicit deviation. (Light was later re-tuned in two rounds to `#8C8E94`, finalized 2026-07-20, desktop and mobile in sync — see decision log.)
- Constraint: **never darken unilaterally** (`#686B72` was tried and rejected, kept only as an archived sample); changing the value requires a fresh user ruling.
- Reverse-frozen test: `cindyThemes.test.ts` group ⑦ asserts the exact finalized values (light `#8C8E94` / dark `#6F6F6F`); injecting `#686B72` must fail; update the baseline only after a user ruling.

### 15.6 HSL Format Contract

The 42 `HSL_FORMAT_IDS` must be HSL triplets (`h s% l%`, `h∈[0,360)`, grays use `hue=0`, 1 decimal place); every other token is hex/rgba. Round-trip HSL→RGB channel error ≤1. Nothing outside `HSL_FORMAT_IDS` may be written as an HSL triplet.

### 15.7 Brand Assets (icon + logo)

The new-session brand block is fixed at a 50×50px square icon + 110×37.5px horizontal logo with a 9px gap (2026-07 design). `ThemeBrandLockup` is the sole renderer. Themes swap artwork only via `theme.brand.icon/logo` — never rescale the finalized lockup; local images are cropped at load time to their alpha visible bounds (source files untouched). cindy-light uses the black-text logo (`cindy-logo-light.png`), cindy-dark the white-text one (`cindy-logo-dark.png`).

The brand block reads only `brand.icon/logo` — no compatibility with the legacy top-level `logo`, `logoScale`, or the interim `brand.mark/wordmark`; the structures differ semantically, never guess a mapping. Settings → Appearance keeps only three light entries (local theme copy, open folder, refresh) — no brand preview or asset picker. Exported standard JSON ships self-describing example paths (`icon-square-50x50px.png` / `logo-horizontal-110x37.5px.png`) so the config file documents both purpose and final display area; sources may export 2x/3x at the same aspect ratio. No extra README, no JSONC.

> The logo-asset red `#F70121` is intrinsic to the official brand artwork (the WORD MARK arrow glyph); it coexists with — and differs from — UI brand red `#DF0C27`. Logos are image assets outside the token system; keep the original color. Do not "correct" it to `#DF0C27`.

The splash wordmark is a separate asset pair (`assets/splash/wordmark.png`, white text, for DARK / `wordmark-light.png`, dark text, for LIGHT): both 459×156 (@2x) with a 229.5×78 render frame (its exact 2x full frame), and **neither carries a drop shadow** — `SplashScreen.test.tsx` asserts the absence. (Asset-size and shadow history: decision log.)

**Sanctioned brand surface — mobile download dialog (approved 2026-07-25).** The fourth surface allowed to carry brand artwork, alongside login / splash / new-session:

- **Where**: `components/sidebar/MobileDownloadDialog.tsx` only, and only the dialog header icon (64px `resources/icon.png`). This is a promotion surface for the mobile app, so showing the app's own icon is identification, not decoration.
- **Constraints**: the color comes only from the official asset — no component-authored gradient or brand hex. The QR card itself carries **no brand edge, no border, no shadow and no pointer 3D tilt**: a 2px edge made of the scaled app icon was tried on 2026-07-25 and removed the same day (it read as a strange ring rotating behind the code — see §14.4). Do not re-add it in any form, static or animated.
- **Scope boundary**: this dialog only. Other working-UI surfaces keep the neutral treatment; a new brand surface needs a new entry here. Contract test: `mobileDownloadDialog.test.tsx` → `keeps the QR card flat with no brand edge`.
- **Reference renders** (light theme, zh-CN, @2x — `assets/mobile-download-dialog/`): [local mode](assets/mobile-download-dialog/guest-local.webp) (QR only — no account, so no permission card) · [signed in, no linked mobile](assets/mobile-download-dialog/onboarding.webp) (228px QR + permission card) · [signed in, mobile linked](assets/mobile-download-dialog/linked.webp) (132px QR + device list). Re-shoot these when the dialog's layout changes. **Stale as of 2026-07-25**: all three still show the retired brand edge around the QR — read them for layout only, not for the card's treatment.

### 15.8 status-badge-fg

- The orange badge (bg `status-bar-accent` `#EA6B17`) has its own foreground token `status-badge-fg`: **default mirrors `accent-pure-cta-fg`** (light white / dark black — zero change for the 9 existing themes); **CINDY overrides both modes to `#1F1F1F`** (near-black), contrast × `#EA6B17` = **5.19:1 ≥ 4.5** (user-approved; darken toward `#000000` if a future orange fails 4.5).
- Consumers: `ContactsListPane:150` uses `status-badge-fg`; the `surface-on-card` consumers that sat on red CTAs (`RolePillDropdown:543/544`, `SkillhubDetailView:504`) moved to `accent-pure-cta-fg` (white); `surface-on-card` stays neutral-inverse (Fast toggle thumb). Registered in `cindyDecisionData` (a D2-phase addition).

### 15.10 Red-System Boundary & Neutral CTAs — current state(E1D 红色边界)

- Ordinary primary actions never use brand red — they are neutral-inverse. **Neutral button four states**: light bg `#3C3F43` / text `#FCFCFC`, hover `#2E3237`, pressed `#25282C`; dark bg `#EEEEEE` / text `#252222`, hover `#E2E2E2`, pressed `#D4D4D4` (WCAG 10.32/13.60:1).
- Red is confined to semantic exceptions: `destructive`/delete, `error-*`, warning, diff red, status dots — plus the login brand accent via `--login-brand-accent` (§16). The older `brand-login-*` tokens were retired with the wave4 white-canvas login and survive only as whitelist strings in `cindyDecisionData.ts` (harmless — the whitelist permits, it does not require).
- **send-btn family**: `send-btn-bg/-icon/-hover-bg/-pressed-bg/-disabled-bg/-disabled-icon` — CINDY overrides the whole family to the neutral four states + disabled grays `#444242`/`#585555`; defaults keep `--accent-cta-bg` with the opacity-85 hover. Whole family sits in `cindyDecisionData` REQUIRED_IDS + CINDY_EXPECTED, guarded by assertion ③.
- **Sidebar color hierarchy** (same set for light/dark):
  - Body (session titles) = `text-foreground` (= `text-primary`: light `#3C3F43` / dark `#D4D4D4`).
  - Secondary gray (leading icons at rest / timestamps / meta / group labels) = light `#9A9DA3` / dark `#6F6F6F` (same as `text-secondary`); CINDY overrides `sidebar-muted` / `sidebar-action-icon` (HSL `220.0 4.7% 62.2%` / `0 0% 43.5%`) + `cmd-palette-item-meta` (hex).
  - Selected pill = inverse pill: `sidebar-item-active` light `#3C3F43` / dark `#EEEEEE`, foreground `sidebar-item-active-foreground` light `#FCFCFC` / dark `#252222`, border transparent. **Any foreground sitting on `bg-sidebar-item-active` must use `text-sidebar-item-active-foreground` — `text-foreground` is forbidden there** (the token defaults to foreground, so non-CINDY themes see zero change).
  - Running-state leading icons (vendor glyph / Puzzle / RadioTower / Clock) = **Thinking Orange `--warning-accent` `#EA6B17`**, breathing via `session-status-breathing`; the selected state stays orange (running outranks the inverse foreground). Mobile `statusAccent` mirrors value and priority. Persistent breathing sits on an HTML wrapper; SVG stays static (engineering conventions §7).
  - Assertions: ③ CINDY_EXPECTED locks the 4 token values; ⑦ adds hierarchy assertions (secondary gray clearly weaker than body; selected-pill foreground ≥4.5 on its fill).
- Test maps: `NEUTRAL_PRIMARY_EXPECTED_BY_ID` / `NEUTRAL_PRIMARY_FOREGROUND_BY_ID` + `RED_EXCEPTION_ALLOWED_IDS` (replacing the pre-E1D `BRAND_RED_*` maps — archived in the decision log). Assertions ⑤/⑦/⑧ enforce exact neutrals, the red whitelist, neutral contrast, and falsifiability.
- Backlog: the five R2 §4.3 Project_List deviations stay deferred (see the decision log backlog).

### 15.11 Input Caret (`--caret-accent`)

- Every editable input surface takes its caret color from the `--caret-accent` token. `globals.css` owns this globally (native `caret-color` plus the ProseMirror pseudo-caret); components MUST NOT set their own caret color.
- Value: default themes = `var(--accent-cta-bg)` (neutral inverse, follows the theme). CINDY overrides both modes to `#417CDD` (information blue, same value as the focus ring); removed from `RED_EXCEPTION_ALLOWED_IDS`, value locked by `cindyDecisionData.ts`.
- Do not wire the caret to any red token — red is not in the caret's allowed palette.
- Do not alias the caret to `--focus-ring` even though the values match: the semantics differ, and `--caret-accent` must stay independently adjustable.
- Mobile parity: `inputCaret` in `apps/mobile/src/theme/tokens.ts` carries the same value in both modes, consumed via TextInput `cursorColor` / `selectionColor`; `themeTokens.test.ts` locks it.

*(Finalized 2026-07-18 after two same-day revisions — earlier "brand-red caret" wording anywhere is void; see design-decision-log.md.)*

### 15.12 Vibrancy (frosted glass) System (macOS; finalized 2026-07-18)

- **The only translucent-surface token**: `surface-translucent-sidebar` — CINDY light `rgba(255, 255, 255, 0.85)` / dark `rgba(18, 15, 15, 0.75)` (defaults to opaque `var(--surface)` in the default theme; zero effect on non-CINDY themes). Consumer: the left sidebar (`aside.bg-sidebar`); any future translucent surface **reuses this token by default** — no new ad-hoc rgba. The splash root is opaque `--surface` (it must fully cover the mounted UI until loading completes — ruling 2026-07-19).
- **Wallpaper-through triple pipeline — missing any one yields dead black** (verified by on-device A/B, 2026-07-18):
  1. Set `backgroundColor: '#00000000'` + vibrancy **at window creation** (`bootstrap-electron.ts` / `vibrancyConfig.ts`); changing alpha via `setBackgroundColor` at runtime is unreliable.
  2. Under CINDY themes the **root container steps aside**: globals.css sets `.h-screen.bg-content-area` (and the splash backing layer while present) to transparent — otherwise the opaque root blocks everything.
  3. **No CSS `backdrop-filter`** — it renders the transparent window backing as a black box; wallpaper blur is entirely the native vibrancy material's job, CSS only lays the translucent tint.
- Material selected via the `XDT_VIBRANCY_MATERIAL` env knob, **code default `hud`** (user-tested). Windows: Win11+ uses `backgroundMaterial` (default `acrylic`, `XDT_BACKDROP_MATERIAL` knob — not yet device-verified); Win10 / non-CINDY fall back to opaque `--surface`.
- **No gradient overlays on translucent surfaces** — the light-red gradient layer was confirmed absent from the design and removed wholesale (2026-07-18); the splash gradient glow is likewise unimplemented (backlog, awaiting a ruling).
- The `surface-translucent-sidebar` alpha is the **only open look-and-feel knob** in the theme-frozen zone; adjusting it requires synchronized changes in three places (`cindy-light.ts` / `cindy-dark.ts` / `cindyDecisionData.ts`) with the themes suite green.

### 15.13 Cross-Platform Skin Rules(双端换肤定稿规则,2026-07-18)

The execution rulebook for subsequent desktop / mobile UI updates. Sources: the skin-docs working files (not in repo) plus the 2026-07-18 dual-platform acceptance.

#### Red boundary

- Brand red `#DF0C27` only for brand display / splash, destructive actions, running/thinking emphasis, and the list active glyph (dark uses `#A61629` for the glyph).
- Ordinary CTAs, FABs, send buttons, and confirm-style primaries are neutral-inverse: light bg `#3C3F43` / text `#FCFCFC`, dark bg `#EEEEEE` / text `#252222`. Never brand-red these.
- The red whitelist does not include carets, focus rings, ordinary buttons, or ordinary selected backgrounds. A new red consumer must document its semantics and enter the token/test whitelist first; no component-level hardcoding.

#### Caret & focus

- All input carets (`cursorColor` / `selectionColor`) are blue `#417CDD`, equal to `permAutoAccent` / desktop `caret-accent`; same value both modes.
- Focus ring, Auto Approval, and info blue share the `#417CDD` family. Figma's older blue `#426BF2` is not adopted.
- Red-family carets are forbidden.

#### Cross-platform color isomorphism

- Mobile color semantics must mirror the desktop token decisions: the base layers (background, body, secondary info, borders) map directly from CINDY desktop semantics — never invent a parallel mobile palette for the same meanings.
- **`colors.border` light is a mobile-wide exception, not a homepage-scoped token** (ruling 2026-07-21, PR #266): mobile light `border` / `borderTranslucent` = `#C6C9CE` / `rgba(198,201,206,0.62)`, deviating from desktop `#DCDFE3` — desktop borders usually sit on `#F8F8F8` cards, while mobile hairlines sit directly on the `#EDEDED` background, where `#DCDFE3` reads at a nearly invisible 1.14:1; the darkened 1.42:1 is device-verified legible. The value lives in `apps/mobile/src/theme/tokens.ts` global `lightColors.border`, applying to every mobile-light hairline; dark stays `#434343`, isomorphic with desktop. `chatCodeBorder` / `sheetActionBorder` / `sheetGrabber` keep independent values and do not follow this exception.
- Mobile-only tokens carry only mobile-specific layers or geometry:

| Mobile token | Light | Dark | Use |
|---|---|---|---|
| `surfaceListRow` | `#F6F6F6` | `#312F2F` | List project/task rows |
| `surfaceListExpanded` | `#EAEAEA` | `#2A2828` | Expanded list block |
| `activeGlyph` | `#DF0C27` | `#A61629` | Leading active glyph in lists |
| `chatCodeSurface` | `#F8F8F8` | `#353333` | Chat / task code card |
| `chatCodeBorder` | `#DCDFE3` | `#3C3C3C` | Chat / task code card border |
| `inputCaret` | `#417CDD` | `#417CDD` | All input carets |
| `sheetSurface` | `rgba(248,248,248,0.95)` | `rgba(59,59,59,0.95)` | Bottom-sheet root |
| `sheetActionSurface` | `#F6F6F6` | `rgba(59,59,59,0.5)` | Sheet action group / row |
| `sheetActionBorder` | `#DCDFE3` | `#505050` | Sheet action group / row border |
| `sheetActionText` | `#3C3F43` | `#C1C1C1` | Sheet action row label |
| `sheetGrabber` | `#DCDFE3` | `#6F6F6F` | Sheet / composer grabber |

#### Iconography

- Session leading agent icons follow runtime identity: the Claude Code official pixel face / the Codex CLI `>_` multi-petal mark; desktop (`VendorIcon`) and mobile (`MobileVendorIcon`) share source assets (finalized 2026-07-20). Agent identity marks must not be mixed with Anthropic / OpenAI provider or model brand marks; `BrandArrow` is reserved for brand decoration.
- Model selection renders by model brand. Brand icons already replaced on desktop are reused on mobile from the same source; everything else uses semantically equivalent lucide glyphs.
- Send semantics use the filled paper plane `Send`, colored by the neutral-inverse CTA tokens; never a red send button or icon for ordinary send.

#### Type & layout

- List pages use card density: 20pt gutter, 60pt row height, 12pt radius, 55pt FAB. Never regress to the loose legacy list or red ordinary CTAs.
- Chat headers use the frosted / translucent glass system: prefer `BlurBackdrop` + the dedicated chat-header tokens; where blur is not wired up, use translucent solid tokens + hairline — no unverified new blur entry points.
- Sheets consistently use the sheet tokens. Restyling shared components (`SheetSurface` …) defaults to variant isolation: only the surfaces the design covered (tasksheet / `SessionActionSheet` / `SessionMenuSheet`) take the new style; ContextSheet, ModelPicker, info sheets do not auto-follow.
- Hairline separators inside expanded blocks: every row but the last; colors via tokens, never hardcoded (see the mobile-light global border exception above).

#### Process gates

- New or changed colors go through tokens — desktop via ColorRegistry / CSS variables, mobile via `ThemeColors` / `useTheme`; no hex/rgba in components.
- `hardcoded-color-audit` (`scripts/hardcoded-color-audit.mjs`) must pass before merging. ⚠ Not yet wired into CI as a required check — run it manually for now; CI enforcement is tracked as a follow-up (modularization plan P6-3'). Genuine exceptions (asset-intrinsic or platform-semantic) must be whitelisted with reasons.
- When a design mock conflicts with existing tokens, list it as "pending ruling" in the spec / PR and request a decision — never self-adjudicate or substitute a near color.
- Shared-component restyles default to variant / prop isolation. Pages, states, and platforms not covered by the mock keep the status quo.

### 15.14 Running / Collaboration Orange (finalized 2026-07-20)

- **Running breathing icons are always Thinking Orange** (`--warning-accent` `#EA6B17`, all themes): VendorIcon, SessionStatusIcon (Puzzle/RadioTower), AutomationSessionGroupItem (Clock); the selected state stays orange — priority: running > selected inverse foreground > rest. Mobile `statusAccent` mirrors value and priority (glyphColor same).
- **Collaboration toggle ON state is orange**: CollaborationModeToggle's active text + Puzzle icon use `warning-accent` (an explicit carve-out from the 2026-07-17 "composer pills go neutral" rule — ON state only; the OFF entry state stays neutral).
- **SVG persistent-animation red line**: breathing-type persistent animation sits on an HTML wrapper (span); SVG stays static.

### 15.15 Create-Page Content Position + Titlebar Hover Discipline (finalized 2026-07-21)

- **CREATE AGENT content-group vertical position**: constant `max(96px, 28vh) + 46px` from the window top.
  Implementation = route container `pt-[calc(max(96px,28vh)+46px-var(--content-header-h,46px))]`:
  - the 268px cap is dead (a leftover of the Figma frame height — the root cause of content sitting high on large windows); 28% is device-tuned (from 25.5%);
  - `--content-header-h` is broadcast by `ContentHeaderSlot` (inside FeatureSidebarSlotProvider) through a display:contents wrapper (46px rendered / 0px hidden, same source as ContentHeader `h-[46px]`) — content stays pinned at the "header present" position with **zero jump** when selecting a project toggles the header;
  - header visibility has a single decision source = `useContentHeaderHidden` (mac + sidebar expanded + no injected content + no right-panel toggle; continues the 2026-06-11 "hide empty header" ruling);
  - guard: `newMakerCreateAgentVisualContract` locks the position formula + anti-regression assertions.
- **Hover-token discipline**: `--update-btn-hover` is exclusively the upgrade button's hover (inverse dark CTA) — **forbidden** on ordinary ghost buttons/badges (near-black `#2E3237` under CINDY light swallows text and icons; 6 misuses cleaned up 2026-07-21). Correct picks:
  - titlebar-area (ContentHeader) ghost elements → `titlebar-button-hover` (same as the ChromeActions window buttons);
  - general light hover in the content area → `--surface-hover`.

## 16. Login Flow (登录链路)

> 本节是登录全链路的设计系统规范。逐参数权威 = 同目录的 [`figma-component-spec.md`](./figma-component-spec.md)（组件 / 色板速查，nodeId 溯源）与 [`token-decision-table.md`](./token-decision-table.md)（token / 尺寸决策）——两份自 2026-07-24 起随 `docs/design-rules/` 入仓维护；`DESIGN-login`（逐屏规格）、`flow-map`（状态机）、`fidelity-matrix`（保真度验收矩阵）仍为设计阶段工作文件，不入仓库。本节不重复抄全表，只钉死设计规则与组件契约，逐参数值以 Figma 组件库及本节色板表为准。
>
> **交付状态**：**亮色** as-built 已合并入 main；**深色**为目标规格（色值经 Figma 组件库 Dark symbol 逐个核验，见 §16.1 双态表 / §16.5），token 已注册但 dark 槽位当前为 light 占位值，待实现 PR 填入真实深色值。两模式均受 §10「Light / Dark 双模式交付门槛」约束——非可选愿景。
>
> 本节独立于 §1–§15 默认皮肤与 CINDY 皮肤族——登录页是独立白底 / 深底反色体系，**不消费编辑器主题的 `--surface` / `--text-*` 等 slot**，只走本节定义的 `--login-*` token（light / dark 二态已注册于 `apps/desktop/src/renderer/themes/colors.ts`；见 §10）。`--login-*` 随基础 light / dark **二态**切换，但**不跟随具体扩展主题**（登录页只认 light / dark 模式；首次亮、后续跟随见 §16.5）。

### 16.1 视觉风格

登录页是**黑白反色**体系（亮色 = 白底墨字 / 深色 = 深底米字），与编辑器主界面解耦，亮 / 深两模式镜像同构：

- **面板 / 控件走墨黑–米白反色，深色镜像反相**：亮色白面板 `#FBFBFB` + 米白控件 `#EEEEEE` + 墨黑主按钮 `#2A2828`；深色反相为深面板 `#312F2F` + 深控件 `#2C2A2A` + 白主按钮 `#EEEEEE`。**两模式的面板 / 控件底色与文字都不出现纯黑 `#000` 或纯白 `#fff`**（`figma-component-spec §1.1`）；细描边例外——暗色主按钮 / 圆钮的 `#FFFFFF` 白边为 figma `white_button` 实测值，不受此限。
- **品牌红 `#DF0C27` 只用于区域徽标（旧称 Global pill，见 §16.3）与字标红元素等品牌 accent，跨模式不变**；**禁止作页面背景**（wave4 改判，见 `token-decision-table §3` 对 `#df0c27` 的语义判定），不渗入面板内部（呼应 §15.10 红色边界）。画布底走 `--login-bg-base`（亮 `#EDEDED` / 深 `#1F1F1E`），红只经 `--login-brand-accent` 消费。错误红 `#D91F37` 同样跨模式不变（语义豁免，呼应 §10 豁免族）。
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

**交互态**：hover（仅桌面）/ pressed（双端）/ disabled / loading 五态。态叠层挂伪元素（桌面 `::after`）/ overlay View（手机），**不动图标 / 文本子节点**；disabled 叠层走 `--login-disabled-button-overlay` token。hover / pressed 叠层**暗色落地前**为 figma 实测 rgba 字面值（亮色 as-built 现状）；**暗色 PR 起 token 化为 `--login-overlay-*` 二态 token**（叠层方向随模式反转，见 §16.5），此后组件内禁止新增字面 rgba 叠层。态系细则见设计阶段工作文件 `DESIGN-login §2`(不入仓库)。

**常驻动画 compositor-only**：spinner / loading 环动画挂 HTML（桌面）/ `Animated.View`（手机）外层 wrapper，SVG 图形保持静态（呼应 §14.4）；`prefers-reduced-motion` 直落静止。面板入场 handoff 动画是 §14.4 容器形变的窄变体（双端冻结 420ms 升起 + 渐显，`LOGIN_HANDOFF_TIMINGS.panelMs` / `panelInMs`）。

**Apple「Sign in with Apple」按钮**：iOS HIG 硬性要求使用 Apple 官方按钮样式，**不可皮肤化**——iOS 上 Apple 槽位保持原生 `ASAuthorizationAppleIDButton`，不套 `LoginSocialButton` 皮。这是合规底线，非视觉遗漏。其余社交圆钮（Google / WeChat / SSO）正常上皮。

**i18n**：登录文案走 `react-i18next`（桌面 `common.json` `login.*` 节）/ `loginMessages`（手机），4 语对齐 `zh-CN` / `en` / `ja` / `ko`（zh-TW 已随旧仓 #488 回退对齐主干四语基线——设计阶段旧文（不在仓库内）的五语门为回退前遗留，待清理，以本节四语为准）。4 语全部翻准，不留空（空 key 静默回退英文）。

**多语言长文本与翻译长度预算（2026-07-24 拍板）**：

- **原则：登录链路里截断与省略号不可作为可见结果**。登录面板是 680×440 冻结几何、槽位不撑高，长文案没有退路——所以约束加在**文案侧**：所有 `login.*` 文案（含 agent 代写 / 补翻的四语文本）必须言简意赅、按槽位长度预算写作。线上出现可见省略号 = 该语言文案超预算 = **文案 bug（P1，修文案，不改布局）**。
- **长度预算自检**（写 / 翻文案时逐语言过一遍）：估宽公式——汉字 / 假名 / 谚文 ≈ 1×字号 px，拉丁字母 / 数字 / 空格 ≈ 0.5×字号 px；估宽 ≤ 槽宽 × 0.95 才算过。常用槽预算：

  | 槽 | 宽×字号 | ≈汉字上限 | ≈拉丁字符上限 |
  |---|---|---:|---:|
  | 标题 | 680 @32 Bold（徽标变体为 inline 组：标题 shrink-to-fit + 2px 间隔 + 区域徽标，徽标宽随文案自适应，按现役最宽的 `Dev`（实测 51.7，非本表估宽公式的 46——公式是文案自检用的保守估算，徽标宽度以实测为准）算可用宽 680−54=626；v3 2026-07-27，原「固定 70px 徽标」几何随 Global 徽标撤除一并作废） | 20（徽标变体 18） | 40（徽标变体 37） |
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
| `LoginTitleBlock` | 双 | 标题 + 副标题 | `title`, `subtitle`, `regionPill?`（桌面） | 标题 y=31 h=38 32 Bold `--login-title-text`；副标题 @(70,75) 540 宽 ≤2 行顶对齐 20 Regular `--login-secondary-text`（2026-07-24 拍板，原 599×23 单行作废）。区域徽标见下方专条 |
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

**区域徽标（`LoginTitleBlock` 的 `regionPill`，桌面；figma §4.10 胶囊 h30 r40，2026-07-27 改判）**：标题右侧品牌红胶囊，`--login-brand-accent` 底 + `--login-inverted-button-border` 白字 16 Bold，inline 组内 gap 2、垂直居中于 38 行框。

- **挂哪些区域**：`cn` → `CN`；`dev` → `Dev`；**`global` 不挂**。这是产品叙事的硬规则而非视觉遗漏——Cindy 是「天生全球」的产品，默认版本不给自己贴标签自证是全球版，只有为特定法规单独构建的版本才被标注（不对称命名）。旧实现给 global 挂 `Global` 徽标，读出来反而是「存在一个本土主场版、这是它的出口型号」，与叙事相反。**给 global 恢复徽标即回退该决策，不得回退。**
- **为什么 cn / dev 仍标**：两者连的都不是 global 端点（cn 走国内端点、dev 走独立 dev 端点），登录页是用户确认自己连向哪个后端的位置；dev 另有并存场景——`CindyDev` 保持独立可执行名，可与正式包同机共存。⚠️ **不要把 cn 的理由写成「区分同机双装的 cn / global」**：2026-07-26 起两者可执行名同为 `Cindy`、安装目录与快捷方式同名互抢，该双装场景已**明确放弃支持**（见 `packages/maker-shared/src/brandIdentity.ts` 的 `executableNameByRegion` doc）。
- **宽度自适应**：由 `REGION_PILL.paddingX`（11）撑开，不再固定 70px——70 是为 `Global` 一词量身定的，`CN` / `Dev` 在固定宽里会留大片空白。11 由原几何反推（(70 − `Global` 6 拉丁字符 @16 Bold ≈ 48) / 2），保住 figma 的左右留白密度。
- **文案不翻译**：四语同文的区域代号（承袭旧 `login.globalRegion` 的做法），但仍走 i18n（`login.regionPill.*`），以便日后改判为「中国大陆版」这类可译文案时不必回改组件。
- **手机端无此变体**：`apps/mobile` 的 `LoginTitleBlock` 不接 `regionPill`（移动端未做区域徽标）。

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
| `account-deletion`（状态浮层） | 账号删除**状态展示**（发起流程在 Settings 的 `AccountDeletionSection`；登录页仅在存在删除回执时以**根层浮层气泡**展示 status，非主状态机 step；详见下方「注销状态浮层气泡」） | `AccountDeletionStatusPanel`（**登录皮容器外**的根层浮层，非面板内） |
| `browser-redirect` | 社交 / SSO 跳浏览器验证，等待回调 | `LoginLoadingRing` + `LoginPrimaryButton`（取消）+ `LoginTitleBlock` |
| `completed` / `error` | 登录成功 / 失败（含 browser 回调终态页） | 成功无面板（进主界面）；error = `LoginTitleBlock` + `LoginPrimaryButton`（重试）+ `LoginErrorText`；browser 回调页 `oauthResultPage`（系统浏览器独立 HTML，main 侧内联常量,色值与 `--login-callback-*` token 同源——renderer CSS var 不可达,改值需两处同步） |

**注销状态浮层气泡（figma 678:1075「注销状态」组件集，2026-07-26 定形）**：账号注销状态**不在登录面板内**，而是登录屏根容器的 absolute 浮层——历史实现曾把它放在登录皮容器（`LoginStage`）的文档流首子位置，被 `absolute; top:0` 的不透明登录面板 100% 覆盖（`pending` / `processing` / `completed` 三态全中，修复前证据见 `docs/design-previews/deletion-banner-repro/`）；**改回面板内即重现该缺陷，不得回退**。

- **层级与布局**:不占布局流、不推挤下方内容,**允许盖住立绘与字标**(设计意图,figma iPhone 帧即压立绘 91px);桌面 `z-30`(低于顶部拖拽条 `z-40`、协议弹窗 `z-50`),移动端靠渲染序位于登录组之后、协议弹窗之前。几何按设计单位 × 登录组同一缩放系数(见下「几何」),不随键盘位移。
- **显隐**：跟随面板入场——opacity 复用登录组同一入场动画值，入场完成前不可见且不可点击（桌面 `panelHidden` / 移动端 `handoffPhase === 'done'` 门控 `pointerEvents`），避免冷启动带注销回执时气泡先于登录 UI 出现在 splash 上。协议弹窗打开时，Android 需与登录组同步 `importantForAccessibility="no-hide-descendants"`（`accessibilityViewIsModal` 仅 iOS 生效，否则 TalkBack 可穿透读到状态文案并激活「我知道了」）。
- **几何(设计单位,与登录组同缩放)**:气泡的每一个几何值都是**设计画布单位**,渲染时乘以与登录组相同的缩放系数——不是物理 px。桌面画布 1819×2098 是 2x 稿,系数 = `PANEL_FIXED_SCALE`(0.5);移动端为各 stage 的 `surface.scale`(phone = 屏宽/750,pad 见 `resolveLoginSurface`)。**2026-07-26 修正**:初版把设计单位当物理 px 直接落码,气泡在屏幕上宽了整一倍(与面板 340 并列时达 670),已按下列换算纠正。
  - 桌面:宽 670、距窗口顶 72(顶对齐固定)→ 屏幕 **335 / 36 CSS px**,与登录面板 680×0.5=340 基本同宽(设计稿即 670 vs 680);水平窗口居中;窄窗时可视宽钳制 ≤ `100vw − 24`。
  - phone(stage 750):宽 670 @x=40 → 屏幕 `670 × 屏宽/750`(393pt 屏 ≈ 351pt,左右边距各 ≈21);top 取 safe-area 顶(设计 y=116 即状态栏下沿,间距 0)。
  - pad 横屏(stage 1180×820):宽 556 = `WORD_MARK` 框宽(figma 679:1201 x=607 w=556,与字标同宽)、x=607(中心 885 与登录组中心 884.8 同轴)、top 72(底边 163 距字标框顶 177 留 14);均 × `surface.scale`。
  - pad 竖屏(stage 744×1133):宽 504(字标框宽按可见图形等比反算 269.51 × 556/297.32)、水平居中于字标轴、top 72;均 × `surface.scale`。`left` 钳制在屏内。
  - 高度**由内容撑开**,禁止固定高。
- **视觉(同为设计单位)**:圆角 22、四边 padding 20、**不透明底**(浮层压立绘必须不透明,不靠阴影 / 模糊);描边保持 1 物理 px 细线(不随缩放,否则小系数下会消失);无图标、无阴影、无动效。标题与正文同为 20 / 行高 23 / Regular 400、全部居中(长文案居中换行),仅以颜色区分层级(标题 `--login-control-text` / 正文 `--login-secondary-text`);标题↔正文 5、正文↔「我知道了」22、**「我知道了」↔气泡底固定 20**(= 下 padding,文案拉长该距不变)。内部几何由组件子元素坐标反算自洽:figma 678:1074 标题 text @(20,20) h=23、正文 @(20,48) h=23,无钮变体总高 91 = 20+23+5+23+20。
- **「我知道了」**(仅 `completed` 态):下划线文字链(非按钮)。热区按端处理——桌面用上下各 11 设计单位 padding + 等量负 margin 抵消视觉(缩放后约 22 CSS px 高,鼠标指针足够);触摸端 hitSlop **按气泡内可用空间钳制**:上 = min(18, 正文↔链接间距×scale)、下 = min(18, 下 padding×scale)、左右 20 物理 pt——RN 的 hitSlop 不会越过父 View 边界,写大了是虚标。**不设未缩放的 44pt 绝对下限**:整个登录系统按 stage 缩放(320pt 窗口下登录主按钮本身仅 ≈34pt 高),孤立保 44 必须打破「正文↔链接 22 / 底距 20 恒定」的拍板视觉;热区随系统同步缩放、在边界内取最大。
- **颜色**：底 `--login-deletion-bubble-bg`（#FFFFFF / #1F1F1E）、描边 `--login-deletion-bubble-border`（#D7D7D4 / #3C3C3A），均为**固定亮 / 暗二值**——与 §16.2「`--login-*` 只分 light / dark、不随扩展主题」一致，**不得**改用 `var(--surface)` / `var(--chat-input-*)` 等会被扩展主题 override 的 alias（同 `--login-bg-base` 的改判先例）；移动端色板逐值一致。
- **状态与文案**：`pending`（预计删除日期 + 重新登录可取消）/ `processing`（等待期结束、正在删除）/ `completed`（已删除 + 「我知道了」）三态；`cancelled` 在轮询侧拦截、不渲染气泡（改为登录后的一次性「注销已取消」提示）。四语言（zh-CN / en / ja / ko）× light / dark 全覆盖。

### 16.5 深色模式与主题跟随

> 深色受 §10「Light / Dark 双模式交付门槛」约束，是**必须交付**的另一模式，非可选愿景。深色色值经 Figma 组件库 Dark symbol 逐个核验（见 §16.1 双态表），为目标规格——token dark 槽位已预留，待实现 PR 填入真实值并补齐 overlay token、深色资产切换及主题跟随逻辑。落地机制如下。

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
