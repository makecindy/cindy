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
4. `launching`  — `CreateProcess` on `<app-dir>\<exe-name>` (detached).
5. `done`       — `pgrep`-style verification passed; updater self-cleans.
6. `failed`     — any step bubbled an error; lock file dropped, UI sticks.

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
  --pid 0 \
  --log C:\Temp\updater-test.log \
  --lock C:\Temp\updater-test.lock
```

`--pid 0` exits the wait phase immediately.

## Prerequisites

- Rust ≥ 1.74 (uses `io::Error::other`)
- MSVC Build Tools 2022 with C++ workload (for `x86_64-pc-windows-msvc`)
- WebView2 Runtime (built into Win10/11)
