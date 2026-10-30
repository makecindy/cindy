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
