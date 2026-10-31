---
id: sidebar
title: Finding and organizing sessions
summary: Browse, group, sort, filter, search, tag, and pin sessions or projects in the left sidebar, and find and restore archived sessions.
---

The left sidebar lists your sessions. It's the main way to navigate and organize. The top of the sidebar has navigation rows (**New** — ⌘N / Ctrl+N starts a new session — then **Automations**, **Plugins**, **Search**; use **More → Customize** to show, hide, or reorder them). **Teammates** have their own section above **Pinned** (see the Teammates topic). Below them is the main session list.

**Finding and restoring an archived session:**

- Archived sessions are hidden from the default list, but they are not deleted. Two ways to find one:
  1. **Search** (top of the sidebar): search covers archived sessions by default, because its **Status** filter starts at **All**. Click a result to open it.
  2. **Sidebar settings → Session status → Archived** (or **All**): the main list then shows archived sessions. Open **Sidebar settings** from the sliders button at the right end of the list header (it appears when you hover over the header), from **Sidebar settings** in the list-header dropdown, or by right-clicking a blank area of the sidebar.
- While **Archived** is selected, the sliders button stays visible and shows a small dot so you remember the list isn't the normal view. **All** shows no dot. Switch back to **Active** to return to the normal list.
- To restore: hover over an archived row and click the **Unarchive** (undo arrow) button, or right-click the row (or use its **⋮** menu, or the **⋯** menu in the open session's header) and choose **Unarchive**. Archived rows show an archive icon in place of the usual status icon.
- Sending a new message in an archived session restores it to **Active** automatically. An automation linked to an archived session also restores it the next time it runs.
- To restore many at once: with **Session status** set to **Archived**, a project's **⋮** menu shows **Restore all**, and the Chat group's menu shows **Restore All**.

**Archiving and deleting:**

- Hover over a session row and click the archive button; it turns into a red **Archived** button — click that to confirm (it reverts after about 4 seconds otherwise). You can also choose **Archived** from the right-click menu. A running session can't be archived until you stop it; a session being remote-controlled must be taken back first.
- Cindy asks for confirmation when the session's worktree has uncommitted changes (they're saved as a git snapshot first) or when a linked automation will keep running and restore the session.
- Archiving removes the session's pin.
- **Delete** asks for confirmation and can't be undone from the UI.
- A project's **⋮** menu has **Archive all** (pinned and running sessions are skipped); the Chat group's menu has the same action.
- **Multi-select:** Cmd-click (macOS) / Ctrl-click (Windows) toggles rows; Shift-click selects a range. A bar above the list then offers **Archive selected sessions**, **Delete selected sessions**, and **Clear selection**.
- Sessions are **active**, **archived**, or **deleted**. **Settings > Storage > Database cleanup** can permanently clear the history of old archived (and optionally unarchived) sessions; scan first, and Cindy asks before cleaning.

**Device scope (the list header title):**

- The main list header title is a dropdown that names what you're looking at: **All sessions**, **Local**, a remote device's name, or **N devices**. Click it to switch scope: **All**, **Local**, or a connected remote device (click a row to switch to that device alone; click the checkbox at the right of a row, or Cmd/Ctrl-click, to select several). The menu also has **Remote desktop** (when another desktop computer can be controlled), **Remote connection settings**, and **Sidebar settings**.
- The scope applies to the whole sidebar, including **Pinned**.
- With no remote devices, the title still reads **All sessions ▾** and the menu only has **Remote connection settings** and **Sidebar settings**. The header stays visible even when the list is empty or remote sessions are still loading.

**Sidebar settings menu** (each row shows its current value and opens a submenu):

- **Group by** — independent checkboxes:
  - **Project** (default on): sessions with a project fold into project rows; project rows and stray chats share one timeline. Turn it off for a flat list.
  - **Chat** (default on): collects projectless sessions into one collapsible **Chat** group.
  - **Device** (default on): appears when you have a remote device. Splits the list into device sections (this computer first), each with a collapsible header showing the device name and online state.
