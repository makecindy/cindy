---
id: getting-started
title: Getting started with Cindy
summary: Start a new session with New (⌘N / Ctrl+N), choose a project and a model (the engine — Claude Code, Codex, or Pi — follows the model), send your first prompt, and iterate.
---
Cindy is a desktop app that runs AI agents (Claude Code, Codex, and Pi) for you.

**Before your first message:**

- You need at least one model. If none is available, Cindy prompts you to sign in to Cindy (Cindy AI, the official service) or connect a provider with your own API key. You can do this later in **Settings > Providers**.

**Your first session:**

- Click **New** (the ⊕ icon) at the top of the left sidebar, or press ⌘N / Ctrl+N.
- Use the folder picker (**Chat or select project**) to choose a project folder for code work, where the agent reads and edits files. Choose **Chat** for plain Q&A that doesn't need a project.
- Pick a **model** in the composer's model selector. There's no separate agent picker: the engine (Claude Code, Codex, or Pi) follows the model you choose and is shown next to it (see the Choosing a model topic). A new session starts with the model you last used.
- Optionally set a **permission mode** in the same toolbar. If you have remote devices connected, you can also choose which device runs the session.
- Type your goal and send. By default **Enter** sends and **Shift+Enter** adds a new line. You can switch to ⌘↵ / Ctrl+Enter under **Settings > General > Message input**.

**Iterating:**

- A session is a persistent chat thread: ask, review the result, then ask the next thing.
- While the agent is working, the composer shows a separate **Stop** button; click it to stop the current run.
- You can keep typing while the agent is busy: the send button becomes **Queue message**, and queued messages go out in order after the current turn. With the default Enter-to-send setting, press ⌘↵ (Ctrl+Enter on Windows/Linux) instead to steer the running turn without stopping it (see the Sessions and the chat thread topic).
- Type `/` in the composer to open the slash-command palette (see the Commands topic).

**Organizing:**

- All sessions are listed in the left sidebar (see the Sidebar topic). Click one to switch to it. Each session remembers its engine, model, and working directory.
- Keep unrelated work in **separate** sessions. Putting everything in one session dilutes the context.

**Tone tip:**

- Describe the goal and context first, then the result you want. That works better than a single short command. The agents respond well to "here's what I'm trying to do, here are the constraints, here's what 'done' looks like".
