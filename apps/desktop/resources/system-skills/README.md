# Bundled system Skills

`cindy-skill-creator` is adapted from OpenAI Codex commit `977193486dfe7a88c4dab24abeafe9b754f5b13f`:

- Source: https://github.com/openai/codex/tree/977193486dfe7a88c4dab24abeafe9b754f5b13f/codex-rs/skills/src/assets/samples/skill-creator
- License: Apache-2.0 (preserved in `cindy-skill-creator/license.txt`)

Its validation and metadata-generation scripts vendor the pure-Python modules from
PyYAML 6.0.3 so they work without a separate package install. The upstream MIT
license and version/source record live under `cindy-skill-creator/scripts/_vendor/`.

`learn` is authored and maintained by Cindy. It starts Cindy's managed Learn
host through the essential `cindy_helper` bridge; another client may discover
the Skill files, but cannot run the workflow without that host capability.

Cindy materializes these resources into its user-data directory at startup. Do not put user-authored Skills here.

`cindy-theme-creator` is authored and maintained by Cindy. It creates complete
data-only theme packages with colors, brand images, fonts, wallpaper, reading
styles, density and motion, applied by the shared Host appearance service. Its
read-only checker and packager include v1 compatibility and verification guidance.

## Bundle version records

The bundle version is a fixed base plus the number of `*.md` files in `_versions/`. Whenever
the bytes under this directory change, add one new record file there, named
`YYYY-MM-DD-<topic>.md`, with one line saying what changed. Never edit, rename or delete an
existing record, and never touch the base number: installed copies only move forward. Run
`pnpm check:built-in-skills` to verify. Each change adds its own file, so two pull requests
never edit the same line, and merging both yields a version newer than either.

## Rules for bundled Skills

- A bundled Skill only describes workflows that apply to any git project. Repository-specific
  rules — DCO sign-off, unit-test gates, preview or personal-client setups, repository approval
  words — stay in that repository's `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING` / PR template;
  the Skill only tells the agent to follow them (2026-10-12 decision).
- The `pr` Skill (PR #8244) runs only when the user explicitly wants a pull request (`/pr`,
  "发 PR", following up a PR). An ordinary change request — including "change it but don't
  publish yet" or "show me first" — is handled directly, without creating a worktree or showing
  a PR card. Do not loosen the Skill description to make it easier to select (2026-10-31 decision).