- **Session sort** — **Priority** (waiting on you first, then unread, then running, then by time; a project row ranks by its most urgent session), **Recent Activity** (default, most recent first), or **Creation Time** (newest first).
- **Project sorting** (only while grouping by project) — **Follow sessions** (default) or **Manual**: drag project rows to reorder them; sessions inside still follow **Session sort**.
- **Session status** — **Active** (default) / **Archived** / **All**. See above.
- **Filters** — **Projects** (multi-select, plus **Chat** for projectless sessions; selecting specific projects hides chats unless **Chat** is also checked), **Harness** (All / Claude Code / Codex / Pi), and **Last activity** (1d / 3d / 7d / 30d / All). **Reset filters** clears these three; it doesn't change **Session status**. The **Filters** row shows how many are active.
- **Display** — **Text** (compact single row) or **List** (two-line row with a preview). Fresh installs default to List; upgraded installs keep Text. This is the same setting as **List Style** in **Settings > Appearance**.
- **Session info** — what appears at the right edge of each row (multi-select, shown in the order you picked): **Time** (default), **PR status** (a status icon plus `#number`; a small orange dot means unresolved review threads), **worktree** (the worktree's short name; click it to open the folder), **Tokens**, **Cost**.
- Filters and **Session status** don't apply to the **Pinned** section; it only follows the device scope.

**Pinning:**

- Right-click a session and choose **Pin** / **Unpin**. There's no limit; a new pin goes to the front.
- In a project's **⋮** menu, choose **Pin project** / **Unpin project** to pin the whole project. Pinned projects and sessions share one draggable order.
- The **Pinned** header has its own view-style button: **Text**, **Cards**, or **List** (Cards is only available in Pinned).

**Collapse / expand all groups:**

- The fold button in the list header (shown on hover) collapses or expands groups. With both device and project grouping on, it steps through: collapse project groups → collapse device groups → expand all. The tooltip names the next step.

**Searching:**

- Click **Search** at the top of the sidebar and type. It matches session **titles and message content** (keyword and semantic matches), shows matching snippets, and jumps to the matching message when you click a result.
- The sliders button in the search box opens **Search criteria**: **Sort by** (Relevance / Recently active / Oldest active), **Status** (Active / Archived / **All**, default All), **Harness** (All / Claude Code / Codex / Pi), **Last activity**, and **Projects**. A dot on the button means a filter is narrowing results. Filters other than sort reset when you close search.
- To search inside one project, choose **Search sessions in this project** from the project's **⋮** menu; the Chat group's menu has **Search This Chat Group**.

**Right-click / ⋮ menu on a session:**

- Regular session: **Pin / Unpin**, **Rename**, **Tags**, **Copy session link** (a `cindy://session/<id>` link), **Share Task**, **Move task** (to another project, to Chat, or copy to another computer), **Export session…**, **Open in new window**, **Archived**, **Delete**. Some items are hidden for remote sessions.
- Archived session: **Rename**, **Tags**, **Copy session link**, **Export session…**, **Unarchive**, **Delete**.
- **Tags:** pick up to seven favorite colored tags directly in the menu, or choose **More tags** to create, edit, or reorder tags. Tags show as colored dots after the session title.
- Double-click a session title to rename it.

**Project menu (⋮ or right-click on a project row):**

- **Rename project**, **Pin project**, **Search sessions in this project**, **Show Files**, **Open in file manager**, **Copy Project Link**, **Sync Codex sessions for this project**, **Remove Project from Sidebar**, **Archive all** / **Restore all**. Remote projects show a shorter menu. The **+** button on a project row starts a new session in that directory.

**Removing a project from the sidebar:**

- Choose **Remove Project from Sidebar** on a local project. Cindy asks for confirmation, then moves its sessions to the **Chat** section. They aren't archived or stopped, pinned sessions stay in **Pinned**, and no files are deleted.
- To bring the project back, start a new session and pick the same folder in the project picker (**Choose another project folder** if it's not listed). Cindy restores the existing sessions under that project.

**Notes:**

- Click the sidebar collapse arrow to shrink it to an icon-only strip; nothing is lost.
- Task pin / unpin changes are saved on the computer that owns the task and update its connected views, including newly pinned tasks outside the recent list. Pin order, project pins, hidden projects, project filters, and collapse state remain local to each installation and separate for each Cindy account.
- On updated clients, list style, pinned-section style, grouping, session sorting, and session info synchronize between your signed-in computers. Devices exchange saved changes when online again; older clients keep their local preferences. This does not require remote control to be enabled, but explicitly revoked devices do not participate.
