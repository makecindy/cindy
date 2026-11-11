---
id: memory
title: Memory across conversations
summary: Settings > Personalization > Memory — the "Cindy" switch (on by default) turns on Cindy memory, shared by Claude Code, Codex and Pi tasks; it keeps memories about you (used in every project) and memories per project (one repository or folder each). View Memories on the Cindy row lets you read, search, edit and delete them, and a reply that saved a memory shows a small "Remembered" note. While it is on, no other memory switches are shown; when it is off, Claude Code and Codex rows appear and those two use their own native memory. Teammates such as Cindy keep their own memory, viewable in the teammate's settings.
tab: personalization
---
Memory lets the agents carry context across your conversations — facts about you, your projects, and how you like to work. Cindy manages memory for every agent — Claude Code, Codex and Pi — so normally there is a single switch.

**Where it lives:**

- Settings > Personalization > **Memory**.

**The "Cindy" switch (default ON):**

- Turning **Cindy** on enables **Cindy memory**, a shared memory for ordinary tasks — Claude Code, Codex, and Pi tasks draw on the same memory.
- Cindy memory has two kinds:
  - **About you** — things about you that hold everywhere (how to address you, your language, general preferences and corrections). It applies in **every project**.
  - **Per project** — things that belong to one project (decisions, constraints, where to find references). There is one memory per **repository** — tasks started in any subfolder or worktree of the same repository share it — or, outside a repository, per **folder**. Projects on an SSH host are kept per host and remote path.
- A task that isn't tied to a project (a one-off conversation) only uses the About you memory.
- While Cindy is on, the built-in (native) memories of Claude Code and Codex aren't used, and their rows are **not shown** — there is nothing else to set.

**Per-agent native memory (shown only when the Cindy switch is OFF):**

- Turn **Cindy** off and two more rows appear: **Claude Code** and **Codex**, each with its own switch and clear button. They control that agent's own native memory, and both are on by default — so turning Cindy off doesn't mean "no memory"; it means each of those agents remembers things its own way.
- Turn Cindy back on and the two rows are hidden again; your choices for them are kept.
- **Pi** has no memory of its own and no row: Pi tasks use Cindy memory when Cindy is on, and no memory when it is off.

**Viewing, editing and deleting what Cindy remembers:**

- On the **Cindy** row, click **View Memories** to open **Saved Memories**.
- Pick what to look at in the selector at the top: **About you** first, then each project that has memories (folder name, with its path — and the host for SSH projects — and the number of memories).
- Memories are grouped as About you / Your preferences / Projects / References, each with its title and first lines. Use the search box to find one.
- Click a memory to read it in full. **Edit** changes its title or content and saves automatically; **Delete** removes it after a confirmation.
- If a task updated the same memory after you opened it, your edit isn't written over it: you're shown the latest content and choose **Use latest** or **Keep my changes**.
- This page also works while the Cindy switch is off — saved memories can still be viewed, edited and deleted.
- Edits and deletions are picked up by the next agent session; a task that is already running keeps the memory list it started with.

**The "Remembered" note under a reply:**

- When a reply in an ordinary task saved or updated a memory, a small line with a brain icon — **Remembered: …** with the memory's title — appears under that reply.
- Click it to open **Saved Memories** on the place the memory was saved (About you or that project).
- For a task running on another computer (remote control or a shared task) the note is shown as plain text, because those memories are stored on that computer. The mobile app shows the note as plain text too.
- Teammate replies show the same kind of note; there it opens the teammate's own Memory page (or its Skills).

**Clearing memories:**

- The clear button (eraser icon) on the **Cindy** row deletes all Cindy memories — the About you memory and every project's. Teammates' memories and the files in your projects aren't affected. To remove a single memory instead, use **View Memories**.
- The clear button on the **Claude Code** or **Codex** row (shown while Cindy is off) deletes all of that agent's own memories. Memories it saved while you used it outside Cindy may be deleted too.
- When you've changed the switches, a **Custom** badge and a **Restore default** button appear next to the Memory title; it restores the switches (not the memories).
- Clearing asks for confirmation and can't be undone.

**Teammates (such as Cindy) have their own memory:**

- A teammate keeps its own memory, separate from the task memory above. To see or edit it, open the teammate's chat, click its name / avatar at the top to open its settings, and choose **Memory**. There you can search memories, open one to read or edit it, delete it, or turn **Use memory** off.

**What memory is, what it isn't:**

- It's the agents' **long-term memory across tasks** — notes about you and your projects.
- It's **not** the chat history of a task (that is always saved with the task).
- It's **not** your custom instructions in Personalization (those are standing instructions you write; memory is what the agents record).
- To make the agent remember something specific, just tell it in the chat (for example "remember that we use pnpm in this repo").

**Notes:**

- After changing a memory switch you usually need to **start a new task** for it to take effect; running tasks keep the setting they started with (running Codex tasks switch after their current turn finishes).
- Memory and these switches belong to your signed-in account on this computer. Memory is stored locally and doesn't move to another computer.
