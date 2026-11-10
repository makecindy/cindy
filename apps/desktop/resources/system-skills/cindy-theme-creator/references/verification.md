# Verify the delivered theme

Keep a short record: target Cindy build/computer, output paths, previous
selection/settings, and each check marked **passed**, **failed** or **not verified**.
An unavailable check stays explicit; it is not a reason to modify the Host.

## Before applying

1. Keep editable JSON and source assets in the task folder. Run the read-only
   validator with `--package-root`, then the packager. Review warnings and the
   `unchecked` list. No Python check proves that the archive actually rendered.
2. Confirm the target client supports v2 before promising complete appearance.
   Use v1 only for its supported colors/brand subset; do not generate an appearance
   plugin to fill a theme's missing parts.
3. Capture prior family/mode and relevant explicit overrides. Use the existing
   target profile and tools; do not copy credentials or replace the running app.
4. Preview real palette/assets with body/secondary text, inputs/focus, a tool
   result, code, a table, messages and affected status states.

## Acceptance matrix

| Part | Evidence required to call it verified |
| --- | --- |
| Colors | Actual Cindy selection and representative views; readable controls, resolved CSS and distinct semantic statuses. |
| Modes | Comparable Light/Dark screenshots; switch requested variants and system-follow mode, verify actual colors/family. |
| Update by ID | A revised package changes colors/assets/defaults without growing the list or changing selected identity. Unrelated themes remain; a rejected update preserves the active version. |
| Brand images | New-task page shows actual icon/logo crop at display size, no stale image or unwanted background. This does not verify Dock icons. |
| Wallpaper | Real Cindy canvas, expected visibility/blur, readable foreground; image fallback and MP4 playback/static mode when provided. Check visibility 0 and reduced motion. |
| Fonts | Actual UI/body/code/terminal samples with Latin, Chinese, digits and punctuation; resources decode, missing-glyph fallback works. Terminal fits after font load without restarting the shell. |
| Reading/styles | Real line height, width, gap, padding and radius; long content fits a narrow window. |
| Density/motion | Requested spacing/duration changes, restoring neutral 1 does not compound scale. Theme motion 0 and OS Reduce motion both suppress animation; theme settings never override OS reduction. |
| Priority | A pre-existing custom font/wallpaper remains after theme selection. Clear only its named override when desired, and verify it then follows the theme across mode changes. |
| Restore | Prior selection or recorded custom values return without resetting unrelated settings. One font-size reset preserves family and other fonts. |
| Persistence | When in scope, reopen the same profile and verify selection, resources and overrides before interacting. Upgrade without changes preserves current choices. |

Inspect the screenshots, including focus/disabled/hover states where affected.
File existence or a tool exit code alone is not visual verification. Code/editor
palettes, native icons, OS wallpaper and Mobile behavior retain their stated
boundaries.

## Receipts and readback

- Import `status: "installed"` is not selection; `refreshed: true` confirms the
  current window updated its list. Read back `preferences.themeFamily` and the
  effective appearance after selecting. A real data-theme import does not ask to
  install a plugin.
- Saved settings are not proof of visible application. Inspect the actual view,
  loaded font and displayed media; record saved-only and failed states accurately.
- Explicit overrides can mask theme defaults. Report them instead of silently
  deleting preferences. Reset follows the current theme, while restoring previous
  custom values needs the actual recorded values. Do not overwrite later edits.
- Same-ID content rollback requires the prior package; switching selection alone
  cannot undo a package update. Do not promise cross-device synchronization.

Deliver the `.cindy`, editable sources/assets, preview and screenshot paths,
selection/restore instructions, and passed/failed/unverified checks. Never claim
that the user's real app changed when only a preview was produced.
