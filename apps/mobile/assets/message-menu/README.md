# Message menu icons

The SVG artwork is exported directly from the desktop's `lucide-react` 0.468.0
components at a 24 × 24 viewBox with stroke width 2, round caps and joins.
The accompanying 1x/2x/3x PNGs are rasterizations of those SVGs; do not redraw them
or replace them with SF Symbols. Lucide's ISC license is included in `LICENSE`.

The SVG viewBox describes source geometry, not display size. Rasterize at
18 × 18 pt (`iconSize.lg`), yielding 18 / 36 / 54 px for 1x / 2x / 3x.
Keep stroke width 2 in the source viewBox (`iconStroke.regular`), scaling it
with the artwork as Lucide does. This matches the existing mobile message,
session, and file action sheets; the native menu retains system row spacing.

| Asset                     | Desktop / React Native glyph |
| ------------------------- | ---------------------------- |
| cindy-message-square-plus | MessageSquarePlus            |
| cindy-link-2              | Link2                        |
| cindy-undo-2              | Undo2                        |
| cindy-trash-2             | Trash2                       |

`with-message-menu-icons` copies the image sets into the app's existing Xcode
asset catalog. The native menu loads them with `UIImage(named:)`; the JS wrapper
applies semantic foreground/destructive colors for Light and Dark.

These are native resources: shipping them requires a new native build. The
2026-09-08 user decision explicitly retained the system menu and accepted this
rebuild. Existing installations cannot acquire the assets through an OTA-only
update. See `docs/design-rules/DESIGN.md` §15.13 for the cross-platform contract.
