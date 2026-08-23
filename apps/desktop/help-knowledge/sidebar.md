---
id: sidebar
title: Finding and organizing sessions
summary: Browse, group, filter, sort, search, and pin sessions or projects in the left sidebar.
---

The left sidebar lists your sessions. It's the main way to navigate and organize. The **Sidebar display settings** menu holds grouping, sorting, filters, and display options — open it from the sliders icon on the main list header, from **Sidebar display settings** in the device-scope menu, or by right-clicking any blank area of the sidebar.

**Device scope (the list header itself):**

- The main list header doubles as the device scope switcher. Its text names what you're looking at — **All sessions**, **This device's sessions**, a remote device's name, or **N machines** — and clicking it opens the scope menu: all / this device / each connected remote device (single-click switches; checkboxes multi-select), plus **Remote connection settings** and **Sidebar display settings**.
- The scope applies to the whole sidebar, including the Pinned section.
- With no remote devices, the header still shows **All sessions ▾**. Clicking it opens a short menu with only **Remote connection settings** and **Sidebar display settings** — no device list. The header stays visible even when the list is empty, only pinned items remain, remote devices/tasks are loading or failed, or the selected remote device is still connecting. There is no separate device row in the top navigation.

**Grouping (independent checkboxes, freely combinable):**

- **Group by project** (default on) — sessions with a project fold into project rows; project rows and stray chats compete for position on the same timeline (a chat active two minutes ago sorts above a project last touched yesterday). Turn it off for a flat list.
- **Group by device** (default on) — only appears when a remote device is connected and the scope isn't narrowed to a single machine; splits the list into device sections (this device first), each with a collapsible header showing the device name and online state. When the last remote device disconnects — or the scope is a single machine — the option disappears and the effect is lifted; the saved preference is untouched and comes back automatically.
- **Group chats together** (default on) — collects projectless sessions into one collapsible **Chat** group instead of interleaving them. With device grouping on, each device section gets its own Chat group with independent collapse state.
- Grouping **by date** has been removed.

**Sorting:**

- **By time** (default) — one activity timeline for the whole list, most recent first. There is no oldest-first option.
- **Priority** — four tiers, same as Codex: sessions waiting on you (pending reply / approval / error) first, then finished-unread sessions, then running sessions, then the rest by time. A project row inherits the highest priority among its sessions. Unread state is in-memory: after a restart most sessions fall back to time order.
- **Manual** — drag project rows to set a persistent custom order. Manual order covers **project rows only**; stray chats and the Chat group always follow by recency. Switch to Manual first to drag; other sort modes do not start a drag.
- Sorting **alphabetically** and **oldest first** have been removed.

**Filters (one row that opens a submenu):**

- **Status** — active / archived / all.
- **Project** — multi-select working directories plus **Chat** (projectless sessions), or "all". Selecting specific projects hides chats unless **Chat** is also checked; check only **Chat** to see projectless sessions alone.
- **Agent** — Claude Code / Codex / all.
- **Recent activity** — last 1 day / 3 days / 7 days / 30 days / all.
- A **Reset filters** action at the bottom clears all four at once. Filters do **not** apply to the Pinned section, except Status (archived pins stay hidden while Status is Active). The list header does not show a standing “filtered” mark; open Sidebar display settings to see which filters are on.

**Display:**

- The main list has **Text** (compact single row) and **List** (two-line row with a preview) styles. Fresh installs default to List; installs upgraded from an older version keep Text so the sidebar looks the way it did before the upgrade. This is separate from the Pinned section's style.
- **Session info** — choose what shows at the right edge of each row: **Time** (default), **PR status** (a status icon plus a monospace `#number`; only the icon is colored — green open / gray draft / red closed / accent merged; the open green follows the row surface so it stays readable on both the rest background and the inverse selected pill; a small orange dot on the icon means the PR still has unresolved review threads; unknown state shows a gray icon; sessions without a PR show nothing), **Tokens** (compact total like `1.4M`), and **Cost** (`$`/`¥` by currency). Multi-select; items render in the order you selected them.

**Pinning:**

- Right-click a session and pick **Pin** to keep it at the top. There's no cap on the number of pinned sessions; a newly pinned session goes to the **front** of the pin order (most recent pin first).
- Right-click a pinned session and pick **Unpin** to remove the pin.
- Open a project's overflow menu and pick **Pin project** to move the whole project into **Pinned**. Project pins are independent from session pins, remain available after a restart or project rename, and can be expanded or collapsed inside **Pinned**.
- Pinned projects and sessions share one draggable order. Newly pinned items move to the front, while the other pinned items keep their relative order. Use **Unpin project** to return a project to its position under the current project sorting mode.
- The **Pinned** section keeps its own display style: **Text**, **List**, and **Card** — Card mode is exclusive to Pinned.

**Collapse / expand all groups:**

- The fold button next to the display-settings button collapses or expands every group at once. With both device and project grouping on, it cycles through levels: collapse project groups → collapse device groups → expand all. The tooltip always names the next step.

**Searching:**

- The search box matches against the **session title only** — not message content and not the working directory path. If you can't remember a session's title, browse via project / agent filters instead.

**Right-click actions:**

- On a regular session: **Pin / Unpin**, **Rename**, **Move to project** (submenu), **Copy session link** (a `cindy://session/<id>` deep link), **Open in new window**, **Archive**, **Delete**.
- On an archived session: **Rename**, **Unarchive**, **Copy session link**, **Delete**.

**Removing a project from the sidebar:**

- Open a local project's overflow menu and choose **Remove Project from Sidebar**. Cindy asks for confirmation, removes the project from the sidebar, and keeps its existing sessions available as projectless chats in the main list. Individually pinned sessions remain in **Pinned**. Those sessions are not archived or stopped, and files on your computer are not deleted.
- To restore the project, choose **Add Project** and select the same directory again. Cindy restores the existing sessions under their original project grouping instead of creating an empty session.

**Session statuses:**

- Sessions are **active**, **archived**, or **deleted** — there are no other states. Archiving hides a session from the default view without removing it; delete is unrecoverable from the UI.

**Notes:**

- Click the sidebar collapse arrow to shrink it to an icon-only strip — that's purely visual, you don't lose any features.
- **Pin state, order, hidden projects, project filters, and identity-based collapse/selection state are isolated per Cindy account.** Pin and hidden-project changes sync across open windows for the same account. Display-only preferences (list style, grouping toggles, sorting, session info) remain local to each window, so they don't sync between, say, a dev window and the installed app.
