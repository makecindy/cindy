# Slider family — 2026-09-17

Design: DESIGN.md §15.18; user-approved Design Lab v6, then requested all variants in one PR.
Scope: Desktop numeric Slider, reasoning effort Slider, media scrubber; native player controls excluded.

## Intentional differences and reasons

| Entry | Before | After / reason |
| --- | --- | --- |
| UI/code font size; Claude/Pi compaction | Radix track/outlined knob with generic surface tokens | shared neutral Slider, clearer dark track, borderless shadow thumb |
| Work Louder keyboard brightness | browser-native range using Switch accent | numeric Slider independent of Switch blue, existing 10% step and commit API |
| Model effort | colored circle, pressed scale | retain colored circle/border/halo, bounded hover and real capsule deformation |
| Audio card | local pointer-only timeline | shared media scrubber; keyboard seconds and consistent hit area |
| Sound effect | click-only timeline | same media component, adds dragging and keyboard seeking |
| Plugin audio slot | separate HTML/pointer implementation | mounts the same media component inside the host-owned slot; audio lifecycle stays owned by host |

## Browser verification

macOS Chrome, actual production components imported from this branch into a temporary local
harness (not a copy of Design Lab CSS). Both CINDY Light and Dark visually inspected.
Screenshot artifact: `dbb206125111c88a.jpg` in the submitting session's browser artifact directory;
not committed. The PR author can attach this artifact to the PR.

Computed styles: Light track rgb(163,163,158), fill rgb(60,63,67), thumb rgb(253,253,248);
Dark track rgb(98,98,98), fill rgb(238,238,238), thumb rgb(252,252,252).
Numeric thumb rest 16×16, observed hover 18×18; media rest 10×10. Enabled cursor ew-resize,
disabled not-allowed. Real drag changed dark numeric 50→20 and cleared pressed state on release.
Unit tests cover key steps/bounds, unknown media duration, right-button rejection, effort
release/cancel/disable/stops replacement and numeric cancel/lost-capture/window blur.

## Limits

Full Electron UI was attempted via `pnpm restart:desktop:remote --region=global --isolated=@worktree`:
`DESKTOP_DEV_VERDICT=failed`, `STARTUP_FAILED`, runtime-assets check failed because GitHub returned
HTTP 403 while downloading the pinned Codex distribution. Browser component evidence does not
claim full Desktop, hardware brightness or Windows validation. No production user profile was used.

Radius classification: track/fill/knob are registered Slider marks with fully rounded ends,
not ordinary content containers. Fixed transparent hit height 36px numeric / 38px effort / 28px media;
visible knob growth does not enlarge or shift the hit region (DESIGN §5 and governance §13).
