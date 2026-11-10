# Verify the delivered appearance

Choose checks for the parts actually requested. Keep one short verification record
with the target Cindy build/computer, output paths, previous selection, and each
check marked **passed**, **failed** or **not verified**. An unavailable check stays
explicit; it does not become a reason to claim success or modify the host.

## Before applying

1. Keep generated JSON and source media together in the task output folder. Run
   `python3 scripts/validate_theme.py <theme files...>` from this Skill directory.
   It prints JSON and returns nonzero for invalid structure, duplicate IDs/variants
   or missing referenced brand files. Warnings and unchecked CSS/image properties
   need review; the script never installs or changes settings.
   For a portable package, pass `--package-root`, build it with `package_theme.py`
   and verify the exact `.cindy` file on the receiving client. A loose JSON check
   does not prove that the archive contains its referenced assets.
2. For plugins, run the current Cindy plugin validator/build workflow from
   `cindy-plugin-creator`. Check declared fields, resource IDs, paths, decodable
   images/fonts and packaging. A local JSON check does not validate a plugin.
3. Capture the prior theme family/mode and the settings this result will change.
   Preserve the original files. Test on the target computer and existing allowed
   profile; do not copy credentials or create an unrelated replacement account.
4. Produce a preview using the real palette and real assets. Include body and
   secondary text, input/focus, a tool result, code, a table, user/assistant messages,
   and warning/error/success states where affected. Avoid previewing only swatches.

## Acceptance matrix

| Part | Evidence required to call it verified |
| --- | --- |
| Global colors | Actual Cindy selection and representative views; no missing CSS values, unreadable controls or semantic status confusion. |
| Mode pairing | Switch each requested variant and system-follow mode; verify selected family and actual colors. Inspect each variant separately. |
| Update by ID | Import a revision with the same IDs and changed colors/assets. The theme list does not grow, the selected identity remains valid, both changes render, and unrelated themes remain available. A rejected update preserves the old appearance. Keep the previous package for rollback. |
| Brand images | New-task page and preview show the intended icon/logo at actual display size, without clipped detail, unwanted background or stale images after refresh. |
| Wallpaper | Real app background, legible foreground, requested blur/visibility; motion and static alternative where provided. A media file alone is not application evidence. |
| Fonts | Actual body/code/UI sample with Latin, Chinese, digits, punctuation and requested weights; check missing glyphs and size. Check terminal separately if changed. |
| Reading/message style | Real message width, line height, gap, padding and radius; long content stays usable in a narrower window. |
| Application icon | Native mutation receipt plus observation of the macOS Dock or supported running window. A brand preview or Finder icon is not this check. |
| Visibility/custom view | Intended window/regions change; a reachable action restores them. Confirm unrelated windows and permission UI remain usable. |
| Restore | The previous selection/custom values or explicitly named defaults return for changed fields, without resetting unrelated preferences. |

For a paired theme, collect comparable light/dark screenshots of the same sample.
Inspect the screenshots; file existence or a screenshot-tool exit code alone does
not prove the appearance is correct. Test hover, keyboard focus and disabled
controls where relevant. Record any code/editor/terminal or Mobile exclusions.

## Mutation and persistence receipts

Use the existing host/plugin call and read back the effective values. Distinguish:

- Theme import `status: "installed"` confirms installation, not selection.
  `refreshed: true` confirms the current window's theme list was refreshed.
  Apply and read back `preferences.themeFamily` separately when requested; a
  real theme import does not ask to install an executable plugin. If the output
  also includes an appearance plugin, identify and verify that companion separately.
- `application.status: "applied"`: the host confirmed application. Still inspect
  the rendered/native result before describing it as visually verified.
- `"saved"`: preferences were saved without current application confirmation,
  including superseded changes. State that result; do not label it applied.
- `"failed"`: report the actual failure and inspect current state before changing
  anything again. Do not silently retry or edit application files.

Use the API's revision option when making or restoring asynchronous changes. An
old preview must not overwrite the user's later choice. Reset only fields changed
by this theme. Show whether an action restores defaults or recorded prior custom
values; these are different outcomes.

If restart persistence is requested, reopen with the same theme files or an active,
approved plugin and verify the result. Runtime icons are rebuilt from valid plugin
resources at startup; stopping/uninstalling the provider may release them. Do not
promise persistent installation icons or cross-device synchronization.

## Delivery record

Keep the handoff compact: theme/plugin and asset paths; preview and screenshot
paths; how to select/apply; how to restore; passed checks; and specific unverified
parts. Do not claim that the user's app changed when only a preview was produced.
