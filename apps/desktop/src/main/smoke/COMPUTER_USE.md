# Computer Use regression smoke

Run from a task worktree on macOS with an installed, OS-authorized cua-driver and an unlocked desktop:

```sh
CINDY_CUA_SMOKE=1 XDT_CDP_PORT=9237 pnpm restart:desktop:remote -- --region=global --isolated=@worktree --isolated-auth
pnpm desktop:whoami --all
```

Use an unused CDP port when other development instances are running. Startup must
report `DESKTOP_DEV_VERDICT=ready` and the worktree must match. Separately inspect
`computer-use-smoke.json` in the isolated instance's reported userData directory:
only `ok:true` proves the smoke completed. The opt-in is ignored in packaged or
non-isolated instances and does not change the saved Computer Use preference.

The fixture exercises the public MCP dispatcher, host adapter and actual driver.
It discovers its own disposable window, reads text-only state, forwards opaque
element credentials, sets long multilingual text, clicks a counter, verifies window
existence, rejects stale credentials, captures a temporary screenshot and rejects
a cancelled action. Web AX values remain untrusted and verification must return
unknown; DOM reads independently check exact text and click count.
After automatic postchecks it explicitly refreshes element credentials. It also
checks native Chinese/emoji typing with a bounded postcondition, macOS default
drag selection, missing-app discovery without launching another app, and closed
window rediscovery without silently selecting a replacement. Installed-bundle
and already-running-app fallback success remain covered by unit regressions.
The window and temporary files are removed; the report retains bounded fixture
evidence, excluding the system menu and recent-items tree. A failure is recorded
without terminating the development app or stopping other driver sessions.

Unit regressions additionally cover cancellation between text chunks, connection
loss without mutation replay, paginated driver discovery, legacy capture modes,
malformed verification results and replay stopping on unknown effects. A successful
macOS smoke does not certify Windows, every application, or every driver release.

## Folder picker wheel regression (Windows)

`CINDY_CUA_SMOKE=folder-picker` selects the real new-task page in an isolated
`--mock` instance. It uses that instance's public Computer MCP dispatcher, host
guards and native driver; the already-running Cindy does not need the patch.
Use an unlocked Windows desktop and a sandbox containing at least five project
rows, including a uniquely searchable `wheel-project-00` fixture. Do not use a
signed-in profile. From PowerShell in the task worktree:

```powershell
$env:CINDY_CUA_SMOKE = 'folder-picker'
$env:XDT_CDP_PORT = '9237' # choose an unused port
pnpm restart:desktop:remote -- --mock --isolated=folder-picker-wheel
```

The smoke sets its isolated page to 100% zoom and checks that scale before each
coordinate calculation. A changed page zoom aborts the run before coordinate
input. This does not certify Windows display scaling or mixed-DPI monitors.
It enters New Task through the shared navigation before waiting for the project
picker, so a restored task or companion page does not need manual navigation.

Inspect `folder-picker-wheel-smoke/report.json` under the reported sandbox
userData. It records trusted native events, intended/actual coordinates, delta,
list/page displacement, cancellation, theme, viewport, receipts and screenshots.
`ok:true` covers the listed new-task project cases only: rows/icons, heading,
search, footer, boundaries, reopen, filtered short/empty lists and two sizes in
both themes. DOM access supplies initial scroll positions/preferences and reads
results; it does not dispatch input or supply the resulting scroll position.
Actually inspect the screenshots before claiming visual verification. The
separate legacy recent-folder gate, macOS trackpad momentum and native folder
dialogs are not certified by this smoke.

The smoke closes its own MCP/driver session, but deliberately leaves the app
available for inspection. Immediately after inspection, use the same worktree's
`node scripts/restart-desktop-remote.mjs --mock --isolated=folder-picker-wheel
--kill-only`, verify its recorded test processes/listeners exited, and preserve
the report and screenshots. The opt-in is ignored outside unpackaged isolated
mock instances; it does not enable Computer Use in saved preferences.
