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
element credentials, sets multilingual text, clicks a counter, verifies window
existence, rejects stale credentials, captures a temporary screenshot and rejects
a cancelled action. Web AX values remain untrusted and verification must return
unknown; DOM reads independently check exact text and click count.
The window and temporary files are removed; the report retains bounded fixture
evidence, excluding the system menu and recent-items tree. A failure is recorded
without terminating the development app or stopping other driver sessions.

Unit regressions additionally cover cancellation between text chunks, connection
loss without mutation replay, paginated driver discovery, legacy capture modes,
malformed verification results and replay stopping on unknown effects. A successful
macOS smoke does not certify Windows, every application, or every driver release.
