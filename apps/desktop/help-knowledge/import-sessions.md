---
id: import-sessions
title: Importing Codex and Claude conversations
summary: Scan and import existing Codex or Claude Code chat history from Settings > Session Import.
tab: import
---
If you already have Codex or Claude Code conversations on disk (from the CLIs), Import brings them into Cindy so they show up in the sidebar alongside your other sessions.

**Importing:**

- Open Settings > Session Import.
- Click **Scan** to discover sessions in the standard Codex / Claude Code locations on your machine.
- Filter the results:
  - by **source** — Codex or Claude Code;
  - by **placement** — by project (sessions inside a specific working directory) or by chat (free-form sessions not tied to a project).
- Tick the sessions or projects you want, then click **Import**.
- They appear in the left sidebar.

**Notes:**

- Importing is **one-way and non-destructive** — the originals on disk are left in place; nothing is synced back. Re-importing the same session is a no-op.
- Imported threads are read-only history at first; you can continue them just like any other Cindy session.
- This is for bringing in past conversations — it's unrelated to archiving / deleting sessions (see the Sidebar topic for those).
