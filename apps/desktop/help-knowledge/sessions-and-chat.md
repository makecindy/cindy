---
id: sessions-and-chat
title: Sessions and the chat thread
summary: Create sessions, send / stop / queue messages, clear context, and switch between sessions in the sidebar.
---
Each **session** is a persistent chat thread driven by **one agent** (Claude Code or Codex). All your chats live as sessions in the left sidebar.

**Starting a session:**

- Click **+ New** at the top of the sidebar.
- Pick the agent (Claude Code or Codex) and — for code work — a working directory.
- Pick a model in the composer toolbar if you want something other than the default.
- Type your first message and send.

**During a turn:**

- While the agent is replying, **Send** becomes **Stop** — click it to interrupt the current turn cleanly.
- You can keep typing while the agent is busy — follow-ups are **queued** in order and sent one after another when the previous turn finishes.

**Conversation controls:**

- **`/clear`** — clears the current session's conversation context in place (resets messages and state without creating or switching to a new session). The session itself stays in the sidebar; only its content is wiped.
- **`/compact`** — ask the agent to summarize and compress earlier turns into a shorter context (Claude Code).
- **Edit** — you can edit your **last** user message. Doing so **rewinds** the conversation: it drops that message and everything after it, then resends your edited message. In sessions with file-rewind support (local git working directories with savepoints), file changes are also rolled back. In sessions without savepoints (remote sessions, non-git directories, or Codex sessions that haven't created savepoints), only the conversation is rewound — filesystem changes remain.

**Switching between sessions:**

- Click any session in the sidebar to switch to it. State is persisted — each session remembers its agent, model, working directory, attachments, etc.
- Keep **unrelated tasks in separate sessions** — sharing one session for everything dilutes the agent's context and confuses it.

**Notes:**

- Sessions are **per local user** — they live in the local SQLite DB at `<userData>/cindy-<userId>.db` (installs migrated from the legacy app get their sessions copied from the old `xdt-maker-<userId>.db` on first login). They don't sync to other machines automatically.
- If you have two desktop instances open (e.g. dev + release) on the same user account, both read/write the same DB and will see each other's sessions.
