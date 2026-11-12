---
id: workspace-panels
title: Right sidebar panels (files, terminal, browser, side chat, and more)
summary: Open the right sidebar next to a task and add panels with + (Add tab) — File browser, Review, Subagent, Background tasks, New side chat, Browser, Terminal, plugin panels — then reorder, move tabs to another edge, or pop them out into their own window.
---
The **right sidebar** sits next to an open task. It holds tabs ("panels") that help you work alongside the conversation. Tabs belong to the task: switching tasks switches to that task's tabs, and they come back when you return. Plugin panels are the exception (see below).

**Opening it:**

- Click the panel icon at the top-right of the window (**Show sidebar**). The same area has **Maximize sidebar** / **Restore sidebar**, **Close sidebar**, and **Open the current tab in a new window**.
- With no tabs yet, the sidebar shows **Add a panel** with the same choices as the **+** menu.
- The right sidebar is only available while a task is open.

**The + (Add tab) menu:**

- **File browser** — browse the task's working folder (details below).
- **Review** — the task's git changes; see the Reviewing changes topic.
- **Subagent** — progress, results, and details of subagents created in this task. It's shown for local Pi tasks (and for tasks that still have Pi subagent records).
- **Background tasks** — background agents, shell commands, and workflows started in this task, split into **Running** and **Completed**; open one to see its progress or output, or **Stop** it. Clicking a background-task card in the chat also opens this tab.
- **New side chat** — see Side chat below.
- **Browser** — a built-in web browser (details below).
- **Terminal** — a shell in the task's working folder (details below).
- **Plugins** — installed plugins that provide a panel are listed under their own heading.
- Review, Subagent, and Background tasks can be open only once per task; the menu then shows **Open** and switches to the existing tab. You can open several File browser, Browser, Terminal, and side chat tabs.
- Other tabs open automatically from elsewhere: the **Team** tab when you use Collaboration (see the Collaboration topic), plus some plugin and mail pages.
- In IM bot chats, the menu is shorter (no Review, Subagent, Background tasks, Terminal, or side chat).

**File browser:**

- A file tree of the working folder next to a preview of the selected file. Drag the divider to resize the tree.
- **Filter files…** narrows the tree by file name; the search button switches to **Search file contents** (with **Match case**). The tree also has **Collapse all**, **Refresh**, and **Show ignored directories**.
- **Edit** a text file right in the panel, then **Save** (Cmd/Ctrl+S). If you switch files with unsaved changes, Cindy asks first.
- Right-click a file for **Open in file browser** (opens it in another File browser tab), **Copy File Path**, and **Show In Folder** (these two for local tasks); web pages also offer **Open in sidebar** (the built-in Browser) and **Open in browser**. Click an image to preview it. Creating, renaming, or deleting files isn't done from this panel.
- Drop a file onto the panel to preview it (one file at a time).
- Also works for tasks on another computer or an SSH host (file-name filtering and search there need ripgrep on the remote machine). Tasks without a working folder can't use it.

**Browser:**

- Address bar (**Enter URL or search**), **Back**, **Forward**, **Reload**, and **New tab**.
- **Screenshot** copies the page to the clipboard.
- **Comment on the page**: click an element (Shift-drag to select an area), describe the change you want, and **Add comment** — the comment goes into the chat input so you can send it to the agent. Press Esc to leave comment mode.
- **More** has **Open in system browser** and **Copy link**.
- Sign-ins and cookies are kept between sessions. You can reference this task's browser tabs in the composer with **@** (see the Attachments topic).

**Terminal:**

- Opens a shell in the task's working folder. Choose the shell in **Settings > Personalization > Default terminal shell** (new tabs only).
- Shortcut: **Ctrl+`** (**Open terminal**) focuses the existing terminal tab or creates one.
- If the shell exits, click **Restart**. Terminals don't survive quitting Cindy.
- Available only for tasks running on this computer — not for tasks on another computer or an SSH host.

**Side chat:**

- Ask a separate question with the main task's context without interrupting it. Open one with **New side chat** in the + menu, with `/side` (text after it becomes the draft question), or by selecting text in a reply and clicking **Side chat**.
- It uses the context completed when you opened it; the main task keeps running. **Open full task page** shows it full-size; **Back to main task** returns.
- Wait until the main task has its first reply. Not available in shared tasks you joined, in IM bot chats, or in tasks whose agent runs in another environment.
- Closing the tab asks **Close side chat?** — it stops the side chat and deletes its history (**Close and delete**).

**Plugin panels:**

- Shown as tabs marked "Global tab, kept across tasks": they stay put when you switch tasks.
- Reopen a closed plugin panel from the **+** menu or with **Open in the sidebar** (see the Plugins topic).

**Managing tabs:**

- Drag tabs to reorder them. Right-click a tab for **Close**, **Close others**, **Close all**, **Move to …**, and **Open in a new window**.
- **Move to left side / top / bottom / right sidebar** places the tab on another edge of the chat area. You can also drag a tab out of the tab strip to an edge, or onto another tab strip.
- **Pop out:** **Open in a new window** (or drag a tab outside the Cindy window) opens just that tab in its own window. Use **Move to window:** to add a tab to a window you already popped out, or **Merge back into the sidebar** to return it.
- Shortcuts: **Previous / Next right sidebar tab** — Cmd+Shift+[ / ] on macOS, Ctrl+PageUp / PageDown on Windows, or Ctrl+Shift+Tab / Ctrl+Tab. On macOS, Cmd+W closes the active tab while the sidebar has focus. Tab-switching and **Open terminal** shortcuts can be changed in **Settings > Keyboard Shortcuts**.
- Panel positions and widths are saved; **Settings > Appearance > Restore default layout** resets them.

**Activity Monitor:**

- Not a sidebar tab: open the menu button at the top-left of the window and choose **Activity Monitor**. It lists **Agent Processes** and **App Processes** with CPU and memory, and can **Stop Process** for an agent process (tasks using it are interrupted; send another message to restart).
