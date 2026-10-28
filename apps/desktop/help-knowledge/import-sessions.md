---
id: import-sessions
title: Importing Codex and Claude conversations
summary: Import existing local Codex or Claude Code history, or a shared .cshare session file, from Settings > Session Import.
tab: import
---
If you already have Codex or Claude Code conversations on this computer (from the CLIs or the Codex app), Session Import brings them into Cindy so they show up in the sidebar with your other sessions.

**Importing local history:**

- Open **Settings > Session Import** (the page is titled **Local Session Import**).
- Cindy scans the standard Codex and Claude Code history locations when you open the page. Click **Scan** to rescan. Scanning is read-only: it doesn't change your database or the sidebar.
- Filter the results:
  - **Source** — All / Codex / Claude;
  - **Placement** — All / **Existing projects** (sessions that will go under a project group) / **Chat** (Codex sessions without a project).
- Tick individual sessions, a whole project group, or **Select all in current filter**, then click **Import selected**.
- A toast reports how many sessions were inserted or updated. They appear in the left sidebar.

**Importing a shared session (.cshare):**

- Click **Import from .cshare…** on the same page, or drag a `.cshare` file onto the Cindy window.
- If the file is encrypted, enter the password from the sender. Then review the preview, choose the matching working directory on this computer, and optionally create it in a worktree.
- If the same session already exists here, you can **Overwrite & import** or cancel.
- To create a `.cshare` file yourself, open a session's menu (right-click it in the sidebar, or use its ⋮ menu) and choose **Export session…**. You can protect the file with a password. Exporting a collaboration lead includes its workers. Sessions that run on a remote machine or another device can't be exported.

**Notes:**

- Importing local history is **one-way and non-destructive**: the original files stay where they are, and nothing is synced back.
- Sessions that are already in Cindy, plus internal sessions, are skipped and don't appear in the list (the summary counts them as **Skipped**).
- You can continue imported sessions just like any other Cindy session.
- Only import shared files from people you trust. The imported history can influence the agent, and a continued session can still read and write local files and run commands.
- This is for bringing in past conversations. It's unrelated to archiving or deleting sessions (see the Sidebar topic for those).
