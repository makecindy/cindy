---
id: reviewing-changes
title: Reviewing the agent's file changes
summary: See what changed from a message's "Changed N files" card (Review / Undo / Reapply) or in the right sidebar's Review tab (git diffs by source, stage / revert, commit and push); use /review for an independent read-only review.
---
There are two places to see what the agent changed: the **changes card** under each reply, and the **Review** tab in the right sidebar.

**Per-message changes card:**

- When a reply edits files, a **"Changed N files"** card appears under it, listing the files.
- **Review** opens those exact changes ("Changes from this message") in the Review tab.
- **Undo** reverts that message's file changes; **Reapply** puts them back. These are blocked while the agent is still replying, and if the files have changed since then, Cindy asks you to review the current changes first. Undo needs Git installed.
- If some writes (e.g. from shell commands) couldn't be captured exactly, the card says so and only the captured part can be reviewed or undone. Exact per-message changes aren't available for remote sessions yet.

**Opening the Review tab:**

- Show the right sidebar with the panel icon at the top-right of the window, click **+** (Add tab), and pick **Review**.
- The source dropdown picks what to compare: **Unstaged** (default), **Staged**, **Commit** (pick a commit on this branch), **Branch** (everything since the merge-base with a **Compare base** branch you choose), or **Last turn** (only files the agent touched in its latest turn).
- Diffs are read from real git state, so the working-tree views include edits you made yourself, not only the agent's.

**Inside the tab:**

- Toggle **Unified** / **Split** views. Diffs are expanded by default; **Expand all diffs** / **Collapse all diffs** and per-file collapse are available.
- **Show files** opens a file tree (with a filter); **Jump to file** filters and jumps.
- The view-options menu has word wrap, word diffs, hide whitespace, rich text preview for Markdown files (on by default), and **Copy git apply command**. Changed images show a Before / After preview.
- Colors follow git convention: **red removed / green added**. Each file can be opened or revealed in its folder.

**Acting on changes:**

- **Stage** / **Unstage** / **Revert** whole files or single hunks, or use **Stage all** / **Unstage all** / **Revert all**. Revert asks for confirmation (untracked files are deleted).
- **Commit or push** (top of the tab): write a commit message, then **Commit** or **Commit and push** (optionally **Include unstaged changes**), or **Push** local commits. Cindy asks before a force push.
- Writes are paused while the agent is running, and during detached HEAD, merge conflicts, or an in-progress git operation. Sessions on SSH hosts or another computer are view-only.

**Independent review (`/review`):**

- Type `/review` (optionally with a focus or path) to start a fresh, read-only reviewer session with no memory of the work; it checks code changes, files, documents, or images against the task. It currently works for local sessions only.

**Notes:**

- This is separate from **Plan mode** (approving a plan before work starts) and from the **collaboration** worker panes.
