---
id: sidebar
title: Finding and organizing sessions
summary: Browse, group, filter, search, and pin sessions or projects in the left sidebar.
---

The left sidebar lists your sessions. It's the main way to navigate and organize.

**Grouping:**

- Switch grouping between **by project** (working directory) and **by date** — those are the two options.

**Filtering:**

- **Status** — active / archived / all.
- **Project** — multi-select working directories, or "all".
- **Agent** — Claude Code / Codex / all.
- **Recent activity** — last 1 day / 3 days / 7 days / 30 days / all.

**Pinning:**

- Right-click a session and pick **Pin** to keep it at the top. There's no cap on the number of pinned sessions; a newly pinned session goes to the **front** of the pin order (most recent pin first).
- Right-click a pinned session and pick **Unpin** to remove the pin.
- Open a project's overflow menu and pick **Pin project** to move the whole project into **Pinned**. Project pins are independent from session pins, remain available after a restart or project rename, and can be expanded or collapsed inside **Pinned**.
- Pinned projects and sessions share one draggable order. Newly pinned items move to the front, while the other pinned items keep their relative order. Use **Unpin project** to return a project to its position under the current project sorting mode.
- The **Pinned** section supports the same **Text**, **List**, and **Card** display modes for both sessions and projects.

**Searching:**

- The search box matches against the **session title only** — not message content and not the working directory path. If you can't remember a session's title, browse via project / date / agent filters instead.

**Right-click actions:**

- On a regular session: **Pin / Unpin**, **Rename**, **Move to project** (submenu), **Copy session link** (a `cindy://session/<id>` deep link), **Open in new window**, **Archive**, **Delete**.
- On an archived session: **Rename**, **Unarchive**, **Copy session link**, **Delete**.

**Removing a project from the sidebar:**

- Open a local project's overflow menu and choose **Remove Project from Sidebar**. Cindy asks for confirmation, removes the project from the sidebar, and keeps its existing sessions available in the **Chat** section. Individually pinned sessions remain in **Pinned**. Those sessions are not archived or stopped, and files on your computer are not deleted.
- To restore the project, choose **Add Project** and select the same directory again. Cindy restores the existing sessions under their original project grouping instead of creating an empty session.

**Session statuses:**

- Sessions are **active**, **archived**, or **deleted** — there are no other states. Archiving hides a session from the default view without removing it; delete is unrecoverable from the UI.

**Notes:**

- Click the sidebar collapse arrow to shrink it to an icon-only strip — that's purely visual, you don't lose any features.
- **Pin state, order, hidden projects, project filters, and identity-based collapse/selection state are isolated per Cindy account.** Pin and hidden-project changes sync across open windows for the same account. Display-only preferences remain local to each window, so they don't sync between, say, a dev window and the installed app.
