# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`.
- Triage state is recorded as a `Status:` line near the top of each issue file.
- Comments and conversation history append under `## Comments`.

## When a skill says “publish to the issue tracker”

Create a file under `.scratch/<feature-slug>/`.

## When a skill says “fetch the relevant ticket”

Read the referenced file path or issue number from `.scratch/<feature-slug>/issues/`.

## Wayfinding operations

- Map: `.scratch/<effort>/map.md`
- Child ticket: `.scratch/<effort>/issues/NN-<slug>.md`
- Ticket fields: `Type:`, `Status:`, optional `Blocked by:`
- A ticket is unblocked when every listed blocker is `resolved`.
- Claim before work by setting `Status: claimed`.
- Resolve by adding `## Answer`, setting `Status: resolved`, and updating the map.
