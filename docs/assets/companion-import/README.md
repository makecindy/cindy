# Companion import component evidence

These images render the actual Desktop `BotImportForm`, button component and
Cindy theme tokens with fixture data: 142 skills, 2,100 memories, 23 connections,
15 automations and four profile documents. The host API and portrait picker use
test stand-ins. They are not screenshots of a packaged app or a live migration.

- `light-selection.png`, `dark-selection.png`: flat category summary in both themes.
- `narrow-skills.png`: the Desktop component at 390 px, with 20-row pagination and
  one scrolling body; this is not a native Mobile screenshot.
Completed saves now navigate directly to the teammate chat; the old completion-page
fixture was removed. Partial failures retain their detail and retry controls.

The fixture renderer and its embedded data are not included in shipped code.
Native iOS/Android visual checks, mixed-version device sessions and live provider
login/authorization remain separate from this component evidence.
