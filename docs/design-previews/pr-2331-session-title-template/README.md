# Session title template — Desktop UI evidence

These screenshots were captured from the running Desktop app with a dedicated
isolated profile and synthetic demo data. No real task, project, or conversation
data was present in the profile.

Demo values:

- Automation: `Daily workspace summary`
- Template: `{scheduleName} · {date:yyyy-MM-dd}`
- Preview: `Daily workspace summary · 2026-08-17`

Evidence:

- `desktop-light-template-preview.png` — the saved template and matching live
  preview after reopening the Advanced panel in the light theme.
- `desktop-dark-template-preview.png` — the same persisted template and preview
  in the dark theme.
- `desktop-light-invalid-template.png` — entering `{unknown}` keeps the dialog
  open and displays the validation error.

The automated regression suite covers generated-title grouping, search by both
generated title and automation name, malformed persisted-template fallback, and
the legacy empty-template fallback.
