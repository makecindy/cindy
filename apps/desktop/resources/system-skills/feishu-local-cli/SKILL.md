---
name: feishu-local-cli
description: Use the first-party Cindy Feishu Local CLI toolset for local spreadsheet cell reads, embedded cell images and true cell clears. Use when XD Feishu cannot insert or clear cell images, or when the user asks for those sheet operations.
---

# Feishu Local CLI

Use `cindy_feishu_local` through the current runtime tool catalog. Do not shell out to `lark-cli`, guess command arguments, copy project scripts, or ask the user for tokens.

## Workflow

1. Call `status` first. If `reason_code` is `LOCAL_CLI_NOT_INSTALLED`, `LOCAL_CLI_VERSION_UNSUPPORTED`, `NOT_AUTHORIZED`, `SCOPE_MISSING`, `SETUP_REQUIRED`, `SETUP_UNAVAILABLE` or `CLI_FAILED`, report that exact reason and use `connect` / the install guidance. Never say "Feishu has no such API" when `PLUGIN_UNSUPPORTED_BUT_LOCAL_CLI_AVAILABLE` is returned.
2. Before any write, call `read_cells` on the whole identity row (for example `A85:K85`) and keep the returned `row_hash` as `expected_row_hash`. The `row_range` must cover every target cell; a hash from another row returns `INVALID_ARGS`. Do not infer row identity from one blank cell.
3. Call the write tool with `dry_run:true` (the default). Review the returned preview, then repeat with `dry_run:false`, the returned `confirmation_token`, and `verify:true`.
4. `clear_cells` additionally requires `confirm:true`. It maps to the CLI's true clear operation; writing an empty string is not a substitute. `scope:'formats'` keeps cell values and verifies style readback; `scope:'content'` verifies cleared values.
5. After the write, trust only the tool's `verified:true` result. If `VERIFY_FAILED` is returned, stop and report it; do not retry blindly.
6. `set_cell_image` accepts only a managed Cindy media reference in `image_ref`. The Host hands off the bytes to a temporary relative path; raw absolute paths are rejected with `PATH_HANDOFF_REJECTED`.

## Errors

- `PLUGIN_UNSUPPORTED_BUT_LOCAL_CLI_AVAILABLE`: the plugin toolset does not expose this operation, but the first-party local CLI does.
- `LOCAL_CLI_NOT_INSTALLED` / `LOCAL_CLI_VERSION_UNSUPPORTED`: use the user-visible install or upgrade entry; do not auto-install or scan PATH.
- `NOT_AUTHORIZED` / `SCOPE_MISSING` / `SETUP_REQUIRED`: use `connect`; device codes and tokens stay on the native setup card and Host credential store.
- `SETUP_UNAVAILABLE`: no trusted interactive setup surface is available for this task; do not ask the user to paste a token.
- `TARGET_DEVICE_UNAVAILABLE`: the requested device is not the executing computer; this version is local-only.
- `ROW_CHANGED`: re-read the whole row and start a new dry-run.
- `INVALID_ARGS`: the arguments are invalid, including a `row_range` that does not cover the write target.
- `PATH_HANDOFF_REJECTED`: pass a managed media reference, not a filesystem path.
- `CONFIRMATION_REQUIRED`: obtain a fresh dry-run token and the required explicit confirmation.
- `CLI_FAILED`: the CLI returned an unusable, truncated or failed result; raw output is withheld.
- `VERIFY_FAILED`: readback did not match; report the mismatch and stop.

`status` is cached and performs no upstream check by default. `refresh_version:true` is an explicit user action. Never poll for updates or authorization completion.
