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
  --zip-sha256 <verified-manifest-sha256> \
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
`executeUpdateWindows`. It passes the SHA-256 from the verified update manifest
through `--zip-sha256`. The updater fails closed when that digest is missing or
the archive does not match it, and forwards the same value through elevation
and manual Retry.

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

### Manual retry after failure

The failure window offers Retry only if the installation was not modified, or
rollback succeeded, and the update zip can be isolated as `retry.zip` in this
attempt's temporary workdir. Moving it out of Electron's staged-patch location
prevents the restored app from automatically applying the same failed archive.
Same-volume isolation uses rename; a cross-volume `EXDEV` / `ERROR_NOT_SAME_DEVICE`
falls back to a digest-checked copy of the still-open source, then deletes the
staged file only after the copy matches. If isolation fails, Retry is unavailable.
A second updater that loses the exclusive `.updating` lock leaves the staged ZIP
in place for the holder; it does not delete the active installation's archive.

Retry is never automatic: Rust rechecks the failure state and readable archive,
then re-runs the installer in the already-loaded process using trusted Rust-owned
arguments. It does not spawn a new updater executable from the `%TEMP%` workdir,
so Windows cannot load a planted `vcruntime140*.dll` beside that path into an
elevated retry. Electron supplies the SHA-256 from the verified update manifest;
Rust verifies it before the first attempt and passes it through elevation and
retry. Extraction hashes and consumes the same protected file handle only after
the digest still matches. A TEMP replacement after failure cannot be installed.
If the isolated archive is later missing, unreadable, or no longer matches, Retry
stays hidden and the failure window only keeps the check-for-updates guidance.
Deterministically malformed or unsupported ZIP formats also do not offer Retry
and the staged archive is deleted so the next Cindy launch downloads a fresh
copy; transient archive I/O failures remain eligible. Only the archive path and
PID change: the retry uses the isolated zip and does not wait on the original,
potentially stale PID. The WebView cannot supply paths or commands.
When the updater is already elevated via `--elevated` after UAC, extract and
backup staging live under the install directory. Classification does not
re-probe writability with that high token: after UAC, Program Files would look
writable and send staging back to the unelevated `%TEMP%` workdir. Inherited
elevation from an elevated Cindy spawn that omitted `--elevated` classifies
with the linked medium-integrity token instead. A writable per-user install
creates `%ProgramData%\cindy-update-{ts}\` with a High integrity DACL at
`CreateDirectoryW` time so a same-login medium process cannot pre-create or
hold a writable handle on that tree before `copy_tree`; a planted directory
or junction is refused. ProgramData is the system known folder, not an
inherited `ProgramData` environment variable. Only that per-attempt private
root uses the High-IL create path; an install directory that happens to live
under ProgramData still uses ordinary `create_dir_all`. A protected Program
Files install still stages next to the app. The archive digest is verified
after the updater window is shown, not before. Stale cleanup under ProgramData
deletes only `cindy-update-{digits}` roots this updater creates; a directory
such as `cindy-update-service` is left alone.
Unelevated per-user installs still probe and stay in TEMP.
Failures before replacement delete those staging directories; only a rollback
that itself failed keeps the backup for manual recovery.
The retry command checks for processes running from the install directory and
asks the user to close them; manual retry never force-terminates those processes.
The first attempt may still request UAC by relaunching this TEMP-copied updater.
The exclusive `.updating` lock is acquired only after that handoff, so the
elevated child can install. Cancelling that prompt, or a Retry that would need a
second `runas`, does not offer Retry and does not relaunch the TEMP executable;
close the window and check for updates again. An already-elevated Retry continues
in-process. Inherited-elevation Retry pins the first medium-integrity
writability of `app_dir` before AppState is cloned, so Retry does not re-probe
a later DACL, and keeps High-IL ProgramData staging even if the install later
looks protected. Windows startup keeps waiting while the `.updating` holder
PID is alive before the 30s timeout, then attempts unlink even if that PID
was recycled. It only keeps waiting after that when unlink fails with a
sharing violation (Retry still owns `FILE_SHARE_READ`); an ACL or third-party
deny-delete error does not hang the pre-window loop. The unelevated parent
forwards `--install-writable true|false` across UAC so the elevated child
does not treat `--elevated` as proof that a per-user install is protected.
A denied write probe still pins the install as writable when the same-login
medium token can modify the directory, an existing `Cindy.exe`, an app-local
DLL, `resources/app.asar`, or an unpacked native addon under
`resources/app.asar.unpacked`, even if Administrators own the tree. Ownership
alone is not enough. A `CreateFile(GENERIC_WRITE)` sharing or lock violation
while Cindy.exe is still mapped is treated as writable, not as a protected
ACL. After Cindy
exits, Retry opens a non-reparse directory handle and writes backup/copy/
rollback through that path, refusing descendant junctions so a swapped
`resources` reparse cannot receive elevated files. Windows startup waits
past 30s on a sharing violation only while the recorded updater PID is
alive; antivirus or other deny-delete handles stop after the timeout.

A successful rollback retains the isolated zip for retry and does not relaunch
Cindy while Retry remains available. Isolation before the outer digest check
is preliminary: if that check later withdraws Retry, the restored Cindy is
relaunched immediately and Close no longer starts a second copy. The exclusive `.updating` lock stays on
disk for that window so a second updater cannot start from `%TEMP%`. Close, or
any other abandoned Retry exit, deletes that file so the next Cindy launch does
not wait 30 seconds, then relaunches the restored Cindy — the concurrency
reason for keeping it closed no longer applies. An elevated updater does not
`CreateProcess` a medium-writable `Cindy.exe` with the high token: Close and
the successful install launch use the linked medium token instead, or skip
relaunch if that token is unavailable. Protected install roots still relaunch
at the current integrity. Retryable failures that never acquired `.updating`
still relaunch if this updater already stopped Cindy. A terminal pre-install
Retry that never rewrote `app_dir` also relaunches on Close even though Retry
is hidden; an inconsistent rollback still does not. A present `.updating`
owned by another process suppresses relaunch — Cindy's 30-second wait can
delete this window's leftover and a later updater may already be replacing
files. A second updater that never owned the lock and never stopped Cindy
does not relaunch or delete it. Close then window
destroy share a one-shot abandon so the restored Cindy is not launched twice.
Clicking Retry hides Close until the worker reports a terminal state, and
Alt+F4 / `CloseRequested` is ignored while that worker is running, so Close
cannot kill an in-flight hash/install. Retry reopens a retained lock only when
the file still names this process.
Failures before UAC on a protected install directory do not offer Retry. A successful update still removes its zip. If rollback fails, Retry
is unavailable and the backup directory is preserved for manual recovery. Stale
temporary directories retain
the existing seven-day cleanup policy.

Only the newly added retry copy has a five-language catalog, selected from the
WebView language with English fallback. Existing updater text remains unchanged.

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
  --zip-sha256 <sha256-of-anything.zip> \
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
