# 开始引导

> 迁自 `DESIGN.md` §4，规范效力不变。文中未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。
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
- **Motion.** Step content arrives with the registered get-started guide entrance (§14.4); the
  window itself keeps the shared modal entrance and nothing loops.

Other wizards keep the registered rule; this entry does not authorize removing step chips,
centering commit actions or adding a × elsewhere.
