---
id: updates-and-about
title: App updates, version and logs
summary: How app updates download and apply (relaunch banner, idle install, Beta channel); where to find the app and agent versions, agent updates, debug logs, log upload, and the logs folder.
tab: about
---
Cindy checks for updates automatically and downloads them in the background. When an update is ready, a banner appears in the sidebar (**Updated to <version> · Relaunch to apply**) with a **Relaunch** button and **See What's New**.

**Applying an update:**

- Click **Relaunch** to install. If a task or other background work is still running, Cindy warns you first (**A task is still running**) and offers **Restart App Anyway** or **Cancel**.
- Click **Later** to hide the banner. The flame button on your account card at the bottom-left of the sidebar then shows **Update ready — click to review** and brings the banner back. Otherwise, the update is applied the next time you start Cindy.
- When no update is pending, the same flame button opens **View release notes**.
- You can also ask a Cindy agent to update Cindy or to turn idle installation on or off; Cindy always shows a confirmation card first.

**Settings > About:**

- **App version** — shown here in the China edition. In every edition, the app version also appears under your name on the account card at the bottom-left of the sidebar.
- **Install updates while idle** (off by default) — after an update finishes downloading, Cindy restarts to install it once the computer has been idle for 10 minutes and no tasks are running. On Linux this row only explains how updates work there: system `.deb` installs ask for your system password; other installs use their package manager.
- **Usage statistics** — turn launch and usage reporting on or off (on by default once you accept the Privacy Policy).
- **Claude Code version** / **Codex version** / **Pi version** — the agent runtimes Cindy manages. They update separately from the app: open the row's menu to **Check for updates** or update (Cindy restarts to apply it). For Pi you can also **Update from Pi GitHub** or **Restore Cindy release**.
- **Debug logs** — turn on more verbose logging while reproducing a problem. Leave it off for normal use.
- **Logs directory** → **Open** — opens the logs folder in your file manager.
- **Upload logs automatically on crash** (off by default) and **Upload logs** → **Upload** — sends recent run records to Cindy and gives you an upload code to quote when you report a problem.
- **Terms of Service**, **Privacy Policy**, and **Connect with Cindy** community links.

**Related settings:**

- **Beta channel** — **Settings > General > Experimental**. Gets upcoming updates early; takes effect after a restart. Not shown on Linux.
- **Storage** — its own Settings tab (**Settings > Storage**): media and cache usage and cleanup, database cleanup, the Chat workspace folder, and **Worktree cleanup**.

**Notes:**

- A downloaded update never restarts Cindy unexpectedly unless you turn on **Install updates while idle**.
- The Claude Code / Codex / Pi versions shown here are what Cindy's managed agents run. They are independent of any Claude Code, Codex, or Pi CLI installed on your system.
