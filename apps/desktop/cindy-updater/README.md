# cindy-updater

> 源码目录、二进制与产物均已统一为 `cindy-updater`（经 owner 确认，
> docs/dev-rules/cindy-updater.md）。

Tauri-based Windows updater for `Cindy`. Replaces the inline `.cmd` script
that the Electron main process previously generated in `executeUpdateWindows`
(see `apps/desktop/src/main/updateService.ts`).

## Why a separate exe

- Real UI (progress / errors / log button) instead of a hidden cmd window.
- Structured error handling — no `if %ERRORLEVEL% GEQ 8` dance.
- Self-update via copy-to-%TEMP% pattern: the updater is copied to
  `%TEMP%\cindy-updater-{ts}.exe` before launch, so the in-`resources/` copy is
  no longer file-locked and the new release's updater can overwrite it.

## Building

- The full source lives in this directory (`src-tauri/` — Rust + Tauri, plus
  the `ui/` webview assets). Nothing about the updater is closed-source.
- Official Windows packaging **always rebuilds it from this source**:
  `forge.config.ts` (`buildCindyUpdater`) runs `cargo build --release` during
  `prePackage`, patches the embedded manifest, copies the result to
  `apps/desktop/resources/cindy-updater.exe`, and hard-fails if the toolchain
  is missing — a release never ships a stale binary.
- **No prebuilt copy is committed.** `apps/desktop/resources/cindy-updater.exe`
  is a build artifact and is git-ignored: keeping a 4.5 MB binary in Git LFS
  would burn LFS bandwidth on every clone. Day-to-day development never reads
  it — at runtime the path resolves under `process.resourcesPath`, which only
  exists in a packaged app, and `updateService.ts` degrades gracefully
  (`updater_missing`) when it is absent.
- To produce one locally (Windows, needs the prerequisites at the bottom):

  ```bash
  cargo build --release --manifest-path apps/desktop/cindy-updater/src-tauri/Cargo.toml
  # output: apps/desktop/cindy-updater/src-tauri/target/release/cindy-updater.exe
  ```

## CLI contract

```
cindy-updater.exe \
  --zip       <path-to-downloaded-patch.zip> \
  --app-dir   <electron-install-dir> \
  --exe-name  Cindy.exe \
  --pid       <main-process-pid> \
  --log       <userData>/logs/cindy-update.log \
  --lock      <userData>/updates/.updating \
  --theme     light|dark|auto      # default: auto
```

`--theme` mirrors the user's current Cindy theme preference into the
updater's WebView. `auto` falls back to the OS color scheme. Without this
the in-app theme override would be lost during the relaunch — e.g. a user
on a light OS who has selected dark mode in Cindy would briefly see a
light updater window.

The Electron main process owns argument construction; see
`executeUpdateWindows`.

### Logging

- Path is whatever `--log` points at; convention is
  `<userData>/logs/cindy-update.log` so the file lives next to the main
  process's existing log directory.
- Full verbose logging — every phase, every retry, every error is appended.
- Size-capped at **5 MiB**. On startup the logger checks the existing file
  size and truncates (in place) when it exceeds the cap, then writes a
  `log truncated (was N bytes…)` header. We do not keep `.old` rotations —
  one rolling file is enough for an updater that only runs minutes per
  invocation.

## Phases (emitted to UI as `update-status`)

