# 新建任务页

> 迁自 `DESIGN.md` §1.1、§15.15，规范效力不变。文中未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。
> **读取时机**：改动新建任务页的内容位置、提示卡片或标题栏悬停之前
> **适用路径**：`apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx`、`apps/desktop/src/renderer/components/layout/ContentHeader.tsx`

### 1.1 New-task home content

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

### 15.15 Create-Page Content Position + Titlebar Hover Discipline

- **CREATE AGENT content-group vertical position**: `max(96px, 28vh) + 46px` from the window top, 32px side padding. Narrow band: when the composer's available width is under 560px (both side panels open or a narrow window), `max(64px, 18vh) + 32px` with 16px side padding.
  Implementation = route container `pt-[calc(max(96px,28vh)+46px-var(--content-header-h,46px))]` (narrow: `max(64px,18vh)+32px`):
  - the 268px cap is dead (a leftover of the Figma frame height — the root cause of content sitting high on large windows); 28% is device-tuned (from 25.5%);
  - `--content-header-h` is broadcast by `ContentHeaderSlot` (inside FeatureSidebarSlotProvider) through a display:contents wrapper (46px rendered / 0px hidden, same source as ContentHeader `h-[46px]`) — content stays pinned at the "header present" position with **zero jump** when selecting a project toggles the header;
  - header visibility has a single decision source = `useContentHeaderHidden` (mac + sidebar expanded + no injected content + no right-panel toggle; continues the 2026-06-11 "hide empty header" ruling);
  - guard: the position formula and its anti-regression assertions are part of the create-page review contract.
- **Hover-token discipline**: `--update-btn-hover` is exclusively the upgrade button's hover (inverse dark CTA) — **forbidden** on ordinary ghost buttons/badges (near-black under CINDY light swallows text and icons; 6 misuses cleaned up 2026-07-21). Correct picks:
  - titlebar-area (ContentHeader) ghost elements → `titlebar-button-hover` (same as the ChromeActions window buttons);
  - general light hover in the content area → `--surface-hover`.
