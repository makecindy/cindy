---
id: updates-and-about
title: App updates, version and logs
summary: How auto-updates apply; where to find the app and agent versions, the debug-log toggle, and the logs folder.
tab: about
---
Cindy checks for updates automatically and downloads them in the background. When an update is ready, you're prompted to **relaunch** the app to apply it.

**Settings > About:**

- **App version** — the desktop app's release.
- **Claude Code source** — keep the Cindy-managed copy (the default), or use a compatible system installation found on `PATH` or at an absolute executable path. Source changes apply after restart.
- **Claude Code version** / **Codex version** — the actual agent CLI versions currently used by Cindy. The Claude Code row also identifies its active source.
- **Auto-relaunch when idle** — an optional toggle that lets a downloaded update apply itself during idle time instead of waiting for you to click relaunch.
- **Debug log toggle** — turn on more verbose logging when reproducing a problem. Leave it off for normal use.
- **Open logs folder** — opens the logs directory in your OS file browser, useful when you need to attach logs to a bug report.
- **Storage** — a storage-management card for reviewing / clearing local app data.

**Notes:**

- By default, a downloaded update only triggers a relaunch prompt — it won't restart you unexpectedly. If you enable **Auto-relaunch when idle**, Cindy will restart itself automatically once the idle and busy gates pass, without an additional prompt.
- If you want to skip auto-update temporarily, you can dismiss the relaunch prompt; the update applies next time you start the app.
- When **System Installation** is selected, Cindy checks `claude --version` at startup. If the executable is missing, cannot be launched, or is older than Cindy's minimum supported version, Cindy falls back to its managed copy and shows an actionable warning.
- Codex remains managed by Cindy and is independent from any Codex CLI installed globally on your shell.
