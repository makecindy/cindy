# PR 2331 — Desktop E2E evidence

These screenshots were captured from the running Desktop app with an isolated
profile and synthetic schedule data.

- `desktop-dark-persisted-template.png` — a saved `{scheduleName}` template is
  visible after reopening the Advanced panel in the dark theme, with its live
  preview.
- `desktop-light-persisted-template.png` — the same persisted template and
  preview in the light theme.
- `desktop-dark-actual-run.png` — an actual **Run now** execution created the
  scheduler session named `PR2331 标题模板验收`, matching the preview.
- `desktop-light-invalid-template.png` — entering `{bogus}` keeps the dialog
  open and marks the template invalid instead of allowing a save.

The E2E pass also exercised keyboard expansion/collapse and variable insertion,
rejected an invalid `{bogus}` template without closing the form, and verified
the empty-template fallback. The corresponding regression tests cover malformed
persisted templates, generated-title grouping, and search by both generated
title and automation name.

For the empty-template run, the isolated Desktop profile's newly created
`sessions` row has `source = scheduler` and the raw title
`[Schedule] PR2331 标题模板验收`. The UI intentionally hides that legacy prefix
when displaying scheduler sessions.