1. `waiting`    — polling sysinfo until `--pid` exits (60s timeout).
2. `extracting` — unzipping `--zip` into a sibling `%TEMP%\…-extract-{ts}\`.
3. `replacing`  — walking the extract tree and copying into `--app-dir/`.
4. `launching`  — start `<app-dir>\<exe-name>` through `launch_detached`:
   an elevated updater first uses the verified same-user, same-session,
   unelevated desktop Shell; an ordinary updater or an unavailable Shell path
   uses the original detached `CreateProcess` fallback.
5. `done`       — `pgrep`-style verification passed; updater self-cleans.
6. `failed`     — any step bubbled an error; lock file dropped, UI sticks.

### Manual retry after failure

The failure window offers Retry when the install was not modified or rollback
succeeded, and the package is still readable. The failed package moves to
`<workdir>/retry.zip` so Cindy cannot automatically apply it again. A cross-volume
move falls back to copying before removing the source. A malformed or unsupported
ZIP is discarded; a failed rollback disables Retry and preserves the backup.

Retry re-runs the installer in the same process using Rust-owned arguments.
If UAC was cancelled, the original permission probe can request it again.
It skips the original, potentially reused PID and asks the user to close any
processes running from the install directory. It rebuilds extraction and backup
directories before replacing files. Success removes the package and exits.
An existing update lock or another Cindy updater also blocks Retry, including
updaters still waiting in TEMP. Close does not relaunch during another update,
and a rejected retry leaves the other updater's lock untouched.

After failure Cindy stays closed until the user chooses Retry or Close. Close
(including the native window close action) removes the retained retry package
and restarts the unmodified or restored Cindy once. Closing is blocked during an
active install. Close cleanup/relaunch runs off the UI thread; closing excludes
duplicate Close and Retry. A failed or unsafe rollback never auto-restarts the app.

The original permission probe, UAC handoff and temporary staging location are
retained. `launch_detached` now checks the updater's actual token elevation and,
when elevated, uses the existing desktop Shell as the new process's parent after
verifying that Shell belongs to the same user and login session and is not
elevated. Synchronous `CreateProcessW` returns the actual process handle, without
an uncancellable COM launch request. It does not switch accounts, enable extra
privileges or modify token ACLs. Environment and cwd retain the original detached
launch's updater context. If the Shell is unavailable or creation fails before
there is a child, the original detached launch remains the fallback and may
inherit the updater's elevation, including an explicitly admin-only target.
Windows observes this handle for three seconds instead of a global name match
or an immediate liveness snapshot. Nonzero early exits enter rollback; normal
exit remains accepted, including single-instance handoff or the user quitting.
Creation/observation is not a full application readiness check. An unknown handle
state or surviving install-directory process blocks overwrite rollback, keeps
the recovery backup and disables automatic Retry/relaunch. Running elevated clients
are supported by the common Windows deep-link handoff; see the authoritative
[startup-permission rules](../../../docs/dev-rules/cindy-updater.md#windows-更新后的启动权限).
The existing seven-day temporary-directory cleanup still applies.

Retry controls retain the five-language WebView catalog and existing theme styles.

A release uses the updater bundled with the currently installed Cindy. Shipping
a new updater does not change the process already performing that update.
Installed-product tests must also cover the next update using the new updater.
Builds and isolated fixtures do not establish antivirus/EDR compatibility;
interception or quarantine needs validation in the relevant security environment.

## Build

```
cd apps/desktop/cindy-updater
pnpm install              # pulls @tauri-apps/cli
pnpm tauri build          # produces target/release/cindy-updater.exe
```

`tauri.conf.json` has `bundle.active = false` — we ship the raw exe, not an
installer. The Electron forge config copies it into the app's `resources/`
during packaging.

## Dev loop

```
pnpm tauri dev
```

For testing the updater UI without running an actual update, pass dummy args:

```
cargo run -- \
  --zip path/to/anything.zip \
  --app-dir C:\Temp\fake-app \
  --exe-name notepad.exe \
  --pid <known-exited-fixture-pid> \
  --log C:\Temp\updater-test.log \
  --lock C:\Temp\updater-test.lock
```

Use the verified PID of an exited disposable test process; PID 0 is Windows'
Idle process and does not bypass the wait phase. Never use the installed Cindy
for this dummy-argument check.

## Prerequisites

- Rust ≥ 1.74 (uses `io::Error::other`)
- MSVC Build Tools 2022 with C++ workload (for `x86_64-pc-windows-msvc`)
- WebView2 Runtime (built into Win10/11)
