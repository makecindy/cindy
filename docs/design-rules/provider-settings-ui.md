# 模型供应商设置页

> 迁自 `DESIGN.md` §4，规范效力不变。文中未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。
> **读取时机**：改动供应商详情页头部或供应商弹窗里的折叠区之前
> **适用路径**：`apps/desktop/src/renderer/components/settings/Provider*.tsx`

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
