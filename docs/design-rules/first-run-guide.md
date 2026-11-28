# 开始引导

> 迁自 `DESIGN.md` §4、§14.4，规范效力不变。文中未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。
> **读取时机**：改动首次登录后的开始引导之前
> **适用路径**：`apps/desktop/src/renderer/features/first-run-guide/**`

### Get-started guide

Desktop `features/first-run-guide/FirstRunGuide.tsx` is a multi-step dialog shown once after the
first sign-in; product rules are in [`../product-rules/first-run-guide.md`](../product-rules/first-run-guide.md).
The owner asked for a more designed guide whose first page stands apart. It keeps the shared
`.modal-scrim` / `.modal-panel`, pill buttons and the registered wizard step chips, with these
differences from the general multi-step dialog rule:

- **Fixed size.** 640px wide (`min(640px, 100vw-32px)`) and `min(640px, 88vh)` high on every
  step, so the window does not jump between steps; a step that is taller scrolls inside it.
- **Cover page (new users only).** No step chips, no header title and no footer. Centered: the
  brand block (§15.7), a 28px/500 headline, one 15px sentence, three bordered 12px-radius cards
  and a single centered CTA with one 12px line naming the steps that follow. Each card opens
  with an 88px `--surface-chip` stage holding a small scene assembled from the product's own
  elements — task rows being ticked off, three registered provider marks (Anthropic, OpenAI,
  DeepSeek — a fixed set, the same in every edition, owner decision 2026-11-11) and a key, a
  computer and a phone showing the same task — then a 14px/500 title and 13px body.
  The scenes replaced generic glyph tiles at the owner's request; they use only
  semantic tokens and registered marks, with no drawn illustration. This is the only page with
  a centered commit action.
- **Step pages.** The header carries the guide title and the step chips; only the current step
  shows its label. Each page opens with a neutral icon tile, a 20px/500 title and one 14px
  sentence. Sparse pages (earlier-version data, migration, finish) center their content; the
  migration page shows two neutral computer tiles joined by an arrow. Option cards on the model
  page are bordered 12px containers with an outlined pill label.
- **Closing.** A top-right × on every page, because the footer holds navigation (back, skip,
  next) rather than a Cancel action; Esc also closes. The scrim never closes it.
- **No decoration beyond the cover's brand block**: no illustration, gradient, shadow or colour
  outside the semantic tokens; icons are lucide glyphs in `--text-primary` / `--text-secondary`.
- **Motion.** Step content arrives with the registered get-started guide entrance ([below](#get-started-guide-entrance)); the
  window itself keeps the shared modal entrance and nothing loops.

Other wizards keep the registered rule; this entry does not authorize removing step chips,
centering commit actions or adding a × elsewhere.

### Get-started guide entrance

- **Get-started guide entrance(开始引导入场)** — the tenth sanctioned motion class (owner-requested 2026-11-11; the cover's timing was tuned twice the same day), **only** for the Desktop get-started guide (`features/first-run-guide/FirstRunGuide.tsx`):
  - **Step pages**: when a step is reached with Start / Next / Skip / Back, its blocks fade in and rise 6px one after another in reading order, so the page reads as content arriving rather than a hard cut. Bot Market detail values: `--motion-base` / `--motion-ease-out`, adjacent blocks **30ms** apart via `--rise-index`, the index clamped at 5.
  - **Cover**: a single choreography of about 1.3 seconds, played once when the cover mounts. The brand block, headline, sentence, three cards, the Start button and the line below it arrive in that order on the step-page values (`--motion-base` / `--motion-ease-out`), rising 8px, **45ms** apart, so everything is in place within about half a second — the owner found a slower arrival of the top block deliberate-looking, and an earlier 0.3s version was over before it could be seen, so the arrival stays brisk and the scenes carry what is worth watching. Each card's scene plays once, starting 150ms after its card began to arrive: three task lines are drawn from the left 180ms apart and ticked off, the last one showing a ring for a moment before its tick replaces it; the provider marks pop in 100ms apart; the computer appears, three dots step toward the phone 70ms apart, the phone appears and the same task line is drawn on it. The Start button is clickable throughout.
  - **Parameters**: every element uses a duration and curve token — pop (`opacity` 0→1, `scale(0.6→1)`) and draw (`opacity` 0→1, `scaleX(0→1)` from the left edge) on `--motion-base` / `--motion-ease-out`, the ring's exit (`opacity` 1→0) on `--motion-fast` / `--motion-ease-in`. Only the start times are literals, passed per element as `--at`. No overshoot, no looping, no replay on rerender, data arrival, scroll or hover, and no exit animation. Motion sits on HTML wrappers, never on an SVG glyph. `transform` / `opacity` only. Like the Bot Market entry, this is an explicit exception to the rule that stagger is limited to the composer-container rows.
  - **Degradation**: `.first-run-rise`, `.first-run-pop`, `.first-run-draw`, `.first-run-leave` and `.first-run-shift` are in the `prefers-reduced-motion` whitelist in `globals.css`; reduced motion lands on the final frame directly — every task ticked, every mark and both screens present, the ring absent.
  - **Scope boundary**: this guide and feature introductions (owner request 2026-11-18, §4 "Feature introduction"), whose cover plays the same choreography. The cover scenes illustrate what the product does; they are not status signals and must not be reused for real task, provider or device state, which keep their registered responses. Implementation: `.first-run-*` in `globals.css`; start times in `FirstRunGuide.tsx` and each introduction's scenes.
  - **Feature introduction scenes** may also use shift (`transform: translateY(var(--shift) → 0)` on `--motion-base` / `--motion-ease-out`, `.first-run-shift`): when a row leaves, the rows below move up into its place. The inbox introduction plays three: rows with a new result or waiting on you are drawn 180ms apart, each followed by its dot; the top row is ticked, leaves, and the rows below shift up one row; a task card gets a clock, three dots step on 90ms apart, and the card returns with a new-result dot. Reduced motion lands on the final frame (`.first-run-shift` is in the whitelist).
