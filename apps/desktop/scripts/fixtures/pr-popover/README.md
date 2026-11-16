# PR popover preview

`cards.json` contains sanitized HTML snapshots from the GitHub plugin’s actual `renderPrCard` and `renderPrReference` output. The seven snapshots cover following, stopped, settings, model selection, and a PR followed by another task; model/provider names are fictional.

The fixture mounts the production badge, task-card store, sandbox action bridge, model selector, and PR link manager. Host responses are simulated: it never starts follow-up work or changes real PRs. The `uninstalled` case retains card history while returning an empty installed-plugin list.

Run `pnpm ui:check --page pr-popover --case all --theme all` from the repository root. The native header hides this entry below 520px.
