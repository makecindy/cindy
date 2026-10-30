---
id: memory
title: Memory across conversations
summary: Settings > Personalization > Memory — the "Cindy" switch (on by default) turns on shared memory per working directory; when it's off, Claude Code and Codex use their own native memory. Teammates such as Cindy keep their own memory, viewable in the teammate's settings.
tab: personalization
---
Memory lets the agents carry context across your conversations — facts about you, your projects, and how you like to work. There are two kinds, and one master switch chooses between them.

**Where it lives:**

- Settings > Personalization > **Memory**.

**The "Cindy" master switch (default ON):**

- Turning **Cindy** on enables a **shared memory** scoped to each working directory — Claude Code, Codex, and Pi tasks in the same working directory draw on the same memory.
- While it's on, the **Claude Code** and **Codex** native-memory rows below are **disabled / grayed out**, because the shared memory replaces them.
- The **Pi** row is the opposite: it's only available while Cindy is on. It controls whether Pi saves its long-session compression summaries to Cindy memory for future Pi tasks.

**Per-agent native memory (used when the master switch is OFF):**

- When Cindy is off, Claude Code and Codex each fall back to **their own native memory** — so turning the master off doesn't mean "no memory"; it means each agent remembers things its own way.
- The **Claude Code** and **Codex** rows each have their own switch (only usable while Cindy is off).

**Resetting:**

- The reset button on the **Cindy** row deletes all Cindy memories for every project.
- The reset button on an agent row deletes all memories that agent has accumulated across every project.
- When you've changed the switches, a **Custom** badge and a **Restore default** button appear next to the Memory title; it restores the switches (not the memories).
- Resets ask for confirmation and can't be undone.

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
