---
id: storage
title: Storage and cleanup
summary: Settings > Storage shows how much disk Cindy uses and lets you set the Chat workspace folder, clear media caches, run Disk cleanup, clean the database (permanently removes old archived history), and handle Worktree cleanup.
---
**Settings > Storage** is where you see and manage what Cindy keeps on this computer. Your database and media cache stay local, and Cindy never deletes your history automatically — every cleanup here is something you start and confirm.

**Chat workspace:**

- The folder used by new sessions that have no project folder. Cindy creates an account-specific subfolder inside it.
- **Open directory**, **Change directory**, **Restore default location**, and **Full path** (with **Copy path**).
- Changing it only affects new sessions — existing files stay where they are.

**Local storage overview:**

- Shows database size, media files, the image cache, and the message attachment cache. **Refresh storage usage** recalculates.

**Media files:**

- **Image cache directory** and **Message attachment cache directory** — **Open directory** to look inside, or **Clear image cache** / **Clear attachment cache**. Clearing deletes only those cache files, but images or attachments in older messages may stop showing, and it can't be undone.
- **Remote image cache** — images downloaded for reuse. **Clear remote cache** frees the space; images download again when opened, and original files and saved attachments are kept.

**Database:**

- **Database cleanup** — click **Scan database** to see what would be removed. It targets the message history of **soft-deleted and archived** tasks not updated for longer than the period you pick (**7 days** by default, or 1, 3, or 6 months).
  - **Clean Unarchived Tasks** (off by default) also includes old unarchived tasks: their history is removed, their agent context is reset, and they leave the task list (teammates' main tasks stay). Cindy asks you to confirm, because such a task could still be running.
  - **Back up database before cleanup** is on by default (the default backup lives in the database folder and only the latest cleanup backup is kept; **Choose backup folder** to put it elsewhere).
  - **Confirm database cleanup** → **Restart and clean up database**: Cindy restarts, backs up (if enabled), removes the history, compacts, and verifies the database before opening it. If a step fails, Cindy keeps or restores the original database.
  - **This permanently removes that history.** With a backup you can restore task and message data from it (**Open cleanup backup**); without one, it can't be recovered. Records used to review or undo file changes from those messages aren't in the backup. Files and generated media on disk are not deleted.
- **Database reminder threshold** — Cindy reminds you to clean up when the database grows beyond this size (10 G by default, 1–1024). **Do not remind me again** hides these reminders.

**Disk cleanup and storage check** (below the database card):

- **Disk cleanup** — **Scan** finds media no session references anymore, caches over their limit, obsolete leftover folders, and stray temporary files, and shows the totals first. Nothing is deleted until you click **Clean up**. Images in composer drafts and queued messages are always protected.
- **Storage check** — **Check** compares Cindy's media records with the files on disk and reports any mismatch. It never deletes anything.

**Worktree cleanup:**

- Lists worktrees Cindy is still waiting to clean up (for example, still in use or with changed contents), with their state and reason. Use **Retry cleanup**, **Keep directory** to keep it, or **Refresh**. See the worktrees topic for how worktrees are created and removed.

**Notes:**

- Archiving or deleting a session in the sidebar keeps its history in the database; Database cleanup is what actually frees that space (see the sidebar topic).
- Logs live elsewhere: **Settings > About** (see the updates-and-about topic).
