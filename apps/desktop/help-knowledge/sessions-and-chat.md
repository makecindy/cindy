---
id: sessions-and-chat
title: Sessions and the chat thread
summary: Create sessions, pick model / engine / project, send / stop / queue / steer messages, compact or clear context, rewind, edit, fork, and switch between sessions.
---
Each **session** is a persistent chat thread run by an agent engine (Claude Code, Codex, or Pi). All your sessions live in the left sidebar.

**Starting a session:**

- Click **New** at the top of the left sidebar (or press ⌘N / Ctrl+N).
- Choose a project folder for code work, or stay in **Chat** for plain Q&A. If you have other computers or SSH hosts, the **Device** picker and **Add remote project** choose where it runs (see the Remote topic).
- Pick a model in the composer's model selector. There's no separate agent picker: the engine (Claude Code, Codex, or Pi) follows the model and is shown next to it; to run a model on a different engine, use that model's **Customize** options (see the Choosing a model topic). You can also set the permission mode in the composer toolbar.
- Type your first message and send. **Enter** sends and **Shift+Enter** adds a new line; to send with ⌘↵ / Ctrl+Enter instead, use **Settings > General > Message input**.

**During a turn:**

- While the agent is replying, the composer shows a separate **Stop** button (labeled **Stop generating**) — click it to interrupt the current turn.
- You can keep typing: the send button becomes **Queue message**, and follow-ups are **queued** and sent one after another when each turn finishes. With the default Enter-to-send setting, press ⌘↵ / Ctrl+Enter instead to **steer** — deliver the message into the running turn without interrupting it.
- Queued messages appear above the composer, where you can **Steer**, **Edit**, **Delete**, or drag to reorder them. If you stop the turn, the queue pauses until you click **Continue sending**.

**Context:**

- The context ring in the composer shows how full the context is; click it to compact (Claude Code and Pi; Codex manages its own context, so the ring is read-only there). **`/compact`** also asks the agent to summarize earlier turns.
- **`/clear`** — clears the current session's conversation context in place (resets messages and state without creating or switching to a new session). The session stays in the sidebar; only its content is wiped.

**Message actions (hover a message):**

- **Copy message**; the **More message actions** menu also has **Copy current message link**.
- **Edit** — available on your **last** message. Editing **rewinds** the conversation to that message and resends your edited text.
- **Back to here** — rewind to an earlier message of yours: later messages are removed and, when a Git file recovery point exists, project files are rolled back too (the dialog shows how many files). Without one (non-git folders, recovery points turned off in **Settings > General > Git Safety**), only the conversation is rewound. Rewind isn't supported yet for remote Claude Code sessions.
- **Start a new session** — fork a separate session from that point; the original stays unchanged.
- **Delete this message** — removes it from the history; the agent's context is rebuilt from what remains on the next send.
- Replies that changed files show a **Changed N files** card with Review / Undo / Reapply (see the Reviewing changes topic).

**Switching between sessions:**

- Click any session in the sidebar, or press ⌘1–⌘9 / Ctrl+1–Ctrl+9 to jump to the first nine visible sessions. Each session remembers its engine, model, working directory, attachments, and draft.
- Picking a model that runs on a different engine mid-session switches the engine after you confirm **Switch Agent?** (see the Choosing a model topic).
- Keep **unrelated tasks in separate sessions** — sharing one session for everything dilutes the agent's context.

**Notes:**

- Sessions are stored locally on this computer, separately for each signed-in account. They aren't copied to your other computers, but with **My devices** (Settings > Remote Connection) you can view and drive sessions on your other signed-in computers from the sidebar.
